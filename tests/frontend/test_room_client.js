/* Isolated transport/lifecycle contracts; no server, media or browser account is used. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../../frontend/room-client.js'), 'utf8');
const roomA = 'aaaaaaaaaa', roomB = 'bbbbbbbbbb';
const tokenA = 'synthetic-room-capability-a'.repeat(2);
const tokenB = 'synthetic-room-capability-b'.repeat(2);
const plain = value => JSON.parse(JSON.stringify(value));
const response = value => ({ ok: true, status: 200, json: async () => value });
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(fetch) {
  const values = new Map(), warnings = [];
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const context = {
    window: {}, document: { hidden: false },
    location: { href: 'http://localhost:8080/remote' },
    fetch, localStorage: storage, crypto: webcrypto, Uint8Array, AbortController,
    URL, URLSearchParams, setTimeout, clearTimeout,
    console: { warn: message => warnings.push(message) },
  };
  vm.runInNewContext(source, context);
  return { ...context.window.OpenKRoom, storage, values, warnings, window: context.window };
}

function state(id = roomA, revision = 1, observed = 1) {
  return {
    id, revision, observed_at: observed, name: 'Party',
    discoverable: true, allow_screens: true, expires_at: 10000,
    members: [{ id: 'member-a', name: 'Alice', role: 'controller', online: true }],
    viewer: { id: 'member-a', name: 'Alice', role: 'controller', online: true },
    player: { online: false, status: 'offline', position: 0, seen_at: null },
    current: null, queue: [], playback: { playing: false, guide: false, seek_version: 0 },
  };
}

async function main() {
  {
    const calls = [];
    const account = '00000000-0000-4000-8000-000000000041';
    const device = 'a'.repeat(32);
    const self = 'room-device-self';
    const env = fixture(async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/player/claim')) return response({ player_token: 'synthetic-player', state: state() });
      if (init.method === 'DELETE') return response({});
      return response({ ...state(), presence_id: self, devices: [{
        id: self, member_id: 'member-a', name: 'Living room', roles: ['player', 'controller'], online: true,
      }] });
    });
    env.window.OpenKAccount = { value: { user: { id: account } } };
    env.window.OpenKUserState = {
      value: { enabled: true, accountId: account, device: { label: 'Living room', roles: ['microphone'] } },
      deviceId: () => device, suggestedLabel: () => 'Browser',
    };
    const client = new env.RoomClient(roomA, null, {
      presence: () => env.devicePresence(['controller', 'player']),
    });
    await client.refresh();
    const first = JSON.parse(calls[0].init.body);
    assert.match(first.client_id, /^[0-9a-f]{32}$/);
    assert.equal(calls[0].url, `/api/rooms/${roomA}/presence`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['X-OpenK-Expected-Account'], account);
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(first.device_id, device);
    assert.equal(first.label, 'Living room');
    assert.deepEqual(first.roles, ['player', 'controller', 'microphone']);
    assert.equal(client.presenceId, self);
    await client.claim();
    assert.deepEqual(JSON.parse(calls[1].init.body), { client_id: first.client_id, device_id: device });
    await client.refresh();
    assert.equal(calls[2].url, `/api/rooms/${roomA}/presence?after=1`);
    assert.equal(JSON.parse(calls[2].init.body).client_id, first.client_id);
    client.stop();
    await turn();
    assert.equal(calls[3].url, `/api/rooms/${roomA}/presence/${first.client_id}`);
    assert.equal(calls[3].init.method, 'DELETE');
    assert.equal(calls[3].init.keepalive, true);
    assert.equal(calls[3].init.signal.aborted, false);
    assert.equal(calls[3].init.headers['X-OpenK-Expected-Account'], account);
    assert.equal(client.presenceId, null);
    await client.refresh();
    assert.notEqual(JSON.parse(calls[4].init.body).client_id, first.client_id,
      'a restarted connection cannot be removed by its previous unload request');
    client.stop();
    await turn();

    env.window.OpenKAccount.value.user.id = '00000000-0000-4000-8000-000000000042';
    assert.deepEqual(plain(env.devicePresence(['controller'])), {
      device_id: device, label: 'Browser', roles: ['controller'],
    }, 'a different account cannot inherit the previous account device name or roles');
    env.window.OpenKAccount.value = { enabled: false };
    assert.equal(env.devicePresence(['player']).device_id, null);
    assert.deepEqual(plain(env.deviceRoles), { player: '播放器', controller: '遥控器', microphone: '麦克风' });
  }

  {
    const env = fixture(async () => response(state()));
    const client = new env.RoomClient(roomA, tokenA);
    const original = { id: 'room-device', name: 'Original', roles: ['controller'], online: true };
    client.accept({ ...state(roomA, 1, 1), devices: [original], presence_id: original.id });
    client.accept({ ...state(roomA, 1, 3), unchanged: true, devices: [{ ...original, name: 'Renamed' }] });
    assert.equal(client.state.devices[0].name, 'Renamed', 'unchanged queue snapshots still update devices');
    client.accept({ ...state(roomA, 1, 2), devices: [original], presence_id: 'stale-device' });
    assert.equal(client.state.devices[0].name, 'Renamed');
    assert.equal(client.presenceId, original.id, 'stale replies cannot change this browser identity');
    client.accept({ ...state(roomA, 1, 4), unchanged: true, devices: [] });
    assert.deepEqual(plain(client.state.devices), [], 'expired connections disappear without a queue revision');
    client.stop();
  }

  {
    let finish;
    const calls = [];
    const env = fixture((url, init) => {
      calls.push({ url, init });
      if (init.method === 'DELETE') return Promise.resolve(response({}));
      return new Promise(resolve => { finish = resolve; });
    });
    const client = new env.RoomClient(roomA, tokenA, {
      presence: () => ({ device_id: null, label: 'Phone', roles: ['controller'] }),
    });
    const pending = client.refresh();
    client.stop();
    finish(response({ ...state(), presence_id: 'obsolete', devices: [] }));
    await assert.rejects(pending, error => error.status === 499);
    await turn();
    assert.equal(client.state, null);
    assert.equal(client.presenceId, null);
    assert.equal(calls[1].init.keepalive, true,
      'stopping an in-flight announcement still removes its connection without a player release');
    assert.ok(calls.every(call => !call.url.includes('/player/')));
  }

  {
    const env = fixture(async () => response(state()));
    const client = new env.RoomClient(roomA, tokenA);
    client.accept(state());
    client.accept({
      ...state(roomA, 1, 3), unchanged: true,
      members: [{ id: 'member-a', name: 'Alice', role: 'controller', online: false }],
    });
    assert.equal(client.state.members[0].online, false);
    assert.deepEqual(plain(client.state.queue), []);
    client.accept({ ...state(roomA, 1, 2), unchanged: true });
    assert.equal(client.state.members[0].online, false, 'old presence must not overwrite a newer snapshot');
    client.accept(state(roomA, 2, 4));
    client.accept(state(roomA, 1, 8));
    assert.equal(client.state.revision, 2);
    assert.throws(() => client.accept(state(roomB, 3)), error => error.status === 502);
    client.stop();
  }

  {
    const pending = [];
    const env = fixture(() => new Promise(resolve => pending.push(resolve)));
    const client = new env.RoomClient(roomA, tokenA);
    let updates = 0, connections = 0;
    client.onstate = () => updates++;
    client.onconnection = () => connections++;
    const result = client.refresh();
    await turn();
    client.stop();
    pending.shift()(response(state()));
    await assert.rejects(result, error => error.status === 499);
    assert.equal(updates, 0);
    assert.equal(connections, 0);
    assert.equal(client.state, null);
    assert.equal(client.pending, null);
  }

  {
    const pending = [], calls = [];
    const env = fixture((url, init) => {
      calls.push({ url, init });
      return new Promise(resolve => pending.push(resolve));
    });
    const client = new env.RoomClient(roomA, tokenA);
    const first = client.command('add', { job_id: 'sample' });
    const queued = client.command('sing', { item_id: 'sample-item' });
    const outcome = Promise.allSettled([first, queued]);
    await turn();
    client.stop();
    pending.shift()(response(state()));
    const results = await outcome;
    assert.equal(calls.length, 1, 'stopped clients must not dispatch queued commands');
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.status === 499));
    assert.ok(calls[0].url.startsWith('/api/rooms/' + roomA));
    assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + tokenA);
    assert.ok(!calls[0].url.includes(tokenA));
  }

  {
    let finish, call;
    const env = fixture((url, init) => {
      call = { url, init };
      return new Promise(resolve => { finish = resolve; });
    });
    const client = new env.RoomClient(roomA, tokenA);
    client.accountId = '00000000-0000-4000-8000-000000000041';
    const release = client.releaseOnUnload('synthetic-player-token');
    client.stop();
    assert.equal(call.url, '/api/rooms/' + roomA + '/player/release');
    assert.equal(call.init.keepalive, true);
    assert.equal(call.init.signal.aborted, false, 'stopping page requests must not abort the unload release');
    assert.equal(call.init.headers['X-Player-Token'], 'synthetic-player-token');
    assert.equal(call.init.headers['X-OpenK-Expected-Account'], client.accountId);
    assert.equal(call.init.headers.Authorization, 'Bearer ' + tokenA);
    finish(response(state()));
    await release;
  }

  {
    const pending = [];
    const env = fixture(() => new Promise(resolve => pending.push(resolve)));
    const client = new env.RoomClient(roomA, tokenA);
    const old = client.refresh();
    await turn();
    client.stop();
    const fresh = client.refresh();
    await turn();
    pending[0](response(state(roomA, 1)));
    await assert.rejects(old, error => error.status === 499);
    assert.notEqual(client.pending, null, 'an old finally must not clear the new request');
    pending[1](response(state(roomA, 2)));
    await fresh;
    assert.equal(client.state.revision, 2);
    assert.equal(client.pending, null);
    client.stop();
  }

  {
    const env = fixture(async () => response(state()));
    const sessions = env.roomSessions;
    assert.equal(sessions.remember({
      room_id: roomA, token: tokenA, role: 'host', name: 'First party', pairing_code: '123456',
    }), true);
    sessions.remember({ room_id: roomB, token: tokenB, role: 'controller', name: 'Second party' });
    sessions.remember({ room_id: roomA, token: tokenB, role: 'screen', name: 'First party' });
    assert.equal(sessions.all().length, 3);
    assert.equal(sessions.get(roomA, ['host']).token, tokenA);
    assert.equal(sessions.get(roomA, ['screen']).token, tokenB);
    assert.equal(sessions.get(roomB).name, 'Second party');
    sessions.forget(roomA, 'screen');
    assert.equal(sessions.get(roomA, ['screen']), null);
    assert.notEqual(sessions.get(roomA, ['host']), null);
    sessions.forget(roomA);
    assert.equal(sessions.get(roomA), null);
    assert.equal(sessions.get(roomB).token, tokenB);
    env.storage.setItem = () => { throw new Error('simulated storage quota'); };
    assert.equal(sessions.remember({ room_id: roomA, token: tokenA, role: 'host' }), false);
    assert.throws(() => sessions.remember({
      room_id: roomA, token: tokenA, role: 'administrator',
    }), error => error.status === 400);
    const phone = new URL(env.joinURL(roomA, '123456'));
    const tv = new URL(env.joinURL(roomA, '123456', 'screen'));
    assert.equal(phone.pathname, '/remote');
    assert.equal(tv.pathname, '/tv');
    assert.equal(phone.search, '');
    assert.equal(new URLSearchParams(tv.hash.slice(1)).get('code'), '123456');
    assert.ok(!phone.href.includes(tokenA) && !tv.href.includes(tokenA));
  }

  {
    const calls = [];
    const env = fixture(async (url, init) => {
      calls.push({ url, init });
      return response(url === '/api/rooms' && init.method === 'GET' ? { rooms: [] } : state());
    });
    const client = new env.RoomClient(roomA, tokenA);
    await env.RoomClient.list();
    await env.RoomClient.create({ name: 'Party', discoverable: true, allow_screens: true });
    await env.RoomClient.join(roomA, '123456', { display_name: 'TV', role: 'screen' });
    await client.settings({ name: 'Renamed' });
    await client.updateMember('Alice');
    await client.release('synthetic-player-lease');
    await client.leave();
    await client.close();
    assert.equal(calls[0].url, '/api/rooms');
    assert.equal(calls[3].init.method, 'PATCH');
    assert.equal(calls[4].url, '/api/rooms/' + roomA + '/member');
    assert.equal(calls[5].init.headers['X-Player-Token'], 'synthetic-player-lease');
    assert.equal(calls[6].url, '/api/rooms/' + roomA + '/leave');
    assert.equal(calls[7].init.method, 'DELETE');
    assert.deepEqual(JSON.parse(calls[2].init.body), {
      display_name: 'TV', role: 'screen', code: '123456',
    });
    client.stop();
  }
  {
    // Account deployments: one current room per person, no room bearer token.
    const calls = [];
    const env = fixture(async (url, init) => {
      calls.push({ url, init });
      if (url === '/api/rooms/current') {
        return response({ room_id: roomA, role: 'host', account_id: 'account-1',
          account_mode: true, pairing_code: '135790', state: state() });
      }
      if (url.endsWith('/invitation')) return response({ pairing_code: '246800', state: state(roomA, 4) });
      return response(state());
    });
    const current = await env.RoomClient.current();
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, undefined, 'current room is requested without a body');
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(current.account_mode, true);
    const client = new env.RoomClient(current.room_id, null);
    const invite = await client.invitation();
    assert.equal(calls[1].url, '/api/rooms/' + roomA + '/invitation');
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(calls[1].init.headers.Authorization, undefined, 'account identity never rides in a header here');
    assert.equal(calls[1].init.credentials, 'same-origin');
    assert.equal(invite.pairing_code, '246800');
    assert.equal(client.state.revision, 4, 'a rotated invitation also delivers fresh room state');
    client.stop();
  }

  {
    // Moving to another room invalidates the old one; the UI must follow the server.
    const moved = { ok: false, status: 409,
      json: async () => ({ detail: { code: 'room_changed', message: '你已经在另一个房间' } }) };
    let calls = 0;
    const env = fixture(async () => { calls++; return moved; });
    const client = new env.RoomClient(roomA, null);
    const signals = [];
    client.onconnection = (status, error) => signals.push([status, error?.code]);
    client.running = true;
    await assert.rejects(client.refresh(), error => error.status === 409 && error.code === 'room_changed'
      && error.message === '你已经在另一个房间');
    assert.deepEqual(signals, [['changed', 'room_changed']]);
    assert.equal(client.running, false, 'polling stops instead of hammering a room we left');

    const other = fixture(async () => { calls++; return moved; });
    const second = new other.RoomClient(roomA, null);
    const seen = [];
    second.onconnection = status => seen.push(status);
    calls = 0;
    await assert.rejects(second.command('add', { job_id: 'song' }),
      error => error.code === 'room_changed');
    assert.equal(calls, 1, 'a moved account must not retry the command against the old room');
    assert.deepEqual(seen, ['changed']);
    assert.equal(second.running, false);
  }

  {
    // A plain string detail keeps the legacy shape and carries no machine-readable code.
    const env = fixture(async () => ({ ok: false, status: 403, json: async () => ({ detail: '没有权限' }) }));
    const client = new env.RoomClient(roomA, tokenA);
    await assert.rejects(client.refresh(), error => error.status === 403 && error.code === ''
      && error.message === '没有权限');
    const broken = fixture(async () => ({ ok: false, status: 500, json: async () => ({ detail: { note: 1 } }) }));
    await assert.rejects(new broken.RoomClient(roomA, tokenA).refresh(),
      error => error.status === 500 && error.code === '' && error.message === '请求失败，请稍后重试');
  }

  console.log('Room transport, cancellation, metadata and per-room credentials passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
