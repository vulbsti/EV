export const PRESENTATION_LIMITS = Object.freeze({
  answerChars: 650,
  mechanismSteps: 6,
  scenarios: 5,
  limits: 3,
  followUps: 3,
  titleChars: 90,
  detailChars: 480,
  inputChars: 220,
  outputChars: 220,
  evidenceChars: 280,
  projectGoalChars: 320,
  projectImpactChars: 420
});

const EPISTEMIC_STATUS = new Set(["observed", "derived", "predicted", "inferred", "unknown"]);
const ALIGNMENT_STATUS = new Set(["aligned", "partial", "misaligned", "unknown"]);

function compact(value, limit, fallback, diagnostics, field) {
  const text = String(value ?? fallback ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  diagnostics.truncatedFields.push({ field, before: text.length, after: limit });
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function parseJsonObject(source) {
  const raw = String(source ?? "").trim();
  const fenced = /^```(?:json)?\s*/i.test(raw);
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return { value: JSON.parse(text), mode: fenced ? "fenced" : "direct" }; } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return { value: JSON.parse(text.slice(start, end + 1)), mode: "salvaged" }; } catch {}
  }
  return { value: null, mode: "failed" };
}

function safeId(value, fallback) {
  return String(value ?? fallback).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || fallback;
}

export function normalizePresentation(source, { evidence = {}, fallback = "", onTrace = null } = {}) {
  const diagnostics = {
    inputChars: String(source ?? "").length,
    parseMode: "failed",
    fallbackUsed: false,
    requestedSteps: 0,
    outputSteps: 0,
    requestedScenarios: 0,
    outputScenarios: 0,
    invalidPathReferences: 0,
    truncatedCollections: [],
    truncatedFields: []
  };
  const trace = (stage, status, detail, data = {}) => onTrace?.({ stage, status, detail, data });
  trace("receive", "observed", "Received untrusted compiler output.", { characters: diagnostics.inputChars });
  const parsedResult = parseJsonObject(source);
  diagnostics.parseMode = parsedResult.mode;
  diagnostics.fallbackUsed = !parsedResult.value;
  const parsed = parsedResult.value ?? {};
  trace("parse", parsedResult.value ? "observed" : "observed", parsedResult.value ? `Parsed ${parsedResult.mode} JSON.` : "Parsing failed; using the bounded fallback path.", { mode: parsedResult.mode });

  diagnostics.requestedSteps = Array.isArray(parsed.mechanism) ? parsed.mechanism.length : 0;
  if (diagnostics.requestedSteps > PRESENTATION_LIMITS.mechanismSteps) diagnostics.truncatedCollections.push({ field: "mechanism", before: diagnostics.requestedSteps, after: PRESENTATION_LIMITS.mechanismSteps });
  const rawSteps = (Array.isArray(parsed.mechanism) ? parsed.mechanism : []).slice(0, PRESENTATION_LIMITS.mechanismSteps);
  const usedIds = new Set();
  const idMap = new Map();
  const mechanism = rawSteps.map((step, index) => {
    const originalId = String(step?.id ?? `step-${index + 1}`);
    let id = safeId(originalId, `step-${index + 1}`);
    while (usedIds.has(id)) id = `${id.slice(0, 44)}-${index + 1}`;
    usedIds.add(id);
    idMap.set(originalId, id);
    return {
      id,
      title: compact(step?.title, PRESENTATION_LIMITS.titleChars, `Step ${index + 1}`, diagnostics, `mechanism.${id}.title`),
      detail: compact(step?.detail, PRESENTATION_LIMITS.detailChars, "No additional mechanism detail was returned.", diagnostics, `mechanism.${id}.detail`),
      input: compact(step?.input, PRESENTATION_LIMITS.inputChars, "Not identified", diagnostics, `mechanism.${id}.input`),
      output: compact(step?.output, PRESENTATION_LIMITS.outputChars, "Not identified", diagnostics, `mechanism.${id}.output`),
      evidence: compact(step?.evidence, PRESENTATION_LIMITS.evidenceChars, "No direct artifact identified", diagnostics, `mechanism.${id}.evidence`),
      status: EPISTEMIC_STATUS.has(step?.status) ? step.status : "unknown"
    };
  });
  const answer = compact(parsed.answer, PRESENTATION_LIMITS.answerChars, fallback, diagnostics, "answer");
  if (!mechanism.length) {
    mechanism.push({
      id: "answer",
      title: "Current answer",
      detail: answer,
      input: compact(evidence.target?.command, PRESENTATION_LIMITS.inputChars, "Observed work", diagnostics, "fallback.input"),
      output: "See the direct answer",
      evidence: `evidence ${evidence.revision ?? "unavailable"}`,
      status: "unknown"
    });
    usedIds.add("answer");
  }
  diagnostics.outputSteps = mechanism.length;
  trace("normalize", "derived", "Normalized step identifiers, fields, and epistemic status.", { requested: diagnostics.requestedSteps, output: diagnostics.outputSteps });

  diagnostics.requestedScenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios.length : 0;
  if (diagnostics.requestedScenarios > PRESENTATION_LIMITS.scenarios) diagnostics.truncatedCollections.push({ field: "scenarios", before: diagnostics.requestedScenarios, after: PRESENTATION_LIMITS.scenarios });
  const scenarios = (Array.isArray(parsed.scenarios) ? parsed.scenarios : []).slice(0, PRESENTATION_LIMITS.scenarios).map((scenario, index) => {
    const path = [];
    for (const reference of Array.isArray(scenario?.path) ? scenario.path : []) {
      const resolved = idMap.get(String(reference)) ?? (usedIds.has(String(reference)) ? String(reference) : null);
      if (resolved && !path.includes(resolved)) path.push(resolved);
      else if (!resolved) diagnostics.invalidPathReferences += 1;
    }
    return {
      id: safeId(scenario?.id, `scenario-${index + 1}`),
      label: compact(scenario?.label, 80, index ? `Edge ${index}` : "Normal path", diagnostics, `scenario.${index}.label`),
      trigger: compact(scenario?.trigger, 240, "Default conditions", diagnostics, `scenario.${index}.trigger`),
      path,
      outcome: compact(scenario?.outcome, 360, answer, diagnostics, `scenario.${index}.outcome`),
      status: EPISTEMIC_STATUS.has(scenario?.status) ? scenario.status : "unknown"
    };
  });
  if (!scenarios.length) scenarios.push({ id: "normal", label: "Normal path", trigger: "Default conditions", path: mechanism.map((step) => step.id), outcome: answer, status: "unknown" });
  diagnostics.outputScenarios = scenarios.length;
  trace("link", diagnostics.invalidPathReferences ? "derived" : "observed", "Validated scenario references against normalized mechanism nodes.", { invalidReferences: diagnostics.invalidPathReferences });

  const list = (value, limit, field, itemLimit) => {
    const input = Array.isArray(value) ? value : [];
    if (input.length > limit) diagnostics.truncatedCollections.push({ field, before: input.length, after: limit });
    return input.slice(0, limit).map((item, index) => compact(item, itemLimit, "", diagnostics, `${field}.${index}`)).filter(Boolean);
  };
  const presentation = {
    version: 2,
    project: {
      goal: compact(parsed.project?.goal, PRESENTATION_LIMITS.projectGoalChars, evidence.project?.summary, diagnostics, "project.goal"),
      alignment: ALIGNMENT_STATUS.has(parsed.project?.alignment) ? parsed.project.alignment : "unknown",
      impact: compact(parsed.project?.impact, PRESENTATION_LIMITS.projectImpactChars, "The available evidence does not establish goal impact yet.", diagnostics, "project.impact")
    },
    answer,
    mechanism,
    scenarios,
    limits: list(parsed.limits, PRESENTATION_LIMITS.limits, "limits", 280),
    followUps: list(parsed.followUps, PRESENTATION_LIMITS.followUps, "followUps", 220)
  };
  trace("bound", diagnostics.truncatedCollections.length || diagnostics.truncatedFields.length ? "derived" : "observed", "Enforced deterministic presentation limits.", { collections: diagnostics.truncatedCollections.length, fields: diagnostics.truncatedFields.length });
  trace("render", "derived", "Produced the bounded interactive presentation model.", { answerChars: presentation.answer.length, steps: mechanism.length, scenarios: scenarios.length });
  return { presentation, diagnostics };
}
