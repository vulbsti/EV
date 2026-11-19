// EV's page: one ongoing conversation, kept live by a single stream of changes.
// Each message and each piece of work is one keyed element, updated in place,
// so whatever the person opened stays open and focus stays where it was.

const $ = (id) => document.getElementById(id);
const root = $("ev");
const elements = {
  stream: $("stream"),
  col: $("col"),
  earlier: $("earlier"),
  focusnote: $("focusnote"),
  empty: $("empty"),
  statusbar: $("statusbar"),
  composer: $("composer"),
  input: $("message-input"),
  send: $("send"),
  workNeed: $("work-need"),
  openWork: $("open-work"),
  workBody: $("work-body"),
  railWork: $("rail-work"),
  findInput: $("find-input"),
  findBrowse: $("find-browse"),
  focusTitle: $("focus-title"),
  findNote: $("find-note"),
  findResults: $("find-results"),
  memoryFilter: $("memory-filter"),
  memoryStatus: $("memory-status"),
  memoryList: $("memory-list"),
  historyList: $("history-list"),
  memoryForm: $("memory-form"),
  memoryValue: $("memory-value")
};

// ---------- Session and status ----------

// Every API call needs the session the daemon's printed link hands out.
let authMissing = false;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  if (response.status === 401) { authMissing = true; showStatus(); }
  return response;
};

const conversationId = new URLSearchParams(location.search).get("conversation") ?? "default";
if (!/^[A-Za-z0-9._:-]{1,128}$/.test(conversationId)) location.replace("/");

let connection = "connecting"; // connecting | live | lost
let statusNote = "";
function showStatus(note) {
  if (note !== undefined) statusNote = note;
  const failed = [...pending.values()].some((item) => item.failed);
  const text = authMissing ? "Open KenWise from the link the daemon printed when it started."
    : statusNote ? statusNote
      : connection === "lost" ? "I can't reach KenWise right now. I'll keep trying, and anything you send waits here."
        : failed ? "Not sent yet. I'll send it as soon as I can reach KenWise."
          : "";
  elements.statusbar.textContent = text;
  elements.statusbar.hidden = !text;
}

// ---------- State ----------

const messages = new Map(); // messageId -> message
const tasks = new Map(); // taskId -> task
const pending = new Map(); // clientMessageId -> { clientMessageId, text, createdAt, failed }
const holdCommands = new Map();
const opened = new Set(); // taskIds whose details the person opened
let thinking = false;
// Set when a message was just accepted and its answer has not arrived yet.
let awaiting = null;
let earlier = false;
let loadingEarlier = false;
let loaded = false;
// Threads of work: the list (from /threads), and the one in focus with what it holds.
let threadList = null;
let focus = null; // { threadId, name, messages: Map, sent: Set of clientMessageIds said while focused }
// Follow new messages unless the person has scrolled up to read.
let following = true;

const PENDING_KEY = `ev.pending-messages.v1.${conversationId}`;
const DRAFT_KEY = `ev.draft.v1.${conversationId}`;
const LOOK_KEY = "ev-look";

function restorePending() {
  try {
    const stored = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]");
    for (const item of stored) {
      if (item?.clientMessageId && item?.text && item?.createdAt) pending.set(item.clientMessageId, { ...item, failed: true });
    }
  } catch {
    try { localStorage.removeItem(PENDING_KEY); } catch {}
  }
}

function persistPending() {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify([...pending.values()].map(({ clientMessageId, text, createdAt }) => ({ clientMessageId, text, createdAt }))));
  } catch {}
}

function upsertMessages(incoming = []) {
  for (const message of incoming) if (message?.messageId) messages.set(message.messageId, message);
  let changed = false;
  for (const message of messages.values()) {
    if (message.clientMessageId && pending.delete(message.clientMessageId)) changed = true;
    if (awaiting && message.replyTo === awaiting) awaiting = null;
  }
  if (changed) persistPending();
}

function upsertTasks(incoming = []) {
  for (const task of incoming) {
    if (!task?.taskId) continue;
    const known = tasks.get(task.taskId);
    // Keep the newest version; a hold response may race the stream.
    if (!known || (task.revision ?? 0) >= (known.revision ?? 0)) tasks.set(task.taskId, { ...task, history: task.history ?? known?.history });
  }
}

// ---------- Small helpers ----------

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

// Links, bold and code from EV's words; everything else is plain text.
function renderAnswer(value) {
  const source = String(value ?? "");
  const tokens = /\[([^\]]{1,160})\]\((https?:\/\/[^\s)"'<>]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let html = "";
  let cursor = 0;
  for (const match of source.matchAll(tokens)) {
    html += escapeHtml(source.slice(cursor, match.index));
    if (match[1]) html += `<a href="${escapeHtml(match[2])}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[1])}</a>`;
    else if (match[3]) html += `<strong>${escapeHtml(match[3])}</strong>`;
    else html += `<code>${escapeHtml(match[4])}</code>`;
    cursor = match.index + match[0].length;
  }
  return html + escapeHtml(source.slice(cursor));
}

function make(tag, className, attributes = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/** Sets markup only when it changed, so nothing inside is redrawn for nothing. */
function setHtml(node, html) {
  if (node._html !== html) { node.innerHTML = html; node._html = html; }
}
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

const ICON = {
  chevron: '<svg class="ic sm chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>',
  pause: '<svg class="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"></path></svg>',
  file: '<svg class="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 19h14"></path></svg>',
  up: '<svg class="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"></path></svg>',
  out: '<svg class="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5"></path></svg>',
  back: '<svg class="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 19H5v-5M5 19l8-8M13 17h5V6H7v5"></path></svg>',
  play: '<svg class="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"></path></svg>'
};

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
function dayKey(iso) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` : "unknown";
}
function dayLabel(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Earlier";
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  if (days < 14) return `Last ${date.toLocaleDateString(undefined, { weekday: "long" })}`;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}
function shortWhen(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const label = dayLabel(iso);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return label === "Today" ? time : `${label}, ${time}`;
}

// ---------- Work: how a piece of work is described ----------

// The six states of a piece of work, in the person's words.
function taskLabel(status) {
  if (status === "leased" || status === "running") return "working";
  if (status === "verifying") return "in review";
  if (status === "waiting") return "waiting on you";
  if (status === "held") return "on hold";
  if (status === "completed") return "delivered";
  return "queued";
}

function taskState(task) {
  const report = task.capability === "openclaw-general-v1" && task.status === "completed" ? task.result?.report : null;
  if (report?.outcome === "partial") return { label: "Partial result", tone: "st-you" };
  if (report?.outcome === "blocked") return { label: "Blocked", tone: "st-you" };
  const label = taskLabel(task.status);
  const tone = { working: "st-working", "in review": "st-review", "waiting on you": "st-you", "on hold": "st-hold", delivered: "st-done", queued: "" }[label];
  const words = { working: "Working", "in review": "In review", "waiting on you": "Needs you", "on hold": "On hold", delivered: "Delivered", queued: "Queued" }[label];
  return { label: words, tone };
}

function reviewSummary(verification) {
  const reviews = verification?.reviews?.filter((review) => !review.unavailable) ?? [];
  if (!reviews.length) return "";
  const accepted = reviews.at(-1).verdict === "accept";
  if (reviews.length === 1) return accepted ? " Accepted on first review." : " Not accepted on review.";
  return accepted ? ` Accepted after ${reviews.length - 1} revision round${reviews.length > 2 ? "s" : ""}.` : ` Still short of the brief after ${reviews.length} review rounds.`;
}

/** The one line under a work card's title. */
function taskLine(task) {
  const isOpenClaw = task.capability === "openclaw-general-v1";
  const isR1 = task.capability === "r1-content-package-v1";
  const report = isOpenClaw && task.status === "completed" ? task.result?.report : null;
  if (task.status === "held") return "On hold. Everything it made is kept; tell me to carry on and the same agent picks it up.";
  if (task.status === "completed") return task.result?.summary ?? (isOpenClaw ? report?.outcome === "blocked" ? "The agent could not achieve the requested outcome. The reason is in the details." : report?.outcome === "partial" ? "Useful work is ready, with unfinished parts or concerns listed in the details." : "The requested work is ready." : isR1 ? "Finished with a draft, review receipt, and materially different final." : "Finished and verified.");
  if (task.status === "queued") return "Saved and waiting for its agent.";
  if (task.status === "waiting") { const question = task.history?.findLast((event) => event.type === "input_needed")?.question; return question ? `Paused until you answer: ${question}` : "Paused until you answer the question above."; }
  if (task.live?.now) return `Now: ${task.live.now}`;
  if (task.status === "verifying") return "Checking the result against its brief.";
  return isOpenClaw ? "An agent is working in this task's workspace." : "The reviewed worker is using its task workspace.";
}

const fileName = (file) => file.title || String(file.relativePath ?? "file").split("/").at(-1);
const downloadLink = (file, label = fileName(file)) => `<a class="btn" href="/api/assistant/artifacts/${encodeURIComponent(file.artifactId)}" download="${escapeHtml(String(file.relativePath ?? "").split("/").at(-1) || "file")}">${ICON.file}${escapeHtml(label)}</a>`;

/** What opens under a work card: the brief, the latest review, the result and its files. */
function taskDetails(task) {
  const parts = [];
  const isOpenClaw = task.capability === "openclaw-general-v1";
  const isR1 = task.capability === "r1-content-package-v1";
  const report = isOpenClaw && task.status === "completed" ? task.result?.report : null;
  const asked = task.brief?.objective ?? task.request;
  if (asked) parts.push(`<section><h3>${task.brief?.objective ? "Interpreted as" : "The brief"}</h3><p>${escapeHtml(asked)}</p></section>`);
  if (task.brief?.successCriteria?.length) parts.push(`<section><h3>Done when</h3><ul>${task.brief.successCriteria.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join("")}</ul></section>`);
  const review = task.reviews?.at(-1);
  if (review) {
    const verdict = review.verdict === "accept" ? "Accepted" : "Sent back";
    const missing = review.missing?.length ? ` Missing: ${review.missing.join(" ")}` : "";
    parts.push(`<section><h3>Latest review${review.round ? `, round ${escapeHtml(review.round)}` : ""}</h3><p>${escapeHtml(`${verdict}.${review.summary ? ` ${review.summary}` : ""}${missing}`)}</p></section>`);
  }
  if (report) {
    if (report.goal) parts.push(`<section><h3>Goal</h3><p>${escapeHtml(report.goal)}</p></section>`);
    if (report.answer) parts.push(`<section><h3>Result</h3><p class="answer">${renderAnswer(report.answer)}</p></section>`);
    if (report.limitations?.length) parts.push(`<section><h3>${report.outcome === "completed" ? "Caveats" : "Unfinished or uncertain"}</h3><p>${escapeHtml(report.limitations.join(" "))}</p></section>`);
    if (report.evidence?.length) parts.push(`<section><h3>Sources (${report.evidence.length})</h3><ul>${report.evidence.map((source) => {
      let label;
      if (String(source.url).startsWith("file:")) {
        let path = source.url;
        try { path = decodeURIComponent(new URL(source.url).pathname); } catch {}
        label = `<span>${escapeHtml(source.title || "Local source")}</span> <code>${escapeHtml(path)}</code>`;
      } else label = /^https?:\/\//.test(source.url) ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || source.url)}</a>` : escapeHtml(source.title || source.url);
      return `<li>${label}${source.supports ? ` — ${escapeHtml(source.supports)}` : ""}${source.observedAt ? ` · ${escapeHtml(source.observedAt)}` : ""}</li>`;
    }).join("")}</ul></section>`);
    if (report.checks?.length) parts.push(`<section><h3>Agent checks</h3><ul>${report.checks.map((check) => `<li>${escapeHtml(check)}</li>`).join("")}</ul></section>`);
    if (task.artifacts?.length) parts.push(`<section><h3>Files</h3><ul class="files">${task.artifacts.map((file) => `<li>${downloadLink(file)}</li>`).join("")}</ul></section>`);
    const gate = report.verification?.qualityGate;
    parts.push(`<p class="note">${gate?.unavailable ? "Separate review unavailable." : gate?.skipped ? "Agent outcome and file checks recorded." : "KenWise reviewed the result against its brief."} ${report.verification?.deliverables?.filter((item) => item.verified).length ?? 0} files checked.${reviewSummary(report.verification)}</p>`);
  } else if (task.status === "completed") {
    if (task.result?.summary) parts.push(`<section><h3>Result</h3><p class="answer">${renderAnswer(task.result.summary)}</p></section>`);
    const artifact = task.artifacts?.[0];
    if (artifact) parts.push(`<section><h3>Files</h3><ul class="files"><li>${isR1
      ? `<a class="btn" href="/api/assistant/artifacts/${encodeURIComponent(artifact.artifactId)}?preview=1" target="_blank" rel="noopener">Open reviewed content package</a>`
      : downloadLink(artifact, "Download verified brief")}</li></ul></section>`);
  } else if (task.artifacts?.length) {
    parts.push(`<section><h3>Files so far</h3><ul class="files">${task.artifacts.map((file) => `<li>${downloadLink(file)}</li>`).join("")}</ul></section>`);
  }
  if (!parts.length) parts.push(`<p class="note">Nothing more to show yet.</p>`);
  return parts.join("");
}

const resting = (task) => ["completed", "held"].includes(task.status);

// ---------- Drawing the conversation, one item at a time ----------

const nodes = new Map(); // key -> element (messages and day dividers)
const cards = new Map(); // taskId -> card element
let typing = null;

const keyOf = (message) => message.clientMessageId ? `c:${message.clientMessageId}` : `m:${message.messageId}`;
const linksOf = (message) => {
  const ids = (message.work ?? []).map((link) => link.taskId);
  if (message.taskId && !ids.includes(message.taskId)) ids.push(message.taskId);
  return ids;
};

/** In focus: what the thread holds, what was said into it on this page, and EV's answers to those. */
function focusedMessages() {
  const shown = new Map(focus.messages);
  const said = new Set();
  for (const message of messages.values()) {
    if (message.clientMessageId && focus.sent.has(message.clientMessageId)) said.add(message.messageId);
  }
  for (const message of messages.values()) {
    if ((message.threads ?? []).includes(focus.threadId) || said.has(message.messageId) || said.has(message.replyTo)) shown.set(message.messageId, message);
    else if (shown.has(message.messageId)) shown.set(message.messageId, message);
  }
  return [...shown.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.sequence - b.sequence);
}

function visibleMessages() {
  const list = focus ? focusedMessages() : [...messages.values()].sort((a, b) => a.sequence - b.sequence);
  const confirmed = new Set(list.map((message) => message.clientMessageId).filter(Boolean));
  const waiting = [...pending.values()].filter((item) => !confirmed.has(item.clientMessageId) && (!focus || focus.sent.has(item.clientMessageId))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const item of waiting) list.push({ messageId: item.clientMessageId, clientMessageId: item.clientMessageId, role: "user", content: item.text, createdAt: item.createdAt, pending: true, failed: item.failed });
  return list;
}

function dayNode(key, iso) {
  const nodeKey = `d:${key}`;
  let node = nodes.get(nodeKey);
  if (!node) { node = make("div", "day"); nodes.set(nodeKey, node); }
  setText(node, dayLabel(iso));
  return node;
}

function strandNode(key, threadId) {
  const thread = threadList?.threads.find((item) => item.threadId === threadId);
  if (!thread) return null;
  const nodeKey = `s:${key}`;
  let node = nodes.get(nodeKey);
  if (!node) { node = make("button", "strand", { type: "button" }); nodes.set(nodeKey, node); }
  node.dataset.thread = threadId;
  setText(node, thread.name);
  return node;
}

function strandEnd(key) {
  const nodeKey = `e:${key}`;
  let node = nodes.get(nodeKey);
  if (!node) { node = make("div", "strand-end", { "aria-hidden": "true" }); nodes.set(nodeKey, node); }
  return node;
}

/** In a focused thread, each thing said in it can be taken out ("Not this thread") or put in another thread. */
function placeControls(node, message) {
  let row = node.querySelector(".place");
  const show = focus && message.role === "user" && !message.pending && (message.threads ?? []).includes(focus.threadId);
  if (!show) { row?.remove(); return; }
  const others = (threadList?.threads ?? []).filter((thread) => thread.threadId !== focus.threadId);
  const item = `message:${message.messageId}`;
  const html = `<button type="button" class="btn quiet" data-unplace="${escapeHtml(item)}">Not this thread</button>${others.length ? `<select data-move="${escapeHtml(item)}" aria-label="Put in another thread"><option value="">Put in…</option>${others.map((thread) => `<option value="${escapeHtml(thread.threadId)}">${escapeHtml(thread.name)}</option>`).join("")}</select>` : ""}`;
  if (!row) { row = make("div", "place"); node.insertBefore(row, node.querySelector(".cards")); }
  if (row.dataset.html !== html) { row.innerHTML = html; row.dataset.html = html; }
}

function messageNode(message) {
  const key = keyOf(message);
  let node = nodes.get(key);
  if (!node) {
    if (message.role === "user") {
      node = make("article", "msg turn-me");
      const bubble = make("div", "me");
      bubble.append(make("p"));
      node.append(bubble, make("span", "sending"), make("span", "to-agent"), make("div", "cards"));
    } else {
      node = make("article", "msg said");
      node.append(make("p", "answer"), make("div", "cards"));
    }
    nodes.set(key, node);
  }
  node.dataset.messageId = message.messageId;
  node.dataset.messageStatus = message.pending ? "unconfirmed" : message.status ?? "answered";
  if (message.role === "user") {
    const bubble = node.querySelector(".me");
    bubble.classList.toggle("pending", Boolean(message.pending));
    setText(bubble.firstChild, message.content);
    const note = node.querySelector(".sending");
    note.classList.toggle("failed", Boolean(message.failed));
    setText(note, message.pending ? message.failed ? "Not sent yet. Retrying when KenWise is reachable." : "Sending" : "");
    note.hidden = !message.pending;
    // Typed in the pane: it went to that work's agent, not to KenWise.
    const told = node.querySelector(".to-agent");
    const work = message.toAgent ? tasks.get(message.taskId) : null;
    setText(told, message.toAgent ? `To the agent of “${work?.title ?? "this work"}”${work?.live?.queued?.includes(message.messageId) ? ` · ${queuedWait(work)}` : ""}` : "");
    told.hidden = !message.toAgent;
  } else {
    setHtml(node.querySelector(".answer"), renderAnswer(message.content));
  }
  return node;
}

function cardNode(task) {
  let card = cards.get(task.taskId);
  if (!card) {
    card = make("section", "card glass", { "aria-label": "Work" });
    card.dataset.taskId = task.taskId;
    const detailsId = `work-${task.taskId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    card.innerHTML = `<div class="card-h"><button type="button" class="card-t" data-toggle aria-expanded="false" aria-controls="${escapeHtml(detailsId)}"></button><span class="state"><span class="dot"></span><span class="state-label"></span></span></div>
      <p class="now"></p>
      <div class="livebox" hidden><ul class="feed" aria-live="polite"></ul><p class="routed"></p></div>
      <div class="details" id="${escapeHtml(detailsId)}" hidden></div>
      <div class="acts qa"><button type="button" class="btn quiet" data-toggle aria-expanded="false" aria-controls="${escapeHtml(detailsId)}">${ICON.chevron}<span>Details</span></button><button type="button" class="btn quiet" data-watch hidden></button><button type="button" class="btn quiet" data-pop hidden></button><button type="button" class="btn quiet" data-hold>${ICON.pause}Hold</button><button type="button" class="btn quiet" data-carry hidden>${ICON.play}Carry on</button></div>`;
    cards.set(task.taskId, card);
  }
  const state = taskState(task);
  setText(card.querySelector(".card-t"), task.title ?? "Background task");
  const badge = card.querySelector(".state");
  const tone = `state ${state.tone}`.trim();
  if (badge.className !== tone) badge.className = tone;
  setText(card.querySelector(".state-label"), state.label);
  const line = card.querySelector(".now");
  setText(line, taskLine(task));
  line.classList.toggle("warm", task.status === "waiting");
  const open = opened.has(task.taskId);
  const details = card.querySelector(".details");
  if (open) setHtml(details, taskDetails(task));
  details.hidden = !open;
  for (const toggle of card.querySelectorAll("[data-toggle]")) toggle.setAttribute("aria-expanded", String(open));
  setText(card.querySelector(".acts [data-toggle] span"), open ? "Less" : "Details");
  const hold = card.querySelector("[data-hold]");
  hold.hidden = resting(task);
  if (!holdCommands.has(task.taskId) || resting(task)) hold.disabled = false;
  const carry = card.querySelector("[data-carry]");
  carry.hidden = task.status !== "held";
  if (!holdCommands.has(task.taskId)) carry.disabled = false;
  drawLive(card, task);
  card.dataset.status = task.status;
  return card;
}

/** Puts `children` into `parent` in this order, moving only what is out of place. */
function arrange(parent, children, after = null) {
  const keep = new Set(children);
  for (const child of [...parent.children]) if (child !== after && !keep.has(child)) child.remove();
  let cursor = after ? after.nextSibling : parent.firstChild;
  for (const child of children) {
    if (child === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(child, cursor);
  }
}

function render() {
  const list = visibleMessages();
  // A piece of work's card sits under the latest message about it.
  const home = new Map();
  for (const message of list) for (const taskId of linksOf(message)) {
    const task = tasks.get(taskId);
    if (task && !task.parentTaskId) { home.delete(taskId); home.set(taskId, keyOf(message)); }
  }
  const byMessage = new Map();
  for (const [taskId, key] of home) byMessage.set(key, [...(byMessage.get(key) ?? []), taskId]);

  const order = [elements.focusnote];
  const used = new Set();
  let lastDay = null;
  let lastThread = null;
  for (const message of list) {
    const day = dayKey(message.createdAt);
    if (day !== lastDay) { const divider = dayNode(day, message.createdAt); order.push(divider); used.add(`d:${day}`); lastDay = day; }
    // Where the work changes, a marker names the thread it moved to; it opens that thread.
    if (!focus && message.role === "user" && message.threads?.length && message.threads[0] !== lastThread) {
      const strand = strandNode(keyOf(message), message.threads[0]);
      if (strand) { order.push(strand); used.add(`s:${keyOf(message)}`); }
    }
    // A message in no thread quietly ends the marker's run above it, so it does not read as part of that work.
    if (!focus && message.role === "user" && !message.pending && !message.threads?.length && lastThread) {
      const end = strandEnd(keyOf(message));
      order.push(end); used.add(`e:${keyOf(message)}`);
      lastThread = null;
    }
    if (message.role === "user" && message.threads?.length) lastThread = message.threads[0];
    const node = messageNode(message);
    placeControls(node, message);
    used.add(keyOf(message));
    // Cards in the order the message names them.
    const ids = byMessage.get(keyOf(message)) ?? [];
    const named = linksOf(message);
    ids.sort((a, b) => named.indexOf(a) - named.indexOf(b));
    arrange(node.querySelector(".cards"), ids.map((taskId) => cardNode(tasks.get(taskId))));
    order.push(node);
  }
  for (const [key] of nodes) if (!used.has(key)) nodes.delete(key);
  for (const [taskId, card] of cards) if (!home.has(taskId)) { card.remove(); if (!tasks.has(taskId)) cards.delete(taskId); }

  // EV is thinking: say so where its answer will appear.
  const busy = thinking || Boolean(awaiting) || [...pending.values()].some((item) => !item.failed);
  if (busy) {
    if (!typing) {
      typing = make("div", "said typing", { role: "status", "aria-busy": "true", "aria-label": "KenWise is thinking" });
      typing.innerHTML = "<i></i><i></i><i></i>";
    }
    order.push(typing);
  } else typing = null;

  arrange(elements.col, order, elements.earlier);
  elements.earlier.hidden = !earlier || Boolean(focus);
  elements.empty.hidden = !loaded || list.length > 0 || earlier;
  renderWork();
  if (poppedOut) drawPane();
  if (following) toBottom();
}

function toBottom() { elements.stream.scrollTop = elements.stream.scrollHeight; }

// ---------- Work sheet and side rail ----------

function workGroups() {
  const roots = [...tasks.values()].filter((task) => !task.parentTaskId).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {
    needs: roots.filter((task) => task.status === "waiting"),
    under: roots.filter((task) => ["queued", "leased", "running", "verifying"].includes(task.status) || !["waiting", "held", "completed"].includes(task.status)),
    held: roots.filter((task) => task.status === "held"),
    delivered: roots.filter((task) => task.status === "completed").slice(0, 8)
  };
}

function workRow(task, action) {
  const sub = task.status === "completed" ? `${taskState(task).label}${task.updatedAt ? `, ${shortWhen(task.updatedAt)}` : ""}. Say anything to reopen it`
    : task.status === "held" ? `On hold${task.updatedAt ? ` since ${shortWhen(task.updatedAt)}` : ""}`
      : taskLine(task).replace(/^Now: /, "");
  const button = action === "hold"
    ? `<button type="button" class="btn quiet" data-hold="${escapeHtml(task.taskId)}"${holdCommands.has(task.taskId) ? " disabled" : ""}>Hold</button>`
    : `<button type="button" class="btn${action === "Answer" ? "" : " quiet"}" data-show="${escapeHtml(task.taskId)}">${action}</button>`;
  return `<div class="row"><div class="row-m"><span class="row-t">${escapeHtml(task.title ?? "Background task")}</span><span class="row-s${task.status === "waiting" ? " warm" : ""}">${escapeHtml(sub)}</span></div>${button}</div>`;
}

function renderWork() {
  const groups = workGroups();
  elements.workNeed.hidden = !groups.needs.length;
  elements.openWork.setAttribute("aria-label", groups.needs.length ? `Work. ${groups.needs.length === 1 ? "One thing needs" : `${groups.needs.length} things need`} you` : "Work");
  if (root.classList.contains("sheet-work")) {
    const section = (title, list, action) => list.length ? `<section><h3>${title}</h3><div class="tile rows">${list.map((task) => workRow(task, action)).join("")}</div></section>` : "";
    const any = groups.needs.length + groups.under.length + groups.held.length + groups.delivered.length;
    setHtml(elements.workBody, `<p class="lede">Everything I'm carrying for you. Holding work never loses it; it waits where it stopped.</p>${any ? "" : `<p class="note">Nothing yet. Ask for something and it shows up here while it runs.</p>`}${section("Needs you", groups.needs, "Answer")}${section("Under way", groups.under, "hold")}${section("On hold", groups.held, "Show")}${section("Delivered", groups.delivered, "Open")}`);
  }
  if (root.classList.contains("layout-rail")) {
    const list = [...groups.needs, ...groups.under, ...groups.held, ...groups.delivered.slice(0, 3)];
    setHtml(elements.railWork, list.length ? list.map((task) => `<div class="row"><div class="row-m"><span class="row-t">${escapeHtml(task.title ?? "Background task")}</span><span class="row-s${task.status === "waiting" ? " warm" : ""}">${escapeHtml(task.status === "waiting" ? "Needs one answer from you" : taskState(task).label)}</span></div></div>`).join("") : `<p class="note">Nothing under way.</p>`);
  }
}

/** Scrolls to a piece of work's card, opening it if asked. */
function showTask(taskId, { open = false } = {}) {
  closeSheets();
  if (open) opened.add(taskId);
  render();
  const card = cards.get(taskId);
  if (!card?.isConnected) return;
  following = false;
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
}

// ---------- Live work: the feed, watching in place, and the pane ----------
// Steps come from the stream as the agent finishes them; the card's "now"
// line and the step under way come from the work's status record (live).

const steps = new Map(); // taskId -> { bySeq: Map(seq -> step), earlier, loaded }
const watching = new Set(); // taskIds whose feed is open in place
const outputs = new Map(); // `${taskId}|${stepId}` -> text, or null while loading
let poppedOut = null; // the one piece of work in the pane beside the chat
const pane = { draftFiles: [], draftPath: null, draft: null, timer: null, fetchedAt: 0 };
const EXPLORING = new Set(["read", "searched"]);
const OPENS = new Set(["ran", "read", "searched", "web", "used"]);

/** What a message to an agent is waiting for, in the person's terms. */
function queuedWait(task) {
  if (task?.status === "held") return "waiting until you carry on";
  if (task?.live?.step?.running) return "waiting for its current step to finish, at most 2 minutes";
  return "waiting for its next step";
}
const isAgentWork = (task) => task.capability === "openclaw-general-v1" && task.status !== "queued" || Boolean(steps.get(task.taskId)?.bySeq.size);

function stepsOf(taskId) {
  if (!steps.has(taskId)) steps.set(taskId, { bySeq: new Map(), earlier: false, loaded: false });
  return steps.get(taskId);
}

function takeSteps(incoming) {
  for (const step of incoming) stepsOf(step.taskId).bySeq.set(step.seq, step);
  const wrote = incoming.some((step) => step.taskId === poppedOut && step.kind === "wrote");
  if (wrote) refreshDrafts();
}

/** Loads a piece of work's steps (the newest page, or the page before what is loaded). */
async function loadSteps(taskId, { older = false } = {}) {
  const entry = stepsOf(taskId);
  const first = Math.min(...entry.bySeq.keys());
  const query = older && Number.isFinite(first) ? `?before=${first}` : "";
  try {
    const body = await fetch(`/api/assistant/tasks/${encodeURIComponent(taskId)}/steps${query}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)));
    for (const step of body.steps) entry.bySeq.set(step.seq, step);
    if (older || !entry.loaded) entry.earlier = body.earlier;
    entry.loaded = true;
    const task = tasks.get(taskId);
    if (task && body.live) tasks.set(taskId, { ...task, live: body.live });
  } catch (error) { showStatus(`Couldn't load what the agent did: ${error.message}`); setTimeout(() => showStatus(""), 5_000); }
  render();
  if (poppedOut === taskId) drawPane();
}

const clock = (iso) => { const at = new Date(iso); return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
function elapsed(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Folds a run of reads and searches into one row, the way Codex shows "Explored". */
function feedRows(list) {
  const rows = [];
  for (const step of list) {
    const last = rows.at(-1);
    if (last && EXPLORING.has(step.kind) && last.group && !step.failed) { last.steps.push(step); continue; }
    rows.push({ group: EXPLORING.has(step.kind) && !step.failed, steps: [step] });
  }
  return rows.map(({ steps: run }) => {
    if (run.length === 1) return { step: run[0], label: run[0].label };
    const reads = run.filter((step) => step.kind === "read").flatMap((step) => step.parsed?.map((item) => item.target) ?? [step.label.replace(/^Read /, "")]);
    const searches = run.filter((step) => step.kind === "searched");
    const name = (path) => String(path).split("/").at(-1);
    const parts = [];
    if (reads.length) parts.push(reads.length <= 3 ? `Read ${reads.map(name).join(", ")}` : `Read ${reads.length} files`);
    if (searches.length) parts.push(searches.length === 1 ? searches[0].label : `searched ${searches.length} times`);
    return { step: run[0], label: parts.join(", "), folded: run.length };
  });
}

function feedHtml(task, { limit = 40 } = {}) {
  const entry = steps.get(task.taskId);
  const list = entry ? [...entry.bySeq.values()].sort((a, b) => a.seq - b.seq) : [];
  const rows = feedRows(list);
  const shown = rows.slice(-limit);
  const live = task.live;
  const running = live?.step?.running && ["leased", "running"].includes(task.status) ? live : null;
  const items = shown.map(({ step, label, folded }) => {
    const tone = step.kind === "reviewed" && !step.accepted ? " is-review" : step.cut || step.failed ? " is-cut" : step.kind === "asked" ? " is-review" : "";
    const opens = !folded && OPENS.has(step.kind) && step.id;
    const key = `${task.taskId}|${step.id}`;
    const output = outputs.has(key) ? `<pre class="out">${escapeHtml(outputs.get(key) ?? "Loading…")}</pre>` : "";
    return `<li class="${(tone + (opens ? " opens" : "")).trim()}"${opens ? ` data-step="${escapeHtml(step.id)}" title="Show what it printed"` : ""}><time>${escapeHtml(clock(step.endedAt ?? step.startedAt))}</time><span class="pt"></span><span>${escapeHtml(label)}${step.failed ? " (failed)" : ""}</span>${output}</li>`;
  });
  if (running) items.push(`<li class="is-now"><time>${escapeHtml(clock(running.step.startedAt))}</time><span class="pt"></span><span>${escapeHtml(running.now)} <span class="el">· ${escapeHtml(elapsed(running.step.startedAt))}</span></span></li>`);
  else if (live?.now && ["leased", "running", "verifying", "queued"].includes(task.status)) items.push(`<li class="is-now"><time>${escapeHtml(clock(live.nowAt))}</time><span class="pt"></span><span>${escapeHtml(live.now)}</span></li>`);
  if (!items.length) return `<li><time></time><span class="pt"></span><span>${entry?.loaded ? "Nothing yet." : "Loading…"}</span></li>`;
  return items.join("");
}

function routedLine(task) {
  const model = task.live?.model;
  if (!model) return "";
  const [provider, ...rest] = model.split("/");
  return rest.length ? `On ${rest.join("/")} through ${provider}.` : `On ${model}.`;
}

/** The card's own live parts: Watch or Less, Pop out or Pop back in, and the feed when watched. */
function drawLive(card, task) {
  const agent = isAgentWork(task);
  const watch = card.querySelector("[data-watch]");
  const pop = card.querySelector("[data-pop]");
  const isOut = poppedOut === task.taskId;
  const open = watching.has(task.taskId) && !isOut;
  watch.hidden = !agent || isOut;
  pop.hidden = !agent;
  setHtml(watch, open ? `${ICON.up}Less` : `${ICON.chevron}Watch`);
  watch.setAttribute("aria-expanded", String(open));
  setHtml(pop, isOut ? `${ICON.back}Pop back in` : `${ICON.out}Pop out`);
  card.classList.toggle("watching", open);
  const box = card.querySelector(".livebox");
  box.hidden = !open;
  if (open) {
    setHtml(box.querySelector(".feed"), feedHtml(task, { limit: 12 }));
    setText(box.querySelector(".routed"), routedLine(task));
  }
  if (isOut) setText(card.querySelector(".now"), "Open beside the chat");
}

function toggleWatch(taskId) {
  if (watching.has(taskId)) watching.delete(taskId);
  else { watching.add(taskId); if (!stepsOf(taskId).loaded) void loadSteps(taskId); }
  render();
}

function popOut(taskId) {
  poppedOut = taskId;
  pane.draftFiles = []; pane.draftPath = null; pane.draft = null;
  root.classList.add("live-out");
  if (!stepsOf(taskId).loaded) void loadSteps(taskId);
  refreshDrafts(true);
  render();
  drawPane();
  requestAnimationFrame(() => $("pane-input").focus());
}

function popIn() {
  const taskId = poppedOut;
  poppedOut = null;
  root.classList.remove("live-out");
  clearTimeout(pane.timer);
  render();
  if (taskId) cards.get(taskId)?.querySelector("[data-pop]")?.focus();
}

/** What the agent has made so far, refetched at most every half second while the pane is open. */
function refreshDrafts(now = false) {
  if (!poppedOut) return;
  clearTimeout(pane.timer);
  const wait = now ? 0 : Math.max(0, pane.fetchedAt + 500 - Date.now());
  pane.timer = setTimeout(async () => {
    const taskId = poppedOut;
    if (!taskId) return;
    pane.fetchedAt = Date.now();
    const base = `/api/assistant/tasks/${encodeURIComponent(taskId)}/drafts`;
    try {
      const list = await fetch(base, { cache: "no-store" }).then((response) => response.json());
      if (poppedOut !== taskId) return;
      pane.draftFiles = list.files ?? [];
      if (!pane.draftFiles.some((file) => file.path === pane.draftPath)) pane.draftPath = pane.draftFiles[0]?.path ?? null;
      pane.draft = pane.draftPath ? (await fetch(`${base}?path=${encodeURIComponent(pane.draftPath)}`, { cache: "no-store" }).then((response) => response.json())).draft ?? null : null;
    } catch { /* the pane keeps what it showed */ }
    if (poppedOut === taskId) drawPane();
  }, wait);
}

function draftHtml() {
  if (!pane.draftFiles.length) return `<p class="note">Nothing written yet.</p>`;
  const chooser = pane.draftFiles.length > 1 ? `<div class="files">${pane.draftFiles.slice(0, 8).map((file) => `<button type="button" class="btn quiet" data-draft="${escapeHtml(file.path)}" aria-pressed="${file.path === pane.draftPath}">${escapeHtml(file.path)}</button>`).join("")}</div>` : "";
  const draft = pane.draft;
  const body = !draft ? `<p class="note">Loading…</p>` : draft.text !== undefined ? `<pre>${escapeHtml(draft.text)}</pre>` : `<p class="note">${draft.binary ? "Not a text file." : "Too large to show here."} ${escapeHtml(String(draft.bytes))} bytes, last changed ${escapeHtml(clock(draft.modifiedAt))}.</p>`;
  return `${chooser}<div class="tile doc"><div class="card-h"><span class="doc-t">${escapeHtml(pane.draftPath ?? "")}</span><span class="badge b-guess">Not reviewed yet</span></div>${body}</div>`;
}

/** The pane beside the chat: the whole feed, the draft so far, and a line to its agent. */
function drawPane() {
  const task = poppedOut ? tasks.get(poppedOut) : null;
  if (!task) { if (poppedOut) popIn(); return; }
  setText($("pane-title"), task.title ?? "Background task");
  const state = taskState(task);
  const badge = $("pane-state");
  badge.className = `state ${state.tone}`.trim();
  const round = task.live?.round > 1 ? `, round ${task.live.round}` : "";
  setText(badge.querySelector(".state-label"), `${state.label}${["leased", "running", "verifying"].includes(task.status) ? round : ""}`);
  const holdButton = $("pane-hold");
  holdButton.hidden = task.status === "completed";
  setHtml(holdButton, task.status === "held" ? `${ICON.play}Carry on` : `${ICON.pause}Hold`);
  holdButton.disabled = holdCommands.has(task.taskId);
  const entry = steps.get(task.taskId);
  const body = $("pane-body");
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  setHtml(body, `<section><h3>Live</h3>${entry?.earlier ? `<button type="button" class="btn quiet" data-older>Earlier steps</button>` : ""}<ul class="feed" aria-live="polite">${feedHtml(task, { limit: 400 })}</ul></section><section><h3>Draft so far</h3>${draftHtml()}</section><p class="routed">${escapeHtml(routedLine(task))}</p>`);
  if (atBottom) body.scrollTop = body.scrollHeight;
  const waiting = (task.live?.queued ?? []).map((id) => messages.get(id)).filter((message) => message?.toAgent);
  const queued = $("pane-queued");
  queued.hidden = !waiting.length;
  setHtml(queued, waiting.map((message) => `<li>${escapeHtml(queuedWait(task).replace(/^w/, "W"))}: ${escapeHtml(message.content)}</li>`).join(""));
  const open = task.status !== "completed";
  $("pane-input").placeholder = task.status === "held" ? "Tell it something and it carries on" : task.status === "completed" ? "Tell it something to reopen this work" : "Tell this agent something";
  $("pane-now").hidden = !["leased", "running"].includes(task.status) || !open;
}

async function toggleOutput(taskId, stepId) {
  const key = `${taskId}|${stepId}`;
  if (outputs.has(key)) { outputs.delete(key); render(); if (poppedOut === taskId) drawPane(); return; }
  outputs.set(key, null);
  render(); if (poppedOut === taskId) drawPane();
  try {
    const body = await fetch(`/api/assistant/tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}/output`, { cache: "no-store" }).then((response) => response.json());
    if (!outputs.has(key)) return;
    outputs.set(key, body.output ? (body.output.text || "(printed nothing)") : "The agent's record of this step is gone.");
  } catch { outputs.set(key, "Couldn't load it just now."); }
  render(); if (poppedOut === taskId) drawPane();
}

/** Sends what the person typed in the pane straight to this work's agent. */
async function tellAgent(mode) {
  const taskId = poppedOut;
  const input = $("pane-input");
  const text = input.value.trim();
  if (!taskId || !text) return;
  input.value = "";
  try {
    const response = await fetch(`/api/assistant/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientMessageId: crypto.randomUUID(), text, mode })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    upsertMessages([body.message]);
    const task = tasks.get(taskId);
    if (task && body.live) tasks.set(taskId, { ...task, live: body.live });
    render();
  } catch (error) {
    input.value = text;
    showStatus(`Not sent to the agent: ${error.message}`);
    setTimeout(() => showStatus(""), 5_000);
  }
}

$("pane-form").addEventListener("submit", (event) => { event.preventDefault(); void tellAgent("next"); });
$("pane-now").addEventListener("click", () => void tellAgent("interrupt"));
$("pane-in").addEventListener("click", () => popIn());
$("pane-hold").addEventListener("click", (event) => {
  const task = tasks.get(poppedOut);
  if (!task) return;
  event.currentTarget.disabled = true;
  void holdTask(task.taskId, true, task.status === "held" ? "carry_on" : "hold");
});
$("pane-body").addEventListener("click", (event) => {
  if (event.target.closest("[data-older]")) { void loadSteps(poppedOut, { older: true }); return; }
  const file = event.target.closest("[data-draft]");
  if (file) { pane.draftPath = file.dataset.draft; pane.draft = null; drawPane(); refreshDrafts(true); return; }
  const row = event.target.closest(".feed li[data-step]");
  if (row) void toggleOutput(poppedOut, row.dataset.step);
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && poppedOut && !SHEETS.some((name) => root.classList.contains(name))) popIn(); });
// A long step shows how long it has been going, so a quiet agent does not look stuck.
setInterval(() => { if (watching.size || poppedOut) render(); }, 10_000);

// ---------- The stream of changes ----------

let source = null;
let retryMs = 1_000;
let retryTimer = null;

function applySnapshot(data) {
  messages.clear();
  tasks.clear();
  upsertMessages(data.messages);
  upsertTasks(data.tasks);
  thinking = Boolean(data.thinking);
  earlier = Boolean(data.earlier);
  takeLook(data.look);
  loaded = true;
  render();
  toBottom();
  void loadThreads();
}

function applyChange(data) {
  if (focus) for (const message of data.messages ?? []) if (focus.messages.has(message.messageId)) focus.messages.set(message.messageId, message);
  if (data.threadsChanged) threadsSoon();
  upsertMessages(data.messages);
  upsertTasks(data.tasks);
  // A piece of work's status record comes whole; it replaces the one the page had.
  for (const record of data.live ?? []) {
    const task = tasks.get(record.taskId);
    if (task) tasks.set(record.taskId, { ...task, live: record });
  }
  takeSteps(data.steps ?? []);
  if (typeof data.thinking === "boolean") thinking = data.thinking;
  if (data.look) takeLook(data.look);
  render();
}

function connect() {
  clearTimeout(retryTimer);
  source?.close();
  source = new EventSource(`/api/assistant/stream?conversationId=${encodeURIComponent(conversationId)}`);
  source.addEventListener("open", () => {
    retryMs = 1_000;
    authMissing = false;
    connection = "live";
    showStatus();
  });
  source.addEventListener("snapshot", (event) => {
    try { applySnapshot(JSON.parse(event.data)); } catch (error) { console.error(error); }
    void retryPending();
  });
  source.addEventListener("change", (event) => {
    try { applyChange(JSON.parse(event.data)); } catch (error) { console.error(error); }
  });
  source.addEventListener("error", () => {
    connection = "lost";
    if (source.readyState === EventSource.CLOSED) {
      // The browser gave up (EV refused or is gone): ask once why, then try again.
      void fetch(`/api/assistant/conversation?conversationId=${encodeURIComponent(conversationId)}&after=${Number.MAX_SAFE_INTEGER}`, { cache: "no-store" }).catch(() => {});
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    }
    showStatus();
  });
}

async function loadEarlier() {
  if (loadingEarlier || !earlier) return;
  const first = Math.min(...[...messages.values()].map((message) => message.sequence));
  if (!Number.isFinite(first)) return;
  loadingEarlier = true;
  elements.earlier.disabled = true;
  try {
    const response = await fetch(`/api/assistant/conversation?conversationId=${encodeURIComponent(conversationId)}&before=${first}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    // Keep what the person is looking at where it is.
    const fromBottom = elements.stream.scrollHeight - elements.stream.scrollTop;
    for (const message of body.messages ?? []) if (!messages.has(message.messageId)) messages.set(message.messageId, message);
    earlier = Boolean(body.earlier);
    following = false;
    render();
    elements.stream.scrollTop = elements.stream.scrollHeight - fromBottom;
  } catch (error) {
    showStatus(`Could not load earlier messages: ${error.message}`);
    setTimeout(() => showStatus(""), 4_000);
  } finally {
    loadingEarlier = false;
    elements.earlier.disabled = false;
  }
}

// ---------- Sending ----------

async function sendPending(item) {
  item.failed = false;
  pending.set(item.clientMessageId, item);
  persistPending();
  render();
  try {
    const response = await fetch("/api/assistant/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, clientMessageId: item.clientMessageId, text: item.text })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    // Saved; EV's answer arrives through the stream.
    pending.delete(item.clientMessageId);
    persistPending();
    if (body.message?.messageId) {
      const answered = [...messages.values()].some((message) => message.replyTo === body.message.messageId);
      if (!messages.has(body.message.messageId)) messages.set(body.message.messageId, body.message);
      if (!answered) awaiting = body.message.messageId;
    }
    statusNote = "";
    showStatus();
    render();
  } catch (error) {
    item.failed = true;
    pending.set(item.clientMessageId, item);
    persistPending();
    showStatus();
    render();
  }
}

let retrying = false;
async function retryPending() {
  if (retrying || !pending.size) return;
  retrying = true;
  try { for (const item of [...pending.values()]) await sendPending(item); }
  finally { retrying = false; }
}

function saveDraft() {
  try {
    if (elements.input.value) localStorage.setItem(DRAFT_KEY, elements.input.value);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {}
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(Math.max(elements.input.scrollHeight, 44), 160)}px`;
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.input.value.trim();
  if (!text) return;
  elements.input.value = "";
  saveDraft();
  resizeInput();
  following = true;
  const clientMessageId = crypto.randomUUID();
  focus?.sent.add(clientMessageId);
  void sendPending({ clientMessageId, text, createdAt: new Date().toISOString(), failed: false });
});
elements.input.addEventListener("input", () => { resizeInput(); saveDraft(); });
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

// ---------- Hold ----------

/** Hold (or, with type carry_on, carry on) one piece of work, replay-safe by its command id. */
async function holdTask(taskId, retryOnConflict = true, type = "hold") {
  const task = tasks.get(taskId);
  if (!task || (type === "hold" ? resting(task) : task.status !== "held")) return;
  const commandId = holdCommands.get(taskId) ?? crypto.randomUUID();
  holdCommands.set(taskId, commandId);
  try {
    const response = await fetch(`/api/assistant/tasks/${encodeURIComponent(taskId)}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId, type, expectedRevision: task.revision })
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && retryOnConflict) {
      // Someone moved it on meanwhile: read its latest revision and try once more.
      const latest = await fetch(`/api/assistant/tasks?conversationId=${encodeURIComponent(conversationId)}`, { cache: "no-store" }).then((reply) => reply.json()).catch(() => ({}));
      upsertTasks((latest.tasks ?? []).filter((item) => item.taskId === taskId));
      holdCommands.delete(taskId);
      return holdTask(taskId, false, type);
    }
    if (!response.ok) throw new Error(body.error ?? `${type === "hold" ? "Hold" : "Carry on"} failed: HTTP ${response.status}`);
    holdCommands.delete(taskId);
    upsertTasks([body.task]);
  } catch (error) {
    holdCommands.delete(taskId);
    showStatus(error.message);
    setTimeout(() => showStatus(""), 5_000);
  }
  render();
}

// ---------- Clicks in the conversation ----------

elements.col.addEventListener("change", (event) => {
  const select = event.target.closest("select[data-move]");
  if (select?.value) void placeItem(select.dataset.move, select.value);
});

/** Moves one item out of the focused thread (to null, or into another), then shows the thread as it now is. */
async function placeItem(item, to) {
  if (await threadCommand("move", { item, to })) await loadFocus();
}

elements.col.addEventListener("click", (event) => {
  const unplace = event.target.closest("[data-unplace]");
  if (unplace) { unplace.disabled = true; void placeItem(unplace.dataset.unplace, null); return; }
  if (event.target.closest("#earlier")) { void loadEarlier(); return; }
  const strand = event.target.closest(".strand");
  if (strand) { void focusThread(strand.dataset.thread); return; }
  const card = event.target.closest("[data-task-id]");
  if (!card) return;
  const taskId = card.dataset.taskId;
  if (event.target.closest("[data-toggle]")) {
    if (opened.has(taskId)) opened.delete(taskId); else opened.add(taskId);
    const task = tasks.get(taskId);
    if (task) cardNode(task);
    return;
  }
  const hold = event.target.closest("[data-hold]");
  if (hold) {
    hold.disabled = true;
    void holdTask(taskId);
    return;
  }
  const carry = event.target.closest("[data-carry]");
  if (carry) { carry.disabled = true; void holdTask(taskId, true, "carry_on"); return; }
  if (event.target.closest("[data-watch]")) { toggleWatch(taskId); return; }
  if (event.target.closest("[data-pop]")) { if (poppedOut === taskId) popIn(); else popOut(taskId); return; }
  const row = event.target.closest(".feed li[data-step]");
  if (row) void toggleOutput(taskId, row.dataset.step);
});

elements.stream.addEventListener("scroll", () => {
  const { scrollTop, scrollHeight, clientHeight } = elements.stream;
  following = scrollHeight - scrollTop - clientHeight < 80;
  if (scrollTop < 120 && earlier) void loadEarlier();
}, { passive: true });

// Fonts and late layout change heights: stay at the newest message while following.
new ResizeObserver(() => { if (following) toBottom(); }).observe(elements.col);

// ---------- Sheets ----------

const SHEETS = ["sheet-find", "sheet-work", "sheet-you", "sheet-settings"];
let sheetOpener = null;
function openSheet(name, opener) {
  closeSheets({ restore: false });
  sheetOpener = opener ?? document.activeElement;
  root.classList.add(name);
  if (name === "sheet-work") renderWork();
  if (name === "sheet-find") { renderBrowse(); elements.findInput.placeholder = focus ? `Search in ${focus.name}` : "Search everything said and done"; void loadThreads(); }
  const sheet = { "sheet-find": "sheet-find", "sheet-work": "sheet-work", "sheet-you": "sheet-you", "sheet-settings": "sheet-look" }[name];
  const focusable = name === "sheet-find" ? elements.findInput : $(sheet).querySelector("button, input");
  requestAnimationFrame(() => focusable?.focus());
}
function closeSheets({ restore = true } = {}) {
  const wasOpen = SHEETS.some((name) => root.classList.contains(name));
  root.classList.remove(...SHEETS);
  if (restore && wasOpen && sheetOpener?.isConnected) sheetOpener.focus();
}

$("open-find").addEventListener("click", (event) => openSheet("sheet-find", event.currentTarget));
$("open-work").addEventListener("click", (event) => openSheet("sheet-work", event.currentTarget));
$("open-you").addEventListener("click", (event) => { openSheet("sheet-you", event.currentTarget); void showUnderstanding(); });
$("open-look").addEventListener("click", (event) => openSheet("sheet-settings", event.currentTarget));
$("scrim").addEventListener("click", () => closeSheets());
for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => closeSheets());
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSheets(); });

elements.workBody.addEventListener("click", (event) => {
  const hold = event.target.closest("[data-hold]");
  if (hold) { hold.disabled = true; void holdTask(hold.dataset.hold); return; }
  const show = event.target.closest("[data-show]");
  if (!show) return;
  const taskId = show.dataset.show;
  const task = tasks.get(taskId);
  showTask(taskId, { open: task?.status === "completed" });
  if (task?.status === "waiting") elements.input.focus({ preventScroll: true });
});

// ---------- Look ----------

const LOOK_DEFAULTS = { theme: "aurora", accent: "sky", glass: "frosted", layout: "column", density: "cosy", font: "sans" };
const LOOK_CHOICES = { theme: ["aurora", "graphite", "frost", "dawn"], accent: ["sky", "iris", "mint", "amber", "rose", "mono"], glass: ["clear", "frosted", "solid"], layout: ["column", "rail"], density: ["cosy", "compact"], font: ["sans", "serif", "mono"] };
const look = { ...LOOK_DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem(LOOK_KEY) ?? "{}");
  for (const [key, choices] of Object.entries(LOOK_CHOICES)) if (choices.includes(saved?.[key])) look[key] = saved[key];
} catch {}

/** A look saved by KenWise (from this or another device) wins over the one this browser remembered. */
function takeLook(saved) {
  if (!saved || typeof saved !== "object") return;
  let changed = false;
  for (const [key, choices] of Object.entries(LOOK_CHOICES)) if (choices.includes(saved[key]) && look[key] !== saved[key]) { look[key] = saved[key]; changed = true; }
  if (!changed) return;
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch {}
  applyLook();
}

function applyLook() {
  for (const [key, choices] of Object.entries(LOOK_CHOICES)) for (const choice of choices) root.classList.toggle(`${key}-${choice}`, look[key] === choice);
  for (const button of document.querySelectorAll("[data-look]")) {
    const [key, value] = button.dataset.look.split(":");
    button.setAttribute("aria-pressed", String(look[key] === value));
  }
  const light = look.theme === "frost" || look.theme === "dawn";
  document.querySelector('meta[name="theme-color"]').setAttribute("content", { aurora: "#0a0d13", graphite: "#0d0e0f", frost: "#e4e9f1", dawn: "#efe8df" }[look.theme]);
  document.body.style.background = { aurora: "#0a0d13", graphite: "#0d0e0f", frost: "#e4e9f1", dawn: "#efe8df" }[look.theme];
  document.documentElement.style.colorScheme = light ? "light" : "dark";
  renderWork();
}

$("sheet-look").addEventListener("click", (event) => {
  const button = event.target.closest("[data-look]");
  if (!button) return;
  const [key, value] = button.dataset.look.split(":");
  look[key] = value;
  applyLook();
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch {}
  fetch("/api/assistant/settings/look", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look }) }).catch(() => {});
});

// ---------- Threads of work ----------

const NUMBER = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n, word, plural = `${word}s`) => `${NUMBER[n] ?? n} ${n === 1 ? word : plural}`;
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Today and last Friday. One piece of work under way, one question for you" */
function threadLine(thread) {
  // "Today and last Friday": only the first day keeps its capital.
  const days = (thread.days ?? []).slice(0, 2).map((day, index) => { const label = dayLabel(`${day}T12:00:00`); return index && /^(Today|Yesterday|Last )/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label; });
  const when = days.join(" and ") || "";
  const by = (statuses) => thread.work.filter((work) => statuses.includes(work.status)).length;
  const under = by(["queued", "leased", "running", "verifying"]);
  const asking = by(["waiting"]);
  const held = by(["held"]);
  const delivered = by(["completed"]);
  const work = [
    under && `${count(under, "piece")} of work under way`,
    asking && `${count(asking, "question")} for you`,
    held && `${count(held, "piece")} on hold`,
    delivered && !under && !asking && `delivered${delivered > 1 ? ` ${count(delivered, "time")}` : ""}`
  ].filter(Boolean).join(", ") || "Mentioned, nothing started";
  const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  return [thread.quiet ? "Quiet" : "", when, sentence(work)].filter(Boolean).join(". ");
}

let threadsTimer = null;
function threadsSoon() {
  clearTimeout(threadsTimer);
  threadsTimer = setTimeout(() => { void loadThreads(); if (focus) void loadFocus(); }, 250);
}

async function loadThreads() {
  try {
    const response = await fetch("/api/assistant/threads", { cache: "no-store" });
    if (!response.ok) return;
    threadList = await response.json();
  } catch { return; }
  if (focus) {
    const now = threadList.threads.find((thread) => thread.threadId === focus.threadId);
    if (now) { focus.name = now.name; setText(elements.focusTitle, now.name); }
  }
  renderBrowse();
  render();
}

function renderBrowse() {
  if (!threadList) { setHtml(elements.findBrowse, `<p class="lede pad">One conversation, always.</p>`); return; }
  const { threads, notGrouped, lastRegroup, collecting } = threadList;
  const row = (thread) => `<button class="prow" type="button" data-thread="${escapeHtml(thread.threadId)}" aria-pressed="${focus?.threadId === thread.threadId}"><span class="row-m"><span class="row-t">${escapeHtml(thread.name)}</span><span class="row-s">${escapeHtml(threadLine(thread))}</span></span></button>`;
  const options = threads.filter((thread) => !thread.quiet).map((thread) => `<option value="${escapeHtml(thread.threadId)}">${escapeHtml(thread.name)}</option>`).join("");
  const loose = (item) => {
    const target = item.messageId ? ` data-message="${escapeHtml(item.messageId)}" data-sequence="${escapeHtml(item.sequence ?? "")}" data-conversation="${escapeHtml(item.conversationId ?? "")}"` : item.workId ? ` data-work="${escapeHtml(item.workId)}"` : "";
    return `<div class="loose"><button class="prow hit" type="button"${target}><span class="row-m"><span class="row-s">${escapeHtml(dayLabel(item.at))}${item.kind === "work" ? ", work" : item.kind === "import" ? ", imported" : ""}</span><span>${escapeHtml(item.text)}</span></span></button>${options ? `<select data-move="${escapeHtml(item.item)}" aria-label="Put in a thread"><option value="">Put in…</option>${options}</select>` : ""}</div>`;
  };
  const organised = lastRegroup
    ? `<span>Last organised ${escapeHtml(shortWhen(lastRegroup.at))}: ${escapeHtml(lastRegroup.undone ? "undone" : lastRegroup.summary)}.</span>${lastRegroup.undone || lastRegroup.summary === "Nothing changed" ? "" : `<button class="lnk" type="button" data-undo="${escapeHtml(lastRegroup.regroupId)}">Undo</button>`}`
    : "";
  setHtml(elements.findBrowse, [
    `<p class="lede pad">One conversation, always. I gather what belongs to the same work, whenever it was said, so you can pull it out.</p>`,
    `<button class="prow" type="button" data-thread="" aria-pressed="${!focus}"><span class="row-m"><span class="row-t">Everything</span><span class="row-s">The whole conversation, in order</span></span></button>`,
    threads.length ? `<h3>Threads of work</h3>${threads.map(row).join("")}` : "",
    collecting && !threads.length ? `<p class="note pad">I'm collecting for now. Once I've seen a few days of your work, I'll group it into threads. You can also ask me to organise it now.</p>` : "",
    notGrouped.count ? `<h3>Not grouped yet</h3><p class="note pad">${notGrouped.count === 1 ? "One new thing waits" : `${capital(count(notGrouped.count, "new thing"))} wait`} here until I next organise your work. Nothing here is lost.</p>${notGrouped.items.slice(0, 8).map(loose).join("")}${notGrouped.count > 8 ? `<p class="note pad">And ${notGrouped.count - 8} more.</p>` : ""}` : "",
    `<div class="organise">${organised}<button class="lnk" type="button" data-organise>Organise now</button></div>`
  ].join(""));
}

/** Shows only one thread of work (null: everything). */
async function focusThread(threadId) {
  closeSheets({ restore: false });
  if (!threadId) {
    focus = null;
    root.classList.add("focus-all");
    setText(elements.focusTitle, "KenWise");
    following = true;
    render();
    toBottom();
    return;
  }
  const name = threadList?.threads.find((thread) => thread.threadId === threadId)?.name ?? "Thread";
  focus = { threadId, name, messages: new Map(), sent: new Set() };
  root.classList.remove("focus-all");
  setText(elements.focusTitle, name);
  await loadFocus();
  following = true;
  toBottom();
}

async function loadFocus() {
  const threadId = focus?.threadId;
  if (!threadId) return;
  try {
    const response = await fetch(`/api/assistant/threads/${encodeURIComponent(threadId)}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    if (focus?.threadId !== threadId) return;
    // A thread merged into another opens as what it became.
    if (body.thread.threadId !== threadId) { focus.threadId = body.thread.threadId; }
    focus.name = body.thread.name;
    setText(elements.focusTitle, body.thread.name);
    focus.messages = new Map(body.messages.map((message) => [message.messageId, message]));
    upsertTasks(body.tasks);
    render();
  } catch (error) {
    showStatus(`Could not open that thread: ${error.message}`);
    setTimeout(() => showStatus(""), 4_000);
  }
}

$("unfocus").addEventListener("click", () => void focusThread(null));

elements.findBrowse.addEventListener("click", (event) => {
  const thread = event.target.closest("[data-thread]");
  if (thread) { void focusThread(thread.dataset.thread || null); return; }
  const hit = event.target.closest("button.hit");
  if (hit) { void openHit(hit.dataset); return; }
  const undo = event.target.closest("[data-undo]");
  if (undo) { undo.disabled = true; void threadCommand("undo", { regroupId: undo.dataset.undo }); return; }
  if (event.target.closest("[data-organise]")) {
    void threadCommand("regroup", {}).then((ok) => { if (ok) { const line = elements.findBrowse.querySelector(".organise"); if (line) line.innerHTML = "<span>Organising your work. This takes a minute or two; this list updates when it is done.</span>"; } });
  }
});

elements.findBrowse.addEventListener("change", (event) => {
  const select = event.target.closest("select[data-move]");
  if (select?.value) void threadCommand("move", { item: select.dataset.move, to: select.value });
});

async function threadCommand(name, body) {
  try {
    const response = await fetch(`/api/assistant/threads/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const reply = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(reply.error ?? `HTTP ${response.status}`);
    await loadThreads();
    return true;
  } catch (error) {
    showStatus(error.message);
    setTimeout(() => showStatus(""), 5_000);
    return false;
  }
}

// ---------- Search ----------

let searchTimer = null;
let searchSeq = 0;
elements.findInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 220);
});

const [MARK_OPEN, MARK_CLOSE] = ["\u0002", "\u0003"];
/** An excerpt with the matched words marked; everything else is plain text. */
function marked(excerpt) {
  return String(excerpt ?? "").split(MARK_OPEN).map((part, index) => {
    if (!index) return escapeHtml(part);
    const [hit, rest = ""] = part.split(MARK_CLOSE);
    return `<mark>${escapeHtml(hit)}</mark>${escapeHtml(rest)}`;
  }).join("");
}

/** Where a hit was said, in words: "3 November, you said", "Tuesday, in the delivered result". */
function hitWhere(hit) {
  const day = hit.atIso ? dayLabel(hit.atIso) : "";
  const what = hit.kind === "message" ? (hit.from === "person" ? "you said" : "")
    : hit.kind === "work" ? `the work “${hit.title ?? "untitled"}”`
      : hit.kind === "result" ? "in the delivered result"
        : hit.kind === "memory" ? `noted about you${hit.status === "earlier version" ? ", earlier" : ""}`
          : hit.kind === "history" ? "in what has happened"
            : hit.kind === "session" ? `in a ${hit.tool ?? "outside"} session${hit.project ? ` (${hit.project})` : ""}` : hit.kind;
  return [day, what].filter(Boolean).join(", ");
}

let lastQuery = "";
async function runSearch() {
  const query = elements.findInput.value.trim();
  lastQuery = query;
  const seq = ++searchSeq;
  root.classList.toggle("search-yes", Boolean(query));
  if (!query) { elements.findResults.innerHTML = ""; return; }
  const scoped = focus ? `&thread=${encodeURIComponent(focus.threadId)}` : "";
  try {
    const response = await fetch(`/api/assistant/search?q=${encodeURIComponent(query)}${scoped}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (seq !== searchSeq) return;
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    const hits = body.hits ?? [];
    // Grouped by the work they belong to, in the order the best match of each group was found.
    const groups = new Map();
    for (const hit of hits) {
      const label = hit.threads?.[0]?.name ?? (["memory", "history"].includes(hit.kind) ? "What I know about you" : "Not grouped yet");
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(hit);
    }
    const threadCount = hits.length ? new Set(hits.map((hit) => hit.threads?.[0]?.id).filter(Boolean)).size : 0;
    const scope = focus ? ` <button class="lnk" type="button" data-everywhere>Search everything</button>` : "";
    setHtml(elements.findNote, hits.length
      ? `${escapeHtml(capital(count(hits.length, "place")))}${focus ? ` in ${escapeHtml(focus.name)}` : threadCount ? `, in ${escapeHtml(count(threadCount, "thread"))} of work` : ""}.${scope}`
      : `Nothing found by those words${focus ? ` in ${escapeHtml(focus.name)}` : ""}.${scope} <button class="lnk" type="button" data-ask>Ask KenWise to find it</button>`);
    elements.findResults.innerHTML = [...groups].map(([label, list]) => `<h3>${escapeHtml(label)}</h3>${list.map((hit) => {
      const messageId = hit.kind === "message" ? hit.id.slice("message:".length) : "";
      const workId = hit.work?.startsWith("work:") ? hit.work.slice(5) : "";
      const data = [
        messageId && `data-message="${escapeHtml(messageId)}" data-sequence="${escapeHtml(hit.sequence ?? "")}" data-conversation="${escapeHtml(hit.conversation ?? "")}"`,
        workId && `data-work="${escapeHtml(workId)}"`,
        hit.threads?.[0] && `data-in-thread="${escapeHtml(hit.threads[0].id.slice(7))}"`,
        ["memory", "history"].includes(hit.kind) && `data-you="1"`
      ].filter(Boolean).join(" ");
      return `<button class="prow hit" type="button" ${data}><span class="row-m"><span class="row-s">${escapeHtml(hitWhere(hit))}</span><span>${marked(hit.excerpt)}</span></span></button>`;
    }).join("")}`).join("");
  } catch (error) {
    if (seq === searchSeq) elements.findNote.textContent = `Search failed: ${error.message}`;
  }
}

elements.findNote.addEventListener("click", (event) => {
  if (event.target.closest("[data-everywhere]")) { focus = null; root.classList.add("focus-all"); setText(elements.focusTitle, "KenWise"); render(); void runSearch(); return; }
  if (event.target.closest("[data-ask]") && lastQuery) {
    // Plain words found nothing: EV searches the way an agent does, trying other words and reading what it finds.
    closeSheets();
    const clientMessageId = crypto.randomUUID();
    focus?.sent.add(clientMessageId);
    following = true;
    void sendPending({ clientMessageId, text: `Can you find where we talked about ${lastQuery}?`, createdAt: new Date().toISOString(), failed: false });
  }
});

/** Opens the conversation at a message, loading everything between it and what is already shown. */
async function jumpToMessage(messageId, sequence) {
  if (focus && !focusedMessages().some((message) => message.messageId === messageId)) await focusThread(null);
  if (!messages.has(messageId) && Number.isInteger(sequence) && !focus) {
    const first = Math.min(...[...messages.values()].map((message) => message.sequence));
    if (Number.isFinite(first) && sequence < first) {
      try {
        const response = await fetch(`/api/assistant/conversation?conversationId=${encodeURIComponent(conversationId)}&before=${first}&from=${Math.max(1, sequence - 10)}`, { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        for (const message of body.messages ?? []) if (!messages.has(message.messageId)) messages.set(message.messageId, message);
        earlier = Boolean(body.earlier);
      } catch (error) { showStatus(`Could not open that point: ${error.message}`); setTimeout(() => showStatus(""), 4_000); return; }
    }
  }
  following = false;
  render();
  const node = [...elements.col.querySelectorAll("[data-message-id]")].find((item) => item.dataset.messageId === messageId);
  if (!node) return;
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
}

async function openHit(data) {
  closeSheets();
  if (data.message && (!data.conversation || data.conversation === conversationId)) { await jumpToMessage(data.message, Number(data.sequence) || null); return; }
  if (data.work && tasks.has(data.work)) { showTask(data.work, { open: true }); return; }
  if (data.inThread) { await focusThread(data.inThread); return; }
  if (data.you) { openSheet("sheet-you"); void showUnderstanding(); }
}

elements.findResults.addEventListener("click", (event) => {
  const hit = event.target.closest("button.hit");
  if (hit) void openHit(hit.dataset);
});

// ---------- Understanding you: notes and history ----------

let memoryClaims = [];
let historyLines = [];
let editingClaimId = null;
let memoryFilter = "all";
const KIND_LABELS = { fact: "About you", preference: "Preference", goal: "Goal", agreement: "How KenWise works with you", state: "Right now", lesson: "Lesson from earlier work" };
const claimText = (claim) => typeof claim.current.value === "string" ? claim.current.value : claim.current.value?.text ?? "";
// Heard (your words), a guess, or a guess EV came to rely on by its own judgement.
function claimStanding(claim) {
  const current = claim.current;
  if (current.status === "candidate") return { kind: "guess", badge: "My guess", className: "b-guess" };
  if (current.status === "disputed") return { kind: "other", badge: "You have said both", className: "" };
  if (current.status !== "active") return { kind: "other", badge: current.status, className: "" };
  if (current.value?.reliedBecause) return { kind: "relied", badge: "Relied on", className: "" };
  if (current.authorType === "user") return { kind: "said", badge: "You said", className: "b-said" };
  return { kind: "other", badge: "", className: "" };
}
const day = (iso) => String(iso ?? "").slice(0, 10);
const evidenceItem = (item) => `<li>${escapeHtml(day(item.at))}: ${item.forgotten ? "(forgotten)" : item.said ? `“${escapeHtml(item.said)}”` : item.work ? `work “${escapeHtml(item.work)}”` : "entered by hand"}</li>`;

function renderMemory() {
  const shown = memoryClaims.filter((claim) => memoryFilter === "all" || claimStanding(claim).kind === memoryFilter);
  elements.memoryList.innerHTML = shown.length ? shown.map((claim) => {
    const standing = claimStanding(claim);
    const meta = [KIND_LABELS[claim.kind] ?? claim.kind, claim.current.value?.state ? String(claim.current.value.state).replace("_", " ") : "", `revision ${claim.current.revision}`].filter(Boolean);
    return `<article class="tile mem" data-claim-id="${escapeHtml(claim.claimId)}">
      <p>${escapeHtml(claimText(claim))}</p>
      <div class="meta">${standing.badge ? `<span class="badge ${standing.className}">${escapeHtml(standing.badge)}</span>` : ""}<span>${escapeHtml(meta.join(" · "))}</span></div>
      ${claim.current.value?.reliedBecause ? `<p class="why">Why: ${escapeHtml(claim.current.value.reliedBecause)}</p>` : ""}
      ${claim.evidence?.length ? `<details class="why"><summary>What this rests on (${claim.evidence.length})</summary><ul>${claim.evidence.map(evidenceItem).join("")}</ul></details>` : ""}
      ${editingClaimId === claim.claimId ? `<form class="edit"><input class="in" name="value" maxlength="2000" value="${escapeHtml(claimText(claim))}" aria-label="Correct what I remember" required><button class="btn" type="submit">Save</button></form>` : ""}
      <div class="links">
        <button type="button" class="lnk" data-memory-action="explain">Why I remember this</button>
        <button type="button" class="lnk" data-memory-action="correct">Correct</button>
        <button type="button" class="lnk" data-memory-action="stop_use">Stop using</button>
        <button type="button" class="lnk" data-memory-action="erase">Erase</button>
      </div>
      <p class="note memory-note" aria-live="polite"></p>
    </article>`;
  }).join("") : `<p class="note">${memoryClaims.length ? "Nothing of this kind." : "Nothing noted yet. I learn from our conversation and from finished work."}</p>`;
  // The dated history: each line opens to the messages and work it summarises.
  elements.historyList.innerHTML = historyLines.length ? [...historyLines].reverse().map((line) => `
    <details class="hist">
      <summary><span class="when">${escapeHtml(line.label)}</span><span class="row-m"><span>${escapeHtml(line.text)}</span></span></summary>
      <ul>${(line.events ?? []).map((event) => `<li>${escapeHtml(day(event.at))}: ${event.work !== undefined ? `work “${escapeHtml(event.work ?? "untitled")}” settled` : `“${escapeHtml(event.said ?? "")}”`}</li>`).join("")}</ul>
    </details>`).join("") : `<div class="row"><span class="row-s">Nothing has happened yet.</span></div>`;
  for (const button of elements.memoryFilter.querySelectorAll("[data-filter]")) button.setAttribute("aria-pressed", String(button.dataset.filter === memoryFilter));
}

async function loadMemory() {
  const response = await fetch("/api/assistant/memory?scope=global", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Memory load failed: HTTP ${response.status}`);
  memoryClaims = body.claims ?? [];
  const timeline = await fetch("/api/assistant/timeline", { cache: "no-store" });
  historyLines = timeline.ok ? (await timeline.json().catch(() => ({}))).lines ?? [] : [];
  renderMemory();
}

async function memoryCommand(command) {
  const response = await fetch("/api/assistant/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Memory change failed: HTTP ${response.status}`);
  await loadMemory();
  return body;
}

async function showUnderstanding() {
  elements.memoryStatus.textContent = "Loading what I've noted…";
  try {
    await loadMemory();
    elements.memoryStatus.textContent = "Changes apply to work started from now on, not work already running.";
  } catch (error) {
    elements.memoryStatus.textContent = error.message;
  }
}

elements.memoryFilter.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  memoryFilter = button.dataset.filter;
  renderMemory();
});

elements.memoryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = elements.memoryValue.value.trim();
  if (!value) return;
  elements.memoryStatus.textContent = "Saving…";
  void memoryCommand({ action: "remember", value, scope: "global" }).then(() => {
    elements.memoryValue.value = "";
    elements.memoryStatus.textContent = "Noted, as something you said.";
  }).catch((error) => { elements.memoryStatus.textContent = error.message; });
});

elements.memoryList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-memory-action]");
  if (!button) return;
  const item = button.closest("[data-claim-id]");
  const claimId = item?.dataset.claimId;
  const claim = memoryClaims.find((candidate) => candidate.claimId === claimId);
  if (!claim) return;
  const action = button.dataset.memoryAction;
  if (action === "correct") {
    editingClaimId = claimId;
    renderMemory();
    elements.memoryList.querySelector(`[data-claim-id="${CSS.escape(claimId)}"] input`)?.focus();
    return;
  }
  if (action === "explain") {
    void fetch(`/api/assistant/memory/${encodeURIComponent(claimId)}/explain`, { cache: "no-store" })
      .then((response) => response.json().then((body) => ({ response, body })))
      .then(({ response, body }) => {
        if (!response.ok) throw new Error(body.error ?? "Could not explain this memory");
        const sources = body.explanation.sources.map((source) => source.sourceType).join(", ");
        item.querySelector(".memory-note").textContent = `Active in ${body.explanation.scope}; revision ${body.explanation.currentRevision.revision}; source: ${sources || "none"}.`;
      }).catch((error) => { item.querySelector(".memory-note").textContent = error.message; });
    return;
  }
  if (action === "erase" && !window.confirm("Erase this? This is separate from merely stopping its use.")) return;
  button.disabled = true;
  void memoryCommand({ action, claimId }).then(() => {
    elements.memoryStatus.textContent = action === "erase" ? "Erased and left out of anything from now on." : "Stopped using this.";
  }).catch((error) => { elements.memoryStatus.textContent = error.message; button.disabled = false; });
});

elements.memoryList.addEventListener("submit", (event) => {
  const form = event.target.closest("form.edit");
  if (!form) return;
  event.preventDefault();
  const item = form.closest("[data-claim-id]");
  const claim = memoryClaims.find((candidate) => candidate.claimId === item?.dataset.claimId);
  const value = new FormData(form).get("value")?.trim();
  if (!claim || !value) return;
  void memoryCommand({ action: "correct", claimId: claim.claimId, expectedRevision: claim.current.revision, value }).then(() => {
    editingClaimId = null;
    elements.memoryStatus.textContent = "Correction saved as a new revision.";
    renderMemory();
  }).catch((error) => { elements.memoryStatus.textContent = error.message; });
});

// ---------- Start ----------

applyLook();
restorePending();
try { elements.input.value = localStorage.getItem(DRAFT_KEY) ?? ""; } catch {}
resizeInput();
render();
connect();
elements.input.focus({ preventScroll: true });
window.addEventListener("online", () => { if (connection !== "live") connect(); void retryPending(); });
