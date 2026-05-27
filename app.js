// Aven Voice — main app logic
// Pipeline: MediaRecorder → Whisper STT → OpenClaw API → OpenAI TTS → Audio playback
// Parallel: Discord channel logging

"use strict";

// ─── State ───────────────────────────────────────────────────────────────────
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let isBusy = false;
let currentAudio = null;
let recordingTimeout = null;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const micBtn = document.getElementById("mic-btn");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");

// ─── Status helpers ───────────────────────────────────────────────────────────
function setStatus(text, cls = "idle") {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
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
  if (isBusy) return;

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

  audioChunks = [];
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
  isBusy = true;
  micBtn.classList.add("recording");
  setStatus("Aufnahme...", "recording");

  // Safety limit
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

// ─── Main pipeline ────────────────────────────────────────────────────────────
async function handleRecording(audioBlob) {
  try {
    // 1. STT via Whisper
    const userText = await transcribeAudio(audioBlob);
    if (!userText || !userText.trim()) {
      setStatus("Bereit", "idle");
      isBusy = false;
      return;
    }

    addBubble("user", userText);

    // 2. Send to OpenClaw
    setStatus("Aven denkt...", "thinking");
    const avenText = await sendToOpenClaw(userText);
    if (!avenText) throw new Error("Leere Antwort von OpenClaw");

    addBubble("aven", avenText);

    // 3. TTS → play
    setStatus("Aven spricht...", "speaking");
    await speakText(avenText);

    // 4. Parallel: log to Discord
    logToDiscord(userText, avenText).catch(err =>
      console.warn("Discord log failed:", err)
    );

    setStatus("Bereit", "idle");
  } catch (err) {
    console.error("Pipeline error:", err);
    setStatus("Fehler", "error");
    setTimeout(() => setStatus("Bereit", "idle"), 3000);
  } finally {
    isBusy = false;
  }
}

// ─── STT: Whisper ─────────────────────────────────────────────────────────────
async function transcribeAudio(blob) {
  const formData = new FormData();
  // Whisper prefers .webm or .mp4 — use the actual mime to set extension
  const ext = blob.type.includes("ogg") ? "ogg"
    : blob.type.includes("mp4") ? "mp4"
    : "webm";
  formData.append("file", blob, `audio.${ext}`);
  formData.append("model", "whisper-1");
  formData.append("language", "de");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}` },
    body: formData,
  });

  if (!res.ok) throw new Error(`Whisper error: ${res.status}`);
  const data = await res.json();
  return data.text?.trim() || "";
}

// ─── LLM: OpenClaw API ────────────────────────────────────────────────────────
async function sendToOpenClaw(message) {
  // OpenAI-compatible Chat Completions endpoint exposed by OpenClaw Gateway
  // model: "openclaw/main" → routes to Aven's main session
  // x-openclaw-session-key: persists the conversation in Aven's main session
  const url = `${CONFIG.OPENCLAW_URL}/v1/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CONFIG.OPENCLAW_TOKEN}`,
      "x-openclaw-session-key": CONFIG.OPENCLAW_SESSION,
    },
    body: JSON.stringify({
      model: `openclaw/${CONFIG.OPENCLAW_SESSION}`,
      messages: [{ role: "user", content: message }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenClaw error ${res.status}: ${body}`);
  }

  const data = await res.json();
  // OpenAI-compatible response shape
  return data.choices?.[0]?.message?.content?.trim() || JSON.stringify(data);
}

// ─── TTS: OpenAI ──────────────────────────────────────────────────────────────
async function speakText(text) {
  // Interrupt previous audio if still playing
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: CONFIG.TTS_MODEL,
      input: text,
      voice: CONFIG.TTS_VOICE,
      response_format: "mp3",
    }),
  });

  if (!res.ok) throw new Error(`TTS error: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
  const audioUrl = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const audio = new Audio(audioUrl);
    currentAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
      resolve();
    };
    audio.onerror = reject;
    audio.play().catch(reject);
  });
}

// ─── Discord logging ──────────────────────────────────────────────────────────
async function logToDiscord(userText, avenText) {
  if (!CONFIG.DISCORD_LOG_CHANNEL) return;

  // Route through local server proxy (/api/log-discord) to avoid CORS
  // and keep the OpenClaw gateway token server-side
  await fetch("/api/log-discord", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: CONFIG.DISCORD_LOG_CHANNEL,
      userText,
      avenText,
    }),
  });
}

// ─── Button events (touch + mouse) ────────────────────────────────────────────
function onPressStart(e) {
  e.preventDefault();
  if (!isBusy) startRecording();
}

function onPressEnd(e) {
  e.preventDefault();
  if (isRecording) stopRecording();
}

micBtn.addEventListener("mousedown", onPressStart);
micBtn.addEventListener("mouseup", onPressEnd);
micBtn.addEventListener("mouseleave", onPressEnd);
micBtn.addEventListener("touchstart", onPressStart, { passive: false });
micBtn.addEventListener("touchend", onPressEnd, { passive: false });
micBtn.addEventListener("touchcancel", onPressEnd, { passive: false });

// ─── Init ─────────────────────────────────────────────────────────────────────
(function init() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Browser nicht unterstützt", "error");
    micBtn.disabled = true;
  }

  // Request mic permission early on iOS
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
    document.addEventListener("click", async function requestMic() {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
      } catch {}
      document.removeEventListener("click", requestMic);
    }, { once: true });
  }
})();
