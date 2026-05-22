// =====================================================
//  TheCollapse — Account Manager
//  全ページ共通で読み込む。アカウントデータは
//  worksheets/data/<username>.json へ保存する。
//  ゲスト時は localStorage にフォールバック。
// =====================================================

const TC_ACCOUNT = (() => {
  // ---- 内部状態 ----
  let _current = null; // { username, passwordHash, icon, bg, createdAt }

  // ---- ユーティリティ ----
  function _hash(str) {
    // 単純な djb2 ハッシュ（サーバー不要のクライアント専用）
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return (h >>> 0).toString(16);
  }

  function _dataPath(username) {
    // 絶対パスを使用（index.html / go.html どちらから呼ばれても正しいパスになる）
    return `/worksheets/data/${encodeURIComponent(username)}.json`;
  }

  // ---- アカウント一覧（サーバー + localStorage 二重管理） ----
  const ACCOUNTS_PATH = '/worksheets/data/account.json';

  function getAccountList() {
    try { return JSON.parse(localStorage.getItem('tc_accounts') || '[]'); } catch { return []; }
  }
  function saveAccountList(list) {
    localStorage.setItem('tc_accounts', JSON.stringify(list));
    // サーバーにも保存（URLが変わっても読める）
    fetch(ACCOUNTS_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(list, null, 2),
    }).catch(() => {});
  }

  // サーバーからアカウント一覧を取得してlocalStorageにマージする
  async function _syncAccountList() {
    try {
      const res = await fetch(ACCOUNTS_PATH, { cache: 'no-store' });
      if (!res.ok) return;
      const serverList = await res.json();
      if (!Array.isArray(serverList)) return;
      const localList = getAccountList();
      // サーバー優先でマージ（usernameをキーに）
      const merged = [...serverList];
      for (const local of localList) {
        if (!merged.find(a => a.username === local.username)) {
          merged.push(local);
        }
      }
      localStorage.setItem('tc_accounts', JSON.stringify(merged));
    } catch {}
  }

  // ---- データファイル読み書き ----
  async function _readData(username) {
    try {
      const res = await fetch(_dataPath(username), { cache: 'no-store' });
      if (!res.ok) return _defaultData(username);
      return await res.json();
    } catch { return _defaultData(username); }
  }

  function _defaultData(username) {
    return { username, history: [], bookmarks: [], tabs: [], tabCounter: 0, searchEngine: 'google', bg: null };
  }

  // 書き込み用内部ヘルパー
  async function _writeDataImmediate(username, data) {
    // まず ./data/<username>.json へのファイル書き込みを試みる
    let serverOk = false;
    try {
      const res = await fetch(_dataPath(username), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data, null, 2),
        keepalive: true, // ページ離脱時も送信完了を保証
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

  // デバウンス書き込み（500ms）。同じユーザの連続書きをまとめる
  const _pendingWrites = new Map(); // username -> { data, timer, promise, resolve }
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

  // ペンディング書き込みを即時実行（ページ離脱前）
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

  async function _getData(username) {
    // まずファイルから読み込みを試みる
    try {
      const res = await fetch(_dataPath(username), { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json && json.username) return json;
      }
    } catch {}

    // フォールバック: IndexedDB から読み込む
    const idb = await _readIDB(username);
    if (idb) return idb;

    return _defaultData(username);
  }

  // ---- UV Cookie IndexedDB ヘルパー ----
  // UVはIndexedDB ".__op" の "cookies" ストアにcookieを保存している

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
        // 既存を全クリアしてから書き込む（古いcookieで上書きを防ぐ）
        const clearReq = store.clear();
        clearReq.onsuccess = () => {
          const now = Date.now();
          for (const cookie of cookies) {
            // 期限切れのcookieはスキップ
            try {
              if (cookie.set !== undefined && cookie.set !== null) {
                // cookie.set は数値タイムスタンプ・文字列・Dateオブジェクト等を想定
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
            // JSON経由でDate→Stringに変換されたフィールドを元のDateオブジェクトに復元する
            // UVは cookie.set.getTime() を呼ぶため、必ずDateオブジェクトでなければならない
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
    // 現在ログイン中のユーザー名（null = ゲスト）
    currentUser: () => _current ? _current.username : null,
    currentAccount: () => _current,

    // アカウント作成
    async createAccount(username, password, iconDataUrl) {
      if (!username || !password) throw new Error('ユーザー名とパスワードは必須です');
      // サーバーのアカウント一覧と同期してから重複チェック・追加を行う
      // （同期しないとlocalStorageが空の場合にサーバー側の既存データが上書きされるバグを防ぐ）
      await _syncAccountList();
      const list = getAccountList();
      if (list.find(a => a.username === username)) throw new Error('そのユーザー名はすでに使われています');
      const account = {
        username,
        passwordHash: _hash(password),
        icon: iconDataUrl || null,
        bg: null,
        createdAt: Date.now(),
      };
      list.push(account);
      saveAccountList(list);
      // データ初期化（passwordHashも含めてデータファイルに保存）
      const initData = _defaultData(username);
      initData.passwordHash = account.passwordHash;
      initData.icon = account.icon || null;
      initData.createdAt = account.createdAt;
      await _writeData(username, initData);
      return account;
    },

    // ログイン
    async login(username, password) {
      // まずサーバーのアカウント一覧と同期してからログイン
      await _syncAccountList();
      let list = getAccountList();
      let account = list.find(a => a.username === username);

      // アカウントリストに見つからない場合、データファイルから直接照合する
      if (!account) {
        try {
          const res = await fetch(_dataPath(username), { cache: 'no-store' });
          if (res.ok) {
            const data = await res.json();
            if (data && data.username === username && data.passwordHash) {
              account = {
                username: data.username,
                passwordHash: data.passwordHash,
                icon: data.icon || null,
                bg: data.bg || null,
                createdAt: data.createdAt || Date.now(),
              };
              // アカウントリストにも追加して次回以降高速化
              list.push(account);
              saveAccountList(list);
            }
          }
        } catch {}
      }

      if (!account) throw new Error('ユーザーが見つかりません');
      if (account.passwordHash !== _hash(password)) throw new Error('パスワードが違います');
      _current = { ...account };
      // データファイルから searchEngine を読み込んでキャッシュ
      try {
        const d = await _getData(username);
        if (d.searchEngine) _current.engine = d.searchEngine;
      } catch {}
      localStorage.setItem('tc_active_user', username);
      return account;
    },

    // ログアウト
    logout() {
      _current = null;
      localStorage.removeItem('tc_active_user');
    },

    // セッション復元
    async restoreSession() {
      const saved = localStorage.getItem('tc_active_user');
      if (!saved) return false;
      // サーバーと同期してからアカウントを探す
      await _syncAccountList();
      let list = getAccountList();
      let account = list.find(a => a.username === saved);

      // リストになければデータファイルから復元を試みる
      if (!account) {
        try {
          const res = await fetch(_dataPath(saved), { cache: 'no-store' });
          if (res.ok) {
            const data = await res.json();
            if (data && data.username === saved) {
              account = {
                username: data.username,
                passwordHash: data.passwordHash || '',
                icon: data.icon || null,
                bg: data.bg || null,
                createdAt: data.createdAt || Date.now(),
              };
              list.push(account);
              saveAccountList(list);
            }
          }
        } catch {}
      }

      if (!account) return false;
      _current = { ...account };
      // データファイルから searchEngine を読み込んでキャッシュ
      try {
        const d = await _getData(saved);
        if (d.searchEngine) _current.engine = d.searchEngine;
      } catch {}
      return true;
    },

    // アカウント情報更新（アイコン・背景など）
    async updateAccount(fields) {
      if (!_current) return;
      const list = getAccountList();
      const idx = list.findIndex(a => a.username === _current.username);
      if (idx === -1) return;
      Object.assign(list[idx], fields);
      _current = list[idx];
      saveAccountList(list);
    },

    // アカウント削除
    async deleteAccount(username, password) {
      const list = getAccountList();
      const account = list.find(a => a.username === username);
      if (!account) throw new Error('ユーザーが見つかりません');
      if (account.passwordHash !== _hash(password)) throw new Error('パスワードが違います');
      const newList = list.filter(a => a.username !== username);
      saveAccountList(newList);
      if (_current?.username === username) {
        _current = null;
        localStorage.removeItem('tc_active_user');
      }
    },

    getAccountList,

    // ---- データ操作（ログイン状態で自動切替） ----
    async getHistory() {
      if (!_current) return GUEST.getHistory();
      const d = await _getData(_current.username);
      return d.history || [];
    },
    async saveHistory(v) {
      if (!_current) { GUEST.saveHistory(v); return; }
      const d = await _getData(_current.username);
      d.history = v;
      await _writeData(_current.username, d);
    },
    async getBookmarks() {
      if (!_current) return GUEST.getBookmarks();
      const d = await _getData(_current.username);
      return d.bookmarks || [];
    },
    async saveBookmarks(v) {
      if (!_current) { GUEST.saveBookmarks(v); return; }
      const d = await _getData(_current.username);
      d.bookmarks = v;
      await _writeData(_current.username, d);
    },
    async getTabs() {
      if (!_current) return { tabs: GUEST.getTabs(), counter: GUEST.getTabCounter() };
      const d = await _getData(_current.username);
      return { tabs: d.tabs || [], counter: d.tabCounter || 0 };
    },
    async saveTabs(tabs, counter) {
      if (!_current) { GUEST.saveTabs(tabs, counter); return; }
      const d = await _getData(_current.username);
      d.tabs = tabs;
      d.tabCounter = counter;
      await _writeData(_current.username, d);
    },
    getEngine() {
      if (!_current) return GUEST.getEngine();
      return _current.engine || 'google';
    },
    async saveEngine(v) {
      if (!_current) { GUEST.saveEngine(v); return; }
      // メモリキャッシュを更新
      _current.engine = v;
      // データファイルに searchEngine として永続化
      const d = await _getData(_current.username);
      d.searchEngine = v;
      await _writeData(_current.username, d);
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
    // UVのcookieはIndexedDB ".__op" > "cookies" ストアに入っている
    async saveCookies() {
      if (!_current) return;
      try {
        const cookies = await _readUVCookiesFromIDB();
        const d = await _getData(_current.username);
        d.uvCookies = cookies;
        await _writeData(_current.username, d);
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

    // ペンディング書き込みを即時実行（ログアウト/ページ離脱時等）
    async flush() {
      await _flushPendingWrites();
    },

    // 外部からの履歴追加（ログインユーザのファイルに直接追加）
    async appendHistoryEntry(entry) {
      if (!_current) {
        const cur = GUEST.getHistory();
        cur.unshift(entry);
        GUEST.saveHistory(cur.slice(0, 500));
        return;
      }
      const d = await _getData(_current.username);
      d.history = d.history || [];
      // 連続重複を防ぐ
      const last = d.history[0];
      if (last && last.url === entry.url && (Date.now() - last.time) < 5000) return;
      d.history.unshift(entry);
      if (d.history.length > 500) d.history = d.history.slice(0, 500);
      await _writeData(_current.username, d);
    },
  };

  // ── 自動保存 ─────────────────────────────────
  // ページ離脱時（pagehide / beforeunload）に、
  //  - 未書き込みデータをフラッシュ
  //  - UV Cookie を最終保存（アカウントに紐付）
  if (typeof window !== 'undefined') {
    const _finalSave = async () => {
      try {
        if (_current) {
          // UV Cookie を積み込む（書き込みは flush で確実に実行）
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
      // 同期 sendBeacon 相当として keepalive fetch を利用するため、最後の flush を必ず発火
      _flushPendingWrites();
    });
    // 定期的に UV Cookie をアカウントに同期（30秒ごと）
    setInterval(async () => {
      if (!_current) return;
      try {
        const cookies = await _readUVCookiesFromIDB();
        if (!cookies || cookies.length === 0) return;
        const d = await _getData(_current.username);
        d.uvCookies = cookies;
        await _writeData(_current.username, d);
      } catch {}
    }, 30000);
  }

  return API;
})();

// グローバルに公開
window.TC_ACCOUNT = TC_ACCOUNT;