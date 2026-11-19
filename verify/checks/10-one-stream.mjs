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
  goal: "EV is one conversation that never ends, and the page is a live view of it. These are the guarantees under that view: a page that lost its connection catches up on exactly what it missed, a message about several pieces of work loses none of them, and what was forgotten leaves an open page at once. How the page looks and behaves was walked through once after it was built (design/build/verification/plumbing.md), not checked on every push.",
  live: [],
  checks: [
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
  ]
};
