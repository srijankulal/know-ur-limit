/**
 * Know Ur Limit - Claude DOM Rate-Limit Banner Watcher
 * Watches for visible DOM rate-limit notices on claude.ai without overwriting MAIN-world telemetry.
 */

(function () {
  'use strict';

  const BOT_ID = 'claude';

  function parseResetTime(text) {
    if (!text) return null;
    const match = text.match(/(?:resets\s+at|until|resets\s+around)\s+(\d{1,2}:\d{2}(?:\s*[AaPpMm]{2})?)/i);
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
    const relMatch = text.match(/in\s+(\d+)\s*(minute|hour|min|hr)s?/i);
    if (relMatch) {
      const amount = parseInt(relMatch[1], 10);
      const unit = relMatch[2].toLowerCase();
      const mult = unit.startsWith('h') ? 3600 * 1000 : 60 * 1000;
      return Date.now() + (amount * mult);
    }
    return null;
  }

  function checkDomForLimitNotice() {
    const allEls = document.querySelectorAll('div[role="alert"], [data-testid*="limit"], p, span');
    for (const el of allEls) {
      const text = el.textContent || '';
      if (
        text.includes('limit will reset at') ||
        text.includes('out of free messages until') ||
        text.includes('reached your message limit') ||
        text.includes('usage limit reached')
      ) {
        return {
          resetsAt: parseResetTime(text),
          reason: text.slice(0, 160)
        };
      }
    }
    return null;
  }

  let lastReason = '';
  const observer = new MutationObserver(() => {
    const limitInfo = checkDomForLimitNotice();
    if (limitInfo && limitInfo.reason !== lastReason) {
      lastReason = limitInfo.reason;
      try {
        chrome.runtime.sendMessage({
          action: 'LIMIT_DETECTED',
          data: {
            botId: BOT_ID,
            resetsAt: limitInfo.resetsAt,
            reason: limitInfo.reason
          }
        });
      } catch (_) {}
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
