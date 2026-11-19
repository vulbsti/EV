import { NotBuilt } from "../lib/protocol.mjs";
import { on } from "../lib/scripts.mjs";

// What the grouper was shown: each item as "[date] message:<id>: <its words or gist>".
const itemsShown = (prompt) => [...prompt.matchAll(/\] ((?:message|work|import):[A-Za-z0-9-]+): (.*)/g)].map((match) => ({ item: match[1], text: match[2] }));
const itemFor = (prompt, words) => itemsShown(prompt).find((entry) => entry.text.includes(words))?.item ?? null;
const threadId = (prompt, name) => new RegExp(`thread:([A-Za-z0-9-]+) "${name}"`).exec(prompt)?.[1] ?? null;

async function threads(ev) {
  const { status, value } = await ev.api("/api/assistant/threads");
  if (status === 404) throw new NotBuilt("threads of work (no GET /api/assistant/threads)");
  return value;
}

/** Which of the person's messages sit in which thread, and which are not grouped yet. */
async function placement(ev) {
  const view = await threads(ev);
  const where = { notGrouped: view.notGrouped.items.filter((item) => item.kind === "message").map((item) => item.text).sort() };
  for (const thread of view.threads) {
    const { value } = await ev.api(`/api/assistant/threads/${encodeURIComponent(thread.threadId)}`);
    where[thread.name] = value.messages.filter((message) => message.role === "user").map((message) => message.content).sort();
  }
  return where;
}

/** Asks for an organise run and waits until it has landed. */
async function organise(ev) {
  const before = (await threads(ev)).lastRegroup?.regroupId ?? null;
  const asked = await ev.api("/api/assistant/threads/regroup", {});
  if (asked.status === 404) throw new NotBuilt("organising on request (no POST /api/assistant/threads/regroup)");
  return ev.until("the organise run to land", async () => {
    const view = await threads(ev);
    return view.lastRegroup && view.lastRegroup.regroupId !== before ? view : null;
  });
}

const SAID = ["pricing call is weekly now, fridays", "need the pricing comparison for friday", "draft the onboarding email", "what's the weather like"];

export default {
  task: 13,
  name: "Threads of work",
  goal: "The one conversation is grouped by the work it is about. A small model files each new message into a thread that exists, or leaves it under \"not grouped yet\"; a stronger model, following the grouping skill, creates and reshapes threads every few days or when asked. Which thread something belongs in is the models' judgement and was walked through once (design/build/verification/threads-of-work.md). What is checked here holds whatever they decide: nothing goes missing, the person's own moves stand, a regroup lands whole and can be undone, a thread's id lasts, filing never delays a reply, and forgetting reaches the threads.",
  live: [],
  checks: [
    {
      id: "G-01",
      expect: "Whatever the models decide, every message the person sent is either in a thread or listed under \"not grouped yet\". Nothing drops out of sight.",
      async run({ start, assert }) {
        const ev = await start({ script: {
          ev: (turn) => turn.reply("Noted."),
          // A filer that names threads that do not exist, and a grouper that moves things into nowhere.
          filer: (call) => ({ items: [...call.text.matchAll(/\[(message:[A-Za-z0-9-]+)\]/g)].map((match) => ({ item: match[1], gist: "x", threads: [{ thread: "thread:does-not-exist", sure: 1 }] })) }),
          grouper: (call) => ({ ops: [
            { op: "create", key: "p", name: "Pricing", card: "Weekly pricing comparison.", items: [itemFor(call.text, "pricing call"), itemFor(call.text, "pricing comparison"), "message:not-a-real-one"] },
            { op: "move", item: itemFor(call.text, "pricing call"), to: "thread:gone" },
            { op: "merge", from: "p", into: "nowhere" },
            { op: "create", key: "e", name: "Email", items: [itemFor(call.text, "onboarding")] },
            { op: "merge", from: "e", into: "p" },
            { op: "frobnicate" }
          ] })
        } });
        for (const text of SAID) await ev.say(text);
        await organise(ev);
        const where = await placement(ev);
        const seen = Object.values(where).flat();
        for (const text of SAID) assert.ok(seen.includes(text), `"${text}" is in no thread and not listed as not grouped yet: ${JSON.stringify(where)}`);
      }
    },
    {
      id: "G-02",
      expect: "When the person puts a message in a thread themselves, no model moves it again: not the filer, not a later organise run.",
      async run({ start, assert }) {
        let round = 0;
        const ev = await start({ script: {
          ev: (turn) => turn.reply("Noted."),
          grouper: (call) => {
            round++;
            const item = itemFor(call.text, "pricing comparison");
            if (round === 1) return { ops: [{ op: "create", key: "a", name: "Pricing", items: [item] }, { op: "create", key: "b", name: "Website", items: [itemFor(call.text, "onboarding")] }] };
            const pricing = threadId(call.text, "Pricing");
            return { ops: [{ op: "move", item, to: `thread:${pricing}` }, { op: "move", item, to: null }, { op: "add", item, thread: `thread:${pricing}` }] };
          }
        } });
        for (const text of SAID) await ev.say(text);
        const first = await organise(ev);
        const website = first.threads.find((thread) => thread.name === "Website");
        const pricing = first.threads.find((thread) => thread.name === "Pricing");
        const { value } = await ev.api(`/api/assistant/threads/${encodeURIComponent(pricing.threadId)}`);
        const message = value.messages.find((entry) => entry.content === SAID[1]);
        const moved = await ev.api("/api/assistant/threads/move", { item: `message:${message.messageId}`, to: website.threadId });
        assert.ok(moved.ok, `Moving a message by hand failed: ${moved.value?.error}`);
        await ev.say("one more thing for later");
        await organise(ev);
        const where = await placement(ev);
        assert.deepEqual(Object.keys(where).filter((name) => where[name].includes(SAID[1])), ["Website"], `The message the person moved to Website was moved again: ${JSON.stringify(where)}`);
      }
    },
    {
      id: "G-03",
      expect: "An organise run changes the threads all at once or not at all, and undoing it puts back exactly what was there before.",
      async run({ start, assert }) {
        let round = 0;
        const ev = await start({ script: {
          ev: (turn) => turn.reply("Noted."),
          grouper: (call) => {
            round++;
            if (round === 1) return { ops: [{ op: "create", key: "p", name: "Pricing", card: "Pricing work.", items: [itemFor(call.text, "pricing call"), itemFor(call.text, "pricing comparison")] }, { op: "create", key: "o", name: "Onboarding", items: [itemFor(call.text, "onboarding")] }] };
            return { ops: [
              { op: "update", thread: `thread:${threadId(call.text, "Pricing")}`, name: "Pricing and email", card: "Both." },
              { op: "merge", from: `thread:${threadId(call.text, "Onboarding")}`, into: `thread:${threadId(call.text, "Pricing")}` },
              { op: "create", key: "w", name: "Weather", items: [itemFor(call.text, "weather")] },
              { op: "move", item: itemFor(call.text, "pricing call"), to: null }
            ] };
          }
        } });
        for (const text of SAID) await ev.say(text);
        await organise(ev);
        const before = await placement(ev);
        // A run whose model fails changes nothing.
        ev.standIn.outage("grouper", 400);
        await ev.api("/api/assistant/threads/regroup", {});
        await ev.until("the failed organise run", () => ev.standIn.calls("grouper").some((call) => call.refused));
        await new Promise((done) => setTimeout(done, 300));
        assert.deepEqual(await placement(ev), before, "An organise run that could not reach its model still changed the threads");
        ev.standIn.restore("grouper");
        const view = await organise(ev);
        assert.notDeepEqual(await placement(ev), before, "The second organise run changed nothing, so undo cannot be judged");
        const undone = await ev.api("/api/assistant/threads/undo", { regroupId: view.lastRegroup.regroupId });
        assert.ok(undone.ok, `Undo failed: ${undone.value?.error}`);
        assert.deepEqual(await placement(ev), before, "Undoing the organise run did not put back exactly what was there before");
      }
    },
    {
      id: "G-04",
      expect: "A thread keeps its id when it is renamed or merged into another, so a link to it still opens the work it became.",
      async run({ start, assert }) {
        let round = 0;
        const ev = await start({ script: {
          ev: (turn) => turn.reply("Noted."),
          grouper: (call) => {
            round++;
            if (round === 1) return { ops: [{ op: "create", key: "p", name: "Pricing", items: [itemFor(call.text, "pricing call")] }, { op: "create", key: "c", name: "Comparison", items: [itemFor(call.text, "pricing comparison")] }] };
            return { ops: [{ op: "update", thread: `thread:${threadId(call.text, "Comparison")}`, name: "Friday comparison" }, { op: "merge", from: `thread:${threadId(call.text, "Friday comparison") ?? threadId(call.text, "Comparison")}`, into: `thread:${threadId(call.text, "Pricing")}` }] };
          }
        } });
        for (const text of SAID.slice(0, 2)) await ev.say(text);
        const first = await organise(ev);
        const old = first.threads.find((thread) => thread.name === "Comparison").threadId;
        await organise(ev);
        const opened = await ev.api(`/api/assistant/threads/${encodeURIComponent(old)}`);
        assert.ok(opened.ok, `The old thread id no longer opens anything (${opened.status})`);
        assert.ok(opened.value.messages.some((message) => message.content === SAID[1]), "The old thread id opens a thread without the messages it held");
      }
    },
    {
      id: "G-05",
      expect: "Filing never holds up a reply: while the filer is still working on one message, the person's next message is answered.",
      async run({ start, assert, gate }) {
        const hold = gate();
        const ev = await start({ script: {
          ev: (turn) => turn.reply(`Answer to: ${turn.message}`),
          filer: async () => { await hold.wait(); return { items: [] }; }
        } });
        try {
          await ev.say("first message");
          await hold.reached;
          const answer = await ev.say("second message", { timeout: 10_000 });
          assert.equal(answer.reply, "Answer to: second message", "The second message was not answered while the filer was busy");
        } finally { hold.open(); }
      }
    },
    {
      id: "G-06",
      expect: "Forgetting a message takes its words out of the threads too: the filer's gist of it, and any thread name or card that may repeat it.",
      async run({ start, assert }) {
        const marker = "TANGIER-58";
        const ev = await start({ script: {
          ev: on([/forget/, async (turn) => { const { hits } = await turn.search(marker); await turn.forget(hits.map((hit) => hit.id)); return turn.reply("Forgotten."); }], [/.*/, (turn) => turn.reply("Noted.")]),
          filer: (call) => ({ items: [...call.text.matchAll(/\[(message:[A-Za-z0-9-]+)\] at [^\n]*\n([^\n]*)/g)].map((match) => ({ item: match[1], gist: match[2].includes(marker) ? `Door code ${marker}` : "The landlord", threads: [] })) }),
          // The first run names and describes the thread with the words; any later run leaves the threads as they are.
          grouper: (call) => (threadId(call.text, `Flat ${marker}`) || !itemFor(call.text, marker) ? { ops: [] } : { ops: [{ op: "create", name: `Flat ${marker}`, card: `The new flat, door code ${marker}.`, items: [itemFor(call.text, marker), itemFor(call.text, "The landlord")] }] })
        } });
        await ev.say(`the door code for the new flat is ${marker}`);
        await ev.say("and the landlord is called Ines");
        await ev.until("the filer to write gists", async () => JSON.stringify(await threads(ev)).includes(marker));
        const view = await organise(ev);
        assert.ok(view.threads.some((thread) => thread.name.includes(marker)), "The stand-in grouper's thread did not land, so this check proves nothing");
        await ev.say("forget the door code");
        const after = JSON.stringify([await threads(ev), ...await Promise.all(view.threads.map(async (thread) => (await ev.api(`/api/assistant/threads/${encodeURIComponent(thread.threadId)}`)).value))]);
        assert.ok(!after.includes(marker), "The threads still hold words the person asked EV to forget");
      }
    }
  ]
};
