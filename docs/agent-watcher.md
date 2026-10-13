# Agent watcher (naru task 1909)

A full-page live timeline of every running agent, at `#/agent-watcher` (nav
entry "Agent watcher", right after Terminal). One row per live session, then
its subagents (`↳`), then its shells (`⌁`); children are always depth 1. A
5m / 15m / 1h toggle picks the window; the page polls every 5s. It is a
**separate surface**: nothing of the Agents panel (`AgentSidebar`,
`GET /api/agents`, `AgentSession`/`AgentChild`) changed.

## Endpoint

`GET /api/agents/watch?minutes=N` — default 15, clamped 1..=60. Gated by
`require_agent_access` like every agents route; no `claude` binary is the same
502 `unavailable` as `/api/agents`. It reads the same 2s-cached panel list
(`panel_sessions` in `src/api.rs`, factored out of `list_all_agents`, whose
output is byte-identical) and runs `agents::watch` under `spawn_blocking`.

Payload (`AgentWatch`, ts-exported, camelCase, **all times Unix seconds**):
`now`, `windowMinutes`, `rows[]`. A row (`AgentWatchRow`): `key` (`sid`,
`sid/<agent id>`, `sid/pid:<n>`, or `sid/cmd:<name>` when no process matched),
`kind` (`session|subagent|shell`), `sessionId`, `parent` (the session key, for
children), `label` (sanitized, bounded), `detail`, `model`, `startedAt`,
`runs` (`[start, end]` working stretches inside the window, empty for a shell),
`lastEventAt` (newest event, any age), `historyFrom`, `outputAt` (shells),
`finished`.

## What goes in

A session is included when `watch_includes`: it has a `pid` and is either not
`done` or still holds a running child (upstream says `done` the moment a turn
ends while its work goes on). Subagent rows are every `subagents/*.jsonl`
touched within the window; shell rows are the session's shell children.

Transcripts are read through `cc::watch_thread` (a 2 MiB tail via `read_tail`,
fail-open): every parseable `assistant`/`user` line with a timestamp is an
event; the session's own file skips sidechain lines (the `pulse_from_text`
rule), a subagent file keeps them. `runs` are the events inside the window
coalesced by `coalesce_runs` — the same arithmetic and gap
(`cc::THREAD_IDLE_GAP_SECS`) as the session timeline's `active_intervals`.

## Segment states (`frontend/src/agentWatch.ts`)

- **active** — solid, the model colour (`modelColor`): inside a run. A run that
  ended less than `QUIET_GAP_S` before the end of an unfinished row is extended
  to now.
- **waiting** — hatched model colour: a session's gap covered by a running
  child (a subagent from its start to its last event/now, a shell from its
  start to now).
- **quiet** — amber: an uncovered gap.
- **output** — green: a shell whose output file is being written.
- **stalled** — red hatch: a shell whose output is older than `SHELL_STALL_S`.

A row starts at the later of the window start, its own `startedAt` and
`historyFrom` (set only when the tail read was cut, so unknown history is not
painted as quiet); a finished subagent ends at its last event.

Constants and why: `QUIET_GAP_S = 60` mirrors the server's idle gap;
`SHELL_STALL_S = 60` the same scale for a shell; `ALL_QUIET_ALERT_S = 300`
raises the on-page banner ("Nobody is working…") when every unfinished row has
been quiet or waiting that long. A shell with no readable output signal never
shows red and suppresses the banner (silence cannot be told from a long quiet
build).
The banner is page-only: no server-side alert, no inbox item.

## Shell output probe

Claude Code writes a Bash call's stdout to
`/private/tmp/claude-<uid>/<slug>/<session>/tasks/<id>.output`. A shell child is
matched to its `ps` row (`ppid` = the session pid and the same sanitized
command line, one row per child) from **one** `read_proc_table()`; then one
`lsof -a -p <pids> -d 1 -Fpn` names fd 1 of every matched pid. `parse_lsof`
keeps only paths containing `/tasks/` and ending `.output`; `output_at` is that
file's mtime. No `lsof`, no match, a tty or pipe — `output_at` is `null`. This
relies on a Claude Code internal convention, not a contract.

## Limits

No finished-shell history (a shell leaves `ps` the moment its call returns),
shells always hang under their session, the transcript tail is 2 MiB (older
history is cut and flagged by `historyFrom`), no cost figures, no CLI command,
no config keys, no phone tab-bar entry.

## Tests

`cc.rs` (`coalesce_runs`, `watch_from_text`), `agents.rs` (`watch_includes`,
`parse_lsof`), `frontend/src/agentWatch.test.ts`, and a section of
`scripts/agents-check.sh` (route, parent links, window clamp, foreign Host).
