# Agent runner (`naru run`, naru task 1686)

A *run* is one `claude -p` session held open on stream-json stdin by a small
detached process of the same binary, so an agent keeps working when the Naru
server — or the CLI that started it — dies. This is infrastructure: the
existing `spawn_bg` sites and `llm::complete` do not use it yet.

## Files are the truth

`<naru home>/runs/<job-id>/` (`~/.naru/runs`, or `~/.mesa/runs` on an install
that predates the rename). No database table: the surface works with no server
running, and a restarted server reattaches by reading the same files.

| File | Content |
| --- | --- |
| `job.json` | `job_id` (8 hex), `session_id` (v4 uuid), `cwd`, `model`, `name`, `status` (`running` `idle` `finished` `failed` `stopped`), `runner_pid`, `claude_pid`, `started_at` / `updated_at` / `finished_at` (unix seconds), `last_result` / `last_subtype` / `last_is_error`, `resumes`, `idle_timeout_secs`. Written by the runner alone once it is up, atomically |
| `events.jsonl` | every stdout line of claude, verbatim, plus runner lines `{"type":"naru_runner","event":…,"at":…}` (`claude_started`, `message_delivered`, `stop_requested`, `idle_timeout`, `resumed`, `exited`, `failed`) |
| `inbox/` | pending user messages, one `<nanos>-<rand>.json` (`{"text":…}`) each, written by temp+rename; the runner moves one to `inbox/delivered/` **before** writing it to claude, so a resume never delivers it twice (a crash in between loses it rather than repeating it) |
| `stop` | marker: wind down |
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
- nothing is in flight and `idle_timeout_secs` (default 3600, `run start
  --idle-timeout`) have passed since the last result — `finished`;
- claude exits on its own — `failed`.

A terminal run refuses further messages (`conflict`).

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
claude -p --input-format stream-json --output-format stream-json --verbose --model {model} --name {name} {session_flag} {session_id}
```

`{session_flag}` is `--session-id` on the first start and `--resume` after; a
value is one shell-quoted word, so the flag is a placeholder of its own rather
than a bash `if`. As for the other defaults, `MESA_CLAUDE_BIN` replaces the
leading `claude` of the *default* template only. There is no `--bare`; no
permission flag either — add one (e.g. `--permission-mode acceptEdits`) in
Settings for a run that must write files.

## Surfaces

CLI (JSON out, `--quiet` accepted and ignored): `naru run start --model M [--cwd D]
[--name L] [--idle-timeout S] <prompt>`, `send <job> <message>`, `show <job>
[--events] [--tail N]`, `list`, `stop <job>`, `reconcile`. Every job view carries
derived `runner_alive` and `pending_messages`.

API, every route `require_agent_access` (reads included — a run executes an
agent): `GET /api/runs`, `POST /api/runs` (body of `start`, 201), `GET
/api/runs/{id}[?tail=N]` (`{job, events}`, 500 events by default), `POST
/api/runs/{id}/message` (`{"text"}`, 202), `POST /api/runs/{id}/stop`.

Gate: `scripts/runner-check.sh`.
