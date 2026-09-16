/* Device topology and settings page. Every control here is a real, persisted
   setting: the account keeps portable defaults, this browser keeps hardware
   overrides, and the preferred player decides where a song is asked to start.
   Nothing on this page can grant microphone access or start audio elsewhere —
   a browser only makes sound after someone activates OpenK on that device. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const api = window.OpenKUserState;
  const ranges = { accompaniment_volume: '%', guide_volume: '%', mic_volume: '%', output_volume: '%' };
  const OVERRIDE_KEYS = ['mic_volume', 'output_volume', 'mic_monitor', 'howl_guard',
    'audio_input', 'audio_output'];
  let busy = false;
  let registered = false;
  let mediaDevices = [];

  const CAP_NOTICE = '这个浏览器还没有注册：账号的设备数量已经达到上限。'
    + '先在下面移除一台，这个浏览器就会自己注册。';
  const ROLE_NAMES = OpenKRoom.deviceRoles;

  function status(message, kind = '') {
    const node = $('#pageStatus');
    node.textContent = message || '';
    node.dataset.kind = kind;
    node.classList.toggle('hidden', !message);
  }
  function hint(node, message) {
    node.textContent = message || '';
    node.classList.toggle('hidden', !message);
  }
  // The page is Simplified Chinese, so dates are formatted for zh-CN rather than
  // for whatever locale the browser happens to prefer.
  function when(seconds) {
    if (!seconds) return '从未';
    const value = new Date(seconds * 1000);
    if (Number.isNaN(value.getTime())) return '未知';
    const minutes = Math.floor((Date.now() - value.getTime()) / 60000);
    if (minutes < 2) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时前`;
    return value.toLocaleDateString('zh-CN');
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---------- media devices this browser can actually offer ---------- */
  function sinkSelectable() {
    return typeof HTMLMediaElement !== 'undefined'
      && typeof HTMLMediaElement.prototype.setSinkId === 'function';
  }
  async function loadMediaDevices() {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) {
      hint($('#mediaHint'), '这个浏览器无法列出音频设备，将使用系统默认设备。');
      mediaDevices = [];
      return;
    }
    try { mediaDevices = await media.enumerateDevices(); } catch { mediaDevices = []; }
    if (!sinkSelectable()) {
      hint($('#mediaHint'), '这个浏览器无法选择音频输出设备，将使用系统默认设备。');
    } else if (mediaDevices.length && mediaDevices.every(item => !item.label)) {
      hint($('#mediaHint'), '在这个浏览器上授权一次麦克风后，才会显示设备名称。');
    } else hint($('#mediaHint'), '');
  }
  function fillMediaSelect(select, kind, current, fallback) {
    const list = mediaDevices.filter(item => item.kind === kind);
    const options = [{ deviceId: '', label: '系统默认设备' }, ...list];
    if (current && !options.some(item => item.deviceId === current)) {
      options.push({ deviceId: current, label: '已保存的设备（这个浏览器上找不到）' });
    }
    select.replaceChildren(...options.map((item, index) => {
      const option = element('option', '', item.label || `${fallback} ${index}`);
      option.value = item.deviceId;
      return option;
    }));
    select.value = options.some(item => item.deviceId === current) ? current : '';
    if (kind === 'audiooutput') select.disabled = !sinkSelectable();
    else select.disabled = !navigator.mediaDevices?.enumerateDevices;
  }

  /* ---------- rendering ---------- */
  function showValue(form, key, value) {
    const out = form.querySelector(`[data-out="${key}"]`);
    if (out) out.textContent = value + (ranges[key] || '');
  }
  function renderDefaults(state) {
    const form = $('#defaultsForm');
    for (const control of form.querySelectorAll('[data-key]')) {
      const key = control.dataset.key;
      const value = state.defaults[key];
      if (control.type === 'checkbox') control.checked = !!value;
      else { control.value = value; showValue(form, key, value); }
    }
  }
  function renderOverrides(state) {
    const form = $('#overridesForm');
    const own = state.device;
    const overrides = own?.overrides || {};
    for (const key of OVERRIDE_KEYS) {
      const toggle = form.querySelector(`[data-override="${key}"]`);
      const control = form.querySelector(`[data-key="${key}"]`);
      if (!toggle || !control) continue;
      const active = Object.prototype.hasOwnProperty.call(overrides, key);
      const value = active ? overrides[key] : state.defaults[key] ?? api.safe[key];
      toggle.checked = active;
      toggle.disabled = !own;
      control.disabled = !own || !active;
      if (control.type === 'checkbox') control.checked = !!value;
      else if (control.tagName === 'SELECT') {
        fillMediaSelect(control, key === 'audio_input' ? 'audioinput' : 'audiooutput', value,
          key === 'audio_input' ? '麦克风' : '扬声器');
        if (!active) control.disabled = true;
      } else { control.value = value; showValue(form, key, value); }
    }
    $('#deviceLabel').value = own?.label || '';
    $('#deviceLabel').disabled = !own;
    $('#saveLabel').disabled = !own;
    $('#clearOverrides').disabled = !own || !Object.keys(overrides).length;
    for (const box of $$('[data-role]')) {
      box.checked = !!own?.roles.includes(box.dataset.role);
      box.disabled = !own;
    }
    const caps = own?.capabilities || {};
    $('#deviceSummary').textContent = own
      ? `${own.label} · 最近出现：${when(own.last_seen_at)} · `
        + `${caps.microphone ? '有麦克风' : '没有麦克风'}，`
        + `${caps.output_select ? '可以选择扬声器' : '不能选择扬声器'}`
      : '这个浏览器还没有注册。';
  }
  function renderPreferred(state) {
    const select = $('#preferredPlayer');
    const options = [element('option', '', '不指定 · 在哪台设备启用就在哪台唱')];
    options[0].value = '';
    for (const device of state.devices) {
      const option = element('option', '', device.label + (device.current ? '（这台设备）' : ''));
      option.value = device.id;
      options.push(option);
    }
    select.replaceChildren(...options);
    select.value = state.preferredPlayer || '';
    const target = state.devices.find(item => item.id === state.preferredPlayer);
    hint($('#topologyHint'), target
      ? (target.current
        ? '歌曲会在这台设备上开唱。同一账号的其他设备要先确认才会接管。'
        : `歌曲应该在「${target.label}」上开唱。请在那台设备上打开 OpenK 并启用声音；`
          + '别的设备不会自己开始，你也可以在那台设备上手动改为在本机播放。')
      : '没有指定时，第一台被启用的设备会拿到房间里唯一的播放权。');
  }
  function renderList(state) {
    const list = $('#deviceList');
    list.replaceChildren(...state.devices.map(device => {
      const item = element('li', 'device-item' + (device.current ? ' is-current' : ''));
      const head = element('div', 'device-head');
      head.append(element('strong', '', device.label));
      if (device.preferred_player) head.append(element('span', 'tag', '首选播放器'));
      if (device.current) head.append(element('span', 'tag', '这台设备'));
      const roles = device.roles.map(role => ROLE_NAMES[role] || role);
      const meta = element('p', 'muted small',
        `${roles.length ? roles.join('、') : '还没有角色'} · 最近出现：${when(device.last_seen_at)}`);
      const actions = element('div', 'device-actions');
      const prefer = element('button', '', device.preferred_player ? '取消首选播放器' : '设为首选播放器');
      prefer.type = 'button';
      prefer.onclick = () => guard(async () => {
        await api.setPreferredPlayer(device.preferred_player ? null : device.id);
        status(device.preferred_player ? '已取消首选播放器。' : `首选播放器已设为「${device.label}」。`, 'ok');
      });
      const remove = element('button', 'danger', '移除');
      remove.type = 'button';
      remove.onclick = () => {
        const message = device.current
          ? `移除「${device.label}」？这个浏览器会作为一台新设备重新注册。`
          : `移除「${device.label}」？它的覆盖项会被删除；播放历史里仍保留当时的设备名称。`;
        if (!window.confirm(message)) return;
        guard(async () => {
          await api.removeDevice(device.id);
          status(`已移除「${device.label}」。`, 'ok');
          // Removing this browser, or freeing the last slot, lets it register again.
          if (device.current) registered = false;
          await claimSlot();
        });
      };
      actions.append(prefer, remove);
      item.append(head, meta, actions);
      return item;
    }));
    if (!state.devices.length) list.append(element('li', 'muted', '还没有注册任何设备。'));
  }

  /* A plain SVG map drawn from the data above: no external assets, no canvas. */
  function renderTopology(state) {
    const host = $('#topology');
    const devices = state.devices.slice(0, 12);
    const width = 320;
    const height = 120 + Math.max(0, devices.length - 1) * 70;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'topology-svg');
    svg.setAttribute('aria-hidden', 'true');
    const make = (tag, attributes, text) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const hubX = 54, hubY = height / 2;
    devices.forEach((device, index) => {
      const y = 46 + index * 70;
      svg.append(make('path', {
        d: `M ${hubX + 26} ${hubY} C ${hubX + 80} ${hubY}, ${140} ${y}, ${188} ${y}`,
        class: 'link' + (device.preferred_player ? ' link-player' : ''),
      }));
      svg.append(make('rect', { x: 188, y: y - 26, width: 118, height: 52, rx: 10,
        class: 'node' + (device.preferred_player ? ' node-player' : '') + (device.current ? ' node-current' : '') }));
      const name = Array.from(device.label);
      svg.append(make('text', { x: 198, y: y - 10, class: 'node-label' },
        name.length > 9 ? name.slice(0, 8).join('') + '…' : device.label));
      const roles = device.roles.map(role => ROLE_NAMES[role]).filter(Boolean);
      svg.append(make('text', { x: 198, y: y + 4, class: 'node-role' },
        roles.slice(0, 2).join(' / ') || '未设置角色'));
      if (roles.length > 2) svg.append(make('text', { x: 198, y: y + 17, class: 'node-role' }, roles.slice(2).join(' / ')));
    });
    svg.append(make('circle', { cx: hubX, cy: hubY, r: 26, class: 'hub' }));
    svg.append(make('text', { x: hubX, y: hubY + 4, class: 'hub-label', 'text-anchor': 'middle' }, '账号'));
    host.replaceChildren(svg);
    $('#topologyText').textContent = devices.length
      ? '你的设备：' + devices.map(device => device.label
        + (device.preferred_player ? '（首选播放器）' : '')
        + '：' + (device.roles.map(role => ROLE_NAMES[role]).filter(Boolean).join('、') || '未设置角色')).join('；')
      : '还没有注册任何设备。';
  }

  function render(state) {
    if (!state?.enabled) return;
    renderDefaults(state);
    renderOverrides(state);
    renderPreferred(state);
    renderList(state);
    renderTopology(state);
    const legacy = api.legacyPreferences();
    $('#importLocal').hidden = !legacy;
  }

  /* Registering claims one of the account's device slots. A browser that cannot
     claim one must still be able to manage the list, so the page falls back to a
     read-only read of the account's own devices — only for that cap failure, and
     only after saying plainly that this browser is not registered. Nothing is
     ever evicted automatically. */
  async function boot() {
    try {
      render(await api.load());
      registered = true;
      status('');
    } catch (error) {
      if (error.status !== 429) throw error;
      registered = false;
      render(await api.refresh());
      status(error.message ? `${error.message} ${CAP_NOTICE}` : CAP_NOTICE, 'error');
    }
  }

  /** Register this browser once a slot has been freed on purpose. */
  async function claimSlot() {
    if (registered) return;
    try {
      render(await api.load());
      registered = true;
      status('这个浏览器已经注册好了。', 'ok');
    } catch (error) {
      if (error.status !== 429) throw error;
      status(CAP_NOTICE, 'error');
    }
  }

  async function guard(action) {
    if (busy) return;
    busy = true;
    try {
      await action();
      const problems = api.problems;
      if (problems.length) status(problems[0], 'error');
    } catch (error) {
      if (error.status !== 499) status(error.message || '这次修改没有保存成功。', 'error');
      // A conflict means another device saved first: show its values immediately.
      if (error.code === 'revision_conflict') await api.refresh().catch(() => {});
      if (error.code === 'account_changed') location.reload();
    } finally {
      busy = false;
      render(api.value);
    }
  }

  function collectOverrides() {
    const form = $('#overridesForm');
    const values = {};
    for (const key of OVERRIDE_KEYS) {
      const toggle = form.querySelector(`[data-override="${key}"]`);
      const control = form.querySelector(`[data-key="${key}"]`);
      if (!toggle?.checked || !control) continue;
      values[key] = control.type === 'checkbox' ? control.checked
        : control.tagName === 'SELECT' ? control.value : Number(control.value);
    }
    return values;
  }
  function saveOverrides() {
    return guard(async () => {
      const device = api.value?.device;
      if (!device) throw new OpenKRoom.RoomError('这个浏览器还没有注册。', 409);
      await api.patchDevice(device.id, { clear_overrides: true, overrides: collectOverrides() });
      status('已保存到这台设备。', 'ok');
    });
  }
  function saveDefaults(key, value) {
    return guard(async () => {
      api.saveDefaults({ [key]: value });
      await api.flush();
      const problems = api.problems;
      status(problems.length ? problems[0] : '已保存到你的账号。', problems.length ? 'error' : 'ok');
    });
  }

  function bind() {
    const defaults = $('#defaultsForm');
    defaults.addEventListener('change', event => {
      const control = event.target.closest('[data-key]');
      if (!control) return;
      const key = control.dataset.key;
      const value = control.type === 'checkbox' ? control.checked
        : control.type === 'range' ? Number(control.value) : control.value;
      saveDefaults(key, value);
    });
    defaults.addEventListener('input', event => {
      const control = event.target.closest('[data-key]');
      if (control?.type === 'range') showValue(defaults, control.dataset.key, control.value);
    });
    const overrides = $('#overridesForm');
    overrides.addEventListener('input', event => {
      const control = event.target.closest('[data-key]');
      if (control?.type === 'range') showValue(overrides, control.dataset.key, control.value);
    });
    overrides.addEventListener('change', event => {
      const toggle = event.target.closest('[data-override]');
      if (toggle) {
        const control = overrides.querySelector(`[data-key="${toggle.dataset.override}"]`);
        if (control) control.disabled = !toggle.checked;
      }
      saveOverrides();
    });
    $('#saveLabel').onclick = () => guard(async () => {
      const device = api.value?.device;
      if (!device) throw new OpenKRoom.RoomError('这个浏览器还没有注册。', 409);
      await api.patchDevice(device.id, { label: $('#deviceLabel').value.trim() });
      status('设备名称已更新。', 'ok');
    });
    for (const box of $$('[data-role]')) {
      box.onchange = () => guard(async () => {
        const device = api.value?.device;
        if (!device) return;
        await api.patchDevice(device.id, {
          roles: $$('[data-role]').filter(item => item.checked).map(item => item.dataset.role),
        });
        status('角色已更新。', 'ok');
      });
    }
    $('#clearOverrides').onclick = () => guard(async () => {
      const device = api.value?.device;
      if (!device) return;
      await api.patchDevice(device.id, { clear_overrides: true, overrides: {} });
      status('这台设备已改用账号默认设置。', 'ok');
    });
    $('#importLocal').onclick = () => {
      const legacy = api.legacyPreferences();
      if (!legacy || !window.confirm(
        '把这个浏览器里保存的设置复制到账号默认设置吗？')) return;
      guard(async () => {
        api.saveDefaults(legacy);
        await api.flush();
        status('已把这个浏览器的设置导入账号。', 'ok');
      });
    };
    $('#preferredPlayer').onchange = event => guard(async () => {
      await api.setPreferredPlayer(event.target.value || null);
      status('首选播放器已更新。', 'ok');
    });
  }

  async function start() {
    const chip = $('#accountChip');
    let account;
    try { account = await OpenKAccount.load(); } catch (error) {
      status(error.message || '无法连接账号服务。', 'error');
      return;
    }
    if (!account.enabled) {
      status('当前部署没有启用账号，设备设置只保存在各自的浏览器里。', 'error');
      return;
    }
    const view = OpenKAccount.mount(chip, { onLogout: () => signOut(view) });
    view.update(account.user);
    if (!account.user) {
      status('请先登录后再管理设备。', 'error');
      location.assign(account.loginUrl || '/auth/login/');
      return;
    }
    api.onchange(state => { if (state?.enabled) render(state); });
    bind();
    await loadMediaDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      loadMediaDevices().then(() => render(api.value));
    });
    try {
      await boot();
    } catch (error) {
      status('无法读取你的设备列表：' + (error.message || error), 'error');
    }
  }
  async function signOut(view) {
    try {
      view.busy(true);
      api.reset();
      location.assign(await OpenKAccount.logout());
    } catch (error) {
      view.busy(false);
      status(error.message || '退出登录失败。', 'error');
    }
  }
  document.addEventListener('DOMContentLoaded', start);
})();
