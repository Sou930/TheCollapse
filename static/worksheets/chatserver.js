/* ============================================================
   chatserver.js — TheCollapse チャットサーバー (ESMモジュール版)
   WebSocket + JSON永続化 + admin制限

   メインの index.js から `attachChatServer(httpServer)` で
   既存の HTTP サーバーに `path: '/chat-ws'` で組み込まれる。
   別ポートを開かないため、ホスティング環境(単一ポート)でも動作。
   ============================================================ */

import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_DIR  = path.join(__dirname, 'data', 'chat');
const DATA_FILE = path.join(DATA_DIR, 'chat-data.json');
export const CHAT_WS_PATH = '/chat-ws';

/* ── 永続化 ───────────────────────────────────────────────── */
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('[chat] data load failed, using defaults:', e.message);
  }
  return {
    rooms: [
      { id: 'general',   name: '# general',   type: 'group', emoji: '💬', members: [], messages: [] },
      { id: 'game-talk', name: '# game-talk', type: 'group', emoji: '🎮', members: [], messages: [] },
    ],
  };
}

let rooms;        // Map<roomId, room>
let saveTimer = null;

function saveData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = { rooms: [...rooms.values()].map(r => ({ ...r, members: [] })) };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[chat] save failed:', e.message);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveData, 1000);
}

/* ── 接続管理 ─────────────────────────────────────────────── */
const roomClients = new Map(); // roomId -> Set<ws>
const clientMeta  = new Map(); // ws -> { username, icon, admin, roomId }

function broadcast(wss, roomId, obj, exclude = null) {
  const clients = roomClients.get(roomId);
  if (!clients) return;
  const str = JSON.stringify(obj);
  clients.forEach(c => { if (c !== exclude && c.readyState === 1) c.send(str); });
}

function broadcastAll(wss, obj, exclude = null) {
  const str = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c !== exclude && c.readyState === 1) c.send(str); });
}

function getRoomMembers(roomId) {
  const clients = roomClients.get(roomId);
  if (!clients) return [];
  return [...clients].map(c => clientMeta.get(c)?.username).filter(Boolean);
}

function sendMemberUpdate(wss, roomId) {
  const members = getRoomMembers(roomId);
  const room = rooms.get(roomId);
  if (room) room.members = members;
  const msg = JSON.stringify({ type: 'members', roomId, members });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

/* ── HTTPサーバーへのアタッチ ─────────────────────────────── */
export function attachChatServer(httpServer) {
  // 初期化
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stored = loadData();
  rooms = new Map(stored.rooms.map(r => [r.id, { ...r, messages: (r.messages || []).slice(-100) }]));

  console.log(`[chat] ${rooms.size} ルーム読み込み済み (${DATA_FILE})`);

  // noServer モードで作成し、upgrade を自前で処理
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { return; }
    if (url.pathname !== CHAT_WS_PATH) return; // 他は素通り

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

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
      if (!meta) return;

      switch (msg.type) {
        /* 認証 */
        case 'auth':
          meta.username = String(msg.username || '').slice(0, 32);
          meta.icon     = msg.icon || null;
          meta.admin    = msg.admin === true;
          console.log(`[chat][auth] ${meta.username} admin=${meta.admin}`);
          break;

        /* ルーム参加 */
        case 'join_room': {
          const { roomId } = msg;
          if (!rooms.has(roomId)) break;

          if (meta.roomId && meta.roomId !== roomId) {
            const prev = roomClients.get(meta.roomId);
            if (prev) {
              prev.delete(ws);
              if (meta.username) {
                broadcast(wss, meta.roomId, { type: 'system', roomId: meta.roomId, text: `${meta.username} が退室しました` });
                sendMemberUpdate(wss, meta.roomId);
              }
            }
          }

          if (!roomClients.has(roomId)) roomClients.set(roomId, new Set());
          roomClients.get(roomId).add(ws);
          meta.roomId = roomId;

          if (meta.username) {
            broadcast(wss, roomId, { type: 'system', roomId, text: `${meta.username} が参加しました` }, ws);
            sendMemberUpdate(wss, roomId);
          }

          // 参加したルームのメッセージ履歴を改めて送信
          const room = rooms.get(roomId);
          if (room) {
            ws.send(JSON.stringify({
              type: 'room_history',
              roomId,
              messages: room.messages.slice(-50),
            }));
          }
          console.log(`[chat][join] ${meta.username} -> ${roomId}`);
          break;
        }

        /* メッセージ送信 */
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
            time:   time || new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
          };

          const room = rooms.get(roomId);
          room.messages.push(msgObj);
          if (room.messages.length > 100) room.messages.shift();
          scheduleSave();

          // 送信者は楽観的にローカルで既に追加済みのため除外
          broadcast(wss, roomId, msgObj, ws);
          console.log(`[chat][msg] ${msgObj.sender} -> ${roomId}: ${String(text).slice(0, 40)}`);
          break;
        }

        /* タイピング */
        case 'typing':
          if (msg.roomId && meta.username) {
            broadcast(wss, msg.roomId, { type: 'typing', roomId: msg.roomId, username: meta.username }, ws);
          }
          break;

        /* ルーム作成 (adminのみ) */
        case 'create_room': {
          if (!meta.admin) {
            ws.send(JSON.stringify({ type: 'error', text: 'チャンネル作成はadminのみ可能です。' }));
            console.warn(`[chat][room] denied: ${meta.username} (admin=false) tried to create channel`);
            break;
          }
          const { room } = msg;
          if (!room || !room.id || rooms.has(room.id)) break;
          const newRoom = { ...room, messages: [], members: [] };
          rooms.set(room.id, newRoom);
          scheduleSave();
          broadcastAll(wss, { type: 'room_created', room: newRoom });
          console.log(`[chat][room] created: ${room.name} by ${meta.username}`);
          break;
        }

        /* メッセージ削除 (自分のメッセージのみ、adminは全削除可) */
        case 'delete_message': {
          const { roomId, messageId } = msg;
          const room = rooms.get(roomId);
          if (!room) break;
          const idx = room.messages.findIndex(m => String(m.id) === String(messageId));
          if (idx === -1) break;
          const target = room.messages[idx];
          if (!meta.admin && target.sender !== meta.username) {
            ws.send(JSON.stringify({ type: 'error', text: '他人のメッセージは削除できません。' }));
            break;
          }
          room.messages.splice(idx, 1);
          scheduleSave();
          broadcast(wss, roomId, { type: 'message_deleted', roomId, messageId });
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
            broadcast(wss, meta.roomId, { type: 'system', roomId: meta.roomId, text: `${meta.username} が退室しました` });
            sendMemberUpdate(wss, meta.roomId);
          }
        }
      }
      clientMeta.delete(ws);
    });

    ws.on('error', (err) => {
      console.warn('[chat][ws error]', err.message);
    });
  });

  // 終了時に保存
  const onShutdown = () => { saveData(); };
  process.on('SIGINT',  () => { onShutdown(); process.exit(0); });
  process.on('SIGTERM', () => { onShutdown(); process.exit(0); });

  console.log(`[chat] WebSocket attached at ws path: ${CHAT_WS_PATH}`);
  return wss;
}
