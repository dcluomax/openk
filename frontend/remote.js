(() => {
  'use strict';
  const { RoomClient, request, saved, clock, joinURL, roomSessions, contextChanged } = OpenKRoom;
  const $ = selector => document.querySelector(selector);
  class Remote {
    constructor() {
      this.client = null;
      this.jobs = [];
      this.zhMap = {};
      this.librarySearch = OpenKSearch.create();
      this.search = '';
      this.composing = false;
      this.libraryPage = 1;
      this.libraryMode = 'all';
      this.libraryLetter = '';
      this.popularity = OpenKLibrary.createPopularity(() => {
        if (!this.destroyed) this.renderLibrary();
      });
      this.joining = false;
      this.loading = false;
      this.libraryError = '';
      this.queueRevision = -1;
      this.epoch = 0;
      this.credentials = null;
      this.destroyed = false;
      this.listing = [];
      this.lobbySignature = '';
      this.memberSignature = '';
      this.account = null;
      this.ready = false;
      this.starting = false;
      this.entry = null;
      this.chipView = null;
      this.lobbyOpen = false;
      this.switching = false;
      this.recovering = null;
      this.bind();
      this.start();
    }
    notice(message) {
      $('#remoteNotice').textContent = message;
      $('#remoteNotice').hidden = false;
      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => { $('#remoteNotice').hidden = true; }, 4500);
    }
    start(force = false) {
      if (this.starting || this.destroyed) return this.startup;
      this.popularity.reset();
      this.starting = true;
      this.ready = false;
      $('#joinScreen').hidden = $('#roomScreen').hidden = $('#signInScreen').hidden = true;
      $('#startupScreen').hidden = false;
      $('#startupStatus').textContent = '正在读取登录状态，请稍候。';
      $('#startupRetry').hidden = true;
      $('#createRoom').disabled = $('#joinSubmit').disabled = true;
      const epoch = this.epoch;
      if (!this.entry) {
        const fragment = new URLSearchParams(location.hash.slice(1));
        this.entry = { room: fragment.get('room'), code: fragment.get('code'),
          lobby: location.pathname.replace(/\/$/, '') === '/rooms' };
        // Keep the initial intent in memory: connecting changes both the URL and the form.
        if (location.hash) history.replaceState(null, '', location.pathname);
      }
      const { room, code, lobby } = this.entry;
      if (room) $('#joinRoom').value = room;
      if (code) $('#joinCode').value = code;
      this.startup = (force ? OpenKAccount.reload() : OpenKAccount.load()).then(account => {
        if (this.destroyed || epoch !== this.epoch) return null;
        this.account = account;
        // Account deployments never reuse another person's saved room capabilities.
        return account.enabled ? this.startAccount(room, code, lobby) : this.startStandalone(room, code, lobby);
      }).catch(error => this.startupFailed(error)).finally(() => {
        this.starting = false;
        $('#createRoom').disabled = $('#joinSubmit').disabled = !this.ready || this.joining;
      });
      return this.startup;
    }
    startupFailed(error) {
      if (this.destroyed || error.status === 499) return;
      if (error.status === 401) { this.signedOut(error.message); return; }
      this.epoch++;
      this.ready = false;
      this.client?.stop();
      this.client = null;
      OpenKRoom.renderDevices($('#remoteDevices'), null, null);
      this.lobbyOpen = false;
      clearTimeout(this.lobbyTimer);
      $('#roomScreen').hidden = true;
      $('#signInScreen').hidden = true;
      $('#joinScreen').hidden = true;
      $('#startupScreen').hidden = false;
      $('#startupRetry').hidden = false;
      $('#lobbyStatus').textContent = '';
      $('#startupStatus').textContent = '暂时无法连接：' + error.message + '。请重新连接后再创建或加入房间。';
      $('#remoteConnection').textContent = '启动失败';
    }
    startStandalone(room, code, lobby) {
      this.ready = true;
      $('#startupScreen').hidden = true;
      const previous = saved('openk.remote.room');
      const nickname = saved('openk.display-name');
      if (typeof nickname === 'string') $('#displayName').value = nickname;
      if (previous?.roomId && previous.token) {
        this.remember({ ...previous, role: previous.role || 'controller' });
      }
      const tv = saved('openk.tv.room');
      if (tv?.roomId && tv.token) this.remember({ ...tv, role: tv.role || 'host' });
      if (lobby && !room) {
        this.showLobby();
      } else if (room && roomSessions.get(room, ['host', 'controller'])) {
        this.connect(roomSessions.get(room, ['host', 'controller']));
      } else if (previous && !room) {
        this.connect(previous);
      } else if (/^[a-f0-9]{10}$/i.test(room || '') && /^\d{6}$/.test(code || '')) {
        return this.join({ room, code });
      } else this.showLobby();
    }
    async startAccount(room, code, lobby) {
      this.chipView = OpenKAccount.mount($('#accountChip'), { onLogout: () => this.signOut() });
      this.chipView.update(this.account.user);
      // Register this phone as one of the account's devices so it shows up in the
      // topology on /devices. It stays a controller: a phone cannot stream its
      // microphone to another device in this product.
      if (this.account.user && window.OpenKUserState) {
        window.OpenKUserState.reset();
        window.OpenKUserState.load().catch(() => {});
      }
      // A persistent nickname belongs to the profile, not to a per-browser text field.
      $('#displayName').hidden = $('#displayNameLabel').hidden = true;
      $('#memberForm').hidden = true;
      $('#profileHint').hidden = $('#memberProfileHint').hidden = false;
      $('#profileLink').href = $('#memberProfileLink').href = this.account.profileUrl;
      $('#playHere').hidden = false;
      $('#memberIdentityHint').textContent = '名单按账号显示，同一账号的手机和电视算同一位成员。演唱安排不会打开手机麦克风。';
      $('#newRoomScreens').nextElementSibling.textContent = '允许其他成员在自己的设备上播放；每房间仅一台播放';
      $('#roomScreens').nextElementSibling.textContent = '允许其他成员播放；关闭会暂停非房主的播放，但不会移出成员';
      $('#recentRooms').hidden = true;
      // Signing in always lands in the server's current room, solo or shared.
      if (!await this.enterCurrent() || this.destroyed) return;
      this.ready = true;
      const invited = /^[a-f0-9]{10}$/i.test(room || '') && /^\d{6}$/.test(code || '');
      if (invited) await this.join({ room, code });
      else if (room || code) {
        this.showLobby();
        $('#joinRoomPanel').open = true;
        $('#joinError').textContent = '配对链接不完整，请向房主获取新的链接或填写房间号和配对码。';
      } else if (lobby) this.showLobby();
    }
    async enterCurrent(notice) {
      const epoch = this.epoch;
      const result = await OpenKAccount.currentRoom();
      if (this.destroyed || epoch !== this.epoch) return null;
      this.enter(result, notice);
      return result;
    }
    /** Follow a server current-room result: the browser never picks the room itself. */
    enter(result, notice) {
      const value = OpenKAccount.adopt(result);
      this.connect({
        room_id: value.room_id, roomId: value.room_id, token: null, role: value.role,
        name: value.state?.name,
        code: OpenKAccount.currentInvite(this.account.user.id, value.room_id,
          value.state?.invite_version),
      }, value.state);
      if (notice) this.notice(notice);
      return value;
    }
    /** The account moved, expired or was disbanded elsewhere: ask the server where we are now. */
    recover(message) {
      if (!this.account?.enabled || this.destroyed || this.signingOut) return this.recovering;
      if (this.recovering) return this.recovering;
      clearTimeout(this.recoverTimer);
      this.recovering = (async () => {
        this.ready = false;
        this.client?.stop();
        this.client = null;
        const epoch = ++this.epoch;
        try {
          const account = await OpenKAccount.reload();
          if (this.destroyed || epoch !== this.epoch) return;
          if (!account.enabled) throw new Error('账号配置已改变，请刷新页面后继续');
          this.account = account;
          this.chipView?.update(account.user);
          if (await this.enterCurrent(message || '你的房间已切换，已经带你回到当前的房间。')) this.ready = true;
        } catch (error) {
          if (this.destroyed || this.signingOut || error.status === 499) return;
          if (error.status === 401) this.signedOut(error.message);
          else {
            this.notice(error.message);
            $('#remoteConnection').textContent = '正在找回你的房间…';
            this.recoverTimer = setTimeout(() => this.recover(message), 3000);
          }
        } finally {
          this.recovering = null;
          $('#createRoom').disabled = $('#joinSubmit').disabled = !this.ready || this.joining;
        }
      })();
      return this.recovering;
    }
    signedOut(message) {
      this.popularity.reset();
      OpenKAccount.reset();
      this.ready = false;
      this.epoch++;
      this.client?.stop();
      this.client = null;
      this.credentials = null;
      this.lobbyOpen = false;
      this.listing = [];
      this.jobs = [];
      this.lobbySignature = this.memberSignature = '';
      clearTimeout(this.lobbyTimer);
      clearTimeout(this.recoverTimer);
      clearTimeout(this.noticeTimer);
      $('#remoteNotice').hidden = true;
      $('#roomScreen').hidden = $('#joinScreen').hidden = true;
      $('#startupScreen').hidden = true;
      $('#queuePanel').hidden = true;
      $('#leaveRoom').hidden = $('#switchRoom').hidden = true;
      $('#playHere').hidden = true;
      $('#signInScreen').hidden = false;
      $('#signInNotice').textContent = message || '登录状态已失效，请重新登录。';
      $('#signInLink').href = this.account?.loginUrl || '/auth/login/';
      $('#remoteConnection').textContent = '未登录';
      $('#roomSongList').replaceChildren();
      $('#roomMembers').replaceChildren();
      OpenKRoom.renderDevices($('#remoteDevices'), null, null);
      $('#remoteQueue').replaceChildren();
      $('#lobbyList').replaceChildren();
      document.body.classList.remove('sheet-open');
      this.chipView?.update(null);
    }
    async signOut() {
      if (this.signingOut) return;
      this.signingOut = true;
      this.ready = false;
      this.chipView?.busy(true);
      this.epoch++;
      this.client?.stop();
      this.client = null;
      OpenKRoom.renderDevices($('#remoteDevices'), null, null);
      clearTimeout(this.lobbyTimer);
      clearTimeout(this.recoverTimer);
      try {
        window.OpenKUserState?.reset();
        location.assign(await OpenKAccount.logout());
      } catch (error) {
        this.signingOut = false;
        this.chipView?.busy(false);
        this.notice(error.message);
        await this.recovering;
        await this.recover('退出登录未成功，已恢复当前房间。');
      }
    }
    bind() {
      $('#playbackPanel').open = window.innerWidth >= 900;
      $('#startupRetry').onclick = () => this.start(true);
      $('#joinForm').onsubmit = event => { event.preventDefault(); this.join(); };
      $('#leaveRoom').onclick = () => this.leave();
      $('#switchRoom').onclick = () => this.showLobby();
      $('#returnRoom').onclick = () => this.closeLobby();
      $('#refreshInvite').onclick = () => this.rotateInvite();
      $('#refreshRooms').onclick = () => this.loadLobby();
      $('#newPartyShortcut').onclick = event => {
        event.preventDefault();
        $('#createRoomPanel').open = !$('#createRoomPanel').open;
        $('#joinRoomPanel').open = false;
        if ($('#createRoomPanel').open) $('#newRoomName').focus();
      };
      $('#joinCodeShortcut').onclick = event => {
        event.preventDefault();
        $('#joinRoomPanel').open = !$('#joinRoomPanel').open;
        $('#createRoomPanel').open = false;
        if ($('#joinRoomPanel').open) ($('#joinRoom').value ? $('#joinCode') : $('#joinRoom')).focus();
      };
      $('#createRoomForm').onsubmit = event => { event.preventDefault(); this.create(); };
      $('#memberForm').onsubmit = event => { event.preventDefault(); this.renameMember(); };
      $('#memberName').oninput = () => { this.nameDirty = true; };
      $('#roomSettingsForm').oninput = () => { this.settingsDirty = true; };
      $('#roomSettingsForm').onsubmit = event => { event.preventDefault(); this.saveSettings(); };
      $('#endRoom').onclick = () => this.endRoom();
      $('#singCurrent').onclick = () => {
        const state = this.client?.state;
        if (state?.current) this.participate($('#singCurrent'), state.current, state);
      };
      $('#songSearch').oninput = event => {
        clearTimeout(this.searchTimer);
        if (event.isComposing) this.composing = true;
        if (this.composing || event.isComposing) return;
        this.searchTimer = setTimeout(() => { this.libraryPage = 1; this.renderLibrary(); }, 100);
      };
      $('#songSearch').addEventListener('compositionstart', () => {
        this.composing = true;
        clearTimeout(this.searchTimer);
      });
      $('#songSearch').addEventListener('compositionend', () => {
        this.composing = false;
        clearTimeout(this.searchTimer);
        this.libraryPage = 1;
        this.renderLibrary();
      });
      $('#refreshLibrary').onclick = () => { this.loadLibrary(); this.refreshPopularity(true); };
      $('#libraryOrder').onchange = () => {
        this.libraryMode = $('#libraryOrder').value;
        this.libraryLetter = '';
        this.libraryPage = 1;
        $('#remoteBrowseOptions').open = false;
        $('#remoteBrowseSummary').focus();
        this.renderLibrary();
        this.refreshPopularity(true);
      };
      $('#remoteIndex').onclick = event => {
        const button = event.target.closest('[data-letter]');
        if (!button || button.disabled) return;
        this.libraryLetter = button.dataset.letter;
        this.libraryPage = 1;
        $('#remoteBrowseOptions').open = false;
        $('#remoteBrowseSummary').focus();
        this.renderLibrary();
      };
      $('#remotePager').onclick = event => {
        const button = event.target.closest('[data-page-step]');
        if (!button || button.disabled) return;
        this.libraryPage += Number(button.dataset.pageStep);
        this.renderLibrary();
        $('.room-library').scrollIntoView?.({ block: 'start' });
      };
      $('#openQueue').onclick = () => this.queue(true);
      $('#closeQueue').onclick = () => this.queue(false);
      $('#queuePanel').onclick = event => { if (event.target === $('#queuePanel')) this.queue(false); };
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && $('#remoteBrowseOptions').open && $('#queuePanel').hidden) {
          event.preventDefault();
          $('#remoteBrowseOptions').open = false;
          $('#remoteBrowseSummary').focus();
          return;
        }
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
      document.addEventListener('click', event => {
        if (!$('#remoteBrowseOptions').contains(event.target)) $('#remoteBrowseOptions').open = false;
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
      $('#remotePlay').onclick = () => this.play();
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
      window.addEventListener('pagehide', () => this.destroy());
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !this.destroyed) this.refreshPopularity(true);
      });
    }
    remember(value) {
      if (this.account?.enabled) return false;
      const entry = {
        room_id: value.room_id || value.roomId, token: value.token,
        role: value.role || 'controller',
        name: value.name || 'Room ' + (value.room_id || value.roomId),
        display_name: value.display_name,
        pairing_code: value.pairing_code || value.code,
      };
      try {
        const stored = roomSessions.remember(entry);
        if (!stored) this.notice('浏览器无法保存房间凭据，请保持此页面打开。');
        return stored;
      } catch (error) { this.notice(error.message); return false; }
    }
    saveCurrent() {
      // Account rooms live on the server; no bearer capability is written to this browser.
      if (this.account?.enabled || !this.credentials) return;
      const signature = JSON.stringify(this.credentials);
      if (signature === this.savedSignature) return;
      const stored = this.remember(this.credentials);
      const current = saved('openk.remote.room', this.credentials) !== null;
      if (stored && current) this.savedSignature = signature;
    }
    lobbyActive() { return this.account?.enabled ? this.lobbyOpen : !this.client; }
    applyChrome() {
      const lobby = this.lobbyActive();
      $('#startupScreen').hidden = true;
      $('#signInScreen').hidden = true;
      $('#joinScreen').hidden = !lobby;
      $('#roomScreen').hidden = lobby || !this.client;
      $('#leaveRoom').hidden = $('#switchRoom').hidden = lobby || !this.client;
    }
    renderBanner() {
      const shown = !!(this.account?.enabled && this.client);
      $('#currentRoomBanner').hidden = !shown;
      if (!shown) return;
      const state = this.client.state;
      const name = state?.name || '房间 ' + this.client.id;
      $('#currentRoomText').textContent = (state?.solo ? '自己的房间：' : '当前房间：') + name
        + ' · 浏览大厅不会退出';
    }
    closeLobby() {
      if (!this.account?.enabled) return;
      this.lobbyOpen = false;
      clearTimeout(this.lobbyTimer);
      history.replaceState(null, '', '/remote');
      document.title = 'OpenK · ' + (this.client?.state?.name || '手机点歌');
      $('#currentRoomBanner').hidden = true;
      this.applyChrome();
      if (this.client?.state) this.render(this.client.state);
      this.client?.refresh().catch(() => {});
    }
    showLobby() {
      if (this.account?.enabled) {
        // The lobby is only a selector: the current room keeps running behind it.
        this.lobbyOpen = true;
        clearTimeout(this.noticeTimer);
        $('#remoteNotice').hidden = true;
        $('#queuePanel').hidden = true;
        $('#hostControls').open = false;
        document.body.classList.remove('sheet-open');
        history.replaceState(null, '', '/rooms');
        document.title = 'OpenK · 聚会大厅';
        this.applyChrome();
        this.renderBanner();
        this.renderLobby();
        this.loadLobby();
        return;
      }
      this.epoch++;
      this.client?.stop();
      this.client = null;
      this.credentials = null;
      this.savedSignature = null;
      this.nameDirty = this.settingsDirty = false;
      this.endConfirm = null;
      clearTimeout(this.noticeTimer);
      $('#remoteNotice').hidden = true;
      history.replaceState(null, '', '/rooms');
      document.title = 'OpenK · 聚会大厅';
      $('#roomScreen').hidden = true;
      $('#joinScreen').hidden = false;
      $('#leaveRoom').hidden = $('#switchRoom').hidden = true;
      $('#queuePanel').hidden = true;
      $('#hostControls').open = false;
      $('#remoteConnection').textContent = '聚会大厅';
      document.body.classList.remove('sheet-open');
      this.renderLobby();
      this.loadLobby();
    }
    async loadLobby() {
      if (!this.lobbyActive() || this.lobbyLoading || this.destroyed) return;
      this.lobbyLoading = true;
      const epoch = this.epoch;
      clearTimeout(this.lobbyTimer);
      $('#refreshRooms').disabled = true;
      $('#lobbyStatus').textContent = '正在读取房间…';
      try {
        const result = await RoomClient.list();
        if (!this.lobbyActive() || this.destroyed) return;
        if (!Array.isArray(result.rooms)) throw new Error('房间列表格式不正确，请刷新重试');
        this.listing = result.rooms;
        this.renderLobby();
        $('#lobbyStatus').textContent = result.rooms.length
          ? (this.account?.enabled ? '选择一个房间即可加入；你当前的房间会自动退出。'
            : '选择房间后输入配对码，或直接返回本机已加入的房间。')
          : '还没有展示中的房间。创建一间，或用配对码加入未展示的房间。';
      } catch (error) {
        if (!this.destroyed && (this.account?.enabled || epoch === this.epoch)) {
          if (error.status === 401) { this.signedOut(error.message); return; }
          if (this.account?.enabled && contextChanged(error)) { this.recover(); return; }
          $('#lobbyStatus').textContent = error.message;
        }
      } finally {
        this.lobbyLoading = false;
        if (!this.destroyed) $('#refreshRooms').disabled = false;
        if (this.lobbyActive() && !this.destroyed) this.lobbyTimer = setTimeout(() => this.loadLobby(), 5000);
      }
    }
    renderLobby() {
      const account = this.account?.enabled;
      // Saved bearer rooms belong to the standalone deployment only.
      const recent = account ? [] : [...new Set(roomSessions.all().map(entry => entry.room_id))]
        .map(roomId => roomSessions.get(roomId, ['host', 'controller', 'screen']));
      const signature = JSON.stringify([
        this.listing.map(({ created_at, expires_at, ...entry }) => entry),
        recent.map(({ token, pairing_code, ...entry }) => entry),
        account ? this.client?.id || null : null,
      ]);
      if (signature === this.lobbySignature) return;
      this.lobbySignature = signature;
      const focused = document.activeElement?.dataset.roomFocus;
      const row = (info, cached, live) => {
        const item = document.createElement('li');
        item.className = 'lobby-room';
        item.dataset.roomId = info.id;
        const description = document.createElement('div');
        description.className = 'song-info';
        const name = document.createElement('strong'); name.textContent = info.name || 'Room ' + info.id;
        const summary = document.createElement('span');
        summary.textContent = live
          ? `${info.members_online} 位在线成员 · ${info.screens_online} 台在线电视 · ${info.queue_length} 首待唱`
          : (cached.role === 'host' ? '本机是房主' : cached.role === 'screen' ? '已保存的电视连接' : '本机已配对');
        description.append(name, summary);
        if (live) {
          const song = document.createElement('span');
          song.textContent = info.current
            ? (info.player.online ? '正在唱 · ' : '待启用电视 · ') + info.current.title
            : '等待点歌';
          description.append(song);
        }
        const actions = document.createElement('div'); actions.className = 'lobby-actions';
        const enter = document.createElement('button');
        const mine = account && live && this.client?.id === info.id;
        enter.textContent = mine ? '返回这个房间'
          : cached?.role === 'screen' ? '继续大屏' : cached ? '进入房间' : '加入';
        enter.dataset.roomFocus = info.id + (live ? '-live' : '-recent');
        enter.onclick = () => {
          if (this.joining) return;
          if (mine) { this.closeLobby(); return; }
          if (account) {
            const code = OpenKAccount.inviteCode(this.account.user.id, info.id)?.code;
            $('#joinRoom').value = info.id;
            $('#joinCode').value = code || '';
            if (code) { this.join(); return; }
            $('#joinRoomPanel').open = true;
            $('#joinForm').scrollIntoView?.({ block: 'nearest' });
            $('#joinCode').focus();
            return;
          }
          if (cached?.role === 'screen') location.assign('/tv#' + new URLSearchParams({ room: info.id }));
          else if (cached) this.connect(cached);
          else {
            $('#joinRoomPanel').open = true;
            $('#joinRoom').value = info.id;
            $('#joinCode').value = '';
            $('#joinForm').scrollIntoView?.({ block: 'nearest' });
            $('#joinCode').focus();
          }
        };
        actions.append(enter);
        // An account television follows its own person; it never pairs as an extra member.
        if (!account && live && info.allow_screens) {
          const screen = document.createElement('a');
          screen.className = 'subtle-link';
          screen.href = '/tv#' + new URLSearchParams({ room: info.id });
          screen.textContent = '电视加入';
          actions.append(screen);
        }
        item.append(description, actions);
        return item;
      };
      $('#lobbyList').replaceChildren(...this.listing.map(info =>
        row(info, account ? null : roomSessions.get(info.id, ['host', 'controller']), true)));
      $('#recentList').replaceChildren(...recent.map(entry =>
        row({ id: entry.room_id, name: entry.name }, entry, false)));
      $('#recentRooms').hidden = recent.length === 0;
      if (focused) [...$('#joinScreen').querySelectorAll('[data-room-focus]')]
        .find(button => button.dataset.roomFocus === focused)?.focus();
    }
    async create() {
      if (!this.ready || this.starting || this.recovering || this.signingOut) {
        this.notice('请先完成连接并确认登录状态，再创建房间。');
        return;
      }
      if (this.joining) return;
      this.joining = true;
      const epoch = this.epoch;
      $('#createRoom').disabled = $('#joinSubmit').disabled = true;
      $('#joinError').textContent = '';
      try {
        const options = {
          name: $('#newRoomName').value.trim(),
          discoverable: $('#newRoomListed').checked, allow_screens: $('#newRoomScreens').checked,
        };
        if (this.account?.enabled) {
          this.switching = true;
          const result = await RoomClient.create(options);
          if (this.destroyed || epoch !== this.epoch) return;
          this.enter(result, '房间已创建。把配对码给朋友，也可以在这台设备上播放。');
          this.closeLobby();
          $('#hostControls').open = true;
          return;
        }
        const result = await RoomClient.create({
          ...options, display_name: $('#displayName').value.trim() || undefined,
        });
        if (result.account_mode || typeof result.host_token !== 'string') {
          throw new Error('房间登录配置已改变，请刷新页面后重试。');
        }
        const credentials = {
          room_id: result.room_id, token: result.host_token, role: 'host',
          pairing_code: result.pairing_code, name: result.state.name,
        };
        this.remember(credentials);
        if (epoch !== this.epoch || this.destroyed) return;
        saved('openk.display-name', $('#displayName').value.trim());
        this.connect(credentials, result.state);
        $('#hostControls').open = true;
        this.notice('房间已创建。把配对码给朋友，也可以让电视加入。');
      } catch (error) {
        if (this.destroyed) return;
        if (this.account?.enabled) this.joinFailed(error);
        else if (epoch === this.epoch) $('#joinError').textContent = error.message;
      } finally {
        this.joining = false;
        this.switching = false;
        $('#createRoom').disabled = $('#joinSubmit').disabled = !this.ready || this.starting;
      }
    }
    /** A refused move keeps the person exactly where the server still has them. */
    joinFailed(error) {
      if (error.status === 401) { this.signedOut(error.message); return; }
      if (this.account?.enabled && this.client && !this.lobbyOpen) this.showLobby();
      $('#joinRoomPanel').open = true;
      $('#joinError').textContent = error.message;
      if (contextChanged(error) || [403, 404].includes(error.status) && !this.client) {
        this.recover();
      } else this.client?.refresh().catch(() => {});
    }
    async join(target = null) {
      if (!this.ready || this.starting && !target || this.recovering || this.signingOut) {
        this.notice('请先完成连接并确认登录状态，再加入房间。');
        return;
      }
      if (this.joining) return;
      this.joining = true;
      $('#joinSubmit').disabled = true;
      $('#joinError').textContent = '';
      const roomId = (target?.room || $('#joinRoom').value).trim().toLowerCase();
      const code = (target?.code || $('#joinCode').value).trim();
      const epoch = this.epoch;
      try {
        if (this.account?.enabled) {
          this.switching = true;
          const result = await RoomClient.join(roomId, code);
          if (this.destroyed || epoch !== this.epoch) return;
          $('#joinCode').value = '';
          this.enter(result, '已加入房间，原来的房间已自动退出。');
          this.closeLobby();
          return;
        }
        const displayName = $('#displayName').value.trim();
        const result = await RoomClient.join(roomId, code, { display_name: displayName || undefined });
        if (result.account_mode || typeof result.controller_token !== 'string') {
          throw new Error('房间登录配置已改变，请刷新页面后重试。');
        }
        const credentials = { roomId, token: result.controller_token, role: 'controller',
          name: result.state.name, display_name: result.state.viewer?.name };
        this.remember(credentials);
        if (epoch !== this.epoch || this.destroyed) return;
        saved('openk.display-name', displayName);
        $('#joinCode').value = '';
        this.connect(credentials, result.state);
      } catch (error) {
        if (this.destroyed) return;
        if (this.account?.enabled) this.joinFailed(error);
        else if (epoch === this.epoch) $('#joinError').textContent = error.message;
      }
      finally {
        this.joining = false; this.switching = false;
        $('#joinSubmit').disabled = !this.ready || this.starting;
      }
    }
    connect(credentials, state) {
      this.epoch++;
      clearTimeout(this.lobbyTimer);
      this.client?.stop();
      this.credentials = { ...credentials, roomId: credentials.roomId || credentials.room_id,
        role: credentials.role || 'controller', code: credentials.code || credentials.pairing_code };
      this.savedSignature = null;
      this.nameDirty = this.settingsDirty = false;
      this.memberSignature = '';
      this.inviteSignature = '';
      this.endConfirm = null;
      this.saveCurrent();
      this.client = new RoomClient(this.credentials.roomId, this.credentials.token, {
        presence: () => OpenKRoom.devicePresence(['controller']),
      });
      history.replaceState(null, '', '/remote');
      const client = this.client;
      this.queueRevision = -1;
      this.client.onstate = current => { if (this.client === client) this.render(current); };
      this.client.onconnection = (connection, error) => {
        if (this.client !== client) return;
        $('#remoteConnection').textContent = {
          connected: '● 房间已连接', reconnecting: '◌ 正在重连…',
          expired: '需要重新配对', changed: '房间已切换',
        }[connection];
        if (this.account?.enabled) {
          if (error?.status === 401) { this.signedOut(error.message); return; }
          // The server owns the current room; follow it instead of showing an empty screen.
          if (connection === 'changed') this.recover();
          else if (connection === 'expired') this.recover('房间已结束，已经回到你自己的房间。');
          return;
        }
        if (connection === 'expired') {
          const roomId = client.id;
          const role = this.credentials.role;
          roomSessions.forget(roomId, error.status === 404 ? undefined : role);
          saved('openk.remote.room', null);
          this.showLobby();
          $('#joinRoom').value = roomId;
          $('#joinError').textContent = error.message;
        } else if (error?.status === 401) {
          $('#remoteConnection').textContent = '请重新登录 OpenK，然后刷新此页';
        }
      };
      if (!this.lobbyOpen) history.replaceState(null, '', '/remote');
      this.applyChrome();
      $('#joinCode').value = '';
      $('#hostControls').open = false;
      for (const selector of ['#remotePlay', '#remoteGuide', '#remoteRestart', '#remoteNext', '#seek', '#singCurrent']) {
        $(selector).disabled = true;
      }
      $('#hostControls').hidden = true;
      for (const selector of ['#remotePlay', '#remoteGuide', '#remoteRestart', '#remoteNext', '#seek', '#singCurrent']) {
        $(selector).disabled = true;
      }
      $('#remoteTitle').textContent = '正在连接房间…';
      $('#remoteArtist').textContent = '';
      $('#currentSingers').textContent = '';
      $('#roomMembers').replaceChildren();
      OpenKRoom.renderDevices($('#remoteDevices'), null, null);
      $('#remoteRoom').textContent = 'LIVE ROOM / ' + this.credentials.roomId;
      if (state) this.client.accept(state);
      this.client.start();
      this.loadLibrary();
      if (this.lobbyOpen) { this.renderBanner(); this.loadLobby(); }
    }
    async leave() {
      const client = this.client, credentials = this.credentials;
      if (!client || $('#leaveRoom').disabled) return;
      $('#leaveRoom').disabled = true;
      try {
        if (this.account?.enabled) {
          this.switching = true;
          const result = await client.leave();
          if (this.destroyed || this.client !== client) return;
          // Leaving a party returns to a private solo room, never to an empty screen.
          this.enter(result.current, result.left === false
            ? '你已经在自己的房间里了。' : '已退出聚会，回到你自己的房间。');
          this.closeLobby();
          return;
        }
        await client.leave();
        if (credentials.role !== 'host') roomSessions.forget(client.id, credentials.role);
        if (this.client !== client) return;
        saved('openk.remote.room', null);
        this.showLobby();
        this.notice(credentials.role === 'host' ? '已离开；房间与房主凭据保留，可随时返回。' : '已退出房间，重新加入需要配对码。');
      } catch (error) {
        if (this.destroyed || this.client !== client) return;
        if (this.account?.enabled) {
          if (error.status === 401) this.signedOut(error.message);
          else if (contextChanged(error) || [403, 404].includes(error.status)) this.recover();
          else this.notice(error.message);
          return;
        }
        if ([403, 404].includes(error.status)) {
          roomSessions.forget(client.id, credentials.role);
          saved('openk.remote.room', null);
          this.showLobby();
        }
        this.notice(error.message);
      } finally { this.switching = false; $('#leaveRoom').disabled = false; }
    }
    async rotateInvite() {
      const client = this.client;
      if (!client || $('#refreshInvite').disabled) return;
      $('#refreshInvite').disabled = true;
      try {
        const result = await client.invitation();
        if (this.client !== client) return;
        if (!/^\d{6}$/.test(result.pairing_code || '')) throw new Error('服务器返回的配对码无效，请重试。');
        OpenKAccount.rememberInvite(this.account.user.id, client.id, result.pairing_code,
          result.state?.invite_version);
        this.credentials.code = result.pairing_code;
        this.inviteStale = false;
        this.inviteSignature = '';
        this.render(client.state);
        this.notice('新的配对码已生成，旧配对码立即失效。');
      } catch (error) {
        if (this.client !== client) return;
        if (error.status === 401) this.signedOut(error.message);
        else this.notice(error.message);
      } finally { $('#refreshInvite').disabled = false; }
    }
    async renameMember() {
      const client = this.client;
      if (!client || $('#saveMember').disabled) return;
      if (this.account?.enabled) {
        this.notice('昵称跟着账号走，请在个人资料中修改。');
        return;
      }
      $('#saveMember').disabled = true;
      try {
        await client.updateMember($('#memberName').value.trim());
        if (this.client !== client) return;
        this.nameDirty = false;
        $('#displayName').value = client.state.viewer.name;
        saved('openk.display-name', client.state.viewer.name);
        this.render(client.state);
        this.notice('演唱昵称已更新');
      } catch (error) { if (this.client === client) this.notice(error.message); }
      finally { $('#saveMember').disabled = false; }
    }
    async saveSettings() {
      const client = this.client;
      if (!client || $('#saveRoomSettings').disabled) return;
      $('#saveRoomSettings').disabled = true;
      try {
        await client.settings({ name: $('#roomName').value.trim(),
          discoverable: $('#roomListed').checked, allow_screens: $('#roomScreens').checked });
        if (this.client !== client) return;
        this.settingsDirty = false;
        this.render(client.state);
        this.notice('房间设置已保存');
      } catch (error) { if (this.client === client) this.notice(error.message); }
      finally { $('#saveRoomSettings').disabled = false; }
    }
    async endRoom() {
      const client = this.client;
      if (!client || $('#endRoom').disabled) return;
      if (this.endConfirm !== client.id) {
        this.endConfirm = client.id;
        $('#endRoom').textContent = '再次点击，结束房间并让所有设备退出';
        clearTimeout(this.endTimer);
        this.endTimer = setTimeout(() => {
          this.endConfirm = null;
          $('#endRoom').textContent = '结束房间';
        }, 5000);
        return;
      }
      $('#endRoom').disabled = true;
      try {
        const result = await client.close();
        if (this.account?.enabled) {
          if (this.destroyed || this.client !== client) return;
          OpenKAccount.forgetInvite(this.account.user.id, client.id);
          this.enter(result.current, '房间已结束，已回到你自己的房间。曲库歌曲仍保留。');
          this.closeLobby();
          return;
        }
        roomSessions.forget(client.id);
        const tv = saved('openk.tv.room');
        if (tv?.roomId === client.id) saved('openk.tv.room', null);
        if (this.client !== client) return;
        saved('openk.remote.room', null);
        this.showLobby();
        this.notice('房间已结束，曲库歌曲仍保留。');
      } catch (error) {
        if (this.destroyed || this.client !== client) return;
        if (this.account?.enabled && error.status === 401) this.signedOut(error.message);
        else if (this.account?.enabled && (contextChanged(error) || [403, 404].includes(error.status))) {
          this.recover();
        } else this.notice(error.message);
      } finally { $('#endRoom').disabled = false; }
    }
    participate(button, item, state) {
      const joined = item.singers?.some(member => member.id === state.viewer?.id);
      return this.run(button, joined ? 'unsing' : 'sing', { item_id: item.id },
        joined ? '已退出这首歌的演唱名单' : '已加入演唱名单，一起唱吧');
    }
    async loadLibrary() {
      if (this.loading) return;
      this.loading = true;
      this.libraryError = '';
      $('#refreshLibrary').disabled = true;
      $('#libraryStatus').textContent = '正在读取 NAS 曲库…';
      try {
        const [jobs, mapping] = await Promise.all([
          request('/api/jobs'),
          request('/api/zh-map').catch(() => ({})),
        ]);
        if (this.destroyed) return;
        this.zhMap = mapping;
        this.librarySearch.setMap(mapping);
        this.jobs = jobs.filter(job => job.state === 'done' && job.media?.instrumental);
        this.renderLibrary();
        this.refreshPopularity();
      } catch (error) {
        if (!this.destroyed) {
          this.libraryError = error.message + '。点击「刷新曲库」重试。';
          $('#libraryStatus').textContent = this.libraryError;
        }
      } finally {
        this.loading = false;
        if (!this.destroyed) $('#refreshLibrary').disabled = false;
      }
    }
    refreshPopularity(force = false) {
      const id = this.account?.enabled ? this.account.user?.id || null : null;
      return this.libraryMode === 'popular' && !this.destroyed
        ? this.popularity.load(id, force) : Promise.resolve();
    }
    renderLibrary() {
      if (!this.composing) this.search = $('#songSearch').value;
      const query = this.librarySearch.query(this.search);
      const accountId = this.account?.enabled ? this.account.user?.id || null : null;
      this.popularity.forAccount(accountId);
      $('#libraryOrder option[value="popular"]').hidden = !accountId;
      const mode = query.text || (this.libraryMode === 'popular' && !accountId) ? 'all' : this.libraryMode;
      $('#remoteBrowseSummary').textContent = query.text ? '搜索'
        : mode === 'popular' ? '常唱' : mode === 'new' ? '最新'
          : this.libraryLetter ? `拼音 ${this.libraryLetter}` : '拼音';
      $('#libraryOrder').value = mode;
      $('#libraryOrder').disabled = !!query.text;
      const indexed = !query.text && mode === 'all';
      $('#remoteAlphabet').hidden = !indexed;
      $('#remoteAlphabetLabel').textContent = '歌名首字母 · ' + (this.libraryLetter || '全部');
      $('#remotePopularityNote').hidden = mode !== 'popular';
      $('#remotePopularityNote').textContent = mode === 'popular' ? this.popularity.note() : '';
      $('#remotePopularityNote').classList.toggle('error', mode === 'popular' && !!this.popularity.state.error);
      let jobs = mode === 'new' ? this.jobs.slice() : this.librarySearch.search(this.jobs, query);
      if (indexed) {
        OpenKLibrary.renderIndex($('#remoteIndex'), jobs, this.libraryLetter, job => this.librarySearch.initial(job));
        if (this.libraryLetter) jobs = jobs.filter(job => this.librarySearch.initial(job) === this.libraryLetter);
      }
      if (mode === 'popular') jobs = this.popularity.rank(jobs);
      $('#libraryCount').textContent = query.text || this.libraryLetter || mode === 'popular'
        ? `${jobs.length} / ${this.jobs.length} 首` : jobs.length + ' 首';
      const selection = OpenKLibrary.page(jobs, this.libraryPage);
      this.libraryPage = selection.page;
      OpenKLibrary.renderPager($('#remotePager'), selection);
      const list = $('#roomSongList');
      list.replaceChildren();
      for (const job of selection.items) {
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
        if (mode === 'popular') {
          const plays = document.createElement('small');
          plays.className = 'catalog-plays';
          plays.textContent = `播放 ${this.popularity.state.songs.get(job.id).play_count} 次`;
          info.append(plays);
        }
        const add = document.createElement('button');
        add.className = 'add-song';
        add.textContent = '+';
        add.setAttribute('aria-label', '点歌：' + title.textContent);
        add.onclick = () => this.run(add, 'add', { job_id: job.id }, '已点 · ' + title.textContent);
        row.append(art, info, add);
        list.append(row);
      }
      $('#libraryStatus').textContent = this.libraryError || (jobs.length ? ''
        : query.text ? '没有匹配的歌曲。试试歌名、歌手、全拼或首字母，也可用空格组合搜索。'
          : mode === 'popular'
            ? this.popularity.state.loading ? '正在读取我的常唱…'
              : this.popularity.state.error ? '统计暂不可用，点击上方「刷新」重试。'
                : '还没有常唱记录。正常播放后会自动累计，只点歌或拖动进度不会增加次数。'
            : this.jobs.length ? '这个字母下没有歌曲，试试其他字母或直接搜索。'
              : '曲库还没有准备好的歌曲。请在经典点歌台导入并完成处理。');
    }
    play() {
      const state = this.client?.state;
      if (!state?.current) { this.notice('先点一首歌，再开始播放。'); return; }
      if (!state.player.online) {
        if (this.account?.enabled) {
          location.assign('/?view=player');
        } else {
          this.notice('还没有播放设备。请在已配对的电视上点击播放，启用声音。');
        }
        return;
      }
      return this.run($('#remotePlay'), state.playback.playing ? 'pause' : 'play');
    }
    async run(button, action, payload = {}, success) {
      if (!this.client || button.dataset.busy) return;
      if (!this.client.state) { this.notice('正在连接房间，请稍候再操作。'); return; }
      const client = this.client;
      button.dataset.busy = 'true';
      button.disabled = true;
      try {
        await client.command(action, payload);
        if (this.client === client && success) this.notice(success);
      } catch (error) { if (this.client === client && error.status !== 499) this.notice(error.message); }
      finally {
        delete button.dataset.busy;
        button.disabled = false;
        if (this.client === client && client.state) this.render(client.state);
      }
    }
    render(state) {
      const item = state.current;
      this.credentials.name = state.name || this.credentials.name;
      this.credentials.role = state.viewer?.role || this.credentials.role;
      this.credentials.display_name = state.viewer?.name || this.credentials.display_name;
      this.saveCurrent();
      document.title = 'OpenK · ' + (state.name || '共享房间');
      $('#remoteRoom').textContent = state.name || '房间 ' + state.id;
      $('#remoteRoom').title = '房间号：' + state.id;
      if (this.account?.enabled) {
        if (state.viewer?.name) this.account.user.display_name = state.viewer.name;
        this.chipView?.update(this.account.user);
        // One person on one device: a solo room can simply play here.
        $('#soloHint').hidden = !state.solo;
        if (this.lobbyOpen) { this.renderBanner(); document.title = 'OpenK · 聚会大厅'; }
      }
      this.renderMembers(state);
      OpenKRoom.renderDevices($('#remoteDevices'), state, this.client?.presenceId);
      this.renderSettings(state);
      $('#currentSingers').textContent = item?.singers?.length
        ? '演唱 · ' + item.singers.map(member => member.name).join(' / ') : '这首歌，你可以和朋友一起唱';
      const singing = !!item?.singers?.some(member => member.id === state.viewer?.id);
      $('#singCurrent').disabled = !item || !!$('#singCurrent').dataset.busy || state.viewer?.role === 'screen';
      $('#singCurrent').textContent = singing ? '退出合唱' : '我要唱';
      $('#singCurrent').setAttribute('aria-pressed', String(singing));
      $('#remoteTitle').textContent = item?.title || '为今晚点第一首歌';
      $('#remoteArtist').textContent = item?.artist || (item ? '一起唱，就是好时光' : '点歌后，在电视上启用声音');
      const status = {
        offline: '电视未启用声音 · 请在大屏按确认键',
        ready: '电视已就绪 · 选一首喜欢的歌',
        playing: '声音正在电视播放', paused: '已暂停', buffering: '电视正在缓冲…',
        blocked: '浏览器等待确认 · 请在电视上重试声音', error: '电视音频加载失败 · 可重试或切歌',
      };
      if (this.account?.enabled) Object.assign(status, {
        offline: '还没有播放设备 · 点播放可打开本机演唱',
        ready: '播放设备已就绪', playing: '房间正在播放', buffering: '播放设备正在缓冲…',
        blocked: '请在播放设备上启用声音', error: '播放设备音频加载失败 · 请在该设备重试',
      });
      $('#playerStatus').textContent = status[state.player.status] || '等待电视连接';
      $('#playerStatus').title = $('#playerStatus').textContent;
      if (!this.seeking) {
        $('#remoteElapsed').textContent = clock(state.player.position);
        $('#seek').value = state.player.position || 0;
      }
      $('#remoteDuration').textContent = clock(item?.duration);
      $('#seek').max = item?.duration || 1;
      $('#seek').disabled = !item?.duration || !!$('#seek').dataset.busy;
      const playing = state.player.online && state.playback.playing;
      $('#remotePlay').textContent = playing ? 'Ⅱ' : '▶';
      $('#remotePlay').setAttribute('aria-label', !state.player.online && this.account?.enabled
        ? '打开本机演唱' : playing ? '暂停' : '播放');
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
    renderMembers(state) {
      const members = state.members || [];
      const online = members.filter(member => member.online).length;
      const devices = (state.devices || []).filter(device => device.online !== false).length;
      $('#memberSummary').textContent = `成员 · ${online}/${members.length} · 设备 ${devices}`;
      $('#memberSummary').title = `${online} 在线 / ${members.length} ${this.account?.enabled ? '位成员' : '个配对成员'} · ${devices} 台在线设备`;
      if (!this.nameDirty) $('#memberName').value = state.viewer?.name || '';
      const signature = JSON.stringify([members, state.viewer?.id, state.player.member_id]);
      if (signature === this.memberSignature) return;
      this.memberSignature = signature;
      $('#roomMembers').replaceChildren(...members.map(member => {
        const item = document.createElement('li');
        item.className = 'member-chip ' + (member.online ? 'online' : 'offline');
        item.dataset.memberId = member.id;
        const role = { host: '房主', controller: '点歌', screen: '电视' }[member.role] || '成员';
        item.textContent = member.name + (member.id === state.viewer?.id ? '（我）' : '')
          + ' · ' + role + (member.id === state.player.member_id ? ' · 播放中' : '')
          + (member.online ? '' : ' · 离线');
        return item;
      }));
    }
    renderSettings(state) {
      const host = state.viewer?.role === 'host';
      const account = !!this.account?.enabled;
      $('#hostControls').hidden = !host;
      if (!host) return;
      if (!this.settingsDirty) {
        $('#roomName').value = state.name || '';
        $('#roomListed').checked = !!state.discoverable;
        $('#roomScreens').checked = !!state.allow_screens;
      }
      if (!this.endConfirm) $('#endRoom').textContent = '结束房间';
      // Another device may have rotated the code: only show one that matches the room's version.
      if (account) {
        const fresh = OpenKAccount.currentInvite(this.account.user.id, state.id, state.invite_version);
        this.inviteStale = !fresh && !!this.credentials.code;
        if (this.credentials.code !== fresh) {
          this.credentials.code = fresh;
          this.inviteSignature = '';
        }
      }
      const code = this.credentials.code;
      const available = /^\d{6}$/.test(code || '');
      $('#roomInvite').hidden = !available;
      // Only a digest of the code is stored server-side, so a host can always mint a new one.
      $('#refreshInvite').hidden = $('#invitePrivacy').hidden = !account;
      $('#refreshInvite').textContent = available ? '换一个配对码' : '生成配对码';
      if (account) {
        $('#invitePrivacy').textContent = this.inviteStale && !available
          ? '另一台设备刚刚换过配对码，这里不再显示旧的。需要邀请别人时，点上面的按钮生成新的配对码。'
          : '服务器只保存配对码的摘要。换一台设备登录时，点上面的按钮生成新的配对码；旧配对码会立即失效。';
      }
      $('#inviteUnavailable').hidden = available || account;
      if (!available) {
        // Never leave a stale code (or a link carrying it) behind on this device.
        $('#inviteCode').textContent = account ? '生成后显示' : '——';
        $('#phoneInviteLink').href = $('#screenInviteLink').href = '/rooms';
        $('#inviteQR').replaceChildren();
        this.inviteSignature = '';
        return;
      }
      $('#inviteRoom').textContent = state.id;
      $('#inviteCode').textContent = code;
      $('#phoneInviteLink').href = joinURL(state.id, code);
      // An account television follows its own person, so it only needs /tv.
      $('#screenInviteLink').href = account ? '/tv' : joinURL(state.id, code, 'screen');
      $('#screenInviteLink').textContent = account ? '让我的电视播放这个房间' : '让这个屏幕播放';
      $('#screenInviteLink').hidden = !state.allow_screens;
      const signature = state.id + ':' + code;
      if (signature !== this.inviteSignature) {
        this.inviteSignature = signature;
        $('#inviteQR').replaceChildren();
        if (window.qrcode) {
          const qr = qrcode(0, 'M');
          qr.addData(joinURL(state.id, code));
          qr.make();
          $('#inviteQR').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
        } else $('#inviteQR').textContent = '使用房间号与配对码加入';
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
        const participation = document.createElement('span');
        participation.textContent = (item.requested_by ? '点歌：' + item.requested_by.name + ' · ' : '')
          + (item.singers?.length ? '演唱：' + item.singers.map(member => member.name).join(' / ') : '等待加入演唱');
        const sing = document.createElement('button');
        const joined = !!item.singers?.some(member => member.id === state.viewer?.id);
        sing.className = 'sing-song';
        sing.textContent = joined ? '退出合唱' : '一起唱';
        sing.dataset.focusKey = item.id + '-sing';
        sing.setAttribute('aria-pressed', String(joined));
        sing.setAttribute('aria-label', (joined ? '退出演唱：' : '加入演唱：') + item.title);
        sing.onclick = () => this.participate(sing, item, this.client.state);
        info.append(participation, sing);
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
      this.popularity.reset();
      this.destroyed = true;
      this.epoch++;
      this.client?.stop();
      clearTimeout(this.noticeTimer);
      clearTimeout(this.searchTimer);
      clearTimeout(this.clearTimer);
      clearTimeout(this.lobbyTimer);
      clearTimeout(this.recoverTimer);
      clearTimeout(this.endTimer);
    }
  }
  window.OpenKRemote = Remote;
  window.openkRemote = new Remote();
})();
