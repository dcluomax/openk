/**
 * node tests/frontend/test_account_rooms.js
 * Account mode end to end: the real FastAPI room API plus jsdom phones, televisions and
 * the library page. Identity is asserted with synthetic proxy headers against a throwaway
 * key file; no real credentials, account service or browser profile is involved.
 */
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../..');
const frontend = path.join(root, 'frontend');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A throwaway proxy key: production keeps the real one inside private NGINX/app mounts.
const KEY = 'openk-synthetic-frontend-test-proxy-key-0123456789_abc';
const keyFile = path.join(root, '.account-key-test-' + crypto.randomBytes(4).toString('hex'));
// 进程被异常打断时也不要在仓库里留下临时密钥文件。
process.on('exit', () => { try { fs.rmSync(keyFile, { force: true }); } catch {} });
const people = {
  ling: { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', username: 'ling', display_name: '小玲', is_staff: false },
  hao: { id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', username: 'hao', display_name: '阿豪', is_staff: false },
};
const header = person => Buffer.from(JSON.stringify(person), 'utf8').toString('base64url');

const windows = [];
const errors = [];
let server, serverOutput = '', checks = 0;

function check(name, condition) {
  assert.ok(condition, name);
  checks++;
  console.log('PASS ', name);
}
async function until(fn, message, timeout = 6000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeout) {
    try { if (await fn()) return; } catch (error) { last = ': ' + error.message; }
    await sleep(25);
  }
  throw new Error('Timed out: ' + message + last);
}

async function startServer() {
  assert.ok(/^[A-Za-z0-9_-]{48,128}$/.test(KEY), 'the synthetic proxy key matches the server contract');
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 });
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
    env: { ...process.env, OPENK_IDENTITY_KEY_FILE: keyFile },
  });
  server.stdout.on('data', data => { serverOutput += data; });
  server.stderr.on('data', data => { serverOutput += data; });
  server.on('error', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + port;
  await until(async () => {
    if (server.exitCode !== null) throw new Error('Fixture API failed: ' + serverOutput);
    try { return (await fetch(origin + '/health')).ok; } catch { return false; }
  }, 'fixture API startup', 15000);
  return origin;
}

/** One browser profile: a jsdom page whose requests carry one person's proxy assertion. */
function browser(page, url, person, storage = {}, controls = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(frontend, page + '.html'), 'utf8'), {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  windows.push(w);
  w.AbortController = globalThis.AbortController;
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, JSON.stringify(value));
  const net = { calls: [], signedOut: false, logouts: 0, navigations: [], person, ...controls };
  w.fetch = async (resource, options = {}) => {
    const target = new URL(resource, w.location.href);
    assert.equal(target.origin, w.location.origin, 'account pages never call a third party');
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    net.calls.push({ path: target.pathname, method: options.method || 'GET', headers: options.headers || {}, body });
    if (net.failNextPlay && target.pathname.endsWith('/commands') && body?.action === 'play') {
      net.failNextPlay = false;
      return { ok: false, status: 503, json: async () => ({ detail: 'Synthetic transient save failure' }) };
    }
    if (target.pathname === '/api/account') {
      if (net.identityWait) await net.identityWait;
      if (net.accountError) throw new Error('Synthetic network failure');
      if (net.accountStatus) return { ok: false, status: net.accountStatus,
        json: async () => ({ detail: 'Synthetic account service failure' }) };
    }
    // The private account service is not part of this fixture; only its contract is.
    if (target.pathname === '/auth/api/me/') {
      if (net.signedOut) return { ok: false, status: 401, json: async () => ({ detail: '请先登录' }) };
      return { ok: true, status: 200, json: async () => ({ ...net.person, csrf_token: 'synthetic-csrf-token',
        profile_url: '/auth/', login_url: '/auth/login/', logout_url: '/auth/logout/' }) };
    }
    if (target.pathname === '/auth/logout/') {
      if (net.logoutStatus) return { ok: false, status: net.logoutStatus, json: async () => ({}) };
      net.logouts++;
      net.signedOut = true;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    const headers = { ...options.headers };
    if (net.person && !net.signedOut) {
      headers['X-OpenK-Identity-Key'] = KEY;
      headers['X-OpenK-Account'] = header(net.person);
    } else if (net.person) {
      headers['X-OpenK-Identity-Key'] = KEY;   // Signed out upstream: the key alone means 401.
    }
    return fetch(target, { ...options, headers });
  };
  // jsdom refuses real navigation, so shadow the page-level `location` binding with a
  // read-through stand-in that records where the app wanted to send the person.
  const location = {
    get href() { return w.location.href; },
    set href(value) { net.navigations.push(String(value)); },
    get origin() { return w.location.origin; },
    get protocol() { return w.location.protocol; },
    get host() { return w.location.host; },
    get hostname() { return w.location.hostname; },
    get port() { return w.location.port; },
    get pathname() { return w.location.pathname; },
    get search() { return w.location.search; },
    get hash() { return w.location.hash; },
    assign: value => net.navigations.push(String(value)),
    replace: value => net.navigations.push(String(value)),
    reload: () => net.navigations.push('reload'),
    toString() { return w.location.href; },
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
  const run = (file, suffix = '') => w.eval('(function(location){'
    + fs.readFileSync(path.join(frontend, file), 'utf8') + '\n' + suffix + '\n}).call(window, window.__location)');
  w.__location = location;
  run('room-client.js');
  run('account.js');
  if (page === 'index') {
    w.AudioContext = w.webkitAudioContext = audioContext;
    w.navigator.mediaDevices = { getUserMedia: () => Promise.reject(new Error('测试环境没有麦克风')) };
    w.alert = message => errors.push('unexpected alert: ' + message);
    run('search.js');
    run('library.js');
    run('app.js', 'window.__t = { room, accountMode, addToQueue, playFromQueue, selectJob, state,'
      + ' inst, vocal, roomState, activateLocalPlayer, roomTransport, userSeek, reportRoomEnded,'
      + ' leaseWatchdog, roomHeartbeat };');
    if (w.document.readyState === 'complete') {
      w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    }
  } else {
    if (page === 'remote') { run('search.js'); run('library.js'); }
    run('vendor/qrcode.js');
    run(page + '.js');
  }
  return { w, net, page: w.openkRemote || w.openkStage,
    $: selector => w.document.querySelector(selector),
    all: selector => [...w.document.querySelectorAll(selector)] };
}

function audioContext() {
  const param = value => ({ value, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} });
  const node = () => ({ connect() {}, disconnect() {}, gain: param(1), buffer: null, type: '',
    frequency: param(1000), Q: param(1), threshold: param(0), knee: param(0), ratio: param(0),
    attack: param(0), release: param(0), fftSize: 2048, frequencyBinCount: 1024,
    smoothingTimeConstant: 0, getFloatFrequencyData(values) { values.fill(-120); } });
  return { state: 'running', resume: () => Promise.resolve(), destination: node(), sampleRate: 48000,
    currentTime: 0, createGain: node, createConvolver: node, createDynamicsCompressor: node,
    createBiquadFilter: node, createAnalyser: node, createMediaElementSource: node,
    createMediaStreamSource: node, createMediaStreamDestination: node,
    createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }) };
}

const connected = view => until(() => view.page?.client?.state, 'room connection for ' + view.w.location.pathname);

async function run() {
  const origin = await startServer();

  /* ---- Startup never exposes an unverified standalone controller. ---- */
  const inviter = { ...people.ling, id: '00000000-0000-4000-8000-000000000003',
    username: 'inviter', display_name: '邀请房主' };
  const invited = { ...people.hao, id: '00000000-0000-4000-8000-000000000004',
    username: 'invited', display_name: '邀请歌手' };
  const host = browser('remote', origin + '/remote', inviter);
  await until(() => host.page.ready && !host.page.starting, 'invitation host startup');
  const target = host.page.client.id;
  const code = host.page.credentials.code;
  let releaseProbe;
  const identityWait = new Promise(resolve => { releaseProbe = resolve; });
  const pendingPhone = browser('remote', origin + '/remote', invited, {}, { identityWait });
  check('First paint hides all create/join controls until identity is known',
    pendingPhone.$('#joinScreen').hidden && !pendingPhone.$('#startupScreen').hidden
    && pendingPhone.$('#createRoom').disabled && pendingPhone.$('#joinSubmit').disabled);
  pendingPhone.$('#newRoomName').value = 'Premature room';
  pendingPhone.$('#joinRoom').value = target;
  pendingPhone.$('#joinCode').value = code;
  await pendingPhone.page.create();
  await pendingPhone.page.join();
  check('Programmatic submits cannot bypass pending startup',
    !pendingPhone.net.calls.some(call => call.method === 'POST' && call.path.startsWith('/api/rooms'))
    && pendingPhone.page.client === null && pendingPhone.w.localStorage.getItem('openk.remote.room') === null);
  releaseProbe();
  await until(() => pendingPhone.page.ready && !pendingPhone.page.starting, 'identity resolves after blocked submits');
  check('The delayed startup still becomes a pinned account controller',
    pendingPhone.page.account.user.id === invited.id && pendingPhone.page.client.accountId === invited.id
    && pendingPhone.page.client.token === null && !pendingPhone.$('#accountChip').hidden);

  const invitationPath = '/remote#room=' + target + '&code=' + code;
  const failedPhone = browser('remote', origin + invitationPath, invited, {}, { accountStatus: 502 });
  await until(() => !failedPhone.$('#startupRetry').hidden, 'failed startup offers retry');
  await failedPhone.page.create();
  await failedPhone.page.join();
  check('An identity error keeps the standalone lobby hidden and performs no room mutation',
    failedPhone.$('#joinScreen').hidden && failedPhone.page.client === null
    && !failedPhone.net.calls.some(call => call.method === 'POST' && call.path.startsWith('/api/rooms')));
  failedPhone.net.accountStatus = 0;
  failedPhone.$('#startupRetry').click();
  await until(() => failedPhone.page.client?.id === target && !failedPhone.page.starting,
    'retry preserves the invitation after the fragment has been cleared');
  check('The account invitation survives current-room entry and joins the intended party',
    failedPhone.page.client.state.viewer.name === invited.display_name
    && failedPhone.page.client.state.members.length === 2 && !failedPhone.$('#roomScreen').hidden
    && failedPhone.w.location.hash === '' && failedPhone.w.localStorage.getItem('openk.remote.room') === null);
  const directLobby = browser('remote', origin + '/rooms', invited);
  await until(() => directLobby.page.ready && !directLobby.page.starting, 'direct account lobby entry');
  check('Opening /rooms preserves the lobby intent after current-room connection',
    directLobby.page.lobbyOpen && directLobby.w.location.pathname === '/rooms'
    && !directLobby.$('#joinScreen').hidden && !directLobby.$('#currentRoomBanner').hidden
    && directLobby.page.client.id === target && directLobby.page.client.running);
  const reopenedLobby = browser('remote', directLobby.w.location.href, invited);
  await until(() => reopenedLobby.page.ready && !reopenedLobby.page.starting, 'reopened account lobby');
  check('A lobby reload still opens the lobby without leaving its room',
    reopenedLobby.page.lobbyOpen && reopenedLobby.page.client.id === target);
  const wrongCode = code === '000000' ? '000001' : '000000';
  const invalidInvite = browser('remote', origin + '/remote#room=' + target + '&code=' + wrongCode, invited);
  await until(() => invalidInvite.page.ready && !invalidInvite.page.starting, 'invalid invitation handling');
  check('A refused invitation keeps the current room and shows a visible retry form',
    invalidInvite.page.client.id === target && !invalidInvite.$('#joinScreen').hidden
    && !!invalidInvite.$('#joinError').textContent);

  /* ---- 登录即入房：新浏览器也直接回到自己的房间 ---- */
  const phone = browser('remote', origin + '/remote', people.ling);
  await connected(phone);
  const solo = phone.page.client.state;
  check('A signed-in phone lands in a room without joining anything', !!solo.id);
  check('That room is a private solo room', solo.solo === true && solo.account_mode === true);
  check('The member is named from the profile, not from a browser field',
    solo.viewer.name === '小玲' && solo.members.length === 1);
  check('Free-form nickname editing is replaced by profile editing',
    phone.$('#displayName').hidden && phone.$('#memberForm').hidden
    && phone.$('#profileLink').getAttribute('href') === '/auth/');
  check('The user chip identifies the signed-in person',
    phone.$('#accountChip .account-name').textContent === '小玲'
    && phone.$('#accountChip .account-avatar').textContent === '小玲'
    && phone.$('#accountChip').dataset.accountId === people.ling.id);
  check('A solo room offers playing on this device', !phone.$('#soloHint').hidden
    && phone.$('#playHere').getAttribute('href') === '/?view=player');
  check('No room bearer capability is kept for an account', phone.page.client.token === null
    && phone.w.localStorage.getItem('openk.remote.room') === null
    && phone.w.localStorage.getItem('openk.room-sessions.v1') === null);

  /* ---- 独唱也用同一套房间/队列/播放器 ---- */
  await until(() => phone.page.jobs.length, 'library load on the phone');
  await phone.page.client.command('add', { job_id: 'song-a' });
  await until(() => phone.page.client.state.current?.job_id === 'song-a', 'solo queue accepted the song');
  check('Solo play uses the same room queue engine',
    phone.page.client.state.current.title === '稻香');

  const tv = browser('tv', origin + '/tv', people.ling);
  await connected(tv);
  check('A television resumes the same account room, not a second guest',
    tv.page.client.id === solo.id);
  check('One account with two devices stays one member',
    tv.page.client.state.members.length === 1);
  check('The television shows who is signed in',
    tv.$('#tvAccountChip .account-name').textContent === '小玲');
  await tv.page.activate();
  check('One person can sing alone with a phone and a television',
    tv.page.armed === true && !tv.page.music.paused
    && tv.page.client.state.current.job_id === 'song-a');

  /* ---- 浏览大厅不会把人丢出房间 ---- */
  await phone.page.leave();
  await until(() => phone.page.client?.id === solo.id, 'leaving a private room keeps the same room');
  check('Leaving a private room keeps the person inside it with the queue intact',
    phone.page.client.state.current?.job_id === 'song-a' && phone.page.client.state.solo === true
    && !phone.$('#roomScreen').hidden && phone.$('#joinScreen').hidden === true);

  phone.page.showLobby();
  await sleep(30);
  check('Browsing the lobby keeps the current room connected',
    phone.page.client?.running === true && phone.page.client.id === solo.id);
  check('The lobby explains where the person currently is',
    !phone.$('#currentRoomBanner').hidden
    && phone.$('#currentRoomText').textContent.includes('自己的房间'));
  check('The lobby is only a selector', phone.w.location.pathname === '/rooms'
    && !phone.$('#joinScreen').hidden);
  phone.$('#returnRoom').click();
  await sleep(30);
  check('Returning from the lobby needs no rejoin', phone.w.location.pathname === '/remote'
    && phone.page.client.id === solo.id && !phone.$('#roomScreen').hidden);

  /* ---- 开派对：同一个账号的电视跟着走，旧房间立刻停声 ---- */
  phone.$('#newRoomName').value = '生日聚会';
  phone.$('#newRoomListed').checked = true;
  phone.$('#newRoomScreens').checked = true;
  await phone.page.create();
  await until(() => phone.page.client?.state?.name === '生日聚会', 'party room created');
  const party = phone.page.client.id;
  check('Creating a party moves the account atomically', party !== solo.id);
  check('The new host keeps a usable invite code',
    /^\d{6}$/.test(phone.page.credentials.code || ''));
  check('The invite cache is namespaced by account and carries the invite version',
    JSON.parse(phone.w.localStorage.getItem('openk.account.invites.v1'))[people.ling.id][party].code
      === phone.page.credentials.code
    && JSON.parse(phone.w.localStorage.getItem('openk.account.invites.v1'))[people.ling.id][party].version
      === phone.page.client.state.invite_version);

  const wasPlaying = tv.page.music._playCount;
  await until(() => tv.page.client?.id === party, 'the television follows the account to the party');
  check('The television stops the old room audio immediately', tv.page.music.paused);
  check('Following a room change requires a new gesture before audio',
    tv.page.armed === false && !tv.$('#pairPanel').hidden && wasPlaying > 0);
  await until(() => tv.page.client.state?.members.length === 1, 'the party sees one account member');
  check('The same account never takes a second seat in the new room',
    tv.page.client.state.members.length === 1);

  /* ---- 主人可以重新生成配对码 ---- */
  const before = phone.page.credentials.code;
  await phone.page.rotateInvite();
  const rotated = phone.page.credentials.code;
  check('A host can rotate the invite code', /^\d{6}$/.test(rotated) && rotated !== before);
  check('The rotated code is stored under this account with the new version',
    JSON.parse(phone.w.localStorage.getItem('openk.account.invites.v1'))[people.ling.id][party].code === rotated
    && phone.page.client.state.invite_version > 1);
  // 另一台已登录的设备换了配对码：这台手机上的旧码必须立刻消失，且不能自己再换一次。
  const elsewhere = await (await fetch(origin + '/api/rooms/' + party + '/invitation', {
    method: 'POST',
    headers: { 'X-OpenK-Identity-Key': KEY, 'X-OpenK-Account': header(people.ling) },
  })).json();
  const rotations = phone.net.calls.filter(call => call.path.endsWith('/invitation')).length;
  await until(() => phone.page.client.state?.invite_version === elsewhere.state.invite_version,
    'the phone sees the invite version another device produced');
  check('A code rotated on another device disappears instead of misleading the host',
    phone.page.credentials.code === null && phone.$('#roomInvite').hidden === true
    && phone.$('#inviteQR').children.length === 0 && phone.$('#inviteCode').textContent !== rotated);
  check('A stale code offers explicit generation instead of auto-rotating across devices',
    phone.$('#refreshInvite').hidden === false && phone.$('#refreshInvite').textContent === '生成配对码'
    && phone.$('#invitePrivacy').textContent.includes('另一台设备')
    && phone.net.calls.filter(call => call.path.endsWith('/invitation')).length === rotations
    && phone.page.client.state.invite_version === elsewhere.state.invite_version);
  await phone.page.rotateInvite();
  const regenerated = phone.page.credentials.code;
  check('The host can mint a working code again on this device',
    /^\d{6}$/.test(regenerated || '') && regenerated !== rotated
    && phone.$('#roomInvite').hidden === false
    && JSON.parse(phone.w.localStorage.getItem('openk.account.invites.v1'))[people.ling.id][party].version
      === phone.page.client.state.invite_version);
  // 电视没有保存过这个房间的明文配对码，所以它只会显示“生成配对码”，不会亮出别的码。
  await until(() => tv.page.client.state?.invite_version === phone.page.client.state.invite_version,
    'the television sees the newest invite version');
  check('A device that never held the code shows no code at all',
    tv.page.host.code === '' && !tv.$('#pairCode').textContent.includes(regenerated)
    && tv.$('#qr').children.length === 0 && tv.$('#tvRefreshInvite').textContent === '生成配对码');
  const stale = await fetch(origin + '/api/rooms/' + party + '/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-OpenK-Identity-Key': KEY, 'X-OpenK-Account': header(people.hao) },
    body: JSON.stringify({ code: before }),
  });
  check('The previous code stops working once rotated', stale.status === 403 || stale.status === 422);

  /* ---- 另一个账号：可以来聚会，也可以自己开房 ---- */
  const guest = browser('remote', origin + '/remote', people.hao);
  await connected(guest);
  const guestSolo = guest.page.client.id;
  check('A different account gets its own independent room', guestSolo !== party && guestSolo !== solo.id);
  check('Each account sees its own name', guest.page.client.state.viewer.name === '阿豪');

  guest.$('#joinRoom').value = party;
  guest.$('#joinCode').value = '000000';
  await guest.page.join();
  check('A refused join leaves the person exactly where they were',
    guest.page.client.id === guestSolo && guest.page.client.running === true
    && !!guest.$('#joinError').textContent);

  guest.$('#joinRoom').value = party;
  guest.$('#joinCode').value = regenerated;
  await guest.page.join();
  await until(() => guest.page.client.id === party, 'the guest joins the party');
  check('A successful join follows the server into the party room',
    guest.page.client.id === party && guest.w.location.pathname === '/remote');
  await until(() => phone.page.client.state.members.length === 2, 'the host sees the guest arrive');
  check('A party holds different accounts as separate members',
    phone.page.client.state.members.map(member => member.name).sort().join() === '小玲,阿豪');
  check('Room membership is a stable pseudonym, not the account id',
    phone.page.client.state.members.every(member => !Object.values(people)
      .some(person => String(member.id).includes(person.id))));

  /* ---- 离开聚会：回到自己的房间，而不是空白页面 ---- */
  await guest.page.leave();
  await until(() => guest.page.client && guest.page.client.id !== party, 'the guest returns to a solo room');
  check('Leaving a party returns to a private solo room',
    guest.page.client.state.solo === true && !guest.$('#roomScreen').hidden);
  check('Leaving never shows an empty join screen', guest.$('#joinScreen').hidden === true);

  /* ---- 曲库页：账号模式下点歌进房间，而且就在本机开唱 ---- */
  const library = browser('index', origin + '/library', people.ling);
  await until(() => library.w.__t?.room?.id, 'library resolves the account current room');
  await until(() => library.all('.song-row').length, 'library renders the catalog');
  check('The library shows the signed-in person',
    library.$('#accountChip .account-name').textContent === '小玲');
  check('The library follows the account room instead of its own',
    library.w.__t.room.id === party);
  check('Opening the library never starts audio before a gesture',
    library.$('#instAudio').paused && library.w.__t.room.armed === false
    && library.w.__t.room.playerToken === null);

  const row = library.all('.song-row').find(node => node.dataset.id === 'song-b');
  row.querySelector('.sr-pick').click();
  await until(() => phone.page.client.state.queue.concat([phone.page.client.state.current])
    .some(item => item?.job_id === 'song-b'), 'the library song reaches the active room');
  check('Library picking enqueues into the active room',
    library.net.calls.some(call => call.path === '/api/rooms/' + party + '/commands'));
  await until(() => !library.$('#instAudio').paused, 'the library sings the room song on this device');
  check('A library pick opens the classic player bound to the room',
    !library.$('#stage').classList.contains('hidden')
    && library.w.__t.state.currentJobId === 'song-b'
    && library.w.__t.room.client.state.current.job_id === 'song-b');
  check('Local audio only runs while this device holds the room player lease',
    library.w.__t.room.armed === true && typeof library.w.__t.room.playerToken === 'string'
    && library.w.__t.room.client.token === null);
  check('Account mode keeps no private browser queue',
    library.w.localStorage.getItem('openk.queue') === null);

  library.$('#viewToggle').click();
  const card = library.all('.song-card').find(node => node.dataset.id === 'song-a');
  card.querySelector('[data-act="play"]').click();
  await until(() => library.w.__t.room.client.state.current?.job_id === 'song-a',
    'library play-now sings immediately in this room');
  await until(() => library.w.__t.state.currentJobId === 'song-a', 'the local engine follows the room');
  check('A library play-now keeps singing here instead of opening a second player',
    !library.net.navigations.includes('/tv') && !library.$('#instAudio').paused
    && library.w.__t.room.armed === true);

  await until(() => library.w.__t.state.lyrics?.lines.length
    && tv.page.loadedItem === library.w.__t.room.loadedItem, 'both account players load the same song');
  library.w.__t.inst.currentTime = 17;
  const lyricItem = library.w.__t.room.loadedItem;
  const lyricGeneration = library.w.__t.state.selectionGeneration;
  const lyricPlays = library.w.__t.inst._playCount;
  const changedLyrics = await phone.w.fetch('/api/jobs/song-a/lyrics', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'Shared synthetic revision',
      lines: [{ start: 0, end: 60, text: 'Shared revised text' }] }),
  });
  assert.equal(changedLyrics.status, 200);
  await until(() => library.w.__t.state.lyrics?.lines[0]?.text === 'Shared revised text'
    && tv.page.lines[0]?.text === 'Shared revised text', 'published lyrics reach both account devices');
  check('Another device updates the full player and TV lyrics without replaying the song',
    library.w.__t.room.loadedItem === lyricItem && library.w.__t.state.selectionGeneration === lyricGeneration
    && library.w.__t.inst._playCount === lyricPlays && library.w.__t.inst.currentTime === 17
    && !library.w.__t.inst.paused && !tv.page.armed && tv.page.music.paused);

  /* ---- 同一首歌点两次是两条独立记录，增删都认房间条目 ID ---- */
  library.w.__t.addToQueue('song-b');
  library.w.__t.addToQueue('song-b');
  library.w.__t.addToQueue('song-b');
  await until(() => library.w.__t.room.items.filter(item => item.job_id === 'song-b').length === 3,
    'the same song can be queued more than once');
  const copies = library.w.__t.room.items.filter(item => item.job_id === 'song-b');
  check('Duplicate picks stay separate entries with their own room item ids',
    new Set(copies.map(item => item.id)).size === 3
    && library.all('#queueList .q-item').length === library.w.__t.room.items.length
    && library.all('#queueList .q-item').every(node => node.dataset.item));
  library.all('#queueList .q-item').find(node => node.dataset.item === copies[1].id)
    .querySelector('[data-act="del"]').click();
  await until(() => library.w.__t.room.items.filter(item => item.job_id === 'song-b').length === 2,
    'a queue removal reaches the room');
  check('Removing one copy leaves the other copies alone',
    library.w.__t.room.items.filter(item => item.job_id === 'song-b')
      .map(item => item.id).join() === [copies[0].id, copies[2].id].join());

  /* ---- 暂停 / 继续 / 导唱都经过房间，两台设备看到的是同一件事 ---- */
  library.$('#playBtn').click();
  await until(() => library.$('#instAudio').paused
    && phone.page.client.state.playback.playing === false, 'pausing here pauses the room');
  check('Pausing here pauses the whole room',
    library.$('#instAudio').paused && phone.page.client.state.playback.playing === false);
  await phone.page.client.command('play');
  await until(() => !library.$('#instAudio').paused, 'a phone play resumes this device');
  check('A phone can resume the singing device', !library.$('#instAudio').paused);
  await phone.page.client.command('guide', { enabled: true });
  await until(() => library.w.__t.state.singMode === 'orig', 'a phone can turn the guide vocal on');
  check('Guide changes from another device reach the local mixer',
    library.w.__t.state.singMode === 'orig' && library.w.localStorage.getItem('openk.queue') === null);

  const singing = library.w.__t.room.client.state.current.id;
  const singingGeneration = library.w.__t.room.client.state.playback.seek_version;
  library.w.__t.reportRoomEnded();
  const endedReport = { ...library.w.__t.room.pendingEnded };
  check('An ended report is minted once against the exact entry and generation',
    typeof endedReport.command_id === 'string' && endedReport.command_id.length > 0
    && endedReport.item_id === singing && endedReport.generation === singingGeneration);
  await until(() => library.w.__t.room.client.state.current?.id !== singing,
    'finishing a song lets the server advance the queue');
  check('The server advances the queue when a song ends here',
    library.w.__t.room.client.state.current.id === copies[0].id
    && library.w.__t.state.currentJobId === 'song-b');

  /* ---- 重发同一条「唱完了」只能被去重，绝不能一口气翻过两首 ---- */
  const advanced = library.w.__t.room.client.state.current.id;
  await library.w.__t.room.client.ended(library.w.__t.room.playerToken, endedReport);
  check('Re-sending the identical ended report is deduplicated instead of skipping a song',
    library.w.__t.room.client.state.current.id === advanced);
  library.w.__t.room.pendingEnded = {
    command_id: library.w.OpenKRoom.id(), item_id: singing, generation: singingGeneration,
  };
  await library.w.__t.roomHeartbeat();
  check('A stale ended report is dropped instead of replayed as a new action',
    library.w.__t.room.pendingEnded === null
    && library.w.__t.room.client.state.current.id === advanced);

  /* ---- 进度条 / 重播 / 切歌还是原来那几个按钮，只是改由房间裁决 ---- */
  const seeksBeforeDrag = library.net.calls.filter(call => call.body?.action === 'seek').length;
  for (let value = 100; value <= 500; value += 10) {
    library.$('#seek').value = value;
    library.$('#seek').dispatchEvent(new library.w.Event('input'));
  }
  await sleep(50);
  check('Dragging previews locally without queuing every intermediate room seek',
    library.net.calls.filter(call => call.body?.action === 'seek').length === seeksBeforeDrag);
  library.$('#seek').dispatchEvent(new library.w.Event('change'));
  await until(() => Math.abs(phone.page.client.state.playback.position - 90) < 1,
    'dragging the seek bar moves the room');
  check('The classic seek bar moves this device and the room together',
    Math.abs(library.w.__t.inst.currentTime - 90) < 1
    && Math.abs(phone.page.client.state.playback.position - 90) < 1
    && library.net.calls.filter(call => call.body?.action === 'seek').length === seeksBeforeDrag + 1);
  library.$('#nbReplay').click();
  await until(() => phone.page.client.state.playback.position === 0, 'replay restarts the room song');
  await until(() => library.w.__t.inst.currentTime === 0, 'replay rewinds this device too');
  check('Replay restarts the song for everyone in the room',
    library.w.__t.inst.currentTime === 0 && !library.$('#instAudio').paused);
  library.$('#nbSkip').click();
  await until(() => library.w.__t.room.client.state.current?.id === copies[2].id,
    'skipping advances exactly one entry');
  check('Skipping advances exactly one entry and loads it on this device',
    library.w.__t.room.client.state.current.id === copies[2].id
    && library.w.__t.room.items.length === 0
    && library.w.__t.state.currentJobId === 'song-b');

  /* ---- 同账号的第二台设备不能把正在唱的那台抢掉 ---- */
  const second = browser('index', origin + '/library', people.ling);
  await until(() => second.w.__t?.room.ready && second.w.__t.room.client.state?.player.online,
    'a second device of the same account sees the live player');
  second.$('#roomActivate').click();
  await sleep(150);
  check('A second device never steals the active player lease',
    second.$('#instAudio').paused && second.w.__t.room.armed === false
    && second.w.__t.room.playerToken === null && !library.$('#instAudio').paused);
  await until(() => second.w.__t.state.currentJobId === 'song-b'
    && second.$('#playBtn').textContent === '⏸', 'the passive device mirrors the live receiver');
  check('A passive device stays on the song list, keeps the room song ready and reports the real receiver',
    second.$('#stage').classList.contains('hidden')
    && second.w.__t.state.currentJobId === 'song-b'
    && second.$('#roomStatus').hidden === false
    && second.$('#roomActivate').disabled
    && /正在播放/.test(second.$('#roomPlaybackStatus').textContent));

  /* ---- 心跳把真实的播放状态和进度交给房间 ---- */
  library.w.__t.inst.currentTime = 42;
  await until(() => phone.page.client.state.player.online
    && phone.page.client.state.player.position >= 42, 'the room sees the real playback position', 12000);
  check('The singing device publishes its real media status to the room',
    phone.page.client.state.player.status === 'playing'
    && phone.page.client.state.player.position >= 42);

  /* ---- 续不上租约就必须马上停声，不能两台机器一起响 ---- */
  library.w.__t.room.lastLease = -1e6;
  library.w.__t.leaseWatchdog();
  check('A lease that cannot be renewed stops local audio at once',
    library.$('#instAudio').paused && library.w.__t.room.armed === false
    && library.w.__t.room.playerToken === null);
  await until(() => !library.$('#roomActivate').disabled, 'the activation control comes back');
  library.$('#roomActivate').click();
  await until(() => !library.$('#instAudio').paused, 'an explicit activation sings again');
  check('An explicit local activation restores singing after a lost lease',
    library.w.__t.room.armed === true && !library.$('#instAudio').paused
    && library.w.__t.state.currentJobId === 'song-b');

  /* ---- 换房间：先停声，新房间要重新做一次手势 ---- */
  const singer = browser('index', origin + '/library', people.hao);
  await until(() => singer.w.__t?.room.ready && singer.all('.song-row').length, 'the other account opens the library');
  singer.all('.song-row').find(node => node.dataset.id === 'song-a').querySelector('.sr-pick').click();
  await until(() => !singer.$('#instAudio').paused, 'the other account sings in its own room');
  const ownRoom = singer.w.__t.room.id;
  check('Every account sings inside its own room, even alone',
    ownRoom !== party && singer.w.__t.room.armed === true
    && singer.w.__t.room.client.state.solo === true);
  guest.$('#newRoomName').value = '换个房间';
  await guest.page.create();
  await until(() => singer.w.__t.room.ready && singer.w.__t.room.id !== ownRoom,
    'the library follows the account into the new room');
  check('A room move stops local audio and needs a fresh gesture',
    singer.$('#instAudio').paused && singer.w.__t.room.armed === false
    && singer.w.__t.room.playerToken === null && singer.w.__t.room.gesture === false
    && !singer.w.__t.room.client.state.current
    && singer.w.localStorage.getItem('openk.queue') === null);
  singer.$('#homeBtn').click();
  await until(() => singer.all('.song-row').length, 'the catalog is browsable in the new room');
  singer.all('.song-row').find(node => node.dataset.id === 'song-a').querySelector('.sr-pick').click();
  await until(() => !singer.$('#instAudio').paused, 'a fresh gesture sings in the new room');
  check('A fresh gesture sings again inside the new room',
    singer.w.__t.room.armed === true
    && singer.w.__t.room.client.state.current.job_id === 'song-a'
    && singer.w.__t.room.id !== ownRoom);

  singer.$('#accountChip .account-logout').click();
  await until(() => singer.net.logouts === 1, 'the library signs out');
  check('Signing out of the library stops local audio before leaving',
    singer.$('#instAudio').paused && singer.w.__t.room.armed === false
    && singer.net.navigations.includes('/auth/login/'));

  /* ---- 手机把人送到 /?view=player：先静静地把歌摆好，按一下才出声 ---- */
  const reopened = browser('index', origin + '/?view=player', people.hao);
  await until(() => reopened.w.__t?.room.ready && reopened.w.__t.state.currentJobId,
    'the reopened player page loads the room song');
  check('Reopening the player shows the room song without making a sound',
    !reopened.$('#stage').classList.contains('hidden') && reopened.$('#instAudio').paused
    && reopened.w.__t.room.armed === false && reopened.w.__t.room.playerToken === null);
  await until(() => !reopened.$('#roomActivate').disabled, 'the activation control is offered', 3000);
  reopened.$('#roomActivate').click();
  await until(() => !reopened.$('#instAudio').paused, 'the offered control starts the audio');
  check('An obvious control turns a silent reopened player into real singing',
    reopened.w.__t.room.armed === true && !reopened.$('#instAudio').paused
    && reopened.w.__t.room.client.state.playback.playing === true);

  /* ---- 房间「想播」但没有任何设备握着租约：界面不许摆出暂停图标骗人 ---- */
  reopened.w.__t.room.lastLease = -1e6;
  reopened.w.__t.leaseWatchdog();
  await until(() => !reopened.w.__t.room.armed && reopened.$('#instAudio').paused,
    'the watchdog gives the player back');
  await until(() => !reopened.w.__t.room.client.state.player.online,
    'the room sees that no device outputs sound any more', 14000);
  // 手机遥控按了播放，可是房间里一台出声的设备都没有——线上就是这样「播放没有用」的。
  await reopened.w.__t.room.client.command('play', {});
  check('A room that only wants to play shows ▶ when no device can make a sound',
    reopened.w.__t.room.client.state.playback.playing === true
    && reopened.w.__t.room.client.state.player.online === false
    && reopened.$('#instAudio').paused && reopened.$('#playBtn').textContent === '▶'
    && reopened.$('#nbPlay').textContent === '▶');
  reopened.$('#playBtn').click();
  await until(() => !reopened.$('#instAudio').paused && reopened.$('#playBtn').textContent === '⏸',
    'the play button itself claims the room player and says so');
  check('Pressing play with no receiver activates this device instead of toggling a silent room',
    reopened.w.__t.room.armed === true && reopened.w.__t.room.playerToken !== null
    && reopened.$('#playBtn').textContent === '⏸');

  const interrupted = browser('index', origin + '/library',
    { ...people.hao, id: '00000000-0000-4000-8000-000000000055', username: 'activation-retry' },
    {}, { failNextPlay: true });
  await until(() => interrupted.w.__t?.room.ready && interrupted.all('.song-row').length, 'activation failure fixture');
  interrupted.all('.song-row')[0].querySelector('.sr-pick').click();
  await until(() => !interrupted.net.failNextPlay && !interrupted.w.__t.room.activating
    && !interrupted.w.__t.room.client.state.player.online, 'a failed play returns the successful claim immediately');
  check('Failure after claiming playback does not strand the user behind their own lease',
    interrupted.w.__t.room.playerToken === null && !interrupted.w.__t.room.armed
    && !interrupted.$('#roomActivate').disabled && interrupted.$('#instAudio').paused);
  interrupted.$('#roomActivate').click();
  await until(() => interrupted.w.__t.room.armed && !interrupted.$('#instAudio').paused,
    'retry after a transient play failure needs no 12 second lease timeout', 3000);
  check('The same device can immediately retry a failed activation', interrupted.w.__t.room.armed);

  const dragging = interrupted.w.__t.room.client;
  const oldItem = dragging.state.current.id;
  await dragging.command('add', { job_id: dragging.state.current.job_id });
  interrupted.$('#seek').value = 400;
  interrupted.$('#seek').dispatchEvent(new interrupted.w.Event('input'));
  const oldSeeks = interrupted.net.calls.filter(call => call.body?.action === 'seek').length;
  await dragging.command('next', { item_id: oldItem });
  interrupted.$('#seek').dispatchEvent(new interrupted.w.Event('change'));
  await sleep(30);
  check('A drag begun on another queue entry cannot seek its replacement',
    dragging.state.current.id !== oldItem
    && interrupted.net.calls.filter(call => call.body?.action === 'seek').length === oldSeeks);

  dragging.stop();
  await interrupted.w.OpenKRoom.RoomClient.create({ name: 'New room, no replay', discoverable: false, allow_screens: true });
  await interrupted.w.__t.roomTransport('add', { job_id: dragging.state.current.job_id });
  check('Recovering a moved account cannot replay an old room action into the new room',
    interrupted.w.__t.room.id !== dragging.id && !interrupted.w.__t.room.client.state.current
    && !interrupted.w.__t.room.armed && interrupted.$('#instAudio').paused);

  let releaseIdentity;
  const libraryIdentityWait = new Promise(resolve => { releaseIdentity = resolve; });
  const waiting = browser('index', origin + '/library', people.ling,
    { 'openk.queue': ['song-a'] }, { identityWait: libraryIdentityWait });
  await until(() => waiting.all('.song-row').length, 'catalog is visible while identity is pending');
  waiting.all('.song-row')[0].querySelector('.sr-pick').click();
  waiting.w.__t.playFromQueue();
  await waiting.w.__t.selectJob('song-a');
  check('Pending identity cannot restore a local queue or open any standalone player',
    !waiting.w.__t.room.ready && waiting.w.__t.state.queue.length === 0
    && waiting.w.__t.state.currentJobId === null && waiting.$('#instAudio').paused
    && waiting.w.localStorage.getItem('openk.queue') === '["song-a"]');
  releaseIdentity();
  await until(() => waiting.w.__t.room.ready, 'pending identity eventually enters its room');
  check('Account startup keeps the legacy local queue separate',
    waiting.w.__t.room.id === party
    && waiting.w.__t.state.queue.join() === waiting.w.__t.room.items.map(item => item.job_id).join()
    && waiting.w.localStorage.getItem('openk.queue') === '["song-a"]');
  for (const controls of [{ accountStatus: 503 }, { accountError: true }]) {
    const failed = browser('index', origin + '/library', people.ling,
      { 'openk.queue': ['song-a'] }, controls);
    await until(() => failed.w.__t?.room.error && failed.all('.song-row').length, 'account failure is surfaced');
    failed.all('.song-row')[0].querySelector('.sr-pick').click();
    failed.w.__t.playFromQueue();
    await failed.w.__t.selectJob('song-a');
    check('A failed account probe never becomes standalone mode',
      !failed.w.__t.room.ready && failed.w.__t.state.queue.length === 0
      && failed.w.__t.state.currentJobId === null && failed.$('#instAudio').paused
      && failed.w.localStorage.getItem('openk.queue') === '["song-a"]');
  }

  /* ---- 房主解散：自己回到单人房间，其他人下次轮询时各自恢复 ---- */
  guest.$('#joinRoom').value = party;
  guest.$('#joinCode').value = regenerated;
  await guest.page.join();
  await until(() => guest.page.client.id === party, 'the guest rejoins before the party ends');
  await phone.page.client.refresh();
  const queueBefore = JSON.stringify(phone.page.client.state.queue);
  for (const page of ['remote', 'tv', 'index']) {
    const switched = browser(page, origin + (page === 'index' ? '/library' : '/' + page), people.ling);
    if (page === 'index') await until(() => switched.w.__t?.room.ready, 'library before cookie switch');
    else await connected(switched);
    switched.net.person = people.hao;
    if (page === 'index') switched.w.__t.addToQueue('song-b');
    else await assert.rejects(switched.page.client.command('add', { job_id: 'song-b' }),
      error => error.code === 'account_changed');
    await until(() => (page === 'index' ? switched.w.__t.room.account : switched.page.account)?.user.id
      === people.hao.id && (page === 'index' ? switched.w.__t.room.ready : switched.page.client?.state),
    'the ' + page + ' follows the new browser account');
    check('Cookie switch refreshes the ' + page + ' identity even within the same party',
      switched.$('.account-name').textContent === '阿豪'
      && switched.net.calls.some(call => call.headers['X-OpenK-Expected-Account'] === people.ling.id));
    if (page === 'tv') check('Cookie switch never auto-enables television audio', !switched.page.armed);
  }
  await phone.page.client.refresh();
  check('Stale commands are not replayed as the new account',
    JSON.stringify(phone.page.client.state.queue) === queueBefore);
  await phone.page.endRoom();
  await phone.page.endRoom();
  await until(() => phone.page.client && phone.page.client.id !== party, 'the host lands in a fresh room');
  check('Disbanding a party still leaves the host inside a room',
    phone.page.client.state.solo === true && !phone.$('#roomScreen').hidden);
  await until(() => guest.page.client && guest.page.client.id !== party, 'the guest recovers on its own');
  check('A member of a closed room recovers its own room instead of stalling',
    guest.page.client.state.solo === true && guest.page.client.running === true
    && guest.$('#joinScreen').hidden === true);
  await until(() => tv.page.client?.id === phone.page.client.id, 'the television follows the host home');
  check('The television leaves the closed room with the account',
    tv.page.client.id === phone.page.client.id && tv.page.music.paused);

  /* ---- 退出登录：先停声，再交还给账号服务 ---- */
  await phone.page.client.command('add', { job_id: 'song-a' });
  await until(() => tv.page.client.state?.current?.job_id === 'song-a', 'the new room has a song to sing');
  tv.w.OpenKAccount.rememberInvite(people.ling.id, party, '111111', 1);
  tv.w.OpenKAccount.rememberInvite(people.hao.id, 'cccccccccc', '222222', 1);
  await tv.page.activate();
  check('Television audio is live before signing out', tv.page.armed && !tv.page.music.paused);
  phone.net.logoutStatus = tv.net.logoutStatus = 503;
  await phone.page.signOut();
  await tv.page.signOut();
  check('A failed phone logout restores its still-authenticated room',
    phone.page.client?.running && !phone.net.signedOut && !phone.page.signingOut);
  check('A failed television logout restores controls but requires a fresh audio gesture',
    tv.page.client?.running && !tv.net.signedOut && !tv.page.signingOut && !tv.page.armed);
  phone.net.logoutStatus = tv.net.logoutStatus = 0;
  await tv.page.activate();
  await tv.page.signOut();
  await until(() => tv.net.logouts === 1, 'the television signs out');
  check('Signing out stops local audio', tv.page.music.paused && tv.page.armed === false);
  check('Signing out ends at the account sign-in page',
    tv.net.navigations.includes('/auth/login/'));
  const remaining = JSON.parse(tv.w.localStorage.getItem('openk.account.invites.v1') || '{}');
  check('Signing out clears only this account cache',
    remaining[people.ling.id] === undefined && remaining[people.hao.id]['cccccccccc'].code === '222222');

  /* ---- 登录失效：明确要求重新登录，不退化成访客 ---- */
  phone.net.signedOut = true;
  await phone.page.client.refresh().catch(() => {});
  await until(() => !phone.$('#signInScreen').hidden, 'the phone offers signing in again');
  check('An expired session stops the room instead of falling back to a guest',
    phone.page.client === null && phone.$('#remoteConnection').textContent === '未登录');
  check('Sign-in is offered with the account service URL',
    phone.$('#signInLink').getAttribute('href') === '/auth/login/');
  check('A signed-out page keeps no other account visible',
    phone.$('#accountChip').dataset.accountId === undefined
    && phone.$('#roomMembers').children.length === 0);

  check('No unhandled window errors', errors.length === 0);
}

(async () => {
  try {
    await run();
    console.log(`\n${checks} account room assertions passed (real API; synthetic identity; simulated media).`);
  } catch (error) {
    console.error(error.stack || error);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    for (const w of windows) {
      // 先走页面自己的 pagehide 清理（停心跳、停轮询、停声音），再关窗，
      // 否则 jsdom 关掉之后还在跑的定时器会撞上已经没有的 document。
      try { w.dispatchEvent(new w.Event('pagehide')); } catch {}
      try { w.__t?.room?.client?.stop(); } catch {}
      w.openkStage?.destroy();
      w.openkRemote?.destroy();
      w.close();
    }
    if (server && server.exitCode === null) {
      const exit = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      await exit;
    }
    fs.rmSync(keyFile, { force: true });
    if (errors.length) {
      console.error('Unhandled errors:', errors);
      process.exitCode = 1;
    }
  }
})();
