(() => {
  'use strict';
  const { RoomClient, request, id, joinURL, saved, clock } = OpenKRoom;
  const $ = selector => document.querySelector(selector);
  const SILENCE = 'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

  class Stage {
    constructor() {
      this.music = $('#instrumental');
      this.voice = $('#vocals');
      this.client = null;
      this.playerToken = null;
      this.armed = false;
      this.activating = false;
      this.status = 'ready';
      this.lines = [];
      this.lineIndex = -2;
      this.loadedItem = null;
      this.generation = -1;
      this.lastLease = 0;
      this.lastSync = 0;
      this.playKey = null;
      this.mediaEpoch = 0;
      this.heartbeatBusy = false;
      this.pendingEnded = null;
      this.frame = 0;
      this.noticeTimer = null;
      this.heartbeatTimer = setInterval(() => this.heartbeat(), 2500);
      this.watchdog = setInterval(() => {
        if (this.armed && performance.now() - this.lastLease > 8500) {
          this.disarm('连接中断，声音已安全暂停。恢复网络后请重新启用。');
        }
      }, 500);
      this.music.src = this.voice.src = SILENCE;
      this.voice.volume = 0.65;
      this.bind();
      this.tick();
      this.start().catch(error => this.notice(error.message));
    }
    notice(message) {
      $('#tvNotice').textContent = message;
      $('#tvNotice').hidden = false;
      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => { $('#tvNotice').hidden = true; }, 6500);
    }
    async start(fresh = false) {
      if (this.starting || this.activating) return;
      this.starting = true;
      $('#newRoom').disabled = true;
      try { await this.setupRoom(fresh); }
      finally { this.starting = false; $('#newRoom').disabled = false; }
    }
    async setupRoom(fresh = false) {
      if (fresh && this.client) {
        // Give the previous room an explicit pause before replacing the local host.
        await this.client.command('pause').catch(() => {});
      }
      this.disarm();
      if (this.client) this.client.stop();
      let host = fresh ? null : saved('openk.tv.room');
      if (!host) {
        const created = await RoomClient.create();
        host = { roomId: created.room_id, token: created.host_token, code: created.pairing_code };
        saved('openk.tv.room', host);
      }
      this.host = host;
      this.client = new RoomClient(host.roomId, host.token);
      const client = this.client;
      this.client.onstate = state => { if (this.client === client) this.render(state); };
      this.client.onconnection = (connection, error) => {
        if (this.client !== client) return;
        $('#connection').textContent = { connected: '● 已连接', reconnecting: '◌ 正在重连', expired: '房间已过期' }[connection];
        if (connection === 'expired') {
          saved('openk.tv.room', null);
          this.disarm(error.message);
          $('#pairNotice').textContent = '房间已过期，请创建新房间。';
          this.overlay(true);
        }
      };
      $('#roomLabel').textContent = '房间 ' + host.roomId;
      $('#pairCode').textContent = host.code.slice(0, 3) + ' ' + host.code.slice(3);
      $('#pairRoom').textContent = '房间号 · ' + host.roomId;
      $('#joinAddress').textContent = new URL('/remote', location.href).href;
      $('#pairNotice').textContent = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
        ? '当前是本机地址。请先用手机可访问的服务器局域网地址打开此电视页面，再扫码。' : '';
      const qrBox = $('#qr');
      qrBox.replaceChildren();
      if (window.qrcode) {
        const qr = qrcode(0, 'M');
        qr.addData(joinURL(host.roomId, host.code));
        qr.make();
        // Only the local library generates this SVG; room strings are not interpolated as markup.
        qrBox.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
      } else qrBox.textContent = '使用配对码加入';
      this.overlay(true);
      this.client.start();
    }
    bind() {
      $('#activate').onclick = $('#pairActivate').onclick = () => this.activate();
      $('#pair').onclick = () => this.overlay(true);
      $('#closePair').onclick = () => this.overlay(false);
      $('#newRoom').onclick = () => {
        $('#newRoom').disabled = true;
        this.start(true).catch(error => this.notice(error.message))
          .finally(() => { $('#newRoom').disabled = false; });
      };
      $('#playPause').onclick = () => this.control(this.client.state?.playback.playing ? 'pause' : 'play');
      $('#guide').onclick = () => this.control('guide', { enabled: !this.client.state?.playback.guide });
      $('#restart').onclick = () => this.control('restart', { item_id: this.client.state?.current?.id });
      $('#next').onclick = () => this.control('next', { item_id: this.client.state?.current?.id });
      $('#fullscreen').onclick = () => {
        const target = document.documentElement;
        const result = document.fullscreenElement ? document.exitFullscreen?.()
          : (target.requestFullscreen || target.webkitRequestFullscreen)?.call(target);
        if (result?.catch) result.catch(() => this.notice('此浏览器不支持全屏，请使用电视浏览器的全屏模式。'));
      };
      document.addEventListener('keydown', event => this.key(event));
      document.addEventListener('pointermove', () => this.showControls());
      document.addEventListener('pointerdown', () => this.showControls());
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.disarm('电视页面已离开，返回后请重新启用声音。');
      });
      this.music.addEventListener('waiting', () => {
        if (this.armed) { this.setStatus('buffering'); this.voice.pause(); }
      });
      this.music.addEventListener('stalled', () => {
        if (this.armed && !this.music.paused) this.setStatus('buffering');
      });
      this.music.addEventListener('playing', () => {
        if (this.activating) return;
        if (!this.armed) { this.pause(); return; }
        this.setStatus('playing');
        this.syncVoice(true);
      });
      this.music.addEventListener('pause', () => {
        this.voice.pause();
        if (this.status === 'playing') this.setStatus('paused');
      });
      this.music.addEventListener('error', () => {
        if (this.loadedItem && !this.activating) {
          this.pause();
          this.setStatus('error');
          this.notice('音频加载失败。检查 NAS 连接，可重试声音或切换下一首。');
          $('#activate').hidden = false;
        }
      });
      this.voice.addEventListener('error', () => {
        this.voiceBlocked = true;
        this.voice.pause();
        this.notice('原唱暂时无法播放，伴奏继续。');
      });
      this.voice.addEventListener('canplay', () => this.syncVoice(true));
      this.music.addEventListener('loadedmetadata', () => this.seekDesired());
      this.music.addEventListener('ended', () => {
        const state = this.client?.state;
        if (!this.armed || !state?.current || !this.music.ended || this.pendingEnded) return;
        this.voice.pause();
        this.pendingEnded = { command_id: id(), item_id: state.current.id,
          generation: this.generation };
        this.sendEnded();
      });
      window.addEventListener('pagehide', () => this.disarm());
    }
    async control(action, payload = {}) {
      try { await this.client.command(action, payload); }
      catch (error) { this.notice(error.message); }
    }
    pause() { this.music.pause(); this.voice.pause(); }
    disarm(message) {
      this.armed = false;
      this.playerToken = null;
      this.pendingEnded = null;
      this.playKey = null;
      this.pause();
      $('#activate').hidden = false;
      $('#pairActivate').textContent = '启用声音，开始今晚';
      this.setStatus('ready');
      if (message) this.notice(message);
    }
    async activate() {
      if (this.activating) {
        this.notice('正在启用电视声音，请稍候…');
        return;
      }
      if (document.hidden) {
        this.setStatus('blocked');
        this.notice('电视页面不在前台。请切换到电视标签页，再按确认键启用声音。');
        return;
      }
      if (this.starting || !this.client?.state) {
        this.notice('正在连接房间，请稍后按确认键重试。');
        return;
      }
      this.activating = true;
      $('#activate').disabled = $('#pairActivate').disabled = true;
      this.setStatus('unlocking');
      let unlockTimeout;
      try {
        // HTMLMediaElement is the entire audio path; unlock both elements inside
        // the gesture, before awaiting the network. No microphone or AudioContext.
        this.music.muted = this.voice.muted = true;
        this.voiceBlocked = false;
        const unlocked = [this.music.play(), this.voice.play().catch(() => {})];
        await Promise.race([
          Promise.all(unlocked),
          new Promise((_, reject) => {
            unlockTimeout = setTimeout(() => reject(new Error('声音加载超时，请检查媒体连接后重试。')), 6500);
          }),
        ]);
        clearTimeout(unlockTimeout);
        this.pause();
        if (!this.playerToken || performance.now() - this.lastLease > 8500) {
          const sentAt = performance.now();
          const claim = await this.client.claim();
          this.playerToken = claim.player_token;
          this.lastLease = sentAt;
        }
        this.armed = true;
        this.playKey = null;
        this.voiceBlocked = false;
        this.lastGuide = this.client.state.playback.guide;
        this.music.muted = this.voice.muted = false;
        $('#activate').hidden = true;
        this.overlay(false);
        this.activating = false;
        await this.client.command('play');
        this.applyPlayback();
        await this.heartbeat();
      } catch (error) {
        this.pause();
        this.armed = false;
        this.music.muted = this.voice.muted = false;
        this.setStatus('blocked');
        $('#activate').hidden = false;
        $('#activate').textContent = '重试电视声音';
        this.notice(error.message || '浏览器阻止声音，请按确认键重试。');
      } finally {
        clearTimeout(unlockTimeout);
        this.activating = false;
        $('#activate').disabled = $('#pairActivate').disabled = false;
      }
    }
    setStatus(status) {
      this.status = status;
      $('#audioStatus').textContent = {
        ready: this.armed ? '声音已就绪 · 等待手机点歌' : '请按确认键启用电视声音',
        unlocking: '正在启用电视声音…',
        playing: '伴奏播放中', paused: '已暂停',
        buffering: '正在缓冲…', blocked: '请在电视上按确认键启用声音', error: '音频加载失败 · 可重试或切歌',
      }[status] || status;
    }
    async heartbeat() {
      if (!this.armed || !this.playerToken || this.heartbeatBusy || !this.client?.state) return;
      this.heartbeatBusy = true;
      const token = this.playerToken;
      const client = this.client;
      const state = client.state;
      const sentAt = performance.now();
      try {
        await client.heartbeat(token, {
          current_id: state.current?.id || null, generation: state.playback.seek_version,
          position: Number.isFinite(this.music.currentTime) && state.current ? this.music.currentTime : 0,
          status: state.current ? (this.status === 'unlocking' ? 'buffering' : this.status) : 'ready',
        });
        if (token === this.playerToken) this.lastLease = sentAt;
        if (this.pendingEnded) await this.sendEnded();
      } catch (error) {
        if (client !== this.client || token !== this.playerToken) return;
        if (error.status === 409) {
          await this.client.refresh().catch(() => {});
          // A command racing a heartbeat is not a lost lease.
          if (!this.client.state?.player.online) this.disarm(error.message);
        } else if ([401, 403, 404].includes(error.status)) this.disarm(error.message);
      } finally { this.heartbeatBusy = false; }
    }
    async sendEnded() {
      if (!this.pendingEnded || this.ending || !this.playerToken) return;
      this.ending = true;
      const client = this.client;
      const report = this.pendingEnded;
      try {
        await client.ended(this.playerToken, report);
        if (this.pendingEnded === report) this.pendingEnded = null;
      } catch (error) {
        if (client !== this.client) return;
        if (error.status === 409) this.disarm(error.message);
        else this.notice('切歌等待网络恢复…');
      } finally { this.ending = false; }
    }
    render(state) {
      $('#songTitle').textContent = state.current?.title || '把客厅交给音乐';
      $('#songArtist').textContent = state.current?.artist || '手机点歌 · 大屏开唱';
      $('#songEyebrow').textContent = state.current ? 'NOW SINGING / 正在演唱' : '今晚，轮到你发光';
      $('#nextSong').textContent = state.queue[0]?.title || '等待手机点歌';
      $('#playPause').disabled = !state.current;
      $('#playPause').textContent = state.playback.playing ? '暂停' : '播放';
      $('#guide').disabled = !state.current?.media.vocals;
      $('#guide').textContent = state.current && !state.current.media.vocals ? '无原唱音轨'
        : '原唱 · ' + (state.playback.guide ? '开' : '关');
      $('#guide').setAttribute('aria-pressed', String(state.playback.guide));
      $('#restart').disabled = $('#next').disabled = !state.current;
      if (this.loadedItem !== (state.current?.id || null)) {
        this.pause();
        this.mediaEpoch++;
        this.loadedItem = state.current?.id || null;
        this.lines = [];
        this.lineIndex = -2;
        this.playKey = null;
        this.voiceBlocked = false;
        this.generation = -1;
        this.music.src = state.current?.media.instrumental || SILENCE;
        this.voice.src = state.current?.media.vocals || SILENCE;
        this.music.load();
        this.voice.load();
        this.setStatus(this.armed ? 'paused' : 'ready');
        this.loadLyrics(state.current, this.mediaEpoch);
        this.artwork(state.current);
      }
      this.applyPlayback();
    }
    async loadLyrics(item, epoch) {
      if (!item?.media.lyrics) return;
      try {
        const lyrics = await request(item.media.lyrics);
        if (epoch !== this.mediaEpoch) return;
        this.lines = (Array.isArray(lyrics.lines) ? lyrics.lines : [])
          .filter(line => Number.isFinite(line.start) && Number.isFinite(line.end) && line.end >= line.start)
          .sort((a, b) => a.start - b.start);
        this.lineIndex = -2;
      } catch { if (epoch === this.mediaEpoch) this.notice('歌词暂时无法加载，伴奏仍可播放。'); }
    }
    artwork(item) {
      const cover = $('#cover');
      cover.hidden = true;
      document.body.style.removeProperty('--art-hue');
      const url = item?.thumbnail;
      if (!url || new URL(url, location.href).origin !== location.origin) return;
      cover.onload = () => {
        if (cover.getAttribute('src') !== url) return;
        cover.hidden = false;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          if (!context) return;
          context.drawImage(cover, 0, 0, 1, 1);
          const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
          const max = Math.max(r, g, b), delta = max - Math.min(r, g, b);
          let hue = 260;
          if (delta) hue = (60 * (max === r ? (g - b) / delta
            : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta) + 360) % 360;
          document.body.style.setProperty('--art-hue', Math.round(hue));
        } catch { /* Static purple/teal palette is the fallback. */ }
      };
      cover.onerror = () => { cover.hidden = true; };
      cover.src = url;
    }
    seekDesired() {
      const state = this.client?.state;
      if (!state?.current) return;
      try {
        this.music.currentTime = state.playback.position;
        this.voice.currentTime = state.playback.position;
      } catch { /* loadedmetadata retries on media that cannot seek yet. */ }
    }
    applyPlayback() {
      const state = this.client?.state;
      if (!state || this.activating) return;
      if (this.generation !== state.playback.seek_version) {
        this.generation = state.playback.seek_version;
        this.seekDesired();
        this.playKey = null;
        this.lineIndex = -2;
      }
      if (!this.armed || !state.current || !state.playback.playing) {
        this.pause();
        this.playKey = null;
        if (this.armed) this.setStatus(state.current ? 'paused' : 'ready');
        return;
      }
      if (state.playback.guide !== this.lastGuide) {
        this.lastGuide = state.playback.guide;
        this.voiceBlocked = false;
      }
      const key = state.current.id + ':' + this.generation;
      if (this.playKey !== key) {
        this.playKey = key;
        const epoch = this.mediaEpoch;
        this.setStatus('buffering');
        Promise.resolve(this.music.play()).then(() => {
          if (!this.armed || epoch !== this.mediaEpoch || !this.client.state.playback.playing) {
            if (epoch === this.mediaEpoch) this.pause();
            return;
          }
          this.setStatus('playing');
          this.syncVoice(true);
        }).catch(error => {
          if (epoch !== this.mediaEpoch) return;
          this.pause();
          this.setStatus(error.name === 'NotAllowedError' ? 'blocked' : 'error');
          $('#activate').hidden = false;
          $('#activate').textContent = '重试电视声音';
          this.notice('未能播放声音，请在电视上按「重试电视声音」。');
        });
      }
      if (!state.playback.guide) this.voice.pause();
      else this.syncVoice(true);
    }
    syncVoice(force = false) {
      const state = this.client?.state;
      if (!this.armed || !state?.current?.media.vocals || !state.playback.guide
          || this.music.paused || this.status === 'buffering') {
        this.voice.pause();
        return;
      }
      const now = performance.now();
      if (!force && now - this.lastSync < 1200) return;
      this.lastSync = now;
      // Keep instrumental authoritative. Avoid rate changes or constant hard seeks.
      if (Math.abs(this.voice.currentTime - this.music.currentTime) > 0.25) {
        try { this.voice.currentTime = this.music.currentTime; } catch { return; }
      }
      if (this.voice.paused && !this.voice.error && !this.voiceStarting && !this.voiceBlocked) {
        this.voiceStarting = true;
        Promise.resolve(this.voice.play()).catch(() => {
          this.voiceBlocked = true;
          this.notice('原唱未能播放；伴奏不受影响。');
        }).finally(() => { this.voiceStarting = false; });
      }
    }
    tick() {
      this.frame = requestAnimationFrame(time => {
        if (!document.hidden && (!this.lastFrame || time - this.lastFrame >= 40)) {
          this.lastFrame = time;
          this.lyrics();
          this.syncVoice();
          const state = this.client?.state;
          const position = state?.current ? this.music.currentTime || 0 : 0;
          const duration = Number.isFinite(this.music.duration) ? this.music.duration : state?.current?.duration || 0;
          $('#elapsed').textContent = clock(position);
          $('#duration').textContent = clock(duration);
          $('#progress').style.width = (duration ? Math.min(100, position / duration * 100) : 0) + '%';
        }
        this.tick();
      });
    }
    lyrics() {
      const position = this.music.currentTime || 0;
      let index = -1;
      let low = 0, high = this.lines.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (this.lines[mid].start <= position) { index = mid; low = mid + 1; } else high = mid - 1;
      }
      const current = this.lines[index];
      const next = this.lines[index + 1];
      const gap = next && (!current || (position > current.end + 1 && next.start - position > 3));
      const displayIndex = gap ? -1000 - index : index;
      if (this.lineIndex !== displayIndex) {
        this.lineIndex = displayIndex;
        const line = $('#lyricCurrent');
        line.replaceChildren();
        this.wordNodes = [];
        if (gap) line.textContent = index < 0 ? '音乐即将开始' : '让音乐，接着说';
        else if (!current) line.textContent = this.loadedItem ? '随音乐自由演唱' : '好歌，值得一起唱';
        else {
          const words = Array.isArray(current.words) && current.words.length
            ? current.words : [{ text: current.text, start: current.start, end: current.end }];
          words.forEach((word, i) => {
            const span = document.createElement('span');
            span.className = 'lyric-word';
            span.textContent = String(word.text || word.word || '');
            line.append(span);
            const following = String(words[i + 1]?.text || words[i + 1]?.word || '');
            if (/[a-zA-Z0-9]$/.test(span.textContent) && /^[a-zA-Z0-9]/.test(following)) line.append(' ');
            this.wordNodes.push({ span, start: Number.isFinite(word.start) ? word.start : current.start,
              end: Number.isFinite(word.end) ? word.end : current.end });
          });
        }
        $('#lyricNext').textContent = next?.text || (this.loadedItem
          ? '下一首 · ' + (this.client?.state.queue[0]?.title || '在手机上继续点歌')
          : '扫码加入房间，点一首喜欢的歌');
      }
      $('#countdown').textContent = gap ? (index < 0 ? '前奏' : '间奏') + ' · ' + Math.ceil(next.start - position) + ' 秒' : '';
      for (const word of this.wordNodes || []) {
        const progress = Math.max(0, Math.min(1, (position - word.start) / Math.max(0.05, word.end - word.start)));
        word.span.style.setProperty('--word-progress', (progress * 100).toFixed(1) + '%');
      }
    }
    overlay(show) {
      $('#pairPanel').hidden = !show;
      if (show) $('#closePair').focus();
      else $('#pair').focus();
      this.showControls();
    }
    showControls() {
      document.body.classList.remove('controls-idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if ($('#pairPanel').hidden && this.armed && !this.music.paused) document.body.classList.add('controls-idle');
      }, 7000);
    }
    key(event) {
      if (['Escape', 'Backspace', 'BrowserBack', 'GoBack'].includes(event.key)
          || event.keyCode === 10009 || event.keyCode === 4) {
        event.preventDefault();
        this.overlay($('#pairPanel').hidden);
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return;
      this.showControls();
      const scope = $('#pairPanel').hidden ? $('#stageControls') : $('#pairPanel');
      const buttons = [...scope.querySelectorAll('button:not(:disabled)')].filter(button => !button.hidden);
      if (!buttons.length) return;
      if (event.key === 'Enter') {
        if (!buttons.includes(document.activeElement)) { event.preventDefault(); buttons[0].focus(); }
        return;
      }
      event.preventDefault();
      let index = buttons.indexOf(document.activeElement);
      index = (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[index].focus();
    }
    destroy() {
      this.disarm();
      this.client?.stop();
      clearInterval(this.heartbeatTimer);
      clearInterval(this.watchdog);
      clearTimeout(this.idleTimer);
      clearTimeout(this.noticeTimer);
      cancelAnimationFrame(this.frame);
    }
  }
  window.OpenKStage = Stage;
  window.openkStage = new Stage();
})();
