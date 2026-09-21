#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryTmux } from "../../lab/lib/tmux.mjs";
import { run } from "../../lab/lib/process.mjs";
import { synthesize, transcribeBuffer } from "../../lab/lib/providers/openrouter.mjs";
import { loadDotEnv } from "./lib/env.mjs";
import { EventStore } from "./lib/store.mjs";
import { createAssistantLedger } from "./lib/assistant-ledger.mjs";
import { planAssistantTurn } from "./lib/assistant-intake.mjs";
import { AssistantSupervisor } from "./lib/assistant-supervisor.mjs";
import { AssistantWorkerService } from "./lib/assistant-worker-service.mjs";
import { AssistantMemoryStore } from "./lib/assistant-memory.mjs";
import { CodexAppServer } from "./lib/codex-app-server.mjs";
import { createExplainer } from "./lib/explainer.mjs";
import { createExperimentRunner } from "./lib/experiment-runner.mjs";
import { inspectAttention, redactCommandPreview, stripTerminalControls, terminalDigest } from "./lib/attention.mjs";
import { assertLoopbackHost, ensurePrivateDirectorySync, ensurePrivateFileSync } from "./lib/file-permissions.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const webRoot = join(projectRoot, "apps", "web");
await loadDotEnv(join(projectRoot, ".env"));
const configuredHost = assertLoopbackHost(process.env.EV_HOST ?? "127.0.0.1");
const store = new EventStore(join(projectRoot, "data", "events.jsonl"));
await store.initialize();
const assistantLedger = createAssistantLedger({ path: join(projectRoot, "data", "assistant.sqlite") });
const assistantWorkerRoot = join(projectRoot, "data", "assistant-worker");
const artifactRoot = join(assistantWorkerRoot, "artifacts");
const assistantSupervisor = await AssistantSupervisor.open({
  statePath: join(assistantWorkerRoot, "supervisor-state.sqlite"),
  artifactRoot
});
const assistantWorkers = new AssistantWorkerService({ supervisor: assistantSupervisor, workerRoot: assistantWorkerRoot });
await assistantWorkers.start();
const assistantMemory = AssistantMemoryStore.open({ path: join(projectRoot, "data", "assistant-memory.sqlite") });
const assistantOwnerId = "default-person";

const config = {
  host: configuredHost,
  port: Number(process.env.EV_PORT ?? 4317),
  openrouterKey: process.env.OPENROUTER_API_KEY,
  sttModel: process.env.OPENROUTER_STT_MODEL ?? "x-ai/grok-stt-1.0",
  ttsModel: process.env.OPENROUTER_TTS_MODEL ?? "x-ai/grok-voice-tts-1.0",
  ttsVoice: process.env.OPENROUTER_TTS_VOICE ?? "eve",
  maxAudioBytes: 15 * 1024 * 1024
};
const paneActivity = new Map();
let snapshotPromise = null;
let snapshotExpiresAt = 0;
const codex = new CodexAppServer({
  cwd: projectRoot,
  model: process.env.EV_EXPLAINER_MODEL ?? null,
  modelProvider: process.env.EV_CODEX_MODEL_PROVIDER ?? "openai"
});
const explainer = await createExplainer({
  store,
  codex,
  getPane: async (paneId) => (await controlSnapshot(72)).panes.find((pane) => pane.paneId === paneId) ?? null
});
const experiments = createExperimentRunner({
  store,
  getPane: async (paneId) => (await controlSnapshot(72)).panes.find((pane) => pane.paneId === paneId) ?? null,
  baseUrl: `http://${config.host}:${config.port}`
});

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function publicTask(task) {
  if (!task) return null;
  return {
    taskId: task.taskId,
    capability: task.input?.capability ?? null,
    title: task.input?.metadata?.title ?? "Background task",
    status: task.status,
    run: task.run ? { runId: task.run.runId, startedAt: task.run.startedAt } : null,
    result: task.result,
    artifacts: task.artifacts,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    revision: task.revision,
    contextManifestId: task.input?.metadata?.contextManifestId ?? null,
    history: task.history
  };
}

function taskIdForClientMessage(clientMessageId) {
  return `launch-${createHash("sha256").update(clientMessageId).digest("hex").slice(0, 24)}`;
}

async function taskForTurn(turn) {
  if (turn.intent?.route !== "worker") return turn.task;
  return assistantSupervisor.getTask(taskIdForClientMessage(turn.userMessage.clientMessageId)).catch(() => null);
}

async function publicConversation(conversationId = "default", afterSequence = 0) {
  const turns = assistantLedger.listTurns(conversationId);
  const linkedTasks = new Map(await Promise.all(turns.map(async (turn) => [turn.userMessage.messageId, await taskForTurn(turn)])));
  const allMessages = turns.flatMap((turn) => [
    { ...turn.userMessage, status: "received" },
    {
      ...turn.assistantMessage,
      status: linkedTasks.get(turn.userMessage.messageId)?.status ?? "answered",
      taskId: linkedTasks.get(turn.userMessage.messageId)?.taskId ?? null,
      taskStatus: linkedTasks.get(turn.userMessage.messageId)?.status ?? null
    }
  ]);
  return {
    messages: allMessages.filter((message) => message.sequence > afterSequence),
    revision: allMessages.at(-1)?.sequence ?? 0
  };
}

async function publicTurn(turn) {
  const task = await taskForTurn(turn);
  return {
    replayed: turn.replayed,
    messages: [
      { ...turn.userMessage, status: "received" },
      {
        ...turn.assistantMessage,
        status: task?.status ?? "answered",
        taskId: task?.taskId ?? null,
        taskStatus: task?.status ?? null
      }
    ],
    task: publicTask(task)
  };
}

async function ensureLaunchBriefTask(clientMessageId, conversationId = "default") {
  const taskId = taskIdForClientMessage(clientMessageId);
  const existing = await assistantSupervisor.getTask(taskId).catch(() => null);
  if (existing) return existing;
  const workspace = taskId;
  const workspacePath = join(assistantWorkerRoot, "workspaces", workspace);
  ensurePrivateDirectorySync(workspacePath);
  ensurePrivateDirectorySync(join(workspacePath, "inputs"));
  ensurePrivateDirectorySync(join(workspacePath, "output"));
  const source = await readFile(join(projectRoot, "fixtures", "assistant", "launch-status-source.md"), "utf8");
  const sourcePath = join(workspacePath, "inputs", "source.md");
  await writeFile(sourcePath, source, { mode: 0o600 });
  ensurePrivateFileSync(sourcePath);
  const guidance = assistantMemory.recall({ ownerId: assistantOwnerId, scope: "global" });
  const claimRevisionIds = guidance.map((claim) => claim.current.revisionId);
  const sourceIds = [...new Set(guidance.flatMap((claim) => claim.sources.map((source) => source.sourceId)))];
  const manifest = assistantMemory.buildContextManifest({
    ownerId: assistantOwnerId,
    taskId,
    conversationId,
    scope: "global",
    claimRevisionIds,
    sourceIds,
    tokenBudget: 1200
  });
  const guidanceText = guidance.length
    ? `\n# Personal guidance\n\n${guidance.map((claim) => `- ${String(claim.current.value)}`).join("\n")}\n`
    : "";
  const context = `# Task context\n\nCapability: extended-launch-brief-v1\nTask: ${taskId}\nAllowed root: this workspace only\nRequired output: output/launch-status-brief.md\nRequired headings: Current state, Evidence, Risks, Next actions\nContext manifest: ${manifest.manifestId}\n${guidanceText}`;
  return assistantWorkers.submitTask({
    taskId,
    capability: "extended-launch-brief-v1",
    prompt: "Read CONTEXT.md and inputs/source.md using workspace tools. Create the required one-page Markdown brief at output/launch-status-brief.md. Then use workspace_run with wc to verify its byte size, read the finished file, and report the checks.",
    workspace,
    context,
    artifact: { sourcePath: "output/launch-status-brief.md", relativePath: "launch-status-brief.md" },
    metadata: { clientMessageId, conversationId, title: "Create a launch-status brief", contextManifestId: manifest.manifestId }
  });
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const body = await readBody(request, 1024 * 1024);
  try { return JSON.parse(body.toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }); }
}

function projectFleet(panes, measuredAt, durationMs) {
  const sessionsById = Object.groupBy(panes, (pane) => pane.sessionId);
  const sessions = Object.entries(sessionsById).map(([sessionId, sessionPanes]) => ({
    sessionId,
    name: sessionPanes[0].sessionName,
    paneCount: sessionPanes.length,
    activePaneCount: sessionPanes.filter((pane) => pane.active).length,
    commands: Object.fromEntries(Object.entries(Object.groupBy(sessionPanes, (pane) => pane.command)).map(([key, values]) => [key, values.length]))
  }));
  return { measuredAt, discoveryLatencyMs: durationMs, sessions, panes };
}

async function getFleet() {
  try {
    const inventory = await inventoryTmux();
    return projectFleet(inventory.panes, new Date().toISOString(), inventory.durationMs);
  } catch (error) {
    if (/no server running|failed to connect|error connecting.*no such file|no such file or directory/i.test(String(error?.stderr ?? error))) return projectFleet([], new Date().toISOString(), 0);
    throw error;
  }
}

async function paneTail(paneId, lines = 120) {
  const safeLines = Math.max(20, Math.min(500, Number(lines) || 120));
  const fleet = await getFleet();
  if (!fleet.panes.some((pane) => pane.paneId === paneId)) throw Object.assign(new Error("Pane was not found"), { statusCode: 404 });
  const result = await run("tmux", ["capture-pane", "-p", "-e", "-t", paneId, "-S", `-${safeLines}`]);
  return { paneId, lines: safeLines, capturedAt: new Date().toISOString(), durationMs: result.durationMs, content: result.stdout };
}

async function controlSnapshot(lines = 48) {
  if (snapshotPromise && Date.now() < snapshotExpiresAt) return snapshotPromise;
  snapshotExpiresAt = Date.now() + 600;
  snapshotPromise = (async () => {
    const fleet = await getFleet();
    const panes = await Promise.all(fleet.panes.map(async (pane) => {
      let content = "";
      let captureLatencyMs = 0;
      try {
        const captured = await run("tmux", ["capture-pane", "-p", "-e", "-t", pane.paneId, "-S", `-${Math.max(20, Math.min(120, Number(lines) || 48))}`]);
        content = stripTerminalControls(captured.stdout);
        captureLatencyMs = captured.durationMs;
      } catch {}
      const digest = terminalDigest(content.split("\n").slice(-30).join("\n"));
      const previous = paneActivity.get(pane.paneId);
      const changed = Boolean(previous && previous.digest !== digest);
      const lastChangedAt = changed || !previous ? new Date().toISOString() : previous.lastChangedAt;
      paneActivity.set(pane.paneId, { digest, lastChangedAt });
      const attention = inspectAttention(content);
      return { ...pane, tail: content, captureLatencyMs, activity: attention.required ? "attention" : changed ? "working" : "steady", lastChangedAt, attention };
    }));
    const liveIds = new Set(panes.map((pane) => pane.paneId));
    for (const paneId of paneActivity.keys()) if (!liveIds.has(paneId)) paneActivity.delete(paneId);
    return { ...fleet, panes, attentionCount: panes.filter((pane) => pane.attention.required).length };
  })();
  try { return await snapshotPromise; }
  finally { if (Date.now() >= snapshotExpiresAt) snapshotPromise = null; }
}

async function requirePane(paneId) {
  const fleet = await getFleet();
  if (!fleet.panes.some((pane) => pane.paneId === paneId)) throw Object.assign(new Error("Pane was not found"), { statusCode: 404 });
}

async function sendPaneInput(paneId, body) {
  await requirePane(paneId);
  const text = String(body.text ?? "");
  if (!text && !body.enter) throw Object.assign(new Error("text or enter is required"), { statusCode: 400 });
  if (text.length > 20_000 || text.includes("\0")) throw Object.assign(new Error("Input is invalid or too large"), { statusCode: 400 });
  if (text) await run("tmux", ["send-keys", "-t", paneId, "-l", text]);
  if (body.enter) await run("tmux", ["send-keys", "-t", paneId, "Enter"]);
  const event = await store.append("pane.input_sent", { paneId, characterCount: text.length, preview: redactCommandPreview(text), enter: Boolean(body.enter) }, paneId);
  snapshotExpiresAt = 0;
  return { ok: true, paneId, eventId: event.eventId, characterCount: text.length, enter: Boolean(body.enter) };
}

const allowedKeys = new Set(["Enter", "C-c", "C-d", "C-z", "Escape", "Tab", "BTab", "Up", "Down", "Left", "Right", "PageUp", "PageDown"]);
async function sendPaneKey(paneId, key) {
  await requirePane(paneId);
  if (!allowedKeys.has(key)) throw Object.assign(new Error("Key is not allowed"), { statusCode: 400 });
  await run("tmux", ["send-keys", "-t", paneId, key]);
  await store.append("pane.key_sent", { paneId, key }, paneId);
  snapshotExpiresAt = 0;
  return { ok: true, paneId, key };
}

async function spawnTmux(body) {
  const mode = body.mode ?? "pane";
  const cwd = String(body.cwd ?? projectRoot);
  const command = String(body.command ?? "").trim();
  const format = "#{pane_id}\t#{session_id}\t#{session_name}\t#{window_id}";
  let args;
  if (mode === "pane") {
    if (!body.target) throw Object.assign(new Error("target is required for a new pane"), { statusCode: 400 });
    args = ["split-window", "-d", "-t", String(body.target), "-c", cwd, "-P", "-F", format, ...(command ? [command] : [])];
  } else if (mode === "window") {
    if (!body.target) throw Object.assign(new Error("target session is required for a new window"), { statusCode: 400 });
    args = ["new-window", "-d", "-t", String(body.target), "-c", cwd, "-P", "-F", format, ...(body.name ? ["-n", String(body.name)] : []), ...(command ? [command] : [])];
  } else if (mode === "session") {
    const name = String(body.name ?? "");
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(name)) throw Object.assign(new Error("A safe session name is required"), { statusCode: 400 });
    args = ["new-session", "-d", "-s", name, "-c", cwd, "-P", "-F", format, ...(command ? [command] : [])];
  } else throw Object.assign(new Error("mode must be pane, window, or session"), { statusCode: 400 });
  const result = await run("tmux", args);
  const [paneId, sessionId, sessionName, windowId] = result.stdout.trim().split("\t");
  await store.append("pane.spawned", { mode, paneId, sessionId, sessionName, windowId, cwd, commandPreview: redactCommandPreview(command) }, paneId);
  snapshotExpiresAt = 0;
  return { ok: true, mode, paneId, sessionId, sessionName, windowId, cwd };
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(response, 200, { ok: true, tmux: true, voiceConfigured: Boolean(config.openrouterKey), explainer: codex.status(), experimentAdapters: [...experiments.adapters], models: { stt: config.sttModel, tts: config.ttsModel, explainer: codex.model ?? "Codex default", explainerProvider: codex.modelProvider } });
  }
  if (request.method === "GET" && url.pathname === "/api/assistant/conversation") {
    const after = Number(url.searchParams.get("after") ?? 0);
    if (!Number.isInteger(after) || after < 0) throw Object.assign(new Error("after must be a non-negative integer"), { statusCode: 400 });
    const conversationId = url.searchParams.get("conversationId") ?? "default";
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(conversationId)) throw Object.assign(new Error("A safe conversationId is required"), { statusCode: 400 });
    return json(response, 200, { conversationId, ...await publicConversation(conversationId, after) });
  }
  if (request.method === "GET" && url.pathname === "/api/assistant/tasks") {
    const after = Number(url.searchParams.get("after") ?? 0);
    if (!Number.isInteger(after) || after < 0) throw Object.assign(new Error("after must be a non-negative integer"), { statusCode: 400 });
    const snapshot = await assistantWorkers.snapshot();
    const conversationId = url.searchParams.get("conversationId") ?? "default";
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(conversationId)) throw Object.assign(new Error("A safe conversationId is required"), { statusCode: 400 });
    return json(response, 200, {
      revision: snapshot.revision,
      tasks: snapshot.tasks.filter((task) => task.revision > after && (task.input?.metadata?.conversationId ?? "default") === conversationId).map(publicTask)
    });
  }
  if (request.method === "GET" && url.pathname === "/api/assistant/memory") {
    const scope = url.searchParams.get("scope") ?? "global";
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(scope)) throw Object.assign(new Error("scope is invalid"), { statusCode: 400 });
    return json(response, 200, { ownerId: assistantOwnerId, scope, claims: assistantMemory.recall({ ownerId: assistantOwnerId, scope }) });
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/assistant/memory/manifests/")) {
    const manifestId = decodeURIComponent(url.pathname.slice("/api/assistant/memory/manifests/".length));
    const manifest = assistantMemory.getContextManifest(manifestId);
    if (!manifest) throw Object.assign(new Error("Context manifest was not found"), { statusCode: 404 });
    const { memoryRevision, eraseEpoch, claimRevisionIds } = manifest;
    return json(response, 200, { ...manifest, memoryRevision, eraseEpoch, claimRevisionIds });
  }
  if (request.method === "GET" && /^\/api\/assistant\/memory\/[^/]+\/explain$/.test(url.pathname)) {
    const claimId = decodeURIComponent(url.pathname.slice("/api/assistant/memory/".length, -"/explain".length));
    const claim = assistantMemory.getClaim(claimId);
    if (!claim || claim.ownerId !== assistantOwnerId) throw Object.assign(new Error("Memory was not found"), { statusCode: 404 });
    return json(response, 200, { claim, explanation: { scope: claim.scope, currentRevision: claim.current, sources: claim.sources } });
  }
  if (request.method === "POST" && url.pathname === "/api/assistant/memory") {
    const body = await readJson(request);
    const action = String(body.action ?? "");
    if (action === "remember") {
      const value = String(body.value ?? "").trim();
      const scope = String(body.scope ?? "global");
      if (!value || value.length > 2000) throw Object.assign(new Error("value must be 1-2000 characters"), { statusCode: 400 });
      if (!/^[A-Za-z0-9:._-]{1,128}$/.test(scope)) throw Object.assign(new Error("scope is invalid"), { statusCode: 400 });
      const source = assistantMemory.addSource({ ownerId: assistantOwnerId, scope, sourceType: "explicit-user", sourceRef: `manual:${randomUUID()}`, metadata: { channel: "understanding-you" } });
      const claim = assistantMemory.createClaim({ ownerId: assistantOwnerId, scope, subject: "user", predicate: "collaboration_guidance", value, sourceIds: [source.sourceId], authorType: "user", inferred: false });
      return json(response, 201, { claim });
    }
    const claimId = String(body.claimId ?? "");
    const claim = assistantMemory.getClaim(claimId);
    if (!claim || claim.ownerId !== assistantOwnerId) throw Object.assign(new Error("Memory was not found"), { statusCode: 404 });
    if (action === "correct") {
      const value = String(body.value ?? "").trim();
      if (!value || value.length > 2000) throw Object.assign(new Error("value must be 1-2000 characters"), { statusCode: 400 });
      const source = assistantMemory.addSource({ ownerId: assistantOwnerId, scope: claim.scope, sourceType: "explicit-correction", sourceRef: `manual:${randomUUID()}`, metadata: { channel: "understanding-you" } });
      const corrected = assistantMemory.correct({ claimId, expectedRevision: body.expectedRevision, value, sourceIds: [source.sourceId], authorType: "user" });
      return json(response, 200, { claim: corrected });
    }
    if (action === "stop_use") {
      const tombstone = assistantMemory.stopUse({ ownerId: assistantOwnerId, targetType: "claim", targetId: claimId, scope: body.scope ?? null, expiresAt: body.expiresAt ?? null });
      return json(response, 200, { tombstone });
    }
    if (action === "erase") {
      const tombstone = assistantMemory.erase({ ownerId: assistantOwnerId, targetType: "claim", targetId: claimId, scope: body.scope ?? null });
      return json(response, 200, { tombstone });
    }
    throw Object.assign(new Error("action must be remember, correct, stop_use, or erase"), { statusCode: 400 });
  }
  if (request.method === "POST" && /^\/api\/assistant\/tasks\/[^/]+\/commands$/.test(url.pathname)) {
    const taskId = decodeURIComponent(url.pathname.slice("/api/assistant/tasks/".length, -"/commands".length));
    const body = await readJson(request);
    const commandId = String(body.commandId ?? "");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(commandId)) throw Object.assign(new Error("A safe commandId is required"), { statusCode: 400 });
    if (body.type !== "cancel") throw Object.assign(new Error("Only the cancel command is supported"), { statusCode: 400 });
    const expectedRevision = body.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Object.assign(new Error("expectedRevision must be a non-negative integer"), { statusCode: 400 });
    const result = await assistantWorkers.cancelTask({ taskId, commandId, expectedRevision, reason: "user-requested" });
    const snapshot = await assistantWorkers.snapshot();
    return json(response, 200, { replayed: result.replayed, revision: snapshot.revision, task: publicTask(result.task) });
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/assistant/artifacts/")) {
    const artifactId = decodeURIComponent(url.pathname.slice("/api/assistant/artifacts/".length));
    const artifact = await assistantSupervisor.readArtifact(artifactId);
    response.writeHead(200, {
      "Content-Type": artifact.filename.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/octet-stream",
      "Content-Length": artifact.contents.length,
      "Content-Disposition": `attachment; filename="${artifact.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "Cache-Control": "no-store",
      "X-EV-Artifact-SHA256": artifact.receipt.sha256
    });
    return response.end(artifact.contents);
  }
  if (request.method === "POST" && url.pathname === "/api/assistant/messages") {
    const body = await readJson(request);
    const clientMessageId = String(body.clientMessageId ?? "");
    const conversationId = String(body.conversationId ?? "default");
    const text = String(body.text ?? "").trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientMessageId)) throw Object.assign(new Error("A safe clientMessageId is required"), { statusCode: 400 });
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(conversationId)) throw Object.assign(new Error("A safe conversationId is required"), { statusCode: 400 });
    if (!text) throw Object.assign(new Error("text is required"), { statusCode: 400 });
    if (text.length > 8000) throw Object.assign(new Error("text must not exceed 8000 characters"), { statusCode: 400 });
    const existing = assistantLedger.findByClientMessageId(clientMessageId);
    if (existing) {
      if (existing.userMessage.conversationId !== conversationId) throw Object.assign(new Error("clientMessageId belongs to another conversation"), { statusCode: 409 });
      if (existing.intent?.route === "worker") await ensureLaunchBriefTask(clientMessageId, conversationId);
      return json(response, 200, await publicTurn({ ...existing, replayed: true }));
    }
    const planned = planAssistantTurn({ clientMessageId, transcript: text, fleet: await controlSnapshot(72) });
    if (planned.route === "worker") await ensureLaunchBriefTask(clientMessageId, conversationId);
    const turn = assistantLedger.recordTurn({
      conversationId,
      clientMessageId,
      userText: text,
      assistantText: planned.response,
      intent: { kind: planned.classification, route: planned.route, capability: planned.capability ?? null },
      route: planned.route === "worker" ? "assistant" : planned.route,
      skipTask: planned.route === "worker",
      taskTitle: text
    });
    return json(response, 201, await publicTurn(turn));
  }
  if (request.method === "GET" && url.pathname === "/api/fleet") return json(response, 200, await getFleet());
  if (request.method === "GET" && url.pathname === "/api/control-snapshot") return json(response, 200, await controlSnapshot(url.searchParams.get("lines")));
  if (request.method === "GET" && url.pathname.startsWith("/api/panes/") && url.pathname.endsWith("/tail")) {
    const encoded = url.pathname.slice("/api/panes/".length, -"/tail".length);
    return json(response, 200, await paneTail(decodeURIComponent(encoded), url.searchParams.get("lines")));
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/panes/") && url.pathname.endsWith("/input")) {
    const encoded = url.pathname.slice("/api/panes/".length, -"/input".length);
    return json(response, 200, await sendPaneInput(decodeURIComponent(encoded), await readJson(request)));
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/panes/") && url.pathname.endsWith("/key")) {
    const encoded = url.pathname.slice("/api/panes/".length, -"/key".length);
    const body = await readJson(request);
    return json(response, 200, await sendPaneKey(decodeURIComponent(encoded), body.key));
  }
  if (request.method === "POST" && url.pathname === "/api/tmux/spawn") return json(response, 200, await spawnTmux(await readJson(request)));
  if (request.method === "GET" && url.pathname === "/api/explain/context") {
    const paneId = url.searchParams.get("paneId");
    if (!paneId) throw Object.assign(new Error("paneId is required"), { statusCode: 400 });
    return json(response, 200, await explainer.context(paneId));
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/explain/sessions/")) {
    const sessionId = decodeURIComponent(url.pathname.slice("/api/explain/sessions/".length));
    return json(response, 200, await explainer.session(sessionId));
  }
  if (request.method === "POST" && url.pathname === "/api/explain/ask") {
    const body = await readJson(request);
    return json(response, 200, await explainer.ask({
      sessionId: body.sessionId ?? null,
      paneId: body.paneId,
      question: body.question
    }));
  }
  if (request.method === "POST" && url.pathname === "/api/explain/feedback") {
    const body = await readJson(request);
    return json(response, 200, await explainer.feedback(body));
  }
  if (request.method === "POST" && url.pathname === "/api/explain/task-context") return json(response, 200, await explainer.bindTask(await readJson(request)));
  if (request.method === "GET" && url.pathname === "/api/capabilities") {
    const paneId = url.searchParams.get("paneId");
    if (!paneId) throw Object.assign(new Error("paneId is required"), { statusCode: 400 });
    return json(response, 200, await experiments.catalog(paneId));
  }
  if (request.method === "POST" && url.pathname === "/api/experiments/run") return json(response, 200, await experiments.run(await readJson(request)));
  if (request.method === "POST" && url.pathname === "/api/experiments/acceptance-suite") return json(response, 200, await experiments.runAcceptanceSuite(await readJson(request)));
  if (request.method === "GET" && url.pathname === "/api/experiments/recent") return json(response, 200, { runs: await experiments.recent(Number(url.searchParams.get("limit")) || 20) });
  if (request.method === "GET" && url.pathname.startsWith("/api/experiments/")) {
    const runId = decodeURIComponent(url.pathname.slice("/api/experiments/".length));
    const receipt = await experiments.get(runId);
    if (!receipt) throw Object.assign(new Error("Experiment was not found"), { statusCode: 404 });
    return json(response, 200, receipt);
  }
  if (request.method === "POST" && url.pathname === "/api/voice/transcribe") {
    if (!config.openrouterKey) throw Object.assign(new Error("OpenRouter voice is not configured"), { statusCode: 503 });
    const audio = await readBody(request, config.maxAudioBytes);
    if (!audio.length) throw Object.assign(new Error("Audio body is empty"), { statusCode: 400 });
    const format = url.searchParams.get("format") || "webm";
    const result = await transcribeBuffer({ apiKey: config.openrouterKey, model: config.sttModel, audio, format, timeoutMs: 60_000 });
    return json(response, 200, { transcript: result.body.text ?? result.body.transcript ?? "", latencyMs: result.latencyMs, inputBytes: result.inputBytes, usage: result.body.usage ?? null, model: config.sttModel });
  }
  if (request.method === "POST" && url.pathname === "/api/voice/speak") {
    if (!config.openrouterKey) throw Object.assign(new Error("OpenRouter voice is not configured"), { statusCode: 503 });
    const body = await readJson(request);
    if (!body.text?.trim()) throw Object.assign(new Error("text is required"), { statusCode: 400 });
    const result = await synthesize({ apiKey: config.openrouterKey, model: config.ttsModel, voice: config.ttsVoice, text: body.text.trim().slice(0, 2000), format: "mp3", timeoutMs: 60_000 });
    response.writeHead(200, {
      "Content-Type": result.contentType ?? "audio/mpeg",
      "Content-Length": result.audio.length,
      "Cache-Control": "no-store",
      "X-EV-First-Byte-Ms": result.firstByteMs.toFixed(1),
      "X-EV-Total-Latency-Ms": result.totalLatencyMs.toFixed(1)
    });
    return response.end(result.audio);
  }
  return false;
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
async function serveStatic(response, url) {
  const pathname = url.pathname === "/" ? "assistant.html" : url.pathname === "/workstation" ? "index.html" : normalize(url.pathname.slice(1));
  if (pathname.startsWith("..")) throw Object.assign(new Error("Invalid path"), { statusCode: 400 });
  try {
    const body = await readFile(join(webRoot, pathname));
    response.writeHead(200, { "Content-Type": contentTypes[extname(pathname)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return json(response, 404, { error: "Not found" });
    throw error;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, url);
      if (handled === false) return json(response, 404, { error: "API route not found" });
      return;
    }
    await serveStatic(response, url);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${request.method} ${url.pathname}: ${error.message}`);
    const codedStatus = {
      TASK_NOT_FOUND: 404,
      ARTIFACT_NOT_FOUND: 404,
      TASK_REVISION_CONFLICT: 409,
      COMMAND_ID_CONFLICT: 409,
      CAPABILITY_NOT_ALLOWED: 400,
      INVALID_ARTIFACT_ID: 400,
      INVALID_COMMAND_ID: 400
    }[error.code];
    if (!response.headersSent) json(response, error.statusCode ?? codedStatus ?? 500, { error: error.message, code: error.code ?? null });
    else response.end();
  }
});

server.listen(config.port, config.host, async () => {
  await store.append("daemon.started", { host: config.host, port: config.port, voiceConfigured: Boolean(config.openrouterKey) });
  console.log(`EV prototype: http://${config.host}:${config.port}`);
  console.log(`Voice: ${config.openrouterKey ? `${config.sttModel} / ${config.ttsModel}` : "not configured"}`);
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await assistantWorkers.shutdown().catch((error) => console.error(`Worker shutdown failed: ${error.message}`));
    codex.close();
    assistantLedger.close();
    assistantMemory.close();
    assistantSupervisor.close();
    server.close(() => process.exit(0));
  });
}
