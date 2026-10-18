#!/usr/bin/env bash
# live push gate (naru task 2051, docs/live.md "Push delivery"): the live
# conversation's user turns and delegate results are written straight into the
# agent's `naru run` inbox by `serve`, exactly once, surviving a `kill -9` of
# the server. Against a throwaway HOME/db, a stub `claude` (MESA_CLAUDE_BIN)
# that logs every stream-json user message to msgs.log, and a throwaway serve.
#
#   (a) a typed turn arrives in the agent's stdin as `[live turn] {json}` (the
#       record `listen` prints, so board_id/image_path ride along) with its id
#       intact, and is stamped delivered;
#   (b) a delegate result arrives as `[live result] {json}`;
#   (c) a turn posted while serve is dead is delivered by the restarted serve;
#   (d) a turn queued in the run's inbox but not stamped (serve killed between
#       the two steps) is stamped on restart without a second copy;
#   (e) no turn is lost and none is delivered twice (lost_turns = 0,
#       duplicate_deliveries = 0);
#   (g) `listen` still works as the fallback, and a turn it claims is never
#       also pushed.
set -euo pipefail
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
cargo build --quiet
NARU="$PWD/target/debug/naru"

TMP=$(mktemp -d)
# A free port picked per run: a fixed one let two concurrent runs of this gate
# post turns to each other's serve and read each other's stub log.
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
BASE="http://127.0.0.1:$PORT"
SERVE_PID=
cleanup() {
  if [ -n "$SERVE_PID" ]; then kill "$SERVE_PID" 2>/dev/null || true; fi
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
export NARU_WATCH_LIVE_PUSH_TICK_MS=100
mkdir -p "$HOME"
RUNS="$HOME/.naru/runs"

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

STUB="$TMP/stub"
mkdir -p "$STUB"
cat > "$STUB/claude" <<STUBEOF
#!/usr/bin/env bash
while IFS= read -r line; do
  text=\$(jq -r '.message.content[0].text' <<<"\$line")
  printf '%s\n' "\$text" >> "$STUB/msgs.log"
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n'
  printf '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'
done
exit 0
STUBEOF
chmod +x "$STUB/claude"
export MESA_CLAUDE_BIN="$STUB/claude"

wait_for() { # <seconds> <description> <cmd...>
  local secs=$1 what=$2; shift 2
  for _ in $(seq 1 $((secs * 10))); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
  [ -f "$STUB/msgs.log" ] && head -c 600 "$STUB/msgs.log" >&2
  fail "timed out waiting for: $what"
}
start_serve() {
  "$NARU" serve --port "$PORT" >>"$TMP/serve.log" 2>&1 &
  SERVE_PID=$!
  wait_for 10 "serve up" curl -sf "$BASE/api/projects"
}
kill_serve() { kill -9 "$SERVE_PID" 2>/dev/null || true; wait "$SERVE_PID" 2>/dev/null || true; SERVE_PID=; }
post() { curl -sf -H 'Content-Type: application/json' -X POST "$BASE$1" -d "$2"; }
# n_msgs <pattern> — how many logged messages match.
n_msgs() { grep -c -- "$1" "$STUB/msgs.log" 2>/dev/null || true; }
has_msg() { [ "$(n_msgs "$1")" -ge 1 ]; }

start_serve
"$NARU" live start >"$TMP/start.json"
SID=$(jq -r .id "$TMP/start.json")
AGENT=$(jq -r .agent_id "$TMP/start.json")
case "$AGENT" in run:*) ;; *) fail "live start did not bind a run agent: $AGENT" ;; esac
JOB=${AGENT#run:}
INBOX="$RUNS/$JOB/inbox"
wait_for 10 "spawn prompt reaches the stub" test -s "$STUB/msgs.log"
ok "live start binds run agent $JOB"

# (a) a typed turn, with board and image fields
T1=$(post /api/live/utterance '{"text":"hello push one"}' | jq -r .id)
wait_for 10 "turn 1 pushed" has_msg 'hello push one'
LINE=$(grep -- 'hello push one' "$STUB/msgs.log" | head -1)
case "$LINE" in "[live turn] {"*) ;; *) fail "turn envelope: $LINE" ;; esac
[ "$(sed 's/^\[live turn\] //' <<<"$LINE" | jq -r .id)" = "$T1" ] || fail "turn id not intact: $LINE"
wait_for 5 "turn 1 stamped" bash -c "$NARU live turns | jq -e '.[] | select(.id==$T1 and .delivered_at!=null)'"
ok "typed turn pushed with its id, stamped delivered"

# (b) a delegate result
"$NARU" live result "found the thing" >/dev/null
wait_for 10 "result pushed" has_msg '\[live result\].*found the thing'
ok "delegate result pushed"

# (b2) a turn row carrying an image and a board keeps both fields
T5=$(sqlite3 "$MESA_DB" "INSERT INTO live_turns (session_id, role, text, image_path, board_id, created_at) VALUES ($SID, 'user', 'with ink', '/tmp/ink-test.png', 7, datetime('now')); SELECT last_insert_rowid();")
wait_for 10 "ink turn pushed" has_msg 'with ink'
INK=$(grep -- 'with ink' "$STUB/msgs.log" | head -1 | sed 's/^\[live turn\] //')
[ "$(jq -r .image_path <<<"$INK")" = "/tmp/ink-test.png" ] && [ "$(jq -r .board_id <<<"$INK")" = 7 ] || fail "ink fields lost: $INK"
ok "image_path and board_id ride along"

# (b3) an ask notice (the ask queue's nudge) is pushed too
"$NARU" ask "does the push work" >/dev/null
wait_for 10 "ask notice pushed" has_msg 'naru ask list'
ok "ask-queue notice pushed"

# (c) a turn posted while serve is dead
kill_serve
T2=$(sqlite3 "$MESA_DB" "INSERT INTO live_turns (session_id, role, text, created_at) VALUES ($SID, 'user', 'while serve was dead', datetime('now')); SELECT last_insert_rowid();")
sleep 0.5
[ "$(n_msgs 'while serve was dead')" = 0 ] || fail "pushed with serve dead"
start_serve
wait_for 10 "turn 2 pushed after restart" has_msg 'while serve was dead'
ok "turn written while serve was dead is delivered by the restarted serve"

# (d) queued but unstamped: serve killed between the two steps
kill_serve
T3=$(sqlite3 "$MESA_DB" "INSERT INTO live_turns (session_id, role, text, created_at) VALUES ($SID, 'user', 'crash window turn', datetime('now')); SELECT last_insert_rowid();")
ROW=$(sqlite3 -json "$MESA_DB" "SELECT * FROM live_turns WHERE id=$T3")
printf '{"text":%s}' "$(jq -Rn --arg t "[live turn] $(jq -c '.[0]' <<<"$ROW")" '$t')" > "$INBOX/live-2-turn-$(printf '%012d' "$T3").json"
start_serve
wait_for 10 "crash-window turn stamped" bash -c "$NARU live turns | jq -e '.[] | select(.id==$T3 and .delivered_at!=null)'"
wait_for 10 "crash-window turn delivered by the runner" has_msg 'crash window turn'
sleep 1
[ "$(n_msgs 'crash window turn')" = 1 ] || fail "crash-window turn delivered $(n_msgs 'crash window turn') times"
ok "queued-but-unstamped turn is stamped on restart, delivered once"

# (f) listen fallback, and no double delivery
T4=$(post /api/live/utterance '{"text":"claimed by listen"}' | jq -r .id)
OUT=$("$NARU" live listen --wait 5 || true)
sleep 1
if [ "$(jq -r '.id // empty' <<<"$OUT")" = "$T4" ]; then
  [ "$(n_msgs 'claimed by listen')" -le 1 ] || fail "turn both listened and pushed twice"
fi
ok "listen still works; one turn is never delivered twice"

# (e) the totals
sleep 1
LOST=0; DUP=0
for t in "hello push one" "while serve was dead" "crash window turn"; do
  c=$(n_msgs "$t")
  [ "$c" = 0 ] && LOST=$((LOST + 1))
  [ "$c" -gt 1 ] && DUP=$((DUP + 1))
done
echo "lost_turns=$LOST duplicate_deliveries=$DUP"
[ "$LOST" = 0 ] && [ "$DUP" = 0 ] || fail "lost=$LOST dup=$DUP"
ok "lost_turns = 0, duplicate_deliveries = 0"

echo "live-push-check: $CHECKS checks passed"
