import { discoverModels } from "../lib/providers/openrouter.mjs";

export const experiment = {
  id: "openrouter-discovery",
  group: "voice",
  description: "Discovers current STT and TTS-capable OpenRouter models instead of trusting hard-coded names.",
  async run(context) {
    if (context.mode === "mock") return { status: "skipped", skipReason: "Network/provider discovery disabled in mock mode.", metrics: {} };
    const [stt, tts] = await Promise.all([
      discoverModels({ outputModalities: "transcription", timeoutMs: context.config.requestTimeoutMs }),
      discoverModels({ outputModalities: "speech", timeoutMs: context.config.requestTimeoutMs })
    ]);
    const project = (model) => ({ id: model.id, name: model.name, pricing: model.pricing, architecture: model.architecture });
    return {
      status: stt.models.length && tts.models.length ? "passed" : "failed",
      metrics: { sttModelCount: stt.models.length, ttsModelCount: tts.models.length, sttLatencyMs: stt.latencyMs, ttsLatencyMs: tts.latencyMs },
      observations: { sttModels: stt.models.map(project), ttsModels: tts.models.map(project) },
      gates: { atLeastOneSttModel: true, atLeastOneTtsModel: true }
    };
  }
};
