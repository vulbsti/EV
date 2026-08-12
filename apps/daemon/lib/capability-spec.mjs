import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const CONTROL_TYPES = new Set(["select", "range", "boolean", "text"]);
const MAX_CAPABILITIES = 30;
const MAX_CONTROLS = 20;
const MAX_PIPELINE_STEPS = 30;
const MAX_SCENARIOS = 30;

function fault(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function shortText(value, limit, field) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw fault(`${field} is required`);
  if (text.length > limit) throw fault(`${field} is too long`);
  return text;
}

function normalizeControl(control, capabilityId) {
  const id = shortText(control?.id, 80, `${capabilityId} control id`);
  if (!SAFE_ID.test(id)) throw fault(`Invalid control id: ${id}`);
  const type = String(control?.type ?? "");
  if (!CONTROL_TYPES.has(type)) throw fault(`Invalid control type for ${id}`);
  const normalized = { id, label: shortText(control?.label, 120, `${id} label`), type, default: control.default };
  if (type === "select") {
    if (!Array.isArray(control.options) || !control.options.length || control.options.length > 30) throw fault(`${id} must define 1-30 options`);
    normalized.options = control.options.map((option) => typeof option === "number" ? option : shortText(option, 160, `${id} option`));
    if (!normalized.options.some((option) => option === normalized.default)) normalized.default = normalized.options[0];
  }
  if (type === "range") {
    normalized.min = Number(control.min);
    normalized.max = Number(control.max);
    normalized.step = Number(control.step ?? 1);
    normalized.default = Number(control.default);
    if (![normalized.min, normalized.max, normalized.step, normalized.default].every(Number.isFinite) || normalized.min > normalized.max || normalized.step <= 0) throw fault(`Invalid range control: ${id}`);
    normalized.default = Math.max(normalized.min, Math.min(normalized.max, normalized.default));
  }
  if (type === "boolean") normalized.default = Boolean(control.default);
  if (type === "text") {
    normalized.default = String(control.default ?? "").slice(0, 500);
    normalized.maxLength = Math.max(1, Math.min(2_000, Number(control.maxLength) || 500));
  }
  return normalized;
}

function normalizeCapability(capability, registeredAdapters) {
  const id = shortText(capability?.id, 80, "capability id");
  if (!SAFE_ID.test(id)) throw fault(`Invalid capability id: ${id}`);
  const adapter = shortText(capability?.adapter, 80, `${id} adapter`);
  if (!SAFE_ID.test(adapter)) throw fault(`Invalid adapter id: ${adapter}`);
  const pipeline = (Array.isArray(capability.pipeline) ? capability.pipeline : []).slice(0, MAX_PIPELINE_STEPS).map((step) => {
    const stepId = shortText(step?.id, 80, `${id} pipeline id`);
    if (!SAFE_ID.test(stepId)) throw fault(`Invalid pipeline id: ${stepId}`);
    return { id: stepId, label: shortText(step?.label, 140, `${stepId} label`) };
  });
  if (!pipeline.length) throw fault(`${id} must define a pipeline`);
  const pipelineIds = new Set(pipeline.map((step) => step.id));
  if (pipelineIds.size !== pipeline.length) throw fault(`${id} has duplicate pipeline ids`);
  const controls = (Array.isArray(capability.controls) ? capability.controls : []).slice(0, MAX_CONTROLS).map((control) => normalizeControl(control, id));
  const controlIds = new Set(controls.map((control) => control.id));
  if (controlIds.size !== controls.length) throw fault(`${id} has duplicate control ids`);
  const scenarios = (Array.isArray(capability.scenarios) ? capability.scenarios : []).slice(0, MAX_SCENARIOS).map((scenario) => {
    const scenarioId = shortText(scenario?.id, 80, `${id} scenario id`);
    if (!SAFE_ID.test(scenarioId)) throw fault(`Invalid scenario id: ${scenarioId}`);
    const overrides = {};
    for (const [key, value] of Object.entries(scenario?.overrides ?? {})) if (controlIds.has(key)) overrides[key] = value;
    return { id: scenarioId, label: shortText(scenario?.label, 140, `${scenarioId} label`), overrides };
  });
  if (!scenarios.length) scenarios.push({ id: "normal", label: "Normal", overrides: {} });
  return {
    id,
    adapter,
    title: shortText(capability?.title, 180, `${id} title`),
    objective: shortText(capability?.objective, 800, `${id} objective`),
    change: shortText(capability?.change, 800, `${id} change`),
    authority: shortText(capability?.authority, 120, `${id} authority`),
    support: registeredAdapters.has(adapter) ? "executable" : "missing_adapter",
    missingAdapter: registeredAdapters.has(adapter) ? null : adapter,
    pipeline,
    controls,
    scenarios
  };
}

async function manifestRoot(cwd) {
  let cursor = resolve(cwd);
  for (;;) {
    const manifestPath = resolve(cursor, ".ev", "capabilities.json");
    try {
      const info = await lstat(manifestPath);
      if (info.isFile() && !info.isSymbolicLink() && info.size <= 256_000) return { root: cursor, manifestPath };
    } catch {}
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

export async function loadCapabilityManifest({ cwd, registeredAdapters = new Set() }) {
  const located = await manifestRoot(cwd);
  if (!located) {
    return {
      schemaVersion: 1,
      projectRoot: resolve(cwd),
      capabilities: [],
      unsupported: {
        reason: "missing_manifest",
        message: "This project has no .ev/capabilities.json capability manifest. EV can explain it, but cannot execute feature experiments yet."
      }
    };
  }
  let source;
  try { source = JSON.parse(await readFile(located.manifestPath, "utf8")); }
  catch (error) { throw fault(`Invalid capability manifest: ${error.message}`); }
  if (source.schemaVersion !== 1) throw fault("Unsupported capability manifest schema version");
  if (!Array.isArray(source.capabilities) || source.capabilities.length > MAX_CAPABILITIES) throw fault(`Capability manifest must contain at most ${MAX_CAPABILITIES} capabilities`);
  const capabilities = source.capabilities.map((capability) => normalizeCapability(capability, registeredAdapters));
  const ids = new Set(capabilities.map((capability) => capability.id));
  if (ids.size !== capabilities.length) throw fault("Capability manifest contains duplicate capability ids");
  return { schemaVersion: 1, projectRoot: located.root, capabilities, unsupported: null };
}

export function coerceExperimentInputs(capability, scenarioId, submitted = {}) {
  const scenario = capability.scenarios.find((item) => item.id === scenarioId) ?? capability.scenarios[0];
  const merged = { ...Object.fromEntries(capability.controls.map((control) => [control.id, control.default])), ...scenario.overrides, ...submitted };
  const inputs = {};
  for (const control of capability.controls) {
    const value = merged[control.id];
    if (control.type === "boolean") inputs[control.id] = Boolean(value);
    if (control.type === "select") inputs[control.id] = control.options.find((option) => String(option) === String(value)) ?? control.default;
    if (control.type === "range") {
      const numeric = Number(value);
      inputs[control.id] = Math.max(control.min, Math.min(control.max, Number.isFinite(numeric) ? numeric : control.default));
    }
    if (control.type === "text") inputs[control.id] = String(value ?? control.default).slice(0, control.maxLength);
  }
  return { scenario, inputs };
}
