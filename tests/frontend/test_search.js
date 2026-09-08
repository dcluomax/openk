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
  w.eval(fs.readFileSync(path.join(frontend, 'search.js'), 'utf8'));
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
  assert.equal(f.$('#showMore').hidden, true);
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
  f.phone.limit = 100;
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
  assert.equal(f.phone.limit, 50);
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
  assert.equal(f.titles().length, 50);
  assert.equal(f.$('#libraryCount').textContent, '61 / 61 首');
  assert.equal(f.$('#showMore').hidden, false);
  f.$('#showMore').click();
  assert.equal(f.titles().length, 61);
  assert.equal(f.$('#showMore').hidden, true);
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
});
