'use strict';
/*
 * Admin REST API + subscription endpoint + web panel.
 *
 * Routes (all protected by ADMIN_TOKEN unless noted):
 *   GET  /panel                         -> web UI (HTML)
 *   GET  /api/stats                     -> aggregate stats
 *   GET  /api/users                     -> list users
 *   POST /api/users                     -> create user
 *   GET  /api/users/:uuid               -> get user
 *   PUT  /api/users/:uuid               -> update user
 *   DEL  /api/users/:uuid               -> delete user
 *   POST /api/users/:uuid/reset         -> reset traffic
 *   GET  /sub/:uuid                     -> subscription (base64 vless link)
 *
 * Auth: `Authorization: Bearer <token>` header only.
 */
const { config } = require('./config');
const crypto = require('crypto');
const { GB, daysToExpiry, isExpired, usedBytes, remainingBytes } = require('./store');

function jres(res, code, obj) {
  const body = JSON.stringify(obj);
  secureHeaders(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function secureHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) req.socket.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function authed(req, parsedUrl) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const provided = Buffer.from(m[1].trim());
  const expected = Buffer.from(config.adminToken);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function numberInRange(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validateUserInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
  if ('remark' in body && (typeof body.remark !== 'string' || body.remark.length > 256)) throw new Error('remark must be a string up to 256 characters');
  if ('enabled' in body && typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean');
  for (const key of ['expiry', 'expiryDays', 'dataLimit', 'dataLimitGB']) {
    if (key in body && !numberInRange(body[key])) throw new Error(`${key} must be a non-negative finite number`);
  }
}

/** Build a vless:// subscription link for a user (uses undashed hex UUID, as present in the wire handshake). */
function buildVlessLink(user) {
  const domain = config.domain;
  const p = encodeURIComponent(config.path || '/');
  const sni = domain;
  const host = domain;
  const uuidHex = String(user.uuid).replace(/-/g, '');
  const remark = encodeURIComponent(user.remark || config.remarks);
  return `vless://${uuidHex}@${domain}:443` +
    `?encryption=none&security=tls&sni=${sni}&fp=chrome&type=ws` +
    `&host=${host}&path=${p}#${remark}`;
}

function publicUser(u) {
  return {
    uuid: u.uuid,
    remark: u.remark,
    enabled: u.enabled,
    expiry: u.expiry,
    expiryInDays: daysToExpiry(u),
    expired: isExpired(u),
    dataLimit: u.dataLimit,
    dataLimitGB: u.dataLimit ? +(u.dataLimit / GB).toFixed(3) : 0,
    up: u.up,
    down: u.down,
    total: u.total,
    used: usedBytes(u),
    remaining: remainingBytes(u),
    lastSeen: u.lastSeen,
    created: u.created,
    vless: buildVlessLink(u),
  };
}

const PANEL_HTML = require('fs').readFileSync(require('path').join(__dirname, 'panel.html'), 'utf8');

function createAdminApi(store) {
  async function handle(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname;

    // Web panel (no auth needed to load the page; API calls require token).
    if (config.webPanel && (pathname === '/panel' || pathname === '/panel/')) {
      secureHeaders(res);
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PANEL_HTML);
      return true;
    }

    // Subscription endpoint (client-facing; addressed by UUID, not token).
    const subMatch = pathname.match(/^\/sub\/([0-9a-f-]{32,36})$/i);
    if (subMatch) {
      const u = store.get(subMatch[1]);
      if (!u) { res.writeHead(404); res.end('not found'); return true; }
      const link = buildVlessLink(u);
      secureHeaders(res);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(Buffer.from(link).toString('base64'));
      return true;
    }

    // API prefix
    if (!pathname.startsWith('/api/')) return false;

    if (!authed(req, parsedUrl)) {
      jres(res, 401, { error: 'unauthorized' });
      return true;
    }

    try {
      if (pathname === '/api/stats' && req.method === 'GET') {
        const all = store.list();
        let up = 0, down = 0, active = 0;
        for (const u of all) { up += u.up; down += u.down; if (u.lastSeen && Date.now() - u.lastSeen < 60000) active++; }
        jres(res, 200, {
          users: all.length,
          active,
          totalUp: up,
          totalDown: down,
          totalTraffic: up + down,
          domain: config.domain,
        });
        return true;
      }

      if (pathname === '/api/users' && req.method === 'GET') {
        jres(res, 200, store.list().map(publicUser));
        return true;
      }

      if (pathname === '/api/users' && req.method === 'POST') {
        const b = await readBody(req);
        validateUserInput(b);
        const opts = {
          remark: b.remark || '',
          enabled: b.enabled !== false,
          expiry: b.expiryDays ? Date.now() + b.expiryDays * 86400000 : (b.expiry || 0),
          dataLimit: b.dataLimitGB ? Math.round(b.dataLimitGB * GB) : (b.dataLimit || 0),
        };
        const u = store.create(opts);
        jres(res, 201, publicUser(u));
        return true;
      }

      const um = pathname.match(/^\/api\/users\/([0-9a-f-]{32,36})$/i);
      if (um) {
        const uuid = um[1];
        if (req.method === 'GET') {
          const u = store.get(uuid);
          if (!u) { jres(res, 404, { error: 'not found' }); return true; }
          jres(res, 200, publicUser(u)); return true;
        }
        if (req.method === 'PUT' || req.method === 'PATCH') {
          const b = await readBody(req);
          validateUserInput(b);
          const patch = {};
          if ('remark' in b) patch.remark = b.remark;
          if ('enabled' in b) patch.enabled = b.enabled;
          if ('dataLimitGB' in b) patch.dataLimit = Math.round(b.dataLimitGB * GB);
          else if ('dataLimit' in b) patch.dataLimit = b.dataLimit;
          if ('expiryDays' in b) patch.expiry = b.expiryDays ? Date.now() + b.expiryDays * 86400000 : 0;
          else if ('expiry' in b) patch.expiry = b.expiry;
          const u = store.update(uuid, patch);
          if (!u) { jres(res, 404, { error: 'not found' }); return true; }
          jres(res, 200, publicUser(u)); return true;
        }
        if (req.method === 'DELETE') {
          const ok = store.remove(uuid);
          jres(res, ok ? 200 : 404, { ok }); return true;
        }
        jres(res, 405, { error: 'method not allowed' });
        return true;
      }

      const rm = pathname.match(/^\/api\/users\/([0-9a-f-]{32,36})\/reset$/i);
      if (rm && req.method === 'POST') {
        const u = store.resetTraffic(rm[1]);
        if (!u) { jres(res, 404, { error: 'not found' }); return true; }
        jres(res, 200, publicUser(u)); return true;
      }

      jres(res, 404, { error: 'not found' });
      return true;
    } catch (e) {
      jres(res, 400, { error: e.message });
      return true;
    }
  }

  return { handle, buildVlessLink };
}

module.exports = { createAdminApi, buildVlessLink, publicUser };
