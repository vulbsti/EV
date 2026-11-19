# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- One-line installer for macOS and Linux (`install.sh`) and a `kenwise` command to start, stop, open and update the daemon.
- The page is the approved interface: one ongoing conversation kept live by a single stream of changes that resumes after a dropped connection, work cards under the messages they belong to (one message can be about several pieces of work), a Work sheet, look settings that follow you to every device, notes and history, search and a phone layout.
- A model per role: `EV_MODEL_EV`, `EV_MODEL_REVIEWER`, `EV_MODEL_LEARNER`.
- Live steps for running work: KenWise reads each agent's transcript into steps with labels made by code (commands sorted into read, list, search or run), keeps finished steps in their own log, and keeps a status record per piece of work with its "now" line (the newest step as it happens), state, round and model. The page's stream carries steps and status records without resending the whole piece of work, and `GET /api/assistant/tasks/:id/steps` pages back through them. Steps replace the old fixed progress sentences.
- Threads of work: each message is filed into the work it is about by a small model after the turn, and new work waits under "Not grouped yet" until the next organise run (every `EV_REGROUP_EVERY`, default `7d`, or when asked), where a stronger model following `apps/daemon/skills/grouping.md` creates and reshapes threads. Runs can be undone; a message you move by hand stays put. The page lists the threads, opens one across days, and groups search results by thread with the matched words marked.
- Search: results open the conversation at that point, can be limited to one thread, and offer to ask KenWise when plain words find nothing. A renamed piece of work is found by its new name.
- README, docs and project files for open-source use: configuration guide, roadmap, contributing guide, AGENTS.md, security policy, code of conduct, issue and pull request templates, CI.

## [0.1.0] - 2026-11-13

First public state of the rebuild: inbox per conversation, KenWise as a tool loop with search and read, one SQLite store with one full-text index, OpenClaw agents in docker with a review loop that has no round limit, work that can be held, steered and reopened, memory learnt in the background with said versus guessed and a dated history, forget, and Claude Code session import.
