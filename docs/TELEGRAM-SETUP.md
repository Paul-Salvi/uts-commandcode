# Telegram Setup

Sets up the CommandCode <-> Telegram bridge (`scripts/commandcode_telegram_bridge.py`)
for a new project. The bridge polls Telegram from an allowlisted chat, forwards each
message to CommandCode headless (`command-code -p ...`) running in the project
directory, and sends the reply back to the same chat. It runs **without write access
by default** — flip `ALLOW_WRITES` only if you trust unattended, permission-free
automation against the project directory.

Use this guide once per project: copy the bridge script into the new project (or
reference it from a shared location), set the three per-project variables below, and
run it.

---

## 1. Prerequisites

- **Command Code** installed globally and on PATH.
  Verify in a normal terminal: `command-code --version`.
  The bridge calls `command-code` explicitly — NOT the `cmd` alias, because `cmd`
  collides with the Windows Command Prompt executable on PATH.
- **Python 3.10+** with pip.
- **python-telegram-bot** (v20+):

  ```sh
  pip install python-telegram-bot --upgrade
  ```

## 2. Create the bot

1. Open Telegram and message **@BotFather**.
2. Send `/newbot`, pick a name and username, and copy the bot **token** it gives you.
3. Keep the token secret — never commit it. Use your own token; do not reuse the
   example default that appears in the script.

## 3. Get your chat id

You need your own numeric chat id so the bridge only answers you:

- **Easiest:** message **@userinfobot** — it replies with your numeric id.
- **Discovery mode:** run the bridge once with `ALLOWED_CHAT_IDS` empty. It prints
  `[discovery] message from chat_id=<id>` the first time you message the bot, then
  set that id and restart.

## 4. Configure per project

All configuration is via environment variables (the script's `CONFIG` block). For a
new project, set at minimum these three:

| Env var | Example | Purpose |
|---------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | `123456:ABC...` | Your bot token from @BotFather |
| `ALLOWED_CHAT_IDS` | `8099948260` | Comma-separated numeric chat ids allowed to use the bridge. Empty = discovery mode |
| `COMMANDCODE_WORKDIR` | `D:\Projects\MyProject` | Project directory CommandCode operates in. Defaults to the repo root (parent of `scripts/`) |

Optional:

| Env var | Default | Purpose |
|---------|---------|---------|
| `COMMANDCODE_ALLOW_WRITES` | `false` | `true` = run with `--yolo` (CommandCode may edit files / run shell commands). Off by default for safety |
| `COMMANDCODE_MAX_TURNS` | `40` | Max turns per headless call |
| `COMMANDCODE_PLANS_DIR` | `~/.commandcode/plans` | Where `/plan` saves confirmed plans |
| `MONITOR_INGEST_URL` | `http://localhost:8787/ingest` | Posts activity events to the monitor dashboard (optional) |
| `OUTBOX_FILE` | `monitor/data/outbox.jsonl` | Commands queued by the monitor's telegram page |
| `BRIDGE_SESSION_FILE` | `monitor/data/bridge_sessions.json` | Per-chat session-id mapping, persisted across restarts |

### Windows (cmd), one-off run

```bat
set TELEGRAM_BOT_TOKEN=123456:ABC...
set ALLOWED_CHAT_IDS=8099948260
set COMMANDCODE_WORKDIR=D:\Projects\MyProject
python scripts\commandcode_telegram_bridge.py
```

### PowerShell, one-off run

```powershell
$env:TELEGRAM_BOT_TOKEN="123456:ABC..."
$env:ALLOWED_CHAT_IDS="8099948260"
$env:COMMANDCODE_WORKDIR="D:\Projects\MyProject"
python scripts\commandcode_telegram_bridge.py
```

### Persisting the config

To keep the variables across terminals (per user):

```bat
setx TELEGRAM_BOT_TOKEN "123456:ABC..."
setx ALLOWED_CHAT_IDS "8099948260"
setx COMMANDCODE_WORKDIR "D:\Projects\MyProject"
```

Or keep a small launcher script / `.env` loader in the project and export these
before starting the bridge. The token is a secret — make sure any file holding it is
git-ignored.

## 5. Run it

```sh
python scripts\commandcode_telegram_bridge.py
```

Expected startup output:

```
CommandCode <-> Telegram bridge running. Ctrl+C to stop.
WORKDIR: D:\Projects\MyProject
ALLOW_WRITES: False
Outbox: ...\monitor\data\outbox.jsonl
```

Then message your bot on Telegram. It should reply within a few seconds. If you ran
in discovery mode (no `ALLOWED_CHAT_IDS`), the log shows `[discovery] message from
chat_id=<id>` — set that id and restart.

The bridge refuses to start if the token is still the placeholder
(`PASTE_YOUR_BOT_TOKEN_HERE`) or if `WORKDIR` does not exist.

## 6. What you can do from Telegram

- **Plain message** — runs `command-code -p <message>` in `WORKDIR` and replies with
  the result.
- **`/plan <item>`** — drafts an implementation plan, then reply **`confirm`** to
  save it to `~/.commandcode/plans/<name>.md` or **`cancel`** to discard. Saving
  requires `COMMANDCODE_ALLOW_WRITES=true`.

## 7. Security notes

- **Read-only by default.** Keep `COMMANDCODE_ALLOW_WRITES=false` unless this project
  directory can be trusted for unattended, permission-free automation. With it off,
  CommandCode can read/search files but cannot edit files or run shell commands.
- **The bot token is a secret** — it must never leave the bridge process, never be
  committed, and never be logged. Rotate it in @BotFather if it leaks.
- **Scope the bridge per project.** `WORKDIR` is fixed per bridge instance and
  conversation continuity is single-threaded per machine/directory — run one bridge
  per project directory.
- **Allowlist only your chats.** `ALLOWED_CHAT_IDS` gates every incoming message;
  anything else is logged as `[blocked]` and ignored.

## 8. Optional: monitor dashboard

The bridge pairs with the Command Code Activity Monitor (`monitor/`). With the
monitor running, the dashboard shows every bridge message and its execution status,
and the `/telegram` page lets you resume conversations from your phone. See
`monitor/README.md` for setup, the `MONITOR_INGEST_URL` wiring, and how to expose the
dashboard to your phone securely. The bridge's monitor POST is best-effort — a
stopped monitor never breaks the Telegram reply loop.

## Reference

- `scripts/commandcode_telegram_bridge.py` — the bridge itself; its docstring is the
  authoritative quick-start and this guide mirrors it.
- `monitor/README.md` — monitor dashboard, `/telegram` resume page, `/plan` details,
  and remote-access security options.
