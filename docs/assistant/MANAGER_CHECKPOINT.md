# Manager checkpoint — 2026-09-26

The current default route implements the priority shift: natural request → goal and success criteria → one executor or independent parallel children → combined outcome → inline answer and downloadable files. It reuses the existing SQLite supervisor. There is no new provider framework or general task DAG.

## Verified

- `npm test`: 150 passed. Manager tests exercise overlapping children and capacity, safe retry, no retry for uncertain side effects, parent cancellation including waiting workers, restart with a completed child, minor/unavailable review, material partial results, blocked delivery, and a missing claimed file.
- Real OpenClaw 2026.2.9 workers, OpenCode Go / GPT-6-Luna: three requests completed through EV's HTTP conversation route. An unfamiliar Python fixture was repaired and its three tests independently rerun successfully. Two parallel workers created Python and Node CSV reporters; the parent combined them and delivered three files. Both downloaded programs were independently rerun and returned the expected total, 53.00. Artifact downloads matched their recorded hashes.
- One acceptance child was deliberately interrupted. It failed with `OPENCLAW_PROCESS_EXIT`; the manager retained the other worker's result, created one retry task, and delivered the combined report.
- The @tibo request recovered from denied browser access and unreadable fetch output by inspecting compressed public HTTP data. It returned three visible original posts with direct links and distinguished the older pinned post. The answer explicitly limits its claim to the unauthenticated public timeline.
- Browser checks: completed answers and download links appeared inline, the failed child and successful retry were visible under their parent, conversation results survived daemon restart/reload, and a task submitted through the browser returned its passing test result. The later check confirms generic command receipts reach review, rather than only a hardcoded test-command list.

Test conversation: http://127.0.0.1:4317/?conversation=manager-check-2026-09-26T07-28-56-854Z

Local evidence under ignored `data/manager-check/2026-09-26T07-28-56-854Z/`: `receipt.json`, `local-verification.json`, `objective-verification.json`, and `browser-turn.json`. The initial failed run is retained separately; it exposed the report parser's incorrect handling of code fences inside JSON. That parser bug was fixed with a regression fixture.

## Current limits

This is a working manager proof of concept, not evidence that every arbitrary task succeeds. Fan-out is one level of independent assignments; dependent steps stay in one executor. Each worker turn has a five-minute timeout, up to three supervised processes run concurrently, and there is no hard token/cost budget. Task directories are not OS sandboxes. Web access and public timeline completeness depend on the available source.

The personal assistant layer still uses explicit global guidance. It does not yet maintain a learned taste profile, infer and reconcile long-term goals, or give conversational follow-ups a complete view of prior task outcomes. The next useful work is that assistant layer: conversation continuity and task context first, then evidence-linked personal understanding and preferences. Keep broad provider support and fine-grained process-status auditing deferred.

Current code remains local and uncommitted on top of `0dbc330`, alongside the earlier prototype edits. The test server is started with `npm run prototype`. Use `npm run assistant:manager-check -- --interrupt-child` to repeat the live manager proof against a running server.
