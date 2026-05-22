/* ============================================================
 * youtube-edu.js
 *  - YouTube 動画再生通信のみプロキシをバイパスし、直接接続で
 *    Education 埋め込み用パラメーターを付与した iframe を生成する
 *  - 6つの edu/N.txt から動的にパラメーターを取得 (24h キャッシュ)
 *  - 取得失敗時は素の embed URL にフォールバック
 *
 *  公開 API:
 *    TC_YT_EDU.isYouTubeUrl(url)            -> boolean
 *    TC_YT_EDU.isYouTubeWatchUrl(url)       -> boolean (動画再生対象か)
 *    TC_YT_EDU.extractVideoId(url)          -> string|null
 *    TC_YT_EDU.buildEmbedUrl(videoId)       -> Promise<string>
 *    TC_YT_EDU.makeDirectPlayerHtml(videoId)-> Promise<string>  (オプション)
 *    TC_YT_EDU.refreshKeys(force=false)     -> Promise<string[]>
 * ============================================================ */
(function () {
  'use strict';

  // ---- 設定 -----------------------------------------------------
  // edu/1.txt ... edu/6.txt を順次取得する
  const KEY_BASE = 'https://raw.githubusercontent.com/wista-api-project/auto/refs/heads/main/edu/';
  const KEY_FILES = ['1.txt', '2.txt', '3.txt', '4.txt', '5.txt', '6.txt'];

  // キャッシュ寿命 (ms) - パラメーターは定期的に更新される前提
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;        // 24 時間
  // 取得失敗→次取得までの最短間隔 (ms)
  const FAIL_RETRY_MS = 5 * 60 * 1000;             // 5 分

  const STORAGE_KEY = 'tc_yt_edu_keys_v1';

  // ---- 内部状態 -------------------------------------------------
  let keysCache = null;      // string[]
  let keysFetchedAt = 0;     // epoch ms
  let lastFailAt = 0;
  let inflight = null;       // Promise を共有して重複fetch防止

  // ---- ローカル永続化 -------------------------------------------
  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.keys) || !obj.fetchedAt) return null;
      return obj;
    } catch { return null; }
  }
  function saveToStorage(keys) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        keys: keys,
        fetchedAt: Date.now()
      }));
    } catch {}
  }

  // 起動時にローカル値を読み込んでおく (オフラインでもとりあえず動く)
  (function initFromStorage() {
    const cached = loadFromStorage();
    if (cached) {
      keysCache = cached.keys;
      keysFetchedAt = cached.fetchedAt || 0;
    }
  })();

  // ---- キー取得 -------------------------------------------------
  // 1つの URL を fetch して、 ?xxx=yyy 形式の文字列に正規化して返す
  async function fetchOneKey(url) {
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      // GitHub raw への直接アクセス (プロキシ経由しない)
      // CORS は raw.githubusercontent.com が許可しているため OK
      mode: 'cors',
      credentials: 'omit'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let text = (await res.text()).trim();
    if (!text) throw new Error('empty body');
    // 多くは "?embed_config=..." を含むが、HTML エンティティ &amp; が混ざっている
    // ことがあるため正規化する
    text = text.replace(/&amp;/g, '&');
    // ファイル先頭の "?" を取り除いた素のクエリ文字列にする
    if (text[0] === '?') text = text.slice(1);
    // 前後の空白/改行を除去
    text = text.replace(/^\s+|\s+$/g, '');
    if (!text) throw new Error('empty key');
    return text;
  }

  // 全6ファイルを並列取得し、取れたものだけ採用する
  async function refreshKeysInternal() {
    const results = await Promise.allSettled(
      KEY_FILES.map(f => fetchOneKey(KEY_BASE + f))
    );
    const ok = [];
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) ok.push(r.value);
    });
    if (ok.length === 0) throw new Error('all key fetches failed');
    keysCache = ok;
    keysFetchedAt = Date.now();
    saveToStorage(ok);
    try { console.info('[YT-EDU] keys refreshed:', ok.length); } catch {}
    return ok;
  }

  async function ensureKeys(force) {
    const now = Date.now();
    const fresh = keysCache && (now - keysFetchedAt) < CACHE_TTL_MS;
    if (!force && fresh) return keysCache;

    // 直近で失敗してるなら、しばらくは既存キャッシュ(あれば)を使う
    if (!force && lastFailAt && (now - lastFailAt) < FAIL_RETRY_MS && keysCache) {
      return keysCache;
    }

    if (inflight) return inflight;
    inflight = refreshKeysInternal()
      .catch(err => {
        lastFailAt = Date.now();
        try { console.warn('[YT-EDU] key fetch failed:', err && err.message); } catch {}
        // フォールバック: 既存キャッシュがあればそれを返す。無ければ空配列。
        return keysCache && keysCache.length ? keysCache : [];
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  // ---- URL ユーティリティ ---------------------------------------
  function safeUrl(u) {
    try { return new URL(u); } catch { return null; }
  }

  function isYouTubeUrl(url) {
    const u = safeUrl(url);
    if (!u) return false;
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    return (
      h === 'youtube.com' ||
      h === 'm.youtube.com' ||
      h === 'music.youtube.com' ||
      h === 'youtube-nocookie.com' ||
      h === 'youtu.be'
    );
  }

  // 動画再生対象か (watch / embed / shorts / youtu.be 短縮)
  // ホーム/検索/チャンネル等は対象外 → 既存プロキシ通信を維持
  function isYouTubeWatchUrl(url) {
    const u = safeUrl(url);
    if (!u) return false;
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    const p = u.pathname;
    if (h === 'youtu.be') {
      // youtu.be/<id>
      return /^\/[A-Za-z0-9_-]{6,}/.test(p);
    }
    if (h === 'youtube.com' || h === 'm.youtube.com' ||
        h === 'youtube-nocookie.com' || h === 'music.youtube.com') {
      if (p === '/watch' && u.searchParams.get('v')) return true;
      if (p.startsWith('/embed/')) return true;
      if (p.startsWith('/shorts/')) return true;
      if (p.startsWith('/live/')) return true;
    }
    return false;
  }

  function extractVideoId(url) {
    const u = safeUrl(url);
    if (!u) return null;
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    const p = u.pathname;
    if (h === 'youtu.be') {
      const id = p.slice(1).split('/')[0];
      return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
    }
    if (p === '/watch') {
      const id = u.searchParams.get('v');
      return id && /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
    }
    // /embed/<id>, /shorts/<id>, /live/<id>
    const m = p.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{6,})/);
    if (m) return m[1];
    return null;
  }

  // ---- Education 用パラメーターを選択 -----------------------------
  // 6個のキーをローテーションして使う(動画ごとに分散)
  function pickKey(keys, videoId) {
    if (!keys || keys.length === 0) return null;
    // videoId から決定的に index を選ぶ → 同じ動画なら毎回同じキーで安定
    let h = 0;
    if (videoId) {
      for (let i = 0; i < videoId.length; i++) {
        h = ((h << 5) - h + videoId.charCodeAt(i)) | 0;
      }
    } else {
      h = Math.floor(Math.random() * 0xffff);
    }
    const idx = Math.abs(h) % keys.length;
    return keys[idx];
  }

  // 取得したクエリ文字列のキーを、対象 URL の searchParams にマージ
  function mergeQueryString(targetUrl, queryStr) {
    if (!queryStr) return targetUrl.toString();
    const params = new URLSearchParams(queryStr);
    params.forEach((v, k) => {
      // 既存値があれば上書きしない(再生制御用 autoplay 等を尊重)
      if (!targetUrl.searchParams.has(k)) {
        targetUrl.searchParams.set(k, v);
      }
    });
    return targetUrl.toString();
  }

  // ---- 公開: 動画 ID から直接接続用 embed URL を生成 ---------------
  async function buildEmbedUrl(videoId, opts) {
    opts = opts || {};
    if (!videoId || !/^[A-Za-z0-9_-]{6,}$/.test(videoId)) {
      throw new Error('invalid videoId');
    }
    // youtube-nocookie を優先 (Education 埋め込みの慣例)
    const base = new URL('https://www.youtube-nocookie.com/embed/' + videoId);
    // 一般的な再生用パラメーター (autoplay などは呼び出し側で上書き可)
    base.searchParams.set('autoplay', opts.autoplay ? '1' : '0');
    base.searchParams.set('rel', '0');
    base.searchParams.set('modestbranding', '1');
    base.searchParams.set('playsinline', '1');

    // Education キーを取得して付与
    try {
      const keys = await ensureKeys(false);
      const k = pickKey(keys, videoId);
      if (k) {
        return mergeQueryString(base, k);
      }
    } catch (e) {
      try { console.warn('[YT-EDU] buildEmbedUrl key error:', e && e.message); } catch {}
    }
    // フォールバック: キー無しでも再生は可能
    return base.toString();
  }

  // ---- (任意) 直接プレイヤーのフル HTML を返す ---------------------
  async function makeDirectPlayerHtml(videoId, opts) {
    const src = await buildEmbedUrl(videoId, opts);
    // sandbox を緩めて YouTube プレーヤーが動くようにする
    return (
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>YouTube</title>' +
      '<style>html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}' +
      'iframe{border:0;width:100%;height:100%;display:block}</style>' +
      '</head><body>' +
      '<iframe src="' + src.replace(/"/g, '&quot;') + '" ' +
      'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ' +
      'allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>' +
      '</body></html>'
    );
  }

  // ---- 公開エクスポート ------------------------------------------
  window.TC_YT_EDU = {
    isYouTubeUrl: isYouTubeUrl,
    isYouTubeWatchUrl: isYouTubeWatchUrl,
    extractVideoId: extractVideoId,
    buildEmbedUrl: buildEmbedUrl,
    makeDirectPlayerHtml: makeDirectPlayerHtml,
    refreshKeys: (force) => ensureKeys(!!force),
    _debugState: () => ({
      hasKeys: !!(keysCache && keysCache.length),
      keyCount: keysCache ? keysCache.length : 0,
      ageMs: keysFetchedAt ? (Date.now() - keysFetchedAt) : -1
    })
  };

  // バックグラウンドで鍵を先読み (非同期、失敗してもOK)
  try { ensureKeys(false); } catch {}
})();
