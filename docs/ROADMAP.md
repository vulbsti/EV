# Roadmap

Where KenWise is going next, in rough order. The [status section](../README.md#status-early) of the README says what works today.

## Now

- **Measure on real models.** Finish the graded run after the last round of fixes, and run KenWise once on a strong model, to separate design gaps from the limits of small test models.
- **The interface.** One ongoing conversation with threads of work, live work you can watch or pop out beside the chat, and "How I understand you": a short portrait of you where every line shows why KenWise thinks it. The screenshots in the README are this design.
- **Sign in with what you have.** Connect the accounts and subscriptions you already pay for instead of one API key. A router picks the model and the account for each piece of work, from a model guide that learns from what actually worked for you. Secrets never enter an agent's container.

## Next

- **Memory that corrects cleanly.** A correction replaces what you said before, and your profile reaches agents as background, not as instructions.
- **Reach you when you're away**, through one channel you choose. This also replaces the old GitHub pull-request watcher.
- **All your sessions.** Pick up Claude Code sessions automatically, then Claude on the web, Codex and other tools, each as one small reader into the same store.
- **A reviewer that can use a browser**, to check web work the way you would.
- **A desktop app.** KenWise runs in your browser for now; the plan is a desktop app (Electron) around the same daemon.
- **Windows**, after macOS and Linux are solid.

Ideas and pull requests for any of these are welcome. Open an issue first for anything large, so we can agree on the shape.
