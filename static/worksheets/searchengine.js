// 検索エンジン設定の読み込み（TC_ACCOUNT 対応版）
// 保存は settings.html の saveSearchEngine() が担う
document.addEventListener('DOMContentLoaded', async function () {
  const sel = document.getElementById('searchengine');
  if (!sel) return;

  if (typeof TC_ACCOUNT !== 'undefined') {
    await TC_ACCOUNT.restoreSession().catch(() => {});
    sel.value = TC_ACCOUNT.getEngine();
  } else {
    sel.value = localStorage.getItem('searchengine') || 'bing';
  }
});