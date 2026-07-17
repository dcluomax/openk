'use strict';

/* ---------------- 工具 ---------------- */
const $ = (sel) => document.querySelector(sel);
const api = {
  async createJob(payload) {
    const r = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '创建任务失败');
    return r.json();
  },
  async listJobs() { const r = await fetch('/api/jobs'); return r.ok ? r.json() : []; },
  async getJob(id) { const r = await fetch('/api/jobs/' + id); if (!r.ok) throw new Error('任务不存在'); return r.json(); },
  async deleteJob(id) { await fetch('/api/jobs/' + id, { method: 'DELETE' }); },
  async retryJob(id) {
    const r = await fetch('/api/jobs/' + id + '/retry', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '重试失败');
    return r.json();
  },
  async updateLyrics(id, payload) {
    const r = await fetch('/api/jobs/' + id + '/lyrics', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '保存失败');
    return r.json();
  },
  async listRecordings(id) { const r = await fetch(`/api/jobs/${id}/recordings`); return r.ok ? r.json() : []; },
  async deleteRecording(id, file) { await fetch(`/api/jobs/${id}/recordings/${encodeURIComponent(file)}`, { method: 'DELETE' }); },
};

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return m + ':' + String(ss).padStart(2, '0');
};

/* ---------------- 全局状态 ---------------- */
const state = {
  currentJobId: null,
  pollTimer: null,
  listTimer: null,
  lyrics: null,      // { language, lines:[{start,end,text,words:[{text,start,end}]}] }
  lineEls: [],       // 每行的 DOM
  activeLine: -1,
  allJobs: [],       // 曲库缓存（用于前端搜索）
  search: '',
  editing: false,    // 歌词编辑态
  lyricsUrl: null,   // 当前歌词 json 地址（保存后重新拉取）
  audioGraph: null,  // Web Audio 图（混响/录制）
  recorder: null,
  recording: false,
  recTimer: null,
  recStart: 0,
  micStream: null,
};

/* ---------------- 新建任务 ---------------- */
async function onCreate() {
  const url = $('#url').value.trim();
  if (!url) { $('#url').focus(); return; }
  const btn = $('#go');
  btn.disabled = true; btn.textContent = '提交中…';
  try {
    const job = await api.createJob({
      url,
      language: $('#language').value || null,
      whisper_model: $('#model').value || null,
    });
    $('#url').value = '';
    await refreshList(true);
    selectJob(job.id);
  } catch (e) {
    alert(e.message || '提交失败');
  } finally {
    btn.disabled = false; btn.textContent = '开始制作';
  }
}

/* ---------------- 曲库列表 ---------------- */
let _listSig = '';
async function refreshList(force = false) {
  state.allJobs = await api.listJobs();
  renderJobs(force);
}

function renderJobs(force = false) {
  const kw = state.search.trim().toLowerCase();
  const jobs = kw
    ? state.allJobs.filter((j) => (j.title || j.url || '').toLowerCase().includes(kw))
    : state.allJobs;

  // 仅在数据真正变化时才重绘，避免定时刷新造成闪烁或打断点击。
  const sig = JSON.stringify([kw, jobs.map((j) => [j.id, j.state, j.progress, j.title, j.id === state.currentJobId])]);
  if (!force && sig === _listSig) return;
  _listSig = sig;

  const ul = $('#jobList');
  ul.innerHTML = '';
  const empty = $('#jobsEmpty');
  if (state.allJobs.length === 0) {
    empty.textContent = '还没有任务，粘贴链接开始吧。'; empty.classList.remove('hidden');
  } else if (jobs.length === 0) {
    empty.textContent = '未找到匹配的歌曲。'; empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }

  const stateText = { queued: '排队中', running: '处理中', done: '已完成', error: '失败' };
  for (const j of jobs) {
    const li = document.createElement('li');
    li.className = 'job-item' + (j.id === state.currentJobId ? ' active' : '');
    const recBadge = (j.recordings && j.recordings.length)
      ? `<span class="rec-badge" title="已录唱">🎤${j.recordings.length}</span>` : '';
    const retryBtn = j.state === 'error'
      ? '<button class="retry" title="重试下载/处理">↻</button>' : '';
    li.innerHTML = `
      <span class="dot ${j.state}"></span>
      <div class="jt">
        <div class="name">${escapeHtml(j.title || j.url)}</div>
        <div class="st">${stateText[j.state] || j.state} · ${j.progress || 0}%</div>
      </div>
      ${recBadge}
      ${retryBtn}
      <button class="del" title="删除">✕</button>`;
    li.querySelector('.jt').addEventListener('click', () => selectJob(j.id));
    li.querySelector('.dot').addEventListener('click', () => selectJob(j.id));
    const retryEl = li.querySelector('.retry');
    if (retryEl) {
      retryEl.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try { await api.retryJob(j.id); selectJob(j.id); refreshList(true); }
        catch (e) { alert(e.message || '重试失败'); }
      });
    }
    li.querySelector('.del').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('删除该任务及其文件（包括录音）？')) return;
      await api.deleteJob(j.id);
      if (state.currentJobId === j.id) resetStage();
      refreshList(true);
    });
    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 选择任务 ---------------- */
async function selectJob(id) {
  state.currentJobId = id;
  stopPolling();
  refreshList();
  let job;
  try { job = await api.getJob(id); } catch { resetStage(); return; }
  if (job.state === 'done') {
    showPlayer(job);
  } else {
    showProgress(job);
    startPolling(id);
  }
}

function resetStage() {
  state.currentJobId = null;
  stopPolling();
  $('#player').classList.add('hidden');
  $('#progressPanel').classList.add('hidden');
  $('#emptyStage').classList.remove('hidden');
  stopAudio();
}

/* ---------------- 进度轮询 ---------------- */
function startPolling(id) {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    let job;
    try { job = await api.getJob(id); } catch { return; }
    updateProgressUI(job);
    refreshList();
    if (job.state === 'done') { stopPolling(); showPlayer(job); }
    else if (job.state === 'error') { stopPolling(); }
  }, 1200);
}
function stopPolling() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }

function showProgress(job) {
  $('#emptyStage').classList.add('hidden');
  $('#player').classList.add('hidden');
  $('#progressPanel').classList.remove('hidden');
  updateProgressUI(job);
}

function updateProgressUI(job) {
  $('#progTitle').textContent = job.title || '处理中…';
  $('#progMessage').textContent = job.message || '';
  $('#progBar').style.width = (job.progress || 0) + '%';
  $('#progPct').textContent = (job.progress || 0) + '%';
  const thumb = $('#progThumb');
  if (job.thumbnail) { thumb.src = job.thumbnail; thumb.style.display = ''; }
  else { thumb.style.display = 'none'; }

  const order = ['download', 'separate', 'transcribe'];
  const cur = order.indexOf(job.step);
  document.querySelectorAll('.step').forEach((el) => {
    const idx = order.indexOf(el.dataset.step);
    el.classList.remove('active', 'done');
    if (job.step === 'done' || (cur >= 0 && idx < cur)) el.classList.add('done');
    else if (idx === cur) el.classList.add('active');
  });

  const errEl = $('#progError');
  if (job.state === 'error') {
    errEl.classList.remove('hidden');
    errEl.textContent = '❌ ' + (job.error || '处理失败');
  } else {
    errEl.classList.add('hidden');
  }
}

/* ---------------- 卡拉OK 播放器 ---------------- */
const inst = $('#instAudio');
const vocal = $('#vocalAudio');

async function showPlayer(job) {
  $('#emptyStage').classList.add('hidden');
  $('#progressPanel').classList.add('hidden');
  $('#player').classList.remove('hidden');

  $('#playerTitle').textContent = job.title || '未命名';
  const link = $('#sourceLink');
  if (job.webpage_url) { link.href = job.webpage_url; link.style.display = ''; }
  else { link.style.display = 'none'; }

  // 载入音轨
  stopAudio();
  inst.src = job.media?.instrumental || '';
  if (job.media?.vocals) {
    vocal.src = job.media.vocals;
    document.querySelector('label.mix:nth-child(2)').style.display = '';
  } else {
    vocal.removeAttribute('src');
    document.querySelector('label.mix:nth-child(2)').style.display = 'none';
  }
  applyVolumes();

  // 录音状态重置 + 载入该歌的历史录音
  $('#recStatus').textContent = '';
  $('#recBtn').textContent = '🎤 开始录唱';
  $('#recBtn').classList.remove('recording');
  loadRecordings(job.id);

  // 载入歌词
  state.lyrics = null; state.lineEls = []; state.activeLine = -1;
  state.lyricsUrl = job.media?.lyrics || null;
  state.editing = false;
  $('#editBar').classList.add('hidden');
  $('#editLyrics').classList.add('hidden');
  const box = $('#lyrics');
  box.innerHTML = '<p class="muted" style="text-align:center">正在载入歌词…</p>';
  try {
    const r = await fetch(job.media.lyrics + '?t=' + Date.now());
    state.lyrics = await r.json();
    // 显示歌词来源徽章
    const badge = $('#lyricSource');
    const src = state.lyrics.source;
    if (src) { badge.textContent = '歌词来源：' + src; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
    renderLyrics();
  } catch {
    box.innerHTML = '<p class="muted" style="text-align:center">未能载入歌词。</p>';
  }
}

function renderLyrics() {
  const box = $('#lyrics');
  box.innerHTML = '';
  state.lineEls = [];
  const lines = state.lyrics?.lines || [];
  if (lines.length === 0) {
    box.innerHTML = '<p class="muted" style="text-align:center">这首歌似乎没有可识别的人声歌词。</p>';
    return;
  }
  lines.forEach((ln, i) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    if (ln.words && ln.words.length) {
      ln.words.forEach((w) => {
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = w.text + ' ';
        span.dataset.start = w.start;
        div.appendChild(span);
      });
    } else {
      div.textContent = ln.text;
    }
    div.addEventListener('click', () => seekTo(ln.start + 0.001));
    box.appendChild(div);
    state.lineEls.push(div);
  });
  $('#editLyrics').classList.toggle('hidden', !(state.lyrics?.lines?.length) || state.editing);
}

/* ---------- 歌词编辑（识别不准时手动纠正） ---------- */
function enterLyricsEdit() {
  const lines = state.lyrics?.lines || [];
  if (!lines.length) return;
  state.editing = true;
  const box = $('#lyrics');
  box.innerHTML = '';
  state.lineEls = [];
  lines.forEach((ln, i) => {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'lyric-edit';
    inp.value = ln.text || '';
    inp.dataset.i = i;
    box.appendChild(inp);
  });
  $('#editBar').classList.remove('hidden');
  $('#editLyrics').classList.add('hidden');
}

function exitLyricsEdit() {
  state.editing = false;
  $('#editBar').classList.add('hidden');
  renderLyrics();
}

async function saveLyricsEdit() {
  if (!state.editing || !state.lyrics) return;
  const inputs = $('#lyrics').querySelectorAll('.lyric-edit');
  const lines = (state.lyrics.lines || []).map((ln, i) => ({
    start: ln.start, end: ln.end,
    text: (inputs[i] ? inputs[i].value : ln.text || '').trim(),
    words: ln.words || [],
  })).filter((ln) => ln.text);
  const btn = $('#saveLyrics');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    await api.updateLyrics(state.currentJobId, {
      lines, language: state.lyrics.language, source: state.lyrics.source,
    });
    const url = (state.lyricsUrl || `/media/${state.currentJobId}/lyrics.json`) + '?t=' + Date.now();
    state.lyrics = await (await fetch(url)).json();
    const badge = $('#lyricSource');
    if (state.lyrics.source) { badge.textContent = '歌词来源：' + state.lyrics.source; badge.classList.remove('hidden'); }
    state.editing = false;
    $('#editBar').classList.add('hidden');
    renderLyrics();
    refreshList(true);
  } catch (e) {
    alert(e.message || '保存失败');
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
}

function updateLyrics(t) {
  if (state.editing) return;
  const lines = state.lyrics?.lines;
  if (!lines || !lines.length) return;

  // 找当前行：最后一个 start <= t 的行
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start <= t + 0.02) idx = i; else break;
  }

  if (idx !== state.activeLine) {
    if (state.activeLine >= 0 && state.lineEls[state.activeLine])
      state.lineEls[state.activeLine].classList.remove('active');
    if (idx >= 0 && state.lineEls[idx]) {
      const el = state.lineEls[idx];
      el.classList.add('active');
      const box = $('#lyrics');
      // 用 scrollTo({behavior:'auto'}) 显式滚动：直接赋值 scrollTop 在
      // CSS scroll-behavior:smooth（或 prefers-reduced-motion）下可能被忽略而不滚动。
      box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'auto' });
    }
    state.activeLine = idx;
  }

  // 逐词高亮当前行
  if (idx >= 0) {
    const el = state.lineEls[idx];
    const spans = el.getElementsByClassName('w');
    for (let k = 0; k < spans.length; k++) {
      const st = parseFloat(spans[k].dataset.start);
      spans[k].classList.toggle('sung', st <= t);
    }
  }
}

/* ---------- Web Audio 引擎（混响 / 录制） ---------- */
const REVERB_PRESETS = {
  none:   { seconds: 0.10, decay: 1.0, wet: 0.00, send: 0.0 },
  room:   { seconds: 0.60, decay: 2.0, wet: 0.22, send: 0.5 },
  ktv:    { seconds: 1.10, decay: 2.2, wet: 0.32, send: 0.7 },
  hall:   { seconds: 1.90, decay: 2.6, wet: 0.40, send: 0.75 },
  church: { seconds: 3.20, decay: 3.0, wet: 0.50, send: 0.85 },
};

// 耳机监听增益：略高于 1，让戴耳机时能清楚听到自己与混响尾音（伴奏走耳机不会啸叫）。
// 只作用于监听支路，不影响录音总线的电平，避免录音文件削幅。
const MONITOR_GAIN = 1.8;

function makeIR(actx, seconds, decay) {
  const rate = actx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = actx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function hasVocal() { return !!vocal.getAttribute('src'); }

// 懒初始化音频图（需在用户手势内调用，如首次播放/录制）。
function ensureAudioGraph() {
  if (state.audioGraph) return state.audioGraph;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const actx = new Ctx();
  const instGain = actx.createGain();
  const vocalGain = actx.createGain();
  const dry = actx.createGain();
  const wet = actx.createGain();
  const conv = actx.createConvolver();
  const send = actx.createGain();
  const speakerBus = actx.createGain();   // → 扬声器
  const recordBus = actx.createGain();    // → 录音
  const recDest = actx.createMediaStreamDestination();

  actx.createMediaElementSource(inst).connect(instGain);
  actx.createMediaElementSource(vocal).connect(vocalGain);
  instGain.connect(dry);
  vocalGain.connect(dry);
  vocalGain.connect(send); send.connect(conv); conv.connect(wet);
  dry.connect(speakerBus); dry.connect(recordBus);
  wet.connect(speakerBus); wet.connect(recordBus);
  speakerBus.connect(actx.destination);
  recordBus.connect(recDest);

  state.audioGraph = {
    actx, instGain, vocalGain, dry, wet, conv, send,
    speakerBus, recordBus, recDest, mic: null, monitorGain: null,
  };
  setReverb($('#reverb').value);
  applyVolumes();
  return state.audioGraph;
}

function setReverb(name) {
  const g = state.audioGraph;
  if (!g) return;
  const p = REVERB_PRESETS[name] || REVERB_PRESETS.none;
  g.conv.buffer = makeIR(g.actx, p.seconds, p.decay);
  g.wet.gain.value = p.wet;
  g.send.gain.value = p.send;
  if (g.mic) {
    g.mic.micConv.buffer = makeIR(g.actx, p.seconds, p.decay);
    g.mic.micWet.gain.value = p.wet;
    g.mic.micSend.gain.value = p.send;
  }
}

/* ---------- 音量 / 播放控制 ---------- */
function applyVolumes() {
  const iv = ($('#instVol').value || 0) / 100;
  const vv = ($('#vocalVol').value || 0) / 100;
  const g = state.audioGraph;
  if (g) {
    // 图存在时媒体元素必须保持满音量：element.volume=0 会让
    // MediaElementSource 直接输出静音，导致导唱人声/混响再怎么调增益都没声。
    // 实际音量改由增益节点控制。
    inst.volume = 1; vocal.volume = 1;
    g.instGain.gain.value = iv; g.vocalGain.gain.value = vv;
  } else {
    inst.volume = iv; vocal.volume = vv;
  }
}

function togglePlay() {
  const g = ensureAudioGraph();
  if (g.actx.state === 'suspended') g.actx.resume();
  if (inst.paused) {
    inst.play();
    if (hasVocal()) { vocal.currentTime = inst.currentTime; vocal.play().catch(() => {}); }
  } else {
    inst.pause(); if (hasVocal()) vocal.pause();
  }
}

function seekTo(t) {
  inst.currentTime = t;
  if (hasVocal()) vocal.currentTime = t;
}

function stopAudio() {
  if (state.recording) stopRecording();
  $('#monitor').checked = false;
  cleanupMic();
  try { inst.pause(); vocal.pause(); } catch {}
  inst.removeAttribute('src'); vocal.removeAttribute('src');
  inst.load(); vocal.load();
  $('#playBtn').textContent = '▶';
}

/* ---------- 录制 / 回放 ---------- */
function pickRecorderOptions() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const t of cands) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return { mimeType: t };
  }
  return {};
}

// 建立麦克风支路（监听/录音共用，仅建一次）。需在用户手势内调用以取得授权。
async function ensureMic() {
  const g = ensureAudioGraph();
  if (g.mic) return g;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('当前浏览器不支持麦克风'); throw new Error('no mic');
  }
  if (g.actx.state === 'suspended') await g.actx.resume();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // 卡拉OK 要「原始人声」：关掉回声消除 + 降噪。否则——
      //   · echoCancellation：伴奏一响，AEC 把伴奏当回声疯狂 ducking → 监听断断续续、很小；
      //   · noiseSuppression：噪声门限把人声也一起切掉 → “屏蔽了很多声音”。
      // 前提是戴耳机（伴奏走耳机、不串入麦克风），所以本就不需要回声消除。
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) { alert('无法获取麦克风权限：' + (e.message || e)); throw e; }
  state.micStream = stream;

  // 麦克风支路：始终进「录音总线」；勾选“耳机监听”后经 monitorGain 进扬声器（建议戴耳机防啸叫）。
  const micSrc = g.actx.createMediaStreamSource(stream);
  const micGain = g.actx.createGain();
  const micDry = g.actx.createGain();
  const micSend = g.actx.createGain();
  const micConv = g.actx.createConvolver();
  const micWet = g.actx.createGain();
  const monitorGain = g.actx.createGain();
  monitorGain.gain.value = $('#monitor').checked ? MONITOR_GAIN : 0;

  micSrc.connect(micGain);
  micGain.connect(micDry); micDry.connect(g.recordBus);
  micGain.connect(micSend); micSend.connect(micConv); micConv.connect(micWet); micWet.connect(g.recordBus);
  micDry.connect(monitorGain); micWet.connect(monitorGain); monitorGain.connect(g.speakerBus);

  g.mic = { micSrc, micGain, micDry, micSend, micConv, micWet };
  g.monitorGain = monitorGain;
  const p = REVERB_PRESETS[$('#reverb').value] || REVERB_PRESETS.none;
  micConv.buffer = makeIR(g.actx, p.seconds, p.decay);
  micWet.gain.value = p.wet; micSend.gain.value = p.send;
  return g;
}

// 仅在既不监听也不录音时释放麦克风。
function maybeReleaseMic() {
  if (state.recording || $('#monitor').checked) return;
  cleanupMic();
}

async function startRecording() {
  if (!inst.getAttribute('src')) { alert('请先选择一首歌'); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { alert('当前浏览器不支持录音'); return; }
  const g = ensureAudioGraph();
  try { await ensureMic(); } catch { return; }

  const mr = new MediaRecorder(g.recDest.stream, pickRecorderOptions());
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = async () => {
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
    const dur = (Date.now() - state.recStart) / 1000;
    await uploadRecording(blob, dur);
    maybeReleaseMic();
  };
  state.recorder = mr;
  state.recStart = Date.now();
  state.recording = true;
  mr.start();

  // 从头播放伴奏（+按滑块的导唱人声）
  seekTo(0);
  inst.play(); if (hasVocal()) { vocal.currentTime = 0; vocal.play().catch(() => {}); }

  $('#recBtn').textContent = '⏹ 停止并保存';
  $('#recBtn').classList.add('recording');
  state.recTimer = setInterval(() => {
    $('#recStatus').textContent = '● 录制中 ' + fmt((Date.now() - state.recStart) / 1000);
  }, 250);
}

function stopRecording() {
  if (!state.recorder || !state.recording) return;
  state.recording = false;
  clearInterval(state.recTimer);
  try { inst.pause(); if (hasVocal()) vocal.pause(); } catch {}
  try { state.recorder.stop(); } catch {}
  $('#recBtn').textContent = '🎤 开始录唱';
  $('#recBtn').classList.remove('recording');
  $('#recStatus').textContent = '正在保存…';
  $('#playBtn').textContent = '▶';
}

function cleanupMic() {
  const g = state.audioGraph;
  if (state.micStream) { state.micStream.getTracks().forEach((t) => t.stop()); state.micStream = null; }
  if (g && g.mic) {
    try { Object.values(g.mic).forEach((n) => n.disconnect && n.disconnect()); } catch {}
    g.mic = null;
  }
  if (g && g.monitorGain) { try { g.monitorGain.disconnect(); } catch {} g.monitorGain = null; }
}

async function uploadRecording(blob, dur) {
  if (!state.currentJobId) return;
  try {
    await fetch(`/api/jobs/${state.currentJobId}/recordings?duration=${dur.toFixed(1)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });
    $('#recStatus').textContent = '已保存 ✓';
    loadRecordings(state.currentJobId);
    refreshList(true);
  } catch (e) {
    $('#recStatus').textContent = '保存失败';
  }
}

async function loadRecordings(jobId) {
  let recs = [];
  try { recs = await api.listRecordings(jobId); } catch { recs = []; }
  renderRecordings(recs);
}

function renderRecordings(recs) {
  const wrap = $('#recListWrap');
  const ul = $('#recList');
  ul.innerHTML = '';
  if (!recs || !recs.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  recs.slice().reverse().forEach((r) => {
    const li = document.createElement('li');
    const when = r.created_at ? new Date(r.created_at * 1000).toLocaleString() : '';
    li.innerHTML = `
      <audio controls preload="none" src="${r.url}"></audio>
      <div class="rec-meta">
        <span>${when}</span>
        <span class="muted small">${r.duration ? fmt(r.duration) : ''}</span>
      </div>
      <a class="dl" href="${r.url}" download title="下载">⬇</a>
      <button class="rdel" title="删除">✕</button>`;
    li.querySelector('.rdel').addEventListener('click', async () => {
      if (!confirm('删除这条录音？')) return;
      await api.deleteRecording(state.currentJobId, r.file);
      loadRecordings(state.currentJobId);
      refreshList(true);
    });
    ul.appendChild(li);
  });
}

/* ---------- 播放器事件绑定 ---------- */
function bindPlayer() {
  $('#playBtn').addEventListener('click', togglePlay);

  inst.addEventListener('play', () => { $('#playBtn').textContent = '⏸'; });
  inst.addEventListener('pause', () => { $('#playBtn').textContent = '▶'; });
  inst.addEventListener('loadedmetadata', () => { $('#durTime').textContent = fmt(inst.duration); });
  inst.addEventListener('ended', () => {
    $('#playBtn').textContent = '▶';
    if (vocal.src) vocal.pause();
  });

  inst.addEventListener('timeupdate', () => {
    const t = inst.currentTime;
    $('#curTime').textContent = fmt(t);
    if (inst.duration) $('#seek').value = Math.round((t / inst.duration) * 1000);
    // 纠正双轨漂移
    if (vocal.src && !vocal.paused && Math.abs(vocal.currentTime - t) > 0.25) {
      vocal.currentTime = t;
    }
    updateLyrics(t);
  });

  $('#seek').addEventListener('input', (e) => {
    if (!inst.duration) return;
    const t = (e.target.value / 1000) * inst.duration;
    seekTo(t);
    $('#curTime').textContent = fmt(t);
    updateLyrics(t);
  });

  $('#instVol').addEventListener('input', applyVolumes);
  $('#vocalVol').addEventListener('input', applyVolumes);
  $('#reverb').addEventListener('change', () => setReverb($('#reverb').value));
  $('#editLyrics').addEventListener('click', enterLyricsEdit);
  $('#saveLyrics').addEventListener('click', saveLyricsEdit);
  $('#cancelLyrics').addEventListener('click', exitLyricsEdit);
  $('#recBtn').addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
  $('#monitor').addEventListener('change', async () => {
    const on = $('#monitor').checked;
    if (on) {
      // 勾选即请求麦克风并接入监听，无需先点“开始录唱”。
      try { await ensureMic(); } catch { $('#monitor').checked = false; return; }
    }
    const g = state.audioGraph;
    if (g && g.monitorGain) g.monitorGain.gain.value = on ? MONITOR_GAIN : 0;
    if (!on) maybeReleaseMic();
  });

  // 空格键播放/暂停
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !$('#player').classList.contains('hidden') &&
        document.activeElement.tagName !== 'INPUT') {
      e.preventDefault(); togglePlay();
    }
  });
}

/* ---------------- 初始化 ---------------- */
function init() {
  $('#go').addEventListener('click', onCreate);
  $('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') onCreate(); });
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderJobs(true); });
  bindPlayer();
  refreshList();
  // 后台自适应刷新列表：有运行中任务时 3s，全部空闲时放慢到 15s；
  // 页面不可见、或正在逐帧轮询单个任务时跳过，避免无谓请求刷屏。
  const scheduleListRefresh = () => {
    const busy = state.allJobs.some((j) => j.state === 'running' || j.state === 'queued');
    state.listTimer = setTimeout(async () => {
      if (!state.pollTimer && !document.hidden) await refreshList();
      scheduleListRefresh();
    }, busy ? 3000 : 15000);
  };
  scheduleListRefresh();
}

document.addEventListener('DOMContentLoaded', init);
