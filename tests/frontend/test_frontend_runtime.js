'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => JSON.parse(JSON.stringify(data)),
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function song(id, extra = {}) {
  return { id, state: 'done', title: `歌曲${id}`, track: `歌曲${id}`, artist: '歌手',
    duration: 180, line_count: 2, lyrics_status: 'ok',
    media: { instrumental: `/m/${id}.mp3`, vocals: `/m/${id}-v.mp3`, lyrics: `/l/${id}.json` },
    ...extra };
}

async function fixture(t, options = {}) {
  const dom = new JSDOM(html, { url: 'https://localhost' + (options.pathname || '/'),
    runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const f = { w, dom, jobs: [song('a'), song('b'), { id: 'p', title: '处理中', state: 'running', progress: 40 }],
    calls: [], plays: [], contexts: [], recorders: [], stops: [], streams: [], revoked: [],
    timeouts: new Map(), intervals: new Map(), frames: new Map(), hidden: false,
    uploadStatus: 200, micCalls: 0, playError: null, route: options.route };
  let timerId = 0, objectId = 0;
  const add = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...args) => { if (type !== 'DOMContentLoaded') add(type, ...args); };
  w.setTimeout = (fn, delay = 0) => { const id = ++timerId; f.timeouts.set(id, { fn, delay }); return id; };
  w.clearTimeout = (id) => f.timeouts.delete(id);
  w.setInterval = (fn, delay) => { const id = ++timerId; f.intervals.set(id, { fn, delay }); return id; };
  w.clearInterval = (id) => f.intervals.delete(id);
  w.requestAnimationFrame = (fn) => { const id = ++timerId; f.frames.set(id, fn); return id; };
  w.cancelAnimationFrame = (id) => f.frames.delete(id);
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => f.hidden });
  Object.defineProperty(w, 'isSecureContext', { configurable: true, value: true });
  const media = w.HTMLMediaElement.prototype;
  Object.defineProperties(media, {
    paused: { configurable: true, get() { return this._paused !== false; } },
    duration: { configurable: true, get() { return this._duration || 180; } },
    currentTime: { configurable: true, get() { return this._time || 0; }, set(value) { this._time = value; } },
    readyState: { configurable: true, get() { return 4; } },
    seeking: { configurable: true, get() { return false; } },
  });
  media.play = function () {
    f.plays.push(this.id);
    if (f.playError && this.id === 'instAudio') return Promise.reject(f.playError);
    this._paused = false;
    this.dispatchEvent(new w.Event('play'));
    this.dispatchEvent(new w.Event('playing'));
    return Promise.resolve();
  };
  media.pause = function () {
    const changed = !this.paused;
    this._paused = true;
    if (changed) this.dispatchEvent(new w.Event('pause'));
  };
  media.load = function () { this._time = 0; };
  w.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
  const param = (value = 1) => ({ value, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; } });
  const node = () => ({ connect() {}, disconnect() {}, gain: param(), frequency: param(1000),
    Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    fftSize: 2048, frequencyBinCount: 2048, stream: {}, getFloatFrequencyData(a) { a.fill(-120); } });
  w.AudioContext = function () {
    const context = { state: 'running', currentTime: 0, sampleRate: 48000, destination: node(),
      resume: async () => { context.state = 'running'; }, close: async () => { context.state = 'closed'; },
      createGain: node, createConvolver: node, createDynamicsCompressor: node,
      createBiquadFilter: node, createAnalyser: node, createMediaElementSource: node,
      createMediaStreamSource: node, createMediaStreamDestination: node,
      createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }) };
    f.contexts.push(context);
    return context;
  };
  f.makeStream = () => {
    const track = { stopped: 0, stop() { this.stopped++; } };
    const stream = { track, getTracks: () => [track] };
    f.streams.push(stream);
    return stream;
  };
  w.navigator.mediaDevices = { getUserMedia: () => {
    f.micCalls++;
    return options.mic ? options.mic(f) : Promise.resolve(f.makeStream());
  } };
  w.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() {
      this.mimeType = options.mimeType || 'audio/webm;codecs=opus';
      this.state = 'inactive';
      f.recorders.push(this);
    }
    start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      const finish = async () => {
        this.ondataavailable?.({ data: new w.Blob(['captured sound'], { type: this.mimeType }) });
        await this.onstop?.();
      };
      if (options.deferRecorderStop) f.stops.push(finish);
      else Promise.resolve().then(finish);
    }
  };
  w.URL.createObjectURL = () => 'blob:recording-' + ++objectId;
  w.URL.revokeObjectURL = (url) => f.revoked.push(url);
  w.alert = () => {};
  w.confirm = () => true;
  const prefs = { micMonitor: false, micVol: 110, howlGuard: true, reverb: 'ktv', singMode: 'inst', v: 2,
    ...options.prefs };
  w.localStorage.setItem('openk.prefs', JSON.stringify(prefs));
  Object.entries(options.storage || {}).forEach(([key, value]) => w.localStorage.setItem(key, value));
  w.fetch = async (url, request = {}) => {
    url = String(url);
    const call = { url, ...request };
    f.calls.push(call);
    if (f.route) {
      const custom = await f.route(url, request, f);
      if (custom !== undefined) return custom;
    }
    if (url === '/api/jobs') return response(f.jobs);
    if (url === '/api/zh-map') return response({ '夢': '梦' });
    if (url === '/api/local/status') return response({ enabled: false });
    if (/\/recordings(?:\?|$)/.test(url)) {
      return request.method === 'POST' ? response({ ok: true }, f.uploadStatus) : response([]);
    }
    if (/\/lyrics\/align$/.test(url)) {
      const jobId = url.split('/')[3];
      return response({ operation: { id: 'op-' + jobId, job_id: jobId, state: 'queued', message: '排队中' } }, 202);
    }
    if (url.startsWith('/api/operations/')) {
      const id = url.split('/').pop();
      return response({ id, job_id: id.replace('op-', ''), state: 'running', message: '对齐中' });
    }
    if (url.startsWith('/api/lyrics/search')) return response([]);
    const job = /^\/api\/jobs\/([^/]+)$/.exec(url);
    if (job) return response(f.jobs.find((j) => j.id === job[1]) || { detail: '任务不存在' },
      f.jobs.some((j) => j.id === job[1]) ? 200 : 404);
    const lyrics = /^\/l\/([^/.]+)\.json/.exec(url);
    if (lyrics) return response({ language: 'zh', source: lyrics[1], lines: [
      { start: 0, end: 10, text: `歌词${lyrics[1]}一`, words: [
        { text: '第一', start: 0, end: 1 }, { text: '句', start: 1, end: 10 }] },
      { start: 10, end: 20, text: `歌词${lyrics[1]}二`, words: [] },
    ] });
    throw new Error('Unexpected mock request: ' + url);
  };
  w.eval(fs.readFileSync(path.join(root, 'frontend/search.js'), 'utf8'));
  w.eval(script + `\nwindow.__t = {
    state, api, prefs, init, selectJob, showBrowse, showStage, endPlayback, playFromQueue,
    startPolling, stopPolling, refreshList, renderBrowse, renderQueue, songInfo, addToQueue,
    ensureMic, cleanupMic, applyMonitorState, startRecording, stopRecording, uploadRecording,
    renderLyrics, updateLyrics, enterLyricsEdit, exitLyricsEdit, loadRecordings, loadPlayerLyrics,
    saveLyricsEdit, doLyricSearch,
    openDrawer, closeDrawers, startPlayback, pausePlayback, seekTo, applyLyric, scheduleAlignment,
    renderAlignmentStatus, stopLyricAnimation, invalidateSelection
  };`);
  f.a = w.__t;
  f.$ = (selector) => w.document.querySelector(selector);
  f.click = (selector) => f.$(selector).click();
  f.key = (target, key, code = key, extra = {}) => {
    const e = new w.KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(e);
    return e;
  };
  f.timer = async (id) => {
    const entry = f.timeouts.get(id);
    assert.ok(entry, `timer ${id} exists`);
    f.timeouts.delete(id);
    await entry.fn();
    await flush();
  };
  f.visibility = async (hidden) => {
    f.hidden = hidden;
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    await flush();
  };
  f.count = (url) => f.calls.filter((call) => call.url === url).length;
  f.a.init();
  await flush();
  t.after(async () => {
    await flush();
    f.a.state.disposed = true;
    f.a.stopPolling();
    f.a.cleanupMic();
    f.a.stopLyricAnimation();
    w.close();
  });
  return f;
}

test('latest selection wins even when an aborted detail request resolves last', async (t) => {
  const slow = deferred();
  const f = await fixture(t, { route: (url) => url === '/api/jobs/a' ? slow.promise : undefined });
  const first = f.a.selectJob('a');
  await flush();
  assert.equal(f.contexts.length, 1, 'audio is unlocked before the detail response');
  const request = f.calls.find((c) => c.url === '/api/jobs/a');
  await f.a.selectJob('b');
  slow.resolve(response(song('a')));
  await first;
  assert.equal(request.signal.aborted, true);
  assert.equal(f.a.state.currentJobId, 'b');
  assert.equal(f.$('#instAudio').getAttribute('src'), '/m/b.mp3');
  assert.equal(f.$('#nbTitle').textContent, '歌曲b');
});

test('focused polling is single-flight, skips catalog ticks, and never replaces playback', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  const initial = f.count('/api/jobs');
  f.a.startPolling('p');
  await f.timer(f.a.state.pollTimer);
  await f.timer(f.a.state.pollTimer);
  assert.equal(f.count('/api/jobs'), initial);
  assert.equal(f.a.state.currentJobId, 'a');
  const pending = deferred();
  f.route = (url) => url === '/api/jobs/p' ? pending.promise : undefined;
  const tick = f.timer(f.a.state.pollTimer);
  await flush();
  assert.equal(f.a.state.pollTimer, null, 'no next timer while request is pending');
  assert.ok(f.a.state.pollRequest);
  const completed = song('p');
  f.jobs[2] = completed;
  pending.resolve(response(completed));
  await tick;
  assert.equal(f.count('/api/jobs'), initial + 1);
  assert.equal(f.a.state.inspectedJobId, null);
  assert.equal(f.a.state.currentJobId, 'a');
  assert.equal(f.$('#instAudio').getAttribute('src'), '/m/a.mp3');
});

test('stopped focused polls cannot commit a late completion', async (t) => {
  const slow = deferred();
  const f = await fixture(t, { route: (url) => url === '/api/jobs/p' ? slow.promise : undefined });
  f.a.startPolling('p');
  const initial = f.count('/api/jobs');
  const tick = f.timer(f.a.state.pollTimer);
  await flush();
  f.a.stopPolling();
  slow.resolve(response(song('p')));
  await tick;
  assert.equal(f.count('/api/jobs'), initial);
  assert.equal(f.a.state.pollTimer, null);
});

test('deleted inspected jobs stop polling without stopping the current song', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.route = (url) => url === '/api/jobs/p' ? response({ detail: '任务不存在' }, 404) : undefined;
  f.a.startPolling('p');
  await f.timer(f.a.state.pollTimer);
  assert.equal(f.a.state.pollTimer, null);
  assert.equal(f.a.state.inspectedJobId, null);
  assert.equal(f.$('#instAudio').paused, false);
});

test('late lyrics and recordings do not overwrite a newly selected song', async (t) => {
  const lyrics = deferred(), recordings = deferred();
  const f = await fixture(t, { route: (url) => {
    if (url === '/l/a.json') return lyrics.promise;
    if (url === '/api/jobs/a/recordings') return recordings.promise;
  } });
  const first = f.a.selectJob('a');
  await flush();
  await f.a.selectJob('b');
  lyrics.resolve(response({ source: 'old-A', lines: [] }));
  recordings.resolve(response([{ url: '/old-recording.webm', file: 'old.webm' }]));
  await first;
  await flush();
  assert.equal(f.a.state.lyrics.source, 'b');
  assert.equal(f.$('#recList').children.length, 0);
  assert.equal(f.$('#lyricSource').textContent, '歌词来源：b');
});

test('inspecting a pending song leaves current lyric loading and playback intact', async (t) => {
  const slow = deferred();
  const f = await fixture(t, { route: (url) => url === '/l/a.json' ? slow.promise : undefined });
  const playing = f.a.selectJob('a');
  await flush();
  const generation = f.a.state.selectionGeneration;
  await f.a.selectJob('p');
  assert.equal(f.a.state.selectionGeneration, generation);
  assert.equal(f.a.state.currentJobId, 'a');
  assert.equal(f.a.state.inspectedJobId, 'p');
  slow.resolve(response({ source: 'a', lines: [{ start: 0, end: 10, text: '继续唱' }] }));
  await playing;
  assert.equal(f.a.state.lyrics.source, 'a');
  assert.equal(f.$('#instAudio').paused, false);
});

test('late lyric-edit save and search results cannot change the next song', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  const saved = deferred(), searched = deferred();
  f.a.api.updateLyrics = () => saved.promise;
  f.a.api.searchLyrics = () => searched.promise;
  f.a.enterLyricsEdit();
  f.$('.lyric-edit').value = '修改后的歌词';
  const saving = f.a.saveLyricsEdit();
  f.$('#lsQuery').value = '歌手 歌曲a';
  const searching = f.a.doLyricSearch();
  await f.a.selectJob('b');
  saved.resolve({ ok: true });
  searched.resolve([{ id: 55, trackName: '旧结果', synced: true }]);
  await Promise.all([saving, searching]);
  assert.equal(f.a.state.lyrics.source, 'b');
  assert.equal(f.a.state.editing, false);
  assert.doesNotMatch(f.$('#lsResults').textContent, /旧结果/);
});

test('manual lyric save resolves the newly published immutable lyric URL', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.route = (url, request) => {
    if (url === '/api/jobs/a/lyrics' && request.method === 'PUT') {
      f.jobs[0].media.lyrics = '/l/a-v2.json';
      return response({ ok: true, lyrics_file: 'artifacts/v2/lyrics.json' });
    }
  };
  f.a.enterLyricsEdit();
  f.$('.lyric-edit').value = '新的歌词';
  await f.a.saveLyricsEdit();
  assert.equal(f.a.state.lyricsUrl, '/l/a-v2.json');
  assert.equal(f.a.state.lyrics.source, 'a-v2');
  assert.equal(f.calls.some((c) => c.url.startsWith('/l/a.json?')), false);
});

test('manual selection and replay cancel automatic next-song timers', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.a.state.queue = ['b'];
  f.$('#instAudio').dispatchEvent(new f.w.Event('ended'));
  const stale = f.timeouts.get(f.a.state.endedTimer).fn;
  await f.a.selectJob('b');
  stale();
  await flush();
  assert.equal(f.a.state.currentJobId, 'b');
  assert.equal(f.a.state.queue.length, 1);
  f.$('#instAudio').dispatchEvent(new f.w.Event('ended'));
  const timer = f.a.state.endedTimer;
  f.a.seekTo(0);
  assert.equal(f.timeouts.has(timer), false);
});

test('recording is saved under its captured song after next-song selection', async (t) => {
  const f = await fixture(t, { deferRecorderStop: true });
  await f.a.selectJob('a');
  await f.a.startRecording();
  assert.equal(f.a.state.recording, true);
  assert.equal(f.recorders[0].timeslice, 1000);
  await f.a.selectJob('b');
  assert.equal(f.stops.length, 1);
  await f.stops[0]();
  const upload = f.calls.find((c) => c.method === 'POST' && c.url.includes('/recordings?'));
  assert.match(upload.url, /^\/api\/jobs\/a\/recordings\?/);
  assert.equal(f.$('#nbTitle').textContent, '歌曲b');
  assert.notEqual(f.$('#recStatus').textContent, '已保存 ✓', 'old save does not replace new song status');
});

test('ending playback still uploads the captured recording after current ID is cleared', async (t) => {
  const f = await fixture(t, { deferRecorderStop: true });
  await f.a.selectJob('a');
  await f.a.startRecording();
  f.a.endPlayback();
  assert.equal(f.a.state.currentJobId, null);
  await f.stops[0]();
  assert.ok(f.calls.some((c) => c.method === 'POST' && c.url.startsWith('/api/jobs/a/recordings?')));
});

test('recording duration is session-local and duplicate stop delivery does not upload twice', async (t) => {
  const f = await fixture(t, { deferRecorderStop: true });
  let now = 1000;
  f.w.Date.now = () => now;
  await f.a.selectJob('a');
  await f.a.startRecording();
  const original = f.a.state.recordingSession;
  now = 6000;
  f.a.stopRecording();
  now = 9000;
  await f.a.startRecording();
  await f.stops[0]();
  await f.stops[0]();
  assert.equal(original.duration, 5);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(f.a.state.recording, true);
  f.a.stopRecording();
  await f.stops[1]();
});

test('switching songs during microphone authorization never starts a stale recording', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { mic: () => permission.promise });
  await f.a.selectJob('a');
  const recording = f.a.startRecording();
  await flush();
  await f.a.selectJob('b');
  const stream = f.makeStream();
  permission.resolve(stream);
  await recording;
  assert.equal(f.recorders.length, 0);
  assert.equal(f.a.state.currentJobId, 'b');
  assert.equal(stream.track.stopped, 1);
  assert.equal(f.$('#recBtn').disabled, false);
});

test('HTTP failure retains MP4 recording, exposes download, and retry is single-flight', async (t) => {
  const f = await fixture(t, { mimeType: 'audio/mp4', deferRecorderStop: true });
  await f.a.selectJob('a');
  await f.a.startRecording();
  f.uploadStatus = 503;
  f.a.stopRecording();
  await f.stops[0]();
  assert.equal(f.a.state.pendingRecordings.size, 1);
  assert.match(f.$('#recStatus').textContent, /保存失败/);
  const session = [...f.a.state.pendingRecordings.values()][0];
  const upload = f.calls.find((c) => c.method === 'POST');
  assert.equal(upload.headers['Content-Type'], 'audio/mp4');
  assert.ok(session.blob.size > 0);
  assert.match(f.$('#pendingRecordings a').download, /\.m4a$/);
  const retry = deferred();
  f.route = (url, request) => request.method === 'POST' ? retry.promise : undefined;
  const first = f.a.uploadRecording(session), second = f.a.uploadRecording(session);
  assert.equal(first, second);
  await flush();
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 2);
  retry.resolve(response({ ok: true }));
  await first;
  assert.equal(f.a.state.pendingRecordings.size, 0);
  assert.equal(f.$('#recStatus').textContent, '已保存 ✓');
  assert.equal(f.revoked.length, 1);
});

test('recording start is single-flight while waiting for microphone permission', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { mic: () => permission.promise });
  await f.a.selectJob('a');
  const first = f.a.startRecording(), second = f.a.startRecording();
  await flush();
  assert.equal(f.micCalls, 1);
  permission.resolve(f.makeStream());
  await Promise.all([first, second]);
  assert.equal(f.recorders.length, 1);
  assert.equal(f.a.state.recording, true);
  f.a.stopRecording();
  await flush();
});

test('finishing an old upload cannot cancel a new recording microphone request', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { deferRecorderStop: true,
    mic: (app) => app.micCalls === 1 ? Promise.resolve(app.makeStream()) : permission.promise });
  await f.a.selectJob('a');
  await f.a.startRecording();
  f.a.stopRecording();
  const starting = f.a.startRecording();
  await flush();
  await f.stops[0]();
  assert.ok(f.a.state.micRequest);
  permission.resolve(f.makeStream());
  await starting;
  assert.equal(f.a.state.recording, true);
  f.a.stopRecording();
  await f.stops[1]();
});

test('microphone requests are shared and a late cancelled stream is stopped', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { mic: () => permission.promise });
  const first = f.a.ensureMic().catch((e) => e), second = f.a.ensureMic().catch((e) => e);
  await flush();
  assert.equal(f.micCalls, 1);
  f.a.cleanupMic();
  const stream = f.makeStream();
  permission.resolve(stream);
  const results = await Promise.all([first, second]);
  await flush();
  assert.equal(results[0].name, 'AbortError');
  assert.equal(results[1].name, 'AbortError');
  assert.equal(stream.track.stopped, 1);
  assert.equal(f.a.state.audioGraph.mic, null);
});

test('microphone authorization timeout releases a subsequently returned stream', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { mic: () => permission.promise });
  const attempt = f.a.ensureMic().catch((e) => e);
  await flush();
  const [timer] = [...f.timeouts.entries()].reverse().find(([, entry]) => entry.delay > 14000 && entry.delay <= 15000);
  await f.timer(timer);
  assert.match((await attempt).message, /超时/);
  const stream = f.makeStream();
  permission.resolve(stream);
  await flush();
  assert.equal(stream.track.stopped, 1);
  assert.equal(f.a.state.micRequest, null);
});

test('recording preparation reports pending permission and recovers without a blocking alert', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { mic: () => permission.promise });
  await f.a.selectJob('a');
  let alerts = 0;
  f.w.alert = () => { alerts++; };
  const recording = f.a.startRecording();
  await flush();
  assert.equal(f.$('#recBtn').textContent, '准备录音…');
  assert.match(f.$('#recStatus').textContent, /连接麦克风/);
  const [timer] = [...f.timeouts.entries()].reverse().find(([, entry]) => entry.delay > 14000 && entry.delay <= 15000);
  await f.timer(timer);
  await recording;
  assert.equal(f.$('#recBtn').disabled, false);
  assert.equal(f.$('#recBtn').textContent, '🎤 开始录唱');
  assert.match(f.$('#recStatus').textContent, /超时/);
  assert.equal(alerts, 0);
  permission.resolve(f.makeStream());
  await flush();
});

test('microphone acquisition also bounds a suspended AudioContext resume', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.a.state.audioGraph.actx.state = 'suspended';
  f.a.state.audioGraph.actx.resume = () => new Promise(() => {});
  const recording = f.a.startRecording();
  await flush();
  const [timer] = [...f.timeouts.entries()].reverse().find(([, entry]) => entry.delay === 8000);
  await f.timer(timer);
  await recording;
  assert.equal(f.$('#recBtn').disabled, false);
  assert.match(f.$('#recStatus').textContent, /音频引擎启动超时/);
  assert.equal(f.micCalls, 0);
  assert.equal(f.a.state.micRequest, null);
});

test('hidden page mutes monitoring, preserves recording, and requires explicit safe restore', async (t) => {
  const f = await fixture(t, { prefs: { micMonitor: true } });
  await f.a.selectJob('a');
  await flush();
  await f.a.startRecording();
  assert.ok(f.a.state.audioGraph.monitorGain.gain.value > 0);
  await f.visibility(true);
  assert.equal(f.a.state.audioGraph.monitorGain.gain.value, 0);
  assert.equal(f.a.state.audioGraph.howl.raf, 0);
  assert.equal(f.a.state.recording, true);
  await f.visibility(false);
  assert.equal(f.a.state.audioGraph.monitorGain.gain.value, 0);
  assert.equal(f.$('#resumeMonitor').classList.contains('hidden'), false);
  f.click('#resumeMonitor');
  await flush();
  assert.ok(f.a.state.audioGraph.monitorGain.gain.value > 0);
  f.a.stopRecording();
  await flush();
});

test('metadata, no-lyrics badges, artist groups and language counts invalidate together', async (t) => {
  const f = await fixture(t);
  f.jobs = [song('a', { track: '旧歌名', artist: '旧歌手', line_count: 0, lyrics_status: 'none' })];
  await f.a.refreshList();
  assert.ok(f.$('.sr-nolrc'));
  assert.equal(f.$('.song-row').children.length, 7, 'artwork has a column; the badge does not');
  assert.ok(f.$('.sr-name .sr-nolrc'), 'no-lyrics badge stays inside the title cell');
  f.jobs = [song('a', { track: '新歌名', artist: '新歌手' }), song('b')];
  await f.a.refreshList();
  assert.equal(f.$('.sr-nolrc'), null);
  assert.match(f.$('#songList').textContent, /新歌名/);
  assert.doesNotMatch(f.$('#songList').textContent, /旧歌名/);
  assert.match(f.$('#langBar').textContent, /国语 2/);
  f.click('[data-tab="artist"]');
  assert.match(f.$('#artistList').textContent, /新歌手/);
  f.jobs[0].artist = '另一歌手';
  await f.a.refreshList();
  assert.match(f.$('#artistList').textContent, /另一歌手/);
});

test('list artwork loads lazily, falls back locally, and preserves song actions', async (t) => {
  const f = await fixture(t);
  f.jobs = [song('a', { thumbnail: '/media/a/cover.png', track: '封面测试' })];
  await f.a.refreshList();
  const image = f.$('.sr-artwork img');
  assert.equal(image.loading, 'lazy');
  assert.equal(image.decoding, 'async');
  assert.equal(image.referrerPolicy, 'no-referrer');
  assert.equal(image.width, 44);
  assert.equal(image.height, 44);
  assert.equal(image.alt, '');
  image.dispatchEvent(new image.ownerDocument.defaultView.Event('error'));
  assert.equal(f.$('.sr-artwork img'), null);
  assert.ok(f.$('.sr-artwork use[href="#icon-note"]'));
  assert.match(f.$('.sr-title').textContent, /封面测试/);
  f.click('.sr-artwork');
  await flush();
  assert.equal(f.a.state.currentJobId, 'a');
});

test('classic search ranks names, combines global terms, and clears the stale artist count label', async (t) => {
  const f = await fixture(t, { route: url => url === '/api/zh-map'
    ? response({ '夢': '梦', '倫': '伦' }) : undefined });
  const indexed = (id, track, artist, full, initials, artistFull, artistInitials) => song(id, {
    track, title: track, artist,
    search_index: { v: 1, f: [[track, [full], [initials]], [artist, [artistFull], [artistInitials]],
      [track, [full], [initials]]] },
  });
  f.jobs = [
    indexed('substring', '稻香现场版', '翻唱', 'daoxiangxianchangban', 'dxxcb', 'fanchang', 'fc'),
    indexed('artist', '另一首歌', '稻香', 'lingyishouge', 'lysg', 'daoxiang', 'dx'),
    indexed('exact', '稻香', '周杰伦', 'daoxiang', 'dx', 'zhoujielun', 'zjl'),
    indexed('youth', '少年', '夢然', 'shaonian', 'sn', 'mengran', 'mr'),
  ];
  await f.a.refreshList();
  const rows = () => [...f.w.document.querySelectorAll('.song-row')].map(el => el.dataset.id);
  const input = value => {
    f.$('#search').value = value;
    f.$('#search').dispatchEvent(new f.w.InputEvent('input', { bubbles: true }));
  };
  const original = rows();
  input('稻香');
  assert.deepEqual(rows(), ['exact', 'artist', 'substring']);
  input('');
  assert.deepEqual(rows(), original);
  f.click('[data-tab="artist"]');
  f.click('[data-artist="梦然"]');
  assert.match(f.$('#browseCount').textContent, /夢然/);
  input('稻香 周杰倫');
  assert.deepEqual(rows(), ['exact']);
  assert.equal(f.$('#browseCount').textContent, '1 首');
  input('zhou jie lun dao xiang');
  assert.deepEqual(rows(), ['exact']);
  input('dx zjl');
  assert.deepEqual(rows(), ['exact']);
  input('zzz-no-song');
  assert.deepEqual(rows(), []);
  assert.equal(f.$('#browseCount').textContent, '0 首');
  assert.match(f.$('#browseEmpty').textContent, /zzz-no-song/);
  input('ZZZ NO SONG');
  assert.match(f.$('#browseEmpty').textContent, /ZZZ NO SONG/);
  f.click('#searchClear');
  assert.deepEqual(rows(), ['youth']);
  assert.match(f.$('#browseCount').textContent, /夢然 · 1 首/);
  assert.equal(f.w.document.activeElement, f.$('#search'));
  f.click('[data-tab="all"]');
  f.jobs.reverse();
  await f.a.refreshList();
  assert.deepEqual(rows(), original, 'empty-query order is independent of API refresh order');
});

test('classic IME search waits for committed text even through catalog refreshes', async (t) => {
  const mapping = deferred();
  const f = await fixture(t, { route: url => url === '/api/zh-map' ? mapping.promise : undefined });
  f.jobs = [song('sea', { title: '海闊天空', track: '海闊天空' }),
    song('rice', { title: '稻香', track: '稻香' })];
  await f.a.refreshList();
  const input = (value, isComposing = false) => {
    f.$('#search').value = value;
    f.$('#search').dispatchEvent(new f.w.InputEvent('input', { bubbles: true, isComposing }));
  };
  input('海阔天空');
  assert.equal(f.$('#browseCount').textContent, '0 首');
  mapping.resolve(response({ '闊': '阔' }));
  await flush();
  assert.equal(f.$('#browseCount').textContent, '1 首', 'late map refreshes the derived fields and results');
  const before = f.$('#songList').textContent;
  f.$('#search').dispatchEvent(new f.w.CompositionEvent('compositionstart'));
  input('dao', true);
  await f.a.refreshList();
  assert.equal(f.$('#songList').textContent, before);
  assert.equal(f.a.state.search, '海阔天空');
  f.$('#search').value = '稻香';
  f.$('#search').dispatchEvent(new f.w.CompositionEvent('compositionend'));
  assert.equal(f.$('.sr-title').textContent, '稻香');
  input('unfinished', true);
  assert.equal(f.a.state.search, '稻香', 'InputEvent.isComposing also suppresses premature filtering');
  f.click('#searchClear');
  assert.equal(f.$('#browseCount').textContent, '2 首');
  assert.equal(f.$('#searchClear').classList.contains('hidden'), true);
});

test('classic artist labels preserve spelling while width/case merge without punctuation overmerge', async (t) => {
  const f = await fixture(t);
  const artists = ['A-Lin', 'ａ－ｌｉｎ', 'A Lin', 'ALin', 'AC/DC', 'ACDC', '夢然', '梦然'];
  f.jobs = artists.map((artist, i) => song(String(i), { artist }));
  await f.a.refreshList();
  f.click('[data-tab="artist"]');
  const chips = [...f.w.document.querySelectorAll('.artist-chip')];
  assert.equal(chips.length, 6);
  assert.equal(f.$('[data-artist="a-lin"] span').textContent, 'A-Lin');
  assert.equal(f.$('[data-artist="a-lin"] em').textContent, '2');
  assert.equal(f.$('[data-artist="梦然"] span').textContent, '夢然');
  f.click('[data-artist="a-lin"]');
  assert.equal(f.$('#browseCount').textContent, 'A-Lin · 2 首（点「歌手」返回）');
});

test('catalog 503 keeps usable stale data and concurrent refreshes share one request', async (t) => {
  const f = await fixture(t);
  const count = f.$('#songList').children.length;
  f.route = (url) => url === '/api/jobs' ? response({ detail: '不可用' }, 503) : undefined;
  await f.a.refreshList();
  assert.equal(f.$('#songList').children.length, count);
  assert.match(f.$('#catalogStatus').textContent, /保留上次结果/);
  const slow = deferred(), before = f.count('/api/jobs');
  f.route = (url) => url === '/api/jobs' ? slow.promise : undefined;
  const first = f.a.refreshList(), second = f.a.refreshList(true);
  await flush();
  assert.equal(f.count('/api/jobs'), before + 1);
  slow.resolve(response(f.jobs));
  await Promise.all([first, second]);
  assert.equal(f.$('#catalogStatus').classList.contains('hidden'), true);
});

test('queue changes update existing rows rather than rebuilding the catalog', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  const row = f.$('.song-row[data-id="b"]');
  f.a.addToQueue('b');
  assert.equal(f.$('.song-row[data-id="b"]'), row);
  assert.equal(row.classList.contains('queued'), true);
});

test('dialogs contain focus and shortcuts do not steal input or native button keys', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.$('#queueBtn').focus();
  f.click('#queueBtn');
  assert.equal(f.w.document.activeElement, f.$('#queueClose'));
  assert.equal(f.$('#browse').inert, true);
  f.$('#queueClear').focus();
  const tab = f.key(f.$('#queueClear'), 'Tab', 'Tab', { shiftKey: true });
  assert.equal(tab.defaultPrevented, true);
  assert.equal(f.w.document.activeElement, f.$('#queueClose'));
  f.key(f.$('#queueClose'), 'Escape');
  assert.equal(f.w.document.activeElement, f.$('#queueBtn'));
  assert.equal(f.$('#browse').inert, false);
  f.$('#lsQuery').focus();
  assert.equal(f.key(f.$('#lsQuery'), '/', 'Slash').defaultPrevented, false);
  assert.equal(f.w.document.activeElement, f.$('#lsQuery'));
  f.$('#modeOrig').focus();
  const plays = f.plays.length;
  assert.equal(f.key(f.$('#modeOrig'), ' ', 'Space').defaultPrevented, false);
  assert.equal(f.plays.length, plays);
  const space = f.key(f.w.document.body, ' ', 'Space');
  assert.equal(space.defaultPrevented, true);
  assert.equal(f.$('#instAudio').paused, true);
});

test('lyrics restore same-line highlighting after edit and animate only on the visible stage', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.$('#instAudio').currentTime = 2;
  f.a.updateLyrics(2);
  assert.ok(f.$('.lyric-line.active'));
  f.a.enterLyricsEdit();
  f.a.exitLyricsEdit();
  assert.ok(f.$('.lyric-line.active'));
  assert.equal(f.$('.lyric-line.active').querySelectorAll('.sung').length, 2);
  assert.ok(f.a.state.lyricRaf);
  f.a.showBrowse();
  assert.equal(f.a.state.lyricRaf, 0);
  f.a.showStage();
  assert.ok(f.a.state.lyricRaf);
  await f.visibility(true);
  assert.equal(f.a.state.lyricRaf, 0);
  await f.visibility(false);
  assert.ok(f.$('.lyric-line.active'));
  assert.ok(f.a.state.lyricRaf);
});

test('word timestamps accept canonical text and Whisper-style word fields', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.a.state.lyrics = { lines: [{ start: 0, end: 10, text: '兼容歌词', words: [
    { text: '兼容', start: 0, end: 1 }, { word: '歌词', start: 1, end: 10 },
  ] }] };
  f.a.renderLyrics();
  f.a.updateLyrics(2);
  assert.equal(f.$('.lyric-line').textContent.trim(), '兼容 歌词');
  assert.equal(f.$('.lyric-line.active').querySelectorAll('.sung').length, 2);
  assert.doesNotMatch(f.$('#lyrics').textContent, /undefined/);
});

test('async alignment is persisted, suppresses duplicate submit, and cannot replace another song', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  await f.a.applyLyric({ id: 11 });
  assert.deepEqual(JSON.parse(f.w.localStorage.getItem('openk.alignments')), { a: 'op-a' });
  await f.a.applyLyric({ id: 12 });
  assert.equal(f.count('/api/jobs/a/lyrics/align'), 1);
  await f.a.selectJob('b');
  f.route = (url) => url === '/api/operations/op-a'
    ? response({ id: 'op-a', job_id: 'a', state: 'done', message: '已完成' }) : undefined;
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.a.state.lyrics.source, 'b');
  assert.deepEqual(JSON.parse(f.w.localStorage.getItem('openk.alignments')), {});
});

test('alignment progress resumes after reload and completes on its original song', async (t) => {
  const f = await fixture(t, { storage: { 'openk.alignments': '{"a":"op-a"}' } });
  await f.a.selectJob('a');
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.a.state.alignmentOperations.a.state, 'running');
  f.route = (url) => {
    if (url === '/api/operations/op-a') return response({ id: 'op-a', job_id: 'a', state: 'done' });
    if (url.startsWith('/l/a.json?')) return response({ source: 'aligned', lines: [{ start: 0, end: 10, text: '新歌词' }] });
  };
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.a.state.lyrics.source, 'aligned');
  assert.match(f.$('#alignmentStatus').textContent, /已更新/);
});

test('alignment completion resolves immutable lyric revisions without restarting audio', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  await f.a.applyLyric({ id: 11 });
  const plays = f.plays.length;
  f.route = (url) => {
    if (url === '/api/operations/op-a') {
      f.jobs[0].media.lyrics = '/l/a-aligned.json';
      return response({ id: 'op-a', job_id: 'a', state: 'done',
        result: { lyrics_file: 'artifacts/aligned/lyrics.json' } });
    }
  };
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.a.state.lyricsUrl, '/l/a-aligned.json');
  assert.equal(f.a.state.lyrics.source, 'a-aligned');
  assert.equal(f.plays.length, plays);
  assert.equal(f.$('#instAudio').paused, false);
});

test('malformed 202 is visible as failure; explicit legacy success remains supported', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.route = (url) => url.endsWith('/lyrics/align') ? response({}, 202) : undefined;
  await f.a.applyLyric({ id: 11 });
  assert.match(f.$('#alignmentStatus').textContent, /有效的对齐任务编号/);
  assert.equal(f.a.state.alignmentTimers.size, 0);
  f.route = (url) => url.endsWith('/lyrics/align') ? response({ ok: true }) : undefined;
  await f.a.applyLyric({ id: 12 });
  assert.match(f.$('#alignmentStatus').textContent, /旧版接口/);
});

test('expired alignment operation stops retrying and permits a new submission', async (t) => {
  const f = await fixture(t, { storage: { 'openk.alignments': '{"a":"op-a"}' } });
  await f.a.selectJob('a');
  f.route = (url) => url === '/api/operations/op-a' ? response({ detail: 'missing' }, 404) : undefined;
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.a.state.alignmentOperations.a.state, 'error');
  assert.equal(f.a.state.alignmentTimers.has('a'), false);
  assert.match(f.$('#alignmentStatus').textContent, /过期/);
  f.route = undefined;
  await f.a.applyLyric({ id: 22 });
  assert.equal(f.a.state.alignmentOperations.a.state, 'queued');
});

test('focused and alignment polls make no requests while the document is hidden', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  await f.a.applyLyric({ id: 11 });
  f.a.startPolling('p');
  await f.visibility(true);
  const jobs = f.count('/api/jobs/p'), operations = f.count('/api/operations/op-a');
  await f.timer(f.a.state.pollTimer);
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.count('/api/jobs/p'), jobs);
  assert.equal(f.count('/api/operations/op-a'), operations);
});

test('play rejection is handled and buffering pauses and restores guide vocals', async (t) => {
  const f = await fixture(t);
  f.playError = new f.w.DOMException('gesture required', 'NotAllowedError');
  await f.a.selectJob('a');
  await flush();
  assert.match(f.$('#audioStatus').textContent, /无法播放/);
  assert.equal(f.$('#instAudio').paused, true);
  f.playError = null;
  assert.equal(await f.a.startPlayback(), true);
  f.$('#instAudio').dispatchEvent(new f.w.Event('waiting'));
  assert.equal(f.$('#vocalAudio').paused, true);
  assert.match(f.$('#audioStatus').textContent, /缓冲/);
  f.$('#instAudio').dispatchEvent(new f.w.Event('playing'));
  await flush();
  assert.equal(f.$('#vocalAudio').paused, false);
});

test('dual-track sync uses mild correction, large-drift reset and no correction during buffering', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  const inst = f.$('#instAudio'), guide = f.$('#vocalAudio');
  let now = 1000;
  Object.defineProperty(f.w.performance, 'now', { value: () => now });
  inst.currentTime = 10;
  guide.currentTime = 10.2;
  inst.dispatchEvent(new f.w.Event('timeupdate'));
  assert.equal(guide.currentTime, 10.2);
  assert.equal(guide.playbackRate, 0.99);
  now += 600;
  guide.currentTime = 12;
  inst.dispatchEvent(new f.w.Event('timeupdate'));
  assert.equal(guide.currentTime, 10);
  assert.equal(guide.playbackRate, 1);
  now += 600;
  f.a.state.buffering = true;
  guide.currentTime = 10.4;
  inst.dispatchEvent(new f.w.Event('timeupdate'));
  assert.equal(guide.currentTime, 10.4);
});

test('a cancelled playback intent cannot start audio after a delayed context resume', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.a.pausePlayback();
  const resume = deferred(), context = f.a.state.audioGraph.actx;
  context.state = 'suspended';
  context.resume = () => resume.promise.then(() => { context.state = 'running'; });
  const before = f.plays.length, start = f.a.startPlayback();
  f.a.pausePlayback();
  resume.resolve();
  assert.equal(await start, false);
  assert.equal(f.plays.length, before);
});

test('direct admin route opens accessible drawer and links use separate page runtimes', async (t) => {
  const f = await fixture(t, { pathname: '/admin' });
  assert.equal(f.$('#adminPanel').classList.contains('hidden'), false);
  assert.equal(f.$('#adminPanel').getAttribute('role'), 'dialog');
  assert.equal(f.w.document.activeElement, f.$('#adminClose'));
  assert.equal(f.$('a[href="/tv"]').target, '_blank');
  assert.equal(f.$('a[href="/remote"]').target, '_blank');
  assert.deepEqual([...f.w.document.querySelectorAll('script[src]')].map(el => el.getAttribute('src')),
    ['/search.js', '/app.js']);
});

test('pagehide releases microphone and invalidates pending media work', async (t) => {
  const f = await fixture(t, { prefs: { micMonitor: true } });
  await f.a.selectJob('a');
  await flush();
  const stream = f.a.state.micStream;
  const generation = f.a.state.selectionGeneration;
  f.w.dispatchEvent(new f.w.PageTransitionEvent('pagehide', { persisted: false }));
  assert.equal(stream.track.stopped, 1);
  assert.equal(f.a.state.audioGraph.mic, null);
  assert.equal(f.a.state.disposed, true);
  assert.ok(f.a.state.selectionGeneration > generation);
  assert.equal(f.$('#instAudio').paused, true);
});
