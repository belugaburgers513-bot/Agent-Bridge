# OrbitBridge

**Your Ubuntu VPS, inside your AI chat.**

OrbitBridge turns chat sites like DeepSeek and Z.ai into a real agent that works
on your own server: terminal commands, file management, git, web fetch and MCP —
driven by the AI, streamed live to your phone, with a ZeroScript-style status
bar docked to the chat composer.

![version](https://img.shields.io/badge/version-1.8.1-blue) ![platform](https://img.shields.io/b/platform-VPS%20Ubuntu%20%2B%20Chromium%20Android-orange) ![node](https://img.shields.io/badge/node-%E2%89%A518-green) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

---

## How it works

```
+----------------+        +--------------------+        +------------------+
|  Phone / PC    |  https |  Cloudflare Tunnel | local  |  Ubuntu VPS      |
|  AI chat site  | <----> |  (cloudflared)     | <----> |  OrbitBridge     |
|  + extension   |  wss   |  free, no ports    |  HTTP  |  server (pm2)    |
+----------------+        +--------------------+        +--------+---------+
        |                                                        |
        |  the AI writes a ```tool``` block ->                   |
        |  extension sends it over the tunnel  --->              tools run:
        |                                                        terminal / files
        |  <--- numbered TOOL_RESULT comes back                  / git / web / MCP
        |  AI reads it and continues
```

- The browser extension watches the chat for tool-call blocks the AI writes.
- Calls are executed on your VPS through the bridge server.
- Results come back as tidy numbered blocks the AI can read and act on.
- Everything is protected by a per-server bearer token; the bridge itself only
  listens on `127.0.0.1` — the Cloudflare tunnel is the only door.

---

## Features

**Agent in your chat**
- Terminal exec, file upload/download/zip/extract, git tools, web fetch, MCP servers
- **You set the tools-per-message cap** (1–12, default 6) + `parallel_commands` for 2–8 simultaneous shells
- Multiple VPS servers — switch the active one from the panel
- Background tools with progress, prompt queue that survives browser closes
- **Self-updating**: after a one-time install, the extension pulls new builds from your server (sha256-verified, idle chat tabs auto-reload) — no more unzip + reload cycles

**ZeroScript-style UI**
- Live status bar docked to the chat composer (breathing dot + agent state) — no floating buttons
- Running tools show a live chip with spinner + shimmer on the AI's message
- Sent results collapse into tidy cards; raw call blocks stay expandable
- Opaque cover over the composer while the agent types; every send verified with auto-retry

**Panel**
- Tabs: Agent, Terminal, Files, Live, Logs, Settings
- **Live tab** streams every command/tool hitting the server in real time
- VPS setup guide built into the panel; in-panel systemd service installer

**Supported chat sites:** `chat.deepseek.com` and `chat.z.ai` (first-class), plus
best-effort `chatgpt.com`, `claude.ai`, `gemini.google.com`.

---

## Quick start

### 1 · Server (Ubuntu VPS, ~2 minutes)

SSH in as root and run the GUI installer:

```bash
curl -sL https://github.com/belugaburgers513-bot/Agent-Bridge/releases/latest/download/ob-install.sh -o ob-install.sh && bash ob-install.sh
```

Pick **`1) Full install`** — that's it. The installer handles Node 20, the
bridge, pm2 (reboot-proof) and a free Cloudflare tunnel, then prints your
**URL + token**.

> Not root? `sudo bash ob-install.sh`. No domain needed for option 1.

### 2 · Extension (Android Chromium / desktop Chromium)

1. Download `orbitbridge.zip` from
   [Releases](https://github.com/belugaburgers513-bot/Agent-Bridge/releases/latest) and unzip it.
2. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select the `extension` folder.
3. Open any supported chat site → open the OrbitBridge panel → **Settings** →
   paste **URL + token** → **Save & test**.

### 3 · Talk to your server

In the chat, insert the agent prompt (panel → Agent tab → *Insert agent prompt*)
and just ask: *"list the files in /root and zip the logs folder"*.

---

## The installer GUI

```
  +==============================================+
  |        OrbitBridge - installer & manager     |
  +==============================================+
    v1.7.0  |  server: stopped  |  port: 3456

  Install / setup
    1) Full install        (server + pm2 + quick tunnel)
    2) Server only         (NO tunnel - bring your own)
    3) Quick tunnel        (trycloudflare URL, add/recreate)
    4) Named tunnel        (your own domain - advanced)
  Manage
    5) Status              (server + tunnel + token)
    6) Show token
    7) Rotate token        (old one stops working)
    8) Change port
    9) Update to latest    (keeps token)
   10) Restart server
   11) Stop server
   12) Start server
   13) Uninstall everything
    q) Quit
```

**Don't want Cloudflare?** Choose **`2) Server only`** — nothing is exposed.
Reach the bridge later via option 3/4, or an SSH tunnel:

```bash
ssh -L 3456:127.0.0.1:3456 root@your-vps     # then URL = http://127.0.0.1:3456
```

**Prefer zero prompts?** Every menu item is also a flag:

| Command | What it does |
|---|---|
| `bash ob-install.sh --full` | unattended install: server + pm2 + quick tunnel |
| `bash ob-install.sh --server-only` | install without any tunnel |
| `bash ob-install.sh --tunnel` | add / recreate the quick tunnel |
| `bash ob-install.sh --named-tunnel` | tunnel on your own domain (walks you through `cloudflared` login) |
| `bash ob-install.sh --status` | server, tunnel, token, health |
| `bash ob-install.sh --token` | print the pairing token |
| `bash ob-install.sh --rotate` | new token (old one dies) |
| `bash ob-install.sh --port 3456` | change the bridge port |
| `bash ob-install.sh --update` | update to the latest release, token preserved |
| `bash ob-install.sh --restart / --stop / --start` | pm2 control |
| `bash ob-install.sh --uninstall` | remove everything (asks first) |

Downloads are **sha256-verified** against `checksums.txt` and PK-guarded before
extraction. Re-running any install/update **preserves your token**.

---

## Updating & rollback

- **Server:** re-run the installer and pick `9) Update to latest` — or
  `bash ob-install.sh --update`. Token survives. The update also refreshes the
  extension copy the OTA server serves.
- **Extension:** from v1.8 on it updates ITSELF (Settings → Extension updates).
  For the one-time jump to v1.8: grab `orbitbridge.zip` from
  [Releases](https://github.com/belugaburgers513-bot/Agent-Bridge/releases), replace the
  folder, hit *Reload* on `chrome://extensions`.
- **Rollback:** every release keeps its assets — download an older version from
  the [releases page](https://github.com/belugaburgers513-bot/Agent-Bridge/releases).

---

## Security model

- Bearer token required on every `/api` request; token lives in `server/.token`
- Bridge listens on **127.0.0.1 only** — never exposed directly to the internet
- Command denylist (`rm -rf /`, `mkfs`, fork bombs, `iptables -F`, …)
- SSRF guard on `fetch_web_url`; private IPs blocked by default
- Brute-force brake: 15 bad tokens/min per client → 429
- Workspace restriction: file tools stay under `WORKSPACE_ROOT` (`strictWorkspace`)
- Running everything as root is convenient but risky — for least privilege,
  create a dedicated user, run pm2 from that account and set `WORKSPACE_ROOT`
  accordingly in `server/ecosystem.config.js`

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Extension says *Offline / Not connected* | wrong URL or token → `bash ob-install.sh --status`, re-paste both |
| Tunnel URL stopped working | quick-tunnel URLs change on reboot → `bash ob-install.sh --tunnel`, or `cat /root/orbitbridge/tunnel.url` |
| Port 3456 busy | `bash ob-install.sh --port 4456`, then update the URL in the panel |
| Need a fresh token | `bash ob-install.sh --rotate` (re-pair the extension) |
| Something crashed | `pm2 logs orbitbridge --lines 50` |
| Want it gone | `bash ob-install.sh --uninstall` |

Rotate the token manually anytime: delete `server/.token`, then
`pm2 restart orbitbridge`.

---

## Repository layout

```
Orbit-Bridge/
├── install.sh        # GUI installer & manager (this is all your VPS needs)
├── extension/        # Chromium extension (load unpacked)
│   ├── manifest.json
│   ├── background.js # launcher, service worker
│   ├── content.js    # per-site engine: chips, masking, sweeps
│   ├── ui.js         # panel UI + composer status bar
│   └── prompt.txt    # the agent prompt
└── server/           # zero-dependency Node server
    ├── server.js
    ├── ecosystem.config.js
    ├── installer.js  # in-panel systemd installer
    └── tools/        # terminal, fs, git, web, MCP, parallel, background
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
