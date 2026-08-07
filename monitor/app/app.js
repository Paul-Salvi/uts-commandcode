// Command Code Activity Monitor — dashboard frontend.
// Loads recent events, opens an SSE stream for live updates, renders summary
// tiles + a filterable feed. No framework, no build step.

"use strict";

const MAX_FEED = 500;
const feedEl = document.getElementById("feed");
const feedCountEl = document.getElementById("feedCount");
const sessionFilterEl = document.getElementById("sessionFilter");
const typeFiltersEl = document.getElementById("typeFilters");
const connEl = document.getElementById("conn");

const state = {
  events: [],            // all events we know about (newest first)
  sessions: [],          // session ids seen, for the dropdown
  types: [],             // event types seen, for the checkboxes
  activeSession: "",
  activeTypes: new Set(),// empty = all
  lastId: 0,
};

// ---- summary tiles ----
async function refreshSummary() {
  try {
    const res = await fetch("/api/summary");
    const s = await res.json();
    setTile("t-active", s.activeSessions);
    setTile("t-tools", s.toolCalls);
    setTile("t-errors", s.errors, s.errors > 0 ? "danger" : "");
    setTile("t-subagents", s.subAgents);
    setTile("t-tokens", formatNum(s.tokens));
    setTile("t-today", s.eventsToday);
    setTile("t-telegram", s.telegramMsgs ?? 0);
    setTile("t-telegram-running", s.telegramRunning ?? 0, s.telegramRunning > 0 ? "warn" : "");
  } catch {
    // server briefly down; retry on next poll
  }
}

function setTile(id, value, extraClass) {
  const el = document.getElementById(id);
  if (!el) return;
  // preserve any link wrapper (clickable tile value)
  const target = el.querySelector("a") || el;
  target.textContent = value ?? "–";
  el.className = "tile-value" + (extraClass ? " " + extraClass : "");
}

function formatNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n ?? 0);
}


// ---- event ingestion ----
function ingest(records) {
  for (const r of records) {
    if (!r || !r.id) continue;
    if (r.id > state.lastId) state.lastId = r.id;
    // dedupe (SSE + initial load can overlap)
    if (state.events.some((e) => e.id === r.id)) continue;
    state.events.unshift(r);
    if (r.sessionId && !state.sessions.includes(r.sessionId)) {
      state.sessions.push(r.sessionId);
      addSessionOption(r.sessionId);
    }
    if (r.type && !state.types.includes(r.type)) {
      state.types.push(r.type);
      addTypeFilter(r.type);
    }
  }
  if (state.events.length > MAX_FEED) {
    state.events.length = MAX_FEED;
  }
  render();
  renderTelegram();
}

async function loadInitial() {
  try {
    const res = await fetch("/api/events?limit=200");
    const data = await res.json();
    ingest(data.events || []);
  } catch {
    // server down — SSE onerror will show disconnected state
  }
}

function addSessionOption(id) {
  const opt = document.createElement("option");
  opt.value = id;
  opt.textContent = id.length > 40 ? id.slice(0, 40) + "…" : id;
  sessionFilterEl.appendChild(opt);
}

function addTypeFilter(type) {
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.value = type;
  cb.checked = true;
  cb.addEventListener("change", () => {
    if (cb.checked) state.activeTypes.delete(type);
    else state.activeTypes.add(type);
    render();
  });
  label.appendChild(cb);
  label.appendChild(document.createTextNode(type));
  typeFiltersEl.appendChild(label);
  // seed the "checked" class
  label.className = "checked";
}


// ---- rendering ----
function visibleEvents() {
  if (state.activeSession && state.activeTypes.size > 0) {
    return state.events.filter((e) => e.sessionId === state.activeSession && !state.activeTypes.has(e.type));
  }
  if (state.activeSession) return state.events.filter((e) => e.sessionId === state.activeSession);
  if (state.activeTypes.size > 0) return state.events.filter((e) => !state.activeTypes.has(e.type));
  return state.events;
}

function render() {
  const list = visibleEvents();
  const stick = shouldStickBottom();
  feedEl.innerHTML = "";
  if (list.length === 0) {
    feedEl.innerHTML = `<div class="empty">No activity yet — start a Command Code session to see events here.</div>`;
    feedCountEl.textContent = "";
    return;
  }
  const frag = document.createDocumentFragment();
  for (const ev of list.slice(0, 200)) {
    frag.appendChild(renderEvent(ev));
  }
  feedEl.appendChild(frag);
  feedCountEl.textContent = `${list.length} shown${state.activeSession || state.activeTypes.size ? " (filtered)" : ""}`;
  if (stick) feedEl.scrollTop = feedEl.scrollHeight;
}

function shouldStickBottom() {
  // stick to bottom if the user is already at/near the bottom (auto-follow)
  return feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;
}

function renderEvent(ev) {
  const el = document.createElement("div");
  el.className = "event";
  const when = timeStr(ev.ts);
  const badge = `<span class="badge ${esc(ev.type)}">${esc(ev.type)}</span>`;
  const main = esc(summarize(ev));
  const sub = esc(subDetail(ev));
  const meta = metaStr(ev);
  el.innerHTML = `<span class="when">${when}</span>${badge}<span class="summary"><span class="main">${main}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</span><span class="meta">${meta}</span>`;
  return el;
}

function timeStr(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour12: false });
}

function metaStr(ev) {
  const parts = [];
  if (ev.model) parts.push(ev.model);
  if (ev.turnNumber != null) parts.push(`t${ev.turnNumber}`);
  if (ev.project) parts.push(shortProject(ev.project));
  return parts.join(" · ");
}

function shortProject(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}


// ---- summarization ----
function summarize(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "run_start": return "Run started";
    case "run_end": return `Run ended (${d.stopReason ?? "unknown reason"})`;
    case "turn_start": return `Turn ${d.turnNumber} started`;
    case "turn_end": return `Turn ${d.turnNumber} ${d.hadToolCalls ? "used tools" : "no tool calls"}`;
    case "model_request_start": return `Model request → ${d.model ?? "?"}`;
    case "model_request_end": return `Model response ${d.model ? `(${d.model})` : ""}${usageStr(d.usage)}`;
    case "tool_queued": return `Queued: ${d.toolName}`;
    case "tool_running": return `${d.toolName}${d.description ? ` — ${d.description}` : ""}`;
    case "tool_completed": return `Completed: ${d.toolName}`;
    case "tool_errored": return `Error: ${d.toolName}${d.error ? ` — ${d.error}` : ""}`;
    case "tool_denied": return `Denied: ${d.toolName}${d.reason ? ` — ${d.reason}` : ""}`;
    case "tool_hook_blocked": return `Blocked by hook: ${d.toolName}`;
    case "subagent_start": return `Sub-agent started (${d.subagentType ?? "?"})`;
    case "subagent_progress": return `Sub-agent: ${d.toolName ?? "?"}`;
    case "subagent_stop": return `Sub-agent finished (${d.subagentType ?? "?"})${d.tokensUsed != null ? `, ${d.tokensUsed} tokens` : ""}`;
    case "notice": return `Notice: ${d.message ?? ""}`;
    case "run_error": return `Run error: ${d.error ?? ""}`;
    case "interrupted": return "Run interrupted";
    case "permission_mode_changed": return `Permission mode → ${d.mode ?? "?"}`;
    case "telegram_msg_queued": return `Telegram msg from chat ${d.chatId ?? "?"} queued (web)`;
    case "telegram_msg_start": return `Telegram msg from chat ${d.chatId ?? "?"} queued`;
    case "telegram_msg_update": return `Telegram msg from chat ${d.chatId ?? "?"} → ${d.status ?? "running"}`;
    case "telegram_msg_end": return `Telegram msg from chat ${d.chatId ?? "?"} → ${d.status ?? "succeeded"}${d.durationMs != null ? ` (${(d.durationMs / 1000).toFixed(1)}s)` : ""}`;
    default: return ev.type;
  }
}

function usageStr(usage) {
  if (!usage) return "";
  const i = usage.inputTokens ?? usage.input ?? usage.prompt ?? 0;
  const o = usage.outputTokens ?? usage.output ?? usage.completion ?? 0;
  return ` (${Number(i) || 0} in / ${Number(o) || 0} out tok)`;
}


function subDetail(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "tool_queued": return inputPreview(d.input);
    case "tool_completed": return inputPreview(d.result);
    case "tool_errored": return String(d.error ?? "").slice(0, 300);
    case "subagent_progress": return inputPreview(d.toolInput);
    case "notice": return "";
    default: return "";
  }
}

function inputPreview(value) {
  if (value == null) return "";
  let s;
  try { s = typeof value === "string" ? value : JSON.stringify(value); } catch { s = String(value); }
  s = s.replace(/\\s+/g, " ").trim();
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "`": "&#x60;" })[c]);
}


// ---- Telegram bridge section ----
const tgListEl = document.getElementById("tgList");
const tgCountEl = document.getElementById("tgCount");
const tgSectionEl = document.getElementById("tgSection");
const tgWrapEl = document.getElementById("tgWrap");
let expandedTg = null; // messageId of the currently expanded detail row

function tgStatusOf(ev) {
  return (ev.data && ev.data.status) || (ev.type === "telegram_msg_start" ? "queued" : "succeeded");
}

function tgEvents() {
  // pair start/update/end events by messageId; end is primary, start fills gaps
  const byId = new Map();
  for (const ev of state.events) {
    if (!ev.type.startsWith("telegram_msg_")) continue;
    const id = ev.data && ev.data.messageId;
    if (id == null) continue;
    const key = String(id);
    if (!byId.has(key)) byId.set(key, {});
    const slot = byId.get(key);
    if (ev.type === "telegram_msg_end") slot.end = ev;
    else if (ev.type === "telegram_msg_update") slot.update = ev;
    else if (ev.type === "telegram_msg_start") slot.start = ev;
  }
  const rows = [];
  for (const [id, slot] of byId) {
    const end = slot.end;
    const ev = end || slot.update || slot.start;
    rows.push({
      id,
      start: slot.start,
      update: slot.update,
      end,
      ev,
      status: end ? tgStatusOf(end) : slot.update ? tgStatusOf(slot.update) : "queued",
      ts: (end && end.ts) || (slot.update && slot.update.ts) || (slot.start && slot.start.ts),
    });
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return rows;
}

function sessionEventsFor(sessionId) {
  if (!sessionId) return [];
  return state.events
    .filter((e) => e.sessionId === sessionId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function tgRow(ev) {
  const d = ev.data || {};
  return `<span class="when">${timeStr(ev.ts)}</span>` +
    `<span class="tg-chat">${esc(d.chatId ?? "?")}</span>` +
    `<span class="tg-msg">${esc(d.messageText ?? "")}</span>` +
    `<span class="badge tg-${esc(tgStatusOf(ev))}">${esc(tgStatusOf(ev))}</span>` +
    `<span class="tg-meta">${d.durationMs != null ? (d.durationMs / 1000).toFixed(1) + "s" : ""} ${d.sessionId ? `<span class="tg-sess" title="${esc(d.sessionId)}">${esc(shortId(d.sessionId))}</span>` : ""}</span>`;
}

function shortId(id) {
  const s = String(id);
  return s.length > 12 ? s.slice(0, 12) + "…" : s;
}

function renderTelegram() {
  const rows = tgEvents();
  tgCountEl.textContent = `${rows.length} message${rows.length === 1 ? "" : "s"}`;
  tgListEl.innerHTML = "";
  if (rows.length === 0) {
    tgListEl.innerHTML = `<div class="empty">No Telegram activity yet — the bridge posts here when it processes a message.</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const wrap = document.createElement("div");
    wrap.className = "tg-row" + (row.status === "queued" || row.status === "running" ? " tg-live" : "");
    wrap.innerHTML = tgRow(row.ev);
    wrap.addEventListener("click", () => {
      const was = expandedTg;
      expandedTg = was === row.id ? null : row.id;
      renderTelegram();
    });
    frag.appendChild(wrap);
    if (expandedTg === row.id) {
      const detail = document.createElement("div");
      detail.className = "tg-detail";
      const sessionId = row.end && row.end.data && row.end.data.sessionId;
      detail.innerHTML = tgDetailHtml(row, sessionId);
      frag.appendChild(detail);
    }
  }
  tgListEl.appendChild(frag);
}

function tgDetailHtml(row, sessionId) {
  const d = row.ev.data || {};
  const startD = (row.start && row.start.data) || {};
  const endD = (row.end && row.end.data) || {};
  const parts = [
    `<div class="tg-detail-head">`,
    `  <span>Chat <b>${esc(d.chatId ?? "?")}</b></span>`,
    `  <span>Message #<b>${esc(row.id)}</b></span>`,
    `  <span>Status <b>${esc(row.status)}</b></span>`,
    `  ${endD.durationMs != null ? `<span>Duration <b>${(endD.durationMs / 1000).toFixed(1)}s</b></span>` : ""}`,
    `  ${endD.stopReason ? `<span>Stop <b>${esc(endD.stopReason)}</b></span>` : ""}`,
    `</div>`,
    `<div class="tg-detail-msg">${esc(d.messageText ?? "")}</div>`,
  ];
  if (sessionId) {
    const sess = sessionEventsFor(sessionId);
    parts.push(`<div class="tg-detail-label">Session ${esc(shortId(sessionId))} — ${sess.length} activity event(s)</div>`);
    if (sess.length === 0) {
      parts.push(`<div class="empty">No activity captured for this session (mod may not have been installed when it ran).</div>`);
    } else {
      const fragEl = document.createElement("div");
      for (const ev of sess.slice(-50)) fragEl.appendChild(renderEvent(ev));
      const tmp = document.createElement("div");
      tmp.appendChild(fragEl);
      parts.push(tmp.innerHTML);
    }
  } else {
    parts.push(`<div class="tg-detail-label">No session link — ${startD.status ? "run " + esc(startD.status) : "no run captured"}.</div>`);
  }
  return parts.join("");
}
function connectStream() {
  const es = new EventSource("/api/stream");
  es.onopen = () => { connEl.classList.add("live"); connEl.querySelector("#connText").textContent = "live"; };
  es.onmessage = (msg) => {
    try { ingest([JSON.parse(msg.data)]); } catch { /* bad frame */ }
  };
  es.onerror = () => {
    connEl.classList.remove("live");
    connEl.querySelector("#connText").textContent = "reconnecting…";
  };
}

// ---- controls ----
sessionFilterEl.addEventListener("change", () => {
  state.activeSession = sessionFilterEl.value;
  render();
});

document.getElementById("tgToggle").addEventListener("click", () => {
  const collapsed = tgSectionEl.style.display === "none";
  tgSectionEl.style.display = collapsed ? "" : "none";
  document.getElementById("tgToggle").textContent = collapsed ? "Collapse" : "Expand";
});

document.getElementById("clearFilters").addEventListener("click", () => {
  state.activeSession = "";
  state.activeTypes.clear();
  sessionFilterEl.value = "";
  document.querySelectorAll("#typeFilters input").forEach((cb) => { cb.checked = true; cb.closest("label").className = "checked"; });
  render();
});

// ---- boot ----
loadInitial();
connectStream();
refreshSummary();
setInterval(refreshSummary, 5000);

