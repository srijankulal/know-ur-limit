/**
 * AI Usage Limits Hub - Gemini DOM Monitor
 */

(function () {
  'use strict';

  const BOT_ID = 'gemini';

  function parseResetTime(text) {
    if (!text) return null;
    const match = text.match(/(?:resets\s+at|until|resets\s+tomorrow\s+at)\s+(\d{1,2}:\d{2}(?:\s*[AaPpMm]{2})?)/i);
    if (match) {
      const timeStr = match[1];
      const parts = timeStr.match(/(\d{1,2}):(\d{2})(?:\s*([AaPpMm]{2}))?/);
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

  // 1. DOM Observer for Gemini
  const observer = new MutationObserver(() => {
    // Check for limit notices
    const alerts = document.querySelectorAll('div[role="alert"], div[class*="snack"], div[class*="banner"], p');
    for (const el of alerts) {
      const text = el.textContent || '';
      if (
        text.includes("reached your limit") ||
        text.includes("reached the message limit") ||
        text.includes("quota exceeded")
      ) {
        const resetsAt = parseResetTime(text);
        try {
          chrome.runtime.sendMessage({
            action: 'LIMIT_DETECTED',
            data: {
              botId: BOT_ID,
              resetsAt: resetsAt || (Date.now() + 24 * 3600 * 1000),
              reason: text.slice(0, 160)
            }
          });
        } catch (e) {}
        break;
      }
    }

    // Detect Gemini Advanced badge
    const headerBadges = document.querySelectorAll('span, div, h1');
    for (const el of headerBadges) {
      const txt = (el.textContent || '').trim();
      if (txt === 'Gemini Advanced') {
        notifyPlan('advanced');
        break;
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  let planReported = false;
  function notifyPlan(plan) {
    if (planReported) return;
    planReported = true;
    try {
      chrome.runtime.sendMessage({
        action: 'PLAN_DETECTED',
        data: { botId: BOT_ID, plan }
      });
    } catch (e) {}
  }

  // 2. Track Prompt Submissions
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const editor = document.querySelector('rich-textarea, div[contenteditable="true"], textarea');
      if (editor && (e.target === editor || editor.contains(e.target))) {
        if ((editor.textContent || editor.value || '').trim().length > 0) {
          notifyPromptSent();
        }
      }
    }
  }, true);

  document.addEventListener('click', (e) => {
    const sendBtn = e.target.closest('button[aria-label*="Send"], button.send-button');
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
        data: { botId: BOT_ID, model: 'gemini-2.0-flash' }
      });
    } catch (e) {}
  }

  console.log('[AI Usage Limits] Gemini DOM watcher registered');
})();
