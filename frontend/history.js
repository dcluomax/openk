/* Playback history page. Entries are written by the server from validated player
   heartbeats, so this page only reads, pages and deletes them. History is scoped
   to the signed-in account: no device id, room id or entry number reveals anyone
   else's playback. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const api = window.OpenKUserState;
  const PAGE = 25;
  let before = null;
  let busy = false;

  function status(message, kind = '') {
    const node = $('#pageStatus');
    node.textContent = message || '';
    node.dataset.kind = kind;
    node.classList.toggle('hidden', !message);
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function clock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }
  // The page is Simplified Chinese, so times are formatted for zh-CN rather than
  // for whatever locale the browser happens to prefer.
  function stamp(seconds) {
    const value = new Date((Number(seconds) || 0) * 1000);
    return Number.isNaN(value.getTime()) ? '时间未知' : value.toLocaleString('zh-CN');
  }

  function row(entry) {
    const item = element('li', 'history-item');
    item.append(element('h3', '', entry.title));
    const parts = [entry.artist || '未知歌手', stamp(entry.startedAt), entry.deviceLabel];
    item.append(element('p', 'meta', parts.join(' · ')));
    const side = element('div', 'side');
    const played = entry.duration > 0
      ? `${clock(entry.position)} / ${clock(entry.duration)}`
      : clock(entry.position);
    side.append(element('span', 'small', entry.completed ? `已唱完 · ${played}` : `已播放 ${played}`));
    if (entry.duration > 0) {
      const bar = element('div', 'progress');
      const fill = element('span');
      const ratio = Math.max(0, Math.min(1, entry.position / entry.duration));
      fill.style.width = (ratio * 100).toFixed(1) + '%';
      bar.append(fill);
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', `已播放 ${(ratio * 100).toFixed(0)}%`);
      side.append(bar);
    }
    const remove = element('button', 'danger', '删除');
    remove.type = 'button';
    remove.onclick = () => {
      if (!window.confirm(`删除「${entry.title}」这条记录吗？`)) return;
      guard(async () => {
        await api.deleteEntry(entry.id);
        await reload();
        status('这条记录已删除。', 'ok');
      });
    };
    side.append(remove);
    item.append(side);
    return item;
  }

  async function guard(action) {
    if (busy) return;
    busy = true;
    try { await action(); } catch (error) {
      if (error.status === 499) return;
      if (error.code === 'account_changed') { location.reload(); return; }
      status(error.message || '无法读取你的播放历史。', 'error');
    } finally { busy = false; }
  }

  async function page(append) {
    const value = await api.history({ limit: PAGE, before: append ? before : null });
    if (!append) $('#historyList').replaceChildren();
    $('#historyList').append(...value.entries.map(row));
    before = value.nextBefore;
    $('#loadMore').hidden = !before;
    $('#historyCount').textContent = value.total
      ? `共 ${value.total} 条记录。`
      : '你的设备还没有播放过歌曲。';
    if (!value.total) {
      $('#historyList').replaceChildren(element('li', 'muted',
        '在你启用过的设备上唱一首，这里就会出现记录。'));
    }
    status('');
  }
  function reload() { before = null; return page(false); }

  async function start() {
    let account;
    try { account = await OpenKAccount.load(); } catch (error) {
      status(error.message || '无法连接账号服务。', 'error');
      return;
    }
    if (!account.enabled) {
      status('当前部署没有启用账号，不会保存播放历史。', 'error');
      return;
    }
    const view = OpenKAccount.mount($('#accountChip'), { onLogout: () => signOut(view) });
    view.update(account.user);
    if (!account.user) {
      status('请先登录后再查看播放历史。', 'error');
      location.assign(account.loginUrl || '/auth/login/');
      return;
    }
    $('#loadMore').onclick = () => guard(() => page(true));
    $('#clearHistory').onclick = () => {
      if (!window.confirm('清空播放历史里的所有记录吗？此操作无法撤销。')) return;
      guard(async () => {
        const result = await api.clearHistory();
        await reload();
        status(`已清空 ${result.removed || 0} 条记录。`, 'ok');
      });
    };
    await guard(reload);
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
