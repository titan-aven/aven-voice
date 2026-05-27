// Aven Voice — static + API proxy server
// Usage: node server.js  |  PORT=8081 node server.js
//
// All OpenClaw gateway calls are proxied server-side to avoid CORS
// and keep credentials out of the browser.

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const PORT  = process.env.PORT || 8081;

// ─── Load local config for server-side credentials ───────────────────────────
let LOCAL_CONFIG = {};
try {
  // config.local.js: const LOCAL_CONFIG = { ... };
  // Patch const→var so Function() can return it
  const raw     = fs.readFileSync(path.join(__dirname, "config.local.js"), "utf8");
  const patched = raw.replace("const LOCAL_CONFIG", "var ___cfg");
  // eslint-disable-next-line no-new-func
  LOCAL_CONFIG = new Function(patched + "; return ___cfg;")();
  console.log("[server] config.local.js loaded, token:", LOCAL_CONFIG.OPENCLAW_TOKEN ? "present" : "MISSING");
} catch (e) {
  console.warn("[server] Could not load config.local.js:", e.message);
}

// Always talk to Gateway on loopback — Tailscale TLS is only for browser→server
const GATEWAY_URL     = "http://localhost:18789";
const OPENCLAW_TOKEN  = LOCAL_CONFIG.OPENCLAW_TOKEN  || process.env.OPENCLAW_TOKEN  || "";
const OPENCLAW_SESSION = LOCAL_CONFIG.OPENCLAW_SESSION || "main";

// ─── Helper: read JSON request body ──────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => { buf += c; });
    req.on("end",  () => { try { resolve(JSON.parse(buf || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// ─── Helper: POST to OpenClaw Gateway (server → loopback, no CORS) ───────────
function gatewayPost(endpointPath, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: "127.0.0.1",
      port:     18789,
      path:     endpointPath,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization":  `Bearer ${OPENCLAW_TOKEN}`,
        ...extraHeaders,
      },
    };
    const req = http.request(options, res => {
      let data = "";
      res.on("data", d => { data += d; });
      res.on("end",  () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Static file MIME ────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // ── POST /api/chat → proxy to OpenClaw /v1/chat/completions ──────────────
  if (req.method === "POST" && req.url === "/api/chat") {
    try {
      const { message } = await readBody(req);
      if (!message) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing message" }));
        return;
      }

      const result = await gatewayPost("/v1/chat/completions", {
        model:    `openclaw/${OPENCLAW_SESSION}`,
        messages: [{ role: "user", content: message }],
      }, {
        "x-openclaw-session-key": OPENCLAW_SESSION,
      });

      if (result.status !== 200) {
        console.error(`[chat] Gateway error ${result.status}:`, result.body.substring(0, 200));
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Gateway returned ${result.status}`, detail: result.body }));
        return;
      }

      const data  = JSON.parse(result.body);
      const reply = data.choices?.[0]?.message?.content?.trim() || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reply }));
    } catch (err) {
      console.error("[chat] Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── POST /api/log-discord → forward voice log to Discord via Gateway ──────
  if (req.method === "POST" && req.url === "/api/log-discord") {
    try {
      const { channel, userText, avenText } = await readBody(req);
      if (!userText || !avenText) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing fields" }));
        return;
      }

      // Target the #aven-voice Discord channel session directly
      const logMsg = `🎤 **Du:** ${userText}\n⚡ **Aven:** ${avenText}`;
      const result = await gatewayPost("/v1/chat/completions", {
        model:    "openclaw/main",
        messages: [{ role: "user", content: logMsg }],
      }, {
        // Route to the voice channel session so it appears in Discord
        "x-openclaw-session-key": `agent:main:discord:channel:${channel || "1508947511099003051"}`,
      });

      console.log(`[discord-log] Gateway ${result.status}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: result.status }));
    } catch (err) {
      console.error("[discord-log] Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url);

  // config.local.js → serve only if it exists (gitignored)
  if (req.url === "/config.local.js") {
    const local = path.join(__dirname, "config.local.js");
    if (!fs.existsSync(local)) { res.writeHead(404); res.end("Not found"); return; }
    filePath = local;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type":  MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Aven Voice running on http://localhost:${PORT}`);
});
