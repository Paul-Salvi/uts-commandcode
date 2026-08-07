// Errors insight page — breakdown of tool_errored / run_error events.
"use strict";

const MAX_EVENTS = 2000;
const state = { events: [], lastId: 0 };

const byToolEl = document.querySelector("#byTool tbody");
const bySessionEl = document.querySelector("#bySession tbody");
const recentEl = document.getElementById("recent");
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

function timeStr(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], { hour12: false });
}

function shortId(id) {
  const s = String(id);
  return s.length > 12 ? s.slice(0, 12) + "…" : s;
}

function errorEvents() {
  return state.events.filter((e) => e.type === "tool_errored" || e.type === "run_error");
}

function errorText(e) {
  const d = e.data || {};
  if (e.type === "run_error") return d.error || "run error";
  return d.error || d.result || "tool error";
}

function render() {
  const errs = errorEvents();
  summaryEl.innerHTML = `<span class="metric-big">${errs.length}</span> <span class="metric-cap">total errors</span>`;

  // by tool
  const byTool = new Map();
  for (const e of errs) {
    const tool = (e.data && e.data.toolName) || "unknown";
    byTool.set(tool, (byTool.get(tool) || 0) + 1);
  }
  byToolEl.innerHTML = "";
  for (const [tool, n] of [...byTool.entries()].sort((a, b) => b[1] - a[1])) {
    byToolEl.innerHTML += `<tr><td>${esc(tool)}</td><td class="num">${n}</td></tr>`;
  }

  // by session
  const bySession = new Map();
  for (const e of errs) {
    const s = e.sessionId || "unknown";
    bySession.set(s, (bySession.get(s) || 0) + 1);
  }
  bySessionEl.innerHTML = "";
  for (const [s, n] of [...bySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    bySessionEl.innerHTML += `<tr><td class="mono">${esc(shortId(s))}</td><td class="num">${n}</td></tr>`;
  }

  // recent errors
  recentEl.innerHTML = "";
  const recent = errs.slice(0, 50);
  if (recent.length === 0) {
    recentEl.innerHTML = `<div class="empty">No errors yet.</div>`;
    return;
  }
  for (const e of recent) {
    const row = document.createElement("div");
    row.className = "metric-item";
    const tool = (e.data && e.data.toolName) || "run";
    row.innerHTML = `<span class="when">${timeStr(e.ts)}</span>` +
      `<span class="badge">${esc(tool)}</span>` +
      `<span class="metric-item-text">${esc(errorText(e))}</span>`;
    recentEl.appendChild(row);
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
