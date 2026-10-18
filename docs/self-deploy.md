# Safe self-redeploy (`scripts/self-deploy.sh`)

Naru tasks 2039 + 2040, parts of task 2035. Gate: `scripts/self-deploy-check.sh`.

Order: build + checks (nothing changed on failure) → `queue pause` → wait for
`queue idle` (`NARU_DEPLOY_DRAIN_TIMEOUT`, default 600 s; timeout = `aborted`, queue
resumed) → db backup → atomic binary swap (`naru.prev` kept) → restart via
`NARU_DEPLOY_RESTART_CMD` (unset on macOS with the `com.naru.serve` launchd agent installed
= `launchctl kickstart -k gui/$(id -u)/com.naru.serve`, see `docs/launchd.md`; unset with no
agent = cannot restart = unhealthy) → `naru workflow defaults --task-loop` with the new binary → health
(`/api/version` on `NARU_DEPLOY_PORT` reports the new version, or `NARU_DEPLOY_HEALTH_CMD`
with `NARU_DEPLOY_EXPECT`; and, if a live conversation was open before, its `agent_id`
changed — i.e. the live supervisor respawned it; `NARU_DEPLOY_LIVE_CHECK=0` skips) within
`NARU_DEPLOY_HEALTH_TIMEOUT` (60 s) → `queue resume`.

Unhealthy: `naru.prev` is restored (re-signed), the db backup replaces the db (stale
`-wal`/`-shm` removed), the server is restarted and checked, the queue resumed, verdict
`rolled_back` (exit 1). If that is unhealthy too: `rollback_failed`, queue left paused.
Queue verbs run on the NEW binary, since the installed one may predate `queue`.
Verdict JSON: `status`, `reason`, `db_backup`, `binary_backup`, `restarted`, `healthy`,
`queue_resumed`.
