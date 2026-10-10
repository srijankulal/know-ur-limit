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

  return {
    botId,
    tier: tierKey,
    maxPrompts: custom.maxPrompts || tierDef.defaultMax,
    windowMinutes: custom.windowMinutes || tierDef.windowMinutes,
    status: STATUS.UNKNOWN,
    prompts: [],
    resetsAt: null,
    limitReason: '',
    lastSeen: null,
    activeModel: botDef.defaultModel
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
function evaluateStatus(state, now = Date.now()) {
  // If explicitly limited, check if resetsAt has passed
  if (state.status === STATUS.LIMITED) {
    if (state.resetsAt && state.resetsAt <= now) {
      state.status = STATUS.AVAILABLE;
      state.resetsAt = null;
      state.limitReason = '';
    } else {
      return state;
    }
  }

  purgeExpiredPrompts(state, now);
  const count = state.prompts.length;
  const max = state.maxPrompts || 80;

  if (count >= max) {
    state.status = STATUS.LIMITED;
    // Calculate reset time based on the oldest prompt expiry
    if (!state.resetsAt && state.prompts.length > 0) {
      const oldestPromptTime = state.prompts[0].timestamp;
      const windowMs = (state.windowMinutes || 180) * 60 * 1000;
      state.resetsAt = oldestPromptTime + windowMs;
      state.limitReason = `Rolling quota reached (${count}/${max} prompts).`;
    }
  } else if (count >= Math.floor(max * 0.8)) {
    state.status = STATUS.APPROACHING;
  } else if (state.lastSeen) {
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
      states[botId] = evaluateStatus(states[botId], now);
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
 * Record a prompt sent by user
 */
export async function recordPromptSent(botId, model = null) {
  const all = await getAllBotStates();
  const state = all[botId];
  if (!state) return null;

  const now = Date.now();
  state.lastSeen = now;
  if (model) state.activeModel = model;

  purgeExpiredPrompts(state, now);
  state.prompts.push({
    timestamp: now,
    model: model || state.activeModel
  });

  evaluateStatus(state, now);
  all[botId] = state;
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);

  // Append to history log
  await logHistoryEvent({
    type: 'prompt',
    botId,
    model: model || state.activeModel,
    timestamp: now
  });

  return state;
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
  state.status = STATUS.LIMITED;
  state.resetsAt = resetsAt || (now + (state.windowMinutes || 180) * 60 * 1000);
  state.limitReason = reason || 'Rate limit reached';
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
 * Clear rate limit for a bot
 */
export async function clearLimit(botId) {
  const all = await getAllBotStates();
  const state = all[botId];
  if (!state) return null;

  state.status = STATUS.AVAILABLE;
  state.resetsAt = null;
  state.limitReason = '';
  // Optional: clear prompts or keep them
  all[botId] = evaluateStatus(state, Date.now());
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
