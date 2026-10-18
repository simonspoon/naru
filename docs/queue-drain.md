# Queue drain (`naru queue`)

Naru task 2038, part 1 of the safe self-redeploy (task 2035, `docs/self-deploy.md`).

- `naru queue pause` / `naru queue resume` — idempotent; print `{"paused": bool}`. The
  todo-watcher's dispatch (`todo_watcher_tick`) claims nothing while paused, read
  fresh every tick. The reaper and the other watchers keep running; sessions already
  dispatched are not stopped.
- `naru queue idle` — prints `{"idle", "in_progress", "runs_active", "paused"}`; exit 0
  only when no task is `in_progress` and no `workflow_runs` row is `running` with a live
  `owner_pid` (a dead or missing owner is abandoned, not active). Exit 1 otherwise —
  data, not an error.
- Persistence: the marker file `<naru home>/queue-paused` (beside the `drain` marker of
  `self-deploy`; no expiry, no migration). `--quiet` is accepted and ignored.

After an install, re-run `naru workflow defaults --task-loop` so the Notify live agent
node exists. Gate: `scripts/queue-check.sh`; dispatch gate: Rust test
`todo_watcher_tick_withholds_dispatch_while_paused`.
