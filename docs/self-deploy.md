# Safe self-redeploy (`scripts/self-deploy.sh`)

Naru tasks 2039 + 2040, parts of task 2035. Gate: `scripts/self-deploy-check.sh`.

Order: build + checks (nothing changed on failure) → `queue pause` → wait for
`queue idle` (`NARU_DEPLOY_DRAIN_TIMEOUT`, default 600 s; timeout = `aborted`, queue
resumed) → db backup → atomic binary swap (`naru.prev` kept) → restart via
`NARU_DEPLOY_RESTART_CMD` (unset on macOS with the `com.naru.serve` launchd agent installed
= `scripts/launchd.sh restart`, a bootout + bootstrap of the installed plist + kickstart,
because a bare `kickstart -k` of a login-loaded agent after a binary swap is `spawn failed`
(naru task 2817, `docs/launchd.md`); `NARU_LAUNCHD_LABEL`/`NARU_LAUNCHD_DIR` pick the agent;
unset with no agent = cannot restart = unhealthy) → health
(`/api/version` on `NARU_DEPLOY_PORT` reports the new version, and its `commit` when both
the new binary's `--version` and the server report one (naru task 2655), or `NARU_DEPLOY_HEALTH_CMD`
with `NARU_DEPLOY_EXPECT`; and, if a live conversation was open before, it is
still `live` (same or new `agent_id` — the agent process survives a restart) and a
`live say` round trip reads back from `live turns`; `NARU_DEPLOY_LIVE_CHECK=0` skips) within
`NARU_DEPLOY_HEALTH_TIMEOUT` (60 s) → `queue resume`.

Unhealthy: `naru.prev` is restored (re-signed), the db backup replaces the db (stale
`-wal`/`-shm` removed), the server is restarted and checked, the queue resumed, verdict
`rolled_back` (exit 1). If that is unhealthy too: `rollback_failed`, queue left paused.
Queue verbs run on the NEW binary, since the installed one may predate `queue`.
`--dry-run` prints the plan, including `restart_cmd` (the resolved restart command, empty if
none) and `health_port`, resolved exactly as a real run would (naru task 2816).
Verdict JSON: `status`, `reason`, `db_backup`, `binary_backup`, `restarted`, `healthy`,
`queue_resumed`, `stale_runners`.

**From the live agent** (naru task 2816): rule 19 of `naru-live` (`docs/live.md`) makes
`naru self-deploy --repo <naru local_path>`, run in the background, its only deploy path; it
says the verdict's `status`, and its `reason` unless `swapped`. Never a release or push.

## Stale runners (naru task 2084)

A `naru run __runner` started before the swap keeps the old binary image (macOS TCC
then denies the old program's tree, e.g. Accessibility for `loki`). After a healthy
deploy, before `queue resume` (queue paused and idle), the new binary's `run list` is filtered to `running`/`idle` runs whose live
`__runner` pid started before the swap (`ps -o lstart=`). The live agent's run
(`run:<job>` in `live status`) is moved with `naru live handoff`; every other stale
runner is only recorded, because a stopped run is terminal and only a dead-runner
non-terminal run resumes (`docs/runner.md`), so nothing here ever stops a run. The
verdict's `stale_runners` lists `{job_id, name, agent, action}`, action `handed_off`,
`left_running` or `failed`, and a `live say` note tells the live agent. Failures never
fail the deploy; a rollback does nothing. `NARU_DEPLOY_RUNNERS=0` skips the step;
`NARU_DEPLOY_RUNNER_START_CMD` (pid as `$1`, prints the start epoch) is the test seam.

## PATH and db target (naru task 2046)

- Unless `--skip-checks`, the script prepends `~/.cargo/bin`, `~/Library/pnpm/bin` and `~/.local/bin` to `PATH` and exits 2 naming `cargo`/`node` if either is still missing, before anything is paused or changed.
- The db is resolved once, before the backup: `NARU_DEPLOY_DB`/`NARU_DB`/`MESA_DB`, else the `com.naru.serve` plist's `NARU_DB`/`MESA_DB`, else the platform-default db that exists (both holding data aborts). A rollback only overwrites that existing file — a missing target is `rollback_failed`, never a new db.
- The deploy no longer re-runs `workflow defaults`: `serve` installs and reseeds the managed built-ins on every start (naru task 2264 removed the Task loop ones).
