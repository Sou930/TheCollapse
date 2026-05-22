/* ============================================================
   chat-server.js — TheCollapse チャットサーバー
   WebSocket + JSON永続化 + admin制限版

   起動方法:
     npm install ws
     node chat-server.js

   ポート: 3001
   データ: chat-data.json (同フォルダに自動生成)
   ============================================================ */

const { WebSocketServer } = require('ws');
const fs   = require('fs');
const path = require('path');

const PORT      = 3001;
const DATA_DIR  = path.join(__dirname, 'data', 'chat');
const DATA_FILE = path.join(DATA_DIR, 'chat-data.json');

/* ── 永続化 ─────────────────────────────────────────────────
   chat-data.json にルームとメッセージを保存します。
   ────────────────────────────────────────────────────────── */
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch(e) {
    console.warn('[data] 読み込み失敗、初期データを使用:', e.message);
  }
  return {
    rooms: [
      { id:'general',   name:'# General',   type:'group', emoji:'💬', members:[], messages:[] },
      { id:'game-talk', name:'# Game Talk',  type:'group', emoji:'🎮', members:[], messages:[] },
    ]
  };
}

function saveData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = { rooms: [...rooms.values()].map(r => ({ ...r, members:[] })) };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch(e) {
    console.warn('[data] 保存失敗:', e.message);
  }
}

// 起動時にデータ読み込み
fs.mkdirSync(DATA_DIR, { recursive: true });
const stored = loadData();
const rooms  = new Map(stored.rooms.map(r => [r.id, { ...r, messages: (r.messages || []).slice(-100) }]));

console.log(`[data] ${rooms.size} ルーム読み込み済み`);

/* ── 接続管理 ─────────────────────────────────────────────── */
const wss        = new WebSocketServer({ port: PORT });
const roomClients = new Map(); // roomId → Set<ws>
const clientMeta  = new Map(); // ws → { username, icon, admin, roomId }

/* ── ユーティリティ ─────────────────────────────────────────── */
function broadcast(roomId, obj, exclude = null) {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  const str = JSON.stringify(obj);
  clients.forEach(c => { if (c !== exclude && c.readyState === 1) c.send(str); });
}

function broadcastAll(obj, exclude = null) {
  const str = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c !== exclude && c.readyState === 1) c.send(str); });
}

function getRoomMembers(roomId) {
  const clients = roomClients.get(roomId);
  if (!clients) return [];
  return [...clients].map(c => clientMeta.get(c)?.username).filter(Boolean);
}

function sendMemberUpdate(roomId) {
  const members = getRoomMembers(roomId);
  const room = rooms.get(roomId);
  if (room) room.members = members;
  const msg = JSON.stringify({ type: 'members', roomId, members });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// 保存デバウンス（書き込みを1秒まとめる）
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveData, 1000);
}

/* ── 接続処理 ────────────────────────────────────────────── */
wss.on('connection', (ws) => {
  clientMeta.set(ws, { username: null, icon: null, admin: false, roomId: null });

  // 接続時: 全ルームと最新メッセージを送信
  ws.send(JSON.stringify({
    type: 'init',
    rooms: [...rooms.values()].map(r => ({
      ...r,
      messages: r.messages.slice(-50),
    })),
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const meta = clientMeta.get(ws);

    switch (msg.type) {

      /* ── 認証 ──────────────────────────────────────────── */
      case 'auth':
        meta.username = String(msg.username || '').slice(0, 32);
        meta.icon     = msg.icon || null;
        meta.admin    = msg.admin === true;  // TC_ACCOUNT から渡される admin フラグ
        console.log(`[auth] ${meta.username} admin=${meta.admin}`);
        break;

      /* ── ルーム参加 ────────────────────────────────────── */
      case 'join_room': {
        const { roomId } = msg;
        if (!rooms.has(roomId)) break;

        // 退室処理
        if (meta.roomId && meta.roomId !== roomId) {
          const prev = roomClients.get(meta.roomId);
          if (prev) {
            prev.delete(ws);
            if (meta.username) {
              broadcast(meta.roomId, { type:'system', roomId: meta.roomId, text:`${meta.username} が退室しました` });
              sendMemberUpdate(meta.roomId);
            }
          }
        }

        // 入室処理
        if (!roomClients.has(roomId)) roomClients.set(roomId, new Set());
        roomClients.get(roomId).add(ws);
        meta.roomId = roomId;

        if (meta.username) {
          broadcast(roomId, { type:'system', roomId, text:`${meta.username} が参加しました` }, ws);
          sendMemberUpdate(roomId);
        }
        console.log(`[join] ${meta.username} → ${roomId}`);
        break;
      }

      /* ── メッセージ送信 ────────────────────────────────── */
      case 'message': {
        const { roomId, text, sender, icon, time } = msg;
        if (!rooms.has(roomId) || !text) break;

        const msgObj = {
          type:   'message',
          id:     Date.now(),
          roomId,
          sender: String(sender || meta.username || 'Unknown').slice(0, 32),
          icon:   icon || meta.icon || null,
          text:   String(text).slice(0, 2000),
          time:   time || new Date().toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' }),
        };

        const room = rooms.get(roomId);
        room.messages.push(msgObj);
        if (room.messages.length > 100) room.messages.shift();
        scheduleSave(); // 💾 保存

        broadcast(roomId, msgObj, ws);
        console.log(`[msg] ${msgObj.sender} → ${roomId}: ${String(text).slice(0,40)}`);
        break;
      }

      /* ── タイピング ────────────────────────────────────── */
      case 'typing':
        if (msg.roomId && meta.username) {
          broadcast(msg.roomId, { type:'typing', roomId: msg.roomId, username: meta.username }, ws);
        }
        break;

      /* ── ルーム作成（adminのみ） ────────────────────────── */
      case 'create_room': {
        // ⚠️ サーバー側でもadminチェック
        if (!meta.admin) {
          ws.send(JSON.stringify({ type:'error', text:'チャンネル作成はadminのみ可能です。' }));
          console.warn(`[room] 拒否: ${meta.username} (admin=false) がチャンネル作成を試みました`);
          break;
        }
        const { room } = msg;
        if (!room || !room.id || rooms.has(room.id)) break;
        const newRoom = { ...room, messages: [], members: [] };
        rooms.set(room.id, newRoom);
        scheduleSave(); // 💾 保存
        broadcastAll({ type: 'room_created', room: newRoom });
        console.log(`[room] 作成: ${room.name} by ${meta.username}`);
        break;
      }
    }
  });

  ws.on('close', () => {
    const meta = clientMeta.get(ws);
    if (meta?.roomId) {
      const clients = roomClients.get(meta.roomId);
      if (clients) {
        clients.delete(ws);
        if (meta.username) {
          broadcast(meta.roomId, { type:'system', roomId: meta.roomId, text:`${meta.username} が退室しました` });
          sendMemberUpdate(meta.roomId);
        }
      }
    }
    clientMeta.delete(ws);
  });
});

console.log(`✅ TheCollapse チャットサーバー起動 ws://localhost:${PORT}`);
console.log(`💾 データ保存先: ${DATA_FILE}`);
console.log(`   停止: Ctrl+C`);

// 終了時に保存
process.on('SIGINT', () => { saveData(); console.log('\n[data] 保存して終了'); process.exit(0); });
process.on('SIGTERM', () => { saveData(); process.exit(0); });