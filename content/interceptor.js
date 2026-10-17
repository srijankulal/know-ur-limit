/**
 * Know Ur Limit - MAIN World Network Interceptor & Live Telemetry Engine
 * Runs directly in the web page context (MAIN world) to inspect fetch/XHR/SSE responses
 * and query real provider usage limits, quota windows, and token counts.
 */

(function () {
  'use strict';

  if (window.__AI_LIMITS_INTERCEPTOR_INSTALLED__) return;
  window.__AI_LIMITS_INTERCEPTOR_INSTALLED__ = true;

  const EVENT_SOURCE = 'AI_LIMITS_HUB';

  // Live telemetry state captured from network streams & headers
  const liveTelemetry = (window.__AI_LIMITS_TELEMETRY__ = window.__AI_LIMITS_TELEMETRY__ || {
    inputTokens: null,
    outputTokens: null,
    tokensUsed: null,
    tokenLimit: null,
    tokensRemaining: null,
    activeModel: null,
    lastUpdated: null
  });

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
      console.warn('[Know Ur Limit] Failed to dispatch message:', e);
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

  dispatchToBridge('HEARTBEAT', { botId });

  // ----------------------------------------------------
  // Helpers
  // ----------------------------------------------------
  function estimateTokensFromText(text) {
    if (!text || typeof text !== 'string') return 0;
    // Standard BPE approximation (~3.8 chars per token for English/code mix)
    return Math.ceil(text.length / 3.8);
  }

  function normalizeResetTimestamp(val) {
    if (!val) return null;
    if (typeof val === 'number') {
      return val < 1e12 ? Math.round(val * 1000) : Math.round(val);
    }
    if (typeof val === 'string') {
      const num = Number(val);
      if (!isNaN(num) && num > 1e9) {
        return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
      }
      const parsed = new Date(val).getTime();
      if (!isNaN(parsed)) return parsed;
    }
    return null;
  }

  function parseTimeStringToTimestamp(timeStr) {
    if (!timeStr) return null;
    try {
      const directDate = new Date(timeStr);
      if (!isNaN(directDate.getTime()) && timeStr.includes('-')) {
        return directDate.getTime();
      }
      const match = timeStr.match(/(\d{1,2}):(\d{2})(?:\s*([AaPpMm]{2}))?/);
      if (match) {
        let hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const ampm = match[3] ? match[3].toUpperCase() : null;
        if (ampm === 'PM' && hours < 12) hours += 12;
        if (ampm === 'AM' && hours === 12) hours = 0;

        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
        if (target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 1);
        }
        return target.getTime();
      }
    } catch (_) {}
    return null;
  }

  function getDeepSeekBearerToken() {
    try {
      const raw = localStorage.getItem('userToken');
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.value === 'string' && parsed.value.trim()) {
            return parsed.value.trim();
          }
        } catch (_) {
          if (typeof raw === 'string' && raw.trim()) return raw.trim();
        }
      }
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.toLowerCase().includes('token')) {
          const v = localStorage.getItem(k);
          try {
            const p = JSON.parse(v);
            if (p && typeof p.value === 'string' && p.value.length > 20) return p.value;
          } catch (_) {
            if (v && v.length > 20 && !v.startsWith('{')) return v;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  // Inspect SSE stream chunks without consuming the original response stream
  function inspectSSEStream(response, onEventJson) {
    try {
      if (!response.body) return;
      const clone = response.clone();
      const reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data:')) {
                const dataStr = trimmed.slice(5).trim();
                if (dataStr && dataStr !== '[DONE]') {
                  try {
                    const json = JSON.parse(dataStr);
                    onEventJson(json);
                  } catch (_) {}
                }
              }
            }
          }
        } catch (_) {}
      })();
    } catch (_) {}
  }

  // ----------------------------------------------------
  // 1. Fetch Interception (Captures Live API & SSE Tokens)
  // ----------------------------------------------------
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const options = args[1] || {};
    const method = (options.method || 'GET').toUpperCase();

    // Detect outgoing chat completion requests to trigger post-response sync
    try {
      if (botId === 'chatgpt' && url.includes('/conversation') && method === 'POST') {
        setTimeout(performCurrentBotSync, 4000);
      } else if (botId === 'claude' && (url.includes('/completion') || url.includes('/chat_conversations')) && method === 'POST') {
        setTimeout(performCurrentBotSync, 4000);
      } else if (botId === 'deepseek' && url.includes('/chat/completion') && method === 'POST') {
        setTimeout(performCurrentBotSync, 4000);
      } else if (botId === 'gemini' && (url.includes('StreamGenerate') || url.includes('BardChatUi')) && method === 'POST') {
        setTimeout(performCurrentBotSync, 4000);
      }
    } catch (_) {}

    const response = await originalFetch.apply(this, args);

    try {
      // Check standard rate-limit headers if present
      const hdrTokLimit = response.headers?.get('anthropic-ratelimit-tokens-limit') || response.headers?.get('x-ratelimit-limit-tokens');
      const hdrTokRem = response.headers?.get('anthropic-ratelimit-tokens-remaining') || response.headers?.get('x-ratelimit-remaining-tokens');
      if (hdrTokLimit && hdrTokRem) {
        const limitNum = parseInt(hdrTokLimit, 10);
        const remNum = parseInt(hdrTokRem, 10);
        if (!isNaN(limitNum) && !isNaN(remNum) && limitNum > 0) {
          liveTelemetry.tokenLimit = limitNum;
          liveTelemetry.tokensRemaining = remNum;
          liveTelemetry.tokensUsed = Math.max(0, limitNum - remNum);
          liveTelemetry.lastUpdated = Date.now();
        }
      }

      // 1. ChatGPT
      if (botId === 'chatgpt') {
        if (url.includes('/backend-api/wham/usage') && response.ok) {
          response.clone().json().then(data => {
            const parsed = parseChatGPTWhamUsage(data);
            dispatchToBridge('AUTO_FETCH_RESULT', {
              botId: 'chatgpt',
              isLoggedIn: true,
              ...parsed,
              fetchStatus: 'synced'
            });
          }).catch(() => {});
        } else if (url.includes('/conversation') && method === 'POST' && response.ok) {
          inspectSSEStream(response, (json) => {
            if (json?.message?.metadata?.model_slug) {
              liveTelemetry.activeModel = json.message.metadata.model_slug;
            }
          });
        } else if (response.status === 429) {
          response.clone().text().then(text => {
            let resetsAt = null;
            let reason = 'ChatGPT rate limit reached';
            try {
              const data = JSON.parse(text);
              if (data?.detail?.clears_in) {
                resetsAt = Date.now() + Number(data.detail.clears_in) * 1000;
              } else if (data?.detail?.resets_at || data?.detail?.reset_at) {
                resetsAt = normalizeResetTimestamp(data.detail.resets_at || data.detail.reset_at);
              } else if (data?.detail?.message) {
                reason = data.detail.message;
                resetsAt = parseTimeStringToTimestamp(reason);
              }
            } catch (_) {
              resetsAt = parseTimeStringToTimestamp(text);
            }
            dispatchToBridge('LIMIT_DETECTED', {
              botId: 'chatgpt',
              resetsAt,
              reason
            });
          }).catch(() => {});
        }
      }

      // 2. Claude
      else if (botId === 'claude') {
        if (url.includes('/api/organizations/') && url.includes('/usage') && response.ok) {
          response.clone().json().then(data => {
            const parsed = parseClaudeUsagePayload(data);
            dispatchToBridge('AUTO_FETCH_RESULT', {
              botId: 'claude',
              isLoggedIn: true,
              ...parsed,
              fetchStatus: 'synced'
            });
          }).catch(() => {});
        } else if (url.includes('/completion') && method === 'POST' && response.ok) {
          // Capture real input_tokens & output_tokens from Claude SSE stream
          inspectSSEStream(response, (json) => {
            const usage = json?.message?.usage || json?.usage;
            if (usage) {
              const inTok = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
              const outTok = usage.output_tokens || 0;
              if (inTok > 0) liveTelemetry.inputTokens = inTok;
              if (outTok > 0) liveTelemetry.outputTokens = outTok;
              liveTelemetry.tokensUsed = (liveTelemetry.inputTokens || 0) + (liveTelemetry.outputTokens || 0);
              liveTelemetry.tokenLimit = liveTelemetry.tokenLimit || 200000;
              liveTelemetry.tokensRemaining = Math.max(0, liveTelemetry.tokenLimit - liveTelemetry.tokensUsed);
              liveTelemetry.lastUpdated = Date.now();
            }
            if (json?.message?.model) {
              liveTelemetry.activeModel = json.message.model;
            }
          });
        } else if (response.status === 429) {
          response.clone().text().then(text => {
            let resetsAt = null;
            let reason = 'Claude usage limit reached';
            try {
              const data = JSON.parse(text);
              if (data?.error?.resetsAt || data?.error?.resets_at || data?.resetsAt || data?.resets_at) {
                resetsAt = normalizeResetTimestamp(data?.error?.resetsAt || data?.error?.resets_at || data?.resetsAt || data?.resets_at);
              } else if (data?.error?.message) {
                reason = data.error.message;
                resetsAt = parseTimeStringToTimestamp(reason);
              }
            } catch (_) {
              resetsAt = parseTimeStringToTimestamp(text);
            }
            dispatchToBridge('LIMIT_DETECTED', {
              botId: 'claude',
              resetsAt,
              reason
            });
          }).catch(() => {});
        }
      }

      // 3. DeepSeek
      else if (botId === 'deepseek') {
        if (url.includes('/chat/completion') && method === 'POST' && response.ok) {
          inspectSSEStream(response, (json) => {
            if (typeof json?.accumulated_token_usage === 'number' && json.accumulated_token_usage > 0) {
              liveTelemetry.tokensUsed = json.accumulated_token_usage;
              liveTelemetry.tokenLimit = liveTelemetry.tokenLimit || 128000;
              liveTelemetry.tokensRemaining = Math.max(0, liveTelemetry.tokenLimit - liveTelemetry.tokensUsed);
              liveTelemetry.lastUpdated = Date.now();
            }
          });
        } else if (response.status === 429) {
          dispatchToBridge('LIMIT_DETECTED', {
            botId: 'deepseek',
            resetsAt: null,
            reason: 'DeepSeek rate limit (HTTP 429)'
          });
        }
      }

      // 4. Gemini
      else if (botId === 'gemini') {
        if (response.status === 429) {
          dispatchToBridge('LIMIT_DETECTED', {
            botId: 'gemini',
            resetsAt: null,
            reason: 'Gemini rate limit reached (HTTP 429)'
          });
        }
      }
    } catch (_) {}

    return response;
  };

  // ----------------------------------------------------
  // 2. Payload Parsers for Real Provider Endpoints
  // ----------------------------------------------------
  function parseClaudeUsagePayload(quotaWindows) {
    const windows = [];
    let primaryUsedPct = null;
    let primaryResetsAt = null;
    let isLimited = false;
    let limitReason = null;

    const windowLabels = {
      five_hour: '5-Hour Limit',
      seven_day: '7-Day Weekly',
      seven_day_sonnet: '7-Day Sonnet',
      seven_day_opus: '7-Day Opus',
      daily: 'Daily Limit'
    };

    if (quotaWindows && typeof quotaWindows === 'object') {
      for (const [key, val] of Object.entries(quotaWindows)) {
        if (!val || typeof val !== 'object') continue;
        if (typeof val.utilization === 'number') {
          // Anthropic returns utilization as 0..100 percentage (e.g., 14 = 14%, 100 = 100%)
          const pct = Math.min(100, Math.max(0, Math.round(val.utilization * 10) / 10));
          const remPct = Math.max(0, Number((100 - pct).toFixed(1)));
          const rAt = normalizeResetTimestamp(val.resets_at || val.reset_at);
          windows.push({
            id: key,
            label: windowLabels[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            usedPercent: pct,
            remainingPercent: remPct,
            resetsAt: rAt
          });

          if (key === 'five_hour' || primaryUsedPct === null) {
            primaryUsedPct = pct;
            if (rAt) primaryResetsAt = rAt;
          }
          if (pct >= 100) {
            isLimited = true;
            limitReason = `Claude ${windowLabels[key] || key} reached (100%)`;
            if (rAt) primaryResetsAt = rAt;
          }
        }
      }
    }

    return {
      usedPercent: primaryUsedPct,
      remainingPercent: primaryUsedPct !== null ? Math.max(0, Number((100 - primaryUsedPct).toFixed(1))) : null,
      resetsAt: primaryResetsAt,
      windows,
      quotaWindows,
      isLimited,
      limitReason
    };
  }

  function parseChatGPTWhamUsage(usageData) {
    let tier = null;
    let tierLabel = null;
    if (usageData?.plan_type) {
      const planStr = String(usageData.plan_type).toLowerCase();
      if (planStr.includes('pro')) { tier = 'pro'; tierLabel = 'ChatGPT Pro'; }
      else if (planStr.includes('team')) { tier = 'team'; tierLabel = 'ChatGPT Team'; }
      else if (planStr.includes('plus')) { tier = 'plus'; tierLabel = 'ChatGPT Plus'; }
      else { tier = 'free'; tierLabel = 'ChatGPT Free'; }
    }

    const windows = [];
    let primaryUsedPct = null;
    let primaryResetsAt = null;
    let isLimited = Boolean(usageData?.rate_limit?.limit_reached);
    let limitReason = isLimited ? 'ChatGPT rate limit reached' : null;

    const rl = usageData?.rate_limit;
    if (rl && typeof rl === 'object') {
      const parseWin = (winObj, id, defaultLabel) => {
        if (!winObj || typeof winObj !== 'object') return;
        let pct = null;
        if (typeof winObj.used_percent === 'number') {
          pct = Math.min(100, Math.max(0, Math.round(winObj.used_percent * 10) / 10));
        } else if (typeof winObj.used === 'number' && typeof winObj.limit === 'number' && winObj.limit > 0) {
          pct = Math.min(100, Math.max(0, Math.round((winObj.used / winObj.limit) * 1000) / 10));
        }
        if (pct === null) return;

        let rAt = null;
        if (typeof winObj.reset_after_seconds === 'number' && winObj.reset_after_seconds > 0) {
          rAt = Date.now() + Math.round(winObj.reset_after_seconds * 1000);
        } else if (winObj.reset_at || winObj.resets_at) {
          rAt = normalizeResetTimestamp(winObj.reset_at || winObj.resets_at);
        }

        let winLabel = defaultLabel;
        if (typeof winObj.limit_window_seconds === 'number' && winObj.limit_window_seconds > 0) {
          const hrs = Math.round(winObj.limit_window_seconds / 3600);
          if (hrs >= 24 && hrs % 24 === 0) {
            winLabel = `${hrs / 24}-Day Window`;
          } else if (hrs > 0) {
            winLabel = `${hrs}-Hour Window`;
          }
        }

        windows.push({
          id,
          label: winLabel,
          usedPercent: pct,
          remainingPercent: Math.max(0, Number((100 - pct).toFixed(1))),
          used: typeof winObj.used === 'number' ? winObj.used : null,
          limit: typeof winObj.limit === 'number' ? winObj.limit : null,
          remaining: typeof winObj.used === 'number' && typeof winObj.limit === 'number' ? Math.max(0, winObj.limit - winObj.used) : null,
          resetsAt: rAt
        });

        if (id === 'primary' || primaryUsedPct === null) {
          primaryUsedPct = pct;
          if (rAt) primaryResetsAt = rAt;
        }
        if (pct >= 100) {
          isLimited = true;
          limitReason = `ChatGPT ${winLabel} cap reached`;
          if (rAt) primaryResetsAt = rAt;
        }
      };

      if (rl.primary_window) {
        parseWin(rl.primary_window, 'primary', 'Primary Window');
      } else {
        parseWin(rl, 'primary', 'Rate Limit Window');
      }
      if (rl.secondary_window) {
        parseWin(rl.secondary_window, 'secondary', 'Weekly Window');
      }
    }

    return {
      tier,
      tierLabel,
      usedPercent: primaryUsedPct,
      remainingPercent: primaryUsedPct !== null ? Math.max(0, Number((100 - primaryUsedPct).toFixed(1))) : null,
      resetsAt: primaryResetsAt,
      windows,
      quotaWindows: usageData,
      isLimited,
      limitReason
    };
  }

  // ----------------------------------------------------
  // 3. Active In-Page Real Telemetry Fetchers
  // ----------------------------------------------------
  let isSyncing = false;

  async function performInPageClaudeSync() {
    try {
      const orgResp = await originalFetch('/api/organizations', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });

      if (!orgResp.ok) {
        if (orgResp.status === 401 || orgResp.status === 403 || (orgResp.redirected && orgResp.url.includes('/login'))) {
          const payload = { botId: 'claude', isLoggedIn: false, fetchStatus: 'login_required' };
          dispatchToBridge('AUTO_FETCH_RESULT', payload);
          return payload;
        }
        return null;
      }

      const orgs = await orgResp.json();
      const orgList = Array.isArray(orgs) ? orgs : (orgs?.items || [orgs]);
      if (!orgList.length) return null;

      // Match lastActiveOrg cookie if available
      const cookieMatch = document.cookie.match(/lastActiveOrg=([^;]+)/);
      const preferredOrgId = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
      const primaryOrg = orgList.find(o => (o.uuid || o.id) === preferredOrgId) ||
                         orgList.find(o => (o.capabilities || []).includes('chat')) ||
                         orgList[0];

      const orgId = primaryOrg?.uuid || primaryOrg?.id;
      if (!orgId) return null;

      const caps = primaryOrg.capabilities || [];
      const rateTier = String(primaryOrg.rate_limit_tier || '').toLowerCase();
      let tier = 'free';
      let tierLabel = 'Claude Free';
      if (caps.includes('claude_max') || rateTier.includes('max')) {
        tier = 'max';
        tierLabel = rateTier.includes('20x') ? 'Claude Max (20x)' : rateTier.includes('5x') ? 'Claude Max (5x)' : 'Claude Max';
      } else if (caps.includes('claude_team') || primaryOrg.has_team_subscription) {
        tier = 'team';
        tierLabel = 'Claude Team';
      } else if (caps.includes('claude_pro') || primaryOrg.has_active_subscription || rateTier.includes('pro')) {
        tier = 'pro';
        tierLabel = 'Claude Pro';
      }

      let usageParsed = {
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        windows: [],
        quotaWindows: null,
        isLimited: false,
        limitReason: null
      };

      try {
        const usageResp = await originalFetch(`/api/organizations/${orgId}/usage`, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (usageResp.ok) {
          const qData = await usageResp.json();
          usageParsed = parseClaudeUsagePayload(qData);
        }
      } catch (_) {}

      // Fetch real token usage from active or most recent conversation(s)
      let tokensUsed = liveTelemetry.tokensUsed;
      let inputTokens = liveTelemetry.inputTokens;
      let outputTokens = liveTelemetry.outputTokens;
      let tokenLimit = liveTelemetry.tokenLimit || 200000;
      let activeModel = liveTelemetry.activeModel || 'claude-sonnet-4';
      let conversationTitle = null;
      let tokenSource = 'Claude 200k Context Window';

      try {
        const pathMatch = window.location.pathname.match(/\/chat\/([a-f0-9-]{36})/i);
        let targetConvId = pathMatch ? pathMatch[1] : null;

        if (!targetConvId) {
          const listResp = await originalFetch(`/api/organizations/${orgId}/chat_conversations?limit=3`, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
          });
          if (listResp.ok) {
            const convList = await listResp.json();
            if (Array.isArray(convList) && convList.length > 0) {
              targetConvId = convList[0].uuid || convList[0].id;
            }
          }
        }

        if (targetConvId) {
          const convResp = await originalFetch(
            `/api/organizations/${orgId}/chat_conversations/${targetConvId}?tree=True&rendering_mode=messages&render_all_tools=true`,
            { credentials: 'include', headers: { 'Accept': 'application/json' } }
          );
          if (convResp.ok) {
            const convData = await convResp.json();
            if (convData?.model) activeModel = convData.model;
            if (convData?.name) conversationTitle = convData.name;

            const messages = convData?.chat_messages || [];
            let calcInput = 0;
            let calcOutput = 0;
            for (const msg of messages) {
              let msgText = '';
              if (typeof msg.text === 'string' && msg.text) {
                msgText = msg.text;
              } else if (Array.isArray(msg.content)) {
                msgText = msg.content.map(c => c.text || c.thinking || '').join(' ');
              }
              const attachmentText = Array.isArray(msg.attachments)
                ? msg.attachments.map(a => a.extracted_content || '').join(' ')
                : '';
              const tok = (msg.input_tokens || msg.output_tokens)
                ? (msg.input_tokens || 0) + (msg.output_tokens || 0)
                : estimateTokensFromText(msgText + ' ' + attachmentText);

              if (msg.sender === 'human') calcInput += tok;
              else calcOutput += tok;
            }
            const totalConvTokens = calcInput + calcOutput;
            if (totalConvTokens > 0 && (tokensUsed === null || totalConvTokens >= tokensUsed)) {
              inputTokens = calcInput;
              outputTokens = calcOutput;
              tokensUsed = totalConvTokens;
              tokenSource = conversationTitle ? `Active Chat: ${conversationTitle.slice(0, 28)}` : 'Active Conversation Tokens';
            }
          }
        } else if (tokensUsed === null) {
          tokensUsed = 0;
          inputTokens = 0;
          outputTokens = 0;
        }
      } catch (_) {}

      const tokensRemaining = typeof tokensUsed === 'number' ? Math.max(0, tokenLimit - tokensUsed) : null;

      let accountEmail = null;
      try {
        const userResp = await originalFetch('/api/auth/current_user', {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (userResp.ok) {
          const userData = await userResp.json();
          accountEmail = userData?.user?.email_address || userData?.email_address || userData?.email || null;
        }
      } catch (_) {}

      const payload = {
        botId: 'claude',
        isLoggedIn: true,
        tier,
        tierLabel,
        activeModel,
        accountEmail,
        conversationTitle,
        ...usageParsed,
        tokensUsed,
        inputTokens,
        outputTokens,
        tokenLimit,
        tokensRemaining,
        tokenSource,
        fetchStatus: 'synced'
      };

      dispatchToBridge('AUTO_FETCH_RESULT', payload);
      return payload;
    } catch (err) {
      console.debug('[Know Ur Limit] Claude sync note:', err.message);
      return null;
    }
  }

  async function performInPageChatGPTSync() {
    try {
      const sessionResp = await originalFetch('/api/auth/session', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });

      if (!sessionResp.ok) {
        if (sessionResp.status === 401 || sessionResp.status === 403 || (sessionResp.redirected && sessionResp.url.includes('/login'))) {
          const payload = { botId: 'chatgpt', isLoggedIn: false, fetchStatus: 'login_required' };
          dispatchToBridge('AUTO_FETCH_RESULT', payload);
          return payload;
        }
        return null;
      }

      const sessionData = await sessionResp.json();
      const token = sessionData?.accessToken;
      if (!token) {
        const payload = { botId: 'chatgpt', isLoggedIn: false, fetchStatus: 'login_required' };
        dispatchToBridge('AUTO_FETCH_RESULT', payload);
        return payload;
      }

      const cookieAccMatch = document.cookie.match(/(?:^|;\s*)_account=([^;]+)/);
      const cookieAccountId = cookieAccMatch ? decodeURIComponent(cookieAccMatch[1]) : '';
      const accountId = cookieAccountId || sessionData?.account?.id || '';

      const authHeaders = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      };
      if (accountId && accountId !== 'personal') {
        authHeaders['ChatGPT-Account-Id'] = accountId;
      }

      let tier = 'free';
      let tierLabel = 'ChatGPT Free';
      let activeModel = liveTelemetry.activeModel || 'gpt-4o';
      let tokenLimit = 128000;
      let usageParsed = {
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null,
        windows: [],
        quotaWindows: null,
        isLimited: false,
        limitReason: null
      };

      // 1. Fetch real rate limit windows from /backend-api/wham/usage
      try {
        const usageResp = await originalFetch('/backend-api/wham/usage', {
          credentials: 'include',
          headers: authHeaders
        });
        if (usageResp.ok) {
          const uData = await usageResp.json();
          usageParsed = parseChatGPTWhamUsage(uData);
          if (usageParsed.tier) tier = usageParsed.tier;
          if (usageParsed.tierLabel) tierLabel = usageParsed.tierLabel;
        }
      } catch (_) {}

      // 2. Fetch real account plan & model limits
      try {
        const modelsResp = await originalFetch('/backend-api/models', {
          credentials: 'include',
          headers: authHeaders
        });
        if (modelsResp.ok) {
          const modelsData = await modelsResp.json();
          const modelsList = modelsData?.models || [];
          if (modelsList.length > 0) {
            const matchedModel = modelsList.find(m => m.slug === activeModel) || modelsList[0];
            if (matchedModel?.max_tokens) {
              tokenLimit = matchedModel.max_tokens;
            }
            if (!liveTelemetry.activeModel && matchedModel?.slug) {
              activeModel = matchedModel.slug;
            }
          }
        }
      } catch (_) {}

      if (!usageParsed.tier) {
        try {
          const accResp = await originalFetch('/backend-api/accounts/check/v4-2023-04-27', {
            credentials: 'include',
            headers: authHeaders
          });
          if (accResp.ok) {
            const accData = await accResp.json();
            const accountsMap = accData?.accounts || {};
            const accObj = accountsMap[accountId] || accountsMap.default || Object.values(accountsMap)[0];
            const planType = accObj?.entitlement?.subscription_plan || accObj?.account?.plan_type || '';
            const pStr = String(planType).toLowerCase();
            if (pStr.includes('pro')) { tier = 'pro'; tierLabel = 'ChatGPT Pro'; }
            else if (pStr.includes('team')) { tier = 'team'; tierLabel = 'ChatGPT Team'; }
            else if (pStr.includes('plus')) { tier = 'plus'; tierLabel = 'ChatGPT Plus'; }
          }
        } catch (_) {}
      }

      // 3. Fetch real conversation token usage
      let tokensUsed = liveTelemetry.tokensUsed;
      let inputTokens = liveTelemetry.inputTokens;
      let outputTokens = liveTelemetry.outputTokens;
      let conversationTitle = null;
      let tokenSource = `Model Context (${Math.round(tokenLimit / 1000)}k max)`;

      try {
        const pathMatch = window.location.pathname.match(/\/c\/([a-f0-9-]+)/i);
        let convId = pathMatch ? pathMatch[1] : null;

        if (!convId) {
          const listResp = await originalFetch('/backend-api/conversations?offset=0&limit=1&order=updated', {
            credentials: 'include',
            headers: authHeaders
          });
          if (listResp.ok) {
            const listData = await listResp.json();
            if (Array.isArray(listData?.items) && listData.items.length > 0) {
              convId = listData.items[0].id;
            }
          }
        }

        if (convId) {
          const convResp = await originalFetch(`/backend-api/conversation/${convId}`, {
            credentials: 'include',
            headers: authHeaders
          });
          if (convResp.ok) {
            const convData = await convResp.json();
            if (convData?.title) conversationTitle = convData.title;
            if (convData?.default_model_slug) activeModel = convData.default_model_slug;

            const mapping = convData?.mapping || {};
            let calcInput = 0;
            let calcOutput = 0;
            for (const node of Object.values(mapping)) {
              const msg = node?.message;
              if (!msg || !msg.content) continue;
              const role = msg.author?.role;
              if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;

              const parts = Array.isArray(msg.content.parts)
                ? msg.content.parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
                : (msg.content.text || '');
              const tok = estimateTokensFromText(parts);
              if (role === 'user') calcInput += tok;
              else calcOutput += tok;
            }
            inputTokens = calcInput;
            outputTokens = calcOutput;
            tokensUsed = calcInput + calcOutput;
            tokenSource = conversationTitle ? `Chat: ${conversationTitle.slice(0, 28)}` : 'Active Conversation Tokens';
          }
        } else if (tokensUsed === null) {
          tokensUsed = 0;
          inputTokens = 0;
          outputTokens = 0;
        }
      } catch (_) {}

      const tokensRemaining = typeof tokensUsed === 'number' ? Math.max(0, tokenLimit - tokensUsed) : null;

      const payload = {
        botId: 'chatgpt',
        isLoggedIn: true,
        tier,
        tierLabel,
        activeModel,
        accountEmail: sessionData.user?.email || null,
        conversationTitle,
        ...usageParsed,
        tokensUsed,
        inputTokens,
        outputTokens,
        tokenLimit,
        tokensRemaining,
        tokenSource,
        fetchStatus: 'synced'
      };

      dispatchToBridge('AUTO_FETCH_RESULT', payload);
      return payload;
    } catch (err) {
      console.debug('[Know Ur Limit] ChatGPT sync note:', err.message);
      return null;
    }
  }

  async function performInPageDeepSeekSync() {
    try {
      const token = getDeepSeekBearerToken();
      if (!token) {
        const payload = { botId: 'deepseek', isLoggedIn: false, fetchStatus: 'login_required' };
        dispatchToBridge('AUTO_FETCH_RESULT', payload);
        return payload;
      }

      const authHeaders = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'x-app-version': '20241129.1'
      };

      const userResp = await originalFetch('/api/v0/users/current', {
        credentials: 'include',
        headers: authHeaders
      });

      if (!userResp.ok) {
        if (userResp.status === 401 || userResp.status === 403) {
          const payload = { botId: 'deepseek', isLoggedIn: false, fetchStatus: 'login_required' };
          dispatchToBridge('AUTO_FETCH_RESULT', payload);
          return payload;
        }
        return null;
      }

      const userData = await userResp.json();
      const bizUser = userData?.data?.biz_data || userData?.data || {};
      const accountEmail = bizUser.email || bizUser.mobile || bizUser.phone || bizUser.id_profile?.email || null;

      const windows = [];
      let primaryUsedPct = null;
      let primaryResetsAt = null;

      // 1. Check DeepSeek feature_quota endpoint
      try {
        const quotaResp = await originalFetch('/api/v0/users/feature_quota', {
          credentials: 'include',
          headers: authHeaders
        });
        if (quotaResp.ok) {
          const qJson = await quotaResp.json();
          const qData = qJson?.data?.biz_data || qJson?.data || {};
          for (const [fKey, fVal] of Object.entries(qData)) {
            if (fVal && typeof fVal === 'object' && typeof fVal.quota === 'number' && fVal.quota > 0) {
              const used = typeof fVal.used === 'number' ? fVal.used : 0;
              const limit = fVal.quota;
              const pct = Math.min(100, Math.max(0, Math.round((used / limit) * 1000) / 10));
              windows.push({
                id: fKey,
                label: fKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                usedPercent: pct,
                remainingPercent: Math.max(0, Number((100 - pct).toFixed(1))),
                used,
                limit,
                remaining: Math.max(0, limit - used),
                resetsAt: normalizeResetTimestamp(fVal.reset_at || fVal.resets_at)
              });
              if (primaryUsedPct === null) primaryUsedPct = pct;
            }
          }
        }
      } catch (_) {}

      // 2. Fetch real accumulated_token_usage from DeepSeek chat session
      let tokensUsed = liveTelemetry.tokensUsed;
      let inputTokens = liveTelemetry.inputTokens;
      let outputTokens = liveTelemetry.outputTokens;
      let activeModel = liveTelemetry.activeModel || 'deepseek-chat';
      let tokenLimit = 128000;
      let conversationTitle = null;
      let tokenSource = 'DeepSeek Server Token Counter';

      try {
        const pathMatch = window.location.pathname.match(/\/s\/([a-f0-9-]+)/i);
        let sessionId = pathMatch ? pathMatch[1] : null;

        if (!sessionId) {
          const sessResp = await originalFetch('/api/v0/chat_session/fetch_page?count=1', {
            credentials: 'include',
            headers: authHeaders
          });
          if (sessResp.ok) {
            const sessJson = await sessResp.json();
            const sessions = sessJson?.data?.biz_data?.chat_sessions || [];
            if (sessions.length > 0) {
              sessionId = sessions[0].id;
              conversationTitle = sessions[0].title || null;
            }
          }
        }

        if (sessionId) {
          const msgResp = await originalFetch(`/api/v0/chat/history_messages?chat_session_id=${sessionId}`, {
            credentials: 'include',
            headers: authHeaders
          });
          if (msgResp.ok) {
            const msgJson = await msgResp.json();
            const bizData = msgJson?.data?.biz_data || {};
            if (bizData.chat_session?.title) conversationTitle = bizData.chat_session.title;
            const messages = bizData.chat_messages || [];

            let maxAccumulated = 0;
            let calcInput = 0;
            let calcOutput = 0;
            let thinkingEnabled = false;

            for (const m of messages) {
              if (typeof m.accumulated_token_usage === 'number' && m.accumulated_token_usage > maxAccumulated) {
                maxAccumulated = m.accumulated_token_usage;
              }
              if (m.thinking_enabled) thinkingEnabled = true;
              const contentTok = estimateTokensFromText((m.content || '') + ' ' + (m.thinking_content || ''));
              if (m.role === 'USER') calcInput += contentTok;
              else calcOutput += contentTok;
            }

            if (thinkingEnabled) {
              activeModel = 'deepseek-reasoner';
              tokenLimit = 64000;
            } else {
              activeModel = 'deepseek-chat';
              tokenLimit = 128000;
            }

            inputTokens = calcInput;
            outputTokens = calcOutput;
            tokensUsed = maxAccumulated > 0 ? maxAccumulated : (calcInput + calcOutput);
            tokenSource = maxAccumulated > 0
              ? `Exact API accumulated_token_usage`
              : (conversationTitle ? `Chat: ${conversationTitle.slice(0, 28)}` : 'Session Tokens');
          }
        } else if (tokensUsed === null) {
          tokensUsed = 0;
          inputTokens = 0;
          outputTokens = 0;
        }
      } catch (_) {}

      const tokensRemaining = typeof tokensUsed === 'number' ? Math.max(0, tokenLimit - tokensUsed) : null;
      if (primaryUsedPct === null && typeof tokensUsed === 'number' && tokenLimit > 0) {
        primaryUsedPct = Math.min(100, Math.max(0, Number(((tokensUsed / tokenLimit) * 100).toFixed(1))));
      }

      const payload = {
        botId: 'deepseek',
        isLoggedIn: true,
        tier: 'free',
        tierLabel: activeModel === 'deepseek-reasoner' ? 'DeepSeek R1' : 'DeepSeek V3',
        activeModel,
        accountEmail,
        conversationTitle,
        usedPercent: primaryUsedPct,
        remainingPercent: primaryUsedPct !== null ? Math.max(0, Number((100 - primaryUsedPct).toFixed(1))) : null,
        resetsAt: primaryResetsAt,
        windows,
        tokensUsed,
        inputTokens,
        outputTokens,
        tokenLimit,
        tokensRemaining,
        tokenSource,
        fetchStatus: 'synced'
      };

      dispatchToBridge('AUTO_FETCH_RESULT', payload);
      return payload;
    } catch (err) {
      console.debug('[Know Ur Limit] DeepSeek sync note:', err.message);
      return null;
    }
  }

  async function performInPageGeminiSync() {
    try {
      const wiz = window.WIZ_global_data || {};
      const wizEmail = wiz.oPEP7c || null;
      const wizToken = wiz.SNlM0e || null;

      const userProfileEl = document.querySelector(
        'a[href*="accounts.google.com"], [aria-label*="Google Account"], [data-email]'
      );
      let domEmail = null;
      if (userProfileEl) {
        const aria = userProfileEl.getAttribute('aria-label') || userProfileEl.getAttribute('data-email') || '';
        const m = aria.match(/([a-zA-Z0-9._+-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/);
        if (m) domEmail = m[1];
      }

      const isLoggedIn = Boolean(wizToken || wizEmail || domEmail || document.cookie.includes('SID='));
      if (!isLoggedIn) {
        const payload = { botId: 'gemini', isLoggedIn: false, fetchStatus: 'login_required' };
        dispatchToBridge('AUTO_FETCH_RESULT', payload);
        return payload;
      }

      let tier = 'free';
      let tierLabel = 'Gemini Standard';
      let activeModel = 'gemini-2.5-flash';
      let tokenLimit = 1000000;

      const bodyText = document.body ? document.body.innerText.slice(0, 4000) : '';
      if (bodyText.includes('Gemini Advanced') || bodyText.includes('Google AI Pro') || bodyText.includes('Ultra')) {
        tier = 'advanced';
        tierLabel = 'Gemini Advanced';
        activeModel = 'gemini-2.5-pro';
        tokenLimit = 1000000;
      } else if (bodyText.includes('2.5 Pro')) {
        activeModel = 'gemini-2.5-pro';
      }

      // Compute real token usage from active Gemini conversation DOM
      const userQueries = document.querySelectorAll('user-query, [data-test-id="user-query"], .user-query-container');
      const modelResponses = document.querySelectorAll('model-response, [data-test-id="model-response"], .model-response-text');

      let calcInput = 0;
      let calcOutput = 0;
      userQueries.forEach(el => {
        calcInput += estimateTokensFromText(el.innerText || el.textContent || '');
      });
      modelResponses.forEach(el => {
        calcOutput += estimateTokensFromText(el.innerText || el.textContent || '');
      });

      const tokensUsed = calcInput + calcOutput;
      const tokensRemaining = Math.max(0, tokenLimit - tokensUsed);
      const usedPercent = Math.min(100, Math.max(0, Number(((tokensUsed / tokenLimit) * 100).toFixed(1))));

      const payload = {
        botId: 'gemini',
        isLoggedIn: true,
        tier,
        tierLabel,
        activeModel,
        accountEmail: wizEmail || domEmail || null,
        usedPercent,
        remainingPercent: Math.max(0, Number((100 - usedPercent).toFixed(1))),
        tokensUsed,
        inputTokens: calcInput,
        outputTokens: calcOutput,
        tokenLimit,
        tokensRemaining,
        tokenSource: `Active Session (1M Token Context)`,
        fetchStatus: 'synced'
      };

      dispatchToBridge('AUTO_FETCH_RESULT', payload);
      return payload;
    } catch (err) {
      console.debug('[Know Ur Limit] Gemini sync note:', err.message);
      return null;
    }
  }

  async function performCurrentBotSync() {
    if (isSyncing) return null;
    isSyncing = true;
    try {
      if (botId === 'claude') return await performInPageClaudeSync();
      if (botId === 'chatgpt') return await performInPageChatGPTSync();
      if (botId === 'deepseek') return await performInPageDeepSeekSync();
      if (botId === 'gemini') return await performInPageGeminiSync();
      return null;
    } finally {
      isSyncing = false;
    }
  }

  // Expose direct callable hook in MAIN world for chrome.scripting.executeScript
  window.__AI_LIMITS_FETCH_NOW__ = performCurrentBotSync;

  // Listen for sync triggers from isolated content script / bridge
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'AI_LIMITS_HUB_REQUEST') return;
    if (event.data.action === 'TRIGGER_IN_PAGE_FETCH') {
      performCurrentBotSync();
    }
  });

  // Sync on page load
  setTimeout(performCurrentBotSync, 1200);

  // Periodic in-page sync every 2 minutes
  setInterval(performCurrentBotSync, 120000);

  console.log(`[Know Ur Limit] Real telemetry interceptor active for ${botId}`);
})();
