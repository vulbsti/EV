import { reviewState } from "../lib/protocol.mjs";
import { crashMidRevision, on, remembersAndForgets, work } from "../lib/scripts.mjs";

export default {
  task: 3,
  name: "One store with real ids",
  goal: "Everything EV holds lives in one place and is linked: a message to the work it started, the work to its result, a memory to where it came from. Because of that, forgetting reaches every copy, a restart loses nothing, and a result can never be too large to keep.",
  live: [
    "`L8-01` After \"forget that\", EV cannot bring the detail back in any later conversation, however it is asked."
  ],
  checks: [
    {
      id: "S-01",
      expect: "After \"forget that\", the forgotten text is in no file EV keeps and no page it serves.",
      async run({ start, assert, sleep }) {
        const marker = "QUILLON-58";
        const ev = await start({ script: {
          ev: (turn) => turn.reply("Done."),
          learner: remembersAndForgets(marker, `Gym locker is ${marker}.`)
        } });
        await ev.say(`my gym locker is ${marker}`);
        await ev.learned();
        assert.ok(JSON.stringify(await ev.memory()).includes(marker), "The stated fact never reached memory, so there is nothing to forget");
        await ev.say("forget my gym locker");
        await ev.learned();
        await sleep(500);
        const files = ev.filesContaining(marker);
        assert.deepEqual(files, [], `The forgotten text is still on disk in: ${files.join(", ")}`);
        assert.ok(!JSON.stringify(await ev.conversation()).includes(marker), "The conversation page still shows the forgotten text");
      }
    },
    {
      id: "S-02",
      expect: "A restart in the middle of a review loop keeps the loop: the reviewer still knows which round it is and what it asked for.",
      async run(context) {
        const { assert } = context;
        const { ev, reviews } = await crashMidRevision(context);
        const [task] = await ev.settled("main", { timeout: 20_000 });
        assert.equal(task.status, "completed", `After the restart the task ended as ${task.status}: ${task.error?.message ?? ""}`);
        const after = reviewState(reviews.at(-1));
        assert.ok(after.round >= 2, `After the restart the reviewer was told this is round ${after.round}; it was already in round 2 before`);
        assert.match(after.earlier, /pricing table is missing/, "After the restart the reviewer was no longer shown what it had asked for in the earlier round");
      }
    },
    {
      id: "S-03",
      expect: "Tokens spent before a restart still count, so the budget is a real limit.",
      async run(context) {
        const { assert } = context;
        // Each agent run spends 6,000 of a 10,000 budget: the second run is the last one the budget allows.
        const { ev, taskId, jobsBefore } = await crashMidRevision({ ...context, env: { EV_AGENT_TOKEN_BUDGET: "10000" }, usage: { input: 6_000, output: 0 }, acceptAfter: 99 });
        await ev.settled("main", { timeout: 20_000 });
        const after = ev.standIn.jobs(taskId).length - jobsBefore;
        assert.equal(after, 1, `After the restart the agent was run ${after} times; the budget had room for one more run, so the earlier spend was forgotten`);
      }
    },
    {
      id: "S-04",
      expect: "A long review loop with detailed feedback still ends in a delivered result; accepted work is never lost for being large.",
      async run({ start, assert }) {
        const long = (label) => `${label}: ${"detail ".repeat(95)}`.slice(0, 690);
        let round = 0;
        const ev = await start({ script: {
          ev: work("Market study"),
          worker: (job) => job.done(`Study, attempt ${job.run}. ${"finding ".repeat(1_200)}`),
          reviewer: (turn) => ++round <= 5
            ? turn.revise({ missing: Array.from({ length: 8 }, (_, index) => long(`Missing ${round}.${index}`)), feedback: Array.from({ length: 8 }, (_, index) => long(`Change ${round}.${index}`)), summary: long("Summary").slice(0, 390) })
            : turn.accept({ handoff: "The market study is ready." })
        } });
        await ev.say("do the market study");
        const [task] = await ev.settled("main", { timeout: 30_000 });
        assert.equal(task.status, "completed", `The reviewer accepted the result in round ${round}, but the task ended as ${task.status}: ${task.error?.code ?? ""} ${task.error?.message ?? ""}`);
      }
    },
    {
      id: "S-05",
      expect: "EV's \"done\" message is tied to the work it is about, so the page can show the result under it.",
      async run({ start, assert }) {
        const ev = await start({ script: { ev: work("Tide poem"), worker: (job) => job.done("The poem.") } });
        const { taskId } = await ev.say("write a poem about tides");
        await ev.settled();
        const done = await ev.until("EV to say the work is done", async () => (await ev.fromEV()).find((message) => /Tide poem/.test(message.content)));
        assert.equal(done.taskId, taskId, `The "done" message carries task id ${done.taskId}; it should point at ${taskId}`);
      }
    },
    {
      id: "S-06",
      expect: "Each task's agent has its own home: one task cannot read what another task's agent left behind.",
      async run({ start, assert }) {
        const ev = await start({ script: {
          ev: on([/first/, work("First errand")], [/second/, work("Second errand")]),
          worker: (job) => job.done("Done.", /first/i.test(job.prompt) ? { files: { "~/.openclaw/notes/from-the-first-task.txt": "private to the first task" } } : {})
        } });
        await ev.say("run the first errand");
        await ev.settled();
        await ev.say("run the second errand");
        await ev.settled();
        const second = ev.standIn.jobs().at(-1);
        assert.ok(!second.homeFiles.some((file) => file.includes("from-the-first-task")), "The second task's agent could see a file the first task's agent left in its home");
      }
    }
  ]
};
