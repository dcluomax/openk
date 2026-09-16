/* Shared catalog navigation. Popularity belongs to the current account, never the browser. */
(() => {
  'use strict';
  const PAGE_SIZE = 24;
  const LETTERS = ['', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];

  function page(items, requested = 1) {
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const current = Math.max(1, Math.min(pages, Math.trunc(requested) || 1));
    const start = (current - 1) * PAGE_SIZE;
    return { items: items.slice(start, start + PAGE_SIZE), page: current, pages,
      total: items.length, start, end: Math.min(items.length, start + PAGE_SIZE) };
  }

  function renderIndex(element, items, selected, initial) {
    const counts = new Map();
    for (const item of items) {
      const letter = initial(item);
      counts.set(letter, (counts.get(letter) || 0) + 1);
    }
    const signature = JSON.stringify([selected, ...LETTERS.map(letter => counts.get(letter) || 0)]);
    if (element.dataset.signature === signature) return;
    element.dataset.signature = signature;
    if (!element.children.length) {
      for (const letter of LETTERS) {
        const button = element.ownerDocument.createElement('button');
        button.type = 'button';
        button.dataset.letter = letter;
        button.textContent = letter || '全部';
        element.append(button);
      }
    }
    for (const button of element.children) {
      const letter = button.dataset.letter;
      const count = letter ? counts.get(letter) || 0 : items.length;
      const name = letter === '#' ? '数字及其他' : letter || '全部';
      button.disabled = !!letter && count === 0 && letter !== selected;
      button.title = `${name} · ${count} 项`;
      button.setAttribute('aria-label', `${name}，${count} 项`);
      button.setAttribute('aria-pressed', String(letter === selected));
    }
  }

  function renderPager(element, selection, unit = '首') {
    element.hidden = selection.total <= PAGE_SIZE;
    element.querySelector('[data-page-step="-1"]').disabled = selection.page <= 1;
    element.querySelector('[data-page-step="1"]').disabled = selection.page >= selection.pages;
    element.querySelector('[data-page-info]').textContent =
      `第 ${selection.page} / ${selection.pages} 页 · ${selection.total ? selection.start + 1 : 0}–${selection.end} ${unit}`;
  }

  function createPopularity(changed) {
    const state = { accountId: null, songs: new Map(), value: null, loading: false, error: '' };
    let generation = 0, pending = null, attemptedAt = 0;
    function reset(accountId = null) {
      generation++;
      pending = null;
      attemptedAt = 0;
      Object.assign(state, { accountId, songs: new Map(), value: null, loading: false, error: '' });
    }
    function forAccount(accountId) {
      if (state.accountId !== accountId) reset(accountId);
      return state;
    }
    function load(accountId, force = false) {
      forAccount(accountId);
      if (!accountId) return Promise.resolve();
      if (pending) return pending;
      if (!force && attemptedAt && Date.now() - attemptedAt < 30000) return Promise.resolve();
      attemptedAt = Date.now();
      const epoch = generation;
      state.loading = true;
      state.error = '';
      const request = Promise.resolve().then(async () => {
        try {
          if (epoch !== generation) return;
          if (!globalThis.OpenKUserState?.libraryStats) throw new Error('常唱统计服务未加载，请刷新页面');
          const value = await globalThis.OpenKUserState.libraryStats();
          if (epoch !== generation) return;
          state.value = value;
          state.songs = new Map(value.songs.map(song => [song.job_id, song]));
        } catch (error) {
          if (epoch !== generation) return;
          if ([401, 403, 409, 499].includes(error.status)) {
            state.songs.clear();
            state.value = null;
          }
          state.error = error.status === 499 ? '账号状态已改变，请重新读取常唱统计。'
            : error.message || '暂时无法读取常唱统计，请重试。';
        } finally {
          if (epoch === generation) {
            pending = null;
            state.loading = false;
            changed();
          }
        }
      });
      pending = request;
      changed();
      return request;
    }
    function rank(jobs) {
      return jobs.filter(job => state.songs.has(job.id)).sort((a, b) => {
        const x = state.songs.get(a.id), y = state.songs.get(b.id);
        return y.play_count - x.play_count || y.last_played_at - x.last_played_at;
      });
    }
    function note() {
      if (state.error) return '常唱统计未更新：' + state.error
        + (state.value ? ' 当前保留上次结果。' : '');
      if (state.loading) return '正在读取我的常唱记录…';
      if (!state.value) return '读取播放记录后显示我的常唱歌曲。';
      return `按最近 ${state.value.history_limit} 条有效播放记录统计，非全网热度；清除历史也会移除对应次数。`;
    }
    return { state, forAccount, load, reset, rank, note };
  }

  const api = { PAGE_SIZE, page, renderIndex, renderPager, createPopularity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.OpenKLibrary = api;
})();
