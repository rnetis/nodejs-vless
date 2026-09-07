'use strict';
/*
 * Entry point. Spins up one HTTP(S) server that hosts:
 *   - the VLESS WebSocket proxy (per-user UUID routing + accounting)
 *   - the admin REST API + web panel + subscription endpoint
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

function main() {
  async function requestHandler(req, res) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;

    // Root welcome page.
    if (pathname === '/') {
      const html = `<h3>nodejs-vless panel</h3>
        <p>Admin panel: <a href="/panel">/panel</a></p>
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

  attachProxy(server, store);
  startTelegram(store);

  server.listen(config.port, config.host, () => {
    const scheme = config.tls.enabled ? 'https' : 'http';
    console.log(`[nodejs-vless] listening on ${scheme}://${config.host}:${config.port}`);
    console.log('[nodejs-vless] admin token is configured (use the Authorization header in the panel).');
    console.log(`[nodejs-vless] panel:        ${scheme}://${config.domain}:${config.port}/panel`);
  });

  const shutdown = () => { store.flush(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
