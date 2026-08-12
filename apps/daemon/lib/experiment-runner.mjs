import { randomUUID } from "node:crypto";
import { loadCapabilityManifest, coerceExperimentInputs } from "./capability-spec.mjs";
import { experimentAdapterRegistry } from "./experiment-adapters.mjs";
import { captureExplanationEvidence } from "./evidence.mjs";

const ACCEPTANCE_VERSION = 2;

const ACCEPTANCE_GATES = [
  ["goal", "Goal and acceptance criteria are explicit"],
  ["capability", "Changed capability boundary is explicit"],
  ["mechanism", "Typed pipeline is available"],
  ["manipulation", "Meaningful controls and scenarios are available"],
  ["execution", "Registered adapter executed real supported code"],
  ["observation", "Trace and epistemic status were captured"],
  ["comparison", "Baseline and candidate were compared"],
  ["envelope", "Bounded load and resource metrics were measured"],
  ["reproduction", "Immutable run receipt was persisted"],
  ["learningLoop", "A failed assertion produced a regression-test proposal"]
];

function regressionProposal(capability, receipt) {
  const failures = receipt.assertions.filter((assertion) => !assertion.passed);
  if (!failures.length) return null;
  return {
    title: `Regression: ${capability.title} / ${receipt.scenario.label}`,
    target: `Adapter ${capability.adapter}`,
    fixture: receipt.inputs,
    assertions: failures.map((failure) => ({ id: failure.id, expected: failure.expected, actual: failure.actual })),
    suggestedTest: `Re-run capability ${capability.id} scenario ${receipt.scenario.id} with the saved fixture and assert ${failures.map((failure) => failure.id).join(", ")}.`,
    status: "proposed_not_applied"
  };
}

function receiptGates(capability, result, inputs, proposal, evidence) {
  return {
    goal: Boolean(capability.objective && evidence.project?.sourcePaths?.length && evidence.taskContext?.objective && evidence.taskContext?.acceptanceCriteria?.length),
    capability: Boolean(capability.change),
    mechanism: capability.pipeline.length > 0,
    manipulation: capability.controls.length > 0 && capability.scenarios.length > 0,
    execution: result.executedRealCode === true,
    observation: result.trace.some((event) => event.status === "observed") && result.assertions.length > 0,
    comparison: Boolean(result.comparison?.baseline && result.comparison?.candidate),
    envelope: Number(inputs.iterations) > 1
      && Boolean(result.metrics?.latency)
      && Number.isFinite(result.metrics?.throughputPerSecond)
      && Number.isFinite(result.metrics?.errorRate)
      && Number.isFinite(result.metrics?.heapDeltaBytes)
      && Number.isFinite(result.cost?.externalApiUsd),
    reproduction: Boolean(evidence.revision && result.adapterVersion && capability.adapter && Object.keys(inputs).length),
    learningLoop: Boolean(proposal)
  };
}

function aggregateAcceptance(receipts) {
  const current = receipts.filter((receipt) => receipt.acceptanceVersion === ACCEPTANCE_VERSION);
  const gates = Object.fromEntries(ACCEPTANCE_GATES.map(([id, label]) => [id, { id, label, passed: current.some((receipt) => receipt.gates?.[id]), runIds: current.filter((receipt) => receipt.gates?.[id]).map((receipt) => receipt.runId) }]));
  const passed = Object.values(gates).filter((gate) => gate.passed).length;
  return { passed, total: ACCEPTANCE_GATES.length, score: `${passed}/${ACCEPTANCE_GATES.length}`, complete: passed === ACCEPTANCE_GATES.length, gates: Object.values(gates) };
}

export function createExperimentRunner({ store, getPane, baseUrl, fetchImpl = fetch }) {
  const adapters = experimentAdapterRegistry({ baseUrl, fetchImpl });
  const activeRuns = new Set();

  async function manifestForPane(paneId) {
    const pane = await getPane(paneId);
    if (!pane) throw Object.assign(new Error("Pane was not found"), { statusCode: 404 });
    const manifest = await loadCapabilityManifest({ cwd: pane.path, registeredAdapters: new Set(adapters.keys()) });
    return { pane, manifest };
  }

  async function catalog(paneId) {
    const { manifest } = await manifestForPane(paneId);
    const receipts = (await store.recentExperimentRuns(100)).filter((receipt) => receipt.projectRoot === manifest.projectRoot);
    return {
      ...manifest,
      capabilities: manifest.capabilities.map((capability) => ({
        ...capability,
        acceptance: aggregateAcceptance(receipts.filter((receipt) => receipt.capabilityId === capability.id))
      }))
    };
  }

  async function run({ paneId, capabilityId, scenarioId = null, inputs: submittedInputs = {} }) {
    if (activeRuns.size >= 3) throw Object.assign(new Error("Experiment capacity is full"), { statusCode: 429 });
    const { pane, manifest } = await manifestForPane(paneId);
    const capability = manifest.capabilities.find((item) => item.id === capabilityId);
    if (!capability) throw Object.assign(new Error("Capability was not found"), { statusCode: 404 });
    if (capability.support !== "executable") throw Object.assign(new Error(`Missing experiment adapter: ${capability.missingAdapter}`), { statusCode: 501 });
    const adapter = adapters.get(capability.adapter);
    if (adapter.authority !== capability.authority) throw Object.assign(new Error("Capability authority does not match the registered adapter"), { statusCode: 403 });
    const { scenario, inputs } = coerceExperimentInputs(capability, scenarioId, submittedInputs);
    const evidence = await captureExplanationEvidence({ pane, store });
    const runId = `experiment-${randomUUID().slice(0, 10)}`;
    const startedAt = new Date().toISOString();
    activeRuns.add(runId);
    await store.append("experiment.started", { runId, paneId, capabilityId, scenarioId: scenario.id, inputs, authority: capability.authority, evidenceRevision: evidence.revision }, runId);
    try {
      const result = await adapter.run({ inputs, capability, pane });
      const receipt = {
        schemaVersion: 1,
        acceptanceVersion: ACCEPTANCE_VERSION,
        runId,
        paneId,
        projectRoot: manifest.projectRoot,
        capabilityId,
        capabilityTitle: capability.title,
        adapter: capability.adapter,
        adapterVersion: result.adapterVersion,
        authority: capability.authority,
        scenario,
        inputs,
        evidenceRevision: evidence.revision,
        goal: {
          project: evidence.project.summary,
          task: evidence.taskContext
        },
        startedAt,
        completedAt: new Date().toISOString(),
        status: result.status,
        summary: result.summary,
        trace: result.trace,
        output: result.output,
        assertions: result.assertions,
        comparison: result.comparison,
        metrics: result.metrics,
        cost: result.cost
      };
      receipt.regressionProposal = regressionProposal(capability, receipt);
      receipt.gates = receiptGates(capability, result, inputs, receipt.regressionProposal, evidence);
      await store.append("experiment.completed", { receipt }, runId);
      return receipt;
    } catch (error) {
      const receipt = {
        schemaVersion: 1,
        acceptanceVersion: ACCEPTANCE_VERSION,
        runId,
        paneId,
        projectRoot: manifest.projectRoot,
        capabilityId,
        capabilityTitle: capability.title,
        adapter: capability.adapter,
        authority: capability.authority,
        scenario,
        inputs,
        evidenceRevision: evidence.revision,
        goal: {
          project: evidence.project.summary,
          task: evidence.taskContext
        },
        startedAt,
        completedAt: new Date().toISOString(),
        status: "error",
        summary: error.message,
        trace: [],
        output: null,
        assertions: [],
        comparison: null,
        metrics: null,
        cost: null,
        regressionProposal: null,
        gates: {}
      };
      await store.append("experiment.failed", { receipt }, runId);
      throw Object.assign(error, { runId });
    } finally {
      activeRuns.delete(runId);
    }
  }

  async function runAcceptanceSuite({ paneId, capabilityId }) {
    const before = await catalog(paneId);
    const capability = before.capabilities.find((item) => item.id === capabilityId);
    if (!capability) throw Object.assign(new Error("Capability was not found"), { statusCode: 404 });
    const normal = capability.scenarios.find((scenario) => /^(normal|health)$/.test(scenario.id)) ?? capability.scenarios[0];
    const load = capability.scenarios.find((scenario) => /^(stress|load)$/.test(scenario.id));
    const failure = capability.scenarios.find((scenario) => scenario.id === "contract-failure");
    const selected = [...new Map([normal, load, failure].filter(Boolean).map((scenario) => [scenario.id, scenario])).values()];
    const receipts = [];
    for (const scenario of selected) receipts.push(await run({ paneId, capabilityId, scenarioId: scenario.id }));
    const after = await catalog(paneId);
    return { capabilityId, runs: receipts, acceptance: after.capabilities.find((item) => item.id === capabilityId).acceptance };
  }

  return {
    adapters: new Set(adapters.keys()),
    catalog,
    run,
    runAcceptanceSuite,
    get: (runId) => store.experimentRun(runId),
    recent: (limit) => store.recentExperimentRuns(limit)
  };
}
