/**
 * AI Usage Limits Hub - Options & Configuration Controller
 */

import { BOTS } from '../shared/constants.js';
import { getSettings, saveSettings, getHistoryEvents, clearAllData, getAllBotStates } from '../shared/storage.js';

let currentSettings = {};

function showToast(message = 'Settings saved successfully!') {
  const toast = document.getElementById('saveToast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 2500);
}

// Load settings into form fields
async function loadSettings() {
  currentSettings = await getSettings();

  // Toggles & Selects
  document.getElementById('notifyOnReset').checked = !!currentSettings.notifyOnReset;
  document.getElementById('notifyOnLimit').checked = !!currentSettings.notifyOnLimit;
  document.getElementById('badgeMode').value = currentSettings.badgeMode || 'countdown';
  document.getElementById('showFloatingHud').checked = currentSettings.showFloatingHud !== false;

  // Bot Quotas
  const custom = currentSettings.customLimits || {};

  for (const botId of Object.keys(BOTS)) {
    const botDef = BOTS[botId];
    const botCustom = custom[botId] || {};
    const defaultTierKey = Object.keys(botDef.tiers)[0];
    const tier = botCustom.tier || defaultTierKey;
    const tierDef = botDef.tiers[tier] || Object.values(botDef.tiers)[0];

    const tierEl = document.getElementById(`tier_${botId}`);
    const maxEl = document.getElementById(`max_${botId}`);
    const winEl = document.getElementById(`window_${botId}`);

    if (tierEl) tierEl.value = tier;
    if (maxEl) maxEl.value = botCustom.maxPrompts || tierDef.defaultMax;
    if (winEl) winEl.value = botCustom.windowMinutes || tierDef.windowMinutes;

    // Auto-update max/window when tier select changes
    if (tierEl) {
      tierEl.addEventListener('change', () => {
        const selectedTier = tierEl.value;
        const newTierDef = botDef.tiers[selectedTier];
        if (newTierDef) {
          if (maxEl) maxEl.value = newTierDef.defaultMax;
          if (winEl) winEl.value = newTierDef.windowMinutes;
        }
      });
    }
  }

  await loadHistoryTable();
}

// Save form values to storage
async function handleSaveSettings() {
  const updatedSettings = {
    notifyOnReset: document.getElementById('notifyOnReset').checked,
    notifyOnLimit: document.getElementById('notifyOnLimit').checked,
    badgeMode: document.getElementById('badgeMode').value,
    showFloatingHud: document.getElementById('showFloatingHud').checked,
    customLimits: {}
  };

  for (const botId of Object.keys(BOTS)) {
    const tierEl = document.getElementById(`tier_${botId}`);
    const maxEl = document.getElementById(`max_${botId}`);
    const winEl = document.getElementById(`window_${botId}`);

    updatedSettings.customLimits[botId] = {
      tier: tierEl ? tierEl.value : 'free',
      maxPrompts: maxEl ? parseInt(maxEl.value, 10) || 50 : 50,
      windowMinutes: winEl ? parseInt(winEl.value, 10) || 180 : 180
    };
  }

  await saveSettings(updatedSettings);
  showToast('Settings saved successfully!');
}

// Populate recent history events
async function loadHistoryTable() {
  const events = await getHistoryEvents();
  const tbody = document.getElementById('historyTableBody');
  tbody.innerHTML = '';

  if (!events || events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No recent events recorded yet.</td></tr>';
    return;
  }

  for (const ev of events.slice(0, 50)) {
    const tr = document.createElement('tr');
    const timeStr = new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const botName = BOTS[ev.botId]?.name || ev.botId;

    let eventBadge = '';
    let details = '';

    if (ev.type === 'prompt') {
      eventBadge = '<span style="color: #38bdf8; font-weight: 600;">Prompt Sent</span>';
      details = `Model: ${ev.model || 'default'}`;
    } else if (ev.type === 'limit_hit') {
      eventBadge = '<span style="color: #f87171; font-weight: 600;">Limit Hit</span>';
      const resetsStr = ev.resetsAt ? new Date(ev.resetsAt).toLocaleTimeString() : 'N/A';
      details = `Resets at ${resetsStr} • ${ev.reason || ''}`;
    } else {
      eventBadge = `<span>${ev.type}</span>`;
      details = JSON.stringify(ev);
    }

    tr.innerHTML = `
      <td>${timeStr}</td>
      <td><strong>${botName}</strong></td>
      <td>${eventBadge}</td>
      <td>${details}</td>
    `;
    tbody.appendChild(tr);
  }
}

// Test Notification
function testDesktopNotification() {
  if (typeof chrome !== 'undefined' && chrome.notifications) {
    chrome.notifications.create(`test_notify_${Date.now()}`, {
      type: 'basic',
      iconUrl: '../icons/icon128.png',
      title: '🎉 AI Limit Hub - Alert Test',
      message: 'System notifications are functioning properly! You will receive alerts when limits reset.',
      priority: 2
    });
    showToast('Test notification triggered!');
  } else {
    alert('Desktop notifications API is available when loaded in Chrome extension environment.');
  }
}

// Export JSON
async function exportData() {
  const states = await getAllBotStates();
  const settings = await getSettings();
  const history = await getHistoryEvents();

  const exportPayload = {
    exportedAt: new Date().toISOString(),
    states,
    settings,
    history
  };

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-limits-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Clear all data
async function handleClearData() {
  if (confirm('Are you sure you want to clear all usage metrics and history?')) {
    await clearAllData();
    await loadSettings();
    showToast('All usage metrics cleared.');
  }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  document.getElementById('saveTopBtn').addEventListener('click', handleSaveSettings);
  document.getElementById('testNotifyBtn').addEventListener('click', testDesktopNotification);
  document.getElementById('exportJsonBtn').addEventListener('click', exportData);
  document.getElementById('clearDataBtn').addEventListener('click', handleClearData);
});
