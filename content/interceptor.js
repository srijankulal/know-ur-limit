/**
 * AI Usage Limits Hub - MAIN World Network Interceptor
 * Runs directly in the web page context to inspect fetch and XHR responses.
 */

(function () {
  'use strict';

  if (window.__AI_LIMITS_INTERCEPTOR_INSTALLED__) return;
  window.__AI_LIMITS_INTERCEPTOR_INSTALLED__ = true;

  const EVENT_SOURCE = 'AI_LIMITS_HUB';

  function dispatchToBridge(type, payload) {
    try {
      window.postMessage(
        {
          source: EVENT_SOURCE,
          type: type,
          payload: payload,
          timestamp: Date.now()
        },
        '*'
      );
    } catch (e) {
      console.warn('[AI Limits Interceptor] Failed to dispatch message:', e);
    }
  }

  // Identify current host
  const host = window.location.hostname;
  let botId = null;
  if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) {
    botId = 'chatgpt';
  } else if (host.includes('claude.ai')) {
    botId = 'claude';
  } else if (host.includes('gemini.google.com')) {
    botId = 'gemini';
  } else if (host.includes('deepseek.com')) {
    botId = 'deepseek';
  }

  if (!botId) return;

  // Signal heartbeat on load
  dispatchToBridge('HEARTBEAT', { botId });

  // ----------------------------------------------------
  // Helper Parsers
  // ----------------------------------------------------
  function parseTimeStringToTimestamp(timeStr) {
    if (!timeStr) return null;
    try {
      // Check if it's already an ISO or timestamp
      const directDate = new Date(timeStr);
      if (!isNaN(directDate.getTime())) {
        return directDate.getTime();
      }

      // Check format like "3:45 PM" or "15:30"
      const match = timeStr.match(/(\d{1,2}):(\d{2})(?:\s*([AaPpMm]{2}))?/);
      if (match) {
        let hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const ampm = match[3] ? match[3].toUpperCase() : null;

        if (ampm === 'PM' && hours < 12) hours += 12;
        if (ampm === 'AM' && hours === 12) hours = 0;

        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
        // If target time is before now, it's tomorrow
        if (target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 1);
        }
        return target.getTime();
      }
    } catch (e) {
      // Ignore parse failure
    }
    return null;
  }

  // ----------------------------------------------------
  // 1. Fetch Interception
  // ----------------------------------------------------
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const options = args[1] || {};
    const method = (options.method || 'GET').toUpperCase();

    // Track Outgoing Prompts
    try {
      if (botId === 'chatgpt' && url.includes('/backend-api/conversation') && method === 'POST') {
        let model = 'gpt-4o';
        try {
          if (options.body && typeof options.body === 'string') {
            const bodyObj = JSON.parse(options.body);
            if (bodyObj.model) model = bodyObj.model;
          }
        } catch (_) {}
        dispatchToBridge('PROMPT_SENT', { botId, model });
        setTimeout(performCurrentBotSync, 3500);
      } else if (botId === 'claude' && (url.includes('/chat_conversations') || url.includes('/completion')) && method === 'POST') {
        let model = 'claude-3-5-sonnet';
        try {
          if (options.body && typeof options.body === 'string') {
            const bodyObj = JSON.parse(options.body);
            if (bodyObj.model) model = bodyObj.model;
          }
        } catch (_) {}
        dispatchToBridge('PROMPT_SENT', { botId, model });
        setTimeout(performCurrentBotSync, 3500);
      } else if (botId === 'gemini' && (url.includes('BardChatUi') || url.includes('BardFrontendService')) && method === 'POST') {
        dispatchToBridge('PROMPT_SENT', { botId, model: 'gemini-2.0-flash' });
      } else if (botId === 'deepseek' && url.includes('/chat/completion') && method === 'POST') {
        dispatchToBridge('PROMPT_SENT', { botId, model: 'deepseek-chat' });
        setTimeout(performCurrentBotSync, 3500);
      }
    } catch (err) {
      // Don't fail the user's fetch request
    }

    // Call native fetch
    let response;
    try {
      response = await originalFetch.apply(this, args);
    } catch (err) {
      throw err;
    }

    // Inspect Response
    try {
      // 1. ChatGPT
      if (botId === 'chatgpt') {
        if (url.includes('/backend-api/wham/usage') && response.ok) {
          const clone = response.clone();
          clone.json().then(data => {
            let tier = 'plus';
            if (data?.plan_type) {
              const p = String(data.plan_type).toLowerCase();
              if (p.includes('pro')) tier = 'pro';
              else if (p.includes('team')) tier = 'team';
              else if (p.includes('plus')) tier = 'plus';
              else tier = 'free';
            }
            let usedPercent = null;
            let usedCount = null;
            let pendingCount = null;
            let resetsAt = null;
            const rl = data?.rate_limit?.primary_window || data?.rate_limit;
            if (rl) {
              if (typeof rl.used === 'number' && typeof rl.limit === 'number') {
                usedCount = rl.used;
                pendingCount = Math.max(0, rl.limit - rl.used);
                usedPercent = Math.round((rl.used / rl.limit) * 100);
              } else if (typeof rl.used_percent === 'number') {
                usedPercent = rl.used_percent <= 1 && rl.used_percent > 0 ? Math.round(rl.used_percent * 100) : Math.round(rl.used_percent);
              }
              if (typeof rl.reset_after_seconds === 'number' && rl.reset_after_seconds > 0) {
                resetsAt = Date.now() + (rl.reset_after_seconds * 1000);
              } else if (rl.resets_at) {
                const p = new Date(rl.resets_at).getTime();
                if (!isNaN(p)) resetsAt = p;
              }
            }
            dispatchToBridge('AUTO_FETCH_RESULT', {
              botId,
              isLoggedIn: true,
              tier,
              usedPercent,
              usedCount,
              pendingCount,
              resetsAt,
              quotaWindows: data,
              fetchStatus: 'synced'
            });
          }).catch(() => {});
        } else if (url.includes('/backend-api/accounts/check') && response.ok) {
          const clone = response.clone();
          clone.json().then(data => {
            const plan = data?.account?.plan_type || data?.plan_type;
            if (plan) {
              const mapped = plan.includes('plus') ? 'plus' : plan.includes('team') ? 'team' : plan.includes('pro') ? 'pro' : 'free';
              dispatchToBridge('PLAN_DETECTED', { botId, plan: mapped });
            }
          }).catch(() => {});
        } else if (response.status === 429) {
          const clone = response.clone();
          clone.text().then(text => {
            let resetsAt = null;
            let reason = 'ChatGPT usage limit reached';
            try {
              const data = JSON.parse(text);
              if (data?.detail?.clears_in) {
                resetsAt = Date.now() + (data.detail.clears_in * 1000);
              } else if (data?.detail?.resets_at) {
                resetsAt = data.detail.resets_at * 1000;
              } else if (data?.detail?.message) {
                reason = data.detail.message;
                resetsAt = parseTimeStringToTimestamp(reason);
              }
            } catch (_) {
              resetsAt = parseTimeStringToTimestamp(text);
            }
            dispatchToBridge('LIMIT_DETECTED', {
              botId,
              resetsAt: resetsAt || (Date.now() + 3 * 3600 * 1000),
              reason
            });
          }).catch(() => {});
        }
      }

      // 2. Claude
      else if (botId === 'claude') {
        if (url.includes('/api/organizations/') && url.includes('/usage') && response.ok) {
          const clone = response.clone();
          clone.json().then(data => {
            let usedPercent = null;
            let usedCount = null;
            let pendingCount = null;
            let resetsAt = null;
            if (data?.five_hour) {
              const util = data.five_hour.utilization;
              if (typeof util === 'number') {
                usedPercent = util <= 1.0 && util > 0 ? Math.round(util * 100) : Math.round(util);
                const defaultCap = 45;
                usedCount = Math.round((usedPercent / 100) * defaultCap);
                pendingCount = Math.max(0, defaultCap - usedCount);
              }
              if (data.five_hour.resets_at) {
                const p = new Date(data.five_hour.resets_at).getTime();
                if (!isNaN(p)) resetsAt = p;
              }
            }
            dispatchToBridge('AUTO_FETCH_RESULT', {
              botId,
              isLoggedIn: true,
              usedPercent,
              usedCount,
              pendingCount,
              resetsAt,
              quotaWindows: data,
              fetchStatus: 'synced'
            });
          }).catch(() => {});
        } else if (url.includes('/api/organizations') && !url.includes('/chat_conversations') && response.ok) {
          const clone = response.clone();
          clone.json().then(data => {
            const orgs = Array.isArray(data) ? data : [data];
            for (const org of orgs) {
              const caps = org?.capabilities || [];
              const tier = caps.includes('claude_team') ? 'team' : (caps.includes('claude_pro') || org?.has_active_subscription) ? 'pro' : 'free';
              dispatchToBridge('PLAN_DETECTED', { botId, plan: tier });
              break;
            }
          }).catch(() => {});
        } else if (response.status === 429) {
          const clone = response.clone();
          clone.text().then(text => {
            let resetsAt = null;
            let reason = 'Claude usage limit reached';
            try {
              const data = JSON.parse(text);
              if (data?.error?.resetsAt || data?.resetsAt) {
                resetsAt = new Date(data?.error?.resetsAt || data?.resetsAt).getTime();
              } else if (data?.error?.message) {
                reason = data.error.message;
                resetsAt = parseTimeStringToTimestamp(reason);
              }
            } catch (_) {
              resetsAt = parseTimeStringToTimestamp(text);
            }
            dispatchToBridge('LIMIT_DETECTED', {
              botId,
              resetsAt: resetsAt || (Date.now() + 5 * 3600 * 1000),
              reason
            });
          }).catch(() => {});
        }
      }

      // 3. Gemini
      else if (botId === 'gemini') {
        if (response.status === 429) {
          dispatchToBridge('LIMIT_DETECTED', {
            botId,
            resetsAt: Date.now() + 24 * 3600 * 1000,
            reason: 'Gemini daily quota limit hit'
          });
        }
      }

      // 4. DeepSeek
      else if (botId === 'deepseek') {
        if (response.status === 429) {
          dispatchToBridge('LIMIT_DETECTED', {
            botId,
            resetsAt: Date.now() + 3600 * 1000,
            reason: 'DeepSeek rate limit reached'
          });
        }
      }
    } catch (e) {
      // Ignore inspection errors
    }

    return response;
  };

  // ----------------------------------------------------
  // 2. XMLHttpRequest Interception
  // ----------------------------------------------------
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__aiUrl = url;
    this.__aiMethod = method;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__aiUrl && typeof this.__aiUrl === 'string') {
      const url = this.__aiUrl;
      const method = (this.__aiMethod || 'GET').toUpperCase();

      if (botId === 'gemini' && (url.includes('BardChatUi') || url.includes('BardFrontendService')) && method === 'POST') {
        dispatchToBridge('PROMPT_SENT', { botId, model: 'gemini-2.0-flash' });
      }

      this.addEventListener('load', function () {
        if (this.status === 429) {
          dispatchToBridge('LIMIT_DETECTED', {
            botId,
            resetsAt: Date.now() + 3600 * 1000,
            reason: `${botId.toUpperCase()} rate limit (429)`
          });
        }
      });
    }

    return originalSend.apply(this, arguments);
  };

  // ----------------------------------------------------
  // 3. Active In-Page Fetcher (Bypasses MV3 CSP & CORS)
  // ----------------------------------------------------
  let isSyncing = false;

  async function performInPageClaudeSync() {
    try {
      const orgResp = await originalFetch('/api/organizations', {
        headers: { 'Accept': 'application/json' }
      });

      if (!orgResp.ok) {
        if (orgResp.status === 401 || (orgResp.redirected && orgResp.url.includes('/login'))) {
          dispatchToBridge('AUTO_FETCH_RESULT', {
            botId: 'claude',
            isLoggedIn: false,
            fetchStatus: 'login_required'
          });
        }
        return;
      }

      const orgs = await orgResp.json();
      const orgList = Array.isArray(orgs) ? orgs : (orgs?.items || [orgs]);
      if (!orgList.length || !orgList[0]?.id) return;

      const primaryOrg = orgList[0];
      const orgId = primaryOrg.id;
      const caps = primaryOrg.capabilities || [];
      let tier = 'free';
      if (caps.includes('claude_team') || primaryOrg.has_team_subscription) {
        tier = 'team';
      } else if (caps.includes('claude_pro') || primaryOrg.has_active_subscription) {
        tier = 'pro';
      }

      let usedPercent = null;
      let usedCount = null;
      let pendingCount = null;
      let resetsAt = null;
      let quotaWindows = null;
      let accountEmail = null;
      let isLimited = false;
      let limitReason = null;

      if (orgId) {
        try {
          const usageResp = await originalFetch(`/api/organizations/${orgId}/usage`, {
            headers: { 'Accept': 'application/json' }
          });
          if (usageResp.ok) {
            quotaWindows = await usageResp.json();
            if (quotaWindows?.five_hour) {
              const util = quotaWindows.five_hour.utilization;
              if (typeof util === 'number') {
                usedPercent = util <= 1.0 && util > 0 ? Math.round(util * 100) : Math.round(util);
                const defaultCap = tier === 'pro' ? 45 : tier === 'team' ? 90 : 12;
                usedCount = Math.round((usedPercent / 100) * defaultCap);
                pendingCount = Math.max(0, defaultCap - usedCount);
              }
              if (quotaWindows.five_hour.resets_at) {
                const parsed = new Date(quotaWindows.five_hour.resets_at).getTime();
                if (!isNaN(parsed)) resetsAt = parsed;
              }
              if (usedPercent !== null && usedPercent >= 100) {
                isLimited = true;
                limitReason = 'Claude 5-hour quota reached';
              }
            }
          }
        } catch (_) {}
      }

      try {
        const userResp = await originalFetch('/api/auth/current_user', {
          headers: { 'Accept': 'application/json' }
        });
        if (userResp.ok) {
          const userData = await userResp.json();
          accountEmail = userData.email_address || userData.email || null;
        }
      } catch (_) {}

      dispatchToBridge('AUTO_FETCH_RESULT', {
        botId: 'claude',
        isLoggedIn: true,
        tier,
        usedPercent,
        usedCount,
        pendingCount,
        resetsAt,
        quotaWindows,
        accountEmail,
        isLimited,
        limitReason,
        fetchStatus: 'synced'
      });
      dispatchToBridge('PLAN_DETECTED', { botId: 'claude', plan: tier });
    } catch (err) {
      console.debug('[AI Limits Interceptor] In-page Claude sync note:', err.message);
    }
  }

  async function performInPageChatGPTSync() {
    try {
      const sessionResp = await originalFetch('/api/auth/session', {
        headers: { 'Accept': 'application/json' }
      });
      if (!sessionResp.ok) {
        if (sessionResp.status === 401 || (sessionResp.redirected && sessionResp.url.includes('/login'))) {
          dispatchToBridge('AUTO_FETCH_RESULT', {
            botId: 'chatgpt',
            isLoggedIn: false,
            fetchStatus: 'login_required'
          });
        }
        return;
      }

      const sessionData = await sessionResp.json();
      const token = sessionData?.accessToken;
      if (!token) return;

      let tier = 'plus';
      let usedPercent = null;
      let usedCount = null;
      let pendingCount = null;
      let resetsAt = null;
      let quotaWindows = null;
      let isLimited = false;
      let limitReason = null;

      const accountId = sessionData?.account?.id || sessionData?.user?.id || sessionData?.accountId || '';
      const authHeaders = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      };
      if (accountId) {
        authHeaders['ChatGPT-Account-Id'] = accountId;
      }

      try {
        const usageResp = await originalFetch('/backend-api/wham/usage', {
          headers: authHeaders
        });
        if (usageResp.ok) {
          quotaWindows = await usageResp.json();
          if (quotaWindows?.plan_type) {
            const planStr = String(quotaWindows.plan_type).toLowerCase();
            if (planStr.includes('pro')) tier = 'pro';
            else if (planStr.includes('team')) tier = 'team';
            else if (planStr.includes('plus')) tier = 'plus';
            else tier = 'free';
          }
          const rateLimit = quotaWindows.rate_limit?.primary_window || quotaWindows.rate_limit;
          if (rateLimit) {
            if (typeof rateLimit.used === 'number' && typeof rateLimit.limit === 'number') {
              usedCount = rateLimit.used;
              pendingCount = Math.max(0, rateLimit.limit - rateLimit.used);
              usedPercent = Math.round((rateLimit.used / rateLimit.limit) * 100);
            } else if (typeof rateLimit.used_percent === 'number') {
              const util = rateLimit.used_percent;
              usedPercent = util <= 1.0 && util > 0 ? Math.round(util * 100) : Math.round(util);
            }
            if (typeof rateLimit.reset_after_seconds === 'number' && rateLimit.reset_after_seconds > 0) {
              resetsAt = Date.now() + (rateLimit.reset_after_seconds * 1000);
            } else if (rateLimit.resets_at) {
              const p = new Date(rateLimit.resets_at).getTime();
              if (!isNaN(p)) resetsAt = p;
            }
            if (usedPercent !== null && usedPercent >= 100) {
              isLimited = true;
              limitReason = 'ChatGPT rolling window cap reached';
            }
          }
        }
      } catch (_) {}

      dispatchToBridge('AUTO_FETCH_RESULT', {
        botId: 'chatgpt',
        isLoggedIn: true,
        tier,
        usedPercent,
        usedCount,
        pendingCount,
        resetsAt,
        quotaWindows,
        accountEmail: sessionData.user?.email || null,
        isLimited,
        limitReason,
        fetchStatus: 'synced'
      });
      dispatchToBridge('PLAN_DETECTED', { botId: 'chatgpt', plan: tier });
    } catch (err) {
      console.debug('[AI Limits Interceptor] In-page ChatGPT sync note:', err.message);
    }
  }

  async function performInPageDeepSeekSync() {
    try {
      const userResp = await originalFetch('/api/v0/users/current', {
        headers: { 'Accept': 'application/json' }
      });
      if (userResp.ok) {
        const userData = await userResp.json();
        if (userData?.code === 0 && userData?.data) {
          dispatchToBridge('AUTO_FETCH_RESULT', {
            botId: 'deepseek',
            isLoggedIn: true,
            tier: 'free',
            accountEmail: userData.data.email || userData.data.phone || userData.data.name || null,
            fetchStatus: 'synced'
          });
        }
      }
    } catch (_) {}
  }

  async function performCurrentBotSync() {
    if (isSyncing) return;
    isSyncing = true;
    try {
      if (botId === 'claude') {
        await performInPageClaudeSync();
      } else if (botId === 'chatgpt') {
        await performInPageChatGPTSync();
      } else if (botId === 'deepseek') {
        await performInPageDeepSeekSync();
      }
    } finally {
      isSyncing = false;
    }
  }

  // Listen for sync triggers from content script / bridge
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'AI_LIMITS_HUB_REQUEST') return;
    if (event.data.action === 'TRIGGER_IN_PAGE_FETCH') {
      performCurrentBotSync();
    }
  });

  // Automatically sync on page load with slight debounce
  setTimeout(performCurrentBotSync, 1500);

  // Periodic in-page sync every 2 minutes
  setInterval(performCurrentBotSync, 120000);

  console.log(`[AI Usage Limits] Active network monitor hooked for ${botId}`);
})();
