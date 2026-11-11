import { openPage } from "../lib/browser.mjs";
import { crashMidRevision, on, passOn, work } from "../lib/scripts.mjs";

export default {
  task: 4,
  name: "One conversation, one thing at a time",
  goal: "A conversation is a queue. Whatever happens in it (a message from the person, work finishing, an agent asking something) is saved the moment it happens and handled in order, so EV always decides with the full picture and the person never has to say something twice or wonder whether it arrived.",
  live: [
    "`L6-01` A correction sent right after a request changes that request; it does not start a second, unrelated task."
  ],
  checks: [
    {
      id: "Q-01",
      expect: "A message is saved the moment it arrives, before EV has decided anything about it.",
      async run({ start, assert, gate }) {
        const thinking = gate();
        const ev = await start({ script: { ev: async (turn) => { await thinking.wait(); return turn.reply("Here."); } } });
        const sent = ev.send("are you there?");
        await thinking.reached;
        const saved = (await ev.conversation()).some((message) => message.role === "user" && message.content === "are you there?");
        thinking.open();
        await sent;
        assert.ok(saved, "While EV was still thinking, the conversation did not contain the person's message");
      }
    },
    {
      id: "Q-02",
      expect: "Two messages sent in quick succession are handled in order: the second is read knowing the first and what it started.",
      async run({ start, assert, gate, sleep }) {
        const first = gate();
        let second = "";
        const ev = await start({ script: {
          ev: on(
            [/Lisbon/, async (turn) => { await first.wait(); await turn.startWork({ title: "Lisbon trip", request: turn.message }); return turn.reply("Planning Lisbon."); }],
            [/Porto/, (turn) => { second = turn.text; return turn.reply("Switched to Porto."); }]
          ),
          worker: (job) => job.done("Trip planned.")
        } });
        const a = ev.send("plan a weekend in Lisbon");
        await first.reached;
        const b = ev.send("actually make it Porto");
        await sleep(400);
        first.open();
        await Promise.all([a, b]);
        assert.match(second, /plan a weekend in Lisbon/, "EV decided on the second message without having seen the first one");
        assert.match(second, /Lisbon trip/, "EV decided on the second message without knowing what the first one had started");
      }
    },
    {
      id: "Q-03",
      expect: "A message EV has received survives a crash and is answered afterwards without being sent again.",
      async run({ start, assert, gate }) {
        const thinking = gate();
        let crashed = false;
        const ev = await start({ script: { ev: async (turn) => { if (!crashed) await thinking.wait(); return turn.reply("Friday at ten works."); } } });
        ev.send("can we move the review to friday at ten?").catch(() => {});
        await thinking.reached;
        crashed = true;
        await ev.restart({ crash: true });
        const answered = await ev.until("EV to answer the message it had received before the crash", async () => {
          const messages = await ev.conversation();
          return messages.some((message) => message.role === "user" && /friday at ten/.test(message.content)) && messages.some((message) => message.role === "assistant" && /Friday at ten works/.test(message.content));
        }, { timeout: 6_000 }).catch(() => false);
        assert.ok(answered, "After the restart the message was gone or never answered; the person would have to notice and send it again");
      }
    },
    {
      id: "Q-04",
      expect: "A change sent while the result is being reviewed reaches the agent before the work can be called done.",
      async run({ start, assert, gate }) {
        const reviewing = gate();
        let reviews = 0;
        const ev = await start({ script: {
          ev: on([/footer/, passOn("Landing page")], [/.*/, work("Landing page")]),
          worker: (job) => job.done(/footer/.test(job.prompt) ? "Page with the footer." : "Page."),
          reviewer: async (turn) => { if (++reviews === 1) await reviewing.wait(); return turn.accept({ handoff: "The landing page is ready." }); }
        } });
        const { taskId } = await ev.say("build the landing page");
        await reviewing.reached;
        const change = await ev.say("also add a footer with the contact address");
        assert.equal(change.reply, "Passed on.", "The change was not accepted for the running work, so this check cannot judge what happened to it");
        reviewing.open();
        const task = await ev.until("the task to finish", async () => { const found = await ev.task(taskId); return found.status === "completed" ? found : null; });
        assert.ok(ev.standIn.jobs(taskId).some((job) => /footer with the contact address/.test(job.prompt)), "EV said it passed the change on, the review then accepted the old result, and the agent never saw the change");
        assert.equal(task.result?.report?.answer, "Page with the footer.", "The delivered result is the one from before the change");
      }
    },
    {
      id: "Q-05",
      expect: "Work that finishes after a restart is announced exactly once.",
      async run(context) {
        const { assert, sleep } = context;
        const { ev } = await crashMidRevision(context);
        await ev.settled("main", { timeout: 20_000 });
        await sleep(600);
        const done = (await ev.fromEV()).filter((message) => /Pricing plan/.test(message.content));
        assert.equal(done.length, 1, `The person got ${done.length} messages about the finished work; expected exactly one`);
      }
    },
    {
      id: "Q-06",
      expect: "Opening a long conversation lands on the newest message, not the oldest.",
      async run({ start, assert, skip }) {
        const ev = await start({ script: { ev: (turn) => turn.reply(`Answer to: ${turn.message}. ${"More detail follows. ".repeat(12)}`) } });
        for (let index = 1; index <= 14; index++) await ev.say(`question number ${index}`);
        const view = await openPage(ev, { skip });
        try { assert.ok(await view.inView("Answer to: question number 14"), "The page opened with the newest message out of view"); }
        finally { await view.close(); }
      }
    },
    {
      id: "Q-07",
      expect: "The page shows the message at once and that EV is thinking, for as long as it is.",
      async run({ start, assert, gate, skip }) {
        const thinking = gate();
        const ev = await start({ script: { ev: async (turn) => { await thinking.wait(); return turn.reply("All set."); } } });
        const view = await openPage(ev, { skip });
        try {
          await view.page.getByRole("textbox").last().fill("reserve the room for monday");
          await view.page.getByRole("button", { name: /send/i }).click();
          await thinking.reached;
          await view.page.getByText("reserve the room for monday").last().waitFor({ state: "visible", timeout: 3_000 });
          // The standard way to mark "an answer is on its way" for both eyes and screen readers.
          const busy = await view.page.locator("[aria-busy='true']").first().waitFor({ state: "attached", timeout: 2_000 }).then(() => true, () => false);
          thinking.open();
          await view.page.getByText("All set.").last().waitFor({ state: "visible", timeout: 8_000 });
          assert.ok(busy, "While EV was thinking, nothing on the page said so (no element with aria-busy=\"true\")");
          assert.equal(await view.page.locator("[aria-busy='true']").count(), 0, "The page still says EV is thinking after the answer arrived");
        } finally { thinking.open(); await view.close(); }
      }
    }
  ]
};
