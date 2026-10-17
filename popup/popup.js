/**
 * Know Ur Limit - Popup Controller
 * Displays real usage limits, quota windows, total tokens used, and remaining tokens
 * fetched directly from Claude, ChatGPT, Google Gemini, and DeepSeek.
 */

import { BOTS, STATUS } from '../shared/constants.js';
import { getAllBotStates, clearLimit } from '../shared/storage.js';

let currentStates = {};

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

function formatRelativeTime(ts) {
  if (!ts) return 'Not synced';
  const diffSecs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSecs < 60) return 'Just now';
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  return `${diffHours}h ago`;
}

function formatTokens(num) {
  if (typeof num !== 'number' || isNaN(num)) return '--';
  if (num >= 1000000) return `${(num / 1000000).toFixed(2).replace(/\.00$/, '')}M`;
  if (num >= 10000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return num.toLocaleString();
}

async function renderDashboard() {
  currentStates = await getAllBotStates();
  const botsGrid = document.getElementById('botsGrid');
  botsGrid.innerHTML = '';

  let syncedBotsCount = 0;
  let limitedCount = 0;
  let loginNeededCount = 0;
  let totalTokensUsed = 0;
  let totalTokensRemaining = 0;
  let anyTokenTelemetry = false;
  const loginNeededBots = [];

  for (const [botId, botDef] of Object.entries(BOTS)) {
    const state = currentStates[botId] || {};
    const isLoggedIn = state.isLoggedIn === true && state.fetchStatus !== 'login_required';

    if (!isLoggedIn) {
      loginNeededCount++;
      loginNeededBots.push(botDef.name);
    } else {
      syncedBotsCount++;
    }

    const hasPct = typeof state.usedPercent === 'number' && !isNaN(state.usedPercent);
    const usedPct = hasPct ? Math.min(100, Math.max(0, state.usedPercent)) : null;
    const remPct = hasPct ? Math.max(0, Number((100 - usedPct).toFixed(1))) : null;

    const hasTokens = typeof state.tokensUsed === 'number' && !isNaN(state.tokensUsed);
    const tokensUsed = hasTokens ? state.tokensUsed : null;
    const tokenLimit = typeof state.tokenLimit === 'number' ? state.tokenLimit : botDef.defaultContextTokens;
    const tokensRemaining = typeof state.tokensRemaining === 'number'
      ? state.tokensRemaining
      : (hasTokens && tokenLimit ? Math.max(0, tokenLimit - tokensUsed) : null);

    if (isLoggedIn && hasTokens) {
      anyTokenTelemetry = true;
      totalTokensUsed += tokensUsed;
      if (typeof tokensRemaining === 'number') {
        totalTokensRemaining += tokensRemaining;
      }
    }

    const now = Date.now();
    const isLimited = state.status === STATUS.LIMITED || (usedPct !== null && usedPct >= 100);
    if (isLoggedIn && isLimited) limitedCount++;

    const card = document.createElement('div');
    card.className = `bot-card ${!isLoggedIn ? 'login-needed' : isLimited ? 'limited' : state.status === STATUS.APPROACHING ? 'approaching' : ''}`;
    card.dataset.botId = botId;

    // Status chip
    let chipText = 'Ready';
    let chipClass = 'available';
    if (!isLoggedIn) {
      chipText = 'Login Needed';
      chipClass = 'login-needed';
    } else if (isLimited) {
      chipText = 'Limit Reached';
      chipClass = 'limited';
    } else if (state.status === STATUS.APPROACHING || (usedPct !== null && usedPct >= 80)) {
      chipText = `${usedPct}% Used`;
      chipClass = 'approaching';
    } else if (usedPct !== null) {
      chipText = `${usedPct}% Used`;
      chipClass = 'available';
    } else if (state.fetchStatus === 'tab_required') {
      chipText = 'Needs Sync';
      chipClass = 'approaching';
    }

    let meterColor = botDef.color;
    if (!isLoggedIn) meterColor = '#94a3b8';
    else if (isLimited) meterColor = '#ef4444';
    else if (state.status === STATUS.APPROACHING) meterColor = '#f59e0b';

    const tierLabel = state.tierLabel || botDef.tiers[state.tier]?.label || botDef.name;
    const modelLabel = state.activeModel || botDef.defaultModel;

    // Sync badge
    let syncBadgeHtml = '';
    if (!isLoggedIn) {
      syncBadgeHtml = `<span class="sync-badge login-required">🔒 Not Logged In</span>`;
    } else if (state.hasRealTelemetry && state.lastFetchedAt) {
      syncBadgeHtml = `<span class="sync-badge synced">⚡ Live (${formatRelativeTime(state.lastFetchedAt)})</span>`;
    } else {
      syncBadgeHtml = `<span class="sync-badge tab-required">🌐 Click Sync to Fetch</span>`;
    }

    const accountEmailHtml = isLoggedIn && state.accountEmail
      ? `<span class="account-email" title="${state.accountEmail}">👤 ${state.accountEmail}</span>`
      : '';

    // Real rate-limit windows breakdown (e.g. Claude 5h/7d, ChatGPT primary/weekly, DeepSeek quotas)
    let windowsHtml = '';
    if (isLoggedIn && Array.isArray(state.windows) && state.windows.length > 0) {
      const winItems = state.windows.map(w => {
        const wReset = w.resetsAt && w.resetsAt > now
          ? ` • Resets ${formatCountdown(w.resetsAt - now)}`
          : '';
        const countPart = typeof w.used === 'number' && typeof w.limit === 'number'
          ? ` (${w.used}/${w.limit})`
          : '';
        return `<div class="quota-win-row">
          <span>${w.label}:</span>
          <strong>${w.usedPercent}% used • ${w.remainingPercent}% left${countPart}${wReset}</strong>
        </div>`;
      }).join('');
      windowsHtml = `<div class="extra-windows">${winItems}</div>`;
    }

    // Body content
    let bodyContentHtml = '';
    if (!isLoggedIn) {
      bodyContentHtml = `
        <div class="login-callout">
          <span class="callout-icon">🔒</span>
          <div class="callout-text">
            <span>Sign in to <strong>${botDef.name}</strong> in your browser to fetch real usage limits and remaining tokens.</span>
          </div>
        </div>
      `;
    } else if (!state.hasRealTelemetry && usedPct === null && tokensUsed === null) {
      bodyContentHtml = `
        <div class="login-callout" style="border-color: rgba(56, 189, 248, 0.35);">
          <span class="callout-icon">⚡</span>
          <div class="callout-text">
            <span>Session detected for <strong>${botDef.name}</strong>. Click <strong>Sync Live Usage</strong> below to fetch real quota & remaining tokens.</span>
          </div>
        </div>
      `;
    } else {
      // Primary display values for TOTAL USAGE and REMAINING TOKENS / QUOTA
      const usedPrimary = hasTokens
        ? `${formatTokens(tokensUsed)} <span class="val-denom">tokens</span>`
        : `${usedPct ?? 0}% <span class="val-denom">used</span>`;

      const usedSub = (hasTokens && typeof state.inputTokens === 'number' && typeof state.outputTokens === 'number')
        ? `In: ${formatTokens(state.inputTokens)} • Out: ${formatTokens(state.outputTokens)}${usedPct !== null ? ` • ${usedPct}%` : ''}`
        : (usedPct !== null ? `${usedPct}% of quota window` : 'Live session usage');

      const remPrimary = typeof tokensRemaining === 'number'
        ? `<strong style="color: #34d399;">${formatTokens(tokensRemaining)}</strong> <span class="val-denom">tok left</span>`
        : `<strong style="color: #34d399;">${remPct ?? 100}%</strong> <span class="val-denom">remaining</span>`;

      const remSub = (typeof tokensRemaining === 'number' && tokenLimit)
        ? `${remPct !== null ? `${remPct}% left • ` : ''}Limit: ${formatTokens(tokenLimit)} tok`
        : `${remPct ?? 100}% quota capacity remaining`;

      const barWidth = isLimited ? 100 : (usedPct ?? 0);

      bodyContentHtml = `
        <div class="usage-dual-badges">
          <div class="usage-badge used" title="Real usage & tokens consumed">
            <div class="usage-badge-label">
              <span class="badge-dot dot-used"></span>
              <span>TOTAL USAGE</span>
            </div>
            <div class="usage-badge-val">
              <strong>${usedPrimary}</strong>
            </div>
            <div class="usage-badge-sub">${usedSub}</div>
          </div>

          <div class="usage-badge pending" title="Real remaining tokens & quota">
            <div class="usage-badge-label">
              <span class="badge-dot dot-pending"></span>
              <span>REMAINING</span>
            </div>
            <div class="usage-badge-val">
              ${remPrimary}
            </div>
            <div class="usage-badge-sub">${remSub}</div>
          </div>
        </div>

        <div class="card-meter-section">
          <div class="meter-track">
            <div class="meter-fill" style="width: ${barWidth}%; background: ${meterColor};"></div>
          </div>
          <div class="meter-labels">
            <span>Used: ${usedPct !== null ? `${usedPct}%` : '--'}${hasTokens ? ` (${formatTokens(tokensUsed)} tok)` : ''}</span>
            <span>Remaining: ${isLimited ? '0% (Limit Hit)' : `${remPct !== null ? `${remPct}%` : '--'}${typeof tokensRemaining === 'number' ? ` (${formatTokens(tokensRemaining)} tok)` : ''}`}</span>
          </div>
          ${windowsHtml}
          ${state.tokenSource ? `<div class="token-source-line">📊 Source: ${state.tokenSource} (${modelLabel})</div>` : ''}
        </div>

        <div class="countdown-box ${isLimited ? 'urgent' : ''}" id="countdown-box-${botId}">
          <span class="countdown-label">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
            <span class="cd-title">${isLimited ? 'Cooldown resets in:' : 'Window resets in:'}</span>
          </span>
          <span class="countdown-value" id="cd-val-${botId}">--:--</span>
        </div>
      `;
    }

    // Action buttons
    let actionsHtml = '';
    if (!isLoggedIn) {
      actionsHtml = `
        <button class="btn-login" data-login-bot="${botId}">
          🔑 Log In to ${botDef.shortName}
        </button>
        <button class="btn-sync" data-sync-bot="${botId}" title="Try syncing ${botDef.name} session">
          ⚡ Sync
        </button>
      `;
    } else {
      actionsHtml = `
        <button class="btn-sync" data-sync-bot="${botId}" title="Fetch live usage & tokens from ${botDef.name}">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
          </svg>
          Sync Live Usage
        </button>
        <button class="btn-open" data-open-bot="${botId}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
          </svg>
          Open Chat
        </button>
        ${isLimited ? `<button class="btn-clear" data-clear-bot="${botId}">Clear</button>` : ''}
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
            <div style="display: flex; align-items: center; gap: 4px; margin-top: 2px; flex-wrap: wrap;">
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

  // Update Overview stats with real tokens
  const statUsedEl = document.getElementById('statTotalUsed');
  if (statUsedEl) {
    statUsedEl.textContent = anyTokenTelemetry ? `${formatTokens(totalTokensUsed)} tok` : '0 tok';
  }
  const statPendingEl = document.getElementById('statTotalPending');
  if (statPendingEl) {
    statPendingEl.textContent = anyTokenTelemetry ? `${formatTokens(totalTokensRemaining)} tok` : '--';
  }
  const statLimitedEl = document.getElementById('statLimitedBots');
  if (statLimitedEl) {
    statLimitedEl.textContent = limitedCount > 0 ? `${limitedCount} Limited` : `${syncedBotsCount} / ${Object.keys(BOTS).length}`;
  }

  // Header status & login banner
  const headerStatusText = document.getElementById('headerStatusText');
  const loginBanner = document.getElementById('loginWarningBanner');

  if (loginNeededCount > 0) {
    if (headerStatusText) {
      headerStatusText.textContent = `${syncedBotsCount} Connected • ${loginNeededCount} Need Login`;
      headerStatusText.style.color = '#f59e0b';
    }
    if (loginBanner) {
      loginBanner.classList.remove('hidden');
      loginBanner.innerHTML = `
        <div class="login-banner-content">
          <span class="banner-icon">🔒</span>
          <div class="banner-msg">
            <strong>Sign in required for ${loginNeededBots.join(', ')}:</strong>
            <span>Log in to fetch real usage quotas and remaining tokens from your account.</span>
          </div>
        </div>
      `;
    }
  } else {
    if (loginBanner) loginBanner.classList.add('hidden');
    if (headerStatusText) {
      if (limitedCount > 0) {
        headerStatusText.textContent = `${limitedCount} Bot${limitedCount > 1 ? 's' : ''} at Usage Limit`;
        headerStatusText.style.color = '#f87171';
      } else {
        headerStatusText.textContent = 'Live Provider Usage & Token Telemetry';
        headerStatusText.style.color = '#34d399';
      }
    }
  }

  bindCardActions();
  updateLiveTimers();
}

function updateLiveTimers() {
  const now = Date.now();

  for (const [botId] of Object.entries(BOTS)) {
    const state = currentStates[botId];
    if (!state) continue;

    const valEl = document.getElementById(`cd-val-${botId}`);
    if (!valEl) continue;

    if (state.resetsAt && state.resetsAt > now) {
      const remainingMs = Math.max(0, state.resetsAt - now);
      valEl.textContent = formatCountdown(remainingMs);
      if (remainingMs <= 0) {
        renderDashboard();
        return;
      }
    } else {
      valEl.textContent = 'No active cooldown';
    }
  }
}

function bindCardActions() {
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

  document.querySelectorAll('[data-sync-bot]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const botId = e.currentTarget.dataset.syncBot;
      btn.classList.add('spinning');
      btn.disabled = true;
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

  document.querySelectorAll('[data-clear-bot]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const botId = e.currentTarget.dataset.clearBot;
      await clearLimit(botId);
      await renderDashboard();
    });
  });
}

async function triggerSyncFromBrowser(allowTempTab = false) {
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.classList.add('spinning');

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'SYNC_USAGE_LIMITS', data: { allowTempTab } },
          (response) => {
            if (response?.states) {
              currentStates = response.states;
            }
            resolve();
          }
        );
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

document.addEventListener('DOMContentLoaded', async () => {
  await renderDashboard();

  // Trigger live sync from open tabs & background sessions on open
  triggerSyncFromBrowser(false);

  setInterval(updateLiveTimers, 1000);

  document.getElementById('refreshBtn').addEventListener('click', () => triggerSyncFromBrowser(true));
  const syncAllFooterBtn = document.getElementById('syncAllFooterBtn');
  if (syncAllFooterBtn) {
    syncAllFooterBtn.addEventListener('click', () => triggerSyncFromBrowser(true));
  }

  document.getElementById('optionsBtn').addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open('../options/options.html', '_blank');
    }
  });

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'STATE_UPDATED' && message.data) {
        currentStates = message.data;
        renderDashboard();
      }
    });
  }
});
