/**
 * AI Usage Limits Hub - ChatGPT DOM Monitor
 */

(function () {
  'use strict';

  const BOT_ID = 'chatgpt';

  function parseResetTime(text) {
    if (!text) return null;
    const match = text.match(/(?:resets\s+at|until|try\s+again\s+at)\s+(\d{1,2}:\d{2}(?:\s*[AaPpMm]{2})?)/i);
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

    // Match relative time: "try again in 45 minutes"
    const relMatch = text.match(/try\s+again\s+in\s+(\d+)\s*(minute|hour|min|hr)s?/i);
    if (relMatch) {
      const amount = parseInt(relMatch[1], 10);
      const unit = relMatch[2].toLowerCase();
      const mult = unit.startsWith('h') ? 3600 * 1000 : 60 * 1000;
      return Date.now() + (amount * mult);
    }

    return null;
  }

  // 1. DOM Observer for Error Toasts and Limit Messages
  const observer = new MutationObserver(() => {
    // Check for error banners / alert texts
    const potentialElements = document.querySelectorAll(
      '[data-testid="error-message"], div[class*="text-red"], div[role="alert"], div[class*="bg-red"]'
    );

    for (const el of potentialElements) {
      const text = el.textContent || '';
      if (
        text.includes("reached your usage limit") ||
        text.includes("current usage limit") ||
        text.includes("limit for GPT-4o") ||
        text.includes("limit for o1")
      ) {
        const resetsAt = parseResetTime(text);
        try {
          chrome.runtime.sendMessage({
            action: 'LIMIT_DETECTED',
            data: {
              botId: BOT_ID,
              resetsAt: resetsAt || (Date.now() + 3 * 3600 * 1000),
              reason: text.slice(0, 160)
            }
          });
        } catch (e) {}
        break;
      }
    }

    // Detect user tier from UI badges (e.g. "Plus", "Team", "Pro")
    const plusBadges = document.querySelectorAll('span, button, div');
    for (const el of plusBadges) {
      const txt = (el.textContent || '').trim();
      if (txt === 'ChatGPT Plus') {
        notifyPlan('plus');
        break;
      } else if (txt === 'ChatGPT Pro') {
        notifyPlan('pro');
        break;
      } else if (txt === 'ChatGPT Team') {
        notifyPlan('team');
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

  // 2. Track Prompt Submissions via User Actions
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const textarea = document.querySelector('#prompt-textarea');
      if (textarea && textarea.value && textarea.value.trim().length > 0) {
        if (e.target === textarea || textarea.contains(e.target)) {
          notifyPromptSent();
        }
      }
    }
  }, true);

  document.addEventListener('click', (e) => {
    const sendBtn = e.target.closest('[data-testid="send-button"], button[aria-label="Send prompt"]');
    if (sendBtn) {
      notifyPromptSent();
    }
  }, true);

  let lastSentTs = 0;
  function notifyPromptSent() {
    const now = Date.now();
    // Debounce 1 sec
    if (now - lastSentTs < 1000) return;
    lastSentTs = now;

    // Detect active model from selector button
    let model = 'gpt-4o';
    const modelBtn = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
    if (modelBtn && modelBtn.textContent) {
      const txt = modelBtn.textContent.toLowerCase();
      if (txt.includes('o1-mini')) model = 'o1-mini';
      else if (txt.includes('o1')) model = 'o1-preview';
      else if (txt.includes('o3-mini')) model = 'o3-mini';
      else if (txt.includes('4o-mini')) model = 'gpt-4o-mini';
      else if (txt.includes('4o')) model = 'gpt-4o';
    }

    try {
      chrome.runtime.sendMessage({
        action: 'PROMPT_SENT',
        data: { botId: BOT_ID, model }
      });
    } catch (e) {}
  }

  console.log('[AI Usage Limits] ChatGPT DOM watcher registered');
})();
