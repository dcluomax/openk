(() => {
  'use strict';
  const { RoomClient, request, id, joinURL, saved, clock, roomSessions, contextChanged } = OpenKRoom;
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
      this.lyricsUrl = null;
      this.lyricsRequest = null;
      this.lyricsRetryAt = 0;
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
      this.connectionEpoch = 0;
      this.destroyed = false;
      this.account = null;
      this.chipView = null;
      this.recovering = null;
      this.switching = false;
      const fragment = new URLSearchParams(location.hash.slice(1));
      this.initialTarget = fragment.get('room') ? {
        room: fragment.get('room').toLowerCase(), code: fragment.get('code') || '',
      } : null;
      if (location.hash) history.replaceState(null, '', location.pathname);
      this.heartbeatTimer = setInterval(() => this.heartbeat(), 2500);
      this.watchdog = setInterval(() => {
        if (this.armed && performance.now() - this.lastLease > 8500) {
          this.disarm('连接中断，声音已安全暂停。恢复网络后请重新启用。');
        }
      }, 500);
      this.music.src = this.voice.src = SILENCE;
      this.voice.volume = 0.65;
      this.outputVolume = 1;
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
    async start(fresh = false, target = null) {
      if (this.starting || this.activating) return;
      this.starting = true;
      $('#newRoom').disabled = $('#joinTV').disabled = true;
      const requested = target || this.initialTarget;
      const epoch = this.connectionEpoch;
      this.initialTarget = null;
      try {
        if (!this.account) {
          const account = await OpenKAccount.load();
          if (this.destroyed || epoch !== this.connectionEpoch) return;
          this.account = account;
          if (this.account.enabled) {
            this.chipView = OpenKAccount.mount($('#tvAccountChip'), { onLogout: () => this.signOut() });
            this.chipView.update(this.account.user);
            if (this.account.user) this.loadSettings();
            // The server names this member from the profile; a per-television alias would lie.
            $('#tvScreenName').hidden = true;
            const label = document.querySelector('label[for="tvScreenName"]');
            if (label) label.hidden = true;
            $('#joinTV').textContent = '加入房间';
            $('#tvJoinHint').textContent = '加入后，同一账号的手机和电视会一起切换房间。';
            $('#tvCreateHint').textContent = '创建后会切换到新房间；原房间还有成员时继续保留。';
            $('#tvRoomScreens').nextElementSibling.textContent = '允许其他成员使用自己的设备播放';
            $('#tvNewScreens').nextElementSibling.textContent = '允许其他成员播放，每房间一台';
          }
        }
        await this.setupRoom(fresh, requested);
      }
      catch (error) {
        if (error.status === 499) return;
        if (!this.destroyed) {
          if (error.status === 401) { this.signedOut(error.message); return; }
          if (this.account?.enabled && contextChanged(error)) return await this.recover(error.message);
          $('#pairNotice').textContent = error.message;
          if (requested) $('#tvJoinPanel').open = true;
          this.overlay(true);
        }
        throw error;
      }
      finally {
        this.starting = false;
        if (!this.destroyed) $('#newRoom').disabled = $('#joinTV').disabled = false;
      }
    }
    resetLyrics() {
      this.lyricsRequest?.controller.abort();
      this.lyricsRequest = null;
      this.lyricsUrl = null;
      this.lyricsRetryAt = 0;
      this.lines = [];
      this.lineIndex = -2;
      this.wordNodes = [];
    }
    resetMedia() {
      this.mediaEpoch++;
      this.loadedItem = null;
      this.generation = -1;
      this.resetLyrics();
      this.voiceStarting = false;
      this.voiceAttempt = null;
      this.heartbeatBusy = false;
      this.heartbeatRequest = null;
      this.ending = false;
      this.endingRequest = null;
      this.music.src = this.voice.src = SILENCE;
      this.music.load();
      this.voice.load();
      $('#cover').hidden = true;
      $('#cover').removeAttribute('src');
      $('#stageSingers').textContent = '';
      $('#songTitle').textContent = '把客厅交给音乐';
      $('#songArtist').textContent = '选择房间后启用电视声音';
      $('#tvMembers').textContent = '';
      OpenKRoom.renderDevices($('#tvDevices'), null, null);
      $('#roomLabel').textContent = '尚未加入房间';
    }
    async detach() {
      const client = this.client, token = this.playerToken;
      this.connectionEpoch++;
      this.client = null;
      this.disarm();
      this.resetMedia();
      client?.stop();
      if (client && token) {
        try { await client.release(token); }
        catch (error) {
          if (![403, 404, 409].includes(error.status)) {
            this.overlay(true);
            throw new Error('本机声音已停止，但释放旧播放连接失败。旧租约会自动过期，请重试切换。');
          }
        }
      }
    }
    rememberHost() {
      // Account televisions hold no bearer capability: the account is the membership.
      if (this.account?.enabled || !this.host) return;
      const signature = JSON.stringify(this.host);
      if (signature === this.savedSignature) return;
      const stored = roomSessions.remember({
        room_id: this.host.roomId, token: this.host.token, role: this.host.role || 'host',
        name: this.host.name, display_name: this.host.display_name, pairing_code: this.host.code,
      });
      const current = saved('openk.tv.room', this.host) !== null;
      if (stored && current) this.savedSignature = signature;
      else {
        this.notice('浏览器无法保存房间凭据，请保持此页面打开。');
      }
    }
    async setupRoom(fresh = false, target = null) {
      await this.detach();
      const epoch = this.connectionEpoch;
      this.settingsDirty = false;
      this.endConfirm = null;
      this.savedSignature = null;
      $('#tvSettingsPanel').hidden = true;
      if (this.account?.enabled) return this.setupAccountRoom(fresh, target, epoch);
      let host = null, initialState = null;
      const previous = saved('openk.tv.room');
      if (previous?.roomId && previous.token) {
        roomSessions.remember({ room_id: previous.roomId, token: previous.token,
          role: previous.role || 'host', pairing_code: previous.code, name: previous.name });
      }
      if (target && !fresh) {
        $('#tvJoinRoom').value = target.room;
        const cached = roomSessions.get(target.room, ['screen', 'host']);
        if (cached?.role === 'screen') {
          host = { roomId: cached.room_id, token: cached.token, code: cached.pairing_code || '',
            role: cached.role, name: cached.name };
        } else if (target.code) {
          const joined = await RoomClient.join(target.room, target.code, {
            role: 'screen', display_name: $('#tvScreenName').value.trim() || '电视',
          });
          host = { roomId: target.room, token: joined.screen_token, code: target.code,
            role: 'screen', name: joined.state.name };
          initialState = joined.state;
        } else if (cached) {
          host = { roomId: cached.room_id, token: cached.token, code: cached.pairing_code || '',
            role: cached.role, name: cached.name };
        } else {
          this.host = null;
          $('#pairCode').textContent = '··· ···';
          $('#pairRoom').textContent = '房间号 · ' + target.room;
          $('#qr').replaceChildren();
          $('#pairNotice').textContent = '输入房间配对码，让这台电视加入。房主需先允许电视连接。';
          $('#tvJoinPanel').open = true;
          this.overlay(true);
          $('#tvJoinCode').focus();
          return;
        }
      } else if (!fresh && previous) {
        host = { ...previous, role: previous.role || 'host' };
      }
      if (!host) {
        const created = await RoomClient.create({
          name: $('#tvNewName').value.trim() || undefined, display_name: '电视房主',
          discoverable: $('#tvNewListed').checked, allow_screens: $('#tvNewScreens').checked,
        });
        host = { roomId: created.room_id, token: created.host_token, code: created.pairing_code,
          role: 'host', name: created.state.name };
        initialState = created.state;
      }
      if (epoch !== this.connectionEpoch || this.destroyed) return;
      this.host = host;
      this.connectRoom(initialState);
    }
    /** One account, one current room: this television follows the same membership as the phone. */
    async setupAccountRoom(fresh, target, epoch) {
      let result = null;
      if (fresh) {
        result = await RoomClient.create({
          name: $('#tvNewName').value.trim() || undefined,
          discoverable: $('#tvNewListed').checked, allow_screens: $('#tvNewScreens').checked,
        });
      } else if (target?.room && target.code) {
        $('#tvJoinRoom').value = target.room;
        result = await RoomClient.join(target.room, target.code);
      } else {
        result = await RoomClient.current();
      }
      if (epoch !== this.connectionEpoch || this.destroyed) return;
      this.attach(result);
      if (!fresh && target?.room && !target.code && this.host.roomId !== target.room) {
        $('#tvJoinRoom').value = target.room;
        $('#pairNotice').textContent = '这不是你当前的房间。输入配对码，电视会带着你的账号一起加入。';
        $('#tvJoinPanel').open = true;
        this.overlay(true);
        $('#tvJoinCode').focus();
      }
    }
    attach(result) {
      const value = OpenKAccount.adopt(result);
      this.host = {
        roomId: value.room_id, token: null, role: value.role, name: value.state?.name,
        code: OpenKAccount.currentInvite(this.account.user.id, value.room_id,
          value.state?.invite_version) || '',
      };
      this.connectRoom(value.state);
    }
    connectRoom(initialState) {
      const host = this.host;
      this.rememberHost();
      this.client = new RoomClient(host.roomId, host.token, {
        presence: () => OpenKRoom.devicePresence(['player']),
      });
      const client = this.client;
      this.client.onstate = state => { if (this.client === client) this.render(state); };
      this.client.onconnection = (connection, error) => {
        if (this.client !== client) return;
        $('#connection').textContent = { connected: '● 已连接', reconnecting: '◌ 正在重连',
          expired: '房间已过期', changed: '房间已切换' }[connection];
        if (this.account?.enabled) {
          if (error?.status === 401) { this.signedOut(error.message); return; }
          if (this.switching || !['changed', 'expired'].includes(connection)) return;
          this.recover(connection === 'changed'
            ? '你的账号换了房间，电视已跟随。请按确认键重新启用声音。'
            : '房间已结束，电视已回到你自己的房间。请按确认键重新启用声音。');
          return;
        }
        if (connection === 'expired') {
          roomSessions.forget(host.roomId, error.status === 404 ? undefined : host.role);
          saved('openk.tv.room', null);
          this.connectionEpoch++;
          this.client = null;
          client.stop();
          this.activating = false;
          $('#activate').disabled = $('#pairActivate').disabled = false;
          this.disarm(error.message);
          this.resetMedia();
          $('#pairNotice').textContent = '房间已过期，请创建新房间。';
          this.overlay(true);
        } else if (error?.status === 401) {
          this.disarm('登录已过期。请重新登录 OpenK 后刷新此页，房间凭据仍保留。');
        }
      };
      this.renderPairing();
      this.overlay(true);
      $('#tvJoinCode').value = '';
      $('#tvJoinPanel').open = false;
      if (initialState) this.client.accept(initialState);
      this.client.start();
    }
    renderPairing() {
      const host = this.host;
      if (!host) return;
      $('#roomLabel').textContent = '房间 ' + host.roomId;
      $('#pairCode').textContent = host.code ? host.code.slice(0, 3) + ' ' + host.code.slice(3)
        : this.account?.enabled ? '生成后显示' : '请向房主获取';
      $('#pairRoom').textContent = '房间号 · ' + host.roomId;
      $('#joinAddress').textContent = new URL('/remote', location.href).href;
      $('#pairNotice').textContent = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
        ? '当前是本机地址。请先用手机可访问的服务器局域网地址打开此电视页面，再扫码。' : '';
      const qrBox = $('#qr');
      qrBox.replaceChildren();
      qrBox.classList.toggle('qr-empty', !(window.qrcode && host.code));
      if (window.qrcode && host.code) {
        const qr = qrcode(0, 'M');
        qr.addData(joinURL(host.roomId, host.code));
        qr.make();
        // Only the local library generates this SVG; room strings are not interpolated as markup.
        qrBox.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 20, scalable: true });
      } else qrBox.textContent = this.account?.enabled && !host.code
        ? host.role === 'host' ? '在「管理当前房间」中生成配对码' : '请房主提供配对码'
        : '使用配对码加入';
    }
    /** Follow the account to its current room, always stopping the previous room's audio first. */
    recover(message) {
      if (!this.account?.enabled || this.destroyed || this.signingOut || this.recovering) return this.recovering;
      clearTimeout(this.recoverTimer);
      this.recovering = (async () => {
        try {
          await this.detach();
          const epoch = this.connectionEpoch;
          const account = await OpenKAccount.reload();
          if (epoch !== this.connectionEpoch || this.destroyed) return;
          if (!account.enabled) throw new Error('账号配置已改变，请刷新页面后继续');
          this.account = account;
          this.chipView?.update(account.user);
          const result = await OpenKAccount.currentRoom();
          if (epoch !== this.connectionEpoch || this.destroyed) return;
          this.attach(result);
          this.notice(message || '房间已切换，请按确认键重新启用声音。');
        } catch (error) {
          if (this.destroyed || this.signingOut || error.status === 499) return;
          if (error.status === 401) { this.signedOut(error.message); return; }
          $('#pairNotice').textContent = error.message;
          this.overlay(true);
          this.recoverTimer = setTimeout(() => this.recover(message), 3000);
        } finally { this.recovering = null; }
      })();
      return this.recovering;
    }
    signedOut(message) {
      OpenKAccount.reset();
      this.connectionEpoch++;
      const client = this.client;
      this.client = null;
      this.host = null;
      this.disarm();
      this.resetMedia();
      client?.stop();
      clearTimeout(this.recoverTimer);
      $('#tvSettingsPanel').hidden = true;
      $('#tvJoinPanel').open = false;
      $('#qr').replaceChildren();
      $('#pairCode').textContent = '··· ···';
      $('#pairRoom').textContent = '';
      $('#roomLabel').textContent = '未登录';
      $('#connection').textContent = '未登录';
      $('#activate').hidden = true;
      $('#pairActivate').hidden = $('#newRoom').hidden = true;
      $('#tvSignIn').hidden = false;
      $('#tvSignIn').href = this.account?.loginUrl || '/auth/login/';
      $('#pairNotice').textContent = message || '登录状态已失效，请在电视上重新登录 OpenK。';
      this.chipView?.update(null);
      this.overlay(true);
    }
    async signOut() {
      if (this.signingOut) return;
      this.signingOut = true;
      this.chipView?.busy(true);
      // Audio stops before the session ends, whether or not the lease can be handed back.
      this.disarm();
      try {
        try { await this.detach(); }
        catch (error) { this.notice(error.message + '（租约会自动过期）'); }
        window.OpenKUserState?.reset();
        location.assign(await OpenKAccount.logout());
      } catch (error) {
        this.signingOut = false;
        this.chipView?.busy(false);
        this.notice(error.message);
        await this.recovering;
        await this.recover('退出登录未成功，已恢复当前房间。请重新启用声音。');
      }
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
      $('#tvJoinForm').onsubmit = event => {
        event.preventDefault();
        this.start(false, { room: $('#tvJoinRoom').value.trim().toLowerCase(),
          code: $('#tvJoinCode').value.trim() }).catch(error => {
          $('#pairNotice').textContent = error.message;
          $('#tvJoinPanel').open = true;
          this.overlay(true);
        });
      };
      $('#tvLobby').onclick = $('#stageLobby').onclick = () => this.goLobby();
      $('#tvRoomSettings').oninput = () => { this.settingsDirty = true; };
      $('#tvRoomSettings').onsubmit = event => { event.preventDefault(); this.saveSettings(); };
      $('#tvRefreshInvite').onclick = () => this.rotateInvite();
      $('#tvEndRoom').onclick = () => this.endRoom();
      $('#playPause').onclick = () => this.control(this.needsLocalActivation()
        ? 'play' : this.client?.state?.playback.playing ? 'pause' : 'play');
      $('#guide').onclick = () => this.control('guide', { enabled: !this.client?.state?.playback.guide });
      $('#restart').onclick = () => this.control('restart', { item_id: this.client?.state?.current?.id });
      $('#next').onclick = () => this.control('next', { item_id: this.client?.state?.current?.id });
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
      window.addEventListener('pagehide', () => {
        if (this.client && this.playerToken) {
          this.client.releaseOnUnload(this.playerToken)
            .catch(error => console.warn('TV exit could not release its player lease:', error));
        }
        this.disarm();
        this.client?.stop();
      });
      window.addEventListener('pageshow', event => {
        if (event.persisted && !this.destroyed) this.client?.start();
      });
    }
    needsLocalActivation() {
      const state = this.client?.state;
      return !!state && (!state.player.online || !!this.playerToken)
        && (!this.armed || ['blocked', 'error'].includes(this.status));
    }
    async control(action, payload = {}) {
      const client = this.client;
      if (!client?.state) { this.notice('请先连接一个房间'); return; }
      if (action === 'play' && this.needsLocalActivation()) return this.activate();
      try { await client.command(action, payload); }
      catch (error) { if (client === this.client && error.status !== 499) this.notice(error.message); }
    }
    async goLobby() {
      if (this.starting || this.activating) {
        this.notice('正在连接或启用声音，请稍候再切换。');
        return;
      }
      try {
        await this.detach();
        location.assign('/rooms');
      } catch (error) { this.notice(error.message); }
    }
    async saveSettings() {
      const client = this.client;
      if (!client || $('#tvSaveSettings').disabled) return;
      $('#tvSaveSettings').disabled = true;
      try {
        await client.settings({ name: $('#tvRoomName').value.trim(),
          discoverable: $('#tvRoomListed').checked, allow_screens: $('#tvRoomScreens').checked });
        if (this.client !== client) return;
        this.settingsDirty = false;
        this.render(client.state);
        this.notice('房间设置已保存');
      } catch (error) { if (this.client === client) this.notice(error.message); }
      finally { $('#tvSaveSettings').disabled = false; }
    }
    async endRoom() {
      const client = this.client;
      if (!client || $('#tvEndRoom').disabled) return;
      if (this.endConfirm !== client.id) {
        this.endConfirm = client.id;
        $('#tvEndRoom').textContent = '再次点击，结束房间并让所有设备退出';
        clearTimeout(this.endTimer);
        this.endTimer = setTimeout(() => {
          this.endConfirm = null;
          $('#tvEndRoom').textContent = '结束当前房间';
        }, 5000);
        return;
      }
      $('#tvEndRoom').disabled = true;
      this.disarm();
      try {
        if (this.account?.enabled) {
          this.switching = true;
          const result = await client.close();
          if (this.destroyed || this.client !== client) return;
          OpenKAccount.forgetInvite(this.account.user.id, client.id);
          await this.detach();
          this.attach(result.current);
          this.notice('房间已结束，电视回到你自己的房间。请按确认键重新启用声音。');
          return;
        }
        await client.close();
        roomSessions.forget(client.id);
        saved('openk.tv.room', null);
        if (this.client !== client) return;
        await this.detach();
        this.host = null;
        $('#qr').replaceChildren();
        $('#pairCode').textContent = '··· ···';
        $('#pairRoom').textContent = '';
        $('#roomLabel').textContent = '房间已结束';
        $('#tvSettingsPanel').hidden = true;
        $('#pairNotice').textContent = '房间已结束。可以创建新房间，或从大厅加入另一场聚会。';
        this.overlay(true);
      } catch (error) {
        if (this.destroyed || this.client !== client) return;
        if (this.account?.enabled && error.status === 401) this.signedOut(error.message);
        else if (this.account?.enabled && (contextChanged(error) || [403, 404].includes(error.status))) {
          this.recover('房间已经不在了，电视已回到你自己的房间。');
        } else this.notice(error.message);
      }
      finally { this.switching = false; $('#tvEndRoom').disabled = false; }
    }
    async rotateInvite() {
      const client = this.client;
      if (!client || $('#tvRefreshInvite').disabled) return;
      $('#tvRefreshInvite').disabled = true;
      try {
        const result = await client.invitation();
        if (this.client !== client) return;
        if (!/^\d{6}$/.test(result.pairing_code || '')) throw new Error('服务器返回的配对码无效，请重试。');
        OpenKAccount.rememberInvite(this.account.user.id, client.id, result.pairing_code,
          result.state?.invite_version);
        this.host.code = result.pairing_code;
        this.renderPairing();
        this.notice('新的配对码已生成，旧配对码立即失效。');
      } catch (error) {
        if (this.client !== client) return;
        if (error.status === 401) this.signedOut(error.message);
        else this.notice(error.message);
      } finally { $('#tvRefreshInvite').disabled = false; }
    }
    pause() { this.music.pause(); this.voice.pause(); }
    disarm(message) {
      this.armed = false;
      this.playerToken = null;
      this.pendingEnded = null;
      this.playKey = null;
      this.pause();
      $('#activate').hidden = false;
      $('#pairActivate').textContent = '启用声音，开始演唱';
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
      // Pressing OK here is an explicit gesture, so it may override the topology,
      // but it must say what it is doing instead of silently taking playback.
      const elsewhere = this.preferredElsewhere();
      if (elsewhere) this.notice(`改用本机播放，不使用“${elsewhere}”。`);
      this.activating = true;
      const client = this.client, epoch = this.connectionEpoch;
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
        if (client !== this.client || epoch !== this.connectionEpoch) return;
        clearTimeout(unlockTimeout);
        this.pause();
        if (!this.playerToken || performance.now() - this.lastLease > 8500) {
          const sentAt = performance.now();
          const claim = await client.claim();
          if (client !== this.client || epoch !== this.connectionEpoch) return;
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
        await client.command('play');
        if (client !== this.client || epoch !== this.connectionEpoch) return;
        this.applyPlayback();
        await this.heartbeat();
      } catch (error) {
        if (client !== this.client || epoch !== this.connectionEpoch) return;
        this.pause();
        this.armed = false;
        this.music.muted = this.voice.muted = false;
        this.setStatus('blocked');
        $('#activate').hidden = false;
        $('#activate').textContent = '重试电视声音';
        this.notice(error.message || '浏览器阻止声音，请按确认键重试。');
      } finally {
        clearTimeout(unlockTimeout);
        if (epoch === this.connectionEpoch && !this.destroyed) {
          this.activating = false;
          $('#activate').disabled = $('#pairActivate').disabled = false;
        }
      }
    }
    /** This television is one of the account's devices: it follows the account
        defaults plus its own overrides, and it says so when the account points
        playback at a different device. */
    async loadSettings() {
      const api = window.OpenKUserState;
      if (!api) return;
      const epoch = this.connectionEpoch;
      api.reset();
      try {
        const value = await api.load();
        if (this.destroyed || epoch !== this.connectionEpoch || !value?.enabled) return;
        this.applySettings(value.settings);
        const elsewhere = this.preferredElsewhere();
        if (elsewhere) {
          this.notice(`首选播放器是“${elsewhere}”。按确认键可改用当前屏幕播放。`);
        }
      } catch (error) {
        if (error.status === 499 || this.destroyed || epoch !== this.connectionEpoch) return;
        this.notice('无法加载已保存的设备设置，当前使用安全默认值。');
      }
    }
    applySettings(values) {
      const level = Number(values?.output_volume);
      this.outputVolume = Number.isFinite(level) ? Math.min(100, Math.max(0, level)) / 100 : 1;
      this.music.volume = this.outputVolume;
      this.voice.volume = 0.65 * this.outputVolume;
      const sink = typeof values?.audio_output === 'string' ? values.audio_output : '';
      if (typeof this.music.setSinkId !== 'function') {
        if (sink) this.notice('当前浏览器不支持选择音频输出设备，将使用系统默认设备。');
        return;
      }
      Promise.all([this.music, this.voice].map(element => element.setSinkId(sink)))
        .catch(() => this.notice('已保存的扬声器在当前设备上不可用，将使用系统默认设备。'));
    }
    /** This screen only names itself for an account; pairing-only rooms stay anonymous. */
    deviceId() {
      return this.account?.user ? window.OpenKUserState?.deviceId() || null : null;
    }
    /** The label of the account's preferred player when it is not this screen. */
    preferredElsewhere() {
      const api = window.OpenKUserState;
      const value = api?.value;
      if (!value?.enabled || !value.preferredPlayer || value.preferredPlayer === api.deviceId()) return null;
      return value.devices.find(item => item.id === value.preferredPlayer)?.label || '另一台设备';
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
      const pending = {};
      this.heartbeatRequest = pending;
      const token = this.playerToken;
      const client = this.client;
      const state = client.state;
      const sentAt = performance.now();
      try {
        await client.heartbeat(token, {
          current_id: state.current?.id || null, generation: state.playback.seek_version,
          position: Number.isFinite(this.music.currentTime) && state.current ? this.music.currentTime : 0,
          status: state.current ? (this.status === 'unlocking' ? 'buffering' : this.status) : 'ready',
          device_id: this.deviceId(),
        });
        if (client === this.client && token === this.playerToken) {
          this.lastLease = sentAt;
          if (this.pendingEnded) await this.sendEnded();
        }
      } catch (error) {
        if (client !== this.client || token !== this.playerToken) return;
        if (contextChanged(error)) {
          // The account is in another room now; stop this room's audio before following.
          this.disarm(error.message);
          this.recover();
        } else if (error.status === 409) {
          try { await client.refresh(); }
          catch (refreshError) {
            if (this.client === client && refreshError.status !== 499) this.notice(refreshError.message);
          }
          if (this.client !== client || token !== this.playerToken) return;
          // A command racing a heartbeat is not a lost lease.
          const state = client.state;
          if (!state?.player.online || state.player.member_id && state.viewer?.id
              && state.player.member_id !== state.viewer.id) this.disarm(error.message);
        } else if ([401, 403, 404].includes(error.status)) this.disarm(error.message);
      } finally {
        if (this.heartbeatRequest === pending) this.heartbeatBusy = false;
      }
    }
    async sendEnded() {
      if (!this.pendingEnded || this.ending || !this.playerToken) return;
      this.ending = true;
      const pending = {};
      this.endingRequest = pending;
      const client = this.client;
      const report = this.pendingEnded;
      try {
        await client.ended(this.playerToken, { ...report, device_id: this.deviceId() });
        if (this.pendingEnded === report) this.pendingEnded = null;
      } catch (error) {
        if (client !== this.client) return;
        if (error.status === 409) this.disarm(error.message);
        else this.notice('切歌等待网络恢复…');
      } finally {
        if (this.endingRequest === pending) this.ending = false;
      }
    }
    render(state) {
      this.host.name = state.name || this.host.name;
      this.host.role = state.viewer?.role || this.host.role;
      this.host.display_name = state.viewer?.name;
      this.rememberHost();
      const members = state.members || [];
      $('#roomLabel').textContent = (state.name || '房间 ' + state.id)
        + ' · ' + members.filter(member => member.online).length + ' 在线';
      $('#tvMembers').textContent = members.filter(member => member.online)
        .map(member => member.name + (member.role === 'screen' ? '（电视）' : '')).join(' · ');
      OpenKRoom.renderDevices($('#tvDevices'), state, this.client?.presenceId);
      $('#stageSingers').textContent = state.current?.singers?.length
        ? '演唱 · ' + state.current.singers.map(member => member.name).join(' / ') : '';
      // The viewer role can change when a host leaves; never trust a cached role here.
      $('#tvSettingsPanel').hidden = state.viewer?.role !== 'host';
      if (this.account?.enabled) {
        if (state.viewer?.name) this.account.user.display_name = state.viewer.name;
        this.chipView?.update(this.account.user);
        // Another device may have rotated the code; a stale one is hidden, not silently reused.
        const fresh = OpenKAccount.currentInvite(this.account.user.id, state.id, state.invite_version);
        if ((this.host.code || '') !== (fresh || '')) {
          const lost = !fresh && !!this.host.code;
          this.host.code = fresh || '';
          this.renderPairing();
          $('#tvInvitePrivacy').textContent = lost
            ? '另一台设备刚刚换过配对码，这里不再显示旧的。需要邀请别人时，生成一个新的配对码。'
            : '服务器只保存配对码的摘要。换设备登录后看不到旧配对码时，生成一个新的；旧配对码会立即失效。';
        }
      }
      $('#tvRefreshInvite').hidden = $('#tvInvitePrivacy').hidden =
        !this.account?.enabled || state.viewer?.role !== 'host';
      $('#tvRefreshInvite').textContent = this.host.code ? '换一个配对码' : '生成配对码';
      if (!this.settingsDirty) {
        $('#tvRoomName').value = state.name || '';
        $('#tvRoomListed').checked = !!state.discoverable;
        $('#tvRoomScreens').checked = !!state.allow_screens;
      }
      if (!this.endConfirm) $('#tvEndRoom').textContent = '结束当前房间';
      $('#songTitle').textContent = state.current?.title || '把客厅交给音乐';
      $('#songArtist').textContent = state.current?.artist || '手机点歌 · 大屏开唱';
      $('#songEyebrow').textContent = state.current ? 'NOW SINGING / 正在演唱' : '今晚，轮到你发光';
      $('#nextSong').textContent = state.queue[0]?.title || '等待手机点歌';
      $('#playPause').disabled = !state.current;
      $('#playPause').textContent = this.needsLocalActivation() ? '在此播放'
        : state.playback.playing ? '暂停' : '播放';
      $('#guide').disabled = !state.current?.media.vocals;
      $('#guide').textContent = state.current && !state.current.media.vocals ? '无原唱音轨'
        : '原唱 · ' + (state.playback.guide ? '开' : '关');
      $('#guide').setAttribute('aria-pressed', String(state.playback.guide));
      $('#restart').disabled = $('#next').disabled = !state.current;
      if (this.loadedItem !== (state.current?.id || null)) {
        this.pause();
        this.mediaEpoch++;
        this.loadedItem = state.current?.id || null;
        this.resetLyrics();
        this.playKey = null;
        this.voiceBlocked = false;
        this.generation = -1;
        this.music.src = state.current?.media.instrumental || SILENCE;
        this.voice.src = state.current?.media.vocals || SILENCE;
        this.music.load();
        this.voice.load();
        this.setStatus(this.armed ? 'paused' : 'ready');
        this.artwork(state.current);
      }
      this.loadLyrics(state.current, this.mediaEpoch);
      this.applyPlayback();
    }
    async loadLyrics(item, epoch) {
      if (this.destroyed || epoch !== this.mediaEpoch) return;
      const url = item?.media?.lyrics || null;
      if (!url) {
        if (this.lyricsUrl || this.lyricsRequest || this.lines.length) {
          this.resetLyrics();
          this.lyrics();
        }
        return;
      }
      if (url === this.lyricsUrl || url === this.lyricsRequest?.url || Date.now() < this.lyricsRetryAt) return;
      this.lyricsRequest?.controller.abort();
      const pending = { url, controller: new AbortController() };
      this.lyricsRequest = pending;
      this.lyricsRetryAt = 0;
      try {
        const lyrics = await request(url, { signal: pending.controller.signal });
        if (this.destroyed || epoch !== this.mediaEpoch || this.lyricsRequest !== pending) return;
        if (!Array.isArray(lyrics?.lines)) throw new Error('歌词格式不正确');
        this.lines = lyrics.lines
          .filter(line => Number.isFinite(line.start) && Number.isFinite(line.end) && line.end >= line.start)
          .sort((a, b) => a.start - b.start);
        this.lyricsUrl = url;
        this.lineIndex = -2;
        this.lyrics();
      } catch {
        if (!this.destroyed && epoch === this.mediaEpoch && this.lyricsRequest === pending
            && !pending.controller.signal.aborted) {
          this.lyricsRetryAt = Date.now() + 3000;
          this.notice('歌词暂时无法加载，伴奏仍可播放；稍后自动重试。');
        }
      } finally {
        if (this.lyricsRequest === pending) this.lyricsRequest = null;
      }
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
        const epoch = this.mediaEpoch, attempt = {};
        this.voiceAttempt = attempt;
        Promise.resolve(this.voice.play()).catch(() => {
          if (epoch !== this.mediaEpoch || this.voiceAttempt !== attempt) return;
          this.voiceBlocked = true;
          this.notice('原唱未能播放；伴奏不受影响。');
        }).finally(() => {
          if (this.voiceAttempt === attempt) this.voiceStarting = false;
        });
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
      if (event.defaultPrevented) return;
      const editing = event.target?.matches?.('input:not([type="checkbox"])');
      if (editing && ['Backspace', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) return;
      if (['Escape', 'Backspace', 'BrowserBack', 'GoBack'].includes(event.key)
          || event.keyCode === 10009 || event.keyCode === 4) {
        event.preventDefault();
        this.overlay($('#pairPanel').hidden);
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return;
      this.showControls();
      const scope = $('#pairPanel').hidden ? $('.tv-safe') : $('#pairPanel');
      const buttons = [...scope.querySelectorAll('button:not(:disabled), input:not(:disabled), summary, a[href]')]
        .filter(button => {
          const closed = button.closest('details:not([open])');
          return !button.hidden && !button.closest('[hidden]')
            && (!closed || button.tagName === 'SUMMARY' && button.parentElement === closed);
        });
      if (!buttons.length) return;
      if (event.key === 'Enter') {
        if (!buttons.includes(document.activeElement)) { event.preventDefault(); buttons[0].focus(); }
        else if (document.activeElement.matches('input[type="checkbox"]')) {
          event.preventDefault();
          document.activeElement.checked = !document.activeElement.checked;
          document.activeElement.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }
      event.preventDefault();
      let index = buttons.indexOf(document.activeElement);
      index = (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[index].focus();
    }
    destroy() {
      this.destroyed = true;
      this.connectionEpoch++;
      this.disarm();
      this.resetLyrics();
      this.client?.stop();
      clearInterval(this.heartbeatTimer);
      clearInterval(this.watchdog);
      clearTimeout(this.idleTimer);
      clearTimeout(this.noticeTimer);
      clearTimeout(this.recoverTimer);
      clearTimeout(this.endTimer);
      cancelAnimationFrame(this.frame);
    }
  }
  window.OpenKStage = Stage;
  window.openkStage = new Stage();
})();
