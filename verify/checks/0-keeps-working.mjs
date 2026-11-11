import { memoryShown } from "../lib/protocol.mjs";
import { on, passOn, remembersAndForgets, said, work } from "../lib/scripts.mjs";

export default {
  task: null,
  name: "What already works and must keep working",
  goal: "EV already tells talk from work, runs an agent, reviews the result until it is right, asks when only the person can answer, and stops when told. None of that may break while the insides are rebuilt.",
  checks: [
    {
      id: "K-01",
      expect: "Small talk gets an answer and starts no work.",
      async run({ start, assert }) {
        const ev = await start({ script: { ev: (turn) => turn.reply("Morning. What are we doing today?") } });
        const turn = await ev.say("good morning");
        assert.equal(turn.reply, "Morning. What are we doing today?", "EV's answer did not reach the person as written");
        assert.equal((await ev.tasks()).length, 0, "A greeting started a task");
        assert.equal(ev.standIn.jobs().length, 0, "A greeting started an agent");
      }
    },
    {
      id: "K-02",
      expect: "A request becomes one task, and its result and file reach the conversation.",
      async run({ start, assert }) {
        const ev = await start({ script: {
          ev: work("Tide poem"),
          worker: (job) => job.done("The poem is in poem.md.", { files: { "poem.md": "The tide comes in.\n" }, deliverables: [{ path: "poem.md", title: "Poem" }] })
        } });
        const turn = await ev.say("write me a short poem about tides");
        assert.ok(turn.taskId, "The request did not start a task");
        const [task] = await ev.settled();
        assert.equal(task.status, "completed", `The task ended as ${task.status}: ${task.error?.message ?? ""}`);
        assert.equal((await ev.work()).length, 1, "One request produced more than one task");
        assert.equal(task.artifacts?.length, 1, "The file the agent delivered is not attached to the task");
        const file = await fetch(`${ev.baseUrl}/api/assistant/artifacts/${encodeURIComponent(task.artifacts[0].artifactId)}`, { headers: { Authorization: "Bearer verify-token" } });
        assert.equal(await file.text(), "The tide comes in.\n", "The delivered file does not download with the agent's contents");
        await ev.until("EV to say the work is done", async () => (await said(ev)).some((text) => /Tide poem/.test(text) && /done/i.test(text)));
      }
    },
    {
      id: "K-03",
      expect: "Work the reviewer sends back returns to the same agent with the feedback, and the person hears only about the accepted version.",
      async run({ start, assert }) {
        let round = 0;
        const ev = await start({ script: {
          ev: work("Pricing summary"),
          worker: (job) => job.done(job.kind === "revision" ? "Summary with the pricing table." : "Summary, no table yet."),
          reviewer: (turn) => ++round === 1 ? turn.revise({ missing: ["The pricing table is missing."], feedback: ["Add the pricing table."] }) : turn.accept({ handoff: "The summary with its pricing table is ready." })
        } });
        const { taskId } = await ev.say("summarise the pricing of our three plans");
        const [task] = await ev.settled();
        const jobs = ev.standIn.jobs(taskId);
        assert.equal(jobs.length, 2, `The agent ran ${jobs.length} time(s); expected a first attempt and one revision`);
        assert.equal(jobs[1].kind, "revision", "The second run was not a revision of the first");
        assert.match(jobs[1].prompt, /Add the pricing table/, "The reviewer's feedback did not reach the agent");
        assert.equal(task.result?.report?.answer, "Summary with the pricing table.", "The delivered result is not the accepted version");
        const done = (await ev.fromEV()).filter((message) => /Pricing summary/.test(message.content));
        assert.equal(done.length, 1, `The person got ${done.length} messages about this work; expected exactly one, after acceptance`);
        assert.match(done[0].content, /pricing table is ready/, "The message does not describe the accepted result");
      }
    },
    {
      id: "K-04",
      expect: "A question only the person can answer reaches them, and their answer continues the same work.",
      async run({ start, assert }) {
        const ev = await start({ script: {
          ev: on([/^the blue one/i, passOn("Order the cover")], [/.*/, work("Order the cover")]),
          worker: (job) => job.kind === "continuation" ? job.done("Ordered the blue cover.") : job.needsInput("Which colour should the cover be?"),
          answer: () => null
        } });
        const { taskId } = await ev.say("sort out a cover for the report");
        await ev.until("the agent's question to reach the person", async () => (await said(ev)).some((text) => /Which colour should the cover be/.test(text)));
        assert.equal((await ev.task(taskId)).status, "waiting", "The task is not waiting for the person");
        await ev.say("the blue one");
        const tasks = await ev.until("the task to finish", async () => { const all = await ev.work(); return all.every((task) => task.status === "completed") ? all : null; });
        assert.equal(tasks.length, 1, "The answer started a second task");
        const jobs = ev.standIn.jobs(taskId);
        assert.match(jobs.at(-1).prompt, /the blue one/i, "The person's answer did not reach the agent");
      }
    },
    {
      id: "K-05",
      expect: "\"Stop\" stops running work, and nothing is delivered for it.",
      async run({ start, assert, gate }) {
        const hold = gate();
        const ev = await start({ script: {
          ev: on([/stop/i, async (turn) => { await turn.messageTask({ task: "Long report", stop: true }); return turn.reply("Stopped."); }], [/.*/, work("Long report")]),
          worker: async (job) => { await hold.wait(); return job.done("Report."); }
        } });
        const { taskId } = await ev.say("write the long quarterly report");
        await hold.reached;
        await ev.say("stop that");
        const task = await ev.until("the task to be cancelled", async () => { const found = await ev.task(taskId); return found.status === "cancelled" ? found : null; });
        hold.open();
        assert.equal(task.result, null, "A cancelled task carries a result");
        assert.ok(!(await ev.fromEV()).some((message) => /is done/.test(message.content)), "EV announced a result for work the person stopped");
      }
    },
    {
      id: "K-06",
      expect: "When the model cannot be reached, nothing starts, EV says so once, and the message is not lost.",
      async run({ start, assert }) {
        const ev = await start({ script: { ev: work("Anything") } });
        ev.standIn.outage("ev", 503);
        const first = await ev.say("book the venue for friday", { id: "venue-1" });
        assert.equal((await ev.tasks()).length, 0, "Work started although EV could not think about the message");
        assert.match(first.reply ?? "", /model|think/i, "EV did not tell the person what went wrong");
        const calls = ev.standIn.calls("ev").length;
        await ev.say("book the venue for friday", { id: "venue-1" });
        assert.equal(ev.standIn.calls("ev").length, calls, "Sending the same message again called the model again");
        assert.ok((await ev.conversation()).some((message) => message.role === "user" && /book the venue/.test(message.content)), "The person's message is not in the conversation");
      }
    },
    {
      id: "K-07",
      expect: "Something the person states about themselves is known to EV on their next message.",
      async run({ start, assert }) {
        const ev = await start({ script: {
          ev: (turn) => turn.reply("Noted."),
          learner: (turn) => [turn.stated("vegetarian", "fact", "Is vegetarian.")]
        } });
        await ev.say("by the way, I'm vegetarian");
        await ev.say("any dinner ideas?");
        assert.match(ev.standIn.calls("ev").at(-1).text, /Is vegetarian/, "EV1 was not shown what the person said one message earlier");
      }
    },
    {
      id: "K-08",
      expect: "After \"forget that\", the memory is gone from what EV knows and from the memory page.",
      async run({ start, assert }) {
        const ev = await start({ script: {
          ev: (turn) => turn.reply("Done."),
          learner: remembersAndForgets("MARLOWE-17", "Gym locker is MARLOWE-17.")
        } });
        await ev.say("my gym locker is MARLOWE-17");
        await ev.learned();
        assert.ok(JSON.stringify(await ev.memory()).includes("MARLOWE-17"), "The stated fact never reached memory, so there is nothing to forget");
        await ev.say("forget my gym locker");
        await ev.learned();
        assert.ok(!JSON.stringify(await ev.memory()).includes("MARLOWE-17"), "The memory page still shows what the person asked EV to forget");
        await ev.say("what do you know about my gym?");
        assert.ok(!memoryShown(ev.standIn.calls("ev").at(-1).text).includes("MARLOWE-17"), "EV1's memory of the person still contains the forgotten detail");
      }
    },
    {
      id: "K-09",
      expect: "A page on another website cannot talk to EV.",
      async run({ start, assert }) {
        const ev = await start();
        const response = await fetch(`${ev.baseUrl}/api/assistant/memory`, { headers: { Origin: "https://example.com", Authorization: "Bearer verify-token" } });
        assert.equal(response.status, 403, `A request from another origin got HTTP ${response.status}`);
      }
    }
  ]
};
