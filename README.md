# ⚡ Aven Voice

Voice interface for Aven AI — talk to Aven like ChatGPT voice mode.

## Architecture

```
Microphone
    ↓  (MediaRecorder)
Audio Blob
    ↓  (OpenAI Whisper STT)
User Text ──────────────────────────→ Discord #aven-voice (log)
    ↓  (OpenClaw HTTP API)
Aven Response ──────────────────────→ Discord #aven-voice (log)
    ↓  (OpenAI TTS, voice: echo)
Audio Playback
```

**Stack:** Vanilla JS PWA · No build step · Mobile-first (iOS)

## Setup

### 1. Configure

Copy `config.js` to `config.local.js` and fill in:

```js
const LOCAL_CONFIG = {
  OPENCLAW_URL:    "http://100.115.12.83:3000",  // Tailscale IP
  OPENCLAW_TOKEN:  "your-gateway-token",
  OPENAI_API_KEY:  "sk-...",
};
```

`config.local.js` is gitignored — never commit secrets.

### 2. Run (Mac Mini)

```bash
node server.js
# → http://localhost:8080
```

For iOS access, expose via Tailscale. iOS requires HTTPS for microphone access — use a reverse proxy (nginx + self-signed cert or Tailscale HTTPS).

### 3. Add to Home Screen (iOS)

1. Open in Safari (must be HTTPS)
2. Share → "Zum Home-Bildschirm"
3. Runs as standalone app

## Usage

- **Press and hold** the mic button → speak
- **Release** → Aven responds (audio + transcript)
- Conversation is logged to Discord `#aven-voice` in parallel

## Roadmap

- [ ] Icons (192px + 512px PNG)
- [ ] HTTPS / nginx config for Mac Mini
- [ ] Tailscale serve integration
- [ ] Interrupt Aven mid-sentence
- [ ] OpenAI Realtime API upgrade (ultra-low latency)
- [ ] Conversation history / context management
- [ ] Wake word ("Hey Aven")

## OpenClaw API

Aven Voice uses the OpenClaw session message API:
```
POST /api/sessions/{sessionKey}/message
Authorization: Bearer {token}
{ "message": "..." }
```

Logging uses:
```
POST /api/message/send
{ "channel": "channel:...", "text": "..." }
```
