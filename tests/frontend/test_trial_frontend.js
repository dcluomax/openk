/* Guest trial page contracts: response validation, safe rendering, the single final
   selection, terminal states, API failures and teardown. Everything here is synthetic —
   no server, no real catalog, no microphone, no credentials. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const trial = path.resolve(__dirname, '../../frontend/trial');
const page = fs.readFileSync(path.join(trial, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(trial, 'trial.js'), 'utf8');
const SONG_A = 'a1b2c3d4e5f6';
const SONG_B = '0123456789ab';

const settle = async (rounds = 5) => {
  for (let index = 0; index < rounds; index++) await new Promise(resolve => setTimeout(resolve, 0));
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const song = (id = SONG_A, extra = {}) => ({
  id, title: 'Paper Planes', track: 'Paper Planes', artist: 'Synthetic Choir', duration: 18,
  has_vocals: true, has_lyrics: true,
  media: { instrumental: '/api/trial/media/instrumental', vocals: '/api/trial/media/vocals',
    lyrics: '/api/trial/lyrics' },
  ...extra,
});
const available = (extra = {}) => ({ status: 'available', song: null, started_at: null,
  expires_at: 2000000000, remaining_seconds: 3600, ...extra });
const active = (value = song(), extra = {}) => ({ status: 'active', song: value, started_at: 1000,
  expires_at: 2000000000, remaining_seconds: 300, ...extra });
const done = (status = 'complete') => ({ status, song: null, started_at: 1000,
  expires_at: 2000000000, remaining_seconds: 0 });
const catalog = (songs = [
  { id: SONG_A, title: 'Paper Planes', track: 'Paper Planes', artist: 'Synthetic Choir', duration: 18 },
  { id: SONG_B, title: 'Lantern Street', track: 'Lantern Street', artist: 'Test Ensemble', duration: 42 },
]) => ({ songs, limit: 50 });
// Trial payloads carry their own `status` field, so an HTTP status is wrapped explicitly.
const http = (code, body = {}) => ({ __http: code, body });
const lyrics = () => ({ language: 'en', lines: [
  { start: 1, end: 3, text: 'first synthetic line',
    words: [{ start: 1, end: 2, text: 'first ' }, { start: 2, end: 3, text: 'synthetic line' }] },
  { start: 4, end: 6, text: 'second synthetic line' },
] });

class Param {
  constructor(value = 0) { this.value = value; }
}
class Node {
  constructor(context, kind) {
    this.context = context;
    this.kind = kind;
    this.outputs = [];
    this.disconnects = 0;
    for (const name of ['gain', 'threshold', 'knee', 'ratio', 'attack', 'release']) this[name] = new Param(0);
    this.gain.value = 1;
  }
  connect(node) { this.outputs.push(node); return node; }
  disconnect() { this.disconnects++; this.outputs = []; }
}
function makeAudioContext(created, options = {}) {
  return class FakeAudioContext {
    constructor() {
      this.state = 'suspended';
      this.destination = new Node(this, 'destination');
      this.nodes = [];
      this.resumes = 0;
      this.sources = [];
      this.listeners = {};
      created.push(this);
    }
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
    emit(type) { for (const handler of this.listeners[type] || []) handler(); }
    /** Model a system interruption: the state changes without anyone asking. */
    setState(state) { this.state = state; this.emit('statechange'); }
    track(kind) { const node = new Node(this, kind); this.nodes.push(node); return node; }
    createGain() { return this.track('gain'); }
    createDynamicsCompressor() { return this.track('compressor'); }
    createMediaElementSource(element) {
      if (options.failElementSource === element.id) throw new Error('element already attached');
      this.sources.push(element.id);
      const node = this.track('element');
      if (options.failSourceConnect === element.id) {
        node.connect = () => { throw new Error('the graph could not be connected'); };
      }
      return node;
    }
    createMediaStreamSource(stream) { this.sources.push(stream); return this.track('stream'); }
    resume() {
      this.resumes++;
      if (!options.resumeFails) this.state = 'running';
      this.emit('statechange');
      return Promise.resolve();
    }
    suspend() { this.state = 'suspended'; this.emit('statechange'); return Promise.resolve(); }
    close() { this.state = 'closed'; this.emit('statechange'); return Promise.resolve(); }
  };
}

function fakeStream() {
  const track = {
    kind: 'audio', readyState: 'live', stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; },
    addEventListener() {},
  };
  return { tracks: [track], getTracks() { return this.tracks; }, getAudioTracks() { return this.tracks; } };
}

function fixture(t, handlers = {}, options = {}) {
  const dom = new JSDOM(page, { url: 'https://guest.example/try', runScripts: 'outside-only',
    pretendToBeVisual: false });
  const w = dom.window;
  const calls = [];
  const contexts = [];
  const routes = {
    'GET /api/trial/state': available(),
    'GET /api/trial/catalog': catalog(),
    'GET /api/trial/lyrics': lyrics(),
    ...handlers,
  };
  w.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, method, init, body });
    const route = routes[method + ' ' + url] ?? routes[method + ' ' + url.split('?')[0]];
    const value = typeof route === 'function' ? await route({ url, method, body }) : route;
    if (value === undefined) return { ok: false, status: 404, json: async () => ({ detail: 'No such route' }) };
    if (value instanceof Error) throw value;
    const status = value && value.__http ? value.__http : 200;
    const payload = value && value.__http ? value.body : value;
    return { ok: status < 400, status, json: async () => payload };
  };
  for (const [key, value] of Object.entries(options.storage || {})) w.localStorage.setItem(key, value);
  if (options.audio !== false) w.AudioContext = makeAudioContext(contexts, options);
  const media = w.HTMLMediaElement.prototype;
  media.play = function play() {
    const refused = options.playRejects
      || (options.guidePlayRejects && this.id === 'guideAudio');
    if (refused) return Promise.reject(new w.DOMException('blocked', 'NotAllowedError'));
    this._paused = false;
    this.dispatchEvent(new w.Event('play'));
    return Promise.resolve();
  };
  media.pause = function pause() {
    if (this._paused === false) { this._paused = true; this.dispatchEvent(new w.Event('pause')); }
    this._paused = true;
  };
  media.load = function load() {};
  for (const [name, descriptor] of Object.entries({
    paused: { get() { return this._paused !== false; } },
    ended: { get() { return !!this._ended; } },
    currentTime: { get() { return this._time || 0; }, set(value) { this._time = value; } },
    duration: { get() { return this._duration === undefined ? 18 : this._duration; } },
  })) Object.defineProperty(media, name, { ...descriptor, configurable: true });
  const streams = [];
  const deferredMics = [];
  const permission = options.mic;
  Object.defineProperty(w.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      calls: 0,
      async getUserMedia() {
        this.calls++;
        if (permission instanceof Error) throw permission;
        const stream = fakeStream();
        streams.push(stream);
        // A real permission prompt can resolve long after the visitor moved on.
        if (options.micDefer) await new Promise(resolve => deferredMics.push(resolve));
        return stream;
      },
    },
  });
  w.eval(script);
  t.after(() => { try { w.OpenKTrial.teardown(); } catch (error) { /* already closed */ } w.close(); });
  return {
    w, calls, contexts, streams, api: w.OpenKTrial,
    resolveMic: () => { for (const resolve of deferredMics.splice(0)) resolve(); },
    hide: () => {
      Object.defineProperty(w.document, 'visibilityState', { configurable: true, value: 'hidden' });
      w.document.dispatchEvent(new w.Event('visibilitychange'));
    },
    doc: w.document,
    $: selector => w.document.querySelector(selector),
    all: selector => [...w.document.querySelectorAll(selector)],
    text: selector => w.document.querySelector(selector)?.textContent.trim(),
    visible: selector => !w.document.querySelector(selector).hidden,
    fire: (element, type) => element.dispatchEvent(new w.Event(type)),
    requests: (method, prefix) => calls.filter(call => call.method === method && call.url.startsWith(prefix)),
  };
}

test('state responses are validated before anything is played', async (t) => {
  const f = fixture(t);
  await f.api.ready;
  const parse = f.api.parseState;
  assert.equal(parse(active()).song.id, SONG_A);
  assert.equal(parse(available()).song, null);

  const rejected = [
    null, 'active', [], {}, { status: 'singing', song: null, started_at: null, expires_at: 1, remaining_seconds: 1 },
    { ...available(), remaining_seconds: -1 },
    { ...available(), remaining_seconds: 'soon' },
    { ...available(), remaining_seconds: Infinity },
    { ...available(), expires_at: 'later' },
    { ...active(), status: 'available' },
    { ...done('complete'), song: song() },
    { ...available(), song: undefined },
    active({ ...song(), id: 'NOT-A-JOB-ID' }),
    active({ ...song(), id: '' }),
    active({ ...song(), duration: 0 }),
    active({ ...song(), duration: -5 }),
    active({ ...song(), duration: 901 }),
    active({ ...song(), duration: 'three minutes' }),
    active({ ...song(), title: 42 }),
    active({ ...song(), title: '   ' }),
    active({ ...song(), has_vocals: 'yes' }),
    active({ ...song(), has_lyrics: 1 }),
  ];
  for (const value of rejected) {
    assert.throws(() => parse(value), error => error.status === 502, JSON.stringify(value));
  }

  // Media URLs are an exact allowlist, never a server-chosen source.
  const badMedia = [
    { instrumental: 'https://evil.example/song.mp3' },
    { instrumental: '/media/abcdef123456/stems/instrumental.wav' },
    { instrumental: '//evil.example/x.mp3' },
    { instrumental: 'javascript:alert(1)' },
    { instrumental: '/api/trial/media/instrumental/../../jobs' },
    { instrumental: '/api/trial/media/instrumental', vocals: 'https://evil.example/v.mp3' },
    { instrumental: '/api/trial/media/instrumental', vocals: '/api/trial/media/vocals',
      lyrics: '/media/abcdef123456/lyrics.json' },
    { instrumental: '/api/trial/media/instrumental', vocals: '/api/trial/media/vocals',
      lyrics: '/api/trial/lyrics', extra: '/api/trial/media/instrumental' },
  ];
  for (const media of badMedia) {
    assert.throws(() => parse(active({ ...song(), media })), error => error.status === 502, JSON.stringify(media));
  }
  // A declared capability must match the delivered URLs in both directions.
  assert.throws(() => parse(active({ ...song(), has_vocals: false })), error => error.status === 502);
  assert.throws(() => parse(active({ ...song(), has_lyrics: true,
    media: { instrumental: '/api/trial/media/instrumental', vocals: '/api/trial/media/vocals' } })),
  error => error.status === 502);
  const noExtras = parse(active({ ...song(), has_vocals: false, has_lyrics: false,
    media: { instrumental: '/api/trial/media/instrumental' } }));
  assert.equal(noExtras.song.media.vocals, undefined);
  // The eligible window is the server's: at most fifteen minutes of song, at most a day of grant.
  assert.equal(parse(active({ ...song(), duration: 900 })).song.duration, 900);
  assert.equal(parse(available({ remaining_seconds: 86400 })).remaining_seconds, 86400);
  assert.equal(parse(available({ remaining_seconds: 90000 })).remaining_seconds, 86400);

  for (const value of [null, {}, { songs: [] }, { songs: {}, limit: 50 }, { songs: [], limit: 0 },
    { songs: [], limit: 51 }, { songs: [], limit: 2.5 },
    { songs: [{ id: SONG_A, title: 'x', track: 'x', artist: '', duration: 1 }], limit: 0 },
    { songs: [{ id: 'nope', title: 'x', track: 'x', artist: '', duration: 1 }], limit: 50 },
    { songs: [{ id: SONG_A, title: 'x', track: 'x', artist: '', duration: 1 },
      { id: SONG_B, title: 'y', track: 'y', artist: '', duration: 1 }], limit: 1 }]) {
    assert.throws(() => f.api.parseCatalog(value), error => error.status === 502, JSON.stringify(value));
  }
  assert.equal(f.api.parseCatalog(catalog()).songs.length, 2);

  assert.throws(() => f.api.parseLyrics({ lines: 'la la la' }), error => error.status === 502);
  const cleaned = f.api.parseLyrics({ lines: [
    { start: 5, end: 6, text: 'later' }, { start: 1, end: 2, text: 'earlier' },
    { start: 'x', text: 'no timing' }, { start: 3, text: 7 }, null,
    { start: 2, end: 1, text: 'backwards', words: [{ start: 2, text: 'ok' }, { text: 'no start' }] },
  ] });
  assert.deepEqual([...cleaned].map(line => line.text), ['earlier', 'backwards', 'later']);
  assert.deepEqual([...cleaned[1].words].map(word => ({ start: word.start, text: word.text })),
    [{ start: 2, text: 'ok' }]);
});

test('opening the page never autoplays, auto-selects or opens a microphone', async (t) => {
  const f = fixture(t);
  await f.api.ready;
  await settle();
  assert.equal(f.api.state.status, 'available');
  assert.ok(f.visible('#chooseView'));
  assert.ok(!f.visible('#playerView') && !f.visible('#doneView') && !f.visible('#loadingView'));
  assert.equal(f.$('#instAudio').getAttribute('src'), null);
  assert.equal(f.$('#guideAudio').getAttribute('src'), null);
  assert.ok(f.$('#instAudio').paused && f.$('#guideAudio').paused);
  assert.equal(f.contexts.length, 0, 'no AudioContext is created before a gesture');
  assert.equal(f.w.navigator.mediaDevices.calls, 0, 'no microphone is touched on load');
  assert.equal(f.w.localStorage.length, 0, 'the trial keeps no identity or quota in this browser');
  assert.equal(f.requests('POST', '/api/trial').length, 0, 'loading the page selects nothing');
  assert.equal(f.all('.trial-song').length, 2);
  assert.match(f.text('#catalogStatus'), /共 2 首可以试唱/);
  assert.match(f.text('#sessionNote'), /选择一首歌/);

  const daily = fixture(t, { 'GET /api/trial/state': available({ remaining_seconds: 86400 }) });
  await daily.api.ready;
  await settle();
  assert.match(daily.text('#sessionNote'), /24 小时 0 分/, 'the whole grant window is described in hours');

  const [stateCall] = f.requests('GET', '/api/trial/state');
  assert.equal(stateCall.init.credentials, 'same-origin');
  assert.equal(stateCall.init.cache, 'no-store');
  assert.equal(stateCall.init.redirect, 'error');
});

test('catalog metadata is rendered as text, never as markup', async (t) => {
  const hostile = {
    id: SONG_A, title: '<img src=x onerror="window.__pwned=1">', duration: 30,
    track: '</span><script>window.__pwned=2</script>', artist: '"><svg onload=alert(1)>',
  };
  const f = fixture(t, { 'GET /api/trial/catalog': catalog([hostile]) });
  await f.api.ready;
  await settle();
  assert.equal(f.all('#catalogList img, #catalogList script, #catalogList svg').length, 0);
  assert.equal(f.text('.trial-song-title'), hostile.title);
  assert.ok(f.text('.trial-song-meta').startsWith(hostile.artist));
  assert.equal(f.w.__pwned, undefined);
  assert.equal(f.$('.trial-song').dataset.id, SONG_A);
});

test('search is debounced, bounded and immune to stale replies', async (t) => {
  const slow = deferred();
  const f = fixture(t, {
    'GET /api/trial/catalog': async ({ url }) => {
      if (url.includes('q=slow')) return slow.promise;
      if (url.includes('q=fast')) return catalog([{ id: SONG_B, title: 'Fast reply', track: 'Fast reply',
        artist: 'Second search', duration: 12 }]);
      return catalog();
    },
  });
  await f.api.ready;
  await settle();
  const before = f.requests('GET', '/api/trial/catalog').length;
  const search = f.$('#songSearch');
  for (const value of ['p', 'pa', 'pap']) {
    search.value = value;
    f.fire(search, 'input');
  }
  await wait(400);
  const queries = f.requests('GET', '/api/trial/catalog').slice(before);
  assert.equal(queries.length, 1, 'keystrokes collapse into one debounced request');
  assert.ok(queries[0].url.endsWith('?q=pap'));

  const pending = f.api.loadCatalog('slow');
  const fresh = f.api.loadCatalog('fast');
  await fresh;
  slow.resolve(catalog([{ id: SONG_A, title: 'Stale reply', track: 'Stale reply',
    artist: 'First search', duration: 9 }]));
  await pending;
  await settle();
  assert.equal(f.text('.trial-song-title'), 'Fast reply', 'an older reply never repaints a newer search');

  await f.api.loadCatalog('x'.repeat(400) + ' <script>');
  const long = f.requests('GET', '/api/trial/catalog').pop();
  const query = decodeURIComponent(long.url.split('q=')[1]);
  assert.equal(query.length, 120, 'the query is capped before it reaches the server');
  assert.ok(!long.url.includes('<script>'), 'the query is URL encoded');
});

test('one deliberate pick locks the session and unlocks audio inside the gesture', async (t) => {
  let selected = null;
  const f = fixture(t, {
    'POST /api/trial/select': ({ body }) => { selected = body; return active(); },
  });
  await f.api.ready;
  await settle();
  const row = f.$(`.trial-song[data-id="${SONG_A}"]`);
  row.querySelector('.trial-pick').click();
  await settle();
  assert.ok(row.classList.contains('confirming'), 'the first click only offers the final confirmation');
  assert.equal(f.requests('POST', '/api/trial/select').length, 0, 'nothing is locked without confirmation');
  assert.match(f.text('.trial-confirm-text'), /唯一能唱/);

  row.querySelector('.trial-confirm-no').click();
  await settle();
  assert.ok(!row.classList.contains('confirming'));
  assert.equal(f.requests('POST', '/api/trial/select').length, 0);

  row.querySelector('.trial-pick').click();
  row.querySelector('.trial-confirm-yes').click();
  assert.equal(f.contexts.length, 1, 'the pick gesture creates the audio context itself');
  assert.ok(f.contexts[0].resumes >= 1, 'and resumes it before awaiting the network');
  await settle();
  assert.deepEqual(selected, { job_id: SONG_A });
  assert.equal(f.api.state.status, 'active');
  assert.ok(f.visible('#playerView') && !f.visible('#chooseView'));
  assert.equal(f.$('#instAudio').getAttribute('src'), '/api/trial/media/instrumental');
  assert.equal(f.$('#guideAudio').getAttribute('src'), '/api/trial/media/vocals');
  assert.ok(f.$('#instAudio').paused, 'a locked song still waits for an explicit play');
  assert.equal(f.text('#playBtn'), '开始演唱');
  assert.equal(f.$('#guideVol').value, '0', 'the guide vocal starts silent');
  assert.equal(f.$('#instAudio').getAttribute('controls'), null, 'no native controls to reach another song');
});

test('a locked session takes the server answer instead of replaying its own choice', async (t) => {
  const f = fixture(t, {
    'POST /api/trial/select': http(409, { detail: 'This guest session already selected its one song.' }),
    'GET /api/trial/state': ({ }) => (f.requests('POST', '/api/trial/select').length ? active() : available()),
  });
  await f.api.ready;
  await settle();
  await f.api.select(SONG_B);
  await settle();
  assert.equal(f.requests('POST', '/api/trial/select').length, 1, 'a conflict is never retried automatically');
  assert.equal(f.api.state.status, 'active');
  assert.equal(f.api.state.song.id, SONG_A, 'the authoritative song wins, not the one this tab wanted');
  assert.ok(f.visible('#trialAlert'));
  assert.match(f.text('#trialAlertText'), /已经选定/);
  assert.ok(f.$('#instAudio').paused);

  // Repeating the same choice is idempotent and simply shows the locked song again.
  const same = fixture(t, { 'POST /api/trial/select': active(), 'GET /api/trial/state': active() });
  await same.api.ready;
  await settle();
  await same.api.select(SONG_A);
  await settle();
  assert.equal(same.api.state.song.id, SONG_A);
  assert.ok(same.visible('#playerView'));
});

test('a resumed active session shows the locked song and waits for an explicit play', async (t) => {
  const f = fixture(t, { 'GET /api/trial/state': active() });
  await f.api.ready;
  await settle();
  assert.ok(f.visible('#playerView'));
  assert.equal(f.text('#trialTitle'), 'Paper Planes');
  assert.ok(f.$('#instAudio').paused, 'reloading an active trial never auto-starts the song');
  assert.equal(f.contexts.length, 0, 'and it does not build an audio graph without a gesture');
  assert.match(f.text('#trialRemaining'), /还可以演唱/);
  assert.match(f.text('#audioStatus'), /已经锁定/);

  f.$('#playBtn').click();
  await settle();
  assert.ok(!f.$('#instAudio').paused, 'the explicit gesture really starts playback');
  assert.equal(f.contexts.length, 1);
  assert.equal(f.text('#playBtn'), '暂停');
  const graph = f.api.audio;
  assert.ok(graph.instGain.gain.value > 0 && graph.instGain.gain.value <= 1, 'music gain stays inside unity');
  assert.equal(graph.guideGain.gain.value, 0, 'the guide vocal is silent until it is asked for');
  assert.equal(graph.master.outputs[0], f.contexts[0].destination, 'output is wired to a real destination');

  f.$('#guideVol').value = '100';
  f.fire(f.$('#guideVol'), 'input');
  assert.equal(graph.guideGain.gain.value, 1);
  assert.equal(f.$('#instAudio').volume, 1, 'element volume stays at unity behind the gain nodes');

  f.$('#playBtn').click();
  await settle();
  assert.ok(f.$('#instAudio').paused && f.$('#guideAudio').paused, 'pause stops both tracks together');
  assert.equal(f.text('#playBtn'), '继续演唱');

  f.$('#instAudio').currentTime = 9;
  f.fire(f.$('#instAudio'), 'seeked');
  assert.equal(f.$('#guideAudio').currentTime, 9, 'the guide track follows every seek');
});

test('lyrics highlight the current line and word, and degrade without them', async (t) => {
  const f = fixture(t, { 'GET /api/trial/state': active() });
  await f.api.ready;
  await settle();
  assert.equal(f.requests('GET', '/api/trial/lyrics').length, 1, 'only the selected song lyrics are read');
  assert.equal(f.all('.trial-line').length, 2);
  assert.equal(f.all('.trial-line')[0].textContent, 'first synthetic line');
  assert.equal(f.all('.trial-word').length, 2);

  const inst = f.$('#instAudio');
  inst.currentTime = 1.2;
  f.fire(inst, 'timeupdate');
  assert.ok(f.all('.trial-line')[0].classList.contains('active'));
  assert.deepEqual(f.all('.trial-word').map(node => node.classList.contains('sung')), [true, false]);
  inst.currentTime = 2.5;
  f.fire(inst, 'timeupdate');
  assert.deepEqual(f.all('.trial-word').map(node => node.classList.contains('sung')), [true, true]);
  inst.currentTime = 4.5;
  f.fire(inst, 'timeupdate');
  assert.ok(f.all('.trial-line')[1].classList.contains('active'));
  assert.ok(!f.all('.trial-line')[0].classList.contains('active'));
  assert.equal(f.text('#elapsed'), '0:04');

  const silent = fixture(t, { 'GET /api/trial/state': active(song(SONG_A, { has_lyrics: false, has_vocals: false,
    media: { instrumental: '/api/trial/media/instrumental' } })) });
  await silent.api.ready;
  await settle();
  assert.equal(silent.requests('GET', '/api/trial/lyrics').length, 0);
  assert.ok(silent.visible('#lyricsFallback'));
  assert.ok(!silent.visible('#guideRow'), 'no guide slider without a guide track');

  const broken = fixture(t, { 'GET /api/trial/state': active(), 'GET /api/trial/lyrics': http(500, {}) });
  await broken.api.ready;
  await settle();
  assert.ok(broken.visible('#lyricsFallback'));
  assert.match(broken.text('#lyricsFallback'), /伴奏仍然可以播放/);
  assert.ok(broken.visible('#playerView'), 'missing lyrics never block the song');
});

test('the natural end consumes the trial and shows only a sign-in call to action', async (t) => {
  let completions = 0;
  const f = fixture(t, {
    'GET /api/trial/state': active(),
    'POST /api/trial/complete': ({ body }) => { completions++; assert.deepEqual(body, {}); return done('complete'); },
  });
  await f.api.ready;
  await settle();
  f.$('#playBtn').click();
  await settle();
  f.fire(f.$('#instAudio'), 'ended');
  await settle();
  assert.equal(completions, 1);
  assert.ok(f.visible('#doneView') && !f.visible('#playerView') && !f.visible('#chooseView'));
  assert.equal(f.$('#loginCta').getAttribute('href'), '/auth/login/?next=%2F');
  assert.ok(!f.visible('#guestEntry'), 'a used trial does not advertise a fresh guest grant');
  assert.equal(f.all('.trial-song, .trial-pick').length, 0, 'no second song can be chosen');
  assert.ok(f.$('#instAudio').paused && f.$('#instAudio').getAttribute('src') === null, 'sound is disarmed');
  assert.equal(f.api.audio.ctx.state, 'suspended');

  f.fire(f.$('#instAudio'), 'ended');
  await settle();
  assert.equal(completions, 1, 'completion is not repeated by a duplicated event');
});

test('a failed completion stops the sound and asks for an explicit retry', async (t) => {
  let attempts = 0;
  const f = fixture(t, {
    'GET /api/trial/state': active(),
    'POST /api/trial/complete': () => (++attempts === 1
      ? http(503, { detail: 'The trial store is unavailable.' }) : done('complete')),
  });
  await f.api.ready;
  await settle();
  f.$('#playBtn').click();
  await settle();
  f.fire(f.$('#instAudio'), 'ended');
  await settle();
  assert.equal(attempts, 1);
  assert.ok(f.$('#instAudio').paused, 'media stops even though the server call failed');
  assert.equal(f.api.micActive, false);
  assert.ok(!f.visible('#doneView'), 'a failed completion is never shown as success');
  assert.equal(f.api.state.status, 'active');
  assert.ok(f.visible('#trialAlert'));
  assert.match(f.text('#trialAlertText'), /还没有确认/);
  assert.equal(f.$('#trialRetry').textContent, '完成试唱');
  assert.ok(f.$('#playBtn').disabled, 'the finished song cannot be replayed while completion is retried');

  f.$('#trialRetry').click();
  await settle();
  assert.equal(attempts, 2);
  assert.ok(f.visible('#doneView'));
  assert.equal(f.api.state.status, 'complete');
});

test('terminal and unauthenticated answers never mint a new trial', async (t) => {
  const used = fixture(t, { 'GET /api/trial/state': done('complete') });
  await used.api.ready;
  await settle();
  assert.ok(used.visible('#doneView'));
  assert.equal(used.requests('GET', '/api/trial/catalog').length, 0, 'a used session does not browse songs');
  assert.match(used.text('#doneMessage'), /本次试唱额度已用完/);

  const expired = fixture(t, { 'GET /api/trial/state': done('expired') });
  await expired.api.ready;
  await settle();
  assert.match(expired.text('#doneTitle'), /已经结束/);
  assert.equal(expired.$('#loginCta').getAttribute('href'), '/auth/login/?next=%2F');

  const gone = fixture(t, { 'GET /api/trial/state': http(410, { detail: 'Your guest song has ended.' }) });
  await gone.api.ready;
  await settle();
  assert.ok(gone.visible('#doneView'));
  assert.equal(gone.api.state.status, 'expired');
  assert.equal(gone.$('#instAudio').getAttribute('src'), null);

  const anonymous = fixture(t, { 'GET /api/trial/state': http(401, { detail: 'Open the guest entry.' }) });
  await anonymous.api.ready;
  await settle();
  assert.ok(anonymous.visible('#doneView'));
  assert.ok(anonymous.visible('#guestEntry'), 'a signed-out visitor is pointed at the explicit opt-in');
  assert.equal(anonymous.$('#guestEntry').getAttribute('href'), '/auth/guest/');
  assert.equal(anonymous.$('#loginCta').getAttribute('href'), '/auth/login/?next=%2F');
  assert.equal(anonymous.requests('POST', '/').length, 0, 'no request tries to create a session by itself');
  assert.equal(anonymous.calls.filter(call => call.url.includes('/auth/guest/')).length, 0);
});

test('server and transport failures surface instead of pretending to work', async (t) => {  let answer = http(500, { detail: '试唱服务暂时不可用。' });
  const f = fixture(t, { 'GET /api/trial/state': () => answer });
  await f.api.ready;
  await settle();
  assert.ok(f.visible('#trialAlert'));
  assert.equal(f.text('#trialAlertText'), '试唱服务暂时不可用。');
  assert.equal(f.$('#trialAlertLink').getAttribute('href'), '/auth/login/?next=%2F');
  assert.equal(f.api.state, null);
  assert.ok(!f.visible('#loadingView'), 'an unknown session shows the failure, not a fake wait');
  assert.ok(f.$('#instAudio').paused);

  answer = available();
  f.$('#trialRetry').click();
  await settle();
  assert.ok(!f.visible('#trialAlert'));
  assert.ok(f.visible('#chooseView'));

  const offline = fixture(t, { 'GET /api/trial/state': new TypeError('Failed to fetch') });
  await offline.api.ready;
  await settle();
  assert.match(offline.text('#trialAlertText'), /无法连接试唱服务/);

  const malformed = fixture(t, { 'GET /api/trial/state': { status: 'active', song: { id: 'x' },
    started_at: null, expires_at: null, remaining_seconds: 5 } });
  await malformed.api.ready;
  await settle();
  assert.ok(malformed.visible('#trialAlert'));
  assert.match(malformed.text('#trialAlertText'), /无法校验/);
  assert.equal(malformed.$('#instAudio').getAttribute('src'), null, 'malformed data never reaches the player');
});

test('a disabled deployment and a consumed grant are explained honestly', async (t) => {
  const off = fixture(t, { 'GET /api/trial/state': http(404, { detail: '访客试唱功能未启用。' }) });
  await off.api.ready;
  await settle();
  assert.equal(off.text('#trialAlertText'), '访客试唱功能未启用。');
  assert.ok(!off.visible('#loadingView') && !off.visible('#playerView') && !off.visible('#doneView'));
  assert.equal(off.$('#instAudio').getAttribute('src'), null);
  assert.equal(off.contexts.length, 0, 'a disabled deployment never builds an audio graph');
  assert.equal(off.requests('POST', '/api/trial').length, 0);

  // A consumed selection answers 410; the state endpoint decides whether it was used or timed out.
  let consumedTrial = false;
  const consumed = fixture(t, {
    'GET /api/trial/state': () => (consumedTrial ? done('complete') : active()),
    'POST /api/trial/complete': () => { consumedTrial = true; return http(410, { detail: '你的试唱歌曲已经结束。' }); },
  });
  await consumed.api.ready;
  await settle();
  consumed.$('#playBtn').click();
  await settle();
  consumed.fire(consumed.$('#instAudio'), 'ended');
  await settle(10);
  assert.equal(consumed.api.state.status, 'complete');
  assert.ok(consumed.visible('#doneView'));
  assert.match(consumed.text('#doneMessage'), /Paper Planes/, 'the finished song is named from what was shown');
  assert.ok(consumed.$('#instAudio').paused && !consumed.$('#instAudio').getAttribute('src'));
  assert.equal(consumed.requests('GET', '/api/trial/state').length, 2, 'the 410 is resolved by one state read');

  // Completing an already-expired selection may answer 200 with an explicit expired state.
  const late = fixture(t, { 'GET /api/trial/state': active(), 'POST /api/trial/complete': done('expired') });
  await late.api.ready;
  await settle();
  late.$('#playBtn').click();
  await settle();
  late.fire(late.$('#instAudio'), 'ended');
  await settle();
  assert.equal(late.api.state.status, 'expired');
  assert.match(late.text('#doneTitle'), /已经结束/);
  assert.equal(late.all('.trial-pick, .trial-confirm-yes').length, 0);
});

test('the trial never touches the signed-in player\'s storage, profile or APIs', async (t) => {
  // The shared player keeps its queue, invites and device topology in these keys. A guest
  // trial must neither read them nor add anything of its own.
  const shared = {
    'openk.queue': '[{"id":"aaaaaaaaaaaa"}]',
    'openk.account.invites.v1': '{"account":{"room":{"code":"123456","version":1}}}',
    'openk.device.v1': '{"device":"living-room"}',
  };
  const f = fixture(t, {
    'GET /api/trial/state': available(),
    'POST /api/trial/select': active(),
    'POST /api/trial/complete': done('complete'),
  }, { storage: { ...shared } });
  await f.api.ready;
  await settle();
  const row = f.$(`.trial-song[data-id="${SONG_A}"]`);
  row.querySelector('.trial-pick').click();
  row.querySelector('.trial-confirm-yes').click();
  await settle();
  f.$('#playBtn').click();
  await settle();
  f.$('#musicVol').value = '55';
  f.fire(f.$('#musicVol'), 'input');
  f.$('#guideVol').value = '40';
  f.fire(f.$('#guideVol'), 'input');
  f.$('#micToggle').click();
  await settle();
  f.fire(f.$('#instAudio'), 'ended');
  await settle();
  assert.equal(f.api.state.status, 'complete');

  for (const [key, value] of Object.entries(shared)) {
    assert.equal(f.w.localStorage.getItem(key), value, key + ' must be left exactly as it was');
  }
  assert.equal(f.w.localStorage.length, Object.keys(shared).length,
    'the trial stores no choice, volume or "song used" flag of its own');
  assert.equal(f.w.sessionStorage.length, 0);
  assert.equal(f.w.document.cookie, '', 'the trial sets no script-visible cookie');
  const outside = f.calls.map(call => call.url.split('?')[0])
    .filter(url => !url.startsWith('/api/trial/'));
  assert.deepEqual(outside, [], 'the guest page calls nothing but its own limited API');

  // A fresh page in the same browser starts from the server state with a silent microphone.
  const again = fixture(t, { 'GET /api/trial/state': done('complete') }, { storage: { ...shared } });
  await again.api.ready;
  await settle();
  assert.equal(again.$('#micToggle').getAttribute('aria-pressed'), 'false');
  assert.equal(again.$('#guideVol').value, '0');
  assert.equal(again.w.localStorage.length, Object.keys(shared).length);
});

test('microphone monitoring is opt-in, bounded and always released', async (t) => {
  const f = fixture(t, { 'GET /api/trial/state': active() });
  await f.api.ready;
  await settle();
  assert.equal(f.$('#micToggle').getAttribute('aria-pressed'), 'false');
  assert.match(f.text('#micNote'), /耳机/);
  assert.equal(f.w.navigator.mediaDevices.calls, 0);

  f.$('#micToggle').click();
  await settle();
  assert.equal(f.w.navigator.mediaDevices.calls, 1);
  assert.equal(f.api.micActive, true);
  assert.equal(f.$('#micToggle').getAttribute('aria-pressed'), 'true');
  const monitor = f.api.audio.monitorGain;
  assert.ok(monitor.gain.value > 0 && monitor.gain.value <= 0.6, 'monitoring stays at a safe default level');
  assert.ok(f.api.audio.mic.gain.gain.value <= 1);
  const compressor = f.api.audio.mic.limiter;
  assert.equal(compressor.kind, 'compressor');
  assert.equal(f.api.audio.mic.gain.outputs[0], compressor, 'the monitor path runs through the compressor');
  assert.equal(compressor.outputs[0], monitor);
  assert.equal(monitor.outputs[0], f.api.audio.master);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.includes('media')).length, 0,
    'nothing about the microphone is uploaded');

  f.$('#micToggle').click();
  await settle();
  assert.equal(f.api.micActive, false);
  assert.equal(f.streams[0].tracks[0].stops, 1, 'turning it off really stops the capture track');

  f.$('#micToggle').click();
  await settle();
  assert.equal(f.api.micActive, true);
  Object.defineProperty(f.doc, 'visibilityState', { configurable: true, value: 'hidden' });
  f.doc.dispatchEvent(new f.w.Event('visibilitychange'));
  await settle();
  assert.equal(f.api.micActive, false, 'a hidden page never keeps the microphone open');
  assert.equal(f.streams[1].tracks[0].stops, 1);

  const denied = fixture(t, { 'GET /api/trial/state': active() },
    { mic: Object.assign(new Error('denied'), { name: 'NotAllowedError' }) });
  await denied.api.ready;
  await settle();
  denied.$('#playBtn').click();
  await settle();
  denied.$('#micToggle').click();
  await settle();
  assert.equal(denied.api.micActive, false);
  assert.match(denied.text('#micStatus'), /授权被拒绝/);
  assert.equal(denied.$('#micToggle').getAttribute('aria-pressed'), 'false');
  assert.ok(!denied.$('#instAudio').paused, 'a refused microphone never stops the backing track');
});

test('a deferred microphone permission can never start capture after it is cancelled', async (t) => {
  const f = fixture(t, { 'GET /api/trial/state': active() }, { micDefer: true });
  await f.api.ready;
  await settle();
  f.$('#playBtn').click();
  await settle();
  f.$('#micToggle').click();
  await settle();
  assert.equal(f.w.navigator.mediaDevices.calls, 1);
  assert.equal(f.api.micPending, true);
  assert.equal(f.api.micActive, false);

  f.$('#micToggle').click();
  await settle();
  assert.equal(f.w.navigator.mediaDevices.calls, 1, 'a second click never opens a second request');
  f.resolveMic();
  await settle();
  assert.equal(f.api.micActive, false, 'a cancelled permission never starts capture');
  assert.equal(f.api.audio.mic, null, 'and no monitor node is left behind');
  assert.equal(f.streams.length, 1);
  assert.equal(f.streams[0].tracks[0].stops, 1, 'the late stream is stopped instead of wired up');
  assert.equal(f.$('#micToggle').getAttribute('aria-pressed'), 'false');
  assert.ok(!f.$('#instAudio').paused, 'the backing track is untouched by the microphone');

  for (const [name, interrupt] of [
    ['a hidden page', fixed => fixed.hide()],
    ['the end of the song', fixed => fixed.fire(fixed.$('#instAudio'), 'ended')],
    ['leaving the page', fixed => fixed.w.dispatchEvent(new fixed.w.Event('pagehide'))],
  ]) {
    const race = fixture(t, { 'GET /api/trial/state': active(), 'POST /api/trial/complete': done('complete') },
      { micDefer: true });
    await race.api.ready;
    await settle();
    race.$('#playBtn').click();
    await settle();
    race.$('#micToggle').click();
    await settle();
    assert.equal(race.api.micPending, true, name + ': the permission is still open');
    interrupt(race);
    await settle();
    race.resolveMic();
    await settle(8);
    assert.equal(race.api.micActive, false, name + ' must cancel a pending microphone');
    assert.equal(race.streams[0].tracks[0].stops, 1, name + ' must stop the late capture track');
    assert.equal(race.api.audio.micStream, null);
  }

  // Turning it on again after a cancellation still works and leaks nothing.
  const retry = fixture(t, { 'GET /api/trial/state': active() }, { micDefer: true });
  await retry.api.ready;
  await settle();
  retry.$('#micToggle').click();
  await settle();
  retry.$('#micToggle').click();
  await settle();
  retry.$('#micToggle').click();
  await settle();
  retry.resolveMic();
  await settle(8);
  assert.equal(retry.w.navigator.mediaDevices.calls, 2);
  assert.equal(retry.api.micActive, true, 'the newest request is the one that is honoured');
  assert.equal(retry.streams[0].tracks[0].stops, 1, 'the cancelled stream stays stopped');
  assert.equal(retry.streams[1].tracks[0].stops, 0);
  assert.equal(retry.api.audio.micStream, retry.streams[1]);
});

test('replies that lost the race cannot revive a finished or torn-down session', async (t) => {
  const slow = deferred();
  let reads = 0;
  const f = fixture(t, {
    'GET /api/trial/state': () => (++reads === 1 ? active() : slow.promise),
    'POST /api/trial/complete': done('complete'),
  });
  await f.api.ready;
  await settle();
  f.$('#playBtn').click();
  await settle();
  const stale = f.api.refresh();
  f.fire(f.$('#instAudio'), 'ended');
  await settle();
  assert.equal(f.api.state.status, 'complete');
  slow.resolve(active());
  await stale;
  await settle();
  assert.equal(f.api.state.status, 'complete', 'a late active reply never resurrects the player');
  assert.ok(f.visible('#doneView') && !f.visible('#playerView') && !f.visible('#chooseView'));
  assert.equal(f.$('#instAudio').getAttribute('src'), null, 'and it never reloads media');
  assert.ok(f.$('#instAudio').paused);

  const lateError = deferred();
  let errorReads = 0;
  const errored = fixture(t, {
    'GET /api/trial/state': () => (++errorReads === 1 ? active() : lateError.promise),
    'POST /api/trial/complete': done('complete'),
  });
  await errored.api.ready;
  await settle();
  const failing = errored.api.refresh();
  errored.fire(errored.$('#instAudio'), 'ended');
  await settle();
  lateError.resolve(http(500, { detail: 'The trial store is unavailable.' }));
  await failing;
  await settle();
  assert.ok(!errored.visible('#trialAlert'), 'a late failure never covers a finished session');
  assert.ok(errored.visible('#doneView'));

  const torn = deferred();
  let tornReads = 0;
  const leaving = fixture(t, { 'GET /api/trial/state': () => (++tornReads === 1 ? available() : torn.promise) });
  await leaving.api.ready;
  await settle();
  const abandoned = leaving.api.refresh();
  leaving.api.teardown();
  torn.resolve(active());
  await abandoned;
  await settle();
  assert.equal(leaving.api.state.status, 'available', 'nothing is applied after teardown');
  assert.equal(leaving.$('#instAudio').getAttribute('src'), null);
  assert.ok(leaving.$('#playerView').hidden);

  const slowCatalog = deferred();
  const chooser = fixture(t, {
    'GET /api/trial/state': available(),
    'GET /api/trial/catalog': ({ url }) => (url.includes('q=') ? slowCatalog.promise : catalog()),
    'POST /api/trial/select': active(),
  });
  await chooser.api.ready;
  await settle();
  const pendingCatalog = chooser.api.loadCatalog('late');
  await chooser.api.select(SONG_A);
  await settle();
  slowCatalog.resolve(catalog([{ id: SONG_B, title: 'Too late', track: 'Too late',
    artist: 'Stale search', duration: 10 }]));
  await pendingCatalog;
  await settle();
  assert.equal(chooser.api.state.status, 'active');
  assert.equal(chooser.all('.trial-song').length, 0, 'a locked session keeps no song list at all');
  assert.ok(!chooser.doc.body.textContent.includes('Too late'));
});

test('a suspended audio context stops sound and asks for an explicit restart', async (t) => {
  const f = fixture(t, { 'GET /api/trial/state': active() });
  await f.api.ready;
  await settle();
  f.$('#playBtn').click();
  f.$('#micToggle').click();
  await settle();
  assert.ok(!f.$('#instAudio').paused && f.api.micActive);

  f.api.audio.ctx.setState('suspended');
  await settle();
  assert.ok(f.$('#instAudio').paused && f.$('#guideAudio').paused, 'an interrupted output stops the song');
  assert.equal(f.api.micActive, false, 'and releases the microphone');
  assert.equal(f.streams[0].tracks[0].stops, 1);
  assert.match(f.text('#audioStatus'), /打断/);
  assert.equal(f.text('#playBtn'), '继续演唱');

  f.$('#playBtn').click();
  await settle();
  assert.ok(!f.$('#instAudio').paused, 'the visitor can start it again explicitly');
  assert.equal(f.api.audio.ctx.state, 'running');

  // Our own suspend during completion is not an interruption and must not be reported as one.
  const finishing = fixture(t, { 'GET /api/trial/state': active(), 'POST /api/trial/complete': done('complete') });
  await finishing.api.ready;
  await settle();
  finishing.$('#playBtn').click();
  await settle();
  finishing.fire(finishing.$('#instAudio'), 'ended');
  await settle();
  assert.equal(finishing.api.state.status, 'complete');
  assert.ok(!/打断/.test(finishing.text('#audioStatus')));
  assert.ok(!finishing.visible('#trialAlert'));
});

test('a lapsed window stops sound immediately and never resumes on its own', async (t) => {
  let answer = active();
  const f = fixture(t, { 'GET /api/trial/state': () => answer });
  await f.api.ready;
  await settle();
  f.$('#playBtn').click();
  f.$('#micToggle').click();
  await settle();
  assert.ok(!f.$('#instAudio').paused && f.api.micActive);

  answer = new TypeError('Failed to fetch');
  await f.api.lapse();
  await settle();
  assert.ok(f.$('#instAudio').paused, 'the end of the window stops buffered playback at once');
  assert.equal(f.api.micActive, false, 'and stops the microphone at once');
  assert.ok(f.$('#playBtn').disabled, 'an uncertain answer never lets playback resume');
  assert.match(f.text('#audioStatus'), /无法连接服务器/);
  assert.equal(f.api.state.status, 'active', 'the page invents no terminal state of its own');

  answer = active();
  await f.api.refresh();
  await settle();
  assert.ok(!f.$('#playBtn').disabled, 'an authoritative active answer re-arms the control');
  assert.ok(f.$('#instAudio').paused, 'but nothing resumes without a gesture');
  assert.match(f.text('#audioStatus'), /点击播放/);

  answer = done('expired');
  await f.api.lapse();
  await settle();
  assert.equal(f.api.state.status, 'expired');
  assert.ok(f.visible('#doneView'));
  assert.equal(f.$('#instAudio').getAttribute('src'), null);

  // The countdown timer itself reaches the same place without anyone calling lapse().
  const timed = fixture(t, { 'GET /api/trial/state': active(song(), { remaining_seconds: 0.5 }) });
  await timed.api.ready;
  await settle();
  timed.$('#playBtn').click();
  await settle();
  assert.ok(!timed.$('#instAudio').paused);
  await wait(1300);
  assert.ok(timed.$('#instAudio').paused, 'the countdown itself disarms at the deadline');
  assert.equal(timed.api.view.tick, 0, 'and stops its own timer');
});

test('a partly built audio graph fails loudly instead of pretending to fall back', async (t) => {
  const partial = fixture(t, { 'GET /api/trial/state': active() }, { failElementSource: 'guideAudio' });
  await partial.api.ready;
  await settle();
  partial.$('#playBtn').click();
  await settle();
  assert.ok(!partial.$('#instAudio').paused, 'the accompaniment still plays through its own graph');
  assert.ok(partial.api.audio.instGain && !partial.api.audio.guideGain);
  assert.ok(!partial.visible('#guideRow'), 'the guide control is withdrawn');
  assert.match(partial.text('#audioStatus'), /原唱音轨/);

  const plain = fixture(t, { 'GET /api/trial/state': active() }, { failElementSource: 'instAudio' });
  await plain.api.ready;
  await settle();
  plain.$('#playBtn').click();
  await settle();
  assert.equal(plain.api.audio.ctx, null);
  assert.equal(plain.api.audio.captured, false, 'nothing was attached, so element volume is real');
  assert.ok(!plain.$('#instAudio').paused);
  assert.equal(plain.$('#instAudio').volume, 0.8);
  assert.match(plain.text('#audioStatus'), /不支持 Web Audio/);

  const broken = fixture(t, { 'GET /api/trial/state': active() }, { failSourceConnect: 'instAudio' });
  await broken.api.ready;
  await settle();
  broken.$('#playBtn').click();
  await settle();
  assert.equal(broken.api.audio.ctx, null);
  assert.equal(broken.api.audio.captured, true);
  assert.ok(broken.visible('#trialAlert'), 'a captured element with no graph is an explicit failure');
  assert.match(broken.text('#trialAlertText'), /音频输出/);
  assert.ok(broken.$('#instAudio').paused, 'and playback is never claimed to have started');

  const stuck = fixture(t, { 'GET /api/trial/state': active() }, { resumeFails: true });
  await stuck.api.ready;
  await settle();
  stuck.$('#playBtn').click();
  await settle();
  assert.ok(stuck.$('#instAudio').paused, 'a refused resume is not treated as success');
  assert.match(stuck.text('#audioStatus'), /没有启动音频输出/);
  assert.equal(stuck.text('#playBtn'), '开始演唱');

  const guideFails = fixture(t, { 'GET /api/trial/state': active() }, { guidePlayRejects: true });
  await guideFails.api.ready;
  await settle();
  guideFails.$('#playBtn').click();
  await settle();
  assert.ok(!guideFails.$('#instAudio').paused, 'a failing guide track never stops the accompaniment');
  assert.ok(!guideFails.visible('#guideRow'));
  assert.match(guideFails.text('#audioStatus'), /原唱音轨/);
});

test('sign-in clicks without navigation and back-cache returns keep the trial usable', async (t) => {
  const f = fixture(t, { 'GET /api/trial/state': active() });
  await f.api.ready;
  await settle();
  f.$('#playBtn').click();
  await settle();
  const context = f.api.audio.ctx;
  const link = f.$('#topSignIn');
  link.addEventListener('click', event => event.preventDefault());
  for (const modifiers of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, {}]) {
    link.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
    await settle();
    assert.equal(f.api.view.disposed, false, 'a click does not prove the document unloaded');
    assert.equal(context.state, 'running');
    assert.equal(f.$('#instAudio').getAttribute('src'), '/api/trial/media/instrumental');
    assert.ok(!f.$('#instAudio').paused);
  }
  const hidden = new f.w.Event('pagehide');
  Object.defineProperty(hidden, 'persisted', { value: true });
  f.w.dispatchEvent(hidden);
  await settle();
  assert.ok(f.$('#instAudio').paused);
  assert.notEqual(context.state, 'closed', 'a cached document retains its media-element graph');
  const shown = new f.w.Event('pageshow');
  Object.defineProperty(shown, 'persisted', { value: true });
  f.w.dispatchEvent(shown);
  await settle();
  assert.equal(f.api.state.status, 'active');
  assert.ok(f.$('#instAudio').paused, 'returning from the cache never autoplays');
  f.$('#playBtn').click();
  await settle();
  assert.equal(f.api.audio.ctx, context);
  assert.equal(context.state, 'running');
  assert.ok(!f.$('#instAudio').paused, 'an explicit gesture resumes the retained graph');
  assert.equal(f.calls.filter(call => call.url === '/api/trial/complete').length, 0);
});

test('leaving the page releases the microphone, the audio and the timers', async (t) => {
  const f = fixture(t, { 'GET /api/trial/state': active() });
  await f.api.ready;
  await settle();
  f.$('#playBtn').click();
  f.$('#micToggle').click();
  await settle();
  assert.equal(f.api.micActive, true);
  assert.ok(!f.$('#instAudio').paused);

  f.w.dispatchEvent(new f.w.Event('pagehide'));
  await settle();
  assert.equal(f.api.micActive, false);
  assert.equal(f.streams[0].tracks[0].stops, 1);
  assert.ok(f.$('#instAudio').paused && f.$('#guideAudio').paused);
  assert.equal(f.$('#instAudio').getAttribute('src'), null);
  assert.equal(f.api.audio.ctx.state, 'closed');
  assert.equal(f.api.view.tick, 0, 'the countdown timer is cleared');

  const before = f.calls.length;
  await wait(1200);
  assert.equal(f.calls.length, before, 'a torn-down page stops polling the trial API');
});

test('the page works without Web Audio and never amplifies past unity', async (t) => {
  const f = fixture(t, { 'GET /api/trial/state': active() }, { audio: false });
  await f.api.ready;
  await settle();
  f.$('#playBtn').click();
  await settle();
  assert.equal(f.api.audio.ctx, null);
  assert.ok(!f.$('#instAudio').paused, 'playback still works with element volume only');
  assert.equal(f.$('#instAudio').volume, 0.8);
  f.$('#musicVol').value = '100';
  f.fire(f.$('#musicVol'), 'input');
  assert.equal(f.$('#instAudio').volume, 1);
});

test('blocked playback is reported instead of silently failing', async (t) => {
  const f = fixture(t, { 'GET /api/trial/state': active() }, { playRejects: true });
  await f.api.ready;
  await settle();
  f.$('#playBtn').click();
  await settle();
  assert.ok(f.$('#instAudio').paused);
  assert.match(f.text('#audioStatus'), /拦截了播放/);
});
