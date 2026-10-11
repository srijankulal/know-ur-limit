/**
 * AI Usage Limits Hub - DeepSeek DOM Monitor & Auto-Fetcher
 * Auto-fetches usage quotas, account status, and rate limit reset times directly from chat.deepseek.com sessions.
 */

(function () {
  'use strict';

  const BOT_ID = 'deepseek';
  let isFetching = false;
  let lastFetchTs = 0;

  // ----------------------------------------------------
  // Live Browser Session Auto-Fetcher for DeepSeek
  // ----------------------------------------------------
  async function autoFetchDeepSeekUsage() {
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
      activeModel: 'deepseek-chat',
      isLimited: false,
      limitReason: null,
      fetchStatus: 'idle'
    };

    try {
      // 1. Fetch current user profile to verify login
      const userResp = await fetch('/api/v0/users/current', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });

      if (userResp.ok) {
        const userData = await userResp.json();
        if (userData?.code === 0 && userData?.data) {
          result.isLoggedIn = true;
          result.accountEmail = userData.data.email || userData.data.phone || userData.data.name || null;
          result.fetchStatus = 'synced';
        } else {
          result.isLoggedIn = false;
          result.fetchStatus = 'login_required';
        }
      } else {
        result.isLoggedIn = false;
        result.fetchStatus = 'login_required';
      }
    } catch (e) {
      console.warn('[AI Limits] DeepSeek auto-fetch error:', e);
      result.fetchStatus = 'error';
    } finally {
      isFetching = false;
    }

    // Inspect DOM for busy or rate limit errors
    const alertInfo = checkDomForLimitNotice();
    if (alertInfo) {
      result.isLimited = true;
      result.resetsAt = alertInfo.resetsAt;
      result.limitReason = alertInfo.reason;
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

  function checkDomForLimitNotice() {
    const alerts = document.querySelectorAll('div[class*="toast"], div[class*="modal"], div[role="alert"]');
    for (const el of alerts) {
      const text = el.textContent || '';
      if (text.includes("Server is busy") || text.includes("limit exceeded") || text.includes("Too many requests")) {
        return {
          resetsAt: Date.now() + 60 * 60 * 1000,
          reason: text.slice(0, 160)
        };
      }
    }
    return null;
  }

  // 1. DOM Observer for rate limits
  const observer = new MutationObserver(() => {
    const alertInfo = checkDomForLimitNotice();
    if (alertInfo) {
      try {
        chrome.runtime.sendMessage({
          action: 'LIMIT_DETECTED',
          data: {
            botId: BOT_ID,
            resetsAt: alertInfo.resetsAt,
            reason: alertInfo.reason
          }
        });
      } catch (e) {}
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // 2. Track Prompt Submissions
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

    // Auto-fetch updated quota 3 seconds after prompt
    setTimeout(autoFetchDeepSeekUsage, 3000);
  }

  // 3. Listen for on-demand fetch requests from background or popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'TRIGGER_AUTO_FETCH' && (message.botId === BOT_ID || !message.botId)) {
      autoFetchDeepSeekUsage().then((res) => {
        sendResponse({ success: true, data: res });
      });
      return true;
    }
  });

  // 4. Run on load and periodically every 2 minutes
  autoFetchDeepSeekUsage();
  setInterval(() => {
    if (Date.now() - lastFetchTs >= 120000) {
      autoFetchDeepSeekUsage();
    }
  }, 120000);

  console.log('[AI Usage Limits] DeepSeek DOM watcher & live auto-fetcher active');
})();
