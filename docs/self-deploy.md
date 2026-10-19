# Safe self-redeploy (`scripts/self-deploy.sh`)

Naru tasks 2039 + 2040, parts of task 2035. Gate: `scripts/self-deploy-check.sh`.

Order: build + checks (nothing changed on failure) → `queue pause` → wait for
`queue idle` (`NARU_DEPLOY_DRAIN_TIMEOUT`, default 600 s; timeout = `aborted`, queue
resumed) → db backup → atomic binary swap (`naru.prev` kept) → restart via
`NARU_DEPLOY_RESTART_CMD` (unset on macOS with the `com.naru.serve` launchd agent installed
= `launchctl kickstart -k gui/$(id -u)/com.naru.serve`, see `docs/launchd.md`; unset with no
agent = cannot restart = unhealthy) → `naru workflow defaults --task-loop` with the new binary → health
(`/api/version` on `NARU_DEPLOY_PORT` reports the new version, or `NARU_DEPLOY_HEALTH_CMD`
with `NARU_DEPLOY_EXPECT`; and, if a live conversation was open before, it is
still `live` (same or new `agent_id` — the agent process survives a restart) and a
`live say` round trip reads back from `live turns`; `NARU_DEPLOY_LIVE_CHECK=0` skips) within
`NARU_DEPLOY_HEALTH_TIMEOUT` (60 s) → `queue resume`.

Unhealthy: `naru.prev` is restored (re-signed), the db backup replaces the db (stale
`-wal`/`-shm` removed), the server is restarted and checked, the queue resumed, verdict
`rolled_back` (exit 1). If that is unhealthy too: `rollback_failed`, queue left paused.
Queue verbs run on the NEW binary, since the installed one may predate `queue`.
Verdict JSON: `status`, `reason`, `db_backup`, `binary_backup`, `restarted`, `healthy`,
`queue_resumed`, `stale_runners`.

## Stale runners (naru task 2084)

A `naru run __runner` started before the swap keeps the old binary image (macOS TCC
then denies the old program's tree, e.g. Accessibility for `loki`). After a healthy
deploy, before `queue resume` (queue paused and idle, so no task-loop commit is in
flight), the new binary's `run list` is filtered to `running`/`idle` runs whose live
`__runner` pid started before the swap (`ps -o lstart=`). The live agent's run
(`run:<job>` in `live status`) is moved with `naru live handoff`; every other stale
runner is only recorded, because a stopped run is terminal and only a dead-runner
non-terminal run resumes (`docs/runner.md`), so nothing here ever stops a run. The
verdict's `stale_runners` lists `{job_id, name, agent, action}`, action `handed_off`,
`left_running` or `failed`, and a `live say` note tells the live agent. Failures never
fail the deploy; a rollback does nothing. `NARU_DEPLOY_RUNNERS=0` skips the step;
`NARU_DEPLOY_RUNNER_START_CMD` (pid as `$1`, prints the start epoch) is the test seam.

## PATH, db target and the Task loop reseed (naru task 2046)

- Unless `--skip-checks`, the script prepends `~/.cargo/bin`, `~/Library/pnpm/bin` and `~/.local/bin` to `PATH` and exits 2 naming `cargo`/`node` if either is still missing, before anything is paused or changed.
- The db is resolved once, before the backup: `NARU_DEPLOY_DB`/`NARU_DB`/`MESA_DB`, else the `com.naru.serve` plist's `NARU_DB`/`MESA_DB`, else the platform-default db that exists (both holding data aborts). A rollback only overwrites that existing file — a missing target is `rollback_failed`, never a new db.
- `workflow defaults --task-loop` gets `--project <id>` (the repo's project; unused since the loop became a managed global built-in, naru task 2103); it reseeds the built-in in place as a `seed` revision, and a pre-existing user-made `Task loop` is renamed `… (custom)` once, never deleted. A rollback restores the db backup, undoing the renames.
