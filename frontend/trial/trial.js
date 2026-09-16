/* OpenK guest trial: one anonymous song on its own page, with its own limited API.
   No account, no room, no recording library, and nothing about the visitor is kept in
   this browser: the server session cookie is the only identity and the server state is
   the only authority for whether the free song is still available. */
(() => {
  'use strict';

  const API = {
    state: '/api/trial/state',
    catalog: '/api/trial/catalog',
    select: '/api/trial/select',
    complete: '/api/trial/complete',
  };
  // Exact same-origin trial allowlist. Server data is compared against these constants and
  // the constants are what gets assigned, so a response can never point playback elsewhere.
  const MEDIA = {
    instrumental: '/api/trial/media/instrumental',
    vocals: '/api/trial/media/vocals',
    lyrics: '/api/trial/lyrics',
  };
  const LOGIN_URL = '/auth/login/?next=%2F';
  const GUEST_ENTRY_URL = '/auth/guest/';
  const STATUSES = ['available', 'active', 'complete', 'expired'];
  const JOB_ID = /^[0-9a-f]{12}$/;
  const MAX_QUERY = 120;
  const SEARCH_DELAY = 250;
  const MAX_SONGS = 50;
  // Mirrors the server contract: only songs with a positive duration of at most fifteen
  // minutes are eligible, and a guest grant lasts at most twenty-four hours.
  const MAX_SONG_SECONDS = 900;
  const MAX_SESSION_SECONDS = 24 * 60 * 60;
  const MAX_LINES = 600;
  const MAX_WORDS = 200;
  const SYNC_TOLERANCE = 0.14;
  // Safe ceilings: the guest player never amplifies above unity, and the monitor path is
  // deliberately quieter than the music it is mixed into.
  const MAX_MUSIC_GAIN = 1;
  const MAX_GUIDE_GAIN = 1;
  const MIC_INPUT_GAIN = 0.9;
  const MIC_MONITOR_GAIN = 0.6;

  const MESSAGES = {
    malformed: '服务器返回的歌曲信息无法校验，请刷新页面后重试。',
    offline: '无法连接试唱服务。请刷新页面，或登录后继续演唱。',
    generic: '本次访客试唱出现了问题。',
    signedOut: '这个访客会话已经不可用。请登录，或打开试唱入口重新开始。',
    locked: '这个访客会话已经选定了它唯一的一首歌。',
    completion: '歌曲已经唱完，但服务器还没有确认。声音已经停止。',
  };

  class TrialError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = 'TrialError';
      this.status = status;
    }
  }
  const malformed = () => new TrialError(MESSAGES.malformed, 502);

  /* ---------- elements ---------- */
  const doc = document;
  const ids = ['trialAlert', 'trialAlertText', 'trialRetry', 'trialAlertLink', 'loadingView',
    'chooseView', 'songSearch', 'searchClear', 'catalogStatus', 'catalogList', 'sessionNote',
    'playerView', 'trialTitle', 'trialArtist', 'trialRemaining', 'playBtn', 'seek', 'elapsed',
    'duration', 'audioStatus', 'musicVol', 'guideRow', 'guideVol', 'lyrics', 'lyricsFallback',
    'micToggle', 'micToggleLabel', 'micStatus', 'doneView', 'doneTitle', 'doneMessage', 'loginCta',
    'guestEntry', 'instAudio', 'guideAudio'];
  const el = {};
  for (const id of ids) {
    const node = doc.getElementById(id);
    if (!node) throw new Error('The guest trial page is missing #' + id);
    el[id] = node;
  }

  const view = {
    state: null, songId: null, songTitle: '', lines: [], lineNodes: [], activeLine: -1, stickyStatus: false,
    pending: null, selecting: false, finishing: false, finished: false, ended: false,
    started: false, seeking: false, deadline: 0, disposed: false, catalogEpoch: 0,
    lyricsEpoch: 0, searchTimer: 0, tick: 0, frame: 0, completionFailed: false,
    recovering: false, stateEpoch: 0, lapsed: false, guideBroken: false, lastSync: 0,
  };
  const audio = {
    ctx: null, master: null, instGain: null, guideGain: null,
    mic: null, micStream: null, monitorGain: null, limiter: null,
    graphFailed: false, captured: false, unlocking: null, suspending: false,
    micRequest: null, micGeneration: 0, micDesired: false,
  };

  /** One shared generation for everything that applies server state. Selection, completion,
      expiry and teardown all invalidate it, so a reply that was already in flight can never
      resurrect a player, a song list or media after the session moved on. */
  function invalidate() { return ++view.stateEpoch; }
  const current = epoch => epoch === view.stateEpoch && !view.disposed;

  /* ---------- transport ---------- */
  async function request(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(path, {
        method, headers, credentials: 'same-origin', cache: 'no-store',
        // The trial API answers with JSON only; a redirect means something proxied us away.
        redirect: 'error', referrerPolicy: 'same-origin', mode: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new TrialError(MESSAGES.offline, 0);
    }
    let payload = null;
    try { payload = await response.json(); } catch (error) { payload = null; }
    if (!response.ok) {
      const detail = payload && typeof payload.detail === 'string' ? payload.detail.slice(0, 300) : '';
      throw new TrialError(detail || MESSAGES.generic, response.status);
    }
    return payload;
  }

  /* ---------- response validation ---------- */
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const label = (value, limit = 400) => (typeof value === 'string' ? value.slice(0, limit) : null);

  function parseMetadata(value) {
    if (!isObject(value) || typeof value.id !== 'string' || !JOB_ID.test(value.id)) throw malformed();
    const title = label(value.title);
    const track = label(value.track);
    const artist = label(value.artist);
    if (title === null || !title.trim() || track === null || artist === null) throw malformed();
    if (!finite(value.duration) || value.duration <= 0 || value.duration > MAX_SONG_SECONDS) throw malformed();
    return { id: value.id, title, track, artist, duration: value.duration };
  }

  function parseMedia(value, song) {
    if (!isObject(value) || value.instrumental !== MEDIA.instrumental) throw malformed();
    const media = { instrumental: MEDIA.instrumental };
    for (const [key, url] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(MEDIA, key) || url !== MEDIA[key]) throw malformed();
      media[key] = MEDIA[key];
    }
    // A declared capability without its allowlisted URL (or the reverse) is malformed data.
    if (song.has_vocals !== ('vocals' in media) || song.has_lyrics !== ('lyrics' in media)) throw malformed();
    return media;
  }

  function parseSong(value) {
    const song = parseMetadata(value);
    if (typeof value.has_vocals !== 'boolean' || typeof value.has_lyrics !== 'boolean') throw malformed();
    song.has_vocals = value.has_vocals;
    song.has_lyrics = value.has_lyrics;
    song.media = parseMedia(value.media, song);
    return song;
  }

  function parseState(value) {
    if (!isObject(value) || !STATUSES.includes(value.status)) throw malformed();
    const active = value.status === 'active';
    // Exactly the active state carries a song; anything else is a contract violation.
    if (active !== isObject(value.song)) throw malformed();
    if (!active && value.song !== null) throw malformed();
    if (!finite(value.remaining_seconds) || value.remaining_seconds < 0) throw malformed();
    if (value.expires_at !== null && !finite(value.expires_at)) throw malformed();
    if (value.started_at !== null && !finite(value.started_at)) throw malformed();
    return {
      status: value.status,
      song: active ? parseSong(value.song) : null,
      started_at: value.started_at,
      expires_at: value.expires_at,
      remaining_seconds: Math.min(value.remaining_seconds, MAX_SESSION_SECONDS),
    };
  }

  function parseCatalog(value) {
    if (!isObject(value) || !Array.isArray(value.songs)) throw malformed();
    if (!Number.isInteger(value.limit) || value.limit <= 0 || value.limit > MAX_SONGS) throw malformed();
    if (value.songs.length > value.limit) throw malformed();
    return { songs: value.songs.map(parseMetadata), limit: value.limit };
  }

  /** Lyrics are decoration: keep the usable lines and drop the rest instead of
      refusing to let someone sing. The envelope itself still has to be right. */
  function parseLyrics(value) {
    if (!isObject(value) || !Array.isArray(value.lines)) throw malformed();
    const lines = [];
    for (const line of value.lines.slice(0, MAX_LINES)) {
      if (!isObject(line) || !finite(line.start) || line.start < 0) continue;
      const text = label(line.text, 400);
      if (text === null) continue;
      const end = finite(line.end) && line.end > line.start ? line.end : line.start;
      const words = [];
      if (Array.isArray(line.words)) {
        for (const word of line.words.slice(0, MAX_WORDS)) {
          const wordText = isObject(word) ? label(word.text, 80) : null;
          if (wordText === null || !finite(word.start) || word.start < 0) continue;
          words.push({ start: word.start, text: wordText });
        }
      }
      lines.push({ start: line.start, end, text, words });
    }
    lines.sort((a, b) => a.start - b.start);
    return lines;
  }

  /* ---------- small helpers ---------- */
  const clamp01 = value => (finite(value) ? Math.min(1, Math.max(0, value)) : 0);
  function clock(seconds) {
    // Elapsed and remaining media time floor, the way every other player shows it.
    const total = Math.max(0, Math.floor(finite(seconds) ? seconds : 0));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }
  function countdown(seconds) {
    const total = Math.max(0, Math.round(finite(seconds) ? seconds : 0));
    if (total >= 3600) return Math.floor(total / 3600) + ' 小时 ' + Math.floor((total % 3600) / 60) + ' 分';
    return clock(total);
  }
  function make(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    // Every server-provided string reaches the DOM as text, never as markup.
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---------- audio ---------- */
  /** Build the output graph once. Real gain nodes and a real destination: an advancing
      media clock is not proof that anything is audible.

      Partial construction is handled explicitly. Once an element has been handed to
      createMediaElementSource it can never go back to plain element output, so a failure
      after that point is reported as a failure instead of a silent "fallback". */
  function ensureGraph() {
    if (audio.ctx) return audio.ctx;
    if (audio.graphFailed) return null;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (typeof Ctx !== 'function') return null;
    let ctx = null;
    try {
      ctx = new Ctx({ latencyHint: 'interactive' });
      const master = ctx.createGain();
      const instGain = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      const source = ctx.createMediaElementSource(el.instAudio);
      audio.captured = true;
      source.connect(instGain).connect(master);
      audio.ctx = ctx;
      audio.master = master;
      audio.instGain = instGain;
    } catch (error) {
      audio.graphFailed = true;
      audio.ctx = null;
      audio.master = null;
      audio.instGain = null;
      if (ctx) { try { ctx.close(); } catch (closing) { /* nothing else to release */ } }
      if (audio.captured) {
        // The accompaniment element is attached to a context that failed: there is no
        // working output left, and pretending otherwise would be a silent failure.
        setAudioStatus('这台设备无法启动音频输出，请刷新页面后再演唱。', { sticky: true });
        showAlert('浏览器无法为访客试唱打开音频输出，请刷新页面后重试。',
          { retry: () => location.reload(), retryLabel: '刷新页面' });
      } else {
        setAudioStatus('这个浏览器不支持 Web Audio，伴奏将使用普通音量控制播放。', { sticky: true });
      }
      return null;
    }
    try {
      const guideGain = ctx.createGain();
      ctx.createMediaElementSource(el.guideAudio).connect(guideGain).connect(audio.master);
      audio.guideGain = guideGain;
    } catch (error) {
      // Only the optional guide path is missing; the accompaniment graph is live.
      audio.guideGain = null;
      guideUnavailable('原唱音轨无法接入，伴奏仍然可以播放。');
    }
    ctx.addEventListener?.('statechange', contextChanged);
    applyVolumes();
    return ctx;
  }

  /** The system, another application or a phone call can suspend output at any time.
      Nothing may keep running as if it were still audible. */
  function contextChanged() {
    const ctx = audio.ctx;
    if (!ctx || view.disposed || audio.suspending) return;
    if (ctx.state === 'running') return;
    const playing = !el.instAudio.paused;
    const monitoring = micActive();
    pausePlayback();
    stopMic();
    if (playing || monitoring) {
      setAudioStatus('声音被这台设备打断了，请重新点击播放。');
    }
  }

  /** Must be started synchronously inside a real gesture; callers await the same attempt
      before claiming that anything is audible. */
  function unlock() {
    const ctx = ensureGraph();
    // With no graph at all the elements still play on their own; only an element that was
    // captured by a failed graph has genuinely lost its output.
    if (!ctx) return Promise.resolve(!audio.captured);
    if (ctx.state === 'running') return Promise.resolve(true);
    if (audio.unlocking) return audio.unlocking;
    const pending = (async () => {
      try { await ctx.resume(); } catch (error) { return false; }
      return ctx.state === 'running';
    })();
    audio.unlocking = pending;
    const release = () => { if (audio.unlocking === pending) audio.unlocking = null; };
    pending.then(release, release);
    return pending;
  }

  function applyVolumes() {
    const music = clamp01(Number(el.musicVol.value) / 100) * MAX_MUSIC_GAIN;
    const guide = clamp01(Number(el.guideVol.value) / 100) * MAX_GUIDE_GAIN;
    // With a media-element source the element volume must stay at unity, otherwise the gain
    // node has nothing to work with. A partially built graph mixes both styles on purpose.
    if (audio.instGain) { el.instAudio.volume = 1; audio.instGain.gain.value = music; }
    else el.instAudio.volume = music;
    if (audio.guideGain) { el.guideAudio.volume = 1; audio.guideGain.gain.value = guide; }
    else el.guideAudio.volume = guide;
  }

  const hasGuide = () => !view.guideBroken && !!view.state?.song?.has_vocals
    && !!el.guideAudio.getAttribute('src');

  /** The optional guide track may fail on its own; that must be visible, and it must never
      take the backing track down with it. */
  function guideUnavailable(message) {
    view.guideBroken = true;
    el.guideRow.hidden = true;
    try { el.guideAudio.pause(); } catch (error) { /* already detached */ }
    el.guideAudio.removeAttribute('src');
    try { el.guideAudio.load(); } catch (error) { /* jsdom and detached elements */ }
    setAudioStatus(message, { sticky: true });
  }

  function syncGuide(force = false) {
    if (!hasGuide()) return;
    const drift = Math.abs(el.guideAudio.currentTime - el.instAudio.currentTime);
    if (force || drift > SYNC_TOLERANCE) {
      try { el.guideAudio.currentTime = el.instAudio.currentTime; } catch (error) { /* not seekable yet */ }
    }
    if (el.instAudio.paused) el.guideAudio.pause();
    else if (el.guideAudio.paused) {
      el.guideAudio.play().catch(error => {
        if (hasGuide()) guideUnavailable('原唱音轨已经停止播放，伴奏仍然可以播放。');
      });
    }
  }

  /** A standing failure (no output, no guide track) outlives the next play attempt; only a
      newer message may replace it. */
  function setAudioStatus(message = '', { sticky = false } = {}) {
    if (!message && view.stickyStatus) return;
    view.stickyStatus = sticky && !!message;
    el.audioStatus.textContent = message;
  }

  const playable = () => !view.finished && !view.ended && !view.lapsed
    && !view.disposed && view.state?.status === 'active';

  async function startPlayback() {
    if (!playable()) return false;
    setAudioStatus('');
    // The gesture already started the unlock; wait for that same attempt and believe it.
    const ready = await unlock();
    if (!ready) {
      setAudioStatus('这台设备没有启动音频输出，请再次点击播放重试。');
      updateTransport();
      return false;
    }
    if (!playable()) return false;
    try {
      await el.instAudio.play();
    } catch (error) {
      setAudioStatus('浏览器拦截了播放，请再次点击播放开始这首歌。');
      updateTransport();
      return false;
    }
    view.started = true;
    syncGuide(true);
    startFrames();
    updateTransport();
    return true;
  }

  function pausePlayback() {
    el.instAudio.pause();
    el.guideAudio.pause();
    stopFrames();
    updateTransport();
  }

  /** Stop every sound this page can make. Used for interruption, expiry, completion and
      teardown; it runs before any network call so a failing request cannot keep audio alive. */
  function disarm({ release = false } = {}) {
    try { el.instAudio.pause(); } catch (error) { /* already detached */ }
    try { el.guideAudio.pause(); } catch (error) { /* already detached */ }
    stopMic();
    stopFrames();
    if (release) {
      for (const element of [el.instAudio, el.guideAudio]) {
        element.removeAttribute('src');
        try { element.load(); } catch (error) { /* jsdom and detached elements */ }
      }
      view.songId = null;
    }
    if (audio.ctx && audio.ctx.state === 'running') {
      audio.suspending = true;
      try {
        Promise.resolve(audio.ctx.suspend()).then(
          () => { audio.suspending = false; },
          () => {
            audio.suspending = false;
            // The elements are already paused, but the visitor deserves to know that the
            // page could not release the output device itself.
            showAlert('无法暂停音频输出。如果还能听到声音，请关闭这个标签页。',
              { notice: true });
          });
      } catch (error) {
        audio.suspending = false;
        showAlert('无法暂停音频输出。如果还能听到声音，请关闭这个标签页。',
          { notice: true });
      }
    }
    updateTransport();
  }

  /* ---------- microphone monitoring (opt in, off by default) ---------- */
  function micActive() { return !!audio.micStream; }
  function micPending() { return !!audio.micRequest && audio.micDesired; }

  /** Single flight with an explicit cancellation generation. A second click, a hidden page,
      the end of the song or teardown cancels the request that is still waiting for
      permission, and the stream that arrives late is stopped instead of being wired up. */
  function enableMic() {
    if (micActive()) return Promise.resolve(true);
    // Only a request the visitor still wants may be shared; a cancelled one is left to
    // resolve into the discard path while a fresh generation starts here.
    if (audio.micRequest && audio.micDesired) return audio.micRequest;
    const ctx = ensureGraph();
    if (!ctx) {
      el.micStatus.textContent = '这个浏览器无法进行麦克风监听。';
      setPressed(false);
      return Promise.resolve(false);
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      el.micStatus.textContent = '这个浏览器不支持访问麦克风。';
      setPressed(false);
      return Promise.resolve(false);
    }
    const generation = ++audio.micGeneration;
    audio.micDesired = true;
    el.micStatus.textContent = '正在等待麦克风授权…';
    setPressed(true);
    const attempt = acquireMic(ctx, generation);
    audio.micRequest = attempt;
    const release = () => { if (audio.micRequest === attempt) audio.micRequest = null; };
    attempt.then(release, release);
    return attempt;
  }

  const micCancelled = generation => generation !== audio.micGeneration || !audio.micDesired
    || view.disposed || view.finished || view.ended || view.lapsed
    || doc.visibilityState === 'hidden';

  async function acquireMic(ctx, generation) {
    let stream;
    try {
      // Guests never record, so echo cancellation is worth more here than capture fidelity.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
    } catch (error) {
      if (generation === audio.micGeneration) {
        audio.micDesired = false;
        el.micStatus.textContent = micProblem(error);
        setPressed(false);
      }
      return false;
    }
    if (micCancelled(generation)) {
      // Permission arrived after the visitor (or the page lifecycle) said no: never capture.
      for (const track of stream.getTracks()) track.stop();
      if (generation === audio.micGeneration) {
        audio.micDesired = false;
        setPressed(false);
        if (!view.disposed) el.micStatus.textContent = '麦克风监听已关闭。';
      }
      return false;
    }
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    const monitor = ctx.createGain();
    gain.gain.value = MIC_INPUT_GAIN;
    monitor.gain.value = MIC_MONITOR_GAIN;
    // Speakers plus an open microphone always loops. The compressor cannot remove the
    // cause, but it keeps feedback inside an unpleasant rather than a painful range.
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    source.connect(gain).connect(limiter).connect(monitor).connect(audio.master);
    audio.mic = { source, gain, limiter };
    audio.micStream = stream;
    audio.monitorGain = monitor;
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => stopMic());
    setPressed(true);
    el.micStatus.textContent = '只通过这台设备监听，不会录音，也不会上传。';
    if (ctx.state !== 'running') {
      const running = await unlock();
      // The visitor may have switched monitoring off again while output was starting.
      if (audio.micStream !== stream) return false;
      if (!running) el.micStatus.textContent = '监听已就绪，但这台设备还没有启动音频输出。';
    }
    return true;
  }

  function micProblem(error) {
    const name = error && error.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '麦克风授权被拒绝。你仍然可以跟着伴奏演唱。';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return '没有找到麦克风。你仍然可以跟着伴奏演唱。';
    }
    return '无法打开麦克风。你仍然可以跟着伴奏演唱。';
  }

  /** Turns monitoring off and cancels any permission prompt that is still open. */
  function stopMic() {
    const was = micActive() || micPending();
    audio.micDesired = false;
    audio.micGeneration++;
    if (audio.micStream) {
      for (const track of audio.micStream.getTracks()) track.stop();
    }
    if (audio.mic) {
      for (const node of [audio.mic.source, audio.mic.gain, audio.mic.limiter, audio.monitorGain]) {
        try { node?.disconnect(); } catch (error) { /* already disconnected */ }
      }
    }
    audio.mic = null;
    audio.micStream = null;
    audio.monitorGain = null;
    setPressed(false);
    if (was && !view.disposed) el.micStatus.textContent = '麦克风监听已关闭。';
  }

  function setPressed(on) {
    el.micToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.micToggleLabel.textContent = on ? '关闭麦克风监听' : '打开麦克风监听';
  }

  /* ---------- lyrics ---------- */
  async function loadLyrics(song) {
    const epoch = ++view.lyricsEpoch;
    const stateEpoch = view.stateEpoch;
    el.lyrics.replaceChildren();
    view.lines = [];
    view.activeLine = -1;
    el.lyricsFallback.hidden = !!song.has_lyrics;
    if (!song.has_lyrics) return;
    try {
      // Only ever the selected song's lyrics: the URL is the allowlisted constant.
      const lines = parseLyrics(await request(song.media.lyrics));
      if (epoch !== view.lyricsEpoch || !current(stateEpoch)) return;
      view.lines = lines;
      renderLyrics();
    } catch (error) {
      if (epoch !== view.lyricsEpoch || !current(stateEpoch)) return;
      el.lyricsFallback.hidden = false;
      el.lyricsFallback.textContent = '歌词加载失败，伴奏仍然可以播放。';
    }
  }

  function renderLyrics() {
    const fragment = doc.createDocumentFragment();
    view.lineNodes = [];
    for (const line of view.lines) {
      const node = make('p', 'trial-line');
      if (line.words.length) {
        const words = [];
        for (const word of line.words) {
          const span = make('span', 'trial-word', word.text);
          words.push({ start: word.start, node: span });
          node.append(span);
        }
        line.nodes = words;
      } else {
        node.textContent = line.text;
        line.nodes = [];
      }
      view.lineNodes.push(node);
      fragment.append(node);
    }
    el.lyrics.replaceChildren(fragment);
    el.lyricsFallback.hidden = view.lines.length > 0;
    if (!view.lines.length) {
      el.lyricsFallback.textContent = '这首歌没有同步歌词，可跟着伴奏演唱。';
    }
  }

  function highlight() {
    if (!view.lines.length) return;
    const time = el.instAudio.currentTime;
    let index = -1;
    for (let low = 0, high = view.lines.length; low < high;) {
      const middle = (low + high) >> 1;
      if (view.lines[middle].start <= time + 0.02) { index = middle; low = middle + 1; } else high = middle;
    }
    if (index !== view.activeLine) {
      view.lineNodes[view.activeLine]?.classList.remove('active');
      const node = view.lineNodes[index];
      if (node) {
        node.classList.add('active');
        const offset = node.offsetTop - el.lyrics.clientHeight / 2 + node.offsetHeight / 2;
        el.lyrics.scrollTop = Math.max(0, offset);
      }
      view.activeLine = index;
    }
    const line = view.lines[index];
    if (line && line.nodes.length) {
      for (const word of line.nodes) word.node.classList.toggle('sung', word.start <= time + 0.02);
    }
  }

  function startFrames() {
    if (view.frame || typeof requestAnimationFrame !== 'function') return;
    const step = () => {
      if (view.disposed || el.instAudio.paused) { view.frame = 0; return; }
      highlight();
      updateProgress();
      // Drift is corrected throughout playback, not only when the song starts or seeks.
      const now = Date.now();
      if (now - view.lastSync > 250) { view.lastSync = now; syncGuide(); }
      view.frame = requestAnimationFrame(step);
    };
    view.frame = requestAnimationFrame(step);
  }

  function stopFrames() {
    if (view.frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(view.frame);
    view.frame = 0;
  }

  /* ---------- transport view ---------- */
  function updateTransport() {
    const playing = !el.instAudio.paused && !el.instAudio.ended;
    const text = playing ? '暂停' : view.started ? '继续演唱' : '开始演唱';
    el.playBtn.textContent = text;
    el.playBtn.setAttribute('aria-label', text);
    // Once the accompaniment has finished, or its window has lapsed without an authoritative
    // answer, there is no replay: this guest session is spent until the server says otherwise.
    el.playBtn.disabled = view.finished || view.ended || view.lapsed
      || view.state?.status !== 'active';
  }

  function updateProgress() {
    const duration = finite(el.instAudio.duration) && el.instAudio.duration > 0
      ? el.instAudio.duration : view.state?.song?.duration || 0;
    el.duration.textContent = clock(duration);
    if (view.seeking) return;
    el.elapsed.textContent = clock(el.instAudio.currentTime);
    el.seek.value = String(duration > 0 ? Math.round((el.instAudio.currentTime / duration) * 1000) : 0);
  }

  function startCountdown() {
    stopCountdown();
    // A lapsed window counts down nothing: only an authoritative state may restart it.
    if (view.lapsed || typeof setInterval !== 'function') return;
    if ((view.deadline - Date.now()) / 1000 <= 0) { lapse(); return; }
    view.tick = setInterval(() => {
      const remaining = (view.deadline - Date.now()) / 1000;
      showRemaining(remaining);
      if (remaining <= 0) {
        stopCountdown();
        if (!view.lapsed) lapse();
      }
    }, 1000);
  }

  /** The window this page knows about is over. Sound stops first and stays stopped: if the
      server cannot be reached, buffered audio and an open microphone must not keep running,
      and nothing resumes by itself once the answer is uncertain. */
  function lapse() {
    view.lapsed = true;
    disarm();
    el.trialRemaining.textContent = '本次试唱的时间已经结束。';
    setAudioStatus('试唱时间已结束，正在向服务器确认…');
    return refresh().then(state => {
      if (!state && !view.disposed) {
        setAudioStatus('试唱时间已结束，并且无法连接服务器。登录后即可继续演唱。');
      }
      return state;
    });
  }

  function stopCountdown() {
    if (view.tick) clearInterval(view.tick);
    view.tick = 0;
  }

  function showRemaining(seconds) {
    const status = view.state?.status;
    if (status === 'active') {
      el.trialRemaining.textContent = '这首歌还可以演唱 ' + countdown(seconds) + '。';
    } else if (status === 'available') {
      el.sessionNote.textContent = '这个访客会话可以在 ' + countdown(seconds) + '内选择一首歌。';
    }
  }

  /* ---------- views ---------- */
  function only(section) {
    for (const name of ['loadingView', 'chooseView', 'playerView', 'doneView']) {
      el[name].hidden = name !== section;
    }
  }

  function clearAlert() {
    el.trialAlert.hidden = true;
    el.trialAlert.classList.remove('notice');
    el.trialAlertText.textContent = '';
    el.trialRetry.hidden = true;
    el.trialAlertLink.hidden = true;
    el.trialRetry.onclick = null;
  }

  function showAlert(message, { retry = null, retryLabel = '重试', link = null,
    linkLabel = '登录', notice = false } = {}) {
    el.trialAlert.hidden = false;
    el.trialAlert.classList.toggle('notice', !!notice);
    el.trialAlertText.textContent = message;
    el.trialRetry.hidden = !retry;
    el.trialRetry.textContent = retryLabel;
    el.trialRetry.disabled = false;
    el.trialRetry.onclick = retry;
    el.trialAlertLink.hidden = !link;
    if (link) {
      el.trialAlertLink.href = link;
      el.trialAlertLink.textContent = linkLabel;
    }
  }

  function renderCatalog(songs) {
    view.pending = null;
    const fragment = doc.createDocumentFragment();
    for (const song of songs) {
      const row = make('li', 'trial-song');
      row.dataset.id = song.id;
      const copy = make('div', 'trial-song-copy');
      copy.append(make('span', 'trial-song-title', song.title));
      const detail = [song.artist, clock(song.duration)].filter(Boolean).join(' · ');
      copy.append(make('span', 'trial-song-meta', detail));
      const pick = make('button', 'trial-button trial-pick', '唱这首');
      pick.type = 'button';
      pick.dataset.action = 'pick';
      pick.dataset.id = song.id;
      const confirm = make('div', 'trial-confirm');
      confirm.append(make('p', 'trial-confirm-text',
        '这是本次访客会话唯一能唱的一首歌，确认后就不能更换了。'));
      const actions = make('div', 'trial-confirm-actions');
      const yes = make('button', 'trial-button primary trial-confirm-yes', '确认，就唱这首');
      yes.type = 'button';
      yes.dataset.action = 'confirm';
      yes.dataset.id = song.id;
      const no = make('button', 'trial-button ghost trial-confirm-no', '再看看');
      no.type = 'button';
      no.dataset.action = 'cancel';
      actions.append(yes, no);
      confirm.append(actions);
      row.append(copy, pick, confirm);
      fragment.append(row);
    }
    el.catalogList.replaceChildren(fragment);
  }

  /** A terminal session keeps no pick controls around, not even hidden ones. */
  function clearChoices() {
    view.pending = null;
    view.catalogEpoch++;
    if (view.searchTimer) { clearTimeout(view.searchTimer); view.searchTimer = 0; }
    el.catalogList.replaceChildren();
    el.catalogStatus.textContent = '';
    el.sessionNote.textContent = '';
    el.songSearch.value = '';
    el.searchClear.hidden = true;
  }

  function showChoose(state) {
    only('chooseView');
    view.songId = null;
    view.started = false;
    view.finished = false;
    if (state.remaining_seconds > 1) view.lapsed = false;
    view.deadline = Date.now() + state.remaining_seconds * 1000;
    showRemaining(state.remaining_seconds);
    startCountdown();
  }

  function showPlayer(state) {
    const song = state.song;
    only('playerView');
    view.finished = false;
    view.completionFailed = false;
    // The choice is locked: no pick control survives anywhere, not even hidden.
    clearChoices();
    // An authoritative active answer with time left clears a lapsed window, but never
    // resumes by itself. An answer that is already at its end stays disarmed.
    if (view.lapsed && state.remaining_seconds > 1) {
      view.lapsed = false;
      setAudioStatus('试唱时间已经刷新。准备好后点击播放继续。');
    }
    el.trialTitle.textContent = song.title;
    view.songTitle = song.title;
    el.trialArtist.textContent = [song.artist, song.track !== song.title ? song.track : '']
      .filter(Boolean).join(' · ');
    el.guideRow.hidden = !song.has_vocals;
    el.duration.textContent = clock(song.duration);
    view.deadline = Date.now() + state.remaining_seconds * 1000;
    showRemaining(state.remaining_seconds);
    startCountdown();
    if (view.songId !== song.id) {
      view.songId = song.id;
      view.started = false;
      view.ended = false;
      // Constants, not server strings: this page can only ever play its own trial media.
      el.instAudio.src = MEDIA.instrumental;
      view.guideBroken = false;
      if (song.has_vocals) el.guideAudio.src = MEDIA.vocals;
      else el.guideAudio.removeAttribute('src');
      el.guideVol.value = '0';
      applyVolumes();
      loadLyrics(song);
      setAudioStatus('歌曲已经锁定。准备好后点击播放开始演唱。');
    }
    updateProgress();
    updateTransport();
  }

  function showDone(status) {
    only('doneView');
    view.finished = true;
    view.lapsed = false;
    // Nothing that was already in flight may reopen a player or a song list after this.
    invalidate();
    stopCountdown();
    disarm({ release: true });
    clearChoices();
    const expired = status === 'expired';
    // The server returns no song in a terminal state; naming the song that was sung is a
    // courtesy drawn from what this page already showed, never a requirement.
    const sung = view.songTitle ? '《' + view.songTitle + '》' : '';
    el.doneTitle.textContent = expired ? '本次访客会话已经结束' : '你的试唱歌曲已唱完';
    el.doneMessage.textContent = expired
      ? '本次访客会话的时间窗口已经过去。登录后可以随时继续演唱。'
      : '谢谢演唱' + sung + '。本次试唱额度已用完，登录后可以继续演唱。';
    el.loginCta.href = LOGIN_URL;
    el.guestEntry.hidden = true;
  }

  /** An authoritative 401 means this browser has no guest session at all. Offer the two
      honest ways forward and never quietly mint a replacement trial. */
  function showSignedOut() {
    only('doneView');
    view.finished = true;
    view.lapsed = false;
    invalidate();
    stopCountdown();
    disarm({ release: true });
    clearChoices();
    el.doneTitle.textContent = '这个访客会话已经不可用';
    el.doneMessage.textContent = MESSAGES.signedOut;
    el.loginCta.href = LOGIN_URL;
    el.guestEntry.href = GUEST_ENTRY_URL;
    el.guestEntry.hidden = false;
  }

  function apply(state) {
    view.state = state;
    clearAlert();
    if (state.status === 'available') showChoose(state);
    else if (state.status === 'active') showPlayer(state);
    else showDone(state.status);
    return state;
  }

  function failure(error, { retry = null } = {}) {
    if (error && error.status === 401) { showSignedOut(); return; }
    if (error && error.status === 410) {
      // A used-up selection and a timed-out grant both answer 410. Show the best ending this
      // page can justify, then ask the state endpoint once which one it really was.
      const known = view.state && ['complete', 'expired'].includes(view.state.status)
        ? view.state.status : view.ended ? 'complete' : 'expired';
      terminal(known);
      if (!view.recovering) {
        view.recovering = true;
        refresh().finally(() => { view.recovering = false; });
      }
      return;
    }
    // Without any known state there is nothing honest to show behind the alert.
    if (!view.state) el.loadingView.hidden = true;
    showAlert((error && error.message) || MESSAGES.generic, {
      retry, link: LOGIN_URL, linkLabel: '改为登录',
    });
  }

  function terminal(status) {
    view.state = { status, song: null, started_at: null, expires_at: null, remaining_seconds: 0 };
    showDone(status);
  }

  /* ---------- actions ---------- */
  async function refresh() {
    const epoch = invalidate();
    try {
      const state = parseState(await request(API.state));
      // A reply that lost the race must never repaint a session that has moved on.
      if (!current(epoch)) return null;
      return apply(state);
    } catch (error) {
      if (!current(epoch)) return null;
      failure(error, { retry: () => refresh() });
      return null;
    }
  }

  async function loadCatalog(query = '') {
    const epoch = ++view.catalogEpoch;
    const stateEpoch = view.stateEpoch;
    const trimmed = String(query || '').slice(0, MAX_QUERY).trim();
    const url = API.catalog + (trimmed ? '?q=' + encodeURIComponent(trimmed) : '');
    try {
      const value = parseCatalog(await request(url));
      // A slower earlier reply must never repaint a newer search, and no reply may repaint
      // a song list after the session has locked its choice or ended.
      if (epoch !== view.catalogEpoch || !current(stateEpoch)) return null;
      renderCatalog(value.songs);
      el.catalogStatus.textContent = value.songs.length
        ? '共 ' + value.songs.length + ' 首可以试唱'
          + (value.songs.length >= value.limit ? '（只显示前 ' + value.limit + ' 首）' : '')
        : trimmed ? '没有找到匹配的歌曲。' : '现在没有可以试唱的歌曲。';
      return value;
    } catch (error) {
      if (epoch !== view.catalogEpoch || !current(stateEpoch)) return null;
      el.catalogStatus.textContent = '歌曲列表加载失败。';
      failure(error, { retry: () => loadCatalog(el.songSearch.value) });
      return null;
    }
  }

  async function select(songId) {
    if (view.selecting || typeof songId !== 'string' || !JOB_ID.test(songId)) return null;
    view.selecting = true;
    // Choosing the one song is authoritative: any state read still in flight is discarded.
    const epoch = invalidate();
    for (const button of el.catalogList.querySelectorAll('button')) button.disabled = true;
    try {
      const state = parseState(await request(API.select, { method: 'POST', body: { job_id: songId } }));
      if (!current(epoch)) return null;
      return apply(state);
    } catch (error) {
      if (!current(epoch)) return null;
      if (error.status === 409) {
        // Another tab already locked this session's song: take the server's answer, and
        // never replay the selection this tab wanted.
        showAlert(MESSAGES.locked, { notice: true });
        const state = await refresh();
        if (state) showAlert(MESSAGES.locked, { notice: true });
        return state;
      }
      failure(error, { retry: null });
      return null;
    } finally {
      view.selecting = false;
      for (const button of el.catalogList.querySelectorAll('button')) button.disabled = false;
    }
  }

  /** Consume the trial at the natural end of the accompaniment. Sound stops first, and a
      failed request is reported as a failure instead of a fake completion. */
  async function finish() {
    if (view.finishing) return null;
    view.finishing = true;
    // Completion outranks anything already in flight: no late "active" may revive the player.
    const epoch = invalidate();
    disarm();
    stopCountdown();
    try {
      const value = parseState(await request(API.complete, { method: 'POST', body: {} }));
      if (!current(epoch)) return null;
      const state = apply(value);
      view.completionFailed = false;
      return state;
    } catch (error) {
      if (!current(epoch)) return null;
      if (error.status === 410 || error.status === 401) { failure(error); return null; }
      view.completionFailed = true;
      showAlert(MESSAGES.completion + ' ' + ((error && error.message) || ''), {
        retry: () => { clearAlert(); finish(); },
        retryLabel: '完成试唱',
        link: LOGIN_URL, linkLabel: '改为登录',
      });
      return null;
    } finally {
      view.finishing = false;
    }
  }

  function teardown() {
    view.disposed = true;
    invalidate();
    stopCountdown();
    stopFrames();
    disarm({ release: true });
    if (audio.ctx && typeof audio.ctx.close === 'function' && audio.ctx.state !== 'closed') {
      try { audio.ctx.close(); } catch (error) { /* best effort on unload */ }
    }
  }

  /* ---------- wiring ---------- */
  el.catalogList.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const row = button.closest('.trial-song');
    if (button.dataset.action === 'cancel') {
      row?.classList.remove('confirming');
      view.pending = null;
      return;
    }
    // Still inside the gesture: unlock output before anything awaits the network.
    unlock();
    if (button.dataset.action === 'pick') {
      for (const other of el.catalogList.querySelectorAll('.trial-song.confirming')) {
        other.classList.remove('confirming');
      }
      row?.classList.add('confirming');
      view.pending = button.dataset.id;
      row?.querySelector('.trial-confirm-yes')?.focus();
      return;
    }
    if (button.dataset.action === 'confirm') select(button.dataset.id);
  });

  el.songSearch.addEventListener('input', () => {
    el.searchClear.hidden = !el.songSearch.value;
    if (view.searchTimer) clearTimeout(view.searchTimer);
    view.searchTimer = setTimeout(() => {
      view.searchTimer = 0;
      loadCatalog(el.songSearch.value);
    }, SEARCH_DELAY);
  });
  el.searchClear.addEventListener('click', () => {
    el.songSearch.value = '';
    el.searchClear.hidden = true;
    el.songSearch.focus();
    loadCatalog('');
  });

  el.playBtn.addEventListener('click', () => {
    unlock();
    if (el.instAudio.paused) startPlayback();
    else pausePlayback();
  });
  el.micToggle.addEventListener('click', () => {
    unlock();
    // A second click while the permission prompt is open cancels it instead of asking twice.
    if (micActive() || micPending()) stopMic();
    else enableMic();
  });
  for (const slider of [el.musicVol, el.guideVol]) slider.addEventListener('input', applyVolumes);

  el.seek.addEventListener('input', () => {
    view.seeking = true;
    const duration = finite(el.instAudio.duration) && el.instAudio.duration > 0
      ? el.instAudio.duration : view.state?.song?.duration || 0;
    el.elapsed.textContent = clock((Number(el.seek.value) / 1000) * duration);
  });
  el.seek.addEventListener('change', () => {
    const duration = finite(el.instAudio.duration) && el.instAudio.duration > 0
      ? el.instAudio.duration : view.state?.song?.duration || 0;
    view.seeking = false;
    if (duration > 0) {
      try { el.instAudio.currentTime = (Number(el.seek.value) / 1000) * duration; } catch (error) { /* not seekable */ }
    }
    syncGuide(true);
    highlight();
    updateProgress();
  });

  el.instAudio.addEventListener('timeupdate', () => { updateProgress(); highlight(); syncGuide(); });
  el.instAudio.addEventListener('seeked', () => { syncGuide(true); highlight(); });
  el.instAudio.addEventListener('play', () => { startFrames(); updateTransport(); });
  el.instAudio.addEventListener('pause', () => { if (hasGuide()) el.guideAudio.pause(); updateTransport(); });
  el.instAudio.addEventListener('loadedmetadata', () => { updateProgress(); syncGuide(true); });
  el.instAudio.addEventListener('waiting', () => setAudioStatus('正在缓冲伴奏…'));
  el.instAudio.addEventListener('playing', () => setAudioStatus(''));
  el.instAudio.addEventListener('ended', () => {
    if (view.finished || view.ended) return;
    view.ended = true;
    finish();
  });
  el.instAudio.addEventListener('error', () => {
    if (!el.instAudio.getAttribute('src')) return;
    setAudioStatus('伴奏加载失败，请刷新页面后重试。');
  });
  el.guideAudio.addEventListener('error', () => {
    if (!el.guideAudio.getAttribute('src')) return;
    guideUnavailable('原唱音轨加载失败，伴奏仍然可以播放。');
  });

  // A page kept in the back/forward cache can come back: release the microphone and the
  // sound, but keep the graph intact so a restored page can resume its own song.
  window.addEventListener('pagehide', event => {
    if (event.persisted) { stopMic(); disarm(); } else teardown();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && !view.completionFailed) { view.disposed = false; refresh(); }
  });
  doc.addEventListener('visibilitychange', () => {
    // A hidden page never keeps a microphone open, and a returning tab re-reads the
    // authoritative state so a sibling tab's choice or completion is respected.
    if (doc.visibilityState === 'hidden') stopMic();
    else if (!view.finished && !view.finishing && !view.completionFailed) refresh();
  });
  /* ---------- boot ---------- */
  async function boot() {
    setPressed(false);
    applyVolumes();
    const state = await refresh();
    if (state && state.status === 'available') await loadCatalog('');
    return state;
  }

  const ready = doc.readyState === 'loading'
    ? new Promise(resolve => doc.addEventListener('DOMContentLoaded', resolve, { once: true })).then(boot)
    : boot();

  window.OpenKTrial = {
    ready, request, parseState, parseCatalog, parseLyrics,
    refresh, loadCatalog, select, finish, teardown, disarm, unlock, lapse,
    enableMic, stopMic, startPlayback, pausePlayback, applyVolumes, highlight,
    MEDIA, API, LOGIN_URL, GUEST_ENTRY_URL,
    get state() { return view.state; },
    get view() { return view; },
    get audio() { return audio; },
    get micActive() { return micActive(); },
    get micPending() { return micPending(); },
  };
})();
