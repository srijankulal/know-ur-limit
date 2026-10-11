/**
 * AI Usage Limits Hub - Storage & State Management
 */

import { BOTS, STATUS, DEFAULT_SETTINGS } from './constants.js';

const STORAGE_KEYS = {
  BOTS_STATE: 'ai_limits_bots_state_v1',
  SETTINGS: 'ai_limits_settings_v1',
  HISTORY: 'ai_limits_history_v1'
};

/**
 * Low-level storage adapter with fallback to localStorage and in-memory Map
 */
const inMemoryStore = new Map();

const storageAdapter = {
  async get(key) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get([key], (result) => {
          resolve(result[key] !== undefined ? result[key] : null);
        });
      });
    }
    try {
      if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : null;
      }
    } catch (_) {}
    return inMemoryStore.has(key) ? inMemoryStore.get(key) : null;
  },

  async set(key, value) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return new Promise((resolve) => {
        chrome.storage.local.set({ [key]: value }, () => resolve(true));
      });
    }
    try {
      if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      }
    } catch (_) {}
    inMemoryStore.set(key, value);
    return true;
  }
};

/**
 * Get extension settings
 */
export async function getSettings() {
  const settings = await storageAdapter.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

/**
 * Save extension settings
 */
export async function saveSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  await storageAdapter.set(STORAGE_KEYS.SETTINGS, merged);
  return merged;
}

/**
 * Initialize default bot state
 */
function createDefaultBotState(botId, settings) {
  const botDef = BOTS[botId];
  const custom = settings?.customLimits?.[botId] || {};
  const tierKey = custom.tier || Object.keys(botDef.tiers)[0];
  const tierDef = botDef.tiers[tierKey] || Object.values(botDef.tiers)[0];
  const maxPrompts = custom.maxPrompts || tierDef.defaultMax;

  return {
    botId,
    tier: tierKey,
    maxPrompts,
    windowMinutes: custom.windowMinutes || tierDef.windowMinutes,
    status: STATUS.UNKNOWN,
    prompts: [],
    resetsAt: null,
    limitReason: '',
    lastSeen: null,
    activeModel: botDef.defaultModel,
    // Live usage tracking (how much used & how much pending)
    usedCount: 0,
    pendingCount: maxPrompts,
    usedPercent: 0,
    pendingPercent: 100,
    liveUtilizationPercent: null,
    // Auto-fetch telemetry fields
    fetchedFromBrowser: false,
    lastFetchedAt: null,
    quotaWindows: null,
    isLoggedIn: false,
    accountEmail: null,
    fetchStatus: 'idle' // 'idle' | 'synced' | 'login_required' | 'error' | 'tab_required'
  };
}

/**
 * Clean up expired prompts outside the rolling window
 */
function purgeExpiredPrompts(state, now = Date.now()) {
  const windowMs = (state.windowMinutes || 180) * 60 * 1000;
  const cutoff = now - windowMs;
  state.prompts = (state.prompts || []).filter(p => p.timestamp >= cutoff);
  return state;
}

/**
 * Re-evaluate bot status (e.g., checks if limit countdown has expired)
 */
function evaluateStatus(state, now = Date.now(), thresholdPercent = 85) {
  // If not logged in and marked as login_required, status is UNKNOWN
  if (!state.isLoggedIn && state.fetchStatus === 'login_required') {
    state.status = STATUS.UNKNOWN;
    return state;
  }

  // If explicitly limited, check if resetsAt has passed
  if (state.status === STATUS.LIMITED) {
    if (state.resetsAt && state.resetsAt <= now) {
      state.status = STATUS.AVAILABLE;
      state.resetsAt = null;
      state.limitReason = '';
      state.lastApproachingAlertTs = null;
      state.liveUtilizationPercent = null;
      state.prompts = [];
      state.usedPercent = 0;
      state.pendingPercent = 100;
      state.usedCount = 0;
      state.pendingCount = state.maxPrompts || 80;
    } else {
      return state;
    }
  }

  purgeExpiredPrompts(state, now);
  const count = state.prompts.length;
  const max = state.maxPrompts || 80;

  // Use live utilization percentage from server API if available, else derive from prompts
  if (typeof state.liveUtilizationPercent === 'number' && state.liveUtilizationPercent !== null) {
    state.usedPercent = Math.min(100, Math.max(0, state.liveUtilizationPercent));
    state.usedCount = Math.min(max, Math.round((state.usedPercent / 100) * max));
    state.pendingCount = Math.max(0, max - state.usedCount);
  } else {
    state.usedPercent = Math.min(100, Math.round((count / max) * 100));
    state.usedCount = count;
    state.pendingCount = Math.max(0, max - count);
  }
  state.pendingPercent = Math.max(0, 100 - state.usedPercent);

  if (state.usedCount >= max || state.usedPercent >= 100) {
    state.status = STATUS.LIMITED;
    // Calculate reset time based on the oldest prompt expiry
    if (!state.resetsAt && state.prompts.length > 0) {
      const oldestPromptTime = state.prompts[0].timestamp;
      const windowMs = (state.windowMinutes || 180) * 60 * 1000;
      state.resetsAt = oldestPromptTime + windowMs;
      state.limitReason = `Rolling quota reached (${state.usedCount}/${max} prompts).`;
    }
  } else if (state.usedPercent >= thresholdPercent) {
    state.status = STATUS.APPROACHING;
  } else if (state.isLoggedIn || state.lastSeen) {
    state.status = STATUS.AVAILABLE;
  } else {
    state.status = STATUS.UNKNOWN;
  }

  return state;
}

/**
 * Get state for all bots
 */
export async function getAllBotStates() {
  const settings = await getSettings();
  let states = await storageAdapter.get(STORAGE_KEYS.BOTS_STATE) || {};
  const now = Date.now();
  let updated = false;

  for (const botId of Object.keys(BOTS)) {
    if (!states[botId]) {
      states[botId] = createDefaultBotState(botId, settings);
      updated = true;
    } else {
      const beforeStatus = states[botId].status;
      const beforeResetsAt = states[botId].resetsAt;
      states[botId] = evaluateStatus(states[botId], now, settings.warningThresholdPercent || 85);
      if (beforeStatus !== states[botId].status || beforeResetsAt !== states[botId].resetsAt) {
        updated = true;
      }
    }
  }

  if (updated) {
    await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, states);
  }

  return states;
}

/**
 * Get state for a single bot
 */
export async function getBotState(botId) {
  const all = await getAllBotStates();
  return all[botId] || null;
}

/**
 * Record a prompt sent by user with approaching limit check
 */
export async function recordPromptSent(botId, model = null) {
  const settings = await getSettings();
  const all = await getAllBotStates();
  const state = all[botId];
  if (!state) return null;

  const now = Date.now();
  state.lastSeen = now;
  state.isLoggedIn = true;
  state.fetchStatus = 'synced';
  if (model) state.activeModel = model;

  purgeExpiredPrompts(state, now);
  state.prompts.push({
    timestamp: now,
    model: model || state.activeModel
  });

  const max = state.maxPrompts || 80;
  // If we had a liveUtilizationPercent from the provider, also reflect this prompt
  if (typeof state.liveUtilizationPercent === 'number' && state.liveUtilizationPercent !== null) {
    const promptIncrement = (1 / max) * 100;
    state.liveUtilizationPercent = Math.min(100, Math.round(state.liveUtilizationPercent + promptIncrement));
  }

  const threshold = settings.warningThresholdPercent || 85;
  evaluateStatus(state, now, threshold);

  const count = state.usedCount;
  const pct = state.usedPercent;

  // Check if we hit the warning threshold (e.g. 85%)
  let approachingTriggered = false;
  const windowMs = (state.windowMinutes || 180) * 60 * 1000;
  if (pct >= threshold && state.status !== STATUS.LIMITED) {
    if (!state.lastApproachingAlertTs || (now - state.lastApproachingAlertTs) >= windowMs) {
      state.lastApproachingAlertTs = now;
      approachingTriggered = true;
    }
  }

  all[botId] = state;
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);

  // Append to history log
  await logHistoryEvent({
    type: approachingTriggered ? 'approaching_limit' : 'prompt',
    botId,
    model: model || state.activeModel,
    pct,
    timestamp: now
  });

  return { state, approachingTriggered, percentage: pct, remaining: Math.max(0, max - count) };
}

/**
 * Record a hard rate limit detected from network or DOM
 */
export async function recordLimitDetected(botId, { resetsAt, reason, model, plan } = {}) {
  const all = await getAllBotStates();
  const state = all[botId];
  if (!state) return null;

  const now = Date.now();
  state.lastSeen = now;
  state.isLoggedIn = true;
  state.status = STATUS.LIMITED;
  state.resetsAt = resetsAt || (now + (state.windowMinutes || 180) * 60 * 1000);
  state.limitReason = reason || 'Rate limit reached';
  state.liveUtilizationPercent = 100;
  state.usedPercent = 100;
  state.pendingPercent = 0;
  state.usedCount = state.maxPrompts || 80;
  state.pendingCount = 0;
  if (model) state.activeModel = model;
  if (plan) state.tier = plan;

  all[botId] = state;
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);

  await logHistoryEvent({
    type: 'limit_hit',
    botId,
    resetsAt: state.resetsAt,
    reason: state.limitReason,
    timestamp: now
  });

  return state;
}

/**
 * Record live usage limit auto-fetched directly from browser session
 */
export async function recordAutoFetchedUsage(botId, data = {}) {
  const settings = await getSettings();
  const all = await getAllBotStates();
  const state = all[botId];
  if (!state) return null;

  const now = Date.now();
  state.lastSeen = now;

  // Handle explicit not-logged-in case
  if (data.isLoggedIn === false) {
    state.isLoggedIn = false;
    state.fetchStatus = 'login_required';
    state.fetchedFromBrowser = false;
    state.status = STATUS.UNKNOWN;
    state.liveUtilizationPercent = null;
    if (data.limitReason) state.limitReason = data.limitReason;
    all[botId] = state;
    await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);
    return state;
  }

  state.lastFetchedAt = now;
  state.isLoggedIn = true;
  state.fetchedFromBrowser = true;
  state.fetchStatus = data.fetchStatus || 'synced';

  if (data.accountEmail) {
    state.accountEmail = data.accountEmail;
  }
  if (data.activeModel) {
    state.activeModel = data.activeModel;
  }

  // Update plan tier if detected from browser
  if (data.tier && BOTS[botId]?.tiers[data.tier]) {
    state.tier = data.tier;
    const tierDef = BOTS[botId].tiers[data.tier];
    const custom = settings?.customLimits?.[botId];
    state.maxPrompts = custom?.maxPrompts || tierDef.defaultMax;
    state.windowMinutes = custom?.windowMinutes || tierDef.windowMinutes;
  }

  // Update quota windows (e.g., Claude's 5-hour and 7-day quotas, ChatGPT windows)
  if (data.quotaWindows) {
    state.quotaWindows = data.quotaWindows;
  }

  // Update reset timestamp
  if (data.resetsAt !== undefined && data.resetsAt !== null) {
    state.resetsAt = data.resetsAt;
  }

  // Update used & pending quota numbers
  const max = state.maxPrompts || 80;
  if (typeof data.usedCount === 'number' && typeof data.pendingCount === 'number') {
    state.usedCount = Math.max(0, Math.round(data.usedCount));
    state.pendingCount = Math.max(0, Math.round(data.pendingCount));
    state.usedPercent = Math.min(100, Math.round((state.usedCount / max) * 100));
    state.pendingPercent = Math.max(0, 100 - state.usedPercent);
    state.liveUtilizationPercent = state.usedPercent;
  } else if (typeof data.usedPercent === 'number' && !isNaN(data.usedPercent)) {
    const rawPct = Math.min(100, Math.max(0, Math.round(data.usedPercent)));
    state.liveUtilizationPercent = rawPct;
    state.usedPercent = rawPct;
    state.pendingPercent = Math.max(0, 100 - rawPct);
    state.usedCount = Math.min(max, Math.round((rawPct / 100) * max));
    state.pendingCount = Math.max(0, max - state.usedCount);

    // Reconstruct prompt markers so count is consistent with percentage
    const targetCount = state.usedCount;
    const windowMs = (state.windowMinutes || 180) * 60 * 1000;
    const oldestTs = state.resetsAt ? Math.max(now - windowMs, state.resetsAt - windowMs) : (now - (windowMs / 2));

    state.prompts = [];
    for (let i = 0; i < targetCount; i++) {
      state.prompts.push({
        timestamp: oldestTs + Math.floor((i / Math.max(1, targetCount)) * (now - oldestTs)),
        model: state.activeModel,
        autoFetched: true
      });
    }
  }

  if (data.limitReason) {
    state.limitReason = data.limitReason;
  }

  // Evaluate status
  const threshold = settings.warningThresholdPercent || 85;
  if (data.isLimited || state.usedPercent >= 100 || (state.resetsAt && state.resetsAt > now && state.usedPercent >= 95)) {
    state.status = STATUS.LIMITED;
    if (!state.limitReason) state.limitReason = `${BOTS[botId]?.name || 'AI'} rate limit hit.`;
  } else if (state.usedPercent >= threshold) {
    state.status = STATUS.APPROACHING;
  } else {
    state.status = STATUS.AVAILABLE;
  }

  all[botId] = state;
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);

  await logHistoryEvent({
    type: 'auto_fetch_sync',
    botId,
    usedPercent: state.usedPercent,
    tier: state.tier,
    status: state.status,
    timestamp: now
  });

  return state;
}

/**
 * Clear rate limit for a bot
 */
export async function clearLimit(botId) {
  const settings = await getSettings();
  const all = await getAllBotStates();
  const state = all[botId];
  if (!state) return null;

  state.status = STATUS.AVAILABLE;
  state.resetsAt = null;
  state.limitReason = '';
  state.lastApproachingAlertTs = null;
  all[botId] = evaluateStatus(state, Date.now(), settings.warningThresholdPercent || 85);
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);

  return state;
}

/**
 * Directly update custom limits for a bot (max prompts, window duration, tier)
 */
export async function updateBotCustomLimit(botId, { maxPrompts, windowMinutes, tier } = {}) {
  const all = await getAllBotStates();
  const state = all[botId];
  if (!state) return null;

  if (maxPrompts !== undefined && Number(maxPrompts) > 0) {
    state.maxPrompts = Number(maxPrompts);
  }
  if (windowMinutes !== undefined && Number(windowMinutes) > 0) {
    state.windowMinutes = Number(windowMinutes);
  }
  if (tier) {
    state.tier = tier;
  }

  const settings = await getSettings();
  if (!settings.customLimits) settings.customLimits = {};
  settings.customLimits[botId] = {
    tier: state.tier,
    maxPrompts: state.maxPrompts,
    windowMinutes: state.windowMinutes
  };
  await saveSettings(settings);

  all[botId] = evaluateStatus(state, Date.now(), settings.warningThresholdPercent || 85);
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);
  return state;
}

/**
 * Update user plan/tier for a bot
 */
export async function updateBotPlan(botId, tierKey) {
  const all = await getAllBotStates();
  const state = all[botId];
  const botDef = BOTS[botId];
  if (!state || !botDef || !botDef.tiers[tierKey]) return null;

  const tierDef = botDef.tiers[tierKey];
  state.tier = tierKey;
  state.maxPrompts = tierDef.defaultMax;
  state.windowMinutes = tierDef.windowMinutes;
  
  evaluateStatus(state, Date.now());
  all[botId] = state;
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);
  return state;
}

/**
 * Mark bot as active/online
 */
export async function updateBotHeartbeat(botId, extra = {}) {
  const all = await getAllBotStates();
  const state = all[botId];
  if (!state) return null;

  state.lastSeen = Date.now();
  if (extra.activeModel) state.activeModel = extra.activeModel;
  if (extra.tier && BOTS[botId]?.tiers[extra.tier]) {
    state.tier = extra.tier;
  }
  if (state.status === STATUS.UNKNOWN) {
    state.status = STATUS.AVAILABLE;
  }

  all[botId] = evaluateStatus(state, Date.now());
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);
  return state;
}

/**
 * Simulate a rate limit for testing
 */
export async function simulateLimit(botId, durationMinutes = 15) {
  const resetsAt = Date.now() + durationMinutes * 60 * 1000;
  return recordLimitDetected(botId, {
    resetsAt,
    reason: `Simulated limit for testing (${durationMinutes}m cooldown)`,
    model: BOTS[botId]?.defaultModel
  });
}

/**
 * History event logging (limited to last 100 items)
 */
async function logHistoryEvent(event) {
  try {
    let history = await storageAdapter.get(STORAGE_KEYS.HISTORY) || [];
    history.unshift(event);
    if (history.length > 100) history = history.slice(0, 100);
    await storageAdapter.set(STORAGE_KEYS.HISTORY, history);
  } catch (e) {
    console.warn('Failed to log history event:', e);
  }
}

/**
 * Get history events
 */
export async function getHistoryEvents() {
  return (await storageAdapter.get(STORAGE_KEYS.HISTORY)) || [];
}

/**
 * Reset all extension data
 */
export async function clearAllData() {
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, {});
  await storageAdapter.set(STORAGE_KEYS.HISTORY, []);
  return true;
}
