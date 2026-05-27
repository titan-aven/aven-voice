// Simple static server for local development / Mac Mini hosting
// Usage: node server.js
// Or with env: PORT=8080 node server.js

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const PORT = process.env.PORT || 8080;

// ─── Load local config for server-side credentials ───────────────────────────
let LOCAL_CONFIG = {};
try {
  // config.local.js uses: const LOCAL_CONFIG = { ... };
  // Patch const → var so Function() can capture it across block scope
  const raw = fs.readFileSync(path.join(__dirname, "config.local.js"), "utf8");
  const patched = raw.replace("const LOCAL_CONFIG", "var ___cfg");
  // eslint-disable-next-line no-new-func
  LOCAL_CONFIG = new Function(patched + "; return ___cfg;")();
} catch (e) {
  console.warn("[server] Could not load config.local.js:", e.message);
}

const OPENCLAW_URL    = LOCAL_CONFIG.OPENCLAW_URL    || process.env.OPENCLAW_URL    || "http://localhost:18789";
const OPENCLAW_TOKEN  = LOCAL_CONFIG.OPENCLAW_TOKEN  || process.env.OPENCLAW_TOKEN  || "";
const OPENCLAW_SESSION = LOCAL_CONFIG.OPENCLAW_SESSION || "main";

// ─── Helper: parse JSON body ──────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ─── Helper: HTTPS/HTTP POST to OpenClaw Gateway ─────────────────────────────
function gatewayPost(urlStr, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(urlStr);
    const lib = url.protocol === "https:" ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": `Bearer ${OPENCLAW_TOKEN}`,
        "x-openclaw-session-key": "agent:main:discord:channel:1508947511099003051",
      },
      // Allow self-signed cert on Tailscale internal hosts
      rejectUnauthorized: false,
    };
    const req = lib.request(options, res => {
      let data = "";
      res.on("data", d => { data += d; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  // ─── API: Discord logging proxy ─────────────────────────────────────────
  if (req.method === "POST" && req.url === "/api/log-discord") {
    try {
      const { channel, userText, avenText } = await readBody(req);
      if (!channel || !userText || !avenText) {
        res.writeHead(400); res.end(JSON.stringify({ error: "Missing fields" }));
        return;
      }

      // Use chat completions to send a message TO the Discord channel session
      // by targeting the Aven voice channel session with a log message
      const text = `🎤 **Du:** ${userText}\n⚡ **Aven:** ${avenText}`;

      // Gateway localhost is always HTTP (Tailscale proxy terminates TLS externally)
      const gatewayLocal = "http://localhost:18789";
      const result = await gatewayPost(`${gatewayLocal}/v1/chat/completions`, {
        model: "openclaw/main",
        messages: [{ role: "user", content: `[Voice Log — sende diese Nachricht als kurze Zusammenfassung im Discord-Channel #aven-voice: ${text}]` }],
      });

      console.log(`[discord-log] Gateway response ${result.status}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, gatewayStatus: result.status }));
    } catch (err) {
      console.error("[discord-log] Error:", err.message);
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── Static file serving ─────────────────────────────────────────────────
  let filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url);

  // Serve config.local.js if it exists, otherwise config.js
  if (req.url === "/config.local.js") {
    const local = path.join(__dirname, "config.local.js");
    if (!fs.existsSync(local)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    filePath = local;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // HTTPS required for mic on iOS — use Tailscale + a reverse proxy or ngrok for dev
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Aven Voice running on http://localhost:${PORT}`);
});
