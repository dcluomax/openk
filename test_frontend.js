/**
 * 点歌台前端的冒烟测试（node test_frontend.js）。
 *
 * 前端没有构建步骤，也就没有编译期检查，光靠肉眼看很容易漏掉「点歌后
 * 控制条没出来」「返回曲库把歌停了」这类只在交互后才暴露的问题。这里用
 * jsdom 把 index.html + app.js 真跑一遍，覆盖点歌台最关键的几条链路。
 *
 * 需要 jsdom：npm install jsdom（没装就跳过，不阻塞其它测试）。
 */
try { require.resolve('jsdom'); } catch {
  console.log('== 前端冒烟 ==\n  (跳过：未安装 jsdom，执行 `npm install jsdom` 后可运行)');
  process.exit(0);
}
const { JSDOM } = require('jsdom');
const fs = require('fs');
const D = require('path').join(__dirname, 'frontend');

const jobs = [
  { id:'a1', state:'done', title:'周杰倫 Jay Chou - 稻香 (Official MV)', duration:223,
    thumbnail:'/media/a1/source/thumb.jpg', media:{instrumental:'/m/i.mp3', vocals:'/m/v.mp3', lyrics:'/m/l.json'},
    artist:'周杰倫', track:'稻香', line_count:42, lyrics_status:'ok' },
  { id:'a2', state:'done', title:'NO -240 淚的小雨- 高勝美(國語) (娛己娛人卡拉OK)', duration:250,
    thumbnail:'/media/a2/source/thumb.jpg', media:{instrumental:'/m/i.mp3', lyrics:'/m/l.json'},
    artist:'高勝美', track:'淚的小雨', line_count:30, lyrics_status:'ok' },
  { id:'a3', state:'done', title:'Beyond - 海闊天空 (粵語)', duration:326,
    thumbnail:null, media:{instrumental:'/m/i.mp3', lyrics:'/m/l.json'}, artist:'Beyond', track:'海闊天空',
    line_count:0, lyrics_status:'none' },
  // 同一位歌手的两种写法：歌手页要合成一位，不能劈成两个
  { id:'a4', state:'done', title:'夢然 - 少年', duration:240,
    thumbnail:null, media:{instrumental:'/m/i.mp3', lyrics:'/m/l.json'}, artist:'夢然', track:'少年',
    line_count:20, lyrics_status:'ok' },
  { id:'a5', state:'done', title:'梦然 - 没有你陪伴真的好孤单', duration:250,
    thumbnail:null, media:{instrumental:'/m/i.mp3', lyrics:'/m/l.json'}, artist:'梦然',
    track:'没有你陪伴真的好孤单', line_count:22, lyrics_status:'ok' },
  { id:'b1', state:'running', title:'处理中的歌', progress:0.4, message:'人声分离' },
];

const dom = new JSDOM(fs.readFileSync(D + '/index.html', 'utf8'), {
  url: 'https://localhost:8443/', runScripts: 'outside-only', pretendToBeVisual: true,
});
const w = dom.window;
const plays = [];
w.HTMLMediaElement.prototype.load = () => {};
w.HTMLMediaElement.prototype.play = function () {
  plays.push(this.id || '?'); this._playing = true; return Promise.resolve();
};
w.HTMLMediaElement.prototype.pause = function () { this._playing = false; };
w.AudioContext = w.webkitAudioContext = function () {
  const param = (v) => ({ value: v, cancelScheduledValues(){}, setValueAtTime(){},
    linearRampToValueAtTime(t){ this.value = t; } });
  const node = () => ({ connect(){}, disconnect(){}, gain:param(1), buffer:null, type:'',
    frequency:param(1000), Q:param(1),
    threshold:param(0), knee:param(0), ratio:param(0), attack:param(0), release:param(0),
    fftSize:2048, frequencyBinCount:1024, smoothingTimeConstant:0,
    getFloatFrequencyData(a){ a.fill(-120); } });
  return { state:'running', resume:()=>Promise.resolve(), destination:node(), sampleRate:48000,
    currentTime:0,
    createGain:node, createConvolver:node, createDynamicsCompressor:node,
    createBiquadFilter:node, createAnalyser:node,
    createMediaElementSource:node, createMediaStreamSource:node, createMediaStreamDestination:node,
    createBuffer:(c,l)=>({getChannelData:()=>new Float32Array(l)}) };
};
w.navigator.mediaDevices = { getUserMedia: () => Promise.reject(new Error('测试环境没有麦克风')) };
w.fetch = (u) => Promise.resolve({
  ok:true,
  json: async () => {
    const m = String(u).match(/\/api\/jobs\/([\w]+)$/);
    if (m) return jobs.find(j => j.id === m[1]);
    if (String(u).includes('/api/jobs')) return jobs;
    if (String(u).includes('/api/zh-map')) return { '闊':'阔', '權':'权', '夢':'梦', '沒':'没' };
    if (String(u).includes('/api/local/status')) return { enabled:true };
    if (String(u).includes('/api/recordings')) return [];
    return { language:'zh', lines:[] };
  },
});
w.alert = (m) => { errs.push('意外弹窗: ' + String(m).slice(0,60)); };

const errs = [];
process.on('unhandledRejection', (e) => errs.push('未处理的 Promise: ' + (e && e.message)));
w.addEventListener('error', (e) => errs.push('window.error: ' + e.message));
w.onerror = (m) => errs.push('onerror: ' + m);

// app.js 是严格模式，indirect eval 下顶层声明不会漏到 window 上，
// 所以在末尾追一句显式导出，把要单测的几个纯函数取出来。
w.eval(fs.readFileSync(D + '/app.js', 'utf8')
  + '\n;window.__t = { findHowlPeak, makeHowlTracker, makeNotchBank, howlTick, HOWL };');

/* 防啸叫：真实啸叫只在「麦克风离音箱太近」的房间里才出现，肉眼和 CI 都碰不到，
   所以直接喂合成频谱，把「像啸叫」和「像唱歌」两类各验一遍——
   误判成本很高：漏判是继续尖叫，错判是把人家的长音给掐了。 */
const BIN_HZ = 48000 / 4096;
function spectrum(peaks, floorDb = -95, bins = 2048) {
  const s = new Float32Array(bins).fill(floorDb);
  for (const [hz, db] of peaks) {
    const b = Math.round(hz / BIN_HZ);
    if (b <= 0 || b >= bins - 1) continue;
    s[b] = db;                                        // 主瓣
    s[b - 1] = Math.max(s[b - 1], db - 22);           // 频谱泄漏的裙边
    s[b + 1] = Math.max(s[b + 1], db - 22);
  }
  return s;
}

function howlTests(T) {
  const { findHowlPeak, makeHowlTracker, makeNotchBank, howlTick } = w.__t;

  // —— 判别：一根孤零零的针是啸叫，一把梳子是人在唱歌 ——
  const howl = findHowlPeak(spectrum([[3000, -20]]), BIN_HZ);
  T(howl && Math.abs(howl.hz - 3000) < 20, `孤立强峰判为啸叫（${howl ? Math.round(howl.hz) : '未检出'}Hz）`);
  T(findHowlPeak(spectrum([[300, -25], [600, -28], [900, -30], [1200, -35]]), BIN_HZ) === null,
    '带 2f/3f 泛音列的长音判为人声，不误伤');
  T(findHowlPeak(spectrum([[5000, -22], [10000, -26], [15000, -30]]), BIN_HZ) !== null,
    '泛音超出分析带宽的高频啸叫仍能检出');
  const noisy = new Float32Array(2048);
  for (let i = 0; i < noisy.length; i++) noisy[i] = -60 + Math.sin(i) * 4;
  T(findHowlPeak(noisy, BIN_HZ) === null, '宽频伴奏没有突出峰，不误报');
  T(findHowlPeak(new Float32Array(2048).fill(-120), BIN_HZ) === null, '静音不误报');
  T(findHowlPeak(spectrum([[3000, -80]], -120), BIN_HZ) === null, '尖但很轻的峰不算啸叫（还没进正反馈）');

  // —— 咬定：啸叫赖在共振点不走，人声就算长音也会飘 ——
  const tr = makeHowlTracker();
  let fired = 0;
  for (let i = 0; i < 6; i++) if (tr.push({ bin: 256, hz: 3000, db: -20 })) fired++;
  T(fired === 1, `同一频点连续 6 帧才确认一次（确认 ${fired} 次）`);
  const tr2 = makeHowlTracker();
  let wobble = 0;
  for (let i = 0; i < 40; i++) if (tr2.push({ bin: 256 + (i % 8) * 6, hz: 3000, db: -20 })) wobble++;
  T(wobble === 0, `频率飘忽的长音永远不会被确认（误判 ${wobble} 次）`);

  // —— 处置：在啸叫的频率上挖窄坑，把环路增益压回 1 以下 ——
  const actx = new w.AudioContext();
  const bank = makeNotchBank(actx);
  T(bank.engage(3000, 1000) === 'add' && bank.active().length === 1, '确认后占一个陷波位');
  T(Math.abs(bank.filters[0].frequency.value - 3000) < 1 && bank.filters[0].gain.value < -10,
    `陷波挖在啸叫频率上（${bank.filters[0].frequency.value}Hz / ${bank.filters[0].gain.value}dB）`);
  const d1 = bank.filters[0].gain.value;
  T(bank.engage(3010, 1100) === 'deepen' && bank.filters[0].gain.value < d1,
    `同一处再叫就加深，不另占坑（${d1} → ${bank.filters[0].gain.value}dB）`);
  bank.engage(500, 1200); bank.engage(800, 1300); bank.engage(1600, 1400);
  T(bank.active().length === 4, `陷波器数量封顶（${bank.active().length} 个）`);
  bank.engage(2400, 1500);
  T(bank.active().length === 4 && !bank.active().some((h) => Math.abs(h - 3000) < 30),
    '位子满了顶掉最久没复发的那个');
  bank.release(99999999);
  T(bank.active().length === 0, '久不复发的坑要填回去，别把声音掏空');

  // —— 兜底：陷波按不住就临时把外放掐小 ——
  let spec = spectrum([[3000, -20]]);
  const duck = actx.createGain();
  const g = { actx, howl: {
    analyser: { getFloatFrequencyData(a) { a.set(spec); } },
    spec: new Float32Array(2048), bank: makeNotchBank(actx), duck,
    tracker: makeHowlTracker(), binHz: BIN_HZ, hits: [], ducked: false, lastAt: 0, raf: 0,
  } };
  let t = 0;
  for (let i = 0; i < 6; i++) howlTick(g, (t += 16));
  T(g.howl.bank.active().length === 1 && !g.howl.ducked, '第一次啸叫只挖坑，不动音量');
  for (let i = 0; i < 6; i++) howlTick(g, (t += 16));
  T(g.howl.ducked && duck.gain.value < 0.5, `同一段时间内反复啸叫才掐外放（增益 ${duck.gain.value}）`);
  spec = new Float32Array(2048).fill(-120);
  howlTick(g, (t += 16));
  T(g.howl.ducked, '刚安静一瞬不急着放开');
  howlTick(g, (t += 2000));
  T(!g.howl.ducked && duck.gain.value === 1, `安静够久才慢慢还回音量（增益 ${duck.gain.value}）`);

  // 不外放就没有环路，连测都不用测（省掉每帧一次 FFT）
  spec = spectrum([[3000, -20]]);
  g.howl.bank.reset(t);
  g.monitorGain = { gain: { value: 0 } };
  for (let i = 0; i < 20; i++) howlTick(g, (t += 16));
  T(g.howl.bank.active().length === 0, '关掉麦克风外放后不再判定啸叫');
}

// 不要手动派发 DOMContentLoaded：jsdom 自己会在构造后异步派发一次，
// 再补一次会让 init 跑两遍、事件监听翻倍，把「点一次算两次」这种
// 脚手架假象误当成应用 bug。

setTimeout(() => {
  const $ = (s) => w.document.querySelector(s);
  const $$ = (s) => [...w.document.querySelectorAll(s)];
  const out = [];
  let fails = 0;
  const T = (c, n) => { out.push((c ? '  ✓ ' : '  ✗ ') + n); if (!c) fails++; };

  T($$('.song-row').length === 5, `默认渲染高密度列表（${$$('.song-row').length} 行，期望 5）`);
  T($('#songList').classList.contains('hidden') === false, '列表可见');
  T($('#grid').classList.contains('hidden'), '封面墙默认隐藏');
  T($$('.lang-btn').length >= 3, `语种筛选条有按钮（${$$('.lang-btn').length} 个）`);
  T($$('.lang-btn').some(b => b.textContent.includes('粤语')), '识别出粤语');
  T($$('.lang-btn').some(b => b.textContent.includes('国语')), '识别出国语');
  T($('#adminBadge').textContent === '1', `后台角标显示待处理数（${$('#adminBadge').textContent}）`);

  howlTests(T);

  // 点歌
  plays.length = 0;
  $$('.song-row')[0].querySelector('.sr-pick').dispatchEvent(new w.Event('click', {bubbles:true}));
  return void setTimeout(() => {
    T(plays.includes('instAudio'), `点歌后自动起播，无需再按 ▶（play 调用：${plays.join(',') || '无'}）`);
    T(w.document.querySelector('#nowbar').classList.contains('hidden') === false, '点歌后常驻控制条出现');
    T($('#nbTitle').textContent === '稻香', `控制条显示歌名（${$('#nbTitle').textContent}）`);
    T($('#modeInst').classList.contains('active'), '默认伴唱模式');
    T($('#vocalVol').value === '0', '伴唱模式下导唱人声为 0');
    T($('#monitor').checked === false, '麦克风授权失败后自动取消勾选（不弹窗）');

    // 原唱切换
    $('#modeOrig').dispatchEvent(new w.Event('click', {bubbles:true}));
    T($('#vocalVol').value === '100', '切原唱后导唱人声拉满');
    $('#modeInst').dispatchEvent(new w.Event('click', {bubbles:true}));

    // 播放中回到曲库，歌不能停
    $('#homeBtn').dispatchEvent(new w.Event('click', {bubbles:true}));
    T($('#browse').classList.contains('hidden') === false, '返回曲库后浏览区可见');
    T(!$('#nowbar').classList.contains('hidden'), '返回曲库后控制条仍在（歌没停）');
    T($('#instAudio').getAttribute('src') === '/m/i.mp3', '返回曲库后音轨仍在播放');

    // 边唱边点
    $$('.song-row')[1].querySelector('.sr-pick').dispatchEvent(new w.Event('click', {bubbles:true}));
    T($('#nbQueueCount').textContent === '1', `唱歌时继续点歌进入队列（${$('#nbQueueCount').textContent}）`);
    T($('#browse').classList.contains('hidden') === false, '点歌后没有被强制跳到歌词页');

    // 搜索：拼音首字母
    $('#search').value = 'dx';
    $('#search').dispatchEvent(new w.Event('input', {bubbles:true}));
    T($$('.song-row').length === 1 && $$('.song-row')[0].querySelector('.sr-title').textContent === '稻香',
      `拼音首字母 dx 搜到稻香（${$$('.song-row').length} 条）`);
    $('#search').value = '';
    $('#search').dispatchEvent(new w.Event('input', {bubbles:true}));

    // 繁简互通：曲库里是「海闊天空」，用户打简体的「海阔天空」也要搜得到
    $('#search').value = '海阔天空';
    $('#search').dispatchEvent(new w.Event('input', {bubbles:true}));
    T($$('.song-row').length === 1
        && $$('.song-row')[0].querySelector('.sr-title').textContent === '海闊天空',
      `简体关键词搜到繁体曲名（${$$('.song-row').length} 条）`);
    $('#search').value = '海闊天空';
    $('#search').dispatchEvent(new w.Event('input', {bubbles:true}));
    T($$('.song-row').length === 1, `繁体关键词照样搜得到（${$$('.song-row').length} 条）`);
    $('#search').value = '';
    $('#search').dispatchEvent(new w.Event('input', {bubbles:true}));

    // 无歌词的伴奏带要挂「无词」标记：能唱，但点之前得知道没字幕
    const rows = $$('.song-row');
    const noLrc = rows.filter((r) => r.querySelector('.sr-nolrc'));
    T(noLrc.length === 1 && noLrc[0].querySelector('.sr-title').textContent === '海闊天空',
      `没有歌词的歌挂上「无词」标记（${noLrc.length} 条）`);
    T(rows.find((r) => r.querySelector('.sr-title').textContent === '稻香')
        .querySelector('.sr-nolrc') === null,
      '有歌词的歌不挂「无词」标记');

    // 语种筛选
    const yue = $$('.lang-btn').find(b => b.textContent.includes('粤语'));
    yue.dispatchEvent(new w.Event('click', {bubbles:true}));
    T($$('.song-row').length === 1, `粤语筛选后剩 1 首（${$$('.song-row').length}）`);
    $$('.lang-btn')[0].dispatchEvent(new w.Event('click', {bubbles:true}));

    // 视图切换
    $('#viewToggle').dispatchEvent(new w.Event('click', {bubbles:true}));
    T($$('.song-card').length === 5, `切到封面墙（${$$('.song-card').length} 张卡）`);
    $('#viewToggle').dispatchEvent(new w.Event('click', {bubbles:true}));
    T($$('.song-row').length === 5, '切回文字列表');

    // 歌手页
    $$('.tab').find(t => t.dataset.tab === 'artist').dispatchEvent(new w.Event('click', {bubbles:true}));
    T($$('.artist-chip').length === 4, `按歌手分组（${$$('.artist-chip').length} 位）`);
    // 夢然 / 梦然 是同一位，必须合成一张卡片、两首歌，显示写法取占多数的那个
    const meng = $$('.artist-chip').filter((c) => /[夢梦]然/.test(c.textContent));
    T(meng.length === 1 && meng[0].querySelector('em').textContent === '2',
      `繁简两种写法的歌手合成一位（${meng.length} 张卡 / ${meng[0] && meng[0].querySelector('em').textContent} 首）`);
    meng[0].dispatchEvent(new w.Event('click', {bubbles:true}));
    T($$('.song-row').length === 2, `点进该歌手能看到两种写法下的歌（${$$('.song-row').length} 首）`);
    $$('.tab').find(t => t.dataset.tab === 'artist').dispatchEvent(new w.Event('click', {bubbles:true}));

    // 连唱：这首放完自动接队列里的下一首（KTV 的命根子）
    const before = $('#nbTitle').textContent;
    plays.length = 0;
    $('#instAudio').dispatchEvent(new w.Event('ended'));
    return void setTimeout(() => {
      T(plays.includes('instAudio'), `唱完自动接下一首（play 调用：${plays.join(',') || '无'}）`);
      T($('#nbTitle').textContent !== before,
        `控制条换成下一首（${before} → ${$('#nbTitle').textContent}）`);
      T($('#nbQueueCount').textContent === '0', `接歌后队列减一（${$('#nbQueueCount').textContent}）`);

      T(errs.length === 0, '运行期无 JS 报错' + (errs.length ? '：' + errs.join('; ') : ''));

      console.log('== 前端冒烟 ==');
      console.log(out.join('\n'));
      console.log(fails ? `\n✗ ${fails} 项失败` : '\n✓ 全部通过');
      process.exit(fails ? 1 : 0);
    }, 1100);
  }, 120);
}, 150);
