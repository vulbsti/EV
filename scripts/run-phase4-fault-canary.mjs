#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StandingResponsibilityStore } from "../apps/daemon/lib/standing-responsibility.mjs";

const root = await mkdtemp(join(tmpdir(), "ev-phase4-fault-"));
let now = new Date("2026-09-22T01:00:00.000Z");
const store = StandingResponsibilityStore.open({ path: join(root, "standing.sqlite"), clock: () => now });
const responsibilityId = "fault-canary";

try {
  await store.createResponsibility({
    responsibilityId,
    ownerId: "default-person",
    mandate: {
      connector: "fault-canary-v1",
      resourceRef: "fixture://fault-canary",
      initialObservation: "baseline_only",
      materialFields: ["date", "blocker"],
      freshnessMs: 60_000,
      preparedOutput: { instructions: "Prepare only from current, fresh source data." },
      approvalBoundary: "prepare_only"
    }
  });
  const baseline = await store.observe({ responsibilityId, observation: { sourceRevision: "1", observedAt: now.toISOString(), payload: { date: "2026-10-01", blocker: null } } });
  now = new Date("2026-09-22T01:05:00.000Z");
  const stale = await store.observe({ responsibilityId, observation: { sourceRevision: "2", observedAt: "2026-09-22T01:00:00.000Z", payload: { date: "2026-10-02", blocker: "stale data" } } });
  const noData = await store.observe({ responsibilityId, observation: { sourceRevision: "state:no-data:3", state: "no_data", observedAt: null, payload: null } });
  const prepared = await store.listPreparedTasks({ responsibilityId });
  const result = {
    baseline: { state: baseline.observation.state, task: baseline.task },
    stale: { state: stale.observation.state, reason: stale.observation.reason, task: stale.task },
    noData: { state: noData.observation.state, task: noData.task },
    preparedTaskCount: prepared.length,
    inventedCurrentData: false
  };
  console.log(JSON.stringify(result, null, 2));
  if (stale.observation.state !== "stale" || noData.observation.state !== "no_data" || prepared.length !== 0) process.exitCode = 1;
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
