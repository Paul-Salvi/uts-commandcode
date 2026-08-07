// Command Code Activity Monitor — collector mod.
//
// Pure observer: subscribes to the AgentEvent stream (cmd.on) and forwards a
// curated subset to the monitor server's ingest endpoint. Never mutates state,
// never blocks tools. A throw in any handler only becomes a mod_error event —
// it can never crash a session.
//
// Install: copy this file to ~/.commandcode/mods/commandcode-monitor.ts
// (personal mods dir). It loads on the next session start.
//
// Config (env vars):
//   MONITOR_INGEST_URL  default http://localhost:8787/ingest
//   MONITOR_BATCH_MS    default 500  (batch window before a POST)
//
// The server: see monitor/server.mjs in this repo.

import type { ModApi } from "@commandcode/harness";
import { spawnSync } from "node:child_process";

const INGEST_URL =
	process.env.MONITOR_INGEST_URL ?? "http://localhost:8787/ingest";
const BATCH_MS = Number(process.env.MONITOR_BATCH_MS ?? 500);

export default function (cmd: ModApi): void {
	const project = process.cwd();
	let sessionId: string | null = null;
	let turnNumber: number | null = null;
	let currentModel: string | null = null;

	// ---- batching: queue events, flush on a timer, retry on failure ----
	const queue: Array<Record<string, unknown>> = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	let flushing = false;

	function flush() {
		timer = null;
		if (queue.length === 0) return;
		const batch = queue.splice(0, queue.length);
		flushing = true;
		fetch(INGEST_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(batch),
		})
			.catch(() => {
				// Server down or transient failure: put the batch back and
				// retry shortly. Never throw into the session.
				queue.unshift(...batch);
				timer = setTimeout(flush, Math.max(BATCH_MS, 2000));
			})
			.finally(() => {
				flushing = false;
				if (!timer && queue.length > 0) {
					timer = setTimeout(flush, BATCH_MS);
				}
			});
	}

	function enqueue(type: string, data: Record<string, unknown>): void {
		queue.push({
			ts: new Date().toISOString(),
			sessionId,
			turnNumber,
			model: currentModel,
			project,
			type,
			data,
		});
		if (timer == null && !flushing) {
			timer = setTimeout(flush, BATCH_MS);
		}
	}

	// ---- event subscriptions ----
	cmd.on("run_start", (e) => {
		sessionId = e.sessionId ?? null;
		turnNumber = null;
		currentModel = null;
		enqueue("run_start", { sessionId: e.sessionId });
	});

	cmd.on("run_end", (e) => {
		enqueue("run_end", {
			stopReason: e.result?.stopReason ?? null,
			turnCount: e.result?.turnCount ?? null,
		});
	});

	cmd.on("turn_start", (e) => {
		turnNumber = e.turnNumber ?? null;
		enqueue("turn_start", { turnNumber: e.turnNumber });
	});

	cmd.on("turn_end", (e) => {
		enqueue("turn_end", {
			turnNumber: e.turnNumber,
			hadToolCalls: e.hadToolCalls ?? null,
			usage: e.usage ?? null,
		});
	});

	cmd.on("model_request_start", (e) => {
		currentModel = e.model ?? null;
		enqueue("model_request_start", { model: e.model });
	});

	cmd.on("model_request_end", (e) => {
		enqueue("model_request_end", {
			model: e.model,
			usage: e.usage ?? null,
			stopReason: e.stopReason ?? null,
		});
	});

	cmd.on("tool_queued", (e) => {
		enqueue("tool_queued", {
			toolName: e.toolName,
			input: e.input,
		});
	});

	cmd.on("tool_running", (e) => {
		enqueue("tool_running", {
			toolName: e.toolName,
			description: e.description ?? null,
		});
	});

	cmd.on("tool_completed", (e) => {
		enqueue("tool_completed", {
			toolName: e.toolName,
			result: truncate(e.result, 2000),
		});
	});

	cmd.on("tool_errored", (e) => {
		enqueue("tool_errored", {
			toolName: e.toolName,
			error: truncate(e.error ?? e.result, 2000),
		});
	});

	cmd.on("tool_denied", (e) => {
		enqueue("tool_denied", {
			toolName: e.toolName,
			reason: truncate(e.reason ?? e.error ?? null, 1000),
		});
	});

	cmd.on("tool_hook_blocked", (e) => {
		enqueue("tool_hook_blocked", {
			toolName: e.toolName,
			hookOutput: truncate(e.hookOutput, 1000),
		});
	});

	cmd.on("subagent_start", (e) => {
		enqueue("subagent_start", {
			toolCallId: e.toolCallId,
			subagentType: e.subagentType,
		});
	});

	cmd.on("subagent_progress", (e) => {
		enqueue("subagent_progress", {
			toolCallId: e.toolCallId,
			subagentType: e.subagentType,
			toolName: e.toolName,
			toolInput: truncate(e.toolInput, 1000),
		});
	});

	cmd.on("subagent_stop", (e) => {
		enqueue("subagent_stop", {
			toolCallId: e.toolCallId,
			subagentType: e.subagentType,
			tokensUsed: e.tokensUsed ?? null,
		});
	});

	cmd.on("notice", (e) => {
		enqueue("notice", { level: e.level, message: e.message });
	});

	cmd.on("run_error", (e) => {
		enqueue("run_error", { error: truncate(e.error, 2000) });
	});

	cmd.on("interrupted", () => {
		enqueue("interrupted", {});
	});

	cmd.on("permission_mode_changed", (e) => {
		enqueue("permission_mode_changed", { mode: e.mode });
	});

	// Flush whatever is left when the process is winding down. Async fetch can't
	// complete inside process.on("exit"), so spawn a tiny node child and block
	// until the POST lands — this covers the trailing events of a session.
	function syncFlush() {
		if (queue.length === 0) return;
		const batch = queue.splice(0, queue.length);
		const script = `
			let d = "";
			process.stdin.on("data", (c) => (d += c));
			process.stdin.on("end", () => {
				fetch(process.env.MONITOR_INGEST_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: d,
				})
					.then(() => process.exit(0))
					.catch(() => process.exit(1));
			});
		`;
		try {
			spawnSync(process.execPath, ["-e", script], {
				input: JSON.stringify(batch),
				env: { ...process.env, MONITOR_INGEST_URL: INGEST_URL },
				timeout: 5000,
				stdio: ["pipe", "ignore", "ignore"],
			});
		} catch {
			// best-effort on exit; nothing more we can do
		}
	}

	try {
		process.on("exit", () => {
			if (timer != null) clearTimeout(timer);
			syncFlush();
		});
	} catch {
		// never let a mod bug break the session exit
	}
}
function truncate(value: unknown, max: number): unknown {
	if (typeof value !== "string") return value;
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

