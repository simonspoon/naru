# Stage driver (`naru stage run`, naru task 1959)

The one thing a task-loop workflow agent node runs (`docs/task-loop-workflow.md`
sections 3 and 4). It starts an agent run exactly as `naru run start --agent`
does (in-process, `core::runner::start_in`), then watches it with the `run
wait` reading of the job directory (`docs/runner.md`) and prints one JSON
verdict. CLI only, no route; `--quiet` is accepted and ignored.

```
naru stage run --agent A --cwd D --deadline S --brief-file F
    [--silence S] [--max-restarts 1] [--grace 180]
    [--also AGENT2 --also-brief-file F2] [--scratch DIR] [--model sonnet] [--stage NAME]
```

Seconds are positive numbers (fractions allowed). A missing required flag is
usage (exit 2); an unreadable or empty brief file, or a non-positive duration,
is `validation` (exit 1). **Anything an agent does is data and exits 0**; only
a driver bug is nonzero.

## The ladder

1. **Start** the run from the brief file (its first message).
2. **Silence** (only with `--silence`): no new line from the agent in
   `events.jsonl` for that long (the runner's own `naru_runner` lines do not
   count) sends ONE plain nudge via `run send` — never `--interrupt`, which
   would kill the turn's background subagents. If the agent writes a line
   after it, it recovered and the silence clock restarts.
3. Still silent after `--grace`: `run stop`, then start again from the same
   brief (a new job, a new session), up to `--max-restarts`. After the last
   restart the same nudge-and-grace happens once more; a second silence ends
   the stage `INCONCLUSIVE`.
4. **Deadline** (`--deadline`, from the stage start): one "Deadline reached,
   report partial results now." nudge, then `--grace`, then `run stop`.
5. A run that goes idle or finishes with a result before that is `COMPLETE`
   and is stopped. A run that `failed`/`stopped` on its own ends `INCONCLUSIVE`.

An overrun is **always** `INCONCLUSIVE`, even when the agent answers the
deadline nudge: that answer is the `partial`, never a pass.

## Output

One agent prints
`{verdict, agent, job_id, job_ids, reason, report, partial, nudges, restarts, scratch}`:
`verdict` is `COMPLETE` (`report` set, `reason`/`partial` null) or
`INCONCLUSIVE` (`reason` says why, `report` null, `partial` is the newest
output or the deadline reply, possibly `""`). With `--also` the two agents run
concurrently (threads, each with its own deadline clock and restarts) and the
output is `{verdict, results: [<first>, <second>], scratch}`; the combined
verdict is `COMPLETE` only if both are.

Report text is capped so the printed document stays under 64 KiB (60 KiB split
across the agents), cut on a character boundary with a
`[truncated: N bytes omitted]` marker.

## `status.json`

`<scratch>/status.json` (default scratch: a fresh `naru-stage-<pid>` folder in
the temp dir, printed as `scratch`) is rewritten on every poll (250 ms) through
a temp file and a rename, so a reader never sees half of it. Shape, pinned by
`scripts/stage-check.sh`:

```
{"stage": "run", "updated_at": <unix>,
 "agents": [ {"agent", "job_id", "job_ids": [..], "state", "started_at",
              "last_event_at", "output_tail", "nudges", "restarts"} ]}
```

`agents` always holds one entry per agent (two with `--also`). `state` is
`starting`, `running`, `complete` or `inconclusive`; `job_id` is the current
run, `job_ids` every run the stage started; `output_tail` the last 500 chars of
the agent's newest assistant or result text; times are unix seconds.

Gate: `scripts/stage-check.sh` (stub `claude` via `MESA_CLAUDE_BIN`, tiny
silence/deadline/grace values).
