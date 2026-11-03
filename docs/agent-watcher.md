# Agent watcher (naru tasks 1909, 2541)

A live map of the whole machine, a dock panel (`watcher`, starts closed; reopen from the header `⋯` menu) and, on the phone tier, a full page at `#/agent-watcher` (nav
entry "Agent watcher", right after Terminal). Since naru task 2541 the page
draws the **orbit** (below, "Orbit page") from `GET /api/agents/orbit`; the
per-session timeline it drew before is gone from the page, but its endpoint
`GET /api/agents/watch` stays — the orbit feed is built on it. It is a
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
`sid/<agent id>`, `sid/pid:<n>`, or `sid/cmd:<i>:<name>` (child index) when no process matched),
`kind` (`session|subagent|shell`), `sessionId`, `parent` (the session key, for
children), `label` (sanitized, bounded), `detail`, `model`, `startedAt`,
`runs` (`[start, end]` working stretches inside the window, empty for a shell),
`lastEventAt` (newest event, any age), `historyFrom`, `outputAt` (shells),
`finished`, `tools` (`[start, end, name, summary]` other tool calls, below).

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

## Tool calls

`cc::watch_from_text` also pairs each `tool_use` block with its `tool_result`
(`tool_use_id`) into `tools`: `[start, end, name, summary]`, the two line timestamps; `summary` is a one-line
digest of the call's `input` (`cc::watch_tool_summary`: the `tool_target` key list —
`command`, `file_path`, `pattern`, `skill`, `url`, `query`… — `subagent_type: description`
for `Agent`, else the first string value; sanitized, capped at 200 chars, empty if none). `end`
is `-1` while no result has arrived (drawn to now, or to the last event of a
finished row). A subagent launch (`Agent`/`Task`) and a `run_in_background`
call are left out (they have their own row/segment); calls ending before the
window are dropped and the newest 300 per transcript kept.

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

At most the newest 50 subagent transcripts (by mtime) are read per session; they are walked back at least 30 minutes (a delegate mid-long-call writes nothing) and a finished one with no event in the window is dropped. No finished-shell history (a shell leaves `ps` the moment its call returns),
shells always hang under their session, the transcript tail is 2 MiB (older
history is cut and flagged by `historyFrom`), no cost figures, no CLI command,
no config keys, no phone tab-bar entry.

## Orbit feed (naru task 2540)

The data half of the watcher redesign (the orbit view; the page that draws it
is naru task 2541, "Orbit page" below). It
describes the whole machine as **jobs**, not tool-call rows.

`GET /api/agents/orbit` — gated by `require_agent_access` like every agents
route. It reads the same 2s-cached panel list (`panel_sessions`) and runs
`agents::watch` over it with a 60-minute window (`ORBIT_WATCH_MINUTES`, so a
job's finished stages stay on its ring), then `core::orbit::from_store`
assembles the rest from the store. An unreadable session list (no `claude`)
is **not** a 502 here: `agentsAvailable` is `false`, jobs are still listed
(state `idle`, no agents) and the queue is whole.

Payload (`AgentOrbit`, ts-exported, camelCase, times Unix seconds unless
said): `now`, `naru`, `agentsAvailable`, `jobs[]`, `queue[]`, `projects[]`.

- **`naru`** (`OrbitNaru`): `active`, `sessionId`, `projectId`, and `state` —
  `off` (no live session), `speaking` (the newest Naru turn is unplayed and
  younger than `orbit::SPEAKING_SECS` = 30 s; an older unplayed one was never
  played, so it is not speech), `resting` (`resting_since`), `working`
  (`working_since`: the agent holds a turn), else `listening`.
- **`jobs`** (`OrbitJob`): `kind` `task` or `workflow`, `id` (task id or run
  id), `workflowId`, `title`, `projectId`/`projectName`, `color`, `stage`,
  `progress` (0..1), `progressEstimated`, `state`, `sessionId`, `startedAt`,
  `agents[]`.
  - A **task job** is every `in_progress` task of a visible project, except an
    umbrella (a parent with subtasks) that no session works — it shows through
    its children, the queue-watcher's leaf rule. A session works a task when
    the task's `owner` is its id (`AgentSession::task_id`), its name is the
    stage driver's `task <id> · <stage> (<agent>)`, or it is the
    queue-watcher's `<project>: <task name>` (only for a session that owns
    no task yet). With several stage-driver sessions, the newest one's stage
    wins.
  - Its **agents** are the watcher's subagent rows of those sessions:
    `role` from the `agentType` (`orbit::role_of`: recon/Explore → `recon`,
    planner/Plan/ux-designer → `plan`, implementer → `build`, diff-reviewer →
    `review`, verifier → `test`, ui-verifier → `check`, else `agent`),
    `label` (the agentType), `detail` (its description), `state` `done`
    (finished), `working` (an event within `orbit::QUIET_SECS` = 60 s) or
    `waiting` (unfinished and quiet longer).
  - **Stage**: a stage driver's declared stage, else the newest unfinished
    agent's role, as `recon` `plan` `build` `review` `verify` (test and
    check) or `working`.
  - **Progress**: with subtasks, done ÷ non-cancelled subtasks
    (`progressEstimated: false`). Otherwise an estimate from the furthest
    stage seen (recon .15, plan .25, build .5, review .7, verify .85; .05
    before any) — a guess, flagged `progressEstimated: true`.
  - **State**, the most urgent over its sessions: `waiting` (blocked on the
    person: `state: blocked` or `waiting_for`), `stalled` (the queue-watcher's
    watchdog), `working`, else `idle` (no session, or one whose turn ended
    with nothing running).
  - A **workflow job** is every `running` workflow run of a visible workflow:
    `stage` is the running node's title, `progress` the steps that ended
    (ok, failed or skipped) ÷ the workflow's nodes (comment boxes excluded), `state` `waiting` while a gate
    of the run is pending, else `working`; its `agents` are the run's steps
    (`role` = node kind, `working` while running, else `done`; skipped steps
    left out).
- **`queue`** (`OrbitQueued`): every `todo` task of a visible project
  (`blocked` from the derived flag), then every enabled `time`-triggered
  workflow not running now, with its `nextRunAt` (stored UTC text). It carries
  **no order numbers**: projects run concurrently, so a position would mean
  nothing; the order is the task list's, then workflows by name.
- **`projects`** (`OrbitProject`): each project a job or queued item names,
  in project-list order, with its `color`.

**Colour**: `orbit::project_color` — `PROJECT_COLORS[project id % 8]`, so a
project keeps its colour wherever it appears and however lists are filtered.
Naru's own purple (`#a371f7`) is not in the palette; a global workflow is
`orbit::GLOBAL_COLOR` (`#8b949e`). Every item carries its colour, so the page
never recomputes it.

System sparklines come from `GET /api/system/stats` (`docs/system.md`).

## Orbit page (naru task 2541)

`frontend/src/pages/AgentWatcherView.tsx` draws; `frontend/src/agentOrbit.ts`
holds every position and grouping (pure, tested). Both feeds poll every 5 s
while the panel is visible.

- **Naru** at the centre of an SVG (viewBox 1000×1000) with five voice bars:
  still and grey when no live session (`off`), a slow pulse while live, fast
  while `speaking`. No "waiting on you" tag.
- **Jobs** evenly on the ring from the top, clockwise (from seven jobs it
  turns half a step so none sits level with Naru). Each node: a progress ring
  in the job's colour with the percent inside, a glow while `working`, dimmed
  when `idle`. Its title and `project · stage` sit on the **inner** side
  (below the node in the top half, above it in the bottom half); the stage
  line says `needs you` (amber) or `stalled` (red) instead when the state is
  that. Titles clip by crowding (`titleChars`: 16, 14, then 11 characters).
- **Sub-agent dots** cluster on the job's outer side, 14° apart, labelled by
  role (a workflow step: its node title), `✓` when done. Glowing in the job's
  colour = working, dashed grey = waiting, grey = done. `maxDots` caps a
  cluster by the room on the ring (6 alone, 4 with five jobs, 2 with eight);
  unfinished agents are kept first, then the newest done.
- **No overlaps**: `agentOrbit.test.ts` lays out 1–8 jobs with full clusters
  and asserts no two painted boxes (estimated text widths) meet and all stay
  inside the viewBox.
- **Stats** (side panel, above the queue): CPU, memory and GPU sparklines
  over the stats history and a disk bar, each with its newest percent; GPU
  says "unavailable" when the host cannot report it.
- **Queue** (side panel, below the orbit when narrow): no numbers. Tasks
  under one heading per project in project-list order, heading tinted with the
  project colour, each item with a project-coloured left bar; a blocked task
  is dimmed. Every timed workflow under one grey "Workflows" heading, grey bar,
  dashed outline.
- Project colours are the feed's (the agent palette, theme-independent);
  every text colour is a theme variable, so light and dark both read.
- A job links to its task panel or workflow; a queued item likewise.

## Tests

`cc.rs` (`coalesce_runs`, `watch_from_text`, tool pairing), `agents.rs` (`watch_includes`,
`parse_lsof`), `orbit.rs` (colours, stage names, roles, and one store-backed
scenario through `from_store`), `api.rs` (`/api/agents/orbit` pairing and
Host refusal), `frontend/src/agentOrbit.test.ts` (layout, overlap, queue
grouping, sparklines), and a section of
`scripts/agents-check.sh` (route, parent links, window clamp, foreign Host).
