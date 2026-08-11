import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class EventStore {
  constructor(path) {
    this.path = path;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, "", { mode: 0o600 });
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

  async tasks() {
    return (await this.all())
      .filter((event) => event.type === "task.delegated")
      .map((event) => ({
        taskId: event.payload.taskId,
        utteranceId: event.payload.utteranceId,
        transcript: event.payload.transcript,
        selectedPaneId: event.payload.selectedPaneId,
        status: "awaiting_orchestrator",
        createdAt: event.occurredAt
      }))
      .reverse();
  }
}
