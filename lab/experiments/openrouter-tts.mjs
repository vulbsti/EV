import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { synthesize } from "../lib/providers/openrouter.mjs";

export const experiment = {
  id: "openrouter-tts",
  group: "voice",
  description: "Measures OpenRouter speech synthesis first-byte latency, total latency, output size, and media type.",
  async run(context) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_TTS_MODEL || context.config.openrouter?.ttsModel;
    if (context.mode !== "live") return { status: "skipped", skipReason: "Live mode is required.", metrics: {} };
    if (!apiKey) return { status: "skipped", skipReason: "OPENROUTER_API_KEY is not set.", metrics: {} };
    if (!model) return { status: "skipped", skipReason: "Set OPENROUTER_TTS_MODEL; the lab will not silently choose a billable model.", metrics: {} };
    const text = context.config.openrouter?.transcript ?? "EV voice transport test.";
    const result = await synthesize({ apiKey, model, voice: context.config.openrouter?.ttsVoice ?? "alloy", text, timeoutMs: context.config.requestTimeoutMs });
    const audioPath = join(context.runDir, "openrouter-tts.mp3");
    await writeFile(audioPath, result.audio, { mode: 0o600 });
    return {
      status: result.audio.length > 0 ? "passed" : "failed",
      provider: "openrouter",
      model,
      metrics: { firstByteMs: result.firstByteMs, totalLatencyMs: result.totalLatencyMs, audioBytes: result.audio.length, characters: text.length },
      observations: { contentType: result.contentType, generationId: result.generationId },
      artifacts: [audioPath]
    };
  }
};
