'use strict';
/*
 * User data store. Persists a JSON file with one entry per client (UUID).
 * Tracks: traffic usage (up/down bytes), expiry timestamp, data cap (bytes),
 * enabled flag, remark, and per-user inbound statistics.
 *
 * The store is intentionally dependency-free so it can be unit tested in
 * isolation. Writes are debounced to avoid thrashing disk on busy links.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');

const GB = 1024 * 1024 * 1024;

function nowMs() { return Date.now(); }

function emptyUser(uuid, opts = {}) {
  const t = nowMs();
  return {
    uuid,
    remark: opts.remark || '',
    enabled: opts.enabled !== false,
    // Expiry as epoch ms. 0 / undefined => no expiry.
    expiry: typeof opts.expiry === 'number' ? opts.expiry : 0,
    // Data cap in bytes. 0 => unlimited.
    dataLimit: opts.dataLimit || 0,
    up: 0,
    down: 0,
    total: 0,            // up + down snapshot
    created: t,
    lastSeen: 0,
  };
}

class Store {
  constructor(dataFile) {
    this.file = dataFile || config.dataFile;
    this.users = new Map();   // uuid -> user object
    this._saveTimer = null;
    this._loading = false;
    this._load();
  }

  _load() {
    this._loading = true;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const u of arr) {
          // Users are stored with a dashed UUID, while all lookups (including
          // VLESS handshakes) use the undashed wire form.  Always use the
          // normalized form as the Map key after a restart as well.
          if (!u || typeof u.uuid !== 'string') continue;
          const key = this._norm(u.uuid);
          if (!/^[0-9a-f]{32}$/.test(key)) continue;
          this.users.set(key, u);
        }
      }
    } catch (_) { /* fresh start */ }
    this._loading = false;
  }

  /** Normalize any UUID form (dashed or undashed hex) to 32-char hex. */
  _norm(uuid) {
    return String(uuid).replace(/-/g, '').toLowerCase();
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, 1000);
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const arr = Array.from(this.users.values());
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }

  /** Force a synchronous save (used on shutdown). */
  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._save();
  }

  list() { return Array.from(this.users.values()); }

  get(uuid) { return this.users.get(this._norm(uuid)); }

  getByUuid(uuid) { return this.get(uuid); }

  /** Find by remark (case-insensitive). */
  find(remark) {
    const q = String(remark).toLowerCase();
    for (const u of this.users.values()) {
      if (u.remark && u.remark.toLowerCase() === q) return u;
    }
    return null;
  }

  create(opts = {}) {
    const uuid = opts.uuid || crypto.randomUUID(); // canonical dashed form
    const key = this._norm(uuid);                  // undashed hex used as Map key
    if (this.users.has(key)) throw new Error('uuid already exists');
    const u = emptyUser(uuid, opts);
    this.users.set(key, u);
    this._scheduleSave();
    return u;
  }

  remove(uuid) {
    const ok = this.users.delete(this._norm(uuid));
    if (ok) this._scheduleSave();
    return ok;
  }

  update(uuid, patch) {
    const u = this.get(uuid);
    if (!u) return null;
    if ('remark' in patch) u.remark = patch.remark;
    if ('enabled' in patch) u.enabled = !!patch.enabled;
    if ('expiry' in patch) u.expiry = patch.expiry;
    if ('dataLimit' in patch) u.dataLimit = patch.dataLimit;
    this._scheduleSave();
    return u;
  }

  /**
   * Add transferred bytes for a user. `dir` is 'up' | 'down'.
   * Returns the updated user or null if unknown.
   */
  addTraffic(uuid, dir, bytes) {
    const u = this.get(uuid);
    if (!u) return null;
    if (dir === 'up') u.up += bytes;
    else u.down += bytes;
    u.total = u.up + u.down;
    u.lastSeen = nowMs();
    this._scheduleSave();
    return u;
  }

  /**
   * Determine whether a user may open a new connection right now.
   * @returns {{ok:boolean, reason?:string, user?:object}}
   */
  canConnect(uuid) {
    const u = this.get(uuid);
    if (!u) return { ok: false, reason: 'unknown_uuid' };
    if (!u.enabled) return { ok: false, reason: 'disabled', user: u };
    if (u.expiry && nowMs() > u.expiry) return { ok: false, reason: 'expired', user: u };
    if (u.dataLimit && (u.up + u.down) >= u.dataLimit) {
      return { ok: false, reason: 'quota_exceeded', user: u };
    }
    return { ok: true, user: u };
  }

  /** Reset traffic counters (e.g. monthly reset). */
  resetTraffic(uuid) {
    const u = this.get(uuid);
    if (!u) return null;
    u.up = 0; u.down = 0; u.total = 0;
    this._scheduleSave();
    return u;
  }
}

// Convenience helpers for callers building subscription links.
function daysToExpiry(u) {
  if (!u.expiry) return null;
  return Math.max(0, Math.ceil((u.expiry - nowMs()) / 86400000));
}

function isExpired(u) {
  return !!(u.expiry && nowMs() > u.expiry);
}

function usedBytes(u) {
  return u.up + u.down;
}

function remainingBytes(u) {
  if (!u.dataLimit) return null;
  return Math.max(0, u.dataLimit - (u.up + u.down));
}

module.exports = {
  Store, GB, nowMs,
  daysToExpiry, isExpired, usedBytes, remainingBytes,
};
