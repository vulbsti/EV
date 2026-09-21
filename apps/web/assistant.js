const elements = {
  messages: document.getElementById("messages"),
  empty: document.getElementById("empty-state"),
  composer: document.getElementById("composer"),
  input: document.getElementById("message-input"),
  status: document.getElementById("connection-status"),
  composerStatus: document.getElementById("composer-status")
};

let messages = [];
const pending = new Map();
let revision = 0;
let retrying = false;
let synchronizing = false;
const PENDING_KEY = "ev.pending-messages.v1";

function restorePending() {
  try {
    const stored = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]");
    for (const item of stored) {
      if (item?.clientMessageId && item?.text && item?.createdAt) pending.set(item.clientMessageId, { ...item, pending: true });
    }
  } catch {
    try { localStorage.removeItem(PENDING_KEY); } catch {}
  }
}

function persistPending() {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify([...pending.values()].map(({ clientMessageId, text, createdAt }) => ({ clientMessageId, text, createdAt }))));
  } catch {
    elements.composerStatus.textContent = "This browser could not persist pending messages.";
  }
}

function mergeMessages(incoming) {
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  for (const message of incoming) byId.set(message.messageId, message);
  messages = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
  const confirmedClientIds = new Set(messages.map((message) => message.clientMessageId).filter(Boolean));
  for (const clientMessageId of confirmedClientIds) pending.delete(clientMessageId);
  persistPending();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function render() {
  const visible = [...messages, ...[...pending.values()].map((item) => ({
    messageId: item.clientMessageId,
    role: "user",
    content: item.text,
    createdAt: item.createdAt,
    status: "received",
    pending: true,
    failed: item.failed
  }))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  elements.empty.hidden = visible.length > 0;
  elements.messages.innerHTML = visible.map((message) => `
    <article class="message ${escapeHtml(message.role)} ${message.pending ? "pending" : ""}" data-message-id="${escapeHtml(message.messageId)}" data-message-status="${escapeHtml(message.pending ? "unconfirmed" : message.status ?? "answered")}"${message.taskId ? ` data-task-id="${escapeHtml(message.taskId)}"` : ""}>
      <div class="message-label">${message.role === "assistant" ? "EV" : "You"}${message.pending ? message.failed ? " · retrying when connected" : " · sending" : ""}</div>
      <p>${escapeHtml(message.content)}</p>
      ${message.taskStatus ? `<span class="task-status ${escapeHtml(message.taskStatus)}">${escapeHtml(message.taskStatus.replaceAll("_", " "))}</span>` : ""}
    </article>`).join("");
  requestAnimationFrame(() => { document.getElementById("conversation").scrollTop = document.getElementById("conversation").scrollHeight; });
}

async function loadConversation({ incremental = false } = {}) {
  try {
    const after = incremental ? revision : 0;
    const response = await fetch(`/api/assistant/conversation?after=${after}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!incremental) messages = [];
    mergeMessages(body.messages);
    revision = Math.max(revision, body.revision);
    document.getElementById("conversation").dataset.revision = String(revision);
    elements.status.textContent = "Saved locally";
    elements.status.className = "online";
    elements.composerStatus.textContent = "Replies survive reload and daemon restart.";
    render();
    return true;
  } catch (error) {
    elements.status.textContent = "Offline";
    elements.status.className = "offline";
    elements.composerStatus.textContent = `Could not load conversation: ${error.message}`;
    render();
    return false;
  }
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 160)}px`;
}

async function sendPending(item) {
  item.pending = true;
  item.failed = false;
  pending.set(item.clientMessageId, item);
  persistPending();
  render();
  try {
    const response = await fetch("/api/assistant/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientMessageId: item.clientMessageId, text: item.text })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    const body = await response.json();
    pending.delete(item.clientMessageId);
    mergeMessages(body.messages);
    revision = Math.max(revision, ...body.messages.map((message) => message.sequence));
    document.getElementById("conversation").dataset.revision = String(revision);
    elements.status.textContent = "Saved locally";
    elements.status.className = "online";
    elements.composerStatus.textContent = "Replies survive reload and daemon restart.";
    render();
  } catch (error) {
    item.failed = true;
    pending.set(item.clientMessageId, item);
    persistPending();
    elements.status.textContent = "Needs retry";
    elements.status.className = "offline";
    elements.composerStatus.textContent = `Message was not confirmed: ${error.message}`;
    render();
  }
}

async function submitMessage(text) {
  return sendPending({ clientMessageId: crypto.randomUUID(), text, createdAt: new Date().toISOString(), pending: true, failed: false });
}

async function retryPending({ refresh = true } = {}) {
  if (retrying || !pending.size) return;
  retrying = true;
  try {
    if (refresh && !await loadConversation({ incremental: false })) return;
    for (const item of [...pending.values()]) await sendPending(item);
  } finally {
    retrying = false;
  }
}

async function synchronize() {
  if (synchronizing) return;
  synchronizing = true;
  try {
    const connected = await loadConversation({ incremental: true });
    if (connected && pending.size) await retryPending({ refresh: false });
  } finally {
    synchronizing = false;
  }
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.input.value.trim();
  if (!text) return;
  elements.input.value = "";
  resizeInput();
  elements.composerStatus.textContent = "Saving…";
  void submitMessage(text);
});

elements.input.addEventListener("input", resizeInput);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

restorePending();
const connected = await loadConversation();
if (connected) await retryPending({ refresh: false });
elements.input.focus();
window.addEventListener("online", () => { void synchronize(); });
setInterval(() => { void synchronize(); }, 4000);
