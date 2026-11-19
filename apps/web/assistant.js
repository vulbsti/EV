// EV's page: one ongoing conversation, kept live by a single stream of changes.
// Each message and each piece of work is one keyed element, updated in place,
// so whatever the person opened stays open and focus stays where it was.

const $ = (id) => document.getElementById(id);
const root = $("ev");
const elements = {
  stream: $("stream"),
  col: $("col"),
  earlier: $("earlier"),
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
  const text = authMissing ? "Open EV from the link the daemon printed when it started."
    : statusNote ? statusNote
      : connection === "lost" ? "I can't reach EV right now. I'll keep trying, and anything you send waits here."
        : failed ? "Not sent yet. I'll send it as soon as I can reach EV."
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
  file: '<svg class="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 19h14"></path></svg>'
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
  if (task.status === "verifying") return task.progress?.message ? `Now: ${task.progress.message}` : "Checking the result against its brief.";
  return task.progress?.message ? `Now: ${task.progress.message}` : isOpenClaw ? "An agent is working in this task's workspace." : "The reviewed worker is using its task workspace.";
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
    parts.push(`<p class="note">${gate?.unavailable ? "Separate review unavailable." : gate?.skipped ? "Agent outcome and file checks recorded." : "EV reviewed the result against its brief."} ${report.verification?.deliverables?.filter((item) => item.verified).length ?? 0} files checked.${reviewSummary(report.verification)}</p>`);
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

function visibleMessages() {
  const list = [...messages.values()].sort((a, b) => a.sequence - b.sequence);
  const confirmed = new Set(list.map((message) => message.clientMessageId).filter(Boolean));
  const waiting = [...pending.values()].filter((item) => !confirmed.has(item.clientMessageId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

function messageNode(message) {
  const key = keyOf(message);
  let node = nodes.get(key);
  if (!node) {
    if (message.role === "user") {
      node = make("article", "msg turn-me");
      const bubble = make("div", "me");
      bubble.append(make("p"));
      node.append(bubble, make("span", "sending"), make("div", "cards"));
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
    setText(note, message.pending ? message.failed ? "Not sent yet. Retrying when EV is reachable." : "Sending" : "");
    note.hidden = !message.pending;
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
      <div class="details" id="${escapeHtml(detailsId)}" hidden></div>
      <div class="acts qa"><button type="button" class="btn quiet" data-toggle aria-expanded="false" aria-controls="${escapeHtml(detailsId)}">${ICON.chevron}<span>Details</span></button><button type="button" class="btn quiet" data-hold>${ICON.pause}Hold</button></div>`;
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

  const order = [];
  const used = new Set();
  let lastDay = null;
  for (const message of list) {
    const day = dayKey(message.createdAt);
    if (day !== lastDay) { const divider = dayNode(day, message.createdAt); order.push(divider); used.add(`d:${day}`); lastDay = day; }
    const node = messageNode(message);
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
      typing = make("div", "said typing", { role: "status", "aria-busy": "true", "aria-label": "EV is thinking" });
      typing.innerHTML = "<i></i><i></i><i></i>";
    }
    order.push(typing);
  } else typing = null;

  arrange(elements.col, order, elements.earlier);
  elements.earlier.hidden = !earlier;
  elements.empty.hidden = !loaded || list.length > 0 || earlier;
  renderWork();
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
  loaded = true;
  render();
  toBottom();
}

function applyChange(data) {
  upsertMessages(data.messages);
  upsertTasks(data.tasks);
  if (typeof data.thinking === "boolean") thinking = data.thinking;
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
  void sendPending({ clientMessageId: crypto.randomUUID(), text, createdAt: new Date().toISOString(), failed: false });
});
elements.input.addEventListener("input", () => { resizeInput(); saveDraft(); });
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

// ---------- Hold ----------

async function holdTask(taskId, retryOnConflict = true) {
  const task = tasks.get(taskId);
  if (!task || resting(task)) return;
  const commandId = holdCommands.get(taskId) ?? crypto.randomUUID();
  holdCommands.set(taskId, commandId);
  try {
    const response = await fetch(`/api/assistant/tasks/${encodeURIComponent(taskId)}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId, type: "hold", expectedRevision: task.revision })
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && retryOnConflict) {
      // Someone moved it on meanwhile: read its latest revision and try once more.
      const latest = await fetch(`/api/assistant/tasks?conversationId=${encodeURIComponent(conversationId)}`, { cache: "no-store" }).then((reply) => reply.json()).catch(() => ({}));
      upsertTasks((latest.tasks ?? []).filter((item) => item.taskId === taskId));
      holdCommands.delete(taskId);
      return holdTask(taskId, false);
    }
    if (!response.ok) throw new Error(body.error ?? `Hold failed: HTTP ${response.status}`);
    upsertTasks([body.task]);
  } catch (error) {
    holdCommands.delete(taskId);
    showStatus(error.message);
    setTimeout(() => showStatus(""), 5_000);
  }
  render();
}

// ---------- Clicks in the conversation ----------

elements.col.addEventListener("click", (event) => {
  if (event.target.closest("#earlier")) { void loadEarlier(); return; }
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
  }
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
});

// ---------- Search ----------

let searchTimer = null;
let searchSeq = 0;
elements.findInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 220);
});

async function runSearch() {
  const query = elements.findInput.value.trim();
  const seq = ++searchSeq;
  if (!query) {
    elements.findNote.textContent = "One conversation, always. Search what was said, the work, and what I remember.";
    elements.findResults.innerHTML = "";
    return;
  }
  try {
    const response = await fetch(`/api/assistant/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (seq !== searchSeq) return;
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    const hits = body.hits ?? [];
    elements.findNote.textContent = hits.length ? `${hits.length === 1 ? "One place" : `${hits.length} places`} mention it.` : "Nothing found.";
    elements.findResults.innerHTML = hits.map((hit) => {
      const kind = { message: hit.from === "person" ? "you said" : "I said", work: "work", result: "a result", memory: "memory", session: hit.outside ?? "elsewhere", history: "history" }[hit.kind] ?? hit.kind;
      const meta = [hit.at, kind, hit.title, hit.status, hit.period].filter(Boolean).join(" · ");
      const messageId = hit.kind === "message" ? hit.id.slice("message:".length) : null;
      const workId = hit.work?.startsWith("work:") ? hit.work.slice(5) : null;
      const target = messageId && messages.has(messageId) ? ` data-message="${escapeHtml(messageId)}"` : workId && tasks.has(workId) ? ` data-work="${escapeHtml(workId)}"` : "";
      const tag = target ? "button" : "div";
      return `<${tag} class="prow hit"${target ? ` type="button"${target}` : ""}><span class="row-m"><span class="row-s">${escapeHtml(meta)}</span><span>${escapeHtml(hit.excerpt ?? "")}</span></span></${tag}>`;
    }).join("");
  } catch (error) {
    if (seq === searchSeq) elements.findNote.textContent = `Search failed: ${error.message}`;
  }
}

elements.findResults.addEventListener("click", (event) => {
  const hit = event.target.closest("button.hit");
  if (!hit) return;
  if (hit.dataset.work) { showTask(hit.dataset.work, { open: true }); return; }
  closeSheets();
  const node = [...elements.col.querySelectorAll("[data-message-id]")].find((item) => item.dataset.messageId === hit.dataset.message);
  if (!node) return;
  following = false;
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
});

// ---------- Understanding you: notes and history ----------

let memoryClaims = [];
let historyLines = [];
let editingClaimId = null;
let memoryFilter = "all";
const KIND_LABELS = { fact: "About you", preference: "Preference", goal: "Goal", agreement: "How EV works with you", state: "Right now", lesson: "Lesson from earlier work" };
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
