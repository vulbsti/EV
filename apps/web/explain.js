const params = new URLSearchParams(location.search);
const paneId = params.get("pane");
const storageKey = paneId ? `ev-explanation-session:${paneId}` : null;
const state = {
  paneId,
  sessionId: storageKey ? localStorage.getItem(storageKey) : null,
  questionId: null,
  evidence: null,
  profile: null,
  asking: false
};

const ids = ["target-label", "evidence-state", "captured-at", "close-window", "refresh-evidence", "fact-pane", "fact-command", "fact-activity", "fact-cwd", "fact-git", "project-name", "project-summary", "project-sources", "change-count", "change-list", "validation-list", "terminal-preview", "session-label", "conversation", "prompt-chips", "question-form", "question", "ask", "ask-status", "feedback-count", "profile-list", "feedback-note", "limitations"];
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

try {
  await Promise.all([refreshEvidence(), restoreSession()]);
} catch (error) {
  addMessage({ role: "system", text: error.message, className: "error" });
}
setInterval(() => refreshEvidence().catch(() => {}), 3_000);
