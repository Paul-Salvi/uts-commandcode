"""
CommandCode <-> Telegram bridge.

Polls Telegram for messages from an allowlisted chat, forwards each message
to CommandCode's headless mode ("command-code -p ..."), and sends the
response back to the same Telegram chat.

Setup
-----
1. pip install python-telegram-bot --upgrade
2. Create a bot via @BotFather in Telegram, copy the token.
3. Get your own numeric Telegram chat id (message @userinfobot, or run this
   script once with ALLOWED_CHAT_IDS empty and it will print any chat id
   that messages it, then add that id and restart).
4. Set the environment variables below (or edit the defaults in CONFIG).
5. Run: python commandcode_telegram_bridge.py

Notes
-----
- Uses "command-code" explicitly, NOT the "cmd" alias, because "cmd" collides
  with the Windows Command Prompt executable on PATH.
- By default this runs WITHOUT --yolo, so CommandCode can read/search files
  but cannot edit files or run shell commands. Flip ALLOW_WRITES to True
  only if you trust running unattended, permission-free automation against
  this project directory.
- Conversation continuity is handled with --continue, which resumes the most
  recent headless session in WORKDIR. That means this bridge is single
  conversation thread per machine/directory, not per Telegram chat.
"""

import asyncio
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import threading
import urllib.request
from pathlib import Path

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.error import NetworkError
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

# Tracks the currently-running command-code subprocess (if any) so Ctrl+C
# can kill it immediately instead of waiting for it to finish.
_active_process_lock = threading.Lock()
_active_process = None

# ----------------------------------------------------------------------------
# CONFIG - edit these or set as environment variables before running
# ----------------------------------------------------------------------------

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "8733315797:AAEqWaiI5PX1FuyXSU7Ul6wgV5xVahGu9_8")

# Only messages from these numeric chat ids will be processed.
# Leave empty list during first run to discover your chat id (see console log).
ALLOWED_CHAT_IDS = {
    int(cid) for cid in os.environ.get("ALLOWED_CHAT_IDS", "8099948260").split(",") if cid.strip()
}

# Working directory CommandCode should operate in (e.g. your Sleeve repo).
# Defaults to the repo root (parent of this scripts/ directory) so the bridge
# works out of the box; override with COMMANDCODE_WORKDIR.
WORKDIR = Path(os.environ.get("COMMANDCODE_WORKDIR", str(Path(__file__).resolve().parent.parent)))

# Set True to allow CommandCode to write files / run shell commands from
# Telegram-triggered messages. Off by default for safety.
ALLOW_WRITES = os.environ.get("COMMANDCODE_ALLOW_WRITES", "false").lower() == "true"

# Max turns per headless call.
MAX_TURNS = int(os.environ.get("COMMANDCODE_MAX_TURNS", "40"))

TELEGRAM_MSG_LIMIT = 4000  # stay under Telegram's 4096 char cap with margin

# Where to post telegram_msg_* activity events for the monitor dashboard
# (same env var + default as the collector mod in monitor/collector.mod.ts).
MONITOR_INGEST_URL = os.environ.get(
    "MONITOR_INGEST_URL", "http://localhost:8787/ingest"
)
MONITOR_MSG_TEXT_LIMIT = 200  # truncate message text before posting

# Outbox: commands queued by the monitor's telegram page are read from here.
OUTBOX_FILE = Path(
    os.environ.get(
        "OUTBOX_FILE",
        str(Path(__file__).resolve().parent.parent / "monitor" / "data" / "outbox.jsonl"),
    )
)
# How often the background poller checks the outbox (seconds).
OUTBOX_POLL_SECONDS = float(os.environ.get("OUTBOX_POLL_SECONDS", "1"))
# Per-chat session-id mapping, persisted across bridge restarts.
BRIDGE_SESSION_FILE = Path(
    os.environ.get(
        "BRIDGE_SESSION_FILE",
        str(Path(__file__).resolve().parent.parent / "monitor" / "data" / "bridge_sessions.json"),
    )
)

# Serializes command-code runs so only one runs at a time (Telegram message
# path and outbox poller share it).
_exec_lock = threading.Lock()

# Directory where /plan writes plan files (Command Code's standard plan location).
PLANS_DIR = Path(
    os.environ.get(
        "COMMANDCODE_PLANS_DIR",
        str(Path.home() / ".commandcode" / "plans"),
    )
)

# Per-chat pending /plan drafts awaiting confirm/cancel: chat_id -> {name, draft}.
_pending_plans = {}
_pending_plans_lock = threading.Lock()

# ----------------------------------------------------------------------------


def _kill_process_tree(proc: subprocess.Popen) -> None:
    """Kill proc and any children it spawned.

    Needed because we launch command-code with shell=True on Windows (to
    resolve npm's .cmd shim) — proc.kill() alone would only kill the cmd.exe
    wrapper and leave the actual command-code/node process running orphaned.
    """
    if platform.system() == "Windows":
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
            capture_output=True,
        )
    else:
        proc.kill()


def _run_once(prompt: str, use_continue: bool, resume_session_id: str | None = None):
    """Run a single command-code invocation.

    Pass resume_session_id to resume that exact session (`--resume <id>`);
    otherwise pass use_continue=True to resume the most recent session.
    Returns (final_text, error_text, raw_stdout, raw_stderr, meta) where meta
    is a dict with sessionId / durationMs / stopReason / subtype / usage parsed
    from the final JSON result frame (best-effort; missing keys are absent).
    """
    cmd = ["command-code", "-p", prompt]
    if resume_session_id:
        cmd += ["--resume", resume_session_id]
    elif use_continue:
        cmd.append("--continue")
    cmd += ["--output-format", "json", "--max-turns", str(MAX_TURNS), "--skip-onboarding"]
    if ALLOW_WRITES:
        cmd.append("--yolo")

    global _active_process
    on_windows = platform.system() == "Windows"

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(WORKDIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=on_windows,
        )
    except FileNotFoundError:
        return (
            None,
            (
                "Could not find the `command-code` executable. Make sure it's "
                "installed globally (`npm i -g command-code`) and on PATH."
            ),
            "",
            "",
            {"error": "executable_not_found"},
        )

    with _active_process_lock:
        _active_process = proc

    try:
        stdout, stderr = proc.communicate(timeout=600)
    except subprocess.TimeoutExpired:
        _kill_process_tree(proc)
        proc.communicate()
        return (
            None,
            "CommandCode timed out after 10 minutes.",
            "",
            "",
            {"error": "timeout"},
        )
    finally:
        with _active_process_lock:
            _active_process = None

    if proc.returncode in (-signal.SIGTERM, -signal.SIGINT):
        return (
            None,
            "(cancelled — bridge was stopped)",
            stdout,
            stderr,
            {"error": "cancelled"},
        )

    final_text = None
    error_text = None
    meta = {}
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except json.JSONDecodeError:
            continue
        if frame.get("type") == "result":
            for key in ("sessionId", "durationMs", "stopReason", "subtype", "usage"):
                if key in frame:
                    meta[key] = frame[key]
            final_text = frame.get("finalText")
            if frame.get("subtype") == "error":
                error_text = frame.get("error")

    return final_text, error_text, stdout, stderr, meta


def _post_monitor(events):
    """Best-effort POST of activity events to the monitor's /ingest endpoint.

    Never raises and never blocks the Telegram reply path — the monitor is an
    optional localhost dashboard. Uses stdlib urllib so the bridge stays
    dependency-free.
    """
    if not events:
        return
    try:
        data = json.dumps(events).encode("utf-8")
        req = urllib.request.Request(
            MONITOR_INGEST_URL,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=3):
            pass
    except Exception as exc:  # noqa: BLE001 — monitor is optional
        print(f"[monitor] failed to post {len(events)} event(s): {exc}")


def _tg_status(meta):
    """Map a _run_once meta dict to a telegram_msg status."""
    err = meta.get("error")
    if err == "timeout":
        return "timeout"
    if err == "cancelled":
        return "cancelled"
    if err == "executable_not_found":
        return "error"
    if meta.get("subtype") == "error":
        return "failed"
    return "succeeded"


def _exec_commandcode(prompt, resume_session_id=None, use_continue=True):
    """Run command-code once, with retry-on-failed-resume fallbacks.

    Returns (reply_text, meta). Tries --resume <id> first (if given), else
    --continue; then retries fresh without any resume/continue flag when:
      - "too many arguments" (no session exists yet in WORKDIR), or
      - "No session ... found to resume" (a stored session id is stale —
        the workspace changed or the session was cleaned up).
    """
    final_text, error_text, stdout, stderr, meta = _run_once(
        prompt, use_continue=use_continue, resume_session_id=resume_session_id
    )
    combined = (((stderr or "") + (stdout or "") + (error_text or ""))).lower()
    resume_failed = (
        resume_session_id
        and not final_text  # None or "" (error result has empty finalText)
        and "no session" in combined
        and "found to resume" in combined
    )
    no_session_yet = (
        final_text is None
        and error_text is None
        and "too many arguments" in combined
    )
    if resume_failed or no_session_yet:
        reason = "stale resume session" if resume_failed else "no existing session in WORKDIR yet"
        print(f"[commandcode] {reason} — retrying without resume/continue")
        if resume_failed:
            print(f"[commandcode] clearing stale session {resume_session_id!r}")
        final_text, error_text, stdout, stderr, meta = _run_once(
            prompt, use_continue=False, resume_session_id=None
        )

    if error_text:
        return f"CommandCode error: {error_text}", meta
    if final_text:
        return final_text, meta
    return stderr.strip() or stdout.strip() or "(no output)", meta


def run_commandcode(prompt: str, tg=None) -> tuple[str, dict]:
    """Run CommandCode headlessly against WORKDIR.

    tg is an optional dict of telegram context ({chatId, messageId,
    messageText}) used to post telegram_msg_* lifecycle events to the monitor.

    Resumes this chat's session if one is known (per-chat session tracking);
    otherwise falls back to --continue, then fresh. Returns (reply_text, meta)
    where meta carries sessionId / status / durationMs / stopReason from the run.
    """
    resolved = shutil.which("command-code")
    if resolved is None:
        msg = (
            "Could not find the `command-code` executable on PATH. "
            "Confirm `command-code --version` works in a normal terminal, "
            "and that this script's Python process was launched from a "
            "terminal with the same PATH (a fresh terminal after installing "
            "usually fixes this — PATH changes don't apply to already-open "
            "windows)."
        )
        return msg, {"error": "executable_not_found"}

    chat_id = tg["chatId"] if tg else None
    tg_common = {
        "chatId": chat_id,
        "messageId": tg["messageId"] if tg else None,
        "messageText": (tg.get("messageText") or "")[:MONITOR_MSG_TEXT_LIMIT],
    }

    def _post(tg_type, **extra):
        _post_monitor(
            [
                {
                    "type": tg_type,
                    "data": {**tg_common, **extra},
                }
            ]
        )

    _post("telegram_msg_start", status="queued")

    # Per-chat session resume: use this chat's last session if we have one.
    resume_session_id = _get_chat_session(chat_id) if chat_id else None
    with _exec_lock:
        reply, meta = _exec_commandcode(prompt, resume_session_id=resume_session_id)
        if meta.get("sessionId"):
            _set_chat_session(chat_id, meta["sessionId"])
        elif resume_session_id:
            # the resume failed (stale session) and the retry produced no new
            # session — clear the stale mapping so we don't retry it forever
            print(f"[commandcode] clearing stale session for chat {chat_id}")
            _clear_chat_session(chat_id)

    status = _tg_status(meta)
    _post(
        "telegram_msg_end",
        status=status,
        sessionId=meta.get("sessionId"),
        durationMs=meta.get("durationMs"),
        stopReason=meta.get("stopReason"),
        subtype=meta.get("subtype"),
        replyText=reply[:2000] if status in ("succeeded", "failed") else None,
    )
    return reply, meta


# ---- per-chat session tracking ----
# Maps chat_id → last command-code sessionId so each Telegram thread resumes
# its own conversation. Persisted to BRIDGE_SESSION_FILE across restarts.
_chat_sessions = {}
_chat_sessions_lock = threading.Lock()


def _load_chat_sessions():
    global _chat_sessions
    try:
        if BRIDGE_SESSION_FILE.exists():
            with open(BRIDGE_SESSION_FILE, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                _chat_sessions = {str(k): v for k, v in data.items()}
    except Exception as exc:  # noqa: BLE001 — best-effort persistence
        print(f"[sessions] failed to load {BRIDGE_SESSION_FILE}: {exc}")


def _save_chat_sessions():
    try:
        BRIDGE_SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(BRIDGE_SESSION_FILE, "w", encoding="utf-8") as f:
            json.dump(_chat_sessions, f, indent=2)
    except Exception as exc:  # noqa: BLE001 — never break the bridge
        print(f"[sessions] failed to save {BRIDGE_SESSION_FILE}: {exc}")


def _get_chat_session(chat_id):
    if chat_id is None:
        return None
    with _chat_sessions_lock:
        return _chat_sessions.get(str(chat_id))


def _set_chat_session(chat_id, session_id):
    if chat_id is None or not session_id:
        return
    with _chat_sessions_lock:
        _chat_sessions[str(chat_id)] = session_id
    _save_chat_sessions()


def _clear_chat_session(chat_id):
    if chat_id is None:
        return
    with _chat_sessions_lock:
        removed = _chat_sessions.pop(str(chat_id), None)
    if removed is not None:
        _save_chat_sessions()


# ---- outbox (commands queued by the monitor's telegram page) ----
# The monitor appends {"id":..., "ts":..., "chatId":..., "sessionId":...,
# "prompt":..., "status":"queued"} lines; the bridge appends status
# transitions for the same id: "running", then "done" (or "error").


def _read_outbox():
    """Return {id: {latest status line}} by scanning the outbox file."""
    out = {}
    try:
        if OUTBOX_FILE.exists():
            with open(OUTBOX_FILE, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(rec, dict) and rec.get("id"):
                        out[str(rec["id"])] = rec
    except Exception as exc:  # noqa: BLE001
        print(f"[outbox] failed to read {OUTBOX_FILE}: {exc}")
    return out


def _append_outbox(rec):
    try:
        OUTBOX_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(OUTBOX_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as exc:  # noqa: BLE001 — never break the bridge
        print(f"[outbox] failed to append: {exc}")


def _exec_outbox_command(rec, bot, loop):
    """Execute one queued command from the outbox. Runs in an executor thread.

    bot.send_message is a coroutine in PTB v20+, so replies are scheduled back
    onto the poller's event loop via run_coroutine_threadsafe.
    """
    cmd_id = str(rec["id"])
    chat_id = rec.get("chatId")
    session_id = rec.get("sessionId") or ""
    prompt = str(rec.get("prompt") or "").strip()

    # defense-in-depth: the web token gates the resume API, but the bridge must
    # not execute arbitrary outbox lines if the file is ever tampered with.
    if ALLOWED_CHAT_IDS and chat_id not in ALLOWED_CHAT_IDS:
        print(f"[outbox] skipping command {cmd_id}: chat {chat_id} not allowlisted")
        _append_outbox({"id": cmd_id, "status": "done", "ok": False, "error": "chat not allowlisted"})
        return
    if not prompt:
        _append_outbox({"id": cmd_id, "status": "done", "ok": False, "error": "empty prompt"})
        return

    _append_outbox({"id": cmd_id, "status": "running"})

    tg_common = {
        "chatId": chat_id,
        "messageId": cmd_id,  # pair the web command with its outbox id
        "messageText": prompt[:MONITOR_MSG_TEXT_LIMIT],
    }

    def _post(tg_type, **extra):
        _post_monitor([{"type": tg_type, "data": {**tg_common, **extra}}])

    _post("telegram_msg_start", status="queued")
    with _exec_lock:
        reply, meta = _exec_commandcode(prompt, resume_session_id=session_id or None, use_continue=False)
        if meta.get("sessionId"):
            _set_chat_session(chat_id, meta["sessionId"])
        elif session_id:
            print(f"[commandcode] clearing stale session for chat {chat_id} (outbox)")
            _clear_chat_session(chat_id)

    status = _tg_status(meta)
    _post(
        "telegram_msg_end",
        status=status,
        sessionId=meta.get("sessionId"),
        durationMs=meta.get("durationMs"),
        stopReason=meta.get("stopReason"),
        subtype=meta.get("subtype"),
        replyText=reply[:2000] if status in ("succeeded", "failed") else None,
    )
    _append_outbox({"id": cmd_id, "status": "done", "ok": status == "succeeded", "statusDetail": status})

    # Reply to the chat via the bot (plain message — web commands have no
    # originating Telegram message to reply to). Schedule onto the event loop.
    if chat_id and status in ("succeeded", "failed"):
        chunks = [reply[i:i + TELEGRAM_MSG_LIMIT] for i in range(0, len(reply), TELEGRAM_MSG_LIMIT)] or [""]
        for idx, chunk in enumerate(chunks):
            markup = _quick_actions_markup(chat_id) if idx == len(chunks) - 1 else None
            fut = asyncio.run_coroutine_threadsafe(
                bot.send_message(chat_id=chat_id, text=chunk, reply_markup=markup), loop
            )
            try:
                fut.result(timeout=30)
            except Exception as exc:  # noqa: BLE001
                print(f"[outbox] failed to send reply to chat {chat_id}: {exc}")


async def _outbox_poller(app):
    """Background task: poll the outbox and execute queued commands.

    Runs the actual command-code work in an executor thread so the Telegram
    polling loop never blocks. _exec_lock (shared with handle_message)
    guarantees only one command-code run at a time.
    """
    loop = asyncio.get_running_loop()
    processed = set()
    while True:
        try:
            outbox = _read_outbox()
            for rec in outbox.values():
                cmd_id = str(rec["id"])
                status = rec.get("status")
                if cmd_id in processed:
                    continue
                if status == "done" or status == "error":
                    processed.add(cmd_id)
                    continue
                if status == "queued":
                    processed.add(cmd_id)  # don't re-queue while running
                    await loop.run_in_executor(None, _exec_outbox_command, rec, app.bot, loop)
        except Exception as exc:  # noqa: BLE001 — never kill the poller
            print(f"[outbox] poller error: {exc}")
        await asyncio.sleep(OUTBOX_POLL_SECONDS)


async def _retry_network_call(coro_factory, attempts: int = 3, delay: float = 2.0):
    """Retry a Telegram API call a few times on transient network errors.

    coro_factory is a zero-arg callable returning a fresh coroutine each
    time, since an already-awaited coroutine object can't be reused.
    """
    last_exc = None
    for attempt in range(1, attempts + 1):
        try:
            return await coro_factory()
        except NetworkError as exc:
            last_exc = exc
            print(f"[network] attempt {attempt}/{attempts} failed: {exc}")
            if attempt < attempts:
                await asyncio.sleep(delay)
    raise last_exc


# ---- /plan command ----
# `/plan <item>` drafts an implementation plan via the agent, replies with the
# draft, and only writes the plan file to PLANS_DIR after the user replies
# "confirm". The bridge never writes the file itself — the agent does, honoring
# ALLOW_WRITES.

_PLAN_NAME_RE = re.compile(r"^\s*PLAN_NAME\s*=\s*([A-Za-z0-9._-]+)\s*$", re.M)


def _slugify(text: str) -> str:
    """Turn free text into a kebab-case plan filename."""
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "plan"


def _parse_plan_name(reply: str, item: str) -> str:
    m = _PLAN_NAME_RE.search(reply or "")
    if m:
        return m.group(1)
    return _slugify(item)


def _draft_prompt(item: str) -> str:
    return (
        "You are a planning assistant for this codebase. Produce a concise, "
        f"actionable implementation plan for: {item}\n"
        "Format it as a short markdown plan with clear numbered steps, and note "
        "any files that would change. Do NOT write any files.\n"
        "End your reply with a single line exactly like: PLAN_NAME=<kebab-case-name>"
    )


def _write_prompt(name: str, draft: str) -> str:
    return (
        f"Write the plan below to the file {PLANS_DIR / name}.md. "
        "Create the file with this exact content (markdown), then reply with "
        "just the absolute path you wrote.\n\n"
        f"---\n{draft}\n---"
    )


async def _reply(update: Update, text: str, reply_markup=None) -> None:
    for i in range(0, len(text), TELEGRAM_MSG_LIMIT):
        chunk = text[i:i + TELEGRAM_MSG_LIMIT]
        last = i + TELEGRAM_MSG_LIMIT >= len(text)
        try:
            await _retry_network_call(
                lambda c=chunk, m=(reply_markup if last else None): update.message.reply_text(c, reply_markup=m)
            )
        except NetworkError as exc:
            print(f"[network] giving up sending a reply chunk: {exc}")


def _plan_markup(chat_id) -> InlineKeyboardMarkup:
    """Save/Cancel buttons for a pending plan draft."""
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("✓ Save plan", callback_data=f"plan:confirm:{chat_id}"),
                InlineKeyboardButton("✗ Cancel", callback_data=f"plan:cancel:{chat_id}"),
            ]
        ]
    )


def _quick_actions_markup(chat_id) -> InlineKeyboardMarkup:
    """Quick-action row attached to every agent reply."""
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("▶ Continue", callback_data=f"act:continue:{chat_id}"),
                InlineKeyboardButton("⚡ Open terminal", callback_data=f"act:terminal:{chat_id}"),
                InlineKeyboardButton("📋 New plan", callback_data=f"act:newplan:{chat_id}"),
                InlineKeyboardButton("ℹ Status", callback_data=f"act:status:{chat_id}"),
            ]
        ]
    )


async def cmd_plan(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = (update.message.text if update.message else "") or ""
    item = text.split(None, 1)[1].strip() if len(text.split(None, 1)) > 1 else ""
    if not item:
        await _reply(update, "Usage: /plan <what to plan>\nExample: /plan add a sponsor dashboard")
        return

    chat_id = update.effective_chat.id
    loop = asyncio.get_running_loop()
    reply, _meta = await loop.run_in_executor(
        None, run_commandcode, _draft_prompt(item),
        {"chatId": chat_id, "messageId": update.message.message_id if update.message else None, "messageText": text},
    )

    name = _parse_plan_name(reply, item)
    with _pending_plans_lock:
        _pending_plans[chat_id] = {"name": name, "draft": reply}
    await _reply(
        update,
        f"{reply}\n\n—\nReply `confirm` to save this plan to `{PLANS_DIR / name}.md`, or `cancel` to discard.",
        reply_markup=_plan_markup(chat_id),
    )


async def _plan_save(update: Update, chat_id: int) -> None:
    """Confirm-and-save a pending plan draft. Shared by text + button paths."""
    with _pending_plans_lock:
        pending = _pending_plans.get(chat_id)

    if not pending:
        await _reply(update, "No pending plan — send `/plan <item>` first.")
        return

    name, draft = pending["name"], pending["draft"]
    if not ALLOW_WRITES:
        await _reply(
            update,
            "Write access is off (`ALLOW_WRITES=false`) — enable it to save plans. "
            "Your draft is still pending; reply `cancel` to discard it.",
        )
        return

    loop = asyncio.get_running_loop()
    reply, meta = await loop.run_in_executor(
        None, run_commandcode, _write_prompt(name, draft),
        {"chatId": chat_id, "messageId": None, "messageText": "confirm plan save"},
    )

    if meta.get("subtype") == "error" or "CommandCode error" in reply:
        await _reply(update, f"Failed to save the plan: {reply}")
        return

    with _pending_plans_lock:
        _pending_plans.pop(chat_id, None)
    await _reply(update, f"Plan saved to `{PLANS_DIR / name}.md`.\n\n{reply}")


async def _plan_cancel(update: Update, chat_id: int) -> None:
    """Discard a pending plan draft. Shared by text + button paths."""
    with _pending_plans_lock:
        had = chat_id in _pending_plans
        _pending_plans.pop(chat_id, None)
    if had:
        await _reply(update, "Plan cancelled.")
    else:
        await _reply(update, "No pending plan — send `/plan <item>` first.")


async def handle_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = (update.message.text if update.message else "") or ""
    chat_id = update.effective_chat.id
    word = text.strip().lower().split(None, 1)[0] if text.strip() else ""

    if word == "cancel":
        await _plan_cancel(update, chat_id)
    else:
        await _plan_save(update, chat_id)


async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Route inline-button taps to the matching action."""
    query = update.callback_query
    if query is None:
        return
    data = query.data or ""
    parts = data.split(":", 2)
    if len(parts) < 3:
        await query.answer()
        return
    kind, action, chat_id_str = parts
    try:
        chat_id = int(chat_id_str)
    except ValueError:
        await query.answer()
        return

    # allowlist guard (same as handle_message)
    if ALLOWED_CHAT_IDS and chat_id not in ALLOWED_CHAT_IDS:
        print(f"[callback] ignored from unlisted chat_id={chat_id}: {data}")
        await query.answer()
        return

    # answer immediately so the button stops spinning
    await query.answer()

    # callback queries carry no update.message — build a minimal stand-in for _reply
    class _CbMsg:
        def __init__(self, chat):
            self.chat = chat
        async def reply_text(self, text, **kw):
            return await query.message.reply_text(text, **kw)

    class _CbUpdate:
        def __init__(self, chat):
            self.message = _CbMsg(chat)
        @property
        def effective_chat(self):
            return self.message.chat

    msg = _CbUpdate(query.message.chat)

    if kind == "plan":
        if action == "confirm":
            await _plan_save(msg, chat_id)
        elif action == "cancel":
            await _plan_cancel(msg, chat_id)
        return

    if kind == "act":
        if action == "continue":
            loop = asyncio.get_running_loop()
            reply, _meta = await loop.run_in_executor(
                None, run_commandcode, "Continue — keep going from where you left off.",
                {"chatId": chat_id, "messageId": None, "messageText": "continue"},
            )
            await _reply(msg, reply, reply_markup=_quick_actions_markup(chat_id))
        elif action == "terminal":
            session_id = _get_chat_session(chat_id)
            if session_id:
                await _reply(
                    msg,
                    f"To open this conversation in a terminal on your PC, use the "
                    f"**Open terminal** button on the monitor page "
                    f"(session `{session_id}`).",
                )
            else:
                await _reply(msg, "No session known for this chat yet — send a message first.")
        elif action == "newplan":
            await _reply(msg, "Usage: /plan <what to plan>\nExample: /plan add a sponsor dashboard")
        elif action == "status":
            session_id = _get_chat_session(chat_id)
            await _reply(msg, f"Chat {chat_id} — last session: `{session_id or 'none'}`.")


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    text = update.message.text if update.message else None

    if ALLOWED_CHAT_IDS and chat_id not in ALLOWED_CHAT_IDS:
        print(f"[blocked] message from unlisted chat_id={chat_id}: {text!r}")
        return

    if not ALLOWED_CHAT_IDS:
        print(f"[discovery] message from chat_id={chat_id} — add this id to ALLOWED_CHAT_IDS")

    if not text:
        return

    # Typing indicator is cosmetic — never let it block the real reply.
    try:
        await update.message.chat.send_action("typing")
    except NetworkError as exc:
        print(f"[network] typing indicator failed, continuing anyway: {exc}")

    loop = asyncio.get_running_loop()
    tg = {
        "chatId": chat_id,
        "messageId": update.message.message_id if update.message else None,
        "messageText": text,
    }
    reply, _meta = await loop.run_in_executor(None, run_commandcode, text, tg)

    await _reply(update, reply, reply_markup=_quick_actions_markup(chat_id))


def _handle_sigint(signum, frame) -> None:
    """Kill any in-flight command-code subprocess, then hard-exit.

    This runs even while a blocking subprocess.Popen().communicate() call is
    executing in a worker thread, which is why it's a real OS signal handler
    rather than relying on asyncio/PTB's own shutdown path — that path only
    gets a chance to run once the executor thread returns, so without this
    Ctrl+C would appear to "hang" until the current command-code call finishes.
    """
    print("\nCtrl+C received — stopping bridge...")
    with _active_process_lock:
        proc = _active_process
    if proc is not None and proc.poll() is None:
        print("Killing in-flight command-code process...")
        _kill_process_tree(proc)
    # os._exit skips normal interpreter cleanup (fine here — we're not
    # holding anything that needs a graceful close) and guarantees the
    # process actually terminates instead of hanging on thread/event-loop
    # shutdown.
    os._exit(0)


def main() -> None:
    if TELEGRAM_BOT_TOKEN == "PASTE_YOUR_BOT_TOKEN_HERE":
        raise SystemExit("Set TELEGRAM_BOT_TOKEN (env var or in this file) before running.")

    if not WORKDIR.is_dir():
        raise SystemExit(
            f"WORKDIR does not exist: {WORKDIR}\n"
            "Set COMMANDCODE_WORKDIR to an existing project directory before running."
        )

    signal.signal(signal.SIGINT, _handle_sigint)
    if hasattr(signal, "SIGBREAK"):  # Windows: Ctrl+Break, sent by some terminals
        signal.signal(signal.SIGBREAK, _handle_sigint)

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("plan", cmd_plan))
    app.add_handler(MessageHandler(filters.Regex(re.compile(r"^(confirm|cancel)\b", re.I)), handle_confirm))
    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    _load_chat_sessions()

    # The outbox poller runs in its own thread with its own event loop so it
    # never disturbs the loop that PTB's run_polling() creates in this thread.
    # Bind the loop only inside the thread — setting it in the main thread here
    # would make run_polling() fail with "event loop is already running".
    poller_loop = asyncio.new_event_loop()

    def _run_poller():
        asyncio.set_event_loop(poller_loop)
        poller_loop.create_task(_outbox_poller(app))
        try:
            poller_loop.run_forever()
        finally:
            poller_loop.close()

    poller_thread = threading.Thread(target=_run_poller, daemon=True)
    poller_thread.start()

    print("CommandCode <-> Telegram bridge running. Ctrl+C to stop.")
    print(f"WORKDIR: {WORKDIR}")
    print(f"ALLOW_WRITES: {ALLOW_WRITES}")
    print(f"Outbox: {OUTBOX_FILE}")
    if not ALLOWED_CHAT_IDS:
        print("No ALLOWED_CHAT_IDS set — message the bot once to discover your chat id.")

    try:
        app.run_polling(stop_signals=None, bootstrap_retries=-1)
    except (KeyboardInterrupt, SystemExit):
        pass


if __name__ == "__main__":
    main()