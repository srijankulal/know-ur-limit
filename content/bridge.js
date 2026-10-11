/**
 * AI Usage Limits Hub - ISOLATED World Bridge & Floating HUD
 * Bridges messages between page context (interceptor) and background service worker.
 */

(function () {
  'use strict';

  const EVENT_SOURCE = 'AI_LIMITS_HUB';
  let currentBotId = null;
  let currentBotState = null;
  let hudElement = null;

  // Identify current host
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

  // 1. Listen for network events dispatched by interceptor.js
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
        if (chrome.runtime.lastError) {
          // Worker might be waking up
          return;
        }
        if (response && response.state) {
          currentBotState = response.state;
          updateHudUI();
        }
      });
    } catch (e) {
      console.warn('[AI Limits Bridge] Message sending failed:', e);
    }
  });

  // 2. Fetch initial state from background
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
    } catch (e) {}
  }

  // 3. Listen for state updates and trigger requests from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'STATE_UPDATED' && message.data && message.data[currentBotId]) {
      currentBotState = message.data[currentBotId];
      updateHudUI();
    } else if (message.action === 'TRIGGER_AUTO_FETCH' && (message.botId === currentBotId || !message.botId)) {
      window.postMessage({
        source: 'AI_LIMITS_HUB_REQUEST',
        action: 'TRIGGER_IN_PAGE_FETCH',
        botId: currentBotId
      }, '*');
      if (sendResponse) sendResponse({ success: true, triggered: true });
    }
  });

  // 4. Floating HUD Implementation
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

  function renderFloatingHud() {
    if (hudElement || !currentBotState) return;

    hudElement = document.createElement('div');
    hudElement.id = '__ai_limits_floating_hud__';
    hudElement.className = 'ai-limits-hud ai-limits-hud-minimized';

    hudElement.innerHTML = `
      <div class="ai-limits-hud-pill" id="__ai_limits_pill__">
        <span class="ai-limits-hud-indicator" id="__ai_limits_indicator__"></span>
        <span class="ai-limits-hud-brand" id="__ai_limits_brand__">AI Hub</span>
        <span class="ai-limits-hud-summary" id="__ai_limits_summary__">Loading...</span>
        <button class="ai-limits-hud-btn" id="__ai_limits_toggle_btn__" title="Expand view">▾</button>
      </div>
      <div class="ai-limits-hud-details" id="__ai_limits_details__" style="display: none;">
        <div class="ai-limits-hud-header">
          <span class="ai-limits-hud-title" id="__ai_limits_card_title__">Usage Tracker</span>
          <span class="ai-limits-hud-tier" id="__ai_limits_card_tier__"></span>
        </div>
        <div class="ai-limits-hud-dual-stat">
          <span class="stat-used" id="__ai_limits_used_stat__">Used: 0 msgs</span>
          <span class="stat-pending" id="__ai_limits_pending_stat__">Pending: 0 msgs</span>
        </div>
        <div class="ai-limits-hud-meter">
          <div class="ai-limits-hud-meter-bar" id="__ai_limits_meter_bar__"></div>
        </div>
        <div class="ai-limits-hud-info">
          <span id="__ai_limits_count_text__">0 / 0 msgs</span>
          <span id="__ai_limits_reset_text__">--</span>
        </div>
        <div class="ai-limits-hud-note" id="__ai_limits_note__"></div>
      </div>
    `;

    document.body.appendChild(hudElement);

    // Toggle expand/collapse
    const pill = hudElement.querySelector('#__ai_limits_pill__');
    const toggleBtn = hudElement.querySelector('#__ai_limits_toggle_btn__');
    const details = hudElement.querySelector('#__ai_limits_details__');

    let expanded = false;
    const toggle = (e) => {
      e.stopPropagation();
      expanded = !expanded;
      details.style.display = expanded ? 'block' : 'none';
      toggleBtn.textContent = expanded ? '▴' : '▾';
      hudElement.classList.toggle('ai-limits-hud-expanded', expanded);
    };

    pill.addEventListener('click', toggle);

    updateHudUI();

    // Start timer tick
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
    const max = state.maxPrompts || 80;
    const usedPct = typeof state.usedPercent === 'number'
      ? state.usedPercent
      : Math.min(100, Math.round(((state.prompts || []).length / max) * 100));
    const pendingPct = Math.max(0, 100 - usedPct);

    const usedCount = typeof state.usedCount === 'number'
      ? state.usedCount
      : (typeof state.usedPercent === 'number' ? Math.round((usedPct / 100) * max) : (state.prompts || []).length);
    const pendingCount = typeof state.pendingCount === 'number'
      ? state.pendingCount
      : Math.max(0, max - usedCount);

    brand.textContent = state.botId.toUpperCase();
    cardTitle.textContent = `${state.botId.toUpperCase()} Quota`;
    cardTier.textContent = state.tier ? state.tier.toUpperCase() : 'STANDARD';

    if (usedStat) usedStat.textContent = `Used: ${usedCount} (${usedPct}%)`;
    if (pendingStat) pendingStat.textContent = `Pending: ${pendingCount} (${pendingPct}%)`;

    const now = Date.now();
    const isLimited = state.status === 'limited' || (state.resetsAt && state.resetsAt > now && usedPct >= 95);

    if (isLimited) {
      indicator.className = 'ai-limits-hud-indicator limited';
      const remainingMs = Math.max(0, (state.resetsAt || now) - now);
      summary.textContent = `Limit Hit (${usedCount}/${max}) • Resets ${formatRemainingTime(remainingMs)}`;
      countText.textContent = `Used: ${usedCount}/${max} • Pending: 0 left`;
      resetText.textContent = `⏳ ${formatRemainingTime(remainingMs)}`;
      meterBar.style.width = '100%';
      meterBar.className = 'ai-limits-hud-meter-bar limited';
      note.textContent = state.limitReason || 'Wait until reset countdown finishes.';
    } else if (state.status === 'approaching' || usedPct >= 80) {
      indicator.className = 'ai-limits-hud-indicator approaching';
      let remainingMs = 0;
      if (state.resetsAt && state.resetsAt > now) {
        remainingMs = state.resetsAt - now;
      } else if (state.prompts && state.prompts.length > 0) {
        remainingMs = Math.max(0, (state.prompts[0].timestamp + (state.windowMinutes * 60 * 1000)) - now);
      }
      summary.textContent = `${usedCount} used • ${pendingCount} pending`;
      countText.textContent = `Used: ${usedCount}/${max} • Pending: ${pendingCount} left`;
      resetText.textContent = remainingMs > 0 ? `Reset in: ${formatRemainingTime(remainingMs)}` : 'Active';
      meterBar.style.width = `${usedPct}%`;
      meterBar.className = 'ai-limits-hud-meter-bar approaching';
      note.textContent = state.fetchedFromBrowser ? `Live quota: ${usedCount} used, ${pendingCount} pending.` : `Approaching limit for ${Math.round(state.windowMinutes / 60)}h window.`;
    } else {
      indicator.className = 'ai-limits-hud-indicator available';
      let remainingMs = 0;
      if (state.resetsAt && state.resetsAt > now) {
        remainingMs = state.resetsAt - now;
      } else if (state.prompts && state.prompts.length > 0) {
        remainingMs = Math.max(0, (state.prompts[0].timestamp + (state.windowMinutes * 60 * 1000)) - now);
      }
      summary.textContent = `${usedCount} used • ${pendingCount} pending`;
      countText.textContent = `Used: ${usedCount}/${max} • Pending: ${pendingCount} left`;
      resetText.textContent = remainingMs > 0 ? `Restores: ${formatRemainingTime(remainingMs)}` : 'Full capacity';
      meterBar.style.width = `${usedPct}%`;
      meterBar.className = 'ai-limits-hud-meter-bar available';
      note.textContent = state.fetchedFromBrowser ? `Live quota: ${usedCount} used, ${pendingCount} pending.` : `Window: ${Math.round(state.windowMinutes / 60)}h rolling quota.`;
    }
  }

  // Initialize
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
