/* Shared account and current-room helper. No credentials are stored by this page:
   the private account service owns the session cookie, this file only reads identity. */
(() => {
  'use strict';
  const { request, RoomError, RoomClient, saved } = OpenKRoom;
  const inviteKey = 'openk.account.invites.v1';
  let state = null;
  let pending = null;
  let epoch = 0;
  let loadedEpoch = 0;
  const mounted = new WeakMap();
  const validAccountId = value => typeof value === 'string'
    && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

  // Only same-origin absolute paths; an account service must never redirect this app off-site.
  function path(value, fallback) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
        || /[\\\x00-\x20\x7f]/.test(value)) return fallback;
    const target = new URL(value, location.href);
    return target.origin === location.origin ? target.pathname + target.search + target.hash : fallback;
  }
  function parse(value) {
    if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') {
      throw new RoomError('账号服务返回了无法识别的资料，请刷新页面重试', 502);
    }
    if (!value.enabled) return { enabled: false, user: null };
    const user = value.user;
    if (!user || typeof user !== 'object'
        || !validAccountId(user.id) || typeof user.is_staff !== 'boolean'
        || typeof user.username !== 'string' || !user.username
        || typeof user.display_name !== 'string' || !user.display_name) {
      throw new RoomError('账号资料不完整，请重新登录 OpenK', 502);
    }
    return {
      enabled: true,
      user: { id: user.id, username: user.username,
        display_name: user.display_name, is_staff: user.is_staff === true },
      profileUrl: path(value.profile_url, '/auth/'),
      loginUrl: path(value.login_url, '/auth/login/'),
      logoutUrl: path(value.logout_url, '/auth/logout/'),
    };
  }
  function load(force = false) {
    if (state && loadedEpoch === epoch && !force) return Promise.resolve(state);
    if (!pending || force) {
      const generation = ++epoch;
      const attempt = (async () => {
        try {
          const value = await request('/api/account');
          if (generation !== epoch) throw new RoomError('账号状态已更新，请重试', 499);
          state = parse(value);
          loadedEpoch = generation;
          return state;
        } catch (error) {
          if (generation !== epoch) throw new RoomError('账号状态已更新，请重试', 499);
          throw error;
        } finally { if (pending === attempt) pending = null; }
      })();
      pending = attempt;
    }
    return pending;
  }
  function initials(name) {
    const value = String(name || '').trim();
    if (!value) return '·';
    if (/^[\x20-\x7e]+$/.test(value)) {
      const words = value.split(/\s+/).filter(Boolean);
      return (words.length > 1 ? words[0][0] + words[1][0] : value.slice(0, 2)).toUpperCase();
    }
    return Array.from(value).slice(-2).join('');
  }

  function invites() {
    const value = saved(inviteKey);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function own(accountId) {
    const value = invites()[accountId];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function inviteCode(accountId, roomId) {
    const entry = own(accountId)[roomId];
    // Legacy entries carry no version: treat them as stale so the host regenerates on purpose.
    const code = typeof entry === 'string' ? entry : entry?.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
    const version = typeof entry === 'object' && Number.isInteger(entry.version) ? entry.version : 0;
    return { code, version };
  }
  /** A cached code is only safe to show while it matches the room's invite version. */
  function currentInvite(accountId, roomId, version) {
    const entry = inviteCode(accountId, roomId);
    return entry && Number.isInteger(version) && entry.version === version ? entry.code : null;
  }
  function rememberInvite(accountId, roomId, code, version) {
    if (!validAccountId(accountId) || !/^[a-f0-9]{10}$/.test(roomId || '') || !/^\d{6}$/.test(code || '')
        || !Number.isInteger(version) || version < 1) {
      throw new RoomError('配对码无效，无法保存', 400);
    }
    const all = invites();
    const entries = Object.entries({ ...own(accountId), [roomId]: { code, version } }).slice(-24);
    return saved(inviteKey, { ...all, [accountId]: Object.fromEntries(entries) }) !== null;
  }
  function forgetInvite(accountId, roomId) {
    const value = own(accountId);
    if (!(roomId in value)) return true;
    delete value[roomId];
    return saved(inviteKey, { ...invites(), [accountId]: value }) !== null;
  }
  // Sign-out removes this account's cache only; another person's browser data stays untouched.
  function clear(accountId) {
    const all = invites();
    if (!(accountId in all)) return true;
    delete all[accountId];
    return saved(inviteKey, all) !== null;
  }

  /** Validate a current-room result and keep the newest invite code for this account. */
  function adopt(value) {
    if (!value || typeof value !== 'object' || !/^[a-f0-9]{10}$/.test(value.room_id || '')
        || !['host', 'controller'].includes(value.role) || value.account_mode !== true
        || !validAccountId(value.account_id) || !value.state || value.state.id !== value.room_id
        || value.state.account_mode !== true || value.state.viewer?.role !== value.role
        || !Number.isInteger(value.state.revision) || value.state.revision < 0
        || !Number.isInteger(value.state.invite_version) || value.state.invite_version < 1) {
      throw new RoomError('房间信息无法识别，请刷新页面重试', 502);
    }
    if (!state?.enabled || loadedEpoch !== epoch || value.account_id !== state.user.id) {
      throw new RoomError('登录账号已改变，请重新读取当前房间', 409, 'account_changed');
    }
    if (typeof value.pairing_code === 'string' && typeof value.account_id === 'string') {
      rememberInvite(value.account_id, value.room_id, value.pairing_code, value.state.invite_version);
    }
    return value;
  }
  async function currentRoom() { return adopt(await RoomClient.current()); }

  function mount(host, options = {}) {
    if (!host) throw new RoomError('页面缺少账号信息位置', 500);
    mounted.get(host)?.();
    const doc = host.ownerDocument;
    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const avatar = make('span', 'account-avatar', '·');
    avatar.setAttribute('aria-hidden', 'true');
    const name = make('span', 'account-name', '未登录');
    const profile = make('a', 'text-button account-profile', '个人资料');
    const devices = make('a', 'text-button account-devices', '设备设置');
    devices.href = '/devices';
    const history = make('a', 'text-button account-history', '播放历史');
    history.href = '/history';
    const signIn = make('a', 'text-button account-signin', '登录');
    const logout = make('button', 'text-button account-logout', '退出登录');
    logout.type = 'button';
    const menu = make('details', 'account-menu');
    const summary = make('summary', 'account-summary');
    const actions = make('nav', 'account-actions');
    actions.setAttribute('aria-label', '账号操作');
    summary.append(avatar, name);
    actions.append(profile, devices, history, signIn, logout);
    menu.append(summary, actions);
    logout.onclick = () => { menu.open = false; options.onLogout?.(); };
    const outside = event => { if (!host.contains(event.target)) menu.open = false; };
    doc.addEventListener('pointerdown', outside);
    mounted.set(host, () => doc.removeEventListener('pointerdown', outside));
    menu.addEventListener('focusout', event => {
      if (event.relatedTarget && !menu.contains(event.relatedTarget)) menu.open = false;
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.open) {
        event.preventDefault(); event.stopPropagation();
        menu.open = false; summary.focus();
      } else if (menu.open && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const items = [profile, devices, history, signIn, logout].filter(item => !item.hidden && !item.disabled);
        const index = items.indexOf(doc.activeElement);
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    });
    host.classList.add('account-chip');
    host.replaceChildren(menu);
    const view = {
      update(user) {
        const current = state || {};
        host.hidden = false;
        if (user) {
          host.dataset.accountId = user.id;
          avatar.textContent = initials(user.display_name);
          name.textContent = user.display_name;
          name.title = user.username;
          summary.setAttribute('aria-label', '账号：' + user.display_name);
          profile.href = current.profileUrl || '/auth/';
          profile.hidden = logout.hidden = false;
          devices.hidden = history.hidden = false;
          signIn.hidden = true;
        } else {
          delete host.dataset.accountId;
          avatar.textContent = '·';
          name.textContent = '未登录';
          summary.setAttribute('aria-label', '账号：未登录');
          name.removeAttribute('title');
          signIn.href = current.loginUrl || '/auth/login/';
          signIn.hidden = false;
          profile.hidden = logout.hidden = true;
          devices.hidden = history.hidden = true;
        }
        return view;
      },
      busy(flag) { logout.disabled = !!flag; logout.textContent = flag ? '正在退出…' : '退出登录'; return view; },
      hide() { host.hidden = true; menu.open = false; return view; },
      nodes: { avatar, name, profile, devices, history, signIn, logout, menu, summary, actions },
    };
    return view.update(null);
  }

  /** One-click sign-out. Callers stop local audio and release a player lease first. */
  async function logout() {
    const current = await load();
    if (!current.enabled) throw new RoomError('当前部署没有启用账号登录', 400);
    let csrf = '';
    let expired = false;
    let accountId = current.user.id;
    try {
      const me = await request('/auth/api/me/');
      if (!validAccountId(me.id)) throw new RoomError('账号服务返回了无法识别的当前用户', 502);
      accountId = me.id;
      if (typeof me.csrf_token === 'string' && me.csrf_token) csrf = me.csrf_token;
    } catch (error) {
      // An already-expired session still ends at the sign-in page.
      if (error.status !== 401) throw error;
      expired = true;
    }
    if (!expired) {
      if (!csrf) throw new RoomError('账号服务没有返回登出凭据，请在个人资料页退出。', 502);
      const response = await fetch(current.logoutUrl, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'follow',
        // Django rejects a CSRF POST over HTTPS without a same-origin Referer.
        referrerPolicy: 'same-origin',
        headers: { Accept: 'application/json', 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest' },
      }).catch(() => { throw new RoomError('无法联系账号服务，请在个人资料页退出。', 0); });
      if (!response.ok) throw new RoomError('退出登录失败，请在个人资料页退出。', response.status);
    }
    clear(accountId);
    reset();
    return current.loginUrl;
  }

  function reset() { epoch++; state = null; pending = null; }
  window.OpenKAccount = {
    load, reload: () => load(true), mount, adopt, currentRoom, logout,
    inviteCode, currentInvite, rememberInvite, forgetInvite, clear, initials,
    get value() { return state; },
    reset,
  };
})();
