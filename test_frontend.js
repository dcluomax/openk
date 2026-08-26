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
  const node = () => ({ connect(){}, disconnect(){}, gain:{value:1}, buffer:null,
    threshold:{value:0}, knee:{value:0}, ratio:{value:0}, attack:{value:0}, release:{value:0} });
  return { state:'running', resume:()=>Promise.resolve(), destination:node(), sampleRate:48000,
    createGain:node, createConvolver:node, createDynamicsCompressor:node,
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

w.eval(fs.readFileSync(D + '/app.js', 'utf8'));
// 不要手动派发 DOMContentLoaded：jsdom 自己会在构造后异步派发一次，
// 再补一次会让 init 跑两遍、事件监听翻倍，把「点一次算两次」这种
// 脚手架假象误当成应用 bug。

setTimeout(() => {
  const $ = (s) => w.document.querySelector(s);
  const $$ = (s) => [...w.document.querySelectorAll(s)];
  const out = [];
  let fails = 0;
  const T = (c, n) => { out.push((c ? '  ✓ ' : '  ✗ ') + n); if (!c) fails++; };

  T($$('.song-row').length === 3, `默认渲染高密度列表（${$$('.song-row').length} 行，期望 3）`);
  T($('#songList').classList.contains('hidden') === false, '列表可见');
  T($('#grid').classList.contains('hidden'), '封面墙默认隐藏');
  T($$('.lang-btn').length >= 3, `语种筛选条有按钮（${$$('.lang-btn').length} 个）`);
  T($$('.lang-btn').some(b => b.textContent.includes('粤语')), '识别出粤语');
  T($$('.lang-btn').some(b => b.textContent.includes('国语')), '识别出国语');
  T($('#adminBadge').textContent === '1', `后台角标显示待处理数（${$('#adminBadge').textContent}）`);

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
    T($$('.song-card').length === 3, `切到封面墙（${$$('.song-card').length} 张卡）`);
    $('#viewToggle').dispatchEvent(new w.Event('click', {bubbles:true}));
    T($$('.song-row').length === 3, '切回文字列表');

    // 歌手页
    $$('.tab').find(t => t.dataset.tab === 'artist').dispatchEvent(new w.Event('click', {bubbles:true}));
    T($$('.artist-chip').length === 3, `按歌手分组（${$$('.artist-chip').length} 位）`);

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
