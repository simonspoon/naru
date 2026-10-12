# Agent runner (`naru run`, naru task 1686)

A *run* is one `claude -p` session held open on stream-json stdin by a small
detached process of the same binary, so an agent keeps working when the Naru
server — or the CLI that started it — dies. This is infrastructure: the
existing `spawn_bg` sites and `llm::complete` do not use it yet. In particular
the todo-watcher still dispatches with `claude --bg`; moving it onto runs is a
separate decision.

## Files are the truth

`<naru home>/runs/<job-id>/` (`~/.naru/runs`, or `~/.mesa/runs` on an install
that predates the rename). No database table: the surface works with no server
running, and a restarted server reattaches by reading the same files.

| File | Content |
| --- | --- |
| `job.json` | `job_id` (8 hex), `session_id` (v4 uuid), `cwd`, `model`, `agent` (when `--agent` was given), `name`, `status` (`running` `idle` `finished` `failed` `stopped`), `runner_pid`, `claude_pid`, `started_at` / `updated_at` / `finished_at` (unix seconds), `last_result` / `last_subtype` / `last_is_error`, `resumes`, `idle_timeout_secs`. Written by the runner alone once it is up, atomically |
| `events.jsonl` | every stdout line of claude, verbatim, plus runner lines `{"type":"naru_runner","event":…,"at":…}` (`claude_started`, `message_delivered`, `stop_requested`, `interrupt_requested`, `idle_timeout`, `resumed`, `exited`, `failed`) |
| `inbox/` | pending user messages, one `<nanos>-<rand>.json` (`{"text":…}`) each, written by temp+rename; the runner moves one to `inbox/delivered/` **before** writing it to claude, so a resume never delivers it twice (a crash in between loses it rather than repeating it) |
| `stop` | marker: wind down |
| `interrupt` | marker: cut the turn in flight short (naru task 1828) |
| `message-pending` | marker: a message was delivered while a turn was in flight (naru task 1868); see "Surfacing a mid-wait message" |
| `runner.pid`, `runner.log`, `claude.log` | the runner's pid, its stdout/stderr, claude's stderr |

## Detach

`naru run start` creates the directory (first prompt in the inbox) and spawns
`naru run __runner <dir>` (hidden subcommand) with `process_group(0)`, stdin
null, stdout/stderr to `runner.log`. It is never waited on by anything that
matters (a reaping thread only keeps a long-lived server from holding a zombie,
which `kill -0` would read as alive). The runner starts claude in its own
process group too (`kill -- -pgid` reaches claude and its children), with piped
stdin/stdout. `runner-check.sh` kills the serve with `-9` mid-turn and the run
carries on.

## The runner loop

Delivers inbox messages in order as stream-json user lines
(`{"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}`),
appends stdout to `events.jsonl`, and keeps `status`: `running` while a turn is
in flight, `idle` after a `{"type":"result"}` line (recording `last_result`,
`last_subtype`, `last_is_error`). It exits when:

- the `stop` marker appears: stdin closes, claude gets 5s, then its group is
  killed — `stopped`;
- nothing is in flight, no background task is running and `idle_timeout_secs`
  (default 3600, `run start --idle-timeout`) have passed since the last line
  claude wrote — `finished`. Every claude line resets that clock, not only a
  `result`; a `system/init` line opens a turn the runner did not start itself
  (a background subagent's notification waking claude), so the run reads
  `running` through it; and the idle end is held off while the latest
  `background_tasks_changed` event's `tasks` list is non-empty (a background
  shell holds it too). `run stop` still ends such a run (naru task 1862);
- claude exits on its own — `failed`.

A terminal run refuses further messages (`conflict`).

**Interrupt** (naru task 1828): `runner::interrupt_in` writes the `interrupt`
marker — a terminal run is `conflict`, an idle one a no-op, a running one gets
the marker. The runner loop turns the marker into one stream-json line,
`{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}`,
**only while a turn is in flight**, and logs `interrupt_requested`; a stale
marker is removed at runner start. Real claude answers a `control_response`
and then a `result` (subtype `error_during_execution`), so the run returns to
`idle` with the session intact.

**Warning:** in real `claude -p` an interrupt also kills the interrupted turn's
background subagents and shells (naru task 1866's trial). Do not interrupt —
by `run interrupt` or `send --interrupt` — while agents you still need are
running.

**Send with interrupt** (naru task 1863): `naru run send --interrupt <job>
<message>` / `{"text":…,"interrupt":true}` writes the flag into the inbox file.
If a turn is in flight the runner sends the same `control_request` first
(`interrupt_requested`, `source: "message"`), holds that message and any behind
it until the cut turn's `result` or 10 s (`INTERRUPT_HOLD`), then delivers it
as a fresh turn. With no turn in flight it is an ordinary send.

## Surfacing a mid-wait message

The runner exports `NARU_RUN_DIR` (the job directory) into claude's
environment. When it delivers a message while a turn is in flight it creates
`<job>/message-pending`, removed on the next main-thread assistant line (a
subagent's lines do not count) or the turn's `result`. claude reads stdin only
between tool calls, so a plain send during a long blocking wait is held until
the wait returns; a wait that checks the marker can end early. The
`supervising-agent-teams` built-in's `waiting.md` loops do: they exit with
`MESSAGE` when `$NARU_RUN_DIR/message-pending` exists. Measured with real
claude (naru task 1868): a plain send during such a wait was answered in
5.3-6.2 s; without the check it was unanswered at 91 s. A wait that does not
check the marker still holds the message until it returns.

## Telemetry

The runner's `claude -p` writes an ordinary transcript,
`~/.claude/projects/<slug>/<session>.jsonl` (naru task 1827), so the cc
dashboard ingests runner sessions with their cost; `claude agents --json --all`
also lists the `-p` session (kind `interactive`) — the Agents panel drops that
row in favour of the runner's own (`docs/agents.md`).

## Reattach and resume

`naru serve` start-up (and `naru run reconcile`) scans `runs/`. A non-terminal
run whose runner pid is dead gets a new detached runner on the same directory.
The runner sees `claude_started` and launches claude with `--resume <same
session id>`, after killing any leftover claude group from the dead runner. If
the interrupted turn had no result (`status` was `running`) the resumed session
is first told to continue where it left off, then the undelivered inbox follows.
`resumes` counts, and a `resumed` event is logged. A run whose runner is alive is
left alone.

If the resumed claude exits without a word and the run never completed a turn,
the session was never saved (the old runner died first): the runner logs a
`resume_fallback` event, puts the delivered messages back in the inbox and starts
the same uuid fresh with `--session-id`. (If a `--resume` fails for another
reason on a session that *was* saved, claude may refuse the reused id and the run
ends `failed`.)

One runner per job: it holds an exclusive `runner.lock`, so a second one exits
quietly. Pids read from `runner.pid` / `job.json` are only acted on if `ps`
shows `__runner` / the run's session id. `model` and `name` may not start with
`-`.

## The `runner` config template

The ninth template (`docs/config.md`):

```
run_agent={run_agent}
claude -p --input-format stream-json --output-format stream-json --verbose ${run_agent:+--agent "$run_agent"} --model {model} --name {name} {session_flag} {session_id}
```

`{run_agent}` is the run's `--agent` name (naru task 1861; not `{agent}`, a
retired placeholder), the empty string when none was given. The default is two
lines: the first captures it as `run_agent={run_agent}`, and the `claude` line
carries `${run_agent:+--agent "$run_agent"}`, so the flag is emitted only when
set. `job.json` keeps the agent, so a resume starts the same one.

`{session_flag}` is `--session-id` on the first start and `--resume` after; a
value is one shell-quoted word, so the flag is a placeholder of its own rather
than a bash `if`. As for the other defaults, `MESA_CLAUDE_BIN` replaces the
`claude` word that starts a line of the *default* template only. There is no `--bare`; no
permission flag either — add one (e.g. `--permission-mode acceptEdits`) in
Settings for a run that must write files.

## Surfaces

CLI (JSON out, `--quiet` accepted and ignored): `naru run start --model M [--cwd D]
[--name L] [--agent A] [--idle-timeout S] <prompt>`, `send <job> <message>
[--interrupt]`, `show <job> [--events] [--main] [--tail N]`, `list`, `stop <job>`, `interrupt <job>`, `reconcile`. Every job view carries
derived `runner_alive` and `pending_messages`.

API, every route `require_agent_access` (reads included — a run executes an
agent): `GET /api/runs`, `POST /api/runs` (body of `start`, 201), `GET
/api/runs/{id}[?tail=N][&scope=main|all]` (`{job, events}`, 500 events by
default; any other `scope` is 422), `POST
/api/runs/{id}/message` (`{"text"[,"interrupt":true]}`, 202), `POST /api/runs/{id}/stop`, `POST /api/runs/{id}/interrupt` (six routes).

`--main` / `scope=main` (naru task 1864) drops the lines of subagents — those
with a string `parent_tool_use_id`, or `owned_by_subagent: true` — from the
returned view only; `events.jsonl` stays verbatim, and `--tail` counts after
the filter. `--main` implies `--events`. `POST /api/runs` also takes `agent`.

The run pane (`RunPane.tsx`, `runEvents.ts`, naru task 1865) folds a
subagent's events under the `Agent` call that launched it ("label · N events");
events whose launching call is not in the view sit in an "earlier subagent"
group.

Gate: `scripts/runner-check.sh`.
