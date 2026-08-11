#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryTmux } from "../../lab/lib/tmux.mjs";
import { run } from "../../lab/lib/process.mjs";
import { synthesize, transcribeBuffer } from "../../lab/lib/providers/openrouter.mjs";
import { loadDotEnv } from "./lib/env.mjs";
import { EventStore } from "./lib/store.mjs";
import { handleCompanion } from "./lib/companion.mjs";
import { inspectAttention, redactCommandPreview, stripTerminalControls, terminalDigest } from "./lib/attention.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const webRoot = join(projectRoot, "apps", "web");
await loadDotEnv(join(projectRoot, ".env"));
const store = new EventStore(join(projectRoot, "data", "events.jsonl"));
await store.initialize();

const config = {
  host: process.env.EV_HOST ?? "127.0.0.1",
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

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
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
    if (/no server running|failed to connect/i.test(String(error?.stderr ?? error))) return projectFleet([], new Date().toISOString(), 0);
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
    return json(response, 200, { ok: true, tmux: true, voiceConfigured: Boolean(config.openrouterKey), models: { stt: config.sttModel, tts: config.ttsModel } });
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
  if (request.method === "GET" && url.pathname === "/api/events") return json(response, 200, { events: await store.recent(Number(url.searchParams.get("limit")) || 40) });
  if (request.method === "GET" && url.pathname === "/api/tasks") return json(response, 200, { tasks: await store.tasks() });
  if (request.method === "POST" && url.pathname === "/api/companion") {
    const body = await readJson(request);
    if (!body.transcript?.trim()) throw Object.assign(new Error("transcript is required"), { statusCode: 400 });
    return json(response, 200, await handleCompanion({ transcript: body.transcript.trim(), selectedPaneId: body.selectedPaneId ?? null, fleet: await getFleet(), store }));
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
  const pathname = url.pathname === "/" ? "index.html" : normalize(url.pathname.slice(1));
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
    if (!response.headersSent) json(response, error.statusCode ?? 500, { error: error.message });
    else response.end();
  }
});

server.listen(config.port, config.host, async () => {
  await store.append("daemon.started", { host: config.host, port: config.port, voiceConfigured: Boolean(config.openrouterKey) });
  console.log(`EV prototype: http://${config.host}:${config.port}`);
  console.log(`Voice: ${config.openrouterKey ? `${config.sttModel} / ${config.ttsModel}` : "not configured"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
