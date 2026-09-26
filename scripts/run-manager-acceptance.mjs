#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const exec = promisify(execFile);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const conversationId = `manager-check-${stamp}`;
const root = resolve("data/manager-check", stamp);
const fixture = join(root, "unfamiliar-project");
await mkdir(fixture, { recursive: true });
await writeFile(join(fixture, "totals.py"), `import csv, io
def summarize(text):
    total = 0.0
    for row in csv.DictReader(io.StringIO(text)):
        total += float(row['price'])
    return f'{total:.2f}'
`);
await writeFile(join(fixture, "test_totals.py"), `import unittest
from totals import summarize
class TotalsTests(unittest.TestCase):
    def test_quantities(self):
        self.assertEqual(summarize('price,quantity\\n0.10,3\\n2.35,2\\n'), '5.00')
    def test_decimal_rounding(self):
        self.assertEqual(summarize('price,quantity\\n2.675,1\\n'), '2.68')
    def test_empty(self):
        self.assertEqual(summarize('price,quantity\\n'), '0.00')
if __name__ == '__main__': unittest.main()
`);
await writeFile(join(fixture, "README.md"), "A CSV reporting library. Prices multiply by quantities; sum in decimal arithmetic and round the final total to cents with ROUND_HALF_UP. Run python3 -m unittest -v.\n");
const dataPath = join(root, "sales.csv");
await writeFile(dataPath, 'product,price,quantity\nWidget,0.10,3\nGadget,2.35,2\n"Widget, large",12.00,4\n');
const requests = [
  { name: "local", text: `Inspect the unfamiliar Python project at ${fixture}. Fix its CSV total calculation to match the README and get its existing tests passing. Save a brief repair-summary.md in your task workspace explaining the fix and the test result. Only modify this fixture project and your task workspace.` },
  { name: "parallel", text: `Use two parallel workers to compare Python and Node for this small CSV reporting job. Give each worker the same input file ${dataPath}. Each worker should implement its own program in its own workspace that correctly parses this CSV, multiplies price by quantity, and reports the grand total. Run both programs and combine the verified results into comparison.md in the parent task workspace. Include copies of both working programs as deliverables. This is a functional comparison, not a rigorous performance benchmark.` },
  { name: "web", text: "Find @tibo's latest three original posts on x.com. Summarize each with its date and direct post URL, distinguishing pinned posts from newer posts. Inspect current public sources, and disclose access limits rather than guessing." }
];
for (const item of requests) {
  const response = await fetch("http://127.0.0.1:4317/api/assistant/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, clientMessageId: `${conversationId}-${item.name}`, text: item.text }) });
  if (!response.ok) throw new Error(`Submission failed: ${response.status}`);
  item.taskId = (await response.json()).task.taskId;
  console.log(`${item.name}: ${item.taskId}`);
}
console.log(`URL: http://127.0.0.1:4317/?conversation=${conversationId}`);
await writeFile(join(root, "requests.json"), JSON.stringify({ conversationId, requests }, null, 2));
const last = new Map();
let injected = null;
for (let i = 0; i < 240; i++) {
  const snapshot = await (await fetch(`http://127.0.0.1:4317/api/assistant/tasks?conversationId=${conversationId}`)).json();
  const parents = requests.map((item) => snapshot.tasks.find((task) => task.taskId === item.taskId));
  for (const task of snapshot.tasks) {
    const state = `${task.status}/${task.progress?.phase ?? ""}`;
    if (last.get(task.taskId) !== state) { last.set(task.taskId, state); console.log(`${task.taskId}: ${state}${task.result?.report ? ` (${task.result.report.outcome})` : ""}`); }
  }
  if (process.argv.includes("--interrupt-child") && !injected) {
    const parent = parents[1];
    const child = snapshot.tasks.find((task) => task.parentTaskId === parent?.taskId && task.taskId.endsWith("-child-2") && task.status === "running");
    if (child && parent.plan?.subtasks[1]?.retrySafe && Date.now() - Date.parse(child.run.startedAt) > 5_000) {
      const pid = Number(child.progress?.workerPid);
      if (pid > 0) { process.kill(-pid, "SIGTERM"); injected = child.taskId; console.log(`Interrupted acceptance child ${child.taskId} to exercise retry.`); }
    }
  }
  await writeFile(join(root, "receipt.json"), JSON.stringify({ at: new Date().toISOString(), conversationId, faultInjected: injected, tasks: snapshot.tasks }, null, 2));
  if (parents.every((task) => task && ["completed", "failed", "cancelled"].includes(task.status))) {
    const result = await exec("python3", ["-m", "unittest", "-v"], { cwd: fixture }).then(({ stdout, stderr }) => ({ passed: true, output: stdout + stderr })).catch((error) => ({ passed: false, output: error.stdout + error.stderr }));
    await writeFile(join(root, "local-verification.json"), JSON.stringify(result, null, 2));
    const checks = [];
    for (const task of parents) {
      for (const file of task.artifacts) {
        const response = await fetch(`http://127.0.0.1:4317/api/assistant/artifacts/${file.artifactId}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        checks.push({ artifact: file.relativePath, downloadHashMatches: response.ok && createHash("sha256").update(bytes).digest("hex") === file.sha256 });
        if (task.taskId === parents[1].taskId && /\.(py|mjs|js)$/.test(file.relativePath)) {
          const program = resolve("data/assistant-worker/artifacts", file.relativePath);
          const runner = file.relativePath.endsWith(".py") ? "python3" : "node";
          const run = await exec(runner, [program, dataPath], { timeout: 10_000 }).then(({ stdout }) => ({ output: stdout.trim(), passed: /53\.00/.test(stdout) })).catch(() => ({ passed: false }));
          checks.push({ program, ...run });
        }
      }
    }
    await writeFile(join(root, "objective-verification.json"), JSON.stringify(checks, null, 2));
    for (let index = 0; index < parents.length; index++) console.log(`${requests[index].name}: ${parents[index].result?.report?.outcome ?? parents[index].status}; files=${parents[index].artifacts.length}`);
    console.log(`Local fixture tests: ${result.passed ? "PASS" : "FAIL"}`);
    console.log(`Receipt: ${join(root, "receipt.json")}`);
    process.exitCode = parents.some((task) => task.status !== "completed" || task.result?.report?.outcome !== "completed") || !result.passed || checks.some((check) => check.passed === false || check.downloadHashMatches === false) || (process.argv.includes("--interrupt-child") && !injected) ? 1 : 0;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  if (i === 239) throw new Error("Acceptance tasks did not finish within 20 minutes");
}
