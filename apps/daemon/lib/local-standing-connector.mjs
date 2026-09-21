import { createHash } from "node:crypto";

function clone(value) {
  return structuredClone(value);
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error(`${name} is required`), { code: "INVALID_INPUT" });
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/**
 * Deterministic local connector implementing the Phase 4 read contract.
 * Tests mutate the fixture through seed/update/remove; the responsibility
 * boundary only receives read results and cannot write a real provider.
 */
export class LocalStandingConnector {
  constructor({ resources = {}, clock = () => new Date() } = {}) {
    this.clock = clock;
    this.resources = new Map();
    for (const [resourceRef, value] of Object.entries(resources)) this.seed({ resourceRef, ...value });
  }

  _now() {
    const value = this.clock();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  seed({ resourceRef, payload, revision = "1", updatedAt = this._now() }) {
    required(resourceRef, "resourceRef");
    this.resources.set(resourceRef, { payload: clone(payload), revision: String(revision), updatedAt: new Date(updatedAt).toISOString(), cursor: `cursor:${String(revision)}` });
    return this.getFixture(resourceRef);
  }

  update({ resourceRef, payload, revision = null, updatedAt = this._now() }) {
    required(resourceRef, "resourceRef");
    const current = this.resources.get(resourceRef);
    const nextRevision = revision === null ? String((Number(current?.revision) || 0) + 1) : String(revision);
    return this.seed({ resourceRef, payload, revision: nextRevision, updatedAt });
  }

  remove({ resourceRef }) {
    required(resourceRef, "resourceRef");
    this.resources.delete(resourceRef);
  }

  getFixture(resourceRef) {
    const value = this.resources.get(resourceRef);
    return value ? clone({ resourceRef, ...value }) : null;
  }

  async read({ resourceRef, cursor = null } = {}) {
    required(resourceRef, "resourceRef");
    const value = this.resources.get(resourceRef);
    if (!value) {
      return {
        resourceRef,
        sourceRevision: "state:no-data",
        cursor,
        state: "no_data",
        observedAt: null,
        payload: null,
        trust: "untrusted-data",
        connector: "local-fixture-v1"
      };
    }
    return {
      resourceRef,
      sourceRevision: value.revision,
      cursor: value.cursor,
      state: "fresh",
      observedAt: value.updatedAt,
      payload: clone(value.payload),
      contentHash: digest(value.payload),
      previousCursor: cursor,
      trust: "untrusted-data",
      connector: "local-fixture-v1"
    };
  }
}

export default LocalStandingConnector;
