import { appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./file-permissions.mjs";

export class EventStore {
  constructor(path) {
    this.path = path;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    ensurePrivateDirectorySync(dirname(this.path));
    await appendFile(this.path, "", { mode: 0o600 });
    ensurePrivateFileSync(this.path);
  }

  async append(type, payload, correlationId = null) {
    const event = {
      schemaVersion: 1,
      eventId: randomUUID(),
      type,
      correlationId,
      occurredAt: new Date().toISOString(),
      payload
    };
    this.writeChain = this.writeChain.then(() => appendFile(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 }));
    await this.writeChain;
    ensurePrivateFileSync(this.path);
    return event;
  }

  async all() {
    await this.writeChain;
    const source = await readFile(this.path, "utf8");
    return source.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  async recent(limit = 50) {
    return (await this.all()).slice(-Math.max(1, Math.min(500, limit))).reverse();
  }

  async explanationSession(sessionId) {
    const events = (await this.all()).filter((event) => event.correlationId === sessionId);
    const started = events.find((event) => event.type === "explanation.session.started");
    if (!started) return null;
    const messages = events
      .filter((event) => event.type === "explanation.question" || event.type === "explanation.answer")
      .map((event) => ({
        role: event.type === "explanation.question" ? "user" : "assistant",
        text: event.payload.text,
        questionId: event.payload.questionId,
        evidenceRevision: event.payload.evidenceRevision,
        occurredAt: event.occurredAt,
        durationMs: event.payload.durationMs ?? null,
        presentation: event.payload.presentation ?? null,
        presentationDiagnostics: event.payload.presentationDiagnostics ?? null
      }));
    return {
      sessionId,
      paneId: started.payload.paneId,
      cwd: started.payload.cwd,
      codexThreadId: started.payload.codexThreadId,
      createdAt: started.occurredAt,
      messages,
      feedback: events.filter((event) => event.type === "explanation.feedback").map((event) => event.payload)
    };
  }

  async explanationProfile() {
    const allEvents = await this.all();
    const lastReset = allEvents.findLastIndex((event) => event.type === "explanation.profile.reset");
    const events = allEvents.slice(lastReset + 1);
    const weights = { concrete: 0, visual: 0, accessible: 0, mechanics: 0, tests: 0, impact: 0 };
    const feedbackMap = {
      more_concrete: "concrete",
      more_visual: "visual",
      less_technical: "accessible",
      deeper_mechanics: "mechanics"
    };
    let explicitFeedbackCount = 0;
    for (const event of events) {
      if (event.type === "explanation.feedback") {
        explicitFeedbackCount += 1;
        const preference = feedbackMap[event.payload.signal];
        if (preference) weights[preference] += 3;
      }
      if (event.type !== "explanation.question") continue;
      const text = event.payload.text.toLowerCase();
      if (/\b(exact|exactly|mechanic|step by step|data flow|control flow)\b/.test(text)) weights.mechanics += 1;
      if (/\b(show|visual|diagram|map|picture)\b/.test(text)) weights.visual += 1;
      if (/\b(test|assert|prove|verification|failure)\b/.test(text)) weights.tests += 1;
      if (/\b(impact|change|break|before|after|affect)\b/.test(text)) weights.impact += 1;
    }
    const preferences = Object.entries(weights)
      .filter(([, weight]) => weight > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, weight]) => ({ name, weight }));
    return { explicitFeedbackCount, weights, preferences };
  }

  async latestTaskContext(paneId) {
    const event = (await this.all()).findLast((item) => item.type === "task.context.bound" && item.payload?.paneId === paneId);
    return event ? { ...event.payload, boundAt: event.occurredAt } : null;
  }

  async experimentRun(runId) {
    const events = (await this.all()).filter((event) => event.correlationId === runId);
    const started = events.find((event) => event.type === "experiment.started");
    const completed = events.findLast((event) => event.type === "experiment.completed" || event.type === "experiment.failed");
    if (!started) return null;
    return completed?.payload?.receipt ?? {
      runId,
      capabilityId: started.payload.capabilityId,
      scenarioId: started.payload.scenarioId,
      status: "running",
      startedAt: started.occurredAt,
      inputs: started.payload.inputs
    };
  }

  async recentExperimentRuns(limit = 20) {
    return (await this.all())
      .filter((event) => event.type === "experiment.completed" || event.type === "experiment.failed")
      .slice(-Math.max(1, Math.min(100, limit)))
      .reverse()
      .map((event) => event.payload.receipt);
  }
}
