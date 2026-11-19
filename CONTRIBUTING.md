# Contributing to EV

Thanks for helping. Bug reports, transcripts of EV misunderstanding someone (with private details removed), design discussion, docs fixes and pull requests are all welcome. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). For security problems, see [SECURITY.md](SECURITY.md) instead of opening an issue.

## Development setup

You need Node.js 22.19 or newer, git, and docker if you want agents to do real work.

```bash
git clone https://github.com/vulbsti/EV.git
cd EV
npm install              # pi-ai, the one library EV uses to talk to models
npm run openclaw:image   # the container agents run in
cp .env.example .env     # then add your model key
npm start                # or: bin/ev run
```

There is no build step. The daemon is `apps/daemon/server.mjs`, the page is `apps/web/`, and the code agents run is in `apps/worker/`.

## Checks

```bash
npm test          # invariants, no model calls, a few seconds
npm run verify    # the behaviours EV aims for, with a scripted model
```

Run both before you open a pull request. CI runs them on Linux. `npm run verify` fails only when a behaviour that held before stops holding (`verify/baseline.json`), so a change may leave unbuilt behaviours open, but it may not break one that works. `npm run qa` and `npm run qa:arc` use a real model and cost money; you don't need them for most changes. If you change how EV understands, asks or reviews, say in the pull request what you ran and what it showed.

## How we decide what goes in

EV has a few design rules. A change that fits them is easy to accept; one that bends them needs an issue first.

- **The code owns facts, the models own meaning.** If the right answer depends on what the person meant, a model decides it, as a tool. If it must be true regardless, code does it and a test proves it. Never add code that reacts to the words of a message ("if the message says stop, stop everything").
- **One of each thing.** One store, one search, one loop, one way to talk to work. Add to them rather than beside them.
- **Lean.** Delete what a change replaces. Keep tests few and behavioural: add one when a behaviour matters, not to restate the implementation.
- **Design for a capable model.** Don't add workarounds for one small model's weakness. If a small model fails, say so in the pull request instead.
- **Never edit a check to make it pass.** The behaviour checks in `verify/` describe what EV should do. If one is wrong, open an issue.

See [AGENTS.md](AGENTS.md) for where things live and the invariants that must not break.

## Pull requests

- Keep each pull request to one change, and link its issue.
- Update the README or `docs/` when you change what a user sees, and add a line to [CHANGELOG.md](CHANGELOG.md) under `Unreleased`.
- Never commit real conversations, memory, `.env` files or keys. Fixtures must be made up.

## Licence

By contributing, you agree that your contributions are licensed under the [Apache-2.0](LICENSE) licence.
