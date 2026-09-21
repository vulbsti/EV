const elements = {
  messages: document.getElementById("messages"),
  empty: document.getElementById("empty-state"),
  composer: document.getElementById("composer"),
  input: document.getElementById("message-input"),
  status: document.getElementById("connection-status"),
  composerStatus: document.getElementById("composer-status"),
  newConversation: document.getElementById("new-conversation"),
  understandingToggle: document.getElementById("understanding-toggle"),
  understandingClose: document.getElementById("understanding-close"),
  understandingPanel: document.getElementById("understanding-panel"),
  memoryForm: document.getElementById("memory-form"),
  memoryValue: document.getElementById("memory-value"),
  memoryStatus: document.getElementById("memory-status"),
  memoryList: document.getElementById("memory-list")
};

const conversationId = new URLSearchParams(location.search).get("conversation") ?? "default";
if (!/^[A-Za-z0-9._:-]{1,128}$/.test(conversationId)) location.replace("/");

let messages = [];
const tasks = new Map();
const cancelCommands = new Map();
const pending = new Map();
let revision = 0;
let taskRevision = 0;
let retrying = false;
let synchronizing = false;
let memoryClaims = [];
let editingClaimId = null;
const PENDING_KEY = `ev.pending-messages.v1.${conversationId}`;

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

function mergeTasks(incoming) {
  for (const task of incoming) tasks.set(task.taskId, task);
}

function taskLabel(status) {
  if (status === "leased" || status === "running") return "working";
  return status?.replaceAll("_", " ") ?? "queued";
}

function renderTask(task) {
  if (!task) return "";
  const terminal = ["completed", "failed", "cancelled"].includes(task.status);
  const artifact = task.artifacts?.[0];
  const detail = task.status === "failed" ? task.error?.message ?? "The worker could not complete this task." :
    task.status === "cancelled" ? "Stopped. No late worker result can replace this state." :
    task.status === "completed" ? task.result?.summary ?? "Finished and verified." :
    task.status === "queued" ? "Saved and waiting for the reviewed worker." : "The reviewed worker is using its isolated task workspace.";
  return `<section class="task-card ${escapeHtml(task.status)}" data-task-id="${escapeHtml(task.taskId)}" aria-label="Background task">
    <div class="task-card-head"><span class="task-status ${escapeHtml(task.status)}">${escapeHtml(taskLabel(task.status))}</span><span class="task-time">${escapeHtml(task.updatedAt ? new Date(task.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "")}</span></div>
    <p>${escapeHtml(detail)}</p>
    <div class="task-actions">
      ${artifact ? `<a class="task-artifact" href="/api/assistant/artifacts/${encodeURIComponent(artifact.artifactId)}" download="${escapeHtml(artifact.relativePath.split("/").at(-1))}">Download verified brief</a>` : ""}
      ${!terminal ? `<button type="button" class="task-cancel" data-command="cancel">Cancel</button>` : ""}
    </div>
  </section>`;
}

function renderMemory() {
  elements.memoryList.innerHTML = memoryClaims.length ? memoryClaims.map((claim) => `
    <article class="memory-item" data-claim-id="${escapeHtml(claim.claimId)}">
      <p>${escapeHtml(claim.current.value)}</p>
      <div class="memory-meta">Scope: ${escapeHtml(claim.scope)} · revision ${escapeHtml(claim.current.revision)}</div>
      <div class="memory-actions">
        <button type="button" data-memory-action="explain">Why I remember this</button>
        <button type="button" data-memory-action="correct">Correct</button>
        <button type="button" data-memory-action="stop_use">Stop using</button>
        <button type="button" data-memory-action="erase">Erase</button>
      </div>
      ${editingClaimId === claim.claimId ? `<form class="memory-correction"><input name="value" maxlength="2000" value="${escapeHtml(claim.current.value)}" aria-label="Correct remembered guidance" required><button type="submit">Save</button></form>` : ""}
      <div class="memory-note" aria-live="polite"></div>
    </article>`).join("") : `<p class="memory-note">No active guidance yet.</p>`;
}

async function loadMemory() {
  const response = await fetch("/api/assistant/memory?scope=global", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Memory load failed: HTTP ${response.status}`);
  memoryClaims = body.claims ?? [];
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
  elements.understandingPanel.hidden = false;
  elements.understandingToggle.setAttribute("aria-expanded", "true");
  elements.memoryStatus.textContent = "Loading source-linked guidance…";
  try {
    await loadMemory();
    elements.memoryStatus.textContent = "Changes apply to future context packages, not work already running.";
  } catch (error) {
    elements.memoryStatus.textContent = error.message;
  }
}

function hideUnderstanding() {
  elements.understandingPanel.hidden = true;
  elements.understandingToggle.setAttribute("aria-expanded", "false");
  elements.understandingToggle.focus();
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
    <article class="message ${escapeHtml(message.role)} ${message.pending ? "pending" : ""}" data-message-id="${escapeHtml(message.messageId)}" data-message-status="${escapeHtml(message.pending ? "unconfirmed" : message.status ?? "answered")}"${message.taskId ? ` data-linked-task-id="${escapeHtml(message.taskId)}"` : ""}>
      <div class="message-label">${message.role === "assistant" ? "EV" : "You"}${message.pending ? message.failed ? " · retrying when connected" : " · sending" : ""}</div>
      <p>${escapeHtml(message.content)}</p>
      ${message.taskId ? renderTask(tasks.get(message.taskId)) : message.taskStatus ? `<span class="task-status ${escapeHtml(message.taskStatus)}">${escapeHtml(message.taskStatus.replaceAll("_", " "))}</span>` : ""}
    </article>`).join("");
  requestAnimationFrame(() => { document.getElementById("conversation").scrollTop = document.getElementById("conversation").scrollHeight; });
}

async function loadTasks({ incremental = false } = {}) {
  const after = incremental ? taskRevision : 0;
  const response = await fetch(`/api/assistant/tasks?conversationId=${encodeURIComponent(conversationId)}&after=${after}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Task sync failed: HTTP ${response.status}`);
  const body = await response.json();
  if (!incremental) tasks.clear();
  mergeTasks(body.tasks ?? []);
  taskRevision = Math.max(taskRevision, body.revision ?? 0);
  document.getElementById("conversation").dataset.taskRevision = String(taskRevision);
  render();
}

async function cancelTask(taskId, retryOnConflict = true) {
  const task = tasks.get(taskId);
  if (!task || ["completed", "failed", "cancelled"].includes(task.status)) return;
  const commandId = cancelCommands.get(taskId) ?? crypto.randomUUID();
  cancelCommands.set(taskId, commandId);
  const response = await fetch(`/api/assistant/tasks/${encodeURIComponent(taskId)}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandId, type: "cancel", expectedRevision: task.revision })
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 409 && retryOnConflict) {
    await loadTasks({ incremental: true });
    return cancelTask(taskId, false);
  }
  if (!response.ok) throw new Error(body.error ?? `Cancel failed: HTTP ${response.status}`);
  mergeTasks([body.task]);
  taskRevision = Math.max(taskRevision, body.revision ?? body.task?.revision ?? 0);
  render();
}

async function loadConversation({ incremental = false } = {}) {
  try {
    const after = incremental ? revision : 0;
    const response = await fetch(`/api/assistant/conversation?conversationId=${encodeURIComponent(conversationId)}&after=${after}`, { cache: "no-store" });
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
      body: JSON.stringify({ conversationId, clientMessageId: item.clientMessageId, text: item.text })
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
    if (connected) await loadTasks({ incremental: true });
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

elements.messages.addEventListener("click", (event) => {
  const button = event.target.closest("button.task-cancel");
  if (!button) return;
  const taskId = button.closest("[data-task-id]")?.dataset.taskId;
  if (!taskId) return;
  button.disabled = true;
  void cancelTask(taskId).catch((error) => {
    elements.composerStatus.textContent = error.message;
    button.disabled = false;
  });
});

elements.understandingToggle.addEventListener("click", () => { void showUnderstanding(); });
elements.newConversation.addEventListener("click", () => {
  location.href = `/?conversation=${encodeURIComponent(`chat-${crypto.randomUUID()}`)}`;
});
elements.understandingClose.addEventListener("click", hideUnderstanding);
elements.memoryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = elements.memoryValue.value.trim();
  if (!value) return;
  elements.memoryStatus.textContent = "Saving explicit guidance…";
  void memoryCommand({ action: "remember", value, scope: "global" }).then(() => {
    elements.memoryValue.value = "";
    elements.memoryStatus.textContent = "Remembered with its explicit source.";
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
  if (action === "erase" && !window.confirm("Erase this remembered guidance? This is separate from merely stopping its use.")) return;
  button.disabled = true;
  void memoryCommand({ action, claimId }).then(() => {
    elements.memoryStatus.textContent = action === "erase" ? "Erased and excluded from future context." : "Stopped using this guidance.";
  }).catch((error) => { elements.memoryStatus.textContent = error.message; button.disabled = false; });
});

elements.memoryList.addEventListener("submit", (event) => {
  const form = event.target.closest("form.memory-correction");
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

restorePending();
const connected = await loadConversation();
if (connected) await loadTasks();
if (connected) await retryPending({ refresh: false });
elements.input.focus();
window.addEventListener("online", () => { void synchronize(); });
setInterval(() => { void synchronize(); }, 4000);
