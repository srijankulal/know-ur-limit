/**
 * Know Ur Limit - DeepSeek DOM Rate-Limit Watcher
 * Watches for visible DOM rate-limit alerts on chat.deepseek.com while MAIN-world interceptor
 * handles authenticated Bearer token requests using localStorage.userToken.
 */

(function () {
  'use strict';

  const BOT_ID = 'deepseek';

  function checkDomForLimitNotice() {
    const alerts = document.querySelectorAll('div[class*="toast"], div[class*="modal"], div[role="alert"]');
    for (const el of alerts) {
      const text = el.textContent || '';
      if (text.includes('limit exceeded') || text.includes('Too many requests')) {
        return {
          resetsAt: null,
          reason: text.slice(0, 160)
        };
      }
    }
    return null;
  }

  let lastReason = '';
  const observer = new MutationObserver(() => {
    const alertInfo = checkDomForLimitNotice();
    if (alertInfo && alertInfo.reason !== lastReason) {
      lastReason = alertInfo.reason;
      try {
        chrome.runtime.sendMessage({
          action: 'LIMIT_DETECTED',
          data: {
            botId: BOT_ID,
            resetsAt: alertInfo.resetsAt,
            reason: alertInfo.reason
          }
        });
      } catch (_) {}
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
