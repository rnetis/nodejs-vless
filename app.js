'use strict';
/*
 * Entry point. Spins up one HTTP(S) server that hosts:
 *   - the VLESS WebSocket proxy (per-user UUID routing + accounting)
 *   - the admin REST API + web panel + subscription endpoint
 *   - (optional) the legacy web-shell runner
 *   - (optional) the Telegram bot
 *
 * TLS is used automatically when TLS_CERT/TLS_KEY are provided.
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const { config, resolveAdminToken } = require('./config');
const { Store } = require('./store');
const { attachProxy } = require('./proxy');
const { createAdminApi } = require('./admin');
const { start: startTelegram } = require('./telegram');

const store = new Store();
const adminToken = resolveAdminToken();
const admin = createAdminApi(store);

// Legacy web-shell (kept for compatibility, off by default).
function mountShell(server) {
  if (!config.webShell) return;
  const { exec } = require('child_process');
  const crypto = require('crypto');
  const path = require('path');
  server.on('request', (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (!u.pathname.endsWith('/run') || req.method !== 'POST') return;
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.socket.destroy(); });
    req.on('end', () => {
      const f = path.join(__dirname, `wsr-${crypto.randomBytes(4).toString('hex')}.sh`);
      fs.writeFile(f, body, { mode: 0o755 }, err => {
        if (err) { res.writeHead(500); return res.end('write error'); }
        exec(`sh "${f}"`, { timeout: 10000 }, (e, out, err2) => {
          fs.unlink(f, () => {});
          if (e) { res.writeHead(500); return res.end(err2); }
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(out);
        });
      });
    });
  });
}

function main() {
  async function requestHandler(req, res) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;

    // Root welcome page.
    if (pathname === '/') {
      const html = `<h3>nodejs-vless panel</h3>
        <p>Admin panel: <a href="/panel">/panel</a> (token: <code>${adminToken}</code>)</p>
        <p>GitHub: <a href="https://github.com/vevc/nodejs-vless" target="_blank">vevc/nodejs-vless</a></p>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }

    // Admin API + web panel + subscription.
    let handled = false;
    try {
      handled = await admin.handle(req, res, parsedUrl);
    } catch (e) {
      console.error('[app] admin.handle error on', pathname, e.message);
    }
    if (handled) return;
    if (res.headersSent) { console.error('[app] response already sent for', pathname); return; }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  const server = config.tls.enabled
    ? https.createServer({ cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) }, requestHandler)
    : http.createServer(requestHandler);

  mountShell(server);

  attachProxy(server, store);
  startTelegram(store);

  server.listen(config.port, config.host, () => {
    const scheme = config.tls.enabled ? 'https' : 'http';
    console.log(`[nodejs-vless] listening on ${scheme}://${config.host}:${config.port}`);
    console.log(`[nodejs-vless] admin token: ${adminToken}`);
    console.log(`[nodejs-vless] panel:        ${scheme}://${config.domain}:${config.port}/panel?token=${adminToken}`);
  });

  const shutdown = () => { store.flush(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
