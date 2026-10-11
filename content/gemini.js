/**
 * AI Usage Limits Hub - Gemini DOM Monitor & Auto-Fetcher
 * Auto-fetches usage quotas, plan tier, and rate limit reset times directly from gemini.google.com sessions.
 */

(function () {
  'use strict';

  const BOT_ID = 'gemini';
  let isFetching = false;
  let lastFetchTs = 0;

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

  // ----------------------------------------------------
  // Live Browser Session Auto-Fetcher for Gemini
  // ----------------------------------------------------
  async function autoFetchGeminiUsage() {
    if (isFetching) return;
    isFetching = true;
    lastFetchTs = Date.now();

    const result = {
      botId: BOT_ID,
      isLoggedIn: false,
      tier: 'free',
      usedPercent: null,
      resetsAt: null,
      quotaWindows: null,
      accountEmail: null,
      activeModel: 'gemini-2.0-flash',
      isLimited: false,
      limitReason: null,
      fetchStatus: 'idle'
    };

    try {
      // 1. Detect if user is authenticated
      const userProfileEl = document.querySelector(
        'a[href*="accounts.google.com"], [aria-label*="Google Account"], [data-email], img[alt*="Google Account"]'
      );
      const isGoogleLoggedIn = !!userProfileEl || document.cookie.includes('SID=') || document.cookie.includes('OSID=');

      if (isGoogleLoggedIn) {
        result.isLoggedIn = true;
        result.fetchStatus = 'synced';

        // Extract email if available in aria-label
        if (userProfileEl) {
          const aria = userProfileEl.getAttribute('aria-label') || '';
          const emailMatch = aria.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/i);
          if (emailMatch) {
            result.accountEmail = emailMatch[1];
          }
        }
      } else {
        result.isLoggedIn = false;
        result.fetchStatus = 'login_required';
      }

      // 2. Detect plan tier from UI
      const headerElements = document.querySelectorAll('span, div, h1, button, a');
      for (const el of headerElements) {
        const txt = (el.textContent || '').trim();
        if (txt === 'Gemini Advanced' || txt.includes('Advanced') || txt.includes('AI Premium')) {
          result.tier = 'advanced';
          result.activeModel = 'gemini-2.0-pro';
          break;
        }
      }

      // 3. Inspect DOM for rate limits or usage notices
      const alerts = document.querySelectorAll(
        'div[role="alert"], div[class*="snack"], div[class*="banner"], p, div[class*="warning"]'
      );
      for (const el of alerts) {
        const text = el.textContent || '';
        if (
          text.includes("reached your limit") ||
          text.includes("reached the message limit") ||
          text.includes("quota exceeded")
        ) {
          result.isLimited = true;
          result.resetsAt = parseResetTime(text) || (Date.now() + 24 * 3600 * 1000);
          result.limitReason = text.slice(0, 160);
          result.usedPercent = 100;
          break;
        }
      }
    } catch (e) {
      console.warn('[AI Limits] Gemini auto-fetch note:', e);
      result.fetchStatus = 'error';
    } finally {
      isFetching = false;
    }

    // Transmit result to background
    try {
      chrome.runtime.sendMessage({
        action: 'AUTO_FETCH_RESULT',
        data: result
      });
    } catch (_) {}

    return result;
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

    // Auto-fetch updated quota 3 seconds after prompt
    setTimeout(autoFetchGeminiUsage, 3000);
  }

  // 3. Listen for on-demand fetch requests from background or popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'TRIGGER_AUTO_FETCH' && (message.botId === BOT_ID || !message.botId)) {
      autoFetchGeminiUsage().then((res) => {
        sendResponse({ success: true, data: res });
      });
      return true;
    }
  });

  // 4. Run on load and periodically every 2 minutes
  autoFetchGeminiUsage();
  setInterval(() => {
    if (Date.now() - lastFetchTs >= 120000) {
      autoFetchGeminiUsage();
    }
  }, 120000);

  console.log('[AI Usage Limits] Gemini DOM watcher & live auto-fetcher active');
})();
