// Aven Voice — main app logic
// Pipeline: MediaRecorder → Whisper STT → OpenClaw API → OpenAI TTS → Audio playback
// Parallel: Discord channel logging
//
// UX: Tap-to-Toggle — one tap starts recording, next tap stops + sends
// API: all OpenClaw calls go through /api/chat proxy on server.js (no CORS)

"use strict";

// ─── State ───────────────────────────────────────────────────────────────────
let mediaRecorder    = null;
let audioChunks      = [];
let isRecording      = false;
let isBusy           = false;
let currentAudio     = null;
let recordingTimeout = null;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const micBtn      = document.getElementById("mic-btn");
const statusEl    = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");

// ─── Status helpers ───────────────────────────────────────────────────────────
function setStatus(text, cls = "idle") {
  statusEl.textContent = text;
  statusEl.className   = `status ${cls}`;
}

// ─── Transcript / Bubbles ─────────────────────────────────────────────────────
function addBubble(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `bubble ${role}`;

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = role === "user" ? "Du" : "⚡ Aven";

  const body = document.createElement("div");
  body.textContent = text;

  wrap.appendChild(label);
  wrap.appendChild(body);
  transcriptEl.appendChild(wrap);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return wrap;
}

// ─── Microphone / Recording ───────────────────────────────────────────────────
async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus("Mikrofon-Fehler", "error");
    console.error("Mic error:", err);
    return;
  }

  // Prefer webm/opus, fall back to whatever the browser supports
  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg", "audio/mp4"]
    .find(t => MediaRecorder.isTypeSupported(t)) || "";

  audioChunks   = [];
  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});

  mediaRecorder.addEventListener("dataavailable", e => {
    if (e.data.size > 0) audioChunks.push(e.data);
  });

  mediaRecorder.addEventListener("stop", async () => {
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    await handleRecording(blob);
  });

  mediaRecorder.start(100); // collect in 100ms chunks
  isRecording = true;
  isBusy      = true;
  micBtn.classList.add("recording");
  setStatus("Aufnahme läuft — nochmal tippen zum Senden", "recording");

  // Safety limit: auto-stop after MAX_RECORD_SECONDS
  recordingTimeout = setTimeout(() => stopRecording(), CONFIG.MAX_RECORD_SECONDS * 1000);
}

function stopRecording() {
  clearTimeout(recordingTimeout);
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  mediaRecorder.stop();
  isRecording = false;
  micBtn.classList.remove("recording");
  setStatus("Verarbeite...", "thinking");
}

// ─── Tap-to-Toggle handler ────────────────────────────────────────────────────
function onTap(e) {
  e.preventDefault();

  if (isBusy && !isRecording) return; // pipeline running, ignore

  if (isRecording) {
    stopRecording();   // second tap → stop + send
  } else {
    startRecording();  // first tap → start
  }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────
async function handleRecording(audioBlob) {
  try {
    // 1. STT via Whisper
    setStatus("Transkribiere...", "thinking");
    const userText = await transcribeAudio(audioBlob);
    if (!userText || !userText.trim()) {
      setStatus("Nichts gehört — nochmal tippen", "idle");
      isBusy = false;
      return;
    }

    addBubble("user", userText);

    // 2. Send to OpenClaw via server proxy
    setStatus("Aven denkt...", "thinking");
    const avenText = await sendToOpenClaw(userText);
    if (!avenText) throw new Error("Leere Antwort von OpenClaw");

    addBubble("aven", avenText);

    // 3. TTS → play
    setStatus("Aven spricht...", "speaking");
    await speakText(avenText);

    // 4. Fire-and-forget: log to Discord
    logToDiscord(userText, avenText).catch(err =>
      console.warn("Discord log failed:", err)
    );

    setStatus("Bereit — tippen zum Sprechen", "idle");
  } catch (err) {
    console.error("Pipeline error:", err);
    setStatus(`Fehler: ${err.message}`, "error");
    setTimeout(() => setStatus("Bereit — tippen zum Sprechen", "idle"), 4000);
  } finally {
    isBusy = false;
  }
}

// ─── STT: Whisper via server proxy (/api/transcribe) ───────────────────────────
// Proxying avoids any CORS / network issues from browser → OpenAI directly,
// and keeps the OpenAI key server-side. Server logs full error details.
async function transcribeAudio(blob) {
  const formData = new FormData();
  // Whisper supports webm, mp4, ogg, m4a etc.
  const ext = blob.type.includes("ogg") ? "ogg"
    : blob.type.includes("mp4") ? "mp4"
    : blob.type.includes("m4a") ? "m4a"
    : "webm";
  formData.append("file",     blob, `audio.${ext}`);
  formData.append("model",    "whisper-1");
  formData.append("language", "de");

  const res = await fetch("/api/transcribe", {
    method: "POST",
    body:   formData,
    // No Content-Type header — browser sets multipart boundary automatically
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Whisper proxy error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return data.text?.trim() || "";
}

// ─── LLM: OpenClaw via local proxy (server.js /api/chat) ─────────────────────
// Proxying avoids CORS and keeps the Gateway token server-side.
async function sendToOpenClaw(message) {
  const res = await fetch("/api/chat", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ message }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenClaw proxy error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.reply || "";
}

// ─── TTS: OpenAI (direct — CORS fine for openai.com) ─────────────────────────
async function speakText(text) {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${CONFIG.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model:           CONFIG.TTS_MODEL,
      input:           text,
      voice:           CONFIG.TTS_VOICE,
      response_format: "mp3",
    }),
  });

  if (!res.ok) throw new Error(`TTS error: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  const blob     = new Blob([arrayBuffer], { type: "audio/mpeg" });
  const audioUrl = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const audio = new Audio(audioUrl);
    currentAudio = audio;
    audio.onended = () => { URL.revokeObjectURL(audioUrl); currentAudio = null; resolve(); };
    audio.onerror = reject;
    audio.play().catch(reject);
  });
}

// ─── Discord logging via server proxy ────────────────────────────────────────
async function logToDiscord(userText, avenText) {
  if (!CONFIG.DISCORD_LOG_CHANNEL) return;

  await fetch("/api/log-discord", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      channel: CONFIG.DISCORD_LOG_CHANNEL,
      userText,
      avenText,
    }),
  });
}

// ─── Button events: Tap-to-Toggle ─────────────────────────────────────────────
// Single unified tap handler — works on iOS touch + desktop click.
// We use "click" for mouse and "touchend" for touch.
// touchend prevents the ghost-click 300ms delay on iOS.

let lastTouchEnd = 0;

micBtn.addEventListener("touchend", e => {
  e.preventDefault();
  lastTouchEnd = Date.now();
  onTap(e);
}, { passive: false });

micBtn.addEventListener("click", e => {
  // Skip if fired within 500ms of a touchend (ghost click)
  if (Date.now() - lastTouchEnd < 500) return;
  onTap(e);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
(function init() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Browser nicht unterstützt", "error");
    micBtn.disabled = true;
    return;
  }

  setStatus("Bereit — tippen zum Sprechen", "idle");

  // iOS: request mic permission on first tap (must be in user gesture context)
  // The actual getUserMedia() call in startRecording() handles this,
  // but we warm it up here to avoid first-tap delay.
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
    document.addEventListener("click", async function warmMic() {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
      } catch {}
      document.removeEventListener("click", warmMic);
    }, { once: true });
  }
})();
