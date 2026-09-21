import test from "node:test";
import assert from "node:assert/strict";

import { StandingResponsibilityScheduler } from "../lib/standing-scheduler.mjs";

class FakeClock {
  constructor() { this.value = new Date("2026-09-21T10:00:00.000Z"); }
  now = () => this.value;
  advance(ms) { this.value = new Date(this.value.getTime() + ms); }
}

class FakeTimers {
  constructor() { this.nextId = 1; this.callbacks = new Map(); }
  setInterval = (callback, intervalMs) => {
    const id = this.nextId++;
    this.callbacks.set(id, { callback, intervalMs });
    return id;
  };
  clearInterval = (id) => { this.callbacks.delete(id); };
  async fire() {
    await Promise.all([...this.callbacks.values()].map(({ callback }) => callback()));
  }
}

test("scheduler wakes only active responsibilities and serializes duplicate ticks", async () => {
  const clock = new FakeClock();
  const timers = new FakeTimers();
  const active = [
    { responsibilityId: "launch-watch", status: "active" },
    { responsibilityId: "launch-watch", status: "active" },
    { responsibilityId: "revoked-watch", status: "revoked" }
  ];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const scheduler = new StandingResponsibilityScheduler({
    listResponsibilities: async () => active,
    createRunner: (responsibility) => ({
      tick: async () => {
        calls += 1;
        await gate;
        return { responsibilityId: responsibility.responsibilityId };
      }
    }),
    intervalMs: 25,
    clock: clock.now,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval
  });

  scheduler.start();
  assert.equal(timers.callbacks.size, 1);
  const firstTick = scheduler.tickNow();
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await scheduler.tickNow();
  assert.equal(calls, 1);
  assert.equal(duplicate[0].status, "already_running");
  release();
  const firstResult = await firstTick;
  assert.equal(firstResult[0].status, "completed");
  assert.equal(firstResult[0].result.responsibilityId, "launch-watch");

  assert.equal(scheduler.stop().status, "stopped");
  assert.equal(scheduler.stop().status, "already_stopped");
  clock.advance(1000);
});
test("timer start is idempotent and tick failures are reported without authority changes", async () => {
  const clock = new FakeClock();
  const timers = new FakeTimers();
  const failures = [];
  let ticks = 0;
  const scheduler = new StandingResponsibilityScheduler({
    listResponsibilities: async () => [{ responsibilityId: "launch-watch", status: "active" }],
    createRunner: () => ({ tick: async () => { ticks += 1; throw Object.assign(new Error("connector unavailable"), { code: "CONNECTOR_DOWN" }); } }),
    intervalMs: 50,
    clock: clock.now,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
    onFailure: async (failure) => { failures.push(failure); }
  });
  assert.deepEqual(scheduler.start(), { status: "started", intervalMs: 50 });
  assert.deepEqual(scheduler.start(), { status: "already_started", intervalMs: 50 });
  await timers.fire();
  assert.equal(ticks, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].responsibilityId, "launch-watch");
  assert.equal(failures[0].error.code, "CONNECTOR_DOWN");
  assert.equal(failures[0].startedAt, "2026-09-21T10:00:00.000Z");
  assert.equal(failures[0].finishedAt, "2026-09-21T10:00:00.000Z");
  assert.equal(scheduler.inFlight.size, 0);
  scheduler.stop();
});

test("invalid enumeration is reported and a broken reporter cannot stop future ticks", async () => {
  const clock = new FakeClock();
  let enumerations = 0;
  let reports = 0;
  const scheduler = new StandingResponsibilityScheduler({
    listResponsibilities: async () => {
      enumerations += 1;
      if (enumerations === 1) return null;
      return [{ responsibilityId: "launch-watch", status: "active" }];
    },
    createRunner: () => ({ tick: async () => ({ ok: true }) }),
    clock: clock.now,
    onFailure: async () => { reports += 1; throw new Error("reporter down"); }
  });
  const invalid = await scheduler.tickNow();
  assert.equal(invalid[0].error.code, "INVALID_RESPONSIBILITY_LIST");
  assert.equal(reports, 1);
  const next = await scheduler.tickNow();
  assert.equal(next[0].status, "completed");
});
