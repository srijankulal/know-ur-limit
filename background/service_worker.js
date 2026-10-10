/**
 * AI Usage Limits Hub - Background Service Worker (Manifest V3)
 */

import { BOTS, STATUS } from '../shared/constants.js';
import {
  getAllBotStates,
  getBotState,
  recordPromptSent,
  recordLimitDetected,
  clearLimit,
  updateBotPlan,
  updateBotHeartbeat,
  updateBotCustomLimit,
  simulateLimit,
  getSettings,
  clearAllData
} from '../shared/storage.js';

// Setup periodic alarm on install/startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[AI Usage Limits] Installed successfully');
  chrome.alarms.create('periodic_status_tick', { periodInMinutes: 1 });
  await updateExtensionBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await updateExtensionBadge();
});

// Handle Alarms (Reset Timers & Status Ticks)
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

// Handle Runtime Messages from Content Scripts & Popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, data } = message;

  (async () => {
    try {
      switch (action) {
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
                message: `You've used ${count}/${max} messages. Only ${remaining} prompts left before cooldown. Click to customize limits.`,
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
          // Set alarm for when it resets
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

  return true; // Keep message channel open for async response
});

// Open Options Page when notification is clicked so user can customize limits
chrome.notifications.onClicked.addListener((notificationId) => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});
