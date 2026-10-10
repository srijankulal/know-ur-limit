/**
 * AI Usage Limits Hub - Popup Controller
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

// Render entire dashboard
async function renderDashboard() {
  currentStates = await getAllBotStates();
  const botsGrid = document.getElementById('botsGrid');
  botsGrid.innerHTML = '';

  let activeCount = 0;
  let limitedCount = 0;
  let totalPromptsCount = 0;

  for (const [botId, botDef] of Object.entries(BOTS)) {
    const state = currentStates[botId] || {};
    const prompts = state.prompts || [];
    const count = prompts.length;
    const max = state.maxPrompts || 80;
    const pct = Math.min(100, Math.round((count / max) * 100));
    const now = Date.now();
    const isLimited = state.status === STATUS.LIMITED || (state.resetsAt && state.resetsAt > now);

    totalPromptsCount += count;
    if (isLimited) limitedCount++;
    else activeCount++;

    const card = document.createElement('div');
    card.className = `bot-card ${isLimited ? 'limited' : state.status === STATUS.APPROACHING ? 'approaching' : ''}`;
    card.dataset.botId = botId;

    // Status chip text and class
    let chipText = 'Ready';
    let chipClass = 'available';
    if (isLimited) {
      chipText = 'Limited';
      chipClass = 'limited';
    } else if (state.status === STATUS.APPROACHING || pct >= 80) {
      chipText = `${pct}% Used`;
      chipClass = 'approaching';
    }

    // Gradient bar color
    let meterColor = botDef.color;
    if (isLimited) meterColor = '#ef4444';
    else if (state.status === STATUS.APPROACHING) meterColor = '#f59e0b';

    // Tier badge label
    const tierDef = botDef.tiers[state.tier] || Object.values(botDef.tiers)[0];
    const tierLabel = tierDef?.label || (state.tier ? state.tier.toUpperCase() : 'STANDARD');

    card.innerHTML = `
      <div class="card-header">
        <div class="card-title-group">
          <div class="bot-icon" style="background: ${botDef.colorLight || 'rgba(255,255,255,0.1)'}; color: ${botDef.color};">
            ${botDef.icon}
          </div>
          <div>
            <span class="bot-name">${botDef.name}</span>
            <span class="tier-badge">${tierLabel}</span>
          </div>
        </div>
        <div class="status-chip ${chipClass}">
          <span class="status-dot"></span>
          <span>${chipText}</span>
        </div>
      </div>

      <div class="card-meter-section">
        <div class="meter-track">
          <div class="meter-fill" style="width: ${isLimited ? 100 : pct}%; background: ${meterColor};"></div>
        </div>
        <div class="meter-labels">
          <span>${count} / ${max} msgs</span>
          <span>${isLimited ? 'Cap Hit' : `${pct}% capacity`}</span>
        </div>
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

      <div class="card-actions">
        <button class="btn-open" data-open-bot="${botId}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
          </svg>
          Open Chat
        </button>
        <button class="btn-config" data-config-bot="${botId}" title="Customize limit for ${botDef.name}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          Limit
        </button>
        ${isLimited ? `<button class="btn-clear" data-clear-bot="${botId}" title="Manually clear limit">Clear</button>` : ''}
      </div>
    `;

    botsGrid.appendChild(card);
  }

  // Update Overview stats
  document.getElementById('statActiveBots').textContent = `${activeCount} / ${Object.keys(BOTS).length}`;
  document.getElementById('statTotalPrompts').textContent = totalPromptsCount;
  document.getElementById('statLimitedBots').textContent = limitedCount;

  const headerStatusText = document.getElementById('headerStatusText');
  if (limitedCount > 0) {
    headerStatusText.textContent = `${limitedCount} Bot${limitedCount > 1 ? 's' : ''} Cooling Down`;
    headerStatusText.style.color = '#f87171';
  } else {
    headerStatusText.textContent = 'All Bots Available';
    headerStatusText.style.color = '#34d399';
  }

  // Bind Buttons
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

    const isLimited = state.status === STATUS.LIMITED || (state.resetsAt && state.resetsAt > now);

    if (isLimited && state.resetsAt) {
      const remainingMs = Math.max(0, state.resetsAt - now);
      valEl.textContent = formatCountdown(remainingMs);
      if (remainingMs <= 0) {
        // Cooldown finished, re-render
        renderDashboard();
        return;
      }
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

// Initialize Popup
document.addEventListener('DOMContentLoaded', async () => {
  await renderDashboard();

  // 1-second ticker for live countdowns
  setInterval(updateLiveTimers, 1000);

  // Refresh Button
  document.getElementById('refreshBtn').addEventListener('click', renderDashboard);

  // Options Button
  document.getElementById('optionsBtn').addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open('../options/options.html', '_blank');
    }
  });

  setupSimulationModal();
  setupCustomLimitModal();
});
