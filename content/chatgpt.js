/**
 * Know Ur Limit - ChatGPT DOM Rate-Limit Banner Watcher
 * Watches for visible DOM rate-limit notices and triggers MAIN-world telemetry syncs.
 */

(function () {
  'use strict';

  const BOT_ID = 'chatgpt';

  function parseResetTime(text) {
    if (!text) return null;
    const match = text.match(/(?:resets\s+at|until|try\s+again\s+at)\s+(\d{1,2}:\d{2}(?:\s*[AaPpMm]{2})?)/i);
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
    const relMatch = text.match(/try\s+again\s+in\s+(\d+)\s*(minute|hour|min|hr)s?/i);
    if (relMatch) {
      const amount = parseInt(relMatch[1], 10);
      const unit = relMatch[2].toLowerCase();
      const mult = unit.startsWith('h') ? 3600 * 1000 : 60 * 1000;
      return Date.now() + (amount * mult);
    }
    return null;
  }

  function checkDomForLimitNotice() {
    const elements = document.querySelectorAll(
      '[data-testid="error-message"], div[class*="text-red"], div[role="alert"], div[class*="bg-red"]'
    );
    for (const el of elements) {
      const text = el.textContent || '';
      if (
        text.includes('reached your usage limit') ||
        text.includes('current usage limit') ||
        text.includes('limit for GPT-') ||
        text.includes('limit for o1') ||
        text.includes('limit for o3')
      ) {
        return {
          resetsAt: parseResetTime(text),
          reason: text.slice(0, 160)
        };
      }
    }
    return null;
  }

  let lastBannerReason = '';
  const observer = new MutationObserver(() => {
    const banner = checkDomForLimitNotice();
    if (banner && banner.reason !== lastBannerReason) {
      lastBannerReason = banner.reason;
      try {
        chrome.runtime.sendMessage({
          action: 'LIMIT_DETECTED',
          data: {
            botId: BOT_ID,
            resetsAt: banner.resetsAt,
            reason: banner.reason
          }
        });
      } catch (_) {}
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
