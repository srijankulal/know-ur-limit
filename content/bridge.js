/**
 * Know Ur Limit - ISOLATED World Bridge & In-Page Floating HUD
 * Bridges real usage/token telemetry between MAIN world interceptor and background service worker,
 * and renders a live in-page HUD showing real quota & remaining tokens.
 */

(function () {
  'use strict';

  const EVENT_SOURCE = 'AI_LIMITS_HUB';
  let currentBotId = null;
  let currentBotState = null;
  let hudElement = null;

  const host = window.location.hostname;
  if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) {
    currentBotId = 'chatgpt';
  } else if (host.includes('claude.ai')) {
    currentBotId = 'claude';
  } else if (host.includes('gemini.google.com')) {
    currentBotId = 'gemini';
  } else if (host.includes('deepseek.com')) {
    currentBotId = 'deepseek';
  }

  function formatCompactTokens(num) {
    if (typeof num !== 'number' || isNaN(num)) return '--';
    if (num >= 1000000) return `${(num / 1000000).toFixed(2).replace(/\.00$/, '')}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return `${num}`;
  }

  function formatRemainingTime(ms) {
    if (ms <= 0) return '0s';
    const totalSecs = Math.floor(ms / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const seconds = totalSecs % 60;

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  // 1. Forward network telemetry events from interceptor.js (MAIN world) to background
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== EVENT_SOURCE) {
      return;
    }

    const { type, payload } = event.data;
    if (!payload || !payload.botId) return;

    try {
      chrome.runtime.sendMessage({
        action: type,
        data: payload
      }, (response) => {
        if (chrome.runtime.lastError) return;
        if (response && response.state) {
          currentBotState = response.state;
          updateHudUI();
        }
      });
    } catch (_) {}
  });

  // 2. Request initial state from background
  function requestCurrentState() {
    if (!currentBotId) return;
    try {
      chrome.runtime.sendMessage({
        action: 'REQUEST_BOT_STATE',
        data: { botId: currentBotId }
      }, (response) => {
        if (chrome.runtime.lastError) return;
        if (response && response.state) {
          currentBotState = response.state;
          renderFloatingHud();
        }
      });
    } catch (_) {}
  }

  // 3. Listen for state broadcasts from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'STATE_UPDATED' && message.data && message.data[currentBotId]) {
      currentBotState = message.data[currentBotId];
      updateHudUI();
    } else if (message.action === 'TRIGGER_AUTO_FETCH' && (message.botId === currentBotId || !message.botId)) {
      window.postMessage({
        source: 'AI_LIMITS_HUB_REQUEST',
        action: 'TRIGGER_IN_PAGE_FETCH',
        botId: currentBotId
      }, '*');
    }
  });

  // 4. Floating HUD Implementation (Real Usage & Remaining Tokens)
  function renderFloatingHud() {
    if (hudElement || !currentBotState) return;

    hudElement = document.createElement('div');
    hudElement.id = '__ai_limits_floating_hud__';
    hudElement.className = 'ai-limits-hud ai-limits-hud-minimized';

    hudElement.innerHTML = `
      <div class="ai-limits-hud-pill" id="__ai_limits_pill__">
        <span class="ai-limits-hud-indicator" id="__ai_limits_indicator__"></span>
        <span class="ai-limits-hud-brand" id="__ai_limits_brand__">AI Hub</span>
        <span class="ai-limits-hud-summary" id="__ai_limits_summary__">Syncing...</span>
        <button class="ai-limits-hud-btn" id="__ai_limits_toggle_btn__" title="Expand view">▾</button>
      </div>
      <div class="ai-limits-hud-details" id="__ai_limits_details__" style="display: none;">
        <div class="ai-limits-hud-header">
          <span class="ai-limits-hud-title" id="__ai_limits_card_title__">Live Telemetry</span>
          <span class="ai-limits-hud-tier" id="__ai_limits_card_tier__"></span>
        </div>
        <div class="ai-limits-hud-dual-stat">
          <span class="stat-used" id="__ai_limits_used_stat__">Used: --</span>
          <span class="stat-pending" id="__ai_limits_pending_stat__">Remaining: --</span>
        </div>
        <div class="ai-limits-hud-meter">
          <div class="ai-limits-hud-meter-bar" id="__ai_limits_meter_bar__"></div>
        </div>
        <div class="ai-limits-hud-info">
          <span id="__ai_limits_count_text__">Tokens: --</span>
          <span id="__ai_limits_reset_text__">--</span>
        </div>
        <div class="ai-limits-hud-note" id="__ai_limits_note__"></div>
      </div>
    `;

    document.body.appendChild(hudElement);

    const pill = hudElement.querySelector('#__ai_limits_pill__');
    const toggleBtn = hudElement.querySelector('#__ai_limits_toggle_btn__');
    const details = hudElement.querySelector('#__ai_limits_details__');

    let expanded = false;
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      expanded = !expanded;
      details.style.display = expanded ? 'block' : 'none';
      toggleBtn.textContent = expanded ? '▴' : '▾';
      hudElement.classList.toggle('ai-limits-hud-expanded', expanded);
    });

    updateHudUI();
    setInterval(updateHudUI, 1000);
  }

  function updateHudUI() {
    if (!hudElement || !currentBotState) return;

    const indicator = hudElement.querySelector('#__ai_limits_indicator__');
    const brand = hudElement.querySelector('#__ai_limits_brand__');
    const summary = hudElement.querySelector('#__ai_limits_summary__');
    const cardTitle = hudElement.querySelector('#__ai_limits_card_title__');
    const cardTier = hudElement.querySelector('#__ai_limits_card_tier__');
    const usedStat = hudElement.querySelector('#__ai_limits_used_stat__');
    const pendingStat = hudElement.querySelector('#__ai_limits_pending_stat__');
    const meterBar = hudElement.querySelector('#__ai_limits_meter_bar__');
    const countText = hudElement.querySelector('#__ai_limits_count_text__');
    const resetText = hudElement.querySelector('#__ai_limits_reset_text__');
    const note = hudElement.querySelector('#__ai_limits_note__');

    const state = currentBotState;
    const hasPct = typeof state.usedPercent === 'number';
    const usedPct = hasPct ? state.usedPercent : 0;
    const remPct = hasPct ? Math.max(0, Number((100 - usedPct).toFixed(1))) : null;

    const hasTokens = typeof state.tokensUsed === 'number';
    const tokUsedStr = hasTokens ? formatCompactTokens(state.tokensUsed) : '--';
    const tokRemStr = typeof state.tokensRemaining === 'number' ? formatCompactTokens(state.tokensRemaining) : '--';

    brand.textContent = state.botId.toUpperCase();
    cardTitle.textContent = `${state.botId.toUpperCase()} Live Usage`;
    cardTier.textContent = state.tierLabel || (state.tier ? state.tier.toUpperCase() : 'LIVE');

    if (usedStat) {
      usedStat.textContent = hasPct
        ? `Used: ${usedPct}%${hasTokens ? ` (${tokUsedStr} tok)` : ''}`
        : `Used: ${tokUsedStr} tok`;
    }
    if (pendingStat) {
      pendingStat.textContent = remPct !== null
        ? `Left: ${remPct}%${typeof state.tokensRemaining === 'number' ? ` (${tokRemStr} tok)` : ''}`
        : `Left: ${tokRemStr} tok`;
    }

    const now = Date.now();
    const isLimited = state.status === 'limited' || (usedPct >= 100);
    const remainingMs = state.resetsAt && state.resetsAt > now ? state.resetsAt - now : 0;

    if (isLimited) {
      indicator.className = 'ai-limits-hud-indicator limited';
      summary.textContent = remainingMs > 0
        ? `Limit Hit • Resets ${formatRemainingTime(remainingMs)}`
        : `Limit Reached (100%)`;
      countText.textContent = hasTokens ? `Tokens: ${tokUsedStr} used / 0 left` : `Quota: 100% used`;
      resetText.textContent = remainingMs > 0 ? `⏳ ${formatRemainingTime(remainingMs)}` : 'Limit Hit';
      meterBar.style.width = '100%';
      meterBar.className = 'ai-limits-hud-meter-bar limited';
      note.textContent = state.limitReason || 'Wait until cooldown resets.';
    } else if (state.status === 'approaching' || usedPct >= 80) {
      indicator.className = 'ai-limits-hud-indicator approaching';
      summary.textContent = hasTokens
        ? `${usedPct}% used • ${tokRemStr} tok left`
        : `${usedPct}% used • ${remPct}% left`;
      countText.textContent = hasTokens ? `Tokens: ${tokUsedStr} used • ${tokRemStr} left` : `Quota: ${usedPct}% used`;
      resetText.textContent = remainingMs > 0 ? `Resets: ${formatRemainingTime(remainingMs)}` : 'Live';
      meterBar.style.width = `${usedPct}%`;
      meterBar.className = 'ai-limits-hud-meter-bar approaching';
      note.textContent = state.tokenSource || 'Approaching usage limit.';
    } else {
      indicator.className = 'ai-limits-hud-indicator available';
      if (hasPct && hasTokens) {
        summary.textContent = `${usedPct}% used • ${tokRemStr} tok left`;
      } else if (hasPct) {
        summary.textContent = `${usedPct}% used • ${remPct}% left`;
      } else if (hasTokens) {
        summary.textContent = `${tokUsedStr} used • ${tokRemStr} tok left`;
      } else {
        summary.textContent = `Syncing telemetry...`;
      }
      countText.textContent = hasTokens ? `Tokens: ${tokUsedStr} used • ${tokRemStr} left` : `Quota: ${hasPct ? `${usedPct}% used` : 'Active'}`;
      resetText.textContent = remainingMs > 0 ? `Resets: ${formatRemainingTime(remainingMs)}` : 'Active';
      meterBar.style.width = `${usedPct}%`;
      meterBar.className = 'ai-limits-hud-meter-bar available';
      note.textContent = state.tokenSource || 'Live telemetry synced from session.';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      requestCurrentState();
      renderFloatingHud();
    });
  } else {
    requestCurrentState();
    renderFloatingHud();
  }
})();
