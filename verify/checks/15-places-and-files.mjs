import { mkdirSync } from "node:fs";
import { join } from "node:path";

const grants = async (ev) => (await ev.api("/api/assistant/files")).value?.grants ?? [];

export default {
  task: 15,
  name: "Where KenWise runs, and what agents may change",
  goal: "On the person's own computer, agents read their files but change only their own copies, plus the folders the person lets them change. A folder becomes writable only from the person: on the Files screen, or in their own words to EV. Nothing an agent, a page or EV's own judgement says makes one writable, and secret places can never be made writable.",
  live: [
    "One real run in docker: an agent reads a file in the home, cannot read ~/.ssh, cannot write outside its workspace, and writes a granted folder at its next step after the grant."
  ],
  checks: [
    {
      id: "F-01",
      expect: "EV can make a folder writable only on the person's own words in their message, and the conversation then shows the folder with a way to take it back; without their words nothing is granted and EV is told why.",
      async run({ start, assert }) {
        const ev = await start({
          script: {
            ev: async (turn) => {
              const folder = "~/proj/site";
              if (/fix the typo/.test(turn.message)) {
                const refused = await turn.grant({ folder, scope: "always", quote: "you may edit my site" });
                return { said: refused.text };
              }
              const granted = await turn.grant({ folder, scope: "always", quote: "yes, you can edit ~/proj/site" });
              return { said: granted.text };
            }
          }
        });
        mkdirSync(join(ev.home, "proj", "site"), { recursive: true });
        const first = await ev.say("fix the typo on my site");
        assert.equal((await grants(ev)).length, 0, "A folder was made writable on words the person never wrote");
        assert.match(first.reply ?? "", /own words|not in their message/i, "EV was not told why nothing was granted");
        const second = await ev.say("yes, you can edit ~/proj/site");
        const now = await grants(ev);
        assert.equal(now.length, 1, `The person's own words did not make the folder writable: ${second.reply}`);
        assert.match(now[0].source ?? "", /^message:/, "The grant does not point to the message it rests on");
        const theirs = (await ev.conversation()).find((message) => message.messageId === now[0].source.slice("message:".length));
        assert.equal(theirs?.grants?.[0]?.id, now[0].id, "The conversation does not show the person that a folder became writable on their words");
      }
    },
    {
      id: "F-02",
      expect: "The Files screen can let agents change a folder and take it back; a secret place or KenWise's own data cannot be made writable.",
      async run({ start, assert }) {
        const ev = await start();
        mkdirSync(join(ev.home, "notes"), { recursive: true });
        mkdirSync(join(ev.home, ".ssh"), { recursive: true });
        const added = await ev.api("/api/assistant/files/grants", { folder: "~/notes" });
        assert.ok(added.ok, `The page could not grant a folder: ${added.value?.error ?? added.status}`);
        const [grant] = await grants(ev);
        assert.ok(grant, "The granted folder is not listed");
        const ssh = await ev.api("/api/assistant/files/grants", { folder: "~/.ssh" });
        assert.ok(!ssh.ok, "~/.ssh was made writable");
        const own = await ev.api("/api/assistant/files/grants", { folder: ev.dataDir });
        assert.ok(!own.ok, "KenWise's own data was made writable");
        const taken = await ev.api(`/api/assistant/files/grants/${grant.id}`, undefined, "DELETE");
        assert.ok(taken.ok, "The grant could not be taken back");
        assert.equal((await grants(ev)).length, 0, "The grant is still listed after it was taken back");
      }
    }
  ]
};
