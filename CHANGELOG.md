# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- One-line installer for macOS and Linux (`install.sh`) and a `kenwise` command to start, stop, open and update the daemon.
- The page is the approved interface: one ongoing conversation kept live by a single stream of changes that resumes after a dropped connection, work cards under the messages they belong to (one message can be about several pieces of work), a Work sheet, look settings that follow you to every device, notes and history, search and a phone layout.
- A model per role: `EV_MODEL_EV`, `EV_MODEL_REVIEWER`, `EV_MODEL_LEARNER`.
- README, docs and project files for open-source use: configuration guide, roadmap, contributing guide, AGENTS.md, security policy, code of conduct, issue and pull request templates, CI.

## [0.1.0] - 2026-11-13

First public state of the rebuild: inbox per conversation, KenWise as a tool loop with search and read, one SQLite store with one full-text index, OpenClaw agents in docker with a review loop that has no round limit, work that can be held, steered and reopened, memory learnt in the background with said versus guessed and a dated history, forget, and Claude Code session import.
