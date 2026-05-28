/* ============================================================
   chat.js — TheCollapse リアルタイムチャット (Discord テーマ版)
   WebSocket + TC_ACCOUNT 連携版
   ============================================================ */

'use strict';

/* ── 設定 ────────────────────────────────────────────────── */
/* 同一HTTPサーバーに /chat-ws として組み込み済み（index.js + chatserver.js）。
   ホスティング環境でも単一ポートで動作する。 */
const WS_PATH = '/chat-ws';
const WS_URL  = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;

/* 絵文字カテゴリ */
const EMOJI_CATEGORIES = {
  'よく使う': ['😀','😂','😍','🤔','👍','❤️','🔥','💯','✨','😎','🙏','🎉'],
  '顔': ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','😗','😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','🥱','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🤑','😲','🙁','😖','😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰','😱','🥵','🥶','😳','🤪','😵','🤠','🥸','🤡','🥳','🥴','😷','🤒','🤕'],
  'ジェスチャー': ['👋','🤚','🖐','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💅','🤳'],
  'ゲーム': ['🎮','🕹','🎲','🧩','🃏','🎯','🎳','🏆','🥇','⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥊','🤺','🏊','🤸','🏋️','🚴'],
  'その他': ['💀','👻','🤖','👾','🎭','🌟','💫','⭐','🌈','🔥','💥','❄️','🌊','💎','👑','🎵','🎶','📢','🔔','💡','🔮','🎀','🎁'],
};

/* ── WebSocket 状態 ──────────────────────────────────────── */
let ws        = null;
let wsReady   = false;
let reconnectTimer = null;
let reconnectCount = 0;

/* ── アプリ状態 ──────────────────────────────────────────── */
let state = {
  activeRoomId: null,
  rooms: [],
  membersOpen: false,
  emojiOpen:   false,
  searchQuery: '',
  selfUser:    null,
  notifications: true,
};

/* ── ユーティリティ ──────────────────────────────────────── */
const $ = id => document.getElementById(id);
const now = () => new Date().toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' });
const nowFull = () => {
  const d = new Date();
  return d.toLocaleDateString('ja-JP', { month:'numeric', day:'numeric' }) + ' ' +
         d.toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' });
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* JS 文字列リテラル / HTML 属性に埋め込む ID 用の厳格なサニタイズ */
function safeId(id) {
  return String(id == null ? '' : id).replace(/[^a-zA-Z0-9._-]/g, '');
}

/* マークダウン風テキスト変換 (XSS 安全: 入力は escapeHtml 済) */
function formatText(text) {
  let t = escapeHtml(text);
  // **太字**
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // *斜体*
  t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // `コード`
  t = t.replace(/`(.+?)`/g, '<code class="code-inline">$1</code>');
  // @メンション
  t = t.replace(/@(\w+)/g, '<span class="mention-tag">@$1</span>');
  // URL リンク化 (http/https のみ、エスケープ後の文字列のため `"` 等は出現しない)
  t = t.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    // 末尾の句読点を除去
    const m = url.match(/^(.*?)([.,;:!?)]*)$/);
    const href = m ? m[1] : url;
    const tail = m ? m[2] : '';
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color:#00b0f4;text-decoration:none;">${href}</a>${tail}`;
  });
  return t;
}

function getRoom(id) { return state.rooms.find(r => r.id === id); }
function isSelf(username) { return state.selfUser && state.selfUser.username === username; }

/* ブラウザ通知 */
function notify(sender, text) {
  if (!state.notifications || document.hasFocus()) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(`${sender}`, { body: text.slice(0, 60), icon: '/favicon.ico' });
  }
}

/* ── WS 接続管理 ─────────────────────────────────────────── */
function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setWsStatus('connecting');
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    wsReady = true;
    reconnectCount = 0;
    setWsStatus('connected');
    if (state.selfUser) {
      // admin はクライアントが自己申告しても無効。adminToken をローカルに保管している場合のみサーバー側で検証される。
      const adminToken = (typeof localStorage !== 'undefined') ? (localStorage.getItem('tc_admin_token') || '') : '';
      wsSend({ type: 'auth', username: state.selfUser.username, icon: state.selfUser.icon || null, adminToken });
    }
    // アクティブルームを再参加
    if (state.activeRoomId) {
      wsSend({ type: 'join_room', roomId: state.activeRoomId });
    }
  });

  ws.addEventListener('message', e => {
    try { handleWsMessage(JSON.parse(e.data)); } catch(err) { console.error('WS parse error', err); }
  });

  ws.addEventListener('close', () => {
    wsReady = false;
    setWsStatus('error');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => setWsStatus('error'));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * 2 ** reconnectCount, 16000);
  reconnectCount++;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWS(); }, delay);
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}

/* ── WS メッセージ処理 ───────────────────────────────────── */
function handleWsMessage(msg) {
  switch (msg.type) {
    case 'init':
      state.rooms = (msg.rooms || []).map(r => ({ ...r, messages: (r.messages || []).map(normalizeMsg), unread: 0 }));
      if (state.rooms.length === 0) {
        state.rooms = [
          { id:'general',   name:'# general',   type:'group', emoji:'💬', members:[], messages:[], unread:0 },
          { id:'game-talk', name:'# game-talk',  type:'group', emoji:'🎮', members:[], messages:[], unread:0 },
        ];
      }
      render();
      break;

    case 'message': {
      const room = getRoom(msg.roomId);
      if (!room) break;
      const normalized = normalizeMsg(msg);
      room.messages.push(normalized);
      if (msg.roomId !== state.activeRoomId) {
        room.unread = (room.unread || 0) + 1;
        notify(normalized.sender, normalized.text);
      } else {
        // アクティブルームなら末尾にリアルタイム追加
        appendMessage(normalized, room);
        renderRoomList();
        return;
      }
      render();
      break;
    }

    case 'typing':
      if (msg.roomId === state.activeRoomId && !isSelf(msg.username)) {
        showTyping(msg.username);
        clearTimeout(window._typingTimer);
        window._typingTimer = setTimeout(hideTyping, 2500);
      }
      break;

    case 'members': {
      const room = getRoom(msg.roomId);
      if (room) {
        room.members = msg.members || [];
        if (msg.roomId === state.activeRoomId) { renderMembers(room); renderHeader(room); }
        renderRoomList();
        renderSidebarFooter();
      }
      break;
    }

    case 'room_created':
      if (!getRoom(msg.room.id)) {
        state.rooms.push({ ...msg.room, messages: [], unread: 0 });
        renderRoomList();
        showToast(`新しいチャンネルが作成されました: ${msg.room.name}`);
      }
      break;

    case 'error':
      showToast(msg.text || 'エラーが発生しました', 'error');
      break;

    case 'room_history': {
      const room = getRoom(msg.roomId);
      if (!room) break;
      room.messages = (msg.messages || []).map(normalizeMsg);
      if (msg.roomId === state.activeRoomId) renderMessages(room);
      break;
    }

    case 'message_deleted': {
      const room = getRoom(msg.roomId);
      if (!room) break;
      const idx = room.messages.findIndex(m => String(m.id) === String(msg.messageId));
      if (idx !== -1) {
        room.messages.splice(idx, 1);
        if (msg.roomId === state.activeRoomId) renderMessages(room);
      }
      break;
    }

    case 'system': {
      const room = getRoom(msg.roomId);
      if (!room) break;
      room.messages.push({ id: Date.now(), type:'system', text: msg.text, time: now() });
      if (msg.roomId === state.activeRoomId) renderMessages(room);
      else room.unread = (room.unread||0) + 1;
      renderRoomList();
      break;
    }
  }
}

function normalizeMsg(m) {
  return {
    id:     m.id || Date.now(),
    sender: m.sender || m.username || 'Unknown',
    icon:   m.icon || null,
    text:   m.text || '',
    time:   m.time || now(),
    timeFull: m.timeFull || nowFull(),
    own:    isSelf(m.sender || m.username),
    type:   m.type || 'message',
  };
}

/* ── ローカルフォールバック ──────────────────────────────── */
function initLocalFallback() {
  state.rooms = [
    {
      id: 'general', name: '# general', type: 'group', emoji: '💬',
      members: [state.selfUser?.username || 'You'],
      messages: [{ id:1, sender:'System', text:'サーバーに接続できません。再接続を試みています...', time:'--:--', timeFull:'--/-- --:--', own:false, type:'system' }],
      unread: 0,
    },
    { id: 'game-talk', name: '# game-talk', type: 'group', emoji: '🎮', members: [], messages: [], unread: 0 },
  ];
  render();
}

/* ── UI ステータス ───────────────────────────────────────── */
function setWsStatus(status) {
  const dot = $('ws-dot');
  const lbl = $('ws-label');
  if (!dot) return;
  dot.className = 'ws-dot ' + status;
  lbl.textContent = { connected:'オンライン', connecting:'接続中...', error:'再接続中...' }[status] || status;
}

/* ── トースト通知 ────────────────────────────────────────── */
function showToast(text, type = 'info') {
  const existing = document.querySelector('.tc-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `tc-toast tc-toast-${type}`;
  toast.style.cssText = `
    position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    background:${type==='error'?'#f23f43':'#23a55a'};color:#fff;
    padding:10px 20px;border-radius:4px;font-size:14px;font-weight:600;
    z-index:500;animation:fadeIn 0.2s ease;box-shadow:0 4px 16px rgba(0,0,0,0.4);
  `;
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

/* ── アバターHTML生成 ────────────────────────────────────── */
function makeAvatarHtml(icon, name, extraClass = '') {
  const initials = (name || '?')[0].toUpperCase();
  if (icon) return `<img src="${escapeHtml(icon)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
  return escapeHtml(initials);
}

/* ── レンダリング ─────────────────────────────────────────── */
function renderRoomList() {
  const list = $('room-list');
  if (!list) return;
  const q = state.searchQuery.toLowerCase();
  const filtered = state.rooms.filter(r =>
    r.name.toLowerCase().includes(q) ||
    (r.messages.length && r.messages[r.messages.length-1].text.toLowerCase().includes(q))
  );
  const groups = filtered.filter(r => r.type === 'group');
  const dms    = filtered.filter(r => r.type === 'dm');
  let html = '';

  if (groups.length) {
    html += `
      <div class="sidebar-section-label">
        <span>チャンネル</span>
        ${isAdmin() ? `<button onclick="TC_CHAT.newChannel()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;line-height:1;padding:0 2px;" title="チャンネルを追加">+</button>` : ''}
      </div>
      ${groups.map(renderRoomItem).join('')}`;
  }
  if (dms.length) {
    html += `<div class="sidebar-section-label"><span>ダイレクトメッセージ</span></div>${dms.map(renderRoomItem).join('')}`;
  }

  list.innerHTML = html || '<div style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center;">見つかりません</div>';
}

function renderRoomItem(room) {
  const isActive = room.id === state.activeRoomId;
  const hasUnread = room.unread > 0;

  /* チャンネルアイコン：グループはDiscordの # 風、DMはアバター */
  let avatarHtml;
  if (room.type === 'group') {
    avatarHtml = `<div class="room-avatar group" style="color:${isActive ? 'var(--text-header)' : 'inherit'}">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" opacity="${isActive ? 1 : 0.6}">
        <path d="M5.41 21L6.25 17H2.5l.36-2h3.75l1-4H4l.36-2h3.5l.84-4h2l-.84 4h4l.84-4h2l-.84 4h3.75L19.25 11H15.5l-1 4h3.75l-.36 2H14l-.84 4h-2l.84-4H8l-.84 4H5.41zM9.5 15h4l1-4h-4l-1 4z"/>
      </svg>
    </div>`;
  } else {
    const onlineDot = room.online ? '<span class="online-dot"></span>' : '';
    avatarHtml = `<div class="room-avatar dm-avatar" style="position:relative;">
      ${makeAvatarHtml(room.icon, room.name)}
      ${onlineDot}
    </div>`;
  }

  return `
    <div class="room-item${isActive ? ' active' : ''}${hasUnread ? ' unread-item' : ''}"
         onclick="TC_CHAT.openRoom('${escapeHtml(room.id)}')"
         data-tooltip="${escapeHtml(room.name)}">
      ${avatarHtml}
      <div class="room-info">
        <div class="room-name">${escapeHtml(room.name)}</div>
      </div>
      ${room.unread ? `<span class="room-badge">${room.unread > 99 ? '99+' : room.unread}</span>` : ''}
    </div>`;
}

/* メッセージ一覧全描画 */
function renderMessages(room) {
  const container = $('messages');
  if (!container || !room) return;

  let html = '';

  /* チャンネル開始バナー */
  html += `
    <div class="welcome-msg">
      <div class="welcome-icon">${room.emoji || '💬'}</div>
      <div class="welcome-title">${escapeHtml(room.name)} へようこそ！</div>
      <div class="welcome-desc">${escapeHtml(room.name)} チャンネルの最初のメッセージです。</div>
    </div>`;

  html += `<div class="date-divider">今日</div>`;

  let prevSender = null;
  let prevTime   = null;

  room.messages.forEach((msg, i) => {
    if (msg.type === 'system') {
      html += `<div class="msg-system">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        ${escapeHtml(msg.text)}
      </div>`;
      prevSender = null;
      return;
    }

    const own = isSelf(msg.sender);
    // 同一送信者が続く場合はコンパクト表示
    const isCompact = prevSender === msg.sender && msg.time === prevTime;
    prevSender = msg.sender;
    prevTime   = msg.time;

    const avatarContent = makeAvatarHtml(msg.icon, msg.sender);
    const senderClass   = own ? 'own-sender' : '';
    const avatarClass   = own ? 'own-avatar' : '';

    if (isCompact) {
      const sid = safeId(msg.id);
      html += `
        <div class="msg-group compact new-msg" id="msg-${sid}">
          <div class="msg-avatar-wrap">
            <span class="compact-time">${escapeHtml(msg.time)}</span>
          </div>
          <div class="msg-body">
            <div class="msg-bubble">${formatText(msg.text)}</div>
          </div>
          <div class="msg-actions">
            ${own ? `<button class="msg-action-btn" onclick="TC_CHAT.deleteMsg('${sid}')" title="削除" style="color:var(--dnd)">🗑</button>` : ''}
          </div>
        </div>`;
    } else {
      const sid = safeId(msg.id);
      html += `
        <div class="msg-group${own ? ' own' : ''} new-msg" id="msg-${sid}" style="margin-top:16px">
          <div class="msg-avatar-wrap">
            <div class="msg-avatar ${avatarClass}">${avatarContent}</div>
          </div>
          <div class="msg-body">
            <div class="msg-header">
              <span class="msg-sender ${senderClass}">${escapeHtml(msg.sender)}</span>
              <span class="msg-timestamp">${escapeHtml(msg.timeFull || msg.time)}</span>
            </div>
            <div class="msg-bubble">${formatText(msg.text)}</div>
          </div>
          <div class="msg-actions">
            ${own ? `<button class="msg-action-btn" onclick="TC_CHAT.deleteMsg('${sid}')" title="メッセージを削除" style="color:var(--dnd)">🗑</button>` : ''}
          </div>
        </div>`;
    }
  });

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

/* 新着メッセージだけ末尾に追加（再描画せず） */
function appendMessage(msg, room) {
  const container = $('messages');
  if (!container) return;

  if (msg.type === 'system') {
    const el = document.createElement('div');
    el.className = 'msg-system';
    el.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      ${escapeHtml(msg.text)}`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return;
  }

  const own = isSelf(msg.sender);
  const lastGroup = container.querySelector('.msg-group:last-child');
  const lastSender = lastGroup?.querySelector('.msg-sender')?.textContent;
  const isCompact  = lastSender === msg.sender;
  const avatarContent = makeAvatarHtml(msg.icon, msg.sender);
  const avatarClass   = own ? 'own-avatar' : '';

  const el = document.createElement('div');
  const sid = safeId(msg.id);
  if (isCompact) {
    el.className = 'msg-group compact new-msg';
    el.id = `msg-${sid}`;
    el.innerHTML = `
      <div class="msg-avatar-wrap">
        <span class="compact-time">${escapeHtml(msg.time)}</span>
      </div>
      <div class="msg-body">
        <div class="msg-bubble">${formatText(msg.text)}</div>
      </div>
      <div class="msg-actions">
        ${own ? `<button class="msg-action-btn" onclick="TC_CHAT.deleteMsg('${sid}')" title="削除" style="color:var(--dnd)">🗑</button>` : ''}
      </div>`;
  } else {
    el.className = `msg-group${own ? ' own' : ''} new-msg`;
    el.id = `msg-${sid}`;
    el.style.marginTop = '16px';
    el.innerHTML = `
      <div class="msg-avatar-wrap">
        <div class="msg-avatar ${avatarClass}">${avatarContent}</div>
      </div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-sender${own ? ' own-sender' : ''}">${escapeHtml(msg.sender)}</span>
          <span class="msg-timestamp">${escapeHtml(msg.timeFull || msg.time)}</span>
        </div>
        <div class="msg-bubble">${formatText(msg.text)}</div>
      </div>
      <div class="msg-actions">
        ${own ? `<button class="msg-action-btn" onclick="TC_CHAT.deleteMsg('${sid}')" title="メッセージを削除" style="color:var(--dnd)">🗑</button>` : ''}
      </div>`;
  }

  container.appendChild(el);
  // 下部に近い場合のみ自動スクロール
  const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 200;
  if (isNearBottom) container.scrollTop = container.scrollHeight;
}

function renderHeader(room) {
  if (!room) return;
  const nameEl = $('chat-header-name');
  const subEl  = $('chat-header-sub');
  const avatarEl = $('chat-header-avatar');

  if (room.type === 'group') {
    nameEl.textContent  = room.name;
    subEl.textContent   = `${room.members.length} メンバー`;
    avatarEl.innerHTML  = `<svg width="22" height="22" viewBox="0 0 24 24" fill="var(--text-muted)">
      <path d="M5.41 21L6.25 17H2.5l.36-2h3.75l1-4H4l.36-2h3.5l.84-4h2l-.84 4h4l.84-4h2l-.84 4h3.75L19.25 11H15.5l-1 4h3.75l-.36 2H14l-.84 4h-2l.84-4H8l-.84 4H5.41zM9.5 15h4l1-4h-4l-1 4z"/>
    </svg>`;
  } else {
    nameEl.textContent  = room.name;
    subEl.textContent   = room.online ? 'オンライン' : 'オフライン';
    avatarEl.textContent = room.name[0].toUpperCase();
  }

  // メンバーボタンをアクティブ表示
  const membBtn = document.querySelector('.hdr-btn[onclick*="toggleMembers"]');
  if (membBtn) membBtn.classList.toggle('active', state.membersOpen);
}

function renderMembers(room) {
  if (!room) return;
  const panel = $('members-panel');
  if (!state.membersOpen || room.type === 'dm') { panel.classList.remove('open'); return; }
  panel.classList.add('open');

  const onlineMembers  = room.members;
  const offlineMembers = []; // 将来的にオフライン情報を受け取れるようにする用

  let html = `<div class="members-title">オンライン — ${onlineMembers.length}</div>`;
  html += onlineMembers.map(m => {
    const isMe = isSelf(m);
    return `<div class="member-item">
      <div class="member-avatar" style="${isMe ? 'background:linear-gradient(135deg,#23a55a,#06c4d9)' : ''}">
        ${m[0].toUpperCase()}
        <span class="online-dot" style="border-color:var(--sidebar-bg)"></span>
      </div>
      <div class="member-name">${escapeHtml(m)}${isMe ? ' <span style="font-size:11px;color:var(--text-muted)">(自分)</span>' : ''}</div>
    </div>`;
  }).join('');

  panel.innerHTML = html;
}

function renderSidebarFooter() {
  const footer = $('sidebar-footer');
  if (!footer || !state.selfUser) return;
  const u = state.selfUser;
  const avatarContent = u.icon ? `<img src="${escapeHtml(u.icon)}" alt="">` : escapeHtml((u.username || '?').slice(0,2).toUpperCase());
  footer.innerHTML = `
    <div class="self-avatar">${avatarContent}</div>
    <div class="self-info">
      <div class="self-name">${escapeHtml(u.username)}</div>
      <div class="self-status">オンライン</div>
    </div>
    <div class="self-actions">
      <button class="self-action-btn" onclick="TC_CHAT.toggleNotifications()" id="notif-btn" title="通知">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      </button>
    </div>`;
}

function render() {
  renderRoomList();
  const room = getRoom(state.activeRoomId);
  if (room) {
    $('empty-chat').style.display = 'none';
    $('chat-main').style.display  = 'flex';
    renderHeader(room); renderMessages(room); renderMembers(room);
  } else {
    $('empty-chat').style.display = 'flex';
    $('chat-main').style.display  = 'none';
  }
  renderSidebarFooter();
}

/* ── アクション ──────────────────────────────────────────── */
function openRoom(id) {
  state.activeRoomId = id;
  const room = getRoom(id);
  if (room) room.unread = 0;
  wsSend({ type: 'join_room', roomId: id });
  render();
  adjustTextarea();
  setTimeout(() => { $('msg-input')?.focus(); }, 50);
}

let typingDebounce = null;
let isTypingSent   = false;

function sendMessage() {
  const ta = $('msg-input');
  const text = ta.value.trim();
  if (!text || !state.activeRoomId) return;
  const room = getRoom(state.activeRoomId);
  if (!room) return;

  const msgObj = {
    id: Date.now(),
    sender: state.selfUser?.username || 'You',
    icon:   state.selfUser?.icon || null,
    text,
    time:     now(),
    timeFull: nowFull(),
    own: true,
    type: 'message',
  };
  room.messages.push(msgObj);
  appendMessage(msgObj, room);
  renderRoomList();

  wsSend({
    type:   'message',
    roomId: state.activeRoomId,
    text,
    sender:   state.selfUser?.username || 'You',
    icon:     state.selfUser?.icon || null,
    time:     msgObj.time,
    timeFull: msgObj.timeFull,
  });
  ta.value = '';
  adjustTextarea();
}

function showTyping(sender) {
  const el = $('typing-indicator');
  if (!el) return;
  el.innerHTML = `
    <div class="typing-dots"><span></span><span></span><span></span></div>
    <span>${escapeHtml(sender)} が入力中…</span>`;
}
function hideTyping() { const el = $('typing-indicator'); if (el) el.innerHTML = ''; }

function toggleMembers() {
  const room = getRoom(state.activeRoomId);
  if (!room || room.type === 'dm') return;
  state.membersOpen = !state.membersOpen;
  renderMembers(room);
  renderHeader(room);
}

function toggleEmoji() {
  state.emojiOpen = !state.emojiOpen;
  $('emoji-picker').classList.toggle('open', state.emojiOpen);
}

function insertEmoji(e) {
  const ta = $('msg-input');
  const pos = ta.selectionStart;
  const val = ta.value;
  ta.value = val.slice(0, pos) + e + val.slice(pos);
  ta.setSelectionRange(pos + e.length, pos + e.length);
  ta.focus();
  state.emojiOpen = false;
  $('emoji-picker').classList.remove('open');
  adjustTextarea();
}

function adjustTextarea() {
  const ta = $('msg-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  $('send-btn').disabled = !ta.value.trim();
}

function onInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    isTypingSent = false;
  } else {
    if (!isTypingSent) {
      isTypingSent = true;
      if (state.activeRoomId) wsSend({ type: 'typing', roomId: state.activeRoomId });
      setTimeout(() => { isTypingSent = false; }, 3000);
    }
  }
}

function onSearch(val) { state.searchQuery = val; renderRoomList(); }

function isAdmin() {
  return !!(state.selfUser && state.selfUser.admin === true);
}

function newChannel() {
  if (!isAdmin()) {
    showToast('チャンネルの作成はadminのみ可能です。', 'error');
    return;
  }
  const name = prompt('チャンネル名を入力してください:');
  if (!name || !name.trim()) return;
  const id = 'ch-' + Date.now();
  const room = {
    id, type: 'group', emoji: '💬',
    name: name.trim().toLowerCase().replace(/\s+/g, '-'),
    members: [state.selfUser?.username || 'You'],
    unread: 0, messages: [],
  };
  wsSend({ type: 'create_room', room });
  if (!getRoom(id)) state.rooms.push(room);
  render();
  openRoom(id);
}

/* メッセージ削除 */
function deleteMsg(msgId) {
  const room = getRoom(state.activeRoomId);
  if (!room) return;
  const idx = room.messages.findIndex(m => String(m.id) === String(msgId));
  if (idx === -1) return;
  const msg = room.messages[idx];
  const admin = state.selfUser && state.selfUser.admin === true;
  if (!isSelf(msg.sender) && !admin) return;
  // サーバーに削除を通知（サーバーが全員にブロードキャスト）
  wsSend({ type: 'delete_message', roomId: state.activeRoomId, messageId: msgId });
  // 楽観的にローカルでも削除
  room.messages.splice(idx, 1);
  const el = document.getElementById(`msg-${msgId}`);
  if (el) el.remove();
  renderRoomList();
}

/* 通知トグル */
function toggleNotifications() {
  state.notifications = !state.notifications;
  const btn = $('notif-btn');
  if (btn) btn.style.color = state.notifications ? '' : 'var(--dnd)';
  if (state.notifications && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  showToast(state.notifications ? '通知をオンにしました' : '通知をオフにしました', 'info');
}

/* ── 絵文字ピッカー構築 ──────────────────────────────────── */
function buildEmojiPicker() {
  const picker = $('emoji-picker');
  if (!picker) return;
  let html = '';
  for (const [cat, emojis] of Object.entries(EMOJI_CATEGORIES)) {
    html += `<div class="emoji-category">${cat}</div>`;
    html += emojis.map(e => `<button class="emoji-btn" onclick="TC_CHAT.insertEmoji('${e}')">${e}</button>`).join('');
  }
  picker.innerHTML = html;
}

/* ── 入力欄プレースホルダー動的更新 ─────────────────────── */
function updatePlaceholder() {
  const ta  = $('msg-input');
  const room = getRoom(state.activeRoomId);
  if (ta && room) ta.placeholder = `${room.name} へメッセージを送る`;
  else if (ta)     ta.placeholder = 'メッセージを入力…';
}

/* ── 初期化 ──────────────────────────────────────────────── */
function init() {
  if (typeof TC_ACCOUNT !== 'undefined') state.selfUser = TC_ACCOUNT.currentAccount();

  const loginGate = $('login-gate');
  const chatApp   = $('chat-app');

  if (!state.selfUser) {
    if (loginGate) loginGate.style.display = 'flex';
    if (chatApp)   chatApp.style.display   = 'none';
    return;
  }

  if (loginGate) loginGate.style.display = 'none';
  if (chatApp)   chatApp.style.display   = 'block';

  buildEmojiPicker();

  /* 外クリックで絵文字ピッカーを閉じる */
  document.addEventListener('click', e => {
    if (state.emojiOpen && !e.target.closest('#emoji-picker') && !e.target.closest('.emoji-toggle')) {
      state.emojiOpen = false;
      const p = $('emoji-picker');
      if (p) p.classList.remove('open');
    }
  });

  /* キーボードショートカット */
  document.addEventListener('keydown', e => {
    // Escape でモーダル/ピッカーを閉じる
    if (e.key === 'Escape') {
      if (state.emojiOpen) { state.emojiOpen = false; $('emoji-picker')?.classList.remove('open'); }
      if (state.membersOpen) { toggleMembers(); }
    }
    // Ctrl+K で検索フォーカス
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      $('room-search')?.focus();
    }
  });

  renderSidebarFooter();
  connectWS();

  // 通知許可リクエスト
  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => Notification.requestPermission(), 2000);
  }

  // 3秒後もルームが空ならローカルフォールバック
  setTimeout(() => { if (state.rooms.length === 0) initLocalFallback(); }, 3000);
}

window.TC_CHAT = {
  openRoom, sendMessage, toggleMembers, toggleEmoji, insertEmoji,
  adjustTextarea, onInputKey, onSearch, newChannel, deleteMsg,
  toggleNotifications,
  onAccountChange: () => { init(); },
};

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof TC_ACCOUNT !== 'undefined' && typeof TC_ACCOUNT.restoreSession === 'function') {
    try { await TC_ACCOUNT.restoreSession(); } catch(e) { console.warn('restoreSession error', e); }
  }
  init();
});