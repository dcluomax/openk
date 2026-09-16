/* Account helper contracts: identity parsing, per-account invite cache, user chip and sign-out.
   No server and no real credentials are involved; every identity here is synthetic. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const frontend = path.resolve(__dirname, '../../frontend');
const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const other = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const roomA = 'aaaaaaaaaa', roomB = 'bbbbbbbbbb';
const account = {
  enabled: true, user: { id: uuid, username: 'ling', display_name: '小玲', is_staff: false },
  profile_url: '/auth/', login_url: '/auth/login/', logout_url: '/auth/logout/',
};
const currentRoom = (room = roomA, extra = {}) => ({
  room_id: room, role: 'host', account_id: uuid, account_mode: true,
  state: { id: room, revision: 1, observed_at: 1, solo: true, account_mode: true,
    invite_version: 1, viewer: { id: 'member-a', name: '小玲', role: 'host' }, members: [], queue: [] },
  ...extra,
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, routes = {}) {
  const dom = new JSDOM('<div id="chip" hidden></div>',
    { url: 'https://localhost:8443/remote', runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  w.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const route = routes[String(url)];
    const value = typeof route === 'function' ? await route(options) : route;
    if (value === undefined) return { ok: false, status: 404, json: async () => ({ detail: '没有这个接口' }) };
    if (value instanceof Error) throw value;
    return { ok: value.status ? value.status < 400 : true, status: value.status || 200,
      json: async () => value.body ?? value };
  };
  w.eval(fs.readFileSync(path.join(frontend, 'room-client.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(frontend, 'account.js'), 'utf8'));
  t.after(() => w.close());
  return { w, calls, api: w.OpenKAccount, $: selector => w.document.querySelector(selector) };
}

test('identity payloads are validated instead of trusted', async (t) => {
  const trusted = fixture(t, { '/api/account': { enabled: false } });
  const standalone = await trusted.api.load();
  assert.equal(standalone.enabled, false);
  assert.equal(standalone.user, null);
  assert.equal(trusted.calls.length, 1);
  await trusted.api.load();
  assert.equal(trusted.calls.length, 1, 'the account probe is cached for the page');
  await trusted.api.reload();
  assert.equal(trusted.calls.length, 2);

  const signedIn = fixture(t, { '/api/account': account });
  const value = await signedIn.api.load();
  assert.equal(value.user.display_name, '小玲');
  assert.equal(value.user.is_staff, false);
  assert.equal(value.profileUrl, '/auth/');

  const hostile = fixture(t, { '/api/account': {
    ...account, profile_url: 'https://evil.example/steal', login_url: '//evil.example', logout_url: 'javascript:1' } });
  const safe = await hostile.api.load();
  assert.equal(safe.profileUrl, '/auth/', 'account links stay on this origin');
  assert.equal(safe.loginUrl, '/auth/login/');
  assert.equal(safe.logoutUrl, '/auth/logout/');
  for (const url of ['/\\evil.example/path', '//', '/\tevil.example', '/auth/\nlogout/']) {
    const malformed = fixture(t, { '/api/account': {
      ...account, profile_url: url, login_url: url, logout_url: url } });
    const guarded = await malformed.api.load();
    assert.equal(guarded.profileUrl, '/auth/');
    assert.equal(guarded.loginUrl, '/auth/login/');
    assert.equal(guarded.logoutUrl, '/auth/logout/');
  }

  for (const broken of [{}, { enabled: 'yes' }, { enabled: true },
    { enabled: true, user: { id: 'not-a-uuid', username: 'a', display_name: 'a' } },
    { enabled: true, user: { id: uuid, username: '', display_name: 'a' } },
    { enabled: true, user: { id: uuid, username: 'a', display_name: '' } },
    { ...account, user: { ...account.user, is_staff: 'true' } },
    { ...account, user: { ...account.user, id: uuid.toUpperCase() } }]) {
    const bad = fixture(t, { '/api/account': broken });
    await assert.rejects(bad.api.load(), error => error.status === 502);
  }

  const denied = fixture(t, { '/api/account': { status: 401, body: { detail: '请先登录' } } });
  await assert.rejects(denied.api.load(), error => error.status === 401 && error.message === '请先登录');
});

test('reload and reset fence late identity results and failed refreshes', async (t) => {
  const first = deferred(), second = deferred();
  let requests = 0;
  const f = fixture(t, { '/api/account': () => (++requests === 1 ? first.promise : second.promise) });
  const stale = assert.rejects(f.api.load(), error => error.status === 499);
  const fresh = f.api.reload();
  second.resolve({ ...account, user: { ...account.user, id: other, display_name: '阿豪' } });
  assert.equal((await fresh).user.id, other);
  first.resolve(account);
  await stale;
  assert.equal(f.api.value.user.id, other, 'the older reply never restores the previous person');

  const late = deferred();
  const reset = fixture(t, { '/api/account': () => late.promise });
  const abandoned = assert.rejects(reset.api.load(), error => error.status === 499);
  reset.api.reset();
  late.resolve(account);
  await abandoned;
  assert.equal(reset.api.value, null, 'reset stays empty after an in-flight reply arrives');

  let reply = account;
  const failed = fixture(t, { '/api/account': () => reply });
  await failed.api.load();
  reply = { status: 503, body: { detail: 'Account service unavailable' } };
  await assert.rejects(failed.api.reload(), error => error.status === 503);
  await assert.rejects(failed.api.load(), error => error.status === 503);
  assert.equal(failed.calls.length, 3, 'a failed reload invalidates the old identity cache');
});

test('room connections pin the expected account without treating it as a credential', async (t) => {
  let reply = account;
  const f = fixture(t, {
    '/api/account': () => reply,
    ['/api/rooms/' + roomA]: { revision: 1, id: roomA },
  });
  await f.api.load();
  const old = new f.w.OpenKRoom.RoomClient(roomA, null);
  reply = { ...account, user: { ...account.user, id: other } };
  await f.api.reload();
  await old.refresh();
  const call = f.calls.find(entry => entry.url === '/api/rooms/' + roomA);
  assert.equal(call.options.headers['X-OpenK-Expected-Account'], uuid);
  assert.equal(call.options.headers.Authorization, undefined);
  assert.ok(f.calls.filter(entry => entry.url === '/api/account')
    .every(entry => entry.options.headers['X-OpenK-Expected-Account'] === undefined));
  old.stop();
});

test('avatar initials survive Chinese, latin and empty names', (t) => {
  const { api } = fixture(t);
  assert.equal(api.initials('小玲'), '小玲');
  assert.equal(api.initials('王小玲'), '小玲');
  assert.equal(api.initials('Ada Lovelace'), 'AL');
  assert.equal(api.initials('ada'), 'AD');
  assert.equal(api.initials('   '), '·');
  assert.equal(api.initials('🎵🎤'), '🎵🎤');
});

test('invite codes are cached per account with the room invite version', async (t) => {
  const f = fixture(t, { '/api/account': account });
  const { api, w } = f;
  assert.equal(api.rememberInvite(uuid, roomA, '123456', 2), true);
  assert.equal(api.rememberInvite(other, roomA, '654321', 1), true);
  assert.deepEqual({ ...api.inviteCode(uuid, roomA) }, { code: '123456', version: 2 });
  assert.deepEqual({ ...api.inviteCode(other, roomA) }, { code: '654321', version: 1 });
  assert.equal(api.inviteCode(uuid, roomB), null);
  assert.throws(() => api.rememberInvite(uuid, roomA, '12345', 1), error => error.status === 400);
  assert.throws(() => api.rememberInvite(uuid, 'not-a-room', '123456', 1), error => error.status === 400);
  assert.throws(() => api.rememberInvite(uuid, roomA, '123456'), error => error.status === 400);

  // A code is only shown while it matches the version the room reports.
  assert.equal(api.currentInvite(uuid, roomA, 2), '123456');
  assert.equal(api.currentInvite(uuid, roomA, 3), null, 'another device rotated the code');
  assert.equal(api.currentInvite(uuid, roomA, undefined), null);
  assert.equal(api.currentInvite(uuid, roomB, 1), null);
  w.localStorage.setItem('openk.account.invites.v1', JSON.stringify({ [uuid]: { [roomB]: '999999' } }));
  assert.equal(api.currentInvite(uuid, roomB, 1), null, 'a code cached without a version is stale');

  api.rememberInvite(other, roomA, '654321', 1);
  api.rememberInvite(uuid, roomA, '123456', 2);
  api.forgetInvite(uuid, roomA);
  assert.equal(api.inviteCode(uuid, roomA), null);
  assert.equal(api.currentInvite(other, roomA, 1), '654321', 'another account keeps its own code');
  api.rememberInvite(uuid, roomB, '222222', 1);
  api.clear(uuid);
  assert.equal(api.inviteCode(uuid, roomB), null);
  assert.equal(api.currentInvite(other, roomA, 1), '654321');
  assert.ok(w.localStorage.getItem('openk.account.invites.v1').includes(other));
});

test('current-room results are validated and remembered', async (t) => {
  const f = fixture(t, {
    '/api/account': account,
    '/api/rooms/current': () => currentRoom(roomA, { pairing_code: '445566' }),
  });
  await f.api.load();
  const value = await f.api.currentRoom();
  assert.equal(value.room_id, roomA);
  assert.equal(f.api.currentInvite(uuid, roomA, value.state.invite_version),
    '445566', 'a host keeps the code the server just issued');
  for (const broken of [null, {}, currentRoom(roomA, { role: 'screen' }),
    currentRoom(roomA, { account_mode: false }), { ...currentRoom(), room_id: 'zz' },
    currentRoom(roomA, { account_id: undefined }),
    currentRoom(roomA, { state: { ...currentRoom().state, id: roomB } }),
    currentRoom(roomA, { state: { ...currentRoom().state, invite_version: undefined }, pairing_code: '123456' }),
    { ...currentRoom(), state: { revision: null } }]) {
    assert.throws(() => f.api.adopt(broken), error => error.status === 502);
  }
  assert.throws(() => f.api.adopt(currentRoom(roomA, { account_id: other })),
    error => error.status === 409 && error.code === 'account_changed');
  f.api.reset();
  assert.throws(() => f.api.adopt(currentRoom()), error => error.code === 'account_changed',
    'a valid room is not adopted without a current verified identity');
});

test('logout clears the actual browser account and invalidates older profile loads', async (t) => {
  const late = deferred();
  let requests = 0;
  const f = fixture(t, {
    '/api/account': () => ++requests === 1 ? late.promise : account,
    '/auth/api/me/': { ...account.user, id: other, csrf_token: 'synthetic-csrf-token' },
    '/auth/logout/': { ok: true },
  });
  const stale = assert.rejects(f.api.load(), error => error.status === 499);
  await f.api.reload();
  f.api.rememberInvite(uuid, roomA, '123456', 1);
  f.api.rememberInvite(other, roomB, '654321', 1);
  await f.api.logout();
  late.resolve(account);
  await stale;
  assert.equal(f.api.value, null);
  assert.equal(f.api.currentInvite(uuid, roomA, 1), '123456');
  assert.equal(f.api.inviteCode(other, roomB), null);
});

test('the user chip shows who is signed in and offers profile or sign-in', async (t) => {
  const f = fixture(t, { '/api/account': account });
  await f.api.load();
  let logouts = 0;
  const chip = f.api.mount(f.$('#chip'), { onLogout: () => logouts++ });
  assert.equal(f.$('#chip').hidden, false);
  chip.update(account.user);
  assert.equal(f.$('.account-avatar').textContent, '小玲');
  assert.equal(f.$('.account-name').textContent, '小玲');
  assert.equal(f.$('.account-name').title, 'ling');
  assert.equal(f.$('#chip').dataset.accountId, uuid);
  assert.equal(f.$('.account-profile').getAttribute('href'), '/auth/');
  assert.equal(f.$('.account-profile').hidden, false);
  assert.equal(f.$('.account-devices').hidden, false, 'signed-in menus link to the device page');
  assert.equal(f.$('.account-devices').textContent, '设备设置');
  assert.equal(f.$('.account-history').hidden, false);
  assert.equal(f.$('.account-history').textContent, '播放历史');
  assert.equal(f.$('.account-signin').hidden, true);
  f.$('.account-logout').click();
  assert.equal(logouts, 1);
  chip.busy(true);
  assert.equal(f.$('.account-logout').disabled, true);

  chip.update(null);
  assert.equal(f.$('.account-name').textContent, '未登录');
  assert.equal(f.$('#chip').dataset.accountId, undefined, 'a signed-out chip keeps no identity');
  assert.equal(f.$('.account-signin').getAttribute('href'), '/auth/login/');
  assert.equal(f.$('.account-logout').hidden, true);
  assert.equal(f.$('.account-devices').hidden, true, 'a signed-out menu offers no account pages');
  assert.equal(f.$('.account-history').hidden, true);
  chip.hide();
  assert.equal(f.$('#chip').hidden, true);
});

test('the account menu supports keyboard navigation and dismissal without stealing page shortcuts', (t) => {
  const f = fixture(t);
  const chip = f.api.mount(f.$('#chip')).update(account.user);
  const { menu, summary, profile, devices, history, logout, signIn } = chip.nodes;
  const key = value => f.w.document.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown',
    { key: value, bubbles: true, cancelable: true }));
  assert.equal(menu.open, false);
  assert.equal(summary.getAttribute('aria-label'), '账号：小玲');
  summary.click();
  summary.focus();
  assert.equal(menu.open, true);
  assert.equal(key('ArrowUp'), false);
  assert.equal(f.w.document.activeElement, logout, 'up from the summary selects the last action');
  key('ArrowDown');
  assert.equal(f.w.document.activeElement, profile, 'navigation skips the hidden sign-in link');
  key('ArrowDown');
  assert.equal(f.w.document.activeElement, devices, 'the menu reaches the device page');
  assert.equal(devices.getAttribute('href'), '/devices');
  key('ArrowDown');
  assert.equal(f.w.document.activeElement, history, 'and the playback history page');
  assert.equal(history.getAttribute('href'), '/history');
  chip.busy(true);
  key('ArrowDown');
  assert.equal(f.w.document.activeElement, profile, 'disabled logout cannot receive navigation focus');
  assert.equal(key('Escape'), false);
  assert.equal(menu.open, false);
  assert.equal(f.w.document.activeElement, summary);

  const outside = f.w.document.createElement('button');
  f.w.document.body.append(outside);
  summary.click();
  outside.focus();
  assert.equal(menu.open, false, 'tabbing out dismisses the menu');
  summary.click();
  summary.dispatchEvent(new f.w.Event('pointerdown', { bubbles: true }));
  assert.equal(menu.open, true, 'pointer events inside do not dismiss it');
  outside.dispatchEvent(new f.w.Event('pointerdown', { bubbles: true }));
  assert.equal(menu.open, false);

  chip.update(null);
  summary.click();
  summary.focus();
  key('ArrowDown');
  assert.equal(f.w.document.activeElement, signIn, 'signed-out menus only offer sign-in');
  chip.hide();
  assert.equal(menu.open, false);
});

test('remounting the account menu removes its old document listener', (t) => {
  const f = fixture(t);
  const previous = f.api.mount(f.$('#chip'));
  const next = f.api.mount(f.$('#chip'));
  previous.nodes.menu.open = true;
  next.nodes.menu.open = true;
  f.w.document.body.dispatchEvent(new f.w.Event('pointerdown', { bubbles: true }));
  assert.equal(next.nodes.menu.open, false);
  assert.equal(previous.nodes.menu.open, true, 'the detached menu no longer observes document events');
  assert.equal(f.$('#chip').querySelectorAll('.account-menu').length, 1);
});

test('sign-out posts a CSRF-protected logout and clears only this account', async (t) => {
  const f = fixture(t, {
    '/api/account': account,
    '/auth/api/me/': { ...account.user, csrf_token: 'synthetic-csrf-token', profile_url: '/auth/' },
    '/auth/logout/': { ok: true },
  });
  await f.api.load();
  f.api.rememberInvite(uuid, roomA, '123456', 1);
  f.api.rememberInvite(other, roomB, '654321', 1);
  assert.equal(await f.api.logout(), '/auth/login/');
  const post = f.calls.find(call => call.url === '/auth/logout/');
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.headers['X-CSRFToken'], 'synthetic-csrf-token');
  assert.equal(post.options.credentials, 'same-origin');
  assert.equal(post.options.referrerPolicy, 'same-origin');
  assert.equal(f.api.inviteCode(uuid, roomA), null);
  assert.equal(f.api.currentInvite(other, roomB, 1), '654321', 'another account on this device is untouched');
  assert.equal(f.api.value, null, 'the cached identity is dropped after sign-out');

  const expired = fixture(t, {
    '/api/account': account,
    '/auth/api/me/': { status: 401, body: { detail: '未登录' } },
  });
  await expired.api.load();
  assert.equal(await expired.api.logout(), '/auth/login/');
  assert.equal(expired.calls.some(call => call.url === '/auth/logout/'), false,
    'an already expired session does not need a logout POST');

  const mute = fixture(t, { '/api/account': account, '/auth/api/me/': { ...account.user } });
  await mute.api.load();
  await assert.rejects(mute.api.logout(), error => error.status === 502,
    'no CSRF token means we must not pretend the session ended');

  const broken = fixture(t, {
    '/api/account': account,
    '/auth/api/me/': { ...account.user, csrf_token: 'synthetic-csrf-token' },
    '/auth/logout/': { status: 500, body: {} },
  });
  await broken.api.load();
  broken.api.rememberInvite(uuid, roomA, '123456', 1);
  await assert.rejects(broken.api.logout(), error => error.status === 500);
  assert.equal(broken.api.currentInvite(uuid, roomA, 1), '123456', 'a failed logout keeps the session usable');

  const standalone = fixture(t, { '/api/account': { enabled: false } });
  await standalone.api.load();
  await assert.rejects(standalone.api.logout(), error => error.status === 400);
});
