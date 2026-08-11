export const experiment = {
  id: "cost-model",
  group: "economics",
  description: "Produces transparent, scenario-based xAI voice cost estimates; unknown tokenized providers remain unestimated.",
  async run() {
    const scenarios = [5, 30, 60].map((minutes) => ({
      minutes,
      xaiThinkFast1Usd: minutes * 0.05,
      xaiThinkFast2Usd: minutes * 0.08,
      xaiSttRestUsd: minutes * (0.10 / 60),
      xaiSttStreamingUsd: minutes * (0.20 / 60)
    }));
    return {
      status: "passed",
      metrics: { scenarios: scenarios.length, pricingSnapshotDate: "2026-08-11" },
      observations: {
        scenarios,
        caveats: [
          "Speech-to-speech text-input charges and TTS character charges are not included in the simple minute estimates.",
          "OpenRouter cost must be computed from the selected model metadata and actual usage.",
          "GPT Realtime audio token pricing cannot honestly be converted to cost per minute until observed audio token rates are collected."
        ]
      },
      gates: { noInventedCrossProviderMinuteEstimate: true }
    };
  }
};
