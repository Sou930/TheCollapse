/* ── TheCollapse PWA Service Worker ─────────────────────────────
   このワーカーは「ホーム画面に追加」(PWA インストール) を成立させ、
   アプリシェル(トップページ)をオフラインでも開けるようにするための
   最小限のキャッシュを担当する。

   ⚠️ 重要: プロキシ用の UltraViolet サービスワーカー (/sw.js, scope:/service/)
   とは完全に別物。プロキシ通信・Bare・WebSocket・API・ユーザーデータには
   一切手を出さない。誤ってフェッチを横取りするとプロキシが壊れるため、
   下記の除外パスは厳守する。
*/

const CACHE = "thecollapse-shell-v1";

// オフラインでも開けるよう最低限キャッシュするアプリシェル
const SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon.svg",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // 取得に失敗しても install を失敗させない（個別 add で握りつぶす）
      Promise.allSettled(SHELL.map((url) => cache.add(url)))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 旧バージョンのシェルキャッシュを掃除
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("thecollapse-shell-") && k !== CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// このワーカーがフェッチを「無視すべき」パスかどうか判定する。
// プロキシ系・動的系は絶対に横取りしない。
function shouldBypass(url) {
  const p = url.pathname;
  return (
    p === "/sw.js" ||                 // UltraViolet 本体のSW
    p.startsWith("/service/") ||      // UV プロキシ (__uv$config.prefix)
    p.startsWith("/bare/") ||         // Bare サーバー
    p.startsWith("/uv/") ||           // UV アセット
    p.startsWith("/worksheets/") ||   // ブラウザUI/データ/チャット等(動的)
    p.startsWith("/api/") ||          // News / Version API
    p.startsWith("/wisp")             // wisp WebSocket 等
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // GET 以外（POST/PUT/WS upgrade 等）は素通し
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // 別オリジン or プロキシ/動的パスは一切触らない
  if (url.origin !== self.location.origin) return;
  if (shouldBypass(url)) return;

  // ナビゲーション要求（アドレスバーで .com を開く / PWA 起動）は
  // ネットワーク優先・失敗時にキャッシュのトップへフォールバック。
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 取得成功したらシェルを更新
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy)).catch(() => {});
          return res;
        })
        .catch(async () => {
          const cached = (await caches.match(req)) || (await caches.match("/index.html")) || (await caches.match("/"));
          return cached || Response.error();
        })
    );
    return;
  }

  // 静的アセット（同一オリジンの GET）は stale-while-revalidate 風に。
  // アイコン/manifest 程度を想定。失敗してもネットワークにフォールバック。
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
