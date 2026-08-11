import { extname } from "node:path";
import { transcribe } from "../lib/providers/openrouter.mjs";
import { wordErrorRate } from "../lib/stats.mjs";

export const experiment = {
  id: "openrouter-stt",
  group: "voice",
  description: "Transcribes a labelled audio fixture and records latency, bytes, usage, and word error rate.",
  async run(context) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_STT_MODEL || context.config.openrouter?.sttModel;
    const audioPath = context.args.audio || process.env.EV_LAB_AUDIO;
    const reference = context.args.reference || process.env.EV_LAB_REFERENCE;
    if (context.mode !== "live") return { status: "skipped", skipReason: "Live mode is required.", metrics: {} };
    if (!apiKey) return { status: "skipped", skipReason: "OPENROUTER_API_KEY is not set.", metrics: {} };
    if (!audioPath) return { status: "skipped", skipReason: "Pass --audio and, for accuracy scoring, --reference.", metrics: {} };
    const format = extname(audioPath).slice(1).toLowerCase() || "wav";
    const result = await transcribe({ apiKey, model, audioPath, format, timeoutMs: context.config.requestTimeoutMs });
    const text = result.body.text ?? result.body.transcript ?? "";
    return {
      status: text ? "passed" : "failed",
      provider: "openrouter",
      model,
      metrics: { latencyMs: result.latencyMs, inputBytes: result.inputBytes, wordErrorRate: reference ? wordErrorRate(reference, text) : null },
      observations: { transcript: text, usage: result.body.usage ?? null, reference: reference ?? null }
    };
  }
};
