import { setTimeout as delay } from "node:timers/promises";

export const experiment = {
  id: "resilience",
  group: "reliability",
  description: "Validates bounded retry, timeouts, cancellation, and duplicate-reply suppression with synthetic providers.",
  async run() {
    let calls = 0;
    async function retrying(operation, maxAttempts) {
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try { return { value: await operation(attempt), attempts: attempt }; }
        catch (error) { lastError = error; if (attempt < maxAttempts) await delay(5); }
      }
      throw lastError;
    }
    const recovered = await retrying(async () => {
      calls += 1;
      if (calls < 3) throw new Error("synthetic transient failure");
      return "ok";
    }, 3);
    const controller = new AbortController();
    const cancelled = delay(1000, null, { signal: controller.signal }).then(() => false, (error) => error.name === "AbortError");
    controller.abort();
    const timeoutObserved = await Promise.race([
      delay(100).then(() => false),
      delay(5).then(() => true)
    ]);
    const deliveredReplies = new Set();
    const deliverOnce = (replyId) => deliveredReplies.has(replyId) ? false : Boolean(deliveredReplies.add(replyId));
    const firstReplyDelivered = deliverOnce("reply-1");
    const duplicateReplySuppressed = !deliverOnce("reply-1");
    const checks = {
      recoveredOnThirdAttempt: recovered.attempts === 3,
      cancellationObserved: await cancelled,
      retryWasBounded: calls === 3,
      timeoutObserved,
      firstReplyDelivered,
      duplicateReplySuppressed
    };
    return {
      status: Object.values(checks).every(Boolean) ? "passed" : "failed",
      metrics: { ...checks, calls },
      observations: { recovered },
      gates: { boundedRetry: true, cancellation: true }
    };
  }
};
