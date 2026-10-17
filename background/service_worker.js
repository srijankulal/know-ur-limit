/**
 * Know Ur Limit - Background Service Worker (Manifest V3)
 * Orchestrates real usage limit & token telemetry fetching from Claude, ChatGPT,
 * Google Gemini, and DeepSeek via MAIN-world script execution and direct API calls.
 */

import { BOTS, STATUS } from '../shared/constants.js';
import {
  getAllBotStates,
  getBotState,
  recordLimitDetected,
  recordAutoFetchedUsage,
  clearLimit,
  updateBotPlan,
  updateBotHeartbeat,
  getSettings,
  clearAllData
} from '../shared/storage.js';

// Setup periodic alarms on install/startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Know Ur Limit] Extension initialized');
  chrome.alarms.create('periodic_status_tick', { periodInMinutes: 1 });
  chrome.alarms.create('periodic_auto_fetch', { periodInMinutes: 2 });
  await updateExtensionBadge();
  await syncAllBotLimits({ allowTempTab: false });
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('periodic_status_tick', { periodInMinutes: 1 });
  chrome.alarms.create('periodic_auto_fetch', { periodInMinutes: 2 });
  await updateExtensionBadge();
  await syncAllBotLimits({ allowTempTab: false });
});

// Watch for tab navigation to AI chat providers to auto-fetch immediately
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    for (const [botId, botDef] of Object.entries(BOTS)) {
      if (botDef.domains.some(d => tab.url.includes(d))) {
        setTimeout(() => syncBotLimits(botId, { allowTempTab: false }), 1200);
        break;
      }
    }
  }
});

// Handle Alarms (Reset Timers, Status Ticks, & Periodic Auto-Fetch)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith('alarm_reset_')) {
    const botId = alarm.name.replace('alarm_reset_', '');
    const botDef = BOTS[botId];
    if (botDef) {
      await clearLimit(botId);
      const settings = await getSettings();

      if (settings.notifyOnReset) {
        chrome.notifications.create(`notify_reset_${botId}_${Date.now()}`, {
          type: 'basic',
          iconUrl: '../icons/icon128.png',
          title: `🎉 ${botDef.name} Limit Reset!`,
          message: `Your usage quota for ${botDef.name} has reset. You can continue chatting!`,
          priority: 2
        });
      }

      await broadcastStateUpdate();
      await updateExtensionBadge();
    }
  } else if (alarm.name === 'periodic_status_tick') {
    await updateExtensionBadge();
  } else if (alarm.name === 'periodic_auto_fetch') {
    const settings = await getSettings();
    if (settings.autoFetchFromBrowser !== false) {
      await syncAllBotLimits({ allowTempTab: false });
    }
  }
});

// Update Extension Icon Badge
async function updateExtensionBadge() {
  try {
    const settings = await getSettings();
    if (settings.badgeMode === 'off') {
      chrome.action.setBadgeText({ text: '' });
      return;
    }

    const states = await getAllBotStates();
    const now = Date.now();
    let minRemainingMs = Infinity;
    let limitedCount = 0;
    let approachingCount = 0;

    for (const botId of Object.keys(BOTS)) {
      const state = states[botId];
      if (!state) continue;

      if (state.status === STATUS.LIMITED || (state.resetsAt && state.resetsAt > now && (state.usedPercent || 0) >= 100)) {
        limitedCount++;
        const rem = (state.resetsAt || now) - now;
        if (rem > 0 && rem < minRemainingMs) minRemainingMs = rem;
      } else if (state.status === STATUS.APPROACHING) {
        approachingCount++;
      }
    }

    if (limitedCount > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      if (settings.badgeMode === 'count' || minRemainingMs === Infinity) {
        chrome.action.setBadgeText({ text: `${limitedCount}` });
      } else {
        const mins = Math.max(1, Math.ceil(minRemainingMs / 60000));
        const badgeText = mins > 99 ? '99m+' : `${mins}m`;
        chrome.action.setBadgeText({ text: badgeText });
      }
    } else if (approachingCount > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      chrome.action.setBadgeText({ text: '!' });
    } else {
      chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    console.warn('Error updating badge:', e);
  }
}

// Broadcast State Update to All Open Tabs & Extension Views
async function broadcastStateUpdate() {
  try {
    const states = await getAllBotStates();
    chrome.runtime.sendMessage({
      action: 'STATE_UPDATED',
      data: states
    }).catch(() => {});

    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs.sendMessage(tab.id, {
          action: 'STATE_UPDATED',
          data: states
        }).catch(() => {});
      }
    });
  } catch (_) {}
}

// ----------------------------------------------------
// Cookie & Session Auth Verification
// ----------------------------------------------------
function matchesAuthCookieName(cookieName, authCookiePatterns = []) {
  if (!cookieName) return false;
  return authCookiePatterns.some(pattern => cookieName === pattern || cookieName.startsWith(pattern + '.'));
}

export async function checkBotLoginStatus(botId) {
  const botDef = BOTS[botId];
  if (!botDef) return false;

  try {
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      const urlCookies = await new Promise(r => chrome.cookies.getAll({ url: botDef.url }, r));
      if (urlCookies && urlCookies.some(c => matchesAuthCookieName(c.name, botDef.authCookies) && c.value && c.value.trim().length > 0)) {
        return true;
      }

      const domain = botDef.authDomain || botDef.domains[0];
      const domCookies = await new Promise(r => chrome.cookies.getAll({ domain }, r));
      if (domCookies && domCookies.some(c => matchesAuthCookieName(c.name, botDef.authCookies) && c.value && c.value.trim().length > 0)) {
        return true;
      }

      const dotCookies = await new Promise(r => chrome.cookies.getAll({ domain: '.' + domain }, r));
      if (dotCookies && dotCookies.some(c => matchesAuthCookieName(c.name, botDef.authCookies) && c.value && c.value.trim().length > 0)) {
        return true;
      }
    }

    if (typeof chrome !== 'undefined' && chrome.tabs) {
      const tabs = await new Promise(r => chrome.tabs.query({}, r));
      if (tabs && tabs.some(t => {
        if (!t.url) return false;
        const matchesDomain = botDef.domains.some(d => t.url.includes(d));
        if (!matchesDomain) return false;
        const u = t.url.toLowerCase();
        if (u.includes('/login') || u.includes('/signin') || u.includes('/sign_in') || u.includes('/auth/login')) {
          return false;
        }
        return true;
      })) {
        return true;
      }
    }
  } catch (err) {
    console.warn(`[Know Ur Limit] Auth check error for ${botId}:`, err);
  }
  return false;
}

// Watch for login / logout cookie changes in real time
if (typeof chrome !== 'undefined' && chrome.cookies && chrome.cookies.onChanged) {
  let cookieDebounce = null;
  chrome.cookies.onChanged.addListener((changeInfo) => {
    const cookie = changeInfo.cookie;
    if (!cookie) return;

    for (const [botId, botDef] of Object.entries(BOTS)) {
      if (!botDef.authCookies) continue;
      const isDomainMatch = (botDef.authDomain && cookie.domain.includes(botDef.authDomain)) ||
        botDef.domains.some(d => cookie.domain.includes(d));

      if (isDomainMatch && matchesAuthCookieName(cookie.name, botDef.authCookies)) {
        clearTimeout(cookieDebounce);
        cookieDebounce = setTimeout(async () => {
          await syncBotLimits(botId, { allowTempTab: false });
        }, 1200);
        break;
      }
    }
  });
}

// ----------------------------------------------------
// Self-Contained MAIN-World Live Telemetry Runner
// Executed via chrome.scripting.executeScript in open tabs
// (Works even on tabs opened BEFORE extension install/reload!)
// ----------------------------------------------------
async function inPageLiveTelemetryRunner(targetBotId) {
  // If interceptor.js is already injected and exposes __AI_LIMITS_FETCH_NOW__, call it directly!
  if (typeof window.__AI_LIMITS_FETCH_NOW__ === 'function') {
    try {
      const res = await window.__AI_LIMITS_FETCH_NOW__();
      if (res) return res;
    } catch (_) {}
  }

  // Self-contained fallback in MAIN world for pre-existing tabs
  const estimateTokens = (text) => (!text || typeof text !== 'string') ? 0 : Math.ceil(text.length / 3.8);
  const normTs = (val) => {
    if (!val) return null;
    if (typeof val === 'number') return val < 1e12 ? Math.round(val * 1000) : Math.round(val);
    if (typeof val === 'string') {
      const num = Number(val);
      if (!isNaN(num) && num > 1e9) return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
      const p = new Date(val).getTime();
      if (!isNaN(p)) return p;
    }
    return null;
  };

  try {
    // 1. CLAUDE
    if (targetBotId === 'claude') {
      const orgResp = await fetch('/api/organizations', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      if (!orgResp.ok) {
        if (orgResp.status === 401 || orgResp.status === 403) {
          return { botId: 'claude', isLoggedIn: false, fetchStatus: 'login_required' };
        }
        return null;
      }
      const orgs = await orgResp.json();
      const orgList = Array.isArray(orgs) ? orgs : (orgs?.items || [orgs]);
      if (!orgList.length) return null;

      const cookieMatch = document.cookie.match(/lastActiveOrg=([^;]+)/);
      const preferredOrgId = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
      const org = orgList.find(o => (o.uuid || o.id) === preferredOrgId) || orgList[0];
      const orgId = org?.uuid || org?.id;
      if (!orgId) return null;

      const caps = org.capabilities || [];
      const rateTier = String(org.rate_limit_tier || '').toLowerCase();
      let tier = 'free';
      let tierLabel = 'Claude Free';
      if (caps.includes('claude_max') || rateTier.includes('max')) {
        tier = 'max';
        tierLabel = rateTier.includes('20x') ? 'Claude Max (20x)' : rateTier.includes('5x') ? 'Claude Max (5x)' : 'Claude Max';
      } else if (caps.includes('claude_team') || org.has_team_subscription) {
        tier = 'team';
        tierLabel = 'Claude Team';
      } else if (caps.includes('claude_pro') || org.has_active_subscription || rateTier.includes('pro')) {
        tier = 'pro';
        tierLabel = 'Claude Pro';
      }

      const windows = [];
      let usedPercent = null;
      let resetsAt = null;
      let quotaWindows = null;
      let isLimited = false;
      let limitReason = null;

      try {
        const usageResp = await fetch(`/api/organizations/${orgId}/usage`, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (usageResp.ok) {
          quotaWindows = await usageResp.json();
          const labels = {
            five_hour: '5-Hour Limit',
            seven_day: '7-Day Weekly',
            seven_day_sonnet: '7-Day Sonnet',
            seven_day_opus: '7-Day Opus'
          };
          for (const [k, v] of Object.entries(quotaWindows || {})) {
            if (v && typeof v === 'object' && typeof v.utilization === 'number') {
              const pct = Math.min(100, Math.max(0, Math.round(v.utilization * 10) / 10));
              const rAt = normTs(v.resets_at || v.reset_at);
              windows.push({
                id: k,
                label: labels[k] || k,
                usedPercent: pct,
                remainingPercent: Math.max(0, Number((100 - pct).toFixed(1))),
                resetsAt: rAt
              });
              if (k === 'five_hour' || usedPercent === null) {
                usedPercent = pct;
                if (rAt) resetsAt = rAt;
              }
              if (pct >= 100) {
                isLimited = true;
                limitReason = `Claude ${labels[k] || k} reached`;
              }
            }
          }
        }
      } catch (_) {}

      let tokensUsed = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      const tokenLimit = 200000;
      let activeModel = 'claude-sonnet-4';
      let conversationTitle = null;

      try {
        const pathMatch = window.location.pathname.match(/\/chat\/([a-f0-9-]{36})/i);
        let convId = pathMatch ? pathMatch[1] : null;
        if (!convId) {
          const lResp = await fetch(`/api/organizations/${orgId}/chat_conversations?limit=1`, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
          });
          if (lResp.ok) {
            const list = await lResp.json();
            if (Array.isArray(list) && list.length > 0) convId = list[0].uuid || list[0].id;
          }
        }
        if (convId) {
          const cResp = await fetch(
            `/api/organizations/${orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages&render_all_tools=true`,
            { credentials: 'include', headers: { 'Accept': 'application/json' } }
          );
          if (cResp.ok) {
            const cData = await cResp.json();
            if (cData?.model) activeModel = cData.model;
            if (cData?.name) conversationTitle = cData.name;
            for (const msg of cData?.chat_messages || []) {
              const txt = typeof msg.text === 'string' && msg.text
                ? msg.text
                : Array.isArray(msg.content) ? msg.content.map(c => c.text || c.thinking || '').join(' ') : '';
              const att = Array.isArray(msg.attachments) ? msg.attachments.map(a => a.extracted_content || '').join(' ') : '';
              const t = estimateTokens(txt + ' ' + att);
              if (msg.sender === 'human') inputTokens += t;
              else outputTokens += t;
            }
            tokensUsed = inputTokens + outputTokens;
          }
        }
      } catch (_) {}

      return {
        botId: 'claude',
        isLoggedIn: true,
        tier,
        tierLabel,
        activeModel,
        conversationTitle,
        usedPercent,
        remainingPercent: usedPercent !== null ? Math.max(0, Number((100 - usedPercent).toFixed(1))) : null,
        resetsAt,
        windows,
        quotaWindows,
        tokensUsed,
        inputTokens,
        outputTokens,
        tokenLimit,
        tokensRemaining: Math.max(0, tokenLimit - tokensUsed),
        tokenSource: conversationTitle ? `Active Chat: ${conversationTitle.slice(0, 28)}` : 'Claude 200k Context Window',
        isLimited,
        limitReason,
        fetchStatus: 'synced'
      };
    }

    // 2. CHATGPT
    if (targetBotId === 'chatgpt') {
      const sResp = await fetch('/api/auth/session', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      if (!sResp.ok) {
        return { botId: 'chatgpt', isLoggedIn: false, fetchStatus: 'login_required' };
      }
      const sData = await sResp.json();
      const token = sData?.accessToken;
      if (!token) {
        return { botId: 'chatgpt', isLoggedIn: false, fetchStatus: 'login_required' };
      }

      const cookieAccMatch = document.cookie.match(/(?:^|;\s*)_account=([^;]+)/);
      const cookieAccountId = cookieAccMatch ? decodeURIComponent(cookieAccMatch[1]) : '';
      const accountId = cookieAccountId || sData?.account?.id || '';
      const authHeaders = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      };
      if (accountId && accountId !== 'personal') {
        authHeaders['ChatGPT-Account-Id'] = accountId;
      }

      let tier = 'free';
      let tierLabel = 'ChatGPT Free';
      let usedPercent = null;
      let resetsAt = null;
      const windows = [];
      let quotaWindows = null;
      let isLimited = false;
      let limitReason = null;

      try {
        const uResp = await fetch('/backend-api/wham/usage', {
          credentials: 'include',
          headers: authHeaders
        });
        if (uResp.ok) {
          quotaWindows = await uResp.json();
          if (quotaWindows?.plan_type) {
            const p = String(quotaWindows.plan_type).toLowerCase();
            if (p.includes('pro')) { tier = 'pro'; tierLabel = 'ChatGPT Pro'; }
            else if (p.includes('team')) { tier = 'team'; tierLabel = 'ChatGPT Team'; }
            else if (p.includes('plus')) { tier = 'plus'; tierLabel = 'ChatGPT Plus'; }
          }
          const rl = quotaWindows?.rate_limit;
          const addWin = (w, id, lbl) => {
            if (!w || typeof w !== 'object') return;
            let pct = typeof w.used_percent === 'number'
              ? Math.min(100, Math.max(0, Math.round(w.used_percent * 10) / 10))
              : (typeof w.used === 'number' && typeof w.limit === 'number' && w.limit > 0)
                ? Math.min(100, Math.max(0, Math.round((w.used / w.limit) * 1000) / 10))
                : null;
            if (pct === null) return;
            let rAt = (typeof w.reset_after_seconds === 'number' && w.reset_after_seconds > 0)
              ? Date.now() + Math.round(w.reset_after_seconds * 1000)
              : normTs(w.reset_at || w.resets_at);
            windows.push({
              id,
              label: lbl,
              usedPercent: pct,
              remainingPercent: Math.max(0, Number((100 - pct).toFixed(1))),
              used: typeof w.used === 'number' ? w.used : null,
              limit: typeof w.limit === 'number' ? w.limit : null,
              remaining: typeof w.used === 'number' && typeof w.limit === 'number' ? Math.max(0, w.limit - w.used) : null,
              resetsAt: rAt
            });
            if (id === 'primary' || usedPercent === null) {
              usedPercent = pct;
              if (rAt) resetsAt = rAt;
            }
            if (pct >= 100) {
              isLimited = true;
              limitReason = `ChatGPT ${lbl} reached`;
            }
          };
          if (rl?.primary_window) addWin(rl.primary_window, 'primary', 'Primary Window');
          else if (rl) addWin(rl, 'primary', 'Rate Limit Window');
          if (rl?.secondary_window) addWin(rl.secondary_window, 'secondary', 'Weekly Window');
        }
      } catch (_) {}

      let activeModel = 'gpt-4o';
      let tokenLimit = 128000;
      let tokensUsed = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let conversationTitle = null;

      try {
        const mResp = await fetch('/backend-api/models', { credentials: 'include', headers: authHeaders });
        if (mResp.ok) {
          const mData = await mResp.json();
          const mList = mData?.models || [];
          if (mList.length > 0 && mList[0].max_tokens) {
            tokenLimit = mList[0].max_tokens;
            activeModel = mList[0].slug || activeModel;
          }
        }
      } catch (_) {}

      try {
        const pathMatch = window.location.pathname.match(/\/c\/([a-f0-9-]+)/i);
        let convId = pathMatch ? pathMatch[1] : null;
        if (!convId) {
          const lResp = await fetch('/backend-api/conversations?offset=0&limit=1&order=updated', {
            credentials: 'include',
            headers: authHeaders
          });
          if (lResp.ok) {
            const lData = await lResp.json();
            if (Array.isArray(lData?.items) && lData.items.length > 0) convId = lData.items[0].id;
          }
        }
        if (convId) {
          const cResp = await fetch(`/backend-api/conversation/${convId}`, {
            credentials: 'include',
            headers: authHeaders
          });
          if (cResp.ok) {
            const cData = await cResp.json();
            if (cData?.title) conversationTitle = cData.title;
            if (cData?.default_model_slug) activeModel = cData.default_model_slug;
            for (const node of Object.values(cData?.mapping || {})) {
              const msg = node?.message;
              if (!msg || !msg.content) continue;
              const role = msg.author?.role;
              if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
              const parts = Array.isArray(msg.content.parts)
                ? msg.content.parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
                : (msg.content.text || '');
              const t = estimateTokens(parts);
              if (role === 'user') inputTokens += t;
              else outputTokens += t;
            }
            tokensUsed = inputTokens + outputTokens;
          }
        }
      } catch (_) {}

      return {
        botId: 'chatgpt',
        isLoggedIn: true,
        tier,
        tierLabel,
        activeModel,
        accountEmail: sData.user?.email || null,
        conversationTitle,
        usedPercent,
        remainingPercent: usedPercent !== null ? Math.max(0, Number((100 - usedPercent).toFixed(1))) : null,
        resetsAt,
        windows,
        quotaWindows,
        tokensUsed,
        inputTokens,
        outputTokens,
        tokenLimit,
        tokensRemaining: Math.max(0, tokenLimit - tokensUsed),
        tokenSource: conversationTitle ? `Chat: ${conversationTitle.slice(0, 28)}` : `Model Context (${Math.round(tokenLimit / 1000)}k max)`,
        isLimited,
        limitReason,
        fetchStatus: 'synced'
      };
    }

    // 3. DEEPSEEK
    if (targetBotId === 'deepseek') {
      let token = null;
      const raw = localStorage.getItem('userToken');
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          token = parsed?.value || null;
        } catch (_) {
          token = raw;
        }
      }
      if (!token) {
        return { botId: 'deepseek', isLoggedIn: false, fetchStatus: 'login_required' };
      }

      const authHeaders = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'x-app-version': '20241129.1'
      };

      const uResp = await fetch('/api/v0/users/current', {
        credentials: 'include',
        headers: authHeaders
      });
      if (!uResp.ok) {
        return { botId: 'deepseek', isLoggedIn: false, fetchStatus: 'login_required' };
      }
      const uData = await uResp.json();
      const bizUser = uData?.data?.biz_data || uData?.data || {};
      const accountEmail = bizUser.email || bizUser.mobile || bizUser.phone || bizUser.id_profile?.email || null;

      const windows = [];
      let usedPercent = null;
      try {
        const qResp = await fetch('/api/v0/users/feature_quota', {
          credentials: 'include',
          headers: authHeaders
        });
        if (qResp.ok) {
          const qJson = await qResp.json();
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
                resetsAt: normTs(fVal.reset_at || fVal.resets_at)
              });
              if (usedPercent === null) usedPercent = pct;
            }
          }
        }
      } catch (_) {}

      let tokensUsed = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let tokenLimit = 128000;
      let activeModel = 'deepseek-chat';
      let conversationTitle = null;

      try {
        const pathMatch = window.location.pathname.match(/\/s\/([a-f0-9-]+)/i);
        let sessionId = pathMatch ? pathMatch[1] : null;
        if (!sessionId) {
          const sResp = await fetch('/api/v0/chat_session/fetch_page?count=1', {
            credentials: 'include',
            headers: authHeaders
          });
          if (sResp.ok) {
            const sJson = await sResp.json();
            const list = sJson?.data?.biz_data?.chat_sessions || [];
            if (list.length > 0) {
              sessionId = list[0].id;
              conversationTitle = list[0].title || null;
            }
          }
        }
        if (sessionId) {
          const mResp = await fetch(`/api/v0/chat/history_messages?chat_session_id=${sessionId}`, {
            credentials: 'include',
            headers: authHeaders
          });
          if (mResp.ok) {
            const mJson = await mResp.json();
            const biz = mJson?.data?.biz_data || {};
            if (biz.chat_session?.title) conversationTitle = biz.chat_session.title;
            let maxAcc = 0;
            let thinking = false;
            for (const m of biz.chat_messages || []) {
              if (typeof m.accumulated_token_usage === 'number' && m.accumulated_token_usage > maxAcc) {
                maxAcc = m.accumulated_token_usage;
              }
              if (m.thinking_enabled) thinking = true;
              const t = estimateTokens((m.content || '') + ' ' + (m.thinking_content || ''));
              if (m.role === 'USER') inputTokens += t;
              else outputTokens += t;
            }
            if (thinking) {
              activeModel = 'deepseek-reasoner';
              tokenLimit = 64000;
            }
            tokensUsed = maxAcc > 0 ? maxAcc : (inputTokens + outputTokens);
          }
        }
      } catch (_) {}

      if (usedPercent === null && tokenLimit > 0) {
        usedPercent = Math.min(100, Math.max(0, Number(((tokensUsed / tokenLimit) * 100).toFixed(1))));
      }

      return {
        botId: 'deepseek',
        isLoggedIn: true,
        tier: 'free',
        tierLabel: activeModel === 'deepseek-reasoner' ? 'DeepSeek R1' : 'DeepSeek V3',
        activeModel,
        accountEmail,
        conversationTitle,
        usedPercent,
        remainingPercent: usedPercent !== null ? Math.max(0, Number((100 - usedPercent).toFixed(1))) : null,
        windows,
        tokensUsed,
        inputTokens,
        outputTokens,
        tokenLimit,
        tokensRemaining: Math.max(0, tokenLimit - tokensUsed),
        tokenSource: 'Exact API accumulated_token_usage',
        fetchStatus: 'synced'
      };
    }

    // 4. GEMINI
    if (targetBotId === 'gemini') {
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
        return { botId: 'gemini', isLoggedIn: false, fetchStatus: 'login_required' };
      }

      const bodyText = document.body ? document.body.innerText.slice(0, 4000) : '';
      const isAdvanced = bodyText.includes('Gemini Advanced') || bodyText.includes('Google AI Pro') || bodyText.includes('Ultra');
      const tier = isAdvanced ? 'advanced' : 'free';
      const tierLabel = isAdvanced ? 'Gemini Advanced' : 'Gemini Standard';
      const activeModel = isAdvanced || bodyText.includes('2.5 Pro') ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
      const tokenLimit = 1000000;

      let inputTokens = 0;
      let outputTokens = 0;
      document.querySelectorAll('user-query, [data-test-id="user-query"], .user-query-container').forEach(el => {
        inputTokens += estimateTokens(el.innerText || el.textContent || '');
      });
      document.querySelectorAll('model-response, [data-test-id="model-response"], .model-response-text').forEach(el => {
        outputTokens += estimateTokens(el.innerText || el.textContent || '');
      });

      const tokensUsed = inputTokens + outputTokens;
      const usedPercent = Math.min(100, Math.max(0, Number(((tokensUsed / tokenLimit) * 100).toFixed(1))));

      return {
        botId: 'gemini',
        isLoggedIn: true,
        tier,
        tierLabel,
        activeModel,
        accountEmail: wizEmail || domEmail || null,
        usedPercent,
        remainingPercent: Math.max(0, Number((100 - usedPercent).toFixed(1))),
        tokensUsed,
        inputTokens,
        outputTokens,
        tokenLimit,
        tokensRemaining: Math.max(0, tokenLimit - tokensUsed),
        tokenSource: 'Active Session (1M Token Context)',
        fetchStatus: 'synced'
      };
    }
  } catch (e) {
    return null;
  }
  return null;
}

// ----------------------------------------------------
// Direct Background Fetch Fallbacks (when no tab is open)
// ----------------------------------------------------
function normalizeResetTs(val) {
  if (!val) return null;
  if (typeof val === 'number') return val < 1e12 ? Math.round(val * 1000) : Math.round(val);
  if (typeof val === 'string') {
    const num = Number(val);
    if (!isNaN(num) && num > 1e9) return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
    const p = new Date(val).getTime();
    if (!isNaN(p)) return p;
  }
  return null;
}

async function directBackgroundFetchClaude() {
  try {
    const orgResp = await fetch('https://claude.ai/api/organizations', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    if (!orgResp.ok) return null;

    const orgs = await orgResp.json();
    const orgList = Array.isArray(orgs) ? orgs : (orgs?.items || [orgs]);
    if (orgList.length === 0) return null;

    const org = orgList[0];
    const orgId = org?.uuid || org?.id;
    if (!orgId) return null;

    const caps = org.capabilities || [];
    const rateTier = String(org.rate_limit_tier || '').toLowerCase();
    let tier = 'free';
    let tierLabel = 'Claude Free';
    if (caps.includes('claude_max') || rateTier.includes('max')) {
      tier = 'max';
      tierLabel = 'Claude Max';
    } else if (caps.includes('claude_team') || org.has_team_subscription) {
      tier = 'team';
      tierLabel = 'Claude Team';
    } else if (caps.includes('claude_pro') || org.has_active_subscription || rateTier.includes('pro')) {
      tier = 'pro';
      tierLabel = 'Claude Pro';
    }

    let usedPercent = null;
    let resetsAt = null;
    let quotaWindows = null;
    const windows = [];

    try {
      const usageResp = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      if (usageResp.ok) {
        quotaWindows = await usageResp.json();
        const labels = {
          five_hour: '5-Hour Limit',
          seven_day: '7-Day Weekly',
          seven_day_sonnet: '7-Day Sonnet',
          seven_day_opus: '7-Day Opus'
        };
        for (const [k, v] of Object.entries(quotaWindows || {})) {
          if (v && typeof v === 'object' && typeof v.utilization === 'number') {
            const pct = Math.min(100, Math.max(0, Math.round(v.utilization * 10) / 10));
            const rAt = normalizeResetTs(v.resets_at || v.reset_at);
            windows.push({
              id: k,
              label: labels[k] || k,
              usedPercent: pct,
              remainingPercent: Math.max(0, Number((100 - pct).toFixed(1))),
              resetsAt: rAt
            });
            if (k === 'five_hour' || usedPercent === null) {
              usedPercent = pct;
              if (rAt) resetsAt = rAt;
            }
          }
        }
      }
    } catch (_) {}

    // Also fetch latest conversation token usage if possible
    let tokensUsed = null;
    let inputTokens = null;
    let outputTokens = null;
    const tokenLimit = 200000;
    let conversationTitle = null;

    try {
      const listResp = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations?limit=1`, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      if (listResp.ok) {
        const list = await listResp.json();
        if (Array.isArray(list) && list.length > 0) {
          const convId = list[0].uuid || list[0].id;
          conversationTitle = list[0].name || null;
          const convResp = await fetch(
            `https://claude.ai/api/organizations/${orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages&render_all_tools=true`,
            { credentials: 'include', headers: { 'Accept': 'application/json' } }
          );
          if (convResp.ok) {
            const cData = await convResp.json();
            let inTok = 0;
            let outTok = 0;
            for (const msg of cData?.chat_messages || []) {
              const txt = typeof msg.text === 'string' && msg.text
                ? msg.text
                : Array.isArray(msg.content) ? msg.content.map(c => c.text || c.thinking || '').join(' ') : '';
              const t = Math.ceil(txt.length / 3.8);
              if (msg.sender === 'human') inTok += t;
              else outTok += t;
            }
            inputTokens = inTok;
            outputTokens = outTok;
            tokensUsed = inTok + outTok;
          }
        }
      }
    } catch (_) {}

    return {
      botId: 'claude',
      isLoggedIn: true,
      tier,
      tierLabel,
      usedPercent,
      remainingPercent: usedPercent !== null ? Math.max(0, Number((100 - usedPercent).toFixed(1))) : null,
      resetsAt,
      windows,
      quotaWindows,
      tokensUsed,
      inputTokens,
      outputTokens,
      tokenLimit,
      tokensRemaining: typeof tokensUsed === 'number' ? Math.max(0, tokenLimit - tokensUsed) : null,
      conversationTitle,
      tokenSource: 'Claude API + Active Chat',
      fetchStatus: 'synced'
    };
  } catch (_) {
    return null;
  }
}

async function directBackgroundFetchChatGPT() {
  try {
    const sessResp = await fetch('https://chatgpt.com/api/auth/session', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    if (!sessResp.ok) return null;

    const sessionData = await sessResp.json();
    const token = sessionData?.accessToken;
    if (!token) return null;

    let tier = 'free';
    let tierLabel = 'ChatGPT Free';
    let usedPercent = null;
    let resetsAt = null;
    let quotaWindows = null;
    const windows = [];

    const accountId = sessionData?.account?.id || '';
    const authHeaders = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    };
    if (accountId && accountId !== 'personal') {
      authHeaders['ChatGPT-Account-Id'] = accountId;
    }

    try {
      const usageResp = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        credentials: 'include',
        headers: authHeaders
      });
      if (usageResp.ok) {
        quotaWindows = await usageResp.json();
        if (quotaWindows.plan_type) {
          const planStr = String(quotaWindows.plan_type).toLowerCase();
          if (planStr.includes('pro')) { tier = 'pro'; tierLabel = 'ChatGPT Pro'; }
          else if (planStr.includes('team')) { tier = 'team'; tierLabel = 'ChatGPT Team'; }
          else if (planStr.includes('plus')) { tier = 'plus'; tierLabel = 'ChatGPT Plus'; }
        }
        const rl = quotaWindows.rate_limit;
        const addWin = (w, id, lbl) => {
          if (!w || typeof w !== 'object') return;
          let pct = typeof w.used_percent === 'number'
            ? Math.min(100, Math.max(0, Math.round(w.used_percent * 10) / 10))
            : (typeof w.used === 'number' && typeof w.limit === 'number' && w.limit > 0)
              ? Math.min(100, Math.max(0, Math.round((w.used / w.limit) * 1000) / 10))
              : null;
          if (pct === null) return;
          let rAt = (typeof w.reset_after_seconds === 'number' && w.reset_after_seconds > 0)
            ? Date.now() + Math.round(w.reset_after_seconds * 1000)
            : normalizeResetTs(w.reset_at || w.resets_at);
          windows.push({
            id,
            label: lbl,
            usedPercent: pct,
            remainingPercent: Math.max(0, Number((100 - pct).toFixed(1))),
            used: typeof w.used === 'number' ? w.used : null,
            limit: typeof w.limit === 'number' ? w.limit : null,
            remaining: typeof w.used === 'number' && typeof w.limit === 'number' ? Math.max(0, w.limit - w.used) : null,
            resetsAt: rAt
          });
          if (id === 'primary' || usedPercent === null) {
            usedPercent = pct;
            if (rAt) resetsAt = rAt;
          }
        };
        if (rl?.primary_window) addWin(rl.primary_window, 'primary', 'Primary Window');
        else if (rl) addWin(rl, 'primary', 'Rate Limit Window');
        if (rl?.secondary_window) addWin(rl.secondary_window, 'secondary', 'Weekly Window');
      }
    } catch (_) {}

    let tokenLimit = 128000;
    let tokensUsed = null;
    let inputTokens = null;
    let outputTokens = null;
    let conversationTitle = null;

    try {
      const lResp = await fetch('https://chatgpt.com/backend-api/conversations?offset=0&limit=1&order=updated', {
        credentials: 'include',
        headers: authHeaders
      });
      if (lResp.ok) {
        const lData = await lResp.json();
        if (Array.isArray(lData?.items) && lData.items.length > 0) {
          const convId = lData.items[0].id;
          const cResp = await fetch(`https://chatgpt.com/backend-api/conversation/${convId}`, {
            credentials: 'include',
            headers: authHeaders
          });
          if (cResp.ok) {
            const cData = await cResp.json();
            conversationTitle = cData?.title || null;
            let inTok = 0;
            let outTok = 0;
            for (const node of Object.values(cData?.mapping || {})) {
              const msg = node?.message;
              if (!msg || !msg.content) continue;
              const role = msg.author?.role;
              if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
              const parts = Array.isArray(msg.content.parts)
                ? msg.content.parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
                : (msg.content.text || '');
              const t = Math.ceil(parts.length / 3.8);
              if (role === 'user') inTok += t;
              else outTok += t;
            }
            inputTokens = inTok;
            outputTokens = outTok;
            tokensUsed = inTok + outTok;
          }
        }
      }
    } catch (_) {}

    return {
      botId: 'chatgpt',
      isLoggedIn: true,
      tier,
      tierLabel,
      usedPercent,
      remainingPercent: usedPercent !== null ? Math.max(0, Number((100 - usedPercent).toFixed(1))) : null,
      resetsAt,
      windows,
      quotaWindows,
      tokensUsed,
      inputTokens,
      outputTokens,
      tokenLimit,
      tokensRemaining: typeof tokensUsed === 'number' ? Math.max(0, tokenLimit - tokensUsed) : null,
      conversationTitle,
      accountEmail: sessionData.user?.email || null,
      tokenSource: 'ChatGPT API + Active Chat',
      fetchStatus: 'synced'
    };
  } catch (_) {
    return null;
  }
}

/**
 * Execute live telemetry fetch in an existing tab (or temporary background tab when requested)
 */
async function executeMainWorldFetchInTab(tabId, botId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: inPageLiveTelemetryRunner,
      args: [botId]
    });
    if (Array.isArray(results) && results[0]?.result) {
      return results[0].result;
    }
  } catch (err) {
    console.debug(`[Know Ur Limit] executeScript note for ${botId}:`, err.message);
  }
  return null;
}

/**
 * Briefly open a hidden background tab to read first-party session telemetry (localStorage/WIZ/API)
 * when user explicitly clicks Sync and no tab is open.
 */
async function fetchViaTemporaryTab(botId) {
  const botDef = BOTS[botId];
  if (!botDef) return null;

  let tempTabId = null;
  try {
    const tab = await chrome.tabs.create({ url: botDef.url, active: false });
    tempTabId = tab.id;
    if (!tempTabId) return null;

    // Wait for tab to finish loading (max 6.5s)
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 6500);

      function listener(updatedTabId, info) {
        if (updatedTabId === tempTabId && info.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 600);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });

    const data = await executeMainWorldFetchInTab(tempTabId, botId);
    return data;
  } catch (_) {
    return null;
  } finally {
    if (tempTabId) {
      try {
        await chrome.tabs.remove(tempTabId);
      } catch (_) {}
    }
  }
}

/**
 * Sync limits & tokens for a specific bot
 */
export async function syncBotLimits(botId, { allowTempTab = false } = {}) {
  const botDef = BOTS[botId];
  if (!botDef) return null;

  // 1. Check if there is already an open tab for this bot
  const tabs = await new Promise(r => chrome.tabs.query({}, r));
  const targetTab = (tabs || []).find(t =>
    t.url && botDef.domains.some(domain => t.url.includes(domain))
  );

  if (targetTab && targetTab.id) {
    const tabData = await executeMainWorldFetchInTab(targetTab.id, botId);
    if (tabData) {
      const updatedState = await recordAutoFetchedUsage(botId, tabData);
      await handlePostSyncNotificationsAndAlarms(botId, updatedState);
      return updatedState;
    }
  }

  // 2. Check cookie-based login status
  const isUserLoggedIn = await checkBotLoginStatus(botId);

  // 3. Attempt direct background fetch for Claude / ChatGPT
  let bgData = null;
  if (botId === 'claude') bgData = await directBackgroundFetchClaude();
  else if (botId === 'chatgpt') bgData = await directBackgroundFetchChatGPT();

  if (bgData && (bgData.usedPercent !== null || bgData.tokensUsed !== null)) {
    const updatedState = await recordAutoFetchedUsage(botId, bgData);
    await handlePostSyncNotificationsAndAlarms(botId, updatedState);
    return updatedState;
  }

  // 4. If user explicitly requested sync (e.g. clicked Sync button) and either is logged in via cookies
  //    or provider uses localStorage (DeepSeek) / WIZ (Gemini), fetch via hidden background tab
  if (allowTempTab && (isUserLoggedIn || botId === 'deepseek')) {
    const tempData = await fetchViaTemporaryTab(botId);
    if (tempData) {
      const updatedState = await recordAutoFetchedUsage(botId, tempData);
      await handlePostSyncNotificationsAndAlarms(botId, updatedState);
      return updatedState;
    }
  }

  if (!isUserLoggedIn) {
    const current = await getBotState(botId);
    // Preserve DeepSeek logged-in state if previously synced from localStorage
    if (botId === 'deepseek' && current?.isLoggedIn && current?.hasRealTelemetry) {
      return current;
    }
    const updatedState = await recordAutoFetchedUsage(botId, {
      isLoggedIn: false,
      fetchStatus: 'login_required'
    });
    await updateExtensionBadge();
    await broadcastStateUpdate();
    return updatedState;
  }

  // Logged in via cookies, but needs an active tab or click on Sync for full in-page telemetry
  const existing = await getBotState(botId);
  if (existing && existing.hasRealTelemetry) {
    return existing;
  }

  const updatedState = await recordAutoFetchedUsage(botId, {
    isLoggedIn: true,
    fetchStatus: 'tab_required'
  });
  await updateExtensionBadge();
  await broadcastStateUpdate();
  return updatedState;
}

async function handlePostSyncNotificationsAndAlarms(botId, state) {
  if (!state) return;
  if (state.resetsAt && state.resetsAt > Date.now()) {
    chrome.alarms.create(`alarm_reset_${botId}`, { when: state.resetsAt });
  }

  const settings = await getSettings();
  const botDef = BOTS[botId];

  if (state._approachingTriggered && settings.notifyOnApproaching !== false && botDef) {
    const remStr = state.tokensRemaining !== null
      ? `${state.tokensRemaining.toLocaleString()} tokens remaining`
      : `${state.remainingPercent ?? 0}% remaining`;
    chrome.notifications.create(`notify_approaching_${botId}_${Date.now()}`, {
      type: 'basic',
      iconUrl: '../icons/icon128.png',
      title: `⚠️ ${botDef.name} Usage Alert (${state.usedPercent}%)`,
      message: `You have reached ${state.usedPercent}% of your ${botDef.name} limit (${remStr}).`,
      priority: 2
    });
  }

  await updateExtensionBadge();
  await broadcastStateUpdate();
}

/**
 * Synchronize limits across all supported bots
 */
export async function syncAllBotLimits({ allowTempTab = false } = {}) {
  const promises = Object.keys(BOTS).map(botId => syncBotLimits(botId, { allowTempTab }));
  await Promise.all(promises);
  return await getAllBotStates();
}

// ----------------------------------------------------
// Runtime Message Listener
// ----------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, data } = message;

  (async () => {
    try {
      switch (action) {
        case 'AUTO_FETCH_RESULT': {
          const state = await recordAutoFetchedUsage(data.botId, data);
          await handlePostSyncNotificationsAndAlarms(data.botId, state);
          sendResponse({ success: true, state });
          break;
        }

        case 'SYNC_USAGE_LIMITS': {
          const states = await syncAllBotLimits({ allowTempTab: Boolean(data?.allowTempTab) });
          sendResponse({ success: true, states });
          break;
        }

        case 'SYNC_BOT_NOW': {
          const state = await syncBotLimits(data?.botId, { allowTempTab: true });
          sendResponse({ success: true, state });
          break;
        }

        case 'LIMIT_DETECTED': {
          const state = await recordLimitDetected(data.botId, data);
          if (state?.resetsAt && state.resetsAt > Date.now()) {
            chrome.alarms.create(`alarm_reset_${data.botId}`, { when: state.resetsAt });
          }

          const settings = await getSettings();
          const botDef = BOTS[data.botId];
          if (settings.notifyOnLimit && botDef) {
            chrome.notifications.create(`notify_limit_${data.botId}_${Date.now()}`, {
              type: 'basic',
              iconUrl: '../icons/icon128.png',
              title: `⚠️ ${botDef.name} Limit Reached`,
              message: data.reason || `Usage cap reached. Reset countdown active.`,
              priority: 1
            });
          }

          await updateExtensionBadge();
          await broadcastStateUpdate();
          sendResponse({ success: true, state });
          break;
        }

        case 'PLAN_DETECTED': {
          const state = await updateBotPlan(data.botId, data.plan);
          await broadcastStateUpdate();
          sendResponse({ success: true, state });
          break;
        }

        case 'HEARTBEAT': {
          const state = await updateBotHeartbeat(data.botId, data);
          sendResponse({ success: true, state });
          break;
        }

        case 'REQUEST_BOT_STATE': {
          const state = await getBotState(data.botId);
          sendResponse({ success: true, state });
          break;
        }

        case 'GET_ALL_STATES': {
          const states = await getAllBotStates();
          sendResponse({ success: true, states });
          break;
        }

        case 'CLEAR_LIMIT': {
          const state = await clearLimit(data.botId);
          chrome.alarms.clear(`alarm_reset_${data.botId}`);
          await updateExtensionBadge();
          await broadcastStateUpdate();
          sendResponse({ success: true, state });
          break;
        }

        case 'CLEAR_ALL_DATA': {
          await clearAllData();
          await updateExtensionBadge();
          await broadcastStateUpdate();
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (err) {
      console.error('[Know Ur Limit] Error processing message:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});

chrome.notifications.onClicked.addListener(() => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});
