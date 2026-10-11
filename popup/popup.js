/**
 * AI Usage Limits Hub - Popup Controller
 * Renders real-time rate limits, live auto-fetched browser session quotas,
 * countdown timers, and sync controls.
 */

import { BOTS, STATUS } from '../shared/constants.js';
import { getAllBotStates, clearLimit, simulateLimit, updateBotCustomLimit } from '../shared/storage.js';

let currentStates = {};

// Format remaining milliseconds to "01h 24m 12s"
function formatCountdown(ms) {
  if (ms <= 0) return '00:00';
  const totalSecs = Math.floor(ms / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const minutes = Math.floor((totalSecs % 3600) / 60);
  const seconds = totalSecs % 60;

  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  }
  return `${pad(minutes)}m ${pad(seconds)}s`;
}

// Format timestamp into human-readable relative string
function formatRelativeTime(ts) {
  if (!ts) return 'Just now';
  const diffSecs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSecs < 60) return 'Just now';
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  return `${diffHours}h ago`;
}

// Render entire dashboard
async function renderDashboard() {
  currentStates = await getAllBotStates();
  const botsGrid = document.getElementById('botsGrid');
  botsGrid.innerHTML = '';

  let activeCount = 0;
  let limitedCount = 0;
  let loginNeededCount = 0;
  let totalUsedCount = 0;
  let totalPendingCount = 0;
  const loginNeededBots = [];

  for (const [botId, botDef] of Object.entries(BOTS)) {
    const state = currentStates[botId] || {};
    const prompts = state.prompts || [];
    const max = state.maxPrompts || 80;

    const isLoggedIn = state.isLoggedIn !== false && state.fetchStatus !== 'login_required';
    if (!isLoggedIn) {
      loginNeededCount++;
      loginNeededBots.push(botDef.name);
    }

    // Use exact percent from browser session API if auto-fetched, otherwise calculated
    const usedPct = typeof state.usedPercent === 'number'
      ? Math.min(100, Math.max(0, state.usedPercent))
      : Math.min(100, Math.round((prompts.length / max) * 100));

    const usedCount = typeof state.usedCount === 'number'
      ? state.usedCount
      : (typeof state.usedPercent === 'number'
        ? Math.round((usedPct / 100) * max)
        : prompts.length);

    const pendingCount = typeof state.pendingCount === 'number'
      ? state.pendingCount
      : Math.max(0, max - usedCount);

    const pendingPct = typeof state.pendingPercent === 'number'
      ? state.pendingPercent
      : Math.max(0, 100 - usedPct);

    const now = Date.now();
    const isLimited = state.status === STATUS.LIMITED || (state.resetsAt && state.resetsAt > now && usedPct >= 95);

    if (isLoggedIn) {
      totalUsedCount += usedCount;
      totalPendingCount += pendingCount;
      if (isLimited) limitedCount++;
      else activeCount++;
    }

    const card = document.createElement('div');
    card.className = `bot-card ${!isLoggedIn ? 'login-needed' : isLimited ? 'limited' : state.status === STATUS.APPROACHING ? 'approaching' : ''}`;
    card.dataset.botId = botId;

    // Status chip text and class
    let chipText = 'Ready';
    let chipClass = 'available';
    if (!isLoggedIn) {
      chipText = 'Login Needed';
      chipClass = 'login-needed';
    } else if (isLimited) {
      chipText = 'Limited';
      chipClass = 'limited';
    } else if (state.status === STATUS.APPROACHING || usedPct >= 80) {
      chipText = `${usedPct}% Used`;
      chipClass = 'approaching';
    }

    // Gradient bar color
    let meterColor = botDef.color;
    if (!isLoggedIn) meterColor = '#94a3b8';
    else if (isLimited) meterColor = '#ef4444';
    else if (state.status === STATUS.APPROACHING) meterColor = '#f59e0b';

    // Tier badge label
    const tierDef = botDef.tiers[state.tier] || Object.values(botDef.tiers)[0];
    const tierLabel = tierDef?.label || (state.tier ? state.tier.toUpperCase() : 'STANDARD');

    // Sync Telemetry Badge
    let syncBadgeHtml = '';
    if (!isLoggedIn) {
      syncBadgeHtml = `<span class="sync-badge login-required" title="Log in to ${botDef.name} to track actual usage limits">🔒 Login Needed</span>`;
    } else if (state.fetchedFromBrowser && state.lastFetchedAt) {
      const relTime = formatRelativeTime(state.lastFetchedAt);
      syncBadgeHtml = `<span class="sync-badge synced" title="Usage quota auto-fetched from live browser session">⚡ Live (${relTime})</span>`;
    } else if (state.fetchStatus === 'tab_required') {
      syncBadgeHtml = `<span class="sync-badge tab-required" title="Click Sync or Open Chat to connect live telemetry">🌐 Tab Sync</span>`;
    } else {
      syncBadgeHtml = `<span class="sync-badge synced" title="Provider session active">⚡ Connected</span>`;
    }

    // Account email chip if detected
    let accountEmailHtml = '';
    if (isLoggedIn && state.accountEmail) {
      accountEmailHtml = `<span class="account-email" title="Signed in as ${state.accountEmail}">👤 ${state.accountEmail}</span>`;
    }

    // Quota windows info if available (e.g. Claude 5h & 7d quotas)
    let extraWindowsHtml = '';
    if (botId === 'claude' && state.quotaWindows?.five_hour && isLoggedIn) {
      const fiveH = state.quotaWindows.five_hour;
      const sevenD = state.quotaWindows.seven_day;
      const fPct = Math.round((fiveH.utilization <= 1 && fiveH.utilization > 0 ? fiveH.utilization * 100 : fiveH.utilization) || 0);
      const sPct = sevenD ? Math.round((sevenD.utilization <= 1 && sevenD.utilization > 0 ? sevenD.utilization * 100 : sevenD.utilization) || 0) : null;
      extraWindowsHtml = `
        <div class="extra-windows">
          <span>5h Window: <strong>${fPct}%</strong></span>
          ${sPct !== null ? `<span>Weekly: <strong>${sPct}%</strong></span>` : ''}
        </div>
      `;
    }

    // Not logged in callout vs normal usage stats
    let bodyContentHtml = '';
    if (!isLoggedIn) {
      bodyContentHtml = `
        <div class="login-callout">
          <span class="callout-icon">🔒</span>
          <div class="callout-text">
            <span>Log in to your ${botDef.name} account to fetch actual rate limits, message caps, and reset times.</span>
          </div>
        </div>
      `;
    } else {
      bodyContentHtml = `
        <!-- Dual Quota Display: Used vs Pending -->
        <div class="usage-dual-badges">
          <div class="usage-badge used" title="Prompts consumed in current window">
            <div class="usage-badge-label">
              <span class="badge-dot dot-used"></span>
              <span>USED</span>
            </div>
            <div class="usage-badge-val">
              <strong>${usedCount}</strong> <span class="val-denom">/ ${max} msgs</span>
            </div>
            <div class="usage-badge-sub">${usedPct}% of limit</div>
          </div>

          <div class="usage-badge pending" title="Prompts remaining before rate limit">
            <div class="usage-badge-label">
              <span class="badge-dot dot-pending"></span>
              <span>PENDING</span>
            </div>
            <div class="usage-badge-val">
              <strong style="color: #34d399;">${pendingCount}</strong> <span class="val-denom">msgs left</span>
            </div>
            <div class="usage-badge-sub">${pendingPct}% remaining</div>
          </div>
        </div>

        <div class="card-meter-section">
          <div class="meter-track">
            <div class="meter-fill" style="width: ${isLimited ? 100 : usedPct}%; background: ${meterColor};"></div>
          </div>
          <div class="meter-labels">
            <span>Used: ${usedCount} (${usedPct}%)</span>
            <span>Pending: ${isLimited ? '0 (Cap Hit)' : `${pendingCount} (${pendingPct}%)`}</span>
          </div>
          ${extraWindowsHtml}
        </div>

        <div class="countdown-box ${isLimited ? 'urgent' : ''}" id="countdown-box-${botId}">
          <span class="countdown-label">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
            <span class="cd-title">${isLimited ? 'Resets in:' : 'Window slot resets:'}</span>
          </span>
          <span class="countdown-value" id="cd-val-${botId}">--:--</span>
        </div>
      `;
    }

    // Action buttons: If not logged in, show primary "Log In" button
    let actionsHtml = '';
    if (!isLoggedIn) {
      actionsHtml = `
        <button class="btn-login" data-login-bot="${botId}" title="Log in to ${botDef.name}">
          🔑 Log In
        </button>
        <button class="btn-open" data-open-bot="${botId}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
          </svg>
          Open Chat
        </button>
        <button class="btn-config" data-config-bot="${botId}" title="Customize limit for ${botDef.name}">
          Limit
        </button>
      `;
    } else {
      actionsHtml = `
        <button class="btn-sync" data-sync-bot="${botId}" title="Sync ${botDef.name} live limit">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
          </svg>
          Sync
        </button>
        <button class="btn-open" data-open-bot="${botId}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
          </svg>
          Open Chat
        </button>
        <button class="btn-config" data-config-bot="${botId}" title="Customize limit for ${botDef.name}">
          Limit
        </button>
        ${isLimited ? `<button class="btn-clear" data-clear-bot="${botId}" title="Manually clear limit">Clear</button>` : ''}
      `;
    }

    card.innerHTML = `
      <div class="card-header">
        <div class="card-title-group">
          <div class="bot-icon" style="background: ${botDef.colorLight || 'rgba(255,255,255,0.1)'}; color: ${botDef.color};">
            ${botDef.icon}
          </div>
          <div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="bot-name">${botDef.name}</span>
              <span class="tier-badge">${tierLabel}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 4px; margin-top: 2px;">
              ${syncBadgeHtml}
              ${accountEmailHtml}
            </div>
          </div>
        </div>
        <div class="status-chip ${chipClass}">
          <span class="status-dot"></span>
          <span>${chipText}</span>
        </div>
      </div>

      ${bodyContentHtml}

      <div class="card-actions">
        ${actionsHtml}
      </div>
    `;

    botsGrid.appendChild(card);
  }

  // Update Overview stats
  const statUsedEl = document.getElementById('statTotalUsed');
  if (statUsedEl) statUsedEl.textContent = `${totalUsedCount} msgs`;
  const statPendingEl = document.getElementById('statTotalPending');
  if (statPendingEl) statPendingEl.textContent = `${totalPendingCount} msgs`;
  const statLimitedEl = document.getElementById('statLimitedBots');
  if (statLimitedEl) statLimitedEl.textContent = limitedCount;

  // Header status & global banner
  const headerStatusText = document.getElementById('headerStatusText');
  const loginBanner = document.getElementById('loginWarningBanner');

  if (loginNeededCount > 0) {
    if (headerStatusText) {
      headerStatusText.textContent = `${loginNeededCount} Bot${loginNeededCount > 1 ? 's' : ''} Need Login`;
      headerStatusText.style.color = '#f59e0b';
    }
    if (loginBanner) {
      loginBanner.classList.remove('hidden');
      loginBanner.innerHTML = `
        <div class="login-banner-content">
          <span class="banner-icon">🔒</span>
          <div class="banner-msg">
            <strong>Login required for live limits:</strong>
            <span>Log in to ${loginNeededBots.join(', ')} in your browser to fetch real quotas.</span>
          </div>
        </div>
      `;
    }
  } else {
    if (loginBanner) loginBanner.classList.add('hidden');
    if (headerStatusText) {
      if (limitedCount > 0) {
        headerStatusText.textContent = `${limitedCount} Bot${limitedCount > 1 ? 's' : ''} Cooling Down`;
        headerStatusText.style.color = '#f87171';
      } else {
        headerStatusText.textContent = 'Auto-Sync Active • Live Browser Quotas';
        headerStatusText.style.color = '#34d399';
      }
    }
  }

  bindCardActions();
  updateLiveTimers();
}

// Live timer tick without refreshing full DOM
function updateLiveTimers() {
  const now = Date.now();

  for (const [botId] of Object.entries(BOTS)) {
    const state = currentStates[botId];
    if (!state) continue;

    const valEl = document.getElementById(`cd-val-${botId}`);
    if (!valEl) continue;

    const isLimited = state.status === STATUS.LIMITED || (state.resetsAt && state.resetsAt > now && (state.usedPercent || 0) >= 95);

    if (isLimited && state.resetsAt) {
      const remainingMs = Math.max(0, state.resetsAt - now);
      valEl.textContent = formatCountdown(remainingMs);
      if (remainingMs <= 0) {
        renderDashboard();
        return;
      }
    } else if (state.resetsAt && state.resetsAt > now) {
      // Future reset point detected from API (e.g. 5h window)
      const remainingMs = Math.max(0, state.resetsAt - now);
      valEl.textContent = formatCountdown(remainingMs);
    } else if (state.prompts && state.prompts.length > 0) {
      const windowMs = (state.windowMinutes || 180) * 60 * 1000;
      const oldestTs = state.prompts[0].timestamp;
      const remainingMs = Math.max(0, (oldestTs + windowMs) - now);
      valEl.textContent = formatCountdown(remainingMs);
    } else {
      valEl.textContent = 'Ready';
    }
  }
}

// Bind Action Handlers for cards
function bindCardActions() {
  // Log In Button
  document.querySelectorAll('[data-login-bot]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const botId = e.currentTarget.dataset.loginBot;
      const botDef = BOTS[botId];
      if (!botDef) return;
      const targetUrl = botDef.loginUrl || botDef.url;
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        chrome.tabs.create({ url: targetUrl });
      } else {
        window.open(targetUrl, '_blank');
      }
    });
  });

  // Individual Bot Sync Button
  document.querySelectorAll('[data-sync-bot]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const botId = e.currentTarget.dataset.syncBot;
      btn.classList.add('spinning');
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime) {
          await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: 'SYNC_BOT_NOW', data: { botId } }, (res) => {
              if (res?.state) currentStates[botId] = res.state;
              resolve();
            });
          });
        }
      } catch (_) {}
      await renderDashboard();
    });
  });

  // Open Chat Tab
  document.querySelectorAll('[data-open-bot]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const botId = e.currentTarget.dataset.openBot;
      const botDef = BOTS[botId];
      if (!botDef) return;

      if (typeof chrome !== 'undefined' && chrome.tabs) {
        chrome.tabs.query({}, (tabs) => {
          const existingTab = tabs.find(t =>
            botDef.domains.some(d => t.url && t.url.includes(d))
          );

          if (existingTab && existingTab.id) {
            chrome.tabs.update(existingTab.id, { active: true });
            chrome.windows.update(existingTab.windowId, { focused: true });
          } else {
            chrome.tabs.create({ url: botDef.url });
          }
        });
      } else {
        window.open(botDef.url, '_blank');
      }
    });
  });

  // Clear Limit
  document.querySelectorAll('[data-clear-bot]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const botId = e.currentTarget.dataset.clearBot;
      await clearLimit(botId);
      await renderDashboard();
    });
  });

  // Customize Limit
  document.querySelectorAll('[data-config-bot]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const botId = e.currentTarget.dataset.configBot;
      openCustomModal(botId);
    });
  });
}

let currentEditingBotId = null;

function openCustomModal(botId) {
  currentEditingBotId = botId;
  const botDef = BOTS[botId];
  const state = currentStates[botId] || {};
  if (!botDef) return;

  const modal = document.getElementById('customModal');
  const title = document.getElementById('customModalTitle');
  const tierSelect = document.getElementById('customTierSelect');
  const maxInput = document.getElementById('customMaxInput');
  const winInput = document.getElementById('customWindowInput');

  title.textContent = `Customize ${botDef.name} Limit`;
  maxInput.value = state.maxPrompts || 80;
  winInput.value = state.windowMinutes || 180;

  // Populate tiers
  tierSelect.innerHTML = '';
  for (const [tKey, tDef] of Object.entries(botDef.tiers)) {
    const opt = document.createElement('option');
    opt.value = tKey;
    opt.textContent = `${tDef.label} (Default: ${tDef.defaultMax} msgs / ${tDef.windowMinutes}m)`;
    if (tKey === state.tier) opt.selected = true;
    tierSelect.appendChild(opt);
  }

  tierSelect.onchange = () => {
    const selectedTier = tierSelect.value;
    const tDef = botDef.tiers[selectedTier];
    if (tDef) {
      maxInput.value = tDef.defaultMax;
      winInput.value = tDef.windowMinutes;
    }
  };

  modal.classList.remove('hidden');
}

function setupCustomLimitModal() {
  const modal = document.getElementById('customModal');
  const cancelBtn = document.getElementById('cancelCustomBtn');
  const saveBtn = document.getElementById('saveCustomBtn');
  const tierSelect = document.getElementById('customTierSelect');
  const maxInput = document.getElementById('customMaxInput');
  const winInput = document.getElementById('customWindowInput');

  cancelBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  saveBtn.addEventListener('click', async () => {
    if (!currentEditingBotId) return;
    const maxPrompts = parseInt(maxInput.value, 10) || 50;
    const windowMinutes = parseInt(winInput.value, 10) || 180;
    const tier = tierSelect.value;

    await updateBotCustomLimit(currentEditingBotId, { maxPrompts, windowMinutes, tier });
    modal.classList.add('hidden');
    await renderDashboard();
  });
}

// Simulation Modal Setup
function setupSimulationModal() {
  const simModal = document.getElementById('simModal');
  const testBtn = document.getElementById('testSimulationBtn');
  const cancelBtn = document.getElementById('cancelSimBtn');
  const applyBtn = document.getElementById('applySimBtn');
  const botSelect = document.getElementById('simBotSelect');
  const minutesInput = document.getElementById('simMinutesInput');

  testBtn.addEventListener('click', () => {
    simModal.classList.remove('hidden');
  });

  cancelBtn.addEventListener('click', () => {
    simModal.classList.add('hidden');
  });

  applyBtn.addEventListener('click', async () => {
    const botId = botSelect.value;
    const minutes = parseInt(minutesInput.value, 10) || 10;
    simModal.classList.add('hidden');
    await simulateLimit(botId, minutes);
    await renderDashboard();
  });
}

// Trigger browser synchronization
async function triggerSyncFromBrowser() {
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.classList.add('spinning');

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'SYNC_USAGE_LIMITS' }, (response) => {
          if (response?.states) {
            currentStates = response.states;
          }
          resolve();
        });
      });
    }
  } catch (err) {
    console.warn('Sync limits error:', err);
  } finally {
    await renderDashboard();
    setTimeout(() => {
      if (refreshBtn) refreshBtn.classList.remove('spinning');
    }, 450);
  }
}

// Initialize Popup
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Initial quick render from storage
  await renderDashboard();

  // 2. Automatically trigger live browser session sync on popup open
  triggerSyncFromBrowser();

  // 3. 1-second ticker for live countdowns
  setInterval(updateLiveTimers, 1000);

  // 4. Manual Refresh Button triggers live browser sync
  document.getElementById('refreshBtn').addEventListener('click', triggerSyncFromBrowser);

  // 5. Options Button
  document.getElementById('optionsBtn').addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open('../options/options.html', '_blank');
    }
  });

  // 6. Listen for state updates broadcasted from background worker
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'STATE_UPDATED' && message.data) {
        currentStates = message.data;
        renderDashboard();
      }
    });
  }

  setupSimulationModal();
  setupCustomLimitModal();
});
