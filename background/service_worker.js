/**
 * AI Usage Limits Hub - Background Service Worker (Manifest V3)
 * Manages rolling quota tracking, automated browser session telemetry,
 * desktop notifications, and extension badge updates.
 */

import { BOTS, STATUS } from '../shared/constants.js';
import {
  getAllBotStates,
  getBotState,
  recordPromptSent,
  recordLimitDetected,
  recordAutoFetchedUsage,
  clearLimit,
  updateBotPlan,
  updateBotHeartbeat,
  updateBotCustomLimit,
  simulateLimit,
  getSettings,
  clearAllData
} from '../shared/storage.js';

// Setup periodic alarms on install/startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[AI Usage Limits] Extension initialized');
  chrome.alarms.create('periodic_status_tick', { periodInMinutes: 1 });
  chrome.alarms.create('periodic_auto_fetch', { periodInMinutes: 2 });
  await updateExtensionBadge();
  await syncAllBotLimits();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('periodic_status_tick', { periodInMinutes: 1 });
  chrome.alarms.create('periodic_auto_fetch', { periodInMinutes: 2 });
  await updateExtensionBadge();
  await syncAllBotLimits();
});

// Watch for tab navigation to AI chat providers to auto-fetch immediately
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    for (const [botId, botDef] of Object.entries(BOTS)) {
      if (botDef.domains.some(d => tab.url.includes(d))) {
        // Tab finished loading, trigger sync for this bot
        setTimeout(() => syncBotLimits(botId), 1500);
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
          message: `Your message allowance for ${botDef.name} has been restored. You can continue chatting!`,
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
      await syncAllBotLimits();
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

      if (state.status === STATUS.LIMITED || (state.resetsAt && state.resetsAt > now)) {
        limitedCount++;
        const rem = (state.resetsAt || now) - now;
        if (rem < minRemainingMs) minRemainingMs = rem;
      } else if (state.status === STATUS.APPROACHING) {
        approachingCount++;
      }
    }

    if (limitedCount > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // Red
      if (settings.badgeMode === 'count') {
        chrome.action.setBadgeText({ text: `${limitedCount}` });
      } else {
        // Countdown mode
        const mins = Math.max(1, Math.ceil(minRemainingMs / 60000));
        const badgeText = mins > 99 ? '99m+' : `${mins}m`;
        chrome.action.setBadgeText({ text: badgeText });
      }
    } else if (approachingCount > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // Amber
      chrome.action.setBadgeText({ text: '!' });
    } else {
      chrome.action.setBadgeBackgroundColor({ color: '#10b981' }); // Green
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    console.warn('Error updating badge:', e);
  }
}

// Broadcast State Update to All Open Tabs
async function broadcastStateUpdate() {
  try {
    const states = await getAllBotStates();
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs.sendMessage(tab.id, {
          action: 'STATE_UPDATED',
          data: states
        }).catch(() => {});
      }
    });
  } catch (e) {}
}

// ----------------------------------------------------
// Automated Browser Session & Auth Checking
// ----------------------------------------------------

/**
 * Check if the user is authenticated with a provider by inspecting Chrome cookies
 */
export async function checkBotLoginStatus(botId) {
  const botDef = BOTS[botId];
  if (!botDef) return false;

  try {
    // 1. URL-based cookie check
    if (typeof chrome !== 'undefined' && chrome.cookies) {
      const urlCookies = await new Promise(r => chrome.cookies.getAll({ url: botDef.url }, r));
      if (urlCookies && urlCookies.some(c => botDef.authCookies?.includes(c.name) && c.value && c.value.trim().length > 0)) {
        return true;
      }

      // 2. Domain-based cookie check
      const domain = botDef.authDomain || botDef.domains[0];
      const domCookies = await new Promise(r => chrome.cookies.getAll({ domain }, r));
      if (domCookies && domCookies.some(c => botDef.authCookies?.includes(c.name) && c.value && c.value.trim().length > 0)) {
        return true;
      }

      // 2b. Dot-prefixed domain check (.claude.ai)
      const dotCookies = await new Promise(r => chrome.cookies.getAll({ domain: '.' + domain }, r));
      if (dotCookies && dotCookies.some(c => botDef.authCookies?.includes(c.name) && c.value && c.value.trim().length > 0)) {
        return true;
      }
    }

    // 3. Tab-based verification: Check if an open tab is on an authenticated chat/app page
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
        return u.includes('/chat') || u.includes('/c/') || u.includes('/app') || u.includes('/project') || u.endsWith('.com/') || u.endsWith('.ai/');
      })) {
        return true;
      }
    }
  } catch (err) {
    console.warn(`[AI Usage Limits] Auth check error for ${botId}:`, err);
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

      if (isDomainMatch && botDef.authCookies.includes(cookie.name)) {
        clearTimeout(cookieDebounce);
        cookieDebounce = setTimeout(async () => {
          console.log(`[AI Usage Limits] Real-time auth cookie change for ${botDef.name}:`, changeInfo.removed ? 'logged out' : 'logged in');
          await syncBotLimits(botId);
        }, 1200);
        break;
      }
    }
  });
}

/**
 * Attempt direct background fetch for Claude if cookies are present
 */
async function directBackgroundFetchClaude() {
  try {
    const orgResp = await fetch('https://claude.ai/api/organizations', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    if (!orgResp.ok) return null;

    const orgs = await orgResp.json();
    const orgList = Array.isArray(orgs) ? orgs : (orgs?.items || [orgs]);
    if (orgList.length === 0 || !orgList[0]?.id) return null;

    const org = orgList[0];
    const orgId = org.id;
    const caps = org.capabilities || [];
    const tier = caps.includes('claude_team') ? 'team' : (caps.includes('claude_pro') || org.has_active_subscription) ? 'pro' : 'free';

    let usedPercent = null;
    let resetsAt = null;
    let quotaWindows = null;

    if (orgId) {
      try {
        const usageResp = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (usageResp.ok) {
          quotaWindows = await usageResp.json();
          if (quotaWindows.five_hour) {
            const util = quotaWindows.five_hour.utilization;
            if (typeof util === 'number') {
              usedPercent = util <= 1.0 && util > 0 ? Math.round(util * 100) : Math.round(util);
            }
            if (quotaWindows.five_hour.resets_at) {
              const p = new Date(quotaWindows.five_hour.resets_at).getTime();
              if (!isNaN(p)) resetsAt = p;
            }
          }
        }
      } catch (_) {}
    }

    return {
      botId: 'claude',
      isLoggedIn: true,
      tier,
      usedPercent,
      resetsAt,
      quotaWindows,
      fetchStatus: 'synced'
    };
  } catch (_) {
    return null;
  }
}

/**
 * Attempt direct background fetch for ChatGPT if session cookies exist
 */
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

    let tier = 'plus';
    let usedPercent = null;
    let usedCount = null;
    let pendingCount = null;
    let resetsAt = null;
    let quotaWindows = null;

    const accountId = sessionData?.account?.id || sessionData?.user?.id || sessionData?.accountId || '';
    const authHeaders = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    };
    if (accountId) {
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
        }
      }
    } catch (_) {}

    return {
      botId: 'chatgpt',
      isLoggedIn: true,
      tier,
      usedPercent,
      usedCount,
      pendingCount,
      resetsAt,
      quotaWindows,
      accountEmail: sessionData.user?.email || null,
      fetchStatus: 'synced'
    };
  } catch (_) {
    return null;
  }
}

/**
 * Attempt direct background fetch for Gemini
 */
async function directBackgroundFetchGemini() {
  try {
    const isLogged = await checkBotLoginStatus('gemini');
    if (isLogged) {
      return {
        botId: 'gemini',
        isLoggedIn: true,
        tier: 'free',
        fetchStatus: 'synced'
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Attempt direct background fetch for DeepSeek
 */
async function directBackgroundFetchDeepSeek() {
  try {
    const userResp = await fetch('https://chat.deepseek.com/api/v0/users/current', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    if (!userResp.ok) return null;
    const userData = await userResp.json();
    if (userData?.code === 0 && userData?.data) {
      return {
        botId: 'deepseek',
        isLoggedIn: true,
        tier: 'free',
        accountEmail: userData.data.email || userData.data.phone || userData.data.name || null,
        fetchStatus: 'synced'
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Sync limits for a specific bot via open tab message or direct background query
 */
export async function syncBotLimits(botId) {
  const botDef = BOTS[botId];
  if (!botDef) return null;

  // 1. Verify actual browser login status
  const isUserLoggedIn = await checkBotLoginStatus(botId);
  if (!isUserLoggedIn) {
    const updatedState = await recordAutoFetchedUsage(botId, {
      isLoggedIn: false,
      fetchStatus: 'login_required'
    });
    await updateExtensionBadge();
    await broadcastStateUpdate();
    return updatedState;
  }

  // 2. User is logged in: Check for open tab to query via content script
  return new Promise((resolve) => {
    chrome.tabs.query({}, async (tabs) => {
      // Find open tab matching this provider
      const targetTab = tabs.find(t =>
        t.url && botDef.domains.some(domain => t.url.includes(domain))
      );

      if (targetTab && targetTab.id) {
        // Send command to content script in tab
        chrome.tabs.sendMessage(targetTab.id, {
          action: 'TRIGGER_AUTO_FETCH',
          botId
        }, async (response) => {
          if (!chrome.runtime.lastError && response?.data) {
            const updatedState = await recordAutoFetchedUsage(botId, response.data);
            if (updatedState?.resetsAt && updatedState.resetsAt > Date.now()) {
              chrome.alarms.create(`alarm_reset_${botId}`, { when: updatedState.resetsAt });
            }
            await updateExtensionBadge();
            await broadcastStateUpdate();
            resolve(updatedState);
            return;
          }

          // If content script didn't answer in time, try direct background fallback
          const bgData = await executeDirectFallback(botId, true);
          resolve(bgData);
        });
      } else {
        // No open tab, attempt direct background fetch
        const bgData = await executeDirectFallback(botId, true);
        resolve(bgData);
      }
    });
  });
}

async function executeDirectFallback(botId, userIsLoggedIn = false) {
  let fetchedData = null;
  if (botId === 'claude') fetchedData = await directBackgroundFetchClaude();
  else if (botId === 'chatgpt') fetchedData = await directBackgroundFetchChatGPT();
  else if (botId === 'gemini') fetchedData = await directBackgroundFetchGemini();
  else if (botId === 'deepseek') fetchedData = await directBackgroundFetchDeepSeek();

  if (fetchedData) {
    const updatedState = await recordAutoFetchedUsage(botId, fetchedData);
    if (updatedState?.resetsAt && updatedState.resetsAt > Date.now()) {
      chrome.alarms.create(`alarm_reset_${botId}`, { when: updatedState.resetsAt });
    }
    await updateExtensionBadge();
    await broadcastStateUpdate();
    return updatedState;
  }

  // If user is logged in via cookies but background fetch was blocked by CORS/Cloudflare:
  if (userIsLoggedIn) {
    const current = await getBotState(botId);
    if (current && current.fetchedFromBrowser && current.usedPercent !== null) {
      return current;
    }
    const updatedState = await recordAutoFetchedUsage(botId, {
      isLoggedIn: true,
      fetchStatus: 'tab_required'
    });
    await updateExtensionBadge();
    await broadcastStateUpdate();
    return updatedState;
  }

  return await getBotState(botId);
}

/**
 * Synchronize limits across all supported bots
 */
export async function syncAllBotLimits() {
  const promises = Object.keys(BOTS).map(botId => syncBotLimits(botId));
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
          if (state.resetsAt && state.resetsAt > Date.now()) {
            chrome.alarms.create(`alarm_reset_${data.botId}`, { when: state.resetsAt });
          }

          // Check for notifications
          const settings = await getSettings();
          const botDef = BOTS[data.botId];

          if (state.status === STATUS.LIMITED && settings.notifyOnLimit && botDef) {
            chrome.notifications.create(`notify_limit_${data.botId}_${Date.now()}`, {
              type: 'basic',
              iconUrl: '../icons/icon128.png',
              title: `⚠️ ${botDef.name} Limit Reached`,
              message: state.limitReason || `Usage cap reached. Reset countdown active.`,
              priority: 1
            });
          }

          await updateExtensionBadge();
          await broadcastStateUpdate();
          sendResponse({ success: true, state });
          break;
        }

        case 'SYNC_USAGE_LIMITS': {
          const states = await syncAllBotLimits();
          sendResponse({ success: true, states });
          break;
        }

        case 'SYNC_BOT_NOW': {
          const state = await syncBotLimits(data?.botId);
          sendResponse({ success: true, state });
          break;
        }

        case 'PROMPT_SENT': {
          const result = await recordPromptSent(data.botId, data.model);
          const state = result?.state || result;

          if (result?.approachingTriggered) {
            const settings = await getSettings();
            const botDef = BOTS[data.botId];
            if (settings.notifyOnApproaching !== false && botDef) {
              const count = state.prompts.length;
              const max = state.maxPrompts;
              const pct = result.percentage || Math.round((count / max) * 100);
              const remaining = result.remaining !== undefined ? result.remaining : Math.max(0, max - count);
              chrome.notifications.create(`notify_approaching_${data.botId}_${Date.now()}`, {
                type: 'basic',
                iconUrl: '../icons/icon128.png',
                title: `⚠️ ${botDef.name} Limit Warning (${pct}%)`,
                message: `You've used ${count}/${max} messages. Only ${remaining} prompts left before cooldown.`,
                priority: 2
              });
            }
          }

          await updateExtensionBadge();
          await broadcastStateUpdate();
          sendResponse({ success: true, state });
          break;
        }

        case 'UPDATE_CUSTOM_LIMIT': {
          const state = await updateBotCustomLimit(data.botId, data);
          await updateExtensionBadge();
          await broadcastStateUpdate();
          sendResponse({ success: true, state });
          break;
        }

        case 'LIMIT_DETECTED': {
          const state = await recordLimitDetected(data.botId, data);
          if (state.resetsAt && state.resetsAt > Date.now()) {
            chrome.alarms.create(`alarm_reset_${data.botId}`, { when: state.resetsAt });
          }

          const settings = await getSettings();
          const botDef = BOTS[data.botId];
          if (settings.notifyOnLimit && botDef) {
            chrome.notifications.create(`notify_limit_${data.botId}_${Date.now()}`, {
              type: 'basic',
              iconUrl: '../icons/icon128.png',
              title: `⚠️ ${botDef.name} Limit Reached`,
              message: data.reason || `Usage cap reached. Cooldown timer active.`,
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

        case 'SIMULATE_LIMIT': {
          const duration = data.durationMinutes || 15;
          const state = await simulateLimit(data.botId, duration);
          if (state.resetsAt) {
            chrome.alarms.create(`alarm_reset_${data.botId}`, { when: state.resetsAt });
          }
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
      console.error('[Service Worker] Error processing message:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});

// Open Options Page when notification is clicked
chrome.notifications.onClicked.addListener((notificationId) => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});
