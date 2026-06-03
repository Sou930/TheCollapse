// =====================================================
//  TheCollapse — Account Manager (server-auth edition)
//  全ページ共通で読み込む。
//  認証はサーバー側 (/api/auth/*) で行い、パスワードは
//  scrypt + salt でハッシュ化してサーバーが保持する。
//  セッションは HttpOnly Cookie で管理されるため、
//  クライアント側にパスワードハッシュを一切保持しない。
//  ユーザーデータは worksheets/data/<username>.json に保存し、
//  サーバーがログイン中の本人のみ読み書きを許可する。
//  ゲスト時は localStorage にフォールバック。
// =====================================================

const TC_ACCOUNT = (() => {
  // ---- 内部状態 ----
  // _current は { username, icon, bg, createdAt, admin } など公開情報のみ。
  // パスワードハッシュは保持しない。
  let _current = null;

  // ---- ユーザーデータの単一インメモリキャッシュ ----
  // 以前は saveHistory / saveTabs / saveBookmarks がそれぞれ独立に
  // _getData()（サーバー再読込）→ 一部フィールドだけ書き換え → 全体を書き戻し
  // を行っていたため、500ms のデバウンス窓内で複数の保存が走ると
  // 後勝ちで互いの変更を上書きし、履歴・タブの同期が失われていた（lost update）。
  // ここでは「読み込んだ 1 個のドキュメント」を常に共有し、各保存はその
  // 同じオブジェクトを書き換えるだけにすることで競合を解消する。
  let _docCache = null;          // 現在ログイン中ユーザーの完全なデータドキュメント
  let _docCacheUser = null;      // _docCache が属する username
  let _docLoadPromise = null;    // 読み込み中の重複リクエスト合流用

  // 他タブ/他端末からの変更を受け取るためのチャネル
  let _bc = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') _bc = new BroadcastChannel('tc_account_sync');
  } catch { _bc = null; }

  function _dataPath(username) {
    return `/worksheets/data/${encodeURIComponent(username)}.json`;
  }

  // _docCache を初期化/破棄
  function _resetDocCache(username = null) {
    _docCache = null;
    _docCacheUser = username;
    _docLoadPromise = null;
  }

  // 他タブへ「データが更新された」ことを通知（自タブの再読込は不要）
  function _broadcastChange(username) {
    try { _bc && _bc.postMessage({ type: 'data-changed', username, ts: Date.now() }); } catch {}
    // BroadcastChannel 非対応環境向けに localStorage シグナルも併用
    try { localStorage.setItem('tc_sync_ping', JSON.stringify({ username, ts: Date.now() })); } catch {}
  }

  // すべての認証/データ系 fetch は Cookie を送るため credentials:'same-origin'
  function _fetch(url, opts = {}) {
    return fetch(url, { credentials: 'same-origin', ...opts });
  }

  async function _api(path, { method = 'GET', body } = {}) {
    const res = await _fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `エラー (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  // ---- データファイル既定値 ----
  function _defaultData(username) {
    return { username, history: [], bookmarks: [], tabs: [], tabCounter: 0, searchEngine: 'google', bg: null };
  }

  // 書き込み用内部ヘルパー（本人のファイルのみ。サーバーが認可）
  async function _writeDataImmediate(username, data) {
    let serverOk = false;
    try {
      const res = await _fetch(_dataPath(username), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data, null, 2),
        keepalive: true,
      });
      if (res.ok) serverOk = true;
    } catch {}

    // IndexedDB へも常にバックアップ（オフライン対策）
    try {
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('tc_userdata', 1);
        req.onupgradeneeded = e => {
          e.target.result.createObjectStore('files', { keyPath: 'username' });
        };
        req.onsuccess = e => {
          const db = e.target.result;
          const tx = db.transaction('files', 'readwrite');
          tx.objectStore('files').put({ username, data: JSON.stringify(data) });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
        req.onerror = () => reject(req.error);
      });
    } catch {}
    return serverOk;
  }

  // デバウンス書き込み（500ms）
  const _pendingWrites = new Map();
  function _writeData(username, data, { immediate = false } = {}) {
    if (immediate) {
      const p = _pendingWrites.get(username);
      if (p) { clearTimeout(p.timer); _pendingWrites.delete(username); }
      return _writeDataImmediate(username, data);
    }
    let entry = _pendingWrites.get(username);
    if (entry) {
      entry.data = data;
      clearTimeout(entry.timer);
    } else {
      entry = { data, timer: null, promise: null, resolve: null };
      entry.promise = new Promise(r => { entry.resolve = r; });
      _pendingWrites.set(username, entry);
    }
    entry.timer = setTimeout(async () => {
      const e = _pendingWrites.get(username);
      if (!e) return;
      _pendingWrites.delete(username);
      const ok = await _writeDataImmediate(username, e.data);
      e.resolve(ok);
    }, 500);
    return entry.promise;
  }

  async function _flushPendingWrites() {
    const entries = [..._pendingWrites.entries()];
    _pendingWrites.clear();
    for (const [username, e] of entries) {
      clearTimeout(e.timer);
      const ok = await _writeDataImmediate(username, e.data);
      e.resolve(ok);
    }
  }

  async function _readIDB(username) {
    return new Promise((resolve) => {
      const req = indexedDB.open('tc_userdata', 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore('files', { keyPath: 'username' });
      };
      req.onsuccess = e => {
        const db = e.target.result;
        const tx = db.transaction('files', 'readonly');
        const get = tx.objectStore('files').get(username);
        get.onsuccess = () => {
          db.close();
          if (get.result) {
            try { resolve(JSON.parse(get.result.data)); } catch { resolve(null); }
          } else { resolve(null); }
        };
        get.onerror = () => { db.close(); resolve(null); };
      };
      req.onerror = () => resolve(null);
    });
  }

  // サーバー（本人のみ許可）→ IndexedDB → 既定値 の順でドキュメントを取得（キャッシュ無視）
  async function _fetchDataFromSource(username) {
    try {
      const res = await _fetch(_dataPath(username), { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json && json.username) return json;
      }
    } catch {}
    // フォールバック: IndexedDB
    const idb = await _readIDB(username);
    if (idb) return idb;
    return _defaultData(username);
  }

  // 単一インメモリキャッシュを介してドキュメントを返す。
  // すべての getter / setter はこの「同じオブジェクト」を共有することで、
  // フィールドごとの保存が互いを上書きする lost update を防ぐ。
  async function _getData(username) {
    // 別ユーザーに切り替わったらキャッシュを捨てる
    if (_docCacheUser !== username) _resetDocCache(username);
    if (_docCache) return _docCache;
    if (_docLoadPromise) return _docLoadPromise;
    _docLoadPromise = (async () => {
      const doc = await _fetchDataFromSource(username);
      // 取得の途中でユーザーが変わっていなければ採用
      if (_docCacheUser === username) _docCache = doc;
      _docLoadPromise = null;
      return _docCache || doc;
    })();
    return _docLoadPromise;
  }

  // 強制的にサーバーから読み直してキャッシュを更新（他タブ/他端末の変更取り込み用）。
  // 進行中の保留書き込みは先に flush して、自分の未保存変更を失わないようにする。
  async function _refreshData(username) {
    if (!username) return null;
    try { await _flushPendingWrites(); } catch {}
    const doc = await _fetchDataFromSource(username);
    if (_docCacheUser === username) _docCache = doc;
    return doc;
  }

  // キャッシュ済みドキュメントを安全に書き換えて永続化する共通ヘルパー。
  // mutator は同じ参照のオブジェクトを直接編集する。
  async function _mutate(username, mutator, opts = {}) {
    const d = await _getData(username);
    mutator(d);
    const p = _writeData(username, d, opts);
    _broadcastChange(username);
    return p;
  }

  // ---- UV Cookie IndexedDB ヘルパー ----
  function _openUVIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('__op', 1);
      req.onupgradeneeded = e => {
        const store = e.target.result.createObjectStore('cookies', { keyPath: 'id' });
        store.createIndex('path', 'path');
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function _readUVCookiesFromIDB() {
    try {
      const db = await _openUVIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('cookies', 'readonly');
        const req = tx.objectStore('cookies').getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror = () => { db.close(); reject(req.error); };
      });
    } catch {
      return [];
    }
  }

  async function _writeUVCookiesToIDB(cookies) {
    if (!cookies || cookies.length === 0) return;
    try {
      const db = await _openUVIDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('cookies', 'readwrite');
        const store = tx.objectStore('cookies');
        const clearReq = store.clear();
        clearReq.onsuccess = () => {
          const now = Date.now();
          for (const cookie of cookies) {
            try {
              if (cookie.set !== undefined && cookie.set !== null) {
                const rawSet = cookie.set;
                const setTime = (typeof rawSet === 'number')
                  ? rawSet
                  : (rawSet instanceof Date ? rawSet.getTime() : new Date(rawSet).getTime());
                if (!isNaN(setTime)) {
                  if (cookie.maxAge && (setTime + cookie.maxAge * 1000) < now) continue;
                }
              }
              if (cookie.expires) {
                const exp = (cookie.expires instanceof Date)
                  ? cookie.expires
                  : new Date(cookie.expires);
                if (!isNaN(exp.getTime()) && exp.getTime() < now) continue;
              }
            } catch { /* 解析失敗時はそのまま保存 */ }
            const cookieToStore = { ...cookie };
            if (cookieToStore.set !== undefined && cookieToStore.set !== null && !(cookieToStore.set instanceof Date)) {
              try {
                const d = new Date(cookieToStore.set);
                if (!isNaN(d.getTime())) cookieToStore.set = d;
                else delete cookieToStore.set;
              } catch { delete cookieToStore.set; }
            }
            if (cookieToStore.expires !== undefined && cookieToStore.expires !== null && !(cookieToStore.expires instanceof Date)) {
              try {
                const d = new Date(cookieToStore.expires);
                if (!isNaN(d.getTime())) cookieToStore.expires = d;
                else delete cookieToStore.expires;
              } catch { delete cookieToStore.expires; }
            }
            store.put(cookieToStore);
          }
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    } catch (e) {
      console.warn('[TC_ACCOUNT] _writeUVCookiesToIDB failed:', e);
    }
  }

  // ---- ゲストストレージ（localStorage） ----
  const GUEST = {
    getHistory:    () => { try { return JSON.parse(localStorage.getItem('tc_history') || '[]'); } catch { return []; } },
    saveHistory:   (v) => localStorage.setItem('tc_history', JSON.stringify(v)),
    getBookmarks:  () => { try { return JSON.parse(localStorage.getItem('tc_bookmarks') || '[]'); } catch { return []; } },
    saveBookmarks: (v) => localStorage.setItem('tc_bookmarks', JSON.stringify(v)),
    getTabs:       () => { try { return JSON.parse(localStorage.getItem('tc_tabs') || '[]'); } catch { return []; } },
    saveTabs:      (v, ctr) => { localStorage.setItem('tc_tabs', JSON.stringify(v)); localStorage.setItem('tc_tabCounter', ctr); },
    getTabCounter: () => parseInt(localStorage.getItem('tc_tabCounter') || '0'),
    getEngine:     () => localStorage.getItem('searchengine') || 'google',
    saveEngine:    (v) => localStorage.setItem('searchengine', v),
    getBg:         () => localStorage.getItem('tc_bg') || null,
    saveBg:        (v) => v ? localStorage.setItem('tc_bg', v) : localStorage.removeItem('tc_bg'),
  };

  // ---- 公開 API ----
  const API = {
    currentUser: () => _current ? _current.username : null,
    currentAccount: () => _current,

    // アカウント作成（サーバーで scrypt ハッシュ化・セッション発行）
    async createAccount(username, password, iconDataUrl) {
      if (!username || !password) throw new Error('ユーザー名とパスワードは必須です');
      const data = await _api('/api/auth/register', {
        method: 'POST',
        body: { username, password, icon: iconDataUrl || null },
      });
      // 登録と同時にサーバーがセッション Cookie を設定する
      _current = data.user;
      localStorage.setItem('tc_active_user', _current.username);
      // データファイル初期化（新規ユーザーのキャッシュも初期化）
      const initData = _defaultData(username);
      initData.icon = _current.icon || null;
      initData.createdAt = _current.createdAt;
      _resetDocCache(username);
      _docCache = initData;
      await _writeData(username, initData);
      return _current;
    },

    // ログイン
    async login(username, password) {
      if (!username || !password) throw new Error('ユーザー名とパスワードは必須です');
      const data = await _api('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      _current = data.user;
      // 別ユーザーの可能性があるためデータキャッシュをリセットしてから読み直す
      _resetDocCache(_current.username);
      // searchEngine をキャッシュ
      try {
        const d = await _getData(_current.username);
        if (d.searchEngine) _current.engine = d.searchEngine;
      } catch {}
      localStorage.setItem('tc_active_user', _current.username);
      return _current;
    },

    // ログアウト
    async logout() {
      // ログアウト前に未保存の変更を確実に書き出す
      try { await _flushPendingWrites(); } catch {}
      try { await _api('/api/auth/logout', { method: 'POST' }); } catch {}
      _current = null;
      _resetDocCache(null);
      localStorage.removeItem('tc_active_user');
    },

    // セッション復元（サーバーの Cookie セッションを参照）
    async restoreSession() {
      try {
        const data = await _api('/api/auth/me');
        if (data && data.user) {
          _current = data.user;
          _resetDocCache(_current.username);
          try {
            const d = await _getData(_current.username);
            if (d.searchEngine) _current.engine = d.searchEngine;
          } catch {}
          localStorage.setItem('tc_active_user', _current.username);
          return true;
        }
      } catch {}
      _current = null;
      _resetDocCache(null);
      localStorage.removeItem('tc_active_user');
      return false;
    },

    // アカウント情報更新（アイコン・背景・パスワード）。サーバーで本人確認。
    async updateAccount(fields) {
      if (!_current) return;
      const body = {};
      if ('icon' in fields) body.icon = fields.icon;
      if ('bg' in fields) body.bg = fields.bg;
      // 旧実装の passwordHash は廃止。新しいパスワードは平文をサーバーに送り
      // サーバー側で scrypt ハッシュ化する（HTTPS 前提）。
      if ('password' in fields && fields.password) body.password = fields.password;
      if (Object.keys(body).length === 0) return;
      try {
        const data = await _api('/api/auth/update', { method: 'POST', body });
        if (data && data.user) {
          const engine = _current.engine;
          _current = data.user;
          if (engine) _current.engine = engine;
        }
      } catch (e) {
        throw e;
      }
    },

    // アカウント削除（サーバーでパスワード再確認）
    async deleteAccount(username, password) {
      // username 引数は互換のために受けるが、サーバーはセッションの本人のみ削除する
      await _api('/api/auth/delete', { method: 'POST', body: { password } });
      // 削除に成功したら保留中の書き込みは破棄してキャッシュも消す
      _pendingWrites.clear();
      if (_current && _current.username === username) {
        _current = null;
        _resetDocCache(null);
        localStorage.removeItem('tc_active_user');
      }
    },

    // 旧 API 互換: アカウント一覧はクライアントに公開しない
    getAccountList() { return []; },

    // ---- データ操作（ログイン状態で自動切替） ----
    async getHistory() {
      if (!_current) return GUEST.getHistory();
      const d = await _getData(_current.username);
      return d.history || [];
    },
    async saveHistory(v) {
      if (!_current) { GUEST.saveHistory(v); return; }
      await _mutate(_current.username, d => { d.history = v; });
    },
    async getBookmarks() {
      if (!_current) return GUEST.getBookmarks();
      const d = await _getData(_current.username);
      return d.bookmarks || [];
    },
    async saveBookmarks(v) {
      if (!_current) { GUEST.saveBookmarks(v); return; }
      await _mutate(_current.username, d => { d.bookmarks = v; });
    },
    async getTabs() {
      if (!_current) return { tabs: GUEST.getTabs(), counter: GUEST.getTabCounter() };
      const d = await _getData(_current.username);
      return { tabs: d.tabs || [], counter: d.tabCounter || 0 };
    },
    async saveTabs(tabs, counter) {
      if (!_current) { GUEST.saveTabs(tabs, counter); return; }
      await _mutate(_current.username, d => { d.tabs = tabs; d.tabCounter = counter; });
    },
    getEngine() {
      if (!_current) return GUEST.getEngine();
      return _current.engine || 'google';
    },
    async saveEngine(v) {
      if (!_current) { GUEST.saveEngine(v); return; }
      _current.engine = v;
      await _mutate(_current.username, d => { d.searchEngine = v; });
    },
    getBg() {
      if (!_current) return GUEST.getBg();
      return _current.bg || null;
    },
    async saveBg(v) {
      if (!_current) { GUEST.saveBg(v); return; }
      await API.updateAccount({ bg: v });
    },

    // ---- UV Cookie 保存・復元（ログインユーザーのみ）----
    async saveCookies() {
      if (!_current) return;
      try {
        const cookies = await _readUVCookiesFromIDB();
        await _mutate(_current.username, d => { d.uvCookies = cookies; });
      } catch (e) {
        console.warn('[TC_ACCOUNT] saveCookies failed:', e);
      }
    },

    async restoreCookies() {
      if (!_current) return;
      try {
        const d = await _getData(_current.username);
        if (d.uvCookies && d.uvCookies.length > 0) {
          await _writeUVCookiesToIDB(d.uvCookies);
        }
      } catch (e) {
        console.warn('[TC_ACCOUNT] restoreCookies failed:', e);
      }
    },

    // 他タブ/他端末の変更を取り込むため、サーバーから読み直す。
    // 戻り値は最新ドキュメント（呼び出し側でキャッシュ再描画に使える）。
    async refresh() {
      if (!_current) return null;
      return _refreshData(_current.username);
    },

    // 変更通知を購読する。callback(username) が呼ばれたら呼び出し側で再読込する。
    onSyncChange(callback) {
      if (typeof callback !== 'function') return () => {};
      const handlers = [];
      if (_bc) {
        const h = (ev) => {
          const data = ev && ev.data;
          if (data && data.type === 'data-changed') callback(data.username);
        };
        _bc.addEventListener('message', h);
        handlers.push(() => _bc.removeEventListener('message', h));
      }
      if (typeof window !== 'undefined') {
        const sh = (ev) => {
          if (ev.key === 'tc_sync_ping' && ev.newValue) {
            try { callback(JSON.parse(ev.newValue).username); } catch { callback(null); }
          }
        };
        window.addEventListener('storage', sh);
        handlers.push(() => window.removeEventListener('storage', sh));
      }
      return () => { handlers.forEach(fn => fn()); };
    },

    async flush() {
      await _flushPendingWrites();
    },

    async appendHistoryEntry(entry) {
      if (!_current) {
        const cur = GUEST.getHistory();
        cur.unshift(entry);
        GUEST.saveHistory(cur.slice(0, 500));
        return;
      }
      await _mutate(_current.username, d => {
        d.history = d.history || [];
        const last = d.history[0];
        if (last && last.url === entry.url && (Date.now() - last.time) < 5000) return;
        d.history.unshift(entry);
        if (d.history.length > 500) d.history = d.history.slice(0, 500);
      });
    },
  };

  // ── 自動保存 ─────────────────────────────────
  if (typeof window !== 'undefined') {
    const _finalSave = async () => {
      try {
        if (_current) {
          try {
            const cookies = await _readUVCookiesFromIDB();
            const d = await _getData(_current.username);
            d.uvCookies = cookies;
            await _writeData(_current.username, d, { immediate: true });
          } catch {}
        }
        await _flushPendingWrites();
      } catch (e) {
        console.warn('[TC_ACCOUNT] finalSave error:', e);
      }
    };
    window.addEventListener('pagehide', _finalSave);
    window.addEventListener('beforeunload', () => {
      _flushPendingWrites();
    });
    // タブが再びアクティブになったとき、他タブ/他端末での変更をサーバーから取り込む。
    // 取り込んだら 'tc:datasync' を発火し、ページ側（go.js 等）が再描画できるようにする。
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !_current) return;
      try {
        await _refreshData(_current.username);
        window.dispatchEvent(new CustomEvent('tc:datasync', { detail: { username: _current.username } }));
      } catch {}
    });
    setInterval(async () => {
      if (!_current) return;
      try {
        const cookies = await _readUVCookiesFromIDB();
        if (!cookies || cookies.length === 0) return;
        await _mutate(_current.username, d => { d.uvCookies = cookies; });
      } catch {}
    }, 30000);

    // 他タブからの変更通知を受けたらサーバーから読み直して再描画イベントを発火。
    // （自タブの保存でも broadcast するが BroadcastChannel は送信元に届かないため
    //  自タブ二重更新は起きない。localStorage 経由のシグナルも別タブにのみ届く。）
    API.onSyncChange(async (username) => {
      if (!_current || (username && username !== _current.username)) return;
      try {
        await _refreshData(_current.username);
        window.dispatchEvent(new CustomEvent('tc:datasync', { detail: { username: _current.username } }));
      } catch {}
    });
  }

  return API;
})();

// グローバルに公開
window.TC_ACCOUNT = TC_ACCOUNT;
