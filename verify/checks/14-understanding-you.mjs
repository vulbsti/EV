import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotBuilt, memoryIdShown } from "../lib/protocol.mjs";

async function understanding(ev) {
  const { status, value } = await ev.api("/api/assistant/understanding");
  if (status === 404 || !("portrait" in (value ?? {}))) throw new NotBuilt("the portrait (no portrait on GET /api/assistant/understanding)");
  return value;
}

/** Waits until the portrait has a sentence that says `words`. */
async function portraitSays(ev, words) {
  return ev.until(`the portrait to say "${words}"`, async () => (await understanding(ev)).portrait?.lines.some((line) => line.text.includes(words)) ? true : null);
}

// The person states two things; the learner notes both, each with its situation.
const learner = (pass) => [
  pass.stated("one word is enough for status", "preference", "Wants a status update in a word.", { situation: "asking where the work stood while boarding" }),
  pass.stated("my dog is called", "fact", "Has a dog called ORRIN-4.", { situation: "chatting at the start of the day" }),
  pass.forgotten("forget my dog", "ORRIN-4")
].filter(Boolean);

export default {
  task: 14,
  name: "Understanding you",
  goal: "EV holds an understanding of the person, not a list of facts: notes keep the situation they were seen in, and a portrait of a few sentences, written by a decent model following the portrait skill, says who they are to work with. What the sentences say, and how EV weighs them case by case, is judgement: it was walked through once (design/build/verification/understanding-you.md) and is tested in pairs in the real-model run. What is checked here holds whatever the models decide: every sentence rests on evidence, forgetting reaches the portrait, and the portrait never reaches an agent.",
  live: [],
  checks: [
    {
      id: "U-01",
      expect: "Every sentence of the portrait rests on at least one note. A sentence the writer gives with nothing behind it is never shown, to the person or to EV.",
      async run({ start, assert }) {
        const ev = await start({ env: { EV_PORTRAIT_EVERY: "1s" }, script: {
          ev: (turn) => turn.reply("Noted."),
          learner,
          portrait: (call) => ({ lines: [
            { text: "You want a status in a word, and more when something is yours to decide.", why: "You said so while boarding.", evidence: [call.noteId("status update")] },
            { text: "You are secretly a night owl FALCON-9.", why: "No reason.", evidence: [] },
            { text: "You love long reports HERON-2.", why: "Made up.", evidence: ["n99"] }
          ], question: null })
        } });
        await ev.say("one word is enough for status, I'm boarding");
        await ev.learned();
        await portraitSays(ev, "status in a word");
        const shown = JSON.stringify(await understanding(ev));
        assert.ok(!shown.includes("FALCON-9") && !shown.includes("HERON-2"), "A portrait sentence that rests on no note is shown to the person");
        for (const line of (await understanding(ev)).portrait.lines) assert.ok(line.evidence.length > 0, `A portrait sentence carries no evidence: ${line.text}`);
        await ev.say("thanks");
        const prompt = ev.standIn.calls("ev").at(-1).text;
        assert.ok(prompt.includes("status in a word"), "EV is not shown the portrait");
        assert.ok(!prompt.includes("FALCON-9") && !prompt.includes("HERON-2"), "EV is shown a portrait sentence that rests on no note");
      }
    },
    {
      id: "U-02",
      expect: "Forgetting a note takes every portrait sentence resting on it away at once, from the page, from what EV is shown, and from every earlier version.",
      async run({ start, assert }) {
        const ev = await start({ env: { EV_PORTRAIT_EVERY: "1s" }, script: {
          ev: (turn) => turn.reply("Noted."),
          learner,
          portrait: (call) => ({ lines: [
            { text: "You want a status in a word.", why: "You said so while boarding.", evidence: [call.noteId("status update")] },
            ...(call.noteId("ORRIN-4") ? [{ text: "You start the day with ORRIN-4, your dog.", why: "You told me.", evidence: [call.noteId("ORRIN-4")] }] : [])
          ], question: null })
        } });
        await ev.say("one word is enough for status, I'm boarding");
        await ev.say("my dog is called ORRIN-4");
        await ev.learned();
        await portraitSays(ev, "ORRIN-4");
        await ev.say("forget my dog");
        await ev.learned();
        await ev.until("the forget to land", async () => !JSON.stringify(await ev.memory()).includes("ORRIN-4") ? true : null);
        assert.ok(!JSON.stringify(await understanding(ev)).includes("ORRIN-4"), "The portrait still says what the person asked EV to forget");
        const { value: history } = await ev.api("/api/assistant/understanding/history");
        assert.ok(!JSON.stringify(history).includes("ORRIN-4"), "An earlier version of the portrait still says what the person asked EV to forget");
        await ev.say("morning");
        assert.ok(!ev.standIn.calls("ev").at(-1).text.includes("ORRIN-4"), "EV is still shown a portrait sentence about what the person asked EV to forget");
      }
    },
    {
      id: "U-03",
      expect: "Nothing from the portrait reaches an agent. Its brief carries only the notes EV named for that work, as background with their situation.",
      async run({ start, assert }) {
        let context = null;
        const ev = await start({ env: { EV_PORTRAIT_EVERY: "1s" }, script: {
          ev: async (turn) => {
            if (!turn.message.includes("draft")) return turn.reply("Noted.");
            await turn.startWork({ title: "Status note", request: "Draft a short status note on the launch.", notes: memoryIdShown(turn.text, "status update") ?? [] });
            return turn.reply("On it.");
          },
          learner,
          portrait: (call) => ({ lines: [{ text: "You are someone who decides fast, KESTREL-3.", why: "Seen often.", evidence: [call.noteId("status update")] }], question: null }),
          worker: (job) => { try { context = readFileSync(join(job.cwd, "CONTEXT.md"), "utf8"); } catch {} return job.done("Drafted."); }
        } });
        await ev.say("one word is enough for status, I'm boarding");
        // Said elsewhere, so it can reach the agent only through memory, not through this conversation.
        await ev.say("my dog is called ORRIN-4", { conversation: "elsewhere" });
        await ev.learned();
        await portraitSays(ev, "KESTREL-3");
        await ev.say("draft the launch status note");
        await ev.settled();
        assert.ok(context !== null, "The agent's brief could not be read");
        assert.ok(!context.includes("KESTREL-3"), "A portrait sentence reached the agent");
        assert.ok(context.includes("status update in a word") && context.includes("boarding"), "The note EV named for the work did not reach the agent with its situation");
        assert.ok(!context.includes("ORRIN-4"), "A note EV did not name for the work reached the agent");
      }
    }
  ]
};
