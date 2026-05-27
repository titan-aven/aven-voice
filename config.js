// aven-voice configuration
// Copy this file to config.local.js and fill in your values.
// config.local.js is gitignored.

const CONFIG = {
  // OpenClaw Gateway URL (use Tailscale IP for remote access)
  // Example: "http://100.115.12.83:3000"
  OPENCLAW_URL: "http://localhost:3000",

  // OpenClaw Gateway token (from openclaw.json → server.token)
  OPENCLAW_TOKEN: "YOUR_GATEWAY_TOKEN",

  // OpenAI API key (for Whisper STT + TTS)
  OPENAI_API_KEY: "YOUR_OPENAI_API_KEY",

  // TTS voice (echo = Aven's voice)
  TTS_VOICE: "echo",

  // TTS model
  TTS_MODEL: "gpt-4o-mini-tts",

  // OpenClaw session to send messages to (e.g. "main" or a specific session key)
  // "main" = your primary Aven session
  OPENCLAW_SESSION: "main",

  // Discord channel ID for parallel logging (set to null to disable)
  // This is the #aven-voice channel
  DISCORD_LOG_CHANNEL: "1508947511099003051",

  // Max recording duration in seconds
  MAX_RECORD_SECONDS: 60,
};

// Allow local override
if (typeof LOCAL_CONFIG !== "undefined") {
  Object.assign(CONFIG, LOCAL_CONFIG);
}
