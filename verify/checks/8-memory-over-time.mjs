import { lookUp, on, remembersAndForgets } from "../lib/scripts.mjs";

const claimsWith = (claims, text) => claims.filter((claim) => JSON.stringify(claim.current?.value ?? "").includes(text));

function todayInWords(now = new Date()) {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const forms = [];
  // Either side of midnight is fine: EV may speak in UTC or in the person's own time zone.
  for (const date of [now, new Date(now.getTime() - 14 * 3_600_000), new Date(now.getTime() + 14 * 3_600_000)]) {
    const day = date.getUTCDate(), month = months[date.getUTCMonth()], year = date.getUTCFullYear();
    forms.push(date.toISOString().slice(0, 10), `${day} ${month} ${year}`, `${month} ${day}, ${year}`, `${day} ${month.slice(0, 3)} ${year}`, `${month.slice(0, 3)} ${day}, ${year}`);
  }
  return forms;
}

export default {
  task: 8,
  name: "Memory that deepens over time",
  goal: "EV knows the person the way a long-time colleague does. It keeps a short dated history of what happened and can open any line of it back to the original words. It saves what matters as it hears it. It can tell what the person said from what it guessed, and a guess becomes knowledge only when it holds up across separate occasions. Nothing it once knew is lost when it changes, and nothing it was asked to forget survives anywhere.",
  live: [
    "`L8-05` Asked what they were working on two weeks ago, EV answers from its history with rough dates.",
    "`L8-06` A preference shown by behaviour but never stated is treated as a hint; EV says so or checks once.",
    "`L8-07` After a correction, EV can still say what was true before and when that changed.",
    "The twelve-week arc (`npm run qa:arc`) is the real measure here: understanding should rise week over week instead of drifting."
  ],
  checks: [
    {
      id: "M-01",
      expect: "EV1 is told today's date, so \"since when\" and \"how long ago\" can be answered.",
      async run({ start, assert }) {
        const ev = await start({ script: { ev: (turn) => turn.reply("Let me check.") } });
        await ev.say("how long until the end of the month?");
        const shown = ev.standIn.calls("ev")[0].text;
        assert.ok(todayInWords().some((form) => shown.includes(form)), "Nothing EV1 was shown says what today's date is");
      }
    },
    {
      id: "M-02",
      expect: "EV1 can save something the person just said, and it is in memory before the reply is sent.",
      async run({ start, assert }) {
        const ev = await start({ script: { ev: async (turn) => { await turn.remember("Prefers metric units.", { quote: "I prefer metric units" }); return turn.reply("Metric from now on."); } } });
        await ev.say("I prefer metric units, please use them with me");
        const saved = claimsWith(await ev.memory(), "metric units");
        assert.equal(saved.length, 1, "What EV1 chose to remember is not in memory right after its reply");
        assert.equal(saved[0].current.status, "active", `Something the person stated in so many words was saved as "${saved[0].current.status}"`);
      }
    },
    {
      id: "M-03",
      expect: "EV1 cannot save a guess as something the person said: without their own words behind it, a memory stays tentative.",
      async run({ start, assert }) {
        const ev = await start({ script: { ev: async (turn) => { await turn.remember("Works at Initech.", { quote: "I work at Initech" }); return turn.reply("Sunny, 21 degrees."); } } });
        await ev.say("what's the weather like today?");
        const active = claimsWith(await ev.memory(), "Initech").filter((claim) => claim.current.status === "active");
        assert.equal(active.length, 0, "A memory whose supporting quote is not in anything the person wrote was stored as an established fact");
      }
    },
    {
      id: "M-04",
      expect: "A guess becomes established only after it shows up on separate occasions, not twice in one conversation.",
      async run({ start, assert }) {
        const ev = await start({ script: {
          ev: (turn) => turn.reply("Noted."),
          learner: (turn) => [
            turn.guessed("long day", "preference", "Prefers quick dinners on work days."),
            turn.confirmed("quick again", "quick dinners"),
            turn.confirmed("quick one today", "quick dinners")
          ]
        } });
        const status = async () => claimsWith(await ev.memory(), "quick dinners")[0]?.current.status;
        await ev.say("long day, could use a quick dinner", { conversation: "monday" });
        await ev.learned();
        assert.equal(await status(), "candidate", "The guess was not recorded as tentative to begin with");
        await ev.say("something quick again tonight", { conversation: "monday" });
        await ev.learned();
        assert.equal(await status(), "candidate", "A guess became an established fact after being seen twice in the same conversation");
        await ev.say("a quick one today as well", { conversation: "thursday" });
        await ev.learned();
        assert.equal(await status(), "active", "A guess confirmed on a separate occasion still did not become established");
      }
    },
    {
      id: "M-05",
      expect: "When something about the person changes, what EV knew before can still be found, marked as no longer current.",
      async run({ start, assert }) {
        const ev = await start({ script: {
          ev: on(
            [/before/, async (turn) => turn.reply((await lookUp(turn, "office site", "site PELICAN-12")) ? "You were at site PELICAN-12 before." : "I have no record of an earlier site.")],
            [/.*/, (turn) => turn.reply("Noted.")]
          ),
          // The learner's wording differs from the person's, so only memory's own history can contain it.
          learner: (turn) => [
            turn.stated("Rotterdam", "fact", "Works from office site PELICAN-12."),
            turn.changed("moved to the Lyon", "PELICAN-12", "Works from office site HERON-9.")
          ]
        } });
        await ev.say("I'm at the Rotterdam office these days");
        await ev.learned();
        await ev.say("I've moved to the Lyon office");
        await ev.learned();
        const answer = await ev.say("where was I based before?");
        assert.equal(answer.reply, "You were at site PELICAN-12 before.", "What EV knew before the change can no longer be found");
      }
    },
    {
      id: "M-06",
      expect: "EV keeps a dated history of what happened that stays short however much happens, and every line opens back to its source.",
      timeout: 90_000,
      async run({ start, assert }) {
        const ev = await start({ script: { ev: (turn) => turn.reply("Noted.") } });
        for (let index = 1; index <= 80; index++) await ev.say(`day note ${index}: finished part ${index} of the kitchen plan`, { conversation: `week-${Math.ceil(index / 10)}` });
        await ev.learned();
        const lines = await ev.timeline();
        assert.ok(lines.length >= 3, `After 80 events the history has ${lines.length} line(s)`);
        assert.ok(lines.length <= 40, `After 80 events the history has ${lines.length} lines; it should stay short by merging older lines`);
        for (const line of lines) assert.ok(line.text && (line.events?.length ?? line.sources?.length ?? 0) > 0, `A history line cannot be opened back to what it summarises: ${JSON.stringify(line).slice(0, 160)}`);
        await ev.say("where are we with the kitchen plan?");
        const shown = ev.standIn.calls("ev").at(-1).text;
        assert.ok(lines.some((line) => shown.includes(line.text)), "EV1 is not shown any of its own history when a new message arrives");
      }
    },
    {
      id: "M-07",
      expect: "Forgetting something removes it from the history as well.",
      async run({ start, assert }) {
        const marker = "MARLOWE-17";
        const ev = await start({ script: { ev: (turn) => turn.reply("Done."), learner: remembersAndForgets(marker, `Gym locker is ${marker}.`) } });
        await ev.say(`my gym locker is ${marker}`);
        await ev.learned();
        const before = await ev.timeline();
        assert.ok(before.length > 0, "Nothing reached the history, so forgetting cannot be judged");
        await ev.say("forget my gym locker");
        await ev.learned();
        assert.ok(!JSON.stringify(await ev.timeline()).includes(marker), "The history still contains what the person asked EV to forget");
      }
    }
  ]
};
