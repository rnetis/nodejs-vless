'use strict';
/*
 * Telegram bot — admin control surface. Uses Node's built-in fetch (no deps)
 * with getUpdates long-polling. Only chat ids listed in ADMIN_TELEGRAM_ID may
 * use it. Commands:
 *   /start, /help            -> command list
 *   /stats                   -> aggregate stats
 *   /list                    -> users (remark · uuid · status)
 *   /add <remark> <days> <GB> -> create user
 *   /del <uuid|remark>       -> delete user
 *   /on <uuid|remark>        -> enable
 *   /off <uuid|remark>       -> disable
 *   /reset <uuid|remark>     -> reset traffic
 *   /info <uuid|remark>      -> user detail + vless link
 */
const { config } = require('./config');
const { GB } = require('./store');

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(2) + ' ' + u[i];
}

function resolveTarget(store, key) {
  if (!key) return null;
  if (/^[0-9a-f-]{36}$/i.test(key)) return store.get(key) || null;
  return store.find(key);
}

function buildVlessLink(user) {
  const domain = config.domain;
  const p = encodeURIComponent(config.path || '/');
  const remark = encodeURIComponent(user.remark || config.remarks);
  return `vless://${user.uuid}@${domain}:443?encryption=none&security=tls&sni=${domain}&fp=chrome&type=ws&host=${domain}&path=${p}#${remark}`;
}

function statusEmoji(u) {
  if (!u.enabled) return '⛔';
  if (u.expiry && Date.now() > u.expiry) return '⌛';
  if (u.dataLimit && (u.up + u.down) >= u.dataLimit) return '🚫';
  return '✅';
}

async function call(method, payload) {
  const url = `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function send(chatId, text) {
  await call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

function allowed(chatId) {
  return config.telegram.adminIds.includes(String(chatId));
}

function start(store) {
  if (!config.telegram.botToken) {
    console.log('[telegram] no BOT_TOKEN configured, bot disabled.');
    return { stop() {} };
  }
  if (config.telegram.adminIds.length === 0) {
    console.error('[telegram] BOT_TOKEN is set but ADMIN_TELEGRAM_ID is empty; bot disabled.');
    return { stop() {} };
  }

  let offset = 0;
  let running = true;
  console.log('[telegram] bot polling…');

  async function tick() {
    if (!running) return;
    let updates;
    try {
      const r = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/getUpdates?offset=${offset}&timeout=30`, { signal: AbortSignal.timeout(35000) });
      updates = await r.json();
    } catch (e) {
      await new Promise(res => setTimeout(res, config.telegram.pollInterval));
      return tick();
    }
    if (updates && updates.result) {
      for (const u of updates.result) {
        offset = u.update_id + 1;
        if (u.message && u.message.text) await handleMessage(u.message);
      }
    }
    setTimeout(tick, config.telegram.pollInterval);
  }

  async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    if (!allowed(chatId)) { await send(chatId, '⛔ You are not authorized to control this bot.'); return; }
    const [cmd, ...args] = text.split(/\s+/);
    const arg = args.join(' ');

    try {
      switch (cmd) {
        case '/start':
        case '/help':
          await send(chatId, '🤖 <b>nodejs-vless bot</b>\n' +
            '/stats — totals\n/list — users\n/add &lt;remark&gt; &lt;days&gt; &lt;GB&gt;\n/del &lt;uuid|remark&gt;\n/on &lt;uuid|remark&gt;\n/off &lt;uuid|remark&gt;\n/reset &lt;uuid|remark&gt;\n/info &lt;uuid|remark&gt;');
          break;
        case '/stats': {
          const all = store.list();
          let up = 0, down = 0, active = 0;
          for (const x of all) { up += x.up; down += x.down; if (x.lastSeen && Date.now() - x.lastSeen < 60000) active++; }
          await send(chatId, `👥 Users: ${all.length}\n🟢 Active: ${active}\n📊 Traffic: ${fmtBytes(up + down)} (↑${fmtBytes(up)} ↓${fmtBytes(down)})\n🌐 Domain: ${config.domain}`);
          break;
        }
        case '/list': {
          const all = store.list();
          if (!all.length) return send(chatId, 'No users.');
          const lines = all.map(u => `${statusEmoji(u)} <b>${u.remark || '—'}</b> <code>${u.uuid.slice(0, 8)}</code> ${fmtBytes(u.up + u.down)}${u.dataLimit ? '/' + fmtBytes(u.dataLimit) : ''}`);
          await send(chatId, lines.join('\n'));
          break;
        }
        case '/add': {
          const remark = args[0] || '';
          const days = parseInt(args[1], 10) || 0;
          const gb = parseFloat(args[2]) || 0;
          const u = store.create({
            remark,
            expiry: days ? Date.now() + days * 86400000 : 0,
            dataLimit: gb ? Math.round(gb * GB) : 0,
          });
          await send(chatId, `✅ Created <b>${u.remark || '—'}</b>\n<code>${u.uuid}</code>\n${buildVlessLink(u)}`);
          break;
        }
        case '/del': {
          const t = resolveTarget(store, arg);
          if (!t) return send(chatId, 'User not found.');
          store.remove(t.uuid);
          await send(chatId, `🗑 Deleted ${t.remark || t.uuid}`);
          break;
        }
        case '/on': {
          const t = resolveTarget(store, arg);
          if (!t) return send(chatId, 'User not found.');
          store.update(t.uuid, { enabled: true });
          await send(chatId, `✅ Enabled ${t.remark || t.uuid}`);
          break;
        }
        case '/off': {
          const t = resolveTarget(store, arg);
          if (!t) return send(chatId, 'User not found.');
          store.update(t.uuid, { enabled: false });
          await send(chatId, `⛔ Disabled ${t.remark || t.uuid}`);
          break;
        }
        case '/reset': {
          const t = resolveTarget(store, arg);
          if (!t) return send(chatId, 'User not found.');
          store.resetTraffic(t.uuid);
          await send(chatId, `🔄 Reset traffic for ${t.remark || t.uuid}`);
          break;
        }
        case '/info': {
          const t = resolveTarget(store, arg);
          if (!t) return send(chatId, 'User not found.');
          const exp = t.expiry ? new Date(t.expiry).toLocaleString() : 'never';
          await send(chatId, `<b>${t.remark || '—'}</b>\nUUID: <code>${t.uuid}</code>\nEnabled: ${t.enabled}\nExpiry: ${exp}\nUsed: ${fmtBytes(t.up + t.down)} / ${t.dataLimit ? fmtBytes(t.dataLimit) : '∞'}\n${buildVlessLink(t)}`);
          break;
        }
        default:
          await send(chatId, 'Unknown command. Send /help.');
      }
    } catch (e) {
      await send(chatId, '⚠️ ' + e.message);
    }
  }

  tick();
  return {
    stop() { running = false; },
  };
}

module.exports = { start };
