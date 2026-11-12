import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crashMidRevision, on, passOn, work } from "../lib/scripts.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export default {
  task: 7,
  name: "Work that can be picked up again, watched and really checked",
  goal: "Most of what people say after a result is a follow-up, and \"stop\" often means \"not now\" or \"not like that\". So work that has finished or been stopped keeps what it knows and made, and EV can send the person back into it. A run is watched for progress, not for the time on a clock, and a run that dies is resumed instead of failing the task. The reviewer opens and tries the real output before the person ever sees it, and can reach nothing outside the task it is reviewing.",
  live: [
    "`L6-04` \"Make it shorter\" after a delivered document changes that document; there is still one task and one file."
  ],
  checks: [
    {
      id: "R-01",
      expect: "EV can send a follow-up into work that has finished: the same agent picks it up, with what it knows and its files, instead of a new task starting from nothing.",
      async run({ start, assert }) {
        const ev = await start({ script: {
          ev: on([/rhyme/, passOn("Tide poem", "I've asked for that change.")], [/.*/, work("Tide poem")]),
          worker: (job) => job.run === 1
            ? job.done("The poem is in poem.md.", { files: { "poem.md": "The tide comes in.\n" }, deliverables: [{ path: "poem.md", title: "Poem" }] })
            : job.done("Now it rhymes.", { files: { "poem.md": "The tide comes in, the day grows thin.\n" }, deliverables: [{ path: "poem.md", title: "Poem" }] })
        } });
        const { taskId } = await ev.say("write a poem about tides");
        await ev.settled();
        await ev.say("make it rhyme");
        await ev.until("an agent to receive the follow-up", () => ev.standIn.jobs().length >= 2, { timeout: 8_000 });
        const tasks = await ev.settled();
        const roots = tasks.filter((task) => !task.parentTaskId);
        const second = ev.standIn.jobs().at(-1);
        assert.equal(roots.length, 1, "The follow-up started a second task instead of continuing the finished one");
        assert.equal(second.taskId, taskId, "The follow-up went to a different agent session");
        assert.ok(second.files.includes("poem.md"), "The agent picking up the follow-up did not find the file from the first round");
        assert.match(second.prompt, /make it rhyme/, "The follow-up did not reach the agent in the person's words");
        assert.equal(roots[0].result?.report?.answer, "Now it rhymes.", "The task still shows the result from before the follow-up");
      }
    },
    {
      id: "R-07",
      expect: "Stopping work does not destroy it. When the person comes back to it, even with a change, the same agent continues from where it stood.",
      async run({ start, assert, gate }) {
        const hold = gate();
        const ev = await start({ script: {
          ev: on(
            [/^stop/i, async (turn) => { await turn.messageTask({ task: "Quarterly report", stop: true }); return turn.reply("Stopped. What is written so far is kept."); }],
            [/carry on/i, passOn("Quarterly report", "Picking the report back up, third quarter only.")],
            [/.*/, work("Quarterly report")]
          ),
          worker: async (job) => {
            if (job.run === 1) { writeFileSync(join(job.cwd, "report-draft.md"), "First and second quarter written.\n"); await hold.wait(); return job.done("Report."); }
            return job.done("Report, third quarter only.");
          }
        } });
        const { taskId } = await ev.say("write the quarterly report");
        await hold.reached;
        await ev.say("stop for now, I need to check the numbers first");
        await ev.until("the work to stop", async () => !["queued", "running", "verifying"].includes((await ev.task(taskId)).status));
        hold.open();
        await ev.say("ok carry on with the report, but only the third quarter");
        await ev.until("an agent to pick the report back up", () => ev.standIn.jobs().some((job) => /third quarter/.test(job.prompt)), { timeout: 8_000 });
        const resumed = ev.standIn.jobs().find((job) => /third quarter/.test(job.prompt));
        assert.equal((await ev.work()).length, 1, "Coming back to stopped work started a second task from nothing, so what had been done was lost");
        assert.equal(resumed.taskId, taskId, "The work was picked up by a different agent session, without what the first one knew");
        assert.ok(resumed.files.includes("report-draft.md"), "The agent picking the work back up did not have what had been written before the stop");
        const [task] = await ev.settled();
        assert.equal(task.result?.report?.answer, "Report, third quarter only.", "The work that was picked back up did not deliver");
      }
    },
    {
      id: "R-02",
      expect: "An agent that keeps making progress is left to finish, however long it takes.",
      async run({ start, assert }) {
        const ev = await start({ env: { EV_WORKER_STALL_MS: "1500" }, script: {
          ev: work("Slow but steady"),
          worker: (job) => ({ ...job.done("Finished after steady progress."), steps: Array.from({ length: 8 }, (_, index) => ({ waitMs: 500, progress: `step ${index + 1} of 8` })) })
        } });
        const { taskId } = await ev.say("do the long migration");
        const [task] = await ev.settled("main", { timeout: 20_000 });
        assert.equal(task.status, "completed", `A progressing agent's task ended as ${task.status}: ${task.error?.message ?? ""}`);
        assert.equal(ev.standIn.jobs(taskId).length, 1, "An agent that was making progress was interrupted and started again");
      }
    },
    {
      id: "R-03",
      expect: "An agent that goes silent is noticed within the stall limit, and its task is resumed, not failed.",
      async run({ start, assert }) {
        const ev = await start({ env: { EV_WORKER_STALL_MS: "1500" }, script: {
          ev: work("Stuck job"),
          worker: (job) => job.run === 1 ? { ...job.done("Too late."), hangMs: 9_000 } : job.done("Finished after being resumed.")
        } });
        const { taskId } = await ev.say("run the import");
        const startedAt = Date.now();
        const resumed = await ev.until("the silent agent to be replaced", () => ev.standIn.jobs(taskId).length >= 2, { timeout: 7_000 }).catch(() => false);
        assert.ok(resumed, "An agent that reported nothing was left alone for more than 7 s although the stall limit was 1.5 s (EV_WORKER_STALL_MS)");
        const [task] = await ev.settled("main", { timeout: 15_000 });
        assert.equal(task.status, "completed", `After the stall the task ended as ${task.status} instead of being resumed to completion`);
        assert.equal(task.result?.report?.answer, "Finished after being resumed.", "The delivered result is not the resumed run's");
        assert.ok(Date.now() - startedAt < 9_000, "The task only finished once the silent agent ended on its own");
      }
    },
    {
      id: "R-04",
      expect: "After EV crashes, the agent it left behind is stopped before a new one takes over the same work.",
      async run(context) {
        const { assert } = context;
        const { ev, taskId, jobsBefore, agentPid } = await crashMidRevision({ ...context, agentSurvives: true });
        try {
          await ev.until("EV to restart the work after the crash", () => ev.standIn.jobs(taskId).length > jobsBefore || ev.task(taskId).then((task) => task.status === "completed"), { timeout: 10_000 });
          assert.ok(!alive(agentPid), "The agent from before the crash is still running next to the one that replaced it, in the same folder");
        } finally { try { process.kill(agentPid, "SIGKILL"); } catch {} }
      }
    },
    {
      id: "R-05",
      expect: "The reviewer can see all of the delivered file, not just what the agent says about it.",
      async run({ start, assert }) {
        const marker = "closing line CURLEW-6017";
        let saw = false;
        const ev = await start({ script: {
          ev: work("Annual report"),
          worker: (job) => job.done("The report is in report.md.", { files: { "report.md": `# Annual report\n\n${"A paragraph of findings. ".repeat(1_200)}\n\n${marker}\n` }, deliverables: [{ path: "report.md", title: "Annual report" }] }),
          reviewer: async (turn) => {
            saw = turn.text.includes(marker);
            if (!saw && turn.tools.length) saw = (await turn.readFile("report.md")).text.includes(marker);
            return turn.accept();
          }
        } });
        await ev.say("write the annual report");
        await ev.settled();
        assert.ok(saw, "The reviewer accepted a 30 KB file without being able to see its end; it judged the agent's description, not the file");
      }
    },
    {
      id: "R-06",
      expect: "The reviewer is never shown a file outside the task it is reviewing, even when the agent's report points at one.",
      async run({ start, assert, fixture }) {
        const outside = fixture("not-for-agents.txt");
        let leaked = false;
        const ev = await start({ script: {
          ev: work("Quick note"),
          worker: (job) => job.done("See the attached evidence.", { evidence: [{ url: `file://${outside}`, title: "Evidence", supports: "The claim" }] }),
          reviewer: async (turn) => {
            leaked ||= turn.text.includes("WREN-0156");
            if (turn.tools.length) leaked ||= (await turn.readFile(outside)).text.includes("WREN-0156");
            return turn.accept();
          }
        } });
        await ev.say("write a quick note");
        await ev.settled();
        assert.ok(!leaked, "A file outside the task folder was read on the agent's say-so and shown to the reviewer");
      }
    }
  ]
};
