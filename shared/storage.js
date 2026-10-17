/**
 * Know Ur Limit - Storage & Real Telemetry State Management
 * Stores only real usage limits, rate-limit windows, and token telemetry fetched from each chatbot.
 * Zero assumed message counts or fake prompt reconstructions.
 */

import { BOTS, STATUS, DEFAULT_SETTINGS } from './constants.js';

const STORAGE_KEYS = {
  BOTS_STATE: 'ai_limits_bots_state_v2',
  SETTINGS: 'ai_limits_settings_v2',
  HISTORY: 'ai_limits_history_v2'
};

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

export async function getSettings() {
  const settings = await storageAdapter.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  await storageAdapter.set(STORAGE_KEYS.SETTINGS, merged);
  return merged;
}

/**
 * Initialize clean bot state without any assumed message limits
 */
function createDefaultBotState(botId) {
  const botDef = BOTS[botId];
  const tierKey = Object.keys(botDef.tiers)[0];
  const tierDef = botDef.tiers[tierKey];

  return {
    botId,
    tier: tierKey,
    tierLabel: tierDef?.label || botDef.name,
    status: STATUS.UNKNOWN,
    activeModel: botDef.defaultModel,
    // Real rate-limit window utilization (from provider API)
    usedPercent: null,
    remainingPercent: null,
    // Real token telemetry (fetched from provider API / active session)
    tokensUsed: null,
    inputTokens: null,
    outputTokens: null,
    tokenLimit: botDef.defaultContextTokens || null,
    tokensRemaining: null,
    tokenSource: null,
    // Normalized real quota windows (e.g. Claude 5h/7d, ChatGPT primary/secondary, DeepSeek quotas)
    windows: [],
    quotaWindows: null,
    resetsAt: null,
    limitReason: '',
    lastSeen: null,
    // Sync metadata
    fetchedFromBrowser: false,
    hasRealTelemetry: false,
    lastFetchedAt: null,
    isLoggedIn: false,
    accountEmail: null,
    conversationTitle: null,
    fetchStatus: 'idle' // 'idle' | 'synced' | 'login_required' | 'tab_required' | 'error'
  };
}

/**
 * Re-evaluate bot status based on real fetched usage & reset timestamps
 */
function evaluateStatus(state, now = Date.now(), thresholdPercent = 85) {
  if (!state.isLoggedIn && state.fetchStatus === 'login_required') {
    state.status = STATUS.UNKNOWN;
    return state;
  }

  // Check if a previously active cooldown timer has expired
  if (state.status === STATUS.LIMITED && state.resetsAt && state.resetsAt <= now) {
    state.status = STATUS.AVAILABLE;
    state.resetsAt = null;
    state.limitReason = '';
    state.lastApproachingAlertTs = null;
    if (state.usedPercent !== null && state.usedPercent >= 100) {
      state.usedPercent = 0;
      state.remainingPercent = 100;
    }
  }

  // Compute remaining tokens if tokensUsed and tokenLimit are present
  if (typeof state.tokensUsed === 'number' && typeof state.tokenLimit === 'number' && state.tokenLimit > 0) {
    state.tokensRemaining = Math.max(0, state.tokenLimit - state.tokensUsed);
  }

  // Determine effective usage percentage from real window % or real token usage %
  let effectivePct = null;
  if (typeof state.usedPercent === 'number' && !isNaN(state.usedPercent)) {
    effectivePct = Math.min(100, Math.max(0, state.usedPercent));
    state.usedPercent = effectivePct;
    state.remainingPercent = Math.max(0, Number((100 - effectivePct).toFixed(1)));
  } else if (typeof state.tokensUsed === 'number' && typeof state.tokenLimit === 'number' && state.tokenLimit > 0) {
    effectivePct = Math.min(100, Math.max(0, Math.round((state.tokensUsed / state.tokenLimit) * 1000) / 10));
    state.usedPercent = effectivePct;
    state.remainingPercent = Math.max(0, Number((100 - effectivePct).toFixed(1)));
  }

  if (state.status === STATUS.LIMITED && (!state.resetsAt || state.resetsAt > now)) {
    return state;
  }

  if (effectivePct !== null && effectivePct >= 100) {
    state.status = STATUS.LIMITED;
  } else if (effectivePct !== null && effectivePct >= thresholdPercent) {
    state.status = STATUS.APPROACHING;
  } else if (state.isLoggedIn) {
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
  let states = (await storageAdapter.get(STORAGE_KEYS.BOTS_STATE)) || {};
  const now = Date.now();
  let updated = false;

  for (const botId of Object.keys(BOTS)) {
    if (!states[botId]) {
      states[botId] = createDefaultBotState(botId);
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
 * Record a hard rate limit detected from network (HTTP 429) or DOM banner
 */
export async function recordLimitDetected(botId, { resetsAt, reason, model, plan, tokensUsed, tokenLimit } = {}) {
  const all = await getAllBotStates();
  const state = all[botId];
  if (!state) return null;

  const now = Date.now();
  state.lastSeen = now;
  state.isLoggedIn = true;
  state.status = STATUS.LIMITED;
  if (resetsAt) state.resetsAt = resetsAt;
  state.limitReason = reason || 'Rate limit reached';
  state.usedPercent = 100;
  state.remainingPercent = 0;
  state.hasRealTelemetry = true;
  if (model) state.activeModel = model;
  if (plan && BOTS[botId]?.tiers[plan]) {
    state.tier = plan;
    state.tierLabel = BOTS[botId].tiers[plan].label;
  }
  if (typeof tokensUsed === 'number') state.tokensUsed = tokensUsed;
  if (typeof tokenLimit === 'number') state.tokenLimit = tokenLimit;
  if (typeof state.tokensUsed === 'number' && typeof state.tokenLimit === 'number') {
    state.tokensRemaining = Math.max(0, state.tokenLimit - state.tokensUsed);
  }

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
 * Record real usage & token telemetry fetched directly from the chatbot session
 */
export async function recordAutoFetchedUsage(botId, data = {}) {
  const settings = await getSettings();
  const all = await getAllBotStates();
  const state = all[botId];
  if (!state) return null;

  const now = Date.now();
  state.lastSeen = now;

  // Explicit not-logged-in state
  if (data.isLoggedIn === false) {
    state.isLoggedIn = false;
    state.fetchStatus = 'login_required';
    state.fetchedFromBrowser = false;
    state.hasRealTelemetry = false;
    state.status = STATUS.UNKNOWN;
    state.usedPercent = null;
    state.remainingPercent = null;
    state.tokensUsed = null;
    state.tokensRemaining = null;
    state.windows = [];
    if (data.limitReason) state.limitReason = data.limitReason;
    all[botId] = state;
    await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);
    return state;
  }

  state.isLoggedIn = true;
  state.fetchStatus = data.fetchStatus || 'synced';

  if (data.accountEmail) state.accountEmail = data.accountEmail;
  if (data.activeModel) state.activeModel = data.activeModel;
  if (data.conversationTitle !== undefined) state.conversationTitle = data.conversationTitle;

  // Update tier & context limit if detected
  if (data.tier && BOTS[botId]?.tiers[data.tier]) {
    state.tier = data.tier;
    const tierDef = BOTS[botId].tiers[data.tier];
    state.tierLabel = data.tierLabel || tierDef.label;
    if (!data.tokenLimit && tierDef.contextTokens) {
      state.tokenLimit = tierDef.contextTokens;
    }
  } else if (data.tierLabel) {
    state.tierLabel = data.tierLabel;
  }

  // Update model-specific token limit if known
  if (typeof data.tokenLimit === 'number' && data.tokenLimit > 0) {
    state.tokenLimit = data.tokenLimit;
  } else if (state.activeModel && BOTS[botId]?.modelContextLimits) {
    const modelMap = BOTS[botId].modelContextLimits;
    for (const [mKey, limitVal] of Object.entries(modelMap)) {
      if (state.activeModel.toLowerCase().includes(mKey)) {
        state.tokenLimit = limitVal;
        break;
      }
    }
  }

  // Update real token telemetry
  if (typeof data.tokensUsed === 'number' && !isNaN(data.tokensUsed)) {
    state.tokensUsed = Math.max(0, Math.round(data.tokensUsed));
    state.hasRealTelemetry = true;
    state.fetchedFromBrowser = true;
    state.lastFetchedAt = now;
  }
  if (typeof data.inputTokens === 'number' && !isNaN(data.inputTokens)) {
    state.inputTokens = Math.max(0, Math.round(data.inputTokens));
  }
  if (typeof data.outputTokens === 'number' && !isNaN(data.outputTokens)) {
    state.outputTokens = Math.max(0, Math.round(data.outputTokens));
  }
  if (typeof data.tokensRemaining === 'number' && !isNaN(data.tokensRemaining)) {
    state.tokensRemaining = Math.max(0, Math.round(data.tokensRemaining));
  } else if (typeof state.tokensUsed === 'number' && typeof state.tokenLimit === 'number' && state.tokenLimit > 0) {
    state.tokensRemaining = Math.max(0, state.tokenLimit - state.tokensUsed);
  }
  if (data.tokenSource) {
    state.tokenSource = data.tokenSource;
  }

  // Update real quota windows
  if (Array.isArray(data.windows) && data.windows.length > 0) {
    state.windows = data.windows;
    state.hasRealTelemetry = true;
    state.fetchedFromBrowser = true;
    state.lastFetchedAt = now;
  }
  if (data.quotaWindows) {
    state.quotaWindows = data.quotaWindows;
  }

  // Update reset timestamp
  if (data.resetsAt !== undefined && data.resetsAt !== null) {
    state.resetsAt = data.resetsAt;
  }

  // Update real usage percentage
  if (typeof data.usedPercent === 'number' && !isNaN(data.usedPercent)) {
    const cleanPct = Math.min(100, Math.max(0, Number(data.usedPercent.toFixed(1))));
    state.usedPercent = cleanPct;
    state.remainingPercent = Math.max(0, Number((100 - cleanPct).toFixed(1)));
    state.hasRealTelemetry = true;
    state.fetchedFromBrowser = true;
    state.lastFetchedAt = now;
  } else if (typeof state.tokensUsed === 'number' && typeof state.tokenLimit === 'number' && state.tokenLimit > 0 && state.usedPercent === null) {
    const tokenPct = Math.min(100, Math.max(0, Number(((state.tokensUsed / state.tokenLimit) * 100).toFixed(1))));
    state.usedPercent = tokenPct;
    state.remainingPercent = Math.max(0, Number((100 - tokenPct).toFixed(1)));
  }

  if (data.limitReason) {
    state.limitReason = data.limitReason;
  }

  // Evaluate status & approaching threshold alert
  const threshold = settings.warningThresholdPercent || 85;
  if (data.isLimited || (state.usedPercent !== null && state.usedPercent >= 100)) {
    state.status = STATUS.LIMITED;
    if (!state.limitReason) state.limitReason = `${BOTS[botId]?.name || 'AI'} usage limit reached.`;
  } else {
    evaluateStatus(state, now, threshold);
  }

  let approachingTriggered = false;
  if (state.status === STATUS.APPROACHING && state.usedPercent !== null && state.usedPercent >= threshold) {
    const cooldownAlertWindow = 3 * 3600 * 1000;
    if (!state.lastApproachingAlertTs || (now - state.lastApproachingAlertTs) >= cooldownAlertWindow) {
      state.lastApproachingAlertTs = now;
      approachingTriggered = true;
    }
  }

  all[botId] = state;
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);

  if (state.hasRealTelemetry) {
    await logHistoryEvent({
      type: 'auto_fetch_sync',
      botId,
      usedPercent: state.usedPercent,
      tokensUsed: state.tokensUsed,
      tokensRemaining: state.tokensRemaining,
      tier: state.tierLabel || state.tier,
      status: state.status,
      timestamp: now
    });
  }

  state._approachingTriggered = approachingTriggered;
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
 * Update user plan/tier for a bot
 */
export async function updateBotPlan(botId, tierKey) {
  const all = await getAllBotStates();
  const state = all[botId];
  const botDef = BOTS[botId];
  if (!state || !botDef || !botDef.tiers[tierKey]) return null;

  const tierDef = botDef.tiers[tierKey];
  state.tier = tierKey;
  state.tierLabel = tierDef.label;
  if (tierDef.contextTokens) {
    state.tokenLimit = tierDef.contextTokens;
  }

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
    state.tierLabel = BOTS[botId].tiers[extra.tier].label;
  }
  if (state.status === STATUS.UNKNOWN && state.isLoggedIn) {
    state.status = STATUS.AVAILABLE;
  }

  all[botId] = evaluateStatus(state, Date.now());
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, all);
  return state;
}

/**
 * History event logging (limited to last 100 items)
 */
async function logHistoryEvent(event) {
  try {
    let history = (await storageAdapter.get(STORAGE_KEYS.HISTORY)) || [];
    // Avoid spamming duplicate sync logs within 30s for the same bot
    if (
      event.type === 'auto_fetch_sync' &&
      history.length > 0 &&
      history[0].type === 'auto_fetch_sync' &&
      history[0].botId === event.botId &&
      event.timestamp - history[0].timestamp < 30000 &&
      history[0].usedPercent === event.usedPercent &&
      history[0].tokensUsed === event.tokensUsed
    ) {
      return;
    }
    history.unshift(event);
    if (history.length > 100) history = history.slice(0, 100);
    await storageAdapter.set(STORAGE_KEYS.HISTORY, history);
  } catch (e) {
    console.warn('Failed to log history event:', e);
  }
}

export async function getHistoryEvents() {
  return (await storageAdapter.get(STORAGE_KEYS.HISTORY)) || [];
}

export async function clearAllData() {
  await storageAdapter.set(STORAGE_KEYS.BOTS_STATE, {});
  await storageAdapter.set(STORAGE_KEYS.HISTORY, []);
  return true;
}
