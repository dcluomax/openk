'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => JSON.parse(JSON.stringify(data)),
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function song(id, extra = {}) {
  return { id, state: 'done', title: `歌曲${id}`, track: `歌曲${id}`, artist: '歌手',
    duration: 180, line_count: 2, lyrics_status: 'ok',
    media: { instrumental: `/m/${id}.mp3`, vocals: `/m/${id}-v.mp3`, lyrics: `/l/${id}.json` },
    ...extra };
}

async function fixture(t, options = {}) {
  const dom = new JSDOM(html, { url: (options.origin || 'https://localhost') + (options.pathname || '/'),
    runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const f = { w, dom, jobs: [song('a'), song('b'), { id: 'p', title: '处理中', state: 'running', progress: 40 }],
    calls: [], plays: [], contexts: [], recorders: [], stops: [], streams: [], revoked: [],
    timeouts: new Map(), intervals: new Map(), frames: new Map(), hidden: false,
    uploadStatus: 200, micCalls: 0, playError: null, route: options.route };
  let timerId = 0, objectId = 0;
  const add = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...args) => { if (type !== 'DOMContentLoaded') add(type, ...args); };
  w.setTimeout = (fn, delay = 0) => { const id = ++timerId; f.timeouts.set(id, { fn, delay }); return id; };
  w.clearTimeout = (id) => f.timeouts.delete(id);
  w.setInterval = (fn, delay) => { const id = ++timerId; f.intervals.set(id, { fn, delay }); return id; };
  w.clearInterval = (id) => f.intervals.delete(id);
  w.requestAnimationFrame = (fn) => { const id = ++timerId; f.frames.set(id, fn); return id; };
  w.cancelAnimationFrame = (id) => f.frames.delete(id);
  Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => f.hidden });
  Object.defineProperty(w, 'isSecureContext', { configurable: true, value: true });
  const media = w.HTMLMediaElement.prototype;
  Object.defineProperties(media, {
    paused: { configurable: true, get() { return this._paused !== false; } },
    duration: { configurable: true, get() { return this._duration || 180; } },
    currentTime: { configurable: true, get() { return this._time || 0; }, set(value) { this._time = value; } },
    readyState: { configurable: true, get() { return 4; } },
    seeking: { configurable: true, get() { return false; } },
  });
  media.play = function () {
    f.plays.push(this.id);
    if (f.playError && this.id === 'instAudio') return Promise.reject(f.playError);
    this._paused = false;
    this.dispatchEvent(new w.Event('play'));
    this.dispatchEvent(new w.Event('playing'));
    return Promise.resolve();
  };
  media.pause = function () {
    const changed = !this.paused;
    this._paused = true;
    if (changed) this.dispatchEvent(new w.Event('pause'));
  };
  media.load = function () { this._time = 0; };
  w.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
  const param = (value = 1) => ({ value, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; } });
  const node = () => ({ connect() {}, disconnect() {}, gain: param(), frequency: param(1000),
    Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    fftSize: 2048, frequencyBinCount: 2048, stream: {}, getFloatFrequencyData(a) { a.fill(-120); } });
  w.AudioContext = function () {
    const context = { state: 'running', currentTime: 0, sampleRate: 48000, destination: node(),
      resume: async () => { context.state = 'running'; }, close: async () => { context.state = 'closed'; },
      createGain: node, createConvolver: node, createDynamicsCompressor: node,
      createBiquadFilter: node, createAnalyser: node, createMediaElementSource: node,
      createMediaStreamSource: node, createMediaStreamDestination: node,
      createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }) };
    f.contexts.push(context);
    return context;
  };
  f.makeStream = () => {
    const track = { stopped: 0, stop() { this.stopped++; } };
    const stream = { track, getTracks: () => [track] };
    f.streams.push(stream);
    return stream;
  };
  w.navigator.mediaDevices = { getUserMedia: () => {
    f.micCalls++;
    return options.mic ? options.mic(f) : Promise.resolve(f.makeStream());
  } };
  w.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() {
      this.mimeType = options.mimeType || 'audio/webm;codecs=opus';
      this.state = 'inactive';
      f.recorders.push(this);
    }
    start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      const finish = async () => {
        this.ondataavailable?.({ data: new w.Blob(['captured sound'], { type: this.mimeType }) });
        await this.onstop?.();
      };
      if (options.deferRecorderStop) f.stops.push(finish);
      else Promise.resolve().then(finish);
    }
  };
  w.URL.createObjectURL = () => 'blob:recording-' + ++objectId;
  w.URL.revokeObjectURL = (url) => f.revoked.push(url);
  w.alert = () => {};
  w.confirm = () => true;
  const prefs = { micMonitor: false, micVol: 110, howlGuard: true, reverb: 'ktv', singMode: 'inst', v: 2,
    ...options.prefs };
  w.localStorage.setItem('openk.prefs', JSON.stringify(prefs));
  Object.entries(options.storage || {}).forEach(([key, value]) => w.localStorage.setItem(key, value));
  w.fetch = async (url, request = {}) => {
    url = String(url);
    const call = { url, ...request };
    f.calls.push(call);
    if (f.route) {
      const custom = await f.route(url, request, f);
      if (custom !== undefined) return custom;
    }
    if (url === '/api/jobs') return response(f.jobs);
    if (url === '/api/zh-map') return response({ '夢': '梦' });
    if (url === '/api/local/status') return response({ enabled: false });
    // 独立部署：没有账号服务，曲库保持原来的本地播放行为
    if (url === '/api/account') return response(f.account ?? { enabled: false });
    if (/\/recordings(?:\?|$)/.test(url)) {
      return request.method === 'POST' ? response({ ok: true }, f.uploadStatus) : response([]);
    }
    if (/\/lyrics\/align$/.test(url)) {
      const jobId = url.split('/')[3];
      return response({ operation: { id: 'op-' + jobId, job_id: jobId, state: 'queued', message: '排队中' } }, 202);
    }
    if (url.startsWith('/api/operations/')) {
      const id = url.split('/').pop();
      return response({ id, job_id: id.replace('op-', ''), state: 'running', message: '对齐中' });
    }
    if (url.startsWith('/api/lyrics/search')) return response([]);
    const job = /^\/api\/jobs\/([^/]+)$/.exec(url);
    if (job) return response(f.jobs.find((j) => j.id === job[1]) || { detail: '任务不存在' },
      f.jobs.some((j) => j.id === job[1]) ? 200 : 404);
    const lyrics = /^\/l\/([^/.]+)\.json/.exec(url);
    if (lyrics) return response({ language: 'zh', source: lyrics[1], lines: [
      { start: 0, end: 10, text: `歌词${lyrics[1]}一`, words: [
        { text: '第一', start: 0, end: 1 }, { text: '句', start: 1, end: 10 }] },
      { start: 10, end: 20, text: `歌词${lyrics[1]}二`, words: [] },
    ] });
    throw new Error('Unexpected mock request: ' + url);
  };
  w.eval(fs.readFileSync(path.join(root, 'frontend/search.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'frontend/library.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'frontend/room-client.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'frontend/account.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'frontend/vendor/qrcode.js'), 'utf8'));
  w.eval(script + `\nwindow.__t = {
    state, api, prefs, init, selectJob, showBrowse, showStage, endPlayback, playFromQueue,
    startPolling, stopPolling, refreshList, renderBrowse, renderQueue, songInfo, addToQueue, deleteFailedJob,
    ensureMic, cleanupMic, applyMonitorState, startRecording, stopRecording, uploadRecording,
    renderLyrics, updateLyrics, enterLyricsEdit, exitLyricsEdit, loadRecordings, loadPlayerLyrics,
    saveLyricsEdit, doLyricSearch,
    openDrawer, closeDrawers, startPlayback, pausePlayback, seekTo, applyLyric, scheduleAlignment,
    renderAlignmentStatus, stopLyricAnimation, invalidateSelection,
    room, addToRoom, initAccount, accountMode, applyRoomState, libraryPopularity, refreshPopularity
  };`);
  f.a = w.__t;
  f.$ = (selector) => w.document.querySelector(selector);
  f.click = (selector) => f.$(selector).click();
  f.key = (target, key, code = key, extra = {}) => {
    const e = new w.KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(e);
    return e;
  };
  f.timer = async (id) => {
    const entry = f.timeouts.get(id);
    assert.ok(entry, `timer ${id} exists`);
    f.timeouts.delete(id);
    await entry.fn();
    await flush();
  };
  f.visibility = async (hidden) => {
    f.hidden = hidden;
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    await flush();
  };
  f.count = (url) => f.calls.filter((call) => call.url === url).length;
  f.a.init();
  await flush();
  t.after(async () => {
    await flush();
    f.a.state.disposed = true;
    f.a.stopPolling();
    f.a.cleanupMic();
    f.a.stopLyricAnimation();
    w.close();
  });
  return f;
}

test('device selectors use Chinese labels and explicit system-default feedback', async (t) => {
  const f = await fixture(t);
  assert.equal(f.w.document.documentElement.lang, 'zh-CN');
  assert.equal(f.$('#audioIn').getAttribute('aria-label'), '麦克风输入设备');
  assert.equal(f.$('#audioOut').getAttribute('aria-label'), '音频输出设备');
  assert.equal(f.$('#audioIn').options[0].textContent, '系统默认');
  assert.equal(f.$('#audioOut').options[0].textContent, '系统默认');
  assert.match(f.$('#deviceHint').textContent, /当前浏览器.*系统默认设备/);
});

test('latest selection wins even when an aborted detail request resolves last', async (t) => {
  const slow = deferred();
  const f = await fixture(t, { route: (url) => url === '/api/jobs/a' ? slow.promise : undefined });
  const first = f.a.selectJob('a');
  await flush();
  assert.equal(f.contexts.length, 1, 'audio is unlocked before the detail response');
  const request = f.calls.find((c) => c.url === '/api/jobs/a');
  await f.a.selectJob('b');
  slow.resolve(response(song('a')));
  await first;
  assert.equal(request.signal.aborted, true);
  assert.equal(f.a.state.currentJobId, 'b');
  assert.equal(f.$('#instAudio').getAttribute('src'), '/m/b.mp3');
  assert.equal(f.$('#nbTitle').textContent, '歌曲b');
});

test('focused polling is single-flight, skips catalog ticks, and never replaces playback', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  const initial = f.count('/api/jobs');
  f.a.startPolling('p');
  await f.timer(f.a.state.pollTimer);
  await f.timer(f.a.state.pollTimer);
  assert.equal(f.count('/api/jobs'), initial);
  assert.equal(f.a.state.currentJobId, 'a');
  const pending = deferred();
  f.route = (url) => url === '/api/jobs/p' ? pending.promise : undefined;
  const tick = f.timer(f.a.state.pollTimer);
  await flush();
  assert.equal(f.a.state.pollTimer, null, 'no next timer while request is pending');
  assert.ok(f.a.state.pollRequest);
  const completed = song('p');
  f.jobs[2] = completed;
  pending.resolve(response(completed));
  await tick;
  assert.equal(f.count('/api/jobs'), initial + 1);
  assert.equal(f.a.state.inspectedJobId, null);
  assert.equal(f.a.state.currentJobId, 'a');
  assert.equal(f.$('#instAudio').getAttribute('src'), '/m/a.mp3');
});

test('stopped focused polls cannot commit a late completion', async (t) => {
  const slow = deferred();
  const f = await fixture(t, { route: (url) => url === '/api/jobs/p' ? slow.promise : undefined });
  f.a.startPolling('p');
  const initial = f.count('/api/jobs');
  const tick = f.timer(f.a.state.pollTimer);
  await flush();
  f.a.stopPolling();
  slow.resolve(response(song('p')));
  await tick;
  assert.equal(f.count('/api/jobs'), initial);
  assert.equal(f.a.state.pollTimer, null);
});

test('deleted inspected jobs stop polling without stopping the current song', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.route = (url) => url === '/api/jobs/p' ? response({ detail: '任务不存在' }, 404) : undefined;
  f.a.startPolling('p');
  await f.timer(f.a.state.pollTimer);
  assert.equal(f.a.state.pollTimer, null);
  assert.equal(f.a.state.inspectedJobId, null);
  assert.equal(f.$('#instAudio').paused, false);
});

async function failedJobFixture(t) {
  const f = await fixture(t);
  f.jobs[2] = { ...f.jobs[2], state: 'error', title: '失败的制作任务' };
  await f.a.refreshList(true);
  return f;
}

test('failed-task deletion is confirmed and unavailable for running or completed songs', async (t) => {
  const f = await failedJobFixture(t);
  let confirmations = 0;
  f.w.confirm = message => {
    confirmations++;
    assert.match(message, /失败的制作任务/);
    assert.match(message, /不会删除导入目录中的原文件/);
    assert.match(message, /无法撤销/);
    return false;
  };
  assert.equal(f.w.document.querySelectorAll('#procList [data-act="delete"]').length, 1);
  f.click('#procList [data-act="delete"]');
  await flush();
  assert.equal(confirmations, 1);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(f.$('#adminBadge').textContent, '1');
  assert.equal(f.a.state.deletingJobs.size, 0);
  f.jobs[2].state = 'running';
  f.a.state.allJobs.find(job => job.id === 'p').state = 'running';
  await f.a.deleteFailedJob('p');
  await f.a.deleteFailedJob('a');
  assert.equal(confirmations, 1, 'stale actions cannot request confirmation or deletion');
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(f.$('#procList [data-act="delete"]'), null);
  f.jobs[2].state = 'cancelled';
  await f.a.refreshList(true);
  assert.ok(f.$('#procList [data-act="delete"]'));
  assert.equal(f.$('#procList [data-act="retry"]'), null);
  assert.match(f.$('#procList .p-msg').textContent, /已取消/);
});

test('inspecting a cancelled task stops after one terminal poll and retains its delete control', async (t) => {
  const f = await failedJobFixture(t);
  f.jobs[2] = { ...f.jobs[2], state: 'cancelled', message: '任务已取消' };
  await f.a.refreshList(true);
  const lists = f.count('/api/jobs');
  f.click('#procList [data-act="inspect"]');
  await f.timer(f.a.state.pollTimer);
  assert.equal(f.count('/api/jobs/p'), 1);
  assert.equal(f.count('/api/jobs'), lists + 1);
  assert.equal(f.a.state.inspectedJobId, null);
  assert.equal(f.a.state.pollTimer, null);
  assert.equal(f.a.state.pollRequest, null);
  assert.equal(f.$('#progressPanel').classList.contains('hidden'), false);
  assert.equal(f.$('#progressPanel').dataset.jobId, 'p');
  assert.ok(f.$('#procList [data-act="delete"]'));
  assert.match(f.$('#toast').textContent, /任务已取消，可在后台删除/);
});

test('failed-task deletion fences stale polls and catalog replies without touching playback', async (t) => {
  const f = await failedJobFixture(t);
  await f.a.addToQueue('a');
  await f.a.addToQueue('b');
  await flush();
  await f.a.ensureMic();
  f.$('#instAudio').currentTime = 42;
  const queue = JSON.stringify(f.a.state.queue), plays = f.plays.length;
  const oldJobs = f.jobs.slice(), catalog = deferred(), inspected = deferred(), deletion = deferred();
  let catalogCalls = 0, confirmations = 0;
  f.w.confirm = () => { confirmations++; return true; };
  f.route = (url, request) => {
    if (url === '/api/jobs' && catalogCalls++ === 0) return catalog.promise;
    if (url === '/api/jobs/p') return inspected.promise;
    if (url === '/api/jobs/p?failed_only=true') {
      assert.equal(request.method, 'DELETE');
      return deletion.promise;
    }
  };
  f.click('#procList [data-act="inspect"]');
  const polling = f.timer(f.a.state.pollTimer);
  await flush();
  const listing = f.a.refreshList();
  const removing = f.a.deleteFailedJob('p');
  await f.a.deleteFailedJob('p');
  assert.equal(confirmations, 1);
  assert.equal(f.count('/api/jobs/p?failed_only=true'), 1);
  assert.equal(f.$('#procList [data-act="delete"]').disabled, true);
  assert.equal(f.$('#procList [data-act="retry"]').disabled, true);
  f.jobs = f.jobs.filter(job => job.id !== 'p');
  deletion.resolve(response({ ok: true }));
  await flush();
  assert.equal(f.a.state.inspectedJobId, null);
  assert.equal(f.$('#progressPanel').classList.contains('hidden'), true);
  catalog.resolve(response(oldJobs));
  await listing;
  await removing;
  inspected.resolve(response(song('p')));
  await polling;
  assert.equal(catalogCalls, 2, 'a pre-delete list cannot replace the post-delete catalog');
  assert.equal(f.a.state.allJobs.some(job => job.id === 'p'), false);
  assert.equal(f.$('#procList').children.length, 0);
  assert.equal(f.$('#adminBadge').textContent, '0');
  assert.equal(f.$('#adminBadge').classList.contains('hidden'), true);
  assert.equal(f.a.state.currentJobId, 'a');
  assert.equal(f.$('#instAudio').paused, false);
  assert.equal(f.$('#instAudio').currentTime, 42);
  assert.equal(f.plays.length, plays);
  assert.equal(JSON.stringify(f.a.state.queue), queue);
  assert.ok(f.streams.length > 0);
  assert.ok(f.streams.every(stream => stream.track.stopped === 0));
});

test('failed-task deletion reports errors, retains the row and allows an explicit retry', async (t) => {
  const f = await failedJobFixture(t);
  const alerts = [];
  f.w.alert = message => alerts.push(message);
  f.route = url => url === '/api/jobs/p?failed_only=true'
    ? response({ detail: '暂时无法删除，请重试' }, 503) : undefined;
  await f.a.deleteFailedJob('p');
  assert.deepEqual(alerts, ['暂时无法删除，请重试']);
  assert.ok(f.a.state.allJobs.some(job => job.id === 'p'));
  assert.equal(f.$('#procList [data-act="delete"]').disabled, false);
  assert.equal(f.$('#adminBadge').textContent, '1');
  f.route = url => {
    if (url === '/api/jobs/p?failed_only=true') {
      f.jobs = f.jobs.filter(job => job.id !== 'p');
      return response({ ok: true });
    }
  };
  f.click('#procList [data-act="delete"]');
  await flush();
  assert.equal(f.a.state.allJobs.some(job => job.id === 'p'), false);
  assert.equal(f.a.state.deletingJobs.size, 0);
});

test('a stale failed-task delete refreshes the retried state rather than removing it', async (t) => {
  const f = await failedJobFixture(t);
  const alerts = [];
  f.w.alert = message => alerts.push(message);
  f.route = url => {
    if (url === '/api/jobs/p?failed_only=true') {
      f.jobs[2] = { ...f.jobs[2], state: 'queued', message: '已重新加入队列' };
      return response({ detail: '任务仍在处理或已完成，只能删除失败或已取消的任务' }, 409);
    }
  };
  await f.a.deleteFailedJob('p');
  assert.match(alerts[0], /只能删除失败/);
  assert.equal(f.a.state.allJobs.find(job => job.id === 'p').state, 'queued');
  assert.equal(f.$('#procList [data-act="delete"]'), null);
  assert.equal(f.$('#adminBadge').textContent, '1');
});

test('an already-removed task closes only its own progress panel and updates the badge', async (t) => {
  const f = await failedJobFixture(t);
  f.click('#procList [data-act="inspect"]');
  await f.timer(f.a.state.pollTimer);
  assert.equal(f.a.state.inspectedJobId, null, 'terminal polls stop before deletion');
  assert.equal(f.$('#progressPanel').classList.contains('hidden'), false);
  f.route = url => {
    if (url === '/api/jobs/p?failed_only=true') {
      f.jobs = f.jobs.filter(job => job.id !== 'p');
      return response({ detail: '任务不存在' }, 404);
    }
  };
  await f.a.deleteFailedJob('p');
  assert.equal(f.$('#progressPanel').classList.contains('hidden'), true);
  assert.equal(f.$('#adminBadge').classList.contains('hidden'), true);
  assert.match(f.$('#toast').textContent, /任务已不存在/);
});

test('deleting a different failed task preserves the currently inspected task', async (t) => {
  const f = await failedJobFixture(t);
  f.jobs.push({ id: 'other', title: '另一个任务', state: 'running', progress: 10 });
  await f.a.refreshList(true);
  f.click('#procList [data-id="other"] [data-act="inspect"]');
  const generation = f.a.state.pollGeneration;
  f.route = url => {
    if (url === '/api/jobs/p?failed_only=true') {
      f.jobs = f.jobs.filter(job => job.id !== 'p');
      return response({ ok: true });
    }
  };
  await f.a.deleteFailedJob('p');
  assert.equal(f.a.state.inspectedJobId, 'other');
  assert.equal(f.a.state.pollGeneration, generation);
  assert.equal(f.$('#progressPanel').classList.contains('hidden'), false);
  assert.equal(f.$('#progressPanel').dataset.jobId, 'other');
});

test('late lyrics and recordings do not overwrite a newly selected song', async (t) => {
  const lyrics = deferred(), recordings = deferred();
  const f = await fixture(t, { route: (url) => {
    if (url === '/l/a.json') return lyrics.promise;
    if (url === '/api/jobs/a/recordings') return recordings.promise;
  } });
  const first = f.a.selectJob('a');
  await flush();
  await f.a.selectJob('b');
  lyrics.resolve(response({ source: 'old-A', lines: [] }));
  recordings.resolve(response([{ url: '/old-recording.webm', file: 'old.webm' }]));
  await first;
  await flush();
  assert.equal(f.a.state.lyrics.source, 'b');
  assert.equal(f.$('#recList').children.length, 0);
  assert.equal(f.$('#lyricSource').textContent, '歌词来源：b');
});

test('inspecting a pending song leaves current lyric loading and playback intact', async (t) => {
  const slow = deferred();
  const f = await fixture(t, { route: (url) => url === '/l/a.json' ? slow.promise : undefined });
  const playing = f.a.selectJob('a');
  await flush();
  const generation = f.a.state.selectionGeneration;
  await f.a.selectJob('p');
  assert.equal(f.a.state.selectionGeneration, generation);
  assert.equal(f.a.state.currentJobId, 'a');
  assert.equal(f.a.state.inspectedJobId, 'p');
  slow.resolve(response({ source: 'a', lines: [{ start: 0, end: 10, text: '继续唱' }] }));
  await playing;
  assert.equal(f.a.state.lyrics.source, 'a');
  assert.equal(f.$('#instAudio').paused, false);
});

test('late lyric-edit save and search results cannot change the next song', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  const saved = deferred(), searched = deferred();
  f.a.api.updateLyrics = () => saved.promise;
  f.a.api.searchLyrics = () => searched.promise;
  f.a.enterLyricsEdit();
  f.$('.lyric-edit').value = '修改后的歌词';
  const saving = f.a.saveLyricsEdit();
  f.$('#lsQuery').value = '歌手 歌曲a';
  const searching = f.a.doLyricSearch();
  await f.a.selectJob('b');
  saved.resolve({ ok: true });
  searched.resolve([{ id: 55, trackName: '旧结果', synced: true }]);
  await Promise.all([saving, searching]);
  assert.equal(f.a.state.lyrics.source, 'b');
  assert.equal(f.a.state.editing, false);
  assert.doesNotMatch(f.$('#lsResults').textContent, /旧结果/);
});

test('manual lyric save resolves the newly published immutable lyric URL', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.route = (url, request) => {
    if (url === '/api/jobs/a/lyrics' && request.method === 'PUT') {
      f.jobs[0].media.lyrics = '/l/a-v2.json';
      return response({ ok: true, lyrics_file: 'artifacts/v2/lyrics.json' });
    }
  };
  f.a.enterLyricsEdit();
  f.$('.lyric-edit').value = '新的歌词';
  await f.a.saveLyricsEdit();
  assert.equal(f.a.state.lyricsUrl, '/l/a-v2.json');
  assert.equal(f.a.state.lyrics.source, 'a-v2');
  assert.equal(f.calls.some((c) => c.url.startsWith('/l/a.json?')), false);
});

test('lyric editor exposes precise timings and keeps playback running while drafting', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.$('#instAudio').currentTime = 5.125;
  const source = JSON.stringify(f.a.state.lyrics), captures = f.micCalls;
  f.click('#editLyrics');
  assert.equal(f.$('[data-time="start"]').value, '00:00.000');
  assert.equal(f.$('[data-time="end"]').value, '00:10.000');
  assert.equal(f.$('#lyricEditPosition').textContent, '00:05.125');
  assert.equal(f.$('#playerControls').classList.contains('hidden'), true);
  assert.equal(f.$('#lyrics').classList.contains('is-editing'), true);
  assert.equal(f.$('#instAudio').paused, false);
  f.$('#lyricOffset').value = '12.5';
  f.click('#applyLyricOffset');
  assert.equal(f.$('[data-time="start"]').value, '00:12.500');
  assert.equal(f.$('[data-time="end"]').value, '00:22.500');
  assert.equal(f.w.document.querySelectorAll('[data-time="start"]')[1].value, '00:22.500');
  assert.equal(JSON.stringify(f.a.state.lyrics), source, 'the live lyrics remain unchanged until save');
  f.key(f.$('[data-time="start"]'), ' ', 'Space');
  assert.equal(f.$('#instAudio').paused, false, 'time inputs do not trigger playback shortcuts');
  assert.equal(f.micCalls, captures);
  assert.equal(f.$('#nowbar').classList.contains('hidden'), true, 'duplicate dock cannot cover timing controls');
  f.a.showBrowse();
  assert.equal(f.$('#nowbar').classList.contains('hidden'), false, 'browsing retains transport while a draft is open');
  f.a.showStage();
  assert.equal(f.$('#nowbar').classList.contains('hidden'), true);
  f.click('#cancelLyrics');
  assert.equal(f.a.state.editing, false);
  assert.equal(JSON.stringify(f.a.state.lyrics), source);
  assert.equal(f.$('#playerControls').classList.contains('hidden'), false);
  assert.equal(f.$('#nowbar').classList.contains('hidden'), false);
});

test('an arbitrary lyric line anchors the whole song and shifts exact word timing', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.a.state.lyrics.lines[0] = { start: 0, end: 8, text: 'hello world',
    words: [{ text: 'hello', start: 0.25, end: 1.25 }, { text: 'world', start: 4, end: 7.5 }] };
  f.a.state.lyrics.lines[1] = { start: 10, end: 18, text: 'second line',
    words: [{ text: 'second', start: 10.5, end: 12 }, { text: 'line', start: 15, end: 17.5 }] };
  f.a.renderLyrics();
  f.click('#editLyrics');
  f.$('#instAudio').currentTime = 22.375;
  f.w.document.querySelectorAll('[data-action="all"]')[1].click();
  assert.equal(f.$('[data-time="start"]').value, '00:12.375');
  assert.equal(f.w.document.querySelectorAll('[data-time="start"]')[1].value, '00:22.375');
  let payload;
  f.a.api.updateLyrics = async (job, data) => { assert.equal(job, 'a'); payload = data; return { ok: true }; };
  await f.a.saveLyricsEdit();
  assert.equal(payload.base_lyrics_url, '/l/a.json');
  assert.equal(payload.lines[0].start, 12.375);
  assert.equal(payload.lines[0].end, 20.375);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.lines[0].words)), [
    { text: 'hello', start: 12.625, end: 13.625 }, { text: 'world', start: 16.375, end: 19.875 },
  ]);
  assert.equal(payload.lines[1].words[0].start, 22.875);
});

test('manual line bounds stretch words, single-line alignment leaves other lines alone, and reset keeps text', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.click('#editLyrics');
  f.$('#instAudio').currentTime = 2.5;
  f.click('[data-action="line"]');
  assert.equal(f.$('[data-time="start"]').value, '00:02.500');
  assert.equal(f.$('[data-time="end"]').value, '00:12.500');
  assert.equal(f.w.document.querySelectorAll('[data-time="start"]')[1].value, '00:10.000');
  f.$('.lyric-edit').value = 'Changed text';
  f.click('#resetLyricTiming');
  assert.equal(f.$('[data-time="start"]').value, '00:00.000');
  assert.equal(f.$('.lyric-edit').value, 'Changed text');
  f.$('[data-time="start"]').value = '2.5';
  f.$('[data-time="end"]').value = '00:07.500';
  let payload;
  f.a.api.updateLyrics = async (job, data) => { payload = data; return { ok: true }; };
  await f.a.saveLyricsEdit();
  assert.equal(payload.lines[0].words[0].start, 2.5);
  assert.equal(payload.lines[0].words[0].end, 3);
  assert.equal(payload.lines[0].words[1].start, 3);
  assert.equal(payload.lines[0].words[1].end, 7.5);
  assert.equal(payload.lines[0].text, 'Changed text');
  assert.equal(payload.lines[1].start, 10);
});

test('invalid lyric times and out-of-range offsets are visible and never saved or partially applied', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  let saves = 0;
  f.a.api.updateLyrics = async () => { saves++; return { ok: true }; };
  f.click('#editLyrics');
  for (const value of ['', '-1', '1:60', 'Infinity', '00:00.1234', '11', '181']) {
    f.$('[data-time="start"]').value = value;
    await f.a.saveLyricsEdit();
    assert.equal(saves, 0, value);
    assert.equal(f.$('#lyricTimingNotice').classList.contains('error'), true, value);
    assert.equal(f.a.state.editing, true);
    f.click('#resetLyricTiming');
  }
  for (const delta of ['-0.1', '200']) {
    f.$('#lyricOffset').value = delta;
    f.click('#applyLyricOffset');
    assert.equal(f.$('[data-time="start"]').value, '00:00.000');
    assert.equal(f.w.document.querySelectorAll('[data-time="start"]')[1].value, '00:10.000');
    assert.equal(f.$('#lyricTimingNotice').classList.contains('error'), true);
  }
  f.click('#resetLyricTiming');
  f.click('[data-lyric-shift="0.1"]');
  f.click('[data-lyric-shift="-0.1"]');
  assert.equal(f.$('[data-time="start"]').value, '00:00.000');
  f.$('[data-time="end"]').value = '181';
  await f.a.saveLyricsEdit();
  assert.match(f.$('#lyricTimingNotice').textContent, /歌曲时长/);
  assert.equal(saves, 0);
});

test('lyric timing errors preserve the draft and late saves cannot close a replacement editor', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.click('#editLyrics');
  f.$('[data-time="start"]').value = '1.125';
  f.a.api.updateLyrics = async () => { throw new Error('歌词已被其他设备更新，请取消编辑'); };
  await f.a.saveLyricsEdit();
  assert.equal(f.$('[data-time="start"]').value, '1.125');
  assert.equal(f.$('#saveLyrics').disabled, false);
  assert.match(f.$('#lyricTimingNotice').textContent, /其他设备更新/);
  const pending = deferred();
  let saves = 0;
  f.a.api.updateLyrics = () => { saves++; return pending.promise; };
  const saving = f.a.saveLyricsEdit();
  await f.a.saveLyricsEdit();
  assert.equal(saves, 1);
  assert.equal(f.$('[data-time="start"]').disabled, true);
  f.a.exitLyricsEdit();
  f.a.enterLyricsEdit();
  f.$('.lyric-edit').value = 'New draft';
  pending.resolve({ ok: true });
  await saving;
  assert.equal(f.a.state.editing, true);
  assert.equal(f.$('.lyric-edit').value, 'New draft');
});

test('lyric preview uses the edited timestamp and current-time markers require the real local player', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.a.pausePlayback();
  f.click('#editLyrics');
  f.$('[data-time="start"]').value = '4.125';
  f.click('[data-action="preview"]');
  await flush();
  assert.equal(f.$('#instAudio').currentTime, 3.125);
  assert.equal(f.$('#instAudio').paused, false);
  f.$('#lyricEditSeek').value = '500';
  f.$('#lyricEditSeek').dispatchEvent(new f.w.Event('input', { bubbles: true }));
  assert.equal(f.$('#instAudio').currentTime, 90);
  assert.equal(f.$('#lyricEditPosition').textContent, '01:30.000');
  f.a.room.account = { enabled: true, user: { id: 'another-account' } };
  f.a.room.armed = false;
  f.$('#instAudio').dispatchEvent(new f.w.Event('timeupdate'));
  assert.equal(f.$('[data-action="all"]').disabled, true);
  assert.equal(f.$('#lyricEditPosition').textContent, '本机未播放');
  assert.equal(f.$('[data-time="start"]').disabled, false, 'manual input remains available');
});

test('manual selection and replay cancel automatic next-song timers', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.a.state.queue = ['b'];
  f.$('#instAudio').dispatchEvent(new f.w.Event('ended'));
  const stale = f.timeouts.get(f.a.state.endedTimer).fn;
  await f.a.selectJob('b');
  stale();
  await flush();
  assert.equal(f.a.state.currentJobId, 'b');
  assert.equal(f.a.state.queue.length, 1);
  f.$('#instAudio').dispatchEvent(new f.w.Event('ended'));
  const timer = f.a.state.endedTimer;
  f.a.seekTo(0);
  assert.equal(f.timeouts.has(timer), false);
});

test('recording is saved under its captured song after next-song selection', async (t) => {
  const f = await fixture(t, { deferRecorderStop: true });
  await f.a.selectJob('a');
  await f.a.startRecording();
  assert.equal(f.a.state.recording, true);
  assert.equal(f.recorders[0].timeslice, 1000);
  await f.a.selectJob('b');
  assert.equal(f.stops.length, 1);
  await f.stops[0]();
  const upload = f.calls.find((c) => c.method === 'POST' && c.url.includes('/recordings?'));
  assert.match(upload.url, /^\/api\/jobs\/a\/recordings\?/);
  assert.equal(f.$('#nbTitle').textContent, '歌曲b');
  assert.notEqual(f.$('#recStatus').textContent, '已保存 ✓', 'old save does not replace new song status');
});

test('ending playback still uploads the captured recording after current ID is cleared', async (t) => {
  const f = await fixture(t, { deferRecorderStop: true });
  await f.a.selectJob('a');
  await f.a.startRecording();
  f.a.endPlayback();
  assert.equal(f.a.state.currentJobId, null);
  await f.stops[0]();
  assert.ok(f.calls.some((c) => c.method === 'POST' && c.url.startsWith('/api/jobs/a/recordings?')));
});

test('recording duration is session-local and duplicate stop delivery does not upload twice', async (t) => {
  const f = await fixture(t, { deferRecorderStop: true });
  let now = 1000;
  f.w.Date.now = () => now;
  await f.a.selectJob('a');
  await f.a.startRecording();
  const original = f.a.state.recordingSession;
  now = 6000;
  f.a.stopRecording();
  now = 9000;
  await f.a.startRecording();
  await f.stops[0]();
  await f.stops[0]();
  assert.equal(original.duration, 5);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(f.a.state.recording, true);
  f.a.stopRecording();
  await f.stops[1]();
});

test('switching songs during microphone authorization never starts a stale recording', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { mic: () => permission.promise });
  await f.a.selectJob('a');
  const recording = f.a.startRecording();
  await flush();
  await f.a.selectJob('b');
  const stream = f.makeStream();
  permission.resolve(stream);
  await recording;
  assert.equal(f.recorders.length, 0);
  assert.equal(f.a.state.currentJobId, 'b');
  assert.equal(stream.track.stopped, 1);
  assert.equal(f.$('#recBtn').disabled, false);
});

test('HTTP failure retains MP4 recording, exposes download, and retry is single-flight', async (t) => {
  const f = await fixture(t, { mimeType: 'audio/mp4', deferRecorderStop: true });
  await f.a.selectJob('a');
  await f.a.startRecording();
  f.uploadStatus = 503;
  f.a.stopRecording();
  await f.stops[0]();
  assert.equal(f.a.state.pendingRecordings.size, 1);
  assert.match(f.$('#recStatus').textContent, /保存失败/);
  const session = [...f.a.state.pendingRecordings.values()][0];
  const upload = f.calls.find((c) => c.method === 'POST');
  assert.equal(upload.headers['Content-Type'], 'audio/mp4');
  assert.ok(session.blob.size > 0);
  assert.match(f.$('#pendingRecordings a').download, /\.m4a$/);
  const retry = deferred();
  f.route = (url, request) => request.method === 'POST' ? retry.promise : undefined;
  const first = f.a.uploadRecording(session), second = f.a.uploadRecording(session);
  assert.equal(first, second);
  await flush();
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 2);
  retry.resolve(response({ ok: true }));
  await first;
  assert.equal(f.a.state.pendingRecordings.size, 0);
  assert.equal(f.$('#recStatus').textContent, '已保存 ✓');
  assert.equal(f.revoked.length, 1);
});

test('recording start is single-flight while waiting for microphone permission', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { mic: () => permission.promise });
  await f.a.selectJob('a');
  const first = f.a.startRecording(), second = f.a.startRecording();
  await flush();
  assert.equal(f.micCalls, 1);
  permission.resolve(f.makeStream());
  await Promise.all([first, second]);
  assert.equal(f.recorders.length, 1);
  assert.equal(f.a.state.recording, true);
  f.a.stopRecording();
  await flush();
});

test('finishing an old upload cannot cancel a new recording microphone request', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { deferRecorderStop: true,
    mic: (app) => app.micCalls === 1 ? Promise.resolve(app.makeStream()) : permission.promise });
  await f.a.selectJob('a');
  await f.a.startRecording();
  f.a.stopRecording();
  const starting = f.a.startRecording();
  await flush();
  await f.stops[0]();
  assert.ok(f.a.state.micRequest);
  permission.resolve(f.makeStream());
  await starting;
  assert.equal(f.a.state.recording, true);
  f.a.stopRecording();
  await f.stops[1]();
});

test('microphone requests are shared and a late cancelled stream is stopped', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { mic: () => permission.promise });
  const first = f.a.ensureMic().catch((e) => e), second = f.a.ensureMic().catch((e) => e);
  await flush();
  assert.equal(f.micCalls, 1);
  f.a.cleanupMic();
  const stream = f.makeStream();
  permission.resolve(stream);
  const results = await Promise.all([first, second]);
  await flush();
  assert.equal(results[0].name, 'AbortError');
  assert.equal(results[1].name, 'AbortError');
  assert.equal(stream.track.stopped, 1);
  assert.equal(f.a.state.audioGraph.mic, null);
});

test('microphone authorization timeout releases a subsequently returned stream', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { mic: () => permission.promise });
  const attempt = f.a.ensureMic().catch((e) => e);
  await flush();
  const [timer] = [...f.timeouts.entries()].reverse().find(([, entry]) => entry.delay > 14000 && entry.delay <= 15000);
  await f.timer(timer);
  assert.match((await attempt).message, /超时/);
  const stream = f.makeStream();
  permission.resolve(stream);
  await flush();
  assert.equal(stream.track.stopped, 1);
  assert.equal(f.a.state.micRequest, null);
});

test('recording preparation reports pending permission and recovers without a blocking alert', async (t) => {
  const permission = deferred();
  const f = await fixture(t, { mic: () => permission.promise });
  await f.a.selectJob('a');
  let alerts = 0;
  f.w.alert = () => { alerts++; };
  const recording = f.a.startRecording();
  await flush();
  assert.equal(f.$('#recBtn').textContent, '准备录音…');
  assert.match(f.$('#recStatus').textContent, /连接麦克风/);
  const [timer] = [...f.timeouts.entries()].reverse().find(([, entry]) => entry.delay > 14000 && entry.delay <= 15000);
  await f.timer(timer);
  await recording;
  assert.equal(f.$('#recBtn').disabled, false);
  assert.equal(f.$('#recBtn').textContent, '🎤 开始录唱');
  assert.match(f.$('#recStatus').textContent, /超时/);
  assert.equal(alerts, 0);
  permission.resolve(f.makeStream());
  await flush();
});

test('microphone acquisition also bounds a suspended AudioContext resume', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.a.state.audioGraph.actx.state = 'suspended';
  f.a.state.audioGraph.actx.resume = () => new Promise(() => {});
  const recording = f.a.startRecording();
  await flush();
  const [timer] = [...f.timeouts.entries()].reverse().find(([, entry]) => entry.delay === 8000);
  await f.timer(timer);
  await recording;
  assert.equal(f.$('#recBtn').disabled, false);
  assert.match(f.$('#recStatus').textContent, /音频引擎启动超时/);
  assert.equal(f.micCalls, 0);
  assert.equal(f.a.state.micRequest, null);
});

test('hidden page mutes monitoring, preserves recording, and requires explicit safe restore', async (t) => {
  const f = await fixture(t, { prefs: { micMonitor: true } });
  await f.a.selectJob('a');
  await flush();
  await f.a.startRecording();
  assert.ok(f.a.state.audioGraph.monitorGain.gain.value > 0);
  await f.visibility(true);
  assert.equal(f.a.state.audioGraph.monitorGain.gain.value, 0);
  assert.equal(f.a.state.audioGraph.howl.raf, 0);
  assert.equal(f.a.state.recording, true);
  await f.visibility(false);
  assert.equal(f.a.state.audioGraph.monitorGain.gain.value, 0);
  assert.equal(f.$('#resumeMonitor').classList.contains('hidden'), false);
  f.click('#resumeMonitor');
  await flush();
  assert.ok(f.a.state.audioGraph.monitorGain.gain.value > 0);
  f.a.stopRecording();
  await flush();
});

test('metadata, no-lyrics badges, artist groups and language counts invalidate together', async (t) => {
  const f = await fixture(t);
  f.jobs = [song('a', { track: '旧歌名', artist: '旧歌手', line_count: 0, lyrics_status: 'none' })];
  await f.a.refreshList();
  assert.ok(f.$('.sr-nolrc'));
  assert.equal(f.$('.song-row').children.length, 7, 'artwork has a column; the badge does not');
  assert.ok(f.$('.sr-name .sr-nolrc'), 'no-lyrics badge stays inside the title cell');
  f.jobs = [song('a', { track: '新歌名', artist: '新歌手' }), song('b')];
  await f.a.refreshList();
  assert.equal(f.$('.sr-nolrc'), null);
  assert.match(f.$('#songList').textContent, /新歌名/);
  assert.doesNotMatch(f.$('#songList').textContent, /旧歌名/);
  assert.match(f.$('#langBar').textContent, /国语 2/);
  f.click('[data-tab="artist"]');
  assert.match(f.$('#artistList').textContent, /新歌手/);
  f.jobs[0].artist = '另一歌手';
  await f.a.refreshList();
  assert.match(f.$('#artistList').textContent, /另一歌手/);
});

test('list artwork loads lazily, falls back locally, and preserves song actions', async (t) => {
  const f = await fixture(t);
  f.jobs = [song('a', { thumbnail: '/media/a/cover.png', track: '封面测试' })];
  await f.a.refreshList();
  const image = f.$('.sr-artwork img');
  assert.equal(image.loading, 'lazy');
  assert.equal(image.decoding, 'async');
  assert.equal(image.referrerPolicy, 'no-referrer');
  assert.equal(image.width, 44);
  assert.equal(image.height, 44);
  assert.equal(image.alt, '');
  image.dispatchEvent(new image.ownerDocument.defaultView.Event('error'));
  assert.equal(f.$('.sr-artwork img'), null);
  assert.ok(f.$('.sr-artwork use[href="#icon-note"]'));
  assert.match(f.$('.sr-title').textContent, /封面测试/);
  f.click('.sr-artwork');
  await flush();
  assert.equal(f.a.state.currentJobId, 'a');
});

test('classic search ranks names, combines global terms, and clears the stale artist count label', async (t) => {
  const f = await fixture(t, { route: url => url === '/api/zh-map'
    ? response({ '夢': '梦', '倫': '伦' }) : undefined });
  const indexed = (id, track, artist, full, initials, artistFull, artistInitials) => song(id, {
    track, title: track, artist,
    search_index: { v: 1, f: [[track, [full], [initials]], [artist, [artistFull], [artistInitials]],
      [track, [full], [initials]]] },
  });
  f.jobs = [
    indexed('substring', '稻香现场版', '翻唱', 'daoxiangxianchangban', 'dxxcb', 'fanchang', 'fc'),
    indexed('artist', '另一首歌', '稻香', 'lingyishouge', 'lysg', 'daoxiang', 'dx'),
    indexed('exact', '稻香', '周杰伦', 'daoxiang', 'dx', 'zhoujielun', 'zjl'),
    indexed('youth', '少年', '夢然', 'shaonian', 'sn', 'mengran', 'mr'),
  ];
  await f.a.refreshList();
  const rows = () => [...f.w.document.querySelectorAll('.song-row')].map(el => el.dataset.id);
  const input = value => {
    f.$('#search').value = value;
    f.$('#search').dispatchEvent(new f.w.InputEvent('input', { bubbles: true }));
  };
  const original = rows();
  input('稻香');
  assert.deepEqual(rows(), ['exact', 'artist', 'substring']);
  input('');
  assert.deepEqual(rows(), original);
  f.click('[data-tab="artist"]');
  f.click('[data-artist="梦然"]');
  assert.match(f.$('#browseCount').textContent, /夢然/);
  input('稻香 周杰倫');
  assert.deepEqual(rows(), ['exact']);
  assert.equal(f.$('#browseCount').textContent, '1 首');
  input('zhou jie lun dao xiang');
  assert.deepEqual(rows(), ['exact']);
  input('dx zjl');
  assert.deepEqual(rows(), ['exact']);
  input('zzz-no-song');
  assert.deepEqual(rows(), []);
  assert.equal(f.$('#browseCount').textContent, '0 首');
  assert.match(f.$('#browseEmpty').textContent, /zzz-no-song/);
  input('ZZZ NO SONG');
  assert.match(f.$('#browseEmpty').textContent, /ZZZ NO SONG/);
  f.click('#searchClear');
  assert.deepEqual(rows(), ['youth']);
  assert.match(f.$('#browseCount').textContent, /夢然 · 1 首/);
  assert.equal(f.w.document.activeElement, f.$('#search'));
  f.click('[data-tab="all"]');
  f.jobs.reverse();
  await f.a.refreshList();
  assert.deepEqual(rows(), original, 'empty-query order is independent of API refresh order');
});

test('classic IME search waits for committed text even through catalog refreshes', async (t) => {
  const mapping = deferred();
  const f = await fixture(t, { route: url => url === '/api/zh-map' ? mapping.promise : undefined });
  f.jobs = [song('sea', { title: '海闊天空', track: '海闊天空' }),
    song('rice', { title: '稻香', track: '稻香' })];
  await f.a.refreshList();
  const input = (value, isComposing = false) => {
    f.$('#search').value = value;
    f.$('#search').dispatchEvent(new f.w.InputEvent('input', { bubbles: true, isComposing }));
  };
  input('海阔天空');
  assert.equal(f.$('#browseCount').textContent, '0 首');
  mapping.resolve(response({ '闊': '阔' }));
  await flush();
  assert.equal(f.$('#browseCount').textContent, '1 首', 'late map refreshes the derived fields and results');
  const before = f.$('#songList').textContent;
  f.$('#search').dispatchEvent(new f.w.CompositionEvent('compositionstart'));
  input('dao', true);
  await f.a.refreshList();
  assert.equal(f.$('#songList').textContent, before);
  assert.equal(f.a.state.search, '海阔天空');
  f.$('#search').value = '稻香';
  f.$('#search').dispatchEvent(new f.w.CompositionEvent('compositionend'));
  assert.equal(f.$('.sr-title').textContent, '稻香');
  input('unfinished', true);
  assert.equal(f.a.state.search, '稻香', 'InputEvent.isComposing also suppresses premature filtering');
  f.click('#searchClear');
  assert.equal(f.$('#browseCount').textContent, '2 首');
  assert.equal(f.$('#searchClear').classList.contains('hidden'), true);
});

test('classic artist labels preserve spelling while width/case merge without punctuation overmerge', async (t) => {
  const f = await fixture(t);
  const artists = ['A-Lin', 'ａ－ｌｉｎ', 'A Lin', 'ALin', 'AC/DC', 'ACDC', '夢然', '梦然'];
  f.jobs = artists.map((artist, i) => song(String(i), { artist }));
  await f.a.refreshList();
  f.click('[data-tab="artist"]');
  const chips = [...f.w.document.querySelectorAll('.artist-chip')];
  assert.equal(chips.length, 6);
  assert.equal(f.$('[data-artist="a-lin"] span').textContent, 'A-Lin');
  assert.equal(f.$('[data-artist="a-lin"] em').textContent, '2');
  assert.equal(f.$('[data-artist="梦然"] span').textContent, '夢然');
  f.click('[data-artist="a-lin"]');
  assert.equal(f.$('#browseCount').textContent, 'A-Lin · 2 首（点「歌手」返回）');
});

test('large classic catalog pages stay bounded, search all songs, and do not touch playback', async t => {
  const f = await fixture(t);
  f.jobs = Array.from({ length: 544 }, (_, i) => {
    const title = String.fromCharCode(65 + i % 26) + String(i).padStart(4, '0');
    return song(String(i), { title, track: title, artist: '演唱者' });
  });
  await f.a.refreshList();
  await f.a.selectJob('0');
  f.a.showBrowse();
  const plays = f.plays.length, queue = [...f.a.state.queue], seen = new Set();
  assert.equal(f.$('#browseCount').textContent, '544 首');
  for (let page = 1; page <= 23; page++) {
    const rows = [...f.w.document.querySelectorAll('#songList .song-row')];
    assert.ok(rows.length <= 24);
    assert.equal(f.a.state.browsePage, page);
    for (const row of rows) {
      assert.equal(seen.has(row.dataset.id), false);
      seen.add(row.dataset.id);
    }
    if (page < 23) f.click('#browsePager [data-page-step="1"]');
  }
  assert.equal(seen.size, 544);
  assert.equal(f.$('#browsePager [data-page-step="1"]').disabled, true);
  assert.equal(f.$('.sr-no').textContent, '529');
  f.$('#search').value = f.jobs[543].track;
  f.$('#search').dispatchEvent(new f.w.InputEvent('input', { bubbles: true }));
  assert.equal(f.$('#songList').children.length, 1);
  assert.equal(f.$('.song-row').dataset.id, '543');
  assert.equal(f.a.state.browsePage, 1);
  f.click('#searchClear');
  f.click('#browseIndex [data-letter="B"]');
  assert.ok([...f.w.document.querySelectorAll('.sr-title')].every(node => node.textContent.startsWith('B')));
  f.click('#viewToggle');
  assert.ok(f.$('#grid').children.length <= 24);
  assert.equal(f.plays.length, plays);
  assert.deepEqual([...f.a.state.queue], queue);
  assert.equal(f.a.state.currentJobId, '0');
  f.click('[data-tab="all"]');
  f.a.state.browsePage = 23;
  f.a.renderBrowse();
  f.jobs = f.jobs.slice(0, 3);
  await f.a.refreshList();
  assert.equal(f.a.state.browsePage, 1);
  assert.equal(f.$('#browsePager').hidden, true);
});

test('artist pagination and initial selection survive entering and leaving an artist', async t => {
  const f = await fixture(t);
  f.jobs = Array.from({ length: 55 }, (_, i) => song(String(i), {
    artist: 'A歌手' + String(i).padStart(2, '0'),
  }));
  await f.a.refreshList();
  f.click('[data-tab="artist"]');
  f.click('#browseIndex [data-letter="A"]');
  assert.equal(f.$('#artistList').children.length, 24);
  f.click('#browsePager [data-page-step="1"]');
  const artist = f.$('.artist-chip').dataset.artist;
  f.click('.artist-chip');
  assert.equal(f.$('#artistBack').hidden, false);
  assert.equal(f.$('#songList').children.length, 1);
  assert.equal(f.a.state.browseLetter, '');
  f.click('#artistBack');
  assert.equal(f.a.state.browsePage, 2);
  assert.equal(f.a.state.browseLetter, 'A');
  assert.equal(f.$('.artist-chip').dataset.artist, artist);
  assert.equal(f.$('#artistBack').hidden, true);
});

test('classic frequent-played ranking is personal, searchable and explicitly retryable', async t => {
  const f = await fixture(t);
  assert.equal(f.$('[data-tab="popular"]').hidden, true);
  f.a.room.account = { enabled: true, user: { id: 'account-a' } };
  let fail = false;
  let value = { account_id: 'account-a', songs: [
    { job_id: 'b', play_count: 8, last_played_at: 1 },
    { job_id: 'a', play_count: 3, last_played_at: 2 },
  ], total_plays: 11, history_limit: 500 };
  f.w.OpenKUserState = { libraryStats: async () => {
    if (fail) throw new Error('统计暂不可用');
    return value;
  } };
  f.a.renderBrowse();
  f.click('[data-tab="popular"]');
  await flush();
  const rows = () => [...f.w.document.querySelectorAll('.song-row')].map(node => node.dataset.id);
  assert.deepEqual(rows(), ['b', 'a']);
  assert.equal(f.$('.catalog-plays').textContent, '播放 8 次');
  assert.match(f.$('#browseHint').textContent, /500.*非全网热度/);
  f.$('#search').value = '歌曲a';
  f.$('#search').dispatchEvent(new f.w.InputEvent('input', { bubbles: true }));
  assert.deepEqual(rows(), ['a']);
  assert.equal(f.$('#browseHint').hidden, true);
  f.click('#searchClear');
  fail = true;
  f.click('#refreshPopularity');
  await flush();
  assert.match(f.$('#browseHint').textContent, /未更新.*保留上次/);
  assert.deepEqual(rows(), ['b', 'a']);
  fail = false;
  value = { ...value, songs: [], total_plays: 0 };
  f.click('#refreshPopularity');
  await flush();
  assert.deepEqual(rows(), []);
  assert.match(f.$('#browseEmpty').textContent, /正常播放.*只点歌或拖动进度不会增加/);
  f.a.room.account = { enabled: false };
  f.a.renderBrowse();
  assert.equal(f.$('[data-tab="popular"]').hidden, true);
  assert.equal(f.a.libraryPopularity.state.value, null);
  assert.equal(f.$('#songList').children.length, 2);
});

test('catalog 503 keeps usable stale data and concurrent refreshes share one request', async (t) => {
  const f = await fixture(t);
  const count = f.$('#songList').children.length;
  f.route = (url) => url === '/api/jobs' ? response({ detail: '不可用' }, 503) : undefined;
  await f.a.refreshList();
  assert.equal(f.$('#songList').children.length, count);
  assert.match(f.$('#catalogStatus').textContent, /保留上次结果/);
  const slow = deferred(), before = f.count('/api/jobs');
  f.route = (url) => url === '/api/jobs' ? slow.promise : undefined;
  const first = f.a.refreshList(), second = f.a.refreshList(true);
  await flush();
  assert.equal(f.count('/api/jobs'), before + 1);
  slow.resolve(response(f.jobs));
  await Promise.all([first, second]);
  assert.equal(f.$('#catalogStatus').classList.contains('hidden'), true);
});

test('queue changes update existing rows rather than rebuilding the catalog', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  const row = f.$('.song-row[data-id="b"]');
  f.a.addToQueue('b');
  assert.equal(f.$('.song-row[data-id="b"]'), row);
  assert.equal(row.classList.contains('queued'), true);
});

test('dialogs contain focus and shortcuts do not steal input or native button keys', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.$('#queueBtn').focus();
  f.click('#queueBtn');
  assert.equal(f.w.document.activeElement, f.$('#queueClose'));
  assert.equal(f.$('#browse').inert, true);
  f.$('#queueClear').focus();
  const tab = f.key(f.$('#queueClear'), 'Tab', 'Tab', { shiftKey: true });
  assert.equal(tab.defaultPrevented, true);
  assert.equal(f.w.document.activeElement, f.$('#queueClose'));
  f.key(f.$('#queueClose'), 'Escape');
  assert.equal(f.w.document.activeElement, f.$('#queueBtn'));
  assert.equal(f.$('#browse').inert, false);
  f.$('#lsQuery').focus();
  assert.equal(f.key(f.$('#lsQuery'), '/', 'Slash').defaultPrevented, false);
  assert.equal(f.w.document.activeElement, f.$('#lsQuery'));
  f.$('#modeOrig').focus();
  const plays = f.plays.length;
  assert.equal(f.key(f.$('#modeOrig'), ' ', 'Space').defaultPrevented, false);
  assert.equal(f.plays.length, plays);
  const space = f.key(f.w.document.body, ' ', 'Space');
  assert.equal(space.defaultPrevented, true);
  assert.equal(f.$('#instAudio').paused, true);
});

test('remote entry opens a local QR for the clean same-origin remote URL without affecting playback', async (t) => {
  const f = await fixture(t, { origin: 'https://openk.example.test:8443',
    pathname: '/?room=private#token=not-for-sharing', prefs: { micMonitor: true } });
  await f.a.selectJob('a');
  await flush();
  currentAccountRoom(f);
  f.$('#instAudio').currentTime = 12;
  const before = { calls: f.calls.length, plays: f.plays.length, generation: f.a.state.selectionGeneration,
    graph: f.a.state.audioGraph, stream: f.a.state.micStream };
  const encoded = [], factory = f.w.qrcode;
  f.w.qrcode = (...args) => {
    const qr = factory(...args), add = qr.addData;
    qr.addData = (...data) => { encoded.push(data[0]); return add.apply(qr, data); };
    return qr;
  };
  f.$('#remoteLink').focus();
  f.click('#remoteLink');
  assert.deepEqual(encoded, ['https://openk.example.test:8443/remote']);
  assert.equal(f.$('#remoteOpen').href, encoded[0]);
  assert.equal(f.$('#remoteAddress').textContent, encoded[0]);
  assert.equal(f.$('#remotePanel').classList.contains('hidden'), false);
  assert.equal(f.$('#remotePanel').getAttribute('role'), 'dialog');
  assert.equal(f.$('#remotePanel').getAttribute('aria-modal'), 'true');
  assert.equal(f.$('#remoteLink').getAttribute('aria-expanded'), 'true');
  assert.equal(f.$('#remoteQR svg').getAttribute('role'), 'img');
  assert.match(f.$('#remoteQR svg').getAttribute('aria-label'), /手机遥控/);
  assert.match(f.$('#remoteQRHint').textContent, /相同的账号/);
  assert.equal(f.$('#remoteQRNotice').classList.contains('hidden'), true);
  assert.equal(f.w.document.activeElement, f.$('#remoteClose'));
  assert.equal(f.$('#roomStatus').inert, true);
  assert.equal(f.$('#stage').inert, true);
  assert.equal(f.calls.length, before.calls, 'QR generation must not request a third party or change a room');
  assert.equal(f.$('#instAudio').currentTime, 12);
  assert.equal(f.$('#instAudio').paused, false);
  assert.equal(f.a.state.selectionGeneration, before.generation);
  assert.equal(f.a.state.audioGraph, before.graph);
  assert.equal(f.a.state.micStream, before.stream);
  f.key(f.$('#remoteClose'), 'Tab', 'Tab', { shiftKey: true });
  assert.equal(f.w.document.activeElement, f.$('#remoteOpen'));
  f.key(f.$('#remoteOpen'), 'Tab');
  assert.equal(f.w.document.activeElement, f.$('#remoteClose'));
  f.key(f.w.document.body, ' ', 'Space');
  assert.equal(f.plays.length, before.plays);
  assert.equal(f.$('#instAudio').paused, false);
  f.key(f.$('#remoteClose'), 'Escape');
  assert.equal(f.$('#remotePanel').classList.contains('hidden'), true);
  assert.equal(f.$('#remoteLink').getAttribute('aria-expanded'), 'false');
  assert.equal(f.w.document.activeElement, f.$('#remoteLink'));
  assert.equal(f.$('#roomStatus').inert, false);
  assert.equal(f.$('#stage').inert, false);
});

test('remote QR closes on its backdrop and other drawers remain mutually exclusive', async (t) => {
  const f = await fixture(t);
  f.$('#remoteLink').focus();
  f.click('#remoteLink');
  f.click('#scrim');
  assert.equal(f.$('#remotePanel').classList.contains('hidden'), true);
  assert.equal(f.w.document.activeElement, f.$('#remoteLink'));
  f.click('#remoteLink');
  f.a.openDrawer('queue');
  assert.equal(f.w.document.querySelectorAll('.drawer:not(.hidden)').length, 1);
  assert.equal(f.$('#queuePanel').classList.contains('hidden'), false);
  assert.equal(f.$('#remoteLink').getAttribute('aria-expanded'), 'false');
  f.a.closeDrawers();
  assert.equal(f.w.document.querySelectorAll('.drawer:not(.hidden)').length, 0);
});

test('modified remote-link clicks keep the direct navigation fallback', async (t) => {
  const f = await fixture(t);
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
    let intercepted;
    f.$('#remoteLink').addEventListener('click', event => {
      intercepted = event.defaultPrevented;
      event.preventDefault();
    }, { once: true });
    f.$('#remoteLink').dispatchEvent(new f.w.MouseEvent('click',
      { bubbles: true, cancelable: true, button: 0, [modifier]: true }));
    assert.equal(intercepted, false, modifier);
    assert.equal(f.$('#remotePanel').classList.contains('hidden'), true);
  }
  assert.equal(f.$('#remoteLink').getAttribute('href'), '/remote');
  assert.equal(f.$('#remoteLink').target, '_blank');
});

test('unavailable QR generation and loopback addresses have explicit guidance and a usable link', async (t) => {
  const f = await fixture(t);
  f.w.qrcode = undefined;
  f.click('#remoteLink');
  assert.equal(f.$('#remoteQR svg'), null);
  assert.match(f.$('#remoteQR').textContent, /未能加载/);
  assert.match(f.$('#remoteQRHint').textContent, /选择或加入/);
  assert.match(f.$('#remoteQRNotice').textContent, /本机地址/);
  assert.equal(f.$('#remoteOpen').href, 'https://localhost/remote');
  assert.equal(f.$('#remoteOpen').target, '_blank');
  f.click('#remoteClose');
  assert.equal(f.$('#remotePanel').classList.contains('hidden'), true);
});

test('lyrics restore same-line highlighting after edit and animate only on the visible stage', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.$('#instAudio').currentTime = 2;
  f.a.updateLyrics(2);
  assert.ok(f.$('.lyric-line.active'));
  f.a.enterLyricsEdit();
  f.a.exitLyricsEdit();
  assert.ok(f.$('.lyric-line.active'));
  assert.equal(f.$('.lyric-line.active').querySelectorAll('.sung').length, 2);
  assert.ok(f.a.state.lyricRaf);
  f.a.showBrowse();
  assert.equal(f.a.state.lyricRaf, 0);
  f.a.showStage();
  assert.ok(f.a.state.lyricRaf);
  await f.visibility(true);
  assert.equal(f.a.state.lyricRaf, 0);
  await f.visibility(false);
  assert.ok(f.$('.lyric-line.active'));
  assert.ok(f.a.state.lyricRaf);
});

test('word timestamps accept canonical text and Whisper-style word fields', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.a.state.lyrics = { lines: [{ start: 0, end: 10, text: '兼容歌词', words: [
    { text: '兼容', start: 0, end: 1 }, { word: '歌词', start: 1, end: 10 },
  ] }] };
  f.a.renderLyrics();
  f.a.updateLyrics(2);
  assert.equal(f.$('.lyric-line').textContent.trim(), '兼容 歌词');
  assert.equal(f.$('.lyric-line.active').querySelectorAll('.sung').length, 2);
  assert.doesNotMatch(f.$('#lyrics').textContent, /undefined/);
});

test('async alignment is persisted, suppresses duplicate submit, and cannot replace another song', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  await f.a.applyLyric({ id: 11 });
  assert.deepEqual(JSON.parse(f.w.localStorage.getItem('openk.alignments')), { a: 'op-a' });
  await f.a.applyLyric({ id: 12 });
  assert.equal(f.count('/api/jobs/a/lyrics/align'), 1);
  await f.a.selectJob('b');
  f.route = (url) => url === '/api/operations/op-a'
    ? response({ id: 'op-a', job_id: 'a', state: 'done', message: '已完成' }) : undefined;
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.a.state.lyrics.source, 'b');
  assert.deepEqual(JSON.parse(f.w.localStorage.getItem('openk.alignments')), {});
});

test('alignment progress resumes after reload and completes on its original song', async (t) => {
  const f = await fixture(t, { storage: { 'openk.alignments': '{"a":"op-a"}' } });
  await f.a.selectJob('a');
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.a.state.alignmentOperations.a.state, 'running');
  f.route = (url) => {
    if (url === '/api/operations/op-a') return response({ id: 'op-a', job_id: 'a', state: 'done' });
    if (url.startsWith('/l/a.json?')) return response({ source: 'aligned', lines: [{ start: 0, end: 10, text: '新歌词' }] });
  };
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.a.state.lyrics.source, 'aligned');
  assert.match(f.$('#alignmentStatus').textContent, /已更新/);
});

test('alignment completion resolves immutable lyric revisions without restarting audio', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  await f.a.applyLyric({ id: 11 });
  const plays = f.plays.length;
  f.route = (url) => {
    if (url === '/api/operations/op-a') {
      f.jobs[0].media.lyrics = '/l/a-aligned.json';
      return response({ id: 'op-a', job_id: 'a', state: 'done',
        result: { lyrics_file: 'artifacts/aligned/lyrics.json' } });
    }
  };
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.a.state.lyricsUrl, '/l/a-aligned.json');
  assert.equal(f.a.state.lyrics.source, 'a-aligned');
  assert.equal(f.plays.length, plays);
  assert.equal(f.$('#instAudio').paused, false);
});

function currentAccountRoom(f) {
  const job = f.jobs.find(value => value.id === f.a.state.currentJobId);
  const value = {
    id: 'test-room', revision: 1, queue: [], members: [], solo: true,
    viewer: { id: 'test-member', role: 'host', name: 'Singer' },
    current: { id: 'queue-' + job.id, job_id: job.id, title: job.title, media: { ...job.media } },
    playback: { position: f.$('#instAudio').currentTime, seek_version: 1, playing: true, guide: false },
    player: { online: true, status: 'playing', member_id: 'test-member' },
  };
  Object.assign(f.a.room, {
    account: { enabled: true, user: { id: 'test-account', display_name: 'Singer' } },
    client: { state: value }, loadedItem: value.current.id, generation: 1,
    armed: true, playerToken: 'synthetic-player',
  });
  return value;
}

test('room devices show each functional role without conflating same-account browsers', async (t) => {
  const f = await fixture(t);
  const host = f.$('#roomDevices');
  const value = {
    current: { id: 'song' }, playback: { playing: true }, player: { status: 'playing' },
    devices: [
      { id: 'desktop', member_id: 'same-account', name: '客厅电脑',
        roles: ['player', 'controller', 'microphone'], online: true, player: true },
      { id: 'phone', member_id: 'same-account', name: '<img src=x onerror=alert(1)>',
        roles: ['controller'], online: true, player: false },
      { id: 'mic', member_id: 'other-account', name: '麦克风设备',
        roles: ['microphone'], online: true, player: false },
    ],
  };
  f.w.OpenKRoom.renderDevices(host, value, 'desktop');
  assert.equal(host.hidden, false);
  assert.match(host.textContent, /房间设备 · 3 台在线/);
  const devices = [...host.querySelectorAll('.room-device')];
  assert.equal(devices.length, 3);
  assert.equal(devices[0].querySelector('strong').textContent, '客厅电脑（本机）');
  assert.deepEqual([...devices[0].querySelectorAll('.room-device-role')].map(node => node.textContent),
    ['播放器', '遥控器', '麦克风']);
  assert.equal(host.querySelectorAll('.is-player').length, 1);
  assert.equal(devices[0].querySelector('.room-device-status').textContent, '正在播放');
  assert.equal(devices[1].querySelector('strong').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(host.querySelector('img'), null, 'device labels are text, never executable markup');
  assert.match(devices[2].querySelector('[data-role="microphone"]').title, /不会向其他设备/);
  f.w.OpenKRoom.renderDevices(host, { ...value, observed_at: 100 }, 'desktop');
  assert.equal(host.querySelector('.room-device'), devices[0], 'unchanged polling does not rebuild device DOM');
  let escaped = false;
  f.w.document.addEventListener('keydown', () => { escaped = true; }, { once: true });
  const list = host.querySelector('.room-device-list');
  list.focus();
  f.key(list, ' ', 'Space');
  assert.equal(escaped, false, 'scroll keys in the device list never trigger room playback shortcuts');
  f.w.OpenKRoom.renderDevices(host, { ...value, devices: value.devices.slice(1) }, 'phone');
  assert.equal(host.querySelectorAll('.room-device').length, 2);
  assert.equal(host.querySelector('[data-device-id="desktop"]'), null);
  assert.equal(f.w.document.activeElement, host.querySelector('.room-device-list'),
    'a presence update retains keyboard focus inside the device list');
  f.w.OpenKRoom.renderDevices(host, null, null);
  assert.equal(host.hidden, true);
  assert.equal(host.querySelectorAll('.room-device').length, 0, 'a lost account/room clears prior device details');
  f.w.OpenKRoom.renderDevices(host, value, 'desktop');
  await f.a.initAccount(true);
  assert.equal(host.hidden, true);
  assert.equal(host.querySelectorAll('.room-device').length, 0,
    'switching out of account mode clears rather than retaining prior account devices');
});

test('an empty account room can arm its player without opening a microphone', async (t) => {
  const f = await fixture(t);
  const value = {
    id: 'ready-room', revision: 1, queue: [], members: [], solo: true, current: null,
    viewer: { id: 'ready-member', role: 'host', name: 'Singer' },
    playback: { position: 0, seek_version: 1, playing: false, guide: false },
    player: { online: false, status: 'offline' }, devices: [],
  };
  let claims = 0;
  Object.assign(f.a.room, {
    account: { enabled: true, user: { id: 'test-account', display_name: 'Singer' } },
    client: {
      state: value,
      async claim() {
        claims++;
        value.player = { online: true, status: 'ready', member_id: 'ready-member' };
        return { player_token: 'synthetic-ready-lease' };
      },
      async heartbeat() {},
      async release() {},
    },
  });
  f.a.applyRoomState(value);
  assert.equal(f.$('#roomActivate').disabled, false);
  assert.equal(f.$('#roomActivate').textContent, '启用播放器');
  f.click('#roomActivate');
  await flush();
  await flush();
  assert.equal(claims, 1);
  assert.equal(f.a.room.armed, true);
  assert.equal(f.micCalls, 0, 'pre-arming requests audio output, not microphone permission');
  assert.match(f.$('#roomPlaybackStatus').textContent, /已就绪.*点歌后自动开唱/);
  const job = f.jobs[0];
  value.current = { id: 'ready-entry', job_id: job.id, title: job.title, media: job.media };
  value.playback = { ...value.playback, playing: true, seek_version: 2 };
  value.revision++;
  f.a.applyRoomState(value);
  await flush();
  await flush();
  assert.equal(f.$('#instAudio').paused, false, 'a first queued song starts on the already-armed receiver');
  assert.equal(claims, 1, 'queue changes do not acquire another player lease');
});

test('catalog lyric revisions refresh the current song without restarting its audio', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.$('#instAudio').currentTime = 17;
  const plays = f.plays.length, generation = f.a.state.selectionGeneration;
  f.jobs[0].media.lyrics = '/l/a-v2.json';
  await f.a.refreshList();
  await flush();
  assert.equal(f.a.state.lyrics.source, 'a-v2');
  assert.equal(f.a.state.lyricsUrl, '/l/a-v2.json');
  assert.equal(f.a.state.selectionGeneration, generation);
  assert.equal(f.plays.length, plays);
  assert.equal(f.$('#instAudio').currentTime, 17);
  assert.equal(f.$('#instAudio').paused, false);
  assert.match(f.$('.lyric-line.active').textContent, /a-v2/);
});

test('account room updates refresh lyrics on the same queue item without restarting audio', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.$('#instAudio').currentTime = 17;
  const value = currentAccountRoom(f);
  const plays = f.plays.length, generation = f.a.state.selectionGeneration;
  f.jobs[0].media.lyrics = value.current.media.lyrics = '/l/a-room-v2.json';
  value.revision++;
  f.a.applyRoomState(value);
  await flush();
  assert.equal(f.a.state.lyrics.source, 'a-room-v2');
  assert.equal(f.a.room.loadedItem, value.current.id);
  assert.equal(f.a.state.selectionGeneration, generation);
  assert.equal(f.plays.length, plays);
  assert.equal(f.$('#instAudio').currentTime, 17);
  assert.equal(f.$('#instAudio').paused, false);
});

test('same-version room polls share a lyric request and newer versions fence late replies', async (t) => {
  const old = deferred();
  const f = await fixture(t);
  await f.a.selectJob('a');
  const value = currentAccountRoom(f);
  f.route = url => url.startsWith('/l/a-room-v2.json') ? old.promise : undefined;
  f.jobs[0].media.lyrics = value.current.media.lyrics = '/l/a-room-v2.json';
  f.a.applyRoomState(value);
  await flush();
  f.a.applyRoomState(value);
  await flush();
  const requests = f.calls.filter(call => call.url.startsWith('/l/a-room-v2.json'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);
  f.jobs[0].media.lyrics = value.current.media.lyrics = '/l/a-room-v3.json';
  f.a.applyRoomState(value);
  await flush();
  assert.equal(f.a.state.lyrics.source, 'a-room-v3');
  old.resolve(response({ source: 'obsolete', lines: [{ start: 0, end: 10, text: 'Obsolete' }] }));
  await flush();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(f.a.state.lyrics.source, 'a-room-v3');
});

test('a failed lyric refresh retains its old version and retries without replaying audio', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  const value = currentAccountRoom(f);
  const plays = f.plays.length;
  let now = f.w.Date.now();
  f.w.Date.now = () => now;
  f.jobs[0].media.lyrics = value.current.media.lyrics = '/l/a-retry.json';
  f.route = url => url.startsWith('/l/a-retry.json') ? response({ detail: 'Temporary failure' }, 503) : undefined;
  f.a.applyRoomState(value);
  await flush();
  assert.equal(f.a.state.lyrics.source, 'a');
  assert.equal(f.a.state.lyricsUrl, '/l/a.json');
  assert.match(f.$('#toast').textContent, /保留上次版本/);
  const calls = f.calls.length;
  f.a.applyRoomState(value);
  await flush();
  assert.equal(f.calls.length, calls, 'failed media must not retry on every room heartbeat');
  now += 5000;
  f.route = undefined;
  f.a.applyRoomState(value);
  await flush();
  assert.equal(f.a.state.lyrics.source, 'a-retry');
  assert.equal(f.plays.length, plays);
});

test('a timed-out refresh retries even when a legacy lyric URL is unchanged', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  let now = f.w.Date.now();
  f.w.Date.now = () => now;
  f.route = (url, options) => {
    if (url.startsWith('/l/a.json?')) return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort',
        () => reject(new f.w.DOMException('Timed out', 'AbortError')), { once: true });
    });
  };
  const loading = f.a.loadPlayerLyrics('a', f.a.state.lyricsUrl, f.a.state.selectionGeneration, true);
  await flush();
  const timeout = [...f.timeouts].find(([, entry]) => entry.delay === 20000);
  assert.ok(timeout);
  await f.timer(timeout[0]);
  await loading;
  assert.equal(f.a.state.lyrics.source, 'a');
  assert.match(f.$('#toast').textContent, /自动重试/);
  now += 5000;
  f.route = url => url.startsWith('/l/a.json?')
    ? response({ source: 'same-path-refresh', lines: [{ start: 0, end: 10, text: 'New words' }] }) : undefined;
  await f.a.refreshList();
  await flush();
  assert.equal(f.a.state.lyrics.source, 'same-path-refresh');
  assert.equal(f.a.state.lyricsUrl, '/l/a.json');
});

test('automatic lyric refresh preserves an edit draft and applies the latest version on cancel', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.a.enterLyricsEdit();
  f.$('.lyric-edit').value = 'Unsaved draft';
  f.jobs[0].media.lyrics = '/l/a-edited-elsewhere.json';
  await f.a.refreshList();
  await flush();
  assert.equal(f.$('.lyric-edit').value, 'Unsaved draft');
  assert.equal(f.a.state.lyrics.source, 'a');
  f.a.exitLyricsEdit();
  await flush();
  assert.equal(f.a.state.lyrics.source, 'a-edited-elsewhere');
});

test('entering the lyric editor fences an automatic refresh that was already in flight', async (t) => {
  const pending = deferred();
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.jobs[0].media.lyrics = '/l/a-pending.json';
  f.route = url => url.startsWith('/l/a-pending.json') ? pending.promise : undefined;
  await f.a.refreshList();
  await flush();
  const request = f.calls.find(call => call.url.startsWith('/l/a-pending.json'));
  assert.ok(request);
  f.a.enterLyricsEdit();
  f.$('.lyric-edit').value = 'Keep this draft';
  pending.resolve(response({ source: 'pending', lines: [{ start: 0, end: 10, text: 'Remote words' }] }));
  await flush();
  assert.equal(request.signal.aborted, true);
  assert.equal(f.$('.lyric-edit').value, 'Keep this draft');
  assert.equal(f.a.state.lyrics.source, 'a');
  f.route = undefined;
  f.a.exitLyricsEdit();
  await flush();
  assert.equal(f.a.state.lyrics.source, 'a-pending');
});

test('malformed 202 is visible as failure; explicit legacy success remains supported', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.route = (url) => url.endsWith('/lyrics/align') ? response({}, 202) : undefined;
  await f.a.applyLyric({ id: 11 });
  assert.match(f.$('#alignmentStatus').textContent, /有效的对齐任务编号/);
  assert.equal(f.a.state.alignmentTimers.size, 0);
  f.route = (url) => url.endsWith('/lyrics/align') ? response({ ok: true }) : undefined;
  await f.a.applyLyric({ id: 12 });
  assert.match(f.$('#alignmentStatus').textContent, /旧版接口/);
});

test('expired alignment operation stops retrying and permits a new submission', async (t) => {
  const f = await fixture(t, { storage: { 'openk.alignments': '{"a":"op-a"}' } });
  await f.a.selectJob('a');
  f.route = (url) => url === '/api/operations/op-a' ? response({ detail: 'missing' }, 404) : undefined;
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.a.state.alignmentOperations.a.state, 'error');
  assert.equal(f.a.state.alignmentTimers.has('a'), false);
  assert.match(f.$('#alignmentStatus').textContent, /过期/);
  f.route = undefined;
  await f.a.applyLyric({ id: 22 });
  assert.equal(f.a.state.alignmentOperations.a.state, 'queued');
});

test('focused and alignment polls make no requests while the document is hidden', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  await f.a.applyLyric({ id: 11 });
  f.a.startPolling('p');
  await f.visibility(true);
  const jobs = f.count('/api/jobs/p'), operations = f.count('/api/operations/op-a');
  await f.timer(f.a.state.pollTimer);
  await f.timer(f.a.state.alignmentTimers.get('a'));
  assert.equal(f.count('/api/jobs/p'), jobs);
  assert.equal(f.count('/api/operations/op-a'), operations);
});

test('play rejection is handled and buffering pauses and restores guide vocals', async (t) => {
  const f = await fixture(t);
  f.playError = new f.w.DOMException('gesture required', 'NotAllowedError');
  await f.a.selectJob('a');
  await flush();
  assert.match(f.$('#audioStatus').textContent, /无法播放/);
  assert.equal(f.$('#instAudio').paused, true);
  f.playError = null;
  assert.equal(await f.a.startPlayback(), true);
  f.$('#instAudio').dispatchEvent(new f.w.Event('waiting'));
  assert.equal(f.$('#vocalAudio').paused, true);
  assert.match(f.$('#audioStatus').textContent, /缓冲/);
  f.$('#instAudio').dispatchEvent(new f.w.Event('playing'));
  await flush();
  assert.equal(f.$('#vocalAudio').paused, false);
});

test('dual-track sync uses mild correction, large-drift reset and no correction during buffering', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  const inst = f.$('#instAudio'), guide = f.$('#vocalAudio');
  let now = 1000;
  Object.defineProperty(f.w.performance, 'now', { value: () => now });
  inst.currentTime = 10;
  guide.currentTime = 10.2;
  inst.dispatchEvent(new f.w.Event('timeupdate'));
  assert.equal(guide.currentTime, 10.2);
  assert.equal(guide.playbackRate, 0.99);
  now += 600;
  guide.currentTime = 12;
  inst.dispatchEvent(new f.w.Event('timeupdate'));
  assert.equal(guide.currentTime, 10);
  assert.equal(guide.playbackRate, 1);
  now += 600;
  f.a.state.buffering = true;
  guide.currentTime = 10.4;
  inst.dispatchEvent(new f.w.Event('timeupdate'));
  assert.equal(guide.currentTime, 10.4);
});

test('a cancelled playback intent cannot start audio after a delayed context resume', async (t) => {
  const f = await fixture(t);
  await f.a.selectJob('a');
  f.a.pausePlayback();
  const resume = deferred(), context = f.a.state.audioGraph.actx;
  context.state = 'suspended';
  context.resume = () => resume.promise.then(() => { context.state = 'running'; });
  const before = f.plays.length, start = f.a.startPlayback();
  f.a.pausePlayback();
  resume.resolve();
  assert.equal(await start, false);
  assert.equal(f.plays.length, before);
});

test('direct admin route opens accessible drawer and links use separate page runtimes', async (t) => {
  const f = await fixture(t, { pathname: '/admin' });
  assert.equal(f.$('#adminPanel').classList.contains('hidden'), false);
  assert.equal(f.$('#adminPanel').getAttribute('role'), 'dialog');
  assert.equal(f.w.document.activeElement, f.$('#adminClose'));
  assert.equal(f.$('a[href="/tv"]').target, '_blank');
  assert.equal(f.$('a[href="/remote"]').target, '_blank');
  assert.deepEqual([...f.w.document.querySelectorAll('script[src]')].map(el => el.getAttribute('src')),
    ['/search.js', '/library.js', '/room-client.js', '/account.js', '/user-state.js', '/vendor/qrcode.js', '/app.js']);
});

test('pagehide releases microphone and invalidates pending media work', async (t) => {
  const f = await fixture(t, { prefs: { micMonitor: true } });
  await f.a.selectJob('a');
  await flush();
  const stream = f.a.state.micStream;
  const generation = f.a.state.selectionGeneration;
  f.w.dispatchEvent(new f.w.PageTransitionEvent('pagehide', { persisted: false }));
  assert.equal(stream.track.stopped, 1);
  assert.equal(f.a.state.audioGraph.mic, null);
  assert.equal(f.a.state.disposed, true);
  assert.ok(f.a.state.selectionGeneration > generation);
  assert.equal(f.$('#instAudio').paused, true);
});
