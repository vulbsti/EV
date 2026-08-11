import test from "node:test";
import assert from "node:assert/strict";
import { percentile, summarizeNumbers, wordErrorRate } from "../lib/stats.mjs";

test("latency summaries are stable", () => {
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.deepEqual(summarizeNumbers([1, 2, 3, 100]), { count: 4, min: 1, median: 2, p95: 100, max: 100 });
});

test("word error rate normalizes case and punctuation", () => {
  assert.equal(wordErrorRate("Hello, EV!", "hello ev"), 0);
  assert.equal(wordErrorRate("one two three", "one three"), 1 / 3);
});
