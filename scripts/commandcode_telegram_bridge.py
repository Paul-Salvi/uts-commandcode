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
import shutil
import signal
import subprocess
import threading
from pathlib import Path

from telegram import Update
from telegram.error import NetworkError
from telegram.ext import Application, MessageHandler, ContextTypes, filters

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
WORKDIR = Path(os.environ.get("COMMANDCODE_WORKDIR", r"C:\path\to\your\project"))

# Set True to allow CommandCode to write files / run shell commands from
# Telegram-triggered messages. Off by default for safety.
ALLOW_WRITES = os.environ.get("COMMANDCODE_ALLOW_WRITES", "false").lower() == "true"

# Max turns per headless call.
MAX_TURNS = int(os.environ.get("COMMANDCODE_MAX_TURNS", "40"))

TELEGRAM_MSG_LIMIT = 4000  # stay under Telegram's 4096 char cap with margin

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


def _run_once(prompt: str, use_continue: bool):
    """Run a single command-code invocation. Returns (final_text, error_text, raw_stdout, raw_stderr)."""
    cmd = ["command-code", "-p", prompt]
    if use_continue:
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
            shell=on_windows,
        )
    except FileNotFoundError:
        return None, (
            "Could not find the `command-code` executable. Make sure it's "
            "installed globally (`npm i -g command-code`) and on PATH."
        ), "", ""

    with _active_process_lock:
        _active_process = proc

    try:
        stdout, stderr = proc.communicate(timeout=600)
    except subprocess.TimeoutExpired:
        _kill_process_tree(proc)
        proc.communicate()
        return None, "CommandCode timed out after 10 minutes.", "", ""
    finally:
        with _active_process_lock:
            _active_process = None

    if proc.returncode in (-signal.SIGTERM, -signal.SIGINT):
        return None, "(cancelled — bridge was stopped)", stdout, stderr

    final_text = None
    error_text = None
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except json.JSONDecodeError:
            continue
        if frame.get("type") == "result":
            final_text = frame.get("finalText")
            if frame.get("subtype") == "error":
                error_text = frame.get("error")

    return final_text, error_text, stdout, stderr


def run_commandcode(prompt: str) -> str:
    """Run CommandCode headlessly against WORKDIR and return the final text.

    Tries --continue first (to keep conversation context). If no session
    exists yet in WORKDIR, command-code's CLI rejects --continue with
    "too many arguments" instead of just starting fresh — so on that
    specific failure we transparently retry once without --continue.
    """
    resolved = shutil.which("command-code")
    if resolved is None:
        return (
            "Could not find the `command-code` executable on PATH. "
            "Confirm `command-code --version` works in a normal terminal, "
            "and that this script's Python process was launched from a "
            "terminal with the same PATH (a fresh terminal after installing "
            "usually fixes this — PATH changes don't apply to already-open "
            "windows)."
        )

    final_text, error_text, stdout, stderr = _run_once(prompt, use_continue=True)

    no_session_yet = (
        final_text is None
        and error_text is None
        and "too many arguments" in ((stderr or "") + (stdout or "")).lower()
    )
    if no_session_yet:
        print("[commandcode] no existing session in WORKDIR yet — retrying without --continue")
        final_text, error_text, stdout, stderr = _run_once(prompt, use_continue=False)

    if error_text:
        return f"CommandCode error: {error_text}"
    if final_text:
        return final_text
    return stderr.strip() or stdout.strip() or "(no output)"


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
    reply = await loop.run_in_executor(None, run_commandcode, text)

    for i in range(0, len(reply), TELEGRAM_MSG_LIMIT):
        chunk = reply[i:i + TELEGRAM_MSG_LIMIT]
        try:
            await _retry_network_call(lambda c=chunk: update.message.reply_text(c))
        except NetworkError as exc:
            print(f"[network] giving up sending a reply chunk: {exc}")


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

    signal.signal(signal.SIGINT, _handle_sigint)
    if hasattr(signal, "SIGBREAK"):  # Windows: Ctrl+Break, sent by some terminals
        signal.signal(signal.SIGBREAK, _handle_sigint)

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    print("CommandCode <-> Telegram bridge running. Ctrl+C to stop.")
    print(f"WORKDIR: {WORKDIR}")
    print(f"ALLOW_WRITES: {ALLOW_WRITES}")
    if not ALLOWED_CHAT_IDS:
        print("No ALLOWED_CHAT_IDS set — message the bot once to discover your chat id.")

    try:
        app.run_polling(stop_signals=None, bootstrap_retries=-1)
    except (KeyboardInterrupt, SystemExit):
        pass


if __name__ == "__main__":
    main()