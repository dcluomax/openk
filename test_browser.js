/* 真实 Chrome + 双页面回归；仅使用 Node/CDP，不安装另一套浏览器测试框架。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn, spawnSync} = require('node:child_process');

const ROOT = __dirname;
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
    const point = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.disabled || el.hidden) throw new Error('控件不可用: ${selector}');
      el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) throw new Error('控件不可见: ${selector}');
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    await this.send('Input.dispatchMouseEvent', {type:'mousePressed', ...point, button:'left', clickCount:1});
    await this.send('Input.dispatchMouseEvent', {type:'mouseReleased', ...point, button:'left', clickCount:1});
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
  let serverLog = '', chromeLog = '';
  const artifacts = process.env.OPENK_TEST_ARTIFACTS;
  let cleanupPromise;
  function cleanup() {
    return cleanupPromise ||= (async () => {
      for (const tab of pages) tab.close();
      for (const browser of browsers) await stop(browser);
      await stop(server);
      await fs.rm(directory, {recursive:true, force:true, maxRetries:4, retryDelay:200});
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
    const binary = await chromePath();
    const python = process.env.OPENK_TEST_PYTHON || path.join(ROOT, '.venv/bin/python');
    const data = path.join(directory, 'data');
    const fixture = spawnSync(python, ['scripts/test_fixtures.py', data, ...(artifacts ? ['--showcase'] : [])],
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
      const profile = path.join(directory, label);
      const browser = spawn(binary, [
        '--headless=new', '--remote-debugging-port=0',
        `--user-data-dir=${profile}`, '--no-first-run',
        '--no-default-browser-check', '--disable-extensions', '--mute-audio',
        '--disable-background-networking', '--disable-component-update',
        '--disable-sync', '--no-pings', '--no-proxy-server',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
      ], {stdio:['ignore', 'pipe', 'pipe'], detached:true});
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
    async function page(route, width, height, browserPort = debugPort) {
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
      await tab.send('Page.navigate', {url:base + route});
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
    await add('一起唱首歌');
    await waitFor(() => tv.evaluate(`document.querySelector('#songTitle').textContent.includes('一起唱首歌')`), '手机点歌出现在电视');
    await tv.click('#pairActivate');
    await waitFor(() => tv.evaluate(`document.querySelector('#instrumental').readyState >= 2`), '音轨可以播放');
    if (await tv.evaluate(`document.querySelector('#instrumental').paused`)) await remote.click('#remotePlay');
    await waitFor(() => tv.evaluate(`!document.querySelector('#instrumental').paused && document.querySelector('#instrumental').currentTime > 0.05`), '真实音轨播放');
    pass('手机点歌 → 电视经用户手势启动真实音频');
    await remote.click('#remoteGuide');
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
    await remote.click('#remoteGuide');
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
    await remote.click('#remoteRestart');
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
      !document.querySelector('#instrumental').paused`), '电视重新启用原房间播放');
    pass('电视刷新保留房间，旧租约到期后重新授权播放');
    const classic = await page('/', 1024, 768, phonePort);
    await waitFor(() => classic.evaluate(`document.body.textContent.includes('一起唱首歌')`), '经典曲库');
    assert.ok(await classic.evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`));
    await screenshot(classic, 'classic-tablet.png');
    await classic.send('Emulation.setDeviceMetricsOverride', {width:390, height:844, deviceScaleFactor:1, mobile:false});
    await sleep(150);
    assert.ok(await classic.evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`), '经典手机页面横向溢出');
    await screenshot(classic, 'classic-phone.png');
    pass('经典入口保留，平板与手机布局无横向溢出');
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
      await remote.click('#remoteNext');
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
        await remote.click('#remoteGuide');
      }
      await waitFor(() => remote.evaluate(`document.querySelector('#remoteNotice').hidden`), '点歌提示自然消失');
      await remote.evaluate(`const seek = document.querySelector('#seek');
        seek.value = 2; seek.dispatchEvent(new Event('change', {bubbles:true})); window.scrollTo(0, 0);`);
      await waitFor(() => tv.evaluate(`Math.abs(document.querySelector('#instrumental').currentTime - 2) < 0.3`),
        '演示逐字歌词位置');
      await remote.click('#remotePlay');
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
main().catch(error => { console.error(error); process.exitCode = 1; });
