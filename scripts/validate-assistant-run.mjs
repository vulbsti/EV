#!/usr/bin/env node
import { validateAssistantRunBundle } from "../apps/daemon/lib/assistant-run-bundle.mjs";

function usage() {
  console.error("Usage: node scripts/validate-assistant-run.mjs [--json] <artifacts/assistant-runs/YYYY-MM-DD/run-id>");
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const paths = args.filter((arg) => arg !== "--json");
if (paths.length !== 1 || paths[0] === "--help" || paths[0] === "-h") {
  usage();
  process.exitCode = paths.length === 1 ? 0 : 2;
} else {
  const result = await validateAssistantRunBundle(paths[0]);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.valid) {
    console.log(`Valid assistant run bundle: ${result.bundlePath}`);
  } else {
    console.error(`Invalid assistant run bundle: ${result.bundlePath}`);
    for (const item of result.issues) {
      const location = item.path ? ` (${item.path}${item.line ? `:${item.line}` : ""})` : "";
      console.error(`- ${item.code}: ${item.message}${location}`);
    }
  }
  process.exitCode = result.valid ? 0 : 1;
}
