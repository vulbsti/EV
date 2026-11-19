# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- One-line installer for macOS and Linux (`install.sh`) and a `kenwise` command to start, stop, open and update the daemon.
- Live steps for running work: KenWise reads each agent's transcript into steps with labels made by code (commands sorted into read, list, search or run), keeps finished steps in their own log, and keeps a status record per piece of work with its "now" line (the latest step, at most every 15 seconds), state, round and model. The page's stream carries steps and status records without resending the whole piece of work, and `GET /api/assistant/tasks/:id/steps` pages back through them. Steps replace the old fixed progress sentences.
- README, docs and project files for open-source use: configuration guide, roadmap, contributing guide, AGENTS.md, security policy, code of conduct, issue and pull request templates, CI.

## [0.1.0] - 2026-11-13

First public state of the rebuild: inbox per conversation, KenWise as a tool loop with search and read, one SQLite store with one full-text index, OpenClaw agents in docker with a review loop that has no round limit, work that can be held, steered and reopened, memory learnt in the background with said versus guessed and a dated history, forget, and Claude Code session import.
