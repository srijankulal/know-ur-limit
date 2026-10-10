# Know Ur Limit ⏳

> **All-in-one usage limit monitor, rate limit detector, and reset countdown tracker for Claude, ChatGPT, Google Gemini, and DeepSeek.**

Monitor your chat quotas, track message limits, detect rate limits in real-time, and get notified the exact minute your cooldown resets — all from a single browser extension popup or subtle in-page HUD.

---

## ✨ Features

- **All Major AI Bots in One Place**:
  - **Claude** (`claude.ai`): Claude 3.5 Sonnet / Opus / Haiku (Free & Pro ~45 msgs / 5h).
  - **ChatGPT** (`chatgpt.com` & `chat.openai.com`): GPT-4o, o1, o3-mini (Free, Plus ~80 msgs / 3h, Team, Pro).
  - **Google Gemini** (`gemini.google.com`): Gemini 2.0 Flash, Gemini Advanced (Google One AI Premium).
  - **DeepSeek** (`chat.deepseek.com`): DeepSeek V3 / R1 web limits and server peak quotas.
- **Deep Network & DOM Telemetry**:
  - **Network Interceptor (MAIN World)**: Captures HTTP `429 Too Many Requests`, `resets_at` timestamps, `clears_in` seconds, and subscription tiers (`pro`, `plus`, `advanced`, `free`) directly from official API responses.
  - **DOM Observer**: Continually monitors chat containers for warning messages like *"You have 5 messages remaining until 3:00 PM"* or *"You've reached your usage limit until 4:15 PM"*.
- **Predictive Rolling Window Quota**:
  - Automatically logs outgoing prompts and calculates rolling usage consumption so you know how close you are to your cap *before* getting blocked.
- **Live Ticking Countdown Timers**:
  - Real-time `hh:mm:ss` countdown to the moment your limit resets or your oldest rolling message slot clears.
- **Desktop System Notifications**:
  - Get notified instantly the moment a cooldown expires: *"🎉 Claude is ready! Your 5-hour limit window has reset."*
- **Toolbar Badge Counter**:
  - Glance at your browser toolbar to see remaining cooldown minutes (e.g., `15m` in red) or active status.
- **In-Page Floating Status HUD**:
  - Optional subtle glassmorphism pill in the corner of your chat page showing message count and time until reset.
- **Customizable Quotas & Plans**:
  - Easily tweak maximum message caps and window lengths in the Options page to match custom enterprise or team plans.
- **100% Private & Local**:
  - Runs entirely in your browser using `chrome.storage.local`. No external analytics, no telemetry, no tracking, and no API keys required.

---

## 🚀 Installation Guide

Works on **Google Chrome**, **Brave**, **Microsoft Edge**, **Arc**, **Opera**, and any Chromium-based browser supporting Manifest V3.

### Step 1: Open Extension Management
- **Google Chrome**: Navigate to `chrome://extensions/`
- **Brave**: Navigate to `brave://extensions/`
- **Microsoft Edge**: Navigate to `edge://extensions/`

### Step 2: Enable Developer Mode
- Toggle the **"Developer mode"** switch in the top-right corner of the extensions page.

### Step 3: Load Unpacked Extension
1. Click the **"Load unpacked"** button in the top-left.
2. Select the repository directory:
   ```
   know-ur-limit
   ```
3. The extension **"Know Ur Limit - AI Usage & Rate Limit Tracker"** will appear in your extensions list.
4. Click the puzzle icon 🧩 in your browser toolbar and click the **Pin** 📌 icon next to **Know Ur Limit** to keep it readily visible.

---

## 🧩 How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     Active Browser Tab                          │
│                                                                 │
│   ChatGPT.com  /  Claude.ai  /  Gemini.google.com  / DeepSeek   │
│                                                                 │
│  [ MAIN World: interceptor.js ]   [ ISOLATED: DOM Observers ]   │
│   - Intercepts fetch/XHR           - Watches warning banners    │
│   - Detects 429 & resets_at        - Captures UI prompt clicks  │
│   - Reads account plan tiers       - Injects Floating Mini HUD  │
└───────────────────────────────┬─────────────────────────────────┘
                                │ window.postMessage + bridge.js
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│           Background Service Worker (service_worker.js)         │
│                                                                 │
│   - Maintains rolling window prompt counters                    │
│   - Schedules chrome.alarms for exact reset timestamps          │
│   - Dispatches chrome.notifications when limits reset           │
│   - Updates toolbar badge (e.g. "25m" in red)                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        ▼                                               ▼
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  Popup Dashboard (popup.js)  │        │   Options Page (options.js)  │
│  - Live countdown ticker     │        │  - Custom quota thresholds   │
│  - Progress bars per bot     │        │  - Notification preferences  │
│  - One-click tab switcher    │        │  - Export / Clear JSON logs  │
│  - Built-in limit simulator  │        │  - Test notification trigger │
└──────────────────────────────┘        └──────────────────────────────┘
```

---

## 🛠️ Testing & Simulation

Want to test how notifications and countdown badges look without waiting until you hit a real rate limit?

1. Click the **AI Limit Hub** extension icon in your browser toolbar.
2. Click **"Simulate Limit"** at the bottom of the popup.
3. Select an AI bot (e.g., *Claude* or *ChatGPT*) and set a duration (e.g., `5` minutes).
4. Click **"Start Cooldown"**.
5. You'll immediately see:
   - The card switch to `Limited` with red pulsing glow.
   - The countdown timer start ticking down.
   - The extension badge turn red with the remaining minutes.
   - A desktop notification fire when the timer reaches zero!
6. Click **"Clear"** on the card anytime to reset it back to normal.

---

## ⚙️ Customizing Limits

Right-click the extension icon and select **Options** (or click the gear icon in the popup):
- Adjust message allowances for **ChatGPT Plus / Team / Pro**.
- Adjust message allowances for **Claude Pro / Team / Free**.
- Adjust rolling window lengths (e.g., 180 min, 300 min, 1440 min).
- Toggle in-page floating status HUD on or off.
- Export your prompt history as a JSON file.

---

## 🔒 Privacy & Permissions

- **`storage`**: Used only to save your prompt counts, detected reset timers, and custom preferences locally on your computer.
- **`alarms`**: Used to wake up the timer when your rate limit resets so it can alert you.
- **`notifications`**: Used to send system desktop alerts when cooldowns finish.
- **`tabs`**: Used to switch directly to your active ChatGPT/Claude/Gemini tab when you click "Open Chat".
- **Zero Remote Servers**: No tracking, no analytics, no external servers. 100% open source and local.
