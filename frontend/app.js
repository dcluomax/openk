'use strict';

/* ---------------- 工具 ---------------- */
const $ = (sel) => document.querySelector(sel);
async function fetchResponse(url, options = {}, timeout = 20000, consume = null) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeout);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    return consume ? await consume(r) : r;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
async function responseJSON(r) {
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw Object.assign(new Error(detail.detail || `请求失败（HTTP ${r.status}）`), { status: r.status });
  }
  return r.json();
}
const fetchJSON = (url, options) => fetchResponse(url, options, 20000, responseJSON);
function bounded(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}
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
  listJobs(options = {}) { return fetchJSON('/api/jobs', { cache: 'no-cache', ...options }); },
  getJob(id, options = {}) { return fetchJSON('/api/jobs/' + encodeURIComponent(id), { cache: 'no-cache', ...options }); },
  async deleteJob(id) {
    const r = await fetchResponse('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) throw new Error(`删除失败（HTTP ${r.status}）`);
  },
  async retryJob(id, payload) {
    const r = await fetch('/api/jobs/' + id + '/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '重试失败');
    return r.json();
  },
  async searchLyrics(params) {
    const r = await fetch('/api/lyrics/search?' + new URLSearchParams(params).toString());
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '搜索失败');
    return r.json();
  },
  async alignLyrics(id, payload) {
    return fetchResponse(`/api/jobs/${id}/lyrics/align`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 20000, async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '对齐失败');
      return { accepted: r.status === 202, data: await r.json() };
    });
  },
  getOperation(id, options) { return fetchJSON('/api/operations/' + encodeURIComponent(id), options); },
  async updateLyrics(id, payload) {
    const r = await fetch('/api/jobs/' + id + '/lyrics', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '保存失败');
    return r.json();
  },
  listRecordings(id, options) { return fetchJSON(`/api/jobs/${id}/recordings`, options); },
  async deleteRecording(id, file) {
    const r = await fetchResponse(`/api/jobs/${id}/recordings/${encodeURIComponent(file)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`删除失败（HTTP ${r.status}）`);
  },
  async previewPlaylist(payload) {
    const r = await fetch('/api/playlists/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '读取播放列表失败');
    return r.json();
  },
  async localStatus() {
    const r = await fetch('/api/local/status');
    return r.ok ? r.json() : { enabled: false, roots: [] };
  },
  async scanLocal(payload) {
    const r = await fetch('/api/local/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '扫描本地目录失败');
    return r.json();
  },
  async importLocal(payload) {
    const r = await fetch('/api/local/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '导入失败');
    return r.json();
  },
  async importPlaylist(payload) {
    const r = await fetch('/api/playlists/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '导入失败');
    return r.json();
  },
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
  inspectedJobId: null,
  selectionGeneration: 0,
  selectionRequestGeneration: 0,
  selectionRequest: null,
  lyricsGeneration: 0,
  lyricsRequest: null,
  recordingsGeneration: 0,
  recordingsRequest: null,
  pollGeneration: 0,
  pollRequest: null,
  listRequest: null,
  listForce: false,
  endedTimer: null,
  lyricRaf: 0,
  lyricWords: [],
  activeWord: -2,
  micRequest: null,
  micGeneration: 0,
  monitorHidden: false,
  alignmentTimers: new Map(),
  alignmentRequests: new Map(),
  alignmentSubmitting: new Set(),
  alignmentOperations: {},
  recordingSession: null,
  recordingStarting: false,
  recordingStartGeneration: 0,
  pendingRecordings: new Map(),
  buffering: false,
  audioStatus: '',
  playbackGeneration: 0,
  playRequested: false,
  lastSyncAt: 0,
  disposed: false,
  pollTimer: null,
  listTimer: null,
  lyrics: null,      // { language, lines:[{start,end,text,words:[{text,start,end}]}] }
  lineEls: [],       // 每行的 DOM
  activeLine: -1,
  allJobs: [],       // 曲库缓存（用于前端搜索）
  search: '',
  editing: false,    // 歌词编辑态
  lyricsUrl: null,   // 当前歌词 json 地址（保存后重新拉取）
  currentTitle: '',  // 当前歌曲标题（用于搜歌词预填）
  libMode: 'all',    // 点歌台视图：all 全部 / artist 按歌手 / new 最新
  artistPick: null,  // 「按歌手」里点进了哪位歌手（存归一后的简体键）
  artistLabel: null, // 该歌手在曲库里的实际写法，用于标题显示
  view: 'list',      // 曲库呈现：list 文字列表（默认，找歌快）/ grid 封面墙
  lang: '',          // 语种筛选，空串表示全部
  singMode: 'inst',  // 伴唱 inst / 原唱 orig
  queue: [],         // 已点歌曲（存的是 job id，落 localStorage）
  audioGraph: null,  // Web Audio 图（混响/录制）
  recorder: null,
  recording: false,
  recTimer: null,
  recStart: 0,
  micStream: null,
  picker: null,      // 批量导入面板的当前数据（歌单或本地扫描结果）
  pickMode: 'playlist',
  plAsked: false,    // 本次输入是否已问过「要不要批量导入」
};

/* ---------------- 新建任务 ---------------- */
async function onCreate() {
  const url = $('#url').value.trim();
  if (!url) { $('#url').focus(); return; }
  // 从歌单里点开某首歌复制出来的链接会带 list= 参数，用户往往并没意识到。
  // 直接按单曲处理会漏掉整个歌单，先问一句最省事。
  if (isPlaylistUrl(url) && !state.plAsked) {
    state.plAsked = true;
    if (confirm('这个链接里带着一个播放列表。要批量导入整个歌单吗？\n（点「取消」则只做当前这一首）')) {
      openPlaylist();
      return;
    }
  }
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

/* ---------------- 批量导入（播放列表 / 本地文件共用一套选择面板）---------------- */
const PL_STATUS = {
  new: ['可导入', 'new'],
  failed: ['上次失败·可重来', 'failed'],
  done: ['曲库已有', 'done'],
  pending: ['队列中', ''],
  too_long: ['超长·跳过', ''],
  unavailable: ['已失效', ''],
};

function isPlaylistUrl(url) {
  const m = /[?&]list=([0-9A-Za-z_-]+)/.exec(url || '');
  // RD/UL/LL/WL 开头的是 YouTube 自动生成的电台或稍后观看，摊平没有意义。
  return !!m && !/^(RD|UL|LL|WL)/.test(m[1]);
}

// 两种来源的「一条记录」用不同字段做标识：歌单用视频 ID，本地用文件路径。
const entryKey = (e) => (state.pickMode === 'local' ? e.path : e.video_id);

function openPanel(titleText) {
  $('#plPanel').classList.remove('hidden');
  $('#plList').innerHTML = '';
  $('#plTitle').textContent = titleText;
  $('#plCount').textContent = '';
  $('#plHint').textContent = '';
}

async function openPlaylist() {
  const url = $('#url').value.trim();
  if (!url) { $('#url').focus(); return; }
  const btn = $('#plGo');
  btn.disabled = true; btn.textContent = '读取中…';
  state.pickMode = 'playlist';
  openPanel('正在读取播放列表…');
  try {
    const data = await api.previewPlaylist({ url });
    state.picker = data;
    renderPicker(data);
  } catch (e) {
    $('#plTitle').textContent = '读取失败';
    $('#plHint').textContent = e.message || '读取播放列表失败';
  } finally {
    btn.disabled = false; btn.textContent = '🎵 导入歌单';
  }
}

async function openLocal() {
  const btn = $('#lcGo');
  btn.disabled = true; btn.textContent = '扫描中…';
  state.pickMode = 'local';
  openPanel('正在扫描本地媒体目录…');
  try {
    const data = await api.scanLocal({});
    state.picker = data;
    renderPicker(data);
  } catch (e) {
    $('#plTitle').textContent = '扫描失败';
    $('#plHint').textContent = e.message || '扫描本地目录失败';
  } finally {
    btn.disabled = false; btn.textContent = '📁 本地文件';
  }
}

function renderPicker(data) {
  const local = state.pickMode === 'local';
  $('#plTitle').textContent = local
    ? `本地媒体（${(data.roots || []).join('、')}）`
    : (data.title || '播放列表');
  $('#plCount').textContent = `共 ${data.total} 首 · ${data.importable} 首可导入`;

  const notes = [];
  if (data.note) notes.push(data.note);
  if (data.truncated) {
    notes.push(local
      ? `目录里还有更多文件，这里只列出前 ${data.limit} 个（可调 OPENK_LOCAL_MEDIA_MAX_ITEMS）`
      : `歌单更长，这里只列出前 ${data.limit} 首（可调 OPENK_PLAYLIST_MAX_ITEMS）`);
  }
  if (data.importable === 0) notes.push('没有需要新建的歌曲——这些已经全部处理过了。');
  else notes.push('默认勾选了还没做过的歌；取消勾选可以跳过。');
  $('#plHint').textContent = notes.join(' ');

  const ul = $('#plList');
  ul.innerHTML = '';
  data.entries.forEach((e) => {
    const [text, cls] = PL_STATUS[e.status] || [e.status, ''];
    const li = document.createElement('li');
    if (!e.importable) li.classList.add('off');
    li.innerHTML = `
      <input type="checkbox" class="pl-pick"
             ${e.importable ? 'checked' : ''} ${e.importable ? '' : 'disabled'} />
      <div class="pl-info"><div class="pl-name"></div></div>
      <span class="pl-dur"></span>
      <span class="pl-tag ${cls}">${text}</span>`;
    // 标题与路径都来自外部数据，一律用 textContent / dataset 赋值，不拼进 HTML。
    li.querySelector('.pl-pick').dataset.key = entryKey(e);
    li.querySelector('.pl-name').textContent = e.title || e.path || e.video_id || '(未知曲目)';
    li.querySelector('.pl-dur').textContent = e.duration ? fmt(e.duration) : '';
    ul.appendChild(li);
  });
  syncPlAll();
}

function pickedKeys() {
  return Array.from(document.querySelectorAll('.pl-pick:checked')).map((c) => c.dataset.key);
}

function syncPlAll() {
  const boxes = Array.from(document.querySelectorAll('.pl-pick:not(:disabled)'));
  const all = $('#plAll');
  all.disabled = boxes.length === 0;
  all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
}

async function onPickerImport() {
  const data = state.picker;
  if (!data) return;
  const keys = pickedKeys();
  if (!keys.length) { alert('没有勾选任何歌曲'); return; }
  const local = state.pickMode === 'local';
  // 分离加识别是按分钟计的重活，几百首要跑很久，先说清楚再动手。
  if (keys.length > 20 &&
      !confirm(`要导入 ${keys.length} 首。分离和识别都很吃算力，会按顺序逐首处理，`
               + `整批可能要跑很久（服务重启后会自动接着跑）。继续吗？`)) {
    return;
  }
  const btn = $('#plImport');
  btn.disabled = true; btn.textContent = '导入中…';
  try {
    const payload = {
      language: $('#language').value || null,
      whisper_model: $('#model').value || null,
    };
    const res = local
      ? await api.importLocal({ ...payload, paths: keys })
      : await api.importPlaylist({
        ...payload,
        url: `https://www.youtube.com/playlist?list=${data.playlist_id}`,
        video_ids: keys,
      });
    $('#plPanel').classList.add('hidden');
    if (!local) { $('#url').value = ''; state.plAsked = false; }
    await refreshList(true);
    const skipped = res.skipped_count ? `，跳过 ${res.skipped_count} 首` : '';
    alert(`已加入队列 ${res.created_count} 首${skipped}。`);
  } catch (e) {
    alert(e.message || '导入失败');
  } finally {
    btn.disabled = false; btn.textContent = '导入选中';
  }
}

const { pyCollator, initialsOf } = OpenKSearch;
const librarySearch = OpenKSearch.create();

/* ---------------- 曲库 ---------------- */
const STATE_TEXT = { queued: '排队中', running: '处理中', done: '已完成', error: '失败' };
let _browseSig = '';

/* 语种：曲库里的标题大多自带 (國語)/(粵語)/(日語) 这类标记，直接拿来用，
 * 比让 whisper 猜语言可靠得多（它把不少中文歌识别成了 en）。认不出就归「其他」。 */
const LANG_TAGS = [
  [/粤语|粵語|廣東話|广东话|cantonese/i, '粤语'],
  [/国语|國語|普通话|普通話|华语|華語|mandarin/i, '国语'],
  [/日语|日語|japanese|j-?pop/i, '日语'],
  [/韩语|韓語|korean|k-?pop/i, '韩语'],
  [/闽南|閩南|台语|台語|hokkien/i, '闽南语'],
];
function guessLang(j) {
  const raw = j.title || '';
  for (const [re, name] of LANG_TAGS) if (re.test(raw)) return name;
  // 没有标记时用字符构成兜底：整条标题没有汉字就当英文歌
  const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk === 0 && /[a-zA-Z]/.test(raw)) return '英语';
  if (cjk > 0) return '国语';
  return '其他';
}

/** 全量单字表也能把「繁体输入 / 纯简体曲库」折成同一写法。 */
const zh = { map: null, version: 0 };

async function loadZhMap() {
  try {
    const r = await fetch('/api/zh-map');
    if (r.ok) {
      zh.map = await r.json();
      zh.version++;
      librarySearch.setMap(zh.map);
      state.allJobs.forEach((j) => { delete j._si; });
    }
  } catch { /* 没有对照表也能搜，只是繁简不互通 */ }
}

/** 检索用的派生字段算一次就缓存在任务对象上：428 首歌逐字比对 collator 并不便宜。 */
function songInfo(j) {
  const key = JSON.stringify([j.track, j.title, j.artist, zh.version, j.search_index]);
  if (!j._si || j._siKey !== key) {
    j._siKey = key;
    const title = j.track || j.title || '未命名';
    const artist = j.artist || '';
    j._si = {
      title, artist,
      lang: guessLang(j),
      chars: (title.match(/[\u4e00-\u9fff]/g) || []).length,   // 字数检索用
      letter: (initialsOf(artist || title)[0] || '#'),
    };
  }
  return j._si;
}

async function refreshList(force = false) {
  if (state.disposed) return;
  state.listForce ||= force;
  if (state.listRequest) return state.listRequest;
  state.listRequest = (async () => {
    try {
      const jobs = await api.listJobs();
      if (!Array.isArray(jobs)) throw new Error('曲库响应格式不正确');
      if (state.disposed) return;
      const prev = new Map(state.allJobs.map((j) => [j.id, j]));
      jobs.forEach((j) => {
        const old = prev.get(j.id);
        if (old) { j._si = old._si; j._siKey = old._siKey; }
      });
      state.allJobs = jobs;
      $('#catalogStatus').textContent = '';
      $('#catalogStatus').classList.add('hidden');
      renderBrowse(state.listForce);
      renderProcessing();
      renderQueue();
    } catch (e) {
      if (!state.disposed) {
        $('#catalogStatus').textContent = '曲库暂时无法更新，保留上次结果。' + (e.message || '');
        $('#catalogStatus').classList.remove('hidden');
      }
    } finally {
      state.listForce = false;
      state.listRequest = null;
    }
  })();
  return state.listRequest;
}

function doneJobs() { return state.allJobs.filter((j) => j.state === 'done'); }

/** 伴奏带没有原唱人声、歌词库也没收录，就是唱得了但没字幕。点歌前先说清楚。 */
function noLyrics(j) {
  return j.lyrics_status === 'none' || !(j.line_count > 0);
}

function songCard(j) {
  const si = songInfo(j);
  const li = document.createElement('li');
  li.className = 'song-card';
  li.dataset.id = j.id;
  if (state.queue.includes(j.id)) li.classList.add('queued');
  const cover = j.thumbnail
    ? `<img class="cover" src="${escapeHtml(j.thumbnail)}" alt="" loading="lazy"
            onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cover ph',textContent:'🎵'}))" />`
    : '<div class="cover ph">🎵</div>';
  li.innerHTML = `
    ${cover}
    <div class="sc-body">
      <p class="sc-title" title="${escapeHtml(si.title)}">${escapeHtml(si.title)}</p>
      <p class="sc-artist">${escapeHtml(si.artist || '未知歌手')}</p>
    </div>
    <div class="sc-actions">
      <button class="sc-pick" data-act="pick">＋ 点歌</button>
      <button class="sc-play" data-act="play" title="马上唱">▶</button>
    </div>
    ${j.duration ? `<span class="sc-dur">${fmt(j.duration)}</span>` : ''}
    ${noLyrics(j) ? '<span class="sc-nolrc" title="此源没有歌词，只有伴奏">无词</span>' : ''}
    <span class="sc-flag">已点</span>`;
  return li;
}

function songRow(j, idx) {
  const si = songInfo(j);
  const li = document.createElement('li');
  li.className = 'song-row';
  li.dataset.id = j.id;
  if (state.queue.includes(j.id)) li.classList.add('queued');
  li.innerHTML = `
    <span class="sr-no">${String(idx + 1).padStart(2, '0')}</span>
    <span class="sr-artwork" data-tone="${idx % 4}" aria-hidden="true">
      <svg class="ui-icon"><use href="#icon-note"/></svg>
    </span>
    <span class="sr-name"><span class="sr-title">${escapeHtml(si.title)}</span>
      ${noLyrics(j) ? '<span class="sr-nolrc" title="此源没有歌词，只有伴奏">无词</span>' : ''}</span>
    <span class="sr-artist">${escapeHtml(si.artist || '未知歌手')}</span>
    <span class="sr-lang">${escapeHtml(si.lang)}</span>
    <span class="sr-dur">${j.duration ? fmt(j.duration) : ''}</span>
    <button class="sr-pick" data-act="pick" aria-label="点歌：${escapeHtml(si.title)}">点歌</button>`;
  if (j.thumbnail) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.width = image.height = 44;
    image.src = j.thumbnail;
    image.addEventListener('error', () => image.remove(), { once: true });
    li.querySelector('.sr-artwork').appendChild(image);
  }
  return li;
}

/** 语种筛选条：一屏之内就能把 400 多首按语言切开，比进二级菜单快。 */
function renderLangBar(all) {
  const bar = $('#langBar');
  const counts = new Map();
  all.forEach((j) => {
    const l = songInfo(j).lang;
    counts.set(l, (counts.get(l) || 0) + 1);
  });
  const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const sig = names.map((n) => `${n}:${counts.get(n)}`).join(',') + '|' + state.lang;
  if (bar.dataset.sig === sig) return;
  bar.dataset.sig = sig;
  bar.innerHTML = '';
  [['', '全部语种'], ...names.map((n) => [n, `${n} ${counts.get(n)}`])].forEach(([v, label]) => {
    const b = document.createElement('button');
    b.className = 'lang-btn' + (state.lang === v ? ' active' : '');
    b.dataset.lang = v;
    b.setAttribute('aria-pressed', String(state.lang === v));
    b.textContent = label;
    bar.appendChild(b);
  });
}

function renderBrowse(force = false) {
  syncQueuedMarkers();
  const query = librarySearch.query(state.search);
  const kw = query.text;
  const all = doneJobs();
  renderLangBar(all);
  let list = all;
  if (state.lang) list = list.filter((j) => songInfo(j).lang === state.lang);
  if (kw) list = librarySearch.search(list, query);

  const grid = $('#grid'), artistBox = $('#artistList'), rows = $('#songList');
  const mode = kw ? 'all' : state.libMode;   // 搜索时不分组，直接给结果

  // 「歌手」页：先列歌手，点进去再看这位歌手的歌
  if (mode === 'artist' && !state.artistPick) {
    const sig = `A:${state.lang}:${list.map(jobRenderKey).join('|')}:${kw}`;
    if (!force && sig === _browseSig) return;
    _browseSig = sig;
    grid.classList.add('hidden'); rows.classList.add('hidden');
    artistBox.classList.remove('hidden');
    const groups = new Map();
    list.forEach((j) => {
      const a = songInfo(j).artist || '未知歌手';
      // 同一位歌手在曲库里可能繁简两种写法（夢然 / 梦然），按简体归组合成一位；
      // 显示时沿用该写法里出现最多的那个，不擅自把港台歌手改成简体。
      const key = librarySearch.artistKey(a);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(j);
    });
    const label = new Map();
    groups.forEach((js, key) => {
      const tally = new Map();
      js.forEach((j) => {
        const a = songInfo(j).artist || '未知歌手';
        tally.set(a, (tally.get(a) || 0) + 1);
      });
      label.set(key, [...tally.entries()].sort((x, y) => y[1] - x[1])[0][0]);
    });
    const names = [...groups.keys()].sort((a, b) =>
      (pyCollator() || undefined) ? pyCollator().compare(label.get(a), label.get(b))
                                  : label.get(a).localeCompare(label.get(b)));
    artistBox.innerHTML = '';
    names.forEach((n) => {
      const li = document.createElement('button');
      li.type = 'button';
      li.className = 'artist-chip';
      li.dataset.artist = n;
      li.innerHTML = `<span>${escapeHtml(label.get(n))}</span><em>${groups.get(n).length}</em>`;
      artistBox.appendChild(li);
    });
    $('#browseCount').textContent = `${names.length} 位歌手 · ${list.length} 首`;
    $('#browseEmpty').classList.toggle('hidden', names.length > 0);
    $('#browseEmpty').textContent = '曲库还是空的，去「⚙️ 后台」添加歌曲。';
    return;
  }

  if (mode === 'artist' && state.artistPick) {
    list = list.filter((j) => librarySearch.artistKey(songInfo(j).artist || '未知歌手') === state.artistPick);
  }
  if (mode === 'new') list = list.slice(0, 60);
  else if (mode === 'all' && !kw) list = librarySearch.search(list, query);

  const sig = `${mode}:${state.view}:${state.lang}:${state.artistPick || ''}:${state.search}:${list.map(jobRenderKey).join('|')}`;
  if (!force && sig === _browseSig) return;
  _browseSig = sig;

  artistBox.classList.add('hidden');
  // 默认走高密度文字列表：一屏十几首、扫一眼就能找到，比封面墙翻半天快。
  // 封面墙留作可选视图（曲库小、或者想按 MV 画面认歌的时候好用）。
  const useGrid = state.view === 'grid';
  grid.classList.toggle('hidden', !useGrid);
  rows.classList.toggle('hidden', useGrid);
  const box = useGrid ? grid : rows;
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  list.forEach((j, i) => frag.appendChild(useGrid ? songCard(j) : songRow(j, i)));
  box.appendChild(frag);

  $('#browseCount').textContent = mode === 'artist' && state.artistPick
    ? `${state.artistLabel || state.artistPick} · ${list.length} 首（点「歌手」返回）`
    : `${list.length} 首`;
  $('#browseEmpty').classList.toggle('hidden', list.length > 0);
  $('#browseEmpty').textContent = kw
    ? `没搜到「${state.search.trim()}」。试试歌名、歌手、全拼或首字母，也可用空格组合搜索。`
    : '曲库还是空的，去「⚙️ 后台」添加歌曲。';
}

function jobRenderKey(j) {
  return JSON.stringify([j.id, songInfo(j).title, songInfo(j).artist, songInfo(j).lang,
    j.thumbnail, j.duration, j.line_count, j.lyrics_status]);
}

function syncQueuedMarkers() {
  const queued = new Set(state.queue);
  document.querySelectorAll('.song-row, .song-card').forEach((el) => {
    el.classList.toggle('queued', queued.has(el.dataset.id));
  });
}

/* ---------------- 已点歌曲（KTV 的核心交互） ---------------- */
const QUEUE_KEY = 'openk.queue';

function saveQueue() { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue)); } catch {} }
function loadQueue() {
  try { state.queue = [...new Set(JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]').filter((id) => typeof id === 'string'))]; }
  catch { state.queue = []; }
}

function jobById(id) { return state.allJobs.find((j) => j.id === id); }

function addToQueue(id, playNow = false) {
  if (playNow) {
    state.queue = state.queue.filter((q) => q !== id);
    state.queue.unshift(id);
    saveQueue(); renderQueue(); renderBrowse();
    playFromQueue();
    return;
  }
  if (state.queue.includes(id)) { toast('这首已经在已点列表里了'); return; }
  state.queue.push(id);
  saveQueue(); renderQueue(); renderBrowse();
  // 没在唱歌就直接开唱，符合「点了就响」的预期
  if (!state.currentJobId && !state.selectionRequest) playFromQueue();
  else toast(`已点：${songInfo(jobById(id) || {}).title || ''}（第 ${state.queue.length} 位）`);
}

function removeFromQueue(id) {
  state.queue = state.queue.filter((q) => q !== id);
  saveQueue(); renderQueue(); renderBrowse();
}

function topQueue(id) {
  state.queue = [id, ...state.queue.filter((q) => q !== id)];
  saveQueue(); renderQueue();
}

/** 取出队首开唱。当前这首会从队列里移除——KTV 机器就是这个行为。
 *
 *  keepView：自动接下一首时用。别人正在翻歌选下一首，结果上一首唱完了
 *  界面自己跳走，很烦人；所以只有用户主动点歌 / 切歌时才切到歌词页。 */
function playFromQueue(keepView = false) {
  const id = state.queue.shift();
  saveQueue(); renderQueue(); renderBrowse();
  if (!id) { endPlayback(); return; }   // 队列空了才真正停下来
  selectJob(id, keepView);
}

function renderQueue() {
  const ul = $('#queueList');
  const signature = state.queue.map((id) => {
    const j = jobById(id);
    return JSON.stringify([id, j && songInfo(j).title, j && songInfo(j).artist]);
  }).join('|');
  if (ul.dataset.signature === signature) return;
  ul.dataset.signature = signature;
  ul.innerHTML = '';
  state.queue.forEach((id, i) => {
    const j = jobById(id);
    const si = j ? songInfo(j) : { title: '（已删除）', artist: '' };
    const li = document.createElement('li');
    li.className = 'q-item';
    li.dataset.id = id;
    li.innerHTML = `
      <span class="q-no">${i + 1}</span>
      <div class="q-body">
        <button class="q-title item-open" data-act="play" aria-label="立即演唱：${escapeHtml(si.title)}">${escapeHtml(si.title)}</button>
        <p class="q-artist">${escapeHtml(si.artist || '未知歌手')}</p>
      </div>
      <button class="lyr-btn" data-act="top" title="置顶，下一首就唱它">⇧ 置顶</button>
      <button class="lyr-btn" data-act="del" title="从已点里删掉">✕</button>`;
    ul.appendChild(li);
  });
  $('#queueCount').textContent = String(state.queue.length);
  $('#nbQueueCount').textContent = String(state.queue.length);
  $('#queueEmpty').classList.toggle('hidden', state.queue.length > 0);
  $('#queueHint').textContent = state.queue.length ? '唱完自动接下一首' : '';
}

/* ---------------- 后台：处理中的任务 ---------------- */
function renderProcessing() {
  const pending = state.allJobs.filter((j) => j.state !== 'done');
  const ul = $('#procList');
  const focused = ul.contains(document.activeElement) ? {
    id: document.activeElement.closest('.proc-item')?.dataset.id,
    action: document.activeElement.dataset.act,
  } : null;
  ul.innerHTML = '';
  pending.slice(0, 50).forEach((j) => {
    const li = document.createElement('li');
    li.className = `proc-item ${j.state}`;
    li.dataset.id = j.id;
    const pct = Math.round(Math.max(0, Math.min(100, Number(j.progress) || 0)));
    li.innerHTML = `
      <div class="p-body">
        <button class="p-title item-open" data-act="inspect" aria-label="查看处理进度：${escapeHtml(j.title || j.id)}">${escapeHtml(j.title || j.url || j.id)}</button>
        <p class="p-msg muted small">${STATE_TEXT[j.state] || j.state} · ${escapeHtml(j.message || '')}</p>
      </div>
      ${j.state === 'error'
        ? '<button class="lyr-btn" data-act="retry">重试</button>'
        : `<span class="p-pct">${pct}%</span>`}`;
    ul.appendChild(li);
  });
  $('#procEmpty').classList.toggle('hidden', pending.length > 0);
  const running = pending.filter((j) => j.state === 'running').length;
  $('#procCount').textContent = pending.length
    ? `（${pending.length} 个待处理，${running} 个进行中）` : '';
  const badge = $('#adminBadge');
  badge.textContent = String(pending.length);
  badge.classList.toggle('hidden', pending.length === 0);
  if (focused) {
    const row = [...ul.children].find((el) => el.dataset.id === focused.id);
    const button = row && [...row.querySelectorAll('button')].find((el) => el.dataset.act === focused.action);
    (button || $('#adminClose')).focus();
  }
}

/* ---------------- 视图切换 ---------------- */
/** 回到曲库。注意**不停音乐**——点歌台最核心的一条：
 *  别人在唱的时候，其他人得能继续翻歌、继续点。 */
function showBrowse() {
  $('#stage').classList.add('hidden');
  $('#browse').classList.remove('hidden');
  stopLyricAnimation();
  renderBrowse();
}

function showStage() {
  $('#browse').classList.add('hidden');
  $('#stage').classList.remove('hidden');
  state.activeLine = -1;
  updateLyrics(inst.currentTime);
  startLyricAnimation();
}

/** 彻底停止播放（只有清空队列 / 没有下一首时才走这里）。 */
function endPlayback() {
  invalidateSelection();
  stopAudio();
  state.currentJobId = null;
  renderNowBar();
  showBrowse();
}

/* ---------------- 常驻控制条 ---------------- */
function renderNowBar() {
  const bar = $('#nowbar');
  const j = state.currentJobId ? jobById(state.currentJobId) : null;
  if (!j) { bar.classList.add('hidden'); document.body.classList.remove('has-nowbar'); return; }
  const si = songInfo(j);
  bar.classList.remove('hidden');
  document.body.classList.add('has-nowbar');
  const cover = $('#nbCover');
  if (j.thumbnail) { cover.src = j.thumbnail; cover.classList.remove('hidden'); }
  else cover.classList.add('hidden');
  $('#nbTitle').textContent = si.title;
  $('#nbArtist').textContent = si.artist || '未知歌手';
  $('#nbQueueCount').textContent = String(state.queue.length);
  $('#nbPlay').textContent = inst.paused ? '▶' : '⏸';
  measureNowBar();
}

function measureNowBar() {
  const height = Math.ceil($('#nowbar').getBoundingClientRect().height);
  if (height > 0) document.documentElement.style.setProperty('--nowbar-height', `${height}px`);
}

/** 原唱 / 伴唱切换。KTV 里默认永远是伴唱——原唱是拿来学的，不是拿来唱的。 */
function setSingMode(mode) {
  state.singMode = mode;
  prefs.singMode = mode;
  savePrefs();
  $('#modeInst').classList.toggle('active', mode === 'inst');
  $('#modeOrig').classList.toggle('active', mode === 'orig');
  $('#modeInst').setAttribute('aria-pressed', String(mode === 'inst'));
  $('#modeOrig').setAttribute('aria-pressed', String(mode === 'orig'));
  // 原唱模式下把导唱人声推满，伴唱模式下压到 0
  $('#vocalVol').value = mode === 'orig' ? 100 : 0;
  applyVolumes();
}

let drawerTrigger = null;
function openDrawer(which) {
  if ($('#scrim').classList.contains('hidden')) drawerTrigger = document.activeElement;
  const q = which === 'queue';
  $('#queuePanel').classList.toggle('hidden', !q);
  $('#adminPanel').classList.toggle('hidden', q);
  $('#scrim').classList.remove('hidden');
  ['.topbar', '#browse', '#stage', '#nowbar', '#pendingRecordingsWrap', '.foot'].forEach((s) => {
    const el = $(s);
    if (el) el.inert = true;
  });
  document.body.classList.add('drawer-open');
  (q ? $('#queueClose') : $('#adminClose')).focus();
}
function closeDrawers() {
  $('#queuePanel').classList.add('hidden');
  $('#adminPanel').classList.add('hidden');
  $('#scrim').classList.add('hidden');
  ['.topbar', '#browse', '#stage', '#nowbar', '#pendingRecordingsWrap', '.foot'].forEach((s) => {
    const el = $(s);
    if (el) el.inert = false;
  });
  document.body.classList.remove('drawer-open');
  if (drawerTrigger?.isConnected) drawerTrigger.focus();
  drawerTrigger = null;
}

let _toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast'; el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 选择任务 ---------------- */
function cancelEndedTimer() {
  clearTimeout(state.endedTimer);
  state.endedTimer = null;
}

function invalidateSelection() {
  state.selectionGeneration++;
  state.selectionRequestGeneration++;
  state.selectionRequest?.abort();
  state.selectionRequest = null;
  state.lyricsGeneration++;
  state.lyricsRequest?.abort();
  state.recordingsGeneration++;
  state.recordingsRequest?.abort();
  cancelEndedTimer();
}

function isCurrentPlayer(id, generation) {
  return !state.disposed && state.currentJobId === id && state.selectionGeneration === generation;
}

async function selectJob(id, keepView = false) {
  const requestGeneration = ++state.selectionRequestGeneration;
  state.selectionRequest?.abort();
  cancelEndedTimer();
  const request = new AbortController();
  state.selectionRequest = request;
  unlockAudio();
  try {
    const job = await api.getJob(id, { signal: request.signal });
    if (requestGeneration !== state.selectionRequestGeneration || request.signal.aborted || state.disposed) return;
    if (job.state === 'done') {
      if (!job.media?.instrumental) throw new Error('伴奏文件暂时不可用，请在后台检查歌曲');
      const generation = ++state.selectionGeneration;
      state.lyricsGeneration++;
      state.lyricsRequest?.abort();
      state.recordingsGeneration++;
      state.recordingsRequest?.abort();
      if (!keepView) showStage();
      await showPlayer(job, generation);
    } else {
      openDrawer('admin');
      showProgress(job);
      startPolling(id);
    }
  } catch (e) {
    if (requestGeneration === state.selectionRequestGeneration && e.name !== 'AbortError') {
      toast(e.message || '无法载入歌曲，请重试');
    }
  } finally {
    if (state.selectionRequest === request) state.selectionRequest = null;
  }
}

/* ---------------- 进度轮询 ---------------- */
function startPolling(id) {
  stopPolling();
  state.inspectedJobId = id;
  const generation = state.pollGeneration;
  let failures = 0;
  const tick = async () => {
    if (generation !== state.pollGeneration || state.disposed) return;
    state.pollTimer = null;
    if (document.hidden) {
      state.pollTimer = setTimeout(tick, 3000);
      return;
    }
    const request = new AbortController();
    state.pollRequest = request;
    try {
      const job = await api.getJob(id, { signal: request.signal });
      if (generation !== state.pollGeneration || request.signal.aborted) return;
      failures = 0;
      updateProgressUI(job);
      const index = state.allJobs.findIndex((j) => j.id === id);
      if (index >= 0) state.allJobs[index] = job;
      else state.allJobs.unshift(job);
      renderProcessing();
      if (job.state === 'done' || job.state === 'error') {
        stopPolling();
        await refreshList();
        toast(job.state === 'done' ? '歌曲已制作完成，可在曲库点唱' : '制作失败，请在后台查看原因');
        return;
      }
    } catch (e) {
      if (generation === state.pollGeneration && e.name !== 'AbortError') {
        if (e.status === 404) {
          stopPolling();
          $('#progressPanel').classList.add('hidden');
          await refreshList();
          toast('该制作任务已不存在');
          return;
        }
        failures++;
        $('#progMessage').textContent = '连接暂时中断，正在重试…';
      }
    } finally {
      if (state.pollRequest === request) state.pollRequest = null;
      if (generation === state.pollGeneration && !state.disposed) {
        state.pollTimer = setTimeout(tick, Math.min(15000, 1200 * (2 ** failures)));
      }
    }
  };
  state.pollTimer = setTimeout(tick, 1200);
}
function stopPolling() {
  state.pollGeneration++;
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.pollRequest?.abort();
  state.pollRequest = null;
  state.inspectedJobId = null;
}

function showProgress(job) {
  $('#progressPanel').classList.remove('hidden');
  updateProgressUI(job);
}

function updateProgressUI(job) {
  $('#progTitle').textContent = job.title || '处理中…';
  $('#progMessage').textContent = job.message || '';
  const pct = Math.max(0, Math.min(100, Number(job.progress || 0)));
  $('#progBar').style.width = pct + '%';
  $('#progPct').textContent = Math.round(pct) + '%';
  $('#progressMeter').setAttribute('aria-valuenow', String(Math.round(pct)));
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

async function showPlayer(job, generation = state.selectionGeneration) {
  if (generation !== state.selectionGeneration) return;
  $('#progressPanel').classList.add('hidden');
  $('#player').classList.remove('hidden');

  const si = songInfo(job);
  $('#playerTitle').textContent = si.artist ? `${si.title} — ${si.artist}` : (si.title || '未命名');
  const link = $('#sourceLink');
  if (job.webpage_url) { link.href = job.webpage_url; link.style.display = ''; }
  else { link.style.display = 'none'; }

  // 载入音轨（换歌不掉麦）
  stopAudio(true);
  state.currentJobId = job.id;
  if (!jobById(job.id)) state.allJobs.unshift(job);
  else state.allJobs[state.allJobs.findIndex((j) => j.id === job.id)] = job;
  inst.src = job.media?.instrumental || '';
  if (job.media?.vocals) {
    vocal.src = job.media.vocals;
    document.querySelector('label.mix:nth-child(2)').style.display = '';
  } else {
    vocal.removeAttribute('src');
    document.querySelector('label.mix:nth-child(2)').style.display = 'none';
  }
  applyVolumes();
  $('#modeOrig').disabled = !hasVocal();
  setAudioStatus('正在载入音频…');

  // 开唱先把麦克风接上（点歌那一下就是用户手势，此时申请授权才会被允许）
  autoEnableMic();
  setSingMode(state.singMode);
  startPlayback();
  renderNowBar();

  // 录音状态重置 + 载入该歌的历史录音
  $('#recStatus').textContent = '';
  $('#recBtn').textContent = '🎤 开始录唱';
  $('#recBtn').classList.remove('recording');
  $('#recBtn').disabled = false;
  $('#saveLyrics').disabled = false;
  $('#lsGo').disabled = false;
  $('#recList').replaceChildren();
  $('#recListWrap').classList.add('hidden');
  $('#recListStatus').textContent = '';
  loadRecordings(job.id);
  renderPendingRecordings();

  // 载入歌词
  state.lyrics = null; state.lineEls = []; state.activeLine = -1;
  state.lyricsUrl = job.media?.lyrics || null;
  state.currentTitle = job.title || '';
  state.editing = false;
  $('#editBar').classList.add('hidden');
  $('#editLyrics').classList.add('hidden');
  $('#searchLyrics').classList.add('hidden');
  $('#lyricSearch').classList.add('hidden');
  $('#lsQuery').value = '';
  $('#lyricSource').classList.add('hidden');
  await loadPlayerLyrics(job.id, state.lyricsUrl, generation);
  if (isCurrentPlayer(job.id, generation)) renderAlignmentStatus(job.id);
}

async function loadPlayerLyrics(jobId, url, generation = state.selectionGeneration, bust = false) {
  if (!isCurrentPlayer(jobId, generation)) return;
  const revision = ++state.lyricsGeneration;
  state.lyricsRequest?.abort();
  const request = new AbortController();
  state.lyricsRequest = request;
  const box = $('#lyrics');
  if (!state.lyrics) box.innerHTML = '<p class="muted empty">正在载入歌词…</p>';
  try {
    if (bust) {
      // 发布歌词会产生新的不可变路径，不能只给旧 URL 加时间戳。
      const job = await api.getJob(jobId, { signal: request.signal });
      if (!isCurrentPlayer(jobId, generation) || revision !== state.lyricsGeneration || request.signal.aborted) return;
      url = job.media?.lyrics || null;
      state.lyricsUrl = url;
      const index = state.allJobs.findIndex((j) => j.id === jobId);
      if (index >= 0) state.allJobs[index] = job;
    }
    if (!url) {
      state.lyrics = { lines: [] };
      renderLyrics();
      return;
    }
    const suffix = bust ? (url.includes('?') ? '&' : '?') + 't=' + Date.now() : '';
    const lyrics = await fetchJSON(url + suffix, { signal: request.signal, cache: 'no-cache' });
    if (!isCurrentPlayer(jobId, generation) || revision !== state.lyricsGeneration || request.signal.aborted) return;
    if (!lyrics || !Array.isArray(lyrics.lines)) throw new Error('歌词格式不正确');
    state.lyrics = lyrics;
    // 显示歌词来源徽章
    const badge = $('#lyricSource');
    const src = state.lyrics.source;
    if (src) { badge.textContent = '歌词来源：' + src; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
    renderLyrics();
  } catch (e) {
    if (isCurrentPlayer(jobId, generation) && revision === state.lyricsGeneration && e.name !== 'AbortError') {
      if (state.lyrics?.lines?.length) {
        renderLyrics();
        toast('新版歌词暂时无法载入，保留上次版本；重新点歌可重试');
      } else {
        box.innerHTML = '<p class="muted empty">未能载入歌词。音乐可继续播放，请稍后重试。</p>';
      }
    }
  } finally {
    if (state.lyricsRequest === request) state.lyricsRequest = null;
  }
}

function renderLyrics() {
  const box = $('#lyrics');
  box.innerHTML = '';
  state.lineEls = [];
  state.lyricWords = [];
  state.activeLine = -1;
  state.activeWord = -2;
  const lines = state.lyrics?.lines || [];
  if (lines.length === 0) {
    box.innerHTML = '<p class="muted" style="text-align:center">这首歌似乎没有可识别的人声歌词。</p>';
    $('#editLyrics').classList.add('hidden');
    $('#searchLyrics').classList.toggle('hidden', state.editing);
    return;
  }
  lines.forEach((ln, i) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.tabIndex = 0;
    div.setAttribute('role', 'button');
    div.setAttribute('aria-label', '跳到歌词：' + ln.text);
    const words = [];
    if (ln.words && ln.words.length) {
      ln.words.forEach((w) => {
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = (w.text ?? w.word ?? '') + ' ';
        span.dataset.start = w.start;
        div.appendChild(span);
        words.push({ el: span, start: Number(w.start) });
      });
    } else {
      div.textContent = ln.text;
    }
    div.addEventListener('click', () => seekTo(ln.start + 0.001));
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); e.stopPropagation(); seekTo(ln.start + 0.001); }
    });
    box.appendChild(div);
    state.lineEls.push(div);
    state.lyricWords.push(words);
  });
  $('#editLyrics').classList.toggle('hidden', !(state.lyrics?.lines?.length) || state.editing);
  $('#searchLyrics').classList.toggle('hidden', state.editing);
  updateLyrics(inst.currentTime);
  startLyricAnimation();
}

/* ---------- 歌词编辑（识别不准时手动纠正） ---------- */
function enterLyricsEdit() {
  const lines = state.lyrics?.lines || [];
  if (!lines.length) return;
  state.editing = true;
  stopLyricAnimation();
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
  $('#searchLyrics').classList.add('hidden');
  $('#lyricSearch').classList.add('hidden');
}

function exitLyricsEdit() {
  state.editing = false;
  $('#editBar').classList.add('hidden');
  renderLyrics();
}

async function saveLyricsEdit() {
  if (!state.editing || !state.lyrics) return;
  const jobId = state.currentJobId;
  const generation = state.selectionGeneration;
  const lyricsUrl = state.lyricsUrl;
  const lyrics = state.lyrics;
  const inputs = $('#lyrics').querySelectorAll('.lyric-edit');
  const lines = (state.lyrics.lines || []).map((ln, i) => ({
    start: ln.start, end: ln.end,
    text: (inputs[i] ? inputs[i].value : ln.text || '').trim(),
    words: ln.words || [],
  })).filter((ln) => ln.text);
  const btn = $('#saveLyrics');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    await api.updateLyrics(jobId, {
      lines, language: lyrics.language, source: lyrics.source,
    });
    if (!isCurrentPlayer(jobId, generation)) return;
    state.editing = false;
    $('#editBar').classList.add('hidden');
    await loadPlayerLyrics(jobId, lyricsUrl, generation, true);
    refreshList(true);
  } catch (e) {
    if (isCurrentPlayer(jobId, generation)) toast(e.message || '保存失败');
  } finally {
    if (isCurrentPlayer(jobId, generation)) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

/* ---------- 搜歌词并重新对齐（识别成拼音/英文时用） ---------- */
function guessQuery(title) {
  if (!title) return '';
  const m = title.match(/《\s*([^《》]+?)\s*》/);   // 只有书名号《》才较可靠地是歌名
  let t = title
    .replace(/[\(（\[【『「][^)）\]】』」]*[\)）\]】』」]/g, ' ')  // 去掉各种括号/引号内的噪声副标题
    .replace(/\s+/g, ' ').trim();
  if (m && m[1] && !t.includes(m[1])) t = (t + ' ' + m[1]).trim();
  return t.length > 28 ? t.slice(0, 28) : t;
}

function toggleLyricSearch(show) {
  const panel = $('#lyricSearch');
  const willShow = (show === undefined) ? panel.classList.contains('hidden') : show;
  panel.classList.toggle('hidden', !willShow);
  if (willShow) {
    if (!$('#lsQuery').value.trim()) $('#lsQuery').value = guessQuery(state.currentTitle);
    $('#lsQuery').focus(); $('#lsQuery').select();
  }
}

async function doLyricSearch() {
  const q = $('#lsQuery').value.trim();
  if (!q) { $('#lsQuery').focus(); return; }
  const hint = $('#lsHint'); const ul = $('#lsResults');
  hint.textContent = '搜索中…'; ul.innerHTML = '';
  const go = $('#lsGo'); go.disabled = true;
  const jobId = state.currentJobId, generation = state.selectionGeneration;
  const searchGeneration = state.lyricSearchGeneration = (state.lyricSearchGeneration || 0) + 1;
  try {
    const results = await api.searchLyrics({ q });
    if (isCurrentPlayer(jobId, generation) && searchGeneration === state.lyricSearchGeneration) renderLyricResults(results);
  } catch (e) {
    if (isCurrentPlayer(jobId, generation)) hint.textContent = e.message || '搜索失败';
  } finally {
    if (isCurrentPlayer(jobId, generation) && searchGeneration === state.lyricSearchGeneration) go.disabled = false;
  }
}

function renderLyricResults(results) {
  const hint = $('#lsHint'); const ul = $('#lsResults');
  ul.innerHTML = '';
  if (!results || !results.length) {
    hint.textContent = '没搜到，换个关键词试试（只写歌名、或用简体）。';
    return;
  }
  hint.textContent = `找到 ${results.length} 条，选一条重新对齐：`;
  results.forEach((r) => {
    const li = document.createElement('li');
    const dur = r.duration ? fmt(r.duration) : '';
    const tag = r.synced
      ? '<span class="ls-tag synced">逐字对齐</span>'
      : '<span class="ls-tag">近似时间</span>';
    li.innerHTML = `
      <div class="ls-info">
        <div class="ls-name">${escapeHtml(r.trackName || '?')} ${tag}</div>
        <div class="ls-sub muted small">${escapeHtml(r.artistName || '')}${r.albumName ? ' · ' + escapeHtml(r.albumName) : ''}${dur ? ' · ' + dur : ''}</div>
      </div>
      <button class="lyr-btn primary ls-use">用这个</button>`;
    li.querySelector('.ls-use').addEventListener('click', () => applyLyric(r, li));
    ul.appendChild(li);
  });
  renderAlignmentStatus(state.currentJobId);
}

const ALIGN_KEY = 'openk.alignments';
function alignmentBusy(jobId) {
  return state.alignmentSubmitting.has(jobId) || ['queued', 'running'].includes(state.alignmentOperations[jobId]?.state);
}
function saveAlignments() {
  const pending = {};
  Object.entries(state.alignmentOperations).forEach(([jobId, op]) => {
    if (op.id && op.state !== 'done') pending[jobId] = op.id;
  });
  try { localStorage.setItem(ALIGN_KEY, JSON.stringify(pending)); } catch {}
}
function resumeAlignments() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(ALIGN_KEY) || '{}'); } catch { saved = {}; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
  Object.entries(saved).forEach(([jobId, id]) => {
    if (typeof id !== 'string') return;
    state.alignmentOperations[jobId] = { id, job_id: jobId, state: 'queued', message: '正在恢复对齐进度…' };
    scheduleAlignment(jobId, 0);
  });
}
function renderAlignmentStatus(jobId) {
  if (state.disposed || state.currentJobId !== jobId) return;
  const op = state.alignmentOperations[jobId];
  const busy = alignmentBusy(jobId);
  const status = $('#alignmentStatus');
  status.textContent = state.alignmentSubmitting.has(jobId) ? '正在提交对齐任务…'
    : op ? ({ queued: '歌词对齐排队中', running: '正在对齐歌词', done: '歌词已更新', error: '歌词对齐失败' }[op.state] || '正在查询对齐进度')
      + (op.error || op.message ? ' · ' + (op.error || op.message) : '') : '';
  status.classList.toggle('hidden', !status.textContent);
  document.querySelectorAll('.ls-use').forEach((b) => { b.disabled = busy; });
  $('#editLyrics').disabled = busy;
}
async function finishAlignment(jobId, op) {
  state.alignmentOperations[jobId] = op;
  saveAlignments();
  renderAlignmentStatus(jobId);
  if (op.state === 'done') {
    if (state.currentJobId === jobId && !state.editing) {
      await loadPlayerLyrics(jobId, state.lyricsUrl, state.selectionGeneration, true);
    }
    await refreshList();
  }
}
function scheduleAlignment(jobId, delay = 1500) {
  clearTimeout(state.alignmentTimers.get(jobId));
  if (state.disposed) return;
  state.alignmentTimers.set(jobId, setTimeout(async () => {
    state.alignmentTimers.delete(jobId);
    const op = state.alignmentOperations[jobId];
    if (!op || !['queued', 'running'].includes(op.state)) return;
    if (document.hidden || state.alignmentRequests.has(jobId)) { scheduleAlignment(jobId, 3000); return; }
    const request = new AbortController();
    state.alignmentRequests.set(jobId, request);
    let retry = 1500;
    try {
      const result = await api.getOperation(op.id, { signal: request.signal });
      if (request.signal.aborted || state.disposed || state.alignmentOperations[jobId]?.id !== op.id) return;
      if (result.id !== op.id || result.job_id !== jobId || !['queued', 'running', 'done', 'error'].includes(result.state)) {
        throw Object.assign(new Error('对齐任务响应格式不正确，请确认服务端版本'), { permanent: true });
      }
      state.alignmentOperations[jobId] = result;
      renderAlignmentStatus(jobId);
      if (result.state === 'done' || result.state === 'error') await finishAlignment(jobId, result);
    } catch (e) {
      retry = Math.min(15000, delay > 0 ? delay * 2 : 3000);
      if (!request.signal.aborted && state.alignmentOperations[jobId]?.id === op.id) {
        if (e.status === 404 || e.permanent) {
          await finishAlignment(jobId, { ...op, state: 'error',
            error: e.status === 404 ? '对齐任务已过期，可重新提交' : e.message });
        } else {
          op.message = '连接暂时中断，稍后自动恢复';
          renderAlignmentStatus(jobId);
        }
      }
    } finally {
      if (state.alignmentRequests.get(jobId) === request) state.alignmentRequests.delete(jobId);
      if (state.alignmentOperations[jobId]?.id === op.id
          && ['queued', 'running'].includes(state.alignmentOperations[jobId].state)) scheduleAlignment(jobId, retry);
    }
  }, delay));
}

async function applyLyric(r, li) {
  const jobId = state.currentJobId;
  if (!jobId || alignmentBusy(jobId)) return;
  state.alignmentSubmitting.add(jobId);
  renderAlignmentStatus(jobId);
  try {
    const { accepted, data } = await api.alignLyrics(jobId, { lrclib_id: r.id });
    if (state.disposed) return;
    if (accepted) {
      const op = data?.operation;
      if (!op?.id || op.job_id !== jobId || !['queued', 'running', 'done', 'error'].includes(op.state)) {
        throw new Error('服务端未返回有效的对齐任务编号');
      }
      state.alignmentOperations[jobId] = op;
      saveAlignments();
      if (op.state === 'done' || op.state === 'error') await finishAlignment(jobId, op);
      else scheduleAlignment(jobId);
    } else if (data?.ok === true) {
      await finishAlignment(jobId, { job_id: jobId, state: 'done', message: '已通过旧版接口完成' });
    } else {
      throw new Error('无法识别对齐响应，请确认服务端版本');
    }
  } catch (e) {
    state.alignmentOperations[jobId] = { job_id: jobId, state: 'error', error: e.message || '对齐失败' };
  } finally {
    state.alignmentSubmitting.delete(jobId);
    renderAlignmentStatus(jobId);
  }
}

function updateLyrics(t) {
  if (state.editing) return;
  const lines = state.lyrics?.lines;
  if (!lines || !lines.length) return;

  // 找当前行：最后一个 start <= t 的行
  let lo = 0, hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].start <= t + 0.02) lo = mid + 1; else hi = mid;
  }
  const idx = lo - 1;

  if (idx !== state.activeLine) {
    if (state.activeLine >= 0 && state.lineEls[state.activeLine])
      state.lineEls[state.activeLine].classList.remove('active');
    if (idx >= 0 && state.lineEls[idx]) {
      const el = state.lineEls[idx];
      el.classList.add('active');
      const box = $('#lyrics');
      // 用 scrollTo({behavior:'auto'}) 显式滚动：直接赋值 scrollTop 在
      // CSS scroll-behavior:smooth（或 prefers-reduced-motion）下可能被忽略而不滚动。
      if (!document.hidden && !$('#stage').classList.contains('hidden')) {
        const top = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
        if (typeof box.scrollTo === 'function') box.scrollTo({ top, behavior: 'auto' });
        else box.scrollTop = top;
      }
    }
    state.activeLine = idx;
    state.activeWord = -2;
  }

  // 逐词高亮当前行
  if (idx >= 0) {
    const words = state.lyricWords[idx] || [];
    let word = -1;
    while (word + 1 < words.length && words[word + 1].start <= t) word++;
    if (word !== state.activeWord) {
      words.forEach((w, i) => w.el.classList.toggle('sung', i <= word));
      state.activeWord = word;
    }
  }
}

function stopLyricAnimation() {
  cancelAnimationFrame(state.lyricRaf);
  state.lyricRaf = 0;
}
function startLyricAnimation() {
  stopLyricAnimation();
  if (state.disposed || inst.paused || document.hidden || state.editing || $('#stage').classList.contains('hidden')) return;
  const tick = () => {
    state.lyricRaf = 0;
    if (state.disposed || inst.paused || document.hidden || state.editing || $('#stage').classList.contains('hidden')) return;
    updateLyrics(inst.currentTime);
    state.lyricRaf = requestAnimationFrame(tick);
  };
  state.lyricRaf = requestAnimationFrame(tick);
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
// 限幅后的补偿增益。限幅器把峰值压到 -3dB 附近，乘回来刚好接近满刻度而不削顶。
const MIC_MAKEUP = 1.4;

/* ---------- 防啸叫 ---------- */
// 麦克风离音箱太近就会尖叫：音箱的声音被麦克风再拾回去、再放大、再拾回去，
// 环路增益一旦大于 1，房间里某个共振频率就会指数级涨到削顶为止。
// 限幅器只能把它压得没那么伤耳朵，治不了成因——要真止住，必须把那个频率
// 从环路里挖掉，或者干脆把环路增益拉回 1 以下。
//
// 好在啸叫和唱歌在频谱上长得完全不一样，这是能自动判别的根据：
//   · 啸叫是共振被反复放大出的「一根针」，能量几乎全堆在一个频点上；
//   · 人声再飙高音也是一串泛音（基频 + 2f + 3f…），谱线是「一把梳子」；
//   · 啸叫锁死在房间共振上纹丝不动，人声就算长音也有揉弦、有漂移。
// 三条都对上才算数，避免把长音误伤成啸叫。
const HOWL = {
  minHz: 180,           // 以下是伴奏低频，本来就厚，不参与
  maxHz: 8000,          // 以上多是气声齿音，能量低、误判多
  peakOverMedianDb: 18, // 峰值高出频谱中位数多少 dB 才算「尖」
  harmonicDb: 10,       // 2f/3f 也这么突出就是泛音列 → 是人声，放过
  quietDb: -70,         // 比这还小说明根本没出声
  holdFrames: 6,        // 连续几帧锁在同一频点才确认（约 100ms）
  binTol: 2,            // 容许的频率漂移，人声的揉弦远大于此
  releaseMs: 12000,     // 一个陷波多久没再啸叫就放开
  maxFilters: 4,        // 陷波器上限，挖太多会把声音掏空
  notchQ: 24,
  burstMs: 2500,        // 这段时间内反复啸叫就认为陷波按不住
  burstHits: 2,
  duckTo: 0.22,         // 按不住时监听增益掐到多少
  duckMs: 40,           // 掐下去要快过啸叫涨起来的速度
  holdMs: 1200,         // 安静多久才开始恢复
  recoverMs: 2500,      // 恢复要慢，免得一放开又炸
};
// 同一处反复啸叫就一档档挖深，别一上来就把整段频率挖没。
const NOTCH_DEPTHS = [-15, -26, -38];

/** 从一帧频谱里挑出「疑似啸叫」的那根针；不像就返回 null。
 *  spec 是 AnalyserNode.getFloatFrequencyData 的输出（dB），binHz 是每格的赫兹数。 */
function findHowlPeak(spec, binHz, cfg = HOWL) {
  const lo = Math.max(1, Math.ceil(cfg.minHz / binHz));
  const hi = Math.min(spec.length - 1, Math.floor(cfg.maxHz / binHz));
  if (hi - lo < 8) return null;
  let bin = -1, peak = -Infinity;
  const vals = [];
  for (let i = lo; i <= hi; i++) {
    const v = spec[i];
    if (!Number.isFinite(v)) continue;
    vals.push(v);
    if (v > peak) { peak = v; bin = i; }
  }
  if (bin < 0 || vals.length < 8 || peak < cfg.quietDb) return null;
  vals.sort((a, b) => a - b);
  const median = vals[vals.length >> 1];
  const prominence = peak - median;
  if (prominence < cfg.peakOverMedianDb) return null;
  // 泛音检查。注意峰值不一定落在基频上——人声常常是第二、三泛音最响——
  // 所以查的是「峰值的整数倍上还有没有东西」，对基频和泛音都成立。
  let harmonics = 0;
  for (const mult of [2, 3]) {
    const h = bin * mult;
    if (h + 1 > hi) continue;
    let hv = -Infinity;
    for (let k = h - 1; k <= h + 1; k++) if (Number.isFinite(spec[k]) && spec[k] > hv) hv = spec[k];
    if (hv - median >= cfg.harmonicDb) harmonics++;
  }
  if (harmonics >= 2) return null;
  return { bin, hz: bin * binHz, db: peak, prominence };
}

/** 盯住连续多帧都待在同一频点的那根针。
 *  「像啸叫」和「就是啸叫」的分界全在这一步：正反馈会赖着不走，人声会飘。 */
function makeHowlTracker(cfg = HOWL) {
  let bin = -1, hits = 0, lastDb = -Infinity;
  return {
    push(peak) {
      if (!peak) { bin = -1; hits = 0; lastDb = -Infinity; return null; }
      if (bin >= 0 && Math.abs(peak.bin - bin) <= cfg.binTol) hits++;
      else { bin = peak.bin; hits = 1; }
      // 正反馈只会越长越响；已经削顶的啸叫则是平的，所以判「没在明显衰减」。
      const rising = peak.db > lastDb - 1;
      lastDb = peak.db;
      if (hits >= cfg.holdFrames && rising) { hits = 0; return peak; }
      return null;
    },
    reset() { bin = -1; hits = 0; lastDb = -Infinity; },
  };
}

// AudioParam 的排程方法在测试替身里可能没有，退回直接赋值。
function rampParam(param, value, ms, actx) {
  if (!param) return;
  if (actx && typeof actx.currentTime === 'number' && typeof param.linearRampToValueAtTime === 'function') {
    try {
      const t = actx.currentTime;
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(value, t + Math.max(0.001, ms / 1000));
      return;
    } catch {}
  }
  param.value = value;
}

/** 串成一串的陷波器。确认一处啸叫就在那个频率上挖一个窄坑，
 *  把环路增益压回 1 以下——这是唯一能「不降音量也止住啸叫」的办法。
 *  用 peaking 而非 notch：深度可以随顽固程度一档档加，也不会一刀切没。 */
function makeNotchBank(actx, cfg = HOWL) {
  const filters = [];
  for (let i = 0; i < cfg.maxFilters; i++) {
    const f = actx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = 1000;
    f.Q.value = cfg.notchQ;
    f.gain.value = 0;
    if (i > 0) filters[i - 1].connect(f);
    filters.push(f);
  }
  const slots = filters.map(() => ({ hz: 0, level: -1, at: 0 }));
  const apply = (i) => {
    const s = slots[i];
    if (s.level < 0) { rampParam(filters[i].gain, 0, 120, actx); return; }
    filters[i].frequency.value = s.hz;
    rampParam(filters[i].gain, NOTCH_DEPTHS[s.level], 30, actx);
  };
  return {
    input: filters[0],
    output: filters[filters.length - 1],
    filters, slots,
    /** 返回 'deepen' | 'add' | 'steal'，供上层判断陷波是否已经按不住。 */
    engage(hz, now) {
      const near = (a, b) => Math.abs(a - b) <= Math.max(25, b * 0.05);
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].level >= 0 && near(slots[i].hz, hz)) {
          slots[i].level = Math.min(NOTCH_DEPTHS.length - 1, slots[i].level + 1);
          slots[i].at = now; apply(i);
          return 'deepen';
        }
      }
      let idx = slots.findIndex((s) => s.level < 0);
      const kind = idx >= 0 ? 'add' : 'steal';
      // 都占满了就顶掉最久没用的那个：新叫起来的比早就安静的更该管。
      if (idx < 0) idx = slots.reduce((m, s, i) => (s.at < slots[m].at ? i : m), 0);
      slots[idx] = { hz, level: 0, at: now };
      apply(idx);
      return kind;
    },
    /** 久未复发的坑要填回去，否则唱着唱着声音就被掏空了。 */
    release(now) {
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].level >= 0 && now - slots[i].at > cfg.releaseMs) {
          slots[i] = { hz: 0, level: -1, at: now }; apply(i);
        }
      }
    },
    active() { return slots.filter((s) => s.level >= 0).map((s) => s.hz); },
    reset(now = 0) { for (let i = 0; i < slots.length; i++) { slots[i] = { hz: 0, level: -1, at: now }; apply(i); } },
  };
}

/* ---------- 用户偏好（存浏览器本地，换台设备互不影响） ---------- */
const PREF_KEY = 'openk.prefs';
const PREF_DEFAULTS = {
  micMonitor: true,   // 默认把麦克风外放——真正的 KTV 就是插上麦就有声
  micVol: 110,        // 裸麦（关掉 AGC）电平远低于成品伴奏，得给到 1 以上才压得住
  howlGuard: true,    // 外放就必然有啸叫风险，防护默认开着
  reverb: 'ktv',
  singMode: 'inst',   // KTV 默认伴唱
  v: 2,               // 偏好版本，用来做一次性迁移
};
const prefs = (() => {
  let p;
  try { p = { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; }
  catch { return { ...PREF_DEFAULTS }; }
  // v1 时代限幅器把人声焊死在音乐的四分之一，大家只好把滑块推到顶还嫌小。
  // 限幅器修好后那些旧数值反而偏低，做一次性抬升，免得升级完还是「怎么推都小」。
  if (!(p.v >= 2)) {
    p.micVol = Math.max(Number(p.micVol) || 0, PREF_DEFAULTS.micVol);
    p.v = 2;
  }
  return p;
})();
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} }

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
  if (!Ctx) throw new Error('此浏览器不支持 Web Audio，请换用较新的浏览器');
  const actx = new Ctx({ latencyHint: 'interactive' });
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
    speakerBus, recordBus, recDest, mic: null, monitorGain: null, irCache: new Map(),
  };
  setReverb($('#reverb').value);
  applyVolumes();
  return state.audioGraph;
}

function setReverb(name) {
  const g = state.audioGraph;
  if (!g) return;
  const p = REVERB_PRESETS[name] || REVERB_PRESETS.none;
  if (!g.irCache.has(name)) g.irCache.set(name, makeIR(g.actx, p.seconds, p.decay));
  g.conv.buffer = g.irCache.get(name);
  g.wet.gain.value = p.wet;
  g.send.gain.value = p.send;
  if (g.mic) {
    g.mic.micConv.buffer = g.irCache.get(name);
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

function setAudioStatus(message = '') {
  if (state.disposed) return;
  state.audioStatus = message;
  $('#audioStatus').textContent = message;
}

function unlockAudio() {
  try {
    const g = ensureAudioGraph();
    return bounded(Promise.resolve(g.actx.state === 'suspended' ? g.actx.resume() : undefined), 8000, '音频启动超时')
      .then(() => true, () => { setAudioStatus('点击播放以启用音频'); return false; });
  } catch (e) {
    setAudioStatus(e.message || '无法启动音频');
    return Promise.resolve(false);
  }
}

function pausePlayback() {
  cancelEndedTimer();
  state.playbackGeneration++;
  state.playRequested = false;
  inst.pause();
  if (hasVocal()) { vocal.pause(); vocal.playbackRate = 1; }
  stopLyricAnimation();
}

function togglePlay() {
  if (inst.paused && !state.playRequested) startPlayback();
  else pausePlayback();
}

/** 点歌即开唱：KTV 点歌台不会让人再按一次播放键。
 *
 *  点歌那一下是用户手势，浏览器允许带声播放；但自动接下一首时没有新手势，
 *  个别浏览器会拦下来——那就提示一句，绝不能默默停在暂停状态让人干等。 */
async function startPlayback() {
  if (!inst.getAttribute('src')) return false;
  const generation = ++state.playbackGeneration;
  state.playRequested = true;
  if (!await unlockAudio() || generation !== state.playbackGeneration) {
    if (generation === state.playbackGeneration) state.playRequested = false;
    return false;
  }
  try {
    const playTrack = (element) => Promise.resolve().then(() => {
      if (generation !== state.playbackGeneration) throw new DOMException('播放已取消', 'AbortError');
      return element.play();
    });
    const plays = [playTrack(inst)];
    if (hasVocal()) {
      vocal.currentTime = inst.currentTime;
      vocal.playbackRate = 1;
      plays.push(playTrack(vocal));
    }
    let guideFailed = false;
    if (plays[1]) bounded(plays[1], 15000, '导唱载入超时').catch(() => {
      guideFailed = true;
      if (generation === state.playbackGeneration) setAudioStatus('伴奏已播放，导唱暂时不可用');
    });
    await bounded(plays[0], 15000, '音频载入超时');
    if (generation !== state.playbackGeneration) return false;
    if (!guideFailed) setAudioStatus('');
    startLyricAnimation();
    return true;
  } catch (e) {
    if (generation === state.playbackGeneration) {
      pausePlayback();
      setAudioStatus('无法播放，请点击播放重试');
      toast(e?.name === 'NotAllowedError' ? '请点一下播放按钮启用音频' : '音频载入失败，请重试');
    }
    return false;
  }
}

function seekTo(t) {
  if (!Number.isFinite(t)) return;
  cancelEndedTimer();
  const time = Math.max(0, Math.min(t, Number.isFinite(inst.duration) ? inst.duration : t));
  inst.currentTime = time;
  if (hasVocal()) { vocal.currentTime = time; vocal.playbackRate = 1; }
  state.activeLine = -1;
  updateLyrics(time);
}
function stopAudio(keepMic = false) {
  state.playbackGeneration++;
  state.playRequested = false;
  stopLyricAnimation();
  if (state.recording) stopRecording();
  state.recordingStarting = false;
  state.recordingStartGeneration++;
  // 连唱下一首时保留麦克风：每首歌都重新申请一次授权、重建音频图，
  // 中间会有一两秒没声音，唱的人会以为麦克风坏了。
  if (!keepMic) {
    $('#monitor').checked = false;
    cleanupMic();
    micHint('');
  }
  try { inst.pause(); vocal.pause(); } catch {}
  vocal.playbackRate = 1;
  inst.removeAttribute('src'); vocal.removeAttribute('src');
  inst.load(); vocal.load();
  $('#playBtn').textContent = '▶';
  state.buffering = false;
}

/* ---------- 录制 / 回放 ---------- */
function pickRecorderOptions() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const t of cands) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return { mimeType: t };
  }
  return {};
}

// 麦克风不可用时给出**准确**的原因。
// 浏览器只在安全上下文（https 或 localhost）下暴露 navigator.mediaDevices，
// 所以从局域网 IP 走 http 访问时它直接是 undefined——这跟「浏览器不支持」
// 完全是两回事，照着后者去查只会白费功夫。
function micUnavailableReason() {
  if (window.isSecureContext === false || (!window.isSecureContext && location.protocol === 'http:'
      && !['localhost', '127.0.0.1', '::1'].includes(location.hostname))) {
    return '浏览器出于隐私保护，只允许 https 或 localhost 页面使用麦克风。\n\n'
         + '当前地址是 ' + location.origin + '（不安全来源），因此麦克风被屏蔽。\n\n'
         + '解决办法：\n'
         + '· 给 openk 配上 HTTPS（python -m scripts.make_cert 生成自签证书）\n'
         + '· 或在本机用 http://localhost:' + (location.port || '8000') + ' 访问';
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return '当前浏览器不支持麦克风录制（缺少 getUserMedia）。';
  }
  return '';
}

// 建立麦克风支路（监听/录音共用，仅建一次）。需在用户手势内调用以取得授权。
function ensureMic(quiet = false) {
  if (state.audioGraph?.mic) return Promise.resolve(state.audioGraph);
  if (state.micRequest) return state.micRequest.promise;
  const pending = { deadline: performance.now() + 15000 };
  const generation = state.micGeneration;
  state.micRequest = pending;
  pending.promise = acquireMic(quiet, generation, pending).finally(() => {
    if (state.micRequest === pending) state.micRequest = null;
  });
  return pending.promise;
}

function requestMicStream(pending, generation) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishError = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    };
    const remaining = Math.max(1, pending.deadline - performance.now());
    const timer = setTimeout(() => finishError(new Error('麦克风授权等待超时，请再次点击重试')), remaining);
    pending.cancel = () => finishError(new DOMException('麦克风请求已取消', 'AbortError'));
    Promise.resolve().then(() => navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })).then((stream) => {
      if (settled || generation !== state.micGeneration || state.disposed) {
        stream.getTracks().forEach((t) => t.stop());
        finishError(new DOMException('麦克风请求已过期', 'AbortError'));
        return;
      }
      settled = true; clearTimeout(timer); resolve(stream);
    }, finishError);
  });
}

async function acquireMic(quiet, generation, pending) {
  const g = ensureAudioGraph();
  if (g.mic) return g;
  const why = micUnavailableReason();
  if (why) { micHint(why); throw new Error(why.split('\n')[0]); }
  let stream;
  try {
    if (g.actx.state === 'suspended') {
      micHint('正在启动音频引擎…');
      await bounded(g.actx.resume(), Math.min(8000, Math.max(1, pending.deadline - performance.now())),
        '音频引擎启动超时，请点击播放后重试');
    }
    if (generation !== state.micGeneration) throw new DOMException('麦克风请求已取消', 'AbortError');
    micHint('正在连接麦克风，请检查浏览器授权提示（最多等待15秒）');
    stream = await requestMicStream(pending, generation);
  } catch (e) {
    if (generation !== state.micGeneration) throw new DOMException('麦克风请求已取消', 'AbortError');
    if (e.name === 'AbortError') throw e;
    const msg = '麦克风连接失败：' + (e.message || e);
    micHint(msg);
    if (!quiet) toast(msg);
    throw e;
  }
  state.micStream = stream;

  // 麦克风支路：始终进「录音总线」；勾选“耳机监听”后经 monitorGain 进扬声器（建议戴耳机防啸叫）。
  const micSrc = g.actx.createMediaStreamSource(stream);
  const micGain = g.actx.createGain();
  const micDry = g.actx.createGain();
  const micSend = g.actx.createGain();
  const micConv = g.actx.createConvolver();
  const micWet = g.actx.createGain();
  const monitorGain = g.actx.createGain();
  monitorGain.gain.value = 0;
  // 外放时麦克风必然会拾到音箱里的声音，形成正反馈。限幅器压不住成因，但能
  // 把啸叫锁在「难听」而不是「刺耳到伤耳朵」的范围内，是外放的必要保险。
  //
  // 注意阈值别设太低：伴奏是直连 speakerBus 的，只有麦克风这一路过限幅器。
  // 早先 -12dB/20:1/硬拐点等于给人声焊了堵砖墙，峰值被摁在音乐的四分之一，
  // 滑块推到头也顶不动。现在只拦真正的峰值，正常演唱原样放过。
  const limiter = g.actx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;
  // 限幅必然削掉一截响度，补偿回来，否则「限幅器一开人声就沉下去」。
  const micMakeup = g.actx.createGain();
  micMakeup.gain.value = MIC_MAKEUP;

  micSrc.connect(micGain);
  micGain.connect(micDry); micDry.connect(g.recordBus);
  micGain.connect(micSend); micSend.connect(micConv); micConv.connect(micWet); micWet.connect(g.recordBus);
  micDry.connect(monitorGain); micWet.connect(monitorGain);

  // 防啸叫只挂在监听支路上，不碰录音总线：陷波和急掐都是为了断开
  // 「音箱→麦克风」这个环路，环路一断，麦克风自然也就不再拾到啸叫，
  // 录音跟着就干净了。反过来若挖在录音路上，一旦误判就是永久性损伤。
  const bank = makeNotchBank(g.actx);
  const howlDuck = g.actx.createGain();
  monitorGain.connect(bank.input);
  bank.output.connect(howlDuck);
  howlDuck.connect(limiter); limiter.connect(micMakeup); micMakeup.connect(g.speakerBus);

  // 分析点取在 micGain 之后：这里听到的就是送去放大的东西，
  // 麦克风推子拉到 0 时自然什么也测不到，不会空转误报。
  const analyser = g.actx.createAnalyser();
  analyser.fftSize = 4096;          // 48kHz 下每格约 11.7Hz，够窄的陷波定位
  analyser.smoothingTimeConstant = 0; // 要看瞬时涨势，不能被平滑抹平
  micGain.connect(analyser);

  g.mic = { micSrc, micGain, micDry, micSend, micConv, micWet };
  g.monitorGain = monitorGain;
  g.limiter = limiter;
  g.micMakeup = micMakeup;
  g.howl = {
    analyser, bank, duck: howlDuck,
    spec: new Float32Array(analyser.frequencyBinCount),
    tracker: makeHowlTracker(),
    binHz: g.actx.sampleRate / analyser.fftSize,
    hits: [], ducked: false, lastAt: 0, raf: 0,
  };
  startHowlGuard();
  micGain.gain.value = prefs.micVol / 100;
  const p = REVERB_PRESETS[$('#reverb').value] || REVERB_PRESETS.none;
  micConv.buffer = g.conv.buffer || makeIR(g.actx, p.seconds, p.decay);
  micWet.gain.value = p.wet; micSend.gain.value = p.send;
  applyMonitorState();
  return g;
}

function micHint(msg) {
  const el = $('#micHint');
  if (el) el.textContent = msg || '';
}

function howlHint(msg) {
  const el = $('#howlHint');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

const fmtHz = (hz) => (hz >= 1000 ? (hz / 1000).toFixed(1) + 'k' : Math.round(hz)) + 'Hz';

/** 走一帧防啸叫：测 → 判 → 挖坑 →（按不住就）急掐 → 平静后慢慢还回来。
 *  拆成纯粹按 now 推进的一步，方便脱离 rAF 和真实音频直接测。 */
function howlTick(g, now, cfg = HOWL) {
  const h = g && g.howl;
  if (!h) return null;
  // 没外放就没有「音箱→麦克风」这个环路，也就不可能啸叫，不必空转做 FFT。
  if (g.monitorGain && !(g.monitorGain.gain.value > 0)) { h.tracker.reset(); return null; }
  h.analyser.getFloatFrequencyData(h.spec);
  const confirmed = h.tracker.push(findHowlPeak(h.spec, h.binHz, cfg));
  let acted = null;
  if (confirmed) {
    h.bank.engage(confirmed.hz, now);
    h.lastAt = now;
    h.hits = h.hits.filter((t) => now - t < cfg.burstMs);
    h.hits.push(now);
    acted = confirmed;
    // 陷波挖了还照叫，说明环路增益高得离谱（麦克风基本贴在音箱上了），
    // 或者共振点在不停乱窜。这时候只能直接把监听掐小——难听一下下，
    // 总好过一屋子人捂耳朵。
    if (!h.ducked && h.hits.length >= cfg.burstHits) {
      h.ducked = true;
      rampParam(h.duck.gain, cfg.duckTo, cfg.duckMs, g.actx);
    }
    const hz = h.bank.active().map(fmtHz).join('、');
    howlHint(h.ducked ? `⚠️ 啸叫压不住，已临时调小外放（${hz}）——请把麦克风拿远离音箱`
                      : `🔇 已自动压掉啸叫 ${hz}`);
  }
  h.bank.release(now);
  if (h.ducked && now - h.lastAt > cfg.holdMs) {
    h.ducked = false;
    h.hits = [];
    rampParam(h.duck.gain, 1, cfg.recoverMs, g.actx);
    howlHint('');
  } else if (!h.ducked && h.lastAt && now - h.lastAt > cfg.releaseMs) {
    h.lastAt = 0;
    howlHint('');
  }
  return acted;
}

function startHowlGuard() {
  const g = state.audioGraph;
  if (!g || !g.howl || g.howl.raf) return;
  const loop = () => {
    const h = state.audioGraph && state.audioGraph.howl;
    if (!h || !h.raf || document.hidden || state.disposed) { if (h) h.raf = 0; return; }
    // 关掉开关就只是停止判定，链路照旧——陷波要先复位，
    // 免得把上一轮挖的坑留在声音里。
    if (prefs.howlGuard) howlTick(state.audioGraph, performance.now());
    else if (h.bank.active().length || h.ducked) resetHowlGuard();
    h.raf = requestAnimationFrame(loop);
  };
  g.howl.raf = requestAnimationFrame(loop);
}

function resetHowlGuard() {
  const h = state.audioGraph && state.audioGraph.howl;
  if (!h) return;
  h.bank.reset(performance.now());
  h.tracker.reset();
  h.hits = []; h.lastAt = 0;
  if (h.ducked) { h.ducked = false; rampParam(h.duck.gain, 1, 200, state.audioGraph.actx); }
  howlHint('');
}

/** 开唱时按偏好自动把麦克风外放接上。
 *  必须在用户手势（点播放 / 点歌）之后调用，否则浏览器不给授权。 */
async function autoEnableMic() {
  if (!prefs.micMonitor || state.disposed) return;
  const box = $('#monitor');
  if (!box) return;
  box.checked = true;
  if (document.hidden || state.monitorHidden) {
    state.monitorHidden = true;
    applyMonitorState();
    return;
  }
  const generation = state.micGeneration;
  try {
    await ensureMic(true);
    if (generation === state.micGeneration) applyMonitorState();
  } catch (e) {
    if (generation === state.micGeneration && e.name !== 'AbortError') box.checked = false;
  }
}

function applyMonitorState() {
  const g = state.audioGraph;
  const requested = prefs.micMonitor && $('#monitor').checked;
  const muted = document.hidden || state.monitorHidden;
  if (document.hidden && requested) state.monitorHidden = true;
  if (g?.monitorGain) {
    if (requested && !muted) {
      startHowlGuard();
      rampParam(g.monitorGain.gain, MONITOR_GAIN, 150, g.actx);
    } else {
      g.monitorGain.gain.cancelScheduledValues?.(g.actx.currentTime);
      g.monitorGain.gain.value = 0;
    }
  }
  $('#resumeMonitor').classList.toggle('hidden', !requested || !state.monitorHidden || document.hidden);
  if (requested && muted) micHint('页面切到后台，麦克风外放已暂停；返回后点击恢复。录音不受影响。');
  else if (requested && g?.mic) micHint(prefs.howlGuard ? '麦克风已接通 · 防啸叫已开启，建议使用耳机' : '麦克风已接通 · 防啸叫已关闭，请谨慎外放');
  else if (!requested) micHint('麦克风外放已关闭');
}

// 仅在既不监听也不录音时释放麦克风。
function maybeReleaseMic() {
  if (state.recording || state.recordingStarting || $('#monitor').checked) return;
  cleanupMic();
}

async function startRecording() {
  if (state.recording || state.recordingStarting) return;
  if (!inst.getAttribute('src')) { alert('请先选择一首歌'); return; }
  const why = micUnavailableReason();
  if (why) { micHint(why); $('#recStatus').textContent = '麦克风不可用'; return; }
  if (!window.MediaRecorder) { $('#recStatus').textContent = '当前浏览器不支持录音（缺少 MediaRecorder）'; return; }
  const jobId = state.currentJobId, generation = state.selectionGeneration;
  const startGeneration = ++state.recordingStartGeneration;
  state.recordingStarting = true;
  $('#recBtn').disabled = true;
  $('#recBtn').textContent = '准备录音…';
  $('#recStatus').textContent = '正在连接麦克风，请在浏览器中允许访问…';
  let session;
  try {
    const g = await ensureMic();
    if (!isCurrentPlayer(jobId, generation) || startGeneration !== state.recordingStartGeneration || !state.recordingStarting) return;
    if (!await unlockAudio() || !isCurrentPlayer(jobId, generation)) return;
    const mr = new MediaRecorder(g.recDest.stream, pickRecorderOptions());
    session = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      jobId, title: songInfo(jobById(jobId) || {}).title, generation,
      mr, chunks: [], startedAt: Date.now(), stoppedAt: null, blob: null,
      status: 'recording', error: '', uploadPromise: null, objectUrl: null,
    };
    mr.ondataavailable = (e) => { if (!session.finalized && e.data?.size) session.chunks.push(e.data); };
    mr.onerror = () => {
      session.interrupted = true;
      session.error = '录制中断，正在保留已录下的音频';
      if (state.recordingSession === session) stopRecording();
    };
    mr.onstop = async () => {
      if (session.cancelled || session.finalized) return;
      session.finalized = true;
      session.stoppedAt ??= Date.now();
      session.duration = Math.max(0, (session.stoppedAt - session.startedAt) / 1000);
      session.blob = new Blob(session.chunks, { type: mr.mimeType || session.chunks[0]?.type || 'audio/webm' });
      session.chunks = [];
      if (state.recordingSession === session) {
        state.recording = false; state.recordingSession = null; state.recorder = null;
        clearInterval(state.recTimer);
        resetRecordButton();
      }
      state.pendingRecordings.set(session.id, session);
      if (!session.blob.size) {
        session.status = 'error'; session.error = '没有捕获到音频，请检查麦克风后重试';
        renderPendingRecordings();
      } else await uploadRecording(session);
      maybeReleaseMic();
    };
    seekTo(0);
    state.recordingSession = session;
    state.recorder = mr;
    state.recStart = session.startedAt;
    mr.start(1000);
    state.recording = true;
    $('#recBtn').disabled = false;
    $('#recBtn').textContent = '⏹ 停止并保存';
    $('#recBtn').classList.add('recording');
    if (!await startPlayback() || !isCurrentPlayer(jobId, generation)) {
      session.cancelled = true;
      if (state.recordingSession === session) stopRecording();
      return;
    }
    $('#recBtn').textContent = '⏹ 停止并保存';
    $('#recBtn').classList.add('recording');
    state.recTimer = setInterval(() => {
      if (state.recordingSession === session) $('#recStatus').textContent = '● 录制中 ' + fmt((Date.now() - session.startedAt) / 1000);
    }, 250);
  } catch (e) {
    if (session && state.recordingSession === session) {
      session.cancelled = true;
      stopRecording();
      state.recordingSession = null;
      state.recorder = null;
      resetRecordButton();
    }
    if (isCurrentPlayer(jobId, generation)) $('#recStatus').textContent = e.message || '无法开始录音';
  } finally {
    if (startGeneration === state.recordingStartGeneration) {
      state.recordingStarting = false;
      $('#recBtn').disabled = false;
      if (!state.recording) resetRecordButton();
    }
    maybeReleaseMic();
  }
}

function resetRecordButton() {
  $('#recBtn').disabled = false;
  $('#recBtn').textContent = '🎤 开始录唱';
  $('#recBtn').classList.remove('recording');
}

function stopRecording() {
  const session = state.recordingSession;
  if (!session || !state.recording) return;
  state.recording = false;
  state.recordingSession = null;
  state.recorder = null;
  session.stoppedAt = Date.now();
  clearInterval(state.recTimer);
  pausePlayback();
  try { session.mr.stop(); } catch {
    session.error = '录音已中断';
    session.mr.onstop();
  }
  resetRecordButton();
  $('#recStatus').textContent = session.cancelled ? '录制未开始，请重试播放' : '正在整理录音…';
  $('#playBtn').textContent = '▶';
  maybeReleaseMic();
}

function cleanupMic() {
  state.micGeneration++;
  state.micRequest?.cancel?.();
  state.micRequest = null;
  const g = state.audioGraph;
  if (state.micStream) { state.micStream.getTracks().forEach((t) => t.stop()); state.micStream = null; }
  if (g && g.howl) {
    if (g.howl.raf) cancelAnimationFrame(g.howl.raf);
    g.howl.raf = 0;
    try { [g.howl.analyser, g.howl.duck, ...g.howl.bank.filters].forEach((n) => n.disconnect && n.disconnect()); } catch {}
    g.howl = null;
    howlHint('');
  }
  if (g && g.mic) {
    try { Object.values(g.mic).forEach((n) => n.disconnect && n.disconnect()); } catch {}
    g.mic = null;
  }
  if (g && g.monitorGain) { try { g.monitorGain.disconnect(); } catch {} g.monitorGain = null; }
  if (g) {
    for (const name of ['limiter', 'micMakeup']) {
      try { g[name]?.disconnect(); } catch {}
      g[name] = null;
    }
  }
}

function uploadRecording(session) {
  if (session.uploadPromise) return session.uploadPromise;
  session.status = 'uploading';
  session.error = '';
  renderPendingRecordings();
  session.uploadPromise = (async () => {
    try {
      const r = await fetchResponse(`/api/jobs/${encodeURIComponent(session.jobId)}/recordings?duration=${session.duration.toFixed(1)}`, {
        method: 'POST',
        headers: { 'Content-Type': session.blob.type || 'audio/webm' },
        body: session.blob,
      }, 120000);
      if (!r.ok) throw new Error(`保存失败（HTTP ${r.status}）`);
      session.status = 'saved';
      state.pendingRecordings.delete(session.id);
      if (session.objectUrl) URL.revokeObjectURL(session.objectUrl);
      session.objectUrl = null;
      if (!state.disposed && state.currentJobId === session.jobId) {
        if (!state.recording && !state.recordingStarting) $('#recStatus').textContent = session.interrupted ? '录音中断，已保存可用片段 ✓' : '已保存 ✓';
        loadRecordings(session.jobId);
      }
      return true;
    } catch (e) {
      session.status = 'error';
      session.error = e.message || '保存失败，请重试或下载';
      if (!state.disposed && state.currentJobId === session.jobId && !state.recording) $('#recStatus').textContent = '保存失败，录音仍保留在本页';
      return false;
    } finally {
      session.uploadPromise = null;
      renderPendingRecordings();
    }
  })();
  return session.uploadPromise;
}

function renderPendingRecordings() {
  if (state.disposed) return;
  const list = $('#pendingRecordings');
  list.replaceChildren();
  state.pendingRecordings.forEach((session) => {
    const row = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = `${session.title} · ${session.status === 'uploading' ? '正在保存…' : session.error}`;
    row.appendChild(title);
    if (session.blob?.size) {
      if (!session.objectUrl && URL.createObjectURL) session.objectUrl = URL.createObjectURL(session.blob);
      if (session.objectUrl) {
        const download = document.createElement('a');
        download.href = session.objectUrl;
        download.download = `openk-${session.jobId}.${session.blob.type.includes('mp4') ? 'm4a' : session.blob.type.includes('ogg') ? 'ogg' : 'webm'}`;
        download.textContent = '下载备份';
        row.appendChild(download);
      }
      const retry = document.createElement('button');
      retry.className = 'lyr-btn';
      retry.textContent = '重试保存';
      retry.disabled = session.status === 'uploading';
      retry.addEventListener('click', () => uploadRecording(session));
      row.appendChild(retry);
    }
    list.appendChild(row);
  });
  $('#pendingRecordingsWrap').classList.toggle('hidden', state.pendingRecordings.size === 0);
}

async function loadRecordings(jobId) {
  if (state.disposed || state.currentJobId !== jobId) return;
  const generation = ++state.recordingsGeneration;
  const selection = state.selectionGeneration;
  state.recordingsRequest?.abort();
  const request = new AbortController();
  state.recordingsRequest = request;
  try {
    const recs = await api.listRecordings(jobId, { signal: request.signal });
    if (isCurrentPlayer(jobId, selection) && generation === state.recordingsGeneration && !request.signal.aborted) {
      renderRecordings(recs, jobId);
    }
  } catch (e) {
    if (isCurrentPlayer(jobId, selection) && generation === state.recordingsGeneration && e.name !== 'AbortError') {
      $('#recListStatus').textContent = '历史录音暂时无法更新，请稍后重试';
    }
  } finally {
    if (state.recordingsRequest === request) state.recordingsRequest = null;
  }
}

function renderRecordings(recs, jobId = state.currentJobId) {
  const wrap = $('#recListWrap');
  const ul = $('#recList');
  ul.innerHTML = '';
  $('#recListStatus').textContent = '';
  if (!recs || !recs.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  recs.slice().reverse().forEach((r) => {
    const li = document.createElement('li');
    const when = r.created_at ? new Date(r.created_at * 1000).toLocaleString() : '';
    li.innerHTML = `
      <audio controls preload="none" src="${escapeHtml(r.url)}" aria-label="录音回放"></audio>
      <div class="rec-meta">
        <span>${when}</span>
        <span class="muted small">${r.duration ? fmt(r.duration) : ''}</span>
      </div>
      <a class="dl" href="${escapeHtml(r.url)}" download title="下载" aria-label="下载录音">⬇</a>
      <button class="rdel" title="删除">✕</button>`;
    li.querySelector('.rdel').addEventListener('click', async () => {
      if (!confirm('删除这条录音？')) return;
      try {
        await api.deleteRecording(jobId, r.file);
        if (state.currentJobId === jobId) loadRecordings(jobId);
      } catch (e) { toast(e.message || '删除失败'); }
    });
    li.querySelector('audio').addEventListener('play', (e) => {
      if (state.recording) stopRecording();
      pausePlayback();
      ul.querySelectorAll('audio').forEach((audio) => { if (audio !== e.target) audio.pause(); });
    });
    ul.appendChild(li);
  });
}

/* ---------- 播放器事件绑定 ---------- */
function bindPlayer() {
  $('#playBtn').addEventListener('click', togglePlay);

  inst.addEventListener('play', () => {
    $('#playBtn').textContent = '⏸';
    $('#playBtn').setAttribute('aria-label', '暂停');
    $('#nbPlay').setAttribute('aria-label', '暂停');
    startLyricAnimation();
  });
  inst.addEventListener('pause', () => {
    $('#playBtn').textContent = '▶';
    $('#playBtn').setAttribute('aria-label', '播放');
    $('#nbPlay').setAttribute('aria-label', '播放');
    stopLyricAnimation();
  });
  inst.addEventListener('loadedmetadata', () => { $('#durTime').textContent = fmt(inst.duration); });
  for (const event of ['waiting', 'stalled']) {
    inst.addEventListener(event, () => {
      if (!state.currentJobId) return;
      state.buffering = true;
      setAudioStatus('音频缓冲中…');
      if (hasVocal()) vocal.pause();
    });
  }
  inst.addEventListener('playing', () => {
    const wasBuffering = state.buffering;
    state.buffering = false;
    setAudioStatus('');
    if (wasBuffering && hasVocal()) {
      const generation = state.playbackGeneration;
      vocal.currentTime = inst.currentTime;
      vocal.playbackRate = 1;
      Promise.resolve().then(() => {
        if (generation === state.playbackGeneration) return vocal.play();
      }).catch(() => {
        if (generation === state.playbackGeneration) setAudioStatus('伴奏已恢复，导唱暂时不可用');
      });
    }
    startLyricAnimation();
  });
  inst.addEventListener('error', () => {
    if (!inst.getAttribute('src')) return;
    pausePlayback();
    setAudioStatus('音频无法载入，请重新点歌或检查网络');
  });
  inst.addEventListener('ended', () => {
    if (state.recording) stopRecording();
    state.playRequested = false;
    $('#playBtn').textContent = '▶';
    if (hasVocal()) vocal.pause();
  });

  inst.addEventListener('timeupdate', () => {
    const t = inst.currentTime;
    $('#curTime').textContent = fmt(t);
    if (inst.duration) $('#seek').value = Math.round((t / inst.duration) * 1000);
    $('#seek').setAttribute('aria-valuetext', `${fmt(t)} / ${fmt(inst.duration)}`);
    // 纠正双轨漂移
    if (hasVocal() && !vocal.paused && !inst.paused && !state.buffering
        && !inst.seeking && !vocal.seeking && inst.readyState >= 2 && vocal.readyState >= 2
        && performance.now() - state.lastSyncAt >= 500) {
      state.lastSyncAt = performance.now();
      const drift = vocal.currentTime - t;
      if (Math.abs(drift) > 0.75) { vocal.currentTime = t; vocal.playbackRate = 1; }
      else vocal.playbackRate = Math.abs(drift) > 0.08 ? (drift > 0 ? 0.99 : 1.01) : 1;
    }
    if (!state.lyricRaf && !document.hidden && !$('#stage').classList.contains('hidden')) updateLyrics(t);
  });

  $('#seek').addEventListener('input', (e) => {
    if (!inst.duration) return;
    const t = (e.target.value / 1000) * inst.duration;
    seekTo(t);
    $('#curTime').textContent = fmt(t);
    $('#seek').setAttribute('aria-valuetext', `${fmt(t)} / ${fmt(inst.duration)}`);
    updateLyrics(t);
  });

  $('#instVol').addEventListener('input', applyVolumes);
  $('#vocalVol').addEventListener('input', applyVolumes);
  $('#reverb').value = prefs.reverb;
  $('#reverb').addEventListener('change', () => {
    prefs.reverb = $('#reverb').value;
    savePrefs();
    setReverb(prefs.reverb);
  });
  $('#editLyrics').addEventListener('click', enterLyricsEdit);
  $('#saveLyrics').addEventListener('click', saveLyricsEdit);
  $('#cancelLyrics').addEventListener('click', exitLyricsEdit);
  $('#searchLyrics').addEventListener('click', () => toggleLyricSearch());
  $('#lsGo').addEventListener('click', doLyricSearch);
  $('#lsClose').addEventListener('click', () => toggleLyricSearch(false));
  $('#lsQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLyricSearch(); });
  $('#recBtn').addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
  $('#micVol').value = prefs.micVol;
  const showMicVol = () => { $('#micVolVal').textContent = prefs.micVol + '%'; };
  showMicVol();
  $('#micVol').addEventListener('input', (e) => {
    prefs.micVol = Number(e.target.value);
    savePrefs();
    showMicVol();
    const g = state.audioGraph;
    if (g && g.mic) g.mic.micGain.gain.value = prefs.micVol / 100;
  });

  $('#monitor').checked = prefs.micMonitor;
  $('#monitor').addEventListener('change', async () => {
    const on = $('#monitor').checked;
    prefs.micMonitor = on;
    savePrefs();
    if (on) state.monitorHidden = false;
    const generation = state.micGeneration;
    if (on) {
      // 勾选即请求麦克风并接入监听，无需先点“开始录唱”。
      try { await ensureMic(); } catch (e) {
        if (generation === state.micGeneration && e.name !== 'AbortError') $('#monitor').checked = false;
        return;
      }
    }
    applyMonitorState();
    if (!on) maybeReleaseMic();
  });
  $('#resumeMonitor').addEventListener('click', async () => {
    if (document.hidden || !prefs.micMonitor) return;
    try {
      await ensureMic();
      if (!document.hidden && prefs.micMonitor) {
        state.monitorHidden = false;
        applyMonitorState();
      }
    } catch { micHint('麦克风未能恢复，请检查授权后重试'); }
  });

  const hg = $('#howlGuard');
  if (hg) {
    hg.checked = prefs.howlGuard;
    hg.addEventListener('change', () => {
      prefs.howlGuard = hg.checked;
      savePrefs();
      if (!hg.checked) resetHowlGuard();
      howlHint(hg.checked ? '' : '⚠️ 防啸叫已关闭，麦克风离音箱近了会尖叫');
    });
  }

}

function interactiveTarget(target) {
  return target?.closest?.('input, textarea, select, button, a, [contenteditable], [role="button"]');
}

function handleKeys(e) {
  const drawer = !$('#queuePanel').classList.contains('hidden') ? $('#queuePanel')
    : !$('#adminPanel').classList.contains('hidden') ? $('#adminPanel') : null;
  if (drawer) {
    if (e.key === 'Escape') { e.preventDefault(); closeDrawers(); return; }
    if (e.key === 'Tab') {
      const controls = [...drawer.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')]
        .filter((el) => !el.disabled && !el.closest('.hidden') && !el.hidden);
      const first = controls[0], last = controls[controls.length - 1];
      if (first && (!drawer.contains(document.activeElement) || (e.shiftKey && document.activeElement === first))) {
        e.preventDefault(); (e.shiftKey ? last : first).focus();
      } else if (last && !e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || interactiveTarget(e.target)) return;
  if (e.code === 'Space' && state.currentJobId) { e.preventDefault(); togglePlay(); }
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
}

/* ---------------- 初始化 ---------------- */
function init() {
  loadQueue();

  /* 顶部：搜索 / 已点 / 后台 */
  let composing = false;
  const onSearch = (event) => {
    if (composing || event?.isComposing) return;
    state.search = $('#search').value;
    $('#searchClear').classList.toggle('hidden', !state.search);
    renderBrowse();
  };
  $('#search').addEventListener('input', onSearch);
  $('#search').addEventListener('compositionstart', () => { composing = true; });
  $('#search').addEventListener('compositionend', () => { composing = false; onSearch(); });
  $('#searchClear').addEventListener('click', () => { composing = false; $('#search').value = ''; onSearch(); $('#search').focus(); });
  $('#homeBtn').addEventListener('click', () => { closeDrawers(); showBrowse(); });   // 只切视图，歌照唱
  $('#backBtn').addEventListener('click', showBrowse);
  $('#queueBtn').addEventListener('click', () => openDrawer('queue'));
  $('#adminBtn').addEventListener('click', () => openDrawer('admin'));
  $('#queueClose').addEventListener('click', closeDrawers);
  $('#adminClose').addEventListener('click', closeDrawers);
  $('#scrim').addEventListener('click', closeDrawers);
  $('#queueClear').addEventListener('click', () => {
    if (!state.queue.length || !confirm('清空已点歌曲？')) return;
    state.queue = []; saveQueue(); renderQueue(); renderBrowse();
  });

  /* 分类页签 */
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.libMode = btn.dataset.tab;
      state.artistPick = null;
      document.querySelectorAll('.tab').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      renderBrowse(true);
    });
  });

  /* 曲库网格：整卡点一下就是点歌，右下角 ▶ 是「插队马上唱」 */
  $('#grid').addEventListener('click', (e) => {
    const card = e.target.closest('.song-card');
    if (!card) return;
    addToQueue(card.dataset.id, e.target.dataset.act === 'play');
  });
  $('#artistList').addEventListener('click', (e) => {
    const chip = e.target.closest('.artist-chip');
    if (!chip) return;
    state.artistPick = chip.dataset.artist;
    state.artistLabel = chip.querySelector('span').textContent;
    renderBrowse(true);
  });

  /* 已点列表：置顶 / 删除 / 直接唱 */
  $('#queueList').addEventListener('click', (e) => {
    const li = e.target.closest('.q-item');
    if (!li) return;
    const act = e.target.dataset.act;
    if (act === 'top') topQueue(li.dataset.id);
    else if (act === 'del') removeFromQueue(li.dataset.id);
    else { closeDrawers(); addToQueue(li.dataset.id, true); }
  });

  /* 后台：添加歌曲 */
  $('#go').addEventListener('click', onCreate);
  $('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') onCreate(); });
  // 换了链接就重新问一次「要不要批量导入」
  $('#url').addEventListener('input', () => { state.plAsked = false; });
  $('#plGo').addEventListener('click', openPlaylist);
  $('#lcGo').addEventListener('click', openLocal);
  $('#plClose').addEventListener('click', () => $('#plPanel').classList.add('hidden'));
  $('#plImport').addEventListener('click', onPickerImport);
  $('#plAll').addEventListener('change', (e) => {
    document.querySelectorAll('.pl-pick:not(:disabled)')
      .forEach((c) => { c.checked = e.target.checked; });
  });
  $('#plList').addEventListener('change', (e) => {
    if (e.target.classList.contains('pl-pick')) syncPlAll();
  });
  $('#procList').addEventListener('click', async (e) => {
    const li = e.target.closest('.proc-item');
    if (!li) return;
    if (e.target.dataset.act === 'retry') {
      try { await api.retryJob(li.dataset.id); await refreshList(true); }
      catch (err) { alert(err.message || '重试失败'); }
    } else {
      showProgress(state.allJobs.find((j) => j.id === li.dataset.id) || {});
      startPolling(li.dataset.id);
    }
  });

  /* 曲库视图切换 + 语种筛选 */
  $('#viewToggle').addEventListener('click', () => {
    state.view = state.view === 'list' ? 'grid' : 'list';
    $('#viewToggle').textContent = state.view === 'list' ? '封面视图' : '列表视图';
    prefs.view = state.view; savePrefs();
    renderBrowse(true);
  });
  $('#songList').addEventListener('click', (e) => {
    const row = e.target.closest('.song-row');
    if (row) addToQueue(row.dataset.id);
  });
  $('#langBar').addEventListener('click', (e) => {
    const b = e.target.closest('.lang-btn');
    if (!b) return;
    state.lang = b.dataset.lang;
    $('#langBar').dataset.sig = '';      // 强制重画选中态
    renderBrowse(true);
  });

  /* 常驻控制条 */
  $('#nbOpen').addEventListener('click', () => { if (state.currentJobId) showStage(); });
  $('#nbCover').addEventListener('click', () => { if (state.currentJobId) showStage(); });
  $('#nbPlay').addEventListener('click', () => { togglePlay(); renderNowBar(); });
  $('#nbReplay').addEventListener('click', () => { seekTo(0); if (inst.paused) togglePlay(); renderNowBar(); });
  $('#nbSkip').addEventListener('click', () => {
    if (state.queue.length) playFromQueue();
    else { toast('已点列表空了，没有下一首'); endPlayback(); }
  });
  $('#nbQueue').addEventListener('click', () => openDrawer('queue'));
  $('#modeInst').addEventListener('click', () => setSingMode('inst'));
  $('#modeOrig').addEventListener('click', () => setSingMode('orig'));
  state.singMode = prefs.singMode;
  state.view = prefs.view || 'list';
  $('#viewToggle').textContent = state.view === 'list' ? '封面视图' : '列表视图';

  bindPlayer();
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(measureNowBar);
    observer.observe($('#nowbar'));
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }
  window.addEventListener('resize', measureNowBar);
  inst.addEventListener('play', renderNowBar);
  inst.addEventListener('pause', renderNowBar);
  // 一首唱完自动接下一首，这是 KTV 机器最基本的行为
  inst.addEventListener('ended', () => {
    cancelEndedTimer();
    const generation = state.selectionGeneration, id = state.currentJobId;
    state.endedTimer = setTimeout(() => {
      state.endedTimer = null;
      if (id && isCurrentPlayer(id, generation)) playFromQueue(true);
    }, 800);
  });
  document.addEventListener('keydown', handleKeys);

  refreshList(true);
  resumeAlignments();
  if (location.pathname.replace(/\/+$/, '') === '/admin') openDrawer('admin');
  // 繁简对照表跟曲库走，晚一步到也没关系——到了就把检索字段重算一遍。
  loadZhMap().then(() => renderBrowse(true));
  // 本地导入默认关闭（部署者不配白名单目录就当没这功能），所以入口按服务端答复决定显隐。
  api.localStatus().then((s) => {
    if (s.enabled) $('#lcGo').classList.remove('hidden');
  }).catch(() => {});
  // 后台自适应刷新列表：有运行中任务时 3s，全部空闲时放慢到 15s；
  // 页面不可见、或正在逐帧轮询单个任务时跳过，避免无谓请求刷屏。
  const scheduleListRefresh = () => {
    if (state.disposed) return;
    if (state.listTimer) clearTimeout(state.listTimer);
    const busy = state.allJobs.some((j) => j.state === 'running' || j.state === 'queued');
    state.listTimer = setTimeout(async () => {
      // finally 保证无论如何都续上下一轮，否则页面会静默停更、只能手动刷新。
      try {
        if (!state.pollTimer && !state.pollRequest && !document.hidden) await refreshList();
      } catch (e) {
        console.error('刷新列表失败', e);
      } finally {
        scheduleListRefresh();
      }
    }, busy ? 3000 : 15000);
  };
  scheduleListRefresh();
  // 息屏/切走时浏览器会暂停定时器，回来后立刻补一次并重新排期，
  // 免得长时间挂着的标签页显示的是过期曲库。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopLyricAnimation();
      applyMonitorState();
      const h = state.audioGraph?.howl;
      if (h?.raf) { cancelAnimationFrame(h.raf); h.raf = 0; }
      state.pollRequest?.abort();
      state.alignmentRequests.forEach((r) => r.abort());
    } else {
      if (!state.inspectedJobId) refreshList();
      else startPolling(state.inspectedJobId);
      scheduleListRefresh();
      state.activeLine = -1;
      if (!$('#stage').classList.contains('hidden')) updateLyrics(inst.currentTime);
      startLyricAnimation();
      applyMonitorState();
      Object.keys(state.alignmentOperations).forEach((jobId) => {
        if (alignmentBusy(jobId)) scheduleAlignment(jobId, 0);
      });
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.recording || state.recordingStarting || state.pendingRecordings.size) {
      e.preventDefault(); e.returnValue = '';
    }
  });
  window.addEventListener('pagehide', (e) => {
    if (state.recording) stopRecording();
    pausePlayback();
    cleanupMic();
    invalidateSelection();
    state.monitorHidden = prefs.micMonitor;
    if (!e.persisted) {
      state.disposed = true;
      stopPolling();
      clearTimeout(state.listTimer);
      state.alignmentTimers.forEach(clearTimeout);
      state.alignmentRequests.forEach((r) => r.abort());
      state.audioGraph?.actx.close?.();
    }
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) { applyMonitorState(); scheduleListRefresh(); }
  });
}

document.addEventListener('DOMContentLoaded', init);
