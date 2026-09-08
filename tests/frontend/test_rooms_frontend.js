/**
 * node tests/frontend/test_rooms_frontend.js
 * Real FastAPI room API + two jsdom browsers; media is stubbed (not a codec test).
 * Uses the existing jsdom runner and .venv Python. No browser/QR cloud service.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../..');
const frontend = path.join(root, 'frontend');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const windows = [];
let server;
let serverOutput = '';
let checks = 0;
const errors = [];

function check(name, condition) {
  assert.ok(condition, name);
  checks++;
  console.log('PASS ', name);
}

async function until(fn, message, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('Timed out: ' + message);
}

async function startServer() {
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const value = probe.address().port;
      probe.close(() => resolve(value));
    });
  });
  const python = process.env.OPENK_TEST_PYTHON || (fs.existsSync(path.join(root, '.venv/bin/python'))
    ? path.join(root, '.venv/bin/python') : 'python3');
  server = spawn(python, ['tests/python/test_rooms.py', '--serve', String(port)], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', data => { serverOutput += data; });
  server.stderr.on('data', data => { serverOutput += data; });
  server.on('error', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + port;
  await until(async () => {
    if (server.exitCode !== null) throw new Error('Fixture API failed: ' + serverOutput);
    try { return (await fetch(origin + '/health')).ok; } catch { return false; }
  }, 'fixture API startup', 10000);
  return origin;
}

function browser(page, url, storage = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(frontend, page + '.html'), 'utf8'), {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  windows.push(w);
  w.AbortController = globalThis.AbortController;
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, JSON.stringify(value));
  const network = { calls: [], offline: false, dropCommand: false, stateRequests: 0, maximum: 0 };
  w.fetch = async (resource, options = {}) => {
    const target = new URL(resource, w.location.href);
    assert.equal(target.origin, w.location.origin, 'room never calls external services');
    network.calls.push({ url: target, options });
    if (network.offline) throw new TypeError('offline');
    const state = /^\/api\/rooms\/[a-f0-9]+$/.test(target.pathname) && (!options.method || options.method === 'GET');
    if (state) {
      network.stateRequests++;
      network.maximum = Math.max(network.maximum, network.stateRequests);
      await sleep(10);
    }
    try {
      const response = await fetch(target, options);
      if (network.dropCommand && target.pathname.endsWith('/commands')) {
        network.dropCommand = false;
        throw new TypeError('response lost after commit');
      }
      return response;
    } finally { if (state) network.stateRequests--; }
  };
  w.HTMLMediaElement.prototype.load = function () { this._time = 0; this._ended = false; this._paused = true; };
  Object.defineProperties(w.HTMLMediaElement.prototype, {
    paused: { configurable: true, get() { return this._paused !== false; } },
    currentTime: { configurable: true, get() { return this._time || 0; }, set(value) { this._time = value; this._ended = false; } },
    duration: { configurable: true, get() { return 180; } },
    ended: { configurable: true, get() { return !!this._ended; } },
    readyState: { configurable: true, get() { return 4; } },
  });
  w.HTMLMediaElement.prototype.play = function () {
    this._playCount = (this._playCount || 0) + 1;
    if (this._rejectPlay) return Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }));
    this._paused = false;
    this._ended = false;
    this.dispatchEvent(new w.Event('playing'));
    return Promise.resolve();
  };
  w.HTMLMediaElement.prototype.pause = function () {
    const wasPlaying = !this.paused;
    this._paused = true;
    if (wasPlaying) this.dispatchEvent(new w.Event('pause'));
  };
  w.addEventListener('error', event => errors.push(event.error || event.message));
  w.eval(fs.readFileSync(path.join(frontend, 'room-client.js'), 'utf8'));
  if (page === 'remote') w.eval(fs.readFileSync(path.join(frontend, 'search.js'), 'utf8'));
  if (page === 'tv') w.eval(fs.readFileSync(path.join(frontend, 'vendor/qrcode.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(frontend, page + '.js'), 'utf8'));
  return { w, network, $: selector => w.document.querySelector(selector) };
}

async function run() {
  const origin = await startServer();
  const tv = browser('tv', origin + '/tv');
  try { await until(() => tv.w.openkStage?.client?.state, 'TV room creation'); }
  catch (error) {
    error.message += ': ' + tv.$('#tvNotice').textContent + ' / ' + tv.$('#connection').textContent;
    throw error;
  }
  const stage = tv.w.openkStage;
  stage.client.stop();
  check('TV creates a paused room and a local QR', !stage.client.state.playback.playing && !!tv.$('#qr svg'));
  const url = tv.w.OpenKRoom.joinURL(stage.host.roomId, stage.host.code);
  check('QR capability only in fragment, current trusted origin', new URL(url).origin === origin
    && !new URL(url).search && new URL(url).hash.includes('code='));
  const remote = browser('remote', url);
  await until(() => remote.w.openkRemote?.client?.state && remote.$('#roomSongList button'), 'phone pairing and library');
  const phone = remote.w.openkRemote;
  phone.client.stop();
  check('Phone automatically pairs; fragment removed immediately', remote.w.location.hash === ''
    && remote.$('#joinScreen').hidden && !remote.$('#roomScreen').hidden);
  check('Only completed playable songs shown', remote.$('#roomSongList').children.length === 2);
  check('Host and paired controller capabilities are different', stage.host.token !== phone.client.token);
  remote.$('#songSearch').value = '海阔天空';
  phone.renderLibrary();
  check('Simplified query matches traditional song title', remote.$('#roomSongList').children.length === 1);
  remote.$('#songSearch').value = 'dx';
  phone.renderLibrary();
  check('Pinyin initials search finds 稻香', remote.$('#roomSongList').children.length === 1
    && remote.$('#roomSongList').textContent.includes('稻香'));
  remote.$('#songSearch').value = '';
  phone.renderLibrary();
  remote.$('#roomSongList button').click();
  await until(() => phone.client.state.current, 'phone add song');
  await stage.client.refresh();
  await until(() => stage.lines.length === 2, 'NAS lyrics loaded');
  check('Phone → API → TV starts same unique queue item', stage.client.state.current.id === phone.client.state.current.id
    && tv.$('#songTitle').textContent === '稻香');
  check('No audio autoplays before TV gesture', stage.music.paused && !stage.armed);
  stage.music.currentTime = 1;
  stage.lyrics();
  check('TV shows intro countdown and next lyric', tv.$('#countdown').textContent.includes('前奏')
    && tv.$('#lyricNext').textContent === '一起唱歌');
  stage.music.currentTime = 5;
  stage.lyrics();
  check('Word progress is continuous, not line-only', tv.$('.lyric-word').style.getPropertyValue('--word-progress') === '50.0%');
  stage.music.currentTime = 10;
  stage.lyrics();
  check('TV shows interlude countdown', tv.$('#countdown').textContent.includes('间奏'));

  Object.defineProperty(tv.w.document, 'hidden', { configurable: true, get: () => true });
  await stage.activate();
  check('Hidden TV activation gives an explicit foreground instruction', !stage.armed
    && tv.$('#tvNotice').textContent.includes('不在前台'));
  Object.defineProperty(tv.w.document, 'hidden', { configurable: true, get: () => false });
  stage.music._rejectPlay = true;
  await stage.activate();
  check('Audio play rejection is visible and recoverable', stage.status === 'blocked' && !stage.armed && !tv.$('#activate').hidden);
  stage.music._rejectPlay = false;
  await stage.activate();
  check('TV gesture claims lease and starts music', stage.armed && !stage.music.paused && !!stage.playerToken);
  const competingTV = browser('tv', origin + '/tv', { 'openk.tv.room': stage.host });
  await until(() => competingTV.w.openkStage?.client?.state, 'second TV opening existing room');
  competingTV.w.openkStage.client.stop();
  await competingTV.w.openkStage.activate();
  check('A second TV tab cannot acquire the live player lease', !competingTV.w.openkStage.armed
    && competingTV.w.openkStage.music.paused && !stage.music.paused);
  competingTV.w.openkStage.destroy();
  await phone.client.refresh();
  check('Controller sees actual player status', phone.client.state.player.online && phone.client.state.player.status === 'playing');
  remote.$('#remoteGuide').click();
  await until(() => phone.client.state.playback.guide, 'guide command');
  await stage.client.refresh();
  check('Phone guide toggle enables synchronized vocals', !stage.voice.paused);
  stage.music.currentTime = 20;
  stage.voice.currentTime = 19;
  stage.syncVoice(true);
  check('Conservative vocal resync preserves main track position', stage.voice.currentTime === 20 && stage.music.currentTime === 20);
  stage.voice.pause();
  stage.voice._rejectPlay = true;
  const beforeAttempts = stage.voice._playCount;
  stage.syncVoice(true);
  await until(() => stage.voiceBlocked, 'voice play rejection');
  stage.syncVoice(true);
  stage.syncVoice(true);
  check('Guide play rejection keeps music and avoids retry storms', !stage.music.paused
    && stage.voice._playCount === beforeAttempts + 1);
  stage.voice._rejectPlay = false;
  await phone.client.command('guide', { enabled: false });
  await stage.client.refresh();
  await phone.client.command('guide', { enabled: true });
  await stage.client.refresh();
  check('Guide can be retried by toggling it', !stage.voice.paused);
  stage.music.dispatchEvent(new tv.w.Event('waiting'));
  check('Buffering has a visible state and pauses guide', stage.status === 'buffering' && stage.voice.paused);
  stage.music.dispatchEvent(new tv.w.Event('playing'));
  remote.$('#remotePlay').click();
  await until(() => !phone.client.state.playback.playing, 'pause command');
  await stage.client.refresh();
  check('Phone pause stops both tracks', stage.music.paused && stage.voice.paused);
  remote.$('#remotePlay').click();
  await until(() => phone.client.state.playback.playing, 'play command');
  await stage.client.refresh();

  remote.network.dropCommand = true;
  await phone.client.command('add', { job_id: 'song-a' });
  check('Dropped command response retries without duplicate queue add', phone.client.state.queue.length === 1);
  const repeat = phone.client.state.queue[0];
  check('Repeat song has a distinct item ID', repeat.id !== phone.client.state.current.id);
  await phone.client.command('add', { job_id: 'song-b' });
  remote.$('#openQueue').click();
  check('Queue sheet opens with server-authoritative contents', !remote.$('#queuePanel').hidden
    && remote.$('#remoteQueue').children.length === 2);
  remote.$('#remoteQueue').children[1].querySelector('button').click();
  await until(() => phone.client.state.queue[0].job_id === 'song-b', 'move-to-top');
  check('Phone move-to-top changes shared queue', phone.client.state.queue[0].job_id === 'song-b');
  remote.$('#remoteQueue').children[1].querySelectorAll('button')[1].click();
  await until(() => phone.client.state.queue.length === 1, 'remove repeat');
  await phone.client.command('add', { job_id: 'song-a' });
  await stage.client.refresh();
  const original = stage.client.state.current.id;
  stage.music._ended = true;
  stage.music.dispatchEvent(new tv.w.Event('ended'));
  await until(() => stage.client.state.current.id !== original, 'TV ended advances queue');
  const second = stage.client.state.current.id;
  await stage.client.ended(stage.playerToken, {
    command_id: 'duplicate-old-event', item_id: original, generation: 1,
  });
  check('Duplicate old ended event cannot skip next song', stage.client.state.current.id === second);
  await phone.client.refresh();
  check('Ended advance is visible on phone', phone.client.state.current.id === second);
  await phone.client.command('seek', { item_id: second, position: 42 });
  await stage.client.refresh();
  check('Phone seek changes authoritative playback generation', stage.music.currentTime === 42);
  await phone.client.command('restart', { item_id: second });
  await stage.client.refresh();
  check('Restart seeks both tracks to zero', stage.music.currentTime === 0 && stage.voice.currentTime === 0);

  remote.$('#clearQueue').click();
  check('Clear queue requires a second confirmation', remote.$('#clearQueue').textContent.includes('确认'));
  remote.$('#clearQueue').click();
  await until(() => phone.client.state.queue.length === 0, 'clear pending');
  check('Clearing pending queue does not stop current song', !!phone.client.state.current);
  remote.w.document.dispatchEvent(new remote.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes phone queue and returns focus', remote.$('#queuePanel').hidden
    && remote.w.document.activeElement === remote.$('#openQueue'));

  await Promise.all([stage.client.refresh(), stage.client.refresh(), stage.client.refresh()]);
  check('Versioned polling remains single-flight', tv.network.maximum === 1);
  tv.network.offline = true;
  await stage.client.refresh().catch(() => {});
  check('Network failure displays reconnect status', tv.$('#connection').textContent.includes('重连'));
  // 断网前发出的心跳仍可能成功；先收完该确认，再模拟租约过期。
  await until(() => !stage.heartbeatBusy, 'last in-flight heartbeat settles');
  stage.lastLease = tv.w.performance.now() - 20000;
  await until(() => !stage.armed && stage.music.paused, 'expired lease watchdog', 2000);
  check('Lost lease watchdog pauses audio before server lease can transfer', !stage.armed && stage.music.paused);
  tv.network.offline = false;
  await stage.client.refresh();
  check('Reconnect never auto-arms television', !stage.armed && stage.music.paused
    && tv.$('#connection').textContent.includes('已连接'));

  stage.overlay(false);
  tv.$('#pair').focus();
  tv.w.document.dispatchEvent(new tv.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  check('D-pad arrows move focus to visible TV controls', tv.w.document.activeElement === tv.$('#fullscreen'));
  tv.w.document.dispatchEvent(new tv.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('TV Back/Escape opens pairing overlay and focuses close', !tv.$('#pairPanel').hidden
    && tv.w.document.activeElement === tv.$('#closePair'));
  tv.w.document.dispatchEvent(new tv.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  check('D-pad focus stays within pairing overlay', tv.$('#pairPanel').contains(tv.w.document.activeElement));
  tv.w.document.dispatchEvent(new tv.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('TV Back/Escape closes overlay', tv.$('#pairPanel').hidden);
  check('No API request URL contains host/controller secrets', [...tv.network.calls, ...remote.network.calls].every(call =>
    !call.url.href.includes(stage.host.token) && !call.url.href.includes(phone.client.token)
    && !call.url.search.includes(stage.host.code)));
  check('No unhandled window errors', errors.length === 0);
}

process.on('unhandledRejection', error => errors.push(error));
(async () => {
  try {
    await run();
    console.log(`\n${checks} room frontend assertions passed (real API; simulated media).`);
  } catch (error) {
    console.error(error.stack || error);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    for (const w of windows) {
      w.openkStage?.destroy();
      w.openkRemote?.destroy();
      w.close();
    }
    if (server && server.exitCode === null) {
      const exit = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      await exit;
    }
    if (errors.length) {
      console.error('Unhandled errors:', errors);
      process.exitCode = 1;
    }
  }
})();
