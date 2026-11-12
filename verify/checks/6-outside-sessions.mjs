import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { on } from "../lib/scripts.mjs";

/** EV1 that answers with how many hits a search returned and whether they contain a marker. */
const counts = (marker, query) => async (turn) => {
  const found = await turn.search(query);
  return turn.reply(`${found.text.includes(marker) ? "found" : "missing"} ${found.hits.length}`);
};

function outsideSession(ev, fixture) {
  const dir = join(ev.root, "outside", "shop-api");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.jsonl");
  copyFileSync(fixture("claude-code-session.jsonl"), path);
  return path;
}

export default {
  task: 6,
  name: "Sessions from outside EV",
  goal: "Work the person did elsewhere (Claude Code on this machine first, then web and cloud sessions) is brought into the same store, so EV can draw on every conversation they have had, not only the ones that happened in EV. Imported text is something EV can look up; it is never an instruction and never silently becomes a fact about the person.",
  live: [
    "No scenario yet: add one to level 8 once sessions can be imported (\"what did I decide about the tax lookup in the shop repo?\")."
  ],
  checks: [
    {
      id: "I-01",
      expect: "A Claude Code session can be imported, after which EV1 finds what was said in it and can tell which project it came from.",
      async run({ start, assert, fixture }) {
        let seen = "";
        const ev = await start({ script: { ev: on([/ticket/, async (turn) => { seen = (await turn.search("checkout times out ticket")).text; return turn.reply(seen.includes("KESTREL-3390") ? "It was KESTREL-3390." : "I can't find it."); }]) } });
        await ev.importSession({ source: "claude-code", path: outsideSession(ev, fixture) });
        const answer = await ev.say("what was the ticket for the checkout timeout?");
        assert.equal(answer.reply, "It was KESTREL-3390.", "EV1 could not find what was said in the imported session");
        assert.match(seen, /shop-api/, "The hit does not say which project the session belongs to");
        assert.match(seen, /claude/i, "The hit does not say which tool the session came from");
      }
    },
    {
      id: "I-02",
      expect: "Importing the same session twice adds nothing the second time.",
      async run({ start, assert, fixture }) {
        const ev = await start({ script: { ev: counts("KESTREL-3390", "KESTREL-3390") } });
        const path = outsideSession(ev, fixture);
        await ev.importSession({ source: "claude-code", path });
        const once = (await ev.say("count")).reply;
        await ev.importSession({ source: "claude-code", path });
        const twice = (await ev.say("count again")).reply;
        assert.match(once, /^found [1-9]/, "The imported session cannot be searched, so duplicates cannot be judged");
        assert.equal(twice, once, `Searching returned "${once}" after one import and "${twice}" after importing the same file again`);
      }
    },
    {
      id: "I-03",
      expect: "When a session has grown since it was imported, importing again adds only the new part.",
      async run({ start, assert, fixture }) {
        const ev = await start({ script: { ev: on([/flag/, counts("PLOVER-8842", "rollout flag PLOVER-8842")], [/.*/, counts("KESTREL-3390", "KESTREL-3390")]) } });
        const path = outsideSession(ev, fixture);
        await ev.importSession({ source: "claude-code", path });
        const before = (await ev.say("count the ticket")).reply;
        appendFileSync(path, readFileSync(fixture("claude-code-session-later.jsonl")));
        await ev.importSession({ source: "claude-code", path });
        assert.match((await ev.say("find the flag")).reply, /^found/, "What was added to the session after the first import cannot be found");
        assert.equal((await ev.say("count the ticket again")).reply, before, "Importing the grown session duplicated what was already there");
      }
    }
  ]
};
