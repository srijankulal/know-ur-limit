/**
 * AI Usage Limits Hub - DeepSeek DOM Monitor
 */

(function () {
  'use strict';

  const BOT_ID = 'deepseek';

  const observer = new MutationObserver(() => {
    const alerts = document.querySelectorAll('div[class*="toast"], div[class*="modal"], div[role="alert"]');
    for (const el of alerts) {
      const text = el.textContent || '';
      if (text.includes("Server is busy") || text.includes("limit exceeded") || text.includes("Too many requests")) {
        try {
          chrome.runtime.sendMessage({
            action: 'LIMIT_DETECTED',
            data: {
              botId: BOT_ID,
              resetsAt: Date.now() + 60 * 60 * 1000,
              reason: text.slice(0, 160)
            }
          });
        } catch (e) {}
        break;
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Track Prompt Submissions
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const textarea = document.querySelector('textarea');
      if (textarea && (e.target === textarea || textarea.contains(e.target))) {
        if (textarea.value && textarea.value.trim().length > 0) {
          notifyPromptSent();
        }
      }
    }
  }, true);

  document.addEventListener('click', (e) => {
    const sendBtn = e.target.closest('div[class*="send"], button[class*="send"]');
    if (sendBtn) {
      notifyPromptSent();
    }
  }, true);

  let lastSentTs = 0;
  function notifyPromptSent() {
    const now = Date.now();
    if (now - lastSentTs < 1000) return;
    lastSentTs = now;

    try {
      chrome.runtime.sendMessage({
        action: 'PROMPT_SENT',
        data: { botId: BOT_ID, model: 'deepseek-chat' }
      });
    } catch (e) {}
  }

  console.log('[AI Usage Limits] DeepSeek DOM watcher registered');
})();
