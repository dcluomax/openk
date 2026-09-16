/* Shared, dependency-free room transport. Capabilities never enter URLs. */
(() => {
  'use strict';
  const deviceRoles = { player: '播放器', controller: '遥控器', microphone: '麦克风' };
  const roleList = roles => Object.keys(deviceRoles).filter(role => roles.includes(role));
  const id = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  class RoomError extends Error {
    constructor(message, status = 0, code = '') { super(message); this.status = status; this.code = code; }
  }
  const contextChanged = error => ['room_changed', 'account_changed'].includes(error?.code);
  // The account room API reports machine-readable causes as an object detail.
  function failure(value, status) {
    const detail = value?.detail;
    if (detail && typeof detail === 'object' && typeof detail.code === 'string') {
      return new RoomError(typeof detail.message === 'string' && detail.message
        ? detail.message : '房间已切换，正在返回你的房间', status, detail.code);
    }
    return new RoomError(typeof detail === 'string' ? detail : '请求失败，请稍后重试', status);
  }
  async function request(path, { token, playerToken, body, method = 'GET', signal, accountId, device, keepalive = false } = {}) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8000);
    const cancel = () => abort.abort();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    try {
      const headers = { Accept: 'application/json' };
      const expected = accountId === undefined ? window.OpenKAccount?.value?.user?.id : accountId;
      // Account-scoped APIs carry the same concurrent-account fence as rooms.
      if ((path.startsWith('/api/rooms') || path.startsWith('/api/user')) && expected) {
        headers['X-OpenK-Expected-Account'] = expected;
      }
      // Names this browser installation for per-device settings. Not a credential.
      if (device) headers['X-OpenK-Device'] = device;
      if (token) headers.Authorization = 'Bearer ' + token;
      if (playerToken) headers['X-Player-Token'] = playerToken;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(path, {
        method, headers, cache: 'no-store', credentials: 'same-origin',
        referrerPolicy: 'no-referrer', signal: abort.signal,
        ...(keepalive ? { keepalive: true } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let value = {};
      try { value = await response.json(); } catch { /* HTTP status still matters. */ }
      if (!response.ok) throw failure(value, response.status);
      return value;
    } catch (error) {
      if (error instanceof RoomError) throw error;
      if (signal?.aborted) throw new RoomError('房间连接已关闭', 499);
      throw new RoomError(error.name === 'AbortError' ? '连接超时，正在重连' : '无法连接房间，请检查 Wi-Fi');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  }
  class RoomClient {
    constructor(roomId, token, options = {}) {
      this.id = roomId;
      this.token = token;
      this.accountId = window.OpenKAccount?.value?.user?.id || null;
      this.state = null;
      this.onstate = () => {};
      this.onconnection = () => {};
      this.running = false;
      this.pending = null;
      this.serial = Promise.resolve();
      this.failures = 0;
      this.timer = null;
      this.epoch = 0;
      this.requests = new Set();
      this.presence = options.presence || null;
      this.presenceClient = null;
      this.presenceId = null;
      this.presenceActive = false;
    }
    static list() { return request('/api/rooms'); }
    static create(options) { return request('/api/rooms', { method: 'POST', body: options }); }
    // Account deployments keep exactly one current room per person on the server.
    static current() { return request('/api/rooms/current', { method: 'POST' }); }
    static join(roomId, code, options = {}) {
      return request('/api/rooms/' + encodeURIComponent(roomId) + '/join',
        { method: 'POST', body: { ...options, code } });
    }
    url(suffix = '') { return '/api/rooms/' + encodeURIComponent(this.id) + suffix; }
    current(epoch) {
      if (epoch !== this.epoch) throw new RoomError('房间连接已关闭', 499);
    }
    async call(suffix = '', options = {}) {
      const epoch = this.epoch;
      const abort = new AbortController();
      this.requests.add(abort);
      try {
        const value = await request(this.url(suffix), {
          ...options, token: this.token, signal: abort.signal, accountId: this.accountId,
        });
        this.current(epoch);
        return value;
      } finally { this.requests.delete(abort); }
    }
    accept(value) {
      if (!value || typeof value.revision !== 'number') return;
      if (value.id !== undefined && value.id !== this.id) throw new RoomError('收到其他房间的状态', 502);
      if (this.state && value.revision < this.state.revision) return;
      if (this.state && value.revision === this.state.revision
          && (value.player?.seen_at || 0) < (this.state.player?.seen_at || 0)) {
        value = { ...value, player: this.state.player };
      }
      if (this.state && value.revision === this.state.revision
          && value.observed_at < this.state.observed_at) {
        value = { ...value, members: this.state.members, viewer: this.state.viewer,
          devices: this.state.devices, presence_id: this.presenceId,
          observed_at: this.state.observed_at };
      }
      if (typeof value.presence_id === 'string') this.presenceId = value.presence_id;
      if (value.unchanged) {
        if (!this.state || value.revision !== this.state.revision) return;
        const metadata = { player: value.player, expires_at: value.expires_at };
        for (const key of ['name', 'discoverable', 'allow_screens', 'members', 'viewer', 'observed_at',
          'account_mode', 'solo', 'invite_version', 'devices']) {
          if (Object.prototype.hasOwnProperty.call(value, key)) metadata[key] = value[key];
        }
        this.state = { ...this.state, ...metadata };
      } else this.state = value;
      this.onstate(this.state);
    }
    async refresh() {
      if (this.pending) return this.pending;
      const epoch = this.epoch;
      const pending = (async () => {
        try {
          const after = this.state ? '?after=' + this.state.revision : '';
          let value;
          if (this.presence) {
            const body = this.presenceBody();
            this.presenceActive = true;
            value = await this.call('/presence' + after, { method: 'POST', body });
          } else value = await this.call(after);
          this.current(epoch);
          this.accept(value);
          this.failures = 0;
          this.onconnection('connected');
          return this.state;
        } catch (error) {
          if (epoch !== this.epoch || error.status === 499) throw error;
          this.failures++;
          const changed = contextChanged(error);
          this.onconnection(changed ? 'changed'
            : error.status === 403 || error.status === 404 ? 'expired' : 'reconnecting', error);
          if (changed || [401, 403, 404].includes(error.status)) this.stop();
          throw error;
        } finally {
          if (this.pending === pending) this.pending = null;
        }
      })();
      this.pending = pending;
      return pending;
    }
    start() {
      if (this.running) return;
      this.running = true;
      const epoch = this.epoch;
      const poll = async () => {
        try { await this.refresh(); } catch { /* Connection UI is updated by refresh. */ }
        if (this.running && epoch === this.epoch) this.timer = setTimeout(poll, this.failures
          ? Math.min(15000, 1500 * 2 ** this.failures)
          : document.hidden ? 4000 : 1500);
      };
      poll();
    }
    stop() {
      this.running = false;
      this.epoch++;
      clearTimeout(this.timer);
      for (const abort of this.requests) abort.abort();
      this.requests.clear();
      this.pending = null;
      this.disconnectPresence();
    }
    presenceBody() {
      if (!this.presenceClient) this.presenceClient = id();
      return { ...this.presence(), client_id: this.presenceClient };
    }
    disconnectPresence() {
      const clientId = this.presenceClient;
      const active = this.presenceActive;
      // A late unload must not remove a subsequent connection from this page.
      this.presenceClient = this.presenceId = null;
      this.presenceActive = false;
      if (!clientId || !active) return;
      request(this.url('/presence/' + encodeURIComponent(clientId)), {
        token: this.token, accountId: this.accountId, method: 'DELETE', keepalive: true,
      }).catch(error => {
        if (![401, 403, 404, 409, 499].includes(error.status)) {
          console.warn('设备离线通知失败，在线状态将在超时后清除。', error);
        }
      });
    }
    command(action, payload = {}) {
      const body = { action, command_id: id(), ...payload };
      const epoch = this.epoch;
      const run = async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            this.current(epoch);
            const value = await this.call('/commands', { method: 'POST', body });
            this.current(epoch);
            this.accept(value);
            return value;
          } catch (error) {
            if (epoch !== this.epoch || error.status === 499) throw error;
            // The account moved to another room; this room can no longer accept commands.
            if (contextChanged(error)) {
              this.onconnection('changed', error);
              this.stop();
              throw error;
            }
            // Same command ID makes a dropped response safe to retry, including add/next.
            if (error.status === 0 && attempt < 1) { await sleep(600); continue; }
            if (error.status === 409) await this.refresh().catch(() => {});
            throw error;
          }
        }
      };
      const pending = this.serial.then(run);
      this.serial = pending.catch(() => {});
      return pending;
    }
    async settings(body) {
      const value = await this.call('', { method: 'PATCH', body });
      this.accept(value);
      return value;
    }
    // Only the digest of a pairing code is stored, so a host rotates it to see one again.
    async invitation() {
      const value = await this.call('/invitation', { method: 'POST' });
      this.accept(value.state);
      return value;
    }
    async updateMember(displayName) {
      const value = await this.call('/member', { method: 'PATCH', body: { display_name: displayName } });
      this.accept(value);
      return value;
    }
    leave() { return this.call('/leave', { method: 'POST' }); }
    close() { return this.call('', { method: 'DELETE' }); }
    async claim() {
      const presence = this.presence ? this.presenceBody() : null;
      const value = await this.call('/player/claim', { method: 'POST',
        ...(presence ? { body: { client_id: presence.client_id, device_id: presence.device_id } } : {}),
      });
      this.accept(value.state);
      return value;
    }
    async heartbeat(playerToken, body) {
      const value = await this.call('/player/heartbeat', { playerToken, method: 'POST', body });
      this.accept(value);
      return value;
    }
    async ended(playerToken, body) {
      const value = await this.call('/player/ended', { playerToken, method: 'POST', body });
      this.accept(value);
      return value;
    }
    async release(playerToken) {
      const value = await this.call('/player/release', { playerToken, method: 'POST' });
      this.accept(value);
      return value;
    }
    releaseOnUnload(playerToken) {
      // Teardown cancels ordinary calls; this small release must outlive the page.
      return request(this.url('/player/release'), {
        token: this.token, playerToken, accountId: this.accountId, method: 'POST', keepalive: true,
      });
    }
  }
  function joinURL(roomId, code, role = 'controller') {
    if (!['controller', 'screen'].includes(role)) throw new RoomError('配对角色无效', 400);
    const url = new URL(role === 'screen' ? '/tv' : '/remote', location.href);
    url.search = '';
    url.hash = new URLSearchParams({ room: roomId, code }).toString();
    return url.href;
  }
  function saved(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { return null; }
  }
  const sessionKey = 'openk.room-sessions.v1';
  function validSession(value) {
    return value && typeof value.room_id === 'string' && /^[a-f0-9]{10}$/.test(value.room_id)
      && typeof value.token === 'string' && value.token.length >= 16 && value.token.length <= 256
      && ['host', 'controller', 'screen'].includes(value.role);
  }
  const roomSessions = {
    all() {
      const value = saved(sessionKey);
      if (value === null) return [];
      if (!Array.isArray(value)) {
        console.warn('Saved room history has an unsupported format.');
        return [];
      }
      const entries = value.filter(validSession);
      if (entries.length !== value.length) console.warn('Invalid saved room entries were not restored.');
      return entries;
    },
    get(roomId, roles = ['controller', 'host', 'screen']) {
      const entries = this.all();
      for (const role of roles) {
        const entry = entries.find(value => value.room_id === roomId && value.role === role);
        if (entry) return entry;
      }
      return null;
    },
    remember(value) {
      if (!validSession(value)) throw new RoomError('房间凭据无效，无法保存', 400);
      const entry = { room_id: value.room_id, token: value.token, role: value.role };
      for (const key of ['name', 'display_name', 'pairing_code']) {
        if (typeof value[key] === 'string') entry[key] = value[key];
      }
      const entries = this.all();
      const index = entries.findIndex(item => item.room_id === entry.room_id && item.role === entry.role);
      if (index !== -1 && JSON.stringify(entries[index]) === JSON.stringify(entry)) return true;
      return saved(sessionKey, [
        entry, ...entries.filter(item => item.room_id !== entry.room_id || item.role !== entry.role),
      ].slice(0, 192)) !== null;
    },
    forget(roomId, role) {
      return saved(sessionKey, this.all().filter(
        item => item.room_id !== roomId || role && item.role !== role)) !== null;
    },
  };
  function clock(seconds) {
    const time = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(time / 60) + ':' + String(time % 60).padStart(2, '0');
  }
  function devicePresence(surfaceRoles, activeRoles = []) {
    const api = window.OpenKUserState;
    const accountId = window.OpenKAccount?.value?.user?.id;
    const value = api?.value;
    const own = accountId && value?.enabled && value.accountId === accountId ? value.device : null;
    return {
      device_id: accountId ? api?.deviceId() || null : null,
      label: own?.label || api?.suggestedLabel() || '浏览器',
      roles: roleList([...surfaceRoles, ...activeRoles, ...(own?.roles || [])]),
    };
  }

  const deviceViews = new WeakMap();
  function renderDevices(host, state, currentId) {
    if (!host) throw new RoomError('页面缺少房间设备列表', 500);
    host.hidden = !Array.isArray(state?.devices);
    const devices = (state?.devices || []).map(device => ({
      id: device.id, name: device.name, roles: roleList(device.roles || []),
      online: device.online !== false, player: device.player === true,
    }));
    const signature = JSON.stringify([devices, currentId, state?.player?.status,
      !!state?.current, state?.playback?.playing]);
    if (deviceViews.get(host) === signature) return;
    deviceViews.set(host, signature);
    const make = (tag, className, text) => {
      const node = host.ownerDocument.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const heading = make('p', 'room-device-heading',
      `房间设备 · ${devices.filter(device => device.online).length} 台在线`);
    const previous = host.querySelector('.room-device-list');
    const focused = previous && host.ownerDocument.activeElement === previous;
    const scrollTop = previous?.scrollTop || 0;
    const list = make('ul', 'room-device-list');
    list.setAttribute('aria-label', '房间设备及角色');
    list.tabIndex = 0;
    list.addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(event.key)) {
        event.stopPropagation();
      }
    });
    for (const device of devices) {
      const item = make('li', 'room-device' + (device.player ? ' is-player' : ''));
      item.dataset.deviceId = device.id;
      const name = make('strong', 'room-device-name',
        device.name + (device.id === currentId ? '（本机）' : ''));
      const roles = make('span', 'room-device-roles');
      for (const role of device.roles) {
        const badge = make('span', 'room-device-role', deviceRoles[role]);
        badge.dataset.role = role;
        if (role === 'microphone') badge.title = '本机麦克风角色，不会向其他设备传送声音';
        roles.append(badge);
      }
      if (!device.roles.length) roles.append(make('span', 'room-device-role', '未设置角色'));
      let status = device.online ? '' : '离线';
      if (device.player) {
        const playback = state.player?.status;
        status = ['blocked', 'error'].includes(playback) ? '声音待恢复'
          : !state.current ? '已就绪，等待点歌'
            : !state.playback?.playing ? '已暂停'
              : playback === 'playing' ? '正在播放'
                : playback === 'buffering' ? '正在缓冲' : '播放器已启用';
      } else if (device.online && device.roles.includes('player')) status = '播放器待启用';
      item.append(name, roles);
      if (status) item.append(make('span', 'room-device-status', status));
      list.append(item);
    }
    host.replaceChildren(heading, list);
    list.scrollTop = scrollTop;
    if (focused) list.focus({ preventScroll: true });
    if (!devices.length) host.append(make('p', 'room-device-empty', '暂无在线设备'));
  }
  window.OpenKRoom = {
    RoomClient, RoomError, request, id, joinURL, saved, clock, roomSessions, contextChanged,
    deviceRoles, devicePresence, renderDevices,
  };
})();
