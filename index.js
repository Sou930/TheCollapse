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
app.use(express.json({ limit: "10mb" }));
app.use(express.static(publicPath));
app.use("/worksheets/uv/", express.static(uvPath));
app.use("/uv/", express.static(uvPath));

// ユーザーデータファイルの書き込みエンドポイント
app.put("/worksheets/data/:filename", async (req, res) => {
  try {
    const filename = req.params.filename;
    // ディレクトリトラバーサル対策
    if (!/^[a-zA-Z0-9%._-]+\.json$/.test(filename)) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const filePath = resolve(join(dataPath, filename));
    // dataPath の外へのアクセスを禁止
    if (!filePath.startsWith(resolve(dataPath))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await mkdir(dataPath, { recursive: true });
    await writeFile(filePath, JSON.stringify(req.body, null, 2), "utf8");
    res.json({ ok: true });
  } catch (e) {
    console.error("data write error:", e);
    res.status(500).json({ error: e.message });
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
