import { createBareServer } from "@nebula-services/bare-server-node";
import wisp from "wisp-server-node";
import express from "express";
import { createServer } from "node:http";
import { SocksProxyAgent } from "socks-proxy-agent";
const socksProxyAgent = new SocksProxyAgent("socks://localhost:40000");
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { attachChatServer, CHAT_WS_PATH } from "./static/worksheets/chatserver.js";

const publicPath = fileURLToPath(new URL("./static/", import.meta.url));
const dataPath = fileURLToPath(new URL("./static/worksheets/data/", import.meta.url));
const bare = createBareServer("/bare/", {});
const app = express();
dotenv.config();

/* ── セキュリティヘッダー ────────────────────────────────── */
// Helmet を入れずとも最低限のヘッダーを付与し、MIME スニッフィング/クリックジャッキング/
// リファラ漏洩などの一般的な攻撃面を縮小する。
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
  res.setHeader("X-XSS-Protection", "0"); // 古い XSS Auditor は無効化が推奨
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // プロキシ機能の都合上、HSTS / CSP は強制しない（UV/Bare の動作を壊さないため）
  next();
});

// JSON ペイロードを 1MB に制限し、リクエスト爆撃による DoS を抑止
app.use(express.json({ limit: "1mb" }));
// 不正な JSON や巨大ペイロード時に Express 既定のスタックトレース付き
// HTML エラーページを返さないようにする（情報漏洩防止）
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) {
    return res.status(err.status || 400).json({ error: "Invalid request body" });
  }
  next(err);
});
app.use(express.static(publicPath));
app.use("/worksheets/uv/", express.static(uvPath));
app.use("/uv/", express.static(uvPath));

/* ── 簡易レートリミッタ (PUT /worksheets/data/:filename) ── */
// 外部依存を増やさず、IP ごとのスライディングウィンドウで毎分の書き込み回数を制限する。
const _rlBucket = new Map(); // ip -> { count, resetAt }
const RL_WINDOW_MS = 60_000;
const RL_MAX = 60; // 1 分あたり 60 回まで
function rateLimit(req, res, next) {
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const now = Date.now();
  const cur = _rlBucket.get(ip);
  if (!cur || cur.resetAt < now) {
    _rlBucket.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    return next();
  }
  cur.count += 1;
  if (cur.count > RL_MAX) {
    res.setHeader("Retry-After", Math.ceil((cur.resetAt - now) / 1000));
    return res.status(429).json({ error: "Too Many Requests" });
  }
  next();
}
// バケットの肥大化防止
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rlBucket) if (v.resetAt < now) _rlBucket.delete(k);
}, 5 * 60_000).unref?.();

// ユーザーデータファイルの書き込みエンドポイント
app.put("/worksheets/data/:filename", rateLimit, async (req, res) => {
  try {
    const filename = req.params.filename;
    // ディレクトリトラバーサル対策
    // `%` を許可していると `%2e%2e` 等が二段デコードで悪用されうるため許可文字を厳格化。
    // 半角英数字 / アンダースコア / ハイフン / ドット のみ、拡張子は .json 固定。
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(filename)) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    // 先頭ドット (隠しファイル) や `..` を含むファイル名を明示的に拒否
    if (filename.startsWith(".") || filename.includes("..")) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    const filePath = resolve(join(dataPath, filename));
    // dataPath の外へのアクセスを禁止（path.resolve 後に再確認）
    const baseResolved = resolve(dataPath);
    if (
      filePath !== baseResolved &&
      !filePath.startsWith(baseResolved + (process.platform === "win32" ? "\\" : "/"))
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // 受信ボディが JSON オブジェクト/配列でない場合は拒否
    if (req.body === null || (typeof req.body !== "object")) {
      return res.status(400).json({ error: "Body must be a JSON object or array" });
    }

    // シリアライズ後サイズで再チェック（1MB）
    const serialized = JSON.stringify(req.body, null, 2);
    if (serialized.length > 1024 * 1024) {
      return res.status(413).json({ error: "Payload too large" });
    }

    await mkdir(dataPath, { recursive: true });
    await writeFile(filePath, serialized, "utf8");
    res.json({ ok: true });
  } catch (e) {
    // エラーメッセージをそのままクライアントへ返さない（情報漏洩防止）
    console.error("data write error:", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const server = createServer();

server.on("request", (req, res) => {
  if (bare.shouldRoute(req)) {
    bare.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

server.on("upgrade", (req, socket, head) => {
  // チャットWebSocketは chatserver.js が自身で upgrade を処理するため除外
  let pathname = "";
  try { pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname; } catch {}
  if (pathname === CHAT_WS_PATH) return; // chatserver.js が処理

  if (bare.shouldRoute(req)) {
    bare.routeUpgrade(req, socket, head);
  } else {
    wisp.routeRequest(req, socket, head);
  }
});

// チャット WebSocket サーバーを同じ HTTP サーバーに組み込む
attachChatServer(server);

const port = process.env.PORT || 3300;
server.on("listening", () => {
  console.log(`UP http://localhost:${port}`);
});

server.listen({
  port,
});
