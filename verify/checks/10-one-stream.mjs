import { openPage } from "../lib/browser.mjs";
import { remembersAndForgets, work } from "../lib/scripts.mjs";

/** What a page holds after applying these frames in order: the latest version of each message and piece of work. */
function picture(frames) {
  const messages = new Map();
  const tasks = new Map();
  let thinking = false;
  for (const { data } of frames) {
    for (const message of data?.messages ?? []) messages.set(message.messageId, message);
    for (const task of data?.tasks ?? []) tasks.set(task.taskId, task);
    if (typeof data?.thinking === "boolean") thinking = data.thinking;
  }
  return { messages, tasks, thinking };
}

const said = (frames, text) => [...picture(frames).messages.values()].find((message) => message.content === text);

export default {
  task: 10,
  name: "The page stays live",
  goal: "EV is one conversation that never ends, and the page is a live view of it. Whatever happens (a message, an answer, work moving, something forgotten) reaches an open page as it happens, without the page asking again, and a page that lost its connection catches up on exactly what it missed. A message can be about several pieces of work at once, and the page shows each of them where it belongs.",
  live: [],
  checks: [
    {
      id: "P-01",
      expect: "With the page open, each change reaches it as it happens: the person's message, EV's answer, and the work it started, up to the moment it is delivered.",
      async run({ start, assert }) {
        const ev = await start({ script: { ev: work("Tide poem", "Writing it."), worker: (job) => job.done("The poem.") } });
        const live = await ev.stream();
        try {
          await live.until("the opening view of the conversation", () => true);
          const { taskId } = await ev.say("write me a poem about tides");
          await live.until("the person's message", (frame) => said([frame], "write me a poem about tides"));
          await live.until("EV's answer", (frame) => said([frame], "Writing it."));
          await live.until("the work to be delivered", (frame) => (frame.data?.tasks ?? []).some((task) => task.taskId === taskId && task.status === "completed"));
          const seen = picture(live.frames);
          assert.ok([...seen.messages.values()].some((message) => /Tide poem/.test(message.content) && /done/i.test(message.content)), "The page was never told that the work is done");
          assert.equal(seen.thinking, false, "The page still believes EV is thinking after everything settled");
        } finally { live.close(); }
      }
    },
    {
      id: "P-02",
      expect: "A page that lost its connection, even across a restart of EV, catches up on exactly what it missed: nothing lost, nothing twice, and it ends up seeing what a freshly opened page sees.",
      timeout: 60_000,
      async run({ start, assert }) {
        const ev = await start({ script: { ev: work("Packing list", "On it."), worker: (job) => job.done("The list.") } });
        await ev.say("make a packing list for the coast");
        const first = await ev.stream();
        const opening = await first.until("the opening view", () => true);
        first.close();
        // While the page is away: more conversation, work finishing, and EV restarting.
        await ev.say("and one for the mountains");
        await ev.settled();
        await ev.restart({ crash: true });
        await ev.say("thanks");
        await ev.settled();
        const resumed = await ev.stream({ after: opening.id });
        const fresh = await ev.stream();
        try {
          await fresh.until("a fresh view", () => true);
          await resumed.until("the change it missed last", (frame) => said([frame], "thanks") && frame.data.messages.some((message) => message.replyTo));
          const ids = resumed.frames.map((frame) => Number(frame.id));
          assert.ok(ids.every((id, index) => Number.isFinite(id) && id > Number(opening.id) && (index === 0 || id > ids[index - 1])), `The catch-up repeated or went back over changes the page had already seen (ids ${ids.join(", ")} after ${opening.id})`);
          const caughtUp = picture([opening, ...resumed.frames]);
          const now = picture(fresh.frames);
          const shown = (view) => [...view.messages.values()].map((message) => `${message.role}: ${message.content}`).sort();
          assert.deepEqual(shown(caughtUp), shown(now), "After catching up, the page shows a different conversation from a page opened just now");
          const states = (view) => [...view.tasks.values()].map((task) => `${task.title}: ${task.status}`).sort();
          assert.deepEqual(states(caughtUp), states(now), "After catching up, the page shows the work in a different state from a page opened just now");
        } finally { resumed.close(); fresh.close(); }
      }
    },
    {
      id: "P-03",
      expect: "When one message asks for two pieces of work, both are tied to that message, and the page shows both under it.",
      async run({ start, assert, skip }) {
        const ev = await start({ script: {
          ev: async (turn) => {
            await turn.startWork({ title: "Pricing page", request: "Redo the pricing page." });
            await turn.startWork({ title: "Onboarding email", request: "Shorten the onboarding email." });
            return turn.reply("Starting both.");
          },
          worker: (job) => job.done("Done.")
        } });
        await ev.say("redo the pricing page, and shorten the onboarding email");
        const tasks = await ev.work();
        const titles = new Map(tasks.map((task) => [task.taskId, task.title]));
        const reply = (await ev.conversation()).find((message) => message.content === "Starting both.");
        const linked = ev.linkedWork(reply).map((id) => titles.get(id)).sort();
        assert.deepEqual(linked, ["Onboarding email", "Pricing page"], `EV's answer is tied to ${linked.length ? linked.join(" and ") : "no work"}; it should be tied to both pieces of work it started`);
        const view = await openPage(ev, { skip });
        try {
          for (const title of ["Pricing page", "Onboarding email"]) {
            const visible = await view.page.getByText(title, { exact: false }).first().waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false);
            assert.ok(visible, `The page does not show "${title}", which this message started`);
          }
        } finally { await view.close(); }
      }
    },
    {
      id: "P-04",
      expect: "Forgetting something takes it off an open page at once, without a reload.",
      async run({ start, assert, sleep }) {
        const marker = "HALDANE-31";
        const ev = await start({ script: { ev: (turn) => turn.reply("Done."), learner: remembersAndForgets(marker, `Bike lock code is ${marker}.`) } });
        const live = await ev.stream();
        try {
          await ev.say(`my bike lock code is ${marker}`);
          await ev.learned();
          await live.until("the message to reach the page", (frame) => JSON.stringify(frame.data).includes(marker));
          await ev.say("forget my bike lock code");
          await ev.learned();
          await sleep(500);
          await live.until("the page to hear about the forgetting", (frame) => frame.type !== "snapshot" && [...picture(live.frames).messages.values()].every((message) => !message.content.includes(marker)), { timeout: 5_000 })
            .catch(() => assert.fail("The forgotten text is still on the open page"));
        } finally { live.close(); }
      }
    },
    {
      id: "P-05",
      expect: "Each role can be given its own model, so the reviewer and the learner can run on a cheaper one while EV thinks with its own.",
      async run({ start, assert }) {
        const ev = await start({
          env: { EV_MODEL: "gpt-6-luna", EV_MODEL_REVIEWER: "claude-haiku-5-5", EV_MODEL_LEARNER: "claude-haiku-5-5" },
          script: { ev: work("Tide poem"), worker: (job) => job.done("The poem.") }
        });
        await ev.say("write me a poem about tides");
        await ev.settled();
        await ev.learned();
        const models = (role) => [...new Set(ev.standIn.calls(role).map((call) => call.body?.model))];
        assert.deepEqual(models("ev"), ["gpt-6-luna"], `EV thought with ${models("ev").join(", ")} instead of its own model`);
        assert.deepEqual(models("reviewer"), ["claude-haiku-5-5"], `The reviewer used ${models("reviewer").join(", ") || "no model"} instead of the one set for it`);
        assert.deepEqual(models("learner"), ["claude-haiku-5-5"], `The learner used ${models("learner").join(", ") || "no model"} instead of the one set for it`);
      }
    },
    {
      id: "P-06",
      expect: "Something the person opened on the page stays open while new messages and work updates arrive.",
      async run({ start, assert, skip }) {
        const ev = await start({ script: { ev: (turn) => /poem/.test(turn.message) ? work("Tide poem")(turn) : turn.reply("Noted."), worker: (job) => job.done("The poem.") } });
        await ev.say("write me a poem about tides");
        await ev.settled();
        const view = await openPage(ev, { skip });
        try {
          const card = view.page.locator("[aria-expanded]").filter({ hasText: "Tide poem" }).first();
          await card.waitFor({ state: "visible", timeout: 8_000 }).catch(() => assert.fail("The work card for \"Tide poem\" has nothing that opens it (no element with aria-expanded)"));
          await card.click();
          assert.equal(await card.getAttribute("aria-expanded"), "true", "Clicking the work card did not open it");
          await ev.say("by the way, I'm out on friday");
          await view.page.getByText("Noted.").last().waitFor({ state: "visible", timeout: 8_000 });
          assert.equal(await card.getAttribute("aria-expanded"), "true", "The work card the person opened closed by itself when a new message arrived");
        } finally { await view.close(); }
      }
    },
    {
      id: "P-07",
      expect: "There is one conversation: the page offers no way to start a separate chat, and the same conversation shows on a phone.",
      async run({ start, assert, skip }) {
        const ev = await start({ script: { ev: (turn) => turn.reply("Morning.") } });
        await ev.say("good morning");
        const view = await openPage(ev, { skip, viewport: { width: 390, height: 780 } });
        try {
          await view.page.getByText("Morning.").last().waitFor({ state: "visible", timeout: 8_000 }).catch(() => assert.fail("The phone-sized page does not show the conversation"));
          const separate = await view.page.getByRole("button", { name: /new (conversation|chat)/i }).count();
          assert.equal(separate, 0, "The page still offers to start a separate conversation");
        } finally { await view.close(); }
      }
    }
  ]
};
