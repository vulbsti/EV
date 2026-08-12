const state = {
  snapshot: { sessions: [], panes: [], attentionCount: 0 },
  view: "all",
  sessionId: "all",
  search: "",
  columns: 5,
  paused: false,
  polling: false,
  selected: new Set(),
  drafts: new Map(),
  focusedPaneId: null,
  dismissedAttention: new Set(),
  seenAttention: new Set(),
  popupPaneId: null,
  eventsVisible: false
};

const ids = ["connection-dot", "count-all", "count-attention", "count-working", "session-nav", "daemon-state", "scan-state", "view-title", "view-subtitle", "search", "pause", "notifications", "refresh", "visible-count", "strip-attention", "strip-working", "selected-count", "updated-at", "terminal-wall", "attention-badge", "attention-list", "orchestrator-input", "orchestrator-context", "delegate", "orchestrator-reply", "toggle-events", "task-list", "event-list", "broadcast-dock", "dock-count", "clear-selection", "broadcast-input", "broadcast-send", "focus-overlay", "focus-session", "focus-title", "focus-path", "focus-terminal", "focus-command", "focus-input", "open-explainer", "close-focus", "spawn-dialog", "spawn-form", "spawn-mode", "spawn-target-label", "spawn-target", "spawn-name", "spawn-cwd", "spawn-command", "spawn-error", "new-runtime", "attention-popup", "dismiss-popup", "popup-title", "popup-evidence", "popup-dismiss", "popup-focus", "toast-stack"];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

async function api(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (await response.json()).error ?? message; } catch {}
    throw new Error(message);
  }
  return response;
}

function relativeTime(timestamp) {
  if (!timestamp) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 3) return "now";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

function tailWindow(content, lineCount = 22) {
  return String(content ?? "").split("\n").slice(-lineCount).join("\n").trimEnd();
}

function attentionKey(pane) {
  return `${pane.paneId}:${pane.attention?.id}:${pane.attention?.evidence}`;
}

function visiblePanes() {
  const query = state.search.toLowerCase();
  return state.snapshot.panes.filter((pane) => {
    if (state.sessionId !== "all" && pane.sessionId !== state.sessionId) return false;
    if (state.view === "attention" && !pane.attention?.required) return false;
    if (state.view === "working" && pane.activity !== "working") return false;
    return `${pane.paneId} ${pane.sessionName} ${pane.command} ${pane.path} ${pane.tail}`.toLowerCase().includes(query);
  }).sort((a, b) => Number(Boolean(b.attention?.required)) - Number(Boolean(a.attention?.required)) || a.sessionName.localeCompare(b.sessionName) || a.windowIndex - b.windowIndex || a.paneIndex - b.paneIndex);
}

function preserveDrafts() {
  document.querySelectorAll("[data-command-input]").forEach((input) => state.drafts.set(input.dataset.commandInput, input.value));
}

function renderNavigation() {
  const panes = state.snapshot.panes;
  el["count-all"].textContent = panes.length;
  el["count-attention"].textContent = panes.filter((pane) => pane.attention?.required).length;
  el["count-working"].textContent = panes.filter((pane) => pane.activity === "working").length;
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  el["session-nav"].innerHTML = `<button class="rail-button ${state.sessionId === "all" ? "active" : ""}" data-session="all"><span>⌘</span>All sessions<b>${panes.length}</b></button>` + state.snapshot.sessions.map((session) => `
    <button class="rail-button ${state.sessionId === session.sessionId ? "active" : ""}" data-session="${escapeHtml(session.sessionId)}"><span>▤</span>${escapeHtml(session.name)}<b>${session.paneCount}</b></button>`).join("");
}

function renderTerminalWall() {
  preserveDrafts();
  const activeInput = document.activeElement?.dataset?.commandInput;
  const panes = visiblePanes();
  const lineCount = state.columns >= 6 ? 15 : state.columns === 5 ? 18 : 23;
  el["terminal-wall"].className = `terminal-wall columns-${state.columns}`;
  el["visible-count"].textContent = panes.length;
  if (!panes.length) {
    el["terminal-wall"].innerHTML = '<div class="loading">No terminals match this workspace view.</div>';
    return;
  }
  el["terminal-wall"].innerHTML = panes.map((pane) => {
    const attention = pane.attention?.required;
    return `<article class="terminal-card ${attention ? "needs-attention" : pane.activity === "working" ? "working" : ""} ${state.selected.has(pane.paneId) ? "selected" : ""}" data-card-pane="${escapeHtml(pane.paneId)}">
      <header class="terminal-head">
        <input type="checkbox" data-select-pane="${escapeHtml(pane.paneId)}" ${state.selected.has(pane.paneId) ? "checked" : ""} title="Select for broadcast">
        <strong>${escapeHtml(pane.paneId)} · ${escapeHtml(pane.command)}</strong>
        <small>${escapeHtml(pane.sessionName)} · ${escapeHtml(pane.path)}</small>
        <span class="terminal-status">${attention ? "NEEDS YOU" : pane.activity === "working" ? "CHANGING" : "STEADY"}</span>
        <button class="explain-button" data-explain-pane="${escapeHtml(pane.paneId)}" title="Open a separate explanation window">WHY?</button>
        <button class="expand-button" data-focus-pane="${escapeHtml(pane.paneId)}" title="Focus terminal">⛶</button>
      </header>
      <pre class="terminal-output">${escapeHtml(tailWindow(pane.tail, lineCount) || "No captured output")}</pre>
      <div class="terminal-command"><span>❯</span><input data-command-input="${escapeHtml(pane.paneId)}" value="${escapeHtml(state.drafts.get(pane.paneId) ?? "")}" placeholder="send to ${escapeHtml(pane.paneId)}" autocomplete="off"><button data-quick-key="C-c" data-pane="${escapeHtml(pane.paneId)}">^C</button><button data-send-pane="${escapeHtml(pane.paneId)}">SEND</button></div>
    </article>`;
  }).join("");
  if (activeInput) {
    const input = document.querySelector(`[data-command-input="${CSS.escape(activeInput)}"]`);
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
}

function renderAttention() {
  const attention = state.snapshot.panes.filter((pane) => pane.attention?.required && !state.dismissedAttention.has(attentionKey(pane)));
  const severityRank = { critical: 3, action: 2, warning: 1 };
  attention.sort((a, b) => (severityRank[b.attention.severity] ?? 0) - (severityRank[a.attention.severity] ?? 0));
  el["attention-badge"].textContent = attention.length;
  el["attention-list"].innerHTML = attention.length ? attention.map((pane) => `
    <article class="attention-item ${escapeHtml(pane.attention.severity)}">
      <header><strong>${escapeHtml(pane.paneId)} · ${escapeHtml(pane.command)}</strong><span>${escapeHtml(pane.attention.label)}</span></header>
      <p>${escapeHtml(pane.attention.evidence)}</p>
      <div class="attention-actions">
        <button data-attention-key="n" data-pane="${escapeHtml(pane.paneId)}">NO</button>
        <button data-attention-key="y" data-pane="${escapeHtml(pane.paneId)}">YES</button>
        <button data-attention-key="Enter" data-pane="${escapeHtml(pane.paneId)}">ENTER</button>
        <button class="primary" data-focus-pane="${escapeHtml(pane.paneId)}">FOCUS</button>
      </div>
    </article>`).join("") : '<p class="empty-state">No agents currently asking for permission, input, or review.</p>';
}

function renderStatus() {
  const panes = state.snapshot.panes;
  const attention = panes.filter((pane) => pane.attention?.required).length;
  const working = panes.filter((pane) => pane.activity === "working").length;
  const session = state.snapshot.sessions.find((item) => item.sessionId === state.sessionId);
  const labels = { all: "All terminals", attention: "Needs attention", working: "Changing now" };
  el["view-title"].textContent = session ? `${session.name} · ${labels[state.view]}` : labels[state.view];
  el["view-subtitle"].textContent = `${visiblePanes().length} live panes · ${state.paused ? "capture paused" : "auto-refreshing"}`;
  el["strip-attention"].textContent = attention;
  el["strip-working"].textContent = working;
  el["selected-count"].textContent = state.selected.size;
  el["updated-at"].textContent = state.paused ? "PAUSED" : `scan ${state.snapshot.discoveryLatencyMs?.toFixed(1) ?? "—"} ms · ${relativeTime(state.snapshot.measuredAt)}`;
  el["daemon-state"].textContent = "CONTROL ONLINE";
  el["scan-state"].textContent = `${panes.length} panes · ${attention} awaiting you`;
  el["connection-dot"].classList.add("online");
  el.pause.classList.toggle("active", state.paused);
}

function renderSelection() {
  el["selected-count"].textContent = state.selected.size;
  el["dock-count"].textContent = `${state.selected.size} PANE${state.selected.size === 1 ? "" : "S"}`;
  el["broadcast-dock"].classList.toggle("visible", state.selected.size > 0);
  const context = state.selected.size ? [...state.selected].join(", ") : state.focusedPaneId ? state.focusedPaneId : "whole fleet";
  el["orchestrator-context"].textContent = `Context: ${context}`;
}

function renderFocus() {
  if (!state.focusedPaneId) return;
  const pane = state.snapshot.panes.find((item) => item.paneId === state.focusedPaneId);
  if (!pane) return closeFocus();
  el["focus-session"].textContent = `${pane.sessionName} · window ${pane.windowIndex} · pane ${pane.paneIndex}`;
  el["focus-title"].textContent = `${pane.paneId} · ${pane.command}${pane.attention?.required ? ` · ${pane.attention.label}` : ""}`;
  el["focus-path"].textContent = pane.path;
  const nearBottom = el["focus-terminal"].scrollHeight - el["focus-terminal"].scrollTop - el["focus-terminal"].clientHeight < 80;
  el["focus-terminal"].textContent = pane.tail || "No captured output";
  if (nearBottom) el["focus-terminal"].scrollTop = el["focus-terminal"].scrollHeight;
}

function notifyAttention() {
  for (const pane of state.snapshot.panes.filter((item) => item.attention?.required)) {
    const key = attentionKey(pane);
    if (state.seenAttention.has(key) || state.dismissedAttention.has(key)) continue;
    state.seenAttention.add(key);
    state.popupPaneId = pane.paneId;
    el["popup-title"].textContent = `${pane.paneId} · ${pane.command} · ${pane.attention.label}`;
    el["popup-evidence"].textContent = pane.attention.evidence;
    el["attention-popup"].classList.add("open");
    el["attention-popup"].setAttribute("aria-hidden", "false");
    if (Notification.permission === "granted") new Notification(`EV: ${pane.paneId} needs attention`, { body: pane.attention.evidence, tag: key });
    break;
  }
}

async function refreshSnapshot(force = false) {
  if ((state.paused && !force) || state.polling) return;
  state.polling = true;
  try {
    const response = await api("/api/control-snapshot?lines=72");
    state.snapshot = await response.json();
    const liveIds = new Set(state.snapshot.panes.map((pane) => pane.paneId));
    for (const paneId of state.selected) if (!liveIds.has(paneId)) state.selected.delete(paneId);
    renderNavigation();
    renderTerminalWall();
    renderAttention();
    renderStatus();
    renderSelection();
    renderFocus();
    notifyAttention();
  } catch (error) {
    el["connection-dot"].classList.remove("online");
    el["daemon-state"].textContent = "CONTROL OFFLINE";
    el["scan-state"].textContent = error.message;
  } finally { state.polling = false; }
}

function toast(message) {
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  el["toast-stack"].append(item);
  setTimeout(() => item.remove(), 3500);
}

async function sendInput(paneId, text, enter = true) {
  await api(`/api/panes/${encodeURIComponent(paneId)}/input`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, enter }) });
  state.drafts.delete(paneId);
  toast(`Sent ${text.length} characters to ${paneId}${enter ? " + Enter" : ""}`);
  setTimeout(() => refreshSnapshot(true), 250);
}

async function sendKey(paneId, key) {
  await api(`/api/panes/${encodeURIComponent(paneId)}/key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
  toast(`Sent ${key} to ${paneId}`);
  setTimeout(() => refreshSnapshot(true), 200);
}

async function safeControl(operation) {
  try { await operation(); }
  catch (error) { toast(`Control failed: ${error.message}`); }
}

function openFocus(paneId) {
  state.focusedPaneId = paneId;
  el["focus-overlay"].classList.add("open");
  el["focus-overlay"].setAttribute("aria-hidden", "false");
  renderFocus();
  setTimeout(() => el["focus-input"].focus(), 0);
  renderSelection();
}

function closeFocus() {
  state.focusedPaneId = null;
  el["focus-overlay"].classList.remove("open");
  el["focus-overlay"].setAttribute("aria-hidden", "true");
  renderSelection();
}

function openExplainer(paneId) {
  const url = `/explain.html?pane=${encodeURIComponent(paneId)}`;
  const name = `ev-explainer-${paneId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const popup = window.open(url, name, "popup,width=1280,height=900");
  if (!popup) toast("The browser blocked the explanation window. Allow popups for this localhost page.");
}

async function refreshLedger() {
  try {
    const [taskResponse, eventResponse] = await Promise.all([api("/api/tasks"), api("/api/events?limit=30")]);
    const { tasks } = await taskResponse.json();
    const { events } = await eventResponse.json();
    el["task-list"].innerHTML = tasks.length ? tasks.slice(0, 12).map((task) => `<article class="task-item"><span>${escapeHtml(task.status)}</span><strong>${escapeHtml(task.taskId)}${task.selectedPaneId ? ` · ${escapeHtml(task.selectedPaneId)}` : ""}</strong><p>${escapeHtml(task.transcript)}</p></article>`).join("") : '<p class="empty-state">No handoffs yet.</p>';
    el["event-list"].innerHTML = events.map((event) => `<article class="event-item"><strong>${escapeHtml(event.type)} · ${relativeTime(event.occurredAt)}</strong><p>${escapeHtml(event.correlationId ?? "system")}</p></article>`).join("");
  } catch {}
}

async function delegateRequest() {
  const transcript = el["orchestrator-input"].value.trim();
  if (!transcript) return;
  el.delegate.disabled = true;
  const selectedPaneId = state.selected.size === 1 ? [...state.selected][0] : state.focusedPaneId;
  try {
    const response = await api("/api/companion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript, selectedPaneId }) });
    const result = await response.json();
    el["orchestrator-reply"].textContent = result.response;
    el["orchestrator-reply"].classList.add("visible");
    el["orchestrator-input"].value = "";
    toast(result.taskId ? `Created ${result.taskId}` : "Orchestrator query answered");
    await refreshLedger();
  } catch (error) { toast(`Orchestrator failed: ${error.message}`); }
  finally { el.delegate.disabled = false; }
}

function populateSpawnTargets() {
  const mode = el["spawn-mode"].value;
  const options = mode === "pane"
    ? state.snapshot.panes.map((pane) => ({ value: pane.paneId, label: `${pane.paneId} · ${pane.sessionName} · ${pane.command}` }))
    : state.snapshot.sessions.map((session) => ({ value: session.name, label: `${session.name} · ${session.paneCount} panes` }));
  el["spawn-target"].innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("");
  el["spawn-target-label"].classList.toggle("hidden", mode === "session");
}

async function launchRuntime(event) {
  event.preventDefault();
  const body = { mode: el["spawn-mode"].value, target: el["spawn-target"].value, name: el["spawn-name"].value.trim(), cwd: el["spawn-cwd"].value.trim(), command: el["spawn-command"].value.trim() };
  el["spawn-error"].textContent = "";
  try {
    const response = await api("/api/tmux/spawn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    el["spawn-dialog"].close();
    toast(`Launched ${result.paneId} in ${result.sessionName}`);
    await refreshSnapshot(true);
    openFocus(result.paneId);
  } catch (error) { el["spawn-error"].textContent = error.message; }
}

function dismissCurrentPopup() {
  if (state.popupPaneId) {
    const pane = state.snapshot.panes.find((item) => item.paneId === state.popupPaneId);
    if (pane) state.dismissedAttention.add(attentionKey(pane));
  }
  el["attention-popup"].classList.remove("open");
  el["attention-popup"].setAttribute("aria-hidden", "true");
  state.popupPaneId = null;
  renderAttention();
}

document.addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]");
  if (view) { state.view = view.dataset.view; renderNavigation(); renderTerminalWall(); renderStatus(); return; }
  const session = event.target.closest("[data-session]");
  if (session) { state.sessionId = session.dataset.session; renderNavigation(); renderTerminalWall(); renderStatus(); return; }
  const focus = event.target.closest("[data-focus-pane]");
  if (focus) return openFocus(focus.dataset.focusPane);
  const explain = event.target.closest("[data-explain-pane]");
  if (explain) return openExplainer(explain.dataset.explainPane);
  const select = event.target.closest("[data-select-pane]");
  if (select) { select.checked ? state.selected.add(select.dataset.selectPane) : state.selected.delete(select.dataset.selectPane); renderTerminalWall(); renderSelection(); return; }
  const send = event.target.closest("[data-send-pane]");
  if (send) { const input = document.querySelector(`[data-command-input="${CSS.escape(send.dataset.sendPane)}"]`); return safeControl(() => sendInput(send.dataset.sendPane, input.value)); }
  const quick = event.target.closest("[data-quick-key]");
  if (quick) return safeControl(() => sendKey(quick.dataset.pane, quick.dataset.quickKey));
  const attentionAction = event.target.closest("[data-attention-key]");
  if (attentionAction) {
    const key = attentionAction.dataset.attentionKey;
    return safeControl(() => key === "Enter" ? sendKey(attentionAction.dataset.pane, "Enter") : sendInput(attentionAction.dataset.pane, key));
  }
  const focusKey = event.target.closest("[data-focus-key]");
  if (focusKey && state.focusedPaneId) return safeControl(() => sendKey(state.focusedPaneId, focusKey.dataset.focusKey));
  const broadcastKey = event.target.closest("[data-broadcast-key]");
  if (broadcastKey) return safeControl(() => Promise.all([...state.selected].map((paneId) => sendKey(paneId, broadcastKey.dataset.broadcastKey))));
});

document.addEventListener("keydown", (event) => {
  const input = event.target.closest("[data-command-input]");
  if (input && event.key === "Enter") { event.preventDefault(); return safeControl(() => sendInput(input.dataset.commandInput, input.value)); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); if (state.selected.size) el["broadcast-input"].focus(); else el["orchestrator-input"].focus(); }
  if (event.key === "/" && !event.target.matches("input,textarea,select")) { event.preventDefault(); el.search.focus(); }
  if (event.key === "Escape") { if (el["spawn-dialog"].open) el["spawn-dialog"].close(); else if (state.focusedPaneId) closeFocus(); }
});

el.search.oninput = () => { state.search = el.search.value; renderTerminalWall(); renderStatus(); };
document.querySelectorAll("[data-columns]").forEach((button) => button.onclick = () => { state.columns = Number(button.dataset.columns); document.querySelectorAll("[data-columns]").forEach((item) => item.classList.toggle("active", item === button)); renderTerminalWall(); });
el.pause.onclick = () => { state.paused = !state.paused; renderStatus(); if (!state.paused) refreshSnapshot(true); };
el.refresh.onclick = () => refreshSnapshot(true);
el.notifications.onclick = async () => { if (!("Notification" in window)) return toast("Desktop notifications are unavailable"); const permission = await Notification.requestPermission(); el.notifications.classList.toggle("active", permission === "granted"); toast(`Notifications: ${permission}`); };
el["clear-selection"].onclick = () => { state.selected.clear(); renderTerminalWall(); renderSelection(); };
el["broadcast-send"].onclick = () => { const text = el["broadcast-input"].value; if (!text) return; safeControl(async () => { await Promise.all([...state.selected].map((paneId) => sendInput(paneId, text))); el["broadcast-input"].value = ""; }); };
el["broadcast-input"].onkeydown = (event) => { if (event.key === "Enter") el["broadcast-send"].click(); };
el["close-focus"].onclick = closeFocus;
el["open-explainer"].onclick = () => { if (state.focusedPaneId) openExplainer(state.focusedPaneId); };
el["focus-command"].onsubmit = (event) => { event.preventDefault(); const text = el["focus-input"].value; if (!text || !state.focusedPaneId) return; safeControl(async () => { await sendInput(state.focusedPaneId, text); el["focus-input"].value = ""; }); };
el.delegate.onclick = delegateRequest;
el["orchestrator-input"].onkeydown = (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") delegateRequest(); };
el["toggle-events"].onclick = () => { state.eventsVisible = !state.eventsVisible; el["event-list"].classList.toggle("hidden", !state.eventsVisible); el["task-list"].classList.toggle("hidden", state.eventsVisible); el["toggle-events"].textContent = state.eventsVisible ? "TASKS" : "EVENTS"; };
el["new-runtime"].onclick = () => { populateSpawnTargets(); el["spawn-dialog"].showModal(); };
el["spawn-mode"].onchange = populateSpawnTargets;
el["spawn-form"].onsubmit = launchRuntime;
document.querySelectorAll("[data-close-spawn]").forEach((button) => button.onclick = () => el["spawn-dialog"].close());
el["dismiss-popup"].onclick = dismissCurrentPopup;
el["popup-dismiss"].onclick = dismissCurrentPopup;
el["popup-focus"].onclick = () => { const paneId = state.popupPaneId; dismissCurrentPopup(); if (paneId) openFocus(paneId); };

await Promise.all([refreshSnapshot(true), refreshLedger()]);
setInterval(refreshSnapshot, 1200);
setInterval(refreshLedger, 4000);
