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
  const network = { calls: [], offline: false, dropCommand: false, stateRequests: 0, maximum: 0,
    holdNextLyrics: false, releaseLyrics: null };
  w.fetch = async (resource, options = {}) => {
    const target = new URL(resource, w.location.href);
    assert.equal(target.origin, w.location.origin, 'room never calls external services');
    network.calls.push({ url: target, options });
    if (network.offline) throw new TypeError('offline');
    const state = /^\/api\/rooms\/[a-f0-9]+$/.test(target.pathname) && (!options.method || options.method === 'GET')
      || /^\/api\/rooms\/[a-f0-9]+\/presence$/.test(target.pathname) && options.method === 'POST';
    if (state) {
      network.stateRequests++;
      network.maximum = Math.max(network.maximum, network.stateRequests);
      await sleep(10);
    }
    try {
      if (network.lyricsStatus && target.pathname.endsWith('/lyrics.json')) {
        return new Response(JSON.stringify({ detail: 'Synthetic media failure' }), {
          status: network.lyricsStatus, headers: { 'Content-Type': 'application/json' },
        });
      }
      const response = await fetch(target, options);
      if (network.holdNextLyrics && target.pathname.endsWith('/lyrics.json')) {
        network.holdNextLyrics = false;
        return new Promise(resolve => { network.releaseLyrics = () => resolve(response); });
      }
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
  w.eval(fs.readFileSync(path.join(frontend, 'account.js'), 'utf8'));
  if (page === 'remote') {
    w.eval(fs.readFileSync(path.join(frontend, 'search.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(frontend, 'library.js'), 'utf8'));
  }
  w.eval(fs.readFileSync(path.join(frontend, 'vendor/qrcode.js'), 'utf8'));
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
  const commandsBeforeSilentPlay = remote.network.calls.filter(call => call.url.pathname.endsWith('/commands')).length;
  remote.$('#remotePlay').click();
  await sleep(30);
  check('Offline remote does not report success or show pause without a receiver',
    remote.network.calls.filter(call => call.url.pathname.endsWith('/commands')).length === commandsBeforeSilentPlay
    && remote.$('#remotePlay').textContent === '▶' && remote.$('#remoteNotice').textContent.includes('还没有播放设备'));
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
  tv.$('#closePair').click();
  tv.$('#playPause').click();
  await until(() => stage.armed && !stage.music.paused && !!stage.playerToken, 'ordinary TV play button activates sound');
  check('TV play button itself claims lease and starts music', stage.armed && !stage.music.paused && !!stage.playerToken);
  const competingTV = browser('tv', origin + '/tv', { 'openk.tv.room': stage.host });
  await until(() => competingTV.w.openkStage?.client?.state, 'second TV opening existing room');
  competingTV.w.openkStage.client.stop();
  await competingTV.w.openkStage.activate();
  check('A second TV tab cannot acquire the live player lease', !competingTV.w.openkStage.armed
    && competingTV.w.openkStage.music.paused && !stage.music.paused);
  const competingClient = competingTV.w.openkStage.client;
  await competingClient.refresh();
  const departingPresence = competingClient.presenceId;
  const departingConnection = competingClient.presenceClient;
  competingTV.w.dispatchEvent(new competingTV.w.PageTransitionEvent('pagehide', { persisted: true }));
  await until(async () => {
    await stage.client.refresh();
    return !stage.client.state.devices.some(device => device.id === departingPresence);
  }, 'departing pairing TV presence is removed without waiting for expiry');
  check('TV pagehide stops polling and deletes only its own connection with keepalive',
    !competingClient.running && competingClient.presenceId === null
    && competingTV.network.calls.some(call => call.options.method === 'DELETE'
      && call.options.keepalive && call.url.pathname.endsWith('/presence/' + departingConnection))
    && stage.client.state.devices.some(device => device.id === stage.client.presenceId && device.player));
  competingTV.w.dispatchEvent(new competingTV.w.PageTransitionEvent('pageshow', { persisted: true }));
  await until(() => competingClient.running && competingClient.presenceId
    && competingClient.presenceId !== departingPresence, 'cached TV page reconnects with a fresh presence');
  await stage.client.refresh();
  check('Restored pairing TV has no ghost row and never bypasses sound activation',
    stage.client.state.devices.filter(device => device.member_id === stage.client.state.viewer.id).length === 2
    && !competingTV.w.openkStage.armed && competingTV.w.openkStage.music.paused && !stage.music.paused);
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

  const itemBeforeLyrics = stage.loadedItem;
  const epochBeforeLyrics = stage.mediaEpoch;
  const playsBeforeLyrics = stage.music._playCount;
  const positionBeforeLyrics = stage.music.currentTime;
  const publishRevision = async text => {
    const value = { source: 'Synthetic revision', lines: [
      { start: 0, end: 30, text, words: [{ text, start: 0, end: 30 }] },
      { start: 30, end: 40, text: 'Another line' },
    ] };
    const publication = await fetch(origin + '/api/jobs/song-a/lyrics', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
    assert.equal(publication.status, 200);
  };
  await publishRevision('Updated words');
  await stage.client.refresh();
  await until(() => stage.lines[0]?.text === 'Updated words', 'TV refreshes lyrics on the same queue item');
  stage.lyrics();
  check('Published lyric revisions replace TV words without reloading either track',
    stage.loadedItem === itemBeforeLyrics && stage.mediaEpoch === epochBeforeLyrics
    && stage.music._playCount === playsBeforeLyrics && stage.music.currentTime === positionBeforeLyrics
    && !stage.music.paused && tv.$('#lyricCurrent').textContent === 'Updated words');

  tv.network.holdNextLyrics = true;
  tv.network.releaseLyrics = null;
  await publishRevision('Obsolete words');
  await stage.client.refresh();
  await until(() => tv.network.releaseLyrics, 'an older lyric response is held');
  const held = tv.network.calls.filter(call => call.url.pathname.endsWith('/lyrics.json')).slice(-1)[0];
  await stage.client.refresh();
  check('Unchanged room polls do not restart an in-flight lyric request',
    tv.network.calls.filter(call => call.url.pathname === held.url.pathname).length === 1);
  await publishRevision('Latest words');
  await stage.client.refresh();
  await until(() => stage.lines[0]?.text === 'Latest words', 'the newer lyric revision loads first');
  tv.network.releaseLyrics();
  await sleep(30);
  check('A late lyric response cannot replace a newer revision of the same song',
    held.options.signal.aborted && stage.lines[0].text === 'Latest words'
    && stage.music.currentTime === positionBeforeLyrics && !stage.music.paused);

  const originalNow = tv.w.Date.now;
  let lyricNow = originalNow();
  tv.w.Date.now = () => lyricNow;
  tv.network.lyricsStatus = 503;
  await publishRevision('Recovered words');
  await stage.client.refresh();
  await until(() => !stage.lyricsRequest && stage.lyricsRetryAt > lyricNow, 'failed lyric fetch schedules retry');
  check('A failed refresh preserves the current TV lyrics and shows a retry notice',
    stage.lines[0].text === 'Latest words' && tv.$('#tvNotice').textContent.includes('自动重试'));
  const failedRequests = tv.network.calls.filter(call => call.url.pathname.endsWith('/lyrics.json')).length;
  await stage.client.refresh();
  check('Lyric failure retries are bounded across room heartbeats',
    tv.network.calls.filter(call => call.url.pathname.endsWith('/lyrics.json')).length === failedRequests);
  lyricNow += 5000;
  tv.network.lyricsStatus = 0;
  await stage.client.refresh();
  await until(() => stage.lines[0]?.text === 'Recovered words', 'a subsequent room poll retries the failed revision');
  tv.w.Date.now = originalNow;
  check('A recovered TV lyric fetch preserves the audio session and position',
    stage.mediaEpoch === epochBeforeLyrics && stage.music._playCount === playsBeforeLyrics
    && stage.music.currentTime === positionBeforeLyrics && !stage.music.paused);

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
  remote.$('#remoteQueue').children[1].querySelector('button[title="置顶"]').click();
  await until(() => phone.client.state.queue[0].job_id === 'song-b', 'move-to-top');
  check('Phone move-to-top changes shared queue', phone.client.state.queue[0].job_id === 'song-b');
  remote.$('#remoteQueue').children[1].querySelector('button[title="移除"]').click();
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
  check('D-pad arrows move focus to visible TV controls', tv.w.document.activeElement === tv.$('#stageLobby'));
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

  const alicePage = browser('remote', origin + '/rooms');
  const alice = alicePage.w.openkRemote;
  await until(() => alicePage.$('#lobbyList').children.length, 'party lobby lists TV room');
  check('Lobby discovers only shared room summaries, not pairing codes',
    alicePage.$('#lobbyList').textContent.includes(stage.host.name)
    && !alicePage.$('#lobbyList').textContent.includes(stage.host.code));
  alicePage.$('#displayName').value = 'Alice';
  alicePage.$('#newRoomName').value = 'Friday friends';
  alicePage.$('#createRoomForm').dispatchEvent(new alicePage.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => alice.client?.state?.viewer.role === 'host' && alicePage.$('#roomSongList button'),
    'phone creates named party room');
  const partyA = { id: alice.client.id, code: alice.credentials.code, token: alice.client.token };
  check('Phone owner can invite a TV without exposing its host capability',
    !alicePage.$('#hostControls').hidden && !!alicePage.$('#inviteQR svg')
    && new URL(alicePage.$('#screenInviteLink').href).pathname === '/tv'
    && !alicePage.$('#screenInviteLink').href.includes(partyA.token));

  const bobPage = browser('remote', alicePage.w.OpenKRoom.joinURL(partyA.id, partyA.code),
    { 'openk.display-name': 'Bob' });
  const bob = bobPage.w.openkRemote;
  await until(() => bob.client?.state?.viewer.name === 'Bob', 'second person joins party');
  check('Ordinary member does not see room-owner settings', bobPage.$('#hostControls').hidden);
  alicePage.$('#songSearch').value = 'dx';
  alice.renderLibrary();
  alicePage.$('#roomSongList button').click();
  await until(() => alice.client.state.current?.job_id === 'song-a', 'owner requests a shared song');
  await bob.client.refresh();
  bobPage.$('#singCurrent').click();
  await until(() => bob.client.state.current.singers.length === 2, 'second singer joins current song');
  await alice.client.refresh();
  check('A shared song records its requester and multiple singers',
    alice.client.state.current.requested_by.name === 'Alice'
    && alicePage.$('#currentSingers').textContent.includes('Alice')
    && alicePage.$('#currentSingers').textContent.includes('Bob')
    && alicePage.$('#roomMembers').textContent.includes('Bob'));

  const screenPage = browser('tv', alicePage.w.OpenKRoom.joinURL(partyA.id, partyA.code, 'screen'));
  screenPage.network.holdNextLyrics = true;
  const screen = screenPage.w.openkStage;
  await until(() => screen.client?.state?.current && screenPage.network.releaseLyrics,
    'invited TV pairs with its own screen capability');
  check('Screen invitation is distinct from ownership and starts silent',
    screen.host.role === 'screen' && screen.host.token !== partyA.token
    && screenPage.$('#tvSettingsPanel').hidden && !screen.armed && screen.music.paused
    && screenPage.w.location.hash === '');
  await screen.activate();
  check('TV renders the shared singing arrangement',
    screen.armed && screenPage.$('#stageSingers').textContent.includes('Alice')
    && screenPage.$('#stageSingers').textContent.includes('Bob'));

  alicePage.$('#switchRoom').click();
  await until(() => !alice.client && !alicePage.$('#joinScreen').hidden, 'owner opens lobby');
  check('Switching the phone view does not interrupt the independent TV',
    !screen.music.paused && !!alicePage.w.OpenKRoom.roomSessions.get(partyA.id, ['host']));
  alicePage.$('#newRoomName').value = 'Second stage';
  alicePage.$('#createRoomForm').dispatchEvent(new alicePage.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => alice.client?.state?.name === 'Second stage', 'second party room');
  const partyB = { id: alice.client.id, code: alice.credentials.code };
  alicePage.$('#songSearch').value = 'hktk';
  alice.renderLibrary();
  alicePage.$('#roomSongList button').click();
  await until(() => alice.client.state.current?.job_id === 'song-b', 'second room queues another song');
  await bob.client.refresh();
  check('Different sessions keep queues and membership isolated',
    bob.client.id === partyA.id && bob.client.state.current.job_id === 'song-a'
    && alice.client.id === partyB.id && alice.client.state.current.job_id === 'song-b');

  screen.music.currentTime = 17;
  await screen.heartbeat();
  screen.overlay(true);
  screenPage.$('#tvJoinPanel').open = true;
  screenPage.$('#tvJoinRoom').value = partyB.id;
  screenPage.$('#tvJoinCode').value = partyB.code;
  screenPage.$('#tvJoinForm').dispatchEvent(new screenPage.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => screen.client?.id === partyB.id && screen.client.state?.current?.job_id === 'song-b',
    'TV switches room through pairing form');
  screenPage.network.releaseLyrics();
  await sleep(50);
  await bob.client.refresh();
  check('TV switch releases only its old lease and fences late lyrics/audio',
    !bob.client.state.player.online && !bob.client.state.playback.playing
    && bob.client.state.current.job_id === 'song-a'
    && screen.music.src.includes('/song-b/') && screen.music.paused && !screen.armed
    && screen.lines.length === 0);
  check('The TV retains separate reconnect credentials for both rooms',
    screenPage.w.OpenKRoom.roomSessions.get(partyA.id, ['screen'])
    && screenPage.w.OpenKRoom.roomSessions.get(partyB.id, ['screen']));
  const savedA = screenPage.w.OpenKRoom.roomSessions.get(partyA.id, ['screen']).token;
  const savedB = screenPage.w.OpenKRoom.roomSessions.get(partyB.id, ['screen']).token;
  await screen.start(false, { room: partyA.id, code: partyA.code });
  await until(() => screen.client?.state, 'screen returns to first party');
  check('Returning to a paired room reuses its screen membership', screen.host.token === savedA);
  await screen.start(false, { room: partyB.id, code: partyB.code });
  await until(() => screen.client?.state, 'screen returns to second party');
  check('Repeated switching does not consume more screen slots', screen.host.token === savedB);
  await screen.activate();
  check('New room requires its own explicit audio activation', screen.armed && !screen.music.paused);

  const bobToken = bob.client.token;
  bobPage.$('#leaveRoom').click();
  await until(() => !bob.client && !bobPage.$('#joinScreen').hidden, 'member leaves party');
  const denied = await fetch(origin + '/api/rooms/' + partyA.id, {
    headers: { Authorization: 'Bearer ' + bobToken },
  });
  check('Leaving removes membership instead of only hiding the phone UI', denied.status === 403
    && !bobPage.w.OpenKRoom.roomSessions.get(partyA.id, ['controller']));

  alicePage.$('#switchRoom').click();
  const returnA = alicePage.$(`#recentList [data-room-id="${partyA.id}"] button`);
  check('The lobby retains multiple own rooms for one-click switching', !!returnA
    && !!alicePage.$(`#recentList [data-room-id="${partyB.id}"] button`));
  returnA.click();
  await until(() => alice.client?.id === partyA.id && alice.client.state, 'resume first room');
  alicePage.$('#hostControls').open = true;
  alicePage.$('#endRoom').click();
  alicePage.$('#endRoom').click();
  await until(() => !alice.client, 'owner closes first room');
  check('Closing one party does not stop a different room',
    screen.client.id === partyB.id && screen.armed && !screen.music.paused
    && !alicePage.w.OpenKRoom.roomSessions.get(partyA.id));
  alicePage.$(`#recentList [data-room-id="${partyB.id}"] button`).click();
  await until(() => alice.client?.id === partyB.id && alice.client.state, 'resume second room');
  alicePage.$('#hostControls').open = true;
  alicePage.$('#endRoom').click();
  alicePage.$('#endRoom').click();
  await until(() => !alice.client && !screen.client && screen.music.paused, 'room closure stops its TV');
  check('Closing a party silences its TV and removes its saved screen grant',
    !screen.armed && !screenPage.w.OpenKRoom.roomSessions.get(partyB.id, ['screen']));

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
