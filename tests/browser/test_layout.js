/* Responsive account-mode layouts, using the existing Chrome/CDP test transport. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { CDP, chromePath, freePort, waitFor, sleep, stop, errors } = require('./test_browser');
const ROOT = path.resolve(__dirname, '../..');

async function main() {
  const scratch = await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'openk-layout-'));
  const artifacts = process.env.OPENK_TEST_ARTIFACTS;
  const reportOnly = process.env.OPENK_LAYOUT_REPORT_ONLY === '1';
  const tabs = [], reports = [], failures = [], qrDestinations = {};
  let server, browser, log = '';
  let cleanupPromise;
  function cleanup() {
    return cleanupPromise ||= (async () => {
      for (const tab of tabs) tab.close();
      await stop(browser);
      await stop(server);
      await fs.rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
    })();
  }
  const interrupted = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const deadline = setTimeout(() => {
    console.error('Responsive layout regression exceeded three minutes; cleaning up its dedicated processes.');
    cleanup().finally(() => process.exit(1));
  }, 180000);
  function expect(condition, message) { if (!condition) failures.push(message); }
  try {
    const python = process.env.OPENK_TEST_PYTHON || path.join(ROOT, '.venv/bin/python');
    const data = path.join(scratch, 'data');
    const demo = spawnSync(python, ['-m', 'tools.demo', data, '--showcase'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(demo.status, 0, demo.stderr);
    const key = 'openk-layout-synthetic-key-0123456789_abcdefghijklmnopqrstuvwxyz';
    const keyFile = path.join(scratch, 'identity');
    await fs.writeFile(keyFile, key, { mode: 0o600 });
    const port = await freePort();
    const origin = 'http://127.0.0.1:' + port;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OPENK_')));
    server = spawn(python, ['-m', 'backend.main'], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, PYTHONDONTWRITEBYTECODE: '1', OPENK_HOST: '127.0.0.1', OPENK_PORT: String(port),
        OPENK_DATA_DIR: data, OPENK_JOBS_DIR: path.join(data, 'jobs'),
        OPENK_RESUME_ON_START: 'false', OPENK_IDENTITY_KEY_FILE: keyFile },
    });
    server.stdout.on('data', chunk => { log += chunk; });
    server.stderr.on('data', chunk => { log += chunk; });
    await waitFor(async () => (await fetch(origin + '/api/health')).ok, 'layout fixture');
    const profile = path.join(scratch, 'chrome');
    browser = spawn(await chromePath(), [
      '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings',
      '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, TMPDIR: scratch } });
    browser.stdout.on('data', () => {});
    browser.stderr.on('data', chunk => { log += chunk; });
    const debugPort = await waitFor(async () =>
      Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'layout Chrome');
    const user = { id: '00000000-0000-4000-8000-000000000031', username: 'layout-singer',
      display_name: '一起在客厅唱歌的朋友'.repeat(4).slice(0, 40), is_staff: false };
    const headers = { 'X-OpenK-Identity-Key': key,
      'X-OpenK-Account': Buffer.from(JSON.stringify(user)).toString('base64url') };

    async function page(route, width, height) {
      const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
      const tab = await CDP.connect(target.webSocketDebuggerUrl);
      tabs.push(tab);
      await tab.send('Network.enable');
      await tab.send('Network.setExtraHTTPHeaders', { headers });
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        navigator.mediaDevices.getUserMedia = async () => {
          throw new DOMException('Physical capture is disabled in layout tests', 'NotAllowedError');
        };` });
      await tab.send('Page.navigate', { url: origin + route });
      await waitFor(() => tab.evaluate(route === '/tv'
        ? '!!window.openkStage?.client?.state'
        : route === '/devices' ? '!!window.OpenKUserState?.value?.device && !!document.querySelector("#topology svg")'
        : route === '/library' ? '!!room?.ready && document.querySelectorAll(".song-row").length > 0'
          : '!!window.openkRemote?.ready && !window.openkRemote.starting && window.openkRemote.jobs.length > 0'),
      'layout page ' + route);
      await tab.evaluate('document.fonts.ready');
      return tab;
    }
    async function capture(tab, name) {
      if (!artifacts) return;
      await fs.mkdir(artifacts, { recursive: true });
      await tab.send('Page.bringToFront');
      // These are synthetic rooms; still redact pairing credentials from saved diagnostics.
      await tab.evaluate(`(() => {
        const style = document.createElement('style'); style.id = 'layout-redaction';
        style.textContent = '#qr:not(.qr-empty), #inviteQR, #pairCode, #inviteCode, #pairRoom, #inviteRoom, #joinRoom, #joinCode, #tvJoinRoom, #tvJoinCode { visibility:hidden!important }';
        document.head.append(style);
      })()`);
      try {
        await sleep(80);
        const image = await tab.send('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(path.join(artifacts, name + '.png'), Buffer.from(image.data, 'base64'));
      } finally { await tab.evaluate('document.querySelector("#layout-redaction").remove()'); }
    }
    async function audit(tab, name, selectors = []) {
      const report = await tab.evaluate(`(() => {
        const box = selector => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom};
        };
        return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
          boxes:Object.fromEntries(${JSON.stringify(selectors)}.map(selector => [selector,box(selector)])),
          overflow:[...document.body.querySelectorAll('*')].filter(element => {
            const rect=element.getBoundingClientRect();
            return rect.width>1 && rect.height>1 && getComputedStyle(element).visibility!=='hidden' &&
              (rect.left < -1 || rect.right > innerWidth+1);
          }).slice(0,12).map(element => element.tagName+'.'+element.className+'#'+element.id)};
      })()`);
      reports.push({ name, ...report });
      expect(report.scrollWidth <= report.width + 1, name + ': page overflows horizontally');
      for (const [selector, rect] of Object.entries(report.boxes)) {
        if (!rect?.height) continue;
        expect(rect.x >= -1 && rect.right <= report.width + 1, name + ': ' + selector + ' exceeds the viewport');
      }
      await capture(tab, name);
      return report;
    }
    async function accountMenu(tab, name) {
      await tab.click('.account-summary');
      const report = await audit(tab, name, ['.account-actions', '.account-profile', '.account-logout']);
      for (const selector of ['.account-profile', '.account-logout']) {
        expect(report.boxes[selector]?.height >= 44, name + ': account actions have usable touch targets');
      }
      await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' });
      expect(await tab.evaluate('document.activeElement.matches(".account-profile")'),
        name + ': down arrow reaches profile without being intercepted');
      await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
      expect(await tab.evaluate('!document.querySelector(".account-menu").open'), name + ': Escape closes the menu');
    }

    async function remoteQR(tab, name) {
      await tab.click('#remoteLink');
      await waitFor(() => tab.evaluate('!!document.querySelector("#remoteQR svg")'), name + ': QR rendered');
      const report = await audit(tab, name, ['#remotePanel', '#remoteQR svg', '#remoteClose', '#remoteOpen']);
      const panel = report.boxes['#remotePanel'], qr = report.boxes['#remoteQR svg'];
      expect(panel.y >= 0 && panel.bottom <= report.height, name + ': dialog fits vertically');
      expect(qr.width >= 180 && Math.abs(qr.width - qr.height) < 1, name + ': QR stays square and large enough to scan');
      expect(report.boxes['#remoteClose'].height >= 44 && report.boxes['#remoteOpen'].height >= 44,
        name + ': dialog actions have usable touch targets');
      qrDestinations[name] = await tab.evaluate('document.querySelector("#remoteOpen").href');
      expect(qrDestinations[name] === origin + '/remote', name + ': QR link stays on this origin without credentials');
      await tab.click('#remoteClose');
      expect(await tab.evaluate('document.activeElement.id === "remoteLink"'), name + ': focus returns to its trigger');
    }

    async function failedProcessing(tab, name) {
      await tab.evaluate(`(async () => {
        await refreshList();
        const original = { jobs: state.allJobs, fetch: window.fetch, confirm: window.confirm };
        window.__processingFixture = original;
        const jobs = [...original.jobs,
          {id:'ffffffffff01',state:'error',title:'名称很长的合成失败任务'.repeat(8),message:'演示文件暂时无法读取'},
          {id:'ffffffffff02',state:'running',title:'合成处理任务',progress:40},
          {id:'ffffffffff03',state:'cancelled',title:'合成已取消任务'}];
        window.fetch = (url, options) => String(url) === '/api/jobs'
          ? Promise.resolve(new Response(JSON.stringify(jobs), {headers:{'Content-Type':'application/json'}}))
          : original.fetch.call(window, url, options);
        window.confirm = message => { original.confirmation = message; return false; };
        state.allJobs = jobs;
        renderProcessing();
      })()`);
      try {
        await tab.click('#adminBtn');
        const prefix = '#procList [data-id="ffffffffff01"]';
        const remove = prefix + ' [data-act="delete"]', retry = prefix + ' [data-act="retry"]';
        await tab.evaluate(`document.querySelector(${JSON.stringify(remove)}).scrollIntoView({block:'center'})`);
        const report = await audit(tab, name, [prefix, remove, retry]);
        for (const selector of [remove, retry]) {
          expect(report.boxes[selector]?.width >= 44 && report.boxes[selector]?.height >= 44,
            name + ': processing actions remain touch-sized');
        }
        expect(await tab.evaluate(`(() => {
          const node = document.querySelector(${JSON.stringify(remove)}), rect = node.getBoundingClientRect();
          return rect.y >= 0 && rect.bottom <= innerHeight &&
            document.elementFromPoint(rect.x + rect.width/2, rect.y + rect.height/2) === node;
        })()`), name + ': the delete control is visible and pointer-accessible');
        await tab.click(remove);
        expect(await tab.evaluate(`window.__processingFixture.confirmation.includes('无法撤销') &&
          state.deletingJobs.size === 0 &&
          !!document.querySelector('#procList [data-id="ffffffffff01"]')`),
        name + ': cancelling confirmation retains the failed task');
        expect(await tab.evaluate(`!document.querySelector('#procList [data-id="ffffffffff02"] [data-act="delete"]') &&
          !!document.querySelector('#procList [data-id="ffffffffff03"] [data-act="delete"]')`),
        name + ': running work stays protected and cancelled work stays removable');
        await tab.click('#adminClose');
      } finally {
        await tab.evaluate(`(() => {
          const original = window.__processingFixture;
          window.fetch = original.fetch;
          window.confirm = original.confirm;
          state.allJobs = original.jobs;
          renderProcessing();
          delete window.__processingFixture;
        })()`);
      }
    }

    async function roomDevices(tab, name, selector) {
      await tab.evaluate(`(() => {
        window.__layoutRoomClient = window.openkRemote?.client || window.openkStage?.client ||
          (typeof room === 'undefined' ? null : room.client);
        window.__layoutRoomClient.stop();
        const state = window.__layoutRoomClient.state;
        const roles = [['player','controller','microphone'], ['controller'], ['microphone'], ['player','microphone']];
        const devices = roles.map((roles, index) => ({
          id: 'layout-device-' + index, member_id: state.viewer.id, online: true, player: index === 0,
          name: ('客厅里的多角色设备' + index).repeat(4).slice(0, 40), roles,
        }));
        OpenKRoom.renderDevices(document.querySelector(${JSON.stringify(selector)}),
          { ...state, devices }, devices[0].id);
        document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' });
      })()`);
      try {
        const report = await audit(tab, name, [selector, selector + ' .room-device-list', selector + ' .room-device']);
        expect(report.boxes[selector]?.height > 0, name + ': device list is visible');
        expect(await tab.evaluate(`document.querySelectorAll(${JSON.stringify(selector + ' .room-device')}).length === 4`),
          name + ': all linked devices are present');
        expect(await tab.evaluate(`(() => {
          const roles = [...document.querySelectorAll(${JSON.stringify(selector + ' .room-device-role')})].map(node => node.textContent);
          return ['播放器','遥控器','麦克风'].every(role => roles.includes(role));
        })()`), name + ': all Chinese role labels are rendered');
      } finally {
        await tab.evaluate(`(() => {
          OpenKRoom.renderDevices(document.querySelector(${JSON.stringify(selector)}),
            window.__layoutRoomClient.state, window.__layoutRoomClient.presenceId);
          window.__layoutRoomClient.start();
          delete window.__layoutRoomClient;
        })()`);
      }
    }

    async function lyricEditor(tab, width) {
      await tab.evaluate(`(async () => {
        room.client.stop();
        const job = state.allJobs.find(value => value.media?.lyrics);
        if (!job) throw new Error('Layout fixture needs a lyric-bearing song');
        await showPlayer(job, state.selectionGeneration, false);
        showStage();
        enterLyricsEdit();
        document.querySelector('#lyricTimingTools').scrollIntoView({block:'start'});
      })()`);
      const name = 'lyric-timing-editor-' + width;
      const report = await audit(tab, name,
        ['#lyricTimingTools', '#saveLyrics', '#lyricEditSeek', '.lyric-edit-row', '.lyric-time-fields']);
      expect(report.boxes['.lyric-edit-row']?.height > 0, name + ': editable lyric rows are visible');
      expect(await tab.evaluate(`(() => {
        const fields = [...document.querySelectorAll('.lyric-time-input')];
        return fields.length >= 2 && fields.every(input => {
          const style = getComputedStyle(input), canvas = document.createElement('canvas');
          const context = canvas.getContext('2d'); context.font = style.font;
          return input.getBoundingClientRect().height >= 44 &&
            context.measureText(input.value).width <= input.clientWidth -
              parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + 1;
        });
      })()`), name + ': precise timestamps fit their touch-sized fields without truncation');
      expect(await tab.evaluate(`getComputedStyle(document.querySelector('#lyrics')).maskImage === 'none'`),
        name + ': editing fields are not faded by the singing mask');
      expect(await tab.evaluate(`getComputedStyle(document.querySelector('#nowbar')).display === 'none'`),
        name + ': duplicate transport cannot cover timing controls');
      await tab.evaluate(`document.querySelector('.lyric-time-input').scrollIntoView({block:'center'})`);
      await audit(tab, name + '-fields', ['#saveLyrics', '.lyric-time-input']);
      expect(await tab.evaluate(`(() => {
        return ['#saveLyrics', '.lyric-time-input'].every(selector => {
          const node = document.querySelector(selector), rect = node.getBoundingClientRect();
          return rect.y >= 0 && rect.bottom <= innerHeight &&
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node;
        });
      })()`), name + ': save and timestamp fields remain visible and pointer-accessible together');
      await tab.click('#cancelLyrics');
      await tab.evaluate('room.client.start()');
    }

    async function catalogBrowsing(tab, name, remote) {
      const input = remote ? '#songSearch' : '#search';
      const alphabet = remote ? '#remoteAlphabet' : '#browseAlphabet';
      const index = remote ? '#remoteIndex' : '#browseIndex';
      const pager = remote ? '#remotePager' : '#browsePager';
      const rows = remote ? '#roomSongList .room-song' : '#songList .song-row';
      const titles = remote ? '#roomSongList strong' : '#songList .sr-title';
      await tab.evaluate(`(() => {
        const remote = ${remote};
        const model = remote ? openkRemote : state;
        const key = remote ? 'jobs' : 'allJobs';
        const fields = remote ? ['libraryMode','libraryPage','libraryLetter','search']
          : ['libMode','browsePage','browseLetter','artistPick','search','view'];
        const original = { fetch: window.fetch, jobs: model[key],
          fields: Object.fromEntries(fields.map(field => [field, model[field]])),
          input: document.querySelector(${JSON.stringify(input)}).value,
          queue: JSON.stringify(remote ? openkRemote.client.state.queue : state.queue),
          current: remote ? openkRemote.client.state.current?.id : state.currentJobId };
        window.__browseFixture = original;
        const jobs = Array.from({length:544}, (_,i) => {
          const title = String.fromCharCode(65+i%26) + '合成曲目' + String(i).padStart(4,'0');
          const value = { ...original.jobs[i % original.jobs.length], id:'browse-'+i,
            title, track:title, artist:'演唱者'+i, thumbnail:null };
          delete value.search_index;
          return value;
        });
        window.fetch = (url, options) => String(url) === '/api/jobs'
          ? Promise.resolve(new Response(JSON.stringify(jobs), {headers:{'Content-Type':'application/json'}}))
          : original.fetch.call(window, url, options);
        model[key] = jobs;
        if (remote) Object.assign(model, {libraryMode:'all',libraryPage:1,libraryLetter:'',search:''});
        else Object.assign(model, {libMode:'all',browsePage:1,browseLetter:'',artistPick:null,search:'',view:'list'});
        document.querySelector(${JSON.stringify(input)}).value='';
        remote ? model.renderLibrary() : renderBrowse(true);
      })()`);
      try {
        expect(await tab.evaluate(`document.querySelectorAll(${JSON.stringify(rows)}).length === 24`),
          name + ': 544-song catalog renders only 24 entries');
        await tab.evaluate(`document.querySelector(${JSON.stringify(alphabet)}).open = true;
          ${remote ? 'document.querySelector("#remoteBrowseOptions").open = true;' : ''}`);
        const report = await audit(tab, name + '-index',
          [alphabet, index, pager, ...(remote ? ['.catalog-menu', '#openQueue'] : [])]);
        if (remote && report.width < 700) {
          expect(report.boxes['.catalog-menu'].y >= 8 &&
            report.boxes['.catalog-menu'].bottom <= report.boxes['#openQueue'].y - 8,
          name + ': complete filter menu fits above the queue dock');
        }
        expect(await tab.evaluate(`[...document.querySelectorAll(${JSON.stringify(index + ' button')})]
          .every(node => node.getBoundingClientRect().height >= 44)`),
          name + ': letter buttons remain touch-sized');
        if (remote) {
          await tab.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape'});
          expect(await tab.evaluate('!document.querySelector("#remoteBrowseOptions").open && document.activeElement.id === "remoteBrowseSummary"'),
            name + ': Escape closes filtering and returns focus');
          await tab.click('#remoteBrowseSummary');
        }
        await tab.click(index + ' [data-letter="Z"]');
        expect(await tab.evaluate(`[...document.querySelectorAll(${JSON.stringify(titles)})]
          .every(node => node.textContent.startsWith('Z'))`), name + ': Z filters across the full catalog');
        await tab.evaluate(`document.querySelector(${JSON.stringify(alphabet)}).open = true;
          ${remote ? 'document.querySelector("#remoteBrowseOptions").open = true;' : ''}`);
        await tab.click(index + ' [data-letter=""]');
        await tab.evaluate(`document.querySelector(${JSON.stringify(pager)}).scrollIntoView({block:'center'})`);
        await tab.click(pager + ' [data-page-step="1"]');
        expect(await tab.evaluate(`${remote ? 'openkRemote.libraryPage' : 'state.browsePage'} === 2 &&
          document.querySelectorAll(${JSON.stringify(rows)}).length === 24`), name + ': next page replaces, not appends');
        await tab.evaluate(`(() => {
          const input=document.querySelector(${JSON.stringify(input)});
          input.value='Z合成曲目0519';
          input.dispatchEvent(new InputEvent('input', {bubbles:true}));
        })()`);
        await waitFor(() => tab.evaluate(`document.querySelectorAll(${JSON.stringify(rows)}).length === 1 &&
          document.querySelector(${JSON.stringify(titles)}).textContent === 'Z合成曲目0519'`), name + ': full catalog search');
        await audit(tab, name + '-search', [input, rows]);
        expect(await tab.evaluate(`window.__browseFixture.queue === JSON.stringify(
          ${remote ? 'openkRemote.client.state.queue' : 'state.queue'}) &&
          window.__browseFixture.current === ${remote ? 'openkRemote.client.state.current?.id' : 'state.currentJobId'}`),
          name + ': browsing never changes the song or queue');
      } finally {
        await tab.evaluate(`(() => {
          const model=${remote ? 'openkRemote' : 'state'}, original=window.__browseFixture;
          window.fetch=original.fetch;
          model[${JSON.stringify(remote ? 'jobs' : 'allJobs')}]=original.jobs;
          Object.assign(model,original.fields);
          document.querySelector(${JSON.stringify(input)}).value=original.input;
          ${remote ? 'model.renderLibrary()' : 'renderBrowse(true)'};
          delete window.__browseFixture;
        })()`);
      }
    }

    for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1366, 900]]) {
      const phone = await page('/remote', width, height);
      const report = await audit(phone, 'phone-' + width,
        ['.remote-header', '#accountChip', '#remotePlay', '#songSearch', '#roomSongList .add-song', '#openQueue']);
      if (width < 600) {
        const first = report.boxes['#roomSongList .add-song'];
        const dock = report.boxes['#openQueue'];
        expect(first?.height >= 44 && dock?.height >= 44, 'phone-' + width + ': song and queue actions are touch-sized');
        expect(first && first.bottom <= dock.y - 8, 'phone-' + width + ': first song is below the usable first screen');
      }
      await accountMenu(phone, 'account-menu-' + width);
      if (width === 390 || width === 1366) await catalogBrowsing(phone, 'phone-catalog-' + width, true);
      if (width === 320 || width === 1366) {
        if (!await phone.evaluate('document.querySelector("#playbackPanel").open')) await phone.click('#playbackToggle');
        await audit(phone, 'playback-controls-' + width,
          ['#playbackToggle', '#remotePlay', '#remoteNext', '#remoteGuide', '#singCurrent']);
        await phone.click('#openQueue');
        await audit(phone, 'queue-' + width, ['.queue-sheet', '#closeQueue', '#clearQueue']);
        await phone.click('#closeQueue');
      }
      await phone.click('#memberSummary');
      await roomDevices(phone, 'phone-device-roles-' + width, '#remoteDevices');
      await phone.click('#memberSummary');
    }
    for (const [width, height] of [[390, 844], [1366, 900]]) {
      const lobby = await page('/rooms', width, height);
      await audit(lobby, 'lobby-' + width, ['#currentRoomBanner', '#newPartyShortcut', '#joinCodeShortcut']);
      await lobby.click('#newPartyShortcut');
      await audit(lobby, 'create-room-' + width, ['#newRoomName', '#createRoom']);
      await lobby.click('#joinCodeShortcut');
      await audit(lobby, 'join-room-' + width, ['#joinRoom', '#joinCode', '#joinSubmit']);
      expect(await lobby.evaluate('!document.querySelector("#createRoomPanel").open'),
        'lobby-' + width + ': only the selected room form is expanded');
      const library = await page('/library', width, height);
      await audit(library, 'library-' + width, ['.topbar', '#search', '#accountChip', '.song-row .sr-pick']);
      expect(await library.evaluate(`getComputedStyle(document.querySelector("#queueBtn")).display !== "none" &&
        localStorage.getItem("openk.queue") === null`),
        'library-' + width + ': account mode exposes the room queue, not a separate local queue');
      await accountMenu(library, 'library-account-' + width);
      await catalogBrowsing(library, 'library-catalog-' + width, false);
      await failedProcessing(library, 'failed-processing-' + width);
      await remoteQR(library, 'remote-qr-' + width);
      await roomDevices(library, 'library-device-roles-' + width, '#roomDevices');
      await lyricEditor(library, width);
    }
    const narrowLibrary = await page('/library', 320, 568);
    await failedProcessing(narrowLibrary, 'failed-processing-320');
    await remoteQR(narrowLibrary, 'remote-qr-320');
    await lyricEditor(narrowLibrary, 320);
    for (const [width, height] of [[390, 844], [1366, 900]]) {
      const devices = await page('/devices', width, height);
      await devices.evaluate(`OpenKUserState.patchDevice(OpenKUserState.deviceId(), {
        label: '设备名字很长也不应挡住每一种角色的标签', roles: ['player','controller','microphone'],
      })`);
      await audit(devices, 'device-topology-roles-' + width, ['#topology', '#topology svg']);
      expect(await devices.evaluate(`(() => {
        const labels = [...document.querySelectorAll('#topology .node-role')];
        return labels.some(node => node.textContent === '麦克风') &&
          labels.some(node => node.textContent === '播放器 / 遥控器') &&
          [...labels, ...document.querySelectorAll('#topology .node-label')]
            .every(node => node.getBBox().x + node.getBBox().width <= 306);
      })()`), 'device-topology-' + width + ': every role and bounded device name fit their SVG node');
    }
    for (const [width, height] of [[390, 844], [1280, 720], [1366, 600], [1920, 1080]]) {
      const tv = await page('/tv', width, height);
      const setup = await audit(tv, 'tv-setup-' + width + 'x' + height, ['.pair-card', '#pairActivate', '#closePair']);
      if (width >= 1000) expect(setup.boxes['#pairActivate'].bottom <= height - 12,
        'tv-setup-' + width + ': activation requires scrolling before any setup');
      if (width >= 1000 && width < 1900) await roomDevices(tv, 'tv-device-roles-' + width + 'x' + height, '#tvDevices');
      await tv.click('#closePair');
      const stage = await audit(tv, 'tv-stage-' + width + 'x' + height,
        ['.stage-header', '.now-heading', '#lyricCurrent', '#lyricNext', '.stage-bottom', '#stageControls']);
      expect(stage.boxes['#lyricNext'].bottom <= stage.boxes['.stage-bottom'].y + 1,
        'tv-stage-' + width + ': lyrics overlap the playback area');
      await accountMenu(tv, 'tv-account-' + width);
      expect(await tv.evaluate('document.querySelector("#pairPanel").hidden'),
        'tv-account-' + width + ': account-menu Escape must not reopen room setup');
    }
    expect(errors.length === 0, 'Unhandled browser errors: ' + errors.join('; '));
    if (artifacts) await fs.writeFile(path.join(artifacts, 'layout-report.json'),
      JSON.stringify({ reports, failures, qrDestinations }, null, 2));
    if (failures.length) console.log(failures.join('\n'));
    if (!reportOnly) assert.deepEqual(failures, [], 'Responsive layout regressions');
    console.log(`${reports.length} responsive layouts captured; ${failures.length} layout failures.`);
  } catch (error) {
    console.error(log.slice(-3000));
    throw error;
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    await cleanup();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
