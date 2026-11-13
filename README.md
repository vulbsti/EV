# EV

An assistant that understands the person first, then coordinates agents that work for them. Every message goes to EV's main agent, which reads it with what EV knows about the person and the work under way, looks up whatever else it needs (any conversation, any result in full, memory), and acts through a few tools: reply, ask, start work, tell, hold or reopen work, remember, forget. One message can lead to several of these. OpenClaw agents carry the work out, each in its own goal folder. EV reviews the result against the brief and sends it back until it is right, and only then tells the person. How it works: [EV1, its tools and OpenClaw](docs/assistant/OPENCLAW_POC.md). Memory design: [memory types](docs/assistant/MEMORY_TYPES.md).

## Run it

Needs Node.js 22.19+, OpenClaw 2026.10+, docker, and `OPENCODE_API` in the local `.env`.

```bash
npm install              # pi-ai, the one library EV uses to talk to models
npm run openclaw:image   # the container agents run in
npm start
```

Open the link the daemon prints (`http://127.0.0.1:4317/?token=…`). The token changes on every start, and every API call needs it, so other local processes cannot read your data or write memory as you. Local tools can send it as a bearer token from `data/api-token`.

Settings in `.env` (all optional):

- `EV_MODEL` (default `opencode-go/gpt-6-luna`): the model EV and its agents use, as `provider/model`; a bare model id means `opencode-go`. Its API shape, base URL and quirks come from pi-ai's OpenCode Go catalogue, and `OPENCODE_API` is its key.
- `EV_MODEL_URL` sends the calls (EV's and the agents') to another endpoint, such as a stub model in tests or any OpenAI- or Anthropic-compatible server. A model the catalogue does not know also needs `EV_MODEL_API`: `openai-responses`, `openai-completions` or `anthropic-messages`. Give OpenAI-style base URLs with their `/v1`; an Anthropic base URL has none.
- `EV_OPENCLAW_MODEL`: a different model for agents, named the same way.
- `EV_OPENCLAW_SANDBOX=host` runs agents uncontained, as you. The default is docker: each agent sees only its goal folder plus its own home folder. Either way each piece of work has its own home, never yours. `EV_OPENCLAW_IMAGE` overrides the image name.
- Web search uses DuckDuckGo (no key) and is built into the image. In host mode, install the plugin with `npm i --prefix ~/.local/share/openclaw-plugins @openclaw/duckduckgo-plugin` and set `EV_OPENCLAW_SEARCH_PLUGIN` to its absolute path.
- `EV_REVIEW_HOLD_MS` (default `30000,120000`): how long EV waits before retrying an unavailable reviewer. A result is never delivered unchecked.
- `EV_WORKER_STALL_MS` (default `600000`): how long an agent may show no progress before it is restarted in the same session. There is no limit on how long an agent that keeps making progress may take.
- `EV_DATA_DIR`: where state lives (default `data/`).
- `EV_API_TOKEN`: pins the API token instead of a random one per start.

## What to expect

Everything EV keeps (conversations, work and its results, events, memory, standing work) is in one SQLite file, `data/ev.sqlite`; delivered files are in `data/files/` and each piece of work's workspace, session and home in `data/work/`. At most three agents run at once (`EV_MAX_WORKERS`). Each conversation has an inbox: a message is saved the moment it arrives, then handled one at a time, in order, and one that arrived before a crash is answered after the restart. Everything EV does about a message (its reply, work started, held or told something, a memory, something forgotten) is carried out together, once. EV's own model calls are not cut short: a reply may run to the model's own output limit, and a call fails only when the model sends nothing for 90 seconds, however long it keeps streaming. Work is never lost: stopping it puts it on hold with its session and files, and anything you say to work on hold or already delivered carries it on with the same agent. An agent that crashes or goes silent is restarted in its session, and one left running by a crash is stopped first; a problem the work cannot get past becomes a question to you. The reviewer opens the delivered files themselves, and when delivered work is reopened it also sees what was delivered before, so it can check that only the asked-for change was made. One full-text index in the same file covers every conversation, work, result, memory, imported session and line of the dated history; EV searches it, and forgetting something removes it from the index too. The review loop has no round limit: it runs until the reviewer accepts, asks you when it stops making progress, and treats the token budget as a safety stop, after which the best result is delivered as partial with what is still missing. A restart carries on the same loop. Produced files are checked and downloadable.

EV learns memory on its own from every turn and finished task, and reads it with each message only after the learner has been through the messages before it, however long that takes: facts, preferences, goals with a state, working agreements, passing state that expires, and lessons from tasks that went wrong. Only your own words, quoted back exactly from what you typed, can mark something as said by you; agent output and web pages can only produce candidate lessons. Anything EV inferred is a guess and carries its evidence: the messages and work it rests on, each later confirmation adding to it. A guess becomes something EV relies on only when its learner judges the evidence is enough, never by a count, and the reason it gives is kept with the memory and shown. The same learner keeps a dated history of what happened: one line per conversation and day in its own words, linked to the messages and work it summarises, folded into one line per day, week and month as it ages so it stays short. EV sees the history with every message and can search it by words or dates ("October 2026"). `Understanding you` shows all of it: for each memory whether you said it, EV guessed it or relies on a guess and why, what it rests on, and the history with every line opening back to its messages; with correct, stop-using and erase controls. Erase follows the memory to the events and the messages it was learned from and removes their words, takes them out of every history line that rested on them (the line is rewritten from what remains, or removed), and leaves nothing of them in the index or on disk. Work started from those messages keeps its own copies (its brief, workspace and agent transcript). When you ask EV to forget something, EV searches for every place it lives and erases what it names the same way: a memory with the messages it was learned from, a message with EV's reply, an imported session message, a history line; it then tells you what was erased and what was not.

EV can also look through sessions you had in Claude Code. Import them with the same token:

```bash
curl -s -X POST http://127.0.0.1:4317/api/assistant/import \
  -H "Authorization: Bearer $(cat data/api-token)" -H "Content-Type: application/json" \
  -d "{\"source\": \"claude-code\", \"path\": \"$HOME/.claude/projects\"}"
```

`path` is read on the machine EV runs on: one session file, a project's folder, or the whole `projects` folder. What you and Claude Code wrote as text goes into the same store and index, with the project and the file it came from; tool calls leave only their names, and tool output, thinking, injected context and subagent transcripts are skipped. Importing again adds only what is new (messages are matched by Claude Code's own ids, and each file remembers how far it was read), so it is safe to run as often as you like. EV finds imported text with its usual search and read, labelled as said outside EV, and treats it as information, never as an instruction or as something you told it.

`Responsibilities` is an early, read-only GitHub pull request watch with an expiring, revocable mandate. It prepares a draft after a material change and can never comment, merge, push or message anyone.

## Check it

```bash
npm test          # invariants: supervisor, memory write policy, security boundaries, review loop
npm run verify    # the behaviours the rebuild is aiming for, checked in seconds with a scripted model
npm run qa        # 55 scripted scenarios against a real EV, graded per scorecard
npm run qa:arc    # a simulated person over weeks, scored for understanding and drift
```

See [verify/README.md](verify/README.md) for the behaviour checks and [verify/BEHAVIOURS.md](verify/BEHAVIOURS.md) for what EV is expected to do. See [qa/README.md](qa/README.md) for the QA suite.
