/* Anonymous one-song guest trial in real Chrome: a synthetic catalog, a synthetic
   microphone and real audio output. No account, no credentials, no real music. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { CDP, chromePath, freePort, waitFor, sleep, stop, errors } = require('./test_browser');

const ROOT = path.resolve(__dirname, '../..');

async function main() {
  // Keep every scratch file inside the project's ignored artifact directory.
  const base = process.env.TMPDIR && process.env.TMPDIR.trim()
    ? process.env.TMPDIR : path.join(ROOT, '.test-artifacts');
  await fs.mkdir(base, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(base, 'openk-trial-'));
  const browserDirectory = await fs.mkdtemp(path.join(
    process.platform === 'win32' ? os.tmpdir() : '/tmp', 'openk-trial-chrome-'));
  if (process.platform !== 'win32') {
    const socket = path.join(
      await fs.realpath(browserDirectory), 'com.google.Chrome.XXXXXX', 'SingletonSocket');
    assert.ok(Buffer.byteLength(socket) < 104,
      'Chrome temporary socket path must stay below the Unix path limit');
  }
  const tabs = [], checks = [];
  let server, disabled, browser, log = '', cleanupPromise;
  const cleanup = () => cleanupPromise ||= (async () => {
    for (const tab of tabs) tab.close();
    await stop(browser);
    await stop(disabled);
    await stop(server);
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
    await fs.rm(browserDirectory, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  })();
  const interrupted = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const deadline = setTimeout(() => {
    console.error('Guest trial regression exceeded three minutes.');
    cleanup().finally(() => process.exit(1));
  }, 180000);
  const pass = name => { checks.push(name); console.log('PASS ' + name); };

  try {
    const python = process.env.OPENK_TEST_PYTHON || path.join(ROOT, '.venv/bin/python');
    const data = path.join(scratch, 'data');
    const demo = spawnSync(python, ['-m', 'tools.demo', data, '--showcase'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(demo.status, 0, demo.stderr);
    const key = 'openk-guest-trial-fixture-key-0123456789_abcdefghijklmnopqrstuvwxyz';
    const keyFile = path.join(scratch, 'identity');
    await fs.writeFile(keyFile, key, { mode: 0o600 });
    const port = await freePort();
    const origin = 'http://127.0.0.1:' + port;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OPENK_')));
    server = spawn(python, ['-m', 'backend.main'], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, PYTHONDONTWRITEBYTECODE: '1', OPENK_HOST: '127.0.0.1', OPENK_PORT: String(port),
        OPENK_DATA_DIR: data, OPENK_JOBS_DIR: path.join(data, 'jobs'),
        OPENK_RESUME_ON_START: 'false', OPENK_IDENTITY_KEY_FILE: keyFile,
        OPENK_GUEST_TRIAL_ENABLED: 'true' },
    });
    server.stdout.on('data', chunk => { log += chunk; });
    server.stderr.on('data', chunk => { log += chunk; });
    await waitFor(async () => (await fetch(origin + '/api/health')).ok, 'guest trial fixture');

    // A trial identity is a proxy assertion, never a browser-held secret: the synthetic
    // hop key stands in for the private gateway connection.
    const guest = { id: randomUUID(), expires_at: Math.floor(Date.now() / 1000) + 3600 };
    const headers = { 'X-OpenK-Identity-Key': key,
      'X-OpenK-Guest': Buffer.from(JSON.stringify(guest)).toString('base64url') };

    const html = await fetch(origin + '/try', { redirect: 'manual' });
    assert.equal(html.status, 200, 'the guest page is served on an enabled deployment');
    const markup = await html.text();
    assert.ok(markup.includes('/trial-assets/trial.js') && markup.includes('/trial-assets/trial.css'),
      'the page uses the agreed public asset URLs');
    assert.ok(markup.includes('<html lang="zh-CN">'), 'the guest page is served as Simplified Chinese');
    for (const copy of ['不用注册，先唱一首。', '选择你要唱的那一首', '打开麦克风监听', '登录后继续演唱']) {
      assert.ok(markup.includes(copy), 'the guest page shows its Chinese copy: ' + copy);
    }
    assert.ok(!/Sing this song|Start singing|Guest trial|Sign in to keep singing/.test(markup),
      'no English chrome is left in the guest page');
    for (const forbidden of ['/app.js', '/styles.css', '/account.js', '/room-client.js', '/api/jobs', '/media/']) {
      assert.ok(!markup.includes(forbidden), 'the guest page must not reference ' + forbidden);
    }
    assert.equal((await fetch(origin + '/try/')).status, 200);
    for (const asset of ['/trial-assets/trial.js', '/trial-assets/trial.css']) {
      assert.equal((await fetch(origin + asset)).status, 200, asset + ' is public');
    }
    for (const refused of ['/trial-assets/app.js', '/trial-assets/index.html', '/trial-assets/trial.js.map']) {
      assert.equal((await fetch(origin + refused)).status, 404, refused + ' is not a public guest asset');
    }
    assert.equal((await fetch(origin + '/api/trial/state')).status, 401,
      'the trial API is closed without a gateway assertion');
    const state = await fetch(origin + '/api/trial/state', { headers });
    assert.equal(state.status, 200);
    assert.equal(state.headers.get('cache-control'), 'private, no-store');
    assert.equal((await state.json()).status, 'available');
    // A guest assertion is confined to the trial API: the gateway must not attach it to the
    // page, its assets or any ordinary route, and the application refuses it there anyway.
    for (const route of ['/api/jobs', '/api/rooms', '/media/000000000001/stems/instrumental.wav',
      '/try', '/trial-assets/trial.js', '/admin']) {
      assert.equal((await fetch(origin + route, { headers })).status, 403,
        'a guest assertion must not authorize ' + route);
    }
    pass('The trial page and its two public assets are served without any signed-in asset');

    // The same build with the feature switched off must not expose the page, the assets or
    // the API at all: a probe can tell an enabled deployment from a disabled one.
    const disabledPort = await freePort();
    const disabledOrigin = 'http://127.0.0.1:' + disabledPort;
    disabled = spawn(python, ['-m', 'backend.main'], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, PYTHONDONTWRITEBYTECODE: '1', OPENK_HOST: '127.0.0.1', OPENK_PORT: String(disabledPort),
        OPENK_DATA_DIR: path.join(scratch, 'off'), OPENK_JOBS_DIR: path.join(scratch, 'off', 'jobs'),
        OPENK_RESUME_ON_START: 'false' },
    });
    disabled.stdout.on('data', chunk => { log += chunk; });
    disabled.stderr.on('data', chunk => { log += chunk; });
    await waitFor(async () => (await fetch(disabledOrigin + '/api/health')).ok, 'disabled trial fixture');
    for (const route of ['/try', '/try/', '/trial-assets/trial.js', '/trial-assets/trial.css',
      '/api/trial/state', '/api/trial/catalog']) {
      assert.equal((await fetch(disabledOrigin + route)).status, 404,
        route + ' must not exist while guest trials are disabled');
      assert.equal((await fetch(disabledOrigin + route, { headers })).status,
        route.startsWith('/api/trial/') ? 404 : 403,
        route + ' must stay refused even with a guest assertion');
    }
    assert.equal((await fetch(disabledOrigin + '/')).status, 200, 'the ordinary application is unaffected');
    await stop(disabled);
    disabled = null;
    pass('A deployment with guest trials disabled serves no trial page, asset or API');

    const profile = path.join(browserDirectory, 'profile');
    browser = spawn(await chromePath(), [
      '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings',
      '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
    ], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, TMPDIR: browserDirectory },
    });
    browser.stdout.on('data', () => {});
    browser.stderr.on('data', chunk => { log += chunk; });
    const debugPort = await waitFor(async () =>
      Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]),
    'guest trial Chrome');

    const requested = [];
    async function page(route = '/try') {
      const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
      const tab = await CDP.connect(target.webSocketDebuggerUrl);
      tabs.push(tab);
      await tab.send('Network.enable');
      // Model the private gateway hop: only /api/trial/ requests carry the guest assertion
      // and the hop key. The page, its assets and every other route reach the application
      // with no identity at all, exactly as a browser session cookie would behave.
      await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      tab.socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method !== 'Fetch.requestPaused') return;
        const { requestId, request } = message.params;
        const injected = new URL(request.url).pathname.startsWith('/api/trial/') ? headers : {};
        requested.push(new URL(request.url).pathname);
        tab.send('Fetch.continueRequest', {
          requestId,
          headers: Object.entries({ ...request.headers, ...injected })
            .map(([name, value]) => ({ name, value: String(value) })),
        }).catch(() => {});
      });
      await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
      await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        // A synthetic oscillator stands in for a physical microphone: no real capture device
        // is ever opened, and the page still sees a normal MediaStream.
        window.__testMics = [];
        window.__micDelay = 0;
        navigator.mediaDevices.getUserMedia = async () => {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const destination = context.createMediaStreamDestination();
          gain.gain.value = .02;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          window.__testMics.push({ context, stream: destination.stream });
          // A real permission prompt can stay open for a long time.
          if (window.__micDelay) await new Promise(resolve => setTimeout(resolve, window.__micDelay));
          await context.resume();
          return destination.stream;
        };` });
      await tab.send('Page.navigate', { url: origin + route });
      await waitFor(() => tab.evaluate('!!window.OpenKTrial'), 'guest trial script on ' + route);
      await tab.evaluate('window.OpenKTrial.ready');
      return tab;
    }
    const audible = tab => tab.evaluate(`(() => {
      const api = window.OpenKTrial, graph = api.audio;
      const inst = document.getElementById('instAudio');
      if (!graph.ctx || graph.ctx.state !== 'running' || inst.paused || inst.currentTime <= 0) return false;
      if (!window.__probe || window.__probe.context !== graph.ctx) {
        window.__probe = graph.ctx.createAnalyser();
        graph.master.connect(window.__probe);
      }
      const samples = new Float32Array(window.__probe.fftSize);
      window.__probe.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) > .001;
    })()`);
    /** The guest page has its own stylesheet, so its responsive behaviour needs its own guard. */
    async function assertFits(tab, label, width = 390, height = 844) {
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      await sleep(150);
      const report = await tab.evaluate(`(() => ({
        scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
        touch: [...document.querySelectorAll('button:not([hidden]), a.trial-button, .trial-signin')]
          .filter(node => node.getBoundingClientRect().height > 0)
          .map(node => Math.round(node.getBoundingClientRect().height)).filter(value => value < 44),
        overflow: [...document.body.querySelectorAll('*')].filter(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 1 && rect.height > 1 && getComputedStyle(node).visibility !== 'hidden'
            && (rect.left < -1 || rect.right > innerWidth + 1);
        }).map(node => node.tagName + '#' + node.id).slice(0, 6),
      }))()`);
      assert.ok(report.scrollWidth <= report.width + 1, label + ' scrolls sideways: ' + JSON.stringify(report));
      assert.deepEqual(report.overflow, [], label + ' has content outside the viewport');
      assert.deepEqual(report.touch, [], label + ' has controls below the 44px touch target');
      await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(80);
    }

    /** Optional visual diagnostics, written only when the runner asks for artifacts. */
    async function capture(tab, name, width = 1100, height = 900) {
      const artifacts = process.env.OPENK_TEST_ARTIFACTS;
      if (!artifacts) return;
      await fs.mkdir(artifacts, { recursive: true });
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
      await tab.send('Page.bringToFront');
      await sleep(120);
      const image = await tab.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(artifacts, 'trial-' + name + '.png'), Buffer.from(image.data, 'base64'));
      await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    }

    const visitor = await page('/try');
    await waitFor(() => visitor.evaluate('document.querySelectorAll(".trial-song").length >= 3'),
      'the guest catalog lists synthetic songs');
    assert.ok(await visitor.evaluate(`(() => {
      const inst = document.getElementById('instAudio'), guide = document.getElementById('guideAudio');
      return OpenKTrial.state.status === 'available' && inst.paused && guide.paused
        && !inst.getAttribute('src') && !guide.getAttribute('src')
        && OpenKTrial.audio.ctx === null && window.__testMics.length === 0
        && localStorage.length === 0 && sessionStorage.length === 0
        && !document.getElementById('playerView').hidden === false;
    })()`), 'Opening /try must not play, select, record or store anything.');
    pass('The guest page opens silent: no autoplay, no microphone, no local identity');

    await assertFits(visitor, 'the guest song list on a phone');
    await capture(visitor, 'choose');
    await capture(visitor, 'choose-phone', 390, 844);
    pass('The song list fits a phone screen with reachable controls');

    await visitor.evaluate('document.getElementById("songSearch").focus()');
    await visitor.send('Input.insertText', { text: 'Pixel' });
    await waitFor(() => visitor.evaluate(`document.querySelectorAll('.trial-song').length === 1 &&
      document.querySelector('.trial-song-title').textContent.includes('Pixel')`),
    'typing narrows the guest catalog through the server');
    const chosen = await visitor.evaluate('document.querySelector(".trial-song").dataset.id');
    const other = await visitor.evaluate(`(async () => {
      const response = await fetch('/api/trial/catalog', { credentials: 'same-origin', cache: 'no-store' });
      const value = await response.json();
      return value.songs.map(song => song.id).find(id => id !== ${JSON.stringify(chosen)});
    })()`);
    assert.match(chosen, /^[0-9a-f]{12}$/);
    assert.match(other, /^[0-9a-f]{12}$/);
    pass('Server-side search narrows the catalog without exposing media paths');

    await visitor.click(`.trial-song[data-id="${chosen}"] .trial-pick`);
    assert.ok(await visitor.evaluate(`document.querySelector('.trial-song[data-id="${chosen}"]').classList.contains('confirming')
      && OpenKTrial.state.status === 'available'
      && document.querySelector('.trial-confirm-text').textContent.includes('唯一能唱')
      && document.querySelector('.trial-pick').textContent === '唱这首'`),
    'the first click only asks for confirmation, in Chinese');
    await visitor.click(`.trial-song[data-id="${chosen}"] .trial-confirm-yes`);
    await waitFor(() => visitor.evaluate('OpenKTrial.state.status === "active"'), 'the confirmed pick locks one song');
    assert.ok(await visitor.evaluate(`(() => {
      const inst = document.getElementById('instAudio');
      return OpenKTrial.state.song.id === ${JSON.stringify(chosen)}
        && inst.getAttribute('src') === '/api/trial/media/instrumental'
        && inst.paused && !!OpenKTrial.audio.ctx
        && document.getElementById('playBtn').textContent === '开始演唱'
        && !inst.hasAttribute('controls');
    })()`), 'A locked song arms the player but still waits for an explicit play.');
    assert.ok(await visitor.evaluate(`/已经锁定/.test(document.getElementById('audioStatus').textContent)
      && /还可以演唱/.test(document.getElementById('trialRemaining').textContent)`),
    'The locked player explains itself in Chinese.');
    pass('One deliberate confirmation locks the song and unlocks audio without autoplay');

    // The locked selection is the only thing the media routes will serve, and it must look
    // like private, sandboxed, seekable audio rather than a cacheable public file.
    const audioResponse = await fetch(origin + '/api/trial/media/instrumental', { headers });
    assert.equal(audioResponse.status, 200);
    assert.equal(audioResponse.headers.get('content-type'), 'audio/wav');
    assert.equal(audioResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(audioResponse.headers.get('cache-control'), 'private, no-store');
    assert.equal(audioResponse.headers.get('accept-ranges'), 'bytes');
    assert.equal(audioResponse.headers.get('content-encoding'), null, 'audio is not transport compressed');
    assert.ok((audioResponse.headers.get('content-security-policy') || '').includes('sandbox'));
    await audioResponse.arrayBuffer();
    const ranged = await fetch(origin + '/api/trial/media/instrumental',
      { headers: { ...headers, Range: 'bytes=0-1023' } });
    assert.equal(ranged.status, 206, 'seeking inside the selected song needs Range support');
    assert.match(ranged.headers.get('content-range') || '', /^bytes 0-1023\/\d+$/);
    assert.equal((await ranged.arrayBuffer()).byteLength, 1024);
    const lyricsResponse = await fetch(origin + '/api/trial/lyrics', { headers });
    assert.equal(lyricsResponse.headers.get('content-type'), 'application/json');
    assert.equal(lyricsResponse.headers.get('cache-control'), 'private, no-store');
    assert.ok(Array.isArray((await lyricsResponse.json()).lines));
    pass('Trial media answers as private, sandboxed, range-capable audio with no compression');

    await visitor.click('#playBtn');
    await waitFor(() => visitor.evaluate(`document.getElementById('instAudio').currentTime > .2`),
      'the guest accompaniment really advances');
    await waitFor(() => audible(visitor), 'real PCM reaches the guest output bus, not just a media clock');
    pass('The explicit play gesture produces real audible output through a real destination');

    await waitFor(() => visitor.evaluate(`!!document.querySelector('.trial-line.active')`),
      'the guest lyrics follow the accompaniment');
    await waitFor(() => visitor.evaluate(`!!document.querySelector('.trial-word.sung')`),
      'word timing highlights inside the active line');
    pass('Synchronized lyrics highlight the active line and word');

    await visitor.evaluate(`(() => {
      const slider = document.getElementById('guideVol');
      slider.value = '100';
      slider.dispatchEvent(new Event('input'));
    })()`);
    await waitFor(() => visitor.evaluate(`(() => {
      const inst = document.getElementById('instAudio'), guide = document.getElementById('guideAudio');
      return !guide.paused && guide.getAttribute('src') === '/api/trial/media/vocals'
        && Math.abs(guide.currentTime - inst.currentTime) < .4
        && OpenKTrial.audio.guideGain.gain.value === 1;
    })()`), 'the optional guide track plays in sync with the accompaniment');
    pass('The guide vocal is opt-in and stays synchronized with the backing track');

    await assertFits(visitor, 'the guest player on a phone');
    await capture(visitor, 'player');
    await capture(visitor, 'player-phone', 390, 844);
    pass('The player, mixer and lyrics fit a phone screen');

    assert.ok(await visitor.evaluate('window.__testMics.length === 0 && OpenKTrial.micActive === false'),
      'Playback must never activate a microphone by itself.');
    await visitor.click('#micToggle');
    try {
      await waitFor(() => visitor.evaluate(`window.__testMics.length === 1 && OpenKTrial.micActive === true &&
        OpenKTrial.audio.monitorGain.gain.value > 0 && OpenKTrial.audio.monitorGain.gain.value <= .61 &&
        OpenKTrial.audio.mic.limiter.threshold.value <= 0 &&
        document.getElementById('micToggle').getAttribute('aria-pressed') === 'true'`),
      'explicit consent starts a bounded, compressed monitor path');
    } catch (error) {
      const diagnostics = await visitor.evaluate(`JSON.stringify({
        mics: window.__testMics.length, active: OpenKTrial.micActive,
        pressed: document.getElementById('micToggle').getAttribute('aria-pressed'),
        status: document.getElementById('micStatus').textContent,
        mediaDevices: !!navigator.mediaDevices, secure: window.isSecureContext,
        monitor: OpenKTrial.audio.monitorGain && OpenKTrial.audio.monitorGain.gain.value,
      })`).catch(() => 'unavailable');
      throw new Error(error.message + ' | microphone diagnostics: ' + diagnostics);
    }
    assert.ok(await visitor.evaluate(`document.getElementById('instAudio').currentTime > 0 &&
      !document.getElementById('instAudio').paused`), 'The microphone must not disturb the backing track.');
    pass('Microphone monitoring is opt-in, bounded and never recorded');

    // A real system interruption (another app, a call, a sleeping device) suspends output.
    await visitor.evaluate('window.OpenKTrial.audio.ctx.suspend()');
    await waitFor(() => visitor.evaluate(`document.getElementById('instAudio').paused &&
      document.getElementById('guideAudio').paused && OpenKTrial.micActive === false &&
      window.__testMics[0].stream.getAudioTracks().every(track => track.readyState === 'ended') &&
      /打断/.test(document.getElementById('audioStatus').textContent)`),
    'an interrupted audio context stops the song and releases the microphone');
    await visitor.click('#playBtn');
    await waitFor(() => visitor.evaluate(`!document.getElementById('instAudio').paused &&
      OpenKTrial.audio.ctx.state === 'running'`), 'an explicit gesture restarts interrupted output');
    await waitFor(() => audible(visitor), 'real output resumes after the interruption');
    pass('An interrupted audio context stops everything and needs an explicit restart');

    // A duplicated tab is the realistic "second song" attempt; the server, not the page, decides.
    const second = await page('/try');
    assert.ok(await second.evaluate(`OpenKTrial.state.status === 'active' &&
      OpenKTrial.state.song.id === ${JSON.stringify(chosen)} &&
      document.getElementById('instAudio').paused &&
      document.getElementById('chooseView').hidden &&
      document.querySelectorAll('.trial-pick').length === 0`),
    'A second tab shows the same locked song and offers no new choice.');
    const conflict = await second.evaluate(`(async () => {
      const response = await fetch('/api/trial/select', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: ${JSON.stringify(other)} }),
      });
      return response.status;
    })()`);
    assert.equal(conflict, 409, 'a modified client cannot lock a second song');
    await second.evaluate('OpenKTrial.select(' + JSON.stringify(other) + ')');
    await waitFor(() => second.evaluate(`OpenKTrial.state.song.id === ${JSON.stringify(chosen)} &&
      !document.getElementById('trialAlert').hidden`), 'a conflicting pick falls back to the authoritative song');
    pass('Reloading or duplicating a tab cannot start a second song');

    // Cancelling while the permission prompt is still open must not start capture later.
    await second.evaluate('window.__micDelay = 2500');
    await second.click('#micToggle');
    assert.ok(await second.evaluate('OpenKTrial.micPending === true && OpenKTrial.micActive === false'),
      'the second tab is waiting for microphone permission');
    await second.click('#micToggle');
    assert.ok(await second.evaluate('OpenKTrial.micPending === false && OpenKTrial.micActive === false'));
    await waitFor(() => second.evaluate(`window.__testMics.length === 1 &&
      OpenKTrial.micActive === false && OpenKTrial.audio.micStream === null &&
      window.__testMics[0].stream.getAudioTracks().every(track => track.readyState === 'ended') &&
      document.getElementById('micToggle').getAttribute('aria-pressed') === 'false'`),
    'a late permission is discarded and its capture track stopped', 15000);
    pass('A deferred microphone permission cannot start capture after it was cancelled');

    const boundary = await second.evaluate(`(async () => {
      const codes = {};
      for (const route of ['/api/trial/state', '/api/trial/catalog']) {
        codes[route] = (await fetch(route, { credentials: 'same-origin', cache: 'no-store' })).status;
      }
      return codes;
    })()`);
    assert.equal(boundary['/api/trial/state'], 200, 'the trial API stays reachable through the gateway hop');
    assert.equal(boundary['/api/trial/catalog'], 200);
    pass('The guest session stays inside the trial API');

    // Seeking inside the selected song is allowed; reaching its end consumes the trial.
    await visitor.evaluate(`(() => {
      const inst = document.getElementById('instAudio');
      inst.currentTime = Math.max(0, inst.duration - .4);
    })()`);
    await waitFor(() => visitor.evaluate(`OpenKTrial.state.status === 'complete'`),
      'the natural end of the accompaniment consumes the trial', 30000);
    const finished = await visitor.evaluate(`(() => {
      const inst = document.getElementById('instAudio');
      return {
        done: !document.getElementById('doneView').hidden,
        playerHidden: document.getElementById('playerView').hidden,
        chooseHidden: document.getElementById('chooseView').hidden,
        cta: document.getElementById('loginCta').getAttribute('href'),
        offers: document.querySelectorAll('.trial-pick, .trial-confirm-yes').length,
        paused: inst.paused, source: inst.getAttribute('src'),
        micActive: OpenKTrial.micActive,
        capture: window.__testMics.flatMap(mic => mic.stream.getAudioTracks().map(track => track.readyState)),
        context: OpenKTrial.audio.ctx.state,
      };
    })()`);
    assert.match(await visitor.evaluate("document.getElementById('doneMessage').textContent"),
      /本次试唱额度已用完/, 'the completion message is Chinese');
    assert.equal(await visitor.evaluate("document.getElementById('loginCta').textContent"), '登录后继续演唱');
    assert.deepEqual(finished, { done: true, playerHidden: true, chooseHidden: true,
      cta: '/auth/login/?next=%2F', offers: 0, paused: true, source: null, micActive: false,
      capture: ['ended'], context: 'suspended' },
    'A completed trial disarms every sound and offers only a sign-in call to action.');
    pass('Finishing the song consumes the trial, stops the microphone and shows the sign-in call to action');

    const afterwards = await visitor.evaluate(`(async () => {
      const codes = {};
      for (const route of ['/api/trial/media/instrumental', '/api/trial/lyrics', '/api/trial/catalog']) {
        codes[route] = (await fetch(route, { credentials: 'same-origin', cache: 'no-store' })).status;
      }
      const select = await fetch('/api/trial/select', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: ${JSON.stringify(other)} }) });
      codes.select = select.status;
      return codes;
    })()`);
    assert.deepEqual(afterwards, { '/api/trial/media/instrumental': 410, '/api/trial/lyrics': 410,
      '/api/trial/catalog': 410, select: 410 });
    const returning = await page('/try');
    assert.ok(await returning.evaluate(`OpenKTrial.state.status === 'complete' &&
      !document.getElementById('doneView').hidden &&
      document.querySelectorAll('.trial-pick').length === 0 &&
      !document.getElementById('instAudio').getAttribute('src')`),
    'A used guest session cannot browse or start another song by reloading.');
    await capture(visitor, 'done');
    pass('A used guest session stays used across reloads and cannot read trial media');

    await visitor.evaluate(`window.dispatchEvent(new Event('pagehide'))`);
    assert.ok(await visitor.evaluate(`OpenKTrial.micActive === false &&
      window.__testMics.every(mic => mic.stream.getAudioTracks().every(track => track.readyState === 'ended')) &&
      document.getElementById('instAudio').paused && OpenKTrial.audio.ctx.state === 'closed'`),
    'Leaving the page releases the microphone and the audio hardware.');
    pass('Leaving the guest page releases capture tracks and the audio context');

    // The guest page belongs to nobody: it must not join the signed-in player's per-user and
    // per-device storage, and it must not reach any route outside its own trial.
    const isolation = await returning.evaluate(`(() => ({
      local: localStorage.length, session: sessionStorage.length, cookie: document.cookie,
      scripts: [...document.querySelectorAll('script')].map(node => new URL(node.src, location.href).pathname),
      styles: [...document.querySelectorAll('link[rel=stylesheet]')].map(node => new URL(node.href, location.href).pathname),
    }))()`);
    assert.deepEqual(isolation, { local: 0, session: 0, cookie: '',
      scripts: ['/trial-assets/trial.js'], styles: ['/trial-assets/trial.css'] },
    'The guest page stores nothing locally and loads only its own two assets.');
    const strayRoutes = [...new Set(requested)].filter(pathname =>
      !['/try', '/favicon.ico'].includes(pathname)
      && !pathname.startsWith('/trial-assets/') && !pathname.startsWith('/api/trial/'));
    assert.deepEqual(strayRoutes, [], 'the whole session touched only the guest routes');
    pass('The guest session stays out of signed-in storage, assets and routes');

    const pageErrors = errors.filter(text => !/favicon/i.test(text));
    assert.deepEqual(pageErrors, [], 'the guest page must not throw in the browser');
    assert.ok(!log.includes('Traceback'), 'the fixture server logged a traceback:\n' + log.slice(-2000));
    console.log(`\n${checks.length}/${checks.length} guest trial checks passed`);
  } catch (error) {
    console.error(error);
    console.error('--- fixture log tail ---\n' + log.slice(-4000));
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    await cleanup();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
