// Tokens insight page — model_request_end usage totals per model / session.
"use strict";

const MAX_EVENTS = 2000;
const state = { events: [], lastId: 0 };

const byModelEl = document.querySelector("#byModel tbody");
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

function formatNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n ?? 0);
}

function usageOf(e) {
  const u = (e.data && e.data.usage) || {};
  const i = u.inputTokens ?? u.input ?? u.prompt ?? u.promptTokens ?? 0;
  const o = u.outputTokens ?? u.output ?? u.completion ?? u.completionTokens ?? 0;
  return { in: Number(i) || 0, out: Number(o) || 0 };
}

function render() {
  const evs = state.events.filter((e) => e.type === "model_request_end");
  let totIn = 0, totOut = 0;
  const byModel = new Map();
  const bySession = new Map();
  for (const e of evs) {
    const u = usageOf(e);
    totIn += u.in;
    totOut += u.out;
    const model = e.model || "unknown";
    const m = byModel.get(model) || { in: 0, out: 0 };
    m.in += u.in; m.out += u.out;
    byModel.set(model, m);
    const s = e.sessionId || "unknown";
    const sAcc = bySession.get(s) || { in: 0, out: 0 };
    sAcc.in += u.in; sAcc.out += u.out;
    bySession.set(s, sAcc);
  }
  summaryEl.innerHTML =
    `<span class="metric-big">${formatNum(totIn + totOut)}</span> ` +
    `<span class="metric-cap">tokens · ${formatNum(totIn)} in / ${formatNum(totOut)} out</span>`;

  byModelEl.innerHTML = "";
  const sortedM = [...byModel.entries()].sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out));
  for (const [model, c] of sortedM) {
    byModelEl.innerHTML += `<tr><td>${esc(model)}</td><td class="num">${formatNum(c.in)}</td><td class="num">${formatNum(c.out)}</td><td class="num">${formatNum(c.in + c.out)}</td></tr>`;
  }

  bySessionEl.innerHTML = "";
  const sortedS = [...bySession.entries()].sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out)).slice(0, 20);
  for (const [s, c] of sortedS) {
    bySessionEl.innerHTML += `<tr><td class="mono">${esc(shortId(s))}</td><td class="num">${formatNum(c.in + c.out)}</td></tr>`;
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
