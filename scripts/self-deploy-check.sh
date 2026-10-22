#!/usr/bin/env bash
# self-deploy gate (naru tasks 2039, 2040): scripts/self-deploy.sh under a
# throwaway HOME, db and PREFIX with a stub "new" binary (no real build):
# --dry-run changes nothing; a failing backup aborts with the install untouched;
# a pass backs up the db (valid), keeps naru.prev byte-equal to the old binary,
# installs the new one, restarts (stub hook), checks
# health and resumes the queue; an unhealthy new build is rolled back (binary and
# db byte-equal to before, queue resumed); a drain timeout aborts, resumes and
# changes nothing; a failed rollback leaves the queue paused; a user's workflows are
# never renamed or copied by a deploy; a missing cargo/node exits 2 early; a rollback restores only the
# db the server uses (never creating a second one) and refuses a missing target; after a
# healthy swap the live agent's runner is handed off and other stale runners recorded, never stopped.
set -euo pipefail
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')
cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
cargo build --quiet
SRC="$PWD/target/debug/naru"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" MESA_DB="$TMP/mesa.db" MESA_CONFIG_FILE="$TMP/no-config.json" PREFIX="$TMP/prefix"
mkdir -p "$HOME" "$PREFIX/bin"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
NARU="$PREFIX/bin/naru"
cp "$SRC" "$NARU"
"$NARU" project create tmp --no-git >/dev/null
# stub "new" binary: queue verbs on marker files ($TMP/busy = not idle), --version, defaults
cat >"$TMP/newbin" <<STUB
#!/bin/sh
case "\$1 \$2" in
  "queue pause") touch "$TMP/paused" ;;
  "queue resume") rm -f "$TMP/paused" ;;
  "queue idle") [ ! -e "$TMP/busy" ] ;;
  "workflow defaults") echo "\$*" >>"$TMP/defaults.log" ;;
  "workflow list"|"workflow update") exec "$SRC" "\$@" ;;
  "project resolve") echo '{"id":1}' ;;
  "live status") if [ -e "$TMP/live" ]; then echo '{"status":"live","agent_id":"run:same"}'; else echo '{"status":"none"}'; fi ;;
  "live say") [ ! -e "$TMP/say_fail" ] && echo '{"id":7}' ;;
  "live turns") echo '[{"id":6},{"id":7}]' ;;
  "run list") [ -e "$TMP/runs.json" ] && cat "$TMP/runs.json" || echo '[]' ;;
  "run stop") echo "\$*" >>"$TMP/runstop.log" ;;
  "live handoff") echo "\$*" >>"$TMP/handoff.log"; [ ! -e "$TMP/handoff_fail" ] ;;
  "--version "*) echo "naru 9.9.9" ;;
  *) echo new ;;
esac
STUB
chmod +x "$TMP/newbin"
export NARU_DEPLOY_POLL=1 NARU_DEPLOY_DRAIN_TIMEOUT=3 NARU_DEPLOY_HEALTH_TIMEOUT=2
export NARU_DEPLOY_RESTART_CMD="echo x >>'$TMP/restarts'"
export NARU_DEPLOY_HEALTH_CMD='[ "$("'"$PREFIX"'/bin/naru" --version 2>/dev/null | awk "{print \$2}")" = "$NARU_DEPLOY_EXPECT" ]'
BAD_HEALTH='[ "$NARU_DEPLOY_EXPECT" != 9.9.9 ]'  # the new build is unhealthy, the old one fine
export NARU_DEPLOY_DB="$MESA_DB"
before=$(shasum "$NARU" | cut -d' ' -f1)
backups="$HOME/.naru/backups"

out=$(scripts/self-deploy.sh --dry-run)
[ "$(echo "$out" | jq -r .status)" = plan ] || fail "dry-run verdict"
[ "$(shasum "$NARU" | cut -d' ' -f1)" = "$before" ] && [ ! -e "$PREFIX/bin/naru.prev" ] && [ ! -d "$backups" ] || fail "dry-run changed something"
ok "dry-run prints the plan and changes nothing"

"$SRC" workflow create "Task loop" --project 1 >/dev/null
"$SRC" workflow create "Task loop: implement and review" --project 1 >/dev/null
out=$(NARU_DEPLOY_NEW_BIN="$TMP/newbin" scripts/self-deploy.sh --skip-checks 2>/dev/null) || fail "deploy exit"
[ "$(echo "$out" | jq -r .status)" = swapped ] && [ "$(echo "$out" | jq -r .healthy)" = true ] && [ "$(echo "$out" | jq -r .queue_resumed)" = true ] || fail "verdict: $out"
[ ! -e "$TMP/paused" ] && [ -s "$TMP/restarts" ] || fail "queue not resumed / no restart"
[ "$(shasum "$PREFIX/bin/naru.prev" | cut -d' ' -f1)" = "$before" ] || fail "naru.prev differs from the old binary"
cmp -s "$NARU" "$TMP/newbin" || [ "$("$NARU" 2>&1 | head -1)" = new ] || fail "new binary not installed"
wl=$("$SRC" workflow list 1)
[ "$(echo "$wl" | jq 'length')" = 2 ] && [ "$(echo "$wl" | jq '[.[] | select(.name|test("pre-|copy|old"))] | length')" = 0 ] || fail "deploy renamed or copied a workflow: $wl"
ok "a deploy did not rename or copy the user workflows"
db=$(echo "$out" | jq -r .db_backup)
[ -f "$db" ] && [ "$(dirname "$db")" = "$backups" ] || fail "no timestamped backup: $db"
case "$(basename "$db")" in naru-pre-deploy-*.db) ;; *) fail "backup name" ;; esac
[ "$(MESA_DB="$db" "$PREFIX/bin/naru.prev" project list | jq length)" = 1 ] || fail "backup is not a valid db"
[ -L "$PREFIX/bin/mesa" ] || fail "mesa symlink"
[ -z "$(ls -A "$PREFIX/bin" | grep '^\.naru\.' || true)" ] || fail "stray temp files"
ok "swap kept naru.prev, wrote a valid timestamped backup, left no temp files"

# a failed pre-swap step leaves the install alone: make the backup dir unwritable
old_prev=$(shasum "$PREFIX/bin/naru.prev" | cut -d' ' -f1); cur=$(shasum "$NARU" | cut -d' ' -f1)
set +e
out=$(NARU_DEPLOY_BACKUP_DIR=/dev/null/x NARU_DEPLOY_NEW_BIN="$SRC" scripts/self-deploy.sh --skip-checks 2>/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(echo "$out" | jq -r .status)" = aborted ] || fail "backup failure should abort ($rc)"
[ "$(shasum "$NARU" | cut -d' ' -f1)" = "$cur" ] && [ "$(shasum "$PREFIX/bin/naru.prev" | cut -d' ' -f1)" = "$old_prev" ] || fail "abort changed the install"
ok "backup failure aborts with binary and naru.prev untouched"

# unhealthy new build -> rolled back: binary and db byte-equal to before, queue resumed
rm -f "$TMP/restarts"
# make the installed one the old (real) binary again so a rollback is distinguishable
cp "$SRC" "$NARU"; cp "$SRC" "$PREFIX/bin/naru.prev"
# the first restart (after the swap) writes to the db: the restore must discard it
hook="echo x >>'$TMP/restarts'; [ -e '$TMP/wrote' ] || { touch '$TMP/wrote'; '$SRC' project create post-swap --no-git >/dev/null; }"
set +e
out=$(NARU_DEPLOY_RESTART_CMD="$hook" NARU_DEPLOY_HEALTH_CMD="$BAD_HEALTH" NARU_DEPLOY_NEW_BIN="$TMP/newbin" scripts/self-deploy.sh --skip-checks 2>/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(echo "$out" | jq -r .status)" = rolled_back ] || fail "expected rolled_back ($rc): $out"
[ "$(shasum "$NARU" | cut -d' ' -f1)" = "$before" ] && cmp -s "$NARU" "$PREFIX/bin/naru.prev" || fail "rollback not byte-identical to naru.prev"
[ "$("$NARU" --version)" = "$("$SRC" --version)" ] && [ "$("$NARU" --version)" != "naru 9.9.9" ] || fail "binary not restored"
[ -e "$TMP/wrote" ] && [ "$("$NARU" project list | jq length)" = 1 ] || fail "db not restored to the backup"
[ ! -e "$TMP/paused" ] || fail "queue left paused after rollback"
[ "$(wc -l <"$TMP/restarts")" -ge 2 ] || fail "rollback did not restart"
ok "unhealthy deploy rolled back (binary restored, db restored, restarted, queue resumed)"

# drain timeout -> aborted, install untouched, queue resumed
touch "$TMP/busy"; cur=$(shasum "$NARU" | cut -d' ' -f1)
set +e
out=$(NARU_DEPLOY_NEW_BIN="$TMP/newbin" scripts/self-deploy.sh --skip-checks 2>/dev/null); rc=$?
set -e
rm -f "$TMP/busy"
[ "$rc" = 1 ] && [ "$(echo "$out" | jq -r .status)" = aborted ] && echo "$out" | jq -r .reason | grep -q drain || fail "drain timeout verdict: $out"
[ "$(shasum "$NARU" | cut -d' ' -f1)" = "$cur" ] && [ ! -e "$TMP/paused" ] || fail "drain abort changed install or left queue paused"
ok "drain timeout aborts with the install untouched and the queue resumed"

# live session check: still live (same agent_id) + say round trip; not live / say failing
# roll back; no live session before the deploy, or NARU_DEPLOY_LIVE_CHECK=0, skips it
live_deploy() { # live_deploy <restart hook> [extra env...]
  local h="$1"; shift
  sleep 1  # backup names are per-second
  cp "$SRC" "$NARU"; cp "$SRC" "$PREFIX/bin/naru.prev"; rm -f "$TMP/paused"
  set +e
  out=$(env "$@" NARU_DEPLOY_RESTART_CMD="$h" NARU_DEPLOY_NEW_BIN="$TMP/newbin" scripts/self-deploy.sh --skip-checks 2>/dev/null); rc=$?
  set -e
}
touch "$TMP/live"
live_deploy "true"
[ "$rc" = 0 ] && [ "$(echo "$out" | jq -r .status)" = swapped ] && [ "$(echo "$out" | jq -r .healthy)" = true ] || fail "same agent_id should be healthy ($rc): $out"
ok "live session still live under the same agent_id -> swapped"
live_deploy "rm -f '$TMP/live'"
[ "$rc" = 1 ] && [ "$(echo "$out" | jq -r .status)" = rolled_back ] || fail "session gone should roll back ($rc): $out"
ok "live session gone after the restart -> rolled_back"
touch "$TMP/live" "$TMP/say_fail"
live_deploy "true"
rm -f "$TMP/say_fail"
[ "$rc" = 1 ] && [ "$(echo "$out" | jq -r .status)" = rolled_back ] || fail "failing say should roll back ($rc): $out"
ok "live say failing -> rolled_back"
rm -f "$TMP/live"
live_deploy "true"
[ "$rc" = 0 ] && [ "$(echo "$out" | jq -r .status)" = swapped ] || fail "no live session before should skip ($rc): $out"
ok "no live session before the deploy -> check skipped, swapped"
touch "$TMP/live" "$TMP/say_fail"
live_deploy "true" NARU_DEPLOY_LIVE_CHECK=0
rm -f "$TMP/live" "$TMP/say_fail"
[ "$rc" = 0 ] && [ "$(echo "$out" | jq -r .status)" = swapped ] || fail "NARU_DEPLOY_LIVE_CHECK=0 should skip ($rc): $out"
ok "NARU_DEPLOY_LIVE_CHECK=0 skips the live check"

# ---- stale runners (naru task 2084): started before the swap and still on the old binary
# the live agent's run is handed off; every other one is only recorded, nothing is stopped
run() { echo "{\"job_id\":\"$1\",\"name\":\"n-$1\",\"agent\":\"a\",\"status\":\"$2\",\"runner_pid\":$3,\"runner_alive\":true,\"pending_messages\":$4}"; }
echo "[$(run same running 101 0),$(run idle1 idle 102 0),$(run busy running 103 0),$(run pend idle 104 2),$(run fresh running 105 0)]" >"$TMP/runs.json"
for p in 101 102 103 104; do echo 100 >"$TMP/start-$p"; done
echo 99999999999 >"$TMP/start-105"   # started after the swap
export NARU_DEPLOY_RUNNER_START_CMD='cat "'"$TMP"'/start-$1"'
rm -f "$TMP/handoff.log" "$TMP/runstop.log"
touch "$TMP/live"
live_deploy "true"
[ "$rc" = 0 ] && [ "$(echo "$out" | jq -r .status)" = swapped ] || fail "stale runners deploy ($rc): $out"
[ "$(wc -l <"$TMP/handoff.log" | tr -d ' ')" = 1 ] && [ ! -e "$TMP/runstop.log" ] || fail "expected one handoff and no run stop"
act() { echo "$out" | jq -r --arg j "$1" '[.stale_runners[] | select(.job_id==$j) | .action][0] // "absent"'; }
[ "$(act same)" = handed_off ] && [ "$(act idle1)" = left_running ] && [ "$(act busy)" = left_running ] && [ "$(act pend)" = left_running ] || fail "stale actions: $out"
[ "$(act fresh)" = absent ] || fail "a runner started after the swap was listed: $out"
ok "live runner handed off once; other stale runners recorded left_running, none stopped; a post-swap runner is not listed"
rm -f "$TMP/handoff.log"; touch "$TMP/handoff_fail"
live_deploy "true"
rm -f "$TMP/handoff_fail"
[ "$rc" = 0 ] && [ "$(echo "$out" | jq -r .status)" = swapped ] && [ "$(act same)" = failed ] || fail "failing handoff should record failed, still swapped ($rc): $out"
ok "failing handoff -> action failed, deploy still swapped"
rm -f "$TMP/handoff.log"
live_deploy "true" NARU_DEPLOY_RUNNERS=0
[ "$rc" = 0 ] && [ "$(echo "$out" | jq '.stale_runners|length')" = 0 ] && [ ! -e "$TMP/handoff.log" ] || fail "NARU_DEPLOY_RUNNERS=0 should do nothing ($rc): $out"
ok "NARU_DEPLOY_RUNNERS=0 skips the stale-runner step"
rm -f "$TMP/live" "$TMP/runs.json"; unset NARU_DEPLOY_RUNNER_START_CMD

# rollback that cannot restart -> rollback_failed, queue stays paused
set +e
out=$(NARU_DEPLOY_HEALTH_CMD=false NARU_DEPLOY_RESTART_CMD="[ ! -e '$TMP/restarts-stop' ] && { touch '$TMP/restarts-stop'; true; }" NARU_DEPLOY_NEW_BIN="$TMP/newbin" scripts/self-deploy.sh --skip-checks 2>/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(echo "$out" | jq -r .status)" = rollback_failed ] && [ -e "$TMP/paused" ] || fail "rollback_failed expected ($rc): $out"
ok "failed rollback leaves the queue paused"

# ---- PATH: without cargo/node (and none in the fake HOME) the deploy exits 2 early
rm -f "$TMP/paused"
mkdir -p "$TMP/minbin" "$TMP/hp"
for t in jq dirname mktemp rm date env awk ls uname sed head cat mkdir tail basename; do
  ln -sf "$(command -v $t)" "$TMP/minbin/$t"
done
before=$(shasum "$NARU" | cut -d' ' -f1)
set +e
msg=$(env -u MESA_DB HOME="$TMP/hp" PATH="$TMP/minbin" NARU_DEPLOY_NEW_BIN="$TMP/newbin" "$(command -v bash)" scripts/self-deploy.sh 2>&1 >/dev/null); rc=$?
set -e
[ "$rc" = 2 ] && echo "$msg" | grep -q "cargo not found" || fail "missing cargo should exit 2 naming it ($rc): $msg"
[ "$(shasum "$NARU" | cut -d' ' -f1)" = "$before" ] && [ ! -e "$TMP/paused" ] || fail "PATH failure changed something"
# cargo in ~/.cargo/bin, node in ~/Library/pnpm/bin of the fake HOME -> the PATH check passes
mkdir -p "$TMP/hp/.cargo/bin" "$TMP/hp/Library/pnpm/bin"
printf '#!/bin/sh\nexit 1\n' >"$TMP/hp/.cargo/bin/cargo"; cp "$TMP/hp/.cargo/bin/cargo" "$TMP/hp/Library/pnpm/bin/node"
chmod +x "$TMP/hp/.cargo/bin/cargo" "$TMP/hp/Library/pnpm/bin/node"
set +e
msg=$(env -u MESA_DB HOME="$TMP/hp" PATH="$TMP/minbin" NARU_DEPLOY_NEW_BIN="$TMP/newbin" "$(command -v bash)" scripts/self-deploy.sh 2>&1 >/dev/null); rc=$?
set -e
echo "$msg" | grep -q "not found on PATH" && fail "PATH not extended from HOME dirs: $msg"
[ ! -e "$TMP/paused" ] || fail "queue left paused"
ok "missing cargo exits 2 naming it; ~/.cargo/bin and ~/Library/pnpm/bin are put on PATH"

# ---- rollback restores the db the server uses and never creates a second one -------
# live db is the legacy mesa.db under the platform data dir; no env names it
AS="$TMP/h2/Library/Application Support"; mkdir -p "$AS/mesa" "$TMP/h2/.naru"
LIVE="$AS/mesa/mesa.db"
MESA_DB="$LIVE" "$SRC" project create live1 --no-git >/dev/null
cp "$SRC" "$NARU"; rm -f "$TMP/wrote"
hook="[ -e '$TMP/wrote' ] || { touch '$TMP/wrote'; MESA_DB='$LIVE' '$SRC' project create post-swap --no-git >/dev/null; }"
set +e
out=$(env -u MESA_DB -u NARU_DEPLOY_DB HOME="$TMP/h2" NARU_DEPLOY_RESTART_CMD="$hook" NARU_DEPLOY_HEALTH_CMD="$BAD_HEALTH" NARU_DEPLOY_NEW_BIN="$TMP/newbin" scripts/self-deploy.sh --skip-checks 2>/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(echo "$out" | jq -r .status)" = rolled_back ] || fail "stub rollback verdict ($rc): $out"
second=$(find "$TMP/h2" -name '*.db*' ! -path "$TMP/h2/.naru/backups/*" ! -path "$AS/mesa/*" | wc -l | tr -d ' ')
[ "$second" = 0 ] && [ ! -e "$AS/naru/naru.db" ] || fail "second_db_files_created=$second"
[ "$(MESA_DB="$LIVE" "$SRC" project list | jq length)" = 1 ] || fail "live db not restored"
ok "rollback restored the live mesa.db; second_db_files_created=0"

# resolved target vanishes during the deploy -> rollback_failed, nothing created in its place
rm -f "$TMP/wrote"
# (a directory in its place, so no CLI call between here and the restore can recreate a db file)
hook="rm -f '$LIVE' '$LIVE-wal' '$LIVE-shm'; mkdir -p '$LIVE'"
set +e
out=$(env -u MESA_DB -u NARU_DEPLOY_DB HOME="$TMP/h2" NARU_DEPLOY_RESTART_CMD="$hook" NARU_DEPLOY_HEALTH_CMD="$BAD_HEALTH" NARU_DEPLOY_NEW_BIN="$TMP/newbin" scripts/self-deploy.sh --skip-checks 2>/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(echo "$out" | jq -r .status)" = rollback_failed ] && echo "$out" | jq -r .reason | grep -q "db restore failed" || fail "missing-target verdict ($rc): $out"
[ -d "$LIVE" ] && [ ! -e "$AS/naru/naru.db" ] && [ -z "$(ls -A "$LIVE")" ] || fail "restore created a db"
ok "missing restore target -> rollback_failed, no file created"

# ---- health port: NARU_DEPLOY_PORT, else the config's serve.port, else 7770 ----------
# Default /api/version check (no NARU_DEPLOY_HEALTH_CMD) against a stub server that
# answers {"version":"9.9.9"}; ports are unlikely ones, checked free first.
cat >"$TMP/stub.py" <<'PY'
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = b'{"version":"9.9.9"}'
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
P1=18877; P2=18878
for p in $P1 $P2; do ! lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 || fail "port $p busy"; done
python3 -I "$TMP/stub.py" $P1 & S1=$!
trap 'kill $S1 2>/dev/null; rm -rf "$TMP"' EXIT
sleep 1
echo "{\"serve\":{\"port\":$P1}}" >"$TMP/port-config.json"
port_deploy() { # port_deploy <config file> [extra env...]: a deploy judged by the default /api/version check
  local cfg="$1"; shift
  cp "$SRC" "$NARU"; rm -f "$TMP/paused"
  set +e
  out=$(env -u NARU_DEPLOY_HEALTH_CMD MESA_CONFIG_FILE="$cfg" "$@" NARU_DEPLOY_HEALTH_TIMEOUT=2 NARU_DEPLOY_LIVE_CHECK=0 NARU_DEPLOY_NEW_BIN="$TMP/newbin" scripts/self-deploy.sh --skip-checks 2>/dev/null); rc=$?
  set -e
}
port_deploy "$TMP/port-config.json"
[ "$rc" = 0 ] && [ "$(echo "$out" | jq -r .status)" = swapped ] || fail "serve.port in the config not used ($rc): $out"
ok "health check follows the config's serve.port"
port_deploy "$TMP/no-config.json"
[ "$rc" = 1 ] && [ "$(echo "$out" | jq -r .status)" != swapped ] || fail "no config: should use 7770, not $P1 ($rc): $out"
ok "no serve.port falls back to 7770"
port_deploy "$TMP/port-config.json" NARU_DEPLOY_PORT=$P2
[ "$rc" = 1 ] && [ "$(echo "$out" | jq -r .status)" != swapped ] || fail "NARU_DEPLOY_PORT should override the config ($rc): $out"
ok "NARU_DEPLOY_PORT overrides the config"
kill $S1 2>/dev/null || true
echo "self-deploy-check: all passed"
