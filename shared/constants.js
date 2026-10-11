/**
 * AI Usage Limits Hub - Constants & Configuration
 */

export const BOTS = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    shortName: 'GPT',
    url: 'https://chatgpt.com',
    loginUrl: 'https://chatgpt.com/auth/login',
    domains: ['chatgpt.com', 'chat.openai.com'],
    authDomain: 'chatgpt.com',
    authCookies: ['__Secure-next-auth.session-token', '__Host-next-auth.session-token', 'next-auth.session-token', '_puid'],
    color: '#10a37f',
    colorLight: '#e6f7f2',
    defaultModel: 'gpt-4o',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M22.28 9.87a6.04 6.04 0 0 0-.5-4.2 6.13 6.13 0 0 0-6.52-3.1 6.1 6.1 0 0 0-4.66-2.07 6.13 6.13 0 0 0-5.83 4.25 6.1 6.1 0 0 0-4.22 3.08 6.13 6.13 0 0 0 .7 7.23 6.04 6.04 0 0 0 .5 4.2 6.13 6.13 0 0 0 6.52 3.1 6.1 6.1 0 0 0 4.66 2.07 6.13 6.13 0 0 0 5.83-4.25 6.1 6.1 0 0 0 4.22-3.08 6.13 6.13 0 0 0-.7-7.23zM12 21.5a4.6 4.6 0 0 1-2.95-1.07l.15-.08 4.88-2.82a.77.77 0 0 0 .39-.67v-6.9l2.08 1.2a.74.74 0 0 1 .38.65v5.7a4.63 4.63 0 0 1-4.93 3.99zm-8.38-4.2a4.6 4.6 0 0 1-.58-3.09l.15.09 4.88 2.82a.77.77 0 0 0 .77 0l5.98-3.45v2.4a.74.74 0 0 1-.38.65l-4.94 2.85a4.63 4.63 0 0 1-5.88-2.27zm-1.1-9.9a4.6 4.6 0 0 1 2.37-2.02v5.82a.77.77 0 0 0 .39.67l5.98 3.45-2.08 1.2a.74.74 0 0 1-.77 0l-4.94-2.85a4.63 4.63 0 0 1-.95-6.27zm14.86 2.7l-4.88-2.82a.77.77 0 0 0-.77 0L5.75 10.73v-2.4a.74.74 0 0 1 .38-.65l4.94-2.85a4.63 4.63 0 0 1 6.83 5.36l-.15-.09zm3.48 4.1a4.6 4.6 0 0 1-.58 3.09l-.15-.09-4.88-2.82a.77.77 0 0 0-.77 0l-5.98 3.45v-2.4a.74.74 0 0 1 .38-.65l4.94-2.85a4.63 4.63 0 0 1 6.83 5.36z"/></svg>`,
    tiers: {
      free: { label: 'Free Tier', defaultMax: 10, windowMinutes: 180, description: 'GPT-4o mini unlimited, GPT-4o ~10 msgs / 3h' },
      plus: { label: 'ChatGPT Plus', defaultMax: 80, windowMinutes: 180, description: 'GPT-4o ~80 msgs / 3h' },
      team: { label: 'ChatGPT Team', defaultMax: 100, windowMinutes: 180, description: 'Higher message caps / 3h' },
      pro: { label: 'ChatGPT Pro', defaultMax: 300, windowMinutes: 180, description: 'Unlimited 4o, high o1 limits' }
    }
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    shortName: 'Claude',
    url: 'https://claude.ai',
    loginUrl: 'https://claude.ai/login',
    domains: ['claude.ai'],
    authDomain: 'claude.ai',
    authCookies: ['sessionKey', 'lastActiveOrg', 'activitySessionId', 'anthropic-consent', 'cf_clearance', 'intercom-session'],
    color: '#d97706',
    colorLight: '#fef3c7',
    defaultModel: 'claude-3-5-sonnet',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3z"/></svg>`,
    tiers: {
      free: { label: 'Free Tier', defaultMax: 12, windowMinutes: 300, description: 'Claude 3.5 Sonnet ~10-15 msgs / 5h' },
      pro: { label: 'Claude Pro', defaultMax: 45, windowMinutes: 300, description: 'Claude 3.5 Sonnet ~45 msgs / 5h' },
      team: { label: 'Claude Team', defaultMax: 90, windowMinutes: 300, description: 'Team workspace ~90 msgs / 5h' }
    }
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    shortName: 'Gemini',
    url: 'https://gemini.google.com',
    loginUrl: 'https://gemini.google.com',
    domains: ['gemini.google.com'],
    authDomain: 'google.com',
    authCookies: ['__Secure-1PSID', 'SID', 'HSID', 'SSID'],
    color: '#2563eb',
    colorLight: '#dbeafe',
    defaultModel: 'gemini-2.0-flash',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/></svg>`,
    tiers: {
      free: { label: 'Standard', defaultMax: 50, windowMinutes: 1440, description: 'Gemini 2.0 Flash / Pro quota' },
      advanced: { label: 'Gemini Advanced', defaultMax: 150, windowMinutes: 1440, description: 'Google One AI Premium tier' }
    }
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    shortName: 'DeepSeek',
    url: 'https://chat.deepseek.com',
    loginUrl: 'https://chat.deepseek.com/sign_in',
    domains: ['chat.deepseek.com'],
    authDomain: 'deepseek.com',
    authCookies: ['userToken', 'd_user', 'ds_token'],
    color: '#0284c7',
    colorLight: '#e0f2fe',
    defaultModel: 'deepseek-chat',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm1.07-5.75-.48.65c-.47.64-.59.95-.59 1.6h-2c0-1.1.34-1.8 1-2.48l.68-.73c.37-.4.57-.8.57-1.29a1.25 1.25 0 1 0-2.5 0H7.75a3.25 3.25 0 1 1 6.5 0c0 .92-.38 1.67-.92 2.45z"/></svg>`,
    tiers: {
      free: { label: 'Free Tier', defaultMax: 50, windowMinutes: 1440, description: 'DeepSeek V3 / R1 web limits' }
    }
  }
};

export const STATUS = {
  AVAILABLE: 'available',
  APPROACHING: 'approaching',
  LIMITED: 'limited',
  UNKNOWN: 'unknown'
};

export const DEFAULT_SETTINGS = {
  notifyOnReset: true,
  notifyOnLimit: true,
  notifyOnApproaching: true,
  warningThresholdPercent: 85, // Alert user when reaching 85% of quota
  badgeMode: 'countdown', // 'countdown' | 'count' | 'off'
  showFloatingHud: true,
  soundEnabled: false,
  autoFetchFromBrowser: true, // Automatically query AI model usage limits from active browser sessions
  autoFetchIntervalMinutes: 2, // Background auto-sync interval
  customLimits: {
    chatgpt: { tier: 'plus', maxPrompts: 80, windowMinutes: 180 },
    claude: { tier: 'pro', maxPrompts: 45, windowMinutes: 300 },
    gemini: { tier: 'free', maxPrompts: 50, windowMinutes: 1440 },
    deepseek: { tier: 'free', maxPrompts: 50, windowMinutes: 1440 }
  }
};

export const MESSAGE_TYPES = {
  PROMPT_SENT: 'AI_USAGE_PROMPT_SENT',
  LIMIT_DETECTED: 'AI_USAGE_LIMIT_DETECTED',
  LIMIT_CLEARED: 'AI_USAGE_LIMIT_CLEARED',
  PLAN_DETECTED: 'AI_USAGE_PLAN_DETECTED',
  REQUEST_STATE: 'AI_USAGE_REQUEST_STATE',
  STATE_UPDATED: 'AI_USAGE_STATE_UPDATED',
  SIMULATE_LIMIT: 'AI_USAGE_SIMULATE_LIMIT',
  CLEAR_ALL: 'AI_USAGE_CLEAR_ALL',
  AUTO_FETCH_RESULT: 'AI_USAGE_AUTO_FETCH_RESULT',
  TRIGGER_AUTO_FETCH: 'AI_USAGE_TRIGGER_AUTO_FETCH',
  SYNC_USAGE_LIMITS: 'AI_USAGE_SYNC_USAGE_LIMITS'
};
