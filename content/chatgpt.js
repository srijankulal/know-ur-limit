/**
 * AI Usage Limits Hub - ChatGPT DOM Monitor & Auto-Fetcher
 * Auto-fetches usage quotas, plan tier, and rate limit reset times directly from chatgpt.com browser sessions.
 */

(function () {
  'use strict';

  const BOT_ID = 'chatgpt';
  let isFetching = false;
  let lastFetchTs = 0;

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

  // ----------------------------------------------------
  // Live Browser Session Auto-Fetcher for ChatGPT
  // ----------------------------------------------------
  async function autoFetchChatGPTUsage() {
    if (isFetching) return;
    isFetching = true;
    lastFetchTs = Date.now();

    const result = {
      botId: BOT_ID,
      isLoggedIn: false,
      tier: 'plus',
      usedPercent: null,
      resetsAt: null,
      quotaWindows: null,
      accountEmail: null,
      activeModel: 'gpt-4o',
      isLimited: false,
      limitReason: null,
      fetchStatus: 'idle'
    };

    try {
      // 1. Fetch user session from ChatGPT web client
      const sessionResp = await fetch('/api/auth/session', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });

      if (!sessionResp.ok) {
        result.isLoggedIn = false;
        result.fetchStatus = 'login_required';
      } else {
        const sessionData = await sessionResp.json();
        const token = sessionData?.accessToken;

        if (token) {
          result.isLoggedIn = true;
          result.fetchStatus = 'synced';
          if (sessionData.user?.email) {
            result.accountEmail = sessionData.user.email;
          }

          const accountId = sessionData?.account?.id || sessionData?.user?.id || sessionData?.accountId || '';
          const authHeaders = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          };
          if (accountId) {
            authHeaders['ChatGPT-Account-Id'] = accountId;
          }

          // 2. Query usage limits & rate limit window (wham/usage)
          try {
            const usageResp = await fetch('/backend-api/wham/usage', {
              credentials: 'include',
              headers: authHeaders
            });

            if (usageResp.ok) {
              const usageData = await usageResp.json();
              result.quotaWindows = usageData;

              // Parse plan
              if (usageData.plan_type) {
                const planStr = String(usageData.plan_type).toLowerCase();
                if (planStr.includes('pro')) result.tier = 'pro';
                else if (planStr.includes('team')) result.tier = 'team';
                else if (planStr.includes('plus')) result.tier = 'plus';
                else result.tier = 'free';
              }

              // Parse rate limits
              const rateLimit = usageData.rate_limit?.primary_window || usageData.rate_limit;
              if (rateLimit) {
                if (typeof rateLimit.used === 'number' && typeof rateLimit.limit === 'number') {
                  result.usedCount = rateLimit.used;
                  result.pendingCount = Math.max(0, rateLimit.limit - rateLimit.used);
                  result.usedPercent = Math.round((rateLimit.used / rateLimit.limit) * 100);
                } else if (typeof rateLimit.used_percent === 'number') {
                  const util = rateLimit.used_percent;
                  result.usedPercent = util <= 1.0 && util > 0 ? Math.round(util * 100) : Math.round(util);
                }

                if (typeof rateLimit.reset_after_seconds === 'number' && rateLimit.reset_after_seconds > 0) {
                  result.resetsAt = Date.now() + (rateLimit.reset_after_seconds * 1000);
                } else if (rateLimit.resets_at) {
                  const p = new Date(rateLimit.resets_at).getTime();
                  if (!isNaN(p)) result.resetsAt = p;
                }

                if (result.usedPercent !== null && result.usedPercent >= 100) {
                  result.isLimited = true;
                  result.limitReason = 'ChatGPT rolling window cap reached';
                }
              }
            }
          } catch (e) {
            console.log('[AI Limits] ChatGPT wham/usage note:', e.message);
          }

          // 3. Fallback to accounts/check for plan verification if needed
          if (!result.quotaWindows) {
            try {
              const accResp = await fetch('/backend-api/accounts/check/v4-2023-04-27', {
                credentials: 'include',
                headers: authHeaders
              });
              if (accResp.ok) {
                const accData = await accResp.json();
                const plan = accData?.account?.plan_type || accData?.plan_type;
                if (plan) {
                  const planStr = String(plan).toLowerCase();
                  if (planStr.includes('pro')) result.tier = 'pro';
                  else if (planStr.includes('team')) result.tier = 'team';
                  else if (planStr.includes('plus')) result.tier = 'plus';
                  else result.tier = 'free';
                }
              }
            } catch (_) {}
          }
        } else {
          result.isLoggedIn = false;
          result.fetchStatus = 'login_required';
        }
      }
    } catch (e) {
      console.warn('[AI Limits] ChatGPT auto-fetch error:', e);
      result.fetchStatus = 'error';
    } finally {
      isFetching = false;
    }

    // Fallback: Verify authentication from DOM if API response was unavailable
    const hasTextarea = !!document.querySelector('#prompt-textarea, [data-testid="send-button"]');
    const onAuthPage = window.location.pathname.includes('/auth/');
    if (hasTextarea && !onAuthPage) {
      result.isLoggedIn = true;
      if (result.fetchStatus === 'login_required' || result.fetchStatus === 'idle' || result.fetchStatus === 'error') {
        result.fetchStatus = 'synced';
      }
    }

    // Trigger in-page fetch via MAIN world interceptor
    try {
      window.postMessage({
        source: 'AI_LIMITS_HUB_REQUEST',
        action: 'TRIGGER_IN_PAGE_FETCH',
        botId: BOT_ID
      }, '*');
    } catch (_) {}

    // Inspect DOM for active model and UI badges
    const detectedModel = detectModelFromDom();
    if (detectedModel) result.activeModel = detectedModel;

    const detectedPlan = detectPlanFromDom();
    if (detectedPlan) result.tier = detectedPlan;

    // Check DOM for fallback rate limit notices
    if (!result.isLimited) {
      const bannerMatch = checkDomForLimitNotice();
      if (bannerMatch) {
        result.isLimited = true;
        result.resetsAt = bannerMatch.resetsAt || result.resetsAt || (Date.now() + 3 * 3600 * 1000);
        result.limitReason = bannerMatch.reason;
      }
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

  function detectModelFromDom() {
    const modelBtn = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
    if (modelBtn && modelBtn.textContent) {
      const txt = modelBtn.textContent.toLowerCase();
      if (txt.includes('o1-mini')) return 'o1-mini';
      if (txt.includes('o1')) return 'o1-preview';
      if (txt.includes('o3-mini')) return 'o3-mini';
      if (txt.includes('4o-mini')) return 'gpt-4o-mini';
      if (txt.includes('4o')) return 'gpt-4o';
    }
    return null;
  }

  function detectPlanFromDom() {
    const badges = document.querySelectorAll('span, button, div');
    for (const el of badges) {
      const txt = (el.textContent || '').trim();
      if (txt === 'ChatGPT Plus') return 'plus';
      if (txt === 'ChatGPT Pro') return 'pro';
      if (txt === 'ChatGPT Team') return 'team';
    }
    return null;
  }

  function checkDomForLimitNotice() {
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
        return {
          resetsAt: parseResetTime(text),
          reason: text.slice(0, 160)
        };
      }
    }
    return null;
  }

  // 1. DOM Observer for Error Toasts and Limit Messages
  const observer = new MutationObserver(() => {
    const banner = checkDomForLimitNotice();
    if (banner) {
      try {
        chrome.runtime.sendMessage({
          action: 'LIMIT_DETECTED',
          data: {
            botId: BOT_ID,
            resetsAt: banner.resetsAt || (Date.now() + 3 * 3600 * 1000),
            reason: banner.reason
          }
        });
      } catch (e) {}
    }

    const plan = detectPlanFromDom();
    if (plan) notifyPlan(plan);
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
    if (now - lastSentTs < 1000) return;
    lastSentTs = now;

    const model = detectModelFromDom() || 'gpt-4o';

    try {
      chrome.runtime.sendMessage({
        action: 'PROMPT_SENT',
        data: { botId: BOT_ID, model }
      });
    } catch (e) {}

    // Auto-fetch updated quota 3 seconds after sending prompt
    setTimeout(autoFetchChatGPTUsage, 3000);
  }

  // 3. Listen for on-demand fetch requests from background or popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'TRIGGER_AUTO_FETCH' && (message.botId === BOT_ID || !message.botId)) {
      autoFetchChatGPTUsage().then((res) => {
        sendResponse({ success: true, data: res });
      });
      return true;
    }
  });

  // 4. Run on load and periodically every 2 minutes while tab is open
  autoFetchChatGPTUsage();
  setInterval(() => {
    if (Date.now() - lastFetchTs >= 120000) {
      autoFetchChatGPTUsage();
    }
  }, 120000);

  console.log('[AI Usage Limits] ChatGPT DOM watcher & live auto-fetcher active');
})();
