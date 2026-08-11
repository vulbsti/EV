import test from "node:test";
import assert from "node:assert/strict";
import { inspectAttention, redactCommandPreview, stripTerminalControls } from "../lib/attention.mjs";

test("detects permission and review prompts near the terminal tail", () => {
  assert.equal(inspectAttention("working\nDo you want to proceed? [y/N]").severity, "critical");
  assert.equal(inspectAttention("done\nReady for your review").severity, "action");
  assert.equal(inspectAttention("all tests passed").required, false);
});

test("strips terminal controls and redacts command secrets", () => {
  assert.equal(stripTerminalControls("\u001b[32mgreen\u001b[0m"), "green");
  assert.equal(redactCommandPreview("curl -H 'token=abc123'"), "curl -H 'token=[REDACTED]");
});
