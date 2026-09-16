/* Real Chrome: account settings follow the person and the device, the topology
   decides where playback may start, and only confirmed playback becomes history.
   Songs are synthetic (tools.demo); the microphone and the account service are
   stubbed, so no real account, microphone or recording is involved. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { CDP, chromePath, freePort, waitFor, sleep, stop, errors } = require('./test_browser');
const ROOT = path.resolve(__dirname, '../..');

// The parent wires these into backend/main.py; the fixture mounts the same
// router and pages so this suite exercises the shipped modules end to end.
const FIXTURE = `import sys
from fastapi import HTTPException
from fastapi.responses import FileResponse
import uvicorn

from backend import config, user_state
from backend.main import app


def page(name: str) -> FileResponse:
    path = config.FRONTEND_DIR / name
    if not path.is_file():
        raise HTTPException(404, "page not installed")
    return FileResponse(path, headers={"Cache-Control": "no-cache, must-revalidate"})


mounted = len(app.router.routes)
app.include_router(user_state.router)


@app.get("/devices", include_in_schema=False)
@app.get("/devices/", include_in_schema=False)
def devices_page() -> FileResponse:
    user_state.require_enabled()
    return page("devices.html")


@app.get("/history", include_in_schema=False)
@app.get("/history/", include_in_schema=False)
def history_page() -> FileResponse:
    user_state.require_enabled()
    return page("history.html")


# main.py registers the frontend mount last; added routes must precede it here.
added = app.router.routes[mounted:]
del app.router.routes[mounted:]
app.router.routes[0:0] = added
uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
`;

async function main() {
  const scratch = await fs.mkdtemp(path.join(ROOT, '.test-artifacts', 'openk-devices-'));
  const tabs = [], browsers = [], checks = [];
  let server, log = '', cleanupPromise;
  const cleanup = () => cleanupPromise ||= (async () => {
    for (const tab of tabs) tab.close();
    for (const browser of browsers) await stop(browser);
    await stop(server);
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  })();
  const interrupted = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const deadline = setTimeout(() => {
    console.error('Device and history regression exceeded three minutes.');
    cleanup().finally(() => process.exit(1));
  }, 180000);
  const pass = name => { checks.push(name); console.log('PASS ' + name); };
  try {
    const python = process.env.OPENK_TEST_PYTHON || path.join(ROOT, '.venv/bin/python');
    const key = 'openk-devices-fixture-key-0123456789_abcdefghijklmnopqrstuvwxyz';
    const origin = 'http://127.0.0.1:' + await freePort();
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OPENK_')));
    const data = path.join(scratch, 'data');
    const demo = spawnSync(python, ['-m', 'tools.demo', data, '--showcase'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(demo.status, 0, demo.stderr);
    const keyFile = path.join(scratch, 'identity');
    await fs.writeFile(keyFile, key, { mode: 0o600 });
    const fixture = path.join(scratch, 'account_fixture.py');
    await fs.writeFile(fixture, FIXTURE);
    server = spawn(python, [fixture, new URL(origin).port], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: ROOT,
        OPENK_DATA_DIR: data, OPENK_JOBS_DIR: path.join(data, 'jobs'),
        OPENK_RESUME_ON_START: 'false', OPENK_IDENTITY_KEY_FILE: keyFile },
    });
    server.stdout.on('data', chunk => { log += chunk; });
    server.stderr.on('data', chunk => { log += chunk; });
    await waitFor(async () => (await fetch(origin + '/api/health')).ok, 'device settings fixture');

    const people = {
      ling: { id: '00000000-0000-4000-8000-000000000051', username: 'ling', display_name: '小玲', is_staff: false },
      hao: { id: '00000000-0000-4000-8000-000000000052', username: 'hao', display_name: '阿豪', is_staff: false },
    };
    const identity = person => ({ 'X-OpenK-Identity-Key': key,
      'X-OpenK-Account': Buffer.from(JSON.stringify(person)).toString('base64url') });

    async function launch(name) {
      const profile = path.join(scratch, name);
      const browser = spawn(await chromePath(), [
        '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings',
        '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
      ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, TMPDIR: scratch } });
      browsers.push(browser);
      browser.stdout.on('data', () => {});
      browser.stderr.on('data', chunk => { log += chunk; });
      return waitFor(async () => Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]),
        'device settings Chrome ' + name);
    }
    async function page(browserPort, route, person = people.ling, width = 1280, height = 900) {
      const target = await (await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: 'PUT' })).json();
      const tab = await CDP.connect(target.webSocketDebuggerUrl);
      tabs.push(tab);
      await tab.send('Network.enable');
      await tab.send('Network.setExtraHTTPHeaders', { headers: identity(person) });
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.__testMics = [];
        navigator.mediaDevices.getUserMedia = async () => {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const destination = context.createMediaStreamDestination();
          gain.gain.value = .02;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          window.__testMics.push({ context, stream: destination.stream });
          await context.resume();
          return destination.stream;
        };` });
      await tab.send('Page.navigate', { url: origin + route });
      return tab;
    }
    const reopen = async (tab, route, person) => {
      if (person) await tab.send('Network.setExtraHTTPHeaders', { headers: identity(person) });
      await tab.send('Page.navigate', { url: origin + route });
    };

    /* ---- One browser: settings are stored for this person on this device. ---- */
    const livingPort = await launch('living');
    const living = await page(livingPort, '/');
    await waitFor(() => living.evaluate(`room.ready && OpenKUserState.enabled &&
      document.querySelectorAll('.song-row').length >= 3`), 'account home with device settings');
    const livingDevice = await living.evaluate('OpenKUserState.deviceId()');
    assert.match(livingDevice, /^[0-9a-f]{32}$/);
    assert.ok(await living.evaluate(`localStorage.getItem('openk.prefs') === null &&
      document.querySelector('#instAudio').paused && window.__testMics.length === 0`),
      'Signing in must not write account settings into this browser or start anything.');
    pass('The full player registers this browser as a device without touching local preferences');

    await living.evaluate(`(() => {
      const mic = document.querySelector('#micVol');
      mic.value = 70;
      mic.dispatchEvent(new Event('input', { bubbles: true }));
      const reverb = document.querySelector('#reverb');
      reverb.value = 'church';
      reverb.dispatchEvent(new Event('change', { bubbles: true }));
      const inst = document.querySelector('#instVol');
      inst.value = 64;
      inst.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(async () => {
      const state = await (await fetch(origin + '/api/user/state', {
        headers: { ...identity(people.ling), 'X-OpenK-Device': livingDevice } })).json();
      return state.settings.mic_volume === 70 && state.settings.reverb === 'church'
        && state.settings.accompaniment_volume === 64 && state.defaults.mic_volume === 110
        && state.device.overrides.mic_volume === 70;
    }, 'player controls reach the account and this device');
    assert.equal(await living.evaluate(`localStorage.getItem('openk.prefs')`), null,
      'Account settings never fall back to the shared browser preference blob.');
    pass('Mixer, reverb and microphone controls persist at the right level for the signed-in person');

    await living.send('Page.reload', { ignoreCache: true });
    await waitFor(() => living.evaluate(`typeof room !== 'undefined' && room.ready && OpenKUserState.enabled &&
      document.querySelector('#micVol').value === '70' && document.querySelector('#reverb').value === 'church' &&
      document.querySelector('#instVol').value === '64'`), 'saved settings return after a reload');
    assert.ok(await living.evaluate('document.querySelector("#instAudio").paused && window.__testMics.length === 0'),
      'Restored settings cannot start audio or open a microphone by themselves.');
    pass('Saved preferences are applied again after a reload without starting anything');

    /* ---- A second person on the same browser starts from safe defaults. ---- */
    await reopen(living, '/', people.hao);
    await waitFor(() => living.evaluate(`typeof room !== 'undefined' && room.ready && OpenKUserState.enabled &&
      OpenKUserState.value.accountId === ${JSON.stringify(people.hao.id)}`), 'second person on the same browser');
    assert.ok(await living.evaluate(`document.querySelector('#micVol').value === '110' &&
      document.querySelector('#reverb').value === 'ktv' && document.querySelector('#instVol').value === '100'`),
      "A shared browser must not hand one person's settings to the next.");
    assert.equal(await living.evaluate('OpenKUserState.deviceId()'), livingDevice,
      'The browser keeps one installation id while the profile behind it changes.');
    pass('A different account on the same device sees safe defaults, not the previous person');

    await reopen(living, '/', people.ling);
    await waitFor(() => living.evaluate(`typeof room !== 'undefined' && room.ready &&
      document.querySelector('#micVol').value === '70'`), 'the first person returns to her own settings');

    /* ---- Topology: playback is asked to start on the chosen device. ---- */
    const studyPort = await launch('study');
    const study = await page(studyPort, '/');
    await waitFor(() => study.evaluate(`room.ready && OpenKUserState.enabled &&
      document.querySelectorAll('.song-row').length >= 3`), 'second device of the same account');
    const studyDevice = await study.evaluate('OpenKUserState.deviceId()');
    assert.notEqual(studyDevice, livingDevice);

    const devices = await page(livingPort, '/devices');
    await waitFor(() => devices.evaluate(`document.querySelectorAll('.device-item').length === 2 &&
      document.querySelectorAll('#topology svg .node').length === 2`), 'the device page lists both devices');
    assert.ok(await devices.evaluate(`document.documentElement.lang === 'zh-CN' &&
      /设备设置/.test(document.title) && document.querySelector('#listTitle').textContent === '已注册的设备' &&
      document.querySelector('[data-role="player"]').closest('label').textContent.includes('播放器')`),
      'The device page is Simplified Chinese like the rest of OpenK.');
    await devices.evaluate(`(() => {
      document.querySelector('#deviceLabel').value = 'Living room';
    })()`);
    await devices.click('#saveLabel');
    await waitFor(() => devices.evaluate(`[...document.querySelectorAll('.device-item strong')]
      .some(node => node.textContent === 'Living room')`), 'renaming a device persists');
    await devices.evaluate(`(() => {
      const select = document.querySelector('#preferredPlayer');
      select.value = ${JSON.stringify(livingDevice)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(async () => {
      const state = await (await fetch(origin + '/api/user/state', {
        headers: { ...identity(people.ling), 'X-OpenK-Device': livingDevice } })).json();
      return state.preferred_player === livingDevice;
    }, 'the preferred player is stored, not only drawn');
    await waitFor(() => devices.evaluate(`document.querySelectorAll('#topology .node-player').length === 1 &&
      document.querySelector('#topologyHint').textContent.includes('这台设备') &&
      [...document.querySelectorAll('.device-item .tag')].some(tag => tag.textContent === '首选播放器')`),
      'the topology view reflects the stored choice');
    pass('Device names and the preferred player are real persisted settings');

    const jobs = await study.evaluate('state.allJobs.filter(job => job.state === "done").slice(0,2).map(job => job.id)');
    const pick = job => `.song-row[data-id="${job}"] .sr-pick`;
    await study.evaluate(`OpenKUserState.refresh()`);
    await waitFor(() => study.evaluate(`OpenKUserState.value?.preferredPlayer === ${JSON.stringify(livingDevice)}`),
      'the second device learns about the topology');
    await study.click(pick(jobs[0]));
    await waitFor(() => study.evaluate('!!room.client.state.current'), 'the song is queued from the second device');
    await sleep(700);
    assert.ok(await study.evaluate(`document.querySelector('#instAudio').paused &&
      !room.armed && !room.client.state.player.online &&
      document.querySelector('#roomPlaybackStatus').textContent.includes('Living room')`),
      'A device that is not the preferred player must not start playing by itself.');
    const queuedOnly = await (await fetch(origin + '/api/user/history', {
      headers: { ...identity(people.ling), 'X-OpenK-Device': studyDevice } })).json();
    assert.equal(queuedOnly.total, 0, 'Queueing a song is not playback history.');
    pass('Picking a song cannot silently claim a device the topology points away from');

    await study.click('#roomActivate');
    await waitFor(() => study.evaluate(`!document.querySelector('#instAudio').paused &&
      document.querySelector('#instAudio').currentTime > .2 && room.armed`),
      'explicit activation overrides the topology on purpose');
    pass('Explicit activation still works and says it is playing here instead');

    /* ---- Confirmed playback becomes history; commands alone do not. ---- */
    await waitFor(async () => {
      const value = await (await fetch(origin + '/api/user/history', {
        headers: { ...identity(people.ling), 'X-OpenK-Device': studyDevice } })).json();
      return value.total === 1 && value.entries[0].position > 2;
    }, 'real advancement is recorded once', 25000);
    await study.click('#homeBtn');
    await study.click('#nbPlay');
    await waitFor(() => study.evaluate(`document.querySelector('#instAudio').paused`),
      'the confirmed play is paused before queueing another song');
    await study.click(pick(jobs[1]));
    await waitFor(() => study.evaluate('room.client.state.queue.length === 1'),
      'a second song only joins the queue');
    await sleep(1200);
    const history = await page(studyPort, '/history');
    await waitFor(() => history.evaluate(`document.querySelectorAll('.history-item').length === 1`),
      'the history page shows the confirmed play');
    assert.ok(await history.evaluate(`document.documentElement.lang === 'zh-CN' &&
      /播放历史/.test(document.title) &&
      /共 1 条记录/.test(document.querySelector('#historyCount').textContent) &&
      document.querySelector('.history-item .danger').textContent === '删除'`),
      'The history page is Simplified Chinese like the rest of OpenK.');
    const entry = await history.evaluate(`(() => {
      const item = document.querySelector('.history-item');
      return { title: item.querySelector('h3').textContent, meta: item.querySelector('.meta').textContent,
        body: document.body.innerHTML };
    })()`);
    const played = await study.evaluate(`(() => {
      const job = state.allJobs.find(item => item.id === ${JSON.stringify(jobs[0])});
      return job.track || job.title;
    })()`);
    assert.equal(entry.title, played, 'History names the song that actually played.');
    assert.ok(/Chrome|设备|浏览器|Living room/.test(entry.meta),
      'History names the device that played it.');
    assert.ok(!entry.body.includes('/media/') && !entry.body.includes('/jobs/'),
      'History never exposes song file locations.');
    pass('Only player-confirmed playback appears in history, with its device and progress');

    await reopen(history, '/history', people.hao);
    await waitFor(() => history.evaluate(`document.querySelector('#historyCount')?.textContent
      .includes('还没有播放过')`), "another account cannot see someone else's history");
    assert.equal(await history.evaluate(`document.querySelectorAll('.history-item').length`), 0);
    pass('Playback history is private to the account that played it');

    /* ---- A blocked receiver never invents history. ---- */
    await reopen(history, '/', people.hao);
    await waitFor(() => history.evaluate(`typeof room !== 'undefined' && room.ready`), "the second person's own room");
    await history.evaluate(`state.allJobs.length && (() => {
      const row = document.querySelector('.song-row .sr-pick');
      row.click();
    })()`);
    await sleep(1500);
    const phantom = await (await fetch(origin + '/api/user/history', { headers: identity(people.hao) })).json();
    assert.equal(phantom.total, 0,
      'A queued song on a device that never produced audio must not create history.');
    pass('A command or a silent player produces no phantom history');

    /* ---- A browser that cannot claim a device slot can still manage the list. ---- */
    const spare = async (index) => {
      const response = await fetch(origin + '/api/user/state', {
        method: 'POST',
        headers: { ...identity(people.ling), 'X-OpenK-Device': index.toString(16).padStart(32, '0'),
          'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Spare ' + (index + 1) }),
      });
      assert.equal(response.status, 200, 'seeding one of this account\u2019s device slots');
      return (await response.json()).devices.length;
    };
    let slots = 0;
    for (let index = 0; index < 40 && slots < 24; index++) slots = await spare(index);
    assert.equal(slots, 24, 'the account reached its device limit');
    const spillPort = await launch('spill');
    const spill = await page(spillPort, '/devices');
    await waitFor(() => spill.evaluate(`document.querySelectorAll('.device-item').length === 24`),
      'a browser over the device limit still renders the account list');
    assert.ok(await spill.evaluate(`/还没有注册/.test(document.querySelector('#pageStatus').textContent)
      && document.querySelector('#pageStatus').dataset.kind === 'error'
      && document.querySelector('#deviceLabel').disabled === true
      && document.querySelector('#saveLabel').disabled === true
      && document.querySelector('#clearOverrides').disabled === true`),
      'An unregistered browser says so plainly and keeps its own controls disabled.');
    await spill.evaluate('window.confirm = () => true');
    await spill.click('.device-item:last-child .danger');
    await waitFor(() => spill.evaluate(`document.querySelectorAll('.device-item').length === 24 &&
      /已经注册/.test(document.querySelector('#pageStatus').textContent) &&
      document.querySelector('#deviceLabel').disabled === false`),
      'freeing a slot lets this browser register itself');
    pass('A browser over the device limit can remove a device and then register itself');

    assert.deepEqual(errors, [], 'No unhandled browser errors');
    const artifacts = process.env.OPENK_TEST_ARTIFACTS;
    if (artifacts) {
      await fs.mkdir(artifacts, { recursive: true });
      await devices.send('Page.bringToFront');
      const image = await devices.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(artifacts, 'account-devices.png'), Buffer.from(image.data, 'base64'));
      await fs.writeFile(path.join(artifacts, 'account-devices-report.json'), JSON.stringify({ checks }, null, 2));
    }
    console.log(`${checks.length} device and history flows passed.`);
  } catch (error) {
    for (const tab of tabs) {
      try {
        console.error('Page state:', await tab.evaluate(`({
          path: location.pathname,
          status: document.querySelector('#pageStatus')?.textContent,
          prefs: document.querySelector('#prefsStatus')?.textContent,
          roomStatus: document.querySelector('#roomPlaybackStatus')?.textContent,
          settings: window.OpenKUserState?.value?.settings || null,
          preferred: window.OpenKUserState?.value?.preferredPlayer || null
        })`));
      } catch (diagnostic) { console.error('Page diagnostics unavailable:', diagnostic.message); }
    }
    console.error(log.slice(-2000));
    throw error;
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    await cleanup();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
