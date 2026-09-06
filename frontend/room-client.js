/* Shared, dependency-free room transport. Capabilities never enter URLs. */
(() => {
  'use strict';
  const id = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  class RoomError extends Error {
    constructor(message, status = 0) { super(message); this.status = status; }
  }
  async function request(path, { token, playerToken, body, method = 'GET' } = {}) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8000);
    try {
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (playerToken) headers['X-Player-Token'] = playerToken;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(path, {
        method, headers, cache: 'no-store', credentials: 'same-origin',
        referrerPolicy: 'no-referrer', signal: abort.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let value = {};
      try { value = await response.json(); } catch { /* HTTP status still matters. */ }
      if (!response.ok) throw new RoomError(
        typeof value.detail === 'string' ? value.detail : '请求失败，请稍后重试', response.status);
      return value;
    } catch (error) {
      if (error instanceof RoomError) throw error;
      throw new RoomError(error.name === 'AbortError' ? '连接超时，正在重连' : '无法连接房间，请检查 Wi-Fi');
    } finally { clearTimeout(timeout); }
  }
  class RoomClient {
    constructor(roomId, token) {
      this.id = roomId;
      this.token = token;
      this.state = null;
      this.onstate = () => {};
      this.onconnection = () => {};
      this.running = false;
      this.pending = null;
      this.serial = Promise.resolve();
      this.failures = 0;
      this.timer = null;
    }
    static create() { return request('/api/rooms', { method: 'POST' }); }
    static join(roomId, code) {
      return request('/api/rooms/' + encodeURIComponent(roomId) + '/join',
        { method: 'POST', body: { code } });
    }
    url(suffix = '') { return '/api/rooms/' + encodeURIComponent(this.id) + suffix; }
    accept(value) {
      if (!value || typeof value.revision !== 'number') return;
      if (this.state && value.revision < this.state.revision) return;
      if (this.state && value.revision === this.state.revision
          && (value.player?.seen_at || 0) < (this.state.player?.seen_at || 0)) {
        value = { ...value, player: this.state.player };
      }
      if (value.unchanged) {
        if (!this.state || value.revision !== this.state.revision) return;
        this.state = { ...this.state, player: value.player, expires_at: value.expires_at };
      } else this.state = value;
      this.onstate(this.state);
    }
    async refresh() {
      if (this.pending) return this.pending;
      this.pending = (async () => {
        try {
          const after = this.state ? '?after=' + this.state.revision : '';
          const value = await request(this.url(after), { token: this.token });
          this.accept(value);
          this.failures = 0;
          this.onconnection('connected');
          return this.state;
        } catch (error) {
          this.failures++;
          this.onconnection(error.status === 403 || error.status === 404 ? 'expired' : 'reconnecting', error);
          if ([401, 403, 404].includes(error.status)) this.stop();
          throw error;
        } finally { this.pending = null; }
      })();
      return this.pending;
    }
    start() {
      if (this.running) return;
      this.running = true;
      const poll = async () => {
        try { await this.refresh(); } catch { /* Connection UI is updated by refresh. */ }
        if (this.running) this.timer = setTimeout(poll, this.failures
          ? Math.min(15000, 1500 * 2 ** this.failures)
          : document.hidden ? 4000 : 1500);
      };
      poll();
    }
    stop() { this.running = false; clearTimeout(this.timer); }
    command(action, payload = {}) {
      const body = { action, command_id: id(), ...payload };
      const run = async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            const value = await request(this.url('/commands'), {
              token: this.token, method: 'POST', body,
            });
            this.accept(value);
            return value;
          } catch (error) {
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
    async claim() {
      const value = await request(this.url('/player/claim'), { token: this.token, method: 'POST' });
      this.accept(value.state);
      return value;
    }
    async heartbeat(playerToken, body) {
      const value = await request(this.url('/player/heartbeat'), {
        token: this.token, playerToken, method: 'POST', body,
      });
      this.accept(value);
      return value;
    }
    async ended(playerToken, body) {
      const value = await request(this.url('/player/ended'), {
        token: this.token, playerToken, method: 'POST', body,
      });
      this.accept(value);
      return value;
    }
  }
  function joinURL(roomId, code) {
    const url = new URL('/remote', location.href);
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
  function clock(seconds) {
    const time = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(time / 60) + ':' + String(time % 60).padStart(2, '0');
  }
  window.OpenKRoom = { RoomClient, RoomError, request, id, joinURL, saved, clock };
})();
