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
      } else if (botId === 'claude' && (url.includes('/chat_conversations') || url.includes('/completion')) && method === 'POST') {
        let model = 'claude-3-5-sonnet';
        try {
          if (options.body && typeof options.body === 'string') {
            const bodyObj = JSON.parse(options.body);
            if (bodyObj.model) model = bodyObj.model;
          }
        } catch (_) {}
        dispatchToBridge('PROMPT_SENT', { botId, model });
      } else if (botId === 'gemini' && (url.includes('BardChatUi') || url.includes('BardFrontendService')) && method === 'POST') {
        dispatchToBridge('PROMPT_SENT', { botId, model: 'gemini-2.0-flash' });
      } else if (botId === 'deepseek' && url.includes('/chat/completion') && method === 'POST') {
        dispatchToBridge('PROMPT_SENT', { botId, model: 'deepseek-chat' });
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
        if (url.includes('/backend-api/accounts/check') && response.ok) {
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
        if (url.includes('/api/organizations') && !url.includes('/chat_conversations') && response.ok) {
          const clone = response.clone();
          clone.json().then(data => {
            const orgs = Array.isArray(data) ? data : [data];
            for (const org of orgs) {
              const caps = org?.capabilities || [];
              const tier = caps.includes('claude_pro') || org?.has_active_subscription ? 'pro' : 'free';
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

  console.log(`[AI Usage Limits] Active network monitor hooked for ${botId}`);
})();
