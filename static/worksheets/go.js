// ======= 状態 =======
let tabs = [];       // { id, title, url, favicon, isNew }
let activeTabId = null;
let tabCounter = 0;

const ENGINES = {
  google:     q => 'https://google.com/search?q='+encodeURIComponent(q),
  bing:       q => 'https://bing.com/search?q='+encodeURIComponent(q),
  duckduckgo: q => 'https://duckduckgo.com/?q='+encodeURIComponent(q),
  yahoo:      q => 'https://search.yahoo.co.jp/search?p='+encodeURIComponent(q),
  brave:      q => 'https://search.brave.com/search?q='+encodeURIComponent(q),
};
const ENGINE_ICONS = {
  google: `<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M44.5 20H24v8.5h11.8C34.2 33.3 29.6 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.7 1.1 7.8 2.9l6-6C34.3 6.5 29.4 4.5 24 4.5 12.7 4.5 3.5 13.7 3.5 25S12.7 45.5 24 45.5c11 0 20-8 20-20.5 0-1.4-.1-2.7-.5-5z"/><path fill="#34A853" d="M6.3 15.7l7 5.1C15.1 17.2 19.2 14 24 14c3 0 5.7 1.1 7.8 2.9l6-6C34.3 6.5 29.4 4.5 24 4.5c-7.6 0-14.2 4.4-17.7 11.2z"/><path fill="#FBBC05" d="M24 45.5c5.3 0 10.1-1.8 13.8-4.8l-6.4-5.4C29.4 37.1 26.8 38 24 38c-5.5 0-10.2-3.6-11.9-8.6l-7 5.4C8.5 41.4 15.6 45.5 24 45.5z"/><path fill="#EA4335" d="M44.5 20H24v8.5h11.8c-.8 2.2-2.3 4.1-4.3 5.4l6.4 5.4C41.7 36.2 44.5 31 44.5 25c0-1.4-.1-2.7-.5-5z"/></svg>`,
  bing: `<svg width="18" height="18" viewBox="0 0 24 24" fill="#0078D4"><path d="M5 2l4 1.4v13.8l4.6-2.6L9 12.4 13 6l6 8-7.5 4.3L5 20V2z"/></svg>`,
  duckduckgo: `<svg width="18" height="18" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#DE5833"/><circle cx="50" cy="42" r="22" fill="white"/><circle cx="58" cy="36" r="5" fill="#333"/><circle cx="60" cy="35" r="2" fill="white"/><path d="M35 65 Q50 80 65 65" stroke="#333" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
  yahoo: `<svg width="18" height="18" viewBox="0 0 48 48"><rect width="48" height="48" rx="8" fill="#720E9E"/><text x="7" y="36" font-family="Arial Black,sans-serif" font-weight="900" font-size="32" fill="white">Y!</text></svg>`,
  brave: `<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#FB542B" d="M21.5 8.3l-.9-2.1-1.5 1-1.2-3.2L16.2 5 15 2 12 3.2 9 2 7.8 5 6.1 4 4.9 7.2l-1.5-1-.9 2.1.9.8-.4 1.5.9.3v1.6l1 .4.4 1.6 1.1.1.7 1.4 1.1-.2 1 1.2 1-.5 1 .5 1-1.2 1.1.2.7-1.4 1.1-.1.4-1.6 1-.4v-1.6l.9-.3-.4-1.5.9-.8zM12 17.5l-3-1.8-.7-2 .5-2 1.5-1.2H12h1.7l1.5 1.2.5 2-.7 2-3 1.8z"/></svg>`,
};
let currentEngine = localStorage.getItem('searchengine') || 'google';

// ======= ローディングオーバーレイ =======
function _showLoading(label) {
  const overlay = document.getElementById('tc-loading-overlay');
  const lbl = document.getElementById('tc-loading-label');
  if (overlay) overlay.style.display = 'flex';
  if (lbl && label) lbl.textContent = label;
}
function _hideLoading() {
  const overlay = document.getElementById('tc-loading-overlay');
  if (!overlay) return;
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.display = 'none'; }, 300);
}

// ======= 初期化 =======
window.addEventListener('DOMContentLoaded', async () => {
  _showLoading('読み込み中...');

  // アカウント復元
  if (typeof TC_ACCOUNT !== 'undefined') {
    _showLoading('アカウントを復元しています...');
    await TC_ACCOUNT.restoreSession();
    currentEngine = TC_ACCOUNT.getEngine();
    renderGoAccountUI();
    // ログイン中ならUV cookieをサーバーから復元
    if (TC_ACCOUNT.currentUser()) {
      _showLoading('セッションを復元しています...');
      await TC_ACCOUNT.restoreCookies();
    }
  }

  // セッションから最初のURL取得
  const initialURL = sessionStorage.getItem('uvURL');
  sessionStorage.removeItem('uvURL');

  // 保存されたタブを復元、なければ新規
  _showLoading('タブを復元しています...');
  await loadTabsFromStorage();

  if (initialURL) {
    const fullURL = '/service/' + initialURL;
    // sessionStorage 経由の URL は __uv$config.encodeUrl 済みなので復号して
    // YouTube 動画再生 URL なら直接接続経路に流す。
    let decodedInitial = null;
    try {
      if (typeof __uv$config !== 'undefined' && __uv$config.decodeUrl) {
        decodedInitial = __uv$config.decodeUrl(initialURL);
      }
    } catch {}

    if (decodedInitial &&
        typeof TC_YT_EDU !== 'undefined' &&
        TC_YT_EDU.isYouTubeWatchUrl(decodedInitial)) {
      const vid = TC_YT_EDU.extractVideoId(decodedInitial);
      if (vid) {
        // 空タブを作って、直接再生にスイッチ
        const newId = createTab(null, true);
        setTimeout(() => {
          try { navigateTabYouTubeDirect(newId, decodedInitial, vid); } catch (e) {
            try { console.warn('[YT-EDU] init direct play error:', e && e.message); } catch {}
            // 失敗したら通常のプロキシ経路で開く
            try {
              const t = tabs.find(x => x.id === newId);
              if (t) { t.url = fullURL; t.displayUrl = decodedInitial; }
              setActiveTab(newId);
            } catch {}
          }
        }, 30);
      } else {
        createTab(fullURL, false);
      }
    } else {
      // 既存タブがあれば新しいタブを追加、なければ最初のタブをそのURLに
      if (tabs.length === 0) {
        createTab(fullURL, false);
      } else {
        createTab(fullURL, false);
      }
    }
  } else if (tabs.length === 0) {
    createTab(null, false); // ニュータブ
  } else {
    // 最後のアクティブタブを表示
    const lastActive = tabs[tabs.length - 1];
    setActiveTab(lastActive.id);
  }

  _hideLoading();

  renderBookmarkBtn();
  document.addEventListener('click', e => {
    if (!document.getElementById('bookmark-panel').contains(e.target) &&
        !document.getElementById('bookmark-btn').contains(e.target)) {
      document.getElementById('bookmark-panel').classList.remove('open');
    }
    if (!document.getElementById('more-options-panel').contains(e.target) &&
        !document.getElementById('more-options-btn').contains(e.target)) {
      document.getElementById('more-options-panel').classList.remove('open');
    }
    if (!document.getElementById('history-panel').contains(e.target) &&
        !document.getElementById('history-btn').contains(e.target)) {
      document.getElementById('history-panel').classList.remove('open');
    }
  });

  // goAboutBlank() で開いた新ウィンドウのiframeナビゲートを履歴に記録
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'tc_nav' && e.data.src) {
      const decoded = decodeProxyUrl(e.data.src);
      const url = decoded || e.data.src;
      const title = e.data.title || url;
      addHistoryEntry({ title, url, favicon: '' });
    }
  });

  // ページを離れる前にUV cookieをサーバーへ保存
  window.addEventListener('beforeunload', () => {
    if (typeof TC_ACCOUNT !== 'undefined' && TC_ACCOUNT.currentUser()) {
      TC_ACCOUNT.saveCookies();
    }
  });
});

// ======= タブ管理 =======
function createTab(url, switchTo = true) {
  const id = ++tabCounter;
  const tab = { id, title: url ? 'Loading...' : 'New Tab', url: url || null, favicon: null, isNew: !url };
  tabs.push(tab);
  saveTabsToStorage();
  renderTabs();
  renderTabContent(tab);
  if (switchTo || tabs.length === 1) setActiveTab(id);
  return id;
}

function setActiveTab(id) {
  activeTabId = id;
  // タブUI更新
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', parseInt(t.dataset.id) === id);
  });
  // コンテンツ切替
  document.querySelectorAll('.tab-content').forEach(c => {
    c.classList.toggle('active', parseInt(c.dataset.id) === id);
  });
  const tab = tabs.find(t => t.id === id);
  if (tab) {
    document.getElementById('address-input').value = tab.isNew ? '' : (tab.displayUrl || tab.url || '');
    updateNavButtons();
    renderBookmarkBtn();
    // Elementsパネルが開いていたら更新
    if (document.getElementById('elements-panel')?.classList.contains('open')) {
      setTimeout(_elemInspectActive, 100);
    }
  }
}

function closeTab(id, e) {
  e && e.stopPropagation();
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  tabs.splice(idx, 1);
  // DOM削除
  document.querySelector(`.tab[data-id="${id}"]`)?.remove();
  document.querySelector(`.tab-content[data-id="${id}"]`)?.remove();
  saveTabsToStorage();
  if (tabs.length === 0) {
    createTab(null, false);
    return;
  }
  if (activeTabId === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    setActiveTab(next.id);
  }
}

function newTab() {
  createTab(null, true);
}

function renderTabs() {
  const bar = document.getElementById('tab-bar');
  // 既存タブ要素削除（newTabボタン以外）
  bar.querySelectorAll('.tab').forEach(t => t.remove());
  const newBtn = document.getElementById('new-tab-btn');
  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    el.dataset.id = tab.id;
    el.onclick = () => setActiveTab(tab.id);
    el.innerHTML = `
      ${tab.favicon ? `<img class="tab-favicon" src="${tab.favicon}" onerror="this.style.display='none'">` : `<svg class="tab-favicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#8892a4"><circle cx="12" cy="12" r="10"/></svg>`}
      <span class="tab-title">${escHtml(tab.title)}</span>
      <span class="tab-close" onclick="closeTab(${tab.id}, event)">✕</span>
    `;
    bar.insertBefore(el, newBtn);
  });
}

function renderTabContent(tab) {
  const area = document.getElementById('content-area');
  const div = document.createElement('div');
  div.className = 'tab-content' + (tab.id === activeTabId ? ' active' : '');
  div.dataset.id = tab.id;

  if (tab.isNew || !tab.url) {
    div.innerHTML = buildNewTabHTML(tab.id);
    area.appendChild(div);
    // エンジン初期化
    setTimeout(() => initNewTabEngine(tab.id), 0);
  } else {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;flex:1;overflow:hidden;display:flex;flex-direction:column;';
    const overlay = document.createElement('div');
    overlay.id = 'elem-highlight-overlay';
    overlay.style.display = 'none';
    overlay.style.position = 'absolute';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '50';
    overlay.style.outline = '2px solid #5b8fff';
    overlay.style.outlineOffset = '0px';
    overlay.style.boxShadow = '0 0 0 4px rgba(91,143,255,0.18), inset 0 0 0 9999px rgba(91,143,255,0.06)';
    overlay.style.borderRadius = '2px';
    overlay.style.transition = 'top .08s,left .08s,width .08s,height .08s';
    const iframe = document.createElement('iframe');
    iframe.className = 'browser-frame';
    iframe.src = tab.url;
    iframe.id = 'frame-' + tab.id;
    iframe.onload = () => {
      onFrameLoad(tab.id, iframe);
      // Elementsパネルが開いていたら再インスペクト
      if (document.getElementById('elements-panel').classList.contains('open') && tab.id === activeTabId) {
        setTimeout(_elemInspectActive, 100);
      }
    };
    wrapper.appendChild(overlay);
    wrapper.appendChild(iframe);
    div.appendChild(wrapper);
    area.appendChild(div);
  }
}

function onFrameLoad(tabId, iframe) {
  try {
    // iframeのURLを取得して表示URL更新
    const src = iframe.src;
    const decoded = decodeProxyUrl(src);
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      tab.url = src;
      tab.displayUrl = decoded;
      tab.isNew = false;
      // タイトル更新を試みる
      try {
        const title = iframe.contentDocument?.title;
        if (title) { tab.title = title; }
        else { tab.title = decoded || 'Page'; }
      } catch { tab.title = decoded || 'Page'; }
      // ファビコン
      try {
        const u = new URL(decoded);
        tab.favicon = 'https://www.google.com/s2/favicons?domain=' + u.hostname + '&sz=32';
      } catch {}
      saveTabsToStorage();
      renderTabs();
      if (tabId === activeTabId) {
        document.getElementById('address-input').value = decoded || src;
        updateNavButtons();
        renderBookmarkBtn();
      }
      // ログ
      addLog(`ページ読み込み完了: ${(decoded || src).slice(0, 60)}`, 'ok');
      setLogStatus('idle', 'Ready');
      // 履歴に追記
      addHistoryEntry({ title: tab.title, url: decoded || src, favicon: tab.favicon || '' });
    }
  } catch(e) {}
}

function decodeProxyUrl(src) {
  if (!src) return '';
  try {
    if (src.includes('/service/') && typeof __uv$config !== 'undefined') {
      const encoded = src.split('/service/')[1];
      return __uv$config.decodeUrl ? __uv$config.decodeUrl(encoded) : encoded;
    }
  } catch {}
  return src;
}

// ======= ニュータブHTML =======
function buildNewTabHTML(tabId) {
  return `
  <div class="newtab-page" id="nt-${tabId}">
    <div class="nt-logo">
      <div class="nt-logo-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      </div>
      <span class="nt-logo-text">TheCollapse</span>
    </div>

    <div class="nt-search-wrapper" id="nt-sw-${tabId}">
      <button class="nt-engine-btn" id="nt-eb-${tabId}" onclick="ntToggleEngine(${tabId}, event)">
        <span id="nt-ei-${tabId}"></span>
      </button>
      <div class="engine-menu" id="nt-em-${tabId}">
        <div class="engine-opt" id="nt-eo-google-${tabId}" onclick="ntSetEngine('google', ${tabId})">
          ${ENGINE_ICONS.google} Google <div class="engine-dot"></div>
        </div>
        <div class="engine-opt" id="nt-eo-bing-${tabId}" onclick="ntSetEngine('bing', ${tabId})">
          ${ENGINE_ICONS.bing} Bing <div class="engine-dot"></div>
        </div>
        <div class="engine-opt" id="nt-eo-duckduckgo-${tabId}" onclick="ntSetEngine('duckduckgo', ${tabId})">
          ${ENGINE_ICONS.duckduckgo} DuckDuckGo <div class="engine-dot"></div>
        </div>
        <div class="engine-opt" id="nt-eo-yahoo-${tabId}" onclick="ntSetEngine('yahoo', ${tabId})">
          ${ENGINE_ICONS.yahoo} Yahoo! Japan <div class="engine-dot"></div>
        </div>
        <div class="engine-opt" id="nt-eo-brave-${tabId}" onclick="ntSetEngine('brave', ${tabId})">
          ${ENGINE_ICONS.brave} Brave <div class="engine-dot"></div>
        </div>
      </div>
      <form onsubmit="ntSearch(event, ${tabId})">
        <input type="text" class="nt-search-input" id="nt-si-${tabId}" placeholder="Search or type URL" autocomplete="off">
      </form>
      <button class="nt-search-submit" onclick="ntSearch(event, ${tabId})">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
    </div>

    <div class="nt-shortcuts">
      <a class="nt-shortcut" href="#" onclick="ntGoTo('https://google.com', ${tabId}, event)">
        <div class="nt-shortcut-icon"><img src="https://www.google.com/s2/favicons?domain=google.com&sz=32" alt="Google"></div>
        <span class="nt-shortcut-label">Google</span>
      </a>
      <a class="nt-shortcut" href="#" onclick="ntGoTo('https://youtube.com', ${tabId}, event)">
        <div class="nt-shortcut-icon"><img src="https://www.google.com/s2/favicons?domain=youtube.com&sz=32" alt="YouTube"></div>
        <span class="nt-shortcut-label">YouTube</span>
      </a>
      <a class="nt-shortcut" href="#" onclick="ntGoTo('https://discord.com', ${tabId}, event)">
        <div class="nt-shortcut-icon"><img src="https://www.google.com/s2/favicons?domain=discord.com&sz=32" alt="Discord"></div>
        <span class="nt-shortcut-label">Discord</span>
      </a>
      <a class="nt-shortcut" href="#" onclick="ntGoTo('https://github.com', ${tabId}, event)">
        <div class="nt-shortcut-icon"><img src="https://www.google.com/s2/favicons?domain=github.com&sz=32" alt="GitHub"></div>
        <span class="nt-shortcut-label">GitHub</span>
      </a>
    </div>
  </div>`;
}

function initNewTabEngine(tabId) {
  ntApplyEngine(currentEngine, tabId, false);
}

function ntApplyEngine(e, tabId, save = true) {
  currentEngine = e;
  if (save) {
    localStorage.setItem('searchengine', e);
    if (typeof TC_ACCOUNT !== 'undefined') TC_ACCOUNT.saveEngine(e);
  }
  const icon = document.getElementById('nt-ei-' + tabId);
  const inp  = document.getElementById('nt-si-' + tabId);
  if (icon) icon.innerHTML = ENGINE_ICONS[e] || ENGINE_ICONS.google;
  if (inp)  inp.placeholder = `Search ${e.charAt(0).toUpperCase()+e.slice(1)} or type URL`;
  document.querySelectorAll(`[id^="nt-eo-"]`).forEach(el => {
    if (el.id.endsWith('-' + tabId)) el.classList.remove('selected');
  });
  const opt = document.getElementById(`nt-eo-${e}-${tabId}`);
  if (opt) opt.classList.add('selected');
}

function ntToggleEngine(tabId, e) {
  e.stopPropagation();
  document.getElementById('nt-em-' + tabId)?.classList.toggle('open');
}

function ntSetEngine(e, tabId) {
  ntApplyEngine(e, tabId);
  document.getElementById('nt-em-' + tabId)?.classList.remove('open');
}

function ntSearch(e, tabId) {
  e.preventDefault();
  const q = document.getElementById('nt-si-' + tabId)?.value.trim();
  if (!q) return;
  navigateTab(tabId, q);
}

function ntGoTo(url, tabId, e) {
  e.preventDefault();
  navigateTab(tabId, url);
}

// ======= ナビゲーション =======
function navigateTab(tabId, query) {
  let url = '';
  try {
    const u = new URL(query);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') u.protocol = 'https:';
    url = u.toString();
  } catch {
    url = /^[a-z]+\.[a-z]{2,}$/i.test(query) ? 'https://' + query : ENGINES[currentEngine](query);
  }

  // ★ YouTube の「動画再生通信」だけはプロキシをバイパスして直接接続する
  //    (Education 用パラメーターを付与した embed iframe を使用)
  //    検索 / ホーム / チャンネル等の通常通信は既存プロキシを維持する。
  try {
    if (typeof TC_YT_EDU !== 'undefined' &&
        TC_YT_EDU.isYouTubeWatchUrl(url)) {
      const vid = TC_YT_EDU.extractVideoId(url);
      if (vid) {
        navigateTabYouTubeDirect(tabId, url, vid);
        return;
      }
    }
  } catch (e) {
    try { console.warn('[YT-EDU] direct play check failed:', e && e.message); } catch {}
  }

  if (typeof __uv$config === 'undefined') { return; }
  window.navigator.serviceWorker.register('/sw.js', { scope: __uv$config.prefix })
    .then(() => {
      const encoded = __uv$config.encodeUrl(url);
      const proxyUrl = '/service/' + encoded;
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return;
      const content = document.querySelector(`.tab-content[data-id="${tabId}"]`);
      if (!content) return;
      // ニュータブページを置換してiframeに
      content.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.className = 'browser-frame';
      iframe.src = proxyUrl;
      iframe.id = 'frame-' + tabId;
      iframe.onload = () => onFrameLoad(tabId, iframe);
      content.appendChild(iframe);
      tab.url = proxyUrl;
      tab.displayUrl = url;
      tab.isNew = false;
      tab.title = 'Loading...';
      document.getElementById('address-input').value = url;
      saveTabsToStorage();
      renderTabs();
      addLog(`ナビゲート: ${url.slice(0, 60)}`, 'info');
      setLogStatus('active', 'Loading...');
    }).catch(err => console.error(err));
}

// ===== YouTube 動画再生用: プロキシをバイパスして直接接続でロード =====
// 仕様:
//  - youtube.com/watch, youtu.be, /embed, /shorts, /live を対象
//  - edu/N.txt から取得した embed_config 等のパラメーターを付与
//  - キー取得失敗時もフォールバックで再生継続(素の embed)
function navigateTabYouTubeDirect(tabId, originalUrl, videoId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;
  const content = document.querySelector(`.tab-content[data-id="${tabId}"]`);
  if (!content) return;

  // タブ表示の更新
  tab.displayUrl = originalUrl;
  tab.url = originalUrl;
  tab.isNew = false;
  tab.title = 'YouTube (Direct)';
  try { tab.favicon = 'https://www.google.com/s2/favicons?domain=youtube.com&sz=32'; } catch {}
  const addrEl = document.getElementById('address-input');
  if (addrEl) addrEl.value = originalUrl;
  saveTabsToStorage();
  renderTabs();
  addLog(`YouTube 直接再生: ${originalUrl.slice(0, 60)}`, 'info');
  setLogStatus('active', 'Loading (direct)...');

  // 既存内容を iframe に置換
  content.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.className = 'browser-frame';
  iframe.id = 'frame-' + tabId;
  iframe.setAttribute('allow',
    'accelerometer; autoplay; clipboard-write; encrypted-media; ' +
    'gyroscope; picture-in-picture; web-share');
  iframe.setAttribute('allowfullscreen', '');
  iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  iframe.onload = () => {
    setLogStatus('idle', 'Ready');
    addLog('YouTube 直接再生: 読み込み完了', 'ok');
    // 履歴に記録(タイトルは取れない可能性が高いので URL のみ)
    try {
      addHistoryEntry({
        title: 'YouTube - ' + (videoId || ''),
        url: originalUrl,
        favicon: 'https://www.google.com/s2/favicons?domain=youtube.com&sz=32'
      });
    } catch {}
  };
  iframe.onerror = () => {
    addLog('YouTube 直接再生: 読み込み失敗 → プロキシにフォールバック', 'warn');
    fallbackToProxy(tabId, originalUrl);
  };
  content.appendChild(iframe);

  // Education キーを取得して URL を組み立て (非同期)
  TC_YT_EDU.buildEmbedUrl(videoId, { autoplay: false })
    .then(src => { iframe.src = src; })
    .catch(err => {
      try { console.warn('[YT-EDU] buildEmbedUrl error:', err && err.message); } catch {}
      // 最後のフォールバック: 素の embed
      iframe.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(videoId);
    });
}

// プロキシ経由ロードへのフォールバック
function fallbackToProxy(tabId, url) {
  if (typeof __uv$config === 'undefined') return;
  window.navigator.serviceWorker.register('/sw.js', { scope: __uv$config.prefix })
    .then(() => {
      const encoded = __uv$config.encodeUrl(url);
      const proxyUrl = '/service/' + encoded;
      const tab = tabs.find(t => t.id === tabId);
      if (!tab) return;
      const content = document.querySelector(`.tab-content[data-id="${tabId}"]`);
      if (!content) return;
      content.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.className = 'browser-frame';
      iframe.src = proxyUrl;
      iframe.id = 'frame-' + tabId;
      iframe.onload = () => onFrameLoad(tabId, iframe);
      content.appendChild(iframe);
      tab.url = proxyUrl;
      tab.displayUrl = url;
    }).catch(err => console.error(err));
}

function onAddressKey(e) {
  if (e.key === 'Enter') {
    const q = e.target.value.trim();
    if (!q || !activeTabId) return;
    navigateTab(activeTabId, q);
  }
}

function goBack() {
  const iframe = document.getElementById('frame-' + activeTabId);
  if (iframe) try { iframe.contentWindow.history.back(); } catch {}
}
function goForward() {
  const iframe = document.getElementById('frame-' + activeTabId);
  if (iframe) try { iframe.contentWindow.history.forward(); } catch {}
}
function reloadTab() {
  const iframe = document.getElementById('frame-' + activeTabId);
  if (iframe) try { iframe.contentWindow.location.reload(); } catch { iframe.src = iframe.src; }
}
function goHome() {
  location.href = '../index.html';
}
function updateNavButtons() {
  const tab = tabs.find(t => t.id === activeTabId);
  document.getElementById('back-btn').disabled = !tab || tab.isNew;
  document.getElementById('forward-btn').disabled = !tab || tab.isNew;
}

// ======= ブックマーク =======
function getBookmarks() {
  if (typeof TC_ACCOUNT !== 'undefined' && TC_ACCOUNT.currentUser()) {
    // 同期的に返せないため、キャッシュを利用
    return window._bmCache || [];
  }
  try { return JSON.parse(localStorage.getItem('tc_bookmarks') || '[]'); } catch { return []; }
}
async function _syncBookmarks() {
  if (typeof TC_ACCOUNT !== 'undefined') {
    window._bmCache = await TC_ACCOUNT.getBookmarks();
  }
}
function saveBookmarks(bms) {
  if (typeof TC_ACCOUNT !== 'undefined') {
    window._bmCache = bms;
    TC_ACCOUNT.saveBookmarks(bms);
  } else {
    localStorage.setItem('tc_bookmarks', JSON.stringify(bms));
  }
}

function addBookmark() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.isNew) return;
  const bms = getBookmarks();
  const url = tab.displayUrl || tab.url || '';
  if (bms.find(b => b.url === url)) return;
  bms.push({ title: tab.title || url, url, favicon: tab.favicon || '' });
  saveBookmarks(bms);
  renderBookmarkBtn();
}

function removeBookmark(url) {
  const bms = getBookmarks().filter(b => b.url !== url);
  saveBookmarks(bms);
  renderBookmarkList();
  renderBookmarkBtn();
}

function renderBookmarkBtn() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.isNew) return;
  const bms = getBookmarks();
  const url = tab.displayUrl || tab.url || '';
  const btn = document.getElementById('add-bookmark-btn');
  const isBookmarked = bms.some(b => b.url === url);
  btn.style.color = isBookmarked ? '#f0c040' : '';
}

function toggleBookmarkPanel() {
  const panel = document.getElementById('bookmark-panel');
  const open = panel.classList.toggle('open');
  if (open) renderBookmarkList();
}

function renderBookmarkList() {
  const bms = getBookmarks();
  const list = document.getElementById('bookmark-list');
  if (bms.length === 0) {
    list.innerHTML = '<div class="bm-empty">ブックマークがありません</div>';
    return;
  }
  list.innerHTML = bms.map(b => `
    <div class="bm-item" onclick="openBookmark('${escHtml(b.url)}')">
      ${b.favicon ? `<img src="${escHtml(b.favicon)}" onerror="this.style.display='none'">` : ''}
      <span class="bm-item-title">${escHtml(b.title || b.url)}</span>
      <button class="bm-item-del" onclick="event.stopPropagation();removeBookmark('${escHtml(b.url)}')">✕</button>
    </div>
  `).join('');
}

function openBookmark(url) {
  document.getElementById('bookmark-panel').classList.remove('open');
  if (activeTabId) {
    navigateTab(activeTabId, url);
  } else {
    const id = createTab(null, true);
    setTimeout(() => navigateTab(id, url), 50);
  }
}

// ======= 履歴 =======
const HISTORY_MAX = 500;

function getHistory() {
  if (typeof TC_ACCOUNT !== 'undefined') return window._histCache || [];
  try { return JSON.parse(localStorage.getItem('tc_history') || '[]'); } catch { return []; }
}
async function _syncHistory() {
  if (typeof TC_ACCOUNT !== 'undefined') {
    window._histCache = await TC_ACCOUNT.getHistory();
    // history-tracker.js が外部ページから localStorage に書いたエントリをマージ
    try {
      const local = JSON.parse(localStorage.getItem('tc_history') || '[]');
      if (local.length > 0) {
        const merged = [...local, ...(window._histCache || [])];
        const seen = new Set();
        window._histCache = merged
          .filter(h => { const k = h.time + '|' + h.url; if (seen.has(k)) return false; seen.add(k); return true; })
          .sort((a, b) => b.time - a.time)
          .slice(0, HISTORY_MAX);
        localStorage.removeItem('tc_history');
        TC_ACCOUNT.saveHistory(window._histCache);
      }
    } catch {}
  }
}
function saveHistory(hist) {
  if (typeof TC_ACCOUNT !== 'undefined') {
    window._histCache = hist;
    TC_ACCOUNT.saveHistory(hist);
  } else {
    localStorage.setItem('tc_history', JSON.stringify(hist));
  }
}

function addHistoryEntry({ title, url, favicon }) {
  if (!url) return;
  let hist = getHistory();
  // 同じURLでも毎回の訪問を記録（Chrome/Edgeと同じ挙動）
  // ただし直前の項目と完全に同じURL・かつ5秒以内のリロード等は除外
  const last = hist[0];
  if (last && last.url === url && (Date.now() - last.time) < 5000) return;
  hist.unshift({ title: title || url, url, favicon: favicon || '', time: Date.now() });
  if (hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
  saveHistory(hist);
}

function clearHistory() {
  if (!confirm('すべての履歴を削除しますか？')) return;
  window._histCache = [];
  if (typeof TC_ACCOUNT !== 'undefined') {
    TC_ACCOUNT.saveHistory([]);
  } else {
    localStorage.removeItem('tc_history');
  }
  renderHistoryList();
}

function toggleHistoryPanel() {
  const panel = document.getElementById('history-panel');
  const open = panel.classList.toggle('open');
  if (open) {
    renderHistoryList();
    document.getElementById('history-search').value = '';
  }
}

function renderHistoryList() {
  const hist = getHistory();
  const query = (document.getElementById('history-search')?.value || '').toLowerCase();
  const list = document.getElementById('history-list');
  const filtered = query
    ? hist.filter(h => h.title.toLowerCase().includes(query) || h.url.toLowerCase().includes(query))
    : hist;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="hist-empty">' + (query ? '一致する履歴がありません' : '履歴がありません') + '</div>';
    return;
  }

  // 日付グループ化
  const groups = {};
  const now = new Date();
  filtered.forEach(h => {
    const d = new Date(h.time);
    let label;
    if (isSameDay(d, now)) label = '今日';
    else if (isSameDay(d, new Date(now - 86400000))) label = '昨日';
    else label = d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    if (!groups[label]) groups[label] = [];
    groups[label].push(h);
  });

  list.innerHTML = Object.entries(groups).map(([label, items]) => `
    <div class="hist-group-label">${escHtml(label)}</div>
    ${items.map(h => `
      <div class="hist-item" onclick="openHistoryItem('${escHtml(h.url)}')">
        ${h.favicon ? `<img src="${escHtml(h.favicon)}" onerror="this.style.display='none'">` : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:#8892a4;flex-shrink:0"><circle cx="12" cy="12" r="10"/></svg>'}
        <div class="hist-item-info">
          <span class="hist-item-title">${escHtml(h.title)}</span>
          <span class="hist-item-url">${escHtml(h.url)}</span>
        </div>
        <span class="hist-item-time">${formatTime(h.time)}</span>
        <button class="hist-item-del" onclick="event.stopPropagation();removeHistoryItem(${h.time})" title="削除">✕</button>
      </div>
    `).join('')}
  `).join('');
}

function openHistoryItem(url) {
  document.getElementById('history-panel').classList.remove('open');
  if (activeTabId) navigateTab(activeTabId, url);
  else { const id = createTab(null, true); setTimeout(() => navigateTab(id, url), 50); }
}

function removeHistoryItem(time) {
  const hist = getHistory().filter(h => String(h.time) !== String(time));
  saveHistory(hist);
  renderHistoryList();
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

// ======= 永続化 =======
function saveTabsToStorage() {
  const data = tabs.map(t => ({ id: t.id, title: t.title, url: t.url, displayUrl: t.displayUrl, favicon: t.favicon, isNew: t.isNew }));
  try {
    localStorage.setItem('tc_tabs', JSON.stringify(data));
    localStorage.setItem('tc_tabCounter', tabCounter);
    if (typeof TC_ACCOUNT !== 'undefined') {
      TC_ACCOUNT.saveTabs(data, tabCounter);
      if (TC_ACCOUNT.currentUser()) TC_ACCOUNT.saveCookies();
    }
  } catch {}
}

async function loadTabsFromStorage() {
  try {
    let saved = [], counter = 0;
    if (typeof TC_ACCOUNT !== 'undefined') {
      const d = await TC_ACCOUNT.getTabs();
      saved = d.tabs; counter = d.counter;
      // 同時にブックマーク・履歴もキャッシュ
      await _syncBookmarks();
      await _syncHistory();
    } else {
      saved = JSON.parse(localStorage.getItem('tc_tabs') || '[]');
      counter = parseInt(localStorage.getItem('tc_tabCounter') || '0');
    }
    tabCounter = counter;
    if (saved.length > 0) {
      saved.forEach(t => {
        tabs.push(t);
        renderTabs();
        renderTabContent(t);
      });
    }
  } catch {}
}

// ======= その他メニュー =======
function toggleMoreOptions() {
  document.getElementById('more-options-panel').classList.toggle('open');
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ======= Elements Inspector =======
let _elemSelectedNode = null;
let _elemDetailTab = 'styles';
let _elemDetailVisible = true;

function toggleElementsPanel() {
  const panel = document.getElementById('elements-panel');
  const contentArea = document.getElementById('content-area');
  const isOpen = panel.classList.toggle('open');
  contentArea.style.right = isOpen ? '360px' : '';
  if (isOpen) _elemInspectActive();
}

function _elemGetActiveFrame() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab.isNew) return null;
  return document.getElementById('frame-' + activeTabId);
}

function _elemInspectActive() {
  const tree = document.getElementById('elemTree');
  const iframe = _elemGetActiveFrame();
  if (!iframe) {
    tree.innerHTML = '<li style="color:var(--muted);padding:8px">ページが読み込まれていません</li>';
    return;
  }
  let doc = null;
  try { doc = iframe.contentDocument || iframe.contentWindow?.document; } catch(e) {}
  if (!doc) {
    tree.innerHTML = '<li style="color:var(--muted);padding:8px">アクセスできません（クロスオリジン）</li>';
    return;
  }
  try {
    tree.innerHTML = '';
    _elemRenderNode(doc.documentElement, tree, 0, iframe);
  } catch(e) {
    tree.innerHTML = '<li style="color:#ff6b6b;padding:8px">エラー: ' + _escHtml(e.message) + '</li>';
  }
}

function _elemRenderNode(element, parent, depth, iframe) {
  if (!element || !element.tagName) return;
  const li = document.createElement('li');
  li.className = 'element-node';
  li.style.paddingLeft = (depth * 10) + 'px';
  const hasChildren = element.children && element.children.length > 0;
  const contentDiv = document.createElement('div');
  contentDiv.className = 'element-content';

  const toggle = document.createElement('span');
  if (hasChildren) {
    toggle.className = 'element-toggle collapsed';
  } else {
    toggle.className = 'element-spacer';
  }
  contentDiv.appendChild(toggle);

  const tagSpan = document.createElement('span');
  let html = '<span class="element-tag">&lt;' + element.tagName.toLowerCase();
  if (element.attributes) {
    for (let i = 0; i < Math.min(element.attributes.length, 4); i++) {
      const a = element.attributes[i];
      html += ' <span class="element-attr-name">' + _escHtml(a.name) + '</span>=';
      html += '<span class="element-attr-value">"' + _escHtml(a.value.substring(0, 40)) + (a.value.length > 40 ? '…"' : '"') + '</span>';
    }
    if (element.attributes.length > 4) html += ' <span style="color:var(--muted)">…</span>';
  }
  html += '&gt;</span>';
  if (!hasChildren && element.textContent && element.textContent.trim()) {
    const text = element.textContent.trim().substring(0, 50);
    html += '<span class="element-text">' + _escHtml(text) + (element.textContent.trim().length > 50 ? '…' : '') + '</span>';
    html += '<span class="element-tag">&lt;/' + element.tagName.toLowerCase() + '&gt;</span>';
  }
  tagSpan.innerHTML = html;
  contentDiv.appendChild(tagSpan);
  li.appendChild(contentDiv);
  parent.appendChild(li);

  if (hasChildren) {
    const childrenUl = document.createElement('ul');
    childrenUl.className = 'element-children';
    li.appendChild(childrenUl);
    toggle.onclick = (e) => {
      e.stopPropagation();
      const expanded = toggle.classList.toggle('expanded');
      toggle.classList.toggle('collapsed', !expanded);
      childrenUl.classList.toggle('expanded', expanded);
      if (expanded && childrenUl.children.length === 0) {
        for (let i = 0; i < element.children.length; i++) {
          _elemRenderNode(element.children[i], childrenUl, depth + 1, iframe);
        }
      }
    };
  }

  contentDiv.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll('.element-content.selected').forEach(n => n.classList.remove('selected'));
    contentDiv.classList.add('selected');
    _elemSelectedNode = element;
    _elemUpdateBreadcrumb(element);
    _elemShowDetail(element, _elemDetailTab);
    _elemHighlight(element, iframe);
  };
  contentDiv.oncontextmenu = (e) => {
    e.preventDefault(); e.stopPropagation();
    _elemSelectedNode = element;
    const menu = document.getElementById('elem-ctx-menu');
    menu.style.display = 'block';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 130) + 'px';
  };
}

function _elemGetSelector(el) {
  const path = [];
  let cur = el;
  while (cur && cur.parentElement) {
    const par = cur.parentElement;
    if (cur.id) { path.unshift(cur.tagName.toLowerCase() + '#' + cur.id); break; }
    const sibs = Array.from(par.children).filter(c => c.tagName === cur.tagName);
    path.unshift(cur.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')' : ''));
    cur = par;
  }
  return path.join(' > ');
}

function _elemUpdateBreadcrumb(el) {
  const bc = document.getElementById('elemBreadcrumb');
  if (!bc) return;
  const crumbs = [];
  let cur = el;
  while (cur && cur.tagName) {
    const tag = cur.tagName.toLowerCase();
    const id = cur.id ? '#' + cur.id : '';
    const cls = cur.className && typeof cur.className === 'string' ? '.' + cur.className.trim().split(/\s+/).slice(0,2).join('.') : '';
    crumbs.unshift({ label: tag + id + cls, el: cur });
    cur = cur.parentElement;
  }
  bc.innerHTML = crumbs.map((c, i) => {
    const isCur = i === crumbs.length - 1;
    return (i > 0 ? '<span class="elem-crumb-sep">›</span>' : '') +
      '<span class="elem-crumb' + (isCur ? ' current' : '') + '" data-idx="' + i + '">' + _escHtml(c.label) + '</span>';
  }).join('');
  bc.classList.add('visible');
  bc.querySelectorAll('.elem-crumb:not(.current)').forEach(span => {
    span.onclick = () => {
      const el2 = crumbs[parseInt(span.dataset.idx)]?.el;
      if (el2) { _elemSelectedNode = el2; _elemUpdateBreadcrumb(el2); _elemShowDetail(el2, _elemDetailTab); }
    };
  });
}

function _elemShowDetail(el, tab) {
  _elemDetailTab = tab;
  const detail = document.getElementById('elem-detail');
  const content = document.getElementById('elem-detail-content');
  document.querySelectorAll('.elem-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  if (!_elemDetailVisible) { detail.style.display = 'none'; return; }
  detail.style.display = 'flex';
  detail.style.flexDirection = 'column';

  if (tab === 'styles') {
    try {
      const cs = el.ownerDocument.defaultView ? el.ownerDocument.defaultView.getComputedStyle(el) : getComputedStyle(el);
      const props = ['display','position','width','height','flex','flex-direction','gap','overflow',
        'margin','padding','color','background-color','border','border-radius','box-shadow',
        'opacity','font-size','font-weight','font-family','line-height','text-align','transform','transition'];
      const skip = new Set(['none','normal','auto','0px','rgba(0, 0, 0, 0)','','transparent','nowrap','static','visible','initial','unset']);
      const groups = [
        { label: 'Layout', keys: ['display','position','width','height','flex','flex-direction','gap','overflow'] },
        { label: 'Spacing', keys: ['margin','padding'] },
        { label: 'Visual', keys: ['color','background-color','border','border-radius','box-shadow','opacity'] },
        { label: 'Typography', keys: ['font-size','font-weight','font-family','line-height','text-align'] },
        { label: 'Transform', keys: ['transform','transition'] },
      ];
      let html = '';
      groups.forEach(g => {
        const rows = g.keys.filter(k => cs.getPropertyValue(k) && !skip.has(cs.getPropertyValue(k)));
        if (!rows.length) return;
        html += '<div style="font-size:9px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin:6px 0 3px;padding-bottom:2px;border-bottom:1px solid var(--border)">' + g.label + '</div>';
        rows.forEach(k => {
          html += '<div style="display:flex;gap:4px;margin-bottom:2px;flex-wrap:wrap;">' +
            '<span style="color:#5cd65c;flex-shrink:0">' + k + '</span>' +
            '<span style="color:var(--muted);flex-shrink:0">:</span>' +
            '<span style="color:#f0c040;word-break:break-all">' + _escHtml(cs.getPropertyValue(k)) + '</span></div>';
        });
      });
      content.innerHTML = html || '<span style="color:var(--muted)">目立つスタイルなし</span>';
    } catch(e) { content.innerHTML = '<span style="color:var(--muted)">スタイル取得不可</span>'; }
  } else if (tab === 'box') {
    try {
      const r = el.getBoundingClientRect();
      const cs = el.ownerDocument.defaultView ? el.ownerDocument.defaultView.getComputedStyle(el) : getComputedStyle(el);
      const pn = v => parseFloat(v) || 0;
      const mt = pn(cs.marginTop), mr = pn(cs.marginRight), mb = pn(cs.marginBottom), ml = pn(cs.marginLeft);
      const pt = pn(cs.paddingTop), pr = pn(cs.paddingRight), pb = pn(cs.paddingBottom), pl = pn(cs.paddingLeft);
      const w = r.width.toFixed(1), h = r.height.toFixed(1);
      content.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;padding:8px 4px;font-size:10px;">
          <div style="width:100%;max-width:200px;">
            <div style="background:rgba(240,192,64,.07);border:1px dashed rgba(240,192,64,.3);border-radius:5px;padding:4px;position:relative;">
              <div style="text-align:center;color:rgba(240,192,64,.6);font-size:9px;text-transform:uppercase;margin-bottom:2px;">margin</div>
              <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                <span style="color:rgba(240,192,64,.8);padding:0 4px">${ml}px</span>
                <div style="flex:1;background:rgba(92,214,92,.07);border:1px dashed rgba(92,214,92,.3);border-radius:4px;padding:4px;">
                  <div style="text-align:center;color:rgba(92,214,92,.6);font-size:9px;text-transform:uppercase;margin-bottom:2px;">padding</div>
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                    <span style="color:rgba(92,214,92,.8)">${pl}px</span>
                    <div style="flex:1;background:rgba(91,143,255,.1);border:1px solid rgba(91,143,255,.25);border-radius:3px;padding:6px 4px;text-align:center;">
                      <div style="color:#5b8fff;font-size:11px;font-weight:600">${w} × ${h}</div>
                      <div style="color:var(--muted);font-size:9px">content</div>
                    </div>
                    <span style="color:rgba(92,214,92,.8)">${pr}px</span>
                  </div>
                  <div style="text-align:center;color:rgba(92,214,92,.7)">${pb}px</div>
                </div>
                <span style="color:rgba(240,192,64,.8);padding:0 4px">${mr}px</span>
              </div>
              <div style="text-align:center;color:rgba(240,192,64,.7)">${mb}px</div>
            </div>
          </div>
          <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:3px 12px;font-size:10.5px;width:100%;max-width:200px;">
            <div><span style="color:var(--muted)">top: </span><span style="color:#f0c040">${r.top.toFixed(1)}px</span></div>
            <div><span style="color:var(--muted)">left: </span><span style="color:#f0c040">${r.left.toFixed(1)}px</span></div>
            <div><span style="color:var(--muted)">bottom: </span><span style="color:#f0c040">${r.bottom.toFixed(1)}px</span></div>
            <div><span style="color:var(--muted)">right: </span><span style="color:#f0c040">${r.right.toFixed(1)}px</span></div>
          </div>
        </div>`;
    } catch(e) { content.innerHTML = '<span style="color:var(--muted)">ボックス取得不可</span>'; }
  } else if (tab === 'attrs') {
    let html = '';
    if (el.attributes && el.attributes.length > 0) {
      for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i];
        html += '<div style="margin-bottom:4px;display:flex;gap:4px;align-items:baseline;flex-wrap:wrap;">' +
          '<span style="color:#5cd65c;flex-shrink:0">' + _escHtml(a.name) + '</span>' +
          '<span style="color:var(--muted);flex-shrink:0">=</span>' +
          '<span style="color:#f0c040;word-break:break-all">"' + _escHtml(a.value) + '"</span></div>';
      }
    } else {
      html = '<span style="color:var(--muted)">属性なし</span>';
    }
    content.innerHTML = html;
  }
}

function _elemHighlight(el, iframe) {
  // ハイライトオーバーレイをiframe親要素に対して動的に作成
  if (!iframe) return;
  let overlay = document.getElementById('elem-highlight-overlay');
  if (!overlay) return;
  try {
    const frameRect = iframe.getBoundingClientRect();
    const elemRect = el.getBoundingClientRect();
    const contentAreaRect = document.getElementById('content-area').getBoundingClientRect();
    const top  = (frameRect.top  - contentAreaRect.top)  + elemRect.top;
    const left = (frameRect.left - contentAreaRect.left) + elemRect.left;
    overlay.style.top    = top + 'px';
    overlay.style.left   = left + 'px';
    overlay.style.width  = elemRect.width + 'px';
    overlay.style.height = elemRect.height + 'px';
    overlay.style.display = 'block';
  } catch(e) { overlay.style.display = 'none'; }
}

function _escHtml(text) {
  const d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
}

// Elements パネル初期化（DOMContentLoaded後）
window.addEventListener('DOMContentLoaded', () => {
  // タブクリックで詳細切替
  document.querySelectorAll('.elem-tab').forEach(btn => {
    btn.onclick = () => { if (_elemSelectedNode) _elemShowDetail(_elemSelectedNode, btn.dataset.tab); };
  });
  // 詳細パネル表示切替ボタン
  const dtBtn = document.getElementById('elemDetailToggleBtn');
  if (dtBtn) {
    dtBtn.addEventListener('click', () => {
      _elemDetailVisible = dtBtn.classList.toggle('active');
      const detail = document.getElementById('elem-detail');
      if (_elemDetailVisible && _elemSelectedNode) {
        detail.style.display = 'flex';
        detail.style.flexDirection = 'column';
        _elemShowDetail(_elemSelectedNode, _elemDetailTab);
      } else {
        detail.style.display = 'none';
      }
    });
  }
  // リフレッシュ
  document.getElementById('elemRefreshBtn')?.addEventListener('click', _elemInspectActive);
  // 検索フィルター
  document.getElementById('elemSearch')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#elemTree .element-node').forEach(node => {
      const text = node.querySelector('.element-content')?.textContent?.toLowerCase() || '';
      node.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
  });
  // コンテキストメニュー
  const ctxMenu = document.getElementById('elem-ctx-menu');
  document.addEventListener('click', () => { if (ctxMenu) ctxMenu.style.display = 'none'; });
  document.getElementById('elemCtxSelector')?.addEventListener('click', () => {
    if (_elemSelectedNode) navigator.clipboard?.writeText(_elemGetSelector(_elemSelectedNode));
  });
  document.getElementById('elemCtxHtml')?.addEventListener('click', () => {
    if (_elemSelectedNode) navigator.clipboard?.writeText(_elemSelectedNode.outerHTML);
  });
  document.getElementById('elemCtxText')?.addEventListener('click', () => {
    if (_elemSelectedNode) navigator.clipboard?.writeText(_elemSelectedNode.textContent?.trim() || '');
  });
  // リサイズハンドル
  const resizeHandle = document.getElementById('elem-resize-handle');
  const panel = document.getElementById('elements-panel');
  if (resizeHandle && panel) {
    let startX, startW;
    resizeHandle.addEventListener('mousedown', e => {
      startX = e.clientX;
      startW = panel.offsetWidth;
      const onMove = mv => {
        const newW = Math.max(240, Math.min(window.innerWidth * 0.6, startW - (mv.clientX - startX)));
        panel.style.width = newW + 'px';
        const ca = document.getElementById('content-area');
        if (panel.classList.contains('open')) ca.style.right = newW + 'px';
      };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
});

// ======= UI非表示 =======
function hideUI() {
  document.getElementById('tab-bar').style.display = 'none';
  document.getElementById('nav-bar').style.display = 'none';
  document.getElementById('show-ui-btn').classList.add('visible');
  // バーを隠した分、コンテンツ領域を画面上端まで広げる（上部の空白を防ぐ）
  document.body.classList.add('ui-hidden');
}
function showUI() {
  document.getElementById('tab-bar').style.display = '';
  document.getElementById('nav-bar').style.display = '';
  document.getElementById('show-ui-btn').classList.remove('visible');
  document.body.classList.remove('ui-hidden');
}

// ======= about:blank（新しいネイティブタブで表示） =======
function goAboutBlank() {
  const tab = tabs.find(t => t.id === activeTabId);
  const iframe = document.getElementById('frame-' + activeTabId);
  const proxyUrl = iframe ? iframe.src : (tab ? tab.url : null);
  const w = window.open('about:blank', '_blank');
  if (!w) return;
  if (proxyUrl && proxyUrl !== 'about:blank') {
    // 最初のURLを即時記録
    const initDisplay = tab ? (tab.displayUrl || tab.url || '') : proxyUrl;
    if (initDisplay) addHistoryEntry({ title: tab?.title || initDisplay, url: initDisplay, favicon: tab?.favicon || '' });

    const escapedSrc = proxyUrl.replace(/"/g, '&quot;');
    const trackerScript = '(function(){' +
      'var fr=document.querySelector("iframe");' +
      'var lastSrc="";' +
      'function notify(t){' +
        'var s=fr.src;' +
        'if(s&&s!==lastSrc&&s!=="about:blank"){' +
          'lastSrc=s;' +
          'try{window.opener.postMessage({type:"tc_nav",src:s,title:t||""},"*");}catch(e){}' +
        '}' +
      '}' +
      'fr.addEventListener("load",function(){' +
        'var t="";try{t=fr.contentDocument.title;}catch(e){}' +
        'notify(t);' +
        'try{' +
          'new MutationObserver(function(){' +
            'var tt="";try{tt=fr.contentDocument.title;}catch(e){}' +
            'notify(tt);' +
          '}).observe(fr.contentDocument,{subtree:true,childList:true});' +
        '}catch(e){}' +
      '});' +
      'new MutationObserver(function(){notify("");}).observe(fr,{attributes:true,attributeFilter:["src"]});' +
      'setInterval(function(){' +
        'try{' +
          'var s=fr.contentWindow.location.href;' +
          'if(s&&s!==lastSrc&&s!=="about:blank"){' +
            'var t="";try{t=fr.contentDocument.title;}catch(e){}' +
            'lastSrc=s;' +
            'try{window.opener.postMessage({type:"tc_nav",src:fr.src,title:t},"*");}catch(e){}' +
          '}' +
        '}catch(e){}' +
      '},1000);' +
    '})();';
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>about:blank</title>' +
      '<style>*{margin:0;padding:0;box-sizing:border-box}html,body,iframe{width:100%;height:100%;border:none;display:block}</style></head>' +
      '<body><iframe src="' + escapedSrc + '" allowfullscreen></iframe>' +
      '<script>' + trackerScript + '</' + 'script>' +
      '</body></html>';
    w.document.open();
    w.document.write(html);
    w.document.close();
  }
}

// ======= フルスクリーン =======
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

// ======= ズーム =======
let _zoomLevel = 100;
function applyZoom() {
  document.querySelectorAll('.browser-frame').forEach(f => {
    f.style.transformOrigin = 'top left';
    if (_zoomLevel === 100) {
      f.style.transform = '';
      f.style.width = '100%';
      f.style.height = '100%';
    } else {
      const scale = _zoomLevel / 100;
      f.style.transform = `scale(${scale})`;
      f.style.width = `${(100 / scale).toFixed(2)}%`;
      f.style.height = `${(100 / scale).toFixed(2)}%`;
    }
  });
  document.getElementById('zoom-level-display').textContent = _zoomLevel + '%';
}
function adjustZoom(delta) {
  _zoomLevel = Math.max(25, Math.min(300, _zoomLevel + delta));
  applyZoom();
  addLog(`ズーム: ${_zoomLevel}%`, 'info');
}
function resetZoom() {
  _zoomLevel = 100;
  applyZoom();
  addLog('ズームをリセット', 'info');
}
function toggleZoomPopup() {
  document.getElementById('zoom-popup').classList.toggle('open');
}

// ======= ログシステム =======
let _logFilter = 'all';
let _logSearch = '';
let _logAutoScroll = true;
let _recentLogs = new Map();

function _updateLogBadge() {
  const logbox = document.getElementById('logbox');
  const badge = document.getElementById('logCountBadge');
  const statsEl = document.getElementById('logStats');
  if (!logbox || !badge) return;
  const all = logbox.querySelectorAll('.log-entry').length;
  const visible = logbox.querySelectorAll('.log-entry:not(.hidden-by-filter)').length;
  badge.textContent = visible < all ? `${visible}/${all}` : `${all}`;
  if (statsEl) statsEl.textContent = `${all} 件`;
}

function _entryMatchesFilter(entry) {
  const type = entry.dataset.type || '';
  const text = (entry.dataset.text || '').toLowerCase();
  const filterOk = _logFilter === 'all' || type === _logFilter;
  const searchOk = !_logSearch || text.includes(_logSearch);
  return filterOk && searchOk;
}

function _applyLogFilter() {
  const logbox = document.getElementById('logbox');
  if (!logbox) return;
  let anyVisible = false;
  logbox.querySelectorAll('.log-entry').forEach(el => {
    const show = _entryMatchesFilter(el);
    el.classList.toggle('hidden-by-filter', !show);
    if (show) anyVisible = true;
  });
  const noResults = document.getElementById('logNoResults');
  if (noResults) noResults.classList.toggle('visible', !anyVisible);
  _updateLogBadge();
}

function setLogStatus(state, text) {
  const dot = document.getElementById('logStatusDot');
  const txt = document.getElementById('logStatusText');
  if (dot) dot.className = 'log-dot ' + state;
  if (txt) txt.textContent = text;
}

function addLog(msg, type = '') {
  const logbox = document.getElementById('logbox');
  if (!logbox) return;
  const d = document.createElement('div');
  d.className = ('log-entry ' + type).trim();
  d.dataset.type = type || 'default';
  const now = new Date();
  const ts = now.toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const tempDiv = document.createElement('div');
  tempDiv.textContent = msg;
  d.dataset.text = msg.toLowerCase();
  const msgKey = msg.slice(0, 200);
  const lastSeen = _recentLogs.get(msgKey);
  if (lastSeen && (Date.now() - lastSeen.time) < 3000) {
    lastSeen.count++;
    if (lastSeen.el) {
      let badge = lastSeen.el.querySelector('.log-dup-badge');
      if (!badge) { badge = document.createElement('span'); badge.className = 'log-dup-badge'; lastSeen.el.appendChild(badge); }
      badge.textContent = `×${lastSeen.count + 1}`;
    }
    return;
  }
  _recentLogs.set(msgKey, { time: Date.now(), count: 1, el: d });
  if (_recentLogs.size > 200) {
    const cutoff = Date.now() - 8000;
    for (const [k, v] of _recentLogs.entries()) { if (v.time < cutoff) _recentLogs.delete(k); }
  }
  const tsSpan = document.createElement('span');
  tsSpan.className = 'log-ts';
  tsSpan.textContent = ts;
  const msgSpan = document.createElement('span');
  msgSpan.className = 'log-msg';
  msgSpan.textContent = msg;
  d.appendChild(tsSpan);
  d.appendChild(msgSpan);
  if (!_entryMatchesFilter(d)) d.classList.add('hidden-by-filter');
  const noResults = document.getElementById('logNoResults');
  if (noResults) logbox.insertBefore(d, noResults);
  else logbox.appendChild(d);
  if (logbox.querySelectorAll('.log-entry').length > 400) {
    const first = logbox.querySelector('.log-entry');
    if (first) logbox.removeChild(first);
  }
  _updateLogBadge();
  const nr = document.getElementById('logNoResults');
  if (nr) nr.classList.toggle('visible', !logbox.querySelector('.log-entry:not(.hidden-by-filter)'));
  if (_logAutoScroll) logbox.scrollTop = logbox.scrollHeight;
}

function toggleLogPanel() {
  document.getElementById('log-panel').classList.toggle('open');
}

// ログUI初期化（DOM ready後）
window.addEventListener('DOMContentLoaded', () => {
  // フィルターバー
  document.getElementById('logFilterBar')?.querySelectorAll('.log-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('logFilterBar').querySelectorAll('.log-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _logFilter = btn.dataset.filter;
      _applyLogFilter();
    });
  });
  // 検索
  document.getElementById('logSearch')?.addEventListener('input', e => {
    _logSearch = e.target.value.trim().toLowerCase();
    _applyLogFilter();
  });
  // 自動スクロールトグル
  const autoBtn = document.getElementById('logAutoScrollBtn');
  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      _logAutoScroll = !_logAutoScroll;
      autoBtn.classList.toggle('pinned', _logAutoScroll);
      const logbox = document.getElementById('logbox');
      if (_logAutoScroll && logbox) logbox.scrollTop = logbox.scrollHeight;
    });
  }
  // スクロール検知
  document.getElementById('logbox')?.addEventListener('scroll', () => {
    const logbox = document.getElementById('logbox');
    const atBottom = logbox.scrollHeight - logbox.scrollTop - logbox.clientHeight < 20;
    if (!atBottom && _logAutoScroll) {
      _logAutoScroll = false;
      document.getElementById('logAutoScrollBtn')?.classList.remove('pinned');
    } else if (atBottom && !_logAutoScroll) {
      _logAutoScroll = true;
      document.getElementById('logAutoScrollBtn')?.classList.add('pinned');
    }
  });
  // クリアボタン
  document.getElementById('clearLogs')?.addEventListener('click', () => {
    const logbox = document.getElementById('logbox');
    logbox?.querySelectorAll('.log-entry').forEach(el => el.remove());
    _recentLogs.clear();
    document.getElementById('logNoResults')?.classList.remove('visible');
    _updateLogBadge();
    addLog('ログをクリアしました', 'info');
  });
  // コピーボタン
  document.getElementById('copyLogs')?.addEventListener('click', () => {
    const logbox = document.getElementById('logbox');
    const lines = Array.from(logbox?.querySelectorAll('.log-entry') || []).map(el => {
      const ts = el.querySelector('.log-ts')?.textContent || '';
      const msg = el.querySelector('.log-msg')?.textContent || '';
      return ts ? `[${ts}] ${msg}` : msg;
    });
    navigator.clipboard.writeText(lines.join('\n')).then(() => addLog('ログをクリップボードにコピーしました', 'info'));
  });
  // ログパネルリサイズ
  const resizeHandle = document.getElementById('log-resize-handle');
  const logPanel = document.getElementById('log-panel');
  if (resizeHandle && logPanel) {
    let startY, startH;
    resizeHandle.addEventListener('mousedown', e => {
      startY = e.clientY;
      startH = logPanel.offsetHeight;
      const onMove = mv => {
        const delta = startY - mv.clientY;
        logPanel.style.height = Math.max(120, Math.min(window.innerHeight - 100, startH + delta)) + 'px';
      };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  // ズームポップアップ外クリックで閉じる
  document.addEventListener('click', e => {
    const zp = document.getElementById('zoom-popup');
    const zb = document.getElementById('more-options-btn');
    if (zp && !zp.contains(e.target)) zp.classList.remove('open');
  });
});

// ======= go.html アカウントUI =======
function renderGoAccountUI() {
  if (typeof TC_ACCOUNT === 'undefined') return;
  const user = TC_ACCOUNT.currentAccount();
  const btn    = document.getElementById('go-account-btn');
  const avatar = document.getElementById('go-account-avatar');
  const ddName = document.getElementById('go-dd-name');
  const ddRole = document.getElementById('go-dd-role');
  const loggedIn  = document.getElementById('go-dd-loggedin');
  const loggedOut = document.getElementById('go-dd-loggedout');
  if (!btn) return;

  if (user) {
    if (user.icon) {
      avatar.innerHTML = `<img src="${user.icon}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      btn.style.background = 'transparent';
    } else {
      avatar.textContent = user.username.slice(0,2).toUpperCase();
      btn.style.background = 'linear-gradient(135deg,#5b8fff,#a55bff)';
    }
    ddName.textContent = user.username;
    ddRole.textContent = 'ログイン中';
    if (loggedIn)  loggedIn.style.display  = 'block';
    if (loggedOut) loggedOut.style.display = 'none';
  } else {
    avatar.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    btn.style.background = 'var(--surface2)';
    ddName.textContent = 'ゲスト';
    ddRole.textContent = 'ログインしていません';
    if (loggedIn)  loggedIn.style.display  = 'none';
    if (loggedOut) loggedOut.style.display = 'block';
  }
}

function toggleGoAccountMenu() {
  const menu = document.getElementById('go-account-menu');
  if (!menu) return;
  const isOpen = menu.style.display === 'block';
  menu.style.display = isOpen ? 'none' : 'block';
}

function doGoLogout() {
  if (typeof TC_ACCOUNT !== 'undefined') TC_ACCOUNT.logout();
  document.getElementById('go-account-menu').style.display = 'none';
  renderGoAccountUI();
}

function goToHome() {
  location.href = '../index.html';
}

// go-account-menu 外クリックで閉じる
document.addEventListener('click', e => {
  const menu = document.getElementById('go-account-menu');
  const btn  = document.getElementById('go-account-btn');
  if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
    menu.style.display = 'none';
  }
});