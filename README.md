# EV

An assistant that understands the person first, then coordinates agents that work for them. Every message goes to EV's main agent, which combines it with what EV knows about the person, decides whether to reply, ask, or start work, and writes a brief. OpenClaw agents carry the work out in a shared goal folder. EV reviews the result against the brief and sends it back until it is right, and only then tells the person. How it works: [EV, the manager and OpenClaw](docs/assistant/OPENCLAW_POC.md). Memory design: [memory types](docs/assistant/MEMORY_TYPES.md).

## Run it

Needs Node.js 24.16+, OpenClaw 2026.10+, docker, and `OPENCODE_API` in the local `.env`.

```bash
npm run openclaw:image   # the container agents run in
npm start
```

Open the link the daemon prints (`http://127.0.0.1:4317/?token=…`). The token changes on every start, and every API call needs it, so other local processes cannot read your data or write memory as you. Local tools can send it as a bearer token from `data/api-token`.

Settings in `.env` (all optional):

- `EV_MODEL`, `EV_MODEL_API` (`responses`, `chat` or `messages`): the model EV thinks and reviews with. `EV_MODEL_URL` points EV's own calls elsewhere, such as a stub model in tests.
- `EV_OPENCLAW_MODEL`, `EV_OPENCLAW_API` (`openai-responses` or `anthropic-messages`): the model agents use.
- `EV_OPENCLAW_SANDBOX=host` runs agents uncontained, as you. The default is docker: each agent sees only its goal folder plus an OpenClaw home folder that all tasks share. `EV_OPENCLAW_IMAGE` overrides the image name.
- Web search uses DuckDuckGo (no key) and is built into the image. In host mode, install the plugin with `npm i --prefix ~/.local/share/openclaw-plugins @openclaw/duckduckgo-plugin` and set `EV_OPENCLAW_SEARCH_PLUGIN` to its absolute path.
- `EV_REVIEW_HOLD_MS` (default `30000,120000`): how long EV waits before retrying an unavailable reviewer. A result is never delivered unchecked.
- `EV_DATA_DIR`: where state lives (default `data/`).
- `EV_API_TOKEN`: pins the API token instead of a random one per start.

## What to expect

Conversations, tasks and memory are durable in SQLite. At most three agents run at once (`EV_MAX_WORKERS`). Messages in one conversation are handled one at a time, in order. The review loop has no round limit: it runs until the reviewer accepts, asks you when it stops making progress, and treats the token budget as a safety stop, after which the best result is delivered as partial with what is still missing. A restart carries on the same loop. Produced files are checked and downloadable.

EV learns memory on its own from every turn and finished task: facts, preferences, goals with a state, working agreements, passing state that expires, and lessons from tasks that went wrong. Only your own words, quoted back exactly from what you typed, can make or change something EV relies on about you; agent output and web pages can only produce candidate lessons. `Understanding you` shows all of it, with correct, stop-using and erase controls. Erase removes the text from memory and from the memory event log, but copies can remain in the conversation, the task records and agent transcripts.

`Responsibilities` is an early, read-only GitHub pull request watch with an expiring, revocable mandate. It prepares a draft after a material change and can never comment, merge, push or message anyone.

## Check it

```bash
npm test          # invariants: supervisor, memory write policy, security boundaries, review loop
npm run qa        # 40 scripted scenarios against a real EV, graded per scorecard
npm run qa:arc    # a simulated person over weeks, scored for understanding and drift
```

See [qa/README.md](qa/README.md) for the QA suite.
