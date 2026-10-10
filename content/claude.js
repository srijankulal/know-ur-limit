/**
 * AI Usage Limits Hub - Claude DOM Monitor
 */

(function () {
  'use strict';

  const BOT_ID = 'claude';

  function parseResetTime(text) {
    if (!text) return null;

    // Matches: "until 3:00 PM" or "resets at 4:30 PM"
    const match = text.match(/(?:resets\s+at|until|resets\s+around)\s+(\d{1,2}:\d{2}(?:\s*[AaPpMm]{2})?)/i);
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

    // Relative: "in 2 hours", "in 45 minutes"
    const relMatch = text.match(/in\s+(\d+)\s*(minute|hour|min|hr)s?/i);
    if (relMatch) {
      const amount = parseInt(relMatch[1], 10);
      const unit = relMatch[2].toLowerCase();
      const mult = unit.startsWith('h') ? 3600 * 1000 : 60 * 1000;
      return Date.now() + (amount * mult);
    }

    return null;
  }

  // 1. DOM Observer for Claude Rate Limits & Warnings
  const observer = new MutationObserver(() => {
    // Look for limit warnings / banners
    const allDivs = document.querySelectorAll('div, p, span, h3');
    for (const el of allDivs) {
      const text = el.textContent || '';
      if (
        text.includes("limit will reset at") ||
        text.includes("out of free messages until") ||
        text.includes("messages remaining until") ||
        text.includes("reached your message limit")
      ) {
        const resetsAt = parseResetTime(text);
        try {
          chrome.runtime.sendMessage({
            action: 'LIMIT_DETECTED',
            data: {
              botId: BOT_ID,
              resetsAt: resetsAt || (Date.now() + 5 * 3600 * 1000),
              reason: text.slice(0, 160)
            }
          });
        } catch (e) {}
        break;
      }
    }

    // Look for Pro badge
    const badgeElements = document.querySelectorAll('span, button, a');
    for (const el of badgeElements) {
      const txt = (el.textContent || '').trim();
      if (txt === 'Claude Pro' || txt === 'Pro Plan') {
        notifyPlan('pro');
        break;
      } else if (txt === 'Claude Team' || txt === 'Team Plan') {
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

  // 2. Track Prompt Submissions
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const editor = document.querySelector('div[contenteditable="true"]');
      if (editor && (e.target === editor || editor.contains(e.target))) {
        if (editor.textContent && editor.textContent.trim().length > 0) {
          notifyPromptSent();
        }
      }
    }
  }, true);

  document.addEventListener('click', (e) => {
    const sendBtn = e.target.closest('button[aria-label="Send Message"], button[aria-label="Send Prompt"]');
    if (sendBtn) {
      notifyPromptSent();
    }
  }, true);

  let lastSentTs = 0;
  function notifyPromptSent() {
    const now = Date.now();
    if (now - lastSentTs < 1000) return;
    lastSentTs = now;

    // Detect model (e.g. Sonnet, Opus, Haiku)
    let model = 'claude-3-5-sonnet';
    const modelSelector = document.querySelector('[data-testid="model-selector-dropdown"], button');
    if (modelSelector && modelSelector.textContent) {
      const txt = modelSelector.textContent.toLowerCase();
      if (txt.includes('haiku')) model = 'claude-3-5-haiku';
      else if (txt.includes('opus')) model = 'claude-3-opus';
      else if (txt.includes('sonnet')) model = 'claude-3-5-sonnet';
    }

    try {
      chrome.runtime.sendMessage({
        action: 'PROMPT_SENT',
        data: { botId: BOT_ID, model }
      });
    } catch (e) {}
  }

  console.log('[AI Usage Limits] Claude DOM watcher registered');
})();
