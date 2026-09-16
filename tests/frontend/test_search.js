'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JSDOM } = require('jsdom');
const Search = require('../../frontend/search.js');
const root = path.resolve(__dirname, '../..');
const python = process.env.OPENK_TEST_PYTHON || (fs.existsSync(path.join(root, '.venv/bin/python'))
  ? path.join(root, '.venv/bin/python') : 'python3');
const fixtures = JSON.parse(execFileSync(python, ['tests/python/test_search.py', '--fixtures'], {
  cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
}));
const ids = jobs => Array.from(jobs, job => job.id);
const clone = value => JSON.parse(JSON.stringify(value));

test('Python and browser normalization, scores and ranked results agree', () => {
  const search = Search.create(fixtures.map);
  for (const item of fixtures.normalization) {
    assert.equal(search.normalize(item.value), item.text, String(item.value));
    assert.deepEqual(search.query(item.value), item.query);
  }
  for (const { q, ids: expected, scores } of fixtures.cases) {
    assert.deepEqual(ids(search.search(fixtures.jobs, q)), expected, q);
    assert.deepEqual(fixtures.jobs.map(job => Search.score(search.index(job), search.query(q))), scores, q);
  }
});

test('empty query sorting is deterministic and does not mutate the library', () => {
  const search = Search.create(fixtures.map), jobs = clone(fixtures.jobs), original = ids(jobs);
  const expected = ids(search.search(jobs, ''));
  for (const query of ['', '　 ', '... 🎤 —']) {
    assert.deepEqual(ids(search.search([...jobs].reverse(), query)), expected);
  }
  assert.deepEqual(ids(jobs), original);
});

test('fallback initials remain prefix-only and avoid Latin/non-Han noise', () => {
  const search = Search.create(fixtures.map);
  const jobs = fixtures.jobs.map(({ search_index, ...job }) => job);
  assert.ok(ids(search.search(jobs, 'dx')).includes('rice'));
  assert.ok(!ids(search.search(jobs, 'dx')).includes('rain'));
  assert.ok(!ids(search.search(jobs, 'dxy')).includes('rain'));
  assert.ok(ids(search.search(jobs, 'yyzbs')).includes('mixed'));
  assert.deepEqual(ids(search.search(jobs, '周杰倫 稻香')), ['rice']);
  assert.deepEqual(ids(search.search(jobs, 'beyonce deja-vu')), ['accent']);
  assert.equal(Search.initialsOf('♪😀'), '');
});

test('metadata, index and character-map changes invalidate cached client fields', () => {
  const search = Search.create();
  const job = clone(fixtures.jobs.find(job => job.id === 'rice'));
  const first = search.index(job);
  assert.equal(search.index(job), first);
  job.track = '重慶';
  job.title = '重慶';
  job.artist = '';
  assert.notEqual(search.index(job), first);
  assert.deepEqual(ids(search.search([job], 'dx')), []);
  assert.deepEqual(ids(search.search([job], '重庆')), []);
  search.setMap(fixtures.map);
  delete job.search_index;
  assert.deepEqual(ids(search.search([job], '重庆')), ['rice']);
  const replacement = fixtures.jobs.find(item => item.id === 'polyphonic');
  Object.assign(job, { ...replacement, id: 'rice' });
  assert.deepEqual(ids(search.search([job], 'chongqing')), ['rice']);
  assert.deepEqual(ids(search.search([job], 'daoxiang')), []);
});

test('artist grouping folds case/width/scripts without merging distinct punctuation', () => {
  const search = Search.create(fixtures.map);
  assert.equal(search.artistKey('夢然'), search.artistKey('梦然'));
  assert.equal(search.artistKey(' Ａ－Ｌｉｎ '), search.artistKey('a-lin'));
  assert.notEqual(search.artistKey('A-Lin'), search.artistKey('ALin'));
  assert.notEqual(search.artistKey('AC/DC'), search.artistKey('ACDC'));
  assert.notEqual(search.artistKey('A-Lin'), search.artistKey('A Lin'));
});

test('letter browsing uses phrase-aware server pinyin and separates song and artist initials', () => {
  const search = Search.create(fixtures.map);
  const find = id => fixtures.jobs.find(job => job.id === id);
  assert.equal(search.initial(find('rice')), 'D');
  assert.equal(search.initial(find('rice'), 1), 'Z');
  assert.equal(search.initial(find('polyphonic')), 'C');
  assert.equal(search.initial(find('accent')), 'D');
  assert.equal(search.initial({ track: '123 木头人' }), '#');
  assert.equal(search.initial({ track: '🎤' }), '#');
  assert.equal(search.initial({ track: '歌曲', artist: '' }, 1), '#');
  assert.equal(search.initial({ track: '稻香' }), 'D');
});

function remoteFixture(t) {
  const frontend = path.join(root, 'frontend');
  const dom = new JSDOM(fs.readFileSync(path.join(frontend, 'remote.html'), 'utf8'), {
    url: 'http://localhost/remote', runScripts: 'outside-only',
  });
  const w = dom.window, timers = new Map();
  let nextTimer = 0, failMap = false, failJobs = false;
  w.setTimeout = fn => { timers.set(++nextTimer, fn); return nextTimer; };
  w.clearTimeout = id => timers.delete(id);
  w.OpenKRoom = {
    RoomClient: {}, saved: () => null, clock: () => '3:00',
    request: async url => {
      if (url === '/api/zh-map') {
        if (failMap) throw new Error('map offline');
        return fixtures.map;
      }
      assert.equal(url, '/api/jobs');
      if (failJobs) throw new Error('catalog offline');
      return [...clone(fixtures.jobs), { id: 'pending', state: 'running' },
        { id: 'unplayable', state: 'done', media: {} }];
    },
  };
  // Catalog projection tests do not start a room or a lobby polling loop.
  w.OpenKAccount = { load: () => new Promise(() => {}) };
  w.eval(fs.readFileSync(path.join(frontend, 'search.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(frontend, 'library.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(frontend, 'remote.js'), 'utf8'));
  const phone = w.openkRemote, $ = selector => w.document.querySelector(selector);
  t.after(() => { phone.destroy(); w.close(); });
  return {
    w, phone, $, timers,
    fail(map, jobs) { failMap = map; failJobs = jobs; },
    input(value, composing = false) {
      $('#songSearch').value = value;
      $('#songSearch').dispatchEvent(new w.InputEvent('input', { bubbles: true, isComposing: composing }));
    },
    flush() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(fn => fn());
    },
    titles: () => Array.from(w.document.querySelectorAll('#roomSongList strong'), el => el.textContent),
  };
}

test('remote uses shared ranking, matched counts, global terms and useful empty text', async t => {
  const f = remoteFixture(t);
  await f.phone.loadLibrary();
  assert.equal(f.phone.jobs.length, fixtures.jobs.length);
  f.input('稻香');
  f.flush();
  assert.deepEqual(f.titles(), ['稻香', '另一首歌', '现场录音', '稻香现场版']);
  assert.equal(f.$('#libraryCount').textContent, `4 / ${fixtures.jobs.length} 首`);
  f.input('稻香 zhou jie lun');
  f.flush();
  assert.deepEqual(f.titles(), ['稻香']);
  f.input('<img src=x onerror=alert(1)>');
  f.flush();
  assert.equal(f.titles().length, 0);
  assert.equal(f.$('#libraryCount').textContent, `0 / ${fixtures.jobs.length} 首`);
  assert.match(f.$('#libraryStatus').textContent, /没有匹配/);
  assert.equal(f.$('#remotePager').hidden, true);
  assert.equal(f.$('#libraryStatus img'), null);
  f.input('');
  f.flush();
  assert.equal(f.titles().length, fixtures.jobs.length);
  assert.equal(f.$('#libraryCount').textContent, `${fixtures.jobs.length} 首`);
  assert.equal(f.$('#libraryStatus').textContent, '');
});

test('remote defers IME filtering, cancels pending input, and keeps committed results on refresh', async t => {
  const f = remoteFixture(t);
  await f.phone.loadLibrary();
  f.input('周杰倫 稻香');
  f.flush();
  f.phone.libraryPage = 3;
  f.input('a pending debounce');
  assert.equal(f.timers.size, 1);
  f.$('#songSearch').dispatchEvent(new f.w.CompositionEvent('compositionstart'));
  assert.equal(f.timers.size, 0);
  f.input('hai', true);
  await f.phone.loadLibrary();
  f.flush();
  assert.deepEqual(f.titles(), ['稻香']);
  f.$('#songSearch').value = '海阔天空';
  f.$('#songSearch').dispatchEvent(new f.w.CompositionEvent('compositionend'));
  assert.deepEqual(f.titles(), ['海闊天空']);
  assert.equal(f.phone.libraryPage, 1);
  f.input('in progress', true);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.titles(), ['海闊天空']);
});

test('remote paging counts all matches, and failed map/catalog loads retain usable behavior', async t => {
  const f = remoteFixture(t);
  await f.phone.loadLibrary();
  f.phone.jobs = Array.from({ length: 61 }, (_, i) => ({
    ...clone(fixtures.jobs[0]), id: 'song-' + i,
  }));
  f.input('dx');
  f.flush();
  assert.equal(f.titles().length, 24);
  assert.equal(f.$('#libraryCount').textContent, '61 / 61 首');
  assert.equal(f.$('#remotePager').hidden, false);
  f.$('#showMore').click();
  assert.equal(f.titles().length, 24);
  assert.equal(f.phone.libraryPage, 2);
  f.$('#showMore').click();
  assert.equal(f.titles().length, 13);
  assert.equal(f.$('#showMore').disabled, true);
  f.$('#showPrevious').click();
  assert.equal(f.phone.libraryPage, 2);
  f.fail(true, false);
  await f.phone.loadLibrary();
  f.input('海闊天空');
  f.flush();
  assert.deepEqual(f.titles(), ['海闊天空'], 'literal fallback survives map failure');
  f.input('haikuotiankong');
  f.flush();
  assert.deepEqual(f.titles(), ['海闊天空'], 'server phonetics survive map failure');
  const before = f.titles();
  f.fail(true, true);
  await f.phone.loadLibrary();
  assert.deepEqual(f.titles(), before);
  assert.match(f.$('#libraryStatus').textContent, /catalog offline/);
  assert.equal(f.$('#refreshLibrary').disabled, false);
  f.phone.renderLibrary();
  assert.match(f.$('#libraryStatus').textContent, /catalog offline/, 'other view updates cannot hide a catalog failure');
});

test('remote initial browsing preserves global search and selected-letter return', async t => {
  const f = remoteFixture(t);
  await f.phone.loadLibrary();
  f.$('#remoteIndex [data-letter="C"]').click();
  assert.deepEqual(f.titles(), ['重慶森林']);
  assert.equal(f.phone.libraryPage, 1);
  f.input('dx zjl');
  f.flush();
  assert.deepEqual(f.titles(), ['稻香']);
  assert.equal(f.$('#remoteAlphabet').hidden, true);
  f.input('');
  f.flush();
  assert.deepEqual(f.titles(), ['重慶森林']);
  assert.equal(f.$('#remoteAlphabet').hidden, false);
  f.$('#remoteIndex [data-letter=""]').click();
  assert.equal(f.titles().length, fixtures.jobs.length);
});

test('remote shows truthful personal play counts and keeps search independent of the ranking', async t => {
  const f = remoteFixture(t);
  await f.phone.loadLibrary();
  f.phone.account = { enabled: true, user: { id: 'account-a' } };
  let value = { account_id: 'account-a', songs: [
    { job_id: 'sea', play_count: 9, last_played_at: 1 },
    { job_id: 'rice', play_count: 2, last_played_at: 2 },
  ], history_limit: 500, total_plays: 11 };
  f.w.OpenKUserState = { libraryStats: async () => value };
  f.phone.renderLibrary();
  f.$('#libraryOrder').value = 'popular';
  f.$('#libraryOrder').dispatchEvent(new f.w.Event('change'));
  await f.phone.refreshPopularity();
  assert.deepEqual(f.titles(), ['海闊天空', '稻香']);
  assert.equal(f.$('.catalog-plays').textContent, '播放 9 次');
  assert.match(f.$('#remotePopularityNote').textContent, /非全网热度/);
  f.input('chongqing');
  f.flush();
  assert.deepEqual(f.titles(), ['重慶森林']);
  assert.equal(f.$('#remotePopularityNote').hidden, true);
  f.input('');
  f.flush();
  value = { ...value, songs: [], total_plays: 0 };
  await f.phone.refreshPopularity(true);
  assert.equal(f.titles().length, 0);
  assert.match(f.$('#libraryStatus').textContent, /还没有常唱记录/);
});
