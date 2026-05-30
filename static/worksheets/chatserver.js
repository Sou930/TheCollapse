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
import { getSessionUser } from '../../auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_DIR  = path.join(__dirname, 'data', 'chat');
const DATA_FILE = path.join(DATA_DIR, 'chat-data.json');
export const CHAT_WS_PATH = '/chat-ws';

/* ── セキュリティ設定 ────────────────────────────────────── */
// 1 メッセージあたりの最大 WS フレームサイズ。
// auth メッセージにはアイコン(data URL, 最大 200KB ※sanitizeIcon)が含まれ得るため、
// テキスト本文の長さ制限(MAX_TEXT_LEN)とは独立して、アイコン込みでも収まるサイズにする。
// これより小さいと「Max payload size exceeded」で接続が切れ、送信できなくなる。
const MAX_WS_FRAME_BYTES = 320 * 1024;
// クライアントあたり 1 秒間の最大メッセージ数 (フラッディング対策)
const RATE_PER_SEC = 10;
// クライアントあたり 60 秒間の最大メッセージ数
const RATE_PER_MIN = 200;
// テキスト/ユーザー名の最大長
const MAX_TEXT_LEN = 2000;
const MAX_NAME_LEN = 32;
// 1 メッセージに付与できるリアクション絵文字の種類数の上限
const MAX_REACTION_KINDS = 24;
// 返信プレビュー用に保持する元メッセージ本文の最大長
const REPLY_SNIPPET_LEN = 120;
// リアクションとして許可する絵文字（サーバー側ホワイトリスト）
const ALLOWED_REACTIONS = new Set([
  '👍','👎','❤️','🔥','😂','😮','😢','🎉','👀','🙏','💯','✨','😍','🤔','👏','🚀',
]);
// admin として認められる事前共有トークン (環境変数で設定)
// 設定が無い場合、誰も admin になれない（安全側に倒す）
const ADMIN_TOKEN = process.env.CHAT_ADMIN_TOKEN || '';

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
const clientMeta  = new Map(); // ws -> { username, icon, admin, roomId, rate{...} }

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

/* ── 入力サニタイズ ──────────────────────────────────────── */
// 制御文字 (NULL, ESC, 改行を除く制御文字) を取り除き、文字列長を制限する
function sanitizeString(s, maxLen) {
  if (typeof s !== 'string') s = String(s ?? '');
  // 制御文字 (改行とタブは保持) を除去
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// アイコン: data: URL もしくは同一オリジン相対パスのみ許可
function sanitizeIcon(icon) {
  if (!icon || typeof icon !== 'string') return null;
  if (icon.length > 200_000) return null; // 200KB を超える data URL は拒否
  if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(icon)) return icon;
  if (/^\/[A-Za-z0-9._\-\/]+$/.test(icon)) return icon;
  return null;
}

// ルーム ID: 安全な文字のみ
function sanitizeRoomId(id) {
  if (typeof id !== 'string') return null;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) return null;
  return id;
}

// リアクション絵文字: ホワイトリスト照合のみ許可（任意文字列の混入を防ぐ）
function sanitizeReaction(emoji) {
  if (typeof emoji !== 'string') return null;
  return ALLOWED_REACTIONS.has(emoji) ? emoji : null;
}

/* ── レートリミッタ (WS) ────────────────────────────────── */
function checkRate(meta) {
  const now = Date.now();
  if (!meta.rate) meta.rate = { sec: { c: 0, t: now }, min: { c: 0, t: now } };
  const r = meta.rate;
  if (now - r.sec.t > 1000) { r.sec.c = 0; r.sec.t = now; }
  if (now - r.min.t > 60_000) { r.min.c = 0; r.min.t = now; }
  r.sec.c++; r.min.c++;
  return r.sec.c <= RATE_PER_SEC && r.min.c <= RATE_PER_MIN;
}

/* ── HTTPサーバーへのアタッチ ─────────────────────────────── */
export function attachChatServer(httpServer) {
  // 初期化
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stored = loadData();
  rooms = new Map(stored.rooms.map(r => [
    r.id,
    {
      ...r,
      messages: (r.messages || []).slice(-100).map(m => ({
        ...m,
        // 旧データ互換: 新フィールドが無い場合に既定値を補う
        edited:    m.edited === true,
        reactions: (m.reactions && typeof m.reactions === 'object') ? m.reactions : {},
        replyTo:   m.replyTo || null,
      })),
    },
  ]));

  console.log(`[chat] ${rooms.size} ルーム読み込み済み (${DATA_FILE})`);
  if (!ADMIN_TOKEN) {
    console.warn('[chat] CHAT_ADMIN_TOKEN 未設定: admin 機能は無効化されます');
  }

  // noServer モードで作成し、upgrade を自前で処理
  // maxPayload で巨大フレームを拒否し、メモリ枯渇 DoS を防ぐ
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME_BYTES });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { return; }
    if (url.pathname !== CHAT_WS_PATH) return; // 他は素通り

    // ── 認証: HttpOnly セッション Cookie からユーザー名を確定する ──
    // 旧実装ではクライアントが auth メッセージで任意の username を申告でき、
    // 他人へのなりすまし投稿・他人のメッセージ削除が可能だった。
    // upgrade 時点でサーバー側セッションから本人を確定し、以降この値のみを信用する。
    const sessionUser = getSessionUser(req);

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, sessionUser);
    });
  });

  wss.on('connection', (ws, _req, sessionUser = null) => {
    // username はセッションから確定した本人のみ。未ログインは null のまま。
    clientMeta.set(ws, { username: sessionUser || null, icon: null, admin: false, roomId: null, rate: null });

    // 接続時: 全ルームと最新メッセージを送信
    ws.send(JSON.stringify({
      type: 'init',
      rooms: [...rooms.values()].map(r => ({
        ...r,
        messages: r.messages.slice(-50),
      })),
    }));

    ws.on('message', (raw) => {
      // フレームサイズの二重チェック
      if (raw && raw.length > MAX_WS_FRAME_BYTES) {
        try { ws.close(1009, 'message too large'); } catch {}
        return;
      }
      const meta = clientMeta.get(ws);
      if (!meta) return;

      // レートリミット
      if (!checkRate(meta)) {
        try { ws.send(JSON.stringify({ type: 'error', text: 'レート上限に達しました。少し待ってから操作してください。' })); } catch {}
        return;
      }

      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        /* 認証 — username はセッション Cookie 由来のみ信用する */
        case 'auth': {
          // 旧仕様: クライアントが msg.username を申告するだけで任意のユーザーになりすませた。
          // 新仕様: meta.username は upgrade 時にセッションから確定済み。
          //         クライアントが送る username は一切採用しない（なりすまし防止）。
          if (!meta.username) {
            // 未ログイン接続はチャットに参加させない（読み取り専用 init は既に送信済み）。
            try { ws.send(JSON.stringify({ type: 'auth_result', admin: false, username: null, error: 'ログインが必要です' })); } catch {}
            break;
          }
          // アイコンのみクライアント申告を受け付けるが、厳格にサニタイズする。
          meta.icon  = sanitizeIcon(msg.icon);
          // admin は ADMIN_TOKEN との照合のみで付与（クライアントの admin:true 申告は無効）。
          const token = typeof msg.adminToken === 'string' ? msg.adminToken : '';
          meta.admin = !!ADMIN_TOKEN && token === ADMIN_TOKEN;
          if (msg.admin === true && !meta.admin) {
            console.warn(`[chat][auth] admin claim rejected: ${meta.username}`);
          }
          console.log(`[chat][auth] ${meta.username} admin=${meta.admin}`);
          // クライアントへ実際に付与された権限・確定ユーザー名を返す
          try { ws.send(JSON.stringify({ type: 'auth_result', admin: meta.admin, username: meta.username })); } catch {}
          break;
        }

        /* ルーム参加 */
        case 'join_room': {
          const roomId = sanitizeRoomId(msg.roomId);
          if (!roomId || !rooms.has(roomId)) break;

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
          const roomId = sanitizeRoomId(msg.roomId);
          if (!roomId || !rooms.has(roomId)) break;
          const text = sanitizeString(msg.text, MAX_TEXT_LEN);
          if (!text) break;
          // 認証済みクライアントのみ送信可
          if (!meta.username) {
            try { ws.send(JSON.stringify({ type: 'error', text: '認証が必要です。' })); } catch {}
            break;
          }
          // 参加していないルームへの投稿は拒否
          if (meta.roomId !== roomId) {
            try { ws.send(JSON.stringify({ type: 'error', text: '先にルームへ参加してください。' })); } catch {}
            break;
          }

          const room = rooms.get(roomId);

          // ── 返信(リプライ) ──────────────────────────────────
          // クライアントは replyTo に「返信先メッセージID」のみを送る。
          // 引用本文・送信者名はサーバー側で元メッセージから取得して固定化し、
          // クライアントの自己申告（なりすまし・XSS用の細工本文）を一切信用しない。
          let replyTo = null;
          if (msg.replyTo != null) {
            const targetId = String(msg.replyTo);
            const target = room.messages.find(
              m => String(m.id) === targetId && m.type !== 'system'
            );
            if (target) {
              replyTo = {
                id:      target.id,
                sender:  target.sender,
                snippet: sanitizeString(target.text || '', REPLY_SNIPPET_LEN),
              };
            }
          }

          // sender / icon / time はサーバー側で生成し、クライアントの自己申告を信用しない。
          // 旧実装ではクライアントが任意の `time` 文字列を送れ、それが innerHTML 経由で
          // クライアントへ描画されることで Stored XSS が成立しうる状態だった。
          const msgObj = {
            type:   'message',
            id:     Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            roomId,
            sender: meta.username,
            icon:   meta.icon || null,
            text,
            time:   new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
            edited: false,
            reactions: {},   // { emoji: [username, ...] }
            replyTo,         // null | { id, sender, snippet }
          };
          room.messages.push(msgObj);
          if (room.messages.length > 100) room.messages.shift();
          scheduleSave();

          // 送信者にも同じ ID で配信し、楽観 UI と整合させる
          broadcast(wss, roomId, msgObj);
          console.log(`[chat][msg] ${msgObj.sender} -> ${roomId}: ${text.slice(0, 40)}`);
          break;
        }

        /* タイピング */
        case 'typing': {
          const roomId = sanitizeRoomId(msg.roomId);
          if (roomId && meta.username && meta.roomId === roomId) {
            broadcast(wss, roomId, { type: 'typing', roomId, username: meta.username }, ws);
          }
          break;
        }

        /* ルーム作成 (adminのみ) */
        case 'create_room': {
          if (!meta.admin) {
            ws.send(JSON.stringify({ type: 'error', text: 'チャンネル作成はadminのみ可能です。' }));
            console.warn(`[chat][room] denied: ${meta.username} (admin=false) tried to create channel`);
            break;
          }
          const incoming = msg.room || {};
          const id = sanitizeRoomId(incoming.id);
          if (!id || rooms.has(id)) break;
          const newRoom = {
            id,
            name:  sanitizeString(incoming.name || `# ${id}`, 64),
            type:  incoming.type === 'dm' ? 'dm' : 'group',
            emoji: sanitizeString(incoming.emoji || '💬', 8),
            members: [],
            messages: [],
          };
          rooms.set(id, newRoom);
          scheduleSave();
          broadcastAll(wss, { type: 'room_created', room: newRoom });
          console.log(`[chat][room] created: ${newRoom.name} by ${meta.username}`);
          break;
        }

        /* メッセージ削除 (自分のメッセージのみ、adminは全削除可) */
        case 'delete_message': {
          const roomId = sanitizeRoomId(msg.roomId);
          if (!roomId) break;
          const room = rooms.get(roomId);
          if (!room) break;
          const idx = room.messages.findIndex(m => String(m.id) === String(msg.messageId));
          if (idx === -1) break;
          const target = room.messages[idx];
          if (!meta.admin && target.sender !== meta.username) {
            ws.send(JSON.stringify({ type: 'error', text: '他人のメッセージは削除できません。' }));
            break;
          }
          room.messages.splice(idx, 1);
          scheduleSave();
          broadcast(wss, roomId, { type: 'message_deleted', roomId, messageId: target.id });
          break;
        }

        /* メッセージ編集 (自分のメッセージのみ。adminも他人のメッセージは編集不可) */
        case 'edit_message': {
          const roomId = sanitizeRoomId(msg.roomId);
          if (!roomId) break;
          const room = rooms.get(roomId);
          if (!room) break;
          if (!meta.username) {
            try { ws.send(JSON.stringify({ type: 'error', text: '認証が必要です。' })); } catch {}
            break;
          }
          const idx = room.messages.findIndex(m => String(m.id) === String(msg.messageId));
          if (idx === -1) break;
          const target = room.messages[idx];
          if (target.type === 'system') break;
          // ── 本人確認: 編集は送信者本人のみ許可（admin であっても他人の発言は改変不可）──
          if (target.sender !== meta.username) {
            ws.send(JSON.stringify({ type: 'error', text: '自分のメッセージのみ編集できます。' }));
            console.warn(`[chat][edit] denied: ${meta.username} tried to edit ${target.sender}'s message`);
            break;
          }
          const newText = sanitizeString(msg.text, MAX_TEXT_LEN);
          if (!newText) {
            ws.send(JSON.stringify({ type: 'error', text: '空のメッセージには編集できません。' }));
            break;
          }
          if (newText === target.text) break; // 変化なし
          target.text   = newText;
          target.edited = true;
          // 自分のメッセージを引用している他メッセージのスニペットも更新
          for (const m of room.messages) {
            if (m.replyTo && String(m.replyTo.id) === String(target.id)) {
              m.replyTo.snippet = sanitizeString(newText, REPLY_SNIPPET_LEN);
            }
          }
          scheduleSave();
          broadcast(wss, roomId, {
            type: 'message_edited', roomId, messageId: target.id, text: newText, edited: true,
          });
          console.log(`[chat][edit] ${meta.username} edited message ${target.id} in ${roomId}`);
          break;
        }

        /* 絵文字リアクション (トグル: 付ける/外す) */
        case 'react_message': {
          const roomId = sanitizeRoomId(msg.roomId);
          if (!roomId) break;
          const room = rooms.get(roomId);
          if (!room) break;
          if (!meta.username) {
            try { ws.send(JSON.stringify({ type: 'error', text: '認証が必要です。' })); } catch {}
            break;
          }
          const emoji = sanitizeReaction(msg.emoji);
          if (!emoji) {
            ws.send(JSON.stringify({ type: 'error', text: 'そのリアクションは使用できません。' }));
            break;
          }
          const target = room.messages.find(m => String(m.id) === String(msg.messageId));
          if (!target || target.type === 'system') break;
          if (!target.reactions || typeof target.reactions !== 'object') target.reactions = {};

          const users = Array.isArray(target.reactions[emoji]) ? target.reactions[emoji] : [];
          const has = users.includes(meta.username);
          if (has) {
            // 既に付けている → 外す
            const next = users.filter(u => u !== meta.username);
            if (next.length === 0) delete target.reactions[emoji];
            else target.reactions[emoji] = next;
          } else {
            // 新規付与。種類数の上限を超える新規絵文字は拒否（DoS/肥大化対策）
            if (!(emoji in target.reactions) &&
                Object.keys(target.reactions).length >= MAX_REACTION_KINDS) {
              ws.send(JSON.stringify({ type: 'error', text: 'このメッセージのリアクション種類が上限に達しています。' }));
              break;
            }
            target.reactions[emoji] = [...users, meta.username];
          }
          scheduleSave();
          broadcast(wss, roomId, {
            type: 'reactions_updated', roomId, messageId: target.id, reactions: target.reactions,
          });
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
