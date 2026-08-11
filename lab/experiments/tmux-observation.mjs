import { setTimeout as delay } from "node:timers/promises";
import { inventoryTmux, captureMetadata } from "../lib/tmux.mjs";
import { summarizeNumbers } from "../lib/stats.mjs";

export const experiment = {
  id: "tmux-observation",
  group: "system",
  description: "Measures fleet discovery and pane-tail capture without storing terminal contents or sending input.",
  async run(context) {
    const samples = [];
    const count = context.config.tmuxSamples ?? 3;
    try {
      for (let index = 0; index < count; index += 1) {
        samples.push(await inventoryTmux());
        if (index < count - 1) await delay(100);
      }
    } catch (error) {
      if (/no server running|failed to connect/i.test(String(error?.stderr ?? error))) {
        return { status: "skipped", skipReason: "No tmux server is running.", metrics: {} };
      }
      throw error;
    }
    const firstIds = new Set(samples[0].panes.map((pane) => pane.paneId));
    const stableCounts = samples.map((sample) => sample.panes.filter((pane) => firstIds.has(pane.paneId)).length);
    const captures = await Promise.all(samples[0].panes.map((pane) => captureMetadata(pane.paneId, context.config.tmuxCaptureLines ?? 80)));
    const stability = firstIds.size ? Math.min(...stableCounts) / firstIds.size : 1;
    return {
      status: stability >= 0.99 ? "passed" : "failed",
      metrics: {
        sessionCount: new Set(samples[0].panes.map((pane) => pane.sessionId)).size,
        paneCount: samples[0].panes.length,
        discoveryLatencyMs: summarizeNumbers(samples.map((sample) => sample.durationMs)),
        captureLatencyMs: summarizeNumbers(captures.map((capture) => capture.durationMs)),
        paneIdStability: stability,
        capturedBytes: captures.reduce((sum, capture) => sum + capture.byteLength, 0),
        rawContentStored: false
      },
      observations: { panes: samples[0].panes, captureMetadata: captures },
      gates: { paneIdStabilityMinimum: 0.99, rawContentStored: false }
    };
  }
};
