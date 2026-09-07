'use strict';
/*
 * Test suite — no external test framework required. Pure logic (handshake
 * parser, store accounting, expiry/quota enforcement) is exercised directly.
 * The full HTTP server is started and probed with real fetch() calls, so the
 * admin API, auth, and subscription endpoint are verified end to end.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parseHandshake, bufToUuid } = require('./handshake');
const { Store, GB, daysToExpiry, isExpired, usedBytes, remainingBytes } = require('./store');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log('  ✓ ' + name);
}

console.log('handshake parser');
{
  // Build a minimal VLESS handshake: version(1) + uuid(16) + optLen(0) + cmd(1)
  // + port(2) + addrType(1=ipv4) + 4 bytes ip + payload
  const uuid = Buffer.alloc(16, 7);
  const buf = Buffer.concat([
    Buffer.from([1]),                 // version
    uuid,                             // id
    Buffer.from([0]),                 // optLen
    Buffer.from([1]),                 // command (1 = TCP)
    Buffer.from([0x1b, 0x39]),        // port 6969
    Buffer.from([1]),                 // addr type IPv4
    Buffer.from([1, 2, 3, 4]),        // 1.2.3.4
    Buffer.from('hello world'),       // payload
  ]);
  const hs = parseHandshake(buf);
  ok('version parsed', hs.version === 1);
  ok('uuid parsed', hs.id.equals(uuid));
  ok('command parsed', hs.command === 1);
  ok('port parsed', hs.port === 6969);
  ok('host parsed (ipv4)', hs.host === '1.2.3.4');
  ok('offset points past header', hs.offset === buf.length - 'hello world'.length);
  ok('uuid->string', bufToUuid(uuid) === '07070707-0707-0707-0707-070707070707');

  // DOMAIN address type
  const buf2 = Buffer.concat([
    Buffer.from([1]), uuid, Buffer.from([0]), Buffer.from([1]),
    Buffer.from([0x00, 0x50]), // port 80
    Buffer.from([2]),          // addr type DOMAIN
    Buffer.from([11]),         // len
    Buffer.from('example.com'),
  ]);
  const hs2 = parseHandshake(buf2);
  ok('domain host parsed', hs2.host === 'example.com');
  ok('domain port parsed', hs2.port === 80);
  assert.throws(() => parseHandshake(Buffer.from([1])), /truncated handshake/);
  ok('truncated handshake rejected', true);
  const udp = Buffer.from(buf);
  udp[18] = 2;
  assert.throws(() => parseHandshake(udp), /unsupported command/);
  ok('non-TCP command rejected', true);
}

console.log('store: create / read / accounting');
{
  const f = path.join(os.tmpdir(), `vless-test-${Date.now()}.json`);
  const s = new Store(f);
  const u = s.create({ remark: 'alice', dataLimit: 1 * GB, expiry: Date.now() + 86400000 });
  ok('create returns uuid', /^[0-9a-f-]{36}$/.test(u.uuid));
  ok('find by remark', s.find('alice').uuid === u.uuid);
  ok('canConnect ok', s.canConnect(u.uuid).ok === true);
  s.addTraffic(u.uuid, 'up', 100);
  s.addTraffic(u.uuid, 'down', 200);
  const got = s.get(u.uuid);
  ok('up counted', got.up === 100);
  ok('down counted', got.down === 200);
  ok('total = up+down', usedBytes(got) === 300);
  ok('remaining decreases', remainingBytes(got) === 1 * GB - 300);
  s.update(u.uuid, { enabled: false });
  ok('disabled blocks connect', s.canConnect(u.uuid).reason === 'disabled');
  s.update(u.uuid, { enabled: true });
  s.update(u.uuid, { expiry: Date.now() - 1000 });
  ok('expired blocks connect', s.canConnect(u.uuid).reason === 'expired');
  ok('isExpired true', isExpired(s.get(u.uuid)) === true);
  s.update(u.uuid, { expiry: 0 });
  s.update(u.uuid, { dataLimit: 250 });
  ok('quota exceeded blocks connect', s.canConnect(u.uuid).reason === 'quota_exceeded');
  s.resetTraffic(u.uuid);
  ok('reset zeroes counters', s.get(u.uuid).up === 0 && s.get(u.uuid).down === 0);
  ok('can delete', s.remove(u.uuid) === true);
  s.flush();
  fs.unlinkSync(f);
}

console.log('HTTP server: auth + users + subscription');
(async () => {
  // Point config at a temp data file via env before requiring app modules.
  const f = path.join(os.tmpdir(), `vless-http-${Date.now()}.json`);
  fs.writeFileSync(f, '[]');
  process.env.DATA_FILE = f;
  process.env.ADMIN_TOKEN = 'test-token';
  process.env.PORT = '3999';
  process.env.DOMAIN = 'test.example.com';
  process.env.WEB_PANEL = 'on';
  process.env.BOT_TOKEN = '';   // disable telegram

  // Require fresh module instances (config reads env at load).
  delete require.cache[require.resolve('./config')];
  delete require.cache[require.resolve('./store')];
  delete require.cache[require.resolve('./admin')];
  delete require.cache[require.resolve('./proxy')];
  delete require.cache[require.resolve('./app')];
  delete require.cache[require.resolve('./handshake')];

  require('./app');
  const base = 'http://127.0.0.1:3999';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const retry = async (fn, n = 40) => {
    for (let i = 0; i < n; i++) {
      try { return await fn(); } catch (e) { await wait(100); }
    }
    throw new Error('server did not start');
  };

  await retry(async () => { const r = await fetch(base + '/api/users', { headers: { Authorization: 'Bearer test-token' } }); if (!r.ok) throw new Error('not up'); });

  const noauth = await fetch(base + '/api/users');
  ok('api rejects missing token', noauth.status === 401);
  const queryAuth = await fetch(base + '/api/users?token=test-token');
  ok('api rejects URL token', queryAuth.status === 401);

  const created = await fetch(base + '/api/users', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ remark: 'bob', expiryDays: 30, dataLimitGB: 5 }),
  });
  ok('create user 201', created.status === 201);
  const bob = await created.json();
  ok('created user has vless link', bob.vless.startsWith('vless://'));
  ok('dataLimitGB serialized', bob.dataLimitGB === 5);

  const invalid = await fetch(base + '/api/users', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataLimitGB: -1 }),
  });
  ok('negative quota rejected', invalid.status === 400);

  const list = await (await fetch(base + '/api/users', { headers: { Authorization: 'Bearer test-token' } })).json();
  ok('list returns 1 user', list.length === 1);

  const info = await (await fetch(base + '/api/users/' + bob.uuid, { headers: { Authorization: 'Bearer test-token' } })).json();
  ok('get single user', info.uuid === bob.uuid);

  const upd = await (await fetch(base + '/api/users/' + bob.uuid, {
    method: 'PUT', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  })).json();
  ok('update disables', upd.enabled === false);

  const sub = await fetch(base + '/sub/' + bob.uuid);
  ok('subscription endpoint 200', sub.status === 200);
  const subText = Buffer.from(await sub.text(), 'base64').toString();
  ok('subscription decodes to vless link', subText.startsWith('vless://') && subText.includes(bob.uuid.replace(/-/g, '')));

  const panel = await fetch(base + '/panel');
  ok('panel page served', panel.status === 200 && (await panel.text()).includes('nodejs-vless'));

  const stats = await (await fetch(base + '/api/stats', { headers: { Authorization: 'Bearer test-token' } })).json();
  ok('stats counts users', stats.users === 1);
  ok('stats does not expose token', !Object.hasOwn(stats, 'adminToken'));

  const del = await fetch(base + '/api/users/' + bob.uuid, { method: 'DELETE', headers: { Authorization: 'Bearer test-token' } });
  ok('delete user', del.status === 200);

  fs.unlinkSync(f);
  process.exit(0);
})();
