#!/usr/bin/env bash
# Inbox-watcher gate: exercises `mesa serve --watch-inbox`'s periodic dispatch
# loop (naru task 1691). Each pending change request is triaged by a detached
# `naru __job inbox-triage`, which makes tool-less `claude -p --json-schema`
# calls (a stub `claude`, MESA_CLAUDE_BIN, so no real Claude Code is involved)
# and applies the structured answer through Store itself. The stub answers
# from `<model>-<item id>.json` files this script stages, and fails the call
# when none is staged. Uses MESA_WATCH_INBOX_TICK_MS (a test-only seam, mirrors
# MESA_CLAUDE_BIN) to shrink the tick from 60s down to test speed.
#
# HOME is pointed at a throwaway dir for the server process: the inbox-watcher
# dispatches in $HOME/.naru/workspace (an inbox item belongs to no project, so
# there is no local_path to spawn in), and the stub logs its cwd — asserting
# against the real home directory would be neither hermetic nor portable. That
# the folder follows $HOME at all is what proves mesa's home lookup reads the
# environment, not the passwd entry.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"
# Pin the user config away from the real ~/.mesa/config.json: this gate
# asserts the BUILT-IN spawn command, so a configured one must not leak in.
export MESA_CONFIG_FILE="$TMP/no-config.json"

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

# ---- stub claude: a `-p` call logs (cwd, name, model) to P_LOG and its flags
# (everything before the prompt, one per line), schema and prompt per
# model+item, then answers with the result envelope around the staged
# `<model>-<id>.json` (exit 1 when none is staged). `--bg`, `agents` and `stop`
# only log to BG_CALLS: the watcher no longer uses any of them, and the gate
# asserts the log stays empty. STUB_DIR comes from the server's environment. ----

STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
P_LOG="$TMP/p.log"
BG_CALLS="$TMP/bg-calls.log"
touch "$P_LOG" "$BG_CALLS"
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
  ID=${NAME#inbox }; ID=${ID%%:*}
  echo "$(pwd)|$NAME|$MODEL" >> "$STUB_DIR/../p.log"
  printf '%s\n' "${@:1:$# - 1}" > "$STUB_DIR/flags-$MODEL-$ID"
  printf '%s' "$SCHEMA" > "$STUB_DIR/schema-$MODEL-$ID"
  printf '%s' "$PROMPT" > "$STUB_DIR/prompt-$MODEL-$ID"
  if [ ! -e "$STUB_DIR/$MODEL-$ID.json" ]; then
    echo "stub claude: no $MODEL-$ID.json staged" >&2
    exit 1
  fi
  printf '{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":%s}\n' "$(cat "$STUB_DIR/$MODEL-$ID.json")"
  exit 0
fi
echo "$*" >> "$STUB_DIR/../bg-calls.log"
exit 2
EOF
chmod +x "$STUB_DIR/claude"
stage() { printf '%s' "$3" > "$STUB_DIR/$1-$2.json"; } # stage <model> <item id> <json>

# ---- fixtures ----

# Resolved to the physical path (macOS's /tmp -> /private/tmp symlink): a
# child process's cwd (as set via current_dir/chdir) reports the physical
# path, so the stub's logged pwd would otherwise never match the expectation.
mkdir -p "$TMP/home" "$TMP/projA"
FAKE_HOME=$(cd "$TMP/home" && pwd -P)
# mesa creates this on demand (mesa task 1040); it deliberately does not exist
# yet, and the dispatch assertions below are what prove it appears.
WORKSPACE="$FAKE_HOME/.naru/workspace"
JOBLOG="$FAKE_HOME/.naru/logs/inbox-triage.log"
DIR_A=$(cd "$TMP/projA" && pwd -P)

# Project A is a real git repo with one commit, so a `shipped` verdict can name
# a sha Naru gathered.
git -C "$DIR_A" init -q
git -C "$DIR_A" -c user.name=t -c user.email=t@t commit -q --allow-empty -m "fix the shipped thing"
SHA=$(git -C "$DIR_A" rev-parse HEAD)

run 0 "$MESA" project create "A" --no-git
A=$(jqs .id)
run 0 "$MESA" project update "$A" --path "$DIR_A"
run 0 "$MESA" task create "$A" "task a"
TASK_A=$(jqs .id)
run 0 "$MESA" task create "$A" "existing: fix khora eval on undefined"
TASK_DUP=$(jqs .id)

add_item() { # add_item <body> [kind] -> the new item's id
  run 0 "$MESA" inbox add --task "$TASK_A" --author agent-7 --kind "${2:-change-request}" "$1"
  jqs .id
}
# A body full of shell syntax: it must reach the prompt byte-identical and run
# nothing, anywhere.
HOSTILE='fyi only: $(touch pwned) `touch pwned2` "q" it'"'"'s nothing to do'
NA=$(add_item "$HOSTILE
second line is ignored by the session name")
DUP=$(add_item "khora: eval errors on undefined (again)")
SHIP=$(add_item "khora: fix the shipped thing")
BOGUS=$(add_item "khora: a thing claimed shipped in a commit that does not exist")
SHARP=$(add_item "khora: eval errors on undefined, please fix")
HOLD=$(add_item "which of the projects is this about?")
FAILED=$(add_item "an item whose model call fails")
SUMMARY=$(add_item "mesa task 846 is done: inbox items now carry a type" task-summary)
run 0 "$MESA" inbox show "$NA"
[ "$(jqs .project_id)" = "null" ] || fail "a new inbox item must start unassigned"
stage haiku "$NA" '{"verdict":{"decision":"not-actionable","reason":"an FYI, nothing to do"}}'
stage haiku "$DUP" "{\"verdict\":{\"decision\":\"duplicate\",\"task_id\":$TASK_DUP,\"reason\":\"same eval bug\"}}"
stage haiku "$SHIP" "{\"verdict\":{\"decision\":\"shipped\",\"evidence\":\"${SHA:0:9}\",\"reason\":\"the commit fixes it\"}}"
stage haiku "$BOGUS" '{"verdict":{"decision":"shipped","evidence":"0123456789abcdef","reason":"a commit I made up"}}'
stage haiku "$SHARP" "{\"verdict\":{\"decision\":\"sharpen\",\"project_id\":$A,\"reason\":\"a real bug in A\"}}"
stage sonnet "$SHARP" '{"title":"Fix khora eval on undefined","body":"Make `khora eval` print `undefined`.","acceptance":"- prints undefined","priority":"high"}'
stage haiku "$HOLD" '{"verdict":{"decision":"hold","reason":"the project is ambiguous"}}'
# $FAILED: nothing staged, so the stub fails the call.
ok "fixtures: project A (real git repo), seven pending change requests and one task-summary"

PORT=17782
wait_for_server() {
  local port=$1
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$port/api/projects" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  fail "server did not start on $port"
}
wait_lines() { # wait_lines <file> <n> -> blocks until the file has >= n lines, or fails
  local file=$1 n=$2
  for _ in $(seq 1 150); do
    [ -f "$file" ] && [ "$(wc -l < "$file")" -ge "$n" ] && return 0
    sleep 0.1
  done
  fail "timed out waiting for $n line(s) in $file; has:\n$(cat "$file" 2>/dev/null)"
}
calls() { # calls <item id> <model> -> how many times the stub was called for it
  awk -F'|' -v p="inbox $1:" -v m="$2" 'index($2, p) == 1 && $3 == m' "$P_LOG" | wc -l | tr -d ' '
}
start_server() { # start_server <flags...>
  HOME="$FAKE_HOME" MESA_CLAUDE_BIN="$STUB_DIR/claude" STUB_DIR="$STUB_DIR" \
    MESA_WATCH_INBOX_TICK_MS=150 MESA_WATCH_TODO_TICK_MS=150 \
    "$MESA" serve --port "$PORT" "$@" >/dev/null 2>&1 &
  SERVER_PID=$!
  wait_for_server "$PORT"
}
stop_server() {
  [ -n "${SERVER_PID:-}" ] || return 0
  kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
}

# ---- flag OFF: no dispatch, ever, even with pending inbox items ----

start_server
sleep 1
[ "$(wc -l < "$P_LOG")" -eq 0 ] || fail "flag off: watcher must not dispatch"
run 0 "$MESA" inbox show "$NA"
[ "$(jqs .archived_at)" = "null" ] || fail "flag off: item must still be pending"
stop_server
ok "watch_inbox off: no dispatch, items untouched"

# ---- flag ON: every pending change request is triaged in one go ----

start_server --watch-inbox
# Seven first passes and one second pass (the sharpen), then seven jobs have
# each logged their one line.
wait_lines "$P_LOG" 8
wait_lines "$JOBLOG" 7
sleep 1
[ "$(wc -l < "$P_LOG")" -eq 8 ] || fail "expected 7 first passes + 1 second pass, got: $(cat "$P_LOG")"
[ -d "$WORKSPACE" ] || fail "the dispatch folder ~/.naru/workspace must be created on demand"
LINE=$(grep "|inbox $NA:" "$P_LOG" | head -1)
case "$LINE" in
  "$WORKSPACE|inbox $NA: fyi only: "*"|haiku") ;;
  *) fail "expected a haiku call in $WORKSPACE named 'inbox $NA: <first body line>', got '$LINE'" ;;
esac
ok "every pending item is triaged in one tick, in ~/.naru/workspace (created on demand), session named 'inbox <id>: <first body line>'"

# The call is a print-mode, tool-less, schema-bound one -- never a --bg agent.
FLAGS=$(tr '\n' '|' < "$STUB_DIR/flags-haiku-$NA")
case "$FLAGS" in
  "-p|--model|haiku|--name|inbox $NA: "*"|--tools||--strict-mcp-config|--output-format|json|--json-schema|{"*) ;;
  *) fail "pass-1 argv is not the structured print call: $FLAGS" ;;
esac
case "$(tr '\n' '|' < "$STUB_DIR/flags-sonnet-$SHARP")" in
  "-p|--model|sonnet|--name|"*"|--tools||--strict-mcp-config|--output-format|json|--json-schema|{"*) ;;
  *) fail "pass-2 argv is not the structured print call on sonnet" ;;
esac
grep -q '"not-actionable"' "$STUB_DIR/schema-haiku-$NA" || fail "pass 1 must carry the verdict schema"
grep -q '"acceptance"' "$STUB_DIR/schema-sonnet-$SHARP" || fail "pass 2 must carry the task schema"
[ ! -s "$BG_CALLS" ] || fail "the watcher must never call --bg, agents or stop: $(cat "$BG_CALLS")"
[ ! -e "$FAKE_HOME/.claude/agents/inbox-triage.md" ] ||
  fail "the inbox-triage agent definition must no longer be seeded"
ok "the calls are 'claude -p --model <m> --tools \"\" --strict-mcp-config --output-format json --json-schema' (haiku, then sonnet), never --bg; no agent definition seeded"

# The prompt carries the body and the project list, the body byte-identical,
# and nothing in a hostile body ran.
grep -qF -- "$HOSTILE" "$STUB_DIR/prompt-haiku-$NA" || fail "the prompt must carry the body byte-identical"
grep -q "^#$A A — repo " "$STUB_DIR/prompt-haiku-$NA" || fail "the prompt must list project A: $(grep -n '^#' "$STUB_DIR/prompt-haiku-$NA")"
grep -q "DATA written by another agent" "$STUB_DIR/prompt-haiku-$NA" || fail "the body must be framed as data"
[ -z "$(find "$TMP" -name 'pwned*' 2>/dev/null)" ] || fail "a hostile body ran something: $(find "$TMP" -name 'pwned*')"
ok "the prompt carries the body byte-identical and the project list; \$() and backticks in a body ran nothing"

# One JSON line per job in the job log.
[ "$(wc -l < "$JOBLOG")" -eq 7 ] || fail "expected one log line per job, got: $(cat "$JOBLOG")"
while read -r l; do jq -e 'type == "object"' <<<"$l" >/dev/null || fail "not a JSON object line: $l"; done < "$JOBLOG"
[ "$(jq -s '[.[] | select(.kind == "inbox-triage")] | length' "$JOBLOG")" -eq 6 ] ||
  fail "six jobs must report: $(cat "$JOBLOG")"
[ "$(jq -s '[.[] | select(.error)] | length' "$JOBLOG")" -eq 1 ] ||
  fail "the failed call must log one error line: $(cat "$JOBLOG")"
ok "each job leaves exactly one JSON line in logs/inbox-triage.log (six reports, one error)"

# ---- one check per outcome ----

run 0 "$MESA" inbox show "$NA"
[ "$(jqs .archived_at)" != "null" ] || fail "not-actionable must archive the item"
[ "$(jqs .archive_reason)" = "an FYI, nothing to do" ] || fail "reason: $(jqs .archive_reason)"
[ "$(jqs .archive_outcome)" = "not-actionable" ] || fail "outcome: $(jqs .archive_outcome)"
ok "not-actionable: archived with the model's reason and outcome"

run 0 "$MESA" inbox show "$DUP"
DUP_CREATED=$(jqs .created_at)
[ "$(jqs .archive_reason)" = "duplicate of task $TASK_DUP: same eval bug" ] || fail "reason: $(jqs .archive_reason)"
[ "$(jqs .archive_outcome)" = "duplicate" ] || fail "outcome: $(jqs .archive_outcome)"
run 0 "$MESA" task show "$TASK_DUP"
WANT=$'From inbox item '"$DUP"$' (agent-7, '"$DUP_CREATED"$'):\nkhora: eval errors on undefined (again)'
[ "$(jqs .result)" = "$WANT" ] || fail "the item text must be appended to the task's result, got: $(jqs .result)"
ok "duplicate: archived 'duplicate of task N: <reason>', the item's text appended to that task's result"

run 0 "$MESA" inbox show "$SHIP"
[ "$(jqs .archive_reason)" = "shipped in ${SHA:0:9}: the commit fixes it" ] || fail "reason: $(jqs .archive_reason)"
[ "$(jqs .archive_outcome)" = "null" ] || fail "shipped carries no outcome: $(jqs .archive_outcome)"
run 0 "$MESA" inbox show "$BOGUS"
[ "$(jqs .archived_at)" = "null" ] || fail "a made-up sha must not archive the item"
[ "$(jqs .read_at)" != "null" ] || fail "a made-up sha is a hold: the item is marked read"
ok "shipped: a real commit sha archives 'shipped in <sha>: <reason>'; a made-up one is a hold"

run 0 "$MESA" inbox show "$SHARP"
SHARP_CREATED=$(jqs .created_at)
SHARP_TASK=$(jqs .converted_task_id)
[ "$SHARP_TASK" != "null" ] || fail "sharpen must convert the item to a task"
[ "$(jqs .archive_outcome)" = "converted-to-task" ] || fail "outcome: $(jqs .archive_outcome)"
run 0 "$MESA" task show "$SHARP_TASK"
[ "$(jqs .status)" = "backlog" ] || fail "the sharpened task stays in backlog"
[ "$(jqs .project_id)" = "$A" ] || fail "the task lands in the chosen project"
[ "$(jqs .priority)" = "high" ] || fail "priority: $(jqs .priority)"
[ "$(jqs .acceptance)" = "- prints undefined" ] || fail "acceptance: $(jqs .acceptance)"
WANT=$'Fix khora eval on undefined\n\nMake `khora eval` print `undefined`.\n\nFrom inbox item '"$SHARP"$' (agent-7, '"$SHARP_CREATED"$'), originating task '"$TASK_A"$'.'
[ "$(jqs .description)" = "$WANT" ] || fail "description: $(jqs .description)"
[ "$(calls "$SHARP" sonnet)" -eq 1 ] || fail "sharpen makes exactly one second pass"
ok "sharpen: a sonnet pass writes the backlog task (title, body, footer, acceptance, priority) and the item is converted-to-task"

for id in "$HOLD" "$FAILED"; do
  run 0 "$MESA" inbox show "$id"
  [ "$(jqs .archived_at)" = "null" ] && [ "$(jqs .converted_task_id)" = "null" ] || fail "item $id must stay pending"
done
run 0 "$MESA" inbox show "$HOLD"
[ "$(jqs .read_at)" != "null" ] || fail "a hold marks the item read"
run 0 "$MESA" inbox show "$FAILED"
[ "$(jqs .read_at)" = "null" ] || fail "a failed call writes nothing, not even a read stamp"
ok "hold marks the item read and stays pending; a failed call leaves it untouched"

# ---- already dispatched: no re-dispatch, tick after tick ----

[ "$(wc -l < "$P_LOG")" -eq 8 ] || fail "a held or failed item must not be re-dispatched on later ticks: $(cat "$P_LOG")"
ok "pending items left in place (hold, failed call) are not re-dispatched on later ticks"

# ---- only change requests are triaged (task 846) ----

[ "$(calls "$SUMMARY" haiku)" -eq 0 ] || fail "a task summary must never be triaged"
run 0 "$MESA" inbox show "$SUMMARY"
[ "$(jqs .kind)" = "task-summary" ] && [ "$(jqs .archived_at)" = "null" ] || fail "the watcher must not touch the summary"
ok "a task-summary item is never dispatched"

# ---- a newly-arrived item dispatches even while older ones are claimed ----

LATE=$(add_item "loki: find exits 0 on no match")
wait_lines "$P_LOG" 9
[ "$(calls "$LATE" haiku)" -eq 1 ] || fail "the new item must be dispatched once: $(cat "$P_LOG")"
wait_lines "$JOBLOG" 8
ok "a new inbox item is dispatched on the next tick, with its own id"

# ---- --watch-todo is a separate flag: the todo backlog is untouched ----

run 0 "$MESA" task show "$TASK_A"
[ "$(jqs .status)" = "todo" ] || fail "--watch-inbox alone must not claim a todo task"
[ ! -s "$BG_CALLS" ] || fail "--watch-inbox alone must not dispatch anything through --bg"
stop_server
ok "watch_inbox is independent of watch_todo: no task claimed, nothing spawned through --bg"

# ---- a restart re-triages what is still pending, never what is settled ----

# The dedup set is in memory, so a restart re-dispatches every item still
# sitting untriaged (the recoverable direction): the made-up-sha item, the
# held one, the failed one and the late one. Archived and converted items have
# been triaged already.
start_server --watch-inbox
wait_lines "$P_LOG" 13
sleep 1
[ "$(wc -l < "$P_LOG")" -eq 13 ] || fail "a restart re-dispatches exactly the four pending items: $(cat "$P_LOG")"
for id in "$NA" "$DUP" "$SHIP" "$SHARP"; do
  [ "$(calls "$id" haiku)" -eq 1 ] || fail "settled item $id must not be re-triaged after a restart"
done
for id in "$BOGUS" "$HOLD" "$FAILED" "$LATE"; do
  [ "$(calls "$id" haiku)" -eq 2 ] || fail "pending item $id must be re-dispatched after a restart"
done
stop_server
ok "after a restart the pending items are re-dispatched and the settled ones are not"

# ---- a job that cannot start: nothing dispatched, nothing crashes ----

NARU_SELF_BIN=/nonexistent/naru start_server --watch-inbox
sleep 1
[ "$(wc -l < "$P_LOG")" -eq 13 ] || fail "an unstartable job must dispatch nothing: $(cat "$P_LOG")"
curl -sf "http://127.0.0.1:$PORT/api/inbox" >/dev/null || fail "the server must survive a failing job start"
stop_server
ok "a job that cannot start dispatches nothing and the server stays healthy"

echo
echo "inbox-watcher check passed ($CHECKS checks)"
