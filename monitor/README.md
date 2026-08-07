# Command Code Activity Monitor

A standalone dashboard that shows what Command Code is doing — live sessions,
tool calls, sub-agents, model usage, and errors — across all your projects.

## How it works

Two pieces:

1. **Collector mod** (`collector.mod.ts`) — installed at the user level so every
   Command Code session (interactive, headless `-p`, the Telegram bridge) reports
   in. It observes the AgentEvent stream via `cmd.on(...)` and batches events to
   the monitor server. It is a pure observer — it never mutates state or blocks
   tools, and a failure can never crash a session.
2. **Monitor server** (`server.mjs`) — a zero-dependency Node HTTP server that
   appends events to `data/events.jsonl`, serves the dashboard, and streams live
   events over SSE.

## Setup

### 1. Install the collector mod

```sh
copy collector.mod.ts "%USERPROFILE%\.commandcode\mods\commandcode-monitor.ts"
```

It loads on the next session start. The live copy lives outside the repo, so
updating the mod means re-copying it.

### 2. Run the server

```sh
node server.mjs
# or: npm start
```

Then open [http://localhost:8787](http://localhost:8787).


## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `MONITOR_INGEST_URL` | `http://localhost:8787/ingest` | Where the mod and bridge post events |
| `MONITOR_BATCH_MS` | `500` | Mod batching window before a POST |
| `MONITOR_MAX_LOG_BYTES` | `52428800` (50 MB) | Event log size cap; oldest lines are trimmed past this. `0` disables rotation |
| `MONITOR_TELEGRAM_STALE_MS` | `900000` (15 min) | A telegram msg that started but never ended is "running" only while younger than this; older = stale (bridge crashed). `0` disables |
| `MONITOR_PAGE_TOKEN` | *(empty)* | When set, gates all dashboard/telegram pages + APIs with a shared token. Empty = no auth (localhost only) |
| `OUTBOX_FILE` | `monitor/data/outbox.jsonl` | Resume commands the bridge executes (bridge env) |
| `OUTBOX_POLL_SECONDS` | `1` | How often the bridge polls the outbox |
| `BRIDGE_SESSION_FILE` | `monitor/data/bridge_sessions.json` | Per-chat session-id mapping persisted by the bridge |
| `PORT` | `8787` | Server port |
| `HOST` | `127.0.0.1` | Bind address (localhost only by default) |

## API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/ingest` | Collector mod + bridge post batched events (never gated) |
| `GET` | `/api/events?limit=&since=&session=` | Recent events for initial load |
| `GET` | `/api/summary` | Aggregate tiles |
| `GET` | `/api/stream` | SSE live feed |
| `GET` | `/` | Dashboard |
| `GET` | `/telegram` | Telegram conversations page (token-gated when `MONITOR_PAGE_TOKEN` set) |
| `GET` | `/metrics/errors` | Errors insight page (by tool, by session, recent errors) |
| `GET` | `/metrics/tools` | Tool-call insight page (calls by tool/session, failure rate) |
| `GET` | `/metrics/tokens` | Token insight page (in/out totals by model/session) |
| `POST` | `/api/telegram/auth` | `{token}` → sets the auth cookie on success |
| `GET` | `/api/telegram/status` | `{authed:true}` / 401 |
| `POST` | `/api/telegram/resume` | `{chatId, sessionId, prompt}` → queues a resume command (returns `{ok, cmdId}`) |
| `POST` | `/api/telegram/open-terminal` | `{sessionId}` → opens a native terminal on the PC running `command-code --resume <sessionId>` |

## Dashboard tiles

The summary tiles on the main dashboard are live counts from `/api/summary`.
**Errors**, **Sub-agents**, and **Events today** count today's activity (resets
each day); the other tiles are all-time totals. The
key tiles are clickable and open a dedicated insight page with a breakdown:
**Errors** → `/metrics/errors`, **Tool calls** → `/metrics/tools`,
**Tokens used** → `/metrics/tokens`, **Telegram msgs** → `/telegram`. Each page
reads the same event stream and updates live over SSE.

## Event log

Events append to `data/events.jsonl` as JSON lines. Server restarts continue the
sequence (`id` is seeded from the last line), so pagination with `since=` stays
consistent.

## Retention

The log is capped at 50 MB by default (`MONITOR_MAX_LOG_BYTES`); once it exceeds
the cap the server trims the oldest lines on the next ingest, keeping ids
monotonic so the live feed and `since=` pagination stay consistent. Set it to
`0` to disable rotation.

To wipe history manually, delete the log — the server recreates it on next
startup (ids restart at 1, which is fine for a dev tool):

```sh
del monitor\data\events.jsonl
```

## Data note

`data/events.jsonl` contains full tool inputs and results — including file
paths, command lines, and file contents the agent reads. Treat it as sensitive:
keep it local (it's git-ignored, so it won't be committed), and keep the server
bound to localhost only (default) rather than a shared network interface. The
mod posts events with no authentication.

## Telegram bridge

The dashboard has a **Telegram bridge** section showing every message the
`scripts/commandcode_telegram_bridge.py` script processed, its execution status
(queued → running → succeeded / failed / timeout / cancelled / error), the chat
that sent it, and — when you click a row — the underlying Command Code session's
activity (tool calls, errors, model usage).

How it works: the bridge already runs `command-code -p --output-format json` and
parses the final `result` frame, which carries the headless session's `sessionId`.
The bridge posts `telegram_msg_start` / `telegram_msg_update` / `telegram_msg_end`
events to the monitor's `/ingest` endpoint (same `MONITOR_INGEST_URL` env var and
default as the collector mod), and the dashboard joins them to the collector's
per-session activity stream by `sessionId`. No collector-mod change is needed —
it already captures headless sessions.

Notes:

- The bridge must be running for events to appear; messages processed before this
  feature existed aren't backfilled.
- The bridge's monitor POST is best-effort — a stopped monitor never breaks the
  Telegram reply loop.
- Chat identity is the numeric `chat_id` only (no friendly names).

## Telegram page (resume conversations from your phone)

A separate page at **`/telegram`** shows past Telegram conversations grouped by
chat, with the prompt and the agent's reply as chat bubbles. Each thread has a
**Resume** box to send a follow-up — the bridge runs
`command-code -p <prompt> --resume <sessionId>` so context carries forward, and
the reply goes back to the Telegram chat (the web page is the control surface;
Telegram stays the reply channel).

How it works:

1. **Resume** posts to `POST /api/telegram/resume` with the thread's `chatId`,
   `sessionId`, and the new prompt.
2. The monitor appends a `telegram_msg_queued` event (broadcast over SSE) and a
   line to the **outbox** (`data/outbox.jsonl`).
3. The bridge's background poller picks up the outbox line, runs
   `--resume <sessionId>`, posts the normal `telegram_msg_start` / `_update` /
   `_end` lifecycle (with the reply text in `_end`), and sends the reply to the
   Telegram chat.
4. The page updates live via SSE.

The bridge also tracks a **per-chat session id** (persisted to
`data/bridge_sessions.json`) so Telegram-originated messages resume their own
chat's session instead of one global `--continue` thread.

### Open terminal

Each thread header has an **Open terminal** button (shown when the thread has a
known session id). Clicking it calls `POST /api/telegram/open-terminal`, which
spawns a **native terminal window on the PC** running the monitor server, in the
bridge's `WORKDIR`, executing `command-code --resume <sessionId>` — so you can
continue the conversation in a full interactive Command Code session. Note the
terminal opens on the PC, not on the phone; from the phone it just triggers it
to open there. `command-code` must be on the server's PATH.

### `/plan` command

Send `/plan <item>` to the bot to draft an implementation plan:

1. The bridge runs the agent headless to **draft** a plan for `<item>` and
   replies with the draft plus "Reply `confirm` to save… or `cancel`".
2. Reply **`confirm`** → the agent writes the plan to
   `~/.commandcode/plans/<name>.md` (configurable via `COMMANDCODE_PLANS_DIR`)
   and the bridge confirms the path. Reply **`cancel`** → the draft is discarded.
3. Saving the file requires the agent's write tools, so it only works when
   `ALLOW_WRITES=true`; with it off, drafting still works and `confirm` explains
   why it can't save.

The bridge never writes the file itself — the agent does, so `ALLOW_WRITES` and
the agent's tool permissions are respected. Only one pending plan per chat; a
new `/plan` replaces the previous draft.

## Exposing to your phone + security

The monitor binds `127.0.0.1` by default with no auth — nothing changes unless
you opt in. To reach `/telegram` from your phone:

1. Set `MONITOR_PAGE_TOKEN` to a long random string (e.g.
   `openssl rand -hex 32`). This gates the dashboard, the telegram page, and all
   read APIs with a shared token (HttpOnly cookie, constant-time compare).
   `POST /ingest` stays open by design — local processes only; don't expose it.
2. Pick an access path:
   - **Tailscale** (recommended): run the PC and phone on the same tailnet, open
     `http://<pc-tailscale-ip>:8787/telegram` — encrypted, no port-forward.
   - **SSH reverse tunnel**: `ssh -R 8787:127.0.0.1:8787 user@vps`, then browse
     the VPS's port (token stays inside the tunnel).
   - **Reverse proxy with TLS** (Caddy/nginx) in front of the monitor.
   - **Raw router port-forward**: works, but the token cookie travels in
     cleartext over plain HTTP — only on a trusted network; the token still
     stops casual/drive-by access to tool inputs and session data.

The bot token never leaves the bridge process.

## Scope

- Localhost-only dev tool, no auth, no DB — JSONL is the store.
- Captures activity from the moment the mod is installed (no backfill of past
  sessions).

## Notes

If you do not want a session recorded, unset/ignore `MONITOR_INGEST_URL` for that
run, or remove the mod from `~/.commandcode/mods/`. The mod posts events with no
authentication and the server is bound to localhost, so keep the server off any
shared network interface.

