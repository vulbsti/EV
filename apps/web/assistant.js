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
  responsibilitiesToggle: document.getElementById("responsibilities-toggle"),
  responsibilitiesClose: document.getElementById("responsibilities-close"),
  responsibilitiesPanel: document.getElementById("responsibilities-panel"),
  connectionForm: document.getElementById("connection-form"),
  githubResource: document.getElementById("github-resource"),
  responsibilityStatus: document.getElementById("responsibility-status"),
  mandatePreview: document.getElementById("mandate-preview"),
  responsibilityList: document.getElementById("responsibility-list"),
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
let responsibilities = [];
let verifiedSource = null;
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

function mergeTasks(incoming) {
  for (const task of incoming) tasks.set(task.taskId, task);
}

function taskLabel(status) {
  if (status === "leased" || status === "running") return "working";
  if (status === "verifying") return "checking quality";
  return status?.replaceAll("_", " ") ?? "queued";
}

function reviewSummary(verification) {
  const reviews = verification?.reviews?.filter((review) => !review.unavailable) ?? [];
  if (!reviews.length) return "";
  const accepted = reviews.at(-1).verdict === "accept";
  if (reviews.length === 1) return accepted ? " Accepted on first review." : " Not accepted on review.";
  return accepted ? ` Accepted after ${reviews.length - 1} revision round${reviews.length > 2 ? "s" : ""}.` : ` Still short of the brief after ${reviews.length} review rounds.`;
}

function renderTask(task) {
  if (!task) return "";
  const terminal = ["completed", "failed", "cancelled"].includes(task.status);
  const artifact = task.artifacts?.[0];
  const isR1 = task.capability === "r1-content-package-v1";
  const isOpenClaw = task.capability === "openclaw-general-v1";
  const report = isOpenClaw && task.status === "completed" ? task.result?.report : null;
  const children = [...tasks.values()].filter((child) => child.parentTaskId === task.taskId);
  const displayStatus = report?.outcome === "partial" ? "partial result" : report?.outcome === "blocked" ? "blocked" : taskLabel(task.status);
  const detail = task.status === "failed" ? task.error?.message ?? "The worker could not complete this task." :
    task.status === "cancelled" ? "Stopped. No late worker result can replace this state." :
    task.status === "completed" ? task.result?.summary ?? (isOpenClaw ? report?.outcome === "blocked" ? "The agent could not achieve the requested outcome. The reason is below." : report?.outcome === "partial" ? "Useful work is ready, with unfinished parts or material concerns listed below." : "The requested work is ready." : isR1 ? "Finished with a draft, review receipt, and materially different final." : "Finished and verified.") :
    task.status === "queued" ? "Saved and waiting for its agent." : task.progress?.message ?? (isOpenClaw ? "OpenClaw is working in this task’s workspace." : "The reviewed worker is using its task workspace.");
  const reportMarkup = report ? `<div class="task-report">
    <p><strong>Goal:</strong> ${escapeHtml(report.goal)}</p>
    ${report.limitations?.length ? `<p><strong>${report.outcome === "completed" ? "Caveats" : "Unfinished or uncertain"}:</strong> ${escapeHtml(report.limitations.join(" "))}</p>` : ""}
    <p class="task-answer">${renderAnswer(report.answer)}</p>
    ${report.evidence?.length ? `<details open><summary>Sources (${report.evidence.length})</summary><ul>${report.evidence.map((source) => `<li>${source.url.startsWith("file:") ? `<span>${escapeHtml(source.title || "Local source")}</span> <code>${escapeHtml(decodeURIComponent(new URL(source.url).pathname))}</code>` : `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || source.url)}</a>`}${source.supports ? ` — ${escapeHtml(source.supports)}` : ""}${source.observedAt ? ` · ${escapeHtml(source.observedAt)}` : ""}</li>`).join("")}</ul></details>` : ""}
    ${report.checks?.length ? `<details><summary>Agent checks</summary><ul>${report.checks.map((check) => `<li>${escapeHtml(check)}</li>`).join("")}</ul></details>` : ""}
    ${task.artifacts?.length ? `<ul class="task-deliverables">${task.artifacts.map((file) => `<li><a href="/api/assistant/artifacts/${encodeURIComponent(file.artifactId)}" download>${escapeHtml(file.title || file.relativePath.split("/").at(-1))}</a></li>`).join("")}</ul>` : ""}
    <small>${report.verification?.qualityGate?.unavailable ? "Separate review unavailable." : report.verification?.qualityGate?.skipped ? "Agent outcome and file checks recorded." : "EV reviewed the result against its brief."} ${report.verification?.deliverables?.filter((item) => item.verified).length ?? 0} files checked.${reviewSummary(report.verification)}</small>
  </div>` : "";
  return `<section class="task-card ${escapeHtml(report?.outcome ?? task.status)}" data-task-id="${escapeHtml(task.taskId)}" aria-label="Background task">
    <div class="task-card-head"><span class="task-status ${escapeHtml(report?.outcome ?? task.status)}">${escapeHtml(displayStatus)}</span><span class="task-time">${escapeHtml(task.updatedAt ? new Date(task.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "")}</span></div>
    <h3>${escapeHtml(task.title ?? "Background task")}</h3>
    ${task.brief?.objective ? `<p><strong>Interpreted as:</strong> ${escapeHtml(task.brief.objective)}</p>` : ""}
    ${!task.brief && task.plan?.intent ? `<p><strong>Interpreted as:</strong> ${escapeHtml(task.plan.intent)}</p><details class="task-brief"><summary>EV's brief</summary><p><strong>Success criteria</strong></p><ul>${(task.plan.successCriteria ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>${task.plan.qualityBar?.length ? `<p><strong>Quality bar</strong></p><ul>${task.plan.qualityBar.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}${task.plan.assumptions?.length ? `<p><strong>Assumptions</strong></p><ul>${task.plan.assumptions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}</details>` : ""}
    ${task.brief?.successCriteria?.length ? `<details class="task-brief"><summary>Success criteria and boundaries</summary><ul>${task.brief.successCriteria.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join("")}</ul><p><strong>Authority:</strong> prepare only</p><p><strong>Memory:</strong> reviewed EV guidance; derived memory providers are disabled</p>${task.contextManifestId ? `<p><strong>Context manifest:</strong> <code>${escapeHtml(task.contextManifestId)}</code></p>` : ""}</details>` : ""}
    <p>${escapeHtml(detail)}</p>
    ${children.length ? `<details class="task-children"><summary>Workers · ${children.filter((child) => ["completed", "failed", "cancelled"].includes(child.status)).length}/${children.length} finished</summary><ul>${children.map((child) => `<li><strong>${escapeHtml(child.title)}</strong>${child.retryOf ? " (retry)" : ""} · ${escapeHtml(child.result?.report?.outcome ?? taskLabel(child.status))}${child.error ? ` · ${escapeHtml(child.error.message)}` : ""}</li>`).join("")}</ul></details>` : ""}
    ${reportMarkup}
    <div class="task-actions">
      ${artifact && !isOpenClaw ? isR1
        ? `<a class="task-artifact" href="/api/assistant/artifacts/${encodeURIComponent(artifact.artifactId)}?preview=1" target="_blank" rel="noopener">Open reviewed content package</a>`
        : `<a class="task-artifact" href="/api/assistant/artifacts/${encodeURIComponent(artifact.artifactId)}" download="${escapeHtml(artifact.relativePath.split("/").at(-1))}">Download verified brief</a>` : ""}
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

function renderResponsibilities() {
  elements.responsibilityList.innerHTML = responsibilities.length ? responsibilities.map((item) => {
    const observation = item.lastObservation;
    const task = item.task;
    const artifact = task?.artifacts?.[0];
    const failure = item.latestFailure?.data;
    const updates = item.updates ?? [];
    return `<article class="responsibility-item" data-responsibility-id="${escapeHtml(item.responsibilityId)}">
      <div class="responsibility-head"><h3>GitHub launch watch</h3><span class="task-status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></div>
      <p><strong>Source:</strong> ${escapeHtml(item.mandate.resourceRef)}</p>
      <p><strong>Boundary:</strong> prepare only · no comments, merge, push, labels, publishing, or messages</p>
      <p><strong>Checks:</strong> every ${escapeHtml(Math.round((item.mandate.trigger?.intervalMs ?? 0) / 1000))} seconds · expires ${escapeHtml(new Date(item.mandate.expiresAt).toLocaleString())}</p>
      ${observation ? `<p><strong>Latest source:</strong> ${escapeHtml(observation.state)} · revision <code>${escapeHtml(observation.sourceRevision)}</code></p>` : `<p>No source observation yet.</p>`}
      ${task ? `<p><strong>Prepared result:</strong> ${escapeHtml(taskLabel(task.status))}${task.contextManifestId ? ` · memory manifest ${escapeHtml(task.contextManifestId)}` : ""}</p>` : ""}
      ${artifact ? `<a class="task-artifact" href="/api/assistant/artifacts/${encodeURIComponent(artifact.artifactId)}" download="${escapeHtml(artifact.relativePath.split("/").at(-1))}">Download verified prepared draft</a>` : ""}
      ${updates.length ? `<div class="responsibility-updates" aria-label="Prepared outcomes">${updates.map((update) => {
        const updateArtifact = update.task?.artifacts?.[0];
        return `<div class="responsibility-update" data-source-revision="${escapeHtml(update.preparedTask.sourceRevision)}">
          <p><strong>${escapeHtml(update.task ? taskLabel(update.task.status) : update.preparedTask.status)}</strong> · source <code>${escapeHtml(update.preparedTask.sourceRevision)}</code></p>
          ${updateArtifact ? `<a class="task-artifact" href="/api/assistant/artifacts/${encodeURIComponent(updateArtifact.artifactId)}" download="${escapeHtml(updateArtifact.relativePath.split("/").at(-1))}">Download verified draft</a>` : ""}
        </div>`;
      }).join("")}</div>` : ""}
      ${failure ? `<p><strong>Last check failed:</strong> ${escapeHtml(failure.code)} — ${escapeHtml(failure.message)}</p>` : ""}
      ${item.status === "active" ? `<div class="responsibility-actions"><button type="button" data-responsibility-action="check_now">Check now</button><button type="button" data-responsibility-action="revoke">Revoke</button></div>` : ""}
    </article>`;
  }).join("") : `<p class="memory-note">No standing responsibility yet.</p>`;
}

async function loadResponsibilities() {
  const response = await fetch("/api/assistant/responsibilities", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Responsibility load failed: HTTP ${response.status}`);
  responsibilities = body.responsibilities ?? [];
  renderResponsibilities();
}

function renderMandatePreview(source) {
  elements.mandatePreview.hidden = false;
  elements.mandatePreview.innerHTML = `<h3>Review this mandate</h3>
    <p><strong>Source:</strong> ${escapeHtml(source.resourceRef)}</p>
    <p><strong>Current title:</strong> ${escapeHtml(source.title)}</p>
    <p><strong>Watch:</strong> title, body, state, draft status, and head revision.</p>
    <p><strong>When changed:</strong> quietly prepare a launch-change briefing and next storyboard draft.</p>
    <p><strong>Authority:</strong> read and prepare only. EV cannot comment, merge, push, label, publish, or message anyone.</p>
    <p><strong>Expiry:</strong> 30 days; you can revoke it immediately.</p>
    <button type="button" data-create-responsibility>Start watching</button>`;
}

async function verifyGitHubSource(resourceRef) {
  const response = await fetch("/api/assistant/connections/github/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resourceRef })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Connection verification failed: HTTP ${response.status}`);
  verifiedSource = body.source;
  renderMandatePreview(verifiedSource);
  return body;
}

async function createResponsibility() {
  if (!verifiedSource) return;
  const response = await fetch("/api/assistant/responsibilities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resourceRef: verifiedSource.resourceRef, conversationId })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Responsibility creation failed: HTTP ${response.status}`);
  verifiedSource = null;
  elements.mandatePreview.hidden = true;
  elements.mandatePreview.innerHTML = "";
  await loadResponsibilities();
  return body;
}

async function commandResponsibility(item, type) {
  const response = await fetch(`/api/assistant/responsibilities/${encodeURIComponent(item.responsibilityId)}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandId: crypto.randomUUID(), type, expectedRevision: item.revision })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Responsibility command failed: HTTP ${response.status}`);
  await loadResponsibilities();
  return body;
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
  elements.responsibilitiesPanel.hidden = true;
  elements.responsibilitiesToggle.setAttribute("aria-expanded", "false");
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

async function showResponsibilities() {
  elements.understandingPanel.hidden = true;
  elements.understandingToggle.setAttribute("aria-expanded", "false");
  elements.responsibilitiesPanel.hidden = false;
  elements.responsibilitiesToggle.setAttribute("aria-expanded", "true");
  elements.responsibilityStatus.textContent = "Loading durable responsibility state…";
  try {
    await loadResponsibilities();
    elements.responsibilityStatus.textContent = "GitHub access stays in the trusted connector; workers receive source data, never credentials.";
  } catch (error) {
    elements.responsibilityStatus.textContent = error.message;
  }
}

function hideResponsibilities() {
  elements.responsibilitiesPanel.hidden = true;
  elements.responsibilitiesToggle.setAttribute("aria-expanded", "false");
  elements.responsibilitiesToggle.focus();
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
    if (connected) await loadResponsibilities();
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
elements.responsibilitiesToggle.addEventListener("click", () => { void showResponsibilities(); });
elements.newConversation.addEventListener("click", () => {
  location.href = `/?conversation=${encodeURIComponent(`chat-${crypto.randomUUID()}`)}`;
});
elements.understandingClose.addEventListener("click", hideUnderstanding);
elements.responsibilitiesClose.addEventListener("click", hideResponsibilities);
elements.connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const resourceRef = elements.githubResource.value.trim();
  if (!resourceRef) return;
  elements.responsibilityStatus.textContent = "Verifying read-only GitHub access…";
  void verifyGitHubSource(resourceRef).then(() => {
    elements.responsibilityStatus.textContent = "Read-only access verified. Review the mandate before starting.";
  }).catch((error) => {
    verifiedSource = null;
    elements.mandatePreview.hidden = true;
    elements.responsibilityStatus.textContent = error.message;
  });
});
elements.mandatePreview.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-create-responsibility]");
  if (!button) return;
  button.disabled = true;
  elements.responsibilityStatus.textContent = "Saving the reviewed mandate and baseline revision…";
  void createResponsibility().then(() => {
    elements.responsibilityStatus.textContent = "Standing responsibility is active. EV will check it while this browser is closed.";
  }).catch((error) => {
    elements.responsibilityStatus.textContent = error.message;
    button.disabled = false;
  });
});
elements.responsibilityList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-responsibility-action]");
  if (!button) return;
  const card = button.closest("[data-responsibility-id]");
  const item = responsibilities.find((candidate) => candidate.responsibilityId === card?.dataset.responsibilityId);
  if (!item) return;
  const type = button.dataset.responsibilityAction;
  if (type === "revoke" && !window.confirm("Revoke this standing responsibility? Later source changes will not start work.")) return;
  button.disabled = true;
  elements.responsibilityStatus.textContent = type === "revoke" ? "Revoking authority…" : "Checking the source now…";
  void commandResponsibility(item, type).then(() => {
    elements.responsibilityStatus.textContent = type === "revoke" ? "Revoked. Later changes cannot start work." : "Check completed against the durable source revision.";
  }).catch((error) => {
    elements.responsibilityStatus.textContent = error.message;
    button.disabled = false;
  });
});
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
if (connected) await loadResponsibilities();
if (connected) await retryPending({ refresh: false });
elements.input.focus();
window.addEventListener("online", () => { void synchronize(); });
setInterval(() => { void synchronize(); }, 4000);
