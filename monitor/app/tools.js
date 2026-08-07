// Tool calls insight page — counts of tool_completed / tool_errored / tool_denied.
"use strict";

const MAX_EVENTS = 2000;
const state = { events: [], lastId: 0 };

const byToolEl = document.querySelector("#byTool tbody");
const bySessionEl = document.querySelector("#bySession tbody");
const summaryEl = document.getElementById("summary");

function ingest(records) {
  let changed = false;
  for (const r of records) {
    if (!r || !r.id) continue;
    if (r.id > state.lastId) state.lastId = r.id;
    if (state.events.some((e) => e.id === r.id)) continue;
    state.events.unshift(r);
    changed = true;
  }
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
  if (changed) render();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "`": "&#x60;" })[c]);
}

function shortId(id) {
  const s = String(id);
  return s.length > 12 ? s.slice(0, 12) + "…" : s;
}

function toolEvents() {
  return state.events.filter((e) => e.type === "tool_completed" || e.type === "tool_errored" || e.type === "tool_denied");
}

function render() {
  const evs = toolEvents();
  const total = evs.length;
  const failed = evs.filter((e) => e.type === "tool_errored").length;
  const denied = evs.filter((e) => e.type === "tool_denied").length;
  summaryEl.innerHTML =
    `<span class="metric-big">${total}</span> <span class="metric-cap">calls · ${failed} failed · ${denied} denied</span>`;

  const byTool = new Map();
  for (const e of evs) {
    const tool = (e.data && e.data.toolName) || "unknown";
    const cur = byTool.get(tool) || { ok: 0, err: 0 };
    if (e.type === "tool_errored") cur.err++;
    else cur.ok++;
    byTool.set(tool, cur);
  }
  byToolEl.innerHTML = "";
  const sorted = [...byTool.entries()].sort((a, b) => (b[1].ok + b[1].err) - (a[1].ok + a[1].err));
  for (const [tool, c] of sorted) {
    const totalN = c.ok + c.err;
    const pct = totalN ? Math.round((c.err / totalN) * 100) : 0;
    byToolEl.innerHTML += `<tr><td>${esc(tool)}</td><td class="num">${totalN}</td><td class="num">${c.err}</td><td class="num">${pct}%</td></tr>`;
  }

  const bySession = new Map();
  for (const e of evs) {
    const s = e.sessionId || "unknown";
    bySession.set(s, (bySession.get(s) || 0) + 1);
  }
  bySessionEl.innerHTML = "";
  for (const [s, n] of [...bySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    bySessionEl.innerHTML += `<tr><td class="mono">${esc(shortId(s))}</td><td class="num">${n}</td></tr>`;
  }
}

async function loadInitial() {
  try {
    const res = await fetch("/api/events?limit=1000");
    const data = await res.json();
    ingest(data.events || []);
  } catch { /* SSE will populate */ }
}

function connectStream() {
  const es = new EventSource("/api/stream");
  es.onmessage = (msg) => { try { ingest([JSON.parse(msg.data)]); } catch { /* bad frame */ } };
}

(async () => {
  await loadInitial();
  connectStream();
  render();
})();
