#!/usr/bin/env bash
# Workflow gate (mesa task 1607): `naru workflow` over the CLI and
# `/api/workflows` over a throwaway `serve`, against a throwaway MESA_DB.
# Replaces the retired diagram gate.
#
# Pinned here: CRUD with the CLI's positional-or-flag create shapes and the
# `--quiet` key sets; the graph rules (cycle, self-edge, duplicate, branch
# edges, one trigger, same-workflow endpoints) with their error codes; a decide
# node (mesa task 1655) over a pinned rules file: a confident choice activating
# only its option's edge, low confidence / no match / backend off taking the
# fallback edge (or skipping everything downstream with none), a rules-file
# error absorbed by a fallback edge or failing the node without one; a run
# over a cli -> branch -> output(log) graph taking the TRUE path with the
# false one skipped, and the reverse; a failing cli node failing the run
# while the command still exits 0 (the status is data) and the rest skipped;
# a prompt node on an Anthropic model through a stub `claude` (MESA_CLAUDE_BIN)
# that speaks `-p --output-format json` and prints the result object: the argv
# it received (model, the thinking form, no tools, `-p`, never `--bg`), the
# answer arriving as the node output (read off `result`), a failing exit, an
# `is_error` result, unparseable output and a hang each failing the node, and
# no API key anywhere; a `local:<name>` prompt node through a stub Ollama HTTP server
# behind OLLAMA_HOST; the script node's `{input}` value
# arriving byte-identical for hostile text (never shell-parsed); the task and
# inbox outputs; the ambient-capture example from docs/workflows.md with stub
# `sox`/`auris`; the API routes, including `require_agent_access` refusing a
# foreign Origin and Host; the ambient trigger, `workflow emit` and
# `POST /api/workflows/events`; `workflow defaults --project` (mesa task 1644:
# both ambient workflows, a rerun skipping them, the task output's `status:
# backlog`, the review filing exactly one backlog task or none on an empty log);
# and `serve --watch-workflows` running a due
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
# Pin the user config away from the real one.
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

# ---- stubs: claude (print mode), an Ollama HTTP server, sox, auris ----
STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
# A stub `claude`: `-p` records its argv byte-exactly (one file per element) and
# prints the `--output-format json` result object. Switches: `fail` (exit 1 with
# a message on stderr), `is-error` (a result with is_error true), `garbage`
# (stdout that is not JSON), `hang` (never exits). Any `--bg` is recorded in
# `bg.calls`.
cat > "$STUB_DIR/claude" <<EOS
#!/usr/bin/env bash
D="$STUB_DIR"
for a in "\$@"; do [ "\$a" = "--bg" ] && echo "\$*" >> "\$D/bg.calls"; done
[ "\$1" = "-p" ] || { echo "stub claude: unexpected: \$*" >&2; exit 1; }
rm -f "\$D"/argv.*
i=0; for a in "\$@"; do printf '%s' "\$a" > "\$D/argv.\$i"; i=\$((i + 1)); done
echo "\$i" > "\$D/argc"
[ -e "\$D/fail" ] && { echo "stub claude is down" >&2; exit 1; }
[ -e "\$D/hang" ] && exec sleep 300
[ -e "\$D/garbage" ] && { echo "this is not json"; exit 0; }
[ -e "\$D/is-error" ] && { jq -nc '{type:"result",subtype:"success",is_error:true,result:"stub rate limit"}'; exit 0; }
jq -nc '{type:"result",subtype:"success",is_error:false,result:"  idea: buy milk  "}'
EOS
chmod +x "$STUB_DIR/claude"
export MESA_CLAUDE_BIN="$STUB_DIR/claude"
reset_claude() { rm -f "$STUB_DIR/bg.calls" "$STUB_DIR"/argv.* "$STUB_DIR/argc" "$STUB_DIR"/fail "$STUB_DIR"/hang "$STUB_DIR"/garbage "$STUB_DIR"/is-error; }
argv() { cat "$STUB_DIR/argv.$1"; }

# The Ollama stub (POST /api/chat): records the last request byte-exactly.
MODEL_PORT=17797
cat > "$STUB_DIR/model-server.py" <<'EOPY'
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
d = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        open(d + "/last.path", "w").write(self.path)
        open(d + "/last.headers", "w").write("".join(f"{k.lower()}: {v}\n" for k, v in self.headers.items()))
        open(d + "/last.body", "wb").write(body)
        if os.path.exists(d + "/http-fail"):
            out, code = json.dumps({"error": "stub model is down"}).encode(), 500
        elif self.path == "/api/chat":
            out, code = json.dumps({"message": {"content": "  local: hi  "}}).encode(), 200
        else:
            out, code = b"{}", 404
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)
HTTPServer(("127.0.0.1", int(sys.argv[2])), H).serve_forever()
EOPY
python3 "$STUB_DIR/model-server.py" "$STUB_DIR" "$MODEL_PORT" >"$TMP/model-server.log" 2>&1 &
MODEL_PID=$!
trap 'rm -rf "$TMP"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; kill "$MODEL_PID" 2>/dev/null; true' EXIT
export OLLAMA_HOST="127.0.0.1:$MODEL_PORT"   # no scheme, as Ollama itself reads it
last() { cat "$STUB_DIR/last.$1"; }

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
[ "$(jq -c '.workflow | keys' <<<"$STDOUT")" = '["created_at","id","last_failure_at","last_run_at","last_run_status","name","next_run_at","project_id","trigger","trigger_events","trigger_phrase","updated_at"]' ] ||
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
run 1 "$NARU" workflow edge create "$W" "$C" "$Q" --branch maybe
[ "$(jqe .error.code)" = "validation" ] || fail "--branch maybe on a non-branch node: validation"
run 1 "$NARU" workflow edge create "$W" "$B" "$Q" --branch maybe
[ "$(jqe .error.code)" = "validation" ] || fail "--branch maybe on a branch node: validation"
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

# ================= a live run: a running step while a node runs =================

run 0 "$NARU" workflow create "Live"
run 0 "$NARU" workflow node create Live trigger Start
LT=$(jqs .id)
run 0 "$NARU" workflow node create Live cli Slow --config '{"command":"sleep 3; echo done"}'
LS=$(jqs .id)
run 0 "$NARU" workflow node create Live output After --config '{"target":"log","log":"live"}'
LA=$(jqs .id)
"$NARU" workflow edge create Live "$LT" "$LS" >/dev/null
"$NARU" workflow edge create Live "$LS" "$LA" >/dev/null
"$NARU" workflow run Live >"$TMP/live-run.json" &
LIVE_PID=$!
SEEN=""
for _ in $(seq 1 40); do
  RID=$("$NARU" workflow runs Live | jq -r '[.[] | select(.status == "running")][0].id // empty')
  if [ -n "$RID" ]; then
    SHOWN=$("$NARU" workflow run-show "$RID")
    if [ "$(jq -r '[.steps[] | select(.status == "running")] | map(.title) | join(",")' <<<"$SHOWN")" = "Slow" ]; then
      SEEN=$SHOWN
      break
    fi
  fi
  sleep 0.2
done
[ -n "$SEEN" ] || fail "no run-show with a running step for the slow node while it ran"
[ "$(jq -r '.status' <<<"$SEEN")" = "running" ] || fail "the run is running while its node is: $SEEN"
[ "$(jq -r '.steps | map(.status) | join(",")' <<<"$SEEN")" = "ok,running" ] || fail "steps so far: $SEEN"
wait "$LIVE_PID"
[ "$(jq -r .status "$TMP/live-run.json")" = "succeeded" ] || fail "live run finishes: $(cat "$TMP/live-run.json")"
[ "$(jq -r '.steps | map(.status) | join(",")' "$TMP/live-run.json")" = "ok,ok,ok" ] || fail "final steps unchanged"
run 0 "$NARU" workflow run-show "$RID"
[ "$(jqs '.steps | map(.status) | join(",")')" = "ok,ok,ok" ] || fail "the stored run is final: $STDOUT"
ok "a running run shows a running step for the node in flight, then the final steps"

# ================= prompt node: a background agent through the stub claude =================

run 0 "$NARU" workflow create "Prompting"
run 0 "$NARU" workflow node create Prompting trigger Start
PT=$(jqs .id)
run 0 "$NARU" workflow node create Prompting prompt Label \
  --config '{"model":"haiku","prompt":"Tag this as idea/todo/note."}'
PP=$(jqs .id)
[ "$(jqs .config.thinking)" = "false" ] || fail "thinking is off by default: $STDOUT"
run 0 "$NARU" workflow node create Prompting output Out --config '{"target":"log","log":"labels"}'
PO=$(jqs .id)
"$NARU" workflow edge create Prompting "$PT" "$PP" >/dev/null
"$NARU" workflow edge create Prompting "$PP" "$PO" >/dev/null
reset_claude
HOSTILE_P=$'buy $(touch /tmp/NARU_PWN) milk `x` "dq" \'sq\' \\ \n second line'
run 0 "$NARU" workflow run Prompting --input "$HOSTILE_P"
[ "$(jqs .status)" = "succeeded" ] || fail "prompt run: $STDOUT"
[ "$(jqs '.steps[1].output')" = "idea: buy milk" ] || fail "the agent's answer is the node output, trimmed: $STDOUT"
[ ! -e /tmp/NARU_PWN ] || { rm -f /tmp/NARU_PWN; fail "a hostile input was executed"; }
[ "$(cat "$STUB_DIR/argc")" = "14" ] || fail "claude argv count: $(cat "$STUB_DIR/argc")"
[ "$(argv 0)" = "-p" ] && [ "$(argv 1)" = "--model" ] && [ "$(argv 2)" = "haiku" ] &&
  [ "$(argv 3)" = "--name" ] && [ "$(argv 4)" = "workflow Prompting · Label" ] &&
  [ "$(argv 5)" = "--tools" ] && [ "$(wc -c < "$STUB_DIR/argv.6" | tr -d ' ')" = "0" ] &&
  [ "$(argv 7)" = "--strict-mcp-config" ] &&
  [ "$(argv 8)" = "--output-format" ] && [ "$(argv 9)" = "json" ] &&
  [ "$(argv 10)" = "--settings" ] && [ "$(argv 11)" = '{"alwaysThinkingEnabled":false}' ] &&
  [ "$(argv 12)" = "--" ] || fail "claude argv: $(for i in 0 1 2 3 4 5 6 7 8 9 10 11 12; do echo "[$(argv $i)]"; done)"
EXPECTED_PROMPT="Tag this as idea/todo/note.

$HOSTILE_P"
[ "$(argv 13)" = "$EXPECTED_PROMPT" ] || fail "the prompt is the node's text, a blank line, then the input, byte-identical: $(argv 13)"
[ ! -e "$STUB_DIR/bg.calls" ] || fail "a background agent was spawned (--bg): $(cat "$STUB_DIR/bg.calls")"
ok "prompt node (haiku): one claude -p --model haiku --name 'workflow <wf> · <node>' --tools \"\" --strict-mcp-config --output-format json --settings {alwaysThinkingEnabled:false} -- <prompt>\\n\\n<input> (byte-identical, no --bg), the answer read off the result JSON and trimmed"

reset_claude
run 0 "$NARU" workflow node update "$PP" --config '{"model":"opus","thinking":true,"prompt":"P"}'
run 0 "$NARU" workflow run Prompting
[ "$(argv 2)" = "opus" ] && [ "$(argv 11)" = '{"alwaysThinkingEnabled":true}' ] || fail "opus / thinking on argv"
[ "$(argv 13)" = "P" ] || fail "an empty input adds no blank line: [$(argv 13)]"
run 0 "$NARU" workflow node update "$PP" --config '{"model":"sonnet","prompt":"P"}'
run 0 "$NARU" workflow run Prompting
[ "$(argv 2)" = "sonnet" ] || fail "sonnet alias"
ok "prompt node: opus with thinking on passes alwaysThinkingEnabled:true; sonnet maps through; an empty input adds nothing to the prompt"

# failures: each one fails the node with a message naming it
reset_claude
touch "$STUB_DIR/fail"
run 0 "$NARU" workflow run Prompting --input x
[ "$(jqs .status)" = "failed" ] && grep -q "stub claude is down" <<<"$(jqs '.steps[1].error')" || fail "a failing exit fails the node with stderr: $STDOUT"
reset_claude
touch "$STUB_DIR/is-error"
run 0 "$NARU" workflow run Prompting --input x
[ "$(jqs .status)" = "failed" ] && grep -q "stub rate limit" <<<"$(jqs '.steps[1].error')" || fail "an is_error result fails the node: $STDOUT"
reset_claude
touch "$STUB_DIR/garbage"
run 0 "$NARU" workflow run Prompting --input x
[ "$(jqs .status)" = "failed" ] && grep -q "no result JSON" <<<"$(jqs '.steps[1].error')" || fail "unparseable output fails the node: $STDOUT"
reset_claude
touch "$STUB_DIR/hang"
run 0 "$NARU" workflow node update "$PP" --config '{"model":"haiku","prompt":"P","timeout_secs":2}'
START=$(date +%s)
run 0 "$NARU" workflow run Prompting --input x
[ $(($(date +%s) - START)) -lt 20 ] || fail "the timeout must bound the wait"
[ "$(jqs .status)" = "failed" ] && grep -q "timed out" <<<"$(jqs '.steps[1].error')" || fail "a timeout fails the node: $STDOUT"
reset_claude
ok "a failing exit, an is_error result, unparseable output and a timeout each fail the node"

# ---- local:<name>: the Ollama HTTP API, no claude at all ----
reset_claude
run 0 "$NARU" workflow node update "$PP" --config '{"model":"local:llama3.2:3b","thinking":true,"prompt":"P"}'
run 0 "$NARU" workflow run Prompting --input "in"
[ "$(jqs .status)" = "succeeded" ] && [ "$(jqs '.steps[1].output')" = "local: hi" ] || fail "local run: $STDOUT"
[ "$(last path)" = "/api/chat" ] || fail "Ollama path: $(last path)"
[ "$(jq -r .model "$STUB_DIR/last.body")" = "llama3.2:3b" ] && [ "$(jq .stream "$STUB_DIR/last.body")" = "false" ] &&
  [ "$(jq .think "$STUB_DIR/last.body")" = "true" ] || fail "Ollama body: $(last body)"
[ "$(jq -r '.messages[0].content' "$STUB_DIR/last.body")" = $'P\n\nin' ] || fail "Ollama prompt"
[ "$(jq '.messages | length' "$STUB_DIR/last.body")" = "1" ] && [ "$(jq 'has("tools")' "$STUB_DIR/last.body")" = "false" ] || fail "one user message, no tools"
[ ! -e "$STUB_DIR/argc" ] || fail "a local model must not start claude"
OLLAMA_HOST="http://127.0.0.1:$MODEL_PORT/" run 0 "$NARU" workflow run Prompting --input "in"
[ "$(jqs .status)" = "succeeded" ] || fail "OLLAMA_HOST with a scheme: $STDOUT"
touch "$STUB_DIR/http-fail"
run 0 "$NARU" workflow run Prompting --input x
[ "$(jqs .status)" = "failed" ] && grep -q "stub model is down" <<<"$(jqs '.steps[1].error')" || fail "Ollama's own message is surfaced: $STDOUT"
rm -f "$STUB_DIR/http-fail"
OLLAMA_HOST="127.0.0.1:1" run 0 "$NARU" workflow run Prompting --input x
[ "$(jqs .status)" = "failed" ] && grep -q "Ollama" <<<"$(jqs '.steps[1].error')" || fail "Ollama down is a clear failure: $STDOUT"
ok "local:<name>: POST /api/chat on OLLAMA_HOST (with or without a scheme), stream false, think mirrors thinking, one user message, no tools, no claude; failures are clear node failures"

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

run 0 "$NARU" script create sleeper 'sleep 30'
run 0 "$NARU" workflow node update "$SS" --config '{"script":"sleeper","timeout_secs":1}'
START=$(date +%s)
run 0 "$NARU" workflow run Scripting --input x
[ $(($(date +%s) - START)) -lt 15 ] || fail "a script node must be killed at its timeout_secs"
grep -q "timed out" <<<"$(jqs '.steps[1].error')" || fail "script timeout error: $STDOUT"
run 1 "$NARU" workflow node update "$SS" --config '{"script":"x","timeout_secs":0}'
[ "$(jqe .error.code)" = "validation" ] || fail "script timeout_secs 0: validation"
ok "script node: past its timeout_secs the script's process group is killed and the node fails"

run 1 "$NARU" workflow node create Scripting prompt Dash --config '{"model":"local:-h","prompt":"x"}'
[ "$(jqe .error.code)" = "validation" ] || fail "a local model starting with '-': validation"
run 1 "$NARU" workflow log --limit 0
[ "$(jqe .error.code)" = "validation" ] || fail "log --limit 0: validation, got $STDERR"
run 1 "$NARU" workflow log --limit 5000
[ "$(jqe .error.code)" = "validation" ] || fail "log --limit 5000: validation"
ok "local: model names starting with '-' and an out-of-range log --limit are validation"

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
[ "$(jqs '.steps | map(select(.title == "File task")) | .[0].output')" = "nothing to deliver" ] || fail "an empty input files nothing and says so: $STDOUT"
run 0 "$NARU" task list "$P"
[ "$(jqs 'length')" = "2" ] || fail "an empty input created no task: $STDOUT"
ok "an output node given no text delivers nothing (output \"nothing to deliver\", no record) rather than failing the run"

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
  --config '{"model":"haiku","prompt":"Tag the following as idea, todo or note, then repeat it on one line."}'
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

# ================= decide node: a local judgement picks one edge =================

# Deterministic rules, beside the pinned config (the implicit rules-file
# location), so the built-in ruleset and the real home play no part.
cat > "$TMP/decide-rules.json" <<'RULES'
{"rules": [
  {"id": "ship", "choice": "ship", "confidence": 0.9,
   "all": [{"field": "input", "pattern": "green"}]},
  {"id": "hold-weak", "choice": "hold", "confidence": 0.3,
   "all": [{"field": "input", "pattern": "flaky"}]}
]}
RULES
run 0 "$NARU" workflow create judge
JW=$(jqs .id)
run 0 "$NARU" workflow node create judge trigger Start
JT=$(jqs .id)
run 0 "$NARU" workflow node create judge decide Pick --config '{"question":"Ship {input}?","options":["ship","hold"]}'
JD=$(jqs .id)
[ "$(jqs .config.threshold)" = "0.5" ] || fail "decide default threshold 0.5: $STDOUT"
run 0 "$NARU" workflow node create judge output Shipped --config '{"target":"log","log":"shipped"}'
JS=$(jqs .id)
run 0 "$NARU" workflow node create judge output Held --config '{"target":"log","log":"held"}'
JH=$(jqs .id)
run 0 "$NARU" workflow node create judge output Fell --config '{"target":"log","log":"fell"}'
JF=$(jqs .id)
run 0 "$NARU" workflow edge create judge "$JT" "$JD"
run 0 "$NARU" workflow edge create judge "$JD" "$JS" --branch ship
[ "$(jqs .branch)" = "ship" ] || fail "decide edge carries its option: $STDOUT"
run 0 "$NARU" workflow edge create judge "$JD" "$JH" --branch hold
run 1 "$NARU" workflow node update "$JD" --config '{"question":"Ship {input}?","options":["ship","wait"]}'
[ "$(jqe .error.code)" = "validation" ] || fail "dropping an option an edge uses: validation"
grep -q 'on .*hold' <<<"$STDERR" || fail "the refusal names the label: $STDERR"
run 0 "$NARU" workflow show judge
[ "$(jqs '.nodes[] | select(.id == '"$JD"') | .config.options | join(",")')" = "ship,hold" ] || fail "the refused update changed the config: $STDOUT"
ok "decide: node created with the default threshold, edges labelled with the option text"

run 1 "$NARU" workflow node create judge decide Bad --config '{"question":"q","options":["only"]}'
[ "$(jqe .error.code)" = "validation" ] || fail "decide with one option: validation"
run 1 "$NARU" workflow node create judge decide Bad --config '{"question":"q","options":["a","fallback"]}'
[ "$(jqe .error.code)" = "validation" ] || fail "an option named fallback: validation"
run 1 "$NARU" workflow node create judge decide Bad --config '{"question":"q","options":["a","b"],"threshold":1.5}'
[ "$(jqe .error.code)" = "validation" ] || fail "threshold 1.5: validation"
run 1 "$NARU" workflow node create judge decide Bad --config '{"question":"q","options":["a","b"],"oops":1}'
grep -q "unknown key" <<<"$STDERR" || fail "unknown decide key: $STDERR"
run 1 "$NARU" workflow edge create judge "$JD" "$JF"
[ "$(jqe .error.code)" = "validation" ] || fail "a decide edge with no --branch: validation"
run 1 "$NARU" workflow edge create judge "$JD" "$JF" --branch maybe
[ "$(jqe .error.code)" = "validation" ] || fail "a decide edge off its options: validation"
run 1 "$NARU" workflow edge create judge "$JD" "$JF" --branch true
[ "$(jqe .error.code)" = "validation" ] || fail "a decide edge labelled true: validation"
run 1 "$NARU" workflow edge create judge "$JD" "$JS" --branch ship
[ "$(jqe .error.code)" = "conflict" ] || fail "a duplicate decide edge: conflict"
ok "decide: bad options/threshold/keys and mislabelled edges are validation, a duplicate is conflict"

# Confident choice: only the chosen option's edge is active.
run 0 "$NARU" workflow run judge --input "tests are green"
[ "$(jqs .status)" = "succeeded" ] || fail "decide run: $STDOUT"
[ "$(jqs '.steps | map(.title + "=" + .status) | join(",")')" = "Start=ok,Pick=ok,Shipped=ok,Held=skipped,Fell=skipped" ] ||
  fail "decide chosen path: $(jqs '.steps | map(.title + "=" + .status) | join(",")')"
[ "$(jqs '.steps[1].output | fromjson | .choice')" = "ship" ] || fail "decide output carries the choice: $STDOUT"
[ "$(jqs '.steps[1].output | fromjson | .confidence')" = "0.9" ] || fail "decide output carries the confidence"
[ "$(jqs '.steps[1].output | fromjson | .fallback')" = "false" ] || fail "decide output: fallback false"
run 0 "$NARU" workflow log shipped
[ "$(jqs length)" = "1" ] || fail "the chosen edge ran its output: $STDOUT"
ok "decide: a confident choice activates only its option's edge; the output carries choice/confidence/fallback"

# Below the threshold, with no fallback edge: not a failure, downstream skipped.
run 0 "$NARU" workflow run judge --input "flaky build"
[ "$(jqs .status)" = "succeeded" ] || fail "low confidence is not a failure: $STDOUT"
[ "$(jqs '.steps | map(.status) | join(",")')" = "ok,ok,skipped,skipped,skipped" ] ||
  fail "no fallback edge: everything downstream skipped: $STDOUT"
[ "$(jqs '.steps[1].output | fromjson | .fallback')" = "true" ] || fail "decide output: fallback true"
[ "$(jqs '.steps[1].output | fromjson | .choice')" = "hold" ] || fail "decide output still names the weak choice"
run 0 "$NARU" workflow run judge --input "no idea"
[ "$(jqs '.steps | map(.status) | join(",")')" = "ok,ok,skipped,skipped,skipped" ] || fail "null choice: skipped: $STDOUT"
[ "$(jqs '.steps[1].output | fromjson | .choice')" = "null" ] || fail "null choice in the output"
ok "decide: low confidence or no match with no fallback edge skips everything downstream (run still succeeds)"

# A fallback edge takes both the low-confidence and the no-match cases.
run 0 "$NARU" workflow edge create judge "$JD" "$JF" --branch fallback
run 0 "$NARU" workflow run judge --input "flaky build"
[ "$(jqs '.steps | map(.title + "=" + .status) | join(",")')" = "Start=ok,Pick=ok,Shipped=skipped,Held=skipped,Fell=ok" ] ||
  fail "fallback path: $(jqs '.steps | map(.title + "=" + .status) | join(",")')"
run 0 "$NARU" workflow run judge --input "no idea"
[ "$(jqs '.steps[4].status')" = "ok" ] || fail "null choice takes the fallback: $STDOUT"
# A lowered threshold lets the weak choice through.
run 0 "$NARU" workflow node update "$JD" --config '{"question":"Ship {input}?","options":["ship","hold"],"threshold":0.3}'
run 0 "$NARU" workflow run judge --input "flaky build"
[ "$(jqs '.steps | map(.title + "=" + .status) | join(",")')" = "Start=ok,Pick=ok,Shipped=skipped,Held=ok,Fell=skipped" ] ||
  fail "threshold 0.3 lets hold through: $(jqs '.steps | map(.title + "=" + .status) | join(",")')"
ok "decide: the fallback edge takes low confidence and no match; a lower threshold activates the option"

# Backend off: no decision, so the fallback edge.
echo '{"decide": {"backend": "off"}}' > "$MESA_CONFIG_FILE"
run 0 "$NARU" workflow run judge --input "tests are green"
[ "$(jqs '.steps[4].status')" = "ok" ] && [ "$(jqs '.steps[2].status')" = "skipped" ] || fail "backend off takes the fallback: $STDOUT"
[ "$(jqs '.steps[1].output | fromjson | .backend')" = "off" ] || fail "decide output names the off backend"
# A broken rules file: the fallback edge absorbs the error ...
echo '{"decide": {"backend": "rules"}}' > "$MESA_CONFIG_FILE"
echo 'not json' > "$TMP/decide-rules.json"
run 0 "$NARU" workflow run judge --input "tests are green"
[ "$(jqs .status)" = "succeeded" ] && [ "$(jqs '.steps[4].status')" = "ok" ] || fail "a decide error with a fallback edge: $STDOUT"
[ "$(jqs '.steps[1].output | fromjson | .error | length > 0')" = "true" ] || fail "the error rides in the output"
# ... and without one the node fails like any failing node.
run 0 "$NARU" workflow edge delete "$(jq -r --argjson d "$JD" --argjson f "$JF" '.edges[] | select(.from_node == $d and .to_node == $f) | .id' < <("$NARU" workflow show judge))"
run 0 "$NARU" workflow run judge --input "tests are green"
[ "$(jqs .status)" = "failed" ] && [ "$(jqs '.steps[1].status')" = "failed" ] || fail "a decide error with no fallback fails the node: $STDOUT"
rm -f "$MESA_CONFIG_FILE" "$TMP/decide-rules.json"
ok "decide: backend off takes the fallback; a rules-file error takes it too, or fails the node when there is none"

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

# ================= ambient trigger and `workflow emit` =================

run 0 "$NARU" workflow create AmbIdea
run 1 "$NARU" workflow node create AmbIdea trigger T --config '{"mode":"ambient"}'
[ "$(jqe .error.code)" = "validation" ] || fail "ambient without events: validation"
run 1 "$NARU" workflow node create AmbIdea trigger T --config '{"mode":"ambient","events":[]}'
run 1 "$NARU" workflow node create AmbIdea trigger T --config '{"mode":"ambient","events":["nope"]}'
run 1 "$NARU" workflow node create AmbIdea trigger T --config '{"mode":"ambient","events":["idea","idea"]}'
run 1 "$NARU" workflow node create AmbIdea trigger T --config '{"mode":"ambient","events":["idea"],"every_minutes":5}'
run 1 "$NARU" workflow node create AmbIdea trigger T --config '{"mode":"manual","events":["idea"]}'
[ "$(jqe .error.code)" = "validation" ] || fail "events on a manual trigger: validation"
ok "ambient trigger config: events required, non-empty, known, distinct; every_minutes and events on other modes refused"

run 0 "$NARU" workflow node create AmbIdea trigger T --config '{"mode":"ambient","events":["idea","wake"]}'
AMB_T1=$(jqs .id)
run 0 "$NARU" workflow node create AmbIdea cli Echo --config '{"command":"cat"}'
AMB_C1=$(jqs .id)
"$NARU" workflow edge create AmbIdea "$AMB_T1" "$AMB_C1" >/dev/null
run 0 "$NARU" workflow create AmbHelp
run 0 "$NARU" workflow node create AmbHelp trigger T --config '{"mode":"ambient","events":["can-help"]}'
AMB_T2=$(jqs .id)
run 0 "$NARU" workflow node create AmbHelp cli Echo --config '{"command":"cat"}'
AMB_C2=$(jqs .id)
"$NARU" workflow edge create AmbHelp "$AMB_T2" "$AMB_C2" >/dev/null
run 0 "$NARU" workflow list
[ "$(jq -r '[.[] | select(.name == "AmbIdea")][0] | "\(.trigger) \(.trigger_events | join(","))"' <<<"$STDOUT")" = "ambient idea,wake" ] ||
  fail "the list row reports trigger ambient and its events: $STDOUT"

printf %s "from a file" > "$TMP/wake.txt"
HOSTILE_AMB=$'$(touch '"$TMP"$'/PWNED3) `x` \'q\' "d" \\n end'
run 0 "$NARU" workflow emit idea --speaker "sp'k" --text "$HOSTILE_AMB"
[ "$(jqs length)" = "1" ] && [ "$(jqs '.[0].trigger')" = "ambient" ] && [ "$(jqs '.[0].status')" = "succeeded" ] ||
  fail "emit idea runs exactly the one matching workflow as ambient: $STDOUT"
EXPECT=$(jq -cn --arg s "sp'k" --arg t "$HOSTILE_AMB" '{event:"idea",speaker:$s,text:$t}')
[ "$(jqs '.[0].input')" = "$EXPECT" ] || fail "run input is the compact event JSON: $(jqs '.[0].input')"
[ "$(jqs '.[0].steps[1].output')" = "$EXPECT" ] || fail "the event JSON reaches the cli node byte-identical"
[ ! -e "$TMP/PWNED3" ] || fail "hostile text was shell-parsed"
run 0 "$NARU" workflow emit can-help --speaker room
[ "$(jqs length)" = "1" ] && [ "$(jqs '.[0].input')" = '{"event":"can-help","speaker":"room","text":""}' ] || fail "emit can-help: $STDOUT"
run 0 "$NARU" workflow emit wake --speaker room --text-file "$TMP/wake.txt" --quiet
[ "$(jqs length)" = "1" ] || fail "wake matches only the workflow listing it: $STDOUT"
ok "workflow emit: only matching ambient workflows run (trigger=ambient), the event JSON reaches a cli node byte-identical, --quiet is accepted"

run 0 "$NARU" workflow node update "$AMB_T2" --config '{"mode":"ambient","events":["wake"]}'
run 0 "$NARU" workflow emit wake --speaker room
[ "$(jqs length)" = "2" ] && [ "$(jqs '.[0].workflow_id < .[1].workflow_id')" = "true" ] || fail "two matches run in id order: $STDOUT"
run 0 "$NARU" workflow node update "$AMB_T2" --config '{"mode":"manual"}'
run 0 "$NARU" workflow emit can-help --speaker room
[ "$STDOUT" = "[]" ] || fail "no match prints [] and exits 0, got: $STDOUT"
run 1 "$NARU" workflow emit nope --speaker room
[ "$(jqe .error.code)" = "validation" ] || fail "unknown event: validation"
run 1 "$NARU" workflow emit idea --speaker ""
[ "$(jqe .error.code)" = "validation" ] || fail "empty speaker: validation"
run 1 "$NARU" workflow emit idea --speaker "$(head -c 65 /dev/zero | tr '\0' s)"
[ "$(jqe .error.code)" = "validation" ] || fail "65-char speaker: validation"
run 2 "$NARU" workflow emit idea
run 2 "$NARU" workflow emit idea --speaker s --text a --text-file "$TMP/wake.txt"
ok "workflow emit: [] when nothing matches, id order, validation exit 1, usage exit 2"

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
api 422 GET "/api/workflow-log?limit=0"
api 422 GET "/api/workflow-log?limit=5000"
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
# No input: the trigger hands on "", the log node has nothing to deliver and
# says so — the run succeeds.
api 200 POST "/api/workflows/$AW/run" '{}'
[ "$(jqb .status)" = "succeeded" ] && [ "$(jqb '.steps[2].output')" = "nothing to deliver" ] || fail "API run with no input: $BODY"
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

# ---- ambient events over HTTP: 202 after validating, runs in the background ----
BEFORE=$("$NARU" workflow runs AmbIdea | jq length)
api 202 POST /api/workflows/events '{"event":"idea","speaker":"api","text":"hello $(id)"}'
[ "$(jqb '.workflow_ids | length')" = "1" ] || fail "events route answers the matched ids: $BODY"
for _ in $(seq 1 50); do
  [ "$("$NARU" workflow runs AmbIdea | jq length)" -gt "$BEFORE" ] && break
  sleep 0.1
done
run 0 "$NARU" workflow runs AmbIdea
[ "$(jqs '.[0].trigger')" = "ambient" ] || fail "the background run is trigger=ambient: $STDOUT"
run 0 "$NARU" workflow run-show "$(jqs '.[0].id')"
[ "$(jqs '.input')" = '{"event":"idea","speaker":"api","text":"hello $(id)"}' ] || fail "API event input: $STDOUT"
api 202 POST /api/workflows/events '{"event":"can-help","speaker":"api"}'
[ "$(jqb '.workflow_ids | length')" = "0" ] || fail "no match answers 202 with an empty list: $BODY"
api 422 POST /api/workflows/events '{"event":"nope","speaker":"api","text":""}'
api 422 POST /api/workflows/events '{"event":"idea","speaker":"","text":""}'
api 422 POST /api/workflows/events '{"event":"idea","text":""}'
ok "API: POST /api/workflows/events is 202 with the matched ids and runs in the background (trigger=ambient); bad input is 422"

# ---- default ambient workflows (mesa task 1644): `workflow defaults`, status backlog ----
run 0 "$NARU" project create "Defaulted" --no-git
DP=$(jqs .id)
run 0 "$NARU" workflow defaults --project Defaulted
[ "$(jqs '.created | map(.workflow.name) | sort | join("|")')" = "Ambient: end-of-day review|Ambient: label ideas" ] || fail "defaults created both: $STDOUT"
[ "$(jqs '.skipped | length')" = "0" ] || fail "nothing skipped on the first call: $STDOUT"
[ "$(jqs '.created | map(.workflow.project_id) | unique | join(",")')" = "$DP" ] || fail "both scoped to the project: $STDOUT"
run 0 "$NARU" workflow defaults --project "$DP"
[ "$(jqs '.created | length')" = "0" ] && [ "$(jqs '.skipped | length')" = "2" ] || fail "a rerun skips both: $STDOUT"
run 0 "$NARU" workflow list "$DP"
[ "$(jqs 'length')" = "2" ] || fail "a rerun created nothing: $STDOUT"
run 1 "$NARU" workflow defaults --project nosuchproject
[ "$(jqe .error.code)" = "not_found" ] || fail "defaults: unknown project is not_found"
ok "workflow defaults --project: creates both ambient workflows scoped to the project; a rerun skips both (idempotent)"

# A task output's status: backlog files a backlog task; todo/absent a todo one; done is refused.
run 0 "$NARU" workflow create Backlogging
run 0 "$NARU" workflow node create Backlogging trigger Go --config '{"mode":"manual"}'
BT=$(jqs .id)
run 0 "$NARU" workflow node create Backlogging output File --config "{\"target\":\"task\",\"project\":$DP,\"status\":\"backlog\"}"
"$NARU" workflow edge create Backlogging "$BT" "$(jqs .id)" >/dev/null
run 0 "$NARU" workflow run Backlogging --input "an idea for the backlog"
[ "$(jqs .status)" = "succeeded" ] || fail "backlog run: $STDOUT"
run 0 "$NARU" task list "$DP"
[ "$(jqs '[.[] | select(.name == "an idea for the backlog" and .status == "backlog")] | length')" = "1" ] || fail "the task output filed a backlog task: $STDOUT"
run 1 "$NARU" workflow node create Backlogging output Bad --config "{\"target\":\"task\",\"project\":$DP,\"status\":\"done\"}"
[ "$(jqe .error.code)" = "validation" ] || fail "status done refused"
ok "output task status: backlog files a backlog task; done is a validation error"

# The review: seeded 'ambient' log -> haiku digest (stub claude) -> exactly one backlog task.
reset_claude
BEFORE_N=$("$NARU" task list "$DP" | jq length)
PATH="$(dirname "$NARU"):$STUB_DIR:$PATH" run 0 "$NARU" workflow run "Ambient: end-of-day review"
[ "$(jqs .status)" = "succeeded" ] || fail "review run: $STDOUT"
[ "$(jqs '.steps | map(.status) | join(",")')" = "ok,ok,ok,ok,ok" ] || fail "every review step ran: $STDOUT"
grep -q "idea: buy milk" <<<"$(jqs ".steps[1].output")" || fail "the cli node printed the ambient log lines: $STDOUT"
grep -q "idea: buy milk" <<<"$(argv 13)" || fail "the digest prompt carried the day's lines"
run 0 "$NARU" task list "$DP"
[ "$(jqs 'length')" = "$((BEFORE_N + 1))" ] || fail "exactly one task filed: $STDOUT"
[ "$(jqs '[.[] | select(.name == "idea: buy milk" and .status == "backlog")] | length')" = "1" ] || fail "the digest landed in backlog: $STDOUT"
ok "end-of-day review: ambient log lines -> haiku digest -> exactly one backlog task"

# Nothing logged: the branch is false, the prompt never runs, nothing is filed.
reset_claude
RV=$("$NARU" workflow show "Ambient: end-of-day review" | jq -r '.nodes[] | select(.kind == "cli") | .id')
run 0 "$NARU" workflow node update "$RV" --config '{"command":"naru workflow log ambient-empty --limit 500 | jq -r \".[].text\""}'
BEFORE_N=$("$NARU" task list "$DP" | jq length)
PATH="$(dirname "$NARU"):$STUB_DIR:$PATH" run 0 "$NARU" workflow run "Ambient: end-of-day review"
[ "$(jqs .status)" = "succeeded" ] || fail "empty review run: $STDOUT"
[ ! -e "$STUB_DIR/argc" ] || fail "the prompt node ran on an empty log"
run 0 "$NARU" task list "$DP"
[ "$(jqs 'length')" = "$BEFORE_N" ] || fail "an empty log filed nothing: $STDOUT"
ok "end-of-day review with an empty log: the prompt node is skipped and no task is filed"

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
  "POST /api/workflows/$AW/edges" "DELETE /api/workflow-edges/1" "POST /api/workflows/$AW/run" \
  "POST /api/workflows/events"; do
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

[ ! -e "$STUB_DIR/bg.calls" ] || fail "a workflow spawned a background agent (--bg): $(cat "$STUB_DIR/bg.calls")"
ok "no --bg agent was spawned anywhere in this gate"

echo "workflow-check: $CHECKS checks passed"
