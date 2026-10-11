/**
 * AI Usage Limits Hub - Claude DOM Monitor & Auto-Fetcher
 * Auto-fetches usage quotas, rolling 5-hour limits, and reset times directly from claude.ai browser sessions.
 */

(function () {
  'use strict';

  const BOT_ID = 'claude';
  let isFetching = false;
  let lastFetchTs = 0;

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

  // ----------------------------------------------------
  // Live Browser Session Auto-Fetcher for Claude
  // ----------------------------------------------------
  async function autoFetchClaudeUsage() {
    if (isFetching) return;
    isFetching = true;
    lastFetchTs = Date.now();

    const onLoginPage = window.location.pathname.includes('/login') || window.location.pathname.includes('/signup');
    const onChatPage = window.location.pathname.startsWith('/chat') || window.location.pathname.startsWith('/project');
    const hasEditor = !!document.querySelector('div[contenteditable="true"]');
    const hasUserMenu = !!document.querySelector('[data-testid="user-menu-button"], button[aria-label*="user"], a[href="/new"], a[href*="/chat/"]');
    const isLoggedIn = !onLoginPage && (onChatPage || hasEditor || hasUserMenu || document.cookie.includes('sessionKey'));

    const result = {
      botId: BOT_ID,
      isLoggedIn: isLoggedIn,
      tier: 'free',
      usedPercent: null,
      resetsAt: null,
      quotaWindows: null,
      accountEmail: null,
      isLimited: false,
      limitReason: null,
      fetchStatus: onLoginPage ? 'login_required' : (isLoggedIn ? 'synced' : 'idle')
    };

    // Detect plan tier from DOM badges
    const badgeElements = document.querySelectorAll('span, button, a');
    for (const el of badgeElements) {
      const txt = (el.textContent || '').trim();
      if (txt === 'Claude Pro' || txt === 'Pro Plan') {
        result.tier = 'pro';
        break;
      } else if (txt === 'Claude Team' || txt === 'Team Plan') {
        result.tier = 'team';
        break;
      }
    }

    // Check DOM for active rate limits
    const bannerMatch = checkDomForLimitNotice();
    if (bannerMatch) {
      result.isLimited = true;
      result.resetsAt = bannerMatch.resetsAt || (Date.now() + 5 * 3600 * 1000);
      result.limitReason = bannerMatch.reason;
    }

    // Trigger high-fidelity in-page fetch via interceptor in MAIN world (exempt from isolated CSP/CORS)
    try {
      window.postMessage({
        source: 'AI_LIMITS_HUB_REQUEST',
        action: 'TRIGGER_IN_PAGE_FETCH',
        botId: BOT_ID
      }, '*');
    } catch (_) {}

    // Transmit DOM auto-fetch result to background
    try {
      chrome.runtime.sendMessage({
        action: 'AUTO_FETCH_RESULT',
        data: result
      });
    } catch (_) {}

    isFetching = false;
    return result;
  }

  function checkDomForLimitNotice() {
    const allDivs = document.querySelectorAll('div, p, span, h3');
    for (const el of allDivs) {
      const text = el.textContent || '';
      if (
        text.includes("limit will reset at") ||
        text.includes("out of free messages until") ||
        text.includes("messages remaining until") ||
        text.includes("reached your message limit")
      ) {
        return {
          resetsAt: parseResetTime(text),
          reason: text.slice(0, 160)
        };
      }
    }
    return null;
  }

  // 1. DOM Observer for Claude Rate Limits & Badges
  const observer = new MutationObserver(() => {
    const limitInfo = checkDomForLimitNotice();
    if (limitInfo) {
      try {
        chrome.runtime.sendMessage({
          action: 'LIMIT_DETECTED',
          data: {
            botId: BOT_ID,
            resetsAt: limitInfo.resetsAt || (Date.now() + 5 * 3600 * 1000),
            reason: limitInfo.reason
          }
        });
      } catch (e) {}
    }

    // Look for Pro / Team badge
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

  // 2. Track Prompt Submissions & Trigger Immediate Sync Afterwards
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

    // Detect model
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

    // Auto-fetch updated quota 3 seconds after sending prompt
    setTimeout(autoFetchClaudeUsage, 3000);
  }

  // 3. Listen for on-demand fetch requests from background or popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'TRIGGER_AUTO_FETCH' && (message.botId === BOT_ID || !message.botId)) {
      autoFetchClaudeUsage().then((res) => {
        sendResponse({ success: true, data: res });
      });
      return true;
    }
  });

  // 4. Run on load and periodically every 2 minutes while tab is open
  autoFetchClaudeUsage();
  setInterval(() => {
    if (Date.now() - lastFetchTs >= 120000) {
      autoFetchClaudeUsage();
    }
  }, 120000);

  console.log('[AI Usage Limits] Claude DOM watcher & live auto-fetcher active');
})();
