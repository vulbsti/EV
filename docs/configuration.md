# Configuration

KenWise reads `.env` in its folder (`~/.kenwise/.env` after the installer) each time it starts. Every setting is optional except a model key. After a change, run `kenwise restart`.

Model accounts can also be added while KenWise runs, by key or by signing in with a subscription (see Accounts below); the settings screen for them is being built. `.env` keeps working.

## Model

- `OPENCODE_API`: the key for [OpenCode Go](https://opencode.ai), which KenWise uses by default. Any key pi-ai knows (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`...) is found the same way and shows as an account.
- `EV_MODEL` (default `opencode-go/gpt-6-luna`): the model KenWise and its agents use, as `provider/model` from pi-ai's catalogue; a bare model id means `opencode-go`. Its API shape, base URL and quirks come from the catalogue, and the key from that provider's account.
- `EV_MODEL_URL` sends the calls (KenWise's and the agents') to another endpoint, such as a stub model in tests or any OpenAI- or Anthropic-compatible server. A model the catalogue does not know also needs `EV_MODEL_API`: `openai-responses`, `openai-completions` or `anthropic-messages`. Give OpenAI-style base URLs with their `/v1`; an Anthropic base URL has none.

## Accounts

KenWise reaches models through accounts, one or more per provider, one of them active. A key in the environment is an account that shows where it was found and is changed there; a key pasted through the settings API is tried with one tiny call before it is kept, and wins over the environment's. Subscriptions and accounts sign in directly where the provider allows other apps to (ChatGPT, GitHub Copilot, SuperGrok, OpenRouter, Kimi, Meta, and an OpenCode account for Zen and Go): the sign-in gives a link or a device code, and when the browser cannot reach KenWise (KenWise on another machine) you paste the final redirect URL back. A Claude subscription is not offered, because Anthropic's terms do not allow it in other apps.

Keys and tokens are kept in one file, `data/secrets/credentials.json`, readable only by your user and never indexed, searched or given to an agent. Agents reach their model through a relay inside KenWise with a token that works only for their own run: KenWise swaps in the real key on the way out, so no key enters an agent's container, and KenWise is the only one that refreshes a subscription token.

The same model is often served by several of your accounts: Haiku 5.5 through OpenCode Go and through OpenRouter, or two ChatGPT accounts. Every call, KenWise's own and agents', goes through the best of them right now: one that is not limited first, then subscription quota before paying per token (quota that goes unused is wasted), then speed for the price, measured on your own recent calls. A piece of work keeps the route it started on while that account is usable, so the provider's prompt cache is kept. If the account runs out mid-task, the refused request goes out again through another subscription or account for the same model before the agent sees the limit, and the work's steps say so. When a subscription runs out and only a route paid per token could carry on, what happens follows your limit setting ([issue 21](https://github.com/vulbsti/KenWise/issues/21)): **Decide for me** (the default: a model weighs, once per piece of work and limit, whether you are waiting on it, how far off the reset is and what paying would cost, and says why), **Prefer waiting** (a subscription that needs a new sign-in is not waited on, since it does not come back by itself), **Always switch**, or **Ask me first** (nothing is paid for until you say so). A monthly cap on paid spend is never crossed without your say-so, whatever the setting. A switch is told once in the conversation with what it costs, and shows as a line on the work; so does a decision to wait. A piece of work moved to a paid route goes back to the subscription once it is usable again. Agents' calls count toward the cap: the relay reads each answer's token counts. Which model a piece of work runs on is KenWise's own judgement: when it starts the work it names a first and a second choice, each with a line of why, from a guide of the models you can reach. The guide gives each model's price and context from the catalogue, what the model atlas in `knowledge/models/` says about it (each claim marked reported or tested, with its source), and what your own work and words show about it. Once a week (`EV_MODEL_GUIDE_EVERY`, default `7d`, and only when there is new finished work or a new note), one model call reads your finished work of the last twelve weeks (which model did it, why it was chosen, review rounds, whether you came back to change it, cost and time) next to the atlas, and adds, rewords or retires claims about models for you, following `apps/daemon/skills/model-guide.md`: "seen" on a few cases, "relied on" for a pattern, with one line of why the evidence is enough. Each claim rests on pieces of work that exist; one whose work is gone is erased at the next run. Your own notes about models are kept in your words and never contradicted, and forgetting one (EV's forget tool with its `model:` id, or deleting it) erases it from the guide's list of changes too. Every change is listed and can be undone on its own, and new atlas claims that arrive with an update are listed once. `EV_MODELS` (a comma list of model names, such as `claude-haiku-5-5, muse-spark-1-3-contributor`) keeps KenWise to those models; a model you switch off is never offered either. The agent runs on the first choice while it can be reached, else the second; the reviewer uses its own model, or the work's other choice when its own model is the one that did the work. `EV_OPENCLAW_MODEL` and `EV_MODEL` are now only what agents use when KenWise names nothing. Every model call leaves a row in `model_calls` (which route, how it ended, time, tokens and cost where known, never any text).

| Call | Does |
| --- | --- |
| `GET /api/assistant/setup/guide` | Each model KenWise can choose: what your work showed (with its standing), what the atlas says (with its source), the routes that reach it, speed; models in your subscriptions nothing is known about; what changed in the last 30 days; notes; what is switched off; the last and next analysis |
| `POST /api/assistant/setup/guide/note` `{text, model?}` | Adds your own note about a model, or about choosing models |
| `DELETE /api/assistant/setup/guide/note/:id` | Forgets a note |
| `GET /api/assistant/setup/limit` | The limit setting (`decide`, `wait`, `switch`, `ask`), the monthly cap and what was spent on paid routes this month |
| `POST /api/assistant/setup/limit` `{choice?, monthlyCapUsd?}` | Changes them; a cap of 0 or null means none |
| `POST /api/assistant/setup/limit/allow` | You say paid routes may be used, past the cap too, until the accounts out of use now are back |
| `POST /api/assistant/setup/guide/undo` `{change}` | Undoes one change |
| `POST /api/assistant/setup/guide/run` | Runs the analysis now |
| `POST /api/assistant/setup/guide/off` `{model, off}` | Switches a model off, or back on |

An account that hits its usage limit is marked limited until its reset time, and one whose key stops being accepted is marked as needing a new sign-in. Neither is called until it is usable again. A message that needs a model meanwhile waits in its inbox and KenWise says so once; it is answered at the reset, or as soon as an account is added. Work in progress and the reviewer wait the same way without counting it as a failure.

| Call | Does |
|---|---|
| `GET /api/assistant/setup` | Providers (with whether a key or a subscription sign-in is offered) and accounts with their status. Never a secret, only a hint |
| `POST /api/assistant/setup/connections` `{provider, key, label?}` | Tries the key, then saves it as the provider's active account |
| `POST /api/assistant/setup/connections/:id` `{active?, label?}` | Makes it the active account, or renames it |
| `DELETE /api/assistant/setup/connections/:id` | Removes a saved account |
| `POST /api/assistant/setup/signin` `{provider, label?}` | Starts a subscription sign-in; poll it with `GET /api/assistant/setup/signin/:id` (link or device code, then saved, failed, expired or cancelled after 10 minutes) |
| `POST /api/assistant/setup/signin/:id/code` `{code}` | Answers what the sign-in asks for, usually the pasted redirect URL |
| `DELETE /api/assistant/setup/signin/:id` | Cancels it |

## Agents and review

- `EV_OPENCLAW_MODEL`: a different model for agents, named the same way.
- `EV_MODEL_EV`, `EV_MODEL_REVIEWER`, `EV_MODEL_LEARNER`, `EV_MODEL_FILER`, `EV_MODEL_GROUPER`, `EV_MODEL_PORTRAIT` (unset by default): a model for one role only, overriding `EV_MODEL` for it, so cheap work can run on a cheap model. The filer files each new message into a thread of work and runs after every turn, so a small model suits it (`opencode-go/claude-haiku-5-5`). The grouper organises the threads every few days and should be a capable one, and so should the portrait writer, which writes how KenWise understands you.

## Threads of work

- `EV_REGROUP_EVERY` (default `7d`): how often the grouper organises the threads of work, as `30m`, `12h`, `7d` or `2w`. The first run comes this long after the first message, so it has days of context to work from. `0` turns the timer off; organising still happens when you ask for it in the conversation or from the list of threads.
- `EV_PORTRAIT_EVERY` (default `1d`): the most often the portrait ("How I understand you") is written again, and only after the notes changed. A sentence whose notes did not change keeps its words. Forgetting or stopping a note it rests on removes the sentence at once and rewrites the portrait within the hour, and so does telling KenWise a sentence is not quite right (once the learner has read it). `0` stops timed rewrites.
- `EV_OPENCLAW_SANDBOX=host` runs agents uncontained, as you. The default is docker: each agent sees only its goal folder plus its own home folder. Either way each piece of work has its own home, never yours. `EV_OPENCLAW_IMAGE` overrides the image name.
- Web search uses DuckDuckGo (no key) and is built into the image. In host mode, install the plugin with `npm i --prefix ~/.local/share/openclaw-plugins @openclaw/duckduckgo-plugin` and set `EV_OPENCLAW_SEARCH_PLUGIN` to its absolute path.
- `EV_REVIEW_HOLD_MS` (default `30000,120000`): how long KenWise waits before retrying an unavailable reviewer. A result is never delivered unchecked.
- `EV_STEER_WAIT_MS` (default `120000`): when you tell a running agent something, how long KenWise waits for the step it is in to finish before it cuts that step short to pass your message on.
- `EV_WORKER_STALL_MS` (default `600000`): how long an agent may show no progress before it is restarted in the same session. There is no limit on how long an agent that keeps making progress may take.
- `EV_MAX_WORKERS` (default `3`): how many agents may run at once.

## The daemon

- `EV_PORT` (default `4317`) and `EV_HOST` (default `127.0.0.1`, and only loopback addresses are accepted): where the page listens.
- `EV_DATA_DIR`: where state lives (default `data/` in KenWise's folder).
- `EV_API_TOKEN`: pins the API token instead of a random one per start.

## How KenWise behaves, in detail

Everything KenWise keeps (conversations, work and its results, events, memory, standing work) is in one SQLite file, `data/ev.sqlite`; delivered files are in `data/files/` and each piece of work's workspace, session and home in `data/work/`. At most three agents run at once (`EV_MAX_WORKERS`). Each conversation has an inbox: a message is saved the moment it arrives, then handled one at a time, in order, and one that arrived before a crash is answered after the restart. Everything KenWise does about a message (its reply, work started, held or told something, a memory, something forgotten) is carried out together, once. KenWise's own model calls are not cut short: a reply may run to the model's own output limit, and a call fails only when the model sends nothing for 90 seconds, however long it keeps streaming. Work is never lost: stopping it puts it on hold with its session and files, and anything you say to work on hold or already delivered carries it on with the same agent. An agent that crashes or goes silent is restarted in its session, and one left running by a crash is stopped first; a problem the work cannot get past becomes a question to you. The reviewer opens the delivered files themselves, and when delivered work is reopened it also sees what was delivered before, so it can check that only the asked-for change was made. One full-text index in the same file covers every conversation, work, result, memory, imported session and line of the dated history; KenWise searches it, and forgetting something removes it from the index too. The review loop has no round limit: it runs until the reviewer accepts, asks you when it stops making progress, and treats the token budget as a safety stop, after which the best result is delivered as partial with what is still missing. A restart carries on the same loop. Produced files are checked and downloadable.

KenWise learns memory on its own from every turn and finished task, and reads it with each message only after the learner has been through the messages before it, however long that takes: facts, preferences, goals with a state, working agreements, passing state that expires, and lessons from tasks that went wrong. Only your own words, quoted back exactly from what you typed, can mark something as said by you; agent output and web pages can only produce candidate lessons. Anything KenWise inferred is a guess and carries its evidence: the messages and work it rests on, each later confirmation adding to it. A guess becomes something KenWise relies on only when its learner judges the evidence is enough, never by a count, and the reason it gives is kept with the memory and shown. The same learner keeps a dated history of what happened: one line per conversation and day in its own words, linked to the messages and work it summarises, folded into one line per day, week and month as it ages so it stays short. KenWise sees the history with every message and can search it by words or dates ("October 2026"). `Understanding you` shows all of it: for each memory whether you said it, KenWise guessed it or relies on a guess and why, what it rests on, and the history with every line opening back to its messages; with correct, stop-using and erase controls. Erase follows the memory to the events and the messages it was learned from and removes their words, takes them out of every history line that rested on them (the line is rewritten from what remains, or removed), and leaves nothing of them in the index or on disk. Work started from those messages keeps its own copies (its brief, workspace and agent transcript). When you ask KenWise to forget something, KenWise searches for every place it lives and erases what it names the same way: a memory with the messages it was learned from, a message with KenWise's reply, an imported session message, a history line; it then tells you what was erased and what was not.

## Import your Claude Code sessions

KenWise can also look through sessions you had in Claude Code. Import them with the same token:

```bash
curl -s -X POST http://127.0.0.1:4317/api/assistant/import \
  -H "Authorization: Bearer $(cat ~/.kenwise/data/api-token)" -H "Content-Type: application/json" \
  -d "{\"source\": \"claude-code\", \"path\": \"$HOME/.claude/projects\"}"
```

`path` is read on the machine KenWise runs on: one session file, a project's folder, or the whole `projects` folder. What you and Claude Code wrote as text goes into the same store and index, with the project and the file it came from; tool calls leave only their names, and tool output, thinking, injected context and subagent transcripts are skipped. Importing again adds only what is new (messages are matched by Claude Code's own ids, and each file remembers how far it was read), so it is safe to run as often as you like. KenWise finds imported text with its usual search and read, labelled as said outside KenWise, and treats it as information, never as an instruction or as something you told it.

## Responsibilities (early)

`Responsibilities` is an early, read-only GitHub pull request watch with an expiring, revocable mandate. It prepares a draft after a material change and can never comment, merge, push or message anyone.
