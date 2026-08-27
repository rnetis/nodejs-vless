'use strict';
/*
 * Central configuration. All values come from environment variables so the
 * service stays 12-factor and easy to deploy. Sensible defaults are provided.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function env(name, def) {
  const v = process.env[name];
  return (v === undefined || v === '') ? def : v;
}

const config = {
  host: env('HOST', '0.0.0.0'),
  port: parseInt(env('PORT', '3000'), 10),
  domain: env('DOMAIN', 'example.com'),
  remarks: env('REMARKS', 'nodejs-vless'),
  // WebSocket path advertised inside the generated vless:// links.
  path: env('VLESS_PATH', '/'),
  // Where the user database is persisted (JSON file).
  dataFile: env('DATA_FILE', path.join(__dirname, 'data', 'users.json')),
  // Master token protecting the admin API + web panel. Empty => auto-generated
  // and persisted to <dataDir>/admin.token on first run.
  adminToken: env('ADMIN_TOKEN', ''),
  webPanel: env('WEB_PANEL', 'on') !== 'off',
  // Legacy "run shell" feature. Off by default for security.
  webShell: env('WEB_SHELL', 'off') === 'on',
  verbose: env('VERBOSE', 'off') === 'on',
  tls: {
    enabled: env('TLS', 'off') === 'on' || !!env('TLS_CERT'),
    cert: env('TLS_CERT', ''),
    key: env('TLS_KEY', ''),
  },
  telegram: {
    botToken: env('BOT_TOKEN', ''),
    // Comma separated list of chat ids allowed to control the bot.
    adminIds: env('ADMIN_TELEGRAM_ID', '').split(',').map(s => s.trim()).filter(Boolean),
    pollInterval: parseInt(env('TG_POLL', '1500'), 10),
  },
};

// Resolve / persist the admin token so it is stable across restarts.
function resolveAdminToken() {
  if (config.adminToken && config.adminToken !== '') return config.adminToken;
  const dir = path.dirname(config.dataFile);
  const tokFile = path.join(dir, 'admin.token');
  try {
    const existing = fs.readFileSync(tokFile, 'utf8').trim();
    if (existing) { config.adminToken = existing; return existing; }
  } catch (_) { /* not generated yet */ }
  const t = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tokFile, t);
  } catch (_) { /* best effort */ }
  config.adminToken = t;
  return t;
}

module.exports = { config, env, resolveAdminToken };
