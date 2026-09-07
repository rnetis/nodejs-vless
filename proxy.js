'use strict';
/*
 * VLESS proxy engine. Attaches a WebSocketServer to the shared HTTP server and
 * routes each client by UUID. Per-connection traffic (up/down bytes) is
 * accounted against the user record, and connections are torn down the moment a
 * user becomes disabled, expired, or over their data cap.
 */
const net = require('net');
const { WebSocketServer, createWebSocketStream } = require('ws');
const { parseHandshake } = require('./handshake');
const { config } = require('./config');

function bufToHex(buf) {
  return buf.toString('hex');
}

/**
 * Attach the proxy to an existing http(s) server.
 * @param {http.Server} server
 * @param {import('./store').Store} store
 */
function attachProxy(server, store) {
  // The first WebSocket message is a compact VLESS header; constrain all
  // frames to keep unauthenticated clients from reserving excessive memory.
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
  // uuid -> Set of active { ws, socket, close() }
  const active = new Map();

  function register(uuid, conn) {
    if (!active.has(uuid)) active.set(uuid, new Set());
    active.get(uuid).add(conn);
  }
  function unregister(uuid, conn) {
    const set = active.get(uuid);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) active.delete(uuid);
  }

  wss.on('connection', (ws, req) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    ws.once('message', msg => {
      try {
        const hs = parseHandshake(msg);
        const uuidHex = bufToHex(hs.id);
        const check = store.canConnect(uuidHex);
        if (!check.ok) {
          if (config.verbose) {
            console.log(`[proxy] rejected ${uuidHex} (${check.reason}) from ${ip}`);
          }
          return ws.close();
        }
        const user = check.user;
        user.lastSeen = Date.now();
        ws.send(Buffer.from([hs.version, 0]));

        const duplex = createWebSocketStream(ws);
        const socket = net.connect({ host: hs.host, port: hs.port }, () => {
          socket.write(msg.slice(hs.offset));
        });

        const conn = {
          ws, socket,
          close() { try { ws.terminate(); } catch (_) {} try { socket.destroy(); } catch (_) {} },
        };
        register(user.uuid, conn);

        const onUp = (chunk) => store.addTraffic(user.uuid, 'up', chunk.length);
        const onDown = (chunk) => store.addTraffic(user.uuid, 'down', chunk.length);
        duplex.on('data', onUp);
        socket.on('data', onDown);

        duplex.pipe(socket);
        socket.pipe(duplex);

        const cleanup = () => {
          duplex.removeListener('data', onUp);
          socket.removeListener('data', onDown);
          unregister(user.uuid, conn);
        };
        duplex.on('error', () => {});
        socket.on('error', () => {});
        socket.on('close', () => { cleanup(); try { ws.terminate(); } catch (_) {} });
        duplex.on('close', () => { cleanup(); try { socket.destroy(); } catch (_) {} });
      } catch (err) {
        ws.close();
      }
    });
  });

  // Periodically evict connections of users that became blocked mid-session.
  const enforceTimer = setInterval(() => {
    for (const [uuid, set] of active) {
      const check = store.canConnect(uuid);
      if (!check.ok) {
        for (const conn of set) conn.close();
      }
    }
  }, 2000);
  if (enforceTimer.unref) enforceTimer.unref();

  return {
    wss,
    activeCount: () => active.size,
    stop() { clearInterval(enforceTimer); },
  };
}

module.exports = { attachProxy };
