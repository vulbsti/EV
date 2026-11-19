import { statSync } from "node:fs";
import { join } from "node:path";
import { work } from "../lib/scripts.mjs";

// The key the harness gives EV in its environment (OPENCODE_API).
const ENV_KEY = "verify-stand-in-key";
const account = async (ev, provider = "opencode-go") => (await ev.setup()).connections.filter((connection) => connection.provider === provider);
const notices = async (ev) => (await ev.fromEV()).filter((message) => !message.replyTo && !message.taskId);
/** Sends a message without waiting for an answer, and returns its id. */
async function send(ev, text, id) {
  const { value } = await ev.api("/api/assistant/messages", { clientMessageId: id, conversationId: "main", text });
  return value.message.messageId;
}
const answerTo = async (ev, messageId) => (await ev.conversation()).find((message) => message.replyTo === messageId);

export default {
  task: 10,
  name: "Accounts EV reaches models through",
  goal: "EV reaches models through the person's own accounts: a key in its environment, a key they paste, or a subscription they sign in to. A key is kept in one protected place and nowhere else, not even with the agents doing the work. An account that hits its usage limit or stops being accepted is a known state, not an error: what needs a model waits, the person is told once, and it goes on by itself when an account is usable again.",
  live: [
    "One real run on the test server: a real account forced into its limit, and an agent in docker reaching its model through the relay."
  ],
  checks: [
    {
      id: "C-01",
      expect: "A key EV finds in its environment shows as a working account that says where it comes from; the key itself is never shown, and the account cannot be removed from the screen.",
      async run({ start, assert }) {
        const ev = await start();
        const setup = await ev.setup();
        assert.ok(!JSON.stringify(setup).includes(ENV_KEY), "The settings screen was sent the key itself");
        const [found] = await account(ev);
        assert.ok(found, "The key in EV's environment does not show as an account");
        assert.equal(found.method, "env", "The account does not say it comes from the environment");
        assert.match(found.source ?? "", /OPENCODE_API/, "The account does not name the setting it was found in");
        assert.equal(found.status, "ready", `The account shows as ${found.status}, not ready`);
        const removed = await ev.removeConnection(found.id);
        assert.ok(!removed.ok, "An account from the environment was removed from the screen");
        assert.equal((await account(ev)).length, 1, "The account from the environment disappeared");
        await ev.say("hello");
        assert.equal(ev.standIn.calls("ev").at(-1).auth, ENV_KEY, "EV did not answer through the account from its environment");
      }
    },
    {
      id: "C-02",
      expect: "A key the person pastes is tried at once: one the provider refuses is reported straight away and not kept; one it accepts is used from EV's next message on, ahead of the environment's, until it is removed.",
      async run({ start, assert }) {
        const ev = await start();
        ev.standIn.refuse("mistyped-key");
        const bad = await ev.addKey("opencode-go", "mistyped-key");
        assert.ok(!bad.ok, "A key the provider refused was saved");
        assert.ok(bad.value?.error, "The person was not told why the key was not saved");
        assert.ok(!(await account(ev)).some((connection) => connection.method === "key"), "The refused key shows as an account");
        const good = await ev.addKey("opencode-go", "pasted-key-1", "Personal");
        assert.ok(good.ok, `A key the provider accepts was not saved: ${good.value?.error ?? good.status}`);
        const pasted = (await account(ev)).find((connection) => connection.method === "key");
        assert.equal(pasted?.status, "ready", "The pasted key does not show as a working account");
        assert.equal(pasted.label, "Personal", "The account lost the name the person gave it");
        assert.ok(!JSON.stringify(await ev.setup()).includes("pasted-key-1"), "The settings screen was sent the pasted key");
        await ev.say("hello");
        assert.equal(ev.standIn.calls("ev").at(-1).auth, "pasted-key-1", "EV kept using the key from its environment after one was pasted");
        assert.ok((await ev.removeConnection(pasted.id)).ok, "The pasted account could not be removed");
        await ev.say("hello again");
        assert.equal(ev.standIn.calls("ev").at(-1).auth, ENV_KEY, "After the pasted key was removed, EV did not go back to the key in its environment");
      }
    },
    {
      id: "C-03",
      expect: "A pasted key survives a restart and is kept in exactly one file that only the person's own user can read: not in the conversation, the store, search or anything given to an agent.",
      async run({ start, assert }) {
        const secret = "sk-verify-kept-in-one-place-7731";
        const ev = await start({ script: { ev: work("Notes"), worker: (job) => job.done("Tidied.") } });
        assert.ok((await ev.addKey("opencode-go", secret)).ok, "The key was not saved");
        await ev.say("tidy my notes");
        await ev.settled();
        await ev.restart();
        await ev.say("thanks");
        assert.equal(ev.standIn.calls("ev").at(-1).auth, secret, "After a restart EV no longer used the pasted key");
        const holders = ev.filesContaining(secret);
        assert.equal(holders.length, 1, `The key is in ${holders.length} files: ${holders.join(", ") || "none"}`);
        assert.ok(!/(^|\/)work\//.test(holders[0]), `The key is in an agent's folder: ${holders[0]}`);
        assert.equal(statSync(join(ev.root, holders[0])).mode & 0o077, 0, "The file holding the key can be read by other users");
        assert.equal((await ev.search(secret)).length, 0, "Search finds the key");
      }
    },
    {
      id: "C-04",
      expect: "An agent's model calls reach the provider with the person's key, while nothing the agent is given (its environment, its config, its files) holds a key.",
      async run({ start, assert }) {
        const ev = await start({ script: { ev: work("Intro"), worker: (job) => job.done("Drafted.", { process: { think: "plan the intro" } }) } });
        await ev.say("draft the intro");
        await ev.settled();
        const calls = ev.standIn.calls("agent");
        assert.ok(calls.length, "The agent's model call never reached the model");
        assert.equal(calls[0].auth, ENV_KEY, "The agent's model call did not arrive with the person's key");
        const [job] = ev.standIn.jobs();
        assert.ok(!Object.values(job.env ?? {}).some((value) => String(value).includes(ENV_KEY)), "The agent's environment holds the key");
        assert.deepEqual(ev.filesContaining(ENV_KEY), [], "A file EV wrote holds the key");
      }
    },
    {
      id: "C-05",
      expect: "When an account hits its usage limit, it shows as limited until a time, the person is told once, and their message waits and is answered after the reset without being sent again.",
      async run({ start, assert }) {
        const ev = await start({ script: { ev: (turn) => turn.reply("Here is today.") } });
        ev.standIn.outage("ev", 429, { retryAfter: 2 });
        const messageId = await send(ev, "what's on today?", "limit-1");
        const [limited] = await ev.until("the account to show as limited", async () => (await account(ev)).filter((connection) => connection.status === "limited"));
        assert.ok(limited.until && !Number.isNaN(Date.parse(limited.until)), "The limited account does not say when it is usable again");
        await ev.until("EV to tell the person the message waits", async () => (await notices(ev)).length);
        assert.ok(!await answerTo(ev, messageId), "EV answered the message as if it had been handled");
        ev.standIn.restore("ev");
        const reply = await ev.until("the waiting message to be answered after the reset", () => answerTo(ev, messageId), { timeout: 25_000 });
        assert.equal(reply.content, "Here is today.", "The answer is not EV's answer to the waiting message");
        assert.equal((await notices(ev)).length, 1, "The person was told about the limit more than once");
        assert.equal((await account(ev))[0].status, "ready", "The account still shows as limited after it worked again");
      }
    },
    {
      id: "C-06",
      expect: "When an account's key stops being accepted, it shows as needing a new sign-in, the person is told once, and their message waits; once they give a key that works, the waiting message is answered.",
      async run({ start, assert }) {
        const ev = await start({ script: { ev: (turn) => turn.reply("Sure.") } });
        ev.standIn.refuse(ENV_KEY);
        const messageId = await send(ev, "book a table", "signin-1");
        await ev.until("the account to show as needing a new sign-in", async () => (await account(ev)).some((connection) => connection.status === "needs-sign-in"));
        await ev.until("EV to tell the person", async () => (await notices(ev)).length);
        assert.ok(!await answerTo(ev, messageId), "EV answered the message as if it had been handled");
        assert.ok((await ev.addKey("opencode-go", "fresh-key")).ok, "The new key was not saved");
        const reply = await ev.until("the waiting message to be answered", () => answerTo(ev, messageId));
        assert.equal(reply.content, "Sure.", "The answer is not EV's answer to the waiting message");
        assert.equal(ev.standIn.calls("ev").at(-1).auth, "fresh-key", "EV did not answer through the new key");
        assert.equal((await notices(ev)).length, 1, "The person was told more than once");
      }
    },
    {
      id: "C-07",
      expect: "Signing in with a subscription gives the person a link to finish it and a way to paste the result back when the browser cannot reach EV; a sign-in they abandon ends without adding an account.",
      async run({ start, assert }) {
        const ev = await start();
        const offered = (await ev.setup()).providers.find((provider) => provider.id === "openai");
        assert.ok(offered?.signIn, "Signing in with ChatGPT is not offered");
        const attempt = await ev.signIn("openai");
        const waiting = await ev.until("a link to finish signing in", async () => { const state = await ev.signInState(attempt.id); return state.url ? state : null; });
        assert.match(waiting.url, /^https:\/\/auth\.openai\.com\//, "The link does not go to OpenAI's sign-in");
        assert.ok(waiting.paste, "There is no way to paste the result back");
        assert.ok((await ev.cancelSignIn(attempt.id)).ok, "The sign-in could not be cancelled");
        assert.equal((await ev.signInState(attempt.id)).state, "cancelled", "The abandoned sign-in did not end");
        assert.equal((await account(ev, "openai")).length, 0, "An abandoned sign-in added an account");
      }
    }
  ]
};
