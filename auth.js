// =====================================================
//  TheCollapse — Server-side Authentication Module
//  クライアント側のみで完結していた脆弱な認証を置き換える。
//  - パスワードは scrypt + ランダムソルトでハッシュ化
//  - 認証情報は静的配信ディレクトリ外の auth-data/auth.json に保存
//  - セッションは HttpOnly Cookie のランダムトークンで管理
//  - ユーザーデータファイルへのアクセスはログイン中の所有者のみ許可
// =====================================================

import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt);

// 認証情報は静的配信されないディレクトリに置く（passwordHash の外部漏洩防止）
const AUTH_DIR = resolve(join(process.cwd(), "auth-data"));
const AUTH_FILE = join(AUTH_DIR, "auth.json");

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

// ---- 認証ストア（メモリ + ファイル永続化） ----
let _users = null; // { [username]: { username, salt, hash, icon, bg, createdAt, admin } }
const _sessions = new Map(); // token -> { username, expiresAt }

async function _load() {
  if (_users) return _users;
  await mkdir(AUTH_DIR, { recursive: true });
  if (existsSync(AUTH_FILE)) {
    try {
      const raw = await readFile(AUTH_FILE, "utf8");
      const parsed = JSON.parse(raw);
      _users = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      _users = {};
    }
  } else {
    _users = {};
  }
  return _users;
}

let _saveQueue = Promise.resolve();
function _persist() {
  // 連続書き込みを直列化して破損を防ぐ
  _saveQueue = _saveQueue.then(async () => {
    await mkdir(AUTH_DIR, { recursive: true });
    await writeFile(AUTH_FILE, JSON.stringify(_users, null, 2), "utf8");
  }).catch((e) => console.error("auth persist error:", e));
  return _saveQueue;
}

async function _hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return { salt, hash: derived.toString("hex") };
}

async function _verifyPassword(password, salt, expectedHashHex) {
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(expectedHashHex, "hex");
  if (expected.length !== derived.length) return false;
  // タイミング攻撃対策の定数時間比較
  return timingSafeEqual(derived, expected);
}

function _newToken() {
  return randomBytes(32).toString("hex");
}

function _publicUser(u) {
  // クライアントに返してよい情報のみ（salt / hash は絶対に含めない）
  return {
    username: u.username,
    icon: u.icon || null,
    bg: u.bg || null,
    createdAt: u.createdAt,
    admin: !!u.admin,
  };
}

// ---- Cookie ヘルパー ----
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// HTTPS 配下では Secure 属性を付与してセッションクッキーの盗聴を防ぐ。
// 環境変数 COOKIE_SECURE=1 で明示有効化、もしくは本番(NODE_ENV=production)時に既定で付与。
const COOKIE_SECURE =
  process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production";

function _setSessionCookie(res, token) {
  const attrs = [
    `tc_session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (COOKIE_SECURE) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}
function _clearSessionCookie(res) {
  const attrs = ["tc_session=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (COOKIE_SECURE) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

// 期限切れセッションの掃除
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of _sessions) if (s.expiresAt < now) _sessions.delete(t);
}, 10 * 60 * 1000).unref?.();

// ---- 認証済みユーザーの取得（ミドルウェア相当） ----
// req は Express の Request でも生の http.IncomingMessage でもよい
// （いずれも headers.cookie を参照するため、WebSocket の upgrade 要求にも使える）。
export function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.tc_session;
  if (!token) return null;
  const s = _sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    _sessions.delete(token);
    return null;
  }
  return s.username;
}

// ===== Express ルーター登録 =====
export function attachAuthRoutes(app) {
  // 登録
  app.post("/api/auth/register", async (req, res) => {
    try {
      const { username, password, icon } = req.body || {};
      if (typeof username !== "string" || !USERNAME_RE.test(username)) {
        return res.status(400).json({ error: "ユーザー名は英数字・_・- の1〜32文字です" });
      }
      if (typeof password !== "string" || password.length < 6) {
        return res.status(400).json({ error: "パスワードは6文字以上にしてください" });
      }
      if (icon != null && (typeof icon !== "string" || icon.length > 2_000_000)) {
        return res.status(400).json({ error: "アイコン画像が不正です" });
      }
      const users = await _load();
      if (users[username]) {
        return res.status(409).json({ error: "そのユーザー名はすでに使われています" });
      }
      const { salt, hash } = await _hashPassword(password);
      users[username] = {
        username,
        salt,
        hash,
        icon: icon || null,
        bg: null,
        createdAt: Date.now(),
        admin: false,
      };
      await _persist();

      const token = _newToken();
      _sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
      _setSessionCookie(res, token);
      res.json({ ok: true, user: _publicUser(users[username]) });
    } catch (e) {
      console.error("register error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ログイン
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (typeof username !== "string" || typeof password !== "string") {
        return res.status(400).json({ error: "ユーザー名とパスワードは必須です" });
      }
      const users = await _load();
      const u = users[username];
      // ユーザー有無に関わらず scrypt を実行してユーザー列挙を防ぐ
      const ok =
        u && (await _verifyPassword(password, u.salt, u.hash));
      if (!ok) {
        // 存在しないユーザーでもダミー計算で応答時間を均す
        if (!u) await _hashPassword(password);
        return res.status(401).json({ error: "ユーザー名またはパスワードが違います" });
      }
      const token = _newToken();
      _sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
      _setSessionCookie(res, token);
      res.json({ ok: true, user: _publicUser(u) });
    } catch (e) {
      console.error("login error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // ログアウト
  app.post("/api/auth/logout", (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.tc_session) _sessions.delete(cookies.tc_session);
    _clearSessionCookie(res);
    res.json({ ok: true });
  });

  // 現在のセッション情報
  app.get("/api/auth/me", async (req, res) => {
    const username = getSessionUser(req);
    if (!username) return res.json({ user: null });
    const users = await _load();
    const u = users[username];
    if (!u) return res.json({ user: null });
    res.json({ user: _publicUser(u) });
  });

  // アカウント更新（要ログイン、本人のみ）
  app.post("/api/auth/update", async (req, res) => {
    try {
      const username = getSessionUser(req);
      if (!username) return res.status(401).json({ error: "ログインが必要です" });
      const users = await _load();
      const u = users[username];
      if (!u) return res.status(401).json({ error: "ログインが必要です" });

      const { password, icon, bg } = req.body || {};
      if (password !== undefined) {
        if (typeof password !== "string" || password.length < 6) {
          return res.status(400).json({ error: "パスワードは6文字以上にしてください" });
        }
        const { salt, hash } = await _hashPassword(password);
        u.salt = salt;
        u.hash = hash;
      }
      if (icon !== undefined) {
        if (icon != null && (typeof icon !== "string" || icon.length > 2_000_000)) {
          return res.status(400).json({ error: "アイコン画像が不正です" });
        }
        u.icon = icon || null;
      }
      if (bg !== undefined) {
        if (bg != null && typeof bg !== "string") {
          return res.status(400).json({ error: "背景が不正です" });
        }
        u.bg = bg || null;
      }
      await _persist();
      res.json({ ok: true, user: _publicUser(u) });
    } catch (e) {
      console.error("update error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  // アカウント削除（要ログイン、パスワード再確認）
  app.post("/api/auth/delete", async (req, res) => {
    try {
      const username = getSessionUser(req);
      if (!username) return res.status(401).json({ error: "ログインが必要です" });
      const { password } = req.body || {};
      const users = await _load();
      const u = users[username];
      if (!u) return res.status(401).json({ error: "ログインが必要です" });
      if (typeof password !== "string" || !(await _verifyPassword(password, u.salt, u.hash))) {
        return res.status(401).json({ error: "パスワードが違います" });
      }
      delete users[username];
      await _persist();
      // セッション破棄
      const cookies = parseCookies(req);
      if (cookies.tc_session) _sessions.delete(cookies.tc_session);
      _clearSessionCookie(res);
      // 関連データファイルも削除（best-effort）
      try {
        const dataPath = resolve(
          join(process.cwd(), "static", "worksheets", "data", `${username}.json`)
        );
        if (existsSync(dataPath)) await unlink(dataPath);
      } catch {}
      res.json({ ok: true });
    } catch (e) {
      console.error("delete error:", e);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });
}
