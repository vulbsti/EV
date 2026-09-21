const params = new URLSearchParams(location.search);
const paneId = params.get("pane");
const storageKey = paneId ? `ev-explanation-session:${paneId}` : null;
const state = {
  paneId,
  sessionId: storageKey ? localStorage.getItem(storageKey) : null,
  questionId: null,
  evidence: null,
  profile: null,
  asking: false,
  catalog: null,
  capabilityId: null,
  labRunning: false
};

const ids = ["target-label", "evidence-state", "captured-at", "close-window", "refresh-evidence", "fact-pane", "fact-command", "fact-activity", "fact-cwd", "fact-git", "project-name", "project-summary", "project-sources", "task-objective", "task-criteria", "bind-task", "task-dialog", "task-form", "task-objective-input", "task-criteria-input", "task-error", "cancel-task", "cancel-task-footer", "change-count", "change-list", "validation-list", "terminal-preview", "session-label", "conversation", "prompt-chips", "question-form", "question", "ask", "ask-status", "feedback-count", "profile-list", "feedback-note", "limitations", "explanation-view", "lab-view", "lab-title", "lab-objective", "lab-score", "capability-select", "scenario-select", "run-experiment", "run-suite", "lab-unsupported", "lab-controls", "lab-run-status", "lab-run-id", "lab-run-tabs", "lab-pipeline", "lab-summary", "lab-metrics", "lab-trace", "lab-assertions", "lab-comparison", "lab-regression", "lab-acceptance", "lab-note"];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

async function api(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (await response.json()).error ?? message; } catch {}
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response.json();
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 3) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function textNode(tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

function renderPresentation(article, presentation) {
  article.append(textNode("p", "answer-summary", presentation.answer));

  const goal = document.createElement("section");
  goal.className = "goal-alignment";
  const goalHead = document.createElement("div");
  goalHead.append(textNode("span", "", "PROJECT GOAL"), textNode("b", `alignment-${presentation.project.alignment}`, presentation.project.alignment.toUpperCase()));
  goal.append(goalHead, textNode("p", "goal-text", presentation.project.goal), textNode("p", "goal-impact", presentation.project.impact));
  article.append(goal);

  const explorer = document.createElement("section");
  explorer.className = "mechanism-explorer";
  const scenarioTabs = document.createElement("div");
  scenarioTabs.className = "scenario-tabs";
  const flow = document.createElement("div");
  flow.className = "mechanism-flow";
  const scenarioResult = document.createElement("div");
  scenarioResult.className = "scenario-result";
  const stepDetail = document.createElement("div");
  stepDetail.className = "step-detail";
  const stepButtons = new Map();
  const scenarioButtons = new Map();

  function selectStep(stepId) {
    const step = presentation.mechanism.find((item) => item.id === stepId) ?? presentation.mechanism[0];
    for (const [id, button] of stepButtons) button.classList.toggle("selected", id === step.id);
    stepDetail.replaceChildren();
    const heading = document.createElement("header");
    heading.append(textNode("strong", "", step.title), textNode("span", `status-${step.status}`, step.status));
    stepDetail.append(heading, textNode("p", "step-mechanic", step.detail));
    for (const [label, value] of [["INPUT", step.input], ["OUTPUT / STATE", step.output], ["EVIDENCE", step.evidence]]) {
      const row = document.createElement("div");
      row.append(textNode("span", "", label), textNode("p", "", value));
      stepDetail.append(row);
    }
  }

  function selectScenario(scenarioId) {
    const scenario = presentation.scenarios.find((item) => item.id === scenarioId) ?? presentation.scenarios[0];
    const activePath = new Set(scenario.path);
    for (const [id, button] of scenarioButtons) {
      const selected = id === scenario.id;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    for (const [id, button] of stepButtons) button.classList.toggle("on-path", activePath.has(id));
    scenarioResult.replaceChildren();
    const heading = document.createElement("div");
    heading.append(textNode("b", "", scenario.label), textNode("span", `status-${scenario.status}`, scenario.status));
    scenarioResult.append(heading, textNode("p", "scenario-trigger", `IF ${scenario.trigger}`), textNode("p", "scenario-outcome", `THEN ${scenario.outcome}`));
    selectStep(scenario.path[0] ?? presentation.mechanism[0]?.id);
  }

  for (const scenario of presentation.scenarios) {
    const button = textNode("button", "", scenario.label);
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.onclick = () => selectScenario(scenario.id);
    scenarioButtons.set(scenario.id, button);
    scenarioTabs.append(button);
  }

  presentation.mechanism.forEach((step, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mechanism-step";
    button.append(textNode("span", "step-number", String(index + 1).padStart(2, "0")), textNode("strong", "", step.title), textNode("small", `status-${step.status}`, step.status));
    button.onclick = () => selectStep(step.id);
    stepButtons.set(step.id, button);
    flow.append(button);
    if (index < presentation.mechanism.length - 1) flow.append(textNode("i", "mechanism-arrow", "→"));
  });

  explorer.append(scenarioTabs, flow, scenarioResult, stepDetail);
  article.append(explorer);

  if (presentation.limits?.length) {
    const details = document.createElement("details");
    details.className = "answer-limits";
    details.append(textNode("summary", "", "What is not proven"));
    for (const limit of presentation.limits) details.append(textNode("p", "", limit));
    article.append(details);
  }

  if (presentation.followUps?.length) {
    const followUps = document.createElement("div");
    followUps.className = "mechanism-followups";
    for (const question of presentation.followUps) {
      const button = textNode("button", "", question);
      button.type = "button";
      button.onclick = () => { el.question.value = question; el.question.focus(); };
      followUps.append(button);
    }
    article.append(followUps);
  }

  selectScenario(presentation.scenarios[0]?.id);
}

function addMessage({ role, text, presentation = null, evidenceRevision = null, occurredAt = null, durationMs = null, className = "" }) {
  const article = document.createElement("article");
  article.className = `message ${role} ${className}`.trim();
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = role === "user" ? "YOUR QUESTION" : role === "assistant" ? "EXPLAINER" : "SYSTEM";
  const detail = document.createElement("span");
  detail.textContent = [evidenceRevision ? `evidence ${evidenceRevision}` : null, durationMs ? `${(durationMs / 1000).toFixed(1)}s` : null, occurredAt ? relativeTime(occurredAt) : null].filter(Boolean).join(" · ");
  meta.append(detail);
  article.append(meta);
  if (role === "assistant" && presentation?.mechanism?.length) renderPresentation(article, presentation);
  else article.append(textNode("p", "", text));
  el.conversation.append(article);
  el.conversation.scrollTop = el.conversation.scrollHeight;
  return article;
}

function renderEvidence(evidence) {
  const previousRevision = state.evidence?.revision;
  state.evidence = evidence;
  el["target-label"].textContent = `${evidence.target.paneId} · ${evidence.target.command} · ${evidence.target.cwd}`;
  el["evidence-state"].textContent = `EVIDENCE ${evidence.revision}`;
  el["evidence-state"].classList.toggle("changed", Boolean(previousRevision && previousRevision !== evidence.revision));
  el["captured-at"].textContent = `captured ${relativeTime(evidence.capturedAt)}`;
  el["fact-pane"].textContent = `${evidence.target.paneId} / ${evidence.target.sessionName}`;
  el["fact-command"].textContent = evidence.target.command;
  el["fact-activity"].textContent = evidence.target.attention ? `needs attention · ${evidence.target.attention.label}` : evidence.target.activity;
  el["fact-cwd"].textContent = evidence.target.cwd;
  el["fact-git"].textContent = evidence.workspace.repository ? `${evidence.workspace.branch} / ${evidence.workspace.head}` : "not a Git repository";
  el["project-name"].textContent = evidence.project?.name ?? "Project not identified";
  el["project-summary"].textContent = evidence.project?.summary ?? "No explicit project goal was found.";
  el["project-sources"].textContent = `${evidence.project?.sourcePaths?.length ?? 0} sources`;
  el["task-objective"].textContent = evidence.taskContext?.objective ?? "No exact task objective is bound.";
  el["task-criteria"].replaceChildren();
  const criteria = evidence.taskContext?.acceptanceCriteria?.length ? evidence.taskContext.acceptanceCriteria : ["Project intent will be used as a weaker fallback."];
  for (const criterion of criteria) el["task-criteria"].append(textNode("li", "", criterion));
  const changes = evidence.workspace.changes ?? [];
  el["change-count"].textContent = changes.length;
  el["change-list"].innerHTML = "";
  if (!changes.length) el["change-list"].innerHTML = '<p class="empty">Working tree is clean or unavailable.</p>';
  for (const change of changes.slice(0, 30)) {
    const item = document.createElement("div");
    item.className = "change-item";
    const code = document.createElement("b");
    code.textContent = change.code;
    const path = document.createElement("span");
    path.textContent = change.path;
    item.append(code, path);
    el["change-list"].append(item);
  }
  el["validation-list"].innerHTML = "";
  if (!evidence.validationSignals.length) el["validation-list"].innerHTML = '<p class="empty">No recent test or build signal was observed. Ask what still needs verification.</p>';
  for (const signal of evidence.validationSignals) {
    const item = document.createElement("p");
    item.className = "signal-item";
    item.textContent = signal;
    el["validation-list"].append(item);
  }
  el["terminal-preview"].textContent = evidence.terminalPreview || "No visible terminal output.";
  el.limitations.innerHTML = "";
  for (const limitation of evidence.limitations) {
    const item = document.createElement("li");
    item.textContent = limitation;
    el.limitations.append(item);
  }
}

function openTaskDialog() {
  const task = state.evidence?.taskContext;
  el["task-objective-input"].value = task?.objective ?? "";
  el["task-criteria-input"].value = (task?.acceptanceCriteria ?? []).join("\n");
  el["task-error"].textContent = "";
  el["task-dialog"].showModal();
  el["task-objective-input"].focus();
}

async function bindTask(event) {
  event.preventDefault();
  const objective = el["task-objective-input"].value.trim();
  const acceptanceCriteria = el["task-criteria-input"].value.split("\n").map((item) => item.trim()).filter(Boolean);
  el["task-error"].textContent = "";
  try {
    await api("/api/explain/task-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paneId: state.paneId, objective, acceptanceCriteria })
    });
    await refreshEvidence();
    el["task-dialog"].close();
  } catch (error) {
    el["task-error"].textContent = error.message;
  }
}

function renderProfile(profile) {
  state.profile = profile;
  el["feedback-count"].textContent = `${profile.explicitFeedbackCount} explicit`;
  el["profile-list"].innerHTML = "";
  if (!profile.preferences.length) {
    el["profile-list"].innerHTML = '<p class="empty">Your questions and feedback will tune later answers.</p>';
    return;
  }
  const max = Math.max(...profile.preferences.map((item) => item.weight));
  for (const preference of profile.preferences) {
    const item = document.createElement("div");
    item.className = "profile-item";
    const name = document.createElement("span");
    name.textContent = preference.name;
    const bar = document.createElement("i");
    const fill = document.createElement("b");
    fill.style.width = `${Math.max(10, (preference.weight / max) * 100)}%`;
    bar.append(fill);
    const weight = document.createElement("b");
    weight.textContent = preference.weight;
    item.append(name, bar, weight);
    el["profile-list"].append(item);
  }
}

function switchStage(name) {
  const lab = name === "lab";
  el["explanation-view"].hidden = lab;
  el["lab-view"].hidden = !lab;
  document.querySelectorAll("[data-stage]").forEach((button) => button.classList.toggle("active", button.dataset.stage === name));
}

function selectedCapability() {
  return state.catalog?.capabilities?.find((capability) => capability.id === state.capabilityId) ?? null;
}

function renderAcceptance(acceptance) {
  el["lab-acceptance"].replaceChildren();
  el["lab-score"].textContent = acceptance?.score ?? "0/10";
  for (const gate of acceptance?.gates ?? []) {
    const item = textNode("span", gate.passed ? "passed" : "", `${gate.passed ? "✓" : "○"} ${gate.id}`);
    item.title = gate.label;
    el["lab-acceptance"].append(item);
  }
}

function renderPipeline(capability, trace = []) {
  el["lab-pipeline"].replaceChildren();
  capability.pipeline.forEach((step, index) => {
    const event = trace.findLast((item) => item.stage === step.id);
    const item = document.createElement("article");
    if (event?.status) item.className = event.status;
    item.append(textNode("strong", "", step.label), textNode("small", "", event ? event.status.toUpperCase() : "NOT RUN"));
    if (event?.detail) item.title = event.detail;
    el["lab-pipeline"].append(item);
    if (index < capability.pipeline.length - 1) el["lab-pipeline"].append(textNode("i", "", "→"));
  });
}

function renderControls(capability) {
  el["lab-controls"].replaceChildren();
  for (const control of capability.controls) {
    const label = document.createElement("label");
    label.dataset.controlLabel = control.id;
    const title = document.createElement("span");
    title.append(document.createTextNode(control.label));
    let input;
    if (control.type === "select") {
      input = document.createElement("select");
      for (const option of control.options) {
        const item = document.createElement("option");
        item.value = String(option);
        item.textContent = String(option);
        input.append(item);
      }
    } else {
      input = document.createElement("input");
      input.type = control.type === "boolean" ? "checkbox" : control.type;
      if (control.type === "range") {
        input.min = control.min;
        input.max = control.max;
        input.step = control.step;
        const output = document.createElement("output");
        title.append(output);
        input.oninput = () => { output.textContent = input.value; };
      }
      if (control.type === "text") input.maxLength = control.maxLength;
    }
    input.dataset.labControl = control.id;
    if (control.type === "boolean") label.className = "boolean-control";
    label.append(title, input);
    el["lab-controls"].append(label);
  }
}

function applyScenario() {
  const capability = selectedCapability();
  if (!capability) return;
  const scenario = capability.scenarios.find((item) => item.id === el["scenario-select"].value) ?? capability.scenarios[0];
  for (const control of capability.controls) {
    const input = el["lab-controls"].querySelector(`[data-lab-control="${CSS.escape(control.id)}"]`);
    const value = Object.hasOwn(scenario.overrides, control.id) ? scenario.overrides[control.id] : control.default;
    if (control.type === "boolean") input.checked = Boolean(value);
    else input.value = String(value);
    input.dispatchEvent(new Event("input"));
  }
}

function renderCapability(capability) {
  state.capabilityId = capability?.id ?? null;
  el["scenario-select"].replaceChildren();
  el["lab-controls"].replaceChildren();
  el["lab-unsupported"].hidden = true;
  if (!capability) {
    el["lab-title"].textContent = "No executable capability";
    el["lab-objective"].textContent = state.catalog?.unsupported?.message ?? "No capability manifest was found.";
    el["lab-unsupported"].textContent = el["lab-objective"].textContent;
    el["lab-unsupported"].hidden = false;
    el["run-experiment"].disabled = true;
    el["run-suite"].disabled = true;
    renderAcceptance(null);
    return;
  }
  el["lab-title"].textContent = capability.title;
  el["lab-objective"].textContent = `${capability.objective} ${capability.change}`;
  for (const scenario of capability.scenarios) {
    const option = document.createElement("option");
    option.value = scenario.id;
    option.textContent = scenario.label;
    el["scenario-select"].append(option);
  }
  renderControls(capability);
  applyScenario();
  renderPipeline(capability);
  renderAcceptance(capability.acceptance);
  const executable = capability.support === "executable";
  el["run-experiment"].disabled = !executable;
  el["run-suite"].disabled = !executable;
  if (!executable) {
    el["lab-unsupported"].textContent = `Missing adapter: ${capability.missingAdapter}. The model may explain this capability, but EV will not pretend it can execute it.`;
    el["lab-unsupported"].hidden = false;
  }
  el["lab-run-status"].textContent = "READY";
  el["lab-run-status"].className = "";
  el["lab-run-id"].textContent = "No experiment yet";
  el["lab-run-tabs"].replaceChildren();
  el["lab-summary"].textContent = "Choose a scenario and run it against the registered adapter.";
  for (const id of ["lab-metrics", "lab-trace", "lab-assertions", "lab-comparison", "lab-regression"]) el[id].replaceChildren();
}

async function loadCapabilities() {
  state.catalog = await api(`/api/capabilities?paneId=${encodeURIComponent(state.paneId)}`);
  el["capability-select"].replaceChildren();
  for (const capability of state.catalog.capabilities) {
    const option = document.createElement("option");
    option.value = capability.id;
    option.textContent = `${capability.title}${capability.support === "executable" ? "" : " · adapter missing"}`;
    el["capability-select"].append(option);
  }
  const selected = state.catalog.capabilities.find((capability) => capability.id === state.capabilityId) ?? state.catalog.capabilities[0] ?? null;
  if (selected) el["capability-select"].value = selected.id;
  renderCapability(selected);
}

function readLabInputs() {
  const capability = selectedCapability();
  return Object.fromEntries(capability.controls.map((control) => {
    const input = el["lab-controls"].querySelector(`[data-lab-control="${CSS.escape(control.id)}"]`);
    const value = control.type === "boolean" ? input.checked : control.type === "range" ? Number(input.value) : input.value;
    return [control.id, value];
  }));
}

function listItem(title, detail, className = "") {
  const article = document.createElement("article");
  article.className = className;
  article.append(textNode("strong", "", title), textNode("span", "", detail));
  return article;
}

function renderReceiptTabs(receipts, selectedRunId) {
  el["lab-run-tabs"].replaceChildren();
  for (const receipt of receipts) {
    const button = textNode("button", receipt.status, `${receipt.scenario.label} · ${receipt.status}`);
    button.type = "button";
    button.classList.toggle("active", receipt.runId === selectedRunId);
    button.onclick = () => renderRun(receipt);
    button.dataset.runId = receipt.runId;
    el["lab-run-tabs"].append(button);
  }
}

function renderRun(receipt) {
  const capability = selectedCapability();
  el["lab-run-tabs"].querySelectorAll("[data-run-id]").forEach((button) => button.classList.toggle("active", button.dataset.runId === receipt.runId));
  el["lab-run-status"].textContent = receipt.status.toUpperCase();
  el["lab-run-status"].className = receipt.status;
  el["lab-run-id"].textContent = `${receipt.runId} · evidence ${receipt.evidenceRevision ?? "legacy"} · ${receipt.adapter}@${receipt.adapterVersion}`;
  el["lab-summary"].textContent = receipt.summary;
  renderPipeline(capability, receipt.trace);

  el["lab-metrics"].replaceChildren();
  const metricValues = [
    ["ITERATIONS", receipt.metrics?.iterations],
    ["CONCURRENCY", receipt.metrics?.concurrency],
    ["P50", receipt.metrics?.latency ? `${receipt.metrics.latency.p50Ms} ms` : null],
    ["P95", receipt.metrics?.latency ? `${receipt.metrics.latency.p95Ms} ms` : null],
    ["THROUGHPUT", receipt.metrics ? `${receipt.metrics.throughputPerSecond}/s` : null],
    ["ERROR RATE", receipt.metrics ? `${(receipt.metrics.errorRate * 100).toFixed(1)}%` : null],
    ["ASSERTION FAIL", Number.isFinite(receipt.metrics?.assertionFailureRate) ? `${(receipt.metrics.assertionFailureRate * 100).toFixed(1)}%` : null],
    ["HEAP Δ", receipt.metrics ? `${receipt.metrics.heapDeltaBytes} B` : null],
    ["EXTERNAL COST", receipt.cost ? `$${receipt.cost.externalApiUsd.toFixed(4)}` : null]
  ];
  for (const [label, value] of metricValues.filter(([, value]) => value !== null && value !== undefined)) {
    const item = document.createElement("div");
    item.className = "lab-metric";
    item.append(textNode("span", "", label), textNode("b", "", value));
    el["lab-metrics"].append(item);
  }

  el["lab-trace"].replaceChildren(...receipt.trace.map((event) => listItem(`${event.stage} · ${event.status}`, event.detail, event.status)));
  el["lab-assertions"].replaceChildren(...receipt.assertions.map((assertion) => listItem(`${assertion.passed ? "PASS" : "FAIL"} · ${assertion.label}`, `expected ${JSON.stringify(assertion.expected)} · actual ${JSON.stringify(assertion.actual)}`, assertion.passed ? "passed" : "failed")));
  el["lab-comparison"].replaceChildren(
    listItem("BASELINE", JSON.stringify(receipt.comparison?.baseline ?? "unavailable")),
    listItem("CANDIDATE", JSON.stringify(receipt.comparison?.candidate ?? "unavailable")),
    listItem("DELTA", JSON.stringify(receipt.comparison?.delta ?? "unavailable"))
  );
  el["lab-regression"].replaceChildren(receipt.regressionProposal
    ? listItem(receipt.regressionProposal.title, `${receipt.regressionProposal.suggestedTest} Status: ${receipt.regressionProposal.status}.`, "failed")
    : listItem("No failed contract", "A regression proposal is created automatically when an assertion fails.", "passed"));
}

async function refreshLabAcceptance() {
  const fresh = await api(`/api/capabilities?paneId=${encodeURIComponent(state.paneId)}`);
  state.catalog = fresh;
  const capability = selectedCapability();
  renderAcceptance(capability?.acceptance);
}

async function runLabExperiment(suite = false) {
  const capability = selectedCapability();
  if (!capability || state.labRunning) return;
  state.labRunning = true;
  el["run-experiment"].disabled = true;
  el["run-suite"].disabled = true;
  el["lab-run-status"].textContent = suite ? "RUNNING SUITE" : "RUNNING";
  el["lab-run-status"].className = "running";
  try {
    if (suite) {
      const result = await api("/api/experiments/acceptance-suite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paneId: state.paneId, capabilityId: capability.id })
      });
      const receipt = result.runs.find((run) => run.status === "failed") ?? result.runs.at(-1);
      renderReceiptTabs(result.runs, receipt.runId);
      renderRun(receipt);
      renderAcceptance(result.acceptance);
      el["lab-run-status"].textContent = result.acceptance.complete ? "SUITE 10/10" : `SUITE ${result.acceptance.score}`;
    } else {
      const receipt = await api("/api/experiments/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paneId: state.paneId, capabilityId: capability.id, scenarioId: el["scenario-select"].value, inputs: readLabInputs() })
      });
      renderReceiptTabs([receipt], receipt.runId);
      renderRun(receipt);
      await refreshLabAcceptance();
    }
  } catch (error) {
    el["lab-run-status"].textContent = "ERROR";
    el["lab-run-status"].className = "error";
    el["lab-summary"].textContent = error.message;
  } finally {
    state.labRunning = false;
    const executable = selectedCapability()?.support === "executable";
    el["run-experiment"].disabled = !executable;
    el["run-suite"].disabled = !executable;
  }
}

async function refreshEvidence() {
  if (!state.paneId) throw new Error("Open this page from an EV terminal card so it has a pane target.");
  try {
    renderEvidence(await api(`/api/explain/context?paneId=${encodeURIComponent(state.paneId)}`));
    el["ask-status"].textContent = "Fresh evidence will be attached automatically.";
  } catch (error) {
    el["ask-status"].textContent = error.message;
    throw error;
  }
}

async function restoreSession() {
  if (!state.sessionId) return;
  try {
    const session = await api(`/api/explain/sessions/${encodeURIComponent(state.sessionId)}`);
    el["session-label"].textContent = session.sessionId;
    renderProfile(session.profile);
    for (const message of session.messages) {
      addMessage({ role: message.role, text: message.text, presentation: message.presentation, evidenceRevision: message.evidenceRevision, occurredAt: message.occurredAt, durationMs: message.durationMs });
      if (message.role === "assistant") state.questionId = message.questionId;
    }
  } catch (error) {
    if (error.status === 404) {
      localStorage.removeItem(storageKey);
      state.sessionId = null;
      return;
    }
    throw error;
  }
}

async function askQuestion(event) {
  event?.preventDefault();
  const question = el.question.value.trim();
  if (!question || state.asking) return;
  state.asking = true;
  el.ask.disabled = true;
  el.question.value = "";
  addMessage({ role: "user", text: question, evidenceRevision: state.evidence?.revision });
  const pending = addMessage({ role: "assistant", text: "Reading the latest pane, repository, diff, tests, and event evidence…", className: "pending" });
  el["ask-status"].textContent = "Explainer is reasoning in its separate read-only thread…";
  try {
    const result = await api("/api/explain/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, paneId: state.paneId, question })
    });
    pending.remove();
    state.sessionId = result.sessionId;
    state.questionId = result.questionId;
    localStorage.setItem(storageKey, state.sessionId);
    el["session-label"].textContent = state.sessionId;
    renderEvidence(result.evidence);
    renderProfile(result.profile);
    addMessage({ role: "assistant", text: result.answer, presentation: result.presentation, evidenceRevision: result.evidence.revision });
    el["ask-status"].textContent = "Ask a follow-up; new evidence will be attached again.";
  } catch (error) {
    pending.remove();
    addMessage({ role: "system", text: `Explanation failed: ${error.message}`, className: "error" });
    el["ask-status"].textContent = error.message;
  } finally {
    state.asking = false;
    el.ask.disabled = false;
    el.question.focus();
  }
}

async function sendFeedback(signal) {
  if (!state.sessionId) {
    el["feedback-note"].textContent = "Ask one question before tuning the explanation.";
    return;
  }
  try {
    const result = await api("/api/explain/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, questionId: state.questionId, signal })
    });
    renderProfile(result.profile);
    el["feedback-note"].textContent = signal === "reset_profile" ? "Learning profile reset. Conversation history is unchanged." : signal === "good" ? "Saved: this explanation style worked." : "Saved. The next answer will adapt.";
  } catch (error) { el["feedback-note"].textContent = error.message; }
}

el["close-window"].onclick = () => window.close();
el["refresh-evidence"].onclick = () => refreshEvidence().catch(() => {});
el["question-form"].onsubmit = askQuestion;
el.question.onkeydown = (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") askQuestion(event); };
el["prompt-chips"].onclick = (event) => {
  const button = event.target.closest("[data-question]");
  if (!button) return;
  el.question.value = button.dataset.question;
  el.question.focus();
};
document.querySelectorAll("[data-feedback]").forEach((button) => button.onclick = () => sendFeedback(button.dataset.feedback));
document.querySelectorAll("[data-stage]").forEach((button) => button.onclick = () => switchStage(button.dataset.stage));
el["capability-select"].onchange = () => renderCapability(state.catalog.capabilities.find((capability) => capability.id === el["capability-select"].value));
el["scenario-select"].onchange = applyScenario;
el["run-experiment"].onclick = () => runLabExperiment(false);
el["run-suite"].onclick = () => runLabExperiment(true);
el["bind-task"].onclick = openTaskDialog;
el["task-form"].onsubmit = bindTask;
el["cancel-task"].onclick = () => el["task-dialog"].close();
el["cancel-task-footer"].onclick = () => el["task-dialog"].close();

try {
  await Promise.all([refreshEvidence(), restoreSession(), loadCapabilities()]);
} catch (error) {
  addMessage({ role: "system", text: error.message, className: "error" });
}
setInterval(() => refreshEvidence().catch(() => {}), 3_000);
