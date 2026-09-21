/**
 * Small, provider-neutral wake scheduler for standing responsibilities.
 *
 * The scheduler owns only process-local wake coordination. It does not store
 * mandates, grant authority, or change responsibility state. Callers provide
 * a narrow active-responsibility enumerator and a runner factory; the runner
 * remains responsible for reading current authority and reconciling a tick.
 */
export class StandingResponsibilityScheduler {
  constructor({
    listResponsibilities,
    createRunner,
    intervalMs = 60_000,
    clock = () => new Date(),
    setIntervalFn = globalThis.setInterval,
    clearIntervalFn = globalThis.clearInterval,
    onFailure = async () => {}
  } = {}) {
    if (typeof listResponsibilities !== "function") {
      throw Object.assign(new Error("listResponsibilities is required"), { code: "INVALID_SCHEDULER" });
    }
    if (typeof createRunner !== "function") {
      throw Object.assign(new Error("createRunner is required"), { code: "INVALID_SCHEDULER" });
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw Object.assign(new Error("intervalMs must be a positive integer"), { code: "INVALID_SCHEDULER" });
    }
    if (typeof clock !== "function" || typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function") {
      throw Object.assign(new Error("clock and timer functions are required"), { code: "INVALID_SCHEDULER" });
    }
    if (typeof onFailure !== "function") {
      throw Object.assign(new Error("onFailure must be a function"), { code: "INVALID_SCHEDULER" });
    }
    this.listResponsibilities = listResponsibilities;
    this.createRunner = createRunner;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.onFailure = onFailure;
    this.timer = null;
    this.inFlight = new Map();
  }

  _now() {
    const value = this.clock();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  _failure({ responsibilityId = null, error, startedAt = null }) {
    return {
      status: "failed",
      responsibilityId,
      startedAt,
      finishedAt: this._now(),
      error: {
        code: error?.code ?? "SCHEDULER_TICK_FAILED",
        message: error?.message ?? String(error)
      }
    };
  }

  async _reportFailure(failure) {
    try {
      await this.onFailure(structuredClone(failure));
    } catch {
      // Failure reporting is observational. A broken reporter must not stop
      // future wakes or turn a runner failure into an authority mutation.
    }
    return failure;
  }

  _responsibilityId(value) {
    const responsibilityId = typeof value === "string" ? value : value?.responsibilityId;
    if (typeof responsibilityId !== "string" || !responsibilityId.trim()) {
      throw Object.assign(new Error("active responsibility must have a responsibilityId"), { code: "INVALID_RESPONSIBILITY" });
    }
    return responsibilityId;
  }

  async _run(value) {
    const responsibilityId = this._responsibilityId(value);
    const existing = this.inFlight.get(responsibilityId);
    if (existing) {
      return {
        status: "already_running",
        responsibilityId,
        startedAt: null,
        finishedAt: this._now()
      };
    }

    const startedAt = this._now();
    const promise = (async () => {
      try {
        const runner = await this.createRunner(value);
        if (!runner || typeof runner.tick !== "function") {
          throw Object.assign(new Error("runner factory must return an object with tick()"), { code: "INVALID_RUNNER" });
        }
        const result = await runner.tick();
        return {
          status: "completed",
          responsibilityId,
          startedAt,
          finishedAt: this._now(),
          result
        };
      } catch (error) {
        return this._reportFailure(this._failure({ responsibilityId, error, startedAt }));
      }
    })();
    this.inFlight.set(responsibilityId, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(responsibilityId) === promise) this.inFlight.delete(responsibilityId);
    }
  }

  async tickNow({ responsibilityId = null } = {}) {
    let responsibilities;
    try {
      responsibilities = await this.listResponsibilities();
      if (!Array.isArray(responsibilities)) {
        throw Object.assign(new Error("listResponsibilities must return an array"), { code: "INVALID_RESPONSIBILITY_LIST" });
      }
    } catch (error) {
      return [await this._reportFailure(this._failure({ error }))];
    }

    const seen = new Set();
    const pending = [];
    for (const value of responsibilities) {
      let id;
      try {
        id = this._responsibilityId(value);
      } catch (error) {
        pending.push(this._reportFailure(this._failure({ error })));
        continue;
      }
      if (responsibilityId && id !== responsibilityId) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      // A responsibility enumerator is expected to return active records. If
      // it also returns a status, enforce the narrow active-only contract.
      if (typeof value === "object" && value.status !== undefined && value.status !== "active") continue;
      // Different responsibilities may make progress concurrently; the
      // inFlight map inside _run provides the per-responsibility serialization
      // that prevents duplicate wakes from overlapping.
      pending.push(this._run(value));
    }
    return Promise.all(pending);
  }

  start() {
    if (this.timer !== null) return { status: "already_started", intervalMs: this.intervalMs };
    this.timer = this.setIntervalFn(() => {
      // The timer must never create an unhandled rejection. tickNow reports
      // runner/list failures through onFailure and returns structured results.
      return this.tickNow();
    }, this.intervalMs);
    return { status: "started", intervalMs: this.intervalMs };
  }

  stop() {
    if (this.timer === null) return { status: "already_stopped" };
    this.clearIntervalFn(this.timer);
    this.timer = null;
    return { status: "stopped" };
  }
}

export default StandingResponsibilityScheduler;
