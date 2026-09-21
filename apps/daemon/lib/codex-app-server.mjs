import { spawn } from "node:child_process";
import readline from "node:readline";

export class CodexAppServer {
  constructor({ cwd, model = null, modelProvider = "openai", turnTimeoutMs = 240_000, command = "codex" } = {}) {
    this.cwd = cwd;
    this.model = model;
    this.modelProvider = modelProvider;
    this.turnTimeoutMs = turnTimeoutMs;
    this.command = command;
    this.process = null;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.loadedThreads = new Set();
    this.stderr = "";
  }

  status() {
    return {
      available: Boolean(this.process && this.process.exitCode === null),
      starting: Boolean(this.starting),
      loadedThreadCount: this.loadedThreads.size,
      lastError: this.stderr.split("\n").filter(Boolean).slice(-1)[0] ?? null
    };
  }

  async start() {
    if (this.process && this.process.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try { await this.starting; }
    finally { this.starting = null; }
  }

  async #start() {
    const args = ["app-server", "--stdio"];
    if (this.modelProvider) args.push("-c", `model_provider=${JSON.stringify(this.modelProvider)}`);
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process = child;
    this.stderr = "";
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.#receive(line));
    child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-8_000); });
    child.on("error", (error) => this.#disconnect(error));
    child.on("exit", (code, signal) => this.#disconnect(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`)));
    await this.#requestRaw("initialize", {
      clientInfo: { name: "ev_explanation_window", title: "EV Explanation Window", version: "0.1.0" }
    });
    this.#send({ method: "initialized", params: {} });
  }

  #send(message) {
    if (!this.process || this.process.exitCode !== null) throw new Error("Codex app-server is unavailable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #requestRaw(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#send({ method, id, params });
    });
  }

  async request(method, params = {}) {
    await this.start();
    return this.#requestRaw(method, params);
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }

    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? "unknown error"}`));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.#send({ id: message.id, error: { code: -32601, message: "EV explainer is read-only and cannot service interactive tool requests." } });
      return;
    }

    const turnId = message.params?.turnId ?? message.params?.turn?.id;
    if (!turnId) return;
    const state = this.turns.get(turnId) ?? { answer: "", completed: null, waiter: null };
    if (message.method === "item/agentMessage/delta") state.answer += message.params.delta ?? "";
    if (message.method === "item/completed" && message.params.item?.type === "agentMessage") state.answer = message.params.item.text ?? state.answer;
    if (message.method === "turn/completed") {
      state.completed = message.params.turn;
      if (state.waiter) state.waiter();
    }
    this.turns.set(turnId, state);
  }

  #disconnect(error) {
    if (!this.process) return;
    this.process = null;
    this.loadedThreads.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const state of this.turns.values()) {
      if (!state.completed) {
        state.completed = { status: "failed", error: { message: error.message } };
        if (state.waiter) state.waiter();
      }
    }
  }

  async startThread({ cwd, developerInstructions }) {
    const params = {
      cwd,
      developerInstructions,
      sandbox: "read-only",
      approvalPolicy: "never",
      personality: "friendly"
    };
    if (this.model) params.model = this.model;
    const result = await this.request("thread/start", params);
    this.loadedThreads.add(result.thread.id);
    return result.thread;
  }

  async resumeThread(threadId) {
    if (this.loadedThreads.has(threadId)) return;
    await this.request("thread/resume", { threadId });
    this.loadedThreads.add(threadId);
  }

  async runTurn({ threadId, input, cwd = null }) {
    await this.resumeThread(threadId);
    const params = {
      threadId,
      input: [{ type: "text", text: input }],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      approvalPolicy: "never"
    };
    if (cwd) params.cwd = cwd;
    const result = await this.request("turn/start", params);
    const turnId = result.turn.id;
    const state = this.turns.get(turnId) ?? { answer: "", completed: null, waiter: null };
    this.turns.set(turnId, state);
    if (!state.completed) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.waiter = null;
          reject(new Error("Explanation turn timed out"));
        }, this.turnTimeoutMs);
        state.waiter = () => { clearTimeout(timer); resolve(); };
      });
    }
    this.turns.delete(turnId);
    if (state.completed.status !== "completed") {
      throw new Error(state.completed.error?.message ?? `Explanation turn ${state.completed.status}`);
    }
    return { turnId, answer: state.answer.trim(), durationMs: state.completed.durationMs ?? null };
  }

  close() {
    if (this.process && this.process.exitCode === null) this.process.kill("SIGTERM");
  }
}
