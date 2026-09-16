/* Shared account + device settings, topology, playback history and the personal
   play counts derived from it.

   Settings follow both the person and the machine: the account keeps portable
   defaults, this browser installation keeps hardware-sensitive overrides, and a
   surface applies the account default overlaid by this device's override. The
   device id below names a browser installation only. It is not a credential, it
   is not a hardware fingerprint, and the server ignores it unless the request
   also carries an authenticated account. Nothing account-scoped is cached in
   local storage, so a shared browser can never hand one person's settings to
   the next person who signs in. */
(() => {
  'use strict';
  const { request, RoomError } = OpenKRoom;
  const DEVICE_KEY = 'openk.device.v1';
  const LEGACY_PREF_KEY = 'openk.prefs';
  const ACCOUNT_KEYS = ['sing_mode', 'reverb', 'view', 'accompaniment_volume', 'guide_volume',
    'mic_monitor', 'mic_volume', 'howl_guard'];
  const DEVICE_ONLY_KEYS = ['output_volume', 'audio_input', 'audio_output'];
  const DEVICE_KEYS = [...ACCOUNT_KEYS, ...DEVICE_ONLY_KEYS];
  const ROLES = ['player', 'controller', 'microphone'];
  const ENUMS = {
    sing_mode: ['inst', 'orig'],
    reverb: ['none', 'room', 'ktv', 'hall', 'church'],
    view: ['list', 'grid'],
  };
  const RANGES = {
    accompaniment_volume: [0, 100], guide_volume: [0, 100],
    mic_volume: [0, 200], output_volume: [0, 100],
  };
  const FLAGS = ['mic_monitor', 'howl_guard'];
  const TEXTS = { audio_input: 200, audio_output: 200 };
  const SAFE = {
    sing_mode: 'inst', reverb: 'ktv', view: 'list',
    accompaniment_volume: 100, guide_volume: 0,
    mic_monitor: true, mic_volume: 110, howl_guard: true,
    output_volume: 100, audio_input: '', audio_output: '',
  };
  const WRITE_DELAY = 400;

  let memoryDevice = null;
  let state = null;
  let epoch = 0;
  let pendingDefaults = null;
  let pendingOverrides = null;
  let flushTimer = null;
  let writing = null;
  const listeners = new Set();
  const problems = new Set();

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
      return value;
    } catch { return null; }
  }
  function randomId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  /** A random per-installation name for this browser, created once and reused. */
  function deviceId() {
    const existing = store(DEVICE_KEY);
    if (typeof existing === 'string' && /^[0-9a-f]{32}$/.test(existing)) return existing;
    const value = randomId();
    if (store(DEVICE_KEY, value) === value) return value;
    // Private browsing keeps no storage: stay usable for this page only.
    if (!memoryDevice) memoryDevice = value;
    return memoryDevice;
  }
  function persistent() { return /^[0-9a-f]{32}$/.test(String(store(DEVICE_KEY) || '')); }

  function suggestedLabel(nav = navigator) {
    const agent = String(nav.userAgent || '');
    const platform = /Android/i.test(agent) ? 'Android'
      : /iPhone|iPad|iPod/i.test(agent) ? 'iOS'
        : /Mac OS X|Macintosh/i.test(agent) ? 'Mac'
          : /Windows/i.test(agent) ? 'Windows'
            : /CrOS/i.test(agent) ? 'ChromeOS'
              : /Linux/i.test(agent) ? 'Linux' : '';
    const browser = /Edg\//.test(agent) ? 'Edge'
      : /OPR\//.test(agent) ? 'Opera'
        : /Chrome\//.test(agent) ? 'Chrome'
          : /Firefox\//.test(agent) ? 'Firefox'
            : /Safari\//.test(agent) ? 'Safari' : '浏览器';
    // A default label only; a name the person typed is never rewritten.
    return (platform ? `${browser}（${platform}）` : browser).slice(0, 40);
  }
  function capabilities(win = window) {
    const media = win.navigator?.mediaDevices;
    return {
      playback: typeof win.Audio === 'function',
      microphone: !!media?.getUserMedia,
      input_select: !!media?.enumerateDevices,
      output_select: typeof win.HTMLMediaElement === 'function'
        && 'setSinkId' in win.HTMLMediaElement.prototype,
    };
  }

  function accountId() { return window.OpenKAccount?.value?.user?.id || null; }
  function valid(value) { return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value); }

  function setting(key, value) {
    if (ENUMS[key]) return ENUMS[key].includes(value) ? value : SAFE[key];
    if (RANGES[key]) {
      const [low, high] = RANGES[key];
      return Number.isInteger(value) && value >= low && value <= high ? value : SAFE[key];
    }
    if (FLAGS.includes(key)) return typeof value === 'boolean' ? value : SAFE[key];
    if (TEXTS[key]) return typeof value === 'string' && value.length <= TEXTS[key] ? value : SAFE[key];
    return SAFE[key];
  }
  /** Values are re-checked here so a damaged row can never drive the audio graph. */
  function clean(values, keys) {
    const source = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const result = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = setting(key, source[key]);
    }
    return result;
  }
  function label(value, fallback) {
    const text = typeof value === 'string' ? value.trim() : '';
    // eslint-disable-next-line no-control-regex
    return text && text.length <= 40 && !/[\u0000-\u001f\u007f]/.test(text) ? text : fallback;
  }
  function device(value) {
    if (!value || typeof value !== 'object' || !valid(value.id)) return null;
    return {
      id: value.id,
      label: label(value.label, '设备'),
      roles: Array.isArray(value.roles) ? value.roles.filter(role => ROLES.includes(role)) : [],
      overrides: clean(value.overrides, DEVICE_KEYS),
      capabilities: value.capabilities && typeof value.capabilities === 'object' ? {
        playback: value.capabilities.playback === true,
        microphone: value.capabilities.microphone === true,
        input_select: value.capabilities.input_select === true,
        output_select: value.capabilities.output_select === true,
      } : {},
      created_at: Number(value.created_at) || 0,
      last_seen_at: Number(value.last_seen_at) || 0,
      revision: Number.isInteger(value.revision) ? value.revision : 0,
      preferred_player: value.preferred_player === true,
      current: value.current === true,
    };
  }
  function parse(value, expected) {
    if (!value || typeof value !== 'object' || value.enabled !== true
        || !Array.isArray(value.devices) || !Number.isInteger(value.revision)) {
      throw new RoomError('设置服务返回了无法识别的内容，请刷新页面重试。', 502);
    }
    if (value.account_id !== expected) {
      throw new RoomError('登录账号已改变，正在重新读取你的设置。', 409, 'account_changed');
    }
    const devices = value.devices.map(device).filter(Boolean);
    const own = device(value.device);
    return {
      enabled: true,
      accountId: expected,
      revision: value.revision,
      defaults: { ...SAFE, ...clean(value.defaults, ACCOUNT_KEYS) },
      preferredPlayer: valid(value.preferred_player) ? value.preferred_player : null,
      device: own && devices.find(item => item.id === own.id) || own,
      devices,
      settings: { ...SAFE, ...clean(value.settings, DEVICE_KEYS) },
      limits: value.limits && typeof value.limits === 'object' ? value.limits : {},
    };
  }

  function notify() { for (const listener of [...listeners]) listener(state); }
  function fail(error) {
    if (error?.status === 499) return;
    problems.add(error?.message || '你的设置没有保存成功。');
    notify();
  }
  function accept(value, generation, id) {
    if (generation !== epoch || id !== accountId()) {
      throw new RoomError('登录账号已改变，正在重新读取你的设置。', 499);
    }
    state = value;
    return value;
  }

  async function call(path, options = {}) {
    const generation = epoch;
    const id = accountId();
    const value = await request(path, { ...options, device: deviceId(), accountId: id });
    if (generation !== epoch || id !== accountId()) {
      throw new RoomError('登录账号已改变，正在重新读取你的设置。', 499);
    }
    return { value, generation, id };
  }
  async function snapshot(path, options) {
    const { value, generation, id } = await call(path, options);
    return accept(parse(value, id), generation, id);
  }

  /** Register this browser for the signed-in account and read the merged state. */
  async function load(options = {}) {
    if (!accountId()) {
      state = { enabled: false, accountId: null, settings: { ...SAFE }, devices: [] };
      return state;
    }
    problems.clear();
    const body = { capabilities: capabilities() };
    if (options.label !== false) body.label = suggestedLabel();
    const value = await snapshot('/api/user/state', { method: 'POST', body });
    notify();
    return value;
  }
  async function refresh() {
    if (!accountId()) return load();
    const value = await snapshot('/api/user/state');
    notify();
    return value;
  }

  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, WRITE_DELAY);
  }
  /** Writes are serialised and retried once against a fresh revision so two of
      your own devices cannot silently overwrite each other's recent edits. */
  async function flush() {
    if (writing) return writing;
    if (!state?.enabled || !accountId()) { pendingDefaults = pendingOverrides = null; return; }
    if (!pendingDefaults && !pendingOverrides) return;
    const run = (async () => {
      while (pendingDefaults || pendingOverrides) {
        const defaults = pendingDefaults;
        const overrides = pendingOverrides;
        pendingDefaults = pendingOverrides = null;
        try {
          if (defaults) await send('/api/user/defaults', () => ({
            method: 'PUT', body: { revision: state.revision, settings: defaults },
          }));
          if (overrides) {
            const id = state.device?.id;
            if (!id) throw new RoomError('这个浏览器还没有注册，请刷新页面。', 409);
            await send('/api/user/devices/' + encodeURIComponent(id), () => ({
              method: 'PATCH', body: { revision: state.device.revision, overrides },
            }));
          }
        } catch (error) {
          fail(error);
          return;
        }
      }
      problems.clear();
      notify();
    })();
    const pending = run.finally(() => { if (writing === pending) writing = null; });
    writing = pending;
    return writing;
  }
  async function send(path, build) {
    try {
      await snapshot(path, build());
    } catch (error) {
      if (error.code !== 'revision_conflict') throw error;
      // Another device edited first: take its values, then re-apply this change.
      await refresh();
      await snapshot(path, build());
    }
  }

  function saveDefaults(patch) {
    const values = clean(patch, ACCOUNT_KEYS);
    if (!state?.enabled || !Object.keys(values).length) return false;
    state = { ...state, defaults: { ...state.defaults, ...values },
      settings: { ...state.settings, ...values, ...(state.device?.overrides || {}) } };
    pendingDefaults = { ...(pendingDefaults || {}), ...values };
    schedule();
    return true;
  }
  function saveOverrides(patch) {
    const values = clean(patch, DEVICE_KEYS);
    if (!state?.enabled || !state.device || !Object.keys(values).length) return false;
    const overrides = { ...state.device.overrides, ...values };
    state = { ...state, device: { ...state.device, overrides },
      settings: { ...state.settings, ...values } };
    pendingOverrides = { ...(pendingOverrides || {}), ...values };
    schedule();
    return true;
  }
  /** Route a player control to the level that owns it. */
  function save(patch) {
    const values = clean(patch, DEVICE_KEYS);
    const account = {};
    const own = {};
    for (const [key, value] of Object.entries(values)) {
      if (['sing_mode', 'reverb', 'view', 'accompaniment_volume', 'guide_volume'].includes(key)) {
        account[key] = value;
      } else own[key] = value;
    }
    const first = Object.keys(account).length ? saveDefaults(account) : false;
    const second = Object.keys(own).length ? saveOverrides(own) : false;
    return first || second;
  }

  async function setPreferredPlayer(id) {
    const value = await snapshot('/api/user/topology', {
      method: 'PUT', body: { revision: state.revision, preferred_player: id || null },
    });
    notify();
    return value;
  }
  async function patchDevice(id, changes) {
    const target = state?.devices.find(item => item.id === id);
    if (!target) throw new RoomError('这台设备已经不在你的设备列表里了。', 404);
    const body = { revision: target.revision, ...changes };
    const value = await snapshot('/api/user/devices/' + encodeURIComponent(id), { method: 'PATCH', body });
    notify();
    return value;
  }
  async function removeDevice(id) {
    const value = await snapshot('/api/user/devices/' + encodeURIComponent(id), { method: 'DELETE' });
    notify();
    return value;
  }

  function entry(value) {
    if (!value || typeof value !== 'object' || !Number.isInteger(value.id)) return null;
    const duration = Number(value.duration);
    const position = Number(value.position);
    return {
      id: value.id,
      title: typeof value.title === 'string' && value.title ? value.title : '未命名歌曲',
      artist: typeof value.artist === 'string' ? value.artist : '',
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      position: Number.isFinite(position) && position > 0 ? position : 0,
      deviceLabel: label(value.device_label, '未知设备'),
      startedAt: Number(value.started_at) || 0,
      updatedAt: Number(value.updated_at) || 0,
      completed: value.completed === true,
    };
  }
  async function history({ limit, before } = {}) {
    const query = new URLSearchParams();
    if (Number.isInteger(limit)) query.set('limit', String(limit));
    if (Number.isInteger(before)) query.set('before', String(before));
    const search = query.toString();
    const { value } = await call('/api/user/history' + (search ? '?' + search : ''));
    if (!value || !Array.isArray(value.entries)) {
      throw new RoomError('无法读取播放历史，请刷新页面重试。', 502);
    }
    return {
      entries: value.entries.map(entry).filter(Boolean),
      total: Number.isInteger(value.total) ? value.total : 0,
      nextBefore: Number.isInteger(value.next_before) ? value.next_before : null,
    };
  }
  async function clearHistory() { return (await call('/api/user/history', { method: 'DELETE' })).value; }
  async function deleteEntry(id) {
    if (!Number.isInteger(id)) throw new RoomError('这条记录无效。', 400);
    return (await call('/api/user/history/' + encodeURIComponent(id), { method: 'DELETE' })).value;
  }

  /** One song in this account's own play counts. A damaged row is refused rather
      than dropped: a silently missing row would reorder a list the person reads
      as "what I sing most". */
  function statistic(value) {
    if (!value || typeof value !== 'object'
        || typeof value.job_id !== 'string' || !value.job_id
        || !Number.isInteger(value.play_count) || value.play_count < 1
        || !Number.isFinite(value.last_played_at) || value.last_played_at < 0) return null;
    return {
      job_id: value.job_id,
      play_count: value.play_count,
      last_played_at: value.last_played_at,
    };
  }
  /** How often this account played each song, counted from its retained history.

      Personal and live: it is read through the same fenced call as every other
      account API, it is never written to this browser or kept for the next
      person who signs in, and it is never a global or internet chart. */
  async function libraryStats() {
    const { value, id } = await call('/api/user/library-stats');
    if (!value || typeof value !== 'object' || !Array.isArray(value.songs)
        || !Number.isInteger(value.total_plays) || value.total_plays < 0
        || !Number.isInteger(value.history_limit) || value.history_limit < 1
        || value.songs.length > value.history_limit) {
      throw new RoomError('无法读取常唱统计，请刷新页面重试。', 502);
    }
    if (value.account_id !== id) {
      throw new RoomError('登录账号已改变，正在重新读取你的设置。', 409, 'account_changed');
    }
    const songs = value.songs.map(statistic);
    if (songs.includes(null)) throw new RoomError('无法读取常唱统计，请刷新页面重试。', 502);
    return {
      account_id: id,
      songs,
      total_plays: value.total_plays,
      history_limit: value.history_limit,
    };
  }

  /** Read this browser's standalone preferences for an explicit, user-made import.
      They are never adopted automatically: a signed-in account starts from safe
      server defaults until the person chooses to bring these values over. */
  function legacyPreferences() {
    let value;
    try { value = JSON.parse(localStorage.getItem(LEGACY_PREF_KEY) || 'null'); } catch { return null; }
    if (!value || typeof value !== 'object') return null;
    const mapped = {
      sing_mode: value.singMode, reverb: value.reverb, view: value.view,
      mic_monitor: value.micMonitor, howl_guard: value.howlGuard,
      mic_volume: Number.isFinite(value.micVol) ? Math.round(value.micVol) : undefined,
      accompaniment_volume: Number.isFinite(value.instVol) ? Math.round(value.instVol) : undefined,
      guide_volume: Number.isFinite(value.vocalVol) ? Math.round(value.vocalVol) : undefined,
    };
    const result = {};
    for (const [key, item] of Object.entries(mapped)) {
      if (item === undefined) continue;
      const checked = setting(key, item);
      if (checked === item) result[key] = checked;
    }
    return Object.keys(result).length ? result : null;
  }

  function reset() {
    epoch++;
    state = null;
    pendingDefaults = pendingOverrides = null;
    clearTimeout(flushTimer);
    flushTimer = null;
    problems.clear();
  }

  window.OpenKUserState = {
    deviceId, persistent, suggestedLabel, capabilities, load, refresh, reset, flush,
    saveDefaults, saveOverrides, save, setPreferredPlayer, patchDevice, removeDevice,
    history, clearHistory, deleteEntry, libraryStats, legacyPreferences,
    onchange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get value() { return state; },
    get problems() { return [...problems]; },
    get settings() { return state?.settings ? { ...state.settings } : { ...SAFE }; },
    get enabled() { return !!state?.enabled; },
    keys: { account: [...ACCOUNT_KEYS], deviceOnly: [...DEVICE_ONLY_KEYS], all: [...DEVICE_KEYS] },
    roles: [...ROLES], enums: ENUMS, ranges: RANGES, safe: { ...SAFE },
  };
})();
