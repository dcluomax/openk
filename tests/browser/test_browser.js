/* 真实 Chrome + 双页面回归；仅使用 Node/CDP，不安装另一套浏览器测试框架。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn, spawnSync} = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
let checks = 0;

async function waitFor(fn, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let value, lastError;
  while (Date.now() < deadline) {
    try {
      value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`等待超时：${label}${lastError ? ` (${lastError.message})` : ''}`);
}

function pass(label) {
  checks++;
  console.log(`PASS ${label}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function chromePath() {
  const candidates = [
    process.env.OPENK_TEST_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error('未找到 Chrome；用 OPENK_TEST_CHROME 指定可执行文件，完整回归不跳过浏览器。');
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.counter = 0;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params.exceptionDetails;
        errors.push(detail.exception?.description || detail.text);
      }
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, {once:true});
      socket.addEventListener('error', reject, {once:true});
    });
    const client = new CDP(socket);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    return client;
  }
  send(method, params = {}) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 15000);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise:true, returnByValue:true, userGesture:true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }
  async click(selector) {
    await this.send('Page.bringToFront');
    // 页面会异步重绘（大厅轮询、details 展开），命中点和真实点击可能错位：
    // 先等布局稳定，再确认元素真的收到了 click，最多重试三次。
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = 'c' + Math.random().toString(36).slice(2);
      const point = await waitFor(async () => {
        const result = await this.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el || el.disabled || el.hidden) return {error: '控件不可用'};
          el.scrollIntoView({block:'center', behavior:'instant'});
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return {error: '控件不可见'};
          const point = {x:r.x+r.width/2,y:r.y+r.height/2};
          const hit = document.elementFromPoint(point.x, point.y);
          if (!hit || !el.contains(hit)) {
            const box = h => h ? [h.tagName, h.id, h.className].filter(Boolean).join('.') : 'outside viewport';
            return {error: '点击被遮挡: ' + box(hit) + ' | ' + JSON.stringify(r) + ' scrollY ' + scrollY};
          }
          window.__clicks = window.__clicks || {};
          el.addEventListener('click', () => { window.__clicks['${token}'] = true; },
            {capture: true, once: true});
          return {point};
        })()`);
        if (result.error) throw new Error(result.error);
        return result.point;
      }, `可点击 ${selector}`, 4000);
      await this.send('Input.dispatchMouseEvent', {type:'mousePressed', ...point, button:'left', clickCount:1});
      await this.send('Input.dispatchMouseEvent', {type:'mouseReleased', ...point, button:'left', clickCount:1});
      // 跳转会清空标记，这时按已送达处理，后续断言仍然会发现真正的问题。
      const landed = await this.evaluate(`!window.__clicks || !!window.__clicks['${token}']`).catch(() => true);
      if (landed) return;
      await sleep(120);
    }
    throw new Error(`点击未送达: ${selector}`);
  }
  close() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('浏览器已关闭'));
    }
    this.pending.clear();
    this.socket.close();
  }
}

async function stageAudioState(tab) {
  return tab.evaluate(`(() => {
    const stage = window.openkStage;
    const audio = id => {
      const element = document.getElementById(id);
      return element && {
        time:element.currentTime, duration:element.duration, paused:element.paused,
        seeking:element.seeking, ended:element.ended, ready:element.readyState,
        network:element.networkState, rate:element.playbackRate,
        muted:element.muted, volume:element.volume, error:element.error?.code,
        buffered:Array.from({length:element.buffered.length}, (_, index) =>
          [element.buffered.start(index), element.buffered.end(index)]),
      };
    };
    return {
      now:performance.now(), visibility:document.visibilityState, focused:document.hasFocus(),
      guide:document.querySelector('#guide')?.getAttribute('aria-pressed'),
      armed:stage?.armed, status:stage?.status, voiceBlocked:stage?.voiceBlocked,
      voiceStarting:stage?.voiceStarting, lastFrame:stage?.lastFrame, lastSync:stage?.lastSync,
      music:audio('instrumental'), voice:audio('vocals'),
    };
  })()`);
}

async function stop(child) {
  if (!child?.pid) return;
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
  function signal(name) {
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  signal('SIGTERM');
  await Promise.race([exited, sleep(1500)]);
  // Chrome 的辅助进程可能比主进程活得久；只终止本测试创建的独立进程组。
  signal('SIGKILL');
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openk-browser-'));
  const pages = [];
  const browsers = [];
  const syncSamples = [];
  let server;
  let accountServer, accountData, identityKeyFile;
  let browserDirectory;
  let serverLog = '', chromeLog = '';
  const artifacts = process.env.OPENK_TEST_ARTIFACTS;
  let cleanupPromise;
  function cleanup() {
    return cleanupPromise ||= (async () => {
      for (const tab of pages) tab.close();
      for (const browser of browsers) await stop(browser);
      await stop(server);
      await stop(accountServer);
      await fs.rm(directory, {recursive:true, force:true, maxRetries:4, retryDelay:200});
      // 账号模式的服务数据和假密钥放在测试目录里，跑完立刻删掉。
      for (const leftover of [accountData, identityKeyFile]) {
        if (leftover) await fs.rm(leftover, {recursive:true, force:true, maxRetries:4, retryDelay:200});
      }
      if (browserDirectory) {
        await fs.rm(browserDirectory, {recursive:true, force:true, maxRetries:4, retryDelay:200});
      }
    })();
  }
  const interrupted = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const deadline = setTimeout(() => {
    console.error('浏览器回归超过三分钟，关闭专用进程并清理测试数据。');
    cleanup().finally(() => process.exit(1));
  }, 180000);
  try {
    // Chromium's SingletonSocket must fit sun_path even in deeply nested CI workspaces.
    browserDirectory = await fs.mkdtemp(path.join(
      process.platform === 'win32' ? os.tmpdir() : '/tmp', 'openk-chrome-'));
    if (process.platform !== 'win32') {
      const socket = path.join(await fs.realpath(browserDirectory), 'com.google.Chrome.XXXXXX', 'SingletonSocket');
      assert.ok(Buffer.byteLength(socket) < 104, 'Chrome 临时套接字路径必须短于 Unix 路径上限');
    }
    const binary = await chromePath();
    const python = process.env.OPENK_TEST_PYTHON || path.join(ROOT, '.venv/bin/python');
    const data = path.join(directory, 'data');
    const fixture = spawnSync(python, ['-m', 'tools.demo', data, ...(artifacts ? ['--showcase'] : [])],
      {cwd:ROOT, encoding:'utf8'});
    assert.equal(fixture.status, 0, fixture.stderr);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENK_')));
    server = spawn(python, ['-m', 'backend.main'], {
      cwd:ROOT,
      env:{...env, PYTHONDONTWRITEBYTECODE:'1', OPENK_HOST:'127.0.0.1', OPENK_PORT:String(port),
        OPENK_DATA_DIR:data, OPENK_JOBS_DIR:path.join(data, 'jobs'), OPENK_RESUME_ON_START:'false'},
      stdio:['ignore', 'pipe', 'pipe'], detached:true,
    });
    server.on('error', error => { serverLog += error.stack; });
    server.stdout.on('data', chunk => { serverLog += chunk; });
    server.stderr.on('data', chunk => { serverLog += chunk; });
    await waitFor(async () => (await fetch(base + '/api/health')).ok, '隔离服务启动');
    async function launchBrowser(label) {
      const profile = path.join(browserDirectory, label);
      const browser = spawn(binary, [
        '--headless=new', '--remote-debugging-port=0',
        `--user-data-dir=${profile}`, '--no-first-run',
        '--no-default-browser-check', '--disable-extensions', '--mute-audio',
        '--disable-background-networking', '--disable-component-update',
        '--disable-sync', '--no-pings', '--no-proxy-server',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
      ], {env:{...process.env, TMPDIR:browserDirectory},
        stdio:['ignore', 'pipe', 'pipe'], detached:true});
      browsers.push(browser);
      browser.on('error', error => { chromeLog += error.stack; });
      browser.stderr.on('data', chunk => { chromeLog += chunk; });
      browser.stdout.on('data', () => {});
      return waitFor(async () => {
        const text = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
        return Number(text.split('\n')[0]);
      }, `${label} Chrome CDP 启动`);
    }
    const debugPort = await launchBrowser('tv-browser');
    // 两个独立设备，不把“手机点按钮”错误模拟成“电视切到后台标签页”。
    const phonePort = await launchBrowser('phone-browser');
    async function page(route, width, height, browserPort = debugPort, options = {}) {
      const response = await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, {method:'PUT'});
      const target = await response.json();
      const tab = await CDP.connect(target.webSocketDebuggerUrl);
      pages.push(tab);
      await tab.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor:1, mobile:false});
      await tab.send('Page.addScriptToEvaluateOnNewDocument', {source:`
        navigator.mediaDevices.getUserMedia = async () => {
          throw new DOMException('Physical capture is disabled in browser tests', 'NotAllowedError');
        };
      `});
      if (options.headers) {
        // 真实部署里这些请求头由 NGINX 注入；测试用隔离服务和假密钥模拟同一条信任链。
        await tab.send('Network.enable');
        await tab.send('Network.setExtraHTTPHeaders', {headers:options.headers});
      }
      await tab.send('Page.navigate', {url:(options.origin || base) + route});
      return tab;
    }
    async function screenshot(tab, filename, selectors = []) {
      if (!artifacts) return;
      await fs.mkdir(artifacts, {recursive:true});
      await tab.send('Page.bringToFront');
      await tab.evaluate('document.fonts.ready');
      await waitFor(() => tab.evaluate(`Array.from(document.images).every(image => {
        const rect = image.getBoundingClientRect();
        return !rect.width || !rect.height || rect.top >= innerHeight || rect.bottom <= 0 ||
          (image.complete && image.naturalWidth > 0);
      })`), `截图图片载入：${filename}`);
      assert.ok(await tab.evaluate(`document.querySelector('#pairPanel')?.hidden !== false`),
        '公开截图不能显示配对二维码或配对码');
      assert.ok(await tab.evaluate(`!document.querySelector('#hostControls')?.open`),
        '公开截图不能显示房主的配对信息');
      await sleep(150);
      const clip = selectors.length ? await tab.evaluate(`(() => {
        const rects = ${JSON.stringify(selectors)}.map(selector => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          if (!rect.width || !rect.height) throw new Error('截图控件不可见：' + selector);
          return rect;
        });
        const x = Math.max(0, Math.floor(Math.min(...rects.map(rect => rect.left)) + scrollX) - 16);
        const y = Math.max(0, Math.floor(Math.min(...rects.map(rect => rect.top)) + scrollY) - 16);
        return {x, y, width:Math.ceil(Math.max(...rects.map(rect => rect.right)) + scrollX) + 16 - x,
          height:Math.ceil(Math.max(...rects.map(rect => rect.bottom)) + scrollY) + 16 - y, scale:1};
      })()`) : undefined;
      const image = await tab.send('Page.captureScreenshot', {
        format:'png', captureBeyondViewport:!!clip, ...(clip ? {clip} : {}),
      });
      await fs.writeFile(path.join(artifacts, filename), Buffer.from(image.data, 'base64'));
    }
    const tv = await page('/tv', 1920, 1080);
    await waitFor(() => tv.evaluate(`document.querySelector('#pairCode')?.textContent.replace(/\\s/g,'').match(/^\\d{6}$/)?.[0]`), '电视创建房间与配对码');
    const pairing = await tv.evaluate(`({
      code:document.querySelector('#pairCode').textContent.replace(/\\s/g,''),
      room:document.querySelector('#pairRoom').textContent.match(/[a-f0-9]{10}/)?.[0],
      qr:!!document.querySelector('#qr svg, #qr img, #qr canvas')
    })`);
    assert.ok(pairing.room);
    assert.ok(pairing.qr, '二维码必须在本地生成');
    pass('电视创建房间并生成本地配对二维码');
    const remote = await page('/remote', 390, 844, phonePort);
    await waitFor(() => remote.evaluate(`!!document.querySelector('#joinSubmit')`), '手机加入页');
    await remote.click('#joinCodeShortcut');
    await remote.evaluate(`document.querySelector('#joinRoom').value=${JSON.stringify(pairing.room)};
      document.querySelector('#joinCode').value=${JSON.stringify(pairing.code)};`);
    await remote.click('#joinSubmit');
    await waitFor(() => remote.evaluate(`!document.querySelector('#roomScreen').hidden &&
      document.querySelector('#roomSongList').textContent.includes('一起唱首歌')`), '手机配对并载入曲库');
    pass('手机配对并读取同一曲库');
    const noOverflow = await remote.evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`);
    assert.ok(noOverflow, '390px 手机不能横向溢出');
    pass('390px 手机布局无横向溢出');
    async function add(title) {
      await remote.evaluate(`(() => {
        const row = [...document.querySelectorAll('#roomSongList li')].find(el=>el.textContent.includes(${JSON.stringify(title)}));
        if (!row) throw new Error('没有找到歌曲');
        const button = row.querySelector('button');
        if (!button || button.disabled) throw new Error('点歌按钮不可用');
        button.click();
      })()`);
    }
    async function roomControl(tab, selector) {
      if (!await tab.evaluate('document.querySelector("#playbackPanel").open')) await tab.click('#playbackToggle');
      await tab.click(selector);
    }
    await add('一起唱首歌');
    await waitFor(() => tv.evaluate(`document.querySelector('#songTitle').textContent.includes('一起唱首歌')`), '手机点歌出现在电视');
    await tv.click('#pairActivate');
    await waitFor(() => tv.evaluate(`document.querySelector('#instrumental').readyState >= 2`), '音轨可以播放');
    if (await tv.evaluate(`document.querySelector('#instrumental').paused`)) await remote.click('#remotePlay');
    await waitFor(() => tv.evaluate(`!document.querySelector('#instrumental').paused && document.querySelector('#instrumental').currentTime > 0.05`), '真实音轨播放');
    pass('手机点歌 → 电视经用户手势启动真实音频');
    await roomControl(remote, '#remoteGuide');
    await waitFor(() => tv.evaluate(`document.querySelector('#guide').getAttribute('aria-pressed') === 'true' &&
      !document.querySelector('#vocals').paused`), '启用原唱音轨');
    await tv.send('Page.bringToFront');
    await waitFor(() => tv.evaluate(`document.querySelector('#lyricCurrent').textContent.includes('一起')`), '电视当前歌词');
    syncSamples.push({...await stageAudioState(tv), phase:'guide-start'});
    await waitFor(async () => {
      const {music, voice} = await stageAudioState(tv);
      return [music, voice].every(audio => audio.ready === 4 && !audio.paused &&
        !audio.seeking && !audio.ended && audio.time >= 1);
    }, '双轨完成缓冲并推进真实时钟');
    // 播放器允许 250ms 内的偏移；确定性地超出死区，才能检验真正的同步纠偏。
    const injectedDrift = await tv.evaluate(`(() => {
      const music = document.querySelector('#instrumental'), voice = document.querySelector('#vocals');
      voice.currentTime = music.currentTime - 0.75;
      return Math.abs(music.currentTime - voice.currentTime);
    })()`);
    assert.ok(injectedDrift > 0.5, '必须先产生可测量的真实音轨偏移');
    await waitFor(async () => {
      const sample = {...await stageAudioState(tv), phase:'recovering'};
      syncSamples.push(sample);
      return [sample.music, sample.voice].every(audio => !audio.paused && !audio.seeking &&
        !audio.ended && audio.ready >= 2 && audio.rate === 1) &&
        Math.abs(sample.music.time - sample.voice.time) < 0.2;
    }, '双轨同步稳定');
    const drift = await tv.evaluate(`Math.abs(document.querySelector('#instrumental').currentTime-document.querySelector('#vocals').currentTime)`);
    assert.ok(drift < 0.2, `合成音轨漂移 ${drift}s`);
    const synchronized = await stageAudioState(tv);
    await sleep(1200);
    const continued = {...await stageAudioState(tv), phase:'continued'};
    syncSamples.push(continued);
    assert.ok(continued.music.time - synchronized.music.time > 0.8 &&
      continued.voice.time - synchronized.voice.time > 0.8, '同步后两条真实音轨必须持续推进');
    assert.ok(Math.abs(continued.music.time - continued.voice.time) < 0.2, '持续播放漂移不能超过 200ms');
    assert.ok(continued.lastFrame > synchronized.lastFrame, '大屏帧调度必须持续更新');
    pass(`真实双轨播放同步（采样漂移 ${Math.round(drift * 1000)}ms）`);
    assert.ok(await tv.evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`));
    await screenshot(tv, 'regression-tv-stage.png');
    await screenshot(remote, 'remote-library.png');
    await remote.click('#remotePlay');
    await waitFor(() => tv.evaluate(`document.querySelector('#instrumental').paused`), '远程暂停');
    const before = await tv.evaluate(`document.querySelector('#instrumental').currentTime`);
    await sleep(250);
    assert.ok(Math.abs(await tv.evaluate(`document.querySelector('#instrumental').currentTime`) - before) < 0.05);
    pass('远程暂停同步到真实媒体时钟');
    await roomControl(remote, '#remoteGuide');
    await waitFor(() => tv.evaluate(`document.querySelector('#guide').getAttribute('aria-pressed') === 'false'`), '原唱切换');
    pass('手机原唱切换同步电视');
    await add('星光练习曲');
    await waitFor(() => tv.evaluate(`document.querySelector('#nextSong').textContent.includes('星光练习曲')`), '下一首队列');
    await remote.click('#openQueue');
    await waitFor(() => remote.evaluate(`!document.querySelector('#queuePanel').hidden`), '手机已点抽屉');
    await screenshot(remote, 'remote-queue.png');
    await remote.click('#closeQueue');
    pass('共享待唱队列与手机抽屉');
    await remote.send('Page.reload');
    await waitFor(() => remote.evaluate(`!document.querySelector('#roomScreen')?.hidden &&
      document.querySelector('#remoteTitle')?.textContent.includes('一起唱首歌')`), '手机刷新恢复房间');
    pass('手机刷新恢复配对和播放状态');
    await remote.click('#remotePlay');
    await waitFor(() => tv.evaluate(`!document.querySelector('#instrumental').paused`), '恢复播放');
    await tv.evaluate(`for(const id of ['instrumental','vocals']) {
      const a=document.getElementById(id); a.currentTime=a.duration-0.25;
    }`);
    await waitFor(() => tv.evaluate(`document.querySelector('#songTitle').textContent.includes('星光练习曲') &&
      !document.querySelector('#instrumental').paused`), '自然 ended 后接下一首');
    pass('真实媒体 ended 事件自动接下一首');
    await remote.send('Network.enable');
    await remote.send('Network.emulateNetworkConditions', {
      offline:true, latency:0, downloadThroughput:-1, uploadThroughput:-1,
    });
    await sleep(1600);
    await remote.send('Network.emulateNetworkConditions', {
      offline:false, latency:0, downloadThroughput:-1, uploadThroughput:-1,
    });
    await waitFor(() => remote.evaluate(`document.querySelector('#remoteTitle').textContent.includes('星光练习曲')`), '断线恢复');
    await roomControl(remote, '#remoteRestart');
    await waitFor(() => tv.evaluate(`document.querySelector('#instrumental').currentTime < 1`), '重连后控制命令到达电视');
    pass('手机断线重连不重置电视队列');
    await tv.send('Page.bringToFront');
    await tv.evaluate(`document.querySelector('#playPause').focus()`);
    const focused = await tv.evaluate(`document.activeElement.id`);
    await tv.send('Input.dispatchKeyEvent', {type:'keyDown', key:'ArrowRight', code:'ArrowRight', windowsVirtualKeyCode:39});
    await tv.send('Input.dispatchKeyEvent', {type:'keyUp', key:'ArrowRight', code:'ArrowRight', windowsVirtualKeyCode:39});
    assert.notEqual(await tv.evaluate(`document.activeElement.id`), focused);
    pass('遥控器方向键移动可见焦点');
    await tv.send('Page.reload');
    await waitFor(() => tv.evaluate(`document.querySelector('#pairRoom')?.textContent.includes(${JSON.stringify(pairing.room)})`), '电视刷新保留原房间');
    // 旧页面没有权力立即夺回活跃租约；等到旧租约失效再显式启用。
    await sleep(12500);
    await tv.click('#pairActivate');
    await waitFor(() => tv.evaluate(`document.querySelector('#songTitle').textContent.includes('星光练习曲') &&
      window.openkStage.armed && !window.openkStage.activating &&
      window.openkStage.client.state.playback.playing &&
      !document.querySelector('#instrumental').muted &&
      !document.querySelector('#instrumental').paused`), '电视重新启用原房间播放');
    pass('电视刷新保留房间，旧租约到期后重新授权播放');

    await remote.evaluate('window.openkRemote.client.refresh().then(() => null)');
    if (await remote.evaluate('window.openkRemote.client.state.playback.playing')) await remote.click('#remotePlay');
    await waitFor(() => tv.evaluate('document.querySelector("#instrumental").paused'), '聚会回归前暂停原房间');
    const guestPort = await launchBrowser('party-guest-browser');
    const guest = await page('/rooms', 390, 844, guestPort);
    await waitFor(() => guest.evaluate(`!!document.querySelector('#lobbyList [data-room-id="${pairing.room}"]')`),
      '大厅列出可发现的聚会房间');
    await guest.click(`#lobbyList [data-room-id="${pairing.room}"] button`);
    assert.equal(await guest.evaluate('document.querySelector("#joinRoom").value'), pairing.room);
    await guest.evaluate(`document.querySelector('#displayName').value='Harmony';
      document.querySelector('#joinCode').value=${JSON.stringify(pairing.code)};`);
    await guest.click('#joinSubmit');
    await waitFor(() => guest.evaluate(`window.openkRemote?.client?.state?.viewer.name === 'Harmony' &&
      !!window.openkRemote.client.state.current`), '独立手机加入聚会');
    assert.ok(await guest.evaluate('document.querySelector("#hostControls").hidden'));
    await roomControl(guest, '#singCurrent');
    await waitFor(() => tv.evaluate('document.querySelector("#stageSingers").textContent.includes("Harmony")'),
      '电视显示多人演唱名单');
    pass('大厅发现房间，独立手机加入并登记合唱，普通成员没有房主管理权限');

    await guest.click('#switchRoom');
    await guest.click('#createRoomPanel summary');
    await guest.evaluate('document.querySelector("#newRoomName").value="Second party"');
    await guest.click('#createRoom');
    await waitFor(() => guest.evaluate(`window.openkRemote?.client?.state?.name === 'Second party' &&
      window.openkRemote.client.state.viewer.role === 'host'`), '手机创建独立聚会房间');
    const newParty = await guest.evaluate(`({
      id: window.openkRemote.client.id,
      code: document.querySelector('#inviteCode').textContent,
      hasQR: !!document.querySelector('#inviteQR svg')
    })`);
    assert.ok(newParty.hasQR);
    await guest.evaluate(`document.querySelector('#hostControls').open=false;
      document.querySelector('#songSearch').value='一起唱首歌';
      document.querySelector('#songSearch').dispatchEvent(new Event('input',{bubbles:true}));`);
    await waitFor(() => guest.evaluate(`document.querySelector('#roomSongList .song-info strong')?.textContent === '一起唱首歌'`),
      '第二房间独立选歌');
    await guest.click('#roomSongList .add-song');
    await waitFor(() => guest.evaluate('window.openkRemote.client.state.current?.title === "一起唱首歌"'),
      '第二房间队列');
    assert.ok(await tv.evaluate(`window.openkStage.client.id === ${JSON.stringify(pairing.room)} &&
      window.openkStage.client.state.current.title === '星光练习曲'`), '另一房间的当前歌曲不能被改动');

    const partyTVPort = await launchBrowser('party-tv-browser');
    const partyTV = await page('/tv#room=' + newParty.id, 1280, 720, partyTVPort);
    await waitFor(() => partyTV.evaluate(`document.querySelector('#tvJoinRoom')?.value === ${JSON.stringify(newParty.id)} &&
      document.querySelector('#tvJoinPanel').open`), '电视从大厅进入指定房间配对');
    assert.ok(await partyTV.evaluate('!window.openkStage.client'), '指定房间未配对时不能悄悄创建另一个房间');
    await partyTV.evaluate(`document.querySelector('#tvJoinCode').value=${JSON.stringify(newParty.code)};
      document.querySelector('#tvScreenName').value='Party TV';`);
    await partyTV.click('#joinTV');
    await waitFor(() => partyTV.evaluate(`window.openkStage.client?.id === ${JSON.stringify(newParty.id)} &&
      window.openkStage.client.state?.viewer.role === 'screen'`), '电视以受限播放角色加入');
    assert.ok(await partyTV.evaluate('document.querySelector("#tvSettingsPanel").hidden && !window.openkStage.armed'));
    await partyTV.click('#pairActivate');
    await waitFor(() => partyTV.evaluate('!document.querySelector("#instrumental").paused && document.querySelector("#instrumental").currentTime > 0.05'),
      '被邀请的电视经手势播放真实音轨');
    assert.ok(await tv.evaluate('document.querySelector("#instrumental").paused'), '独立房间不能被别的电视激活');
    pass('手机建房后电视独立配对播放，不传递房主凭据，两个房间各自控制音轨');

    await guest.click('#switchRoom');
    await waitFor(() => guest.evaluate(`!!document.querySelector('#recentList [data-room-id="${newParty.id}"]')`),
      '大厅保留每个房间的本机凭据');
    assert.ok(await partyTV.evaluate('!document.querySelector("#instrumental").paused'),
      '手机切换大厅不能暂停另一设备的电视');
    await screenshot(guest, 'party-lobby.png');
    await guest.click(`#recentList [data-room-id="${newParty.id}"] button`);
    await waitFor(() => guest.evaluate(`window.openkRemote?.client?.id === ${JSON.stringify(newParty.id)} &&
      !!window.openkRemote.client.state`), '从大厅恢复原房间');
    await guest.click('#hostControls summary');
    await guest.click('#endRoom');
    await guest.click('#endRoom');
    await waitFor(() => partyTV.evaluate('!window.openkStage.client && document.querySelector("#instrumental").paused'),
      '房主结束房间后电视停止');
    pass('多房间切换保留配对，结束只撤销本房间并停止其电视');
    if (!await guest.evaluate('document.querySelector("#createRoomPanel").open')) await guest.click('#newPartyShortcut');
    async function touchTargets(selectors) {
      const targets = await guest.evaluate(`${JSON.stringify(selectors)}.map(selector => {
        const rect=document.querySelector(selector).getBoundingClientRect();
        return {selector,width:rect.width,height:rect.height};
      })`);
      for (const target of targets) assert.ok(target.width >= 44 && target.height >= 44,
        `大厅控件需满足触摸尺寸：${JSON.stringify(target)}`);
    }
    for (const width of [320, 390, 768]) {
      await guest.send('Emulation.setDeviceMetricsOverride', {width, height:900, deviceScaleFactor:1, mobile:false});
      assert.ok(await guest.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),
        `聚会大厅 ${width}px 页面不能横向溢出`);
      await touchTargets(['#displayName', '#newRoomName', '#createRoom', '#joinCodeShortcut', '#refreshRooms']);
      await guest.click('#joinCodeShortcut');
      await touchTargets(['#joinRoom', '#joinCode', '#joinSubmit']);
      await guest.click('#newPartyShortcut');
    }
    pass('聚会大厅 320–768px 布局及触摸控件可用');

    const classic = await page('/', 1024, 768, phonePort);
    await waitFor(() => classic.evaluate(`document.body.textContent.includes('一起唱首歌')`), '经典曲库');
    for (const [width, height, name] of [
      [1440, 960, 'classic-desktop'], [1024, 768, 'classic-tablet'],
      [768, 1024, 'classic-portrait'], [390, 844, 'classic-phone'], [320, 812, 'classic-small-phone'],
    ]) {
      await classic.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor:1, mobile:false});
      await classic.evaluate('window.scrollTo(0, 0)');
      await sleep(150);
      assert.ok(await classic.evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`),
        `经典 ${width}px 页面横向溢出`);
      const targets = await classic.evaluate(`['#search', '#queueBtn', '#adminBtn', '.sr-pick'].map(selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return {selector, width:rect.width, height:rect.height, left:rect.left, right:rect.right};
      })`);
      for (const target of targets) {
        assert.ok(target.width >= 44 && target.height >= 44 && target.left >= 0 && target.right <= width + 1,
          `${width}px 核心控件必须可见且可点击：${JSON.stringify(target)}`);
      }
      await screenshot(classic, `${name}.png`);
    }
    await classic.click('#viewToggle');
    await waitFor(() => classic.evaluate(`!document.querySelector('#grid').classList.contains('hidden')`), '手机封面视图');
    assert.ok(await classic.evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`), '320px 封面视图横向溢出');
    await screenshot(classic, 'classic-covers-phone.png');
    await classic.click('#viewToggle');
    pass('经典入口与列表/封面视图保留，320–1440px 布局无横向溢出');
    await classic.send('Emulation.setDeviceMetricsOverride', {width:1024, height:768, deviceScaleFactor:1, mobile:false});
    // 原生合成 MediaStream 驱动真实混音与 MediaRecorder，绝不打开机器的物理麦克风。
    await classic.evaluate(`(() => {
      const context = new AudioContext(), source = context.createOscillator();
      const gain = context.createGain(), output = context.createMediaStreamDestination();
      gain.gain.value = 0.02; source.frequency.value = 440;
      source.connect(gain); gain.connect(output); source.start();
      navigator.mediaDevices.getUserMedia = async () => {
        await context.resume();
        return output.stream.clone();
      };
      addEventListener('pagehide', () => { source.stop(); context.close(); }, {once:true});
    })()`);
    await classic.click('.song-row .sr-pick');
    await waitFor(() => classic.evaluate(`!document.querySelector('#instAudio').paused &&
      document.querySelector('#instAudio').currentTime > 0`), '经典播放器真实起播');
    const recordedId = await classic.evaluate(`document.querySelector('#instAudio').currentSrc.match(/\\/media\\/([^/]+)\\//)[1]`);
    await classic.click('#recBtn');
    await waitFor(() => classic.evaluate(`/停止/.test(document.querySelector('#recBtn').textContent)`), '真实 MediaRecorder 启动');
    await sleep(900);
    await classic.click('#homeBtn');
    await classic.click('.song-row:nth-child(2) .sr-pick');
    await classic.click('#nbSkip');
    await waitFor(async () => (await (await fetch(`${base}/api/jobs/${recordedId}/recordings`)).json()).length === 1, '切歌后旧录音上传原歌曲');
    const newId = await classic.evaluate(`document.querySelector('#instAudio').currentSrc.match(/\\/media\\/([^/]+)\\//)[1]`);
    assert.notEqual(newId, recordedId);
    const oldRecordings = await (await fetch(`${base}/api/jobs/${recordedId}/recordings`)).json();
    const newRecordings = await (await fetch(`${base}/api/jobs/${newId}/recordings`)).json();
    assert.equal(newRecordings.length, 0, '录音不能错挂到下一首');
    const recording = await fetch(base + oldRecordings[0].url);
    assert.ok((await recording.arrayBuffer()).byteLength > 100);
    pass('真实模拟麦克风/MediaRecorder 录唱，切歌后音频保存到原歌曲');

    /* ---- 账号模式：真实浏览器里同一个账号只有一个当前房间 ---- */
    // 生产上这条信任链由 NGINX + 账号服务提供；这里用隔离服务和假密钥复现同样的协议。
    const identityKey = 'openk-browser-test-fake-proxy-key-0123456789_abcdef';
    assert.ok(/^[A-Za-z0-9_-]{48,128}$/.test(identityKey), '合成代理密钥要符合服务端约定');
    identityKeyFile = path.join(__dirname, '.identity-key-' + Math.random().toString(36).slice(2, 10));
    accountData = path.join(__dirname, '.account-data-' + Math.random().toString(36).slice(2, 10));
    await fs.writeFile(identityKeyFile, identityKey, {mode:0o600});
    const accountFixture = spawnSync(python, ['-m', 'tools.demo', accountData], {cwd:ROOT, encoding:'utf8'});
    assert.equal(accountFixture.status, 0, accountFixture.stderr);
    const accountPort = await freePort();
    const accountBase = `http://127.0.0.1:${accountPort}`;
    accountServer = spawn(python, ['-m', 'backend.main'], {
      cwd:ROOT,
      env:{...env, PYTHONDONTWRITEBYTECODE:'1', OPENK_HOST:'127.0.0.1', OPENK_PORT:String(accountPort),
        OPENK_DATA_DIR:accountData, OPENK_JOBS_DIR:path.join(accountData, 'jobs'),
        OPENK_RESUME_ON_START:'false', OPENK_IDENTITY_KEY_FILE:identityKeyFile},
      stdio:['ignore', 'pipe', 'pipe'], detached:true,
    });
    accountServer.on('error', error => { serverLog += error.stack; });
    accountServer.stdout.on('data', chunk => { serverLog += chunk; });
    accountServer.stderr.on('data', chunk => { serverLog += chunk; });
    await waitFor(async () => (await fetch(accountBase + '/api/health')).ok, '账号模式隔离服务启动');
    const singer = {id:'3f2504e0-4f89-11d3-9a0c-0305e82c3301', username:'ling', display_name:'小玲', is_staff:false};
    const identity = {
      'X-OpenK-Identity-Key': identityKey,
      'X-OpenK-Account': Buffer.from(JSON.stringify(singer), 'utf8').toString('base64url'),
    };
    const landing = await fetch(accountBase + '/', {headers:identity});
    assert.equal(new URL(landing.url).pathname, '/', '账号模式首页保留完整的房间播放器');
    assert.ok((await landing.text()).includes('id="instAudio"'), '首页不再是没有音频的遥控器');
    assert.ok((await fetch(accountBase + '/library', {headers:identity})).ok, '经典曲库仍在 /library');
    const accountPhone = await page('/remote', 390, 844, phonePort, {origin:accountBase, headers:identity});
    await waitFor(() => accountPhone.evaluate(`!!window.openkRemote?.client?.state?.solo &&
      document.querySelector('#accountChip .account-name')?.textContent === '小玲'`), '登录后自动进入自己的房间');
    const soloRoom = await accountPhone.evaluate('window.openkRemote.client.id');
    assert.ok(await accountPhone.evaluate(`window.openkRemote.client.token === null &&
      localStorage.getItem('openk.remote.room') === null`), '账号模式不保存房间凭据');
    const accountTV = await page('/tv', 1280, 720, debugPort, {origin:accountBase, headers:identity});
    await waitFor(() => accountTV.evaluate(`window.openkStage?.client?.id === ${JSON.stringify(soloRoom)} &&
      window.openkStage.client.state?.members.length === 1`), '电视沿用同一账号的房间和同一个成员');
    await accountPhone.evaluate(`window.openkRemote.client.command('add', {job_id:
      window.openkRemote.jobs.find(job => job.title === '星光练习曲').id}).then(() => null)`);
    await waitFor(() => accountTV.evaluate(`window.openkStage.client.state?.current?.title === '星光练习曲'`),
      '独唱房间用同一套队列');
    await accountTV.click('#closePair');
    await accountTV.click('#playPause');
    await waitFor(() => accountTV.evaluate(`!document.querySelector('#instrumental').paused &&
      document.querySelector('#instrumental').currentTime > 0.05`), '一个人也能在自己的房间里真实起播');
    pass('账号登录后手机和电视自动共用同一个私人房间并真实播放');

    await accountPhone.evaluate(`document.querySelector('#newRoomName').value = '客厅聚会';
      window.openkRemote.create().then(() => null)`);
    await waitFor(() => accountPhone.evaluate(`window.openkRemote.client?.state?.name === '客厅聚会' &&
      window.openkRemote.client.id !== ${JSON.stringify(soloRoom)}`), '手机整体搬进新的聚会房间');
    const partyRoom = await accountPhone.evaluate('window.openkRemote.client.id');
    await waitFor(() => accountTV.evaluate(`window.openkStage.client?.id === ${JSON.stringify(partyRoom)}`),
      '电视跟着账号换房间');
    assert.ok(await accountTV.evaluate(`document.querySelector('#instrumental').paused &&
      window.openkStage.armed === false && !document.querySelector('#pairPanel').hidden`),
      '换房间必须先停声并重新请求用户手势');
    assert.ok(await accountTV.evaluate(`window.openkStage.client.state.members.length === 1`),
      '同一个账号的两台设备仍然只占一个成员');
    assert.ok(/^\d{6}$/.test(await accountPhone.evaluate(`document.querySelector('#inviteCode').textContent`)),
      '房主拿到可用的邀请码');
    const firstCode = await accountPhone.evaluate(`document.querySelector('#inviteCode').textContent`);
    // 电视没有保存过明文配对码（服务器只存摘要），所以它只提供“生成配对码”。
    assert.ok(await accountTV.evaluate(`!document.querySelector('#pairCode').textContent
        .includes(${JSON.stringify(firstCode.slice(0, 3))}) &&
      document.querySelector('#tvRefreshInvite').textContent === '生成配对码'`), '另一台设备不会凭空得到配对码');
    // 另一台已登录设备换码：手机上的旧码必须消失，并且不能自己再换一次。
    const rotated = await (await fetch(`${accountBase}/api/rooms/${partyRoom}/invitation`,
      {method:'POST', headers:identity})).json();
    assert.ok(/^\d{6}$/.test(rotated.pairing_code) && rotated.state.invite_version > 1, '另一台设备换码成功');
    await waitFor(() => accountPhone.evaluate(`window.openkRemote.client.state.invite_version ===
        ${rotated.state.invite_version} && document.querySelector('#roomInvite').hidden === true &&
      document.querySelector('#inviteQR').children.length === 0 &&
      document.querySelector('#refreshInvite').textContent === '生成配对码' &&
      !document.querySelector('#inviteCode').textContent.includes(${JSON.stringify(firstCode.slice(0, 3))})`),
      '别的设备换码后旧码在这里消失');
    assert.equal(await accountPhone.evaluate(`window.openkRemote.client.state.invite_version`),
      rotated.state.invite_version, '过期的配对码不会触发自动换码');
    await accountPhone.click('#refreshInvite');
    await waitFor(() => accountPhone.evaluate(`/^\\d{6}$/.test(document.querySelector('#inviteCode').textContent) &&
      document.querySelector('#roomInvite').hidden === false &&
      JSON.parse(localStorage.getItem('openk.account.invites.v1'))[${JSON.stringify(singer.id)}]
        [${JSON.stringify(partyRoom)}].version === window.openkRemote.client.state.invite_version`),
      '房主可以按版本重新生成并保存邀请码');
    pass('换房间后电视立即停声、跟随账号，并按账号和版本管理邀请码');

    const guestSinger = {...singer, id:'9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      username:'hao', display_name:'阿豪'};
    const guestIdentity = {...identity,
      'X-OpenK-Account': Buffer.from(JSON.stringify(guestSinger), 'utf8').toString('base64url')};
    const invitationCode = await accountPhone.evaluate(`document.querySelector('#inviteCode').textContent`);
    const invitedPhone = await page(`/remote#room=${partyRoom}&code=${invitationCode}`, 390, 844, phonePort,
      {origin:accountBase, headers:guestIdentity});
    await waitFor(() => invitedPhone.evaluate(`!window.openkRemote?.starting &&
      window.openkRemote.client?.id === ${JSON.stringify(partyRoom)} &&
      document.querySelector('#accountChip .account-name').textContent === '阿豪'`), '新账号通过邀请链接加入聚会');
    assert.ok(await invitedPhone.evaluate(`location.hash === '' &&
      window.openkRemote.client.token === null && document.querySelector('#joinScreen').hidden`),
      '进入自己的房间不会清掉待处理的邀请');
    const accountLobby = await page('/rooms', 390, 844, phonePort, {origin:accountBase, headers:identity});
    await waitFor(() => accountLobby.evaluate(`!window.openkRemote?.starting && window.openkRemote.lobbyOpen &&
      location.pathname === '/rooms' && !document.querySelector('#joinScreen').hidden &&
      window.openkRemote.client?.id === ${JSON.stringify(partyRoom)}`), '直接打开大厅仍停留在大厅');
    await accountLobby.evaluate('window.__beforeLobbyReload = true');
    await accountLobby.send('Page.reload');
    await waitFor(() => accountLobby.evaluate(`window.__beforeLobbyReload === undefined &&
      !window.openkRemote?.starting && window.openkRemote?.lobbyOpen &&
      location.pathname === '/rooms' && window.openkRemote.client?.id === ${JSON.stringify(partyRoom)}`),
      '刷新大厅后保留房间和大厅页面');
    pass('账号邀请链接、大厅直达和大厅刷新都保留原始入口意图');

    await accountPhone.click('#switchRoom');
    await waitFor(() => accountPhone.evaluate(`location.pathname === '/rooms' &&
      !document.querySelector('#currentRoomBanner').hidden &&
      window.openkRemote.client?.running === true`), '逛大厅不会把人丢出房间');
    await accountPhone.click('#returnRoom');
    await waitFor(() => accountPhone.evaluate(`location.pathname === '/remote' &&
      window.openkRemote.client.id === ${JSON.stringify(partyRoom)}`), '从大厅直接回到当前房间');
    await accountPhone.click('#leaveRoom');
    await waitFor(() => accountPhone.evaluate(`window.openkRemote.client?.state?.solo === true &&
      window.openkRemote.client.id !== ${JSON.stringify(partyRoom)} &&
      document.querySelector('#roomScreen').hidden === false`), '离开聚会回到自己的房间而不是空白页');
    assert.ok(await accountPhone.evaluate(`document.querySelector('#soloHint').hidden === false &&
      document.querySelector('#playHere').getAttribute('href') === '/?view=player'`), '私人房间提供完整的本机演唱入口');
    const accountLibrary = await page('/library', 1024, 768, phonePort, {origin:accountBase, headers:identity});
    await waitFor(() => accountLibrary.evaluate(`!!room?.id &&
      document.querySelectorAll('.song-row').length > 0 &&
      document.querySelector('#accountChip .account-name')?.textContent === '小玲'`), '账号模式曲库载入');
    await accountLibrary.click('.song-row[data-id="000000000002"] .sr-pick');
    await waitFor(() => accountPhone.evaluate(`window.openkRemote.client.state.queue
      .concat([window.openkRemote.client.state.current]).some(item => item)`), '曲库点歌进入当前房间');
    await waitFor(() => accountLibrary.evaluate(`!document.querySelector('#instAudio').paused &&
      document.querySelector('#instAudio').currentTime > .05`), '账号曲库点歌在当前房间真实本机起播');
    assert.ok(await accountLibrary.evaluate(`!document.querySelector('#stage').classList.contains('hidden') &&
      room.client.state.current.job_id === state.currentJobId &&
      localStorage.getItem('openk.queue') === null`),
      '账号曲库恢复完整播放器但不另开房间外的本地队列');
    pass('账号模式下大厅、离开、曲库和完整本机播放都使用同一个当前房间');

    if (artifacts) {
      await waitFor(() => classic.evaluate(`!document.querySelector('#instAudio').paused`), '经典下一首真实起播');
      await classic.click('#playBtn');
      await waitFor(() => classic.evaluate(`document.querySelector('#instAudio').paused`), '截图准备暂停经典歌曲');
      // 只通过真实控件组织演示；曲库、封面、音轨均由隔离 fixture 生成。
      await remote.send('Emulation.setDeviceMetricsOverride', {
        width:430, height:960, deviceScaleFactor:1, mobile:false,
      });
      await add('一起唱首歌');
      await waitFor(() => remote.evaluate(`document.querySelector('#remoteQueueCount').textContent === '1'`),
        '演示歌曲入队');
      await roomControl(remote, '#remoteNext');
      await waitFor(() => tv.evaluate(`document.querySelector('#songTitle').textContent === '一起唱首歌' &&
        document.querySelector('#instrumental').readyState >= 2`), '演示舞台歌曲');
      if (!await tv.evaluate(`document.querySelector('#instrumental').paused`)) await remote.click('#remotePlay');
      await waitFor(() => tv.evaluate(`document.querySelector('#instrumental').paused`), '演示准备暂停');
      for (const [index, title] of ['星光练习曲', '纸飞机电台', '云端散步'].entries()) {
        await add(title);
        await waitFor(() => remote.evaluate(`Number(document.querySelector('#remoteQueueCount').textContent) === ${index + 1}`),
          '演示待唱队列');
      }
      if (!await remote.evaluate(`document.querySelector('#remoteGuide').getAttribute('aria-pressed') === 'true'`)) {
        await roomControl(remote, '#remoteGuide');
      }
      await waitFor(() => remote.evaluate(`document.querySelector('#remoteNotice').hidden`), '点歌提示自然消失');
      await remote.evaluate(`const seek = document.querySelector('#seek');
        seek.value = 2; seek.dispatchEvent(new Event('change', {bubbles:true})); window.scrollTo(0, 0);`);
      await waitFor(() => tv.evaluate(`Math.abs(document.querySelector('#instrumental').currentTime - 2) < 0.3`),
        '演示逐字歌词位置');
      await tv.send('Page.bringToFront');
      if (!await tv.evaluate('window.openkStage.armed')) {
        const activate = await tv.evaluate(`document.querySelector('#pairPanel').hidden ? '#activate' : '#pairActivate'`);
        await tv.click(activate);
        await waitFor(() => tv.evaluate('window.openkStage.armed && !window.openkStage.activating'),
          '重新启用演示电视声音');
      }
      if (!await remote.evaluate('window.openkRemote.client.state.playback.playing')) await remote.click('#remotePlay');
      await waitFor(() => tv.evaluate(`!document.querySelector('#instrumental').paused &&
        document.querySelector('#lyricCurrent').textContent.includes('一起')`), '演示真实播放');
      await screenshot(tv, 'tv-stage.png');
      await waitFor(() => remote.evaluate(`document.querySelector('#playerStatus').textContent === '声音正在电视播放'`),
        '演示手机播放状态');
      await screenshot(remote, 'remote.png');
      await remote.click('#remotePlay');
      await waitFor(() => tv.evaluate(`document.querySelector('#instrumental').paused`), '演示搜索前暂停');
      await waitFor(() => remote.evaluate(`document.querySelector('#playerStatus').textContent === '已暂停'`),
        '演示手机暂停状态');
      await remote.click('#songSearch');
      await remote.send('Input.insertText', {text:'xg'});
      await waitFor(() => remote.evaluate(`document.querySelectorAll('#roomSongList li').length === 1 &&
        document.querySelector('#roomSongList').textContent.includes('星光练习曲')`), '真实拼音首字母搜索');
      await screenshot(remote, 'remote-search.png');
      await remote.evaluate(`document.querySelector('#songSearch').value = '';
        document.querySelector('#songSearch').dispatchEvent(new Event('input', {bubbles:true}));`);
      await waitFor(() => remote.evaluate(`document.querySelectorAll('#roomSongList li').length === 8`),
        '恢复演示曲库');
      await remote.click('#openQueue');
      await screenshot(remote, 'remote-queue.png');
      await remote.click('#closeQueue');
      await classic.send('Emulation.setDeviceMetricsOverride', {
        width:1280, height:960, deviceScaleFactor:1, mobile:false,
      });
      if (!await classic.evaluate(`document.querySelector('#instAudio').paused`)) await classic.click('#playBtn');
      await classic.click('#homeBtn');
      await classic.click('.song-row[data-id="000000000001"] .sr-pick');
      await classic.click('#nbSkip');
      await waitFor(() => classic.evaluate(`document.querySelector('#playerTitle').textContent.includes('一起唱首歌') &&
        !document.querySelector('#instAudio').paused`), '经典演示歌曲');
      await classic.click('#playBtn');
      if (await classic.evaluate(`!document.querySelector('#resumeMonitor').classList.contains('hidden')`)) {
        await classic.click('#resumeMonitor');
      }
      await classic.click('#homeBtn');
      await classic.click('.song-row[data-id="000000000002"] .sr-pick');
      await classic.click('.song-row[data-id="000000000003"] .sr-pick');
      await waitFor(() => classic.evaluate(`!document.querySelector('#toast')?.classList.contains('show')`),
        '经典点歌提示自然消失');
      await classic.evaluate('window.scrollTo(0, 0)');
      await screenshot(classic, 'songboard.png');
      await classic.click('#adminBtn');
      await waitFor(() => classic.evaluate(`!document.querySelector('#adminPanel').classList.contains('hidden') &&
        !document.querySelector('#procEmpty').classList.contains('hidden')`), '真实空闲导入后台');
      await screenshot(classic, 'processing.png');
      await classic.click('#adminClose');
      await classic.click('#nbOpen');
      await classic.click('#playBtn');
      await waitFor(() => classic.evaluate(`document.querySelector('#lyrics .active')?.textContent.replace(/\\s/g, '').includes('声音')`),
        '经典播放器合成歌词');
      await classic.click('#playBtn');
      await classic.evaluate('window.scrollTo(0, 0)');
      await screenshot(classic, 'player.png');
      await screenshot(classic, 'controls.png', ['.controls', '#playBtn', '.mixer', '.recorder']);
      for (const tab of [tv, remote, classic]) {
        assert.ok(await tab.evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`),
          '公开截图布局不能横向溢出');
      }
      pass('公开截图：合成曲库、大屏、手机搜索/队列、经典播放器和空闲后台');
    }
    assert.deepEqual(errors, [], `浏览器未处理异常：${errors.join('\n')}`);
    pass('所有页面无未处理的 JavaScript 异常');
    console.log(`\n${checks} browser checks passed`);
  } catch (error) {
    console.error(error.stack);
    console.error('Test directory:', directory);
    console.error('PAGE ERRORS:\n' + errors.join('\n'));
    console.error('AUDIO SYNC:', JSON.stringify({
      samples:syncSamples.length, first:syncSamples[0], last:syncSamples.at(-1),
    }));
    for (const [index, tab] of pages.entries()) {
      try {
        const state = await tab.evaluate(`({
          route:location.pathname,
          joinError:document.querySelector('#joinError')?.textContent,
          libraryStatus:document.querySelector('#libraryStatus')?.textContent,
          roomHidden:document.querySelector('#roomScreen')?.hidden,
          songs:document.querySelector('#roomSongList')?.textContent?.slice(0,600),
          audioStatus:document.querySelector('#audioStatus')?.textContent,
          recording:document.querySelector('#recStatus')?.textContent,
          microphone:document.querySelector('#micHint')?.textContent,
          audioContext:typeof state!=='undefined'?state.audioGraph?.actx?.state:undefined,
          micPending:typeof state!=='undefined'?!!state.micRequest:undefined
        })`);
        console.error('PAGE STATE:', JSON.stringify(state));
        if (state.route === '/tv') console.error('STAGE AUDIO:', JSON.stringify(await stageAudioState(tab)));
        if (artifacts) {
          await fs.mkdir(artifacts, {recursive:true});
          const screenshot = await tab.send('Page.captureScreenshot', {format:'png'});
          await fs.writeFile(path.join(artifacts, `failure-${index}.png`), Buffer.from(screenshot.data, 'base64'));
        }
      } catch (captureError) { console.error('Failure capture:', captureError.message); }
    }
    console.error('SERVER LOG:\n' + serverLog.slice(-12000));
    console.error('CHROME LOG:\n' + chromeLog.slice(-2000));
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    try {
      if (artifacts) {
        await fs.mkdir(artifacts, {recursive:true});
        await fs.writeFile(path.join(artifacts, 'audio-sync.json'), JSON.stringify({
          samples:syncSamples,
          displayLinkWarnings:chromeLog.split('CVDisplayLinkCreateWithCGDisplay failed').length - 1,
        }, null, 2));
      }
    } finally { await cleanup(); }
  }
}
module.exports = { CDP, chromePath, freePort, waitFor, sleep, stop, errors };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
