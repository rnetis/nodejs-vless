# nodejs-vless — with multi-user panel

[![fork of vevc/nodejs-vless](https://img.shields.io/badge/fork%20of-vevc%2Fnodejs--vless-blue)](https://github.com/vevc/nodejs-vless)

A lightweight **VLESS over WebSocket** proxy (Node.js), evolved with a
**multi-user management panel**: per-user traffic accounting, expiry dates,
data limits, an admin REST API, a web panel, and a **Telegram bot**.

> Original repo: https://github.com/vevc/nodejs-vless — this fork adds user
> management on top of the same VLESS/WSS protocol implementation.

## ✨ Features

- ✅ VLESS protocol over WebSocket (compatible with V2Ray / NekoBox / Shadowrocket / etc.)
- ✅ **Per-user UUID routing** — every client gets its own UUID
- 📊 **Traffic accounting** — up/down bytes counted live per user (saved to disk)
- ⏰ **Expiration** — disable a user automatically after a date
- 📦 **Data usage limits** — cap each user by GB; over-limit connections are dropped
- 🌐 **Web panel** — create / list / enable / disable / reset / delete users, see live stats
- 🔌 **Subscription endpoint** — `/sub/<uuid>` returns a base64 `vless://` link
- 🤖 **Telegram bot** — admin-only commands (`/add`, `/list`, `/off`, `/stats`, …)
- 🔐 Admin API protected by a Bearer token (auto-generated if not set)
- 🔒 Optional TLS (provide `TLS_CERT` / `TLS_KEY`) and optional legacy web-shell

## 📦 Install

```bash
git clone https://github.com/<you>/nodejs-vless
cd nodejs-vless
npm install          # installs ws@^8
node app.js
```

> `npm install` needs a working npm. If you only have `ws`, drop it into
> `node_modules/ws` and run `node app.js` directly.

## ⚙️ Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | HTTP(S) listen port | `3000` |
| `HOST` | Bind address | `0.0.0.0` |
| `DOMAIN` | Public domain used in generated links | `example.com` |
| `REMARKS` | Fallback node remark | `nodejs-vless` |
| `VLESS_PATH` | WebSocket path used in links | `/` |
| `DATA_FILE` | User database JSON path | `./data/users.json` |
| `ADMIN_TOKEN` | Master token for API + panel. Empty ⇒ auto-generated & saved to `<dataDir>/admin.token` | auto |
| `WEB_PANEL` | Show web panel (`on`/`off`) | `on` |
| `WEB_SHELL` | Legacy shell runner (`on`/`off`) | `off` |
| `TLS` | Use TLS | `off` |
| `TLS_CERT` / `TLS_KEY` | PEM cert/key paths (enables TLS) | — |
| `BOT_TOKEN` | Telegram bot token (enables bot) | — |
| `ADMIN_TELEGRAM_ID` | Comma-separated chat ids allowed to use the bot | all if empty |
| `TG_POLL` | Bot long-poll interval (ms) | `1500` |

## 🚀 Run

```bash
PORT=3000 DOMAIN=your.domain.com \
ADMIN_TOKEN=change-me \
BOT_TOKEN=123456:ABC-your-token \
ADMIN_TELEGRAM_ID=987654321 \
node app.js
```

On first boot (if `ADMIN_TOKEN` is empty) a token is printed:

```
[nodejs-vless] admin token: a1b2c3…e9f0
[nodejs-vless] panel:        http://your.domain.com:3000/panel?token=a1b2c3…e9f0
```

## 🖥 Web panel

Open `/panel?token=<ADMIN_TOKEN>`. From there you can:

- add a user (remark, expiry in days, data cap in GB),
- copy its subscription link,
- enable / disable / reset / delete users,
- watch aggregate traffic and active-user counts.

## 📡 Subscription link

Each user has a subscription endpoint:

```
GET /sub/<uuid>
```

It returns a base64-encoded `vless://` link you can paste into any VLESS client
(or import as a subscription). Example decoded link:

```
vless://<uuid>@your.domain.com:443?encryption=none&security=tls&sni=your.domain.com&fp=chrome&type=ws&host=your.domain.com&path=%2F#remark
```

## 🤖 Telegram bot

Set `BOT_TOKEN` (and optionally `ADMIN_TELEGRAM_ID`). Commands:

| Command | Action |
| --- | --- |
| `/start` `/help` | Show help |
| `/stats` | Totals: users, active, traffic |
| `/list` | List users with status + usage |
| `/add <remark> <days> <GB>` | Create a user |
| `/del <uuid|remark>` | Delete a user |
| `/on <uuid|remark>` | Enable a user |
| `/off <uuid|remark>` | Disable a user |
| `/reset <uuid|remark>` | Reset traffic counters |
| `/info <uuid|remark>` | Show detail + `vless://` link |

Only chat ids in `ADMIN_TELEGRAM_ID` may control the bot (or everyone if unset).

## 🔌 Admin REST API

All routes (except `/panel` and `/sub/:uuid`) require
`Authorization: Bearer <ADMIN_TOKEN>` or `?token=<ADMIN_TOKEN>`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/stats` | Aggregate stats |
| `GET` | `/api/users` | List users |
| `POST` | `/api/users` | Create: `{remark, expiryDays, dataLimitGB}` |
| `GET` | `/api/users/:uuid` | Get a user |
| `PUT` | `/api/users/:uuid` | Update: `{remark, enabled, expiryDays, dataLimitGB}` |
| `DELETE` | `/api/users/:uuid` | Delete a user |
| `POST` | `/api/users/:uuid/reset` | Reset traffic |

## 🧪 Tests

```bash
npm test                 # API + store + handshake unit/integration tests
node test.proxy.js       # real VLESS handshake + traffic accounting + expiry/disable
```

## 🛡 Security notes

- Change the default `ADMIN_TOKEN`; the API is powerful.
- Keep `WEB_SHELL=off` unless you absolutely need it (it executes shell as the
  node process user).
- Put the service behind a reverse proxy with TLS and firewall the ports.

## 📜 License

MIT — same as the upstream project. Contributions welcome.
