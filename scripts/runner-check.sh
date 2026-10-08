#!/usr/bin/env bash
# runner gate (naru task 1686, docs/runner.md): detached `claude -p` agent runs
# that outlive the server, against a throwaway HOME, a stub `claude`
# (MESA_CLAUDE_BIN) that speaks stream-json on stdin/stdout and logs its argv,
# and `naru serve` on a throwaway port.
#
#   (a) a run started over POST /api/runs keeps going, and finishes its turn,
#       after the serve that started it is `kill -9`ed mid-turn;
#   (b) a restarted serve shows its events and final result via GET /api/runs/{id};
#   (c) a message POSTed after the restart reaches the same running session
#       (one claude invocation, `--session-id`, its echo is the result);
#   (d) `kill -9` of the runner mid-turn, then a restarted serve: the stub is
#       re-invoked with `--resume <same session id>` and the run reaches idle
#       after being told to continue;
#   plus stop, the idle timeout, CLI error shapes and the agent-access gate.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
BIN="$PWD/target/debug"
NARU="$BIN/naru"

TMP=$(mktemp -d)
PORT=17811
BASE="http://127.0.0.1:$PORT"
SERVE_PID=
cleanup() {
  # No `a && b` lists here: with errexit a failing `b` would turn a clean pass
  # into exit 1 from inside the EXIT trap.
  if [ -n "$SERVE_PID" ]; then kill "$SERVE_PID" 2>/dev/null || true; fi
  # Every runner and claude this gate started, by the pids their files hold.
  for d in "$TMP"/home/.naru/runs/*/; do
    for pid in $(cat "$d/runner.pid" 2>/dev/null) $(jq -r '.runner_pid // empty, .claude_pid // empty' "$d/job.json" 2>/dev/null); do
      kill "$pid" 2>/dev/null || true
      kill -- "-$pid" 2>/dev/null || true
    done
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

export MESA_DB="$TMP/mesa.db"
export HOME="$TMP/home"
export MESA_CONFIG_FILE="$TMP/no-such-config.json"
mkdir -p "$HOME" "$TMP/work"
RUNS="$HOME/.naru/runs"

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

# ---- stub claude ----
#
# Logs one argv line per invocation. Reads stream-json user messages, one per
# line; for each answers with an assistant line and a result line echoing the
# text. A file `sleep-secs` in the stub dir makes each turn take that long, so
# a gate can kill things mid-turn. EOF on stdin ends it, like the real one.
STUB="$TMP/stub"
mkdir -p "$STUB"
cat > "$STUB/claude" <<STUBEOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$STUB/argv.log"
if [ -f "$STUB/fail-resume" ] && [[ " \$* " == *" --resume "* ]]; then
  echo "No conversation found" >&2; exit 1
fi
while IFS= read -r line; do
  text=\$(jq -r '.message.content[0].text' <<<"\$line")
  s=0; [ -f "$STUB/sleep-secs" ] && s=\$(cat "$STUB/sleep-secs")
  [ "\$s" != 0 ] && sleep "\$s"
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":%s}]}}\n' "\$(jq -Rn --arg t "\$text" '\$t')"
  printf '{"type":"result","subtype":"success","is_error":false,"result":%s}\n' "\$(jq -Rn --arg t "echo: \$text" '\$t')"
done
STUBEOF
chmod +x "$STUB/claude"
export MESA_CLAUDE_BIN="$STUB/claude"

wait_for() { # <seconds> <description> <cmd...>
  local secs=$1 what=$2; shift 2
  for _ in $(seq 1 $((secs * 10))); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
  fail "timed out waiting for: $what"
}
start_serve() {
  "$NARU" serve --port "$PORT" >>"$TMP/serve.log" 2>&1 &
  SERVE_PID=$!
  wait_for 10 "serve up" curl -sf "$BASE/api/projects"
}
api() { curl -sf -H 'Content-Type: application/json' "$@"; }
job_field() { jq -r ".$2" "$RUNS/$1/job.json"; }
status_is() { [ "$(job_field "$1" status)" = "$2" ]; }
result_is() { [ "$(job_field "$1" last_result)" = "$2" ]; }
pid_alive() { kill -0 "$1" 2>/dev/null; }
delivered_is() { [ "$(grep -c message_delivered "$RUNS/$1/events.jsonl")" = "$2" ]; }
resumed_idle() { [ "$(job_field "$1" resumes)" = 1 ] && status_is "$1" idle; }

# ---- (a) a run outlives the serve that started it ----
echo 4 > "$STUB/sleep-secs"
start_serve
STARTED=$(api -X POST "$BASE/api/runs" -d '{"model":"haiku","prompt":"first job","cwd":"'"$TMP/work"'","name":"gate run"}')
ID=$(jq -r .job_id <<<"$STARTED")
SESSION=$(jq -r .session_id <<<"$STARTED")
[[ "$ID" =~ ^[0-9a-f]{8}$ ]] || fail "job id shape: $ID"
[[ "$SESSION" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail "session id is not a v4 uuid: $SESSION"
wait_for 10 "first message delivered" delivered_is "$ID" 1
status_is "$ID" running || fail "run should be mid-turn"
RUNNER_PID=$(cat "$RUNS/$ID/runner.pid")
kill -9 "$SERVE_PID"; wait "$SERVE_PID" 2>/dev/null || true; SERVE_PID=
pid_alive "$RUNNER_PID" || fail "runner died with the server"
ok "(a) runner $RUNNER_PID survived kill -9 of the serve mid-turn"
wait_for 15 "turn finishing with no server" result_is "$ID" "echo: first job"
status_is "$ID" idle || fail "run should be idle after its result: $(job_field "$ID" status)"
[ "$(wc -l < "$STUB/argv.log" | tr -d " ")" = 1 ] || fail "claude should have been started once"
grep -q -- "--session-id $SESSION" "$STUB/argv.log" || fail "first start must pass --session-id $SESSION: $(cat "$STUB/argv.log")"
grep -q -- "--model haiku" "$STUB/argv.log" || fail "model not passed: $(cat "$STUB/argv.log")"
ok "(a) the turn finished with no server running; claude started once with --session-id"

# ---- (b) a restarted serve shows events and the result ----
echo 0 > "$STUB/sleep-secs"
start_serve
SHOWN=$(api "$BASE/api/runs/$ID")
[ "$(jq -r .job.status <<<"$SHOWN")" = idle ] || fail "restarted serve: $SHOWN"
[ "$(jq -r .job.last_result <<<"$SHOWN")" = "echo: first job" ] || fail "last_result: $SHOWN"
[ "$(jq '[.events[] | select(.type == "result")] | length' <<<"$SHOWN")" = 1 ] || fail "result event missing: $SHOWN"
[ "$(jq '[.events[] | select(.type == "naru_runner" and .event == "message_delivered")] | length' <<<"$SHOWN")" = 1 ] || fail "runner event missing"
[ "$(jq -r '.job.runner_alive' <<<"$SHOWN")" = true ] || fail "runner should report alive"
[ "$(api "$BASE/api/runs" | jq -r '.[0].job_id')" = "$ID" ] || fail "list does not show the run"
ok "(b) restarted serve shows the run's events and final result"

# ---- (c) a message after the restart reaches the running session ----
api -X POST "$BASE/api/runs/$ID/message" -d '{"text":"second \"quoted\" message"}' >/dev/null
wait_for 10 "second result" result_is "$ID" 'echo: second "quoted" message'
status_is "$ID" idle || fail "idle after the second turn"
[ "$(wc -l < "$STUB/argv.log" | tr -d " ")" = 1 ] || fail "the message must reach the same claude, not start another"
[ "$(cat "$RUNS/$ID/runner.pid")" = "$RUNNER_PID" ] || fail "runner changed"
[ -z "$(ls "$RUNS/$ID/inbox"/*.json 2>/dev/null)" ] || fail "inbox not drained"
[ "$(ls "$RUNS/$ID/inbox/delivered" | wc -l | tr -d " ")" = 2 ] || fail "delivered/ should hold both messages"
ok "(c) a message POSTed after the restart reached the same claude session"

# ---- (d) kill -9 the runner mid-turn; a restarted serve resumes it ----
echo 6 > "$STUB/sleep-secs"
api -X POST "$BASE/api/runs/$ID/message" -d '{"text":"third"}' >/dev/null
wait_for 10 "third delivered" delivered_is "$ID" 3
status_is "$ID" running || fail "should be mid-turn"
OLD_CLAUDE=$(job_field "$ID" claude_pid)
kill -9 "$SERVE_PID"; wait "$SERVE_PID" 2>/dev/null || true; SERVE_PID=
kill -9 "$RUNNER_PID"
sleep 0.3
pid_alive "$RUNNER_PID" && fail "runner should be dead"
echo 0 > "$STUB/sleep-secs"
start_serve
wait_for 20 "resumed run idle again" resumed_idle "$ID"
[ "$(wc -l < "$STUB/argv.log" | tr -d " ")" = 2 ] || fail "claude should have been invoked twice: $(cat "$STUB/argv.log")"
tail -1 "$STUB/argv.log" | grep -q -- "--resume $SESSION" || fail "resume must pass --resume $SESSION: $(tail -1 "$STUB/argv.log")"
! tail -1 "$STUB/argv.log" | grep -q -- "--session-id" || fail "resume must not pass --session-id"
[ "$(job_field "$ID" session_id)" = "$SESSION" ] || fail "session id changed"
case "$(job_field "$ID" last_result)" in "echo: The process running you was restarted"*) ;; *) fail "the resumed session was not told to continue: $(job_field "$ID" last_result)";; esac
NEW_RUNNER=$(cat "$RUNS/$ID/runner.pid")
[ "$NEW_RUNNER" != "$RUNNER_PID" ] || fail "no new runner"
pid_alive "$OLD_CLAUDE" && fail "the old claude ($OLD_CLAUDE) must be gone after the resume"
SHOWN=$(api "$BASE/api/runs/$ID")
[ "$(jq '[.events[] | select(.type == "naru_runner" and .event == "resumed")] | length' <<<"$SHOWN")" = 1 ] || fail "no resumed event"
ok "(d) runner killed mid-turn: restarted serve resumed it with --resume $SESSION (resumes=1)"

# ---- stop ----
api -X POST "$BASE/api/runs/$ID/stop" -d '{}' >/dev/null
wait_for 10 "stopped" status_is "$ID" stopped
pid_alive "$NEW_RUNNER" && fail "runner should exit after stop"
pid_alive "$(job_field "$ID" claude_pid)" && fail "claude should be gone after stop"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST "$BASE/api/runs/$ID/message" -d '{"text":"late"}')
[ "$code" = 409 ] || fail "message to a stopped run should be 409, got $code"
ok "stop ended the runner and claude; a stopped run refuses messages (409)"

# ---- resume of a session that was never saved falls back to a fresh start ----
: > "$STUB/argv.log"
echo 6 > "$STUB/sleep-secs"
J3=$("$NARU" run start --model haiku --cwd "$TMP/work" "unsaved prompt" | jq -r .job_id)
S3=$(job_field "$J3" session_id)
wait_for 10 "prompt delivered" delivered_is "$J3" 1
R3=$(cat "$RUNS/$J3/runner.pid")
kill -9 "$R3"; kill -- "-$(job_field "$J3" claude_pid)" 2>/dev/null || true
sleep 0.3
touch "$STUB/fail-resume"
echo 0 > "$STUB/sleep-secs"
"$NARU" run reconcile | jq -e --arg j "$J3" '.resumed == [$j]' >/dev/null || fail "reconcile should resume $J3"
wait_for 20 "fallback run idle" result_is "$J3" "echo: unsaved prompt"
status_is "$J3" idle || fail "fallback run should be idle, got $(job_field "$J3" status)"
[ "$(sed -n 1p "$STUB/argv.log" | grep -c -- "--session-id $S3")" = 1 ] || fail "first start: $(cat "$STUB/argv.log")"
sed -n 2p "$STUB/argv.log" | grep -q -- "--resume $S3" || fail "second call should be the failed --resume: $(cat "$STUB/argv.log")"
sed -n 3p "$STUB/argv.log" | grep -q -- "--session-id $S3" || fail "third call should be a fresh --session-id $S3: $(cat "$STUB/argv.log")"
"$NARU" run show "$J3" --events | jq -e '[.events[] | select(.event == "resume_fallback")] | length == 1' >/dev/null || fail "no resume_fallback event"
rm "$STUB/fail-resume"
"$NARU" run stop "$J3" >/dev/null
wait_for 10 "fallback run stopped" status_is "$J3" stopped
ok "a resume of a never-saved session fell back to a fresh --session-id start and re-delivered the prompt"

# ---- two racing reconciles start claude exactly once (runner.lock) ----
: > "$STUB/argv.log"
echo 6 > "$STUB/sleep-secs"
J4=$("$NARU" run start --model haiku --cwd "$TMP/work" "race prompt" | jq -r .job_id)
wait_for 10 "race prompt delivered" delivered_is "$J4" 1
R4=$(cat "$RUNS/$J4/runner.pid")
kill -9 "$R4"; kill -- "-$(job_field "$J4" claude_pid)" 2>/dev/null || true
sleep 0.3
echo 0 > "$STUB/sleep-secs"
"$NARU" run reconcile >/dev/null &
RC1=$!
"$NARU" run reconcile >/dev/null &
RC2=$!
wait "$RC1" "$RC2"
wait_for 20 "raced run idle" resumed_idle "$J4"
sleep 1
[ "$(wc -l < "$STUB/argv.log" | tr -d " ")" = 2 ] || fail "claude should have been invoked once more (2 lines total): $(cat "$STUB/argv.log")"
"$NARU" run stop "$J4" >/dev/null
wait_for 10 "raced run stopped" status_is "$J4" stopped
ok "two concurrent reconciles of a dead run started claude exactly once more"

# ---- idle timeout ----
J2=$("$NARU" run start --model haiku --cwd "$TMP/work" --idle-timeout 2 "short lived" | jq -r .job_id)
wait_for 10 "result" result_is "$J2" "echo: short lived"
wait_for 10 "idle timeout -> finished" status_is "$J2" finished
ok "idle timeout wound the run down to finished"

# ---- CLI shapes ----
"$NARU" run list | jq -e 'length == 4' >/dev/null || fail "run list"
"$NARU" run show "$J2" --events | jq -e '.job.job_id and (.events | length) > 0' >/dev/null || fail "run show --events"
"$NARU" run show "$J2" --tail 1 | jq -e '.events | length == 1' >/dev/null || fail "run show --tail"
"$NARU" run show "$J2" --quiet | jq -e '.job_id' >/dev/null || fail "--quiet is accepted and ignored"
set +e
err=$("$NARU" run show ffffffff 2>&1 >/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(jq -r .error.code <<<"$err")" = not_found ] || fail "unknown run: rc=$rc $err"
set +e
err=$("$NARU" run show ../etc 2>&1 >/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(jq -r .error.code <<<"$err")" = validation ] || fail "bad run id: rc=$rc $err"
set +e
"$NARU" run start --model haiku >/dev/null 2>&1; rc=$?
set -e
[ "$rc" = 2 ] || fail "missing prompt should be a usage error, got $rc"
"$NARU" run reconcile | jq -e '.resumed == []' >/dev/null || fail "reconcile with nothing to do"
ok "CLI: list/show/tail/quiet, not_found, validation, usage exit codes, empty reconcile"

# ---- the gate: every route refuses a foreign Host ----
for route in "GET /api/runs" "GET /api/runs/$ID" "POST /api/runs" "POST /api/runs/$ID/message" "POST /api/runs/$ID/stop"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example:80' -H 'Content-Type: application/json' -X "${route%% *}" -d '{}' "$BASE${route#* }")
  [ "$code" = 403 ] || fail "$route with a foreign Host answered $code, expected 403"
done
ok "all five routes refuse a foreign Host"

echo "runner-check: $CHECKS checks passed"
