// Simple static server for local development / Mac Mini hosting
// Usage: node server.js
// Or with env: PORT=8080 node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const PORT = process.env.PORT || 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

const server = http.createServer((req, res) => {
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
