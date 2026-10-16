#!/usr/bin/env bash
# stage gate (naru task 1959, docs/stage.md): `naru stage run`, the task-loop
# stage driver, against a throwaway HOME and a stub `claude` (MESA_CLAUDE_BIN)
# speaking stream-json. Per-agent files in the stub dir steer it:
# sleep.<agent> = seconds each turn takes before it answers (read when the
# message is read, so a gate can change it between turns); turns.<agent> gets
# one line per message read. Covers: normal completion; silence -> nudge ->
# recovers; silence -> nudge -> restart; deadline -> partial report; deadline
# -> INCONCLUSIVE; a parallel pair with one overrunning; status.json's shape;
# the 64 KiB cap; usage / validation shapes.
set -euo pipefail
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
NARU="$PWD/target/debug/naru"

TMP=$(mktemp -d)
cleanup() {
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

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
wait_for() { # <seconds> <description> <cmd...>
  local secs=$1 what=$2; shift 2
  for _ in $(seq 1 $((secs * 10))); do "$@" >/dev/null 2>&1 && return 0; sleep 0.1; done
  fail "timed out waiting for: $what"
}

STUB="$TMP/stub"
mkdir -p "$STUB"
cat > "$STUB/claude" <<STUBEOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$STUB/argv.log"
agent=\$(sed -n 's/.*--agent \([^ ]*\).*/\1/p' <<<"\$*")
while IFS= read -r line; do
  text=\$(jq -r '.message.content[0].text' <<<"\$line")
  s=0; [ -f "$STUB/sleep.\$agent" ] && s=\$(cat "$STUB/sleep.\$agent")
  printf 'turn\n' >> "$STUB/turns.\$agent"
  (
    [ "\$s" != 0 ] && sleep "\$s"
    printf '{"type":"assistant","message":{"content":[{"type":"text","text":%s}]}}\n' "\$(jq -Rn --arg t "\$text" '\$t')"
    printf '{"type":"result","subtype":"success","is_error":false,"result":%s}\n' "\$(jq -Rn --arg t "echo: \$text" '\$t')"
  ) &
done
wait
exit 0
STUBEOF
chmod +x "$STUB/claude"
export MESA_CLAUDE_BIN="$STUB/claude"

turns() { grep -c . "$STUB/turns.$1" 2>/dev/null || echo 0; }
turns_ge() { [ "$(turns "$1")" -ge "$2" ]; }
brief() { printf '%s' "$2" > "$TMP/$1.md"; }
stage() { # <outfile> <args...>: runs the driver, prints its exit code
  local out=$1; shift
  set +e; "$NARU" stage run --cwd "$TMP/work" "$@" >"$out" 2>"$out.err"; local rc=$?; set -e
  echo "$rc"
}

# ---- 1. normal completion ----
echo 0 > "$STUB/sleep.a-ok"
brief ok "do the thing"
rc=$(stage "$TMP/o1" --agent a-ok --deadline 30 --silence 5 --grace 2 --scratch "$TMP/s1" --brief-file "$TMP/ok.md")
[ "$rc" = 0 ] || fail "normal: exit $rc: $(cat "$TMP/o1.err")"
jq -e '.verdict=="COMPLETE" and .report=="echo: do the thing" and .partial==null and .nudges==0 and .restarts==0 and .agent=="a-ok" and (.job_ids|length)==1' "$TMP/o1" >/dev/null || fail "normal: $(cat "$TMP/o1")"
grep -q -- "--agent a-ok" "$STUB/argv.log" || fail "normal: --agent did not reach claude"
ok "normal completion"

# ---- 2. silence -> nudge -> recovers ----
echo 20 > "$STUB/sleep.a-rec"
brief rec "slow start"
( rc=$(stage "$TMP/o2" --agent a-rec --deadline 60 --silence 2 --grace 8 --scratch "$TMP/s2" --brief-file "$TMP/rec.md"); echo "$rc" > "$TMP/rc2" ) &
wait_for 10 "first turn read" turns_ge a-rec 1
echo 0 > "$STUB/sleep.a-rec"
wait_for 40 "driver done" test -s "$TMP/rc2"
[ "$(cat "$TMP/rc2")" = 0 ] || fail "recover: exit $(cat "$TMP/rc2"): $(cat "$TMP/o2.err")"
jq -e '.verdict=="COMPLETE" and (.report|startswith("echo: Status check")) and .nudges==1 and .restarts==0 and (.job_ids|length)==1' "$TMP/o2" >/dev/null || fail "recover: $(cat "$TMP/o2")"
ok "silence -> nudge -> recovers"

# ---- 3. silence -> nudge -> restart ----
echo 30 > "$STUB/sleep.a-rst"
brief rst "restart me"
( rc=$(stage "$TMP/o3" --agent a-rst --deadline 90 --silence 2 --grace 4 --scratch "$TMP/s3" --brief-file "$TMP/rst.md"); echo "$rc" > "$TMP/rc3" ) &
wait_for 10 "nudge read" turns_ge a-rst 2
echo 0 > "$STUB/sleep.a-rst"
# mid-run status: running, one nudge, no restart yet
status_is() { jq -e "$2" "$1" >/dev/null; }
wait_for 10 "status shows the nudge" status_is "$TMP/s3/status.json" '.agents[0].nudges==1'
jq -e '.agents[0].state=="running" and .agents[0].nudges==1 and .agents[0].restarts==0' "$TMP/s3/status.json" >/dev/null || fail "restart: mid-run status $(cat "$TMP/s3/status.json")"
wait_for 40 "driver done" test -s "$TMP/rc3"
[ "$(cat "$TMP/rc3")" = 0 ] || fail "restart: exit $(cat "$TMP/rc3"): $(cat "$TMP/o3.err")"
jq -e '.verdict=="COMPLETE" and .report=="echo: restart me" and .nudges==1 and .restarts==1 and (.job_ids|length)==2 and .job_id==.job_ids[1]' "$TMP/o3" >/dev/null || fail "restart: $(cat "$TMP/o3")"
[ "$(grep -c -- "--agent a-rst" "$STUB/argv.log")" = 2 ] || fail "restart: expected two claude launches"
ok "silence -> nudge -> restart"

# ---- 3b. second silence ends the stage ----
echo 30 > "$STUB/sleep.a-dead"
brief dead "never answers"
rc=$(stage "$TMP/o3b" --agent a-dead --deadline 90 --silence 1 --grace 1 --scratch "$TMP/s3b" --brief-file "$TMP/dead.md")
[ "$rc" = 0 ] || fail "second silence: exit $rc"
jq -e '.verdict=="INCONCLUSIVE" and .report==null and .restarts==1 and .nudges==2 and (.reason|test("silent"))' "$TMP/o3b" >/dev/null || fail "second silence: $(cat "$TMP/o3b")"
ok "second silence ends the stage INCONCLUSIVE, exit 0"

# ---- 4. deadline -> partial report ----
echo 30 > "$STUB/sleep.a-dl"
brief dl "long job"
( rc=$(stage "$TMP/o4" --agent a-dl --deadline 2 --grace 8 --scratch "$TMP/s4" --brief-file "$TMP/dl.md"); echo "$rc" > "$TMP/rc4" ) &
wait_for 10 "first turn read" turns_ge a-dl 1
echo 0 > "$STUB/sleep.a-dl"
wait_for 40 "driver done" test -s "$TMP/rc4"
[ "$(cat "$TMP/rc4")" = 0 ] || fail "deadline partial: exit $(cat "$TMP/rc4")"
jq -e '.verdict=="INCONCLUSIVE" and (.reason|test("deadline")) and (.partial|startswith("echo: Deadline reached")) and .report==null and .nudges==1' "$TMP/o4" >/dev/null || fail "deadline partial: $(cat "$TMP/o4")"
ok "deadline -> partial report is INCONCLUSIVE, never a pass"

# ---- 5. deadline -> INCONCLUSIVE, no report ----
echo 30 > "$STUB/sleep.a-dl2"
brief dl2 "hopeless"
rc=$(stage "$TMP/o5" --agent a-dl2 --deadline 2 --grace 2 --scratch "$TMP/s5" --brief-file "$TMP/dl2.md")
[ "$rc" = 0 ] || fail "deadline none: exit $rc"
jq -e '.verdict=="INCONCLUSIVE" and (.reason|test("deadline")) and .report==null and .nudges==1' "$TMP/o5" >/dev/null || fail "deadline none: $(cat "$TMP/o5")"
ok "deadline -> INCONCLUSIVE"

# ---- 6. parallel pair, one overruns; status.json shape ----
echo 0 > "$STUB/sleep.p-fast"; echo 30 > "$STUB/sleep.p-slow"
brief pf "fast one"; brief ps "slow one"
rc=$(stage "$TMP/o6" --agent p-fast --deadline 3 --grace 2 --scratch "$TMP/s6" --brief-file "$TMP/pf.md" --also p-slow --also-brief-file "$TMP/ps.md")
[ "$rc" = 0 ] || fail "parallel: exit $rc: $(cat "$TMP/o6.err")"
jq -e '.verdict=="INCONCLUSIVE" and (.results|length)==2 and .results[0].verdict=="COMPLETE" and .results[0].agent=="p-fast" and .results[1].verdict=="INCONCLUSIVE" and .results[1].agent=="p-slow"' "$TMP/o6" >/dev/null || fail "parallel: $(cat "$TMP/o6")"
ok "parallel pair: combined INCONCLUSIVE, fast one COMPLETE"
S="$TMP/s6/status.json"
jq -e '(keys|sort)==["agents","stage","updated_at"] and .stage=="run" and (.updated_at|type)=="number" and (.agents|length)==2' "$S" >/dev/null || fail "status top shape: $(cat "$S")"
jq -e 'all(.agents[]; (keys|sort)==["agent","job_id","job_ids","last_event_at","nudges","output_tail","restarts","started_at","state"] and (.job_id|type)=="string" and (.job_ids|type)=="array" and (.started_at|type)=="number" and (.last_event_at|type)=="number" and (.output_tail|type)=="string" and (.nudges|type)=="number" and (.restarts|type)=="number")' "$S" >/dev/null || fail "status agent shape: $(cat "$S")"
jq -e '.agents[0].state=="complete" and .agents[1].state=="inconclusive" and .agents[1].nudges==1' "$S" >/dev/null || fail "status final states: $(cat "$S")"
ls "$TMP/s6" | grep -q tmp && fail "status tmp file left behind"
ok "status.json shape pinned"

# ---- 7. 64 KiB cap ----
echo 0 > "$STUB/sleep.a-big"
head -c 100000 /dev/zero | tr '\0' 'x' > "$TMP/big.md"
rc=$(stage "$TMP/o7" --agent a-big --deadline 30 --grace 2 --scratch "$TMP/s7" --brief-file "$TMP/big.md")
[ "$rc" = 0 ] || fail "cap: exit $rc"
[ "$(wc -c < "$TMP/o7")" -lt 65536 ] || fail "cap: output is $(wc -c < "$TMP/o7") bytes"
jq -e '.verdict=="COMPLETE" and (.report|contains("[truncated:"))' "$TMP/o7" >/dev/null || fail "cap: no truncation marker"
ok "report capped under 64 KiB with a marker"

# ---- 8. usage and validation ----
set +e
"$NARU" stage run --agent x --cwd . --deadline 5 >/dev/null 2>"$TMP/e1"; rc=$?
set -e
[ "$rc" = 2 ] || fail "missing --brief-file should be usage, exit 2 (got $rc)"
set +e
"$NARU" stage run --agent x --cwd . --deadline 5 --brief-file "$TMP/nope.md" >/dev/null 2>"$TMP/e2"; rc=$?
set -e
[ "$rc" = 1 ] && jq -e '.error.code=="validation"' "$TMP/e2" >/dev/null || fail "missing brief file should be validation, exit 1 (got $rc): $(cat "$TMP/e2")"
set +e
"$NARU" stage run --agent x --cwd . --deadline 5 --brief-file "$TMP/ok.md" --also y >/dev/null 2>"$TMP/e3"; rc=$?
set -e
[ "$rc" = 2 ] || fail "--also without --also-brief-file should be usage, exit 2 (got $rc)"
ok "usage and validation shapes"

echo "stage-check: all ok"
