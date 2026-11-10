#!/usr/bin/env bash
# Phone-answer gate (naru task 2699): a workflow approval gate answered from
# Telegram. `src/core/phone.rs` (the one `vox events --json` reader `serve`
# supervises) and the gate notification of `src/core/workflow.rs`, against a
# stub `vox` (MESA_VOX_BIN) that records its argv and whose `events --json` tails
# a file this script appends to. No real vox is ever run: a guard `vox` at the
# front of PATH records any call, and the last check asserts there was none.
#
# Covers, in order (one `serve` for 1-5, since a restarted `tail` replays):
#   1. the gate notification: --choice Approve / Cancel before --button, the
#      reply hint in the text;
#   2. a choice tap approves / rejects (reason `telegram`), the run takes that
#      edge, and the message is edited "- Approved|Cancelled (from Telegram)";
#   3. replies: approve, cancel, an unrecognised one (hinted, still pending),
#      then " YES ";
#   4. the first answer wins: a tap after a CLI decision changes nothing and the
#      message is edited "(in Naru)";
#   5. malformed / mismatched lines change nothing;
#   6. no usable vox, and an older vox (no `events`): the gate still works, plain
#      notification, no reader;
#   7. a non-real NARU_HOME with no vox override: vox is never called.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }

cargo build --quiet
NARU=target/debug/naru

TMP=$(mktemp -d)
STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
trap '[ -n "${RUNPID:-}" ] && kill "$RUNPID" 2>/dev/null;
      [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null;
      pkill -f "$STUB_DIR/events.jsonl" 2>/dev/null;
      rm -rf "$TMP"; true' EXIT
export MESA_DB="$TMP/mesa.db"
export HOME=$(mkdir -p "$TMP/home" && cd "$TMP/home" && pwd -P)
export MESA_CONFIG_FILE="$TMP/config.json"
export STUB_DIR

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

# The real vox must never run: a guard first on PATH records the call.
mkdir -p "$TMP/guard"
cat > "$TMP/guard/vox" <<GUARD_EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMP/real-vox-called"
exit 1
GUARD_EOF
chmod +x "$TMP/guard/vox"
export PATH="$TMP/guard:$PATH"

# Fixed ports no other gate uses; they must be free.
P_MAIN=17841 P_NOVOX=17842 P_OLD=17843 P_SANDBOX=17844
for p in $P_MAIN $P_NOVOX $P_OLD $P_SANDBOX; do
  ! lsof -nP -iTCP:"$p" >/dev/null 2>&1 || fail "port $p is in use; this gate needs 17841-17844 free"
done

# The stub vox. One argv element per line, then --END--.
cat > "$STUB_DIR/vox" <<'STUB_EOF'
#!/usr/bin/env bash
case "$1" in
  events)
    [ "${2:-}" = --help ] && exit 0
    echo started >> "$STUB_DIR/events-started"
    exec tail -n +1 -F "$STUB_DIR/events.jsonl"
    ;;
  notify)
    n=$(cat "$STUB_DIR/counter")
    echo $((n + 1)) > "$STUB_DIR/counter"
    echo "$n" >> "$STUB_DIR/notify.ids"
    { printf '%s\n' "$@"; echo --END--; } >> "$STUB_DIR/notify.log"
    printf '{"message_id":%s,"chat_id":7}\n' "$n"
    ;;
  progress)
    { printf '%s\n' "$@"; echo --END--; } >> "$STUB_DIR/progress.log"
    ;;
  *) exit 2 ;;
esac
STUB_EOF
chmod +x "$STUB_DIR/vox"
echo 1000 > "$STUB_DIR/counter"
: > "$STUB_DIR/events.jsonl"
export MESA_VOX_BIN="$STUB_DIR/vox"

# ---------------------------------------------------------------- helpers
# poll DESC CMD... — runs CMD (a function) every 0.1s for up to 15s.
poll() {
  local desc=$1
  shift
  for _ in $(seq 1 150); do "$@" && return 0; sleep 0.1; done
  fail "timed out waiting for $desc"
}
wait_serve() { # <port> <log>
  local port=$1 log=$2
  for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$port/api/version" >/dev/null 2>&1 && return 0; sleep 0.1; done
  fail "serve on $port did not start (log: $(cat "$log"))"
}
stop_serve() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=
}
notify_count() { [ -f "$STUB_DIR/notify.log" ] && grep -c '^--END--$' "$STUB_DIR/notify.log" || echo 0; }
nth_notify() { awk -v n="$1" '/^--END--$/{i++; next} i==n-1{print}' "$STUB_DIR/notify.log"; }
# progress_texts <message id> — the text (last argv element) of each progress call for it.
progress_texts() {
  [ -f "$STUB_DIR/progress.log" ] || return 0
  awk -v m="$1" '/^--END--$/{ if (hit) print last; hit=0; next } { last=$0; if ($0==m) hit=1 }' "$STUB_DIR/progress.log"
}
progress_n() { progress_texts "$1" | grep -c . || true; }
feed() { printf '%s\n' "$1" >> "$STUB_DIR/events.jsonl"; }
tap() { feed "$(jq -nc --argjson m "$1" --arg d "$2" '{kind:"choice",message_id:$m,data:$d,user_id:1}')"; }
reply() { feed "$(jq -nc --argjson to "$1" --argjson m "$2" --arg t "$3" '{kind:"reply",reply_to_message_id:$to,message_id:$m,text:$t,user_id:1}')"; }
gate_status() { "$NARU" workflow gate list --all | jq -r --argjson g "$1" '.[] | select(.id == $g) | .status'; }
all_gates() { "$NARU" workflow gate list --all | jq -cS '[.[] | {id, status, reason}] | sort_by(.id)'; }
hint_seen() { grep -qx -- "--reply-to=$1" "$STUB_DIR/notify.log" 2>/dev/null; }
barrier() { # <gate message id> <reply message id> — an unrecognised reply, then wait for its hint
  reply "$1" "$2" "what is this?"
  poll "the hint for reply $2" hint_seen "$2"
}

# make_wf <name> — trigger -> gate(approved: Yes, rejected: No)
make_wf() {
  local wf=$1 t g y n
  "$NARU" workflow create "$wf" >/dev/null
  t=$("$NARU" workflow node create "$wf" trigger Start | jq -r .id)
  g=$("$NARU" workflow node create "$wf" gate Approve --config '{"message":"Ship it?","timeout_secs":60}' | jq -r .id)
  y=$("$NARU" workflow node create "$wf" cli Yes --config '{"command":"echo went-yes"}' | jq -r .id)
  n=$("$NARU" workflow node create "$wf" cli No --config '{"command":"echo went-no"}' | jq -r .id)
  "$NARU" workflow edge create "$wf" "$t" "$g" >/dev/null
  "$NARU" workflow edge create "$wf" "$g" "$y" --branch approved >/dev/null
  "$NARU" workflow edge create "$wf" "$g" "$n" --branch rejected >/dev/null
}
pending_gate() { # prints the id of the one pending gate
  local id
  for _ in $(seq 1 150); do
    id=$("$NARU" workflow gate list | jq -r '.[0].id // empty')
    [ -n "$id" ] && { echo "$id"; return; }
    sleep 0.1
  done
  fail "no pending gate appeared"
}
# start_run <wf> [--no-notify] — starts the run in the background; sets RUNPID,
# RUNOUT, G (the gate id) and, when a notification is expected, M (its message id,
# once phone_prompts holds the row, so a tap right after cannot be lost).
RUNN=0
start_run() {
  local wf=$1 before
  before=$(notify_count)
  RUNN=$((RUNN + 1))
  RUNOUT="$TMP/run.$RUNN.json"
  "$NARU" workflow run "$wf" >"$RUNOUT" 2>"$TMP/run.$RUNN.err" &
  RUNPID=$!
  G=$(pending_gate)
  [ "${2:-}" = --no-notify ] && return 0
  count_grew() { [ "$(notify_count)" -gt "$before" ]; }
  poll "the gate notification" count_grew
  M=$(sed -n "$((before + 1))p" "$STUB_DIR/notify.ids")
  have_row() { [ "$(sqlite3 "$MESA_DB" "select count(*) from phone_prompts where message_id=$M")" = 1 ]; }
  poll "the phone_prompts row for $M" have_row
}
wait_run() { # waits (bounded) for RUNPID; sets STDOUT to the run JSON
  for _ in $(seq 1 150); do kill -0 "$RUNPID" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$RUNPID" 2>/dev/null && fail "the run did not finish (gate $G: $(gate_status "$G"))"
  wait "$RUNPID" || fail "the run exited nonzero: $(cat "$TMP/run.$RUNN.err")"
  RUNPID=
  STDOUT=$(cat "$RUNOUT")
}
step_status() { jq -r --arg t "$1" '.steps[] | select(.title == $t) | .status' <<<"$STDOUT"; }
gate_reason() { "$NARU" workflow gate list --all --run "$(jq -r .id <<<"$STDOUT")" | jq -r '.[0].reason'; }
expect_path() { # <Yes|No> — the run succeeded on that edge only
  [ "$(jq -r .status <<<"$STDOUT")" = succeeded ] || fail "run status: $STDOUT"
  if [ "$1" = Yes ]; then
    [ "$(step_status Yes)" = ok ] && [ "$(step_status No)" = skipped ] || fail "approved path only: $STDOUT"
  else
    [ "$(step_status No)" = ok ] && [ "$(step_status Yes)" = skipped ] || fail "rejected path only: $STDOUT"
  fi
}
edited_to() { progress_texts "$1" | grep -q -- "$2\$"; } # <message id> <suffix>

# =====================================================================
# serve with the stub vox
# =====================================================================
echo "{\"notify\":{\"base-url\":\"http://127.0.0.1:$P_MAIN\"}}" > "$MESA_CONFIG_FILE"
"$NARU" serve --port "$P_MAIN" >"$TMP/serve.log" 2>&1 &
SERVER_PID=$!
wait_serve "$P_MAIN" "$TMP/serve.log"
started() { [ -s "$STUB_DIR/events-started" ]; }
poll "serve to start \`vox events --json\`" started
make_wf approver

# ---- 1. the notification ----
start_run approver
G1=$G M1=$M
E=$(nth_notify 1)
WFID=$("$NARU" workflow list | jq -r '.[] | select(.name == "approver") | .id')
[ "$(grep -c '^--END--$' "$STUB_DIR/notify.log")" = 1 ] || fail "expected exactly one notify: $(cat "$STUB_DIR/notify.log")"
line_of() { printf '%s\n' "$E" | grep -nxF -- "$1" | head -1 | cut -d: -f1; }
L_APP=$(line_of "Approve=gate:$G1:approve")
L_CAN=$(line_of "Cancel=gate:$G1:reject")
L_BTN=$(line_of "Open Naru=http://127.0.0.1:$P_MAIN/open/workflows/$WFID")
[ -n "$L_APP" ] && [ -n "$L_CAN" ] && [ -n "$L_BTN" ] || fail "choices / button missing: $E"
[ "$(printf '%s\n' "$E" | sed -n "$((L_APP - 1))p")" = --choice ] || fail "--choice before Approve: $E"
[ "$(printf '%s\n' "$E" | sed -n "$((L_CAN - 1))p")" = --choice ] || fail "--choice before Cancel: $E"
[ "$(printf '%s\n' "$E" | sed -n "$((L_BTN - 1))p")" = --button ] || fail "--button before Open Naru: $E"
[ "$L_APP" -lt "$L_BTN" ] && [ "$L_CAN" -lt "$L_BTN" ] || fail "choices come before --button: $E"
printf '%s\n' "$E" | grep -qx -- '--title=Naru: approval needed' || fail "title missing: $E"
printf '%s\n' "$E" | grep -q 'reply approve / cancel' || fail "reply hint missing: $E"
ok "1: a gate run sends exactly one notify with --choice Approve/Cancel before --button, the title, the Open Naru button and the reply hint"

# ---- 2. taps ----
tap "$M1" "gate:$G1:approve"
wait_run
expect_path Yes
[ "$(gate_status "$G1")" = approved ] && [ "$(gate_reason)" = telegram ] || fail "tap approve: $(all_gates)"
poll "the Approved edit" edited_to "$M1" " - Approved (from Telegram)"
ok "2a: a choice tap approves (reason telegram), takes the approved edge, and the message is edited '- Approved (from Telegram)'"

start_run approver
G2=$G M2=$M
tap "$M2" "gate:$G2:reject"
wait_run
expect_path No
[ "$(gate_status "$G2")" = rejected ] && [ "$(gate_reason)" = telegram ] || fail "tap reject: $(all_gates)"
poll "the Cancelled edit" edited_to "$M2" " - Cancelled (from Telegram)"
ok "2b: a reject tap takes the rejected edge and the message is edited '- Cancelled (from Telegram)'"

# ---- 3. replies ----
start_run approver
G3=$G M3=$M
reply "$M3" 5001 approve
wait_run
expect_path Yes
[ "$(gate_status "$G3")" = approved ] && [ "$(gate_reason)" = telegram ] || fail "reply approve: $(all_gates)"
poll "the reply Approved edit" edited_to "$M3" " - Approved (from Telegram)"
ok "3a: a reply 'approve' approves"

start_run approver
G4=$G M4=$M
reply "$M4" 5002 cancel
wait_run
expect_path No
[ "$(gate_status "$G4")" = rejected ] && [ "$(gate_reason)" = telegram ] || fail "reply cancel: $(all_gates)"
poll "the reply Cancelled edit" edited_to "$M4" " - Cancelled (from Telegram)"
ok "3b: a reply 'cancel' rejects"

start_run approver
G5=$G M5=$M
barrier "$M5" 5003
grep -qxF 'Reply approve or cancel, or tap a button.' "$STUB_DIR/notify.log" || fail "hint text: $(cat "$STUB_DIR/notify.log")"
[ "$(gate_status "$G5")" = pending ] || fail "an unrecognised reply must leave the gate pending: $(all_gates)"
reply "$M5" 5004 " YES "
wait_run
expect_path Yes
[ "$(gate_status "$G5")" = approved ] || fail "' YES ': $(all_gates)"
ok "3c: an unrecognised reply is hinted and leaves the gate pending; ' YES ' then approves"

# ---- 4. first answer wins ----
start_run approver
G6=$G M6=$M
"$NARU" workflow gate approve "$G6" >/dev/null
wait_run
expect_path Yes
one_edit() { [ "$(progress_n "$M6")" -ge 1 ]; }
poll "the run's own edit of $M6" one_edit
BEFORE=$(progress_n "$M6")
tap "$M6" "gate:$G6:reject"
grew() { [ "$(progress_n "$M6")" -gt "$BEFORE" ]; }
poll "an edit for the late tap" grew
[ "$(gate_status "$G6")" = approved ] || fail "a late tap changed the gate: $(all_gates)"
kill -0 "$SERVER_PID" 2>/dev/null || fail "serve died on a late tap"
[ "$(progress_texts "$M6" | tail -1 | grep -c ' - Approved (in Naru)$')" = 1 ] || fail "late-tap edit text: $(progress_texts "$M6")"
ok "4: the first answer wins: a tap after a CLI decision changes nothing and edits the message '- Approved (in Naru)'"

# ---- 5. lines that change nothing ----
start_run approver
G7=$G M7=$M
SNAP=$(all_gates)
feed 'this is not json'
feed '{"kind":"choice"}'
tap "$M7" "gate:x:approve"
tap "$M7" "gate:$G7:maybe"
tap "$M7" "gate:999999:approve"
tap 424242 "gate:$G7:approve"
tap "$M7" "gate:$G1:approve"
reply 424242 5010 approve
barrier "$M7" 5011
[ "$(gate_status "$G7")" = pending ] || fail "a bad line decided the gate: $(all_gates)"
[ "$(all_gates)" = "$SNAP" ] || fail "a bad line changed a gate: before $SNAP after $(all_gates)"
kill -0 "$SERVER_PID" 2>/dev/null || fail "serve died on a bad line"
"$NARU" workflow gate reject "$G7" >/dev/null
wait_run
expect_path No
ok "5: malformed, mismatched and unknown-message lines change nothing"
stop_serve

# =====================================================================
# 6. no usable vox, and an older vox
# =====================================================================
export MESA_DB="$TMP/b.db"
export MESA_VOX_BIN="$STUB_DIR/no-such-vox"
"$NARU" serve --port "$P_NOVOX" >"$TMP/serve-novox.log" 2>&1 &
SERVER_PID=$!
wait_serve "$P_NOVOX" "$TMP/serve-novox.log"
make_wf approver
start_run approver --no-notify
"$NARU" workflow gate approve "$G" >/dev/null
wait_run
expect_path Yes
ok "6a: with no usable vox, serve starts and a gate run still waits, is decided by the CLI and takes the approved edge"
stop_serve

OLD="$TMP/old"
mkdir -p "$OLD"
cat > "$OLD/vox" <<'OLD_EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/old-calls"
[ "$1" = notify ] || exit 2
{ printf '%s\n' "$@"; echo --END--; } >> "$STUB_DIR/old-notify.log"
echo '{"message_id":77,"chat_id":7}'
OLD_EOF
chmod +x "$OLD/vox"
export MESA_VOX_BIN="$OLD/vox"
"$NARU" serve --port "$P_OLD" >"$TMP/serve-old.log" 2>&1 &
SERVER_PID=$!
wait_serve "$P_OLD" "$TMP/serve-old.log"
probed() { grep -qx 'events --help' "$STUB_DIR/old-calls" 2>/dev/null; }
poll "the reader to probe the older vox" probed
start_run approver --no-notify
sent() { [ -s "$STUB_DIR/old-notify.log" ]; }
poll "the plain notification" sent
"$NARU" workflow gate approve "$G" >/dev/null
wait_run
expect_path Yes
! grep -q -- '--choice' "$STUB_DIR/old-notify.log" || fail "older vox got --choice: $(cat "$STUB_DIR/old-notify.log")"
! grep -q 'reply approve' "$STUB_DIR/old-notify.log" || fail "older vox got the reply sentence: $(cat "$STUB_DIR/old-notify.log")"
grep -qx -- '--title=Naru: approval needed' "$STUB_DIR/old-notify.log" || fail "plain notification title: $(cat "$STUB_DIR/old-notify.log")"
sleep 1 # a reader that was going to start has had its chance
! grep -qx 'events --json' "$STUB_DIR/old-calls" || fail "serve started \`events --json\` on an older vox: $(cat "$STUB_DIR/old-calls")"
ok "6b: an older vox gets today's plain notification (no --choice, no reply sentence) and serve never starts \`events --json\`"
stop_serve

# =====================================================================
# 7. a non-real home, no override: vox is not called
# =====================================================================
SBX="$TMP/sbx"
mkdir -p "$SBX"
cat > "$SBX/vox" <<SBX_EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMP/sandbox-vox-called"
exit 2
SBX_EOF
chmod +x "$SBX/vox"
(
  unset MESA_VOX_BIN
  export MESA_DB="$TMP/c.db"
  export PATH="$SBX:$PATH"
  export NARU_HOME="$TMP/sandbox-home"
  mkdir -p "$NARU_HOME"
  "$NARU" serve --port "$P_SANDBOX" >"$TMP/serve-sbx.log" 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
  wait_serve "$P_SANDBOX" "$TMP/serve-sbx.log"
  sleep 2
  make_wf approver
  start_run approver --no-notify
  "$NARU" workflow gate approve "$G" >/dev/null
  wait_run
  expect_path Yes
  sleep 1
) || exit 1
[ ! -e "$TMP/sandbox-vox-called" ] || fail "a sandbox run called vox: $(cat "$TMP/sandbox-vox-called")"
ok "7: with a non-real NARU_HOME and no override, serve and the gate run never call vox (no events, notify or progress)"

# The other direction, and section 7's control: the real install's shape (no
# NARU_HOME, NARU_DB naming the account's own default db, as the launchd plist
# does; HOME here is the throwaway one) does look for a reader.
(
  unset MESA_VOX_BIN
  case "$(uname)" in
    Darwin) OWN_DB="$HOME/Library/Application Support/naru/naru.db" ;;
    *) OWN_DB="${XDG_DATA_HOME:-$HOME/.local/share}/naru/naru.db" ;;
  esac
  mkdir -p "$(dirname "$OWN_DB")"
  export MESA_DB="$OWN_DB"
  export PATH="$SBX:$PATH"
  for _ in $(seq 1 50); do lsof -i ":$P_SANDBOX" >/dev/null 2>&1 || break; sleep 0.1; done
  "$NARU" serve --port "$P_SANDBOX" >"$TMP/serve-own.log" 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
  wait_serve "$P_SANDBOX" "$TMP/serve-own.log"
  for _ in $(seq 1 150); do grep -qx 'events --help' "$TMP/sandbox-vox-called" 2>/dev/null && break; sleep 0.1; done
) || exit 1
grep -qx 'events --help' "$TMP/sandbox-vox-called" 2>/dev/null ||
  fail "the real install's shape (own db, no NARU_HOME) must probe vox for a reader: $(cat "$TMP/sandbox-vox-called" 2>/dev/null)"
ok "7b: with the account's own db and no NARU_HOME, serve does probe vox for a reader"

# =====================================================================
[ ! -e "$TMP/real-vox-called" ] || fail "the real vox was called: $(cat "$TMP/real-vox-called")"
ok "8: the real vox was never called (real_telegram_messages = 0)"

echo "all $CHECKS checks passed"
