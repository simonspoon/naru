#!/usr/bin/env bash
# queue gate (naru task 2038, docs/queue-drain.md): `naru queue pause|resume|idle`
# against a throwaway HOME and db. No serve. Covers: fresh state, idempotent
# pause/resume, the marker persisting across invocations, idle exiting 1 for an
# in_progress task and for a running workflow run with a live owner pid (not
# a dead one), and 0 once both are gone. The dispatch gate itself is the Rust
# test `queue_watcher_tick_withholds_dispatch_while_paused`.
set -euo pipefail
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')
cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
cargo build --quiet
N="$PWD/target/debug/naru"
SQL=/usr/bin/sqlite3
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" MESA_DB="$TMP/mesa.db" MESA_CONFIG_FILE="$TMP/no-config.json"
mkdir -p "$HOME"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
idle_code() { set +e; $N queue idle >"$TMP/out" 2>/dev/null; IDLE_RC=$?; set -e; }

idle_code; [ $IDLE_RC = 0 ] || fail "fresh idle exit $IDLE_RC"
[ "$(jq .paused "$TMP/out")" = false ] || fail "fresh paused"
ok "fresh state idle, not paused"

[ "$($N queue pause | jq .paused)" = true ] || fail "pause"
[ "$($N queue pause | jq .paused)" = true ] || fail "pause idempotent"
idle_code; [ "$(jq .paused "$TMP/out")" = true ] || fail "idle reports paused (separate invocation)"
[ $IDLE_RC = 0 ] || fail "paused is still idle"
ok "pause idempotent and persisted"
[ "$($N queue resume | jq .paused)" = false ] || fail "resume"
[ "$($N queue resume | jq .paused)" = false ] || fail "resume idempotent"
idle_code; [ "$(jq .paused "$TMP/out")" = false ] || fail "resume cleared"
ok "resume clears"

P=$($N project create qcheck --no-git | jq .id)
T=$($N task create "$P" "queue check task" | jq .id)
$N task update "$T" --status in_progress >/dev/null
idle_code; [ $IDLE_RC = 1 ] || fail "in_progress should not be idle (rc $IDLE_RC)"
[ "$(jq .in_progress "$TMP/out")" = 1 ] || fail "in_progress count"
$N task update "$T" --status done --no-artifact gate >/dev/null
idle_code; [ $IDLE_RC = 0 ] || fail "done task idle (rc $IDLE_RC)"
ok "in_progress task blocks idle"

$SQL "$MESA_DB" "INSERT INTO workflows(name) VALUES('q');" 2>/dev/null || true
W=$($SQL "$MESA_DB" "SELECT id FROM workflows LIMIT 1;")
if [ -z "$W" ]; then W=$($N workflow create qwf | jq .id); fi
sleep 60 & LIVE=$!
$SQL "$MESA_DB" "INSERT INTO workflow_runs(workflow_id,trigger,status,started_at,owner_pid) VALUES($W,'manual','running',datetime('now'),$LIVE);"
idle_code; [ $IDLE_RC = 1 ] || fail "live run should not be idle (rc $IDLE_RC)"
[ "$(jq .runs_active "$TMP/out")" = 1 ] || fail "runs_active"
kill $LIVE; wait $LIVE 2>/dev/null || true
idle_code; [ $IDLE_RC = 0 ] || fail "dead-owner run should be idle (rc $IDLE_RC)"
ok "live run blocks idle, dead owner does not"
echo "queue-check: all passed"
