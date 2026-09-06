(() => {
  'use strict';
  const { RoomClient, request, saved, clock } = OpenKRoom;
  const $ = selector => document.querySelector(selector);
  class Remote {
    constructor() {
      this.client = null;
      this.jobs = [];
      this.zhMap = {};
      this.librarySearch = OpenKSearch.create();
      this.search = '';
      this.composing = false;
      this.limit = 50;
      this.joining = false;
      this.loading = false;
      this.queueRevision = -1;
      this.bind();
      this.start();
    }
    notice(message) {
      $('#remoteNotice').textContent = message;
      $('#remoteNotice').hidden = false;
      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => { $('#remoteNotice').hidden = true; }, 4500);
    }
    start() {
      const fragment = new URLSearchParams(location.hash.slice(1));
      const room = fragment.get('room'), code = fragment.get('code');
      // Remove the pairing capability immediately, including before any artwork loads.
      if (location.hash) history.replaceState(null, '', location.pathname);
      const previous = saved('openk.remote.room');
      if (room) $('#joinRoom').value = room;
      if (code) $('#joinCode').value = code;
      if (previous && (!room || previous.roomId === room)) {
        this.connect(previous);
      } else if (/^[a-f0-9]{10}$/i.test(room || '') && /^\d{6}$/.test(code || '')) {
        this.join();
      }
    }
    bind() {
      $('#joinForm').onsubmit = event => { event.preventDefault(); this.join(); };
      $('#leaveRoom').onclick = () => this.leave();
      $('#songSearch').oninput = event => {
        clearTimeout(this.searchTimer);
        if (event.isComposing) this.composing = true;
        if (this.composing || event.isComposing) return;
        this.searchTimer = setTimeout(() => { this.limit = 50; this.renderLibrary(); }, 100);
      };
      $('#songSearch').addEventListener('compositionstart', () => {
        this.composing = true;
        clearTimeout(this.searchTimer);
      });
      $('#songSearch').addEventListener('compositionend', () => {
        this.composing = false;
        clearTimeout(this.searchTimer);
        this.limit = 50;
        this.renderLibrary();
      });
      $('#refreshLibrary').onclick = () => this.loadLibrary();
      $('#showMore').onclick = () => { this.limit += 50; this.renderLibrary(); };
      $('#openQueue').onclick = () => this.queue(true);
      $('#closeQueue').onclick = () => this.queue(false);
      $('#queuePanel').onclick = event => { if (event.target === $('#queuePanel')) this.queue(false); };
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !$('#queuePanel').hidden) { event.preventDefault(); this.queue(false); }
        if (event.key === 'Tab' && !$('#queuePanel').hidden) {
          const items = [...$('#queuePanel').querySelectorAll('button:not(:disabled)')];
          if (event.shiftKey && document.activeElement === items[0]) {
            event.preventDefault(); items[items.length - 1].focus();
          } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
            event.preventDefault(); items[0].focus();
          }
        }
      });
      $('#clearQueue').onclick = () => {
        const revision = this.client?.state?.revision;
        if (this.clearRevision !== revision) {
          this.clearRevision = revision;
          $('#clearQueue').textContent = '再点一次，确认清空';
          clearTimeout(this.clearTimer);
          this.clearTimer = setTimeout(() => {
            this.clearRevision = null;
            $('#clearQueue').textContent = '清空待唱';
          }, 3500);
          return;
        }
        this.run($('#clearQueue'), 'clear', { expected_revision: revision }, '待唱队列已清空');
        this.clearRevision = null;
      };
      $('#remotePlay').onclick = () => this.run($('#remotePlay'),
        this.client.state.playback.playing ? 'pause' : 'play');
      $('#remoteGuide').onclick = () => this.run($('#remoteGuide'), 'guide',
        { enabled: !this.client.state.playback.guide });
      $('#remoteRestart').onclick = () => this.run($('#remoteRestart'), 'restart',
        { item_id: this.client.state.current.id }, '从头开始');
      $('#remoteNext').onclick = () => this.run($('#remoteNext'), 'next',
        { item_id: this.client.state.current.id }, '已切换下一首');
      $('#seek').oninput = () => { this.seeking = true; $('#remoteElapsed').textContent = clock($('#seek').value); };
      $('#seek').onchange = () => {
        this.seeking = false;
        const item = this.client?.state.current;
        if (item) this.run($('#seek'), 'seek', { item_id: item.id, position: Number($('#seek').value) });
      };
      window.addEventListener('online', () => {
        this.client?.start();
        this.client?.refresh().catch(() => {});
      });
      window.addEventListener('pagehide', () => this.client?.stop());
    }
    async join() {
      if (this.joining) return;
      this.joining = true;
      $('#joinSubmit').disabled = true;
      $('#joinError').textContent = '';
      const roomId = $('#joinRoom').value.trim().toLowerCase();
      const code = $('#joinCode').value.trim();
      try {
        const result = await RoomClient.join(roomId, code);
        const credentials = { roomId, token: result.controller_token };
        saved('openk.remote.room', credentials);
        $('#joinCode').value = '';
        this.connect(credentials, result.state);
      } catch (error) { $('#joinError').textContent = error.message; }
      finally { this.joining = false; $('#joinSubmit').disabled = false; }
    }
    connect(credentials, state) {
      this.client?.stop();
      this.client = new RoomClient(credentials.roomId, credentials.token);
      const client = this.client;
      this.queueRevision = -1;
      this.client.onstate = current => { if (this.client === client) this.render(current); };
      this.client.onconnection = (connection, error) => {
        if (this.client !== client) return;
        $('#remoteConnection').textContent = {
          connected: '● 房间已连接', reconnecting: '◌ 正在重连…', expired: '需要重新配对',
        }[connection];
        if (connection === 'expired') {
          this.leave();
          $('#joinError').textContent = error.message;
        }
      };
      $('#joinScreen').hidden = true;
      $('#roomScreen').hidden = false;
      $('#leaveRoom').hidden = false;
      $('#remoteRoom').textContent = 'LIVE ROOM / ' + credentials.roomId;
      if (state) this.client.accept(state);
      this.client.start();
      this.loadLibrary();
    }
    leave() {
      this.client?.stop();
      this.client = null;
      saved('openk.remote.room', null);
      $('#roomScreen').hidden = true;
      $('#joinScreen').hidden = false;
      $('#leaveRoom').hidden = true;
      $('#queuePanel').hidden = true;
      $('#remoteConnection').textContent = '尚未加入';
      document.body.classList.remove('sheet-open');
    }
    async loadLibrary() {
      if (this.loading) return;
      this.loading = true;
      $('#refreshLibrary').disabled = true;
      $('#libraryStatus').textContent = '正在读取 NAS 曲库…';
      try {
        const [jobs, mapping] = await Promise.all([
          request('/api/jobs'),
          request('/api/zh-map').catch(() => ({})),
        ]);
        this.zhMap = mapping;
        this.librarySearch.setMap(mapping);
        this.jobs = jobs.filter(job => job.state === 'done' && job.media?.instrumental);
        this.renderLibrary();
      } catch (error) {
        $('#libraryStatus').textContent = error.message + '。点击「刷新曲库」重试。';
      } finally { this.loading = false; $('#refreshLibrary').disabled = false; }
    }
    renderLibrary() {
      if (!this.composing) this.search = $('#songSearch').value;
      const query = this.librarySearch.query(this.search);
      const jobs = this.librarySearch.search(this.jobs, query);
      $('#libraryCount').textContent = query.text
        ? `${jobs.length} / ${this.jobs.length} 首` : this.jobs.length + ' 首';
      const list = $('#roomSongList');
      list.replaceChildren();
      for (const job of jobs.slice(0, this.limit)) {
        const row = document.createElement('li');
        row.className = 'room-song';
        const art = document.createElement('div');
        art.className = 'song-art';
        art.textContent = '♪';
        if (job.thumbnail) {
          try {
            const url = new URL(job.thumbnail, location.href);
            if (url.origin === location.origin && url.pathname.startsWith('/media/')) {
              const image = document.createElement('img');
              image.src = url.href; image.alt = ''; image.loading = 'lazy';
              image.onerror = () => image.remove();
              art.append(image);
            }
          } catch { /* A missing/invalid thumbnail is decorative. */ }
        }
        const info = document.createElement('div');
        info.className = 'song-info';
        const title = document.createElement('strong');
        title.textContent = job.track || job.title || '未命名歌曲';
        const subtitle = document.createElement('span');
        subtitle.textContent = (job.artist || '未知歌手') + ' · ' + clock(job.duration)
          + (!job.media.lyrics ? ' · 纯伴奏' : '');
        info.append(title, subtitle);
        const add = document.createElement('button');
        add.className = 'add-song';
        add.textContent = '+';
        add.setAttribute('aria-label', '点歌：' + title.textContent);
        add.onclick = () => this.run(add, 'add', { job_id: job.id }, '已点 · ' + title.textContent);
        row.append(art, info, add);
        list.append(row);
      }
      $('#libraryStatus').textContent = jobs.length ? ''
        : query.text ? '没有匹配的歌曲。试试歌名、歌手、全拼或首字母，也可用空格组合搜索。'
          : '曲库还没有准备好的歌曲。请在经典点歌台导入并完成处理。';
      $('#showMore').hidden = jobs.length <= this.limit;
    }
    async run(button, action, payload = {}, success) {
      if (!this.client || button.dataset.busy) return;
      button.dataset.busy = 'true';
      button.disabled = true;
      try {
        await this.client.command(action, payload);
        if (success) this.notice(success);
      } catch (error) { this.notice(error.message); }
      finally {
        delete button.dataset.busy;
        button.disabled = false;
        if (this.client?.state) this.render(this.client.state);
      }
    }
    render(state) {
      const item = state.current;
      $('#remoteTitle').textContent = item?.title || '为今晚点第一首歌';
      $('#remoteArtist').textContent = item?.artist || (item ? '一起唱，就是好时光' : '点歌后，在电视上启用声音');
      const status = {
        offline: '电视未启用声音 · 请在大屏按确认键',
        ready: '电视已就绪 · 选一首喜欢的歌',
        playing: '声音正在电视播放', paused: '已暂停', buffering: '电视正在缓冲…',
        blocked: '浏览器等待确认 · 请在电视上重试声音', error: '电视音频加载失败 · 可重试或切歌',
      };
      $('#playerStatus').textContent = status[state.player.status] || '等待电视连接';
      if (!this.seeking) {
        $('#remoteElapsed').textContent = clock(state.player.position);
        $('#seek').value = state.player.position || 0;
      }
      $('#remoteDuration').textContent = clock(item?.duration);
      $('#seek').max = item?.duration || 1;
      $('#seek').disabled = !item?.duration || !!$('#seek').dataset.busy;
      $('#remotePlay').textContent = state.playback.playing ? 'Ⅱ' : '▶';
      $('#remotePlay').setAttribute('aria-label', state.playback.playing ? '暂停' : '播放');
      for (const selector of ['#remotePlay', '#remoteRestart', '#remoteNext']) {
        $(selector).disabled = !item || !!$(selector).dataset.busy;
      }
      $('#remoteGuide').disabled = !item?.media.vocals || !!$('#remoteGuide').dataset.busy;
      $('#remoteGuide').setAttribute('aria-pressed', String(state.playback.guide));
      $('#remoteGuide small').textContent = !item?.media.vocals ? '无音轨'
        : state.playback.guide ? '已开启' : '已关闭';
      $('#remoteQueueCount').textContent = state.queue.length;
      if (this.queueRevision !== state.revision) {
        this.queueRevision = state.revision;
        this.renderQueue(state);
      }
    }
    queue(show) {
      $('#queuePanel').hidden = !show;
      document.body.classList.toggle('sheet-open', show);
      if (show) $('#closeQueue').focus();
      else $('#openQueue').focus();
    }
    renderQueue(state) {
      const list = $('#remoteQueue');
      const focused = document.activeElement?.dataset.focusKey;
      list.replaceChildren();
      $('#queueNow').textContent = '正在唱 · ' + (state.current?.title || '等待点歌');
      $('#queueSummary').textContent = state.queue.length + ' 首待唱 · 按点歌顺序播放';
      $('#queueEmpty').hidden = state.queue.length > 0;
      $('#clearQueue').disabled = state.queue.length === 0 || !!$('#clearQueue').dataset.busy;
      $('#clearQueue').textContent = '清空待唱';
      this.clearRevision = null;
      state.queue.forEach((item, index) => {
        const row = document.createElement('li');
        const number = document.createElement('span');
        number.className = 'queue-number';
        number.textContent = String(index + 1).padStart(2, '0');
        const info = document.createElement('div');
        info.className = 'song-info';
        const title = document.createElement('strong'); title.textContent = item.title;
        const artist = document.createElement('span'); artist.textContent = item.artist;
        info.append(title, artist);
        const top = document.createElement('button');
        top.textContent = '↑'; top.title = '置顶';
        top.setAttribute('aria-label', '置顶：' + item.title);
        top.dataset.focusKey = item.id + '-top';
        top.onclick = () => this.run(top, 'top', { item_id: item.id }, '已移至下一首');
        const remove = document.createElement('button');
        remove.textContent = '×'; remove.title = '移除';
        remove.setAttribute('aria-label', '移除：' + item.title);
        remove.dataset.focusKey = item.id + '-remove';
        remove.onclick = () => this.run(remove, 'remove', { item_id: item.id }, '已移出队列');
        row.append(number, info, top, remove);
        list.append(row);
      });
      if (focused) [...list.querySelectorAll('button')].find(button => button.dataset.focusKey === focused)?.focus();
    }
    destroy() {
      this.client?.stop();
      clearTimeout(this.noticeTimer);
      clearTimeout(this.searchTimer);
      clearTimeout(this.clearTimer);
    }
  }
  window.OpenKRemote = Remote;
  window.openkRemote = new Remote();
})();
