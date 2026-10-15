// The simulated user and the judges are model calls separate from EV, made
// through EV's own client. EV_QA_MODEL / EV_QA_MODEL_API pick a different model
// for them (recommended, so EV is not graded by its own blind spots); they
// default to EV_MODEL / EV_MODEL_API.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { callModel, parseModelJson } from "../../apps/daemon/lib/ev-model.mjs";

// The runners read EV's .env too, so one key setup serves EV and the QA models.
function dotEnvKey(name) {
  try {
    const line = readFileSync(join(import.meta.dirname, "../../.env"), "utf8").split("\n").find((entry) => entry.trim().startsWith(`${name}=`));
    return line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
}

export function qaModelEnv(env = process.env) {
  return {
    EV_MODEL: env.EV_QA_MODEL || env.EV_MODEL || dotEnvKey("EV_QA_MODEL") || dotEnvKey("EV_MODEL") || "",
    EV_MODEL_API: env.EV_QA_MODEL_API || env.EV_MODEL_API || dotEnvKey("EV_QA_MODEL_API") || dotEnvKey("EV_MODEL_API") || ""
  };
}

export async function askModelJson(input, { maxOutputTokens = 3_000, timeoutMs = 120_000, label = "qa" } = {}) {
  const apiKey = process.env.EV_QA_API_KEY ?? process.env.OPENCODE_API ?? dotEnvKey("OPENCODE_API");
  if (!apiKey) throw new Error("Set OPENCODE_API (or EV_QA_API_KEY) for the simulated user and judges");
  return callModel({
    input, apiKey, label, code: "QA_MODEL_UNAVAILABLE", maxOutputTokens, timeoutMs,
    session: `qa-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    env: qaModelEnv(),
    // EV_QA_MODEL_URL redirects the calls (e.g. to a local stand-in for smoke tests).
    ...(process.env.EV_QA_MODEL_URL ? { fetchImpl: (url, init) => fetch(String(url).replace("https://opencode.ai/zen/go/v1", process.env.EV_QA_MODEL_URL.replace(/\/$/, "")), init) } : {}),
    parse: (text) => parseModelJson(text, `QA model returned unreadable JSON: ${String(text).slice(0, 200)}`)
  });
}
