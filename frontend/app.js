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
  deleteJob(id, { failedOnly = false } = {}) {
    return fetchJSON('/api/jobs/' + encodeURIComponent(id) + (failedOnly ? '?failed_only=true' : ''),
      { method: 'DELETE' });
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
  lyricsRequestUrl: null,
  lyricsRetryAt: 0,
  recordingsGeneration: 0,
  recordingsRequest: null,
  pollGeneration: 0,
  pollRequest: null,
  listRequest: null,
  listForce: false,
  deletingJobs: new Set(),
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
  lyricEdit: null,
  lyricsUrl: null,   // 当前歌词 json 地址（保存后重新拉取）
  currentTitle: '',  // 当前歌曲标题（用于搜歌词预填）
  libMode: 'all',
  browseLetter: '',
  browsePage: 1,
  artistReturn: null,
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
const libraryPopularity = OpenKLibrary.createPopularity(() => {
  if (!state.disposed) renderBrowse();
});
function libraryAccountId() { return room.account?.enabled ? room.account.user?.id || null : null; }
function refreshPopularity(force = false) {
  return state.libMode === 'popular' && !state.disposed
    ? libraryPopularity.load(libraryAccountId(), force) : Promise.resolve();
}

/* ---------------- 曲库 ---------------- */
const STATE_TEXT = { queued: '排队中', running: '处理中', done: '已完成', error: '失败', cancelled: '已取消' };
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
      const current = jobs.find(j => j.id === state.currentJobId && j.state === 'done');
      if (current) refreshPlayerLyrics(current.id, current.media?.lyrics || null);
      $('#catalogStatus').textContent = '';
      $('#catalogStatus').classList.add('hidden');
      renderBrowse(state.listForce);
      renderProcessing();
      renderQueue();
      refreshPopularity();
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
      ${songPopularity(j)}
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
      ${noLyrics(j) ? '<span class="sr-nolrc" title="此源没有歌词，只有伴奏">无词</span>' : ''}
      ${songPopularity(j)}</span>
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

function songPopularity(job) {
  const count = state.libMode === 'popular' && !librarySearch.query(state.search).text
    ? libraryPopularity.state.songs.get(job.id)?.play_count : 0;
  return count ? `<span class="catalog-plays">播放 ${count} 次</span>` : '';
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
  const accountId = libraryAccountId();
  libraryPopularity.forAccount(accountId);
  $('[data-tab="popular"]').hidden = !accountId;
  renderLangBar(all);
  let list = all;
  if (state.lang) list = list.filter((j) => songInfo(j).lang === state.lang);
  if (kw) list = librarySearch.search(list, query);

  const grid = $('#grid'), artistBox = $('#artistList'), rows = $('#songList');
  const mode = kw || (state.libMode === 'popular' && !accountId) ? 'all' : state.libMode;
  const artistRoot = mode === 'artist' && !state.artistPick;
  const indexed = !kw && (mode === 'all' || mode === 'artist');
  $('#browseAlphabet').hidden = !indexed;
  $('#browseAlphabetLabel').textContent = `${artistRoot ? '歌手' : '歌名'}首字母 · ${state.browseLetter || '全部'}`;
  $('#artistBack').hidden = mode !== 'artist' || !state.artistPick;
  $('#viewToggle').hidden = artistRoot;
  $('#refreshPopularity').hidden = mode !== 'popular';
  $('#browseAux').hidden = $('#artistBack').hidden && $('#refreshPopularity').hidden;
  $('#refreshPopularity').disabled = libraryPopularity.state.loading;
  $('#browseHint').hidden = mode !== 'popular';
  $('#browseHint').textContent = mode === 'popular' ? libraryPopularity.note() : '';
  $('#browseHint').classList.toggle('error', mode === 'popular' && !!libraryPopularity.state.error);
  document.querySelectorAll('.tab').forEach(button => {
    const active = button.dataset.tab === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  // 「歌手」页：先列歌手，点进去再看这位歌手的歌
  if (artistRoot) {
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
    let names = [...groups.keys()].sort((a, b) =>
      (pyCollator() || undefined) ? pyCollator().compare(label.get(a), label.get(b))
                                  : label.get(a).localeCompare(label.get(b)));
    const initial = key => librarySearch.initial(groups.get(key)[0], 1);
    OpenKLibrary.renderIndex($('#browseIndex'), names, state.browseLetter, initial);
    if (state.browseLetter) names = names.filter(key => initial(key) === state.browseLetter);
    const selection = OpenKLibrary.page(names, state.browsePage);
    state.browsePage = selection.page;
    OpenKLibrary.renderPager($('#browsePager'), selection, '位');
    const sig = `A:${state.lang}:${state.browseLetter}:${selection.page}:${list.map(jobRenderKey).join('|')}`;
    if (!force && sig === _browseSig) return;
    _browseSig = sig;
    grid.classList.add('hidden'); rows.classList.add('hidden');
    artistBox.classList.remove('hidden');
    artistBox.innerHTML = '';
    selection.items.forEach((n) => {
      const li = document.createElement('button');
      li.type = 'button';
      li.className = 'artist-chip';
      li.dataset.artist = n;
      li.innerHTML = `<span>${escapeHtml(label.get(n))}</span><em>${groups.get(n).length}</em>`;
      artistBox.appendChild(li);
    });
    const songs = names.reduce((count, key) => count + groups.get(key).length, 0);
    $('#browseCount').textContent = `${names.length} 位歌手 · ${songs} 首`;
    $('#browseEmpty').classList.toggle('hidden', names.length > 0);
    $('#browseEmpty').textContent = all.length
      ? '这个分类下没有歌手，试试其他字母或语种，也可以直接搜索。'
      : '曲库还是空的，去「⚙️ 后台」添加歌曲。';
    return;
  }

  if (mode === 'artist' && state.artistPick) {
    list = list.filter((j) => librarySearch.artistKey(songInfo(j).artist || '未知歌手') === state.artistPick);
  }
  if (!kw && mode !== 'new') list = librarySearch.search(list, query);
  if (indexed) {
    OpenKLibrary.renderIndex($('#browseIndex'), list, state.browseLetter, job => librarySearch.initial(job));
    if (state.browseLetter) list = list.filter(job => librarySearch.initial(job) === state.browseLetter);
  }
  if (mode === 'popular') list = libraryPopularity.rank(list);
  const selection = OpenKLibrary.page(list, state.browsePage);
  state.browsePage = selection.page;
  OpenKLibrary.renderPager($('#browsePager'), selection);

  const popularityKey = mode === 'popular' ? JSON.stringify([...libraryPopularity.state.songs]) : '';
  const sig = `${mode}:${state.view}:${state.lang}:${state.artistPick || ''}:${state.search}:${state.browseLetter}:${selection.page}:${popularityKey}:${list.map(jobRenderKey).join('|')}`;
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
  selection.items.forEach((j, i) => frag.appendChild(useGrid ? songCard(j) : songRow(j, selection.start + i)));
  box.appendChild(frag);

  $('#browseCount').textContent = mode === 'artist' && state.artistPick
    ? `${state.artistLabel || state.artistPick} · ${list.length} 首（点「歌手」返回）`
    : `${list.length} 首`;
  $('#browseEmpty').classList.toggle('hidden', list.length > 0);
  $('#browseEmpty').textContent = kw
    ? `没搜到「${state.search.trim()}」。试试歌名、歌手、全拼或首字母，也可用空格组合搜索。`
    : mode === 'popular'
      ? libraryPopularity.state.loading ? '正在读取我的常唱…'
        : libraryPopularity.state.error ? '统计暂不可用，请点击「刷新常唱」重试。'
          : '还没有符合条件的常唱歌曲。正常播放后会自动累计，只点歌或拖动进度不会增加次数。'
      : all.length ? '这个分类下没有歌曲，试试其他字母或语种，也可以直接搜索。'
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

// 账号模式下队列只存在服务端房间里；本机绝不另存一份，否则两个人会看到两张单子。
function saveQueue() {
  if (accountMode()) return;
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue)); } catch {}
}
function loadQueue() {
  try { state.queue = [...new Set(JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]').filter((id) => typeof id === 'string'))]; }
  catch { state.queue = []; }
}

function jobById(id) { return state.allJobs.find((j) => j.id === id); }

/* ---------------- 账号模式：一个人也待在自己的房间里 ---------------- */
/* 私有账号服务挡在 OpenK 前面时，每个登录的人恒定拥有一个房间。房间是队列和
   播放权的唯一权威，但唱歌用的还是本页原来那套混音器 / 歌词 / 录音引擎：
   本机必须先拿到这个房间的独占播放租约，而且只有真实手势才会让它出声。 */
const room = {
  account: null, id: null, client: null, chip: null, ready: false, error: '', epoch: 0,
  items: [], armed: false, activating: false, gesture: false,
  playerToken: null, lastLease: 0, loadedItem: null, generation: -1, seekTarget: null,
  seeking: false, seekSession: null,
  focus: false, pendingEnded: null, ending: false, endingRequest: null, playFailed: null,
  heartbeatBusy: false, heartbeatRequest: null, recovering: null, connection: '',
  heartbeatTimer: null, watchdog: null, releasing: Promise.resolve(),
};
// 服务端租约 12 秒：2.5 秒续一次，8.5 秒没续上就认定失联并立刻停声。
const LEASE_RENEW_MS = 2500;
const LEASE_LOST_MS = 8500;

function accountMode() { return !!room.account?.enabled; }
function roomState() { return accountMode() ? room.client?.state || null : null; }
function roomCurrent() { return roomState()?.current || null; }
function roomItemId() { return roomCurrent()?.id || null; }

/** 别的设备（电视，或同一个账号的另一台机器）正握着这个房间的播放租约。
 *  这种时候本机只做遥控：点歌和播放控制都发给房间，不自己出声。 */
function remotePlayerActive() {
  const s = roomState();
  return !!s?.player?.online && !room.playerToken;
}

/* ---------- 个人设置与设备拓扑 ---------- */
/* 这台浏览器在账号里的名字。它不是凭据：没有登录时什么也代表不了，
   而且服务端永远先按账号隔离，共用浏览器不会把设置带给下一个人。 */
function thisDevice() {
  return accountMode() ? window.OpenKUserState?.deviceId() || null : null;
}
function userState() {
  const value = window.OpenKUserState?.value;
  return value?.enabled ? value : null;
}
function preferredPlayerId() { return userState()?.preferredPlayer || null; }
/** 账号把播放指到了别的设备：这台机器就不该自作主张开声。 */
function preferredPlayerElsewhere() {
  const preferred = preferredPlayerId();
  return !!preferred && preferred !== thisDevice();
}
function preferredPlayerName() {
  const value = userState();
  return value?.devices.find((item) => item.id === value.preferredPlayer)?.label || '另一台设备';
}
function preferredPlayerNotice() {
  return `首选播放器是“${preferredPlayerName()}”。请在该设备上打开 OpenK 开始播放，`
       + '或点击“在本机播放”改用当前设备。';
}

function setRoomStatus(message) {
  const status = $('#roomPlaybackStatus');
  if (status) status.textContent = message;
}

function catalogNotice(message) {
  const status = $('#catalogStatus');
  if (!status) return;
  status.textContent = message || '';
  status.classList.toggle('hidden', !message);
}

function reportRoomError(e) {
  if (!e || e.status === 499 || e.name === 'AbortError') return;
  if (e.status === 401) { accountLost(e); return; }
  const message = e.message || '房间操作失败，请重试';
  toast(message);
  setRoomStatus(message);
}

function renderRoomStatus() {
  const host = $('#roomStatus');
  if (!host) return;
  if (!accountMode()) {
    OpenKRoom.renderDevices($('#roomDevices'), null, null);
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.classList.remove('hidden');
  const s = roomState();
  OpenKRoom.renderDevices($('#roomDevices'), room.account.user ? s : null, room.client?.presenceId);
  const button = $('#roomActivate');
  const label = $('#currentRoomName');
  if (label) {
    const online = (s?.members || []).filter((m) => m.online).length;
    label.textContent = !s ? '当前房间'
      : (s.solo ? '我的房间 · 只有你' : (s.name || '当前房间') + ` · ${online} 人在线`);
  }
  const idle = (text) => {
    if (button) { button.disabled = true; button.textContent = '在本机播放'; }
    setRoomStatus(text);
  };
  if (!room.account.user) { idle('需要登录后才能点歌。'); return; }
  if (!s) { idle(room.error || '正在连接房间…'); return; }
  if (button) {
    button.disabled = room.armed || room.activating || remotePlayerActive();
    button.textContent = room.armed ? (playbackAudible() ? '本机正在播放' : '本机已连接')
      : s.current ? '在本机播放' : '启用播放器';
  }
  if (room.connection === 'reconnecting') { setRoomStatus('房间连接不稳定，正在重连…'); return; }
  if (room.armed) {
    const status = localMediaStatus();
    setRoomStatus(!s.current ? '播放器已就绪 · 点歌后自动开唱'
      : status === 'playing' ? '本机正在播放这个房间的歌'
      : status === 'buffering' ? '本机正在缓冲音频…'
      : ['blocked', 'error'].includes(status) ? '声音尚未启用 · 点击播放重试'
      : '本机已就绪 · 已暂停');
  } else if (remotePlayerActive()) {
    const who = (s.members || []).find((m) => m.id === s.player.member_id);
    const device = s.devices?.find(item => item.player);
    const status = playbackAudible() ? '正在播放' : '已连接';
    setRoomStatus(`${device?.name || who?.name || '另一台设备'}${status} · 本机可以点歌和遥控`);
  } else if (preferredPlayerElsewhere()) {
    setRoomStatus(preferredPlayerNotice());
  } else if (!s.current) {
    setRoomStatus('点歌即可开唱；也可先启用播放器，等待手机点歌。');
  } else {
    setRoomStatus('本机还没有开声 · 点「在本机播放」开始');
  }
}

/* ---------- 手势与独占播放租约 ---------- */

/** 界面上的 ▶ / ⏸ 必须诚实。服务端的 playback.playing 只是「房间想播」，
 *  没有任何设备握着租约时它并不代表有人听得见声音——那种时候必须显示 ▶，
 *  让人一眼看出「还没开声」，按下去就能在本机开唱。 */
function playbackAudible() {
  if (!accountMode()) return !inst.paused;
  if (room.armed) return !inst.paused && state.audioGraph?.actx.state === 'running';
  if (!remotePlayerActive()) return false;
  const s = roomState();
  return !!s.playback.playing && ['playing', 'buffering'].includes(s.player.status);
}

function renderTransportLabels() {
  const playing = playbackAudible();
  const label = playing ? '暂停' : '播放';
  for (const id of ['#playBtn', '#nbPlay', '#lyricEditPlay']) {
    const button = $(id);
    if (!button) continue;
    button.textContent = playing ? '⏸' : '▶';
    button.setAttribute('aria-label', label);
  }
  renderLyricEditProgress();
}

/** 必须在真实的指针/键盘事件里同步调用：先把原来的 AudioContext 解锁，再去等网络。
 *  这里绝不碰麦克风——「开声音」不该顺手把录音权限也要走。 */
function localGesture() {
  if (!accountMode()) return;
  room.gesture = true;
  room.playFailed = null;
  if (!remotePlayerActive()) unlockAudio();
}

function releaseLease(client, token) {
  if (!client || !token) return Promise.resolve();
  return client.release(token).catch((e) => {
    // 租约 12 秒自己过期，所以这里只需要让人知道发生过什么。
    if (![403, 404, 409, 499].includes(e.status)) console.warn('释放播放租约失败，等待自动过期', e);
  });
}

/** 停掉本机的一切声音：音频、麦克风监听、录音（已录到的音频仍然保留）。 */
function disarmLocalPlayer(message, { reset = false, release = true } = {}) {
  const client = room.client, token = room.playerToken;
  room.armed = false;
  room.activating = false;
  room.playerToken = null;
  room.pendingEnded = null;
  room.ending = false;
  room.heartbeatBusy = false;
  room.generation = -1;
  room.seekTarget = null;
  room.seeking = false;
  room.seekSession = null;
  room.lastLease = 0;
  room.playFailed = null;
  cancelEndedTimer();
  // stopAudio 会顺带停止录音（音频进 pendingRecordings 不会丢）并断开麦克风。
  stopAudio();
  // 音轨已经被 stopAudio 卸掉了，所以必须让房间状态重新把这首歌装回来，
  // 否则重新拿到播放权时会对着一个空的 <audio> 按播放。
  room.loadedItem = null;
  if (reset) {
    room.focus = false;
    room.gesture = false;
    viewPlayerRequested = false;
    invalidateSelection();
    state.currentJobId = null;
    $('#player').classList.add('hidden');
  }
  renderNowBar();
  renderRoomStatus();
  renderTransportLabels();
  room.releasing = release ? releaseLease(client, token) : Promise.resolve();
  if (message) { toast(message); setRoomStatus(message); }
}

/** 取得房间的独占播放租约。服务端只允许一个租约存在，所以这里抢不到就老实当遥控。 */
async function armLocalPlayer() {
  const client = room.client, epoch = room.epoch;
  if (room.armed) return true;
  if (room.activating) return false;
  if (!client?.state) { toast('正在连接房间，请稍后重试'); return false; }
  if (remotePlayerActive()) {
    setRoomStatus('另一台设备正在播放这个房间，先在那台设备上停止。');
    return false;
  }
  room.activating = true;
  renderRoomStatus();
  try {
    if (!await unlockAudio()) {
      setAudioStatus('点击播放以启用音频');
      return false;
    }
    if (client !== room.client || epoch !== room.epoch) return false;
    // 保守起见用「请求发出」的时刻记租约，网络慢时才不会高估剩余时间。
    const sentAt = performance.now();
    const claim = await client.claim();
    if (client !== room.client || epoch !== room.epoch) {
      releaseLease(client, claim.player_token);
      return false;
    }
    room.playerToken = claim.player_token;
    room.lastLease = sentAt;
    room.armed = true;
    room.generation = -1;
    room.activating = false;
    // claim 会把房间置为暂停，所以要显式把它放起来。
    if (client.state.current) await client.command('play');
    if (client !== room.client || epoch !== room.epoch
        || !room.armed || room.playerToken !== claim.player_token) return false;
    if (client.state.current) autoEnableMic();
    applyRoomPlayback(true);
    roomHeartbeat();
    return true;
  } catch (e) {
    if (client !== room.client || epoch !== room.epoch) return false;
    disarmLocalPlayer('');
    await room.releasing;
    if (client !== room.client || epoch !== room.epoch) return false;
    if (e.status === 409) setRoomStatus('另一台设备正在播放这个房间，先在那台设备上停止。');
    reportRoomError(e);
    return false;
  } finally {
    if (client === room.client && epoch === room.epoch) room.activating = false;
    renderRoomStatus();
    renderTransportLabels();
    renderNowBar();
  }
}

/** 有真实手势、又没人占着播放权时，才在本机开声。 */
async function ensureLocalPlayer() {
  if (room.armed) return true;
  if (!room.gesture || remotePlayerActive()) return false;
  // 账号把播放指到了别的设备时，点歌不再顺手在这台机器上开声：
  // 要么去那台设备上打开，要么在这里显式按「在本机播放」。
  if (preferredPlayerElsewhere()) {
    setRoomStatus(preferredPlayerNotice());
    return false;
  }
  return armLocalPlayer();
}

async function activateLocalPlayer() {
  room.gesture = true;
  if (remotePlayerActive()) {
    toast('另一台设备正在播放这个房间，先在那台设备上停止。');
    return;
  }
  // 这一下是显式手势，所以允许覆盖拓扑，但必须说清楚发生了什么。
  if (preferredPlayerElsewhere()) toast(`改用本机播放，不使用“${preferredPlayerName()}”。`);
  if (await armLocalPlayer() && roomCurrent()) showStage();
}

/* ---------- 心跳、看门狗与自动切歌 ---------- */

function localMediaStatus() {
  const s = roomState();
  if (!s?.current || !state.currentJobId) return 'ready';
  if (inst.error) return 'error';
  if (state.audioGraph && state.audioGraph.actx.state !== 'running') return 'blocked';
  if (state.buffering) return 'buffering';
  if (!inst.paused) return 'playing';
  return state.playRequested ? 'buffering' : 'paused';
}

/** 把本机真实的播放状态与进度告诉房间，同时续租。 */
async function roomHeartbeat() {
  const client = room.client, token = room.playerToken, s = client?.state;
  if (!room.armed || !token || room.heartbeatBusy || !s) return;
  room.heartbeatBusy = true;
  const pending = {};
  room.heartbeatRequest = pending;
  const sentAt = performance.now();
  try {
    await client.heartbeat(token, {
      current_id: s.current?.id || null,
      generation: s.playback.seek_version,
      position: s.current && Number.isFinite(inst.currentTime) ? Math.max(0, inst.currentTime) : 0,
      status: localMediaStatus(),
      device_id: thisDevice(),
    });
    if (client !== room.client || token !== room.playerToken) return;
    room.lastLease = sentAt;
    if (room.pendingEnded) await sendRoomEnded();
  } catch (e) {
    if (client !== room.client || token !== room.playerToken) return;
    if (OpenKRoom.contextChanged(e)) {
      disarmLocalPlayer(e.message, { reset: true, release: false });
      recoverRoom(e).catch(() => {});
    } else if (e.status === 409) {
      // 命令和心跳撞车不算丢租约：刷新之后再判断播放权是不是真的没了。
      try { await client.refresh(); }
      catch (error) { if (client === room.client && error.status !== 499) setRoomStatus(error.message); }
      if (client !== room.client || token !== room.playerToken) return;
      const fresh = client.state;
      if (!fresh?.player.online || (fresh.player.member_id && fresh.viewer?.id
          && fresh.player.member_id !== fresh.viewer.id)) {
        disarmLocalPlayer('播放权已被收回，本机声音已停止。');
      }
    } else if ([401, 403, 404].includes(e.status)) {
      disarmLocalPlayer(e.message, { release: false });
      if (e.status === 401) accountLost(e);
    } else setRoomStatus('与房间的连接不稳定，正在重试…');
  } finally {
    if (room.heartbeatRequest === pending) room.heartbeatBusy = false;
  }
}

function leaseWatchdog() {
  if (!room.armed) return;
  if (performance.now() - room.lastLease > LEASE_LOST_MS) {
    // 顺手把租约还回去：只是网络抖了一下的话，人重新点「在本机播放」就能立刻继续，
    // 不必干等 12 秒；网络真断了这次释放也只会无声失败。
    disarmLocalPlayer('与房间失去联系，声音已安全停止。恢复网络后请重新开声。');
  }
}

/** 唱完一首由服务端推进队列，本机不另开一条本地队列去抢。 */
async function sendRoomEnded() {
  const client = room.client, token = room.playerToken, report = room.pendingEnded;
  if (!report || room.ending || !token || !client?.state) return;
  const s = client.state;
  // 服务端已经翻到下一首，或者这首歌被重播 / 拖动过——这份「唱完了」已经过期，直接丢掉。
  // 绝不改写 generation 去迁就新状态：那等于拿旧动作去推一个新局面。
  if (s.current?.id !== report.item_id || s.playback.seek_version !== report.generation) {
    room.pendingEnded = null;
    return;
  }
  room.ending = true;
  const pending = {};
  room.endingRequest = pending;
  try {
    await client.ended(token, {
      command_id: report.command_id, item_id: report.item_id, generation: report.generation,
      device_id: thisDevice(),
    });
    if (room.pendingEnded === report) room.pendingEnded = null;
  } catch (e) {
    if (client !== room.client || token !== room.playerToken) return;
    if (e.status === 409) disarmLocalPlayer(e.message);
    else setRoomStatus('正在等待网络恢复后切歌…');
  } finally {
    if (room.endingRequest === pending) room.ending = false;
  }
}

function reportRoomEnded() {
  const s = roomState();
  if (!room.armed || !s?.current) return;
  if (room.pendingEnded?.item_id === s.current.id) return;
  // 命令编号只铸一次，重发用的必须是同一条命令：网络抖一下重试时服务端才能去重，
  // 而不会把队列一口气翻过两首歌。
  room.pendingEnded = {
    command_id: OpenKRoom.id(), item_id: s.current.id, generation: s.playback.seek_version,
  };
  sendRoomEnded();
}

/* ---------- 房间状态 → 本机引擎 ---------- */

function applyGuideState(guide) {
  const mode = guide ? 'orig' : 'inst';
  if (state.singMode !== mode) setSingMode(mode, false);
}

/** 服务端要求的播放位置。媒体还没就绪时先记下来，等 loadedmetadata 再落位。 */
function applyRoomSeek(position) {
  if (!Number.isFinite(inst.duration)) { room.seekTarget = position; return; }
  room.seekTarget = null;
  seekTo(position);
}

/** 只在「歌变了 / seek_version 变了 / 播放开关变了」时动引擎，不能每轮轮询都重设进度。 */
function applyRoomPlayback(reseek = false) {
  const s = roomState();
  if (!s || state.disposed || !room.armed) return;
  if (state.audioGraph?.actx.state !== 'running') {
    disarmLocalPlayer('声音被系统暂停，请点击「在本机播放」恢复。');
    return;
  }
  if (!s.current || room.loadedItem !== s.current.id || !state.currentJobId) return;
  if (!room.seeking && (reseek || room.generation !== s.playback.seek_version)) {
    room.generation = s.playback.seek_version;
    applyRoomSeek(s.playback.position);
  }
  if (s.playback.playing) {
    const key = s.current.id + ':' + s.playback.seek_version;
    if (inst.paused && !inst.ended && !state.playRequested && !room.pendingEnded
        && room.playFailed !== key) {
      // 起播失败（多半是浏览器要一次新手势）只提示一次，不能每轮轮询都弹一遍。
      startPlayback().then((ok) => { if (!ok && room.armed) room.playFailed = key; });
    }
  } else if (!inst.paused || state.playRequested) pausePlayback();
  renderNowBar();
}

/** 载入房间当前这首歌。歌曲信息以房间条目为准（服务端只会给出真实存在的音轨），
 *  再用曲库里的同一首歌补上来源链接等额外字段。走的还是原来的 showPlayer 那条路，
 *  所以歌词、歌词编辑、重对齐、历史录音全部照旧可用。 */
async function loadRoomSong(item, focus) {
  const requestGeneration = ++state.selectionRequestGeneration;
  state.selectionRequest?.abort();
  state.selectionRequest = null;
  cancelEndedTimer();
  const known = jobById(item.job_id);
  const job = {
    ...(known || {}),
    id: item.job_id,
    state: 'done',
    track: item.title || known?.track,
    title: item.title || known?.title,
    artist: item.artist || known?.artist || '',
    duration: item.duration || known?.duration || 0,
    thumbnail: item.thumbnail || known?.thumbnail || null,
    media: item.media || known?.media || {},
  };
  if (!job.media.instrumental) {
    const message = '伴奏文件暂时不可用，请在后台检查歌曲';
    toast(message);
    setRoomStatus(message);
    return;
  }
  const generation = ++state.selectionGeneration;
  state.lyricsGeneration++;
  state.lyricsRequest?.abort();
  state.recordingsGeneration++;
  state.recordingsRequest?.abort();
  if (focus) showStage();
  await showPlayer(job, generation, false);
}

function applyRoomCurrent(s) {
  const current = s.current || null;
  if ((current?.id || null) === room.loadedItem) {
    if (current) refreshPlayerLyrics(current.job_id, current.media?.lyrics || null);
    if (room.focus && current) { room.focus = false; showStage(); }
    return;
  }
  const focus = room.focus;
  room.focus = false;
  room.loadedItem = current?.id || null;
  room.generation = -1;
  room.seekTarget = null;
  room.pendingEnded = null;
  cancelEndedTimer();
  if (!current) { endPlayback(); return; }
  loadRoomSong(current, focus);
}

function applyRoomState(s) {
  if (!accountMode() || state.disposed || !s) return;
  consumeViewIntent(s);
  room.items = Array.isArray(s.queue) ? s.queue : room.items;
  // 曲库上的「已点」角标按歌显示；真正的增删置顶都用房间条目 ID，重复点同一首才不会串。
  const mirrored = room.items.map((item) => item.job_id);
  const changed = mirrored.join('|') !== state.queue.join('|');
  state.queue = mirrored;
  renderQueue();
  if (changed) renderBrowse();
  applyRoomCurrent(s);
  // 导唱开关是房间设置：手机上按一下，正在唱的这台机器也要跟着切。
  applyGuideState(s.playback.guide);
  applyRoomPlayback();
  renderRoomStatus();
  renderTransportLabels();
  renderNowBar();
}

/* ---------- 房间连接 ---------- */

/** 手机在没有播放设备时把人送到 /?view=player：进来就看见当前这首歌的完整播放器。
 *  这只是「打开播放器」，不是播放许可——开声仍然要一次真实手势。用过一次就作废，
 *  免得之后换了房间还被这条旧地址拽走。 */
let viewPlayerRequested = false;
try { viewPlayerRequested = new URLSearchParams(location.search).get('view') === 'player'; } catch {}

function consumeViewIntent(s) {
  if (!viewPlayerRequested || !s?.current) return;
  viewPlayerRequested = false;
  room.focus = true;
}

function bindRoom(current) {
  room.id = current.room_id;
  room.items = [];
  const client = new OpenKRoom.RoomClient(current.room_id, null, {
    presence: () => OpenKRoom.devicePresence(['player', 'controller'], state.micStream ? ['microphone'] : []),
  });
  room.client = client;
  client.onstate = (value) => { if (room.client === client) applyRoomState(value); };
  client.onconnection = (status, error) => {
    if (room.client === client) roomConnectionChanged(status, error);
  };
  // 房间里已经有歌时，只有地址明确要求 /?view=player 才直接进歌词页；
  // 平常刷新首页仍然停在点歌台，用房间条上的「在本机播放」当那次手势入口。
  room.focus = false;
  client.accept(current.state);
  client.start();
}

function roomConnectionChanged(status, error) {
  room.connection = status;
  if (status === 'connected') {
    room.error = '';
    catalogNotice('');
    renderRoomStatus();
    return;
  }
  if (error?.status === 401) { accountLost(error); return; }
  if (status === 'changed' || status === 'expired') {
    disarmLocalPlayer(error?.message || '房间已切换，本机声音已停止。',
      { reset: true, release: false });
    recoverRoom(error).catch(() => {});
    return;
  }
  setRoomStatus(error?.message || '房间连接不稳定，正在重连…');
}

/** 房间换了 / 账号换了：先停声，再按新的身份重新绑定。旧动作绝不重放。 */
function recoverRoom(cause) {
  if (room.recovering) return room.recovering;
  const pending = (async () => {
    disarmLocalPlayer(cause?.message, { reset: true, release: false });
    try { await initAccount(true); }
    catch (e) { accountFailed(e); throw e; }
  })();
  room.recovering = pending;
  pending.catch(() => {}).then(() => { if (room.recovering === pending) room.recovering = null; });
  return pending;
}

async function roomConnected() {
  if (room.client) return room.client;
  const current = await OpenKAccount.currentRoom();
  if (!room.client) bindRoom(current);
  return room.client;
}

async function roomCommand(action, payload) {
  const accountId = room.account?.user?.id;
  try {
    const client = await roomConnected();
    return await client.command(action, payload);
  } catch (e) {
    if (OpenKRoom.contextChanged(e) || [403, 404].includes(e.status)) {
      await recoverRoom(e);
      const changed = accountId !== room.account?.user?.id;
      throw new OpenKRoom.RoomError(changed ? '登录账号已改变，请确认当前账号后重新操作'
        : '房间已重新连接，请在当前房间重试操作', 409, changed ? 'account_changed' : 'room_changed');
    }
    throw e;
  }
}

function roomTransport(action, payload = {}) {
  return roomCommand(action, payload).catch(reportRoomError);
}

/* ---------- 点歌 / 切歌 / 传输控制 ---------- */

async function addToRoom(id, playNow) {
  const title = songInfo(jobById(id) || {}).title || '';
  try {
    const empty = !roomItemId();
    if (empty || playNow) room.focus = true;
    const s = await roomCommand('add', { job_id: id });
    const item = [...(s?.queue || [])].reverse().find((entry) => entry.job_id === id);
    if (playNow && !empty && item) {
      await roomCommand('top', { item_id: item.id });
      const current = roomItemId();
      if (current && current !== item.id) await roomCommand('next', { item_id: current });
    }
    room.focus = false;
    const playing = await ensureLocalPlayer();
    if (empty || playNow) toast(`已点：${title}`);
    else toast(`已点到房间：${title}（第 ${room.items.length} 位）`);
    if (!playing && remotePlayerActive()) setRoomStatus('已排进队列，正在播放的设备会接着唱。');
  } catch (e) {
    room.focus = false;
    reportRoomError(e);
  }
}

async function singRoomItemNow(itemId) {
  try {
    room.focus = true;
    await roomCommand('top', { item_id: itemId });
    const current = roomItemId();
    if (current && current !== itemId) await roomCommand('next', { item_id: current });
    room.focus = false;
    await ensureLocalPlayer();
  } catch (e) {
    room.focus = false;
    reportRoomError(e);
  }
}

function toggleRoomPlay() {
  const s = roomState();
  if (!s) { accountWaiting(); return; }
  if (!s.current) { toast('先点一首歌再播放'); return; }
  if (!room.armed && !remotePlayerActive()) { activateLocalPlayer(); return; }
  roomTransport(s.playback.playing ? 'pause' : 'play');
}

function skipRoomSong() {
  const item = roomItemId();
  if (!item) { toast('房间里还没有歌曲'); return; }
  roomTransport('next', { item_id: item });
}

function restartRoomSong() {
  const item = roomItemId();
  if (!item) { toast('房间里还没有歌曲'); return; }
  // 从头再唱一次：停着的时候按重播，理应直接唱起来。
  const paused = !roomState()?.playback.playing;
  roomTransport('restart', { item_id: item });
  if (paused) roomTransport('play');
}

/** 拖进度条 / 点歌词行。本机先跟手，房间随后确认同一个位置。 */
function userSeek(t) {
  if (!Number.isFinite(t)) return;
  if (!accountMode()) { seekTo(t); return; }
  const item = roomItemId();
  if (room.armed) seekTo(t);
  if (!item) return;
  return roomTransport('seek', { item_id: item, position: Math.max(0, t) });
}

function setSingModeIntent(mode) {
  if (!accountMode()) { setSingMode(mode); return; }
  prefs.singMode = mode;
  savePrefs('singMode');
  roomTransport('guide', { enabled: mode === 'orig' });
}

/* ---------- 账号生命周期 ---------- */

function prefsStatus(message) {
  const node = $('#prefsStatus');
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('hidden', !message);
}
function deviceHint(message) {
  const node = $('#deviceHint');
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('hidden', !message);
}

/** 把服务端「账号默认 + 这台设备覆盖」的有效设置装进运行时。 */
function applyUserSettings(values) {
  if (!values) return;
  prefs.singMode = values.sing_mode;
  prefs.reverb = values.reverb;
  prefs.view = values.view;
  prefs.instVol = values.accompaniment_volume;
  prefs.vocalVol = values.guide_volume;
  prefs.micMonitor = values.mic_monitor;
  prefs.micVol = values.mic_volume;
  prefs.howlGuard = values.howl_guard;
  prefs.outVol = values.output_volume;
  prefs.audioIn = values.audio_input;
  prefs.audioOut = values.audio_output;
  syncPrefControls();
}

/** 控件与音频图跟着偏好走。这里绝不申请麦克风，也绝不自己开始播放：
 *  存下来的偏好只是偏好，真正出声仍然要手势和浏览器授权。 */
function syncPrefControls() {
  const set = (selector, value) => { const node = $(selector); if (node) node.value = value; };
  const text = (selector, value) => { const node = $(selector); if (node) node.textContent = value; };
  set('#reverb', prefs.reverb);
  set('#instVol', prefs.instVol);
  set('#vocalVol', prefs.vocalVol);
  set('#micVol', prefs.micVol);
  set('#outVol', prefs.outVol);
  text('#micVolVal', prefs.micVol + '%');
  text('#outVolVal', prefs.outVol + '%');
  const monitor = $('#monitor');
  if (monitor) monitor.checked = prefs.micMonitor;
  const guard = $('#howlGuard');
  if (guard) guard.checked = prefs.howlGuard;
  if (state.audioGraph) {
    setReverb(prefs.reverb);
    if (state.audioGraph.mic) state.audioGraph.mic.micGain.gain.value = prefs.micVol / 100;
  }
  applyVolumes();
  applyMonitorState();
  applyOutputDevice();
  refreshMediaDevices();
  if (prefs.view && prefs.view !== state.view) {
    state.view = prefs.view;
    text('#viewToggle', state.view === 'list' ? '封面视图' : '列表视图');
    renderBrowse(true);
  }
  // 房间里原唱/伴唱是大家共用的开关，个人偏好不能悄悄把它掀过去。
  if (prefs.singMode && !accountMode() && prefs.singMode !== state.singMode) {
    setSingMode(prefs.singMode, false);
  }
}

/** 输出设备只能由这台浏览器自己决定，不支持就明说，不假装换成功。 */
function applyOutputDevice() {
  const sink = typeof prefs.audioOut === 'string' ? prefs.audioOut : '';
  if (!sinkSelectable()) {
    if (sink) deviceHint('当前浏览器不支持选择音频输出设备，将使用系统默认设备。');
    return Promise.resolve(false);
  }
  return Promise.all([inst, vocal].map((element) => element.setSinkId(sink)))
    .then(() => { deviceHint(''); return true; })
    .catch(() => {
      deviceHint('已保存的扬声器在当前设备上不可用，将使用系统默认设备。');
      return false;
    });
}
function sinkSelectable() {
  return typeof HTMLMediaElement !== 'undefined'
    && typeof HTMLMediaElement.prototype.setSinkId === 'function';
}

/** 列出这台浏览器能用的输入/输出设备。名字要等授权过一次才有，如实说明。 */
async function refreshMediaDevices() {
  const input = $('#audioIn'), output = $('#audioOut');
  if (!input || !output) return;
  const fill = (select, list, current, fallback) => {
    const options = [{ deviceId: '', label: '系统默认' }, ...list];
    if (current && !options.some((item) => item.deviceId === current)) {
      options.push({ deviceId: current, label: '已保存的设备（当前浏览器未找到）' });
    }
    select.replaceChildren(...options.map((item, index) => {
      const option = document.createElement('option');
      option.value = item.deviceId;
      option.textContent = item.label || `${fallback} ${index}`;
      return option;
    }));
    select.value = current && options.some((item) => item.deviceId === current) ? current : '';
  };
  const media = navigator.mediaDevices;
  const sink = sinkSelectable();
  let devices = [];
  if (media?.enumerateDevices) {
    try { devices = await media.enumerateDevices(); } catch { devices = []; }
  }
  fill(input, devices.filter((item) => item.kind === 'audioinput'), prefs.audioIn, '麦克风');
  fill(output, sink ? devices.filter((item) => item.kind === 'audiooutput') : [], prefs.audioOut, '扬声器');
  input.disabled = !media?.enumerateDevices;
  output.disabled = !sink;
  if (!media?.enumerateDevices) deviceHint('当前浏览器无法列出音频设备，将使用系统默认设备。');
  else if (!sink) deviceHint('当前浏览器不支持选择音频输出设备，将使用系统默认设备。');
  else if (devices.length && devices.every((item) => !item.label)) {
    deviceHint('允许访问麦克风后，才能显示设备名称。');
  }
}

/** 登录后读「人 + 这台设备」的设置。读不到就退回内置安全默认值并说明，
 *  绝不把上一位用户留在这台浏览器里的本地偏好顶上去当成新用户的设置。 */
async function loadUserSettings() {
  const api = window.OpenKUserState;
  if (!api) return;
  const epoch = room.epoch;
  Object.assign(prefs, PREF_DEFAULTS);
  api.reset();
  syncPrefControls();
  prefsStatus('正在加载已保存的设置…');
  try {
    const value = await api.load();
    if (epoch !== room.epoch) return;
    if (value?.enabled) applyUserSettings(value.settings);
    prefsStatus('');
  } catch (e) {
    if (e.status === 499 || epoch !== room.epoch) return;
    prefsStatus('无法加载已保存的设置，当前使用安全默认值。'
      + (e.message || ''));
  }
}

function accountLost(e) {
  room.ready = false;
  room.error = '登录已过期，请重新登录后再点歌。';
  room.epoch++;
  OpenKAccount.reset();
  window.OpenKUserState?.reset();
  prefsStatus('');
  disarmLocalPlayer('登录已过期，本机声音已停止。', { reset: true, release: false });
  room.client?.stop();
  room.client = null;
  room.id = null;
  room.items = [];
  state.queue = [];
  room.account = { enabled: true, user: null, loginUrl: e?.loginUrl || '/auth/login/' };
  room.chip?.update(null);
  renderQueue();
  renderBrowse();
  renderRoomStatus();
  catalogNotice('登录已过期，请重新登录后再点歌。');
}

async function initAccount(force = false) {
  if (!window.OpenKAccount) throw new Error('缺少 account.js，前端资源不完整');
  libraryPopularity.reset();
  const epoch = ++room.epoch;
  room.ready = false;
  room.error = '';
  room.client?.stop();
  room.client = null;
  OpenKRoom.renderDevices($('#roomDevices'), null, null);
  room.id = null;
  room.items = [];
  const host = $('#accountChip');
  const account = await (force ? OpenKAccount.reload() : OpenKAccount.load());
  if (epoch !== room.epoch) throw new OpenKRoom.RoomError('账号状态已更新，请重试', 499);
  room.account = account;
  if (!account.enabled) {
    if (host) host.hidden = true;
    renderRoomStatus();
    loadQueue();
    room.ready = true;
    renderQueue(); renderBrowse();
    return;
  }
  document.body.classList.add('account-mode');
  room.chip = OpenKAccount.mount(host, { onLogout: () => signOutLibrary() });
  room.chip.update(account.user);
  state.queue = [];
  renderRoomStatus();
  if (account.user) await loadUserSettings();
  if (epoch !== room.epoch) throw new OpenKRoom.RoomError('账号状态已更新，请重试', 499);
  const current = await OpenKAccount.currentRoom();
  if (epoch !== room.epoch) throw new OpenKRoom.RoomError('账号状态已更新，请重试', 499);
  // 换房间要重新做一次手势才会出声，绝不因为跟随而自动播放。
  room.gesture = false;
  bindRoom(current);
  room.ready = true;
  catalogNotice('');
  renderRoomStatus();
  renderQueue();
  renderBrowse();
  refreshPopularity(true);
}

function accountFailed(e) {
  if (e.status === 499) return;
  room.ready = false;
  room.error = '无法读取登录状态，请刷新页面后重试。';
  if (e.status === 401) {
    room.account = { enabled: true, user: null, loginUrl: '/auth/login/' };
    libraryPopularity.reset();
    renderBrowse();
    document.body.classList.add('account-mode');
    room.chip = OpenKAccount.mount($('#accountChip'), {});
    room.chip.update(null);
    renderRoomStatus();
    catalogNotice('需要登录后才能点歌。');
    return;
  }
  // 绝不悄悄退回独立播放器：那会绕过房间，也会让别人看不到你点的歌。
  renderRoomStatus();
  catalogNotice('无法读取登录状态：' + (e.message || e));
  toast('无法读取登录状态：' + (e.message || e));
}

function accountWaiting() {
  if (accountMode() && !room.account.user) location.assign(room.account.loginUrl || '/auth/login/');
  else toast(room.error || '正在读取登录状态和当前房间，请稍后重试。');
}

async function signOutLibrary() {
  try {
    room.chip?.busy(true);
    // 先停本机的声音和麦克风，并且真的把播放权还回去，再把身份交还给账号服务：
    // 否则房间要空等 12 秒才肯让下一台设备开声。
    disarmLocalPlayer('正在退出登录…');
    await room.releasing;
    window.OpenKUserState?.reset();
    const url = await OpenKAccount.logout();
    room.client?.stop();
    room.client = null;
    OpenKRoom.renderDevices($('#roomDevices'), null, null);
    location.assign(url);
  } catch (e) {
    room.chip?.busy(false);
    toast(e.message || '退出登录失败');
    setRoomStatus('退出登录失败，房间仍然可用。');
    // 退出失败不能把界面留在一个死掉的连接上。
    if (!room.client?.running) initAccount(true).catch(accountFailed);
  }
}

function addToQueue(id, playNow = false) {
  if (!room.ready) { accountWaiting(); return; }
  if (accountMode()) {
    if (!room.account.user) { location.assign(room.account.loginUrl || '/auth/login/'); return; }
    addToRoom(id, playNow);
    return;
  }
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
 *  界面自己跳走，很烦人；所以只有用户主动点歌 / 切歌时才切到歌词页。
 *
 *  账号模式下队列在服务端，所以这里只是把「下一首」这个意图交给房间，
 *  绝不在房间之外再开一条本地队列。 */
function playFromQueue(keepView = false) {
  if (!room.ready) { accountWaiting(); return; }
  if (accountMode()) { skipRoomSong(); return; }
  const id = state.queue.shift();
  saveQueue(); renderQueue(); renderBrowse();
  if (!id) { endPlayback(); return; }   // 队列空了才真正停下来
  selectJob(id, keepView);
}

/** 账号模式的已点列表直接画服务端条目：同一首歌点两次是两条独立记录，
 *  置顶/删除/立即唱都认条目 ID，不会误伤另一份拷贝。 */
function renderRoomQueue() {
  const ul = $('#queueList');
  const items = room.items;
  const signature = items.map((item) =>
    JSON.stringify([item.id, item.job_id, item.title, item.artist])).join('|');
  if (ul.dataset.signature !== signature) {
    ul.dataset.signature = signature;
    ul.innerHTML = '';
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'q-item';
      li.dataset.id = item.job_id;
      li.dataset.item = item.id;
      li.innerHTML = `
      <span class="q-no">${i + 1}</span>
      <div class="q-body">
        <button class="q-title item-open" data-act="play" aria-label="立即演唱：${escapeHtml(item.title || '')}">${escapeHtml(item.title || '未命名')}</button>
        <p class="q-artist">${escapeHtml(item.artist || '未知歌手')}</p>
      </div>
      <button class="lyr-btn" data-act="top" title="置顶，下一首就唱它">⇧ 置顶</button>
      <button class="lyr-btn" data-act="del" title="从已点里删掉">✕</button>`;
      ul.appendChild(li);
    });
  }
  $('#queueCount').textContent = String(items.length);
  $('#nbQueueCount').textContent = String(items.length);
  $('#queueEmpty').classList.toggle('hidden', items.length > 0);
  $('#queueHint').textContent = items.length ? '唱完自动接下一首' : '';
}

function renderQueue() {
  if (accountMode()) { renderRoomQueue(); return; }
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
function isFailedJob(job) {
  return job?.state === 'error' || job?.state === 'cancelled';
}

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
    const deleting = state.deletingJobs.has(j.id);
    const disabled = deleting ? 'disabled' : '';
    const pct = Math.round(Math.max(0, Math.min(100, Number(j.progress) || 0)));
    li.innerHTML = `
      <div class="p-body">
        <button class="p-title item-open" data-act="inspect" aria-label="查看处理进度：${escapeHtml(j.title || j.id)}">${escapeHtml(j.title || j.url || j.id)}</button>
        <p class="p-msg muted small">${STATE_TEXT[j.state] || j.state} · ${escapeHtml(j.message || '')}</p>
      </div>
      ${j.state === 'error'
        ? `<button class="lyr-btn" data-act="retry" ${disabled}>重试</button>`
        : isFailedJob(j) ? '' : `<span class="p-pct">${pct}%</span>`}
      ${isFailedJob(j)
        ? `<button class="lyr-btn proc-delete" data-act="delete" ${disabled}
            aria-label="删除任务：${escapeHtml(j.title || j.id)}">${deleting ? '删除中…' : '删除'}</button>`
        : ''}`;
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
    (button && !button.disabled ? button : row?.querySelector('button:not(:disabled)') || $('#adminClose')).focus();
  }
}

async function deleteFailedJob(id) {
  if (state.deletingJobs.has(id)) return;
  const job = jobById(id);
  if (!isFailedJob(job)) {
    toast('任务状态已改变，请刷新后再处理');
    await refreshList(true);
    return;
  }
  if (!confirm(`删除「${job.title || job.id}」及其任务工作文件？\n不会删除导入目录中的原文件。此操作无法撤销。`)) return;
  state.deletingJobs.add(id);
  renderProcessing();
  try {
    let missing = false;
    try {
      await api.deleteJob(id, { failedOnly: true });
    } catch (err) {
      if (err.status !== 404) throw err;
      missing = true;
    }
    if (state.disposed) return;
    if (state.inspectedJobId === id) stopPolling();
    if ($('#progressPanel').dataset.jobId === id) $('#progressPanel').classList.add('hidden');
    // Drain a pre-delete catalog request before fetching the authoritative new list.
    await state.listRequest;
    if (state.disposed) return;
    state.allJobs = state.allJobs.filter((item) => item.id !== id);
    renderProcessing();
    await refreshList(true);
    toast(missing ? '任务已不存在，列表已更新' : '任务已删除');
  } catch (err) {
    if (!state.disposed) alert(err.message || '删除失败，请重试');
    await state.listRequest;
    await refreshList(true);
  } finally {
    state.deletingJobs.delete(id);
    if (!state.disposed) renderProcessing();
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
  renderNowBar();
}

function showStage() {
  $('#browse').classList.add('hidden');
  $('#stage').classList.remove('hidden');
  state.activeLine = -1;
  updateLyrics(inst.currentTime);
  startLyricAnimation();
  renderNowBar();
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
  if (!j || (state.editing && !$('#stage').classList.contains('hidden'))) {
    bar.classList.add('hidden');
    document.body.classList.remove('has-nowbar');
    renderTransportLabels();
    return;
  }
  const si = songInfo(j);
  bar.classList.remove('hidden');
  document.body.classList.add('has-nowbar');
  const cover = $('#nbCover');
  if (j.thumbnail) { cover.src = j.thumbnail; cover.classList.remove('hidden'); }
  else cover.classList.add('hidden');
  $('#nbTitle').textContent = si.title;
  $('#nbArtist').textContent = si.artist || '未知歌手';
  $('#nbQueueCount').textContent = String(state.queue.length);
  renderTransportLabels();
  measureNowBar();
}

function measureNowBar() {
  const height = Math.ceil($('#nowbar').getBoundingClientRect().height);
  if (height > 0) document.documentElement.style.setProperty('--nowbar-height', `${height}px`);
}

/** 原唱 / 伴唱切换。KTV 里默认永远是伴唱——原唱是拿来学的，不是拿来唱的。
 *  persist=false 用于照抄房间下发的状态：别把别人按的开关记成本机偏好。 */
function setSingMode(mode, persist = true) {
  state.singMode = mode;
  if (persist) prefs.singMode = mode;
  $('#modeInst').classList.toggle('active', mode === 'inst');
  $('#modeOrig').classList.toggle('active', mode === 'orig');
  $('#modeInst').setAttribute('aria-pressed', String(mode === 'inst'));
  $('#modeOrig').setAttribute('aria-pressed', String(mode === 'orig'));
  // 原唱模式下把导唱人声推满，伴唱模式下压到 0
  $('#vocalVol').value = mode === 'orig' ? 100 : 0;
  prefs.vocalVol = Number($('#vocalVol').value);
  // 房间下发的模式不算个人设置，所以只有本机主动切换时才记下来。
  if (persist) savePrefs('singMode', 'vocalVol');
  applyVolumes();
}

const DRAWERS = {
  queue: { panel: '#queuePanel', close: '#queueClose' },
  admin: { panel: '#adminPanel', close: '#adminClose' },
  remote: { panel: '#remotePanel', close: '#remoteClose' },
};
const DRAWER_BACKGROUND = ['.topbar', '#roomStatus', '#browse', '#stage', '#nowbar', '#pendingRecordingsWrap', '.foot'];
let drawerTrigger = null;
function openDrawer(which) {
  const drawer = DRAWERS[which];
  if (!drawer) throw new Error('Unknown drawer: ' + which);
  if ($('#scrim').classList.contains('hidden')) drawerTrigger = document.activeElement;
  Object.entries(DRAWERS).forEach(([name, value]) => $(value.panel).classList.toggle('hidden', name !== which));
  $('#remoteLink').setAttribute('aria-expanded', String(which === 'remote'));
  $('#scrim').classList.remove('hidden');
  DRAWER_BACKGROUND.forEach((s) => {
    const el = $(s);
    if (el) el.inert = true;
  });
  document.body.classList.add('drawer-open');
  $(drawer.close).focus();
}
function closeDrawers() {
  Object.values(DRAWERS).forEach(value => $(value.panel).classList.add('hidden'));
  $('#remoteLink').setAttribute('aria-expanded', 'false');
  $('#scrim').classList.add('hidden');
  DRAWER_BACKGROUND.forEach((s) => {
    const el = $(s);
    if (el) el.inert = false;
  });
  document.body.classList.remove('drawer-open');
  if (drawerTrigger?.isConnected) drawerTrigger.focus();
  drawerTrigger = null;
}

function openRemoteQR() {
  // Share only the navigation URL, never account cookies or room capabilities.
  const url = new URL('/remote', location.href).href;
  $('#remoteOpen').href = url;
  $('#remoteAddress').textContent = url;
  $('#remoteQRHint').textContent = !room.ready
    ? '用手机相机扫码打开遥控页；如需登录，请使用与本机相同的账号。'
    : accountMode() ? '用手机相机扫码，登录与本机相同的账号后，即可控制当前房间。'
      : '用手机相机扫码打开遥控页，再选择或加入要控制的房间。';
  const notice = $('#remoteQRNotice');
  notice.textContent = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
    ? '当前是本机地址。请先用手机可访问的域名或局域网地址打开 OpenK，再扫码。' : '';
  notice.classList.toggle('hidden', !notice.textContent);
  const box = $('#remoteQR');
  box.replaceChildren();
  if (typeof window.qrcode === 'function') {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
    const svg = box.querySelector('svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '扫描二维码打开手机遥控页');
  } else {
    box.textContent = '二维码生成器未能加载，请使用下方链接打开遥控页。';
  }
  openDrawer('remote');
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
  resetLyricsEditor();
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
  if (room.ready) unlockAudio();
  try {
    const job = await api.getJob(id, { signal: request.signal });
    if (requestGeneration !== state.selectionRequestGeneration || request.signal.aborted || state.disposed) return;
    if (job.state === 'done') {
      if (!room.ready) { accountWaiting(); return; }
      if (accountMode()) { await addToRoom(id, true); return; }
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
      if (job.state === 'done' || isFailedJob(job)) {
        stopPolling();
        await refreshList();
        toast(job.state === 'done' ? '歌曲已制作完成，可在曲库点唱'
          : job.state === 'cancelled' ? '任务已取消，可在后台删除' : '制作失败，请在后台查看原因');
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
  $('#progressPanel').dataset.jobId = job.id || '';
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

async function showPlayer(job, generation = state.selectionGeneration, autoplay = true) {
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

  // 开唱先把麦克风接上（点歌那一下就是用户手势，此时申请授权才会被允许）。
  // 房间里没拿到播放权的那台设备不出声，也就不该顺手要走麦克风。
  if (autoplay || room.armed) autoEnableMic();
  if (accountMode()) {
    const guide = roomState()?.playback.guide;
    setSingMode(guide ? 'orig' : 'inst', false);
  } else setSingMode(state.singMode);
  if (autoplay) startPlayback();
  else if (accountMode()) {
    setAudioStatus(room.armed ? '' : '点「在本机播放」开始');
    applyRoomPlayback(true);
  }
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
  resetLyricsEditor();
  $('#editLyrics').classList.add('hidden');
  $('#searchLyrics').classList.add('hidden');
  $('#lyricSearch').classList.add('hidden');
  $('#lsQuery').value = '';
  $('#lyricSource').classList.add('hidden');
  await loadPlayerLyrics(job.id, state.lyricsUrl, generation);
  if (isCurrentPlayer(job.id, generation)) renderAlignmentStatus(job.id);
}

function refreshPlayerLyrics(jobId, url) {
  if (state.disposed || state.currentJobId !== jobId || state.editing
      || (state.lyrics && state.lyricsUrl === url && !state.lyricsRetryAt)
      || (state.lyricsRequest && state.lyricsRequestUrl === url)
      || Date.now() < state.lyricsRetryAt) return;
  loadPlayerLyrics(jobId, url, state.selectionGeneration, true);
}

async function loadPlayerLyrics(jobId, url, generation = state.selectionGeneration, bust = false) {
  if (!isCurrentPlayer(jobId, generation)) return;
  const revision = ++state.lyricsGeneration;
  state.lyricsRequest?.abort();
  const request = new AbortController();
  state.lyricsRequest = request;
  state.lyricsRequestUrl = url;
  state.lyricsRetryAt = 0;
  const box = $('#lyrics');
  if (!state.lyrics) box.innerHTML = '<p class="muted empty">正在载入歌词…</p>';
  try {
    if (bust) {
      // Room/catalog snapshots can lag a local edit; resolve the latest immutable path.
      const job = await api.getJob(jobId, { signal: request.signal });
      if (!isCurrentPlayer(jobId, generation) || revision !== state.lyricsGeneration || request.signal.aborted) return;
      url = job.media?.lyrics || null;
      state.lyricsRequestUrl = url;
      const index = state.allJobs.findIndex((j) => j.id === jobId);
      if (index >= 0) state.allJobs[index] = job;
    }
    if (!url) {
      state.lyrics = { lines: [] };
      state.lyricsUrl = null;
      $('#lyricSource').classList.add('hidden');
      renderLyrics();
      return;
    }
    const suffix = bust ? (url.includes('?') ? '&' : '?') + 't=' + Date.now() : '';
    const lyrics = await fetchJSON(url + suffix, { signal: request.signal, cache: 'no-cache' });
    if (!isCurrentPlayer(jobId, generation) || revision !== state.lyricsGeneration || request.signal.aborted) return;
    if (!lyrics || !Array.isArray(lyrics.lines)) throw new Error('歌词格式不正确');
    state.lyrics = lyrics;
    state.lyricsUrl = url;
    // 显示歌词来源徽章
    const badge = $('#lyricSource');
    const src = state.lyrics.source;
    if (src) { badge.textContent = '歌词来源：' + src; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
    renderLyrics();
  } catch (e) {
    if (isCurrentPlayer(jobId, generation) && revision === state.lyricsGeneration && !request.signal.aborted) {
      state.lyricsRetryAt = Date.now() + 3000;
      if (state.lyrics?.lines?.length) {
        renderLyrics();
        toast('新版歌词暂时无法载入，保留上次版本；稍后自动重试');
      } else {
        box.innerHTML = '<p class="muted empty">未能载入歌词。音乐可继续播放，稍后会自动重试。</p>';
      }
    }
  } finally {
    if (state.lyricsRequest === request) {
      state.lyricsRequest = null;
      state.lyricsRequestUrl = null;
    }
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
    div.addEventListener('click', () => { localGesture(); userSeek(ln.start + 0.001); });
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); e.stopPropagation(); localGesture(); userSeek(ln.start + 0.001); }
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
function formatLyricTime(value) {
  if (!Number.isFinite(value)) return '';
  const milliseconds = Math.round(value * 1000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return '';
  return String(Math.floor(milliseconds / 60000)).padStart(2, '0') + ':'
    + String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0') + '.'
    + String(milliseconds % 1000).padStart(3, '0');
}

function parseLyricTime(value) {
  const match = /^(?:(\d+):)?(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match || (match[1] !== undefined && Number(match[2]) >= 60)) return NaN;
  const seconds = Number(match[1] || 0) * 60 + Number(match[2]) + Number('0.' + (match[3] || '0'));
  return Number.isSafeInteger(Math.round(seconds * 1000)) ? seconds : NaN;
}

function lyricTimingNotice(message, error = false) {
  const notice = $('#lyricTimingNotice');
  notice.textContent = message;
  notice.classList.toggle('error', error);
}

function invalidLyricTime(message, field) {
  field?.setAttribute('aria-invalid', 'true');
  const error = new Error(message);
  error.field = field;
  throw error;
}

function lyricEditDuration() {
  const duration = Number.isFinite(inst.duration) ? inst.duration : Number(jobById(state.currentJobId)?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function validateLyricEdits(lines) {
  const duration = lyricEditDuration();
  let previous = -1;
  for (const line of lines) {
    const row = state.lyricEdit.rows[line.index];
    if (!Number.isFinite(line.start) || line.start < 0) {
      invalidLyricTime(`第 ${line.index + 1} 行开始时间无效，请填写秒数或分:秒，最多三位小数。`, row.start);
    }
    if (!Number.isFinite(line.end) || line.end < line.start) {
      invalidLyricTime(`第 ${line.index + 1} 行结束时间不能早于开始时间。`, row.end);
    }
    if (line.start < previous) {
      invalidLyricTime(`第 ${line.index + 1} 行不能早于上一行；补前奏请用「对齐整首」。`, row.start);
    }
    if (duration !== null && line.end > duration + 0.001) {
      invalidLyricTime(`第 ${line.index + 1} 行超出歌曲时长 ${formatLyricTime(duration)}，请检查结束时间或偏移量。`, row.end);
    }
    previous = line.start;
  }
  return lines;
}

function readLyricEdits() {
  const lines = state.lyricEdit.rows.map((row, index) => {
    row.text.removeAttribute('aria-invalid');
    row.start.removeAttribute('aria-invalid');
    row.end.removeAttribute('aria-invalid');
    return { index, start: parseLyricTime(row.start.value), end: parseLyricTime(row.end.value),
      text: row.text.value.trim() };
  }).filter(line => line.text);
  if (!lines.length) invalidLyricTime('歌词不能为空，请至少保留一行。', state.lyricEdit.rows[0]?.text);
  return validateLyricEdits(lines);
}

function showLyricTimingError(error) {
  lyricTimingNotice(error.message || '无法调整时间，请检查输入。', true);
  error.field?.focus();
}

function writeLyricTimes(lines) {
  validateLyricEdits(lines);
  for (const line of lines) {
    const row = state.lyricEdit.rows[line.index];
    row.start.value = formatLyricTime(line.start);
    row.end.value = formatLyricTime(line.end);
    row.start.removeAttribute('aria-invalid');
    row.end.removeAttribute('aria-invalid');
  }
  renderLyricEditProgress();
}

function shiftLyricTimes(delta, lines = readLyricEdits()) {
  if (!Number.isFinite(delta)) invalidLyricTime('请输入偏移秒数：正数延后，负数提前。', $('#lyricOffset'));
  writeLyricTimes(lines.map(line => ({ ...line,
    start: Math.round((line.start + delta) * 1000) / 1000,
    end: Math.round((line.end + delta) * 1000) / 1000 })));
  lyricTimingNotice(`整首歌词已${delta < 0 ? '提前' : '延后'} ${Number(Math.abs(delta).toFixed(3))} 秒，尚未保存。`);
}

function lyricEditPlayhead() {
  if (accountMode() && !room.armed) return null;
  return Number.isFinite(inst.currentTime) && lyricEditDuration() !== null ? inst.currentTime : null;
}

function alignLyricAtPlayhead(index, wholeSong) {
  const position = lyricEditPlayhead();
  if (position === null) throw new Error('请在实际播放设备上标记当前时间；本页仍可直接填写起止时间。');
  const lines = readLyricEdits();
  const selected = lines.find(line => line.index === index);
  if (!selected) invalidLyricTime('请先填写这一行的歌词。', state.lyricEdit.rows[index].text);
  const delta = Math.round((position - selected.start) * 1000) / 1000;
  if (wholeSong) shiftLyricTimes(delta, lines);
  else {
    writeLyricTimes(lines.map(line => line.index === index
      ? { ...line, start: Math.round(position * 1000) / 1000,
        end: Math.round((line.end + delta) * 1000) / 1000 } : line));
    lyricTimingNotice(`第 ${index + 1} 行已对齐到 ${formatLyricTime(position)}，其余行不变；尚未保存。`);
  }
}

function renderLyricEditProgress() {
  const draft = state.lyricEdit;
  if (!draft) return;
  const position = lyricEditPlayhead();
  $('#lyricEditPosition').textContent = position === null ? '本机未播放' : formatLyricTime(position);
  $('#lyricEditSeek').disabled = position === null;
  $('#lyricEditPlaybackHint').textContent = position === null
    ? '本机不是播放器；这里可改时间，当前时间请在播放设备上标记。'
    : '可暂停后拖动进度精确定位。点「试听本句」从这一句前一秒播放；对齐不需要重新识别。';
  if (position !== null && !room.seeking) {
    $('#lyricEditSeek').value = position / lyricEditDuration() * 1000;
    $('#lyricEditSeek').setAttribute('aria-valuetext', formatLyricTime(position));
  }
  for (const row of draft.rows) {
    const start = parseLyricTime(row.start.value), end = parseLyricTime(row.end.value);
    row.node.classList.toggle('is-current', position !== null && position >= start && position < end);
    for (const button of row.node.querySelectorAll('[data-playhead]')) {
      button.disabled = draft.saving || position === null;
    }
  }
}

function resetLyricsEditor() {
  state.editing = false;
  state.lyricEdit = null;
  $('#editBar').classList.add('hidden');
  $('#lyricTimingTools').classList.add('hidden');
  $('#lyrics').classList.remove('is-editing');
  $('#player').classList.remove('is-editing');
  $('#playerControls').classList.remove('hidden');
  $('#saveLyrics').disabled = $('#cancelLyrics').disabled = false;
  $('#saveLyrics').textContent = '保存';
  renderNowBar();
}

function setLyricEditBusy(busy) {
  state.lyricEdit.saving = busy;
  for (const control of document.querySelectorAll('#lyrics input, #lyrics [data-timing-change], #lyricTimingTools [data-timing-change], #lyricOffset, #cancelLyrics')) {
    control.disabled = busy;
  }
  $('#saveLyrics').disabled = busy;
  $('#saveLyrics').textContent = busy ? '保存中…' : '保存';
  renderLyricEditProgress();
}

function enterLyricsEdit() {
  const lines = state.lyrics?.lines || [];
  if (!lines.length || state.editing) return;
  state.editing = true;
  const draft = { rows: [], saving: false, lines };
  state.lyricEdit = draft;
  state.lyricsGeneration++;
  state.lyricsRequest?.abort();
  state.lyricsRequest = null;
  state.lyricsRequestUrl = null;
  stopLyricAnimation();
  const box = $('#lyrics');
  box.innerHTML = '';
  state.lineEls = [];
  lines.forEach((ln, i) => {
    const row = document.createElement('div');
    row.className = 'lyric-edit-row';
    const label = document.createElement('label');
    label.className = 'lyric-edit-label';
    label.htmlFor = 'lyric-text-' + i;
    label.textContent = `第 ${i + 1} 行`;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.id = label.htmlFor;
    inp.className = 'lyric-edit';
    inp.value = ln.text || '';
    inp.dataset.i = i;
    const fields = document.createElement('div');
    fields.className = 'lyric-time-fields';
    const times = {};
    for (const [key, text] of [['start', '开始'], ['end', '结束']]) {
      const timeLabel = document.createElement('label');
      timeLabel.textContent = text;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'lyric-time-input';
      input.dataset.time = key;
      input.value = formatLyricTime(ln[key]);
      input.placeholder = '00:12.500';
      input.setAttribute('aria-label', `第 ${i + 1} 行${text}时间`);
      input.addEventListener('change', () => {
        try { readLyricEdits(); lyricTimingNotice('时间已修改，尚未保存。'); }
        catch (error) { showLyricTimingError(error); }
        renderLyricEditProgress();
      });
      timeLabel.append(input);
      fields.append(timeLabel);
      times[key] = input;
    }
    const actions = document.createElement('div');
    actions.className = 'lyric-edit-actions';
    for (const [action, text] of [['line', '本行对齐'], ['all', '对齐整首'], ['preview', '试听本句']]) {
      const button = document.createElement('button');
      button.className = 'lyr-btn';
      button.textContent = text;
      button.dataset.action = action;
      button.setAttribute('aria-label', `第 ${i + 1} 行：${text}`);
      if (action !== 'preview') {
        button.dataset.playhead = '';
        button.dataset.timingChange = '';
        button.title = action === 'line' ? '把本行起点设为当前播放时间，保持本行时长'
          : '以这句的开口时间为准，平移所有歌词（补前奏）';
      }
      button.addEventListener('click', () => {
        if (state.lyricEdit !== draft) return;
        try {
          if (action !== 'preview') alignLyricAtPlayhead(i, action === 'all');
          else {
            const start = parseLyricTime(times.start.value);
            if (!Number.isFinite(start)) invalidLyricTime('请先填写这一行的开始时间。', times.start);
            localGesture();
            userSeek(Math.max(0, start - 1));
            if (!playbackAudible() && !state.playRequested) togglePlay();
            lyricTimingNotice(`从 ${formatLyricTime(Math.max(0, start - 1))} 开始试听，草稿未保存。`);
          }
        } catch (error) { showLyricTimingError(error); }
      });
      actions.append(button);
    }
    row.append(label, inp, fields, actions);
    box.append(row);
    draft.rows.push({ node: row, text: inp, ...times });
  });
  box.classList.add('is-editing');
  $('#player').classList.add('is-editing');
  $('#playerControls').classList.add('hidden');
  $('#lyricTimingTools').classList.remove('hidden');
  $('#lyricOffset').value = '0';
  $('#lyricOffset').removeAttribute('aria-invalid');
  for (const control of $('#lyricTimingTools').querySelectorAll('[data-timing-change], #lyricOffset')) control.disabled = false;
  lyricTimingNotice('调整尚未保存，可试听或取消。');
  $('#editBar').classList.remove('hidden');
  $('#editLyrics').classList.add('hidden');
  $('#searchLyrics').classList.add('hidden');
  $('#lyricSearch').classList.add('hidden');
  renderTransportLabels();
  renderNowBar();
  draft.rows[Math.max(0, state.activeLine)]?.text.focus();
}

function exitLyricsEdit() {
  resetLyricsEditor();
  renderLyrics();
  const current = accountMode() ? roomCurrent() : jobById(state.currentJobId);
  if (current) refreshPlayerLyrics(state.currentJobId, current.media?.lyrics || null);
}

async function saveLyricsEdit() {
  const draft = state.lyricEdit;
  if (!state.editing || !draft || draft.saving) return;
  const jobId = state.currentJobId;
  const generation = state.selectionGeneration;
  const lyricsUrl = state.lyricsUrl;
  const lyrics = state.lyrics;
  let lines;
  try {
    lines = readLyricEdits().map(({ index, start, end, text }) => {
      const original = draft.lines[index];
      const span = original.end - original.start;
      const moved = start !== original.start || end !== original.end;
      // Move/stretch word timing with its line without losing the original gaps.
      const time = value => Math.round(Math.max(start, Math.min(end,
        start + (value - original.start) * (end - start) / span)) * 1000) / 1000;
      const words = moved && !(span > 0) ? [] : (original.words || []).map(word => ({
        ...word, text: word.text ?? word.word ?? '',
        start: moved ? time(word.start) : word.start, end: moved ? time(word.end) : word.end,
      }));
      return { start, end, text, words };
    });
  } catch (error) { showLyricTimingError(error); return; }
  setLyricEditBusy(true);
  try {
    await api.updateLyrics(jobId, {
      lines, language: lyrics.language, source: lyrics.source, base_lyrics_url: lyricsUrl,
    });
    if (!isCurrentPlayer(jobId, generation) || state.lyricEdit !== draft) return;
    resetLyricsEditor();
    await loadPlayerLyrics(jobId, lyricsUrl, generation, true);
    refreshList(true);
  } catch (e) {
    if (isCurrentPlayer(jobId, generation) && state.lyricEdit === draft) showLyricTimingError(e);
  } finally {
    if (isCurrentPlayer(jobId, generation) && state.lyricEdit === draft) {
      setLyricEditBusy(false);
    }
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

/* ---------- 用户偏好 ----------
   独立部署时仍然存在这台浏览器本地（换台设备互不影响）；
   接上账号服务后偏好同时跟着「人」和「这台设备」走，由服务端保存，
   本地不再留档，免得共用浏览器把上一个人的设置留给下一个人。 */
const PREF_KEY = 'openk.prefs';
const PREF_DEFAULTS = {
  micMonitor: true,   // 默认把麦克风外放——真正的 KTV 就是插上麦就有声
  micVol: 110,        // 裸麦（关掉 AGC）电平远低于成品伴奏，得给到 1 以上才压得住
  howlGuard: true,    // 外放就必然有啸叫风险，防护默认开着
  reverb: 'ktv',
  singMode: 'inst',   // KTV 默认伴唱
  view: 'list',
  instVol: 100,       // 伴奏音量
  vocalVol: 0,        // 导唱人声音量
  outVol: 100,        // 本机输出音量：跟着这台设备走
  audioIn: '',        // 麦克风输入设备；浏览器给的 id 只在本来源有效，不可搬到别的设备
  audioOut: '',       // 输出设备（需要浏览器支持 setSinkId）
  v: 2,               // 偏好版本，用来做一次性迁移
};
// 服务端字段名 ←→ 本地字段名。服务端那套名字同时被 /devices 页面使用。
const PREF_FIELDS = {
  singMode: 'sing_mode', reverb: 'reverb', view: 'view',
  micMonitor: 'mic_monitor', micVol: 'mic_volume', howlGuard: 'howl_guard',
  instVol: 'accompaniment_volume', vocalVol: 'guide_volume',
  outVol: 'output_volume', audioIn: 'audio_input', audioOut: 'audio_output',
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
/** 传入改动过的本地字段名；账号模式下只把这几项交给服务端。 */
function savePrefs(...keys) {
  if (accountMode()) { pushPrefs(keys); return; }
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
}
function pushPrefs(keys) {
  const api = window.OpenKUserState;
  if (!api?.enabled) return;
  const patch = {};
  for (const key of keys.length ? keys : Object.keys(PREF_FIELDS)) {
    if (PREF_FIELDS[key] && prefs[key] !== undefined) patch[PREF_FIELDS[key]] = prefs[key];
  }
  if (Object.keys(patch).length) api.save(patch);
}

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
  actx.addEventListener?.('statechange', () => {
    if (accountMode() && room.armed && actx.state !== 'running') {
      disarmLocalPlayer('声音被系统暂停，请点击「在本机播放」恢复。');
    }
  });
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
  // 本机输出音量属于这台设备：只压扬声器总线，录音仍然保持原电平。
  const raw = Number(prefs.outVol);
  const ov = (Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 100) / 100;
  const g = state.audioGraph;
  if (g) {
    // 图存在时媒体元素必须保持满音量：element.volume=0 会让
    // MediaElementSource 直接输出静音，导致导唱人声/混响再怎么调增益都没声。
    // 实际音量改由增益节点控制。
    inst.volume = 1; vocal.volume = 1;
    g.instGain.gain.value = iv; g.vocalGain.gain.value = vv;
    g.speakerBus.gain.value = ov;
  } else {
    inst.volume = iv * ov; vocal.volume = vv * ov;
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
    return bounded(Promise.resolve(g.actx.state !== 'running' ? g.actx.resume() : undefined), 8000, '音频启动超时')
      .then(() => {
        if (g.actx.state === 'running') return true;
        setAudioStatus('点击播放以启用音频');
        return false;
      }, () => { setAudioStatus('点击播放以启用音频'); return false; });
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
  if (accountMode()) { toggleRoomPlay(); return; }
  if (inst.paused && !state.playRequested) startPlayback();
  else pausePlayback();
}

/** 录唱要从头唱。账号模式下房间也得回到 0，其他设备看到的进度才不会骗人。 */
function restartForRecording() {
  seekTo(0);
  if (accountMode() && room.armed && roomItemId()) {
    roomTransport('restart', { item_id: roomItemId() });
  }
}

/** 录音 / 连唱时的「就从这里放」。账号模式下同时把房间切到播放态，
 *  但不等网络往返——录音起头那一两秒不能是空的。 */
async function beginPlayback() {
  if (accountMode() && room.armed && roomItemId()) roomTransport('play');
  return startPlayback();
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
  renderTransportLabels();
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
    // 选了具体输入设备就按它取流；这台机器上找不到就退回默认设备并明说，
    // 绝不假装换成功了。设备 id 只在本浏览器本来源有效，不会被搬到别的设备。
    const chosen = typeof prefs.audioIn === 'string' ? prefs.audioIn : '';
    const capture = (deviceId) => navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    Promise.resolve().then(() => capture(chosen).catch((error) => {
      if (!chosen || !['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error;
      micHint('选定的麦克风在这台设备上不可用，已改用系统默认麦克风。');
      return capture('');
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
    restartForRecording();
    state.recordingSession = session;
    state.recorder = mr;
    state.recStart = session.startedAt;
    mr.start(1000);
    state.recording = true;
    $('#recBtn').disabled = false;
    $('#recBtn').textContent = '⏹ 停止并保存';
    $('#recBtn').classList.add('recording');
    if (!await beginPlayback() || !isCurrentPlayer(jobId, generation)) {
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
  renderTransportLabels();
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
  for (const id of ['#playBtn', '#lyricEditPlay']) {
    $(id).addEventListener('click', () => { localGesture(); togglePlay(); });
  }

  inst.addEventListener('play', () => {
    renderTransportLabels();
    startLyricAnimation();
  });
  inst.addEventListener('pause', () => {
    renderTransportLabels();
    stopLyricAnimation();
  });
  inst.addEventListener('loadedmetadata', () => {
    $('#durTime').textContent = fmt(inst.duration);
    // 房间下发的进度可能在媒体就绪前就到了，这里补上那一次定位。
    if (accountMode() && room.seekTarget !== null && Number.isFinite(inst.duration)) {
      const target = room.seekTarget;
      room.seekTarget = null;
      seekTo(target);
    }
  });
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
    renderTransportLabels();
    if (hasVocal()) vocal.pause();
  });

  inst.addEventListener('timeupdate', () => {
    const t = inst.currentTime;
    renderLyricEditProgress();
    if (!room.seeking) {
      $('#curTime').textContent = fmt(t);
      if (inst.duration) $('#seek').value = Math.round((t / inst.duration) * 1000);
      $('#seek').setAttribute('aria-valuetext', `${fmt(t)} / ${fmt(inst.duration)}`);
    }
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

  for (const id of ['#seek', '#lyricEditSeek']) {
    $(id).addEventListener('input', (e) => {
      if (!inst.duration) return;
      const t = (e.target.value / 1000) * inst.duration;
      localGesture();
      if (accountMode()) {
        if (!room.seeking) room.seekSession = { room: room.id, item: roomItemId() };
        room.seeking = true;
        if (room.armed) seekTo(t);
      } else userSeek(t);
      $('#curTime').textContent = fmt(t);
      $('#seek').setAttribute('aria-valuetext', `${fmt(t)} / ${fmt(inst.duration)}`);
      if (state.editing) {
        $('#lyricEditPosition').textContent = formatLyricTime(t);
        $('#lyricEditSeek').setAttribute('aria-valuetext', formatLyricTime(t));
      }
      updateLyrics(t);
    });
    $(id).addEventListener('change', (e) => {
      if (!accountMode()) return;
      const session = room.seekSession;
      room.seeking = false;
      room.seekSession = null;
      if (!session || session.room !== room.id || session.item !== roomItemId()) {
        toast('歌曲或房间已切换，这次拖动已取消。');
        applyRoomPlayback(true);
        return;
      }
      if (Number.isFinite(inst.duration)) userSeek((e.target.value / 1000) * inst.duration);
    });
  }

  $('#instVol').addEventListener('input', () => {
    prefs.instVol = Number($('#instVol').value);
    applyVolumes();
    savePrefs('instVol');
  });
  $('#vocalVol').addEventListener('input', () => {
    prefs.vocalVol = Number($('#vocalVol').value);
    applyVolumes();
    savePrefs('vocalVol');
  });
  $('#instVol').value = prefs.instVol;
  $('#vocalVol').value = prefs.vocalVol;
  const outVol = $('#outVol');
  if (outVol) {
    outVol.value = prefs.outVol;
    $('#outVolVal').textContent = prefs.outVol + '%';
    outVol.addEventListener('input', () => {
      prefs.outVol = Number(outVol.value);
      $('#outVolVal').textContent = prefs.outVol + '%';
      applyVolumes();
      savePrefs('outVol');
    });
  }
  const audioIn = $('#audioIn'), audioOut = $('#audioOut');
  if (audioIn) {
    audioIn.addEventListener('change', () => {
      prefs.audioIn = audioIn.value;
      savePrefs('audioIn');
      // 换麦克风要重新取流，所以先断开；下一次监听/录音的手势会按新选择连上。
      if (state.audioGraph?.mic) {
        cleanupMic();
        micHint('麦克风已更换，请重新开启监听以连接新设备。');
      }
    });
  }
  if (audioOut) {
    audioOut.addEventListener('change', async () => {
      prefs.audioOut = audioOut.value;
      savePrefs('audioOut');
      if (!await applyOutputDevice()) audioOut.value = prefs.audioOut;
    });
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { refreshMediaDevices(); });
  refreshMediaDevices();
  applyOutputDevice();
  applyVolumes();
  $('#reverb').value = prefs.reverb;
  $('#reverb').addEventListener('change', () => {
    prefs.reverb = $('#reverb').value;
    savePrefs('reverb');
    setReverb(prefs.reverb);
  });
  $('#editLyrics').addEventListener('click', enterLyricsEdit);
  $('#saveLyrics').addEventListener('click', saveLyricsEdit);
  $('#applyLyricOffset').addEventListener('click', () => {
    if (!state.lyricEdit || state.lyricEdit.saving) return;
    try {
      const value = $('#lyricOffset').value.trim();
      shiftLyricTimes(value ? Number(value) : NaN);
      $('#lyricOffset').value = '0';
      $('#lyricOffset').removeAttribute('aria-invalid');
    } catch (error) { showLyricTimingError(error); }
  });
  for (const button of document.querySelectorAll('[data-lyric-shift]')) {
    button.addEventListener('click', () => {
      if (!state.lyricEdit || state.lyricEdit.saving) return;
      try { shiftLyricTimes(Number(button.dataset.lyricShift)); }
      catch (error) { showLyricTimingError(error); }
    });
  }
  $('#resetLyricTiming').addEventListener('click', () => {
    const draft = state.lyricEdit;
    if (!draft || draft.saving) return;
    draft.rows.forEach((row, i) => {
      row.start.value = formatLyricTime(draft.lines[i].start);
      row.end.value = formatLyricTime(draft.lines[i].end);
      row.start.removeAttribute('aria-invalid');
      row.end.removeAttribute('aria-invalid');
    });
    $('#lyricOffset').value = '0';
    $('#lyricOffset').removeAttribute('aria-invalid');
    lyricTimingNotice('已还原打开编辑器时的时间，文字修改仍保留；尚未保存。');
    renderLyricEditProgress();
  });
  $('#cancelLyrics').addEventListener('click', exitLyricsEdit);
  $('#searchLyrics').addEventListener('click', () => toggleLyricSearch());
  $('#lsGo').addEventListener('click', doLyricSearch);
  $('#lsClose').addEventListener('click', () => toggleLyricSearch(false));
  $('#lsQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLyricSearch(); });
  $('#recBtn').addEventListener('click', () => {
    localGesture();
    if (!state.recording) return startRecording();
    stopRecording();
    // 主动停录音就是「这一段唱完了」，房间里其他人的进度条也该跟着停。
    // 换歌时 stopAudio 内部那次停止不走这里，免得把下一首刚开的播放又摁停。
    if (accountMode() && room.armed) roomTransport('pause');
  });
  $('#micVol').value = prefs.micVol;
  const showMicVol = () => { $('#micVolVal').textContent = prefs.micVol + '%'; };
  showMicVol();
  $('#micVol').addEventListener('input', (e) => {
    prefs.micVol = Number(e.target.value);
    savePrefs('micVol');
    showMicVol();
    const g = state.audioGraph;
    if (g && g.mic) g.mic.micGain.gain.value = prefs.micVol / 100;
  });

  $('#monitor').checked = prefs.micMonitor;
  $('#monitor').addEventListener('change', async () => {
    const on = $('#monitor').checked;
    prefs.micMonitor = on;
    savePrefs('micMonitor');
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
      savePrefs('howlGuard');
      if (!hg.checked) resetHowlGuard();
      howlHint(hg.checked ? '' : '⚠️ 防啸叫已关闭，麦克风离音箱近了会尖叫');
    });
  }

}

function interactiveTarget(target) {
  return target?.closest?.('input, textarea, select, button, a, [contenteditable], [role="button"]');
}

function handleKeys(e) {
  const drawer = document.querySelector('.drawer:not(.hidden)');
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
  if (e.code === 'Space' && state.currentJobId) { e.preventDefault(); localGesture(); togglePlay(); }
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
}

/* ---------------- 初始化 ---------------- */
function init() {
  // Playback and restoring a local queue require an explicit account-mode response.
  initAccount().catch(accountFailed);

  /* 顶部：搜索 / 已点 / 后台 */
  let composing = false;
  const onSearch = (event) => {
    if (composing || event?.isComposing) return;
    state.search = $('#search').value;
    state.browsePage = 1;
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
  $('#remoteLink').addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    openRemoteQR();
  });
  $('#queueClose').addEventListener('click', closeDrawers);
  $('#adminClose').addEventListener('click', closeDrawers);
  $('#remoteClose').addEventListener('click', closeDrawers);
  $('#scrim').addEventListener('click', closeDrawers);
  $('#queueClear').addEventListener('click', () => {
    if (accountMode()) {
      if (!room.items.length || !confirm('清空房间里的已点歌曲？')) return;
      roomTransport('clear', { expected_revision: roomState()?.revision });
      return;
    }
    if (!state.queue.length || !confirm('清空已点歌曲？')) return;
    state.queue = []; saveQueue(); renderQueue(); renderBrowse();
  });

  /* 分类页签 */
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.libMode = btn.dataset.tab;
      state.artistPick = null;
      state.artistReturn = null;
      state.browseLetter = '';
      state.browsePage = 1;
      document.querySelectorAll('.tab').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      renderBrowse(true);
      refreshPopularity(true);
    });
  });
  $('#browseAlphabet').open = window.innerWidth >= 900;
  $('#browseIndex').addEventListener('click', event => {
    const button = event.target.closest('[data-letter]');
    if (!button || button.disabled) return;
    state.browseLetter = button.dataset.letter;
    state.browsePage = 1;
    if (window.innerWidth < 700) $('#browseAlphabet').open = false;
    renderBrowse(true);
  });
  $('#browsePager').addEventListener('click', event => {
    const button = event.target.closest('[data-page-step]');
    if (!button || button.disabled) return;
    state.browsePage += Number(button.dataset.pageStep);
    renderBrowse(true);
    $('.library-heading').scrollIntoView?.({ block: 'start' });
  });
  $('#artistBack').addEventListener('click', () => {
    state.artistPick = null;
    state.artistLabel = null;
    state.browseLetter = state.artistReturn?.letter || '';
    state.browsePage = state.artistReturn?.page || 1;
    state.artistReturn = null;
    renderBrowse(true);
  });
  $('#refreshPopularity').addEventListener('click', () => refreshPopularity(true));

  /* 曲库网格：整卡点一下就是点歌，右下角 ▶ 是「插队马上唱」 */
  $('#grid').addEventListener('click', (e) => {
    const card = e.target.closest('.song-card');
    if (!card) return;
    localGesture();
    addToQueue(card.dataset.id, e.target.dataset.act === 'play');
  });
  $('#artistList').addEventListener('click', (e) => {
    const chip = e.target.closest('.artist-chip');
    if (!chip) return;
    state.artistReturn = { letter: state.browseLetter, page: state.browsePage };
    state.artistPick = chip.dataset.artist;
    state.artistLabel = chip.querySelector('span').textContent;
    state.browseLetter = '';
    state.browsePage = 1;
    renderBrowse(true);
  });

  /* 已点列表：置顶 / 删除 / 直接唱。账号模式下这些动作认房间条目 ID，
     所以同一首歌点了两次也能分别处理。 */
  $('#queueList').addEventListener('click', (e) => {
    const li = e.target.closest('.q-item');
    if (!li) return;
    const act = e.target.dataset.act;
    localGesture();
    if (accountMode()) {
      const item = li.dataset.item;
      if (!item) return;
      if (act === 'top') roomTransport('top', { item_id: item });
      else if (act === 'del') roomTransport('remove', { item_id: item });
      else { closeDrawers(); singRoomItemNow(item); }
      return;
    }
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
    if (e.target.dataset.act === 'delete') {
      await deleteFailedJob(li.dataset.id);
    } else if (e.target.dataset.act === 'retry') {
      if (state.deletingJobs.has(li.dataset.id)) return;
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
    prefs.view = state.view; savePrefs('view');
    renderBrowse(true);
  });
  $('#songList').addEventListener('click', (e) => {
    const row = e.target.closest('.song-row');
    if (!row) return;
    localGesture();
    addToQueue(row.dataset.id);
  });
  $('#langBar').addEventListener('click', (e) => {
    const b = e.target.closest('.lang-btn');
    if (!b) return;
    state.lang = b.dataset.lang;
    state.browsePage = 1;
    $('#langBar').dataset.sig = '';      // 强制重画选中态
    renderBrowse(true);
  });

  /* 常驻控制条 */
  $('#nbOpen').addEventListener('click', () => { if (state.currentJobId) showStage(); });
  $('#nbCover').addEventListener('click', () => { if (state.currentJobId) showStage(); });
  $('#nbPlay').addEventListener('click', () => { localGesture(); togglePlay(); renderNowBar(); });
  $('#nbReplay').addEventListener('click', () => {
    localGesture();
    if (accountMode()) { restartRoomSong(); return; }
    seekTo(0);
    if (inst.paused) togglePlay();
    renderNowBar();
  });
  $('#nbSkip').addEventListener('click', () => {
    localGesture();
    if (accountMode()) { skipRoomSong(); return; }
    if (state.queue.length) playFromQueue();
    else { toast('已点列表空了，没有下一首'); endPlayback(); }
  });
  $('#nbQueue').addEventListener('click', () => openDrawer('queue'));
  $('#modeInst').addEventListener('click', () => { localGesture(); setSingModeIntent('inst'); });
  $('#modeOrig').addEventListener('click', () => { localGesture(); setSingModeIntent('orig'); });
  $('#roomActivate')?.addEventListener('click', () => { localGesture(); activateLocalPlayer(); });
  // 保存失败必须看得见，不能让人以为已经存上了。
  window.OpenKUserState?.onchange(() => {
    const problems = window.OpenKUserState.problems;
    prefsStatus(problems.length ? '未保存：' + problems[0] : '');
    renderRoomStatus();
  });
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
  // 一首唱完自动接下一首，这是 KTV 机器最基本的行为。
  // 账号模式下推进队列的是服务端：本机只汇报「这首唱完了」，不跟房间抢顺序。
  inst.addEventListener('ended', () => {
    cancelEndedTimer();
    if (accountMode()) { if (room.armed) reportRoomEnded(); return; }
    const generation = state.selectionGeneration, id = state.currentJobId;
    state.endedTimer = setTimeout(() => {
      state.endedTimer = null;
      if (id && isCurrentPlayer(id, generation)) playFromQueue(true);
    }, 800);
  });
  // 独占租约 12 秒：2.5 秒续一次，8.5 秒续不上就立刻停声，免得两台机器同时响。
  room.heartbeatTimer = setInterval(() => { roomHeartbeat(); }, LEASE_RENEW_MS);
  room.watchdog = setInterval(leaseWatchdog, 500);
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
      refreshPopularity(true);
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
    libraryPopularity.reset();
    if (accountMode()) {
      const client = room.client, token = room.playerToken;
      if (client && token) {
        client.releaseOnUnload(token).catch(error => console.warn('Page exit could not release the player lease:', error));
      }
      disarmLocalPlayer('', { reset: true, release: false });
      client?.stop();
    }
    if (state.recording) stopRecording();
    pausePlayback();
    cleanupMic();
    invalidateSelection();
    state.monitorHidden = prefs.micMonitor;
    if (!e.persisted) {
      state.disposed = true;
      clearInterval(room.heartbeatTimer);
      clearInterval(room.watchdog);
      stopPolling();
      clearTimeout(state.listTimer);
      state.alignmentTimers.forEach(clearTimeout);
      state.alignmentRequests.forEach((r) => r.abort());
      state.audioGraph?.actx.close?.();
    }
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      if (accountMode()) recoverRoom().catch(reportRoomError);
      applyMonitorState();
      scheduleListRefresh();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
