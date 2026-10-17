/**
 * Know Ur Limit - Options & Configuration Controller
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

async function loadSettings() {
  currentSettings = await getSettings();

  document.getElementById('notifyOnReset').checked = !!currentSettings.notifyOnReset;
  document.getElementById('notifyOnLimit').checked = !!currentSettings.notifyOnLimit;
  document.getElementById('notifyOnApproaching').checked = currentSettings.notifyOnApproaching !== false;

  const threshold = currentSettings.warningThresholdPercent || 85;
  const slider = document.getElementById('warningThresholdPercent');
  const display = document.getElementById('thresholdDisplay');
  if (slider && display) {
    slider.value = threshold;
    display.textContent = `${threshold}%`;
    slider.oninput = () => {
      display.textContent = `${slider.value}%`;
    };
  }

  document.getElementById('badgeMode').value = currentSettings.badgeMode || 'countdown';
  document.getElementById('showFloatingHud').checked = currentSettings.showFloatingHud !== false;
  document.getElementById('autoFetchFromBrowser').checked = currentSettings.autoFetchFromBrowser !== false;
  document.getElementById('autoFetchIntervalMinutes').value = String(currentSettings.autoFetchIntervalMinutes || 2);

  await loadHistoryTable();
}

async function handleSaveSettings() {
  const updatedSettings = {
    notifyOnReset: document.getElementById('notifyOnReset').checked,
    notifyOnLimit: document.getElementById('notifyOnLimit').checked,
    notifyOnApproaching: document.getElementById('notifyOnApproaching').checked,
    warningThresholdPercent: parseInt(document.getElementById('warningThresholdPercent').value, 10) || 85,
    badgeMode: document.getElementById('badgeMode').value,
    showFloatingHud: document.getElementById('showFloatingHud').checked,
    autoFetchFromBrowser: document.getElementById('autoFetchFromBrowser').checked,
    autoFetchIntervalMinutes: parseInt(document.getElementById('autoFetchIntervalMinutes').value, 10) || 2
  };

  await saveSettings(updatedSettings);

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ action: 'GET_ALL_STATES' }, () => {});
  }

  showToast('Settings saved successfully!');
}

async function loadHistoryTable() {
  const events = await getHistoryEvents();
  const tbody = document.getElementById('historyTableBody');
  tbody.innerHTML = '';

  if (!events || events.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No recent telemetry events recorded yet.</td></tr>';
    return;
  }

  for (const ev of events.slice(0, 50)) {
    const tr = document.createElement('tr');
    const timeStr = new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const botName = BOTS[ev.botId]?.name || ev.botId;

    let eventBadge = '';
    let details = '';

    if (ev.type === 'auto_fetch_sync') {
      eventBadge = '<span style="color: #10b981; font-weight: 600;">⚡ Live Telemetry Synced</span>';
      const pctPart = ev.usedPercent !== null && ev.usedPercent !== undefined ? `Quota: ${ev.usedPercent}% used` : '';
      const tokPart = typeof ev.tokensUsed === 'number'
        ? `Tokens: ${ev.tokensUsed.toLocaleString()} used / ${(ev.tokensRemaining ?? 0).toLocaleString()} left`
        : '';
      details = [pctPart, tokPart, `Plan: ${ev.tier || 'Standard'}`].filter(Boolean).join(' • ');
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

function testDesktopNotification() {
  if (typeof chrome !== 'undefined' && chrome.notifications) {
    chrome.notifications.create(`test_notify_${Date.now()}`, {
      type: 'basic',
      iconUrl: '../icons/icon128.png',
      title: '🎉 Know Ur Limit - Alert Test',
      message: 'System notifications are functioning properly! You will receive alerts when limits reset.',
      priority: 2
    });
    showToast('Test notification triggered!');
  } else {
    alert('Desktop notifications API is available when loaded in Chrome extension environment.');
  }
}

async function handleSyncNow() {
  const syncBtn = document.getElementById('syncNowBtn');
  syncBtn.textContent = '⏳ Syncing real usage & tokens...';
  syncBtn.disabled = true;

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'SYNC_USAGE_LIMITS', data: { allowTempTab: true } }, () => resolve());
      });
    }
    await loadHistoryTable();
    showToast('Synchronized real usage limits & tokens from browser sessions!');
  } catch (err) {
    console.warn('Sync error:', err);
  } finally {
    syncBtn.textContent = '⚡ Sync Real Limits & Tokens Now';
    syncBtn.disabled = false;
  }
}

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
  a.download = `know-ur-limit-telemetry-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function handleClearData() {
  if (confirm('Are you sure you want to reset stored telemetry and history?')) {
    await clearAllData();
    await loadSettings();
    showToast('Stored telemetry cleared.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  document.getElementById('saveTopBtn').addEventListener('click', handleSaveSettings);
  document.getElementById('syncNowBtn').addEventListener('click', handleSyncNow);
  document.getElementById('testNotifyBtn').addEventListener('click', testDesktopNotification);
  document.getElementById('exportJsonBtn').addEventListener('click', exportData);
  document.getElementById('clearDataBtn').addEventListener('click', handleClearData);
});
