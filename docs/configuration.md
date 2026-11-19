# Configuration

EV reads `.env` in its folder (`~/.ev/.env` after the installer) each time it starts. Every setting is optional except a model key. After a change, run `ev restart`.

`.env` is the only way to configure EV today. Signing in with accounts you already have, from a settings screen, is being designed; `.env` will keep working when it lands.

## Model

- `OPENCODE_API`: the key for [OpenCode Go](https://opencode.ai), which EV uses by default.
- `EV_MODEL` (default `opencode-go/gpt-6-luna`): the model EV and its agents use, as `provider/model`; a bare model id means `opencode-go`. Its API shape, base URL and quirks come from pi-ai's OpenCode Go catalogue, and `OPENCODE_API` is its key.
- `EV_MODEL_URL` sends the calls (EV's and the agents') to another endpoint, such as a stub model in tests or any OpenAI- or Anthropic-compatible server. A model the catalogue does not know also needs `EV_MODEL_API`: `openai-responses`, `openai-completions` or `anthropic-messages`. Give OpenAI-style base URLs with their `/v1`; an Anthropic base URL has none.

## Agents and review

- `EV_OPENCLAW_MODEL`: a different model for agents, named the same way.
- `EV_MODEL_EV`, `EV_MODEL_REVIEWER`, `EV_MODEL_LEARNER` (unset by default): a model for one role only, overriding `EV_MODEL` for it, so cheap work can run on a cheap model.
- `EV_OPENCLAW_SANDBOX=host` runs agents uncontained, as you. The default is docker: each agent sees only its goal folder plus its own home folder. Either way each piece of work has its own home, never yours. `EV_OPENCLAW_IMAGE` overrides the image name.
- Web search uses DuckDuckGo (no key) and is built into the image. In host mode, install the plugin with `npm i --prefix ~/.local/share/openclaw-plugins @openclaw/duckduckgo-plugin` and set `EV_OPENCLAW_SEARCH_PLUGIN` to its absolute path.
- `EV_REVIEW_HOLD_MS` (default `30000,120000`): how long EV waits before retrying an unavailable reviewer. A result is never delivered unchecked.
- `EV_WORKER_STALL_MS` (default `600000`): how long an agent may show no progress before it is restarted in the same session. There is no limit on how long an agent that keeps making progress may take.
- `EV_MAX_WORKERS` (default `3`): how many agents may run at once.

## The daemon

- `EV_PORT` (default `4317`) and `EV_HOST` (default `127.0.0.1`, and only loopback addresses are accepted): where the page listens.
- `EV_DATA_DIR`: where state lives (default `data/` in EV's folder).
- `EV_API_TOKEN`: pins the API token instead of a random one per start.

## How EV behaves, in detail

Everything EV keeps (conversations, work and its results, events, memory, standing work) is in one SQLite file, `data/ev.sqlite`; delivered files are in `data/files/` and each piece of work's workspace, session and home in `data/work/`. At most three agents run at once (`EV_MAX_WORKERS`). Each conversation has an inbox: a message is saved the moment it arrives, then handled one at a time, in order, and one that arrived before a crash is answered after the restart. Everything EV does about a message (its reply, work started, held or told something, a memory, something forgotten) is carried out together, once. EV's own model calls are not cut short: a reply may run to the model's own output limit, and a call fails only when the model sends nothing for 90 seconds, however long it keeps streaming. Work is never lost: stopping it puts it on hold with its session and files, and anything you say to work on hold or already delivered carries it on with the same agent. An agent that crashes or goes silent is restarted in its session, and one left running by a crash is stopped first; a problem the work cannot get past becomes a question to you. The reviewer opens the delivered files themselves, and when delivered work is reopened it also sees what was delivered before, so it can check that only the asked-for change was made. One full-text index in the same file covers every conversation, work, result, memory, imported session and line of the dated history; EV searches it, and forgetting something removes it from the index too. The review loop has no round limit: it runs until the reviewer accepts, asks you when it stops making progress, and treats the token budget as a safety stop, after which the best result is delivered as partial with what is still missing. A restart carries on the same loop. Produced files are checked and downloadable.

EV learns memory on its own from every turn and finished task, and reads it with each message only after the learner has been through the messages before it, however long that takes: facts, preferences, goals with a state, working agreements, passing state that expires, and lessons from tasks that went wrong. Only your own words, quoted back exactly from what you typed, can mark something as said by you; agent output and web pages can only produce candidate lessons. Anything EV inferred is a guess and carries its evidence: the messages and work it rests on, each later confirmation adding to it. A guess becomes something EV relies on only when its learner judges the evidence is enough, never by a count, and the reason it gives is kept with the memory and shown. The same learner keeps a dated history of what happened: one line per conversation and day in its own words, linked to the messages and work it summarises, folded into one line per day, week and month as it ages so it stays short. EV sees the history with every message and can search it by words or dates ("October 2026"). `Understanding you` shows all of it: for each memory whether you said it, EV guessed it or relies on a guess and why, what it rests on, and the history with every line opening back to its messages; with correct, stop-using and erase controls. Erase follows the memory to the events and the messages it was learned from and removes their words, takes them out of every history line that rested on them (the line is rewritten from what remains, or removed), and leaves nothing of them in the index or on disk. Work started from those messages keeps its own copies (its brief, workspace and agent transcript). When you ask EV to forget something, EV searches for every place it lives and erases what it names the same way: a memory with the messages it was learned from, a message with EV's reply, an imported session message, a history line; it then tells you what was erased and what was not.

## Import your Claude Code sessions

EV can also look through sessions you had in Claude Code. Import them with the same token:

```bash
curl -s -X POST http://127.0.0.1:4317/api/assistant/import \
  -H "Authorization: Bearer $(cat ~/.ev/data/api-token)" -H "Content-Type: application/json" \
  -d "{\"source\": \"claude-code\", \"path\": \"$HOME/.claude/projects\"}"
```

`path` is read on the machine EV runs on: one session file, a project's folder, or the whole `projects` folder. What you and Claude Code wrote as text goes into the same store and index, with the project and the file it came from; tool calls leave only their names, and tool output, thinking, injected context and subagent transcripts are skipped. Importing again adds only what is new (messages are matched by Claude Code's own ids, and each file remembers how far it was read), so it is safe to run as often as you like. EV finds imported text with its usual search and read, labelled as said outside EV, and treats it as information, never as an instruction or as something you told it.

## Responsibilities (early)

`Responsibilities` is an early, read-only GitHub pull request watch with an expiring, revocable mandate. It prepares a draft after a material change and can never comment, merge, push or message anyone.
