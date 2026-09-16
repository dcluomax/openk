/* Account-mode full player: real UI gestures and audio, without a separate TV. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { CDP, chromePath, freePort, waitFor, sleep, stop, errors } = require('./test_browser');
const ROOT = path.resolve(__dirname, '../..');

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || args.length === 2 && args[0] === '--source-root',
    'Usage: test_account_playback.js [--source-root extracted-runtime-directory]');
  const sourceRoot = args.length ? await fs.realpath(args[1]) : ROOT;
  await fs.access(path.join(sourceRoot, 'backend/main.py'));
  await fs.access(path.join(sourceRoot, 'frontend/app.js'));
  const scratch = await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'openk-playback-'));
  const tabs = [], browsers = [], checks = [];
  let server, log = '', cleanupPromise;
  const cleanup = () => cleanupPromise ||= (async () => {
    for (const tab of tabs) tab.close();
    for (const browser of browsers) await stop(browser);
    await stop(server);
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  })();
  const interrupted = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const deadline = setTimeout(() => {
    console.error('Account playback regression exceeded three minutes.');
    cleanup().finally(() => process.exit(1));
  }, 180000);
  const pass = name => { checks.push(name); console.log('PASS ' + name); };
  try {
    const python = process.env.OPENK_TEST_PYTHON || path.join(ROOT, '.venv/bin/python');
    const key = 'openk-playback-fixture-key-0123456789_abcdefghijklmnopqrstuvwxyz';
    const origin = 'http://127.0.0.1:' + await freePort();
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OPENK_')));
    const data = path.join(scratch, 'data');
    const demo = spawnSync(python, ['-m', 'tools.demo', data, '--showcase'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(demo.status, 0, demo.stderr);
    const keyFile = path.join(scratch, 'identity');
    await fs.writeFile(keyFile, key, { mode: 0o600 });
    server = spawn(python, ['-m', 'backend.main'], {
      cwd: sourceRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, PYTHONDONTWRITEBYTECODE: '1', OPENK_HOST: '127.0.0.1', OPENK_PORT: new URL(origin).port,
        OPENK_DATA_DIR: data, OPENK_JOBS_DIR: path.join(data, 'jobs'),
        OPENK_RESUME_ON_START: 'false', OPENK_IDENTITY_KEY_FILE: keyFile },
    });
    server.stdout.on('data', chunk => { log += chunk; });
    server.stderr.on('data', chunk => { log += chunk; });
    await waitFor(async () => (await fetch(origin + '/api/health')).ok, 'account playback fixture');
    const singer = { id: '00000000-0000-4000-8000-000000000041', username: 'studio-singer',
      display_name: '本机演唱', is_staff: false };
    const identity = { 'X-OpenK-Identity-Key': key,
      'X-OpenK-Account': Buffer.from(JSON.stringify(singer)).toString('base64url') };
    const landing = await fetch(origin + '/', { headers: identity, redirect: 'manual' });
    assert.equal(landing.status, 200, 'Account home must offer the full player, not redirect to a silent remote.');
    assert.ok((await landing.text()).includes('id="instAudio"'), 'Home includes the room-capable audio engine.');

    async function launch(name) {
      const profile = path.join(scratch, name);
      const browser = spawn(await chromePath(), [
        '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings',
        '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
      ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, TMPDIR: scratch } });
      browsers.push(browser);
      browser.stdout.on('data', () => {});
      browser.stderr.on('data', chunk => { log += chunk; });
      return waitFor(async () => Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]),
        'account playback Chrome ' + name);
    }
    async function page(browserPort, route, width = 1280, height = 900, headers = identity) {
      const target = await (await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: 'PUT' })).json();
      const tab = await CDP.connect(target.webSocketDebuggerUrl);
      tabs.push(tab);
      await tab.send('Network.enable');
      await tab.send('Network.setExtraHTTPHeaders', { headers });
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        // CDP drops extra headers on detached keepalive requests. Model only the
        // synthetic trusted proxy assertion here; production uses native cookies.
        const nativeFetch = window.fetch;
        window.fetch = function(resource, options = {}) {
          if (options.keepalive && new URL(resource, location.href).origin === location.origin) {
            const headers = new Headers(options.headers);
            for (const [name, value] of Object.entries(${JSON.stringify(headers)})) headers.set(name, value);
            return nativeFetch.call(this, resource, { ...options, headers });
          }
          return nativeFetch.call(this, resource, options);
        };
        window.__testMics = [];
        if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const destination = context.createMediaStreamDestination();
          gain.gain.value = .02;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          window.__testMics.push({ context, oscillator, stream: destination.stream });
          await context.resume();
          return destination.stream;
        };` });
      await tab.send('Page.navigate', { url: origin + route });
      return tab;
    }
    async function assertSpeakerSignal(tab, label) {
      await waitFor(() => tab.evaluate(`(() => {
        const g = state.audioGraph;
        if (!g || g.actx.state !== 'running' || inst.paused || inst.volume !== 1 ||
            ![g.instGain, g.dry, g.speakerBus].every(node => node.gain.value > 0)) return false;
        if (!window.__speakerProbe || window.__speakerProbe.context !== g.actx) {
          window.__speakerProbe = g.actx.createAnalyser();
          g.speakerBus.connect(window.__speakerProbe);
        }
        const samples = new Float32Array(window.__speakerProbe.fftSize);
        window.__speakerProbe.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) > .001;
      })()`), label);
    }
    const studioPort = await launch('studio');
    const studio = await page(studioPort, '/');
    await waitFor(() => studio.evaluate(`room.ready && document.querySelectorAll('.song-row').length >= 3`),
      'account home and current room');
    const roomId = await studio.evaluate('room.id');
    assert.ok(await studio.evaluate(`document.querySelector('#instAudio').paused &&
      localStorage.getItem('openk.queue') === null && window.__testMics.length === 0`),
      'Opening the room cannot autoplay, acquire a microphone or restore an independent queue.');
    const jobs = await studio.evaluate('state.allJobs.filter(job => job.state === "done").slice(0,3).map(job => job.id)');
    const pick = job => `.song-row[data-id="${job}"] .sr-pick`;
    await studio.click(pick(jobs[0]));
    await waitFor(() => studio.evaluate(`!document.querySelector('#instAudio').paused &&
      document.querySelector('#instAudio').currentTime > .15 && !document.querySelector('#stage').classList.contains('hidden')`),
      'one device: song pick produces real local playback');
    assert.ok(await studio.evaluate(`room.id === ${JSON.stringify(roomId)} && room.client.state.current.job_id ===
      ${JSON.stringify(jobs[0])} && room.client.token === null && localStorage.getItem('openk.queue') === null`));
    pass('Account home song pick really plays in its current room without any TV page');
    await assertSpeakerSignal(studio, 'real PCM reaches the running speaker bus, not just an advancing media clock');
    await waitFor(() => studio.evaluate(`window.__testMics.length === 1 &&
      state.audioGraph.mic && state.audioGraph.monitorGain.gain.value > 0 &&
      state.micStream.getAudioTracks().some(track => track.readyState === 'live')`),
      'first song activates the preferred microphone monitor without needing a recording or second song');
    pass('The first song has a live microphone monitor and nonzero speaker-bus PCM');

    await studio.evaluate(`(() => {
      window.__beforeRemoteQR = {
        item: room.loadedItem, generation: state.selectionGeneration,
        position: inst.currentTime, graph: state.audioGraph, mic: state.micStream,
      };
    })()`);
    await studio.click('#remoteLink');
    await waitFor(() => studio.evaluate('!!document.querySelector("#remoteQR svg")'), 'phone remote QR popup');
    const phoneRemoteURL = new URL(await studio.evaluate('document.querySelector("#remoteOpen").href'));
    assert.equal(phoneRemoteURL.href, origin + '/remote');
    assert.ok(await studio.evaluate(`document.activeElement.id === 'remoteClose'
      && document.querySelector('#stage').inert && document.querySelector('#roomStatus').inert`));
    await assertSpeakerSignal(studio, 'speaker-bus PCM continues while the remote QR is open');
    await studio.click('#remoteClose');
    assert.ok(await studio.evaluate(`(() => {
      const before = window.__beforeRemoteQR;
      return document.activeElement.id === 'remoteLink' && !inst.paused && inst.currentTime >= before.position
        && room.loadedItem === before.item && state.selectionGeneration === before.generation
        && state.audioGraph === before.graph && state.micStream === before.mic;
    })()`), 'Opening the phone QR must not navigate, seek, interrupt audio or reset the microphone.');
    pass('The phone remote QR opens locally while playback and microphone capture continue');

    await studio.click('#playBtn');
    await waitFor(() => studio.evaluate(`document.querySelector('#instAudio').paused && !room.client.state.playback.playing`),
      'full-player pause reaches the room');
    const pausedAt = await studio.evaluate('document.querySelector("#instAudio").currentTime');
    await sleep(250);
    assert.ok(Math.abs(await studio.evaluate('document.querySelector("#instAudio").currentTime') - pausedAt) < .08);
    await studio.click('#nbPlay');
    await waitFor(() => studio.evaluate(`!document.querySelector('#instAudio').paused &&
      document.querySelector('#instAudio').currentTime > ${pausedAt + .15}`), 'bottom bar resumes real audio');
    await studio.click('#modeOrig');
    await waitFor(() => studio.evaluate(`room.client.state.playback.guide &&
      !document.querySelector('#vocalAudio').paused && document.querySelector('#vocalAudio').currentTime > 0`),
      'guide audio and room guide state');
    await studio.click('#modeInst');
    await waitFor(() => studio.evaluate('!room.client.state.playback.guide'), 'guide can be switched off');
    await studio.click('#playBtn');
    await waitFor(() => studio.evaluate('document.querySelector("#instAudio").paused'), 'pause before seek');
    await studio.evaluate(`(() => {
      window.__seekCommands = 0;
      const original = window.fetch;
      window.fetch = function(resource, options = {}) {
        if (String(resource).endsWith('/commands') && typeof options.body === 'string' &&
            JSON.parse(options.body).action === 'seek') window.__seekCommands++;
        return original.call(this, resource, options);
      };
      document.querySelector('#seek').scrollIntoView({ block: 'center' });
    })()`);
    const slider = await studio.evaluate(`(() => {
      const r = document.querySelector('#seek').getBoundingClientRect();
      return {x:r.x, y:r.y + r.height/2, width:r.width};
    })()`);
    await studio.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1,
      x: slider.x + slider.width * .1, y: slider.y });
    for (let step = 1; step <= 30; step++) {
      await studio.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1,
        x: slider.x + slider.width * (.1 + .5 * step / 30), y: slider.y });
    }
    assert.equal(await studio.evaluate('window.__seekCommands'), 0, 'A live drag cannot fsync every intermediate room position.');
    await studio.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1,
      x: slider.x + slider.width * .6, y: slider.y });
    await waitFor(() => studio.evaluate(`Math.abs(room.client.state.playback.position -
      document.querySelector('#instAudio').currentTime) < .6 && document.querySelector('#instAudio').currentTime > 1`),
      'seek is synchronized with the room');
    assert.equal(await studio.evaluate('window.__seekCommands'), 1, 'A complete drag commits exactly one room seek.');
    pass('Local play/pause, original/guide and seeking remain functional');

    await waitFor(() => studio.evaluate('document.querySelectorAll("#lyrics .lyric-line").length > 0'), 'full lyrics load');
    await studio.click('#editLyrics');
    assert.ok(await studio.evaluate(`!document.querySelector('#editBar').classList.contains('hidden')`),
      'Original lyrics editing remains reachable in account mode');
    await studio.click('#cancelLyrics');
    await studio.click('#playBtn');
    await waitFor(() => studio.evaluate('!inst.paused'), 'resume before refreshing lyrics');
    const lyricTarget = await studio.evaluate(`(() => {
      window.__beforeLyricRefresh = {
        item: room.loadedItem, generation: state.selectionGeneration,
        position: inst.currentTime, src: inst.src, graph: state.audioGraph, mic: state.micStream,
      };
      return { id: state.currentJobId, duration: inst.duration };
    })()`);
    const lyricPublication = await fetch(origin + '/api/jobs/' + lyricTarget.id + '/lyrics', {
      method: 'PUT', headers: { ...identity, 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'en', source: 'Synthetic browser revision',
        lines: [{ start: 0, end: lyricTarget.duration, text: 'Fresh synthetic lyric' }] }),
    });
    assert.equal(lyricPublication.status, 200, await lyricPublication.text());
    await waitFor(() => studio.evaluate(`state.lyrics?.lines[0]?.text === 'Fresh synthetic lyric'
      && document.querySelector('#lyrics').textContent.includes('Fresh synthetic lyric')`),
      'published lyrics appear without reloading the page');
    assert.ok(await studio.evaluate(`(() => {
      const before = window.__beforeLyricRefresh;
      return room.loadedItem === before.item && state.selectionGeneration === before.generation
        && inst.currentTime >= before.position && inst.src === before.src && !inst.paused
        && state.audioGraph === before.graph && state.micStream === before.mic;
    })()`), 'Lyric refresh must preserve the active song, audio graph, microphone and playback position.');
    await assertSpeakerSignal(studio, 'real speaker-bus PCM continues after lyric publication');
    await studio.click('#playBtn');
    await waitFor(() => studio.evaluate('inst.paused'), 'pause after lyric refresh');
    pass('A published lyric revision reaches the live player without interrupting audio or its microphone');

    await studio.evaluate('userSeek(0)');
    await studio.click('#playBtn');
    await waitFor(() => studio.evaluate('!inst.paused'), 'resume for manual lyric timing');
    await studio.click('#editLyrics');
    const timing = await studio.evaluate(`(() => {
      window.__beforeTimingEdit = {
        item: room.loadedItem, generation: state.selectionGeneration,
        src: inst.src, graph: state.audioGraph, mic: state.micStream, url: state.lyricsUrl,
      };
      const end = Math.round(inst.duration * 500) / 1000;
      document.querySelector('[data-time="end"]').value = String(end);
      document.querySelector('#lyricOffset').value = '1';
      return {end: end + 1, job: state.currentJobId};
    })()`);
    await studio.click('#applyLyricOffset');
    assert.equal(await studio.evaluate(`document.querySelector('[data-time="start"]').value`), '00:01.000');
    assert.equal(await studio.evaluate('state.lyrics.lines[0].start'), 0,
      'An unsaved offset must not rewrite the active lyric object.');
    await studio.evaluate(`(() => {
      window.__seekCommands = 0;
      const range = document.querySelector('#lyricEditSeek');
      for (const position of ['20', '40', '60']) {
        range.value = position;
        range.dispatchEvent(new Event('input', {bubbles:true}));
      }
    })()`);
    assert.equal(await studio.evaluate('window.__seekCommands'), 0);
    await studio.evaluate(`document.querySelector('#lyricEditSeek').dispatchEvent(new Event('change', {bubbles:true}))`);
    await waitFor(() => studio.evaluate('window.__seekCommands === 1'), 'editor seek commits once');
    await studio.click('#saveLyrics');
    await waitFor(() => studio.evaluate(`!state.editing && state.lyricsUrl !== window.__beforeTimingEdit.url
      && state.lyrics.lines[0].start === 1`), 'manual timing is published and reloaded');
    assert.ok(await studio.evaluate(`(() => {
      const before = window.__beforeTimingEdit, line = state.lyrics.lines[0];
      return line.end === ${timing.end} && line.words.every(word => word.start >= 1 && word.end <= line.end)
        && line.words[0].start === 1 && room.loadedItem === before.item
        && state.selectionGeneration === before.generation && inst.src === before.src
        && !inst.paused && state.audioGraph === before.graph && state.micStream === before.mic;
    })()`), 'Manual timing must preserve word bounds, current song, audio and microphone.');
    const timingJob = await (await fetch(origin + '/api/jobs/' + timing.job, { headers: identity })).json();
    const persistedTiming = await (await fetch(origin + timingJob.media.lyrics, { headers: identity })).json();
    assert.equal(persistedTiming.lines[0].start, 1);
    assert.equal(persistedTiming.lines[0].end, timing.end);
    await assertSpeakerSignal(studio, 'real speaker-bus PCM continues after manual timing save');
    await studio.click('#playBtn');
    await waitFor(() => studio.evaluate('inst.paused'), 'pause after manual timing');
    pass('Manual intro offsets and line bounds persist with word timing, one-command seeking and uninterrupted audio');

    await studio.click('#homeBtn');
    await studio.click(pick(jobs[1]));
    await studio.click(pick(jobs[2]));
    await studio.click(pick(jobs[1]));
    await waitFor(() => studio.evaluate('room.client.state.queue.length === 3'), 'shared queue accepts specific duplicate entries');
    const queued = await studio.evaluate('room.client.state.queue.map(item => ({id:item.id,job:item.job_id}))');
    assert.equal(new Set(queued.map(item => item.id)).size, 3);
    await studio.click('#queueBtn');
    await waitFor(() => studio.evaluate('document.querySelectorAll("#queueList .q-item").length === 3'), 'room queue drawer');
    await studio.click('#queueList .q-item:nth-child(3) [data-act="top"]');
    await waitFor(() => studio.evaluate(`room.client.state.queue[0].id === ${JSON.stringify(queued[2].id)}`),
      'queue top acts on an entry, not every copy of a job');
    await studio.click('#queueList .q-item:nth-child(2) [data-act="del"]');
    await waitFor(() => studio.evaluate(`room.client.state.queue.length === 2 &&
      !room.client.state.queue.some(item => item.id === ${JSON.stringify(queued[0].id)})`), 'remove the exact room entry');
    await studio.click('#queueClose');
    pass('Full lyrics editor and authoritative duplicate-safe room queue are restored');

    const controllerPort = await launch('controller');
    const remote = await page(controllerPort, phoneRemoteURL.pathname, 390, 844);
    await waitFor(() => remote.evaluate(`window.openkRemote?.ready &&
      window.openkRemote.client?.id === ${JSON.stringify(roomId)} && window.openkRemote.client.state.player.online`),
      'second device observes the full-player lease');
    await remote.click('#remotePlay');
    await waitFor(() => studio.evaluate('!document.querySelector("#instAudio").paused'), 'phone controls full-player audio');
    await remote.click('#remotePlay');
    await waitFor(() => studio.evaluate('document.querySelector("#instAudio").paused'), 'phone pauses full-player audio');
    await studio.click('#nbSkip');
    await waitFor(() => studio.evaluate(`room.client.state.current?.id === ${JSON.stringify(queued[2].id)} &&
      state.currentJobId === ${JSON.stringify(jobs[1])} && !inst.paused && inst.currentTime > .1`),
      'manual skip from pause starts the next shared queue entry');
    await assertSpeakerSignal(studio, 'manual skip produces real next-song audio without another play click');
    pass('Phone remote controls the full player; skipping a paused song immediately plays the next shared entry');

    await studio.click('#nbOpen');
    const recordingJob = await studio.evaluate('state.currentJobId');
    await studio.click('#recBtn');
    await waitFor(() => studio.evaluate('state.recording'), 'account-mode original recorder starts');
    await sleep(500);
    await studio.click('#recBtn');
    await waitFor(() => studio.evaluate('!state.recording && document.querySelectorAll("#recList audio").length > 0'),
      'account recording is uploaded and shown');
    assert.ok(await studio.evaluate(`state.currentJobId === ${JSON.stringify(recordingJob)}`));
    pass('Original microphone mixing/MediaRecorder recording is available within the room');

    const peer = await page(controllerPort, '/');
    await waitFor(() => peer.evaluate(`room.ready && room.id === ${JSON.stringify(roomId)} &&
      room.client.state.player.online`), 'a second full-player page observes the existing lease');
    assert.ok(await peer.evaluate('document.querySelector("#instAudio").paused && window.__testMics.length === 0'),
      'Opening another full player must not duplicate audio or acquire a microphone');
    if (!await peer.evaluate('document.querySelector("#roomActivate").disabled')) {
      await peer.click('#roomActivate');
      await sleep(300);
    }
    assert.ok(await peer.evaluate('document.querySelector("#instAudio").paused'),
      'Another device cannot steal the room player lease');
    pass('A second full-player device remains a controller instead of producing duplicate audio');

    assert.ok(await studio.evaluate('room.armed && !!room.playerToken'), 'Reload fixture holds the receiver lease.');
    await studio.evaluate('window.__beforeReload = true');
    await studio.send('Page.reload', { ignoreCache: true });
    await waitFor(() => studio.evaluate(`typeof room !== 'undefined' && !window.__beforeReload && room.ready &&
      !room.client.state.player.online && !document.querySelector('#roomActivate').disabled`),
      'reload returns its old lease before the 12 second timeout', 4000);
    assert.ok(await studio.evaluate('inst.paused && window.__testMics.length === 0'),
      'Reload is silent until a new gesture.');
    await studio.click('#roomActivate');
    await assertSpeakerSignal(studio, 'reloaded player can promptly reclaim and produce speaker signal');
    pass('Reload promptly releases its lease and an explicit click restores real output');

    await studio.evaluate('state.audioGraph.actx.suspend()');
    await waitFor(() => studio.evaluate(`!room.armed && inst.paused && !room.client.state.player.online &&
      document.querySelector('#playBtn').textContent === '▶' && !document.querySelector('#roomActivate').disabled`),
      'an interrupted output graph stops fake playback and relinquishes the receiver', 4000);
    assert.ok(await studio.evaluate(`state.micStream === null ||
      state.micStream.getTracks().every(track => track.readyState === 'ended')`),
      'Output suspension stops microphone capture as well.');
    await studio.click('#roomActivate');
    await assertSpeakerSignal(studio, 'explicit reactivation resumes the suspended graph and real speaker PCM');
    pass('Suspended output is reported honestly and can be recovered with one playback gesture');

    await remote.click('#switchRoom');
    await remote.click('#newPartyShortcut');
    await remote.click('#newRoomName');
    await remote.send('Input.insertText', { text: 'Playback lifecycle fixture' });
    await remote.click('#createRoom');
    const nextRoom = await waitFor(async () => {
      const value = await remote.evaluate('window.openkRemote.client?.id');
      return value && value !== roomId ? value : null;
    }, 'account moves to a different room through actual UI');
    await waitFor(() => studio.evaluate(`room.id === ${JSON.stringify(nextRoom)} &&
      document.querySelector('#instAudio').paused && !state.recording &&
      (!state.micStream || state.micStream.getTracks().every(track => track.readyState === 'ended'))`),
      'room movement disarms full playback and microphone');
    assert.ok(await studio.evaluate(`window.__testMics.every(mic =>
      mic.stream.getTracks().every(track => track.readyState === 'ended'))`), 'Microphone tracks cannot leak across rooms.');
    assert.ok(await studio.evaluate(`!room.client.state.current && localStorage.getItem('openk.queue') === null`),
      'A different room does not inherit the old local player or queue.');
    pass('Room changes stop the full player/microphone and require a new audio gesture');
    await studio.click('#homeBtn');
    await waitFor(() => studio.evaluate('!!OpenKUserState.value?.device'), 'studio device registration');
    await waitFor(() => remote.evaluate('!!OpenKUserState.value?.device'), 'phone device registration');
    await studio.evaluate(`OpenKUserState.patchDevice(OpenKUserState.deviceId(), { label: '客厅播放器' })`);
    await remote.evaluate(`OpenKUserState.patchDevice(OpenKUserState.deviceId(), { label: '点歌手机' })`);
    const microphonesBeforeArming = await studio.evaluate('window.__testMics.length');
    assert.equal(await studio.evaluate('document.querySelector("#roomActivate").disabled'), false,
      'An empty room offers an explicit preparation gesture.');
    await studio.click('#roomActivate');
    await waitFor(() => studio.evaluate('room.armed && !room.client.state.current'), 'pre-armed empty room');
    assert.ok(await studio.evaluate(`inst.paused && !state.micStream &&
      window.__testMics.length === ${microphonesBeforeArming}`), 'Preparing a receiver must not acquire a microphone.');
    await waitFor(() => remote.evaluate('!!document.querySelector("#roomSongList .add-song")'), 'phone song choices');
    await remote.click('#roomSongList .add-song');
    await waitFor(() => studio.evaluate(`!document.querySelector('#instAudio').paused &&
      document.querySelector('#instAudio').currentTime > .1 &&
      !!room.client.state.current`), 'the phone first enqueue starts the already-ready receiver');
    await assertSpeakerSignal(studio, 'the first remotely queued song produces speaker PCM without another click');
    pass('An empty receiver can be prepared without a microphone; the first phone selection then starts automatically');

    await waitFor(() => studio.evaluate(`room.client.state.devices?.length === 2 &&
      room.client.state.devices.some(device => device.name === '客厅播放器' && device.player
        && ['player','controller','microphone'].every(role => device.roles.includes(role))) &&
      room.client.state.devices.some(device => device.name === '点歌手机' && !device.player)`),
      'distinct same-account device roles and the real receiving player');
    assert.equal(await studio.evaluate('room.client.state.members.length'), 1,
      'Devices remain separate without fabricating additional account members.');
    assert.equal(await studio.evaluate('document.querySelectorAll("#roomDevices .room-device").length'), 2);
    await remote.click('#memberSummary');
    await waitFor(() => remote.evaluate(`document.querySelectorAll('#remoteDevices .room-device').length === 2 &&
      document.querySelector('#remoteDevices').textContent.includes('麦克风')`), 'phone renders room device roles');
    const phoneDevices = await remote.evaluate(`document.querySelector('#remoteDevices').textContent`);
    assert.ok(phoneDevices.includes('播放器') && phoneDevices.includes('遥控器') && phoneDevices.includes('麦克风'));
    await peer.send('Page.navigate', { url: 'about:blank' });
    await waitFor(() => studio.evaluate(`room.client.state.devices?.length === 2 &&
      room.client.state.devices.some(device => device.name === '点歌手机'
        && device.roles.length === 1 && device.roles[0] === 'controller')`),
      'closing one tab removes only its role while the phone stays connected');
    await remote.click('#memberSummary');
    pass('Same-account devices are distinct, same-device tabs are aggregated, and live player/remote/microphone roles are labelled');

    await studio.click('#nbPlay');
    await waitFor(() => studio.evaluate('inst.paused && !room.client.state.playback.playing'), 'explicit pause');
    await remote.click('#roomSongList li:nth-child(2) .add-song');
    await waitFor(() => studio.evaluate('room.client.state.queue.length === 1'), 'enqueue while manually paused');
    assert.ok(await studio.evaluate('inst.paused && !room.client.state.playback.playing'),
      'Adding another song cannot override a deliberate pause of the current one.');
    const nextEntry = await studio.evaluate('room.client.state.queue[0].id');
    await waitFor(() => remote.evaluate('!window.openkRemote.client.state.playback.playing'), 'phone observes pause');
    await remote.click('#remotePlay');
    await waitFor(() => studio.evaluate('!inst.paused'), 'resume queued playback');
    await studio.evaluate('userSeek(Math.max(0, inst.duration - .35))');
    await waitFor(() => studio.evaluate(`room.client.state.current?.id === ${JSON.stringify(nextEntry)} &&
      !inst.paused && inst.currentTime > .1`), 'natural media end automatically starts the next queued entry');
    await assertSpeakerSignal(studio, 'the next queued song has real speaker signal');
    pass('Manual pause is respected; after resuming, natural completion automatically starts the next queue entry');

    const newcomer = { ...singer, id: '00000000-0000-4000-8000-000000000042', username: 'remote-singer',
      display_name: '遥控入口演唱' };
    const remoteOnly = await page(controllerPort, '/remote', 390, 844, {
      ...identity, 'X-OpenK-Account': Buffer.from(JSON.stringify(newcomer)).toString('base64url'),
    });
    await waitFor(() => remoteOnly.evaluate(`window.openkRemote?.ready &&
      document.querySelector('#roomSongList .add-song')`), 'receiver-free bookmarked remote');
    await remoteOnly.click('#roomSongList .add-song');
    await waitFor(() => remoteOnly.evaluate('!!window.openkRemote.client.state.current'), 'remote-only song pick');
    assert.ok(await remoteOnly.evaluate(`!window.openkRemote.client.state.player.online &&
      document.querySelector('#remotePlay').textContent === '▶'`), 'Silent room intent must not show a fake pause state.');
    await remoteOnly.click('#remotePlay');
    await waitFor(() => remoteOnly.evaluate(`location.pathname === '/' && room.ready &&
      !!room.client.state.current && !document.querySelector('#stage').classList.contains('hidden')`),
      'offline remote opens its room-bound full player');
    assert.ok(await remoteOnly.evaluate('document.querySelector("#instAudio").paused'),
      'Navigating to the full player is not itself audio permission.');
    await remoteOnly.click('#roomActivate');
    await waitFor(() => remoteOnly.evaluate(`!document.querySelector('#instAudio').paused &&
      document.querySelector('#instAudio').currentTime > .1`), 'explicit local activation from a remote bookmark');
    pass('A receiver-free remote bookmark leads to usable local playback instead of silent success');

    assert.deepEqual(errors, [], 'No unhandled browser errors');
    const artifacts = process.env.OPENK_TEST_ARTIFACTS;
    if (artifacts) {
      await fs.mkdir(artifacts, { recursive: true });
      await studio.send('Page.bringToFront');
      const image = await studio.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(artifacts, 'account-full-player.png'), Buffer.from(image.data, 'base64'));
      await fs.writeFile(path.join(artifacts, 'account-playback-report.json'), JSON.stringify({ sourceRoot, checks }, null, 2));
    }
    console.log(`${checks.length} account playback flows passed.`);
  } catch (error) {
    for (const tab of tabs) {
      try {
        console.error('Page state:', await tab.evaluate(`({
          path:location.pathname, status:document.querySelector('#audioStatus')?.textContent,
          notice:document.querySelector('#toast')?.textContent || document.querySelector('#remoteNotice')?.textContent,
          roomStatus:document.querySelector('#roomPlaybackStatus')?.textContent,
          audio:[...document.querySelectorAll('audio')].map(a=>({id:a.id,paused:a.paused,time:a.currentTime,ready:a.readyState,error:a.error?.code}))
        })`));
      } catch (diagnosticError) { console.error('Page diagnostics unavailable:', diagnosticError.message); }
    }
    console.error('Receiver API history:', log.split('\n').filter(line => line.includes('/player/')).join('\n'));
    console.error(log.slice(-2000));
    throw error;
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    await cleanup();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
