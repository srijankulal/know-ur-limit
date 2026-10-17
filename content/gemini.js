/**
 * Know Ur Limit - Gemini DOM Rate-Limit Watcher
 * Watches for visible DOM rate-limit banners on gemini.google.com and triggers MAIN-world syncs.
 */

(function () {
  'use strict';

  const BOT_ID = 'gemini';

  function parseResetTime(text) {
    if (!text) return null;
    const match = text.match(/(?:resets\s+at|until|resets\s+tomorrow\s+at)\s+(\d{1,2}:\d{2}(?:\s*[AaPpMm]{2})?)/i);
    if (match) {
      const parts = match[1].match(/(\d{1,2}):(\d{2})(?:\s*([AaPpMm]{2}))?/);
      if (parts) {
        let hours = parseInt(parts[1], 10);
        const minutes = parseInt(parts[2], 10);
        const ampm = parts[3] ? parts[3].toUpperCase() : null;
        if (ampm === 'PM' && hours < 12) hours += 12;
        if (ampm === 'AM' && hours === 12) hours = 0;

        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
        if (target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 1);
        }
        return target.getTime();
      }
    }
    return null;
  }

  let lastReason = '';
  const observer = new MutationObserver(() => {
    const alerts = document.querySelectorAll('div[role="alert"], div[class*="snack"], div[class*="banner"]');
    for (const el of alerts) {
      const text = el.textContent || '';
      if (
        text.includes('reached your limit') ||
        text.includes('reached the message limit') ||
        text.includes('quota exceeded')
      ) {
        if (text !== lastReason) {
          lastReason = text;
          try {
            chrome.runtime.sendMessage({
              action: 'LIMIT_DETECTED',
              data: {
                botId: BOT_ID,
                resetsAt: parseResetTime(text),
                reason: text.slice(0, 160)
              }
            });
          } catch (_) {}
        }
        break;
      }
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
