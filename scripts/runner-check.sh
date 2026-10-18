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
# text; a control_request is logged to control.log and, mid-turn, aborts the turn
# (control_response + an error result). A file `sleep-secs` in the stub dir makes each turn take that long, so
# a gate can kill things mid-turn. EOF on stdin ends it, like the real one.
STUB="$TMP/stub"
mkdir -p "$STUB"
cat > "$STUB/claude" <<STUBEOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$STUB/argv.log"
printf '%s\n' "\$PATH" > "$STUB/path.log"
cargo --version > /dev/null 2>&1; echo \$? > "$STUB/cargo.exit"
if [ -f "$STUB/fail-resume" ] && [[ " \$* " == *" --resume "* ]]; then
  echo "No conversation found" >&2; exit 1
fi
turn_pid=
# Trigger files, named per working directory so only one run's stub reacts:
# bg-on.<dir> / bg-off.<dir> report one / no background task, self-turn.<dir>
# starts a turn nobody asked for (init, assistant, 4 s, result).
me=\$\$
(
  while kill -0 "\$me" 2>/dev/null; do
    d=\$(basename "\$PWD")
    if [ -f "$STUB/bg-on.\$d" ]; then rm -f "$STUB/bg-on.\$d"
      echo '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"t1","task_type":"local_agent"}]}'; fi
    if [ -f "$STUB/bg-off.\$d" ]; then rm -f "$STUB/bg-off.\$d"
      echo '{"type":"system","subtype":"background_tasks_changed","tasks":[]}'; fi
    if [ -f "$STUB/self-turn.\$d" ]; then rm -f "$STUB/self-turn.\$d"
      echo '{"type":"system","subtype":"init","session_id":"s"}'
      echo '{"type":"assistant","message":{"content":[{"type":"text","text":"woken"}]}}'
      sleep 4
      echo '{"type":"result","subtype":"success","is_error":false,"result":"self-started"}'; fi
    sleep 0.2
  done
) &
disown
while IFS= read -r line; do
  if [ "\$(jq -r '.type' <<<"\$line")" = control_request ]; then
    printf '%s\n' "\$line" >> "$STUB/control.log"
    if [ -n "\$turn_pid" ] && kill -0 "\$turn_pid" 2>/dev/null; then
      kill "\$turn_pid" 2>/dev/null; wait "\$turn_pid" 2>/dev/null
      turn_pid=
      printf '{"type":"control_response","response":{"subtype":"success","request_id":%s}}\n' "\$(jq '.request_id' <<<"\$line")"
      printf '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"interrupted"}\n'
    fi
    continue
  fi
  # A file named coalesce folds a message that arrives mid-turn into the running turn, as the real claude does: no second turn, no second result.
  if [ -f "$STUB/coalesce" ] && [ -n "\$turn_pid" ] && kill -0 "\$turn_pid" 2>/dev/null; then continue; fi
  text=\$(jq -r '.message.content[0].text' <<<"\$line")
  s=0; [ -f "$STUB/sleep-secs" ] && s=\$(cat "$STUB/sleep-secs")
  # Logged only after sleep-secs is read: a gate that waits on this file may then change it.
  printf '%s\n' "\$NARU_RUN_DIR" >> "$STUB/turns.log"
  # The turn runs in the background so the loop can still read a control_request.
  (
    [ "\$s" != 0 ] && sleep "\$s"
    # A file named subagent adds the lines a subagent's work leaves in the stream.
    if [ -f "$STUB/subagent" ]; then
      echo '{"type":"system","subtype":"task_started","task_id":"t9","tool_use_id":"toolu_sub","description":"sub"}'
      echo '{"type":"system","subtype":"task_progress","owned_by_subagent":true}'
      echo '{"type":"assistant","parent_tool_use_id":"toolu_sub","message":{"content":[{"type":"text","text":"sub work"}]}}'
    fi
    printf '{"type":"assistant","message":{"content":[{"type":"text","text":%s}]}}\n' "\$(jq -Rn --arg t "\$text" '\$t')"
    printf '{"type":"result","subtype":"success","is_error":false,"result":%s}\n' "\$(jq -Rn --arg t "echo: \$text" '\$t')"
  ) &
  turn_pid=\$!
done
[ -n "\$turn_pid" ] && wait "\$turn_pid"
exit 0
STUBEOF
chmod +x "$STUB/claude"
# A fake cargo under the throwaway HOME's ~/.cargo/bin, which this script's own
# PATH does not hold: the agent step must still find it (naru task 2054).
mkdir -p "$HOME/.cargo/bin"
printf '#!/bin/sh\necho "cargo 0.0.0-stub"\n' > "$HOME/.cargo/bin/cargo"
chmod +x "$HOME/.cargo/bin/cargo"
export MESA_CLAUDE_BIN="$STUB/claude"

wait_for() { # <seconds> <description> <cmd...>
  # Deadlines are scaled (WAIT_SCALE, default 3): a loaded box (a parallel build) is slow, and a
  # passing wait returns as soon as its condition holds, so a generous deadline costs nothing.
  local secs=$1 what=$2; shift 2
  for _ in $(seq 1 $((secs * 10 * ${WAIT_SCALE:-3}))); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
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
# The stub has read (and logged) at least N lines; "delivered" only means written to its stdin.
turns_at_least() { [ "$(wc -l < "$STUB/turns.log" | tr -d " ")" -ge "$1" ]; }
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
[ "$(cat "$STUB/cargo.exit")" = 0 ] || fail "cargo --version failed inside the agent step (PATH: $(cat "$STUB/path.log"))"
case "$(cat "$STUB/path.log")" in "$HOME/.cargo/bin:"*) ;; *) fail "agent PATH should start with ~/.cargo/bin: $(cat "$STUB/path.log")" ;; esac
ok "agent step: ~/.cargo/bin leads PATH and cargo --version exits 0"

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

# ---- agent: --agent reaches claude's argv, is absent without it, survives a resume ----
: > "$STUB/argv.log"
echo 6 > "$STUB/sleep-secs"
JA=$("$NARU" run start --model haiku --agent supervisor --cwd "$TMP/work" "agent prompt" | jq -r .job_id)
wait_for 10 "agent prompt delivered" delivered_is "$JA" 1
[ "$(job_field "$JA" agent)" = supervisor ] || fail "job.json should carry the agent"
grep -q -- " --agent supervisor " "$STUB/argv.log" || fail "agent missing from argv: $(cat "$STUB/argv.log")"
RA=$(cat "$RUNS/$JA/runner.pid")
kill -9 "$RA"; kill -- "-$(job_field "$JA" claude_pid)" 2>/dev/null || true
sleep 0.3
echo 0 > "$STUB/sleep-secs"
"$NARU" run reconcile >/dev/null
wait_for 20 "agent run resumed idle" resumed_idle "$JA"
grep -- "--resume" "$STUB/argv.log" | grep -q -- " --agent supervisor " || fail "agent missing from the --resume argv: $(cat "$STUB/argv.log")"
"$NARU" run stop "$JA" >/dev/null
wait_for 10 "agent run stopped" status_is "$JA" stopped
: > "$STUB/argv.log"
JB=$("$NARU" run start --model haiku --cwd "$TMP/work" "no agent prompt" | jq -r .job_id)
wait_for 10 "plain prompt delivered" delivered_is "$JB" 1
! grep -q -- "--agent" "$STUB/argv.log" || fail "argv has --agent without one asked for: $(cat "$STUB/argv.log")"
"$NARU" run stop "$JB" >/dev/null
wait_for 10 "plain run stopped" status_is "$JB" stopped
BADERR=$("$NARU" run start --model haiku --agent=-x --cwd "$TMP/work" "bad" 2>&1 || true)
jq -e '.error.code == "validation"' <<<"$BADERR" >/dev/null || fail "--agent starting with - should be validation"
ok "agent: --agent in argv when given, absent without, still present after --resume"

# ---- interrupt: a control_request ends the turn, the run stays open ----
: > "$STUB/control.log"
echo 4 > "$STUB/sleep-secs"
J5=$("$NARU" run start --model haiku --cwd "$TMP/work" "long turn" | jq -r .job_id)
wait_for 10 "long turn delivered" delivered_is "$J5" 1
status_is "$J5" running || fail "should be mid-turn"
"$NARU" run interrupt "$J5" | jq -e '.job_id' >/dev/null || fail "run interrupt output"
wait_for 10 "interrupt delivered to claude" grep -q interrupt "$STUB/control.log"
[ "$(wc -l < "$STUB/control.log" | tr -d " ")" = 1 ] || fail "one control_request expected: $(cat "$STUB/control.log")"
jq -e '.type == "control_request" and .request.subtype == "interrupt"' "$STUB/control.log" >/dev/null || fail "control line: $(cat "$STUB/control.log")"
wait_for 10 "interrupted run idle" status_is "$J5" idle
grep -q interrupt_requested "$RUNS/$J5/events.jsonl" || fail "no interrupt_requested event"
[ ! -e "$RUNS/$J5/interrupt" ] || fail "interrupt marker should be consumed"
echo 0 > "$STUB/sleep-secs"
"$NARU" run send "$J5" "after interrupt" >/dev/null
wait_for 10 "send after interrupt answered" result_is "$J5" "echo: after interrupt"
"$NARU" run interrupt "$J5" >/dev/null
sleep 1
[ "$(wc -l < "$STUB/control.log" | tr -d " ")" = 1 ] || fail "interrupting an idle run must send nothing"
"$NARU" run stop "$J5" >/dev/null
wait_for 10 "interrupt run stopped" status_is "$J5" stopped
set +e
err=$("$NARU" run interrupt "$J5" 2>&1 >/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(jq -r .error.code <<<"$err")" = conflict ] || fail "interrupt of a stopped run: rc=$rc $err"
ok "interrupt ended the turn mid-flight, the run stayed open and answered the next send; idle/terminal runs refused or ignored"

# ---- messages folded into one turn: three deliveries, one result, run goes idle ----
touch "$STUB/coalesce"
echo 3 > "$STUB/sleep-secs"
J6=$("$NARU" run start --model haiku --cwd "$TMP/work" "fold one" | jq -r .job_id)
wait_for 10 "fold: first delivered" delivered_is "$J6" 1
"$NARU" run send "$J6" "fold two" >/dev/null
"$NARU" run send "$J6" "fold three" >/dev/null
wait_for 10 "fold: all three delivered" delivered_is "$J6" 3
status_is "$J6" running || fail "fold: should still be mid-turn"
wait_for 15 "fold: idle after the single result" status_is "$J6" idle
[ "$(grep -c '"type":"result"' "$RUNS/$J6/events.jsonl")" = 1 ] || fail "fold: expected exactly one result"
rm -f "$STUB/coalesce"
echo 0 > "$STUB/sleep-secs"
"$NARU" run stop "$J6" >/dev/null
wait_for 10 "fold run stopped" status_is "$J6" stopped
ok "three messages folded into one turn gave one result and the run went idle"

# ---- urgent send: --interrupt cuts the turn in flight, then delivers as a fresh turn ----
: > "$STUB/control.log"
echo 30 > "$STUB/sleep-secs"
: > "$STUB/turns.log"
J9=$("$NARU" run start --model haiku --cwd "$TMP/work" "very long turn" | jq -r .job_id)
wait_for 10 "urgent: long turn delivered" delivered_is "$J9" 1
wait_for 10 "urgent: stub began the long turn" turns_at_least 1
"$NARU" run send "$J9" "plain" >/dev/null
wait_for 5 "urgent: plain message delivered mid-turn" delivered_is "$J9" 2
# The stub must have read "plain" (and its 30 s sleep) before sleep-secs changes.
wait_for 10 "urgent: stub read the plain message" turns_at_least 2
[ ! -s "$STUB/control.log" ] || fail "a plain send must not interrupt: $(cat "$STUB/control.log")"
echo 0 > "$STUB/sleep-secs"
"$NARU" run send --interrupt "$J9" "urgent" >/dev/null
wait_for 5 "urgent: answered" result_is "$J9" "echo: urgent"
[ "$(wc -l < "$STUB/control.log" | tr -d " ")" = 1 ] || fail "urgent: one control_request expected: $(cat "$STUB/control.log")"
[ "$(jq -rs '[.[] | select(.event == "interrupt_requested" or .event == "message_delivered") | .event] | join(",")' "$RUNS/$J9/events.jsonl")" = "message_delivered,message_delivered,interrupt_requested,message_delivered" ] || fail "urgent: interrupt_requested must precede the delivery"
[ "$(jq -s '[.[] | select(.event == "interrupt_requested")] | .[0].source' -r "$RUNS/$J9/events.jsonl")" = message ] || fail "urgent: source should be message"
[ "$(grep -c '"message_delivered"' "$RUNS/$J9/events.jsonl")" = 3 ] || fail "urgent: delivered exactly once expected (3 deliveries in all)"
[ "$(ls "$RUNS/$J9/inbox/delivered" | wc -l | tr -d " ")" = 3 ] || fail "urgent: delivered dir"
"$NARU" run stop "$J9" >/dev/null
wait_for 10 "urgent run stopped" status_is "$J9" stopped
ok "urgent send: a plain send mid-turn sent no control_request; --interrupt sent exactly one, logged it before the delivery, answered echo: urgent"

: > "$STUB/control.log"
echo 30 > "$STUB/sleep-secs"
: > "$STUB/turns.log"
J10=$("$NARU" run start --model haiku --cwd "$TMP/work" "very long turn" | jq -r .job_id)
wait_for 10 "urgent api: long turn delivered" delivered_is "$J10" 1
# Delivered only means written to the stub's stdin: wait for the stub to have read
# the line (and its 30 s sleep), or a late read sees sleep-secs 0 and the turn
# ends before the interrupt, leaving no control_request.
wait_for 10 "urgent api: stub began the long turn" test -s "$STUB/turns.log"
echo 0 > "$STUB/sleep-secs"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST -d '{"text":"urgent","interrupt":true}' "$BASE/api/runs/$J10/message")
[ "$code" = 202 ] || fail "urgent api: expected 202, got $code"
wait_for 5 "urgent api: answered" result_is "$J10" "echo: urgent"
[ "$(wc -l < "$STUB/control.log" | tr -d " ")" = 1 ] || fail "urgent api: one control_request expected: control.log=[$(cat "$STUB/control.log")] turns.log=[$(cat "$STUB/turns.log")] events=$(jq -c '[.event // .type] ' "$RUNS/$J10/events.jsonl" | tr '\n' ' ')"
[ "$(jq -rs '[.[] | select(.event == "interrupt_requested" or .event == "message_delivered") | .event] | join(",")' "$RUNS/$J10/events.jsonl")" = "message_delivered,interrupt_requested,message_delivered" ] || fail "urgent api: event order"
"$NARU" run stop "$J10" >/dev/null
wait_for 10 "urgent api run stopped" status_is "$J10" stopped
ok "urgent send over the API: 202, one control_request, interrupt_requested before the delivery, echo: urgent"

# ---- pending marker: a message sent mid-turn leaves message-pending until claude acts again ----
: > "$STUB/turns.log"
echo 6 > "$STUB/sleep-secs"
J11=$("$NARU" run start --model haiku --cwd "$TMP/work" "marker turn" | jq -r .job_id)
wait_for 10 "marker: first delivered" delivered_is "$J11" 1
wait_for 10 "marker: stub began the turn" test -s "$STUB/turns.log"
[ "$(head -n1 "$STUB/turns.log")" = "$RUNS/$J11" ] || fail "marker: NARU_RUN_DIR in the stub's env should be the job dir: $(cat "$STUB/turns.log")"
[ ! -e "$RUNS/$J11/message-pending" ] || fail "marker: idle-state first delivery must not create it"
"$NARU" run send "$J11" "mid-wait" >/dev/null
wait_for 5 "marker: appears after a plain send mid-turn" test -e "$RUNS/$J11/message-pending"
wait_for 15 "marker: gone once the turn continues" test ! -e "$RUNS/$J11/message-pending"
wait_for 10 "marker: stub read the mid-wait message" turns_at_least 2
echo 0 > "$STUB/sleep-secs"
# Turn 2 still holds its 6 s sleep: let it answer before an idle message goes in.
wait_for 20 "marker: mid-wait answered" result_is "$J11" "echo: mid-wait"
wait_for 15 "marker: run settled" status_is "$J11" idle
"$NARU" run send "$J11" "idle one" >/dev/null
wait_for 10 "marker: idle message answered" result_is "$J11" "echo: idle one"
[ ! -e "$RUNS/$J11/message-pending" ] || fail "marker: an idle delivery must not create it"
"$NARU" run stop "$J11" >/dev/null
wait_for 10 "marker run stopped" status_is "$J11" stopped
ok "pending marker: NARU_RUN_DIR reached claude; a mid-turn send created message-pending, the turn continuing removed it, idle sends made none"

# ---- idle timeout ----
J2=$("$NARU" run start --model haiku --cwd "$TMP/work" --idle-timeout 2 "short lived" | jq -r .job_id)
wait_for 10 "result" result_is "$J2" "echo: short lived"
wait_for 10 "idle timeout -> finished" status_is "$J2" finished
ok "idle timeout wound the run down to finished"

# ---- idle guard: a waiting run is not idle-killed; a self-started turn is a turn ----
mkdir -p "$TMP/idle-bg" "$TMP/idle-self"
echo 2 > "$STUB/sleep-secs"
J7=$("$NARU" run start --model haiku --cwd "$TMP/idle-bg" --idle-timeout 2 "guard me" | jq -r .job_id)
touch "$STUB/bg-on.idle-bg"
wait_for 10 "guard: result" result_is "$J7" "echo: guard me"
echo 0 > "$STUB/sleep-secs"
wait_for 10 "guard: idle" status_is "$J7" idle
sleep 6
status_is "$J7" idle || fail "idle guard: run with a background task left idle (status $(job_field "$J7" status))"
grep -q idle_timeout "$RUNS/$J7/events.jsonl" && fail "idle guard: idle_timeout fired with a background task"
touch "$STUB/bg-off.idle-bg"
wait_for 10 "guard: tasks [] -> finished" status_is "$J7" finished
ok "idle guard: a run with one background task stayed idle past its timeout, finished within 10 s of tasks: []"
J8=$("$NARU" run start --model haiku --cwd "$TMP/idle-self" --idle-timeout 2 "self" | jq -r .job_id)
wait_for 10 "self: first result" result_is "$J8" "echo: self"
wait_for 10 "self: idle" status_is "$J8" idle
touch "$STUB/self-turn.idle-self"
wait_for 5 "self: unprompted turn -> running" status_is "$J8" running
sleep 3.2
status_is "$J8" running || fail "idle guard: idle end fired during a self-started turn (status $(job_field "$J8" status))"
wait_for 10 "self: result -> idle" result_is "$J8" "self-started"
status_is "$J8" idle || [ "$(job_field "$J8" status)" = finished ] || fail "self: unexpected status"
ok "idle guard: an unprompted turn showed running (not killed by a 2 s timeout), then idle"

# ---- CLI shapes ----
"$NARU" run list | jq -e 'length == 13' >/dev/null || fail "run list"
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

# ---- scope: the main-thread view of the event log ----
touch "$STUB/subagent"
JS=$("$NARU" run start --model haiku --cwd "$TMP/work" "scope me" | jq -r .job_id)
wait_for 10 "scope: result" result_is "$JS" "echo: scope me"
rm -f "$STUB/subagent"
SUBQ='[.events[]|select((.parent_tool_use_id // null)!=null or .owned_by_subagent==true)]|length'
all_n=$("$NARU" run show "$JS" --events | jq "$SUBQ")
[ "$all_n" -gt 0 ] || fail "scope: default view has no subagent lines ($all_n)"
[ "$("$NARU" run show "$JS" --main | jq "$SUBQ")" = 0 ] || fail "scope: --main kept a subagent line"
[ "$(api "$BASE/api/runs/$JS?scope=main" | jq "$SUBQ")" = 0 ] || fail "scope: ?scope=main kept a subagent line"
[ "$(api "$BASE/api/runs/$JS?scope=all" | jq "$SUBQ")" = "$all_n" ] || fail "scope: ?scope=all differs from default"
[ "$(api "$BASE/api/runs/$JS" | jq "$SUBQ")" = "$all_n" ] || fail "scope: default API view changed"
[ "$("$NARU" run show "$JS" --main --tail 1 | jq '.events[0].type')" = '"result"' ] || fail "scope: --tail did not count after the filter"
code=$(curl -s -o "$TMP/scope.json" -w '%{http_code}' "$BASE/api/runs/$JS?scope=bogus")
[ "$code" = 422 ] && [ "$(jq -r .error.code "$TMP/scope.json")" = validation ] || fail "scope: ?scope=bogus answered $code"
ok "show --main / ?scope=main has no line with parent_tool_use_id or owned_by_subagent, default output unchanged, --tail counts after the filter, ?scope=bogus 422"

# ---- wait: idle / silent / deadline / stopped, each with its exit code and JSON ----
wait_rc() { # <outfile> <args...>: runs `run wait`, prints its exit code
  local out=$1; shift
  set +e; "$NARU" run wait "$@" >"$out" 2>"$out.err"; local rc=$?; set -e
  echo "$rc"
}
echo 2 > "$STUB/sleep-secs"
JW=$("$NARU" run start --model haiku --cwd "$TMP/work" "wait me" | jq -r .job_id)
rc=$(wait_rc "$TMP/w1.json" "$JW" --deadline 30)
[ "$rc" = 0 ] || fail "wait idle: rc=$rc $(cat "$TMP/w1.json" "$TMP/w1.json.err")"
jq -e '.reason == "idle" and .job.status == "idle" and .job.last_result == "echo: wait me" and (.job.events | length) > 0' "$TMP/w1.json" >/dev/null || fail "wait idle json: $(cat "$TMP/w1.json")"
rc=$(wait_rc "$TMP/w1b.json" "$JW" --deadline 5)
[ "$rc" = 0 ] && jq -e '.reason == "idle"' "$TMP/w1b.json" >/dev/null || fail "wait on an already idle run: rc=$rc"
echo 8 > "$STUB/sleep-secs"
"$NARU" run send "$JW" "slow one" >/dev/null
wait_for 10 "slow turn delivered" delivered_is "$JW" 2
rc=$(wait_rc "$TMP/w2.json" "$JW" --silence 2 --deadline 30)
[ "$rc" = 10 ] || fail "wait silent: rc=$rc $(cat "$TMP/w2.json")"
jq -e '.reason == "silent" and .job.status == "running"' "$TMP/w2.json" >/dev/null || fail "wait silent json: $(cat "$TMP/w2.json")"
rc=$(wait_rc "$TMP/w3.json" "$JW" --deadline 2)
[ "$rc" = 11 ] || fail "wait deadline: rc=$rc $(cat "$TMP/w3.json")"
jq -e '.reason == "deadline" and .job.status == "running"' "$TMP/w3.json" >/dev/null || fail "wait deadline json: $(cat "$TMP/w3.json")"
[ ! -s "$STUB/control.log" ] || [ "$(wc -l < "$STUB/control.log" | tr -d " ")" = 1 ] || fail "wait must send nothing to claude"
[ "$(grep -c message_delivered "$RUNS/$JW/events.jsonl")" = 2 ] || fail "wait must not message the run"
"$NARU" run stop "$JW" >/dev/null
wait_for 10 "wait run stopped" status_is "$JW" stopped
rc=$(wait_rc "$TMP/w4.json" "$JW" --deadline 5)
[ "$rc" = 12 ] && jq -e '.reason == "stopped"' "$TMP/w4.json" >/dev/null || fail "wait stopped: rc=$rc $(cat "$TMP/w4.json")"
rc=$(wait_rc "$TMP/w5.json" deadbeef --deadline 1)
[ "$rc" = 1 ] && [ "$(jq -r .error.code "$TMP/w5.json.err")" = not_found ] || fail "wait unknown run: rc=$rc $(cat "$TMP/w5.json.err")"
echo 0 > "$STUB/sleep-secs"
ok "wait: idle (0, also already idle), silent (10), deadline (11), stopped (12) each with {reason, job}; unknown run not_found; the run neither messaged nor interrupted"

# ---- the gate: every route refuses a foreign Host ----
for route in "GET /api/runs" "GET /api/runs/$ID" "POST /api/runs" "POST /api/runs/$ID/message" "POST /api/runs/$ID/stop" "POST /api/runs/$ID/interrupt"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example:80' -H 'Content-Type: application/json' -X "${route%% *}" -d '{}' "$BASE${route#* }")
  [ "$code" = 403 ] || fail "$route with a foreign Host answered $code, expected 403"
done
ok "all six routes refuse a foreign Host"

echo "runner-check: $CHECKS checks passed"
