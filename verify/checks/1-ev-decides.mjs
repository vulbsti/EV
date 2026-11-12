import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { on, passOn, said, work } from "../lib/scripts.mjs";

const RUNNING = new Set(["queued", "running", "verifying"]);
const allDone = (ev) => ev.until("all the work to finish", async () => { const all = await ev.work(); return all.length && all.every((task) => !RUNNING.has(task.status) && task.status !== "waiting") ? all : null; });

export default {
  task: null,
  name: "The choice is EV's, never the code's",
  goal: "The same words can mean different things, and only EV, knowing the person and what is going on, can tell which. So the code holds no flow of its own: every sensible reading is open to EV, exactly the one it picks is carried out, and nothing fires on the words themselves. Each line here is checked as a contrast: the same message, read two ways, must lead to two different outcomes. A system that works by rule can satisfy only one side.",
  live: [
    "`L9-01` / `L9-02` \"stop\" with three things running: once it means one of them, once it is not about the work at all.",
    "`L9-03` / `L9-04` \"stop\" as a pause that is picked up again, and \"stop\" as a change of direction that keeps what was made.",
    "`L9-05` / `L9-06` \"also ...\" while work runs: once it belongs in that work, once it is something else entirely.",
    "`L9-07` / `L9-08` A follow-up after two finished pieces of work goes into the one it is about; a similar-sounding new ask does not.",
    "`L8-04` / `L6-07` A vague request is met with a stated assumption when being wrong is cheap, and with a question before anything that cannot be undone."
  ],
  checks: [
    {
      id: "D-01",
      expect: "The same words can be small talk or the start of work. EV's reading decides, and the code starts nothing and blocks nothing on its own.",
      async run({ start, assert }) {
        let turns = 0;
        const ev = await start({ script: {
          ev: async (turn) => {
            if (++turns === 1) return turn.reply("Morning.");
            await turn.startWork({ title: "Morning briefing", request: "Put together this morning's briefing." });
            return turn.reply("Putting your briefing together.");
          },
          worker: (job) => job.done("Briefing ready.")
        } });
        await ev.say("good morning", { conversation: "talk" });
        assert.equal((await ev.tasks("talk")).length, 0, "EV read the message as a greeting and work started anyway");
        const asked = await ev.say("good morning", { conversation: "briefing" });
        assert.ok(asked.taskId, "EV read the same words as a request for the morning briefing, and no work started");
        const [task] = await ev.settled("briefing");
        assert.equal(task.status, "completed", `The briefing ended as ${task.status}`);
      }
    },
    {
      id: "D-02",
      expect: "A new ask while work is running can join that work, where the context already is, or become work of its own. EV chooses each time, and only what it chose happens.",
      async run({ start, assert, gate }) {
        const play = async (decide) => {
          const hold = gate();
          let first = true;
          const ev = await start({ script: {
            ev: on([/Android/, decide], [/.*/, work("Habit app research")]),
            worker: async (job) => { if (first) { first = false; await hold.wait(); } return job.done("Research done."); }
          } });
          const { taskId } = await ev.say("research the top habit apps on iOS");
          await hold.reached;
          await ev.say("and look at Android too");
          hold.open();
          return { ev, taskId, all: await allDone(ev) };
        };
        const joined = await play(passOn("Habit app research"));
        assert.equal(joined.all.length, 1, "EV sent the message into the running work, and a second task appeared as well");
        assert.ok(joined.ev.standIn.jobs(joined.taskId).some((job) => /Android too/.test(job.prompt)), "EV sent the message into the running work, and its agent never received it");
        const apart = await play(work("Android research"));
        assert.equal(apart.all.length, 2, `EV started separate work for the message, and there are ${apart.all.length} pieces of work`);
        assert.ok(apart.ev.standIn.jobs(apart.taskId).every((job) => !/Android too/.test(job.prompt)), "EV started separate work, and the message was pushed into the running work as well");
      }
    },
    {
      id: "D-03",
      expect: "The words \"stop\" and \"cancel\" do nothing by themselves: when EV reads them as not about the work, the work carries on and is delivered.",
      async run({ start, assert, gate }) {
        const hold = gate();
        const ev = await start({ script: {
          ev: on([/worrying/, (turn) => turn.reply("It won't be late. About ten more minutes.")], [/.*/, work("Slide deck")]),
          worker: async (job) => { await hold.wait(); return job.done("Deck ready."); }
        } });
        const { taskId } = await ev.say("build the slide deck for Friday");
        await hold.reached;
        await ev.say("I can't stop worrying this will be late. I'll have to cancel dinner if it is");
        assert.ok(RUNNING.has((await ev.task(taskId)).status), "The message contained \"stop\" and \"cancel\", EV read it as worry and not as an instruction, and the work was stopped anyway");
        hold.open();
        const [task] = await ev.settled();
        assert.equal(task.status, "completed", `The work ended as ${task.status}`);
        await ev.until("EV to say the deck is done", async () => (await said(ev)).some((text) => /Slide deck/.test(text) && /done/i.test(text)));
      }
    },
    {
      id: "D-04",
      expect: "With several pieces of work running, EV can stop the one that was meant. The others are untouched and deliver.",
      async run({ start, assert, gate }) {
        const hold = gate();
        const ev = await start({ script: {
          ev: on(
            [/^drop/i, async (turn) => { await turn.messageTask({ task: "Privacy policy", stop: true }); return turn.reply("Dropped the privacy policy. The other two carry on."); }],
            [/privacy/i, work("Privacy policy")], [/store/i, work("Store description")], [/.*/, work("Press kit")]
          ),
          worker: async (job) => { await hold.wait(); return job.done("Finished."); }
        } });
        const policy = await ev.say("write a privacy policy draft");
        await ev.say("write the store description");
        await ev.say("put together a press kit");
        await ev.until("all three agents to be running", () => ev.standIn.jobs().length === 3);
        await ev.say("drop the policy one, I'll use a template");
        await ev.until("the privacy policy to stop", async () => !RUNNING.has((await ev.task(policy.taskId)).status));
        const others = (await ev.work()).filter((task) => task.taskId !== policy.taskId);
        assert.ok(others.every((task) => RUNNING.has(task.status)), `Stopping one piece of work also touched another: ${others.map((task) => task.status).join(", ")}`);
        hold.open();
        const all = await allDone(ev);
        assert.equal(all.filter((task) => task.status === "completed").length, 2, "The two pieces of work the person did not stop were not both delivered");
        const heard = await said(ev);
        assert.ok(!heard.some((text) => /Privacy policy/.test(text) && /done/i.test(text)), "EV announced a result for the work the person stopped");
      }
    },
    {
      id: "D-05",
      expect: "\"Stop, not like that\" can be a change of direction: EV can redirect running work, and the same agent carries on with what it has already made instead of starting over.",
      async run({ start, assert, gate }) {
        const hold = gate();
        const ev = await start({ script: {
          ev: on([/green/, passOn("Landing page", "Switching it to green.")], [/.*/, work("Landing page")]),
          worker: async (job) => {
            if (job.run === 1) { writeFileSync(join(job.cwd, "page.html"), "<h1>Tidepool</h1><!-- blue -->\n"); await hold.wait(); return job.done("Blue page."); }
            return job.done("Green page.", { files: { "page.html": "<h1>Tidepool</h1><!-- green -->\n" }, deliverables: [{ path: "page.html", title: "Landing page" }] });
          }
        } });
        const { taskId } = await ev.say("build the landing page, blue theme");
        await hold.reached;
        await ev.say("stop, not blue. make it green");
        hold.open();
        const task = await ev.until("the landing page to finish", async () => { const found = await ev.task(taskId); return found.status === "completed" ? found : RUNNING.has(found.status) ? null : assert.fail(`EV redirected the work and it ended as ${found.status} instead of carrying on`); });
        assert.equal((await ev.work()).length, 1, "The change of direction started a second task from nothing");
        const redirected = ev.standIn.jobs(taskId).find((job) => /green/.test(job.prompt));
        assert.ok(redirected, "The change of direction never reached the agent");
        assert.ok(redirected.files.includes("page.html"), "The agent that picked up the change did not have what had already been made");
        assert.equal(task.result?.report?.answer, "Green page.", "The delivered result is the one from before the change");
        assert.equal((await said(ev)).filter((text) => /Landing page/.test(text) && /done/i.test(text)).length, 1, "The person did not hear exactly once that the page is done");
      }
    }
  ]
};
