// Command Code Activity Monitor — server.
//
// Tiny zero-dependency Node HTTP server:
//   POST /ingest         collector mod posts batched events here
//   GET  /api/events     recent events (limit, since=id) for initial load
//   GET  /api/summary    aggregate tiles
//   GET  /api/stream     SSE live feed
//   GET  /               the dashboard UI
//
// Events append to data/events.jsonl (created on first write).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const OUTBOX_FILE = path.join(DATA_DIR, "outbox.jsonl");
const APP_DIR = path.join(__dirname, "app");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
// Size cap for the event log (bytes). Tunable via env; 0 disables rotation.
const MAX_LOG_BYTES = Number(process.env.MONITOR_MAX_LOG_BYTES ?? 50 * 1024 * 1024);
// Shared token that gates the dashboard + telegram pages when set.
// Empty (default) = no auth, localhost-only behavior unchanged.
const PAGE_TOKEN = process.env.MONITOR_PAGE_TOKEN ?? "";
// A telegram message that started but never ended is "running" only while it's
// recent. Past this age (bridge timeout 10min + margin) it's stale — the bridge
// crashed/restarted mid-run — and is not counted as running. 0 disables.
const TELEGRAM_STALE_MS = Number(process.env.MONITOR_TELEGRAM_STALE_MS ?? 15 * 60 * 1000);
// Working directory for the "open terminal" action (matches the bridge's
// WORKDIR). Defaults to the repo root where the monitor lives.
const WORKDIR = process.env.COMMANDCODE_WORKDIR ?? __dirname.replace(/\\monitor$/, "");

// ---- state ----
const sseClients = new Set();
let nextId = 1;

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, "");
if (!fs.existsSync(OUTBOX_FILE)) fs.writeFileSync(OUTBOX_FILE, "");

// Seed nextId from the last line of the log so restarts keep ids monotonic.
function seedNextId() {
	try {
		const stat = fs.statSync(EVENTS_FILE);
		if (stat.size === 0) return;
		const fd = fs.openSync(EVENTS_FILE, "r");
		const buf = Buffer.alloc(Math.min(stat.size, 4096));
		fs.readSync(fd, buf, 0, buf.length, Math.max(0, stat.size - buf.length));
		fs.closeSync(fd);
		const text = buf.toString("utf8");
		const lastLine = text.trim().split("\n").pop();
		if (!lastLine) return;
		const parsed = JSON.parse(lastLine);
		if (Number.isInteger(parsed?.id)) nextId = parsed.id + 1;
	} catch {
		// not fatal — ids restart at 1 if the log is unreadable
	}
}
seedNextId();

// ---- helpers ----
function readEvents() {
	try {
		const text = fs.readFileSync(EVENTS_FILE, "utf8");
		return text
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => { try { return JSON.parse(l); } catch { return null; } })
			.filter((e) => e !== null);
	} catch {
		return [];
	}
}

function writeEvent(event) {
	fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n");
}

// ---- auth (optional token gate) ----
// When PAGE_TOKEN is set, every GET UI/API route requires it. Accepted via:
//   - HttpOnly cookie `monitor_token` (set after ?token= or POST /api/telegram/auth)
//   - `Authorization: Bearer <token>`
//   - `?token=<token>` (bootstrap: sets the cookie, then 302s)
// POST /ingest stays open — local collector mod + bridge post to it.
function tokenMatches(candidate) {
	if (!PAGE_TOKEN || !candidate) return false;
	const a = Buffer.from(String(candidate));
	const b = Buffer.from(PAGE_TOKEN);
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

function cookieToken(req) {
	const header = req.headers.cookie ?? "";
	for (const part of header.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === "monitor_token") return decodeURIComponent(v.join("="));
	}
	return null;
}

function bearerToken(req) {
	const auth = req.headers.authorization ?? "";
	const m = /^Bearer\s+(.+)$/i.exec(auth);
	return m ? m[1].trim() : null;
}

function isAuthed(req, url) {
	return (
		!PAGE_TOKEN ||
		tokenMatches(cookieToken(req)) ||
		tokenMatches(bearerToken(req)) ||
		tokenMatches(url.searchParams.get("token"))
	);
}

function setTokenCookie(res) {
	res.setHeader(
		"Set-Cookie",
		`monitor_token=${encodeURIComponent(PAGE_TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`
	);
}

function sendJson(res, status, obj) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(obj));
}

// ---- outbox (commands for the telegram bridge) ----
function appendOutbox(line) {
	fs.appendFileSync(OUTBOX_FILE, JSON.stringify(line) + "\n");
}

function appendEventAndBroadcast(type, data) {
	const record = {
		id: nextId++,
		ts: new Date().toISOString(),
		sessionId: data.sessionId ?? null,
		turnNumber: null,
		model: null,
		project: null,
		type,
		data,
	};
	writeEvent(record);
	trimLog();
	for (const sse of sseClients) {
		try { sse.write(`data: ${JSON.stringify(record)}\n\n`); } catch { /* client gone */ }
	}
	return record;
}

// Keep the event log bounded: once it exceeds MAX_LOG_BYTES, drop the oldest
// lines until it fits (keeping the newest ~90% under the cap). Ids are never
// renumbered, so /api/events?since= and SSE clients that track lastId stay
// consistent — a client reconnecting with a `since` older than the trimmed
// start simply gets everything from the trimmed start and dedupes by id.
function trimLog() {
	if (!MAX_LOG_BYTES || MAX_LOG_BYTES <= 0) return;
	try {
		const stat = fs.statSync(EVENTS_FILE);
		if (stat.size <= MAX_LOG_BYTES) return;
		const lines = readEvents().map((e) => JSON.stringify(e));
		let total = lines.reduce((n, l) => n + l.length + 1, 0);
		while (lines.length > 1 && total > MAX_LOG_BYTES) {
			total -= lines[0].length + 1;
			lines.shift();
		}
		if (lines.length) {
			fs.writeFileSync(EVENTS_FILE, lines.join("\n") + "\n");
		} else {
			fs.writeFileSync(EVENTS_FILE, "");
		}
	} catch (err) {
		// never fatal — a malformed log or IO error just skips this rotation
		console.error("[monitor] log trim failed:", err.message ?? err);
	}
}

function sumTokens(usage) {
	if (!usage || typeof usage !== "object") return 0;
	// Common shapes: {inputTokens, outputTokens} or {input, output} or {prompt, completion}
	const i = usage.inputTokens ?? usage.input ?? usage.prompt ?? usage.promptTokens ?? 0;
	const o = usage.outputTokens ?? usage.output ?? usage.completion ?? usage.completionTokens ?? 0;
	return (Number(i) || 0) + (Number(o) || 0);
}

function computeSummary() {
	const events = readEvents();
	const now = Date.now();
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);

	const activeSessions = new Set();
	const finishedSessions = new Set();
	const telegramIds = new Set();
	const telegramStarted = new Map(); // id -> start ts
	const telegramDone = new Set();
	let toolCalls = 0;
	let errors = 0;
	let subAgents = 0;
	let tokens = 0;
	let eventsToday = 0;

	for (const e of events) {
		if (e.type === "run_start") activeSessions.add(e.sessionId);
		if (e.type === "run_end") { activeSessions.delete(e.sessionId); finishedSessions.add(e.sessionId); }
		if (e.type === "tool_completed" || e.type === "tool_errored" || e.type === "tool_denied") toolCalls++;
		if (e.type === "model_request_end") tokens += sumTokens(e.data?.usage);
		if (e.type === "telegram_msg_end") {
			const id = e.data?.messageId;
			if (id != null) telegramIds.add(id);
			telegramDone.add(id);
		}
		if (e.type === "telegram_msg_start" || e.type === "telegram_msg_update") {
			const id = e.data?.messageId;
			if (id != null && !telegramStarted.has(id)) {
				telegramStarted.set(id, Date.parse(e.ts) || Date.now());
			}
		}
		const ts = Date.parse(e.ts);
		const isToday = !Number.isNaN(ts) && ts >= todayStart.getTime();
		if (isToday) {
			eventsToday++;
			// Errors and Sub-agents tiles are "today" counters (like Events today).
			if (e.type === "tool_errored" || e.type === "run_error") errors++;
			if (e.type === "subagent_start") subAgents++;
		}
	}

	// messages with a start/update but no end → currently queued/running,
	// unless the start is stale (bridge crashed/restarted mid-run).
	const nowMs = Date.now();
	const telegramRunning = [...telegramStarted.entries()].filter(([id, startTs]) =>
		!telegramDone.has(id) && (TELEGRAM_STALE_MS <= 0 || nowMs - startTs < TELEGRAM_STALE_MS)
	).length;

	return {
		activeSessions: activeSessions.size,
		finishedSessions: finishedSessions.size,
		toolCalls,
		errors,
		subAgents,
		tokens,
		eventsToday,
		telegramMsgs: telegramIds.size,
		telegramRunning,
		now: new Date().toISOString(),
	};
}

function serveFile(res, filePath, contentType) {
	fs.readFile(filePath, (err, data) => {
		if (err) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
			return;
		}
		res.writeHead(200, { "Content-Type": contentType });
		res.end(data);
	});
}

function serveLogin(res) {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Monitor login</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="login-wrap">
    <h1 class="login-title">Command Code Monitor</h1>
    <p class="login-hint">Enter the page token to continue.</p>
    <form id="loginForm" class="login-form">
      <input type="password" id="tokenInput" placeholder="token" autocomplete="off" />
      <button class="btn-ghost" type="submit">Unlock</button>
    </form>
    <p id="loginError" class="login-error" style="display:none">Wrong token.</p>
  </div>
  <script>
    document.getElementById("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = document.getElementById("tokenInput").value;
      const res = await fetch("/api/telegram/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) location.href = "/telegram";
      else document.getElementById("loginError").style.display = "block";
    });
  </script>
</body>
</html>`;
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(html);
}

// Open a detached native terminal window on this machine running
// `command-code --resume <sessionId>` in WORKDIR. The terminal outlives the
// HTTP request. Best-effort spawn; errors are logged, never thrown. Every
// child gets an error listener — an unhandled 'error' on a child would
// otherwise crash the whole server (e.g. spawn ENOENT when cmd.exe can't be
// resolved).
function spawnTerminal(sessionId) {
	const platform = process.platform;
	// Keep a reference so the listener can log without GC keeping things alive.
	let child = null;
	const onError = (err) => console.error("[monitor] spawnTerminal error:", err?.message ?? err);
	try {
		if (platform === "win32") {
			// ComSpec is the absolute path to cmd.exe, set by Windows — avoids
			// PATH resolution failures for the shell executable itself.
			const cmd = process.env.ComSpec || "cmd.exe";
			// `start` opens a new console window; `/k` keeps it open after
			// command-code exits (or is quit with exit).
			child = spawn(
				cmd,
				["/c", "start", "", "cmd", "/k", "command-code", "--resume", sessionId],
				{ detached: true, stdio: "ignore", cwd: WORKDIR }
			);
		} else if (platform === "darwin") {
			const script = `tell app "Terminal" to do script "cd '${WORKDIR}' && command-code --resume ${sessionId}"`;
			child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
		} else {
			// Linux: try a common terminal emulator; fall back to xterm.
			const cmd = `cd '${WORKDIR}' && command-code --resume ${sessionId}; exec $SHELL`;
			const term = process.env.TERMINAL || "x-terminal-emulator";
			child = spawn(term, ["-e", "bash", "-c", cmd], { detached: true, stdio: "ignore" });
		}
		if (child) {
			child.on("error", onError);
			child.unref();
		}
	} catch (err) {
		console.error("[monitor] spawnTerminal failed:", err.message ?? err);
	}
}

// ---- request routing ----
const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
	const pathname = url.pathname;

	// CORS: allow the mod (running in any project cwd) and the dashboard.
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// ?token= bootstrap for /telegram: validate, set the cookie, redirect to
	// the clean URL. Must run before the general gate, which would otherwise
	// accept the query token and serve the page without setting a cookie.
	if (pathname === "/telegram" && req.method === "GET" && tokenMatches(url.searchParams.get("token"))) {
		setTokenCookie(res);
		res.writeHead(302, { Location: "/telegram" });
		res.end();
		return;
	}

	// Token gate: when PAGE_TOKEN is set, all GET UI/API routes AND the
	// resume POST require auth. POST /ingest and POST /api/telegram/auth
	// stay open (local processes + the login flow itself).
	const needsAuth =
		req.method === "GET" ||
		(req.method === "POST" &&
			(pathname === "/api/telegram/resume" || pathname === "/api/telegram/open-terminal"));
	if (needsAuth && !isAuthed(req, url)) {
		if (pathname === "/api/telegram/status") {
			sendJson(res, 401, { authed: false });
			return;
		}
		// /telegram without auth (no valid token) → show the login form.
		if (pathname === "/telegram") {
			serveLogin(res);
			return;
		}
		sendJson(res, 401, { ok: false, error: "unauthorized" });
		return;
	}

	// ---- POST /ingest ----
	if (req.method === "POST" && pathname === "/ingest") {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			try {
				const events = JSON.parse(body);
				if (!Array.isArray(events)) throw new Error("expected array");
				const saved = [];
				for (const ev of events) {
					const record = {
						id: nextId++,
						ts: ev.ts ?? new Date().toISOString(),
						sessionId: ev.sessionId ?? null,
						turnNumber: ev.turnNumber ?? null,
						model: ev.model ?? null,
						project: ev.project ?? null,
						type: ev.type ?? "unknown",
						data: ev.data ?? {},
					};
					writeEvent(record);
					saved.push(record);
				}
				trimLog();
				for (const sse of sseClients) {
					for (const rec of saved) {
						sse.write(`data: ${JSON.stringify(rec)}\n\n`);
					}
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, count: saved.length }));
			} catch (err) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: String(err.message ?? err) }));
			}
		});
		return;
	}

	// ---- GET /api/events ----
	if (req.method === "GET" && pathname === "/api/events") {
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
		const since = Number(url.searchParams.get("since") ?? 0);
		const session = url.searchParams.get("session");
		let events = readEvents();
		if (since > 0) events = events.filter((e) => e.id > since);
		if (session) events = events.filter((e) => e.sessionId === session);
		events.reverse(); // newest first
		const sliced = events.slice(0, limit);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ events: sliced, total: events.length }));
		return;
	}

	// ---- GET /api/summary ----
	if (req.method === "GET" && pathname === "/api/summary") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(computeSummary()));
		return;
	}

	// ---- POST /api/telegram/auth ----
	if (req.method === "POST" && pathname === "/api/telegram/auth") {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			try {
				const parsed = JSON.parse(body || "{}");
				if (tokenMatches(parsed.token)) {
					setTokenCookie(res);
					sendJson(res, 200, { ok: true });
				} else {
					sendJson(res, 401, { ok: false, error: "invalid token" });
				}
			} catch {
				sendJson(res, 400, { ok: false, error: "bad request" });
			}
		});
		return;
	}

	// ---- GET /api/telegram/status ----
	if (req.method === "GET" && pathname === "/api/telegram/status") {
		sendJson(res, 200, { authed: true });
		return;
	}

	// ---- POST /api/telegram/resume ----
	if (req.method === "POST" && pathname === "/api/telegram/resume") {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			try {
				const parsed = JSON.parse(body || "{}");
				const prompt = String(parsed.prompt ?? "").trim();
				const chatId = Number(parsed.chatId);
				const sessionId = String(parsed.sessionId ?? "").trim();
				if (!prompt) return sendJson(res, 400, { ok: false, error: "prompt is required" });
				if (!Number.isInteger(chatId)) return sendJson(res, 400, { ok: false, error: "chatId must be an integer" });
				if (!/^[0-9a-f-]{20,}$/i.test(sessionId)) return sendJson(res, 400, { ok: false, error: "sessionId looks invalid" });
				// defense-in-depth: only resumable sessions seen in a telegram_msg_end may be resumed
				const known = readEvents().some((e) => e.type === "telegram_msg_end" && e.data?.sessionId === sessionId);
				if (!known) return sendJson(res, 400, { ok: false, error: "sessionId not found in telegram activity" });

				const cmdId = crypto.randomUUID();
				const data = { cmdId, chatId, sessionId, messageText: prompt, source: "web", status: "queued" };
				appendEventAndBroadcast("telegram_msg_queued", data);
				appendOutbox({ id: cmdId, ts: new Date().toISOString(), chatId, sessionId, prompt, status: "queued" });
				sendJson(res, 200, { ok: true, cmdId });
			} catch (err) {
				sendJson(res, 400, { ok: false, error: String(err.message ?? err) });
			}
		});
		return;
	}

	// ---- POST /api/telegram/open-terminal ----
	// Spawns a detached native terminal window on THIS machine (the PC the
	// monitor server runs on) running `command-code --resume <sessionId>`
	// in WORKDIR, so the conversation continues in an interactive session.
	if (req.method === "POST" && pathname === "/api/telegram/open-terminal") {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			try {
				const parsed = JSON.parse(body || "{}");
				const sessionId = String(parsed.sessionId ?? "").trim();
				if (!/^[0-9a-f-]{20,}$/i.test(sessionId)) {
					return sendJson(res, 400, { ok: false, error: "sessionId looks invalid" });
				}
				const known = readEvents().some((e) => e.type === "telegram_msg_end" && e.data?.sessionId === sessionId);
				if (!known) return sendJson(res, 400, { ok: false, error: "sessionId not found in telegram activity" });

				// probe command-code exists in this server's PATH (shell:true
				// because on Windows command-code is a .cmd shim)
				const probe = spawnSync("command-code --version", { encoding: "utf8", timeout: 5000, shell: true });
				if (probe.error || probe.status !== 0) {
					return sendJson(res, 500, { ok: false, error: "command-code not found on server PATH" });
				}

				spawnTerminal(sessionId);
				sendJson(res, 200, { ok: true });
			} catch (err) {
				sendJson(res, 500, { ok: false, error: String(err.message ?? err) });
			}
		});
		return;
	}

	// ---- GET /api/stream (SSE) ----
	if (req.method === "GET" && pathname === "/api/stream") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write(`retry: 3000\n\n`);
		sseClients.add(res);
		const heartbeat = setInterval(() => {
			try { res.write(`: ping\n\n`); } catch { /* client gone */ }
		}, 30000);
		req.on("close", () => {
			clearInterval(heartbeat);
			sseClients.delete(res);
		});
		return;
	}

	// ---- GET / (dashboard), /telegram, and static app files ----
	if (req.method === "GET") {
		let filePath;
		let contentType;
		if (pathname === "/") {
			filePath = path.join(APP_DIR, "index.html");
			contentType = "text/html; charset=utf-8";
		} else if (pathname === "/telegram") {
			filePath = path.join(APP_DIR, "telegram.html");
			contentType = "text/html; charset=utf-8";
		} else if (pathname === "/telegram.js") {
			filePath = path.join(APP_DIR, "telegram.js");
			contentType = "text/javascript; charset=utf-8";
		} else if (pathname === "/metrics/errors") {
			filePath = path.join(APP_DIR, "errors.html");
			contentType = "text/html; charset=utf-8";
		} else if (pathname === "/metrics/errors.js") {
			filePath = path.join(APP_DIR, "errors.js");
			contentType = "text/javascript; charset=utf-8";
		} else if (pathname === "/metrics/tools") {
			filePath = path.join(APP_DIR, "tools.html");
			contentType = "text/html; charset=utf-8";
		} else if (pathname === "/metrics/tools.js") {
			filePath = path.join(APP_DIR, "tools.js");
			contentType = "text/javascript; charset=utf-8";
		} else if (pathname === "/metrics/tokens") {
			filePath = path.join(APP_DIR, "tokens.html");
			contentType = "text/html; charset=utf-8";
		} else if (pathname === "/metrics/tokens.js") {
			filePath = path.join(APP_DIR, "tokens.js");
			contentType = "text/javascript; charset=utf-8";
		} else if (pathname === "/app.js") {
			filePath = path.join(APP_DIR, "app.js");
			contentType = "text/javascript; charset=utf-8";
		} else if (pathname === "/styles.css") {
			filePath = path.join(APP_DIR, "styles.css");
			contentType = "text/css; charset=utf-8";
		} else {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
			return;
		}
		serveFile(res, filePath, contentType);
		return;
	}

	res.writeHead(405, { "Content-Type": "text/plain" });
	res.end("Method not allowed");
});

server.listen(PORT, HOST, () => {
	console.log(`[monitor] dashboard at http://${HOST}:${PORT}`);
	console.log(`[monitor] ingest at http://${HOST}:${PORT}/ingest`);
	console.log(`[monitor] events log: ${EVENTS_FILE}`);
});

server.on("error", (err) => {
	console.error("[monitor] server error:", err.message);
	process.exit(1);
});

