#!/usr/bin/env bash
# Retro gate (mesa task 1158, reworked by naru task 1692): the session
# retrospective over the CLI and `mesa serve --watch-retro`. A run is a detached
# `naru __job retro` making tool-less `claude -p --json-schema` calls (a stub
# `claude`, MESA_CLAUDE_BIN, so no real Claude Code is involved) — a haiku skim
# per session, one sonnet roll-up — and Naru records and files the findings
# itself. The stub answers from `<key>.json` files this script stages and fails
# the call when none is staged. Uses MESA_WATCH_RETRO_TICK_MS (a test-only
# seam, mirrors MESA_WATCH_INBOX_TICK_MS) to shrink the tick from an hour down
# to test speed.
#
# HOME is pointed at a throwaway dir for the server process: a retrospective
# spans every project, so it runs in $HOME/.naru/workspace, and the stub logs
# its cwd — the inbox-watcher gate's reasoning, and the same hermeticity.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"
# Pin the user config away from the real ~/.mesa/config.json: this gate
# asserts the BUILT-IN spawn command and interval, so a configured one must
# not leak in.
export MESA_CONFIG_FILE="$TMP/config.json"

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

run() {
  local expected=$1; shift
  set +e
  STDOUT=$("$@" 2>"$TMP/stderr")
  CODE=$?
  set -e
  STDERR=$(cat "$TMP/stderr")
  [ "$CODE" -eq "$expected" ] ||
    fail "expected exit $expected, got $CODE: $* (stderr: $STDERR)"
}
jqs() { jq -r "$1" <<<"$STDOUT"; }
jqe() { jq -r "$1" <<<"$STDERR"; }
# The sorted key set of a JSON object, one line, for the --quiet contract.
keys() { jq -r 'keys | join(",")' <<<"$1"; }

# ---- stub claude: answers every `-p` call from a staged file, logs the rest ----
#
# A `-p` call logs (cwd, name, model) to P_LOG and its flags (everything before
# the prompt, one per line), schema and prompt per key, then answers with the
# result envelope around the staged `<key>.json` (exit 1 when none is staged,
# or when the `fail` marker exists, which is also logged to FAIL_LOG). The key
# is `skim-<session id>` for the haiku skims (the session name is `naru retro
# <run> skim <session id>`) and `rollup` for the sonnet call. Anything else
# (`--bg`, `agents`, `stop`) logs to BG_CALLS: the retrospective no longer uses
# any of them, and the gate asserts that log stays empty. STUB_DIR comes from
# the environment.

export STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
P_LOG="$TMP/p.log"
BG_CALLS="$TMP/bg-calls.log"
FAIL_LOG="$TMP/fail.log"
touch "$P_LOG" "$BG_CALLS" "$FAIL_LOG"
cat > "$STUB_DIR/claude" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-p" ]; then
  MODEL=""; NAME=""; SCHEMA=""
  for ((i = 1; i < $#; i++)); do
    j=$((i + 1))
    case "${!i}" in
      --model) MODEL=${!j} ;;
      --name) NAME=${!j} ;;
      --json-schema) SCHEMA=${!j} ;;
    esac
  done
  PROMPT=""
  for a in "$@"; do PROMPT=$a; done
  case "$NAME" in
    *" skim "*) KEY="skim-${NAME##* skim }" ;;
    *) KEY="rollup" ;;
  esac
  echo "$(pwd)|$NAME|$MODEL" >> "$STUB_DIR/../p.log"
  printf '%s\n' "${@:1:$# - 1}" > "$STUB_DIR/flags-$KEY"
  printf '%s' "$SCHEMA" > "$STUB_DIR/schema-$KEY"
  printf '%s' "$PROMPT" > "$STUB_DIR/prompt-$KEY"
  if [ -e "$STUB_DIR/fail" ]; then
    echo "stub claude is down" >&2
    echo refused >> "$STUB_DIR/../fail.log"
    exit 1
  fi
  if [ ! -e "$STUB_DIR/$KEY.json" ]; then
    echo "stub claude: no $KEY.json staged" >&2
    exit 1
  fi
  printf '{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":%s}\n' "$(cat "$STUB_DIR/$KEY.json")"
  exit 0
fi
echo "$*" >> "$STUB_DIR/../bg-calls.log"
exit 2
EOF
chmod +x "$STUB_DIR/claude"
export MESA_CLAUDE_BIN="$STUB_DIR/claude"
stage() { printf '%s' "$2" > "$STUB_DIR/$1.json"; } # stage <key> <json>

mkdir -p "$TMP/home"
FAKE_HOME=$(cd "$TMP/home" && pwd -P)
export HOME="$FAKE_HOME"
WORKSPACE="$FAKE_HOME/.naru/workspace"
JOBLOG="$FAKE_HOME/.naru/logs/retro.log"
job_count() { if [ -f "$JOBLOG" ]; then wc -l < "$JOBLOG" | tr -d ' '; else echo 0; fi; }
wait_jobs() { # wait_jobs <n> -> blocks until the job log has >= n lines, or fails
  local n=$1
  for _ in $(seq 1 300); do
    [ "$(job_count)" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n job report(s); log:
$(cat "$JOBLOG" 2>/dev/null)"
}

# ---- fixtures: a task for the inbox item a finding links to ----

run 0 "$MESA" project create "A" --no-git
A=$(jqs .id)
run 0 "$MESA" task create "$A" "task a"
TASK_A=$(jqs .id)
ok "fixtures: project A, task $TASK_A"

# ---- the finding log: record, dedup bump, a second fingerprint ----

run 0 "$MESA" retro finding record --fingerprint swe/denial --subject swe --kind denial \
  --summary "swe keeps asking to run git push" --evidence "session abc: 3 denials" \
  --session-id sess-1
[ "$(jqs .new)" = "true" ] || fail "first record must be new: $STDOUT"
F1=$(jqs .finding.id)
[ "$(jqs .finding.count)" = "1" ] || fail "a new finding has count 1: $STDOUT"
[ "$(jqs .finding.evidence)" = "session abc: 3 denials" ] || fail "evidence is the line given: $STDOUT"
[ "$(jqs .finding.inbox_item_id)" = "null" ] || fail "a new finding is unlinked: $STDOUT"
[ "$(jqs '.finding.session_ids | join(",")')" = "sess-1" ] ||
  fail "the recorded session id rides back: $STDOUT"
FULL_KEYS=$(keys "$(jqs .finding)")
[ "$FULL_KEYS" = "count,evidence,fingerprint,first_seen_at,id,inbox_item_id,kind,last_seen_at,session_ids,subject,summary" ] ||
  fail "finding key set: $FULL_KEYS"
ok "finding record: a new fingerprint is {new: true, finding: {count 1, evidence as given, unlinked}}"

run 0 "$MESA" retro finding record --fingerprint swe/denial --subject swe --kind denial \
  --summary "a different summary" --evidence "session def: 2 denials" --session-id sess-2
[ "$(jqs .new)" = "false" ] || fail "the repeat must answer new: false: $STDOUT"
[ "$(jqs .finding.id)" = "$F1" ] || fail "the repeat is the same row: $STDOUT"
[ "$(jqs .finding.count)" = "2" ] || fail "the repeat bumps count to 2: $STDOUT"
[ "$(jqs .finding.summary)" = "swe keeps asking to run git push" ] || fail "the summary stays as first recorded: $STDOUT"
[ "$(jqs .finding.evidence)" = "$(printf 'session abc: 3 denials\nsession def: 2 denials')" ] ||
  fail "evidence is appended, newest last: $STDOUT"
# The acceptance of mesa task 1255: a second session is KEPT beside the first,
# which is the whole reason the ids are a sibling table and not a column.
[ "$(jqs '.finding.session_ids | join(",")')" = "sess-1,sess-2" ] ||
  fail "a repeat from another session keeps both ids: $STDOUT"
ok "finding record of a known fingerprint: new false, count 2, evidence appended, summary kept, both session ids"

run 0 "$MESA" retro finding record --fingerprint khora/timeout --subject khora --kind timeout \
  --summary "khora find hangs on a slow page"
[ "$(jqs .new)" = "true" ] || fail "a different fingerprint is new: $STDOUT"
F2=$(jqs .finding.id)
[ "$(jqs .finding.evidence)" = "null" ] || fail "no --evidence is null, not empty: $STDOUT"
[ "$(jqs '.finding.session_ids | length')" = "0" ] ||
  fail "no --session-id is an empty set, not a null: $STDOUT"
ok "a second fingerprint is a new finding, recorded without a session id"

# ---- --quiet: record/link/show drop summary + evidence; list rejects it ----

# A second later, so this report moves swe/denial's last_seen_at past
# khora/timeout's (timestamps are whole seconds) and the list order below
# is a real newest-seen order rather than the id tiebreak.
sleep 1
run 0 "$MESA" retro finding record --quiet --fingerprint swe/denial --subject swe --kind denial \
  --summary x --evidence "session ghi: 1 denial" --session-id sess-1
[ "$(jqs .new)" = "false" ] || fail "quiet record keeps the composite's keys: $STDOUT"
[ "$(jqs .finding.count)" = "3" ] || fail "quiet changes stdout only: $STDOUT"
[ "$(jqs '.finding.session_ids | join(",")')" = "sess-1,sess-2" ] ||
  fail "a repeat from a known session is idempotent: $STDOUT"
# session_ids is a bounded set of pointers — the point of recording one — so
# --quiet KEEPS it.
[ "$(keys "$(jqs .finding)")" = "count,fingerprint,first_seen_at,id,inbox_item_id,kind,last_seen_at,session_ids,subject" ] ||
  fail "quiet finding key set: $(keys "$(jqs .finding)")"
run 0 "$MESA" retro finding show "$F1" --quiet
[ "$(keys "$STDOUT")" = "count,fingerprint,first_seen_at,id,inbox_item_id,kind,last_seen_at,session_ids,subject" ] ||
  fail "quiet show key set: $(keys "$STDOUT")"
run 0 "$MESA" retro finding show "$F1"
[ "$(keys "$STDOUT")" = "$FULL_KEYS" ] || fail "default show is the full record: $(keys "$STDOUT")"
[ "$(jqs .count)" = "3" ] || fail "show reflects the third report: $STDOUT"
run 0 "$MESA" retro finding get "$F1"
[ "$(jqs .id)" = "$F1" ] || fail "get is an alias for show"
PLAIN=$("$MESA" retro finding list)
run 0 "$MESA" retro finding list --quiet
[ "$STDOUT" = "$PLAIN" ] || fail "finding list --quiet must equal the plain list"
ok "--quiet drops summary and evidence (keeping session_ids) on record/show and is an accepted no-op on list"

# ---- list: newest-seen first, bare array, --limit ----

run 0 "$MESA" retro finding list
[ "$(jqs 'map(.id) | join(",")')" = "$F1,$F2" ] || fail "list is most recently seen first: $STDOUT"
[ "$(jqs 'map(has("summary")) | all')" = "true" ] || fail "list carries the full rows: $STDOUT"
[ "$(jqs '.[0].session_ids | join(",")')" = "sess-1,sess-2" ] ||
  fail "list derives the session ids too: $STDOUT"
run 0 "$MESA" retro finding list --limit 1
[ "$(jqs 'length')" = "1" ] || fail "--limit bounds the list: $STDOUT"
[ "$(jqs '.[0].id')" = "$F1" ] || fail "--limit keeps the newest-seen: $STDOUT"
ok "finding list is a bare array, newest-seen first, bounded by --limit"

# ---- link: to a real inbox item; not_found / validation otherwise ----

run 0 "$MESA" inbox add --task "$TASK_A" --author retro --kind change-request "swe keeps asking to run git push"
ITEM=$(jqs .id)
run 0 "$MESA" retro finding link --id "$F1" --inbox-item "$ITEM"
[ "$(jqs .inbox_item_id)" = "$ITEM" ] || fail "link sets inbox_item_id: $STDOUT"
[ "$(jqs '.session_ids | join(",")')" = "sess-1,sess-2" ] || fail "link derives the ids too: $STDOUT"
[ "$(jqs .count)" = "3" ] || fail "link bumps nothing: $STDOUT"
run 0 "$MESA" retro finding link --id "$F1" --inbox-item "$ITEM" --quiet
[ "$(keys "$STDOUT")" = "count,fingerprint,first_seen_at,id,inbox_item_id,kind,last_seen_at,session_ids,subject" ] ||
  fail "quiet link key set: $(keys "$STDOUT")"
run 1 "$MESA" retro finding link --id 9999 --inbox-item "$ITEM"
[ "$(jqe .error.code)" = "not_found" ] || fail "linking an unknown finding is not_found: $STDERR"
[ -z "$STDOUT" ] || fail "an error prints nothing on stdout"
run 1 "$MESA" retro finding link --id "$F1" --inbox-item 9999
[ "$(jqe .error.code)" = "validation" ] || fail "linking to an unknown inbox item is validation: $STDERR"
run 1 "$MESA" retro finding show 9999
[ "$(jqe .error.code)" = "not_found" ] || fail "show of an unknown finding is not_found: $STDERR"
# Triage deletes the item it assigns (SET NULL): the finding keeps its memory.
run 0 "$MESA" inbox delete "$ITEM"
run 0 "$MESA" retro finding show "$F1"
[ "$(jqs .inbox_item_id)" = "null" ] || fail "a deleted item unlinks the finding: $STDOUT"
[ "$(jqs .count)" = "3" ] || fail "…and nothing else changes: $STDOUT"
ok "finding link: sets the pointer without a bump; not_found for an unknown finding, validation for an unknown item; ON DELETE SET NULL"

# ---- validation shapes ----

LONG_KEY=$(printf 'k%.0s' $(seq 1 201))
LONG_SUMMARY=$(printf 's%.0s' $(seq 1 2001))
LONG_EVIDENCE=$(printf 'e%.0s' $(seq 1 2001))
check_validation() { # check_validation <label> <args...>
  local label=$1; shift
  run 1 "$MESA" retro finding record "$@"
  [ "$(jqe .error.code)" = "validation" ] || fail "$label must be validation: $STDERR"
  [ -z "$STDOUT" ] || fail "$label: an error prints nothing on stdout"
}
check_validation "empty fingerprint" --fingerprint "" --subject s --kind k --summary sum
check_validation "blank subject" --fingerprint f --subject "  " --kind k --summary sum
check_validation "empty kind" --fingerprint f --subject s --kind "" --summary sum
check_validation "empty summary" --fingerprint f --subject s --kind k --summary ""
check_validation "long fingerprint" --fingerprint "$LONG_KEY" --subject s --kind k --summary sum
check_validation "long subject" --fingerprint f --subject "$LONG_KEY" --kind k --summary sum
check_validation "long kind" --fingerprint f --subject s --kind "$LONG_KEY" --summary sum
check_validation "long summary" --fingerprint f --subject s --kind k --summary "$LONG_SUMMARY"
check_validation "long evidence" --fingerprint f --subject s --kind k --summary sum --evidence "$LONG_EVIDENCE"
check_validation "blank session id" --fingerprint f --subject s --kind k --summary sum --session-id "  "
check_validation "long session id" --fingerprint f --subject s --kind k --summary sum --session-id "$LONG_KEY"
run 0 "$MESA" retro finding list
[ "$(jqs 'length')" = "2" ] || fail "a rejected record writes nothing: $STDOUT"
run 2 "$MESA" retro finding record --fingerprint f --subject s --kind k
[ -z "$STDOUT" ] || fail "a missing required flag is a usage error with empty stdout"
ok "every validation shape is exit 1 / validation writing nothing; a missing flag is exit 2"

# ---- status on a fresh install: due, nothing to point at ----

run 0 "$MESA" retro status
[ "$(jqs .last_run)" = "null" ] || fail "no run yet: $STDOUT"
[ "$(jqs .due)" = "true" ] || fail "nothing has run: due: $STDOUT"
[ "$(jqs .next_due_at)" = "null" ] || fail "no run, no deadline: $STDOUT"
[ "$(jqs .interval_hours)" = "72" ] || fail "the built-in interval is 72h: $STDOUT"
[ "$(jqs .findings)" = "2" ] || fail "status counts the log: $STDOUT"
[ "$(jqs .linked)" = "0" ] || fail "status counts linked findings: $STDOUT"
run 0 "$MESA" retro status --quiet
[ "$(keys "$STDOUT")" = "due,findings,interval_hours,last_run,linked,next_due_at" ] ||
  fail "status key set: $(keys "$STDOUT")"
run 0 "$MESA" retro show
[ "$(jqs .due)" = "true" ] || fail "show is an alias for status"
ok "retro status on a fresh install: due, last_run null, next_due_at null, 72h, counts"

# ---- fixtures for the runs: a project with a folder, a done task, four sessions ----
#
# Session sess-one and sess-two ran in project B's folder (attributed to its
# task closed in the window), sess-clean did too but failed nothing (costs no
# call), sess-orphan ran elsewhere (unattributed, skipped). The task's name and
# a tool error carry shell syntax: it must reach the prompt as data and run
# nothing, anywhere.

mkdir -p "$TMP/projB" "$TMP/elsewhere" "$TMP/tree/-proj-b"
DIR_B=$(cd "$TMP/projB" && pwd -P)
DIR_X=$(cd "$TMP/elsewhere" && pwd -P)
run 0 "$MESA" project create "B" --no-git
B=$(jqs .id)
run 0 "$MESA" project update "$B" --path "$DIR_B"
HOSTILE_TASK='fix $(touch pwned) `touch pwned2` "q"'
run 0 "$MESA" task create "$B" "$HOSTILE_TASK"
TASK_B=$(jqs .id)
# env -u: inside a Claude Code session the close guard (mesa task 1515) probes `claude agents`.
run 0 env -u CLAUDE_CODE_SESSION_ID "$MESA" task update "$TASK_B" --status done
# Timestamps an hour ahead, so they stay inside every run's window.
TS=$(python3 -c 'import datetime; print((datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))')
transcript() { # transcript <file> <session id> <cwd> <with errors: 1|0>
  local f=$1 sid=$2 cwd=$3 errs=$4
  {
    if [ "$errs" = 1 ]; then
      cat <<JSONL
{"type":"assistant","uuid":"$sid-a","sessionId":"$sid","timestamp":"$TS","cwd":"$cwd","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"$sid-1","name":"Bash","input":{"command":"git push origin main"}},{"type":"tool_use","id":"$sid-2","name":"Bash","input":{"command":"sed -n p gone.txt"}}],"usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"type":"user","uuid":"$sid-b","sessionId":"$sid","timestamp":"$TS","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"$sid-1","is_error":true,"content":"PreToolUse:Bash hook error: Blocked \`git push origin main\`: nothing is pushed unless the user asks"}]}}
{"type":"user","uuid":"$sid-c","sessionId":"$sid","timestamp":"$TS","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"$sid-2","is_error":true,"content":"sed: \$(touch pwned3): No such file or directory"}]}}
JSONL
    else
      cat <<JSONL
{"type":"assistant","uuid":"$sid-a","sessionId":"$sid","timestamp":"$TS","cwd":"$cwd","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"all fine"}],"usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
JSONL
    fi
  } > "$f"
}
transcript "$TMP/tree/-proj-b/one.jsonl" sess-one "$DIR_B" 1
transcript "$TMP/tree/-proj-b/two.jsonl" sess-two "$DIR_B" 1
transcript "$TMP/tree/-proj-b/clean.jsonl" sess-clean "$DIR_B" 0
transcript "$TMP/tree/-proj-b/orphan.jsonl" sess-orphan "$DIR_X" 1
export MESA_CC_PROJECTS_DIR="$TMP/tree"
ok "fixtures: project B with a done task and four sessions (two failing and attributed, one clean, one unattributed)"

# ---- a job that cannot start leaves NO run row ----

run 1 env NARU_SELF_BIN="$TMP/no-such-binary" "$MESA" retro run
[ "$(jqe .error.code)" = "unavailable" ] || fail "a failed start is unavailable: $STDERR"
[ -z "$STDOUT" ] || fail "a failed run prints nothing on stdout"
run 0 "$MESA" retro status
[ "$(jqs .last_run)" = "null" ] || fail "a failed start must delete its run row: $STDOUT"
[ "$(jqs .due)" = "true" ] || fail "…so the next attempt is not a conflict: $STDOUT"
[ "$(job_count)" -eq 0 ] || fail "a job that never started logs nothing"
ok "retro run whose job cannot start is unavailable and leaves no run row"

# ---- retro run: a manual run, a detached job, findings recorded, filed and linked ----

FINDINGS_BEFORE=$("$MESA" retro finding list | jq length)
INBOX_BEFORE=$("$MESA" inbox list | jq length)
stage skim-sess-one '{"friction":[{"subject":"git","kind":"denial","evidence":"git push refused 3 times"}]}'
stage skim-sess-two '{"friction":[{"subject":"git","kind":"denial","evidence":"git push refused again"},{"subject":"sed","kind":"tool-failure","evidence":"sed on a missing file"}]}'
stage rollup "$(jq -nc --argjson t "$TASK_B" '{findings: [
  {subject: "Git", kind: "Denial", summary: "Agents keep trying git push and the hook refuses it", evidence: "sess-one and sess-two: push refused", proposal: "teach the agents not to push", session_ids: ["sess-one", "sess-two", "ghost"], task_id: $t},
  {subject: "sed", kind: "tool-failure", summary: "sed on a missing file", evidence: "sess-two: sed failed", proposal: "check the path first", session_ids: ["sess-two"], task_id: 99999},
  {subject: "made-up", kind: "thing", summary: "names nothing real", evidence: "none", proposal: "none", session_ids: ["ghost"], task_id: 99999}]}')"
run 0 "$MESA" retro run
RUN1=$(jqs .id)
[ "$(jqs .trigger)" = "manual" ] || fail "a CLI run is trigger manual: $STDOUT"
[ "$(keys "$STDOUT")" = "id,spawned_at,started_at,trigger" ] || fail "run key set: $(keys "$STDOUT")"
[ "$(jqs .spawned_at)" != "null" ] || fail "a run that started prints spawned_at: $STDOUT"
wait_jobs 1
REPORT=$(sed -n 1p "$JOBLOG")
[ "$(jq -r .kind <<<"$REPORT")" = "retro" ] && [ "$(jq -r .run_id <<<"$REPORT")" = "$RUN1" ] ||
  fail "the job's one-line report names the run: $REPORT"
[ "$(jq -r .sessions <<<"$REPORT")" = "2" ] || fail "two sessions are skimmed: $REPORT"
[ "$(jq -r .unattributed <<<"$REPORT")" = "1" ] || fail "the orphan session is skipped: $REPORT"
[ "$(jq -r .clean <<<"$REPORT")" = "1" ] || fail "the clean session costs no call: $REPORT"
[ "$(jq -r '.findings | length' <<<"$REPORT")" = "2" ] || fail "two findings applied: $REPORT"
[ "$(jq -r '.rejected | length' <<<"$REPORT")" = "1" ] || fail "the made-up finding is rejected: $REPORT"
ok "retro run records a manual run and its detached job logs one report: 2 sessions skimmed, 1 unattributed, 1 clean, 2 findings applied, 1 rejected"

# The calls: two haiku skims and one sonnet roll-up, in the workspace, `-p`
# with no tools and a schema, never --bg and never an agent.
[ "$(grep -c '|haiku$' "$P_LOG")" -eq 2 ] || fail "two haiku skims: $(cat "$P_LOG")"
[ "$(grep -c '|sonnet$' "$P_LOG")" -eq 1 ] || fail "one sonnet roll-up: $(cat "$P_LOG")"
grep -qFx "$WORKSPACE|naru retro $RUN1 skim sess-one|haiku" "$P_LOG" || fail "a skim runs in the workspace named for its session: $(cat "$P_LOG")"
grep -qFx "$WORKSPACE|naru retro $RUN1|sonnet" "$P_LOG" || fail "the roll-up is named for the run: $(cat "$P_LOG")"
! grep -Eq 'sess-orphan|sess-clean' "$P_LOG" || fail "an unattributed or clean session is never skimmed: $(cat "$P_LOG")"
[ ! -s "$BG_CALLS" ] || fail "no --bg, agents or stop call is ever made: $(cat "$BG_CALLS")"
for key in skim-sess-one skim-sess-two rollup; do
  FLAGS="$STUB_DIR/flags-$key"
  grep -qx -- '-p' "$FLAGS" && grep -qx -- '--tools' "$FLAGS" && grep -qx -- '--strict-mcp-config' "$FLAGS" &&
    grep -qx -- '--json-schema' "$FLAGS" && grep -qx -- '--output-format' "$FLAGS" ||
    fail "$key: expected a tool-less -p structured call: $(tr '\n' ' ' < "$FLAGS")"
  ! grep -Eqx -- '--bg|--agent' "$FLAGS" || fail "$key: must never start an agent: $(cat "$FLAGS")"
  jq -e '.type == "object"' "$STUB_DIR/schema-$key" >/dev/null || fail "$key: the schema is JSON: $(cat "$STUB_DIR/schema-$key")"
done
ok "retro job: 2 haiku skims + 1 sonnet roll-up as tool-less 'claude -p --json-schema' calls in the workspace, never --bg or --agent, nothing skipped skimmed"

# The skim prompt carries the hostile task name as DATA (byte-identical, in
# its fence); nothing ran it.
grep -qF "task: #$TASK_B $HOSTILE_TASK" "$STUB_DIR/prompt-skim-sess-one" ||
  fail "the hostile task name must reach the skim prompt byte-identical: $(cat "$STUB_DIR/prompt-skim-sess-one")"
grep -q 'DATA' "$STUB_DIR/prompt-skim-sess-one" && grep -q '<<<DATA' "$STUB_DIR/prompt-rollup" ||
  fail "untrusted text must be fenced as data"
grep -q 'failures: 2' "$STUB_DIR/prompt-skim-sess-one" || fail "the skim carries the session's failure digest: $(cat "$STUB_DIR/prompt-skim-sess-one")"
grep -q 'git push' "$STUB_DIR/prompt-skim-sess-one" || fail "the digest names the refused command"
grep -q 'git/denial' "$STUB_DIR/prompt-rollup" ||
  fail "the roll-up carries the skims: $(cat "$STUB_DIR/prompt-rollup")"
for f in pwned pwned2 pwned3; do
  [ ! -e "$WORKSPACE/$f" ] && [ ! -e "$f" ] && [ ! -e "$TMP/$f" ] || fail "hostile text ran: $f exists"
done
ok "hostile session text (task name, tool error) reaches the prompts as fenced data and runs nothing"

# The findings: recorded through the log's own path, filed as change requests
# from author retro against the observed task, and linked.
run 0 "$MESA" retro finding list
[ "$(jqs 'length')" -eq $((FINDINGS_BEFORE + 2)) ] || fail "two findings recorded: $STDOUT"
GIT=$(jq -c '.[] | select(.fingerprint == "git/denial")' <<<"$STDOUT")
SED=$(jq -c '.[] | select(.fingerprint == "sed/tool-failure")' <<<"$STDOUT")
[ -n "$GIT" ] && [ -n "$SED" ] || fail "fingerprints are Naru's own lowercase subject/kind: $STDOUT"
[ "$(jq -r .count <<<"$GIT")" = "1" ] || fail "a new finding has count 1: $GIT"
[ "$(jq -r '.session_ids | join(",")' <<<"$GIT")" = "sess-one,sess-two" ] || fail "only listed sessions are kept: $GIT"
[ "$(jq -r '.evidence | startswith("run '"$RUN1"': ")' <<<"$GIT")" = "true" ] || fail "evidence names the run: $GIT"
GIT_ITEM=$(jq -r .inbox_item_id <<<"$GIT")
SED_ITEM=$(jq -r .inbox_item_id <<<"$SED")
[ "$GIT_ITEM" != "null" ] && [ "$SED_ITEM" != "null" ] || fail "both new findings are linked to their inbox item: $GIT $SED"
run 0 "$MESA" inbox show "$GIT_ITEM"
[ "$(jqs .kind)" = "change-request" ] && [ "$(jqs .author)" = "retro" ] && [ "$(jqs .task_id)" = "$TASK_B" ] ||
  fail "the item is a change-request from retro on the observed task: $STDOUT"
jqs .body | grep -q 'git/denial' || fail "the item names its finding: $STDOUT"
[ "$("$MESA" inbox list | jq length)" -eq $((INBOX_BEFORE + 2)) ] || fail "exactly two items filed"
# The task a model invents is not one the finding can be filed against: sed's
# fell back to its listed session's task.
run 0 "$MESA" inbox show "$SED_ITEM"
[ "$(jqs .task_id)" = "$TASK_B" ] || fail "an unlisted task falls back to the session's task: $STDOUT"
ok "new findings: recorded as git/denial and sed/tool-failure (session ids kept, unlisted ones dropped), each filed as a change-request from retro on the observed task and linked"

# ---- inside the interval: conflict; --force runs anyway ----

run 1 "$MESA" retro run
[ "$(jqe .error.code)" = "conflict" ] || fail "a second run inside the interval is conflict: $STDERR"
[ "$(job_count)" -eq 1 ] || fail "a conflict starts nothing"
run 0 "$MESA" retro status
[ "$(jqs .last_run.id)" = "$RUN1" ] || fail "status names the run: $STDOUT"
[ "$(jqs .due)" = "false" ] || fail "just ran: not due: $STDOUT"
# next_due_at = started_at + 72h, on the store's own clock.
[ "$(jqs '((.last_run.started_at | strptime("%Y-%m-%d %H:%M:%S") | mktime) + 72 * 3600) == (.next_due_at | strptime("%Y-%m-%d %H:%M:%S") | mktime)')" = "true" ] ||
  fail "next_due_at must be started_at + 72h: $STDOUT"

# A repeat: the roll-up names git/denial again. The count bumps and evidence
# appends; NOTHING is filed.
stage rollup "$(jq -nc --argjson t "$TASK_B" '{findings: [
  {subject: "git", kind: "denial", summary: "a different summary, ignored", evidence: "sess-one: refused again", proposal: "again", session_ids: ["sess-one"], task_id: $t}]}')"
run 0 "$MESA" retro run --force --quiet
RUN2=$(jqs .id)
[ "$RUN2" -gt "$RUN1" ] || fail "--force records a new run: $STDOUT"
[ "$(keys "$STDOUT")" = "id,spawned_at,started_at,trigger" ] || fail "a run has nothing to drop under --quiet: $(keys "$STDOUT")"
wait_jobs 2
REPORT=$(sed -n 2p "$JOBLOG")
[ "$(jq -r '.findings[0].new' <<<"$REPORT")" = "false" ] && [ "$(jq -r '.findings[0].count' <<<"$REPORT")" = "2" ] ||
  fail "a repeat answers new: false, count 2: $REPORT"
run 0 "$MESA" retro finding show "$(jq -r .id <<<"$GIT")"
[ "$(jqs .count)" = "2" ] || fail "the repeat bumped the count: $STDOUT"
[ "$(jqs .summary)" = "Agents keep trying git push and the hook refuses it" ] || fail "the summary stays as first recorded: $STDOUT"
[ "$(jqs '.evidence | contains("run '"$RUN2"': ")')" = "true" ] || fail "the repeat appended its evidence: $STDOUT"
[ "$(jqs .inbox_item_id)" = "$GIT_ITEM" ] || fail "the link is unchanged: $STDOUT"
[ "$("$MESA" inbox list | jq length)" -eq $((INBOX_BEFORE + 2)) ] || fail "a repeat files nothing"
ok "retro run inside the interval is conflict; --force runs; next_due_at is started_at + interval; a repeated finding bumps count + evidence and files nothing"

# ---- a failed call leaves no half-applied state, and gives the claim back ----

FINDINGS_NOW=$("$MESA" retro finding list | jq length)
INBOX_NOW=$("$MESA" inbox list | jq length)
snapshot() { "$MESA" retro finding list | jq -c '[.[] | {id, count, evidence, inbox_item_id, session_ids}]'; }
SNAP=$(snapshot)
# (1) every skim fails (claude down): the job fails, the run row is deleted.
touch "$STUB_DIR/fail"
: > "$FAIL_LOG"
run 0 "$MESA" retro run --force
RUN3=$(jqs .id)
wait_jobs 3
tail -1 "$JOBLOG" | jq -e '.error.code == "unavailable"' >/dev/null || fail "every skim failing is an error line: $(tail -1 "$JOBLOG")"
[ "$(wc -l < "$FAIL_LOG" | tr -d ' ')" -ge 2 ] || fail "both skims were attempted: $(cat "$FAIL_LOG")"
run 0 "$MESA" retro status
[ "$(jqs .last_run.id)" = "$RUN2" ] || fail "a failed job deletes its claim, so the next tick retries: $STDOUT"
rm -f "$STUB_DIR/fail"
# (2) skims fine, the roll-up fails (nothing staged for it).
rm -f "$STUB_DIR/rollup.json"
run 0 "$MESA" retro run --force
wait_jobs 4
tail -1 "$JOBLOG" | jq -e '.error.code == "unavailable"' >/dev/null || fail "a failed roll-up is an error line: $(tail -1 "$JOBLOG")"
run 0 "$MESA" retro status
[ "$(jqs .last_run.id)" = "$RUN2" ] || fail "a failed roll-up also gives the claim back: $STDOUT"
[ "$("$MESA" retro finding list | jq length)" -eq "$FINDINGS_NOW" ] || fail "a failed call adds no finding"
[ "$("$MESA" inbox list | jq length)" -eq "$INBOX_NOW" ] || fail "a failed call files nothing"
[ "$(snapshot)" = "$SNAP" ] || fail "a failed call changes no finding (count, evidence, link, sessions)"
ok "a failed call (every skim, or the roll-up) writes nothing — no finding, no bump, no inbox item — and deletes its run row"

# ---- the interval is the config's `watchers.retro-interval-hours`, read fresh ----

cat > "$MESA_CONFIG_FILE" <<'EOC'
{"watchers": {"retro-interval-hours": 1}}
EOC
run 0 "$MESA" retro status
[ "$(jqs .interval_hours)" = "1" ] || fail "the configured interval is read: $STDOUT"
[ "$(jqs '((.last_run.started_at | strptime("%Y-%m-%d %H:%M:%S") | mktime) + 3600) == (.next_due_at | strptime("%Y-%m-%d %H:%M:%S") | mktime)')" = "true" ] ||
  fail "next_due_at follows the configured interval: $STDOUT"
# A hand-edited out-of-range value clamps on read (the todo-concurrency posture).
cat > "$MESA_CONFIG_FILE" <<'EOC'
{"watchers": {"retro-interval-hours": 0}}
EOC
run 0 "$MESA" retro status
[ "$(jqs .interval_hours)" = "1" ] || fail "a hand-edited 0 clamps to 1: $STDOUT"
rm -f "$MESA_CONFIG_FILE"
ok "retro-interval-hours governs status/run with no restart; a hand-edited bad value clamps on read"

# ---- the watcher: serve --watch-retro ----

PORT=17801
SERVER_ERR="$TMP/server.err"
: > "$SERVER_ERR"
wait_for_server() {
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  fail "server did not start on $PORT"
}
wait_err_lines() { # wait_err_lines <n> <text> -> blocks until the server logged <text> >= n times
  local n=$1 text=$2
  for _ in $(seq 1 100); do
    [ "$(grep -c "$text" "$SERVER_ERR")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n '$text' line(s); stderr:
$(cat "$SERVER_ERR")"
}
start_server() { # start_server <flags...>
  MESA_WATCH_RETRO_TICK_MS=150 "$MESA" serve --port "$PORT" "$@" >/dev/null 2>>"$SERVER_ERR" &
  SERVER_PID=$!
  wait_for_server
}
stop_server() {
  [ -n "${SERVER_PID:-}" ] || return 0
  kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
}
api() { # api <method> <path> [json-body] -> STDOUT=body, CODE=status
  local method=$1 path=$2 body=${3:-}
  CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$method" \
    -H 'Content-Type: application/json' \
    ${body:+--data "$body"} "http://127.0.0.1:$PORT$path")
  STDOUT=$(cat "$TMP/body")
}

# A fresh db, so the watcher's first tick finds nothing has run.
export MESA_DB="$TMP/watcher.db"
JOBS0=$(job_count)

# flag OFF: no dispatch, ever.
start_server
sleep 1
[ "$(job_count)" -eq "$JOBS0" ] || fail "flag off: watcher must not dispatch"
run 0 "$MESA" retro status
[ "$(jqs .last_run)" = "null" ] || fail "flag off: no run row"

# GET/PUT /api/config/watchers carries the new key beside todo_concurrency.
api GET /api/config/watchers
[ "$CODE" = "200" ] || fail "GET /api/config/watchers: $CODE $STDOUT"
[ "$(jqs .retro_interval_hours)" = "null" ] || fail "unconfigured: null: $STDOUT"
[ "$(jqs .retro_interval_hours_default)" = "72" ] || fail "the built-in behind it: $STDOUT"
api PUT /api/config/watchers '{"retro_interval_hours": 24}'
[ "$CODE" = "200" ] || fail "PUT /api/config/watchers: $CODE $STDOUT"
[ "$(jqs .retro_interval_hours)" = "24" ] || fail "PUT echoes the getter: $STDOUT"
[ "$(jq -r '.watchers["retro-interval-hours"]' "$MESA_CONFIG_FILE")" = "24" ] || fail "the key lands in the file"
run 0 "$MESA" retro status
[ "$(jqs .interval_hours)" = "24" ] || fail "the CLI reads what the page wrote: $STDOUT"
for bad in 0 8761 1.5 '"24"'; do
  api PUT /api/config/watchers "{\"retro_interval_hours\": $bad}"
  [ "$CODE" = "422" ] || fail "PUT $bad must be 422, got $CODE: $STDOUT"
  [ "$(jqs .error.code)" = "validation" ] || fail "PUT $bad: $STDOUT"
  [ "$(jq -r '.watchers["retro-interval-hours"]' "$MESA_CONFIG_FILE")" = "24" ] || fail "a rejected PUT writes nothing"
done
api PUT /api/config/watchers '{"todo_concurrency": 3}'
[ "$(jqs .retro_interval_hours)" = "24" ] || fail "saving the sibling key preserves this one: $STDOUT"
api PUT /api/config/watchers '{"retro_interval_hours": null}'
[ "$(jqs .retro_interval_hours)" = "null" ] || fail "null restores the built-in: $STDOUT"
[ "$(jqs .todo_concurrency)" = "3" ] || fail "…and preserves the sibling: $STDOUT"
rm -f "$MESA_CONFIG_FILE"
stop_server
ok "watch_retro off: no dispatch; GET/PUT /api/config/watchers carry retro_interval_hours (422 on a bad value writing nothing, null restores 72, siblings preserved)"

# A job that cannot start: the run row is rolled back, so a later tick
# retries. The proof is the RETRY, not a point-in-time read of the row: each
# tick inserts the row, fails to start the job and deletes it again, so
# `retro status` sampled at a random instant may land inside that window. A
# second failure can only happen because the first attempt's row was deleted
# (a leftover row makes the next tick "not due" for 72 hours).
NARU_SELF_BIN="$TMP/no-such-binary" start_server --watch-retro
wait_err_lines 2 'spawn failed for retro run'
[ "$(job_count)" -eq "$JOBS0" ] || fail "a job that never started logs nothing"
stop_server
run 0 "$MESA" retro status
[ "$(jqs .last_run)" = "null" ] || fail "a failed start leaves no row: $STDOUT"

# flag ON: exactly one job, trigger watcher, and not again inside the interval.
start_server --watch-retro
wait_jobs $((JOBS0 + 1))
run 0 "$MESA" retro status
RUN_W=$(jqs .last_run.id)
[ "$(jqs .last_run.trigger)" = "watcher" ] || fail "a watcher run is trigger watcher: $STDOUT"
[ "$(jqs .due)" = "false" ] || fail "just dispatched: not due: $STDOUT"
REPORT=$(tail -1 "$JOBLOG")
[ "$(jq -r .run_id <<<"$REPORT")" = "$RUN_W" ] && [ "$(jq -r .sessions <<<"$REPORT")" = "0" ] ||
  fail "the watcher's job reports its run (no tasks here, so nothing to review): $REPORT"
sleep 1
[ "$(job_count)" -eq $((JOBS0 + 1)) ] || fail "inside the interval the watcher must not dispatch again: $(tail -3 "$JOBLOG")"
[ ! -s "$BG_CALLS" ] || fail "the watcher never uses --bg: $(cat "$BG_CALLS")"
# The run row is the claim the CLI sees too.
run 1 "$MESA" retro run
[ "$(jqe .error.code)" = "conflict" ] || fail "a CLI run against the watcher's row is conflict: $STDERR"
stop_server
ok "watch_retro on: a job that cannot start leaves no row and retries; then exactly one 'watcher' job per interval, and the CLI sees its claim"

echo
echo "retro check passed ($CHECKS checks)"
