/**
 * node tests/frontend/test_user_state.js
 * The shared account/device settings client plus the /devices and /history pages.
 * Every identity, device id and song here is synthetic; no server is contacted.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const frontend = path.resolve(__dirname, '../../frontend');
const ling = { id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', username: 'ling', display_name: '小玲', is_staff: false };
const hao = { id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', username: 'hao', display_name: '阿豪', is_staff: false };
const account = user => ({ enabled: true, user, profile_url: '/auth/', login_url: '/auth/login/', logout_url: '/auth/logout/' });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

const DEVICE_A = 'a'.repeat(32);
const DEVICE_B = 'b'.repeat(32);

/** A tiny in-memory stand-in for the account-scoped server state. */
function server(owner = ling.id) {
  return {
    owner,
    revision: 0,
    maxDevices: 24,
    defaults: {},
    preferred: null,
    devices: new Map(),
    history: [],
    // When set to { body, status } the statistics reply is served verbatim.
    stats: null,
    calls: [],
    failWrites: null,
    conflictOnce: false,
    snapshot(device) {
      const list = [...this.devices.values()].map(item => ({
        ...item, preferred_player: item.id === this.preferred, current: item.id === device,
      }));
      const own = list.find(item => item.id === device) || null;
      const base = {
        sing_mode: 'inst', reverb: 'ktv', view: 'list', accompaniment_volume: 100, guide_volume: 0,
        mic_monitor: true, mic_volume: 110, howl_guard: true,
        output_volume: 100, audio_input: '', audio_output: '',
      };
      return {
        enabled: true, account_id: this.owner, revision: this.revision,
        defaults: { ...base, ...this.defaults }, preferred_player: this.preferred,
        device: own, devices: list,
        settings: { ...base, ...this.defaults, ...(own?.overrides || {}) },
        limits: { max_devices: 24, history_page: 50 },
      };
    },
  };
}

function fixture(t, { page = null, user = ling, state = server(), storage = {}, media = true } = {}) {
  const markup = page ? fs.readFileSync(path.join(frontend, page + '.html'), 'utf8')
    : '<div id="chip" hidden></div>';
  const dom = new JSDOM(markup, { url: 'https://localhost:8443/' + (page || 'remote'), runScripts: 'outside-only' });
  const w = dom.window;
  const navigations = [];
  const confirms = [];
  w.AbortController = globalThis.AbortController;
  w.confirm = message => { confirms.push(message); return w.__confirm !== false; };
  for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
  if (media) {
    w.navigator.mediaDevices = {
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Studio mic' },
        { kind: 'audiooutput', deviceId: 'sink-1', label: 'Living room speakers' },
      ],
      addEventListener() {},
    };
    w.HTMLMediaElement.prototype.setSinkId = function () { return Promise.resolve(); };
  }
  w.fetch = async (resource, options = {}) => {
    const target = new URL(String(resource), w.location.href);
    assert.equal(target.origin, w.location.origin, 'account pages never call a third party');
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    const headers = options.headers || {};
    state.calls.push({ path: target.pathname + target.search, method: options.method || 'GET', headers, body });
    const device = headers['X-OpenK-Device'] || null;
    const reply = value => ({ ok: true, status: 200, json: async () => value });
    const error = (status, detail) => ({ ok: false, status, json: async () => ({ detail }) });
    if (target.pathname === '/api/account') return reply(account(user));
    if (!target.pathname.startsWith('/api/user')) return error(404, 'not part of this fixture');
    const expected = headers['X-OpenK-Expected-Account'];
    assert.ok(expected === undefined || expected === user.id, 'the account fence names the current account');
    if (user.id !== state.owner) return error(401, '请先登录 OpenK 后再管理设备');
    if (state.failWrites && options.method && options.method !== 'GET') {
      return error(state.failWrites, 'Synthetic settings failure');
    }
    if (target.pathname === '/api/user/state') {
      if (options.method === 'POST' && device && !state.devices.has(device)) {
        if (state.devices.size >= state.maxDevices) {
          return error(429, '账号的设备数量已达上限，请先在「设备设置」页面移除一台。');
        }
        state.devices.set(device, {
          id: device, label: body?.label || 'Device', roles: ['controller'], overrides: {},
          capabilities: body?.capabilities || {}, created_at: 1, last_seen_at: 2, revision: 1,
        });
      }
      return reply(state.snapshot(device));
    }
    if (target.pathname === '/api/user/defaults') {
      if (state.conflictOnce) {
        state.conflictOnce = false;
        return error(409, { code: 'revision_conflict', message: '你的设置已在另一台设备上更新' });
      }
      if (body.revision !== state.revision) {
        return error(409, { code: 'revision_conflict', message: '你的设置已在另一台设备上更新' });
      }
      state.defaults = { ...state.defaults, ...body.settings };
      state.revision++;
      return reply(state.snapshot(device));
    }
    if (target.pathname === '/api/user/topology') {
      if (body.revision !== state.revision) return error(409, { code: 'revision_conflict', message: 'stale' });
      state.preferred = body.preferred_player;
      state.revision++;
      return reply(state.snapshot(device));
    }
    if (target.pathname.startsWith('/api/user/devices/')) {
      const id = target.pathname.split('/').pop();
      const entry = state.devices.get(id);
      if (!entry) return error(404, '这台设备不属于当前账号');
      if (options.method === 'DELETE') {
        state.devices.delete(id);
        if (state.preferred === id) state.preferred = null;
        return reply(state.snapshot(device));
      }
      if (body.revision !== entry.revision) {
        return error(409, { code: 'revision_conflict',
          message: '这台设备的信息已在别处修改，请刷新页面后重试' });
      }
      if (body.label !== undefined && body.label !== null) entry.label = body.label;
      if (body.roles) entry.roles = body.roles;
      if (body.clear_overrides) entry.overrides = {};
      if (body.overrides) entry.overrides = { ...entry.overrides, ...body.overrides };
      entry.revision++;
      return reply(state.snapshot(device));
    }
    if (target.pathname === '/api/user/history') {
      if (options.method === 'DELETE') {
        const removed = state.history.length;
        state.history = [];
        return reply({ removed });
      }
      const limit = Number(target.searchParams.get('limit') || 50);
      const before = Number(target.searchParams.get('before') || 0);
      const rows = state.history.filter(item => !before || item.id < before).slice(0, limit + 1);
      return reply({
        entries: rows.slice(0, limit), total: state.history.length, limit,
        next_before: rows.length > limit ? rows[limit - 1].id : null,
      });
    }
    if (target.pathname === '/api/user/library-stats') {
      if (state.stats) {
        return state.stats.status ? error(state.stats.status, state.stats.body) : reply(state.stats.body);
      }
      const counted = new Map();
      for (const item of state.history) {
        const song = counted.get(item.job_id)
          || { job_id: item.job_id, play_count: 0, last_played_at: 0 };
        song.play_count += 1;
        song.last_played_at = Math.max(song.last_played_at, item.started_at || 0);
        counted.set(item.job_id, song);
      }
      const songs = [...counted.values()].sort((a, b) => b.play_count - a.play_count
        || b.last_played_at - a.last_played_at || (a.job_id < b.job_id ? -1 : 1));
      return reply({
        account_id: state.owner, songs, history_limit: 500,
        total_plays: songs.reduce((sum, song) => sum + song.play_count, 0),
      });
    }
    if (target.pathname.startsWith('/api/user/history/')) {
      const id = Number(target.pathname.split('/').pop());
      const before = state.history.length;
      state.history = state.history.filter(item => item.id !== id);
      return before === state.history.length ? error(404, 'That history entry is not in your history.')
        : reply({ removed: 1 });
    }
    return error(404, 'not part of this fixture');
  };
  const location = {
    get href() { return w.location.href; },
    get origin() { return w.location.origin; },
    get pathname() { return w.location.pathname; },
    get search() { return w.location.search; },
    get hash() { return w.location.hash; },
    assign: value => navigations.push(String(value)),
    replace: value => navigations.push(String(value)),
    reload: () => navigations.push('reload'),
    toString() { return w.location.href; },
  };
  w.__location = location;
  const run = file => w.eval('(function(location){'
    + fs.readFileSync(path.join(frontend, file), 'utf8') + '\n}).call(window, window.__location)');
  run('room-client.js');
  run('account.js');
  run('user-state.js');
  t.after(() => w.close());
  return {
    w, state, navigations, confirms,
    api: w.OpenKUserState, accounts: w.OpenKAccount,
    run,
    $: selector => w.document.querySelector(selector),
    all: selector => [...w.document.querySelectorAll(selector)],
  };
}

async function page(t, name, options = {}) {
  const view = fixture(t, { page: name, ...options });
  view.run(name + '.js');
  // jsdom fires DOMContentLoaded itself once parsing settles; only a document that
  // already finished needs the event replayed, otherwise the page boots twice.
  if (view.w.document.readyState === 'complete') {
    view.w.document.dispatchEvent(new view.w.Event('DOMContentLoaded'));
  }
  await settle(60);
  return view;
}

test('a device id names this browser installation and is not a credential', async (t) => {
  const f = fixture(t);
  const id = f.api.deviceId();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(f.api.deviceId(), id, 'the same browser keeps one id');
  assert.equal(f.w.localStorage.getItem('openk.device.v1'), id);
  assert.ok(f.api.persistent());
  assert.notEqual(id, fixture(t).api.deviceId(), 'another browser profile gets its own id');
  const label = f.api.suggestedLabel({ userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120 Safari/537' });
  assert.equal(label, 'Chrome（Mac）');
  assert.ok(label.length <= 40);
});

test('settings are read per account and never adopted from another person', async (t) => {
  const state = server();
  state.defaults = { reverb: 'hall' };
  const f = fixture(t, { state });
  await f.accounts.load();
  const value = await f.api.load();
  assert.equal(value.enabled, true);
  assert.equal(value.settings.reverb, 'hall');
  assert.equal(value.device.label, f.api.suggestedLabel(f.w.navigator));
  assert.equal(value.device.capabilities.output_select, true);
  const register = state.calls.find(call => call.method === 'POST' && call.path === '/api/user/state');
  assert.equal(register.headers['X-OpenK-Device'], f.api.deviceId());
  assert.equal(register.headers['X-OpenK-Expected-Account'], ling.id);

  // The same browser, a second person: the server owns a different account.
  const other = fixture(t, { user: hao, state });
  await other.accounts.load();
  await assert.rejects(() => other.api.load(), error => error.status === 401);
  assert.equal(other.api.enabled, false);
  assert.deepEqual(other.api.settings, other.api.safe, 'an unreadable profile falls back to safe defaults');
});

test('damaged or hostile server values are clamped before they reach the player', async (t) => {
  const state = server();
  state.defaults = { reverb: 'stadium', mic_volume: 9000, view: 'tiles' };
  state.devices.set(DEVICE_A, { id: DEVICE_A, label: 'x'.repeat(200), roles: ['player', 'laser'],
    overrides: { mic_volume: -5, audio_output: 'sink-1' }, capabilities: { playback: 'yes' },
    created_at: 1, last_seen_at: 2, revision: 1 });
  const f = fixture(t, { state });
  await f.accounts.load();
  const value = await f.api.load();
  assert.equal(value.settings.reverb, 'ktv');
  assert.equal(value.settings.mic_volume, 110);
  assert.equal(value.settings.view, 'list');
  assert.equal(value.settings.audio_output, '');
  const listed = value.devices.find(item => item.id === DEVICE_A);
  assert.equal(listed.label, '设备', 'an over-long name falls back instead of rendering');
  assert.deepEqual(listed.roles, ['player']);
  assert.equal(listed.capabilities.playback, false);
});

test('player edits go to the level that owns them and are debounced', async (t) => {
  const f = fixture(t, { state: server() });
  await f.accounts.load();
  await f.api.load();
  f.api.save({ reverb: 'hall', mic_volume: 60, output_volume: 45 });
  f.api.save({ sing_mode: 'orig' });
  await f.api.flush();
  const writes = f.state.calls.filter(call => ['PUT', 'PATCH'].includes(call.method));
  assert.equal(writes.length, 2, 'one account write and one device write, not one per control');
  const defaults = writes.find(call => call.path === '/api/user/defaults');
  assert.deepEqual(defaults.body.settings, { reverb: 'hall', sing_mode: 'orig' });
  const device = writes.find(call => call.method === 'PATCH');
  assert.deepEqual(device.body.overrides, { mic_volume: 60, output_volume: 45 },
    'hardware-sensitive values stay on this device');
  assert.equal(f.api.value.settings.mic_volume, 60);
  assert.equal(f.state.defaults.mic_volume, undefined);
});

test('a revision conflict refreshes and replays instead of overwriting', async (t) => {
  const state = server();
  const f = fixture(t, { state });
  await f.accounts.load();
  await f.api.load();
  // Another device saved first; this one still holds the old revision.
  state.defaults = { sing_mode: 'orig' };
  state.revision = 5;
  f.api.saveDefaults({ reverb: 'church' });
  await f.api.flush();
  assert.equal(f.state.defaults.sing_mode, 'orig', "the other device's edit survives");
  assert.equal(f.state.defaults.reverb, 'church', 'and this edit still lands');
  assert.equal(f.api.problems.length, 0);
  assert.equal(f.state.calls.filter(call => call.path === '/api/user/defaults').length, 2);
});

test('an unreachable settings service reports a visible failure, never a false save', async (t) => {
  const state = server();
  const f = fixture(t, { state });
  await f.accounts.load();
  await f.api.load();
  const seen = [];
  f.api.onchange(() => seen.push(f.api.problems.slice()));
  state.failWrites = 503;
  f.api.saveDefaults({ reverb: 'church' });
  await f.api.flush();
  assert.ok(f.api.problems.length, 'the failure is surfaced to the page');
  assert.equal(state.defaults.reverb, undefined);
  assert.ok(seen.some(problems => problems.length));
  state.failWrites = null;
  f.api.saveDefaults({ reverb: 'church' });
  await f.api.flush();
  assert.equal(f.api.problems.length, 0);
  assert.equal(state.defaults.reverb, 'church');
});

test('an account switch cancels settings work already in flight', async (t) => {
  const state = server();
  const f = fixture(t, { state });
  await f.accounts.load();
  await f.api.load();
  const pending = f.api.refresh();
  f.api.reset();
  await assert.rejects(() => pending, error => error.status === 499);
  assert.equal(f.api.value, null, 'no earlier account state is left behind');
  f.api.saveDefaults({ reverb: 'hall' });
  await f.api.flush();
  assert.equal(state.defaults.reverb, undefined, 'a stale edit cannot land on the new account');
});

test('personal play counts are read live for the signed-in account only', async (t) => {
  const state = server();
  state.history = [
    { id: 3, job_id: 'sea', started_at: 1700000300 },
    { id: 2, job_id: 'rice', started_at: 1700000200 },
    { id: 1, job_id: 'sea', started_at: 1700000100 },
  ];
  const f = fixture(t, { state });
  await f.accounts.load();
  await f.api.load();
  const stats = await f.api.libraryStats();
  assert.equal(stats.account_id, ling.id);
  // The rows cross into this test's realm, so compare plain copies of them.
  assert.deepEqual(stats.songs.map(song => ({ ...song })), [
    { job_id: 'sea', play_count: 2, last_played_at: 1700000300 },
    { job_id: 'rice', play_count: 1, last_played_at: 1700000200 },
  ]);
  assert.equal(stats.total_plays, 3);
  assert.equal(stats.history_limit, 500);
  assert.ok(!(stats.songs instanceof Map), 'the page decides how to index these rows');

  const reads = f.state.calls.filter(call => call.path === '/api/user/library-stats');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].method, 'GET');
  assert.equal(reads[0].body, null, 'reading what you sang changes nothing');
  assert.equal(reads[0].headers['X-OpenK-Expected-Account'], ling.id);
  assert.equal(reads[0].headers['X-OpenK-Device'], f.api.deviceId());

  // Live, never cached: a deleted history entry is reflected on the next read.
  state.history = state.history.filter(item => item.id !== 1);
  const again = await f.api.libraryStats();
  assert.deepEqual(again.songs.map(song => song.play_count), [1, 1]);
  assert.equal(f.state.calls.filter(call => call.path === '/api/user/library-stats').length, 2,
    'every read asks the server instead of reusing an earlier answer');

  const keys = [];
  for (let index = 0; index < f.w.localStorage.length; index++) keys.push(f.w.localStorage.key(index));
  assert.deepEqual(keys, ['openk.device.v1'], 'what this person sings is never written to the browser');
  assert.equal(f.api.value.songs, undefined, 'and it is not parked in the shared settings state');
});

test('a damaged, foreign or unavailable play-count reply is refused instead of ranked', async (t) => {
  const state = server();
  const f = fixture(t, { state });
  await f.accounts.load();
  await f.api.load();
  const good = { job_id: 'sea', play_count: 2, last_played_at: 1700000300 };
  const reply = extra => ({ account_id: ling.id, songs: [good], total_plays: 2, history_limit: 500, ...extra });
  for (const body of [
    null, 'sea', [good],
    reply({ songs: {} }),
    reply({ songs: null }),
    reply({ total_plays: -1 }),
    reply({ total_plays: 2.5 }),
    reply({ history_limit: 0 }),
    reply({ history_limit: 1, songs: [good, { ...good, job_id: 'rice' }], total_plays: 3 }),
    reply({ songs: [{ ...good, job_id: '' }] }),
    reply({ songs: [{ ...good, job_id: 42 }] }),
    reply({ songs: [{ ...good, play_count: 0 }] }),
    reply({ songs: [{ ...good, play_count: '9' }] }),
    reply({ songs: [{ ...good, play_count: 1.5 }] }),
    reply({ songs: [{ ...good, last_played_at: 'yesterday' }] }),
    reply({ songs: [{ ...good, last_played_at: Infinity }] }),
    reply({ songs: [{ ...good, last_played_at: NaN }] }),
    reply({ songs: [{ ...good, last_played_at: -1 }] }),
    reply({ songs: [good, null] }),
  ]) {
    state.stats = { body };
    await assert.rejects(() => f.api.libraryStats(),
      error => error.status === 502 && /常唱统计/.test(error.message), JSON.stringify(body));
  }

  // Another account's numbers are refused even when they are well formed.
  state.stats = { body: reply({ account_id: hao.id }) };
  await assert.rejects(() => f.api.libraryStats(),
    error => error.status === 409 && error.code === 'account_changed');

  // An unavailable store is surfaced, never softened into "you sang nothing".
  state.stats = { body: '暂时无法读取常唱统计，请稍后重试', status: 503 };
  await assert.rejects(() => f.api.libraryStats(),
    error => error.status === 503 && /常唱统计/.test(error.message));

  state.stats = null;
  assert.deepEqual((await f.api.libraryStats()).songs, [], 'a real empty history is still readable');
});

test('play counts already in flight are dropped when the account resets or changes', async (t) => {
  const state = server();
  state.history = [{ id: 1, job_id: 'sea', started_at: 1700000100 }];
  const f = fixture(t, { state });
  await f.accounts.load();
  await f.api.load();

  const afterReset = f.api.libraryStats();
  f.api.reset();
  await assert.rejects(() => afterReset, error => error.status === 499);

  const afterSwitch = f.api.libraryStats();
  f.w.OpenKAccount = { value: account(hao) };
  await assert.rejects(() => afterSwitch, error => error.status === 499);
  const reads = f.state.calls.filter(call => call.path === '/api/user/library-stats');
  assert.equal(reads.length, 2);
  assert.ok(reads.every(call => call.headers['X-OpenK-Expected-Account'] === ling.id),
    'each read is fenced to the account that asked for it, not to whoever is signed in later');
});

test('another person on the same browser never sees the previous account play counts', async (t) => {
  const person = { ...ling };
  const state = server(ling.id);
  state.history = [{ id: 1, job_id: 'sea', started_at: 1700000100 }];
  const f = fixture(t, { user: person, state });
  await f.accounts.load();
  await f.api.load();
  assert.equal((await f.api.libraryStats()).songs[0].job_id, 'sea');

  // The next person signs in on the same browser installation.
  f.api.reset();
  Object.assign(person, hao);
  f.w.OpenKAccount = { value: account(person) };
  await assert.rejects(() => f.api.libraryStats(), error => error.status === 401);
  assert.equal(f.api.value, null, 'nothing from the previous account is left behind to rank');
  const reads = f.state.calls.filter(call => call.path === '/api/user/library-stats');
  assert.equal(reads.length, 2, 'the second person is never answered from the first one\'s numbers');
  assert.equal(reads[1].headers['X-OpenK-Expected-Account'], hao.id);
});

test('this browser local preferences are imported only on request', async (t) => {
  const legacy = JSON.stringify({ micVol: 150, reverb: 'church', singMode: 'orig', view: 'grid',
    micMonitor: false, howlGuard: false, instVol: 80, vocalVol: 20, extra: 'ignored' });
  const state = server();
  const f = fixture(t, { state, storage: { 'openk.prefs': legacy } });
  await f.accounts.load();
  const value = await f.api.load();
  assert.equal(value.settings.mic_volume, 110, 'a new sign-in starts from safe server defaults');
  assert.equal(value.settings.reverb, 'ktv');
  assert.deepEqual({ ...f.api.legacyPreferences() }, {
    sing_mode: 'orig', reverb: 'church', view: 'grid', mic_monitor: false, howl_guard: false,
    mic_volume: 150, accompaniment_volume: 80, guide_volume: 20,
  });
  f.api.saveDefaults(f.api.legacyPreferences());
  await f.api.flush();
  assert.equal(state.defaults.mic_volume, 150, 'the explicit import lands');
});

test('the device page persists topology, names and overrides', async (t) => {
  const state = server();
  state.devices.set(DEVICE_B, { id: DEVICE_B, label: 'Living room TV', roles: ['player'],
    overrides: {}, capabilities: { playback: true }, created_at: 1, last_seen_at: 2, revision: 1 });
  const view = await page(t, 'devices', { state });
  const own = view.api.deviceId();
  assert.ok(state.devices.has(own), 'the page registers this browser for the account');
  assert.equal(view.all('.device-item').length, 2);
  assert.ok(view.$('#topology svg'), 'the topology is drawn from the account data');
  assert.equal(view.all('#topology .node').length, 2);
  assert.match(view.$('#topologyText').textContent, /Living room TV/);

  const select = view.$('#preferredPlayer');
  assert.equal(view.all('#preferredPlayer option').length, 3);
  select.value = DEVICE_B;
  select.dispatchEvent(new view.w.Event('change'));
  await settle(40);
  assert.equal(state.preferred, DEVICE_B, 'the preferred player is persisted, not only drawn');
  assert.equal(view.all('#topology .node-player').length, 1);
  assert.match(view.$('#topologyHint').textContent, /Living room TV/);

  view.$('#deviceLabel').value = '  厨房平板  ';
  view.$('#saveLabel').click();
  await settle(40);
  assert.equal(state.devices.get(own).label, '厨房平板');
  assert.equal(view.all('.device-item strong').some(node => node.textContent === '厨房平板'), true);

  const toggle = view.$('[data-override="mic_volume"]');
  toggle.checked = true;
  toggle.dispatchEvent(new view.w.Event('change', { bubbles: true }));
  await settle(40);
  const control = view.$('#o_mic_volume');
  assert.equal(control.disabled, false);
  control.value = '75';
  control.dispatchEvent(new view.w.Event('change', { bubbles: true }));
  await settle(40);
  assert.deepEqual(state.devices.get(own).overrides, { mic_volume: 75 });
  assert.equal(view.$('#o_mic_volume').value, '75');

  view.$('#clearOverrides').click();
  await settle(40);
  assert.deepEqual(state.devices.get(own).overrides, {});
});

test('the device page asks before removing a device and keeps history names', async (t) => {
  const state = server();
  state.devices.set(DEVICE_B, { id: DEVICE_B, label: 'Old phone', roles: ['controller'],
    overrides: {}, capabilities: {}, created_at: 1, last_seen_at: 2, revision: 1 });
  const view = await page(t, 'devices', { state });
  view.w.__confirm = false;
  view.all('.device-item')[0].querySelector('.danger').click();
  await settle(30);
  assert.equal(view.confirms.length, 1);
  assert.equal(state.devices.size, 2, 'a cancelled confirmation changes nothing');
  view.w.__confirm = true;
  const target = view.all('.device-item').find(item => item.textContent.includes('Old phone'));
  target.querySelector('.danger').click();
  await settle(40);
  assert.equal(state.devices.has(DEVICE_B), false);
  assert.equal(view.all('.device-item').length, 1);
});

test('device account defaults are saved from the defaults form', async (t) => {
  const view = await page(t, 'devices', { state: server() });
  const select = view.$('#d_reverb');
  select.value = 'church';
  select.dispatchEvent(new view.w.Event('change', { bubbles: true }));
  await settle(60);
  assert.equal(view.state.defaults.reverb, 'church');
  const slider = view.$('#d_accompaniment_volume');
  slider.value = '60';
  slider.dispatchEvent(new view.w.Event('input', { bubbles: true }));
  assert.equal(view.$('[data-out="accompaniment_volume"]').textContent, '60%');
  slider.dispatchEvent(new view.w.Event('change', { bubbles: true }));
  await settle(60);
  assert.equal(view.state.defaults.accompaniment_volume, 60);
  assert.match(view.$('#pageStatus').textContent, /已保存/);
});

test('the history page lists confirmed playback and escapes song text', async (t) => {
  const state = server();
  state.history = [
    { id: 3, job_id: 'j3', title: '<img src=x onerror=alert(1)>', artist: 'A & B', duration: 200,
      device_label: 'Living room TV', device_id: DEVICE_B, started_at: 1700000000,
      updated_at: 1700000100, position: 100, completed: false },
    { id: 2, job_id: 'j2', title: '第二首', artist: '', duration: 180, device_label: 'Kitchen tablet',
      device_id: DEVICE_A, started_at: 1699999000, updated_at: 1699999180, position: 180, completed: true },
  ];
  const view = await page(t, 'history', { state });
  const items = view.all('.history-item');
  assert.equal(items.length, 2);
  assert.equal(items[0].querySelector('h3').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(items[0].querySelector('h3').children.length, 0, 'song titles are text, never markup');
  assert.match(items[0].querySelector('.meta').textContent, /Living room TV/);
  assert.match(items[0].querySelector('.side').textContent, /已播放 1:40 \/ 3:20/);
  assert.match(items[1].querySelector('.side').textContent, /已唱完/);
  assert.match(items[0].querySelector('.progress span').style.width, /^50(\.0)?%$/);
  assert.match(view.$('#historyCount').textContent, /共 2 条记录/);
  assert.equal(view.$('#loadMore').hidden, true);
  const body = view.w.document.body.innerHTML;
  assert.ok(!body.includes('/media/') && !body.includes('job_id'), 'no file locations are exposed');
});

test('history deletion and clearing need an explicit confirmation', async (t) => {
  const state = server();
  state.history = [
    { id: 2, job_id: 'j2', title: 'Second', artist: 'B', duration: 100, device_label: 'TV',
      device_id: DEVICE_B, started_at: 1700000000, updated_at: 1700000100, position: 50, completed: false },
    { id: 1, job_id: 'j1', title: 'First', artist: 'A', duration: 100, device_label: 'TV',
      device_id: DEVICE_B, started_at: 1699999000, updated_at: 1699999100, position: 90, completed: true },
  ];
  const view = await page(t, 'history', { state });
  view.w.__confirm = false;
  view.$('#clearHistory').click();
  await settle(30);
  assert.equal(state.history.length, 2, 'history is never cleared without a confirmation');
  view.w.__confirm = true;
  view.all('.history-item')[0].querySelector('.danger').click();
  await settle(40);
  assert.equal(state.history.length, 1);
  assert.equal(view.all('.history-item').length, 1);
  view.$('#clearHistory').click();
  await settle(40);
  assert.equal(state.history.length, 0);
  assert.match(view.$('#historyList').textContent, /在你启用过的设备上唱一首/);
});

test('history paging asks for older entries only when there are more', async (t) => {
  const state = server();
  state.history = Array.from({ length: 30 }, (unused, index) => ({
    id: 30 - index, job_id: 'j', title: 'Song ' + (30 - index), artist: 'A', duration: 100,
    device_label: 'TV', device_id: DEVICE_B, started_at: 1700000000 - index,
    updated_at: 1700000000 - index, position: 50, completed: false,
  }));
  const view = await page(t, 'history', { state });
  assert.equal(view.all('.history-item').length, 25);
  assert.equal(view.$('#loadMore').hidden, false);
  view.$('#loadMore').click();
  await settle(60);
  assert.equal(view.all('.history-item').length, 30);
  assert.equal(view.$('#loadMore').hidden, true);
  const paged = view.state.calls.filter(call => call.path.startsWith('/api/user/history'));
  assert.ok(paged.some(call => call.path.includes('before=')), 'older pages are bounded by a cursor');
});

test('the device page recovers honestly when another device saved first', async (t) => {
  const state = server();
  const view = await page(t, 'devices', { state });
  const own = view.api.deviceId();
  // An account default written elsewhere: the page replays this change on top.
  state.conflictOnce = true;
  const reverb = view.$('#d_reverb');
  reverb.value = 'hall';
  reverb.dispatchEvent(new view.w.Event('change', { bubbles: true }));
  await settle(80);
  assert.equal(state.defaults.reverb, 'hall');
  assert.match(view.$('#pageStatus').textContent, /已保存/);

  // A device edit that lost the race is reported instead of silently overwriting.
  state.devices.get(own).revision = 9;
  state.devices.get(own).label = 'Renamed elsewhere';
  view.$('#deviceLabel').value = 'Kitchen';
  view.$('#saveLabel').click();
  await settle(80);
  assert.equal(state.devices.get(own).label, 'Renamed elsewhere');
  assert.match(view.$('#pageStatus').textContent, /已在别处修改/);
  assert.equal(view.$('#pageStatus').dataset.kind, 'error');
  assert.equal(view.$('#deviceLabel').value, 'Renamed elsewhere', 'the page shows the newer value');
});

test('a browser that cannot claim a device slot can still manage the list', async (t) => {
  const state = server();
  for (let index = 0; index < 24; index++) {
    const id = index.toString(16).padStart(32, '0');
    state.devices.set(id, { id, label: '备用设备 ' + (index + 1), roles: ['controller'],
      overrides: {}, capabilities: {}, created_at: index, last_seen_at: index, revision: 1 });
  }
  const view = await page(t, 'devices', { state });
  const own = view.api.deviceId();
  assert.equal(state.devices.size, 24);
  assert.equal(state.devices.has(own), false, 'the twenty-fifth browser claimed no slot');
  assert.equal(view.all('.device-item').length, 24, 'the account devices still render');
  assert.equal(view.all('#preferredPlayer option').length, 25);
  assert.match(view.$('#pageStatus').textContent, /还没有注册/);
  assert.equal(view.$('#pageStatus').dataset.kind, 'error');
  assert.match(view.$('#deviceSummary').textContent, /还没有注册/);
  for (const selector of ['#deviceLabel', '#saveLabel', '#clearOverrides',
    '[data-override="mic_volume"]', '#o_mic_volume', '[data-role="player"]']) {
    assert.equal(view.$(selector).disabled, true, selector + ' stays disabled while unregistered');
  }
  assert.deepEqual(state.calls.filter(call => call.path === '/api/user/state').map(call => call.method),
    ['POST', 'GET'], 'recovery reads the list instead of retrying registration');

  view.w.__confirm = true;
  const target = view.all('.device-item')
    .find(item => item.querySelector('strong').textContent === '备用设备 1');
  target.querySelector('.danger').click();
  await settle(80);
  assert.equal(state.devices.has(own), true, 'the freed slot is claimed only after a deliberate removal');
  assert.equal(view.all('.device-item').length, 24);
  assert.match(view.$('#pageStatus').textContent, /已经注册/);
  assert.equal(view.$('#deviceLabel').disabled, false);
  assert.equal(view.$('#deviceLabel').value, view.api.suggestedLabel(view.w.navigator));
});

// Two consecutive Latin words are a sentence; product names and units are not.
const ENGLISH_COPY = /[A-Za-z]{3,}[ \u00a0]+[A-Za-z]{3,}/;
const CHINESE_COPY = /[\u4e00-\u9fff]/;

/** Every string this page shows, excluding the account chip the parent owns. */
function visibleCopy(w) {
  const strings = [];
  const push = value => { if (typeof value === 'string' && value.trim()) strings.push(value.trim()); };
  push(w.document.title);
  const chip = w.document.querySelector('#accountChip');
  for (const node of w.document.querySelectorAll(
    'h1,h2,h3,p,label,button,option,legend,a,li,output,span')) {
    if (chip?.contains(node)) continue;
    const nested = [...node.children].some(child => child.textContent.trim());
    if (!nested) push(node.textContent);
    for (const name of ['aria-label', 'placeholder', 'title']) push(node.getAttribute(name));
  }
  for (const node of w.document.querySelectorAll('[aria-label],[placeholder]')) {
    if (chip?.contains(node)) continue;
    push(node.getAttribute('aria-label'));
    push(node.getAttribute('placeholder'));
  }
  return strings;
}

test('the device page speaks Simplified Chinese like the rest of OpenK', async (t) => {
  const state = server();
  state.devices.set(DEVICE_B, { id: DEVICE_B, label: '客厅电视', roles: ['player', 'microphone'],
    overrides: { mic_volume: 90 }, capabilities: { playback: true, microphone: true },
    created_at: 1, last_seen_at: Math.floor(Date.now() / 1000) - 3600, revision: 1 });
  state.preferred = DEVICE_B;
  const view = await page(t, 'devices', { state });
  assert.equal(view.w.document.documentElement.lang, 'zh-CN');
  assert.match(view.w.document.title, /设备设置/);
  const copy = visibleCopy(view.w);
  // Hardware names come from the operating system and are shown verbatim.
  const hardware = ['Studio mic', 'Living room speakers'];
  const untranslated = copy.filter(value => ENGLISH_COPY.test(value) && !hardware.includes(value));
  assert.deepEqual(untranslated, [], 'device page copy is Simplified Chinese');
  assert.deepEqual(hardware.filter(name => copy.includes(name)), hardware,
    'operating-system device names are never rewritten');
  assert.ok(copy.filter(value => CHINESE_COPY.test(value)).length > 25, 'the page is actually Chinese');
  // Dynamic states, roles, relative times and the topology description too.
  assert.match(view.$('#deviceSummary').textContent, /最近出现：.+ · 没有麦克风，可以选择扬声器/);
  assert.match(view.$('#topologyHint').textContent, /客厅电视/);
  assert.match(view.$('#topologyText').textContent, /你的设备：客厅电视（首选播放器）/);
  const other = view.all('.device-item').find(item => item.textContent.includes('客厅电视'));
  assert.match(other.querySelector('p.muted.small').textContent,
    /^播放器、麦克风 · 最近出现：1 小时前$/);
  assert.deepEqual([...other.querySelectorAll('.tag')].map(tag => tag.textContent), ['首选播放器']);
  assert.deepEqual([...view.all('#topology .node-role')].map(node => node.textContent),
    ['播放器 / 麦克风', '遥控器']);
  assert.equal(view.$('#topology .hub-label').textContent, '账号');
  assert.equal(view.$('#o_audio_input').options[0].textContent, '系统默认设备');
  // A name the person typed is never rewritten by the translation.
  assert.equal(other.querySelector('strong').textContent, '客厅电视');
});

test('device topology exposes every role and does not invent one for unassigned devices', async (t) => {
  const state = server();
  state.devices.set(DEVICE_B, { id: DEVICE_B, label: '客厅多角色设备', roles: ['player', 'controller', 'microphone'],
    overrides: {}, capabilities: {}, created_at: 1, last_seen_at: 1, revision: 1 });
  const view = await page(t, 'devices', { state });
  assert.match(view.$('#topologyText').textContent, /客厅多角色设备：播放器、遥控器、麦克风/);
  const roles = [...view.all('#topology .node-role')].map(node => node.textContent);
  assert.ok(roles.includes('播放器 / 遥控器') && roles.includes('麦克风'));
  await view.w.OpenKUserState.patchDevice(DEVICE_B, { roles: [] });
  assert.ok([...view.all('#topology .node-role')].some(node => node.textContent === '未设置角色'));
  assert.match(view.$('#topologyText').textContent, /客厅多角色设备：未设置角色/);
});

test('the history page speaks Simplified Chinese and formats zh-CN dates', async (t) => {
  const state = server();
  state.history = [
    { id: 5, job_id: 'j5', title: '月亮代表我的心', artist: '邓丽君', duration: 200,
      device_label: '客厅电视', device_id: DEVICE_B, started_at: 1700000000,
      updated_at: 1700000100, position: 100, completed: false },
  ];
  const view = await page(t, 'history', { state });
  assert.equal(view.w.document.documentElement.lang, 'zh-CN');
  assert.match(view.w.document.title, /播放历史/);
  const untranslated = visibleCopy(view.w).filter(value => ENGLISH_COPY.test(value));
  assert.deepEqual(untranslated, [], 'history page copy is Simplified Chinese');
  const item = view.$('.history-item');
  assert.equal(item.querySelector('h3').textContent, '月亮代表我的心');
  assert.match(item.querySelector('.meta').textContent, /邓丽君 · .+ · 客厅电视/);
  const stamped = item.querySelector('.meta').textContent.split(' · ')[1];
  assert.equal(stamped, new view.w.Date(1700000000 * 1000).toLocaleString('zh-CN'),
    'times are formatted for zh-CN, not for the browser locale');
  assert.match(item.querySelector('.side').textContent, /已播放 1:40 \/ 3:20/);
  assert.equal(item.querySelector('.side .danger').textContent, '删除');
  assert.equal(item.querySelector('.progress').getAttribute('aria-label'), '已播放 50%');
  assert.match(view.$('#historyCount').textContent, /共 1 条记录/);
});

test('the settings pages refuse to work without an account', async (t) => {
  const dom = new JSDOM(fs.readFileSync(path.join(frontend, 'devices.html'), 'utf8'),
    { url: 'https://localhost:8443/devices', runScripts: 'outside-only' });
  const w = dom.window;
  t.after(() => w.close());
  w.AbortController = globalThis.AbortController;
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ enabled: false }) });
  const run = file => w.eval('(function(location){'
    + fs.readFileSync(path.join(frontend, file), 'utf8') + '\n}).call(window, window.__location)');
  w.__location = { assign() {}, replace() {}, get href() { return w.location.href; } };
  run('room-client.js');
  run('account.js');
  run('user-state.js');
  run('devices.js');
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await settle(40);
  assert.match(w.document.querySelector('#pageStatus').textContent, /没有启用账号/);
  assert.equal(w.document.querySelector('#deviceList').children.length, 0);
});
