// Telegram conversations page — auth, live ingest, thread grouping, resume.
"use strict";

const MAX_FEED = 2000;
const loginView = document.getElementById("loginView");
const appView = document.getElementById("appView");
const threadsEl = document.getElementById("threads");
const emptyEl = document.getElementById("emptyThreads");

const state = {
  events: [], // all known events (newest first)
  lastId: 0,
};

// ---- auth ----
async function checkAuth() {
  try {
    const res = await fetch("/api/telegram/status");
    if (res.ok) return true;
  } catch { /* fall through to login */ }
  return false;
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = document.getElementById("tokenInput").value;
  try {
    const res = await fetch("/api/telegram/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) location.reload();
    else document.getElementById("loginError").style.display = "block";
  } catch {
    document.getElementById("loginError").style.display = "block";
  }
});

// ---- event ingest ----
function ingest(records) {
  let changed = false;
  for (const r of records) {
    if (!r || !r.id) continue;
    if (r.id > state.lastId) state.lastId = r.id;
    if (state.events.some((e) => e.id === r.id)) continue;
    state.events.unshift(r);
    changed = true;
  }
  if (state.events.length > MAX_FEED) state.events.length = MAX_FEED;
  if (changed) render();
}

async function loadInitial() {
  try {
    const res = await fetch("/api/events?limit=1000");
    const data = await res.json();
    ingest(data.events || []);
  } catch { /* SSE will populate */ }
}

// ---- telegram grouping ----
function tgStatusOf(ev) {
  return (ev.data && ev.data.status) || "succeeded";
}

function cmdIdOf(ev) {
  const d = ev.data || {};
  return d.cmdId ?? d.messageId ?? null;
}

// Pair queued/start/update/end events by cmdId (messageId), newest first.
function tgMessages() {
  const byId = new Map();
  for (const ev of state.events) {
    if (!ev.type.startsWith("telegram_msg_")) continue;
    const id = cmdIdOf(ev);
    if (id == null) continue;
    const key = String(id);
    if (!byId.has(key)) byId.set(key, {});
    const slot = byId.get(key);
    if (ev.type === "telegram_msg_end") slot.end = ev;
    else if (ev.type === "telegram_msg_update") slot.update = ev;
    else if (ev.type === "telegram_msg_start") slot.start = ev;
    else if (ev.type === "telegram_msg_queued") slot.queued = ev;
  }
  const rows = [];
  for (const [id, slot] of byId) {
    const end = slot.end;
    const ev = end || slot.update || slot.start || slot.queued;
    if (!ev) continue;
    rows.push({
      id,
      queued: slot.queued,
      start: slot.start,
      update: slot.update,
      end,
      ev,
      status: end ? tgStatusOf(end) : slot.update ? tgStatusOf(slot.update) : slot.start ? tgStatusOf(slot.start) : "queued",
      ts: (end && end.ts) || (slot.update && slot.update.ts) || (slot.start && slot.start.ts) || (slot.queued && slot.queued.ts),
      data: ev.data || {},
    });
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return rows;
}

// Group messages into threads by chatId, newest thread first, each thread's
// messages oldest-first.
function tgThreads() {
  const msgs = tgMessages();
  const byChat = new Map();
  for (const m of msgs) {
    const chat = String(m.data.chatId ?? "?");
    if (!byChat.has(chat)) byChat.set(chat, []);
    byChat.get(chat).push(m);
  }
  const threads = [];
  for (const [chatId, messages] of byChat) {
    messages.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    threads.push({ chatId, messages, lastTs: messages[messages.length - 1].ts });
  }
  threads.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
  return threads;
}

// ---- rendering ----
function esc(s) {
  return String(s ?? "").replace(/[&<>"`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "`": "&#x60;" })[c]);
}

function timeStr(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function shortId(id) {
  const s = String(id);
  return s.length > 12 ? s.slice(0, 12) + "…" : s;
}

function render() {
  const threads = tgThreads();
  emptyEl.style.display = threads.length === 0 ? "block" : "none";
  threadsEl.innerHTML = "";
  for (const t of threads) {
    const card = document.createElement("div");
    card.className = "tg-thread";
    const head = document.createElement("div");
    head.className = "tg-thread-head";
    head.innerHTML = `<span class="tg-chat">Chat <b>${esc(t.chatId)}</b></span>` +
      `<span class="tg-count">${t.messages.length} message${t.messages.length === 1 ? "" : "s"}</span>`;

    // "Open terminal" button: resumes the conversation in a native terminal
    // window on the PC running the monitor. Shown when a session is known.
    const last = t.messages[t.messages.length - 1];
    const lastSession = (last.end && last.end.data && last.end.data.sessionId) || last.data.sessionId || null;
    if (lastSession) {
      const termBtn = document.createElement("button");
      termBtn.className = "btn-ghost tg-term-btn";
      termBtn.textContent = "Open terminal";
      termBtn.title = "Open this conversation in a terminal on your PC";
      termBtn.addEventListener("click", async () => {
        termBtn.disabled = true;
        const orig = termBtn.textContent;
        termBtn.textContent = "Opening…";
        try {
          const res = await fetch("/api/telegram/open-terminal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: lastSession }),
          });
          const data = await res.json();
          termBtn.textContent = res.ok ? "Opened on PC" : ("Error: " + (data.error || "failed"));
        } catch (err) {
          termBtn.textContent = "Error: " + String(err);
        }
        setTimeout(() => {
          termBtn.disabled = false;
          termBtn.textContent = orig;
        }, 3000);
      });
      head.appendChild(termBtn);
    }

    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "tg-thread-body";
    for (const m of t.messages) {
      body.appendChild(renderMessage(m));
    }
    card.appendChild(body);

    const resume = document.createElement("div");
    resume.className = "tg-resume";
    const ta = document.createElement("textarea");
    ta.placeholder = "Send a follow-up…";
    ta.rows = 2;
    const btn = document.createElement("button");
    btn.className = "btn-ghost";
    btn.textContent = "Resume";
    btn.addEventListener("click", async () => {
      const prompt = ta.value.trim();
      if (!prompt) return;
      const sessionId = (t.messages[t.messages.length - 1].end && t.messages[t.messages.length - 1].end.data.sessionId) || "";
      btn.disabled = true;
      try {
        const res = await fetch("/api/telegram/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: Number(t.chatId), sessionId, prompt }),
        });
        const data = await res.json();
        if (res.ok && data.cmdId) {
          ta.value = "";
          // optimistic insert so the user sees it immediately
          state.events.unshift({
            id: state.lastId + 1,
            ts: new Date().toISOString(),
            type: "telegram_msg_queued",
            data: { cmdId: data.cmdId, chatId: Number(t.chatId), sessionId, messageText: prompt, source: "web", status: "queued" },
          });
          state.lastId += 1;
          render();
        } else {
          ta.value = "Error: " + (data.error || "failed to queue");
        }
      } catch (err) {
        ta.value = "Error: " + String(err);
      } finally {
        btn.disabled = false;
      }
    });
    resume.appendChild(ta);
    resume.appendChild(btn);
    card.appendChild(resume);
    threadsEl.appendChild(card);
  }
}

function renderMessage(m) {
  const d = m.data;
  const el = document.createElement("div");
  el.className = "tg-msg-row";
  const status = m.status;
  const isRunning = status === "queued" || status === "running" || status === "retrying_without_continue";

  const head = document.createElement("div");
  head.className = "tg-msg-head";
  head.innerHTML = `<span class="when">${timeStr(m.ts)}</span>` +
    `<span class="badge tg-${esc(status)}">${esc(status)}</span>` +
    (d.sessionId ? `<span class="tg-sess" title="${esc(d.sessionId)}">${esc(shortId(d.sessionId))}</span>` : "") +
    (d.durationMs != null ? `<span class="tg-dur">${(d.durationMs / 1000).toFixed(1)}s</span>` : "");

  const prompt = document.createElement("div");
  prompt.className = "bubble bubble-user";
  prompt.textContent = d.messageText || d.prompt || "(no text)";

  el.appendChild(head);
  el.appendChild(prompt);

  const replyText = (m.end && m.end.data.replyText) || null;
  if (replyText) {
    const reply = document.createElement("div");
    reply.className = "bubble bubble-agent";
    reply.textContent = replyText;
    el.appendChild(reply);
  } else if (isRunning) {
    const pending = document.createElement("div");
    pending.className = "bubble bubble-agent bubble-pending";
    pending.textContent = status === "queued" ? "queued…" : "working…";
    el.appendChild(pending);
  }

  // keep the running row highlighted
  if (isRunning) el.classList.add("tg-live");
  return el;
}

// ---- SSE live stream ----
function connectStream() {
  const es = new EventSource("/api/stream");
  es.onmessage = (msg) => {
    try { ingest([JSON.parse(msg.data)]); } catch { /* bad frame */ }
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

// ---- boot ----
(async () => {
  const authed = await checkAuth();
  if (!authed) {
    loginView.style.display = "block";
    return;
  }
  appView.style.display = "block";
  await loadInitial();
  connectStream();
  render();
})();
