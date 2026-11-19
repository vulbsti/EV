# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/vulbsti/KenWise/security/advisories/new). Do not open a public issue. Include the commit you ran, your OS, what you did and what happened. You should get a reply within a week.

## What to know before you run KenWise

KenWise holds the most private thing an assistant can: what it has learnt about you. It is built to keep that on your machine, and to keep the agents it starts away from everything else.

**The page is local only.** The daemon refuses any host that is not a loopback address. Every API call needs a token that changes on each start (unless you pin `EV_API_TOKEN`), so other local processes and web pages cannot read your data or write memory as you. Requests are checked for their `Host` and `Origin`, which blocks DNS rebinding and cross-site requests.

**Agents are contained.** By default each agent runs in a docker container that sees only its own work folder and its own home, as your user and never as root, with all capabilities dropped and CPU, memory and process limits. `EV_OPENCLAW_SANDBOX=host` turns this off and runs agents as you, with your files in reach; only use it on a machine you don't mind them touching.

**What leaves your machine.** Your messages, what KenWise knows about you that is relevant, and the files agents work on are sent to the model provider you configure. That provider's data policy applies. Agents can search the web and open pages, and text from the web is treated as information, never as instructions.

**What stays.** Conversations, memory, history and work are in `data/` (`~/.kenwise/data` after the installer). Anyone with access to your user account can read them. Forgetting something in KenWise erases it from the store, the history and the search index; work that was started from it keeps its own copy until the work is erased.

**Keys.** Your model key is in `.env`, which is created with mode `600` and is never committed. Don't paste keys into a conversation: KenWise's memory rules avoid storing secrets, but a model can still repeat them.
