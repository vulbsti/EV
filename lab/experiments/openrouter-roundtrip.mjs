import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { synthesize, transcribe } from "../lib/providers/openrouter.mjs";
import { wordErrorRate } from "../lib/stats.mjs";

export const experiment = {
  id: "openrouter-roundtrip",
  group: "voice",
  description: "Runs text through OpenRouter TTS and back through STT to measure the chained transport independently of orchestration.",
  async run(context) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const ttsModel = process.env.OPENROUTER_TTS_MODEL || context.config.openrouter?.ttsModel;
    const sttModel = process.env.OPENROUTER_STT_MODEL || context.config.openrouter?.sttModel;
    if (context.mode !== "live") return { status: "skipped", skipReason: "Live mode is required.", metrics: {} };
    if (!apiKey) return { status: "skipped", skipReason: "OPENROUTER_API_KEY is not set.", metrics: {} };
    if (!ttsModel || !sttModel) return { status: "skipped", skipReason: "Set explicit OPENROUTER_TTS_MODEL and OPENROUTER_STT_MODEL values.", metrics: {} };
    const reference = context.config.openrouter?.transcript ?? "EV voice transport round trip.";
    const tts = await synthesize({ apiKey, model: ttsModel, voice: context.config.openrouter?.ttsVoice ?? "alloy", text: reference, timeoutMs: context.config.requestTimeoutMs });
    const audioPath = join(context.runDir, "openrouter-roundtrip.mp3");
    await writeFile(audioPath, tts.audio, { mode: 0o600 });
    const stt = await transcribe({ apiKey, model: sttModel, audioPath, format: "mp3", timeoutMs: context.config.requestTimeoutMs });
    const transcript = stt.body.text ?? stt.body.transcript ?? "";
    return {
      status: transcript ? "passed" : "failed",
      provider: "openrouter",
      model: `${ttsModel} -> ${sttModel}`,
      metrics: {
        ttsFirstByteMs: tts.firstByteMs,
        ttsTotalLatencyMs: tts.totalLatencyMs,
        sttLatencyMs: stt.latencyMs,
        endToEndLatencyMs: tts.totalLatencyMs + stt.latencyMs,
        audioBytes: tts.audio.length,
        wordErrorRate: transcript ? wordErrorRate(reference, transcript) : 1
      },
      observations: { reference, transcript, sttUsage: stt.body.usage ?? null },
      artifacts: [audioPath]
    };
  }
};
