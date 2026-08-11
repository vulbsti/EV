import { probeXaiRealtime } from "../lib/providers/xai-realtime.mjs";

export const experiment = {
  id: "xai-realtime",
  group: "voice",
  description: "Probes xAI ephemeral credentials, WebSocket compatibility, events, transcript, and returned audio.",
  async run(context) {
    const apiKey = process.env.XAI_API_KEY;
    if (context.mode !== "live") return { status: "skipped", skipReason: "Live mode is required.", metrics: {} };
    if (!apiKey) return { status: "skipped", skipReason: "XAI_API_KEY is not set.", metrics: {} };
    const model = process.env.XAI_VOICE_MODEL || context.config.xai?.model || "grok-voice-think-fast-2.0";
    const result = await probeXaiRealtime({
      apiKey,
      model,
      voice: context.config.xai?.voice ?? "Eve",
      prompt: context.config.xai?.prompt ?? "Confirm this voice transport works in one sentence.",
      timeoutMs: context.config.requestTimeoutMs
    });
    return {
      status: result.audioBytes > 0 ? "passed" : "failed",
      provider: "xai",
      model,
      metrics: { tokenLatencyMs: result.tokenLatencyMs, responseLatencyMs: result.connectAndResponseMs, firstAudioMs: result.firstAudioMs, audioBytes: result.audioBytes },
      observations: { transcript: result.transcript, eventTypes: result.eventTypes }
    };
  }
};
