'use strict';
/*
 * Proxy integration test: spin up the real server, open a genuine VLESS
 * WebSocket connection with a valid handshake, and confirm:
 *   1. the connection is accepted (UUID routed + version byte echoed),
 *   2. inbound bytes (client -> proxy -> target) are counted as DOWNLOAD,
 *      outbound echoed bytes as UPLOAD,
 *   3. a disabled user is rejected.
 * The "target" is a localhost TCP echo server we control, so we can measure
 * exactly how many bytes flow through. The user is created via the server's
 * OWN admin API, so its in-memory store is the one actually checked.
 */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

function startEcho() {
  const srv = net.createServer(sock => { sock.on('data', d => sock.write(d)); });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}

function handshake(uuidBuf, host, port) {
  const domain = Buffer.from(host, 'utf8');
  return Buffer.concat([
    Buffer.from([1]),
    uuidBuf,
    Buffer.from([0]),
    Buffer.from([1]),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    Buffer.from([2]),
    Buffer.from([domain.length]),
    domain,
  ]);
}

(async () => {
  const f = path.join(os.tmpdir(), `vless-proxy-${Date.now()}.json`);
  fs.writeFileSync(f, '[]');
  process.env.DATA_FILE = f;
  process.env.ADMIN_TOKEN = 'tok';
  process.env.PORT = '3998';
  process.env.DOMAIN = '127.0.0.1';
  process.env.BOT_TOKEN = '';
  for (const m of ['./config', './store', './admin', './proxy', './app', './handshake']) delete require.cache[require.resolve(m)];

  const echo = await startEcho();
  require('./app');
  await new Promise(r => setTimeout(r, 600));

  // Create the user through the server's API so its store is populated.
  const created = await fetch('http://127.0.0.1:3998/api/users', {
    method: 'POST',
    headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
    body: JSON.stringify({ remark: 'carol' }),
  });
  const user = await created.json();
  const uuidBuf = Buffer.from(user.uuid.replace(/-/g, ''), 'hex');

  const ws = new WebSocket('ws://127.0.0.1:3998');
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(handshake(uuidBuf, '127.0.0.1', echo.port));

  const first = await new Promise(res => ws.once('message', res));
  if (!(first instanceof Buffer) || first[0] !== 1 || first[1] !== 0) {
    console.error('FAIL: handshake not acknowledged', first);
    process.exit(1);
  }
  console.log('  ✓ proxy accepted handshake and echoed version byte');

  const payload = Buffer.alloc(1024, 0xAB);
  let got = 0;
  ws.on('message', m => { got += m.length; });
  await new Promise(res => {
    ws.send(payload);
    const check = setInterval(() => { if (got >= 1024) { clearInterval(check); res(); } }, 20);
    setTimeout(() => { clearInterval(check); res(); }, 2000);
  });
  await new Promise(r => setTimeout(r, 400)); // let accounting save

  // Read back the user via the API to confirm persisted counters.
  const info = await (await fetch('http://127.0.0.1:3998/api/users/' + user.uuid, { headers: { Authorization: 'Bearer tok' } })).json();
  console.log(`  ✓ counted up=${info.up} down=${info.down} (1024-byte echo → both >= 1024)`);
  if (info.up < 1024) { console.error('FAIL: upload not counted'); process.exit(1); }
  if (info.down < 1024) { console.error('FAIL: download not counted'); process.exit(1); }
  console.log('  ✓ traffic accounting works end-to-end');

  // Disable via API and confirm a new connection is rejected by the server.
  await fetch('http://127.0.0.1:3998/api/users/' + user.uuid, {
    method: 'PUT', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  const ws2 = new WebSocket('ws://127.0.0.1:3998');
  const rejected = await new Promise(res => {
    const to = setTimeout(() => res(false), 2000);
    ws2.on('open', () => ws2.send(handshake(uuidBuf, '127.0.0.1', echo.port)));
    ws2.on('close', () => { clearTimeout(to); res(true); });
    ws2.on('error', () => { clearTimeout(to); res(true); });
  });
  console.log(rejected ? '  ✓ disabled user connection rejected' : 'FAIL: disabled user not rejected');
  if (!rejected) process.exit(1);

  ws.close(); ws2.close(); echo.srv.close();
  fs.unlinkSync(f);
  console.log('\nPROXY INTEGRATION: ALL PASSED');
  process.exit(0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
