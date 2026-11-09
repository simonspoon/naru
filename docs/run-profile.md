# Run profile (naru task 2647)

A project with a long-running dev server keeps serving old code after a task
lands until someone restarts it. A **run profile** makes the queue watcher do
that restart and say whether it worked.

## Setting it

```bash
naru project update <project> --run-restart ./scripts/restart.sh \
  --run-health http://127.0.0.1:7880/health [--run-dir <dir>]
naru project update <project> --run-health ""    # clear one part
naru project update <project> --run-restart ""   # remove the whole profile
```

- `restart` (required): a shell command, run as `bash -c <restart>`. It must
  stop the old server itself and start the new one, for example
  `pkill -f scripts/serve.py; nohup python3 scripts/serve.py &`.
- `dir`: where it runs; defaults to the project's `local_path`.
- `health`: an `http(s)://` URL that answers 2xx once the new server is up.
  Optional; with none the outcome is "restarted (no health URL to check)".

The profile is on `Project.run_profile` (`null` = none) in every project read.
It is **CLI-only**: it is a shell command, so `PATCH /api/projects/{id}`
ignores it and the web UI cannot set it.

`Store::update_project` (through `core::run_profile::patched`) rejects with
`validation`: a `--run-dir`/`--run-health` on a project with no restart
command, an empty restart command, `--run-restart ""` combined with another
`--run-*` flag, a health URL that is not `http(s)://`, and
any profile naming the person's real install (`com.naru.`, `com.mesa.`,
`install.sh`, `self-deploy`, `~/.local/bin/naru|mesa`, `/Applications/Naru.app`,
`:7777`, `:7870`; `docs/dev-env.md`). The same check runs again before a
restart. This is a guardrail against mistakes, not a security boundary.

## When it fires

Only for tasks the queue watcher dispatched (`serve --watch-queue`). The
first reaper pass (`todo_reaper_tick`) that sees a dispatched task `done`
hands it to a pending set (`AppState::run_landings`) that outlives the
dispatch entry. Every pass then checks each pending landing
(`api::run_landings_tick` / `fire_run_profile`):

- no task, or its project has no profile: dropped;
- no commit citing `task <id>` since its claim in the history of the
  project `local_path`'s checked-out `HEAD`
  (`git::commit_citing_task_in_head`, the landing digest's match limited to
  `HEAD`; a commit still on a worktree branch is not the code being served):
  waits;
- a restart of the same project still running: waits (one restart per
  project at a time);
- otherwise: fires, once.

A landing still waiting after 15 minutes is dropped with the task note
`Run profile: not restarted: no commit citing task <id> reached the
project's checked-out HEAD within 15 minutes.`

A task closed by hand, outside the watcher, restarts nothing. No profile, no
behaviour change. Pending landings live in the serve process: a serve
restart forgets them.

## What it does

On a thread of its own (never holding the store lock):

1. Spawns the command detached: own process group, stdin null, stdout and
   stderr appended to `logs/run-<project id>.log` in Naru's home
   (`~/.naru`), after a `--- <time> restart: <cmd>` header line. Naru does not
   wait for it to exit: the command may be the server itself.
2. Polls the health URL every 0.5 s, for up to 30 s from the spawn
   (`MESA_RUN_HEALTH_WAIT_MS` / `NARU_RUN_HEALTH_WAIT_MS` shortens it, a
   test-only seam). Probes start when the command exits 0, or after 5 s if it
   is still running (taken to be the server itself). The old server must
   be gone by then, or its answer counts for the new one, so a restart
   command should stop the old server first. A command that exits non-zero
   is the answer.
3. Records the outcome as a task note `Run profile: <outcome>.` and, when a
   live session exists, a live result
   `Task <id> landed in <project> (commit <sha>): <outcome>.`

Outcomes: `restarted, healthy (HTTP 200 from <url>)`,
`restarted, but <url> was not healthy after 30.0s: <HTTP code | error>`,
`restart command exited <code> (log: <path>)`,
`restarted (no health URL to check)`, or `not restarted: …`.

## Gate

`scripts/queue-watcher-check.sh`, section "run profile": a real
`python3 -m http.server` restarted after a dispatched task lands (new pid,
old one gone, health 200, the note, the live result, the log line, fired
once), a commit on a worktree branch waiting until it is merged, a 404
health URL and a failing command reported, the validation refusals, and no
profile restarting nothing. Unit tests:
`core::run_profile::tests`.
