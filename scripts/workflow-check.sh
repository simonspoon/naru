#!/usr/bin/env bash
# Workflow gate (mesa task 1607): `naru workflow` over the CLI and
# `/api/workflows` over a throwaway `serve`, against a throwaway MESA_DB.
# Replaces the retired diagram gate.
#
# Pinned here: CRUD with the CLI's positional-or-flag create shapes and the
# `--quiet` key sets; the graph rules (cycle, self-edge, duplicate, branch
# edges, one trigger, same-workflow endpoints) with their error codes; a run
# over a cli -> branch -> output(log) graph taking the TRUE path with the
# false one skipped, and the reverse; a failing cli node failing the run
# while the command still exits 0 (the status is data) and the rest skipped;
# a prompt node through a stub `claude` (MESA_CLAUDE_BIN), asserting the exact
# argv it received for thinking off and on; the script node's `{input}` value
# arriving byte-identical for hostile text (never shell-parsed); the task and
# inbox outputs; the ambient-capture example from docs/workflows.md with stub
# `sox`/`auris`; the API routes, including `require_agent_access` refusing a
# foreign Origin and Host; and `serve --watch-workflows` running a due
# time-triggered workflow exactly once per interval.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')
unset CLAUDE_CODE_SESSION_ID

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
NARU="$PWD/target/debug/naru"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"
# A throwaway HOME: a global workflow's cli nodes run in $HOME/.naru/workspace,
# and nothing here should create that folder in the real home.
export HOME="$TMP/home"
mkdir -p "$HOME"
# Pin the user config away from the real one: this gate asserts the BUILT-IN
# workflow-prompt command.
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
    fail "expected exit $expected, got $CODE: $* (stdout: $STDOUT; stderr: $STDERR)"
}
jqs() { jq -r "$1" <<<"$STDOUT"; }
jqe() { jq -r "$1" <<<"$STDERR"; }
keys() { jq -c 'keys' <<<"$1"; }

# ---- stubs: claude (records its argv byte-exactly), sox, auris ----
STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/claude" <<EOS
#!/usr/bin/env bash
# One file per argv element (a prompt holds newlines, so no line format is safe).
rm -f "$STUB_DIR"/argv.*
i=0
for a in "\$@"; do printf '%s' "\$a" > "$STUB_DIR/argv.\$i"; i=\$((i + 1)); done
echo "\$i" > "$STUB_DIR/argc"
[ -e "$STUB_DIR/claude-fail" ] && { echo "stub claude is down" >&2; exit 1; }
echo "  idea: buy milk  "
EOS
chmod +x "$STUB_DIR/claude"
export MESA_CLAUDE_BIN="$STUB_DIR/claude"

# sox: pretend to record; auris: print what "$STUB_DIR/heard" holds as the one
# transcript line of auris's JSON-Lines output (empty file = silence).
cat > "$STUB_DIR/sox" <<EOS
#!/usr/bin/env bash
# sox -d -q -t wav <out> trim 0 10  -> the last argument group's file is the 5th..; find the path
for a in "\$@"; do case "\$a" in /*) out=\$a ;; esac; done
printf 'RIFFstub' > "\$out"
EOS
cat > "$STUB_DIR/auris" <<EOS
#!/usr/bin/env bash
[ "\$1" = "-q" ] && [ "\$2" = "--format" ] && [ "\$3" = "json" ] || { echo "stub auris: unexpected argv: \$*" >&2; exit 2; }
cat >/dev/null
printf '{"type":"segment","text":"partial"}\n'
printf '{"type":"transcript","text":"%s"}\n' "\$(cat "$STUB_DIR/heard")"
EOS
chmod +x "$STUB_DIR/sox" "$STUB_DIR/auris"

argv() { cat "$STUB_DIR/argv.$1"; }

# ================= CRUD =================

run 0 "$NARU" project create "Flows" --no-git
P=$(jqs .id)

run 0 "$NARU" workflow create "Gate demo" --description "a demo"
[ "$(jqs .name)" = "Gate demo" ] || fail "create: name"
[ "$(jqs .description)" = "a demo" ] || fail "create: description"
[ "$(jqs .project_id)" = "null" ] || fail "create: global by default"
[ "$(jqs .trigger)" = "null" ] || fail "create: no trigger yet"
W=$(jqs .id)
ok "workflow create returns the full record, global by default, trigger null"

run 0 "$NARU" workflow create --name "Flag form" --project "$P"
[ "$(jqs .project_id)" = "$P" ] || fail "create --project"
WF=$(jqs .id)
run 2 "$NARU" workflow create "A" --name "B"
[ "$(jqe .error.code)" = "usage" ] || fail "positional+flag name: usage"
run 2 "$NARU" workflow create
[ "$(jqe .error.code)" = "usage" ] || fail "missing name: usage"
ok "workflow create: positional/flag name forms; both or neither is usage"

run 1 "$NARU" workflow create "gate DEMO"
[ "$(jqe .error.code)" = "conflict" ] || fail "duplicate name (case-insensitive): conflict, got $STDERR"
run 1 "$NARU" workflow create "42"
[ "$(jqe .error.code)" = "validation" ] || fail "a numeric name: validation, got $STDERR"
run 1 "$NARU" workflow create "x" --project nosuchproject
[ "$(jqe .error.code)" = "not_found" ] || fail "unknown project name: not_found"
ok "workflow names: unique case-insensitively, never numeric; an unknown project is not_found"

run 0 "$NARU" workflow list
[ "$(jqs 'map(.name) | sort | join(",")')" = "Flag form,Gate demo" ] || fail "list: $STDOUT"
run 0 "$NARU" workflow list "$P"
[ "$(jqs 'map(.name) | join(",")')" = "Flag form" ] || fail "list PROJECT: $STDOUT"
run 0 "$NARU" workflow list --project Flows
[ "$(jqs length)" = "1" ] || fail "list --project by name"
ok "workflow list: bare array, project filter by id, positional or name flag"

run 0 "$NARU" workflow update "gate demo" --description ""
[ "$(jqs .description)" = "null" ] || fail "update --description \"\" clears"
run 0 "$NARU" workflow update "$W" --name "Gate demo" --project ""
run 0 "$NARU" workflow update "$WF" --project ""
[ "$(jqs .project_id)" = "null" ] || fail "update --project \"\" un-binds"
run 2 "$NARU" workflow update "$W"
[ "$(jqe .error.code)" = "usage" ] || fail "update with no field: usage"
ok "workflow update: clears and un-binds; no field is usage"

run 0 "$NARU" workflow show "$W"
[ "$(keys "$STDOUT")" = '["edges","nodes","workflow"]' ] || fail "show shape: $STDOUT"
run 0 "$NARU" workflow get "gate demo" --quiet
[ "$(jq -c '.workflow | keys' <<<"$STDOUT")" = '["created_at","id","name","project_id","trigger","trigger_phrase","updated_at"]' ] ||
  fail "show --quiet drops description: $STDOUT"
ok "workflow show/get: {workflow, nodes, edges}; --quiet drops the description"

# ================= nodes and edges =================

run 0 "$NARU" workflow node create "$W" trigger Start
T=$(jqs .id)
[ "$(jqs .config.mode)" = "manual" ] || fail "a trigger defaults to manual: $STDOUT"
run 0 "$NARU" workflow node create "$W" cli "Echo" --config '{"command":"cat; printf \" seen\""}'
C=$(jqs .id)
run 0 "$NARU" workflow node create --workflow "$W" --kind branch --title "Gate" \
  --config '{"op":"contains","value":"idea"}' --x 500 --y 40
B=$(jqs .id)
[ "$(jqs '.x == 500')" = "true" ] || fail "node create --x"
run 0 "$NARU" workflow node create "$W" output "Yes" --config '{"target":"log","log":"yes"}'
OY=$(jqs .id)
run 0 "$NARU" workflow node create "$W" output "No" --config '{"target":"log","log":"no"}'
ON=$(jqs .id)
[ "$(jqs '.y == 40 and .x != 40')" = "true" ] || fail "an omitted position is placed beside the others, not stacked: $STDOUT"
run 0 "$NARU" workflow node create "$W" cli "Quiet one" --config '{"command":"true"}' --quiet
[ "$(jqs 'keys | join(",")')" = "created_at,id,kind,title,updated_at,workflow_id,x,y" ] || fail "node --quiet drops config: $STDOUT"
Q=$(jqs .id)
ok "workflow node create: positional/flag forms, default trigger config, auto-placement, --quiet drops config"

run 1 "$NARU" workflow node create "$W" trigger Again
[ "$(jqe .error.code)" = "validation" ] || fail "a second trigger: validation"
run 1 "$NARU" workflow node create "$W" cli Bad
[ "$(jqe .error.code)" = "validation" ] || fail "cli with no command: validation"
run 1 "$NARU" workflow node create "$W" cli Bad --config '{"command":"x","oops":1}'
grep -q "unknown key" <<<"$STDERR" || fail "unknown config key: $STDERR"
run 1 "$NARU" workflow node create "$W" branch Bad --config '{"op":"score_above","value":"high"}'
[ "$(jqe .error.code)" = "validation" ] || fail "non-numeric score: validation"
run 1 "$NARU" workflow node create "$W" branch Bad --config '{"op":"regex","value":"("}'
[ "$(jqe .error.code)" = "validation" ] || fail "invalid regex: validation"
run 1 "$NARU" workflow node create "$W" output Bad --config '{"target":"inbox"}'
[ "$(jqe .error.code)" = "validation" ] || fail "inbox output needs task_id: validation"
run 1 "$NARU" workflow node create "$W" prompt Bad --config '{"model":"gpt","prompt":"x"}'
[ "$(jqe .error.code)" = "validation" ] || fail "unknown model: validation"
run 1 "$NARU" workflow node create "$W" cli Bad --config 'not json'
[ "$(jqe .error.code)" = "validation" ] || fail "--config not JSON: validation"
run 2 "$NARU" workflow node create "$W" nonsense Bad
[ "$(jqe .error.code)" = "usage" ] || fail "unknown kind: usage"
ok "node config is validated per kind: second trigger, missing/unknown keys, bad op/model/regex, bad JSON"

run 0 "$NARU" workflow edge create "$W" "$T" "$C"
[ "$(jqs .branch)" = "null" ] || fail "edge: branch null"
E1=$(jqs .id)
run 0 "$NARU" workflow edge create "$W" "$C" "$B"
run 0 "$NARU" workflow edge create --workflow "$W" --from "$B" --to "$OY" --branch true
run 0 "$NARU" workflow edge create "$W" "$B" "$ON" --branch false
[ "$(jqs .branch)" = "false" ] || fail "edge --branch false"
ok "workflow edge create: positional and flag forms, branch edges"

run 1 "$NARU" workflow edge create "$W" "$C" "$B"
[ "$(jqe .error.code)" = "conflict" ] || fail "duplicate edge: conflict"
run 1 "$NARU" workflow edge create "$W" "$C" "$C"
[ "$(jqe .error.code)" = "cycle" ] || fail "self-edge: cycle"
run 1 "$NARU" workflow edge create "$W" "$OY" "$C"
[ "$(jqe .error.code)" = "cycle" ] || fail "an edge closing a cycle: cycle"
run 1 "$NARU" workflow edge create "$W" "$OY" "$T"
[ "$(jqe .error.code)" = "validation" ] || fail "an edge into the trigger: validation"
run 1 "$NARU" workflow edge create "$W" "$B" "$Q"
[ "$(jqe .error.code)" = "validation" ] || fail "a branch edge with no --branch: validation"
run 1 "$NARU" workflow edge create "$W" "$C" "$Q" --branch true
[ "$(jqe .error.code)" = "validation" ] || fail "--branch on a non-branch edge: validation"
run 0 "$NARU" workflow create other
run 0 "$NARU" workflow node create other cli Foreign --config '{"command":"true"}'
FOREIGN=$(jqs .id)
run 1 "$NARU" workflow edge create "$W" "$C" "$FOREIGN"
[ "$(jqe .error.code)" = "validation" ] || fail "an edge to another workflow's node: validation"
run 2 "$NARU" workflow edge create "$W" "$C" "$Q" --branch maybe
[ "$(jqe .error.code)" = "usage" ] || fail "--branch maybe: usage"
ok "edge rules: duplicate=conflict, self/closing edge=cycle, into trigger / branch mismatch / foreign node=validation"

run 0 "$NARU" workflow edge delete "$E1" --quiet
[ "$(jqs .id)" = "$E1" ] || fail "edge delete echoes the edge"
run 0 "$NARU" workflow edge create "$W" "$T" "$C"
run 0 "$NARU" workflow node update "$Q" --title "Renamed" --x 10 --config '{"command":"false","timeout_secs":5}'
[ "$(jqs .title)" = "Renamed" ] && [ "$(jqs .config.timeout_secs)" = "5" ] || fail "node update: $STDOUT"
run 1 "$NARU" workflow node update "$Q" --config '{"nope":1}'
[ "$(jqe .error.code)" = "validation" ] || fail "node update validates against its kind"
run 2 "$NARU" workflow node update "$Q"
[ "$(jqe .error.code)" = "usage" ] || fail "node update with no field: usage"
run 0 "$NARU" workflow node delete "$Q"
[ "$(keys "$STDOUT")" = '["edges","node"]' ] || fail "node delete echoes {node, edges}: $STDOUT"
run 1 "$NARU" workflow node update "$Q" --title x
[ "$(jqe .error.code)" = "not_found" ] || fail "a deleted node: not_found"
ok "node update/delete and edge delete echo and validate"

run 0 "$NARU" workflow list
[ "$(jq -r '.[] | select(.name == "Gate demo") | .trigger' <<<"$STDOUT")" = "manual" ] || fail "list carries the trigger mode: $STDOUT"
ok "workflow list rows carry their trigger mode"

# ================= running: true and false paths =================

run 0 "$NARU" workflow run "gate demo" --input "an idea"
[ "$(jqs .status)" = "succeeded" ] || fail "run: $STDOUT"
[ "$(jqs '.steps | map(.title + "=" + .status) | join(",")')" = "Start=ok,Echo=ok,Gate=ok,Yes=ok,No=skipped" ] ||
  fail "true path: $(jqs '.steps | map(.title + "=" + .status) | join(",")')"
[ "$(jqs '.steps[1].output')" = "an idea seen" ] || fail "cli node: stdin reaches the command"
[ "$(jqs .trigger)" = "manual" ] || fail "run trigger"
RID=$(jqs .id)
run 0 "$NARU" workflow log yes
[ "$(jqs '.[0].text')" = "an idea seen" ] && [ "$(jqs length)" = "1" ] || fail "the true branch wrote the log: $STDOUT"
run 0 "$NARU" workflow log no
[ "$(jqs length)" = "0" ] || fail "the false branch wrote nothing: $STDOUT"
ok "run: the TRUE path runs, the false output is skipped, the log line is written"

run 0 "$NARU" workflow run "$W" --input "nothing here" --trigger voice
[ "$(jqs '.steps | map(.title + "=" + .status) | join(",")')" = "Start=ok,Echo=ok,Gate=ok,Yes=skipped,No=ok" ] ||
  fail "false path: $(jqs '.steps | map(.title + "=" + .status) | join(",")')"
[ "$(jqs .trigger)" = "voice" ] || fail "--trigger voice recorded"
run 0 "$NARU" workflow log no --limit 5
[ "$(jqs '.[0].text')" = "nothing here seen" ] || fail "false branch log: $STDOUT"
ok "run: the FALSE path runs the other output; --trigger voice is recorded"

run 2 "$NARU" workflow run "$W" --trigger time
[ "$(jqe .error.code)" = "usage" ] || fail "--trigger time is the watcher's alone: usage"
printf 'from a file' > "$TMP/in.txt"
run 0 "$NARU" workflow run "$W" --input-file "$TMP/in.txt" --quiet
[ "$(jqs 'keys | join(",")')" = "error,finished_at,id,started_at,status,trigger,workflow_id" ] || fail "run --quiet drops steps and input: $STDOUT"
run 0 "$NARU" workflow run "$W" --input-file - <<<"from stdin"
run 0 "$NARU" workflow run-show "$(jqs .id)"
[ "$(jqs '.steps[1].output')" = "from stdin
 seen" ] || fail "--input-file - reads stdin: $(jqs '.steps[1].output')"
run 0 "$NARU" workflow runs "$W"
[ "$(jqs 'map(.id) == (map(.id) | sort | reverse)')" = "true" ] || fail "runs are newest first"
[ "$(jqs '.[0] | has("steps") or has("input")')" = "false" ] || fail "runs rows omit steps and input"
run 0 "$NARU" workflow run-show "$RID"
[ "$(jqs '.steps | length')" = "5" ] || fail "run-show is in full"
run 1 "$NARU" workflow run-show 999999
[ "$(jqe .error.code)" = "not_found" ] || fail "run-show unknown: not_found"
ok "run: --input-file (path and stdin), --quiet, runs newest first without steps, run-show in full"

# A workflow with no trigger, and one with two (a second created by hand is
# refused at the store, so only the no-trigger case is reachable).
run 0 "$NARU" workflow create "No trigger"
run 1 "$NARU" workflow run "No trigger"
[ "$(jqe .error.code)" = "validation" ] || fail "a run needs a trigger: validation"
run 1 "$NARU" workflow run nosuchflow
[ "$(jqe .error.code)" = "not_found" ] || fail "run unknown: not_found"
ok "a run needs exactly one trigger: validation; an unknown workflow is not_found"

# ================= a failing node =================

run 0 "$NARU" workflow create "Failing"
run 0 "$NARU" workflow node create Failing trigger Start
FT=$(jqs .id)
run 0 "$NARU" workflow node create Failing cli Boom --config '{"command":"echo boom >&2; exit 3"}'
FB=$(jqs .id)
run 0 "$NARU" workflow node create Failing output After --config '{"target":"log","log":"never"}'
FA=$(jqs .id)
"$NARU" workflow edge create Failing "$FT" "$FB" >/dev/null
"$NARU" workflow edge create Failing "$FB" "$FA" >/dev/null
run 0 "$NARU" workflow run Failing --input x
[ "$(jqs .status)" = "failed" ] || fail "a failing node fails the run: $STDOUT"
[ "$(jqs '.steps | map(.status) | join(",")')" = "ok,failed,skipped" ] || fail "downstream skipped: $STDOUT"
grep -q boom <<<"$(jqs '.steps[1].error')" || fail "the failed step carries stderr: $STDOUT"
grep -q Boom <<<"$(jqs .error)" || fail "the run error names the node: $STDOUT"
run 0 "$NARU" workflow log never
[ "$(jqs length)" = "0" ] || fail "nothing downstream of a failure ran"
ok "a failing cli node fails the run (record printed, exit 0), skips the rest, and runs nothing downstream"

run 0 "$NARU" workflow node update "$FB" --config '{"command":"sleep 30","timeout_secs":1}'
START=$(date +%s)
run 0 "$NARU" workflow run Failing
[ $(($(date +%s) - START)) -lt 15 ] || fail "the timeout must kill the node, not wait it out"
grep -q "timed out" <<<"$(jqs '.steps[1].error')" || fail "timeout error: $STDOUT"
ok "a cli node past its timeout_secs is killed and fails the run"

# ================= prompt node through the stub claude =================

run 0 "$NARU" workflow create "Prompting"
run 0 "$NARU" workflow node create Prompting trigger Start
PT=$(jqs .id)
run 0 "$NARU" workflow node create Prompting prompt Label \
  --config '{"model":"haiku","thinking":false,"prompt":"Tag this as idea/todo/note."}'
PP=$(jqs .id)
run 0 "$NARU" workflow node create Prompting output Out --config '{"target":"log","log":"labels"}'
PO=$(jqs .id)
"$NARU" workflow edge create Prompting "$PT" "$PP" >/dev/null
"$NARU" workflow edge create Prompting "$PP" "$PO" >/dev/null
run 0 "$NARU" workflow run Prompting --input 'buy $(touch /tmp/NARU_PWN) milk'
[ "$(jqs .status)" = "succeeded" ] || fail "prompt run: $STDOUT"
[ "$(jqs '.steps[1].output')" = "idea: buy milk" ] || fail "the model's answer is the node output, trimmed: $STDOUT"
[ ! -e /tmp/NARU_PWN ] || { rm -f /tmp/NARU_PWN; fail "a hostile input was executed"; }
[ "$(cat "$STUB_DIR/argc")" = "7" ] || fail "claude argv count: $(cat "$STUB_DIR/argc")"
[ "$(argv 0)" = "-p" ] && [ "$(argv 1)" = "--model" ] && [ "$(argv 2)" = "haiku" ] &&
  [ "$(argv 3)" = "--settings" ] && [ "$(argv 4)" = '{"alwaysThinkingEnabled":false}' ] &&
  [ "$(argv 5)" = "--" ] || fail "claude argv (thinking off): $(for i in 0 1 2 3 4 5 6; do echo "[$(argv $i)]"; done)"
EXPECTED_PROMPT=$'Tag this as idea/todo/note.\n\nbuy $(touch /tmp/NARU_PWN) milk'
[ "$(argv 6)" = "$EXPECTED_PROMPT" ] || fail "the prompt is the node's text, a blank line, then the input: $(argv 6)"
ok "prompt node: claude -p --model haiku --settings {alwaysThinkingEnabled:false} -- <prompt>\\n\\n<input>, the answer trimmed, hostile input inert"

run 0 "$NARU" workflow node update "$PP" --config '{"model":"opus","thinking":true,"prompt":"P"}'
run 0 "$NARU" workflow run Prompting
[ "$(argv 2)" = "opus" ] && [ "$(argv 4)" = '{"alwaysThinkingEnabled":true}' ] || fail "thinking on / opus argv"
[ "$(argv 6)" = "P" ] || fail "an empty input adds no blank line: [$(argv 6)]"
ok "prompt node: opus with thinking on passes alwaysThinkingEnabled:true; an empty input adds nothing to the prompt"

touch "$STUB_DIR/claude-fail"
run 0 "$NARU" workflow run Prompting --input x
[ "$(jqs .status)" = "failed" ] && grep -q "stub claude is down" <<<"$(jqs '.steps[1].error')" || fail "a failing model call fails the node: $STDOUT"
rm -f "$STUB_DIR/claude-fail"
ok "a failing model call is a node failure carrying its stderr"

# a missing binary is a clear node failure (the default template, an unusable bin)
MESA_CLAUDE_BIN="$TMP/does-not-exist" run 0 "$NARU" workflow run Prompting --input x
[ "$(jqs .status)" = "failed" ] || fail "a missing claude fails the node: $STDOUT"
grep -qi "not found\|No such file" <<<"$(jqs '.steps[1].error')" || fail "a missing binary says so: $(jqs '.steps[1].error')"
ok "a missing claude binary is a node failure that says so"

# ================= script node: {input} arrives byte-identical =================

run 0 "$NARU" script create echo-arg 'printf "%s" "$1"' --arg text:text:required
run 0 "$NARU" workflow create "Scripting"
run 0 "$NARU" workflow node create Scripting trigger Start
ST=$(jqs .id)
run 0 "$NARU" workflow node create Scripting script Run --config '{"script":"echo-arg","values":{"text":"{input}"}}'
SS=$(jqs .id)
"$NARU" workflow edge create Scripting "$ST" "$SS" >/dev/null
HOSTILE=$'$(touch '"$TMP"$'/PWNED) `touch '"$TMP"$'/PWNED2` \'single\' "double" ; rm -rf / # \\n {input}'
run 0 "$NARU" workflow run Scripting --input "$HOSTILE"
[ "$(jqs .status)" = "succeeded" ] || fail "script run: $STDOUT"
[ "$(jqs '.steps[1].output')" = "$HOSTILE" ] || fail "the {input} value must reach the script byte-identical, got: $(jqs '.steps[1].output')"
[ ! -e "$TMP/PWNED" ] && [ ! -e "$TMP/PWNED2" ] || fail "hostile input was shell-parsed"
ok "script node: a hostile {input} value reaches the script as an argument, byte-identical, never shell-parsed"

run 0 "$NARU" workflow node update "$SS" --config '{"script":"nosuchscript"}'
run 0 "$NARU" workflow run Scripting --input x
[ "$(jqs .status)" = "failed" ] && grep -q "no script named" <<<"$(jqs '.steps[1].error')" || fail "an unknown script fails the node: $STDOUT"
ok "script node: an unknown script is a node failure"

# ================= task and inbox outputs =================

run 0 "$NARU" task create "$P" "the origin task" --quiet
OT=$(jqs .id)
run 0 "$NARU" workflow create "Filing"
run 0 "$NARU" workflow node create Filing trigger Start
GT=$(jqs .id)
run 0 "$NARU" workflow node create Filing output "File task" --config '{"target":"task","project":"Flows"}'
GK=$(jqs .id)
run 0 "$NARU" workflow node create Filing output "File inbox" \
  --config "{\"target\":\"inbox\",\"task_id\":$OT,\"kind\":\"change-request\"}"
GI=$(jqs .id)
"$NARU" workflow edge create Filing "$GT" "$GK" >/dev/null
"$NARU" workflow edge create Filing "$GT" "$GI" >/dev/null
run 0 "$NARU" workflow run Filing --input "ship the workflows"
[ "$(jqs .status)" = "succeeded" ] || fail "filing run: $STDOUT"
grep -q "^created task " <<<"$(jqs '.steps[1].output')" || fail "task receipt: $STDOUT"
run 0 "$NARU" task list "$P"
[ "$(jqs '[.[] | select(.name == "ship the workflows")] | length')" = "1" ] || fail "the task output created a task: $STDOUT"
run 0 "$NARU" inbox list
[ "$(jqs '[.[] | select(.body == "ship the workflows" and .kind == "change-request" and .task_id == '"$OT"')] | length')" = "1" ] ||
  fail "the inbox output filed a change request naming its task: $STDOUT"
ok "output nodes: target task creates a task in the named project, target inbox files an item for its task"

run 0 "$NARU" workflow run Filing
[ "$(jqs .status)" = "failed" ] && grep -q "must not be empty" <<<"$(jqs '.steps[1].error')" || fail "an empty input cannot file a task: $STDOUT"
ok "an output node given no text fails rather than filing an empty record"

run 0 "$NARU" workflow node create Filing output "Board" --config '{"target":"board"}'
"$NARU" workflow edge create Filing "$GT" "$(jqs .id)" >/dev/null
run 0 "$NARU" workflow run Filing --input "x"
[ "$(jqs '.steps | map(select(.title == "Board")) | .[0].status')" = "failed" ] || fail "board output with no live session fails"
grep -q "no live session" <<<"$(jqs '.steps | map(select(.title == "Board")) | .[0].error')" || fail "board failure names the cause"
ok "a board output with no live session is a node failure naming the cause"

# ================= live board push --workflow =================

run 0 "$NARU" live start --no-agent
run 0 "$NARU" live board push --workflow "gate demo" --say "the flow"
[ "$(jqs .kind)" = "diagram" ] || fail "a workflow snapshot is a diagram board: $STDOUT"
BID=$(jqs .id)
run 0 "$NARU" live board show "$BID"
grep -q "<svg" <<<"$(jqs .body)" && grep -q ">Gate</text>" <<<"$(jqs .body)" && grep -q ">true</text>" <<<"$(jqs .body)" ||
  fail "the snapshot draws nodes and branch labels: $STDOUT"
run 0 "$NARU" workflow node update "$B" --title "Renamed gate"
run 0 "$NARU" live board show "$BID"
grep -q ">Gate</text>" <<<"$(jqs .body)" || fail "a board is a snapshot: later edits do not change it"
run 0 "$NARU" live board push --workflow "$W"
run 2 "$NARU" live board push --diagram 1
[ "$(jqe .error.code)" = "usage" ] || fail "--diagram is retired: usage"
run 0 "$NARU" live stop
ok "live board push --workflow: an SVG snapshot (kind diagram) with nodes and branch labels; --diagram is retired"

# ================= the ambient-capture example =================
# docs/workflows.md "Ambient capture", built with exactly the commands the
# doc gives, against stub sox/auris: record, transcribe, gate on "heard a
# word", label with haiku (thinking off), log to "ambient".

run 0 "$NARU" workflow create ambient --description "Capture a spoken thought"
run 0 "$NARU" workflow node create ambient trigger Start --config '{"mode":"manual","phrase":"capture a thought"}'
A1=$(jqs .id)
CMD='f=$(mktemp -t naru-ambient); sox -d -q -t wav "$f" trim 0 10; auris -q --format json < "$f" | jq -rs "map(select(.type==\"transcript\")) | last | .text // \"\""; rm -f "$f"'
run 0 "$NARU" workflow node create ambient cli Transcribe --config "$(jq -nc --arg c "$CMD" '{command: $c, timeout_secs: 30}')"
A2=$(jqs .id)
run 0 "$NARU" workflow node create ambient branch Gate --config '{"op":"regex","value":"[[:alpha:]]"}'
A3=$(jqs .id)
run 0 "$NARU" workflow node create ambient prompt "Label idea" \
  --config '{"model":"haiku","thinking":false,"prompt":"Tag the following as idea, todo or note, then repeat it on one line."}'
A4=$(jqs .id)
run 0 "$NARU" workflow node create ambient output Log --config '{"target":"log","log":"ambient"}'
A5=$(jqs .id)
"$NARU" workflow edge create ambient "$A1" "$A2" >/dev/null
"$NARU" workflow edge create ambient "$A2" "$A3" >/dev/null
"$NARU" workflow edge create ambient "$A3" "$A4" --branch true >/dev/null
"$NARU" workflow edge create ambient "$A4" "$A5" >/dev/null
run 0 "$NARU" workflow list
[ "$(jq -r '.[] | select(.name == "ambient") | .trigger_phrase' <<<"$STDOUT")" = "capture a thought" ] || fail "the voice phrase is listed"

printf 'buy milk on the way home' > "$STUB_DIR/heard"
PATH="$STUB_DIR:$PATH" run 0 "$NARU" workflow run ambient --trigger voice
[ "$(jqs .status)" = "succeeded" ] || fail "ambient run: $STDOUT"
[ "$(jqs '.steps[1].output')" = "buy milk on the way home" ] || fail "Transcribe printed the transcript: $(jqs '.steps[1].output')"
[ "$(jqs '.steps | map(.status) | join(",")')" = "ok,ok,ok,ok,ok" ] || fail "every step ran: $STDOUT"
run 0 "$NARU" workflow log ambient
[ "$(jqs length)" = "1" ] && [ "$(jqs '.[0].text')" = "idea: buy milk" ] || fail "the labelled line reached the log: $STDOUT"
ok "ambient capture: record -> transcribe -> gate -> label -> log, end to end over stubs"

: > "$STUB_DIR/heard"   # silence
PATH="$STUB_DIR:$PATH" run 0 "$NARU" workflow run ambient
[ "$(jqs '.steps | map(.status) | join(",")')" = "ok,ok,ok,skipped,skipped" ] || fail "silence stops at the gate: $STDOUT"
run 0 "$NARU" workflow log ambient
[ "$(jqs length)" = "1" ] || fail "silence logged nothing"
ok "ambient capture: silence fails the gate, so the model is never called and nothing is logged"

# ================= delete =================

run 0 "$NARU" workflow delete other --quiet
[ "$(keys "$STDOUT")" = '["edges","nodes","workflow"]' ] || fail "delete echoes the view: $STDOUT"
run 0 "$NARU" workflow delete "Filing"
[ "$(jqs '.nodes | length')" = "4" ] || fail "delete echoes every destroyed node: $STDOUT"
run 1 "$NARU" workflow show Filing
[ "$(jqe .error.code)" = "not_found" ] || fail "show a deleted workflow: not_found"
run 0 "$NARU" workflow log yes
[ "$(jqs length)" = "1" ] && [ "$(jqs '.[0].workflow_id')" != "null" ] || fail "setup for log retention: $STDOUT"
run 0 "$NARU" workflow delete "Gate demo"
run 0 "$NARU" workflow log yes
[ "$(jqs length)" = "1" ] && [ "$(jqs '.[0].workflow_id')" = "null" ] || fail "log lines outlive their workflow, unattributed: $STDOUT"
ok "workflow delete echoes the whole graph; its log lines stay, unattributed"

run 0 "$NARU" workflow create Bound --project "$P"
run 0 "$NARU" project delete "$P" --quiet
run 1 "$NARU" workflow show Bound
[ "$(jqe .error.code)" = "not_found" ] || fail "deleting a project deletes its workflows: $STDERR"
ok "project delete cascades to the workflows bound to it"

# ================= API =================

PORT=17795
"$NARU" serve --port "$PORT" >"$TMP/serve.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null ||
  fail "server did not start (log: $(cat "$TMP/serve.log"))"

api() { # api <expected-status> <method> <path> [json-body]
  local expected=$1 method=$2 path=$3 body=${4:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method")
  case "$method" in
    POST | PUT | PATCH | DELETE)
      args+=(-H 'Content-Type: application/json' -d "${body:-{\}}")
      ;;
  esac
  STATUS=$(curl "${args[@]}" "http://127.0.0.1:$PORT$path")
  BODY=$(cat "$TMP/body")
  [ "$STATUS" = "$expected" ] ||
    fail "expected HTTP $expected, got $STATUS: $method $path ($BODY)"
}
jqb() { jq -r "$1" <<<"$BODY"; }

api 201 POST /api/workflows '{"name":"Api flow","description":"over http"}'
AW=$(jqb .id)
[ "$(jqb .name)" = "Api flow" ] && [ "$(jqb .trigger)" = "null" ] || fail "API create: $BODY"
api 409 POST /api/workflows '{"name":"api FLOW"}'
[ "$(jqb .error.code)" = "conflict" ] || fail "API duplicate name: conflict"
api 422 POST /api/workflows '{"name":"  "}'
api 201 POST "/api/workflows/$AW/nodes" '{"kind":"trigger","title":"Go","config":{"mode":"manual"}}'
AT=$(jqb .id)
api 201 POST "/api/workflows/$AW/nodes" '{"kind":"cli","title":"Shout","config":{"command":"tr a-z A-Z"}}'
AC=$(jqb .id)
api 201 POST "/api/workflows/$AW/nodes" '{"kind":"output","title":"Out","config":{"target":"log","log":"api"}}'
AO=$(jqb .id)
api 422 POST "/api/workflows/$AW/nodes" '{"kind":"cli","title":"Bad","config":{}}'
api 422 POST "/api/workflows/$AW/nodes" '{"kind":"nonsense","title":"Bad"}'
api 201 POST "/api/workflows/$AW/edges" "{\"from_node\":$AT,\"to_node\":$AC}"
AE=$(jqb .id)
api 201 POST "/api/workflows/$AW/edges" "{\"from_node\":$AC,\"to_node\":$AO}"
api 409 POST "/api/workflows/$AW/edges" "{\"from_node\":$AO,\"to_node\":$AC}"
[ "$(jqb .error.code)" = "cycle" ] || fail "API cycle: 409 cycle, got $BODY"
api 409 POST "/api/workflows/$AW/edges" "{\"from_node\":$AT,\"to_node\":$AC}"
[ "$(jqb .error.code)" = "conflict" ] || fail "API duplicate edge: conflict"
api 422 POST "/api/workflows/$AW/edges" "{\"from_node\":$AC,\"to_node\":$AO,\"branch\":\"true\"}"
ok "API: workflow/node/edge create with 201, and conflict/cycle/validation shapes"

api 200 GET "/api/workflows/$AW"
[ "$(jq -c 'keys' <<<"$BODY")" = '["edges","nodes","workflow"]' ] && [ "$(jqb '.nodes | length')" = "3" ] || fail "API show: $BODY"
api 200 GET /api/workflows
[ "$(jqb '[.[] | select(.name == "Api flow")] | length')" = "1" ] || fail "API list"
api 200 GET "/api/workflows?project=999"
[ "$(jqb length)" = "0" ] || fail "API list ?project="
api 200 PATCH "/api/workflows/$AW" '{"description":null}'
[ "$(jqb .description)" = "null" ] || fail "API patch clears description"
api 200 PATCH "/api/workflow-nodes/$AC" '{"title":"Shouting","x":120}'
[ "$(jqb .title)" = "Shouting" ] && [ "$(jqb '.x == 120')" = "true" ] || fail "API node patch"
api 422 PATCH "/api/workflow-nodes/$AC" '{"config":{"nope":1}}'
api 404 GET /api/workflow-runs/999999
ok "API: show, list, patch (description null clears), node patch and its validation, unknown run 404"

api 200 POST "/api/workflows/$AW/run" '{"input":"hello api"}'
[ "$(jqb .status)" = "succeeded" ] && [ "$(jqb '.steps[1].output')" = "HELLO API" ] || fail "API run: $BODY"
AR=$(jqb .id)
api 200 GET "/api/workflows/$AW/runs"
[ "$(jqb '.[0].id')" = "$AR" ] && [ "$(jqb '.[0].steps | length')" = "3" ] || fail "API runs"
api 200 GET "/api/workflow-runs/$AR"
[ "$(jqb .input)" = "hello api" ] || fail "API run show"
api 200 GET "/api/workflow-log?log=api&limit=5"
[ "$(jqb '.[0].text')" = "HELLO API" ] || fail "API log: $BODY"
# No input: the trigger hands on "", the log node refuses an empty line, so the
# run is recorded as failed — still a 200.
api 200 POST "/api/workflows/$AW/run" '{}'
[ "$(jqb .status)" = "failed" ] || fail "API run with no input: $BODY"
api 422 POST "/api/workflows/$AW/run" "{\"input\":\"$(head -c 300000 /dev/zero | tr '\0' x)\"}"
api 404 POST /api/workflows/999999/run '{}'
api 200 DELETE "/api/workflow-edges/$AE"
api 200 DELETE "/api/workflow-nodes/$AO"
[ "$(jqb '.edges | length')" = "1" ] || fail "API node delete echoes {node, edges}: $BODY"
ok "API: run (200 with the record), runs, run show, log, an oversized input 422, unknown 404, edge/node delete"

# A failing run is a 200 with status failed.
api 201 POST /api/workflows '{"name":"Api failing"}'
FW=$(jqb .id)
api 201 POST "/api/workflows/$FW/nodes" '{"kind":"trigger","title":"Go"}'
FT2=$(jqb .id)
api 201 POST "/api/workflows/$FW/nodes" '{"kind":"cli","title":"Fail","config":{"command":"exit 7"}}'
FC2=$(jqb .id)
api 201 POST "/api/workflows/$FW/edges" "{\"from_node\":$FT2,\"to_node\":$FC2}"
api 200 POST "/api/workflows/$FW/run" '{}'
[ "$(jqb .status)" = "failed" ] || fail "API failed run is 200 failed: $BODY"
api 200 DELETE "/api/workflows/$FW"
[ "$(jqb '.nodes | length')" = "2" ] || fail "API delete echoes the view"
ok "API: a failed run is 200 with status failed"

# ---- the gate: require_agent_access on every route, reads included ----
raw() { # raw <method> <path> [extra curl args...]
  local method=$1 path=$2; shift 2
  STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$method" "$@" "http://127.0.0.1:$PORT$path")
  BODY=$(cat "$TMP/body")
}
JSON=(-H 'Content-Type: application/json' -d '{}')
EVIL=(-H "Host: 127.0.0.1:$PORT" -H 'Origin: https://evil.example')
for route in "GET /api/workflows" "GET /api/workflows/$AW" "GET /api/workflows/$AW/runs" \
  "GET /api/workflow-runs/$AR" "GET /api/workflow-log"; do
  set -- $route
  raw "$1" "$2" "${EVIL[@]}"
  [ "$STATUS" = "403" ] || fail "default: $route with a foreign Origin must be 403, got $STATUS"
done
for route in "POST /api/workflows" "PATCH /api/workflows/$AW" "DELETE /api/workflows/$AW" \
  "POST /api/workflows/$AW/nodes" "PATCH /api/workflow-nodes/$AC" "DELETE /api/workflow-nodes/$AC" \
  "POST /api/workflows/$AW/edges" "DELETE /api/workflow-edges/1" "POST /api/workflows/$AW/run"; do
  set -- $route
  raw "$1" "$2" "${EVIL[@]}" "${JSON[@]}"
  [ "$STATUS" = "403" ] || fail "default: $route with a foreign Origin must be 403, got $STATUS"
done
raw GET /api/workflows -H "Host: evil.example:$PORT"
[ "$STATUS" = "403" ] || fail "default: a foreign Host must be 403, got $STATUS"
raw GET /api/workflows -H "Host: 127.0.0.1:$PORT"
[ "$STATUS" = "200" ] || fail "default: a local Host is served, got $STATUS"
raw POST "/api/workflows/$AW/run" -H "Host: 127.0.0.1:$PORT" -H 'Content-Type: text/plain' -d '{}'
[ "$STATUS" = "415" ] || [ "$STATUS" = "422" ] || [ "$STATUS" = "403" ] || fail "the Content-Type gate must still fire on run, got $STATUS"
ok "default mode: every workflow route (reads included) refuses a foreign Origin and Host; the Content-Type gate still fires"
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=

# ================= serve --watch-workflows =================

run 0 "$NARU" workflow create Ticker
run 0 "$NARU" workflow node create Ticker trigger Clock --config '{"mode":"time","every_minutes":1}'
TT=$(jqs .id)
run 0 "$NARU" workflow node create Ticker cli Tick --config '{"command":"echo tick"}'
TC=$(jqs .id)
"$NARU" workflow edge create Ticker "$TT" "$TC" >/dev/null
run 0 "$NARU" workflow create Manual
run 0 "$NARU" workflow node create Manual trigger Hand
MESA_WATCH_WORKFLOWS_TICK_MS=200 "$NARU" serve --port "$PORT" --watch-workflows >"$TMP/serve2.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
for _ in $(seq 1 50); do
  run 0 "$NARU" workflow runs Ticker
  [ "$(jqs length)" -ge 1 ] && break
  sleep 0.2
done
[ "$(jqs length)" = "1" ] || fail "the watcher must run a due time workflow (log: $(cat "$TMP/serve2.log"))"
[ "$(jqs '.[0].trigger')" = "time" ] || fail "the watcher's run is trigger=time"
sleep 1.5   # seven more ticks, still inside the one-minute interval
run 0 "$NARU" workflow runs Ticker
[ "$(jqs length)" = "1" ] || fail "a workflow already run inside its interval is not due again: $STDOUT"
run 0 "$NARU" workflow runs Manual
[ "$(jqs length)" = "0" ] || fail "a manual-trigger workflow is never run by the watcher"
run 0 "$NARU" workflow run-show "$(jq -r '.[0].id' < <("$NARU" workflow runs Ticker))"
[ "$(jqs '.steps[1].output')" = "tick" ] || fail "the watcher's run executed its nodes: $STDOUT"
ok "serve --watch-workflows: a due time workflow runs once per interval (trigger=time); a manual one never"
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=

echo "workflow-check: $CHECKS checks passed"
