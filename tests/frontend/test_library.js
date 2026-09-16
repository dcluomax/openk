'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Library = require('../../frontend/library.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const stats = (songs = [], account = 'a') => ({
  account_id: account, songs, total_plays: songs.reduce((sum, song) => sum + song.play_count, 0),
  history_limit: 500,
});
function client(t, libraryStats) {
  const original = globalThis.OpenKUserState;
  globalThis.OpenKUserState = { libraryStats };
  t.after(() => {
    if (original === undefined) delete globalThis.OpenKUserState;
    else globalThis.OpenKUserState = original;
  });
}

test('544-song pagination bounds every page, visits every item once and clamps after deletion', () => {
  const songs = Array.from({ length: 544 }, (_, id) => ({ id }));
  const visited = [];
  for (let number = 1; number <= 23; number++) {
    const result = Library.page(songs, number);
    assert.ok(result.items.length <= 24);
    assert.equal(result.page, number);
    assert.equal(result.pages, 23);
    assert.equal(result.total, 544);
    visited.push(...result.items);
  }
  assert.deepEqual(visited, songs);
  assert.equal(Library.page(songs, 999).items.length, 16);
  assert.equal(Library.page(songs.slice(0, 3), 23).page, 1);
  assert.equal(Library.page([], 23).total, 0);
  assert.equal(Library.page(songs, -1).page, 1);
});

test('letter controls expose real counts, keep focused nodes, and allow clearing an empty selection', t => {
  const dom = new JSDOM('<nav id="letters"></nav>');
  t.after(() => dom.window.close());
  const element = dom.window.document.querySelector('nav');
  const items = ['A', 'A', 'B', '#'];
  Library.renderIndex(element, items, 'A', value => value);
  const chosen = element.querySelector('[data-letter="A"]');
  assert.equal(element.children.length, 28);
  assert.equal(chosen.getAttribute('aria-label'), 'A，2 项');
  assert.equal(chosen.getAttribute('aria-pressed'), 'true');
  assert.equal(element.querySelector('[data-letter="C"]').disabled, true);
  assert.equal(element.querySelector('[data-letter="#"]').disabled, false);
  chosen.focus();
  Library.renderIndex(element, items, 'A', value => value);
  assert.equal(dom.window.document.activeElement, chosen);
  Library.renderIndex(element, [], 'A', value => value);
  assert.equal(chosen.disabled, false);
  assert.equal(element.querySelector('[data-letter=""]').disabled, false);
});

test('personal popularity shares requests, ranks only retained plays, and never changes catalog order', async t => {
  const reply = deferred();
  let calls = 0, changes = 0;
  client(t, () => { calls++; return reply.promise; });
  const model = Library.createPopularity(() => changes++);
  await model.load(null);
  assert.equal(calls, 0);
  const first = model.load('a');
  assert.equal(model.load('a', true), first);
  assert.equal(model.state.loading, true);
  reply.resolve(stats([
    { job_id: 'older', play_count: 2, last_played_at: 10 },
    { job_id: 'favorite', play_count: 5, last_played_at: 2 },
    { job_id: 'recent', play_count: 2, last_played_at: 12 },
    { job_id: 'removed-from-catalog', play_count: 20, last_played_at: 100 },
  ]));
  await first;
  const songs = ['older', 'unplayed', 'favorite', 'recent'].map(id => ({ id }));
  assert.deepEqual(model.rank(songs).map(song => song.id), ['favorite', 'recent', 'older']);
  assert.deepEqual(songs.map(song => song.id), ['older', 'unplayed', 'favorite', 'recent']);
  await model.load('a');
  assert.equal(calls, 1);
  assert.equal(changes, 2);
  assert.match(model.note(), /500.*非全网热度.*清除历史/);
});

test('stats errors retain an explicitly stale result; successful refresh honors deleted history', async t => {
  let fail = false, value = stats([{ job_id: 'a', play_count: 2, last_played_at: 1 }]);
  client(t, async () => {
    if (fail) throw new Error('NAS 暂不可用');
    return value;
  });
  const model = Library.createPopularity(() => {});
  await model.load('a');
  fail = true;
  await model.load('a', true);
  assert.equal(model.state.songs.size, 1);
  assert.match(model.note(), /未更新.*NAS 暂不可用.*保留上次/);
  fail = false;
  value = stats([]);
  await model.load('a', true);
  assert.equal(model.state.songs.size, 0);
  assert.equal(model.state.error, '');
});

test('a reset/account switch fences pending stats and authentication failure clears private counts', async t => {
  const old = deferred();
  let request = () => old.promise;
  client(t, () => request());
  const model = Library.createPopularity(() => {});
  const stale = model.load('a');
  await Promise.resolve();
  model.forAccount('b');
  request = async () => stats([{ job_id: 'b-song', play_count: 3, last_played_at: 1 }], 'b');
  await model.load('b');
  old.resolve(stats([{ job_id: 'private-old-song', play_count: 40, last_played_at: 1 }]));
  await stale;
  assert.equal(model.state.accountId, 'b');
  assert.deepEqual([...model.state.songs.keys()], ['b-song']);
  request = async () => { throw Object.assign(new Error('重新登录'), { status: 401 }); };
  await model.load('b', true);
  assert.equal(model.state.songs.size, 0);
  assert.equal(model.state.value, null);
  assert.match(model.note(), /重新登录/);
  model.reset();
  assert.equal(model.state.accountId, null);
});

test('a missing client surfaces a retryable error rather than latching a completed request', async t => {
  client(t, undefined);
  const model = Library.createPopularity(() => {});
  await model.load('a');
  assert.match(model.state.error, /未加载/);
  globalThis.OpenKUserState.libraryStats = async () => stats([]);
  await model.load('a', true);
  assert.equal(model.state.error, '');
  assert.ok(model.state.value);
});
