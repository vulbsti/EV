import { work } from "../lib/scripts.mjs";

const AUTH_STEPS = (ev, taskId) => ev.api(`/api/assistant/tasks/${encodeURIComponent(taskId)}/steps`);
const busy = (count, waitMs) => Array.from({ length: count }, (_, index) => ({ waitMs, call: { name: "exec", arguments: { command: `cat notes-${index + 1}.md` } } }));

export default {
  task: 12,
  name: "Live work",
  goal: "The person can watch an agent work, step by step, and come back to it later. Under that view are two guarantees that hold whatever EV or its agents decide: the steps reach a page that lost its connection with nothing missing and nothing twice, and work on hold shows nothing new from an agent it has stopped. Everything else about the live view (labels, the \"now\" line, the pane) was walked through once against its state chart (design/build/verification/live-work.md), not checked on every push.",
  live: [],
  checks: [
    {
      id: "L-01",
      expect: "A page that loses its connection while an agent works catches up on exactly the steps it missed: none lost, none twice.",
      timeout: 60_000,
      async run({ start, assert }) {
        const ev = await start({ script: { ev: work("Notes digest"), worker: (job) => ({ ...job.done("Digest."), steps: busy(10, 250) }) } });
        const first = await ev.stream();
        const { taskId } = await ev.say("digest my notes");
        const seen = await first.until("a few of the agent's steps", () => first.frames.flatMap((frame) => frame.data?.steps ?? []).length >= 3);
        first.close();
        await ev.settled();
        const resumed = await ev.stream({ after: first.frames.at(-1).id });
        try {
          await resumed.until("the catch-up", () => resumed.frames.length > 0);
          const { value } = await AUTH_STEPS(ev, taskId);
          const all = value.steps.map((step) => step.seq);
          const got = [...first.frames, ...resumed.frames].flatMap((frame) => frame.data?.steps ?? []).filter((step) => step.taskId === taskId).map((step) => step.seq);
          assert.ok(seen && all.length >= 10, `Only ${all.length} steps were kept for an agent that took 10`);
          assert.equal(new Set(got).size, got.length, "A step reached the page twice");
          assert.deepEqual([...got].sort((a, b) => a - b), all, "The page that reconnected is missing steps, or has steps the work does not");
        } finally { resumed.close(); }
      }
    },
    {
      id: "L-02",
      expect: "Once work is on hold, nothing more from its agent shows up in it, even while that agent is slow to stop.",
      timeout: 60_000,
      async run({ start, assert, sleep }) {
        const ev = await start({ script: { ev: work("Long digest"), worker: (job) => ({ ...job.done("Digest."), steps: busy(40, 150), ignoresStop: true }) } });
        const { taskId } = await ev.say("digest all my notes");
        await ev.until("the agent to be a few steps in", async () => (await AUTH_STEPS(ev, taskId)).value?.steps?.length >= 3);
        const task = await ev.task(taskId);
        const held = await ev.api(`/api/assistant/tasks/${encodeURIComponent(taskId)}/commands`, { commandId: `hold-${Date.now()}`, type: "hold", expectedRevision: task.revision });
        assert.ok(held.ok, `The hold was refused (${held.status})`);
        await sleep(2_500);
        const holdSeq = (await ev.task(taskId)).history.findLast((event) => event.type === "held").sequence;
        const { value } = await AUTH_STEPS(ev, taskId);
        const late = value.steps.filter((step) => step.seq > holdSeq);
        assert.equal(late.length, 0, `${late.length} step(s) from the stopped agent appeared after the hold`);
      }
    }
  ]
};
