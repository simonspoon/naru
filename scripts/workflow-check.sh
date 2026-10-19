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
# the `enabled` switch (a disabled ambient workflow skipped by `emit`, still
# run by hand) and `workflow duplicate` (CLI + API: remapped nodes/edges, a
# disabled copy, naming and conflict); and `serve --watch-workflows` running a due
# time-triggered workflow exactly once per interval; and the gate node (naru
# task 1993): a run waiting on a pending gate with a stub-`vox` phone
# notification, approved over the API and rejected over the CLI (each taking
# only its own edge, the run still succeeding), a timeout rejecting with the
# reason, and a second decision refused.
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
# Staged replies for the agent-node checks: reply.<n> answers the n-th call
# since reset_claude, else reply, else the canned line.
n=\$(( \$(cat "\$D/calls" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "\$D/calls"
for f in "\$D/reply.\$n" "\$D/reply"; do
  [ -e "\$f" ] && { jq -nc --rawfile r "\$f" '{type:"result",subtype:"success",is_error:false,result:\$r}'; exit 0; }
done
jq -nc '{type:"result",subtype:"success",is_error:false,result:"  idea: buy milk  "}'
EOS
chmod +x "$STUB_DIR/claude"
export MESA_CLAUDE_BIN="$STUB_DIR/claude"
reset_claude() { rm -f "$STUB_DIR/bg.calls" "$STUB_DIR"/argv.* "$STUB_DIR/argc" "$STUB_DIR"/fail "$STUB_DIR"/hang "$STUB_DIR"/garbage "$STUB_DIR"/is-error "$STUB_DIR/calls" "$STUB_DIR"/reply "$STUB_DIR"/reply.*; }
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
[ "$(jq -c '.workflow | keys' <<<"$STDOUT")" = '["builtin","created_at","enabled","id","last_failure_at","last_run_at","last_run_status","name","next_run_at","project_id","trigger","trigger_events","trigger_phrase","types","updated_at"]' ] ||
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
run 0 "$NARU" workflow log yes --workflow "$W"
[ "$(jqs length)" = "1" ] || fail "log --workflow keeps this workflow's line: $STDOUT"
run 1 "$NARU" workflow log yes --workflow no-such-workflow
[ "$(jqe .error.code)" = "not_found" ] || fail "log --workflow unknown: not_found"
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

# ---- parse-json (naru task 1985) ----
run 0 "$NARU" workflow create PJ
run 0 "$NARU" workflow node create PJ trigger PT
PJT=$(jqs .id)
run 0 "$NARU" workflow node create PJ parse-json PP --config '{"type":"number"}'
PJP=$(jqs .id)
[ "$(jqs '.config.pins.out[0].ty')" = "number" ] || fail "parse-json out pin takes the configured type: $STDOUT"
[ "$(jqs '.config.pins.in[0].ty')" = "string" ] || fail "parse-json in pin is a string: $STDOUT"
run 0 "$NARU" workflow edge create PJ "$PJT" "$PJP"
run 0 "$NARU" workflow run PJ --input ' 42 '
[ "$(jqs .status)" = "succeeded" ] || fail "parse-json valid run: $STDOUT"
[ "$(jqs '.steps[] | select(.title=="PP") | .output')" = "42" ] || fail "parse-json outputs the typed value: $STDOUT"
run 0 "$NARU" workflow run PJ --input 'not json'
[ "$(jqs .status)" = "failed" ] || fail "parse-json invalid JSON fails the run: $STDOUT"
case "$(jqs '.steps[] | select(.title=="PP") | .error')" in "invalid JSON"*) ;; *) fail "parse-json failure reason: $STDOUT" ;; esac
run 0 "$NARU" workflow run PJ --input '"x"'
[ "$(jqs .status)" = "failed" ] || fail "parse-json type mismatch fails the run: $STDOUT"
case "$(jqs '.steps[] | select(.title=="PP") | .error')" in *"expected number"*) ;; *) fail "parse-json mismatch reason: $STDOUT" ;; esac
run 1 "$NARU" workflow node create PJ parse-json Bad --config '{"type":"bad type"}'
[ "$(jqe .error.code)" = "validation" ] || fail "parse-json with a malformed type: validation"
ok "parse-json: typed output pin, valid JSON, invalid JSON and a type mismatch fail with a reason, bad type is validation"

# ---- variable (naru task 1986) ----
run 0 "$NARU" workflow create VR
run 0 "$NARU" workflow node create VR trigger VT
VRT=$(jqs .id)
run 0 "$NARU" workflow node create VR variable VS --config '{"op":"set","name":"x","type":"number"}'
VRS=$(jqs .id)
[ "$(jqs '.config.pins.in[0].ty + "," + .config.pins.out[0].ty')" = "number,number" ] || fail "variable set pins are typed: $STDOUT"
run 0 "$NARU" workflow node create VR variable VG --config '{"op":"get","name":"x","type":"number"}'
VRG=$(jqs .id)
[ "$(jqs '.config.pins.in[0].name + "," + .config.pins.out[0].ty')" = "trigger,number" ] || fail "variable get pins: $STDOUT"
run 0 "$NARU" workflow edge create VR "$VRT" "$VRS"
run 0 "$NARU" workflow edge create VR "$VRS" "$VRG"
run 0 "$NARU" workflow run VR --input ' 7 '
[ "$(jqs .status)" = "succeeded" ] || fail "variable set then get run: $STDOUT"
[ "$(jqs '.steps[] | select(.title=="VG") | .output')" = "7" ] || fail "get returns the value set: $STDOUT"
run 0 "$NARU" workflow run VR --input '"s"'
[ "$(jqs .status)" = "failed" ] || fail "variable set type mismatch fails the run: $STDOUT"
case "$(jqs '.steps[] | select(.title=="VS") | .error')" in *"expected number"*) ;; *) fail "variable mismatch reason: $STDOUT" ;; esac
run 0 "$NARU" workflow create VU
run 0 "$NARU" workflow node create VU trigger UT
UT=$(jqs .id)
run 0 "$NARU" workflow node create VU variable UG --config '{"op":"get","name":"never"}'
UG=$(jqs .id)
run 0 "$NARU" workflow edge create VU "$UT" "$UG"
run 0 "$NARU" workflow run VU --input go
[ "$(jqs .status)" = "failed" ] || fail "get before set fails the run: $STDOUT"
case "$(jqs '.steps[] | select(.title=="UG") | .error')" in *"is not set"*) ;; *) fail "get before set reason: $STDOUT" ;; esac
run 1 "$NARU" workflow node create VU variable Bad --config '{"op":"put","name":"x"}'
[ "$(jqe .error.code)" = "validation" ] || fail "variable with a bad op: validation"
run 1 "$NARU" workflow node create VU variable Bad --config '{"op":"get"}'
[ "$(jqe .error.code)" = "validation" ] || fail "variable without a name: validation"
ok "variable: typed pins, set then get round trip, type mismatch and get-before-set fail with a reason, bad op/name is validation"

# ---- mapfilter (naru task 1987) ----
run 0 "$NARU" workflow create MF
run 0 "$NARU" workflow node create MF trigger MT
MFT=$(jqs .id)
run 0 "$NARU" workflow node create MF mapfilter MM --config '{"mode":"map","expr":"Task: {item}"}'
MFM=$(jqs .id)
run 0 "$NARU" workflow node create MF mapfilter MX --config '{"mode":"filter","expr":"not-contains:b"}'
MFX=$(jqs .id)
run 0 "$NARU" workflow edge create MF "$MFT" "$MFM"
run 0 "$NARU" workflow edge create MF "$MFM" "$MFX"
run 0 "$NARU" workflow run MF --input '["a","b","ca"]'
[ "$(jqs .status)" = "succeeded" ] || fail "mapfilter run: $STDOUT"
[ "$(jqs '.steps[] | select(.title=="MM") | .output')" = '["Task: a","Task: b","Task: ca"]' ] || fail "mapfilter map output: $STDOUT"
[ "$(jqs '.steps[] | select(.title=="MX") | .output')" = '["Task: a","Task: ca"]' ] || fail "mapfilter filter output: $STDOUT"
run 0 "$NARU" workflow run MF --input '{"a":1}'
[ "$(jqs .status)" = "failed" ] || fail "mapfilter on a non-list fails the run: $STDOUT"
case "$(jqs '.steps[] | select(.title=="MM") | .error')" in *"must be a list"*) ;; *) fail "mapfilter non-list reason: $STDOUT" ;; esac
run 1 "$NARU" workflow node create MF mapfilter Bad --config '{"mode":"filter","expr":"regex:("}'
[ "$(jqe .error.code)" = "validation" ] || fail "mapfilter bad regex: validation"
run 1 "$NARU" workflow node create MF mapfilter Bad --config '{"mode":"filter","expr":"wat:x"}'
[ "$(jqe .error.code)" = "validation" ] || fail "mapfilter bad predicate: validation"
ok "mapfilter: map then filter produce the expected list, a non-list input fails with a reason, a bad regex/predicate is validation"

# ---- foreach (naru task 1988) ----
run 0 "$NARU" workflow create FE
run 0 "$NARU" workflow node create FE trigger FT
FET=$(jqs .id)
run 0 "$NARU" workflow node create FE foreach FL --config '{"body":"echo item-$1"}'
FEL=$(jqs .id)
[ "$(jqs '.config.pins.out[0].name + "," + .config.pins.out[0].ty')" = "results,list<string>" ] || fail "foreach pins: $STDOUT"
run 0 "$NARU" workflow edge create FE "$FET" "$FEL"
run 0 "$NARU" workflow run FE --input '[1,2,3]'
[ "$(jqs .status)" = "succeeded" ] || fail "foreach run: $STDOUT"
[ "$(jqs '.steps[] | select(.title=="FL") | .output')" = '["item-1","item-2","item-3"]' ] || fail "foreach results: $STDOUT"
run 0 "$NARU" workflow run FE --input '["$(echo pwned)"]'
[ "$(jqs '.steps[] | select(.title=="FL") | .output')" = '["item-$(echo pwned)"]' ] || fail "foreach hostile item literal: $STDOUT"
run 0 "$NARU" workflow node create FE foreach FX --config '{"body":"[ \"$1\" = 2 ] && exit 3; echo ok"}'
FEX=$(jqs .id)
run 0 "$NARU" workflow edge create FE "$FET" "$FEX"
run 0 "$NARU" workflow run FE --input '[1,2,3]'
[ "$(jqs .status)" = "failed" ] || fail "foreach failing item fails the run: $STDOUT"
case "$(jqs '.steps[] | select(.title=="FX") | .error')" in *"item 1 exited 3"*) ;; *) fail "foreach failing item reason: $STDOUT" ;; esac
run 0 "$NARU" workflow run FE --input '{"a":1}'
case "$(jqs '.steps[] | select(.title=="FL") | .error')" in *"must be a list"*) ;; *) fail "foreach non-list reason: $STDOUT" ;; esac
run 1 "$NARU" workflow node create FE foreach Bad --config '{}'
[ "$(jqe .error.code)" = "validation" ] || fail "foreach without a body: validation"
ok "foreach: results collected in order, a hostile item stays literal, a failing item and a non-list input fail with a reason, a missing body is validation"

# A workflow with no trigger, and one with two (a second created by hand is
# refused at the store, so only the no-trigger case is reachable).
run 0 "$NARU" workflow create "No trigger"
run 1 "$NARU" workflow run "No trigger"
[ "$(jqe .error.code)" = "validation" ] || fail "a run needs a trigger: validation"
run 1 "$NARU" workflow run nosuchflow
[ "$(jqe .error.code)" = "not_found" ] || fail "run unknown: not_found"
ok "a run needs exactly one trigger: validation; an unknown workflow is not_found"

# ---- parallel / join (naru task 1989) ----
run 0 "$NARU" workflow create FanJoin
run 0 "$NARU" workflow node create FanJoin trigger PT
PJT=$(jqs .id)
run 0 "$NARU" workflow node create FanJoin parallel Fan
PJP=$(jqs .id)
run 0 "$NARU" workflow node create FanJoin cli PA --config '{"command":"printf a"}'
PJA=$(jqs .id)
run 0 "$NARU" workflow node create FanJoin cli PB --config '{"command":"printf b"}'
PJB=$(jqs .id)
run 0 "$NARU" workflow node create FanJoin join Gather
PJJ=$(jqs .id)
run 1 "$NARU" workflow node create FanJoin join Bad --config '{"x":1}'
[ "$(jqe .error.code)" = "validation" ] || fail "join takes no config: validation"
for e in "$PJT $PJP" "$PJP $PJA" "$PJP $PJB" "$PJA $PJJ" "$PJB $PJJ"; do
  set -- $e
  run 0 "$NARU" workflow edge create FanJoin "$1" "$2"
done
run 0 "$NARU" workflow run FanJoin
[ "$(jqs .status)" = "succeeded" ] || fail "parallel/join run: $STDOUT"
[ "$(jqs '.steps[] | select(.title=="Gather") | .output')" = '["a","b"]' ] || fail "join output is the ordered array: $STDOUT"
# a branch that never reaches the join leaves it skipped, the run still succeeding
run 0 "$NARU" workflow node create FanJoin branch PG --config '{"op":"contains","value":"zzz"}'
PJG=$(jqs .id)
run 0 "$NARU" workflow node create FanJoin cli PC --config '{"command":"printf c"}'
PJC=$(jqs .id)
run 0 "$NARU" workflow edge create FanJoin "$PJP" "$PJG"
run 0 "$NARU" workflow edge create FanJoin "$PJG" "$PJC" --branch true
run 0 "$NARU" workflow edge create FanJoin "$PJC" "$PJJ"
run 0 "$NARU" workflow run FanJoin
[ "$(jqs .status)" = "succeeded" ] || fail "join with an inactive branch: run succeeds: $STDOUT"
[ "$(jqs '.steps[] | select(.title=="Gather") | .status')" = "skipped" ] || fail "join waits for every branch: $STDOUT"
ok "parallel/join: both branches gathered in order; an inactive branch skips the join; join config is validated"

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
run 0 "$NARU" workflow watch "$RID"
[ "$(jqs '.status')" = "running" ] && [ "$(jqs '.running_step.title')" = "Slow" ] && [ "$(jqs '.running_step.kind')" = "cli" ] \
  && [ "$(jqs '.running_step.elapsed_secs >= 0')" = "true" ] && [ "$(jqs '.steps_done')" = "1" ] && [ "$(jqs '.steps_total')" = "3" ] \
  && [ "$(jqs '.stage')" = "null" ] && [ "$(jqs '.stalled')" = "false" ] || fail "watch mid-run: $STDOUT"
wait "$LIVE_PID"
[ "$(jq -r .status "$TMP/live-run.json")" = "succeeded" ] || fail "live run finishes: $(cat "$TMP/live-run.json")"
[ "$(jq -r '.steps | map(.status) | join(",")' "$TMP/live-run.json")" = "ok,ok,ok" ] || fail "final steps unchanged"
run 0 "$NARU" workflow run-show "$RID"
[ "$(jqs '.steps | map(.status) | join(",")')" = "ok,ok,ok" ] || fail "the stored run is final: $STDOUT"
ok "a running run shows a running step for the node in flight, then the final steps"
run 0 "$NARU" workflow watch "$RID" --follow --quiet
[ "$(jqs '.status')" = "succeeded" ] && [ "$(jqs '.running_step')" = "null" ] && [ "$(jqs '.steps_done')" = "3" ] \
  && [ "$(jqs '.last_step.title')" = "After" ] || fail "watch after the run: $STDOUT"
run 1 "$NARU" workflow watch 99999
ok "workflow watch: a running snapshot mid-run, a final one after (--follow exits at once), unknown run not_found"

# ================= --detach: a run that outlives its invoker (naru task 1958) =================

run 0 "$NARU" workflow create Detach
run 0 "$NARU" workflow node create Detach trigger Start
DT=$(jqs .id)
run 0 "$NARU" workflow node create Detach cli Slow --config '{"command":"sleep 3; echo done"}'
DS=$(jqs .id)
"$NARU" workflow edge create Detach "$DT" "$DS" >/dev/null
T0=$(date +%s)
run 0 "$NARU" workflow run Detach --detach
T1=$(date +%s)
DRID=$(jqs .run_id)
[ "$(jqs 'keys | join(",")')" = "run_id,status" ] || fail "detach prints run_id and status: $STDOUT"
[ "$((T1 - T0))" -lt 3 ] || fail "--detach returned only after the 3s node ($((T1 - T0))s)"
run 0 "$NARU" workflow run-show "$DRID"
[ "$(jqs .status)" = "running" ] || fail "a detached run reads running at once: $STDOUT"
ok "--detach returns before the 3s cli node finishes, with {run_id, status: running}"
DOWNER=$(/usr/bin/sqlite3 "$MESA_DB" "SELECT owner_pid FROM workflow_runs WHERE id = $DRID")
[ -n "$DOWNER" ] && [ "$DOWNER" != "$$" ] || fail "owner_pid is the job, not the invoker: $DOWNER"
ps -p "$DOWNER" -o command= | grep -q "__job workflow-run" || fail "owner_pid $DOWNER is not a workflow-run job"
for _ in $(seq 1 60); do
  run 0 "$NARU" workflow run-show "$DRID"
  [ "$(jqs .status)" != "running" ] && break
  sleep 0.2
done
[ "$(jqs .status)" = "succeeded" ] || fail "the detached run finishes: $STDOUT"
[ "$(jqs '.steps | map(.status) | join(",")')" = "ok,ok" ] || fail "detached run steps: $STDOUT"
ok "a detached run reads running, then succeeded, owned by its __job process"

# Killing the invoking CLI mid-run does not fail the run: the job owns it.
"$NARU" workflow run Detach --detach >"$TMP/detach2.json" &
INV=$!
kill -9 "$INV" 2>/dev/null || true
wait "$INV" 2>/dev/null || true
for _ in $(seq 1 25); do
  [ -s "$TMP/detach2.json" ] && break
  sleep 0.1
done
if [ -s "$TMP/detach2.json" ]; then
  D2=$(jq -r .run_id "$TMP/detach2.json")
else
  D2=$(/usr/bin/sqlite3 "$MESA_DB" "SELECT max(id) FROM workflow_runs")
fi
for _ in $(seq 1 60); do
  run 0 "$NARU" workflow run-show "$D2"
  [ "$(jqs .status)" != "running" ] && break
  sleep 0.2
done
[ "$(jqs .status)" = "succeeded" ] || fail "killing the invoker must not fail the run: $STDOUT"
ok "killing the invoking CLI mid-run leaves the detached run to finish succeeded"

# Killing the job itself leaves an orphan, which serve's start-up reconcile fails.
run 0 "$NARU" workflow run Detach --detach
D3=$(jqs .run_id)
D3PID=$(/usr/bin/sqlite3 "$MESA_DB" "SELECT owner_pid FROM workflow_runs WHERE id = $D3")
kill -9 "$D3PID"
sleep 0.3
run 0 "$NARU" workflow run-show "$D3"
[ "$(jqs .status)" = "running" ] || fail "a killed job leaves the row running until reconcile: $STDOUT"
RPORT=17794
"$NARU" serve --port "$RPORT" >"$TMP/serve-reconcile.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$RPORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
run 0 "$NARU" workflow run-show "$D3"
[ "$(jqs .status)" = "failed" ] || fail "a dead detached owner is reconciled to failed: $STDOUT"
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=
ok "a killed detached job is reconciled to failed by serve's start-up"

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
# ---- typed pins (naru task 1981) -----------------------------------------
run 0 "$NARU" workflow create Typed
run 0 "$NARU" workflow type add Typed Review --field score:number --field ok:bool --field tags:list\<string\>
[ "$(jqs '.types[0].fields | length')" = "3" ] || fail "type add stores the fields: $STDOUT"
run 1 "$NARU" workflow type add Typed Bad --field x:Nope
[ "$(jqe .error.code)" = "validation" ] || fail "an unknown field type is validation: $STDERR"
run 0 "$NARU" workflow node create Typed trigger Start
TY_T=$(jqs .id)
JSON_TEXT='{"score":4,"ok":true,"tags":["x","y"]}'
SRC_CFG=$(jq -nc --arg c "printf '%s' '$JSON_TEXT'" '{command:$c, pins:{out:[{name:"result",ty:"Review"}]}}')
run 0 "$NARU" workflow node create Typed cli Src --config "$SRC_CFG"
TY_SRC=$(jqs .id)
run 0 "$NARU" workflow node create Typed break "Break Review" --config '{"struct":"Review"}'
TY_BRK=$(jqs .id)
run 0 "$NARU" workflow node create Typed make "Make Review" --config '{"struct":"Review"}'
TY_MK=$(jqs .id)
run 0 "$NARU" workflow node create Typed cli Sink --config '{"command":"cat","pins":{"in":[{"name":"input","ty":"Review"}]}}'
TY_SINK=$(jqs .id)
run 0 "$NARU" workflow node create Typed cli Num --config '{"command":"true","pins":{"in":[{"name":"input","ty":"number"}]}}'
TY_NUM=$(jqs .id)
run 0 "$NARU" workflow edge create Typed "$TY_T" "$TY_SRC"
run 0 "$NARU" workflow edge create Typed "$TY_SRC" "$TY_BRK"
for f in tags score ok; do
  run 0 "$NARU" workflow edge create Typed "$TY_BRK" "$TY_MK" --from-pin "$f" --to-pin "$f"
done
run 0 "$NARU" workflow edge create Typed "$TY_MK" "$TY_SINK"
# A Review output into a number input is refused, naming both types.
run 1 "$NARU" workflow edge create Typed "$TY_SRC" "$TY_NUM"
[ "$(jqe .error.code)" = "validation" ] || fail "a mismatched wire is validation: $STDERR"
case "$(jqe .error.message)" in *Review*number*) ;; *) fail "the refusal names both types: $STDERR" ;; esac
# A bool field into a number input is refused too; a number field is accepted.
run 1 "$NARU" workflow edge create Typed "$TY_BRK" "$TY_NUM" --from-pin ok
[ "$(jqe .error.code)" = "validation" ] || fail "bool -> number is validation: $STDERR"
run 0 "$NARU" workflow edge create Typed "$TY_BRK" "$TY_NUM" --from-pin score
# A pin the node does not have is validation.
run 1 "$NARU" workflow edge create Typed "$TY_BRK" "$TY_SINK" --from-pin nope
[ "$(jqe .error.code)" = "validation" ] || fail "an unknown pin is validation: $STDERR"
# A type a node still uses cannot be removed.
run 1 "$NARU" workflow type remove Typed Review
[ "$(jqe .error.code)" = "conflict" ] || fail "removing a type in use is conflict: $STDERR"
# The struct passes through break and make as byte-identical JSON.
run 0 "$NARU" workflow run Typed --input go
[ "$(jqs .status)" = "succeeded" ] || fail "the typed run succeeds: $STDOUT"
[ "$(jq -r --arg id "$TY_BRK" '.steps[] | select(.node_id == ($id|tonumber)) | .output' <<<"$STDOUT")" = "$JSON_TEXT" ] ||
  fail "break passes the struct on: $STDOUT"
[ "$(jq -r --arg id "$TY_MK" '.steps[] | select(.node_id == ($id|tonumber)) | .output' <<<"$STDOUT")" = "$JSON_TEXT" ] ||
  fail "make rebuilds the struct byte-identical: $STDOUT"
[ "$(jq -r --arg id "$TY_NUM" '.steps[] | select(.node_id == ($id|tonumber)) | .output' <<<"$STDOUT")" != "x" ] || true
ok "typed pins: mismatched wires refused naming both types, a struct round-trips through break/make byte-identical, a type in use is conflict"
# An untyped workflow is unaffected: no types, pin-free edges.
run 0 "$NARU" workflow show Typed
[ "$(jqs '[.edges[] | select(.from_pin == null and .to_pin == null)] | length')" -ge 2 ] || fail "pin-free edges stay pin-free"
run 0 "$NARU" workflow create Untyped
[ "$(jqs '.types | length')" = "0" ] || fail "a new workflow has no types: $STDOUT"
ok "an untyped workflow reads with no types"

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

# ================= agent node (naru task 1982) =================
run 0 "$NARU" library create agent wf-reviewer --body=$'---\nname: wf-reviewer\nmodel: opus\n---\nYou review things.\n'
run 0 "$NARU" workflow create Agenting
run 0 "$NARU" workflow node create Agenting trigger Start
AT=$(jqs .id)
run 0 "$NARU" workflow node create Agenting agent Ask --config '{"agent":"wf-reviewer","prompt":"Review: {input}"}'
AA=$(jqs .id)
[ "$(jq -c '.config.pins.out' <<<"$STDOUT")" = '[{"name":"result","ty":"string"},{"name":"status","ty":"string"}]' ] || fail "agent pins: $STDOUT"
run 0 "$NARU" workflow node create Agenting output Out --config '{"target":"log","log":"agent"}'
AO=$(jqs .id)
"$NARU" workflow edge create Agenting "$AT" "$AA" >/dev/null
"$NARU" workflow edge create Agenting "$AA" "$AO" >/dev/null
reset_claude
run 0 "$NARU" workflow run Agenting --input 'a $(touch /tmp/NARU_PWN) b'
[ "$(jqs .status)" = "succeeded" ] || fail "agent run: $STDOUT"
[ "$(jqs '.steps[1].output')" = "idea: buy milk" ] || fail "agent text result: $STDOUT"
[ ! -e /tmp/NARU_PWN ] || { rm -f /tmp/NARU_PWN; fail "a hostile input was executed"; }
[ "$(argv 2)" = "opus" ] || fail "the agent definition's own model is used: $(argv 2)"
grep -q 'You review things.' <<<"$(argv 13)" && grep -qF 'Review: a $(touch /tmp/NARU_PWN) b' <<<"$(argv 13)" || fail "the prompt carries the definition and the task: $(argv 13)"
! grep -q 'name: wf-reviewer' <<<"$(argv 13)" || fail "frontmatter is not sent"
[ ! -e "$STUB_DIR/bg.calls" ] || fail "no --bg"
run 0 "$NARU" workflow node update "$AA" --config '{"agent":"wf-reviewer","prompt":"P","model":"haiku"}'
reset_claude
run 0 "$NARU" workflow run Agenting --input x
[ "$(argv 2)" = "haiku" ] || fail "a model override wins: $(argv 2)"
ok "agent node: plain text result, definition + task in one tool-less call, hostile input inert, model override"

run 1 "$NARU" workflow node create Agenting agent Bad --config '{"agent":"a","prompt":"p","model":"gpt"}'
run 1 "$NARU" workflow node create Agenting agent Bad --config '{"prompt":"p"}'
run 0 "$NARU" workflow node update "$AA" --config '{"agent":"no-such-agent","prompt":"P"}'
run 0 "$NARU" workflow run Agenting --input x
[ "$(jqs .status)" = "failed" ] && grep -q "unknown agent" <<<"$(jqs '.steps[1].error')" || fail "an unknown agent fails the node: $STDOUT"
reset_claude
touch "$STUB_DIR/hang"
run 0 "$NARU" workflow node update "$AA" --config '{"agent":"wf-reviewer","prompt":"P","timeout_secs":2}'
run 0 "$NARU" workflow run Agenting --input x
[ "$(jqs .status)" = "failed" ] && grep -q "timed out" <<<"$(jqs '.steps[1].error')" || fail "an agent timeout fails the node: $STDOUT"
reset_claude
ok "agent node: bad config is validation, an unknown agent and a timeout each fail the node"

# Typed result: a struct type, validated, retried once.
run 0 "$NARU" workflow type add Agenting Verdict --field score:number --field ok:bool
run 0 "$NARU" workflow node update "$AA" --config '{"agent":"wf-reviewer","prompt":"P","result_type":"Verdict"}'
[ "$(jqs '.config.pins.out[0].ty')" = "Verdict" ] || fail "the result pin carries the type: $STDOUT"
printf '```json\n{"ok": true, "score": 3, "extra": 1}\n```' > "$STUB_DIR/reply"
run 0 "$NARU" workflow run Agenting --input x
[ "$(jqs .status)" = "succeeded" ] || fail "typed run: $STDOUT"
[ "$(jqs '.steps[1].output')" = '{"score":3,"ok":true}' ] || fail "typed result is canonical JSON in field order: $STDOUT"
grep -q 'Verdict' <<<"$(argv 13)" || fail "the prompt names the type"
reset_claude
echo 'not json at all' > "$STUB_DIR/reply.1"
echo '{"score": 1, "ok": false}' > "$STUB_DIR/reply.2"
run 0 "$NARU" workflow run Agenting --input x
[ "$(jqs .status)" = "succeeded" ] && [ "$(cat "$STUB_DIR/calls")" = "2" ] || fail "an invalid first reply is retried once: $STDOUT"
reset_claude
echo '{"score": "high"}' > "$STUB_DIR/reply"
run 0 "$NARU" workflow run Agenting --input x
[ "$(jqs .status)" = "failed" ] && [ "$(cat "$STUB_DIR/calls")" = "2" ] && grep -q "not a valid Verdict" <<<"$(jqs '.steps[1].error')" || fail "two invalid replies fail the node with the reason: $STDOUT"
[ "$(jqs '.steps[2].status')" = "skipped" ] || fail "downstream is skipped: $STDOUT"
reset_claude
ok "agent node: a typed result is validated and canonical, retried once, then a visible failure"

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

# ================= switch node: a many-way branch on the input (naru task 1990) =================

run 0 "$NARU" workflow create sorter
run 0 "$NARU" workflow node create sorter trigger Start
WT=$(jqs .id)
run 0 "$NARU" workflow node create sorter switch Sort --config '{"op":"contains","cases":[{"match":"red","label":"r"},{"match":"blue"}]}'
WS=$(jqs .id)
[ "$(jqs .config.cases[1].label)" = "blue" ] || fail "a case label defaults to its match: $STDOUT"
run 0 "$NARU" workflow node create sorter output Red --config '{"target":"log","log":"sw-red"}'
WR=$(jqs .id)
run 0 "$NARU" workflow node create sorter output Blue --config '{"target":"log","log":"sw-blue"}'
WB=$(jqs .id)
run 0 "$NARU" workflow node create sorter output Other --config '{"target":"log","log":"sw-other"}'
WO=$(jqs .id)
run 0 "$NARU" workflow edge create sorter "$WT" "$WS"
run 0 "$NARU" workflow edge create sorter "$WS" "$WR" --branch r
[ "$(jqs .branch)" = "r" ] || fail "switch edge carries its case label: $STDOUT"
run 0 "$NARU" workflow edge create sorter "$WS" "$WB" --branch blue
run 0 "$NARU" workflow edge create sorter "$WS" "$WO" --branch default

# Bad configs and mislabelled edges.
run 1 "$NARU" workflow node create sorter switch Bad --config '{"cases":[{"match":"a"}]}'
[ "$(jqe .error.code)" = "validation" ] || fail "switch with one case: validation"
run 1 "$NARU" workflow node create sorter switch Bad --config '{"cases":[{"match":"a"},{"match":"b","label":"default"}]}'
[ "$(jqe .error.code)" = "validation" ] || fail "switch case labelled default: validation"
run 1 "$NARU" workflow node create sorter switch Bad --config '{"cases":[{"match":"a","label":"x"},{"match":"b","label":"x"}]}'
[ "$(jqe .error.code)" = "validation" ] || fail "switch duplicate label: validation"
run 1 "$NARU" workflow node create sorter switch Bad --config '{"op":"regex","cases":[{"match":"a"},{"match":"("}]}'
[ "$(jqe .error.code)" = "validation" ] || fail "switch bad regex: validation"
run 1 "$NARU" workflow node create sorter switch Bad --config '{"op":"score_above","cases":[{"match":"a"},{"match":"b"}]}'
[ "$(jqe .error.code)" = "validation" ] || fail "switch bad op: validation"
run 1 "$NARU" workflow edge create sorter "$WS" "$WR"
[ "$(jqe .error.code)" = "validation" ] || fail "a switch edge with no --branch: validation"
run 1 "$NARU" workflow edge create sorter "$WS" "$WR" --branch green
[ "$(jqe .error.code)" = "validation" ] || fail "a switch edge off its labels: validation"
run 1 "$NARU" workflow node update "$WS" --config '{"op":"contains","cases":[{"match":"red","label":"r"},{"match":"green"}]}'
[ "$(jqe .error.code)" = "validation" ] || fail "dropping a label an edge uses: validation"
ok "switch: bad config and mislabelled edges are validation; a refused update changes nothing"

# The first matching case's edge runs; the others are skipped.
run 0 "$NARU" workflow run sorter --input "a red thing"
[ "$(jqs .status)" = "succeeded" ] || fail "switch run: $STDOUT"
[ "$(jqs '.steps | map(.title + "=" + .status) | join(",")')" = "Start=ok,Sort=ok,Red=ok,Blue=skipped,Other=skipped" ] ||
  fail "switch matching path: $(jqs '.steps | map(.title + "=" + .status) | join(",")')"
[ "$(jqs '.steps[1].output | fromjson | .label')" = "r" ] || fail "switch output names the label: $STDOUT"
run 0 "$NARU" workflow run sorter --input "blue and red"
[ "$(jqs '.steps | map(.title + "=" + .status) | join(",")')" = "Start=ok,Sort=ok,Red=ok,Blue=skipped,Other=skipped" ] ||
  fail "switch first match wins: $(jqs '.steps | map(.title + "=" + .status) | join(",")')"
run 0 "$NARU" workflow run sorter --input "only blue"
[ "$(jqs '.steps | map(.title + "=" + .status) | join(",")')" = "Start=ok,Sort=ok,Red=skipped,Blue=ok,Other=skipped" ] ||
  fail "switch second case: $(jqs '.steps | map(.title + "=" + .status) | join(",")')"
ok "switch: the first matching case activates only its edge"

# No match takes the default edge.
run 0 "$NARU" workflow run sorter --input "green"
[ "$(jqs '.steps | map(.title + "=" + .status) | join(",")')" = "Start=ok,Sort=ok,Red=skipped,Blue=skipped,Other=ok" ] ||
  fail "switch default path: $(jqs '.steps | map(.title + "=" + .status) | join(",")')"
[ "$(jqs '.steps[1].output | fromjson | .matched')" = "false" ] || fail "switch output: matched false"
ok "switch: no match takes the default edge"

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

# ================= enabled switch and duplicate (naru task 1633) =================

run 0 "$NARU" workflow update AmbIdea --enabled false
[ "$(jqs .enabled)" = "false" ] || fail "update --enabled false: $STDOUT"
run 0 "$NARU" workflow emit idea --speaker room
[ "$STDOUT" = "[]" ] || fail "a disabled ambient workflow is not run by emit: $STDOUT"
run 0 "$NARU" workflow run AmbIdea --input hi
[ "$(jqs .status)" = "succeeded" ] || fail "a disabled workflow still runs by hand: $STDOUT"
run 0 "$NARU" workflow update AmbIdea --enabled true --quiet
[ "$(jqs .enabled)" = "true" ] || fail "--enabled true (quiet keeps the bounded flag): $STDOUT"
run 0 "$NARU" workflow emit idea --speaker room
[ "$(jqs length)" = "1" ] || fail "re-enabled, emit runs it again: $STDOUT"
run 2 "$NARU" workflow update AmbIdea --enabled maybe
ok "workflow update --enabled: a disabled ambient workflow is skipped by emit but still runs by hand"

run 0 "$NARU" workflow duplicate AmbIdea
[ "$(jqs .workflow.name)" = "AmbIdea (copy)" ] && [ "$(jqs .workflow.enabled)" = "false" ] ||
  fail "default name and disabled copy: $STDOUT"
DUP1=$(jqs .workflow.id)
[ "$(jqs '.nodes | length')" = "2" ] && [ "$(jqs '.edges | length')" = "1" ] || fail "copy has the nodes and edges: $STDOUT"
[ "$(jqs '.nodes[0].config.events | join(",")')" = "idea,wake" ] || fail "node config copied: $STDOUT"
[ "$(jqs '.edges[0].from_node == .nodes[0].id and .edges[0].to_node == .nodes[1].id')" = "true" ] ||
  fail "edges remapped onto the copy's own nodes: $STDOUT"
[ "$(jqs '.nodes[0].id != '"$AMB_T1")" = "true" ] || fail "copy has new node ids"
run 0 "$NARU" workflow runs "$DUP1"
[ "$(jqs length)" = "0" ] || fail "run history is not copied"
run 0 "$NARU" workflow emit idea --speaker room
[ "$(jqs length)" = "1" ] || fail "the disabled copy does not double-fire: $STDOUT"
run 0 "$NARU" workflow duplicate AmbIdea --quiet
[ "$(jqs .workflow.name)" = "AmbIdea (copy 2)" ] || fail "second default name: $STDOUT"
DUP2=$(jqs .workflow.id)
[ "$(jqs '.workflow | has("description")')" = "false" ] || fail "--quiet drops description"
run 0 "$NARU" workflow duplicate AmbIdea --name "Named Copy"
[ "$(jqs .workflow.name)" = "Named Copy" ] || fail "explicit name: $STDOUT"
DUP3=$(jqs .workflow.id)
run 1 "$NARU" workflow duplicate AmbIdea --name "named COPY"
[ "$(jqe .error.code)" = "conflict" ] || fail "a taken explicit name is conflict: $STDERR"
run 1 "$NARU" workflow duplicate nope-not-there
[ "$(jqe .error.code)" = "not_found" ] || fail "unknown workflow: not_found"
ok "workflow duplicate: nodes+edges remapped, disabled, no runs, (copy)/(copy 2) naming, explicit name, conflict on a taken one"
for d in "$DUP1" "$DUP2" "$DUP3"; do "$NARU" workflow delete "$d" >/dev/null; done

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
api 200 GET "/api/workflow-log?log=api&workflow=$AW&limit=5"
[ "$(jqb '.[0].text')" = "HELLO API" ] || fail "API log ?workflow=: $BODY"
api 200 GET "/api/workflow-log?log=api&workflow=999999"
[ "$(jqb length)" = "0" ] || fail "API log ?workflow= of another workflow: $BODY"
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

# ---- enabled + duplicate over HTTP (naru task 1633) ----
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"enabled":false}' "http://127.0.0.1:$PORT/api/workflows/$AW" >"$TMP/body"
[ "$(jq -r .enabled "$TMP/body")" = "false" ] || fail "PATCH enabled false: $(cat "$TMP/body")"
curl -s -X PATCH -H 'Content-Type: application/json' -d '{"enabled":true}' "http://127.0.0.1:$PORT/api/workflows/$AW" >"$TMP/body"
[ "$(jq -r .enabled "$TMP/body")" = "true" ] || fail "PATCH enabled true: $(cat "$TMP/body")"
STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/workflows/$AW/duplicate")
[ "$STATUS" = "201" ] || fail "duplicate answers 201, got $STATUS: $(cat "$TMP/body")"
[ "$(jq -r .workflow.enabled "$TMP/body")" = "false" ] && [ "$(jq '.nodes | length' "$TMP/body")" -ge 1 ] || fail "API copy: $(cat "$TMP/body")"
APIDUP=$(jq -r .workflow.id "$TMP/body")
STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"name\":\"$(jq -r .workflow.name "$TMP/body")\"}" "http://127.0.0.1:$PORT/api/workflows/$AW/duplicate")
[ "$STATUS" = "409" ] || fail "a taken name on duplicate is 409, got $STATUS"
STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"name":"ApiNamed"}' "http://127.0.0.1:$PORT/api/workflows/$AW/duplicate")
[ "$STATUS" = "201" ] && [ "$(jq -r .workflow.name "$TMP/body")" = "ApiNamed" ] || fail "named duplicate: $STATUS $(cat "$TMP/body")"
curl -s -X DELETE -H 'Content-Type: application/json' "http://127.0.0.1:$PORT/api/workflows/$APIDUP" >/dev/null
curl -s -X DELETE -H 'Content-Type: application/json' "http://127.0.0.1:$PORT/api/workflows/$(jq -r .workflow.id "$TMP/body")" >/dev/null
ok "API: PATCH enabled toggles, POST duplicate is 201 with a disabled copy, a taken name is 409"

# ---- the gate: require_agent_access on every route, reads included ----
raw() { # raw <method> <path> [extra curl args...]
  local method=$1 path=$2; shift 2
  STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$method" "$@" "http://127.0.0.1:$PORT$path")
  BODY=$(cat "$TMP/body")
}
JSON=(-H 'Content-Type: application/json' -d '{}')
EVIL=(-H "Host: 127.0.0.1:$PORT" -H 'Origin: https://evil.example')
for route in "GET /api/workflows" "GET /api/workflows/$AW" "GET /api/workflows/$AW/runs" "GET /api/workflows/$AW/export" \
  "GET /api/workflow-runs/$AR" "GET /api/workflow-runs/$AR/status" "GET /api/workflow-log"; do
  set -- $route
  raw "$1" "$2" "${EVIL[@]}"
  [ "$STATUS" = "403" ] || fail "default: $route with a foreign Origin must be 403, got $STATUS"
done
for route in "POST /api/workflows" "PATCH /api/workflows/$AW" "DELETE /api/workflows/$AW" \
  "POST /api/workflows/$AW/nodes" "PATCH /api/workflow-nodes/$AC" "DELETE /api/workflow-nodes/$AC" \
  "POST /api/workflows/$AW/edges" "DELETE /api/workflow-edges/1" "POST /api/workflows/$AW/run" \
  "POST /api/workflows/events" "POST /api/workflows/$AW/duplicate" "POST /api/workflows/import"; do
  set -- $route
  raw "$1" "$2" "${EVIL[@]}" "${JSON[@]}"
  [ "$STATUS" = "403" ] || fail "default: $route with a foreign Origin must be 403, got $STATUS"
done
raw GET /api/workflows -H "Host: evil.example:$PORT"
[ "$STATUS" = "403" ] || fail "default: a foreign Host must be 403, got $STATUS"
raw GET /api/workflows -H "Host: 127.0.0.1:$PORT"
[ "$STATUS" = "200" ] || fail "default: a local Host is served, got $STATUS"
raw GET "/api/workflow-runs/$AR/status" -H "Host: 127.0.0.1:$PORT"
[ "$STATUS" = "200" ] && [ "$(jq -r '.run_id' <<<"$BODY")" = "$AR" ] || fail "run status over http: $STATUS $BODY"
raw GET /api/workflow-runs/99999/status -H "Host: 127.0.0.1:$PORT"
[ "$STATUS" = "404" ] || fail "run status for an unknown run must be 404, got $STATUS"
raw GET "/api/workflow-runs/$AR/status" -H "Host: evil.example:$PORT"
[ "$STATUS" = "403" ] || fail "run status with a foreign Host must be 403, got $STATUS"
raw POST "/api/workflows/$AW/run" -H "Host: 127.0.0.1:$PORT" -H 'Content-Type: text/plain' -d '{}'
[ "$STATUS" = "415" ] || [ "$STATUS" = "422" ] || [ "$STATUS" = "403" ] || fail "the Content-Type gate must still fire on run, got $STATUS"
ok "default mode: every workflow route (reads included) refuses a foreign Origin and Host; the Content-Type gate still fires"
# ---- webhook node (naru task 2005): a POSTed body becomes the typed `body` pin ----
run 0 "$NARU" workflow create Hook
run 0 "$NARU" workflow node create Hook webhook Catch --config '{"type":"number"}'
HW=$(jqs .id)
[ "$(jqs .kind)" = "webhook" ] || fail "webhook node kind: $STDOUT"
[ "$(jqs '.config.pins.out[0].ty')" = "number" ] || fail "webhook declares a typed body pin: $STDOUT"
run 0 "$NARU" workflow node create Hook output Sink --config '{"target":"log","log":"hook"}'
HO=$(jqs .id)
"$NARU" workflow edge create Hook "$HW" "$HO" >/dev/null
run 1 "$NARU" workflow node create Hook trigger Second
run 1 "$NARU" workflow edge create Hook "$HO" "$HW"
run 1 "$NARU" workflow node create Hook webhook Again --config '{"type":"number"}'
run 0 "$NARU" workflow create HookBad
run 1 "$NARU" workflow node create HookBad webhook Bad --config '{"secret":"x"}'
HID=$("$NARU" workflow show Hook | jq -r .workflow.id)
STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '42' "http://127.0.0.1:$PORT/api/workflows/$HID/webhook")
[ "$STATUS" = "200" ] || fail "webhook POST must be 200, got $STATUS: $(cat "$TMP/body")"
[ "$(jq -r .status "$TMP/body")" = "succeeded" ] || fail "webhook run must succeed: $(cat "$TMP/body")"
[ "$(jq -r .trigger "$TMP/body")" = "webhook" ] || fail "webhook run is trigger=webhook"
[ "$(jq -r '.steps[0].output' "$TMP/body")" = "42" ] || fail "the body must be the webhook node's output: $(cat "$TMP/body")"
STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '"nope"' "http://127.0.0.1:$PORT/api/workflows/$HID/webhook")
[ "$STATUS" = "200" ] || fail "a wrong-typed body is a failed run (200), got $STATUS"
[ "$(jq -r .status "$TMP/body")" = "failed" ] || fail "a wrong-typed body must fail the run: $(cat "$TMP/body")"
[ "$(jq -r '.steps[0].status' "$TMP/body")" = "failed" ] || fail "the webhook node must be the failed step: $(cat "$TMP/body")"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' -d '42' "http://127.0.0.1:$PORT/api/workflows/$HID/webhook")
[ "$STATUS" = "415" ] || [ "$STATUS" = "422" ] || [ "$STATUS" = "400" ] || [ "$STATUS" = "403" ] || fail "a non-JSON Content-Type must be refused, got $STATUS"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'Host: evil.example' -d '42' "http://127.0.0.1:$PORT/api/workflows/$HID/webhook")
[ "$STATUS" = "403" ] || fail "a foreign Host must be 403 on the webhook route, got $STATUS"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '42' "http://127.0.0.1:$PORT/api/workflows/$AW/webhook")
[ "$STATUS" = "422" ] || fail "a workflow with no webhook node must be 422, got $STATUS"
ok "webhook node: body becomes the typed pin, wrong type fails the node, no-webhook workflow 422, Content-Type and Host gates hold"
# ---- task-event node (naru task 2006): a task create / status change starts a detached run ----
run 0 "$NARU" project create --no-git TEProj
TEP=$(jqs .id)
run 0 "$NARU" project create --no-git TEOther
TEO=$(jqs .id)
run 0 "$NARU" workflow create TEBoth
run 0 "$NARU" workflow node create TEBoth task-event Created --config '{"event":"any","project":"TEProj"}'
TEN=$(jqs .id)
[ "$(jqs '.config.pins.out[0].name')" = "task" ] || fail "task-event declares a task pin: $STDOUT"
run 0 "$NARU" workflow node create TEBoth output Sink --config '{"target":"log","log":"te-any"}'
"$NARU" workflow edge create TEBoth "$TEN" "$(jqs .id)" >/dev/null
run 0 "$NARU" workflow create TEDone
run 0 "$NARU" workflow node create TEDone task-event Done --config '{"event":"status","status":"done"}'
TED=$(jqs .id)
run 0 "$NARU" workflow node create TEDone output Sink --config '{"target":"log","log":"te-done"}'
"$NARU" workflow edge create TEDone "$TED" "$(jqs .id)" >/dev/null
run 1 "$NARU" workflow node create TEDone trigger Second
run 0 "$NARU" workflow create TEBad
run 1 "$NARU" workflow node create TEBad task-event Bad --config '{"event":"created","status":"done"}'
run 1 "$NARU" workflow node create TEBad task-event Bad --config '{"event":"sometimes"}'
run 1 "$NARU" workflow node create TEBad task-event Bad --config '{"x":1}'
te_runs() { "$NARU" workflow runs "$1" | jq 'length'; }
te_wait() { # te_wait <workflow> <count>: wait for that many finished runs
  for _ in $(seq 1 50); do
    [ "$("$NARU" workflow runs "$1" | jq '[.[] | select(.status != "running")] | length')" = "$2" ] && return 0
    sleep 0.2
  done
  fail "workflow $1 did not reach $2 finished runs: $("$NARU" workflow runs "$1")"
}
run 0 "$NARU" task create "$TEP" '"; rm -rf / #'
TET=$(jqs .id)
te_wait TEBoth 1
[ "$(te_runs TEDone)" = "0" ] || fail "a creation must not fire the done-status workflow"
RID=$("$NARU" workflow runs TEBoth | jq -r '.[0].id')
run 0 "$NARU" workflow run-show "$RID"
[ "$(jqs .trigger)" = "task-event" ] || fail "run trigger must be task-event: $STDOUT"
[ "$(jq -r '.steps[0].output | fromjson | .name' <<<"$STDOUT")" = '"; rm -rf / #' ] || fail "a hostile name must arrive byte-identical: $STDOUT"
run 0 "$NARU" task update "$TET" --status in_progress
te_wait TEBoth 2
[ "$(te_runs TEDone)" = "0" ] || fail "a non-matching status must not fire the done workflow"
run 0 "$NARU" task update "$TET" --status done
te_wait TEDone 1
te_wait TEBoth 3
run 0 "$NARU" task update "$TET" --priority high
sleep 1
[ "$(te_runs TEBoth)" = "3" ] || fail "a write that leaves the status alone must fire nothing, got $(te_runs TEBoth) runs"
run 0 "$NARU" task create "$TEO" "other project"
sleep 1
[ "$(te_runs TEBoth)" = "3" ] || fail "a task in another project must not fire the project-filtered workflow"
ok "task-event node: create and status change start runs, status/project filters hold, hostile name intact, bad config is validation"

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
# schedule node (naru task 2004): validation, one entry node, then the watcher fires it.
run 0 "$NARU" workflow create Sched
run 0 "$NARU" workflow node create Sched schedule Every --config '{"every_minutes":1}'
SS=$(jqs .id)
[ "$(jqs .kind)" = "schedule" ] || fail "schedule node kind: $STDOUT"
run 0 "$NARU" workflow node create Sched cli SchedTick --config '{"command":"echo sched"}'
SC=$(jqs .id)
"$NARU" workflow edge create Sched "$SS" "$SC" >/dev/null
run 1 "$NARU" workflow node create Sched trigger Second
run 1 "$NARU" workflow edge create Sched "$SC" "$SS"
run 0 "$NARU" workflow create SchedCron
run 0 "$NARU" workflow node create SchedCron schedule Cron --config '{"cron":"  * * * * *"}'
[ "$(jqs .config.cron)" = "* * * * *" ] || fail "cron is stored normalized: $STDOUT"
run 0 "$NARU" workflow create SchedBad
for cfg in '{}' '{"every_minutes":5,"cron":"* * * * *"}' '{"every_minutes":0}' '{"every_minutes":10081}' '{"cron":"* * * *"}' '{"cron":"61 * * * *"}' '{"cron":"* * * * *","x":1}'; do
  run 1 "$NARU" workflow node create SchedBad schedule Bad --config "$cfg"
done
ok "schedule node: created through the CLI, cron normalized, bad configs and a second entry node or an edge into it refused"
# file-watch node (naru task 2007): validation, one entry node, then the watcher fires it per change.
FWFILE="$TMP/watched.txt"
echo one >"$FWFILE"
run 0 "$NARU" workflow create FileW
run 0 "$NARU" workflow node create FileW file-watch Watch --config "{\"path\":\"$FWFILE\",\"event\":\"modified\"}"
FWN=$(jqs .id)
[ "$(jqs '.config.pins.out[0].name')" = "event" ] || fail "file-watch declares an event pin: $STDOUT"
run 0 "$NARU" workflow node create FileW output Sink --config '{"target":"log","log":"fw"}'
"$NARU" workflow edge create FileW "$FWN" "$(jqs .id)" >/dev/null
run 1 "$NARU" workflow node create FileW trigger Second
run 0 "$NARU" workflow create FileBad
for cfg in '{}' '{"path":""}' '{"path":"/x","event":"sometimes"}' '{"path":"/x","x":1}'; do
  run 1 "$NARU" workflow node create FileBad file-watch Bad --config "$cfg"
done
ok "file-watch node: created through the CLI with an event pin, bad configs and a second entry node refused"
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
run 0 "$NARU" workflow runs Sched
[ "$(jqs length)" = "1" ] || fail "the watcher must run a due schedule (interval) workflow once: $STDOUT"
[ "$(jqs '.[0].trigger')" = "time" ] || fail "a schedule's run is trigger=time"
run 0 "$NARU" workflow run-show "$(jq -r '.[0].id' < <("$NARU" workflow runs Sched))"
[ "$(jqs '.steps[1].output')" = "sched" ] || fail "the schedule's run executed its nodes: $STDOUT"
run 0 "$NARU" workflow runs SchedCron
[ "$(jqs length)" -ge 1 ] || fail "the watcher must run an every-minute cron schedule: $STDOUT"
ok "serve --watch-workflows: a schedule node (interval once per interval, cron on its minute) runs from the watcher"
run 0 "$NARU" workflow runs FileW
[ "$(jqs length)" = "0" ] || fail "the first watcher pass only baselines the file, no run: $STDOUT"
echo three >>"$FWFILE"
for _ in $(seq 1 50); do
  run 0 "$NARU" workflow runs FileW
  [ "$(jqs length)" -ge 1 ] && break
  sleep 0.2
done
sleep 0.8
run 0 "$NARU" workflow runs FileW
[ "$(jqs length)" = "1" ] || fail "one change must start exactly one run: $STDOUT"
[ "$(jqs '.[0].trigger')" = "file-watch" ] || fail "a file-watch run is trigger=file-watch: $STDOUT"
run 0 "$NARU" workflow run-show "$(jq -r '.[0].id' < <("$NARU" workflow runs FileW))"
[ "$(jq -r '.steps[0].output | fromjson | .event' <<<"$STDOUT")" = "modified" ] || fail "run input names the event: $STDOUT"
[ "$(jq -r '.steps[0].output | fromjson | .path' <<<"$STDOUT")" = "$FWFILE" ] || fail "run input names the path: $STDOUT"
[ "$(jq -r '.steps[0].output | fromjson | .size' <<<"$STDOUT")" -gt 4 ] || fail "run input carries the size: $STDOUT"
rm "$FWFILE"   # event filter is modified: a deletion fires nothing
sleep 0.8
run 0 "$NARU" workflow runs FileW
[ "$(jqs length)" = "1" ] || fail "a deletion must not fire a modified-only watcher: $STDOUT"
ok "serve --watch-workflows: a file-watch node baselines, then runs once per change with {path,event,mtime,size}, filtered by event"
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=

# ================= retry node: retry / timeout wrapper (naru task 1991) =================

run 0 "$NARU" workflow create flaky
run 0 "$NARU" workflow node create flaky trigger Start
RT=$(jqs .id)
CNT="$TMP/retry-count"
rm -f "$CNT"
# Fails twice, then succeeds: the third attempt of three.
RCFG=$(jq -nc --arg c "echo x >> '$CNT'; [ \$(wc -l < '$CNT') -ge 3 ] && echo recovered" \
  '{wrap:{kind:"cli",config:{command:$c}},attempts:3,backoff_ms:50,backoff_factor:2}')
run 0 "$NARU" workflow node create flaky retry Flaky --config "$RCFG"
RN=$(jqs .id)
[ "$(jqs .config.attempts)" = "3" ] || fail "retry config normalized: $STDOUT"
run 0 "$NARU" workflow edge create flaky "$RT" "$RN"
run 0 "$NARU" workflow run flaky
[ "$(jqs .status)" = "succeeded" ] || fail "retry run: $STDOUT"
[ "$(wc -l < "$CNT" | tr -d ' ')" = "3" ] || fail "retry ran the wrapped command 3 times, got $(wc -l < "$CNT")"
[ "$(jqs '.steps[1].output' | tr -d '\n')" = "recovered" ] || fail "retry output is the wrapped node's: $STDOUT"
# Every attempt fails: the node fails after all of them, naming the count.
rm -f "$CNT"
run 0 "$NARU" workflow node update "$RN" --config "$(jq -nc --arg c "echo x >> '$CNT'; exit 3" '{wrap:{kind:"cli",config:{command:$c}},attempts:2}')"
run 0 "$NARU" workflow run flaky
[ "$(jqs .status)" = "failed" ] || fail "exhausted retry fails the run: $STDOUT"
[ "$(jqs '.steps[1].error')" != "null" ] && [[ "$(jqs '.steps[1].error')" == *"failed after 2 attempt"* ]] || fail "exhausted retry error: $STDOUT"
[ "$(wc -l < "$CNT" | tr -d ' ')" = "2" ] || fail "exhausted retry tried twice"
# The timeout bounds each attempt.
run 0 "$NARU" workflow node update "$RN" --config '{"wrap":{"kind":"cli","config":{"command":"sleep 5"}},"attempts":2,"timeout_secs":1}'
run 0 "$NARU" workflow run flaky
[ "$(jqs .status)" = "failed" ] || fail "a timed-out retry fails the run: $STDOUT"
ok "retry: succeeds on attempt 3, fails after exhausting attempts, timeout fails an attempt"
for bad in '{"attempts":2}' \
  '{"wrap":{"kind":"cli","config":{"command":"true"}},"attempts":0}' \
  '{"wrap":{"kind":"cli","config":{"command":"true"}},"timeout_secs":3601}' \
  '{"wrap":{"kind":"branch","config":{"op":"contains","value":"x"}}}' \
  '{"wrap":{"kind":"cli","config":{}}}'; do
  run 1 "$NARU" workflow node create flaky retry Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "retry bad config $bad: validation"
done
ok "retry: a missing wrap, bad bounds and a control-kind wrap are validation"

# ================= delay node: wait for a duration or until a time (naru task 1992) =================

run 0 "$NARU" workflow create waiter
run 0 "$NARU" workflow node create waiter trigger Start
DT=$(jqs .id)
run 0 "$NARU" workflow node create waiter delay Wait --config '{"seconds":1}'
DN=$(jqs .id)
[ "$(jqs .config.seconds)" = "1" ] || fail "delay config normalized: $STDOUT"
run 0 "$NARU" workflow edge create waiter "$DT" "$DN"
DT0=$(date +%s)
run 0 "$NARU" workflow run waiter --input "carry me"
DT1=$(date +%s)
[ "$(jqs .status)" = "succeeded" ] || fail "delay run: $STDOUT"
[ $((DT1 - DT0)) -ge 1 ] || fail "delay waited at least a second, took $((DT1 - DT0))s"
[ "$(jqs '.steps[1].output' | tr -d '\n')" = "carry me" ] || fail "delay passes its input through: $STDOUT"
ok "delay: waits its seconds and passes the input through unchanged"
for bad in '{}' '{"seconds":3601}' '{"seconds":-1}' '{"seconds":1,"until":"10:00"}' '{"until":"25:00"}' '{"until":"soon"}'; do
  run 1 "$NARU" workflow node create waiter delay Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "delay bad config $bad: validation"
done
run 0 "$NARU" workflow node create waiter delay Later --config '{"until":"14:30"}'
ok "delay: a missing/both/out-of-range/unparseable config is validation, HH:MM is accepted"

# ================= gate node: human approval (naru task 1993) =================
# A gate pauses the run on a pending decision; a stub `vox` records the phone
# notification; the decision comes from the CLI or the API; a timeout rejects.

cat > "$STUB_DIR/vox" <<VOXEOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$STUB_DIR/vox.argv"
echo '{"message_id":1,"chat_id":2}'
VOXEOF
chmod +x "$STUB_DIR/vox"
export MESA_VOX_BIN="$STUB_DIR/vox"
GPORT=17796
echo "{\"notify\":{\"base-url\":\"http://127.0.0.1:$GPORT\"}}" > "$MESA_CONFIG_FILE"
"$NARU" serve --port "$GPORT" >"$TMP/gate-serve.log" 2>&1 &
SERVER_PID=$!
PORT=$GPORT
EVIL=(-H "Host: 127.0.0.1:$PORT" -H 'Origin: https://evil.example')
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$GPORT/api/version" && break; sleep 0.1; done

run 0 "$NARU" workflow create approver
run 0 "$NARU" workflow node create approver trigger Start
GT=$(jqs .id)
run 0 "$NARU" workflow node create approver gate Approve --config '{"message":"Ship it?","timeout_secs":30}'
GN=$(jqs .id)
[ "$(jqs .config.on_timeout)" = "reject" ] || fail "gate config normalized: $STDOUT"
run 0 "$NARU" workflow node create approver cli Yes --config '{"command":"echo went-yes"}'
GY=$(jqs .id)
run 0 "$NARU" workflow node create approver cli No --config '{"command":"echo went-no"}'
GNO=$(jqs .id)
run 0 "$NARU" workflow edge create approver "$GT" "$GN"
run 1 "$NARU" workflow edge create approver "$GN" "$GY"
[ "$(jqe .error.code)" = "validation" ] || fail "a gate edge needs a branch: $STDERR"
run 1 "$NARU" workflow edge create approver "$GN" "$GY" --branch true
[ "$(jqe .error.code)" = "validation" ] || fail "a gate edge branch is approved|rejected: $STDERR"
run 0 "$NARU" workflow edge create approver "$GN" "$GY" --branch approved
run 0 "$NARU" workflow edge create approver "$GN" "$GNO" --branch rejected
ok "gate: node + approved/rejected edges; an edge without or with another branch is validation"

pending_gate() { # prints the id of the one pending gate, waiting up to 15s
  local id
  for _ in $(seq 1 150); do
    id=$("$NARU" workflow gate list | jq -r '.[0].id // empty')
    [ -n "$id" ] && { echo "$id"; return; }
    sleep 0.1
  done
  fail "no pending gate appeared"
}
step_status() { jq -r --arg t "$1" '.steps[] | select(.title == $t) | .status' <<<"$STDOUT"; }

# approve over the API: the approved edge runs, the rejected one is skipped
"$NARU" workflow run approver --input "payload" > "$TMP/gate-run.json" &
RUNPID=$!
G1=$(pending_gate)
run 0 "$NARU" workflow gate list
[ "$(jqs '.[0].message')" = "Ship it?" ] && [ "$(jqs '.[0].status')" = "pending" ] || fail "pending gate listed: $STDOUT"
for _ in $(seq 1 50); do [ -s "$STUB_DIR/vox.argv" ] && break; sleep 0.1; done # the row exists before vox has run
grep -q -- "--title=Naru: approval needed" "$STUB_DIR/vox.argv" || fail "phone notification titled: $(cat "$STUB_DIR/vox.argv")"
grep -q "Open Naru=http://127.0.0.1:$GPORT/open/workflows/" "$STUB_DIR/vox.argv" || fail "notification button: $(cat "$STUB_DIR/vox.argv")"
ok "gate: the run waits on a pending gate and the phone is notified with an Open Naru link"
raw GET /api/workflow-gates "${EVIL[@]}"
[ "$STATUS" = "403" ] || fail "gate list with a foreign Origin must be 403, got $STATUS"
raw POST "/api/workflow-gates/$G1/decide" "${EVIL[@]}" -H 'Content-Type: application/json' -d '{"decision":"approved"}'
[ "$STATUS" = "403" ] || fail "gate decide with a foreign Origin must be 403, got $STATUS"
api 422 POST "/api/workflow-gates/$G1/decide" '{"decision":"maybe"}'
api 404 POST /api/workflow-gates/999999/decide '{"decision":"approved"}'
api 200 GET "/api/workflow-gates"
api 200 POST "/api/workflow-gates/$G1/decide" '{"decision":"approved"}'
api 409 POST "/api/workflow-gates/$G1/decide" '{"decision":"rejected"}'
wait "$RUNPID"
STDOUT=$(cat "$TMP/gate-run.json")
[ "$(jqs .status)" = "succeeded" ] || fail "approved run: $STDOUT"
[ "$(step_status Yes)" = "ok" ] && [ "$(step_status No)" = "skipped" ] || fail "approved path only: $STDOUT"
ok "gate: API approve takes the approved edge, skips the rejected one; a second decision is 409; foreign Origin 403"

# reject over the CLI (with --quiet dropping the message): the rejected edge runs
"$NARU" workflow run approver > "$TMP/gate-run.json" &
RUNPID=$!
G2=$(pending_gate)
run 0 "$NARU" workflow gate reject "$G2" --quiet
[ "$(jqs .status)" = "rejected" ] && [ "$(jqs 'has("message")')" = "false" ] || fail "reject --quiet: $STDOUT"
run 1 "$NARU" workflow gate approve "$G2"
[ "$(jqe .error.code)" = "conflict" ] || fail "a decided gate is conflict: $STDERR"
wait "$RUNPID"
STDOUT=$(cat "$TMP/gate-run.json")
[ "$(jqs .status)" = "succeeded" ] || fail "rejected run still succeeds: $STDOUT"
[ "$(step_status Yes)" = "skipped" ] && [ "$(step_status No)" = "ok" ] || fail "rejected path only: $STDOUT"
ok "gate: CLI reject takes the rejected edge, the run still succeeds, a second decision is conflict"

# timeout: nobody decides, the gate rejects itself and says why
run 0 "$NARU" workflow node update "$GN" --config '{"message":"Ship it?","timeout_secs":1}'
run 0 "$NARU" workflow run approver
[ "$(jqs .status)" = "succeeded" ] || fail "timed-out run: $STDOUT"
[ "$(step_status No)" = "ok" ] && [ "$(step_status Yes)" = "skipped" ] || fail "timeout rejects: $STDOUT"
GRUN=$(jqs .id)
run 0 "$NARU" workflow gate list --all --run "$GRUN"
[ "$(jqs '.[0].status')" = "rejected" ] && [ "$(jqs '.[0].reason')" = "timed out" ] || fail "timeout reason recorded: $STDOUT"
ok "gate: a timeout rejects with the reason 'timed out'"
for bad in '{"timeout_secs":0}' '{"timeout_secs":86401}' '{"on_timeout":"approve"}' '{"nope":1}'; do
  run 1 "$NARU" workflow node create approver gate Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "gate bad config $bad: validation"
done
ok "gate: an out-of-range timeout, another on_timeout and an unknown key are validation"
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=

# ================= subworkflow node (naru task 1994) =================
# A parent runs a child workflow: the node's input is the child's trigger
# input, the child's last output comes out, a failing child fails the node,
# and a loop or a chain over 8 workflows is refused on save.

run 0 "$NARU" workflow create swchild
run 0 "$NARU" workflow node create swchild trigger Start
SWCT=$(jqs .id)
run 0 "$NARU" workflow node create swchild cli Echo --config '{"command":"cat"}'
SWCE=$(jqs .id)
run 0 "$NARU" workflow edge create swchild "$SWCT" "$SWCE"
run 0 "$NARU" workflow create swparent
run 0 "$NARU" workflow node create swparent trigger Start
SWPT=$(jqs .id)
run 0 "$NARU" workflow node create swparent subworkflow Call --config '{"workflow":"SWCHILD"}'
SWPN=$(jqs .id)
[ "$(jqs .config.workflow)" = "SWCHILD" ] || fail "subworkflow config kept: $STDOUT"
run 0 "$NARU" workflow edge create swparent "$SWPT" "$SWPN"
run 0 "$NARU" workflow run swparent --input "from the parent"
[ "$(jqs .status)" = "succeeded" ] || fail "subworkflow run: $STDOUT"
[ "$(jqs '.steps[] | select(.title == "Call") | .output' | tr -d '\n')" = "from the parent" ] || fail "child output comes out of the node: $STDOUT"
ok "subworkflow: the input goes to the child's trigger and the child's last output comes out"

run 0 "$NARU" workflow node update "$SWCE" --config '{"command":"exit 3"}'
run 0 "$NARU" workflow run swparent --input x
[ "$(jqs .status)" = "failed" ] || fail "failing child fails the parent: $STDOUT"
[ "$(jqs '.steps[] | select(.title == "Call") | .status')" = "failed" ] || fail "the node failed: $STDOUT"
ok "subworkflow: a failing child fails the node and the parent run"

run 1 "$NARU" workflow node create swparent subworkflow Self --config '{"workflow":"swparent"}'
[ "$(jqe .error.code)" = "validation" ] || fail "self-call is validation: $STDERR"
run 1 "$NARU" workflow node create swchild subworkflow Back --config '{"workflow":"swparent"}'
[ "$(jqe .error.code)" = "validation" ] || fail "A->B->A is validation: $STDERR"
run 1 "$NARU" workflow node create swparent subworkflow Ghost --config '{"workflow":"no such workflow"}'
[ "$(jqe .error.code)" = "validation" ] || fail "unknown child is validation: $STDERR"
run 1 "$NARU" workflow node create swparent subworkflow Bad --config '{}'
[ "$(jqe .error.code)" = "validation" ] || fail "missing workflow is validation: $STDERR"
ok "subworkflow: a self-call, a loop, an unknown child and a missing key are validation"

for i in 1 2 3 4 5 6 7 8 9; do run 0 "$NARU" workflow create "swchain$i"; done
for i in 7 6 5 4 3 2 1; do
  run 0 "$NARU" workflow node create "swchain$i" subworkflow Next --config "{\"workflow\":\"swchain$((i + 1))\"}"
done
run 0 "$NARU" workflow create swchain0
run 1 "$NARU" workflow node create swchain0 subworkflow Next --config '{"workflow":"swchain1"}'
[ "$(jqe .error.code)" = "validation" ] || fail "a chain over 8 deep is validation: $STDERR"
ok "subworkflow: an 8-deep chain is saved, a 9-deep one is validation"

# ================= task node (naru task 1996) =================
# create / update / read one task; the output is the task as JSON, `{input}`
# stands in for any value, and a bad config or a missing task is an error.

run 0 "$NARU" project create "TaskNodes" --no-git
TKP=$(jqs .id)
run 0 "$NARU" workflow create tkflow
run 0 "$NARU" workflow node create tkflow trigger Start
TKT=$(jqs .id)
run 0 "$NARU" workflow node create tkflow task Make --config '{"action":"create","project":"tasknodes","description":"made: {input}","priority":"high"}'
TKN=$(jqs .id)
[ "$(jqs .kind)" = "task" ] && [ "$(jqs .config.action)" = "create" ] || fail "task node kept: $STDOUT"
run 0 "$NARU" workflow edge create tkflow "$TKT" "$TKN"
run 0 "$NARU" workflow run tkflow --input "from a workflow"
[ "$(jqs .status)" = "succeeded" ] || fail "task create run: $STDOUT"
TKID=$(jq -r '.steps[] | select(.title == "Make") | .output | fromjson | .id' <<<"$STDOUT")
run 0 "$NARU" task show "$TKID"
[ "$(jqs .description)" = "made: from a workflow" ] && [ "$(jqs .priority)" = "high" ] && [ "$(jqs .project_id)" = "$TKP" ] || fail "created task row: $STDOUT"
ok "task: a create node makes the task in the project, {input} substituted, output is the task JSON"

run 0 "$NARU" workflow node update "$TKN" --config '{"action":"update","task":"{input}","status":"done","result":"closed by workflow"}'
run 0 "$NARU" workflow run tkflow --input "$TKID"
[ "$(jqs .status)" = "succeeded" ] || fail "task update run: $STDOUT"
run 0 "$NARU" task show "$TKID"
[ "$(jqs .status)" = "done" ] && [ "$(jqs .result)" = "closed by workflow" ] || fail "updated task row: $STDOUT"
ok "task: an update node changes the task"

run 0 "$NARU" workflow node update "$TKN" --config '{"action":"read","task":"{input}"}'
run 0 "$NARU" workflow run tkflow --input "$TKID"
[ "$(jqs .status)" = "succeeded" ] || fail "task read run: $STDOUT"
[ "$(jq -r '.steps[] | select(.title == "Make") | .output | fromjson | .status' <<<"$STDOUT")" = "done" ] || fail "read output: $STDOUT"
run 0 "$NARU" workflow run tkflow --input "999999"
[ "$(jqs .status)" = "failed" ] || fail "reading a missing task fails the run: $STDOUT"
ok "task: a read node outputs the task, a missing id fails the node"

for bad in '{}' '{"action":"drop"}' '{"action":"create"}' '{"action":"read"}' '{"action":"update","task":1}' '{"action":"read","task":1,"status":"done"}' '{"action":"create","project":"x","status":"nope"}' '{"action":"read","task":1,"zz":1}'; do
  run 1 "$NARU" workflow node create tkflow task Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "task bad config $bad: validation"
done
ok "task: a missing/unknown action, missing required fields, a field the action does not take and an unknown key are validation"

# ================= trycatch node (naru task 1995) =================
# A failing wrapped node is caught: the node and the run succeed and only the
# `caught` edge runs; a passing wrap takes `ok`; an unwired branch skips.

run 0 "$NARU" workflow create tcflow
run 0 "$NARU" workflow node create tcflow trigger Start
TCT=$(jqs .id)
run 0 "$NARU" workflow node create tcflow trycatch Try --config '{"wrap":{"kind":"cli","config":{"command":"exit 3"}}}'
TCN=$(jqs .id)
run 0 "$NARU" workflow node create tcflow cli Good --config '{"command":"echo fine"}'
TCG=$(jqs .id)
run 0 "$NARU" workflow node create tcflow cli Handled --config '{"command":"echo handled"}'
TCH=$(jqs .id)
run 0 "$NARU" workflow edge create tcflow "$TCT" "$TCN"
run 1 "$NARU" workflow edge create tcflow "$TCN" "$TCG"
[ "$(jqe .error.code)" = "validation" ] || fail "trycatch edge needs a branch: $STDERR"
run 1 "$NARU" workflow edge create tcflow "$TCN" "$TCG" --branch true
[ "$(jqe .error.code)" = "validation" ] || fail "trycatch branch must be ok|caught: $STDERR"
run 0 "$NARU" workflow edge create tcflow "$TCN" "$TCG" --branch ok
run 0 "$NARU" workflow edge create tcflow "$TCN" "$TCH" --branch caught
TCE=$(jqs .id)
run 0 "$NARU" workflow run tcflow
[ "$(jqs .status)" = "succeeded" ] || fail "caught failure keeps the run succeeding: $STDOUT"
[ "$(step_status Try)" = "ok" ] && [ "$(step_status Handled)" = "ok" ] && [ "$(step_status Good)" = "skipped" ] || fail "caught takes the caught edge: $STDOUT"
ok "trycatch: a failing wrap is caught, the run succeeds and only the caught edge runs"

run 0 "$NARU" workflow node update "$TCN" --config '{"wrap":{"kind":"cli","config":{"command":"true"}}}'
run 0 "$NARU" workflow run tcflow
[ "$(jqs .status)" = "succeeded" ] || fail "passing wrap run: $STDOUT"
[ "$(step_status Good)" = "ok" ] && [ "$(step_status Handled)" = "skipped" ] || fail "a passing wrap takes ok: $STDOUT"
ok "trycatch: a passing wrap takes the ok edge and skips caught"

run 0 "$NARU" workflow node update "$TCN" --config '{"wrap":{"kind":"cli","config":{"command":"exit 3"}}}'
run 0 "$NARU" workflow edge delete "$TCE"
run 0 "$NARU" workflow run tcflow
[ "$(jqs .status)" = "succeeded" ] && [ "$(step_status Good)" = "skipped" ] || fail "an unwired caught skips downstream: $STDOUT"
ok "trycatch: with no caught edge the run still succeeds and downstream is skipped"

for bad in '{"wrap":{"kind":"branch","config":{}}}' '{}' '{"wrap":{"kind":"cli","config":{"command":"true"}},"attempts":2}'; do
  run 1 "$NARU" workflow node create tcflow trycatch Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "trycatch bad config $bad: validation"
done
ok "trycatch: a bad wrap kind, a missing wrap and an unknown key are validation"

# ================= http node (naru task 1997) =================
cat > "$STUB_DIR/http-server.py" <<'EOPY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _reply(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n).decode() if n else ""
        if self.path.startswith("/missing"):
            code, out = 404, b"gone"
        elif self.path.startswith("/slow"):
            import time; time.sleep(3); code, out = 200, b"late"
        else:
            code = 200
            out = json.dumps({"method": self.command, "path": self.path, "body": body, "x": self.headers.get("x-test")}).encode()
        self.send_response(code)
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)
    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _reply
srv = HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(srv.server_address[1]))
srv.serve_forever()
EOPY
python3 "$STUB_DIR/http-server.py" "$STUB_DIR/http-port" >"$TMP/http-server.log" 2>&1 &
HTTP_PID=$!
for _ in $(seq 1 50); do [ -s "$STUB_DIR/http-port" ] && break; sleep 0.1; done
HTTP_BASE="http://127.0.0.1:$(cat "$STUB_DIR/http-port")"
run 0 "$NARU" workflow create Httping
run 0 "$NARU" workflow node create Httping trigger Start
HT=$(jqs .id)
run 0 "$NARU" workflow node create Httping http Call --config "{\"method\":\"post\",\"url\":\"$HTTP_BASE/echo?q={input}\",\"headers\":{\"X-Test\":\"{input}\"},\"body\":\"b={input}\"}"
HC=$(jqs .id)
[ "$(jqs .config.method)" = "POST" ] || fail "http method normalised: $STDOUT"
"$NARU" workflow edge create Httping "$HT" "$HC" >/dev/null
run 0 "$NARU" workflow run Httping --input 'a $(touch /tmp/NARU_PWN)'
[ "$(jqs .status)" = "succeeded" ] || fail "http run: $STDOUT"
HOUT=$(jqs '.steps[1].output')
[ "$(jq -r .status <<<"$HOUT")" = "200" ] && [ "$(jq -r .ok <<<"$HOUT")" = "true" ] || fail "http status: $HOUT"
[ "$(jq -r .json.method <<<"$HOUT")" = "POST" ] && [ "$(jq -r .json.body <<<"$HOUT")" = 'b=a $(touch /tmp/NARU_PWN)' ] || fail "http body and parsed json: $HOUT"
[ "$(jq -r .json.x <<<"$HOUT")" = 'a $(touch /tmp/NARU_PWN)' ] || fail "http header carries the input: $HOUT"
[ ! -e /tmp/NARU_PWN ] || { rm -f /tmp/NARU_PWN; fail "a hostile input was executed"; }
ok "http node: POST with {input} in url, header and body returns status, ok and parsed json; hostile input inert"

run 0 "$NARU" workflow node update "$HC" --config "{\"url\":\"$HTTP_BASE/missing\"}"
run 0 "$NARU" workflow run Httping --input x
[ "$(jqs .status)" = "succeeded" ] || fail "a 404 is data, the run succeeds: $STDOUT"
HOUT=$(jqs '.steps[1].output')
[ "$(jq -r .status <<<"$HOUT")" = "404" ] && [ "$(jq -r .ok <<<"$HOUT")" = "false" ] && [ "$(jq -r .body <<<"$HOUT")" = "gone" ] || fail "404 output: $HOUT"
ok "http node: a 404 is data and the run still succeeds"

run 0 "$NARU" workflow node update "$HC" --config "{\"url\":\"$HTTP_BASE/slow\",\"timeout_secs\":1}"
run 0 "$NARU" workflow run Httping --input x
[ "$(jqs .status)" = "failed" ] || fail "a timeout fails the node: $STDOUT"
run 0 "$NARU" workflow node update "$HC" --config '{"url":"http://127.0.0.1:1/"}'
run 0 "$NARU" workflow run Httping --input x
[ "$(jqs .status)" = "failed" ] && grep -q "request failed" <<<"$(jqs '.steps[1].error')" || fail "a refused connection fails the node: $STDOUT"
ok "http node: a timeout and a refused connection each fail the node"

for bad in '{}' '{"url":"ftp://x"}' '{"url":"https://x"}' '{"url":"http://x","method":"TRACE"}' '{"url":"http://x","body":"b"}' '{"url":"http://x","zz":1}'; do
  run 1 "$NARU" workflow node create Httping http Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "http bad config $bad: validation"
done
kill "$HTTP_PID" 2>/dev/null || true
wait "$HTTP_PID" 2>/dev/null || true
ok "http node: a missing url, a bad scheme, an unknown method, a body on GET and an unknown key are validation"

# ================= notify node (naru task 1998) =================
# Phone mode runs the stub `vox` (MESA_VOX_BIN, set by the gate section) with
# the message and title as argv; speak mode appends a naru turn to the live
# conversation. The input passes through either way.
run 0 "$NARU" workflow create Notifying
run 0 "$NARU" workflow node create Notifying trigger Start
NT=$(jqs .id)
run 0 "$NARU" workflow node create Notifying notify Ping --config '{"message":"saw {input}","title":"Naru test"}'
NN=$(jqs .id)
[ "$(jqs .config.mode)" = "phone" ] || fail "notify mode defaults to phone: $STDOUT"
"$NARU" workflow edge create Notifying "$NT" "$NN" >/dev/null
rm -f "$STUB_DIR/vox.argv"
run 0 "$NARU" workflow run Notifying --input 'a $(touch /tmp/NARU_PWN)'
[ "$(jqs .status)" = "succeeded" ] || fail "notify run: $STDOUT"
[ "$(jqs '.steps[1].output')" = 'a $(touch /tmp/NARU_PWN)' ] || fail "notify passes its input through: $STDOUT"
grep -qxF 'saw a $(touch /tmp/NARU_PWN)' "$STUB_DIR/vox.argv" && grep -qxF -- '--title=Naru test' "$STUB_DIR/vox.argv" || fail "vox argv: $(cat "$STUB_DIR/vox.argv")"
[ ! -e /tmp/NARU_PWN ] || { rm -f /tmp/NARU_PWN; fail "a hostile input was executed"; }
ok "notify node: phone mode sends message and title through vox, input passes through, hostile text inert"

# No message: the input itself is sent.
run 0 "$NARU" workflow node update "$NN" --config '{"mode":"phone"}'
rm -f "$STUB_DIR/vox.argv"
run 0 "$NARU" workflow run Notifying --input 'bare input'
grep -qxF 'bare input' "$STUB_DIR/vox.argv" || fail "an empty message sends the input: $(cat "$STUB_DIR/vox.argv")"
ok "notify node: no message sends the node's input"

# vox missing: the node and the run fail.
SAVED_VOX="$MESA_VOX_BIN"
export MESA_VOX_BIN="$STUB_DIR/no-such-vox"
run 0 "$NARU" workflow run Notifying --input x
[ "$(jqs .status)" = "failed" ] || fail "a missing vox fails the run: $STDOUT"
grep -q "vox" <<<"$(jqs '.steps[1].error')" || fail "the error names vox: $STDOUT"
export MESA_VOX_BIN="$SAVED_VOX"
ok "notify node: a missing vox fails the node"

# Speak mode: no live conversation fails; a live one gets a naru turn.
run 0 "$NARU" workflow node update "$NN" --config '{"mode":"speak","message":"hello {input}"}'
run 0 "$NARU" workflow run Notifying --input world
[ "$(jqs .status)" = "failed" ] || fail "speak with no live conversation fails: $STDOUT"
run 0 "$NARU" live start --no-agent
run 0 "$NARU" workflow run Notifying --input world
[ "$(jqs .status)" = "succeeded" ] || fail "speak run: $STDOUT"
run 0 "$NARU" live turns
jq -e 'map(select(.role == "naru" and .text == "hello world")) | length == 1' <<<"$STDOUT" >/dev/null || fail "the naru turn was written: $STDOUT"
run 0 "$NARU" live stop
ok "notify node: speak mode fails with no live conversation and appends a naru turn when one is live"

for bad in '{"mode":"shout"}' '{"mode":"speak","title":"T"}' '{"open":"../x"}' '{"zz":1}'; do
  run 1 "$NARU" workflow node create Notifying notify Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "notify bad config $bad: validation"
done
ok "notify node: a bad mode, a title in speak mode, a bad route and an unknown key are validation"

# ================= board node (naru task 2001) =================
# Pushes a board to the live whiteboard: no live conversation fails the node
# and writes nothing; a live one gets exactly one board with the templated body.
run 0 "$NARU" workflow create Boarding
run 0 "$NARU" workflow node create Boarding trigger Start
BT=$(jqs .id)
run 0 "$NARU" workflow node create Boarding board Show --config '{"title":"Check","body":"# Hi {input}"}'
BN=$(jqs .id)
[ "$(jqs .config.kind)" = "markdown" ] || fail "board kind defaults to markdown: $STDOUT"
"$NARU" workflow edge create Boarding "$BT" "$BN" >/dev/null
run 0 "$NARU" workflow run Boarding --input world
[ "$(jqs .status)" = "failed" ] || fail "board with no live conversation fails: $STDOUT"
grep -q "naru live start" <<<"$(jqs '.steps[1].error')" || fail "the error names naru live start: $STDOUT"
run 0 "$NARU" live start --no-agent
run 0 "$NARU" workflow run Boarding --input world
[ "$(jqs .status)" = "succeeded" ] || fail "board run: $STDOUT"
[ "$(jqs '.steps[1].output')" = "world" ] || fail "board passes its input through: $STDOUT"
run 0 "$NARU" live board list
jq -e 'length == 1 and .[0].kind == "markdown" and .[0].title == "Check"' <<<"$STDOUT" >/dev/null || fail "one board was pushed: $STDOUT"
run 0 "$NARU" live board show
grep -qF '# Hi world' <<<"$STDOUT" || fail "the board body is the templated input: $STDOUT"
run 0 "$NARU" live stop
ok "board node: fails with no live conversation, pushes one templated board when one is live, input passes through"

for bad in '{"kind":"svg"}' '{"zz":1}'; do
  run 1 "$NARU" workflow node create Boarding board Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "board bad config $bad: validation"
done
ok "board node: a bad kind and an unknown key are validation"

# ================= git node (naru task 1999) =================
# branch -> commit -> diff over a throwaway repo: the hostile commit message is
# one argv word and lands byte-identical, `ok`/`status` leave by their own pins,
# a commit with nothing left to commit is data, a bad config is validation.
GITREPO="$TMP/gitrepo"
mkdir -p "$GITREPO"
git -C "$GITREPO" init -q
git -C "$GITREPO" config user.name "Naru Test"
git -C "$GITREPO" config user.email "naru@example.com"
git -C "$GITREPO" config commit.gpgsign false
echo base > "$GITREPO/f.txt"
git -C "$GITREPO" add -A
git -C "$GITREPO" commit -q -m base
echo hello > "$GITREPO/g.txt"
GIT_MSG='it'"'"'s $(touch /tmp/NARU_GIT_PWN) `x` "q"'
run 0 "$NARU" workflow create Gitting
run 0 "$NARU" workflow node create Gitting trigger Start
GT=$(jqs .id)
run 0 "$NARU" workflow node create Gitting git Branch --config "{\"op\":\"branch\",\"cwd\":\"$GITREPO\",\"name\":\"feat/{input}\"}"
GB=$(jqs .id)
[ "$(jqs '.config.pins.out | map(.name) | join(",")')" = "result,ok,status" ] || fail "git pins: $STDOUT"
run 0 "$NARU" workflow node create Gitting git Commit --config "$(jq -nc --arg c "$GITREPO" --arg m "$GIT_MSG" '{op:"commit",cwd:$c,message:$m}')"
GC=$(jqs .id)
run 0 "$NARU" workflow node create Gitting git Diff --config "{\"op\":\"diff\",\"cwd\":\"$GITREPO\",\"base\":\"HEAD~1\"}"
GD=$(jqs .id)
run 0 "$NARU" workflow node create Gitting cli Status --config '{"command":"cat"}'
GS=$(jqs .id)
"$NARU" workflow edge create Gitting "$GT" "$GB" >/dev/null
"$NARU" workflow edge create Gitting "$GB" "$GC" >/dev/null
"$NARU" workflow edge create Gitting "$GC" "$GD" >/dev/null
"$NARU" workflow edge create Gitting "$GC" "$GS" --from-pin status >/dev/null
run 0 "$NARU" workflow run Gitting --input work
[ "$(jqs .status)" = "succeeded" ] || fail "git run: $STDOUT"
[ "$(git -C "$GITREPO" branch --show-current)" = "feat/work" ] || fail "branch created and switched to"
[ "$(git -C "$GITREPO" log -1 --format=%B)" = "$GIT_MSG" ] || fail "commit message byte-identical: $(git -C "$GITREPO" log -1 --format=%B)"
[ ! -e /tmp/NARU_GIT_PWN ] || { rm -f /tmp/NARU_GIT_PWN; fail "a hostile commit message was executed"; }
[ "$(jqs ".steps[] | select(.node_id == $GC) | .output | fromjson | .ok")" = "true" ] || fail "commit ok: $STDOUT"
[ "$(jqs ".steps[] | select(.node_id == $GC) | .output | fromjson | .result")" = "$(git -C "$GITREPO" rev-parse HEAD)" ] || fail "commit result is the sha"
jqs ".steps[] | select(.node_id == $GD) | .output | fromjson | .result" | grep -q '^+hello' || fail "diff shows the commit: $STDOUT"
[ "$(jqs ".steps[] | select(.node_id == $GS) | .output")" = "committed" ] || fail "status pin edge: $STDOUT"
ok "git node: branch created, hostile message committed byte-identical and inert, result/ok/status pins, diff"

# Nothing left to commit is data: the run succeeds with ok false.
run 0 "$NARU" workflow run Gitting --input work
[ "$(jqs .status)" = "succeeded" ] || fail "no-op git run: $STDOUT"
[ "$(jqs ".steps[] | select(.node_id == $GB) | .output | fromjson | .status")" = "switched" ] || fail "existing branch is switched to: $STDOUT"
[ "$(jqs ".steps[] | select(.node_id == $GC) | .output | fromjson | [.ok, .status] | join(\",\")")" = "false,nothing to commit" ] || fail "nothing to commit is data: $STDOUT"
ok "git node: an existing branch is switched to; nothing to commit is ok=false data, not a failure"

# A folder that is not a repository fails the node.
run 0 "$NARU" workflow node update "$GD" --config "{\"op\":\"diff\",\"cwd\":\"$TMP\"}"
run 0 "$NARU" workflow run Gitting --input work
[ "$(jqs .status)" = "failed" ] || fail "diff outside a repo fails the run: $STDOUT"
ok "git node: a git failure fails the node"

for bad in '{"op":"push"}' '{"op":"commit"}' '{"op":"branch","name":"-x"}' '{"op":"branch","name":"a b"}' '{"op":"diff","base":"--output=/tmp/x"}' '{"op":"diff","message":"m"}' '{"op":"diff","pins":{}}' '{"zz":1}'; do
  run 1 "$NARU" workflow node create Gitting git Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "git bad config $bad: validation"
done
ok "git node: a bad op, a missing message, a dash or spaced name, an option-like base, a stray key and pins are validation"

# ================= file node (naru task 2000) =================
# trigger -> write -> append -> read -> cli: hostile input lands byte-identical
# and inert, a missing read fails the node and the run (CLI still exit 0), a
# bad config is validation.
FILEDIR="$TMP/filenode"
FILE_IN='it'"'"'s $(touch /tmp/NARU_FILE_PWN) `x` "q"'
run 0 "$NARU" workflow create Filing
run 0 "$NARU" workflow node create Filing trigger Start
FT=$(jqs .id)
run 0 "$NARU" workflow node create Filing file Write --config "{\"op\":\"write\",\"path\":\"$FILEDIR/sub/out.txt\"}"
FW=$(jqs .id)
[ "$(jqs '.config.pins.out | map(.name) | join(",")')" = "result,path" ] || fail "file pins: $STDOUT"
run 0 "$NARU" workflow node create Filing file Append --config "{\"op\":\"write\",\"path\":\"$FILEDIR/sub/out.txt\",\"content\":\"|{input}\",\"append\":true}"
FA=$(jqs .id)
run 0 "$NARU" workflow node create Filing file Read --config "{\"op\":\"read\",\"path\":\"$FILEDIR/sub/out.txt\"}"
FR=$(jqs .id)
run 0 "$NARU" workflow node create Filing cli Show --config '{"command":"cat"}'
FS=$(jqs .id)
"$NARU" workflow edge create Filing "$FT" "$FW" >/dev/null
"$NARU" workflow edge create Filing "$FW" "$FA" >/dev/null
"$NARU" workflow edge create Filing "$FA" "$FR" >/dev/null
"$NARU" workflow edge create Filing "$FR" "$FS" >/dev/null
run 0 "$NARU" workflow run Filing --input "$FILE_IN"
[ "$(jqs .status)" = "succeeded" ] || fail "file run: $STDOUT"
[ "$(cat "$FILEDIR/sub/out.txt")" = "$FILE_IN|$FILE_IN" ] || fail "file written then appended byte-identical: $(cat "$FILEDIR/sub/out.txt")"
[ ! -e /tmp/NARU_FILE_PWN ] || { rm -f /tmp/NARU_FILE_PWN; fail "a hostile file input was executed"; }
[ "$(jqs ".steps[] | select(.node_id == $FS) | .output")" = "$FILE_IN|$FILE_IN" ] || fail "read content reaches the next node: $STDOUT"
ok "file node: write creates folders, append appends, read round-trips hostile text inert"

run 0 "$NARU" workflow node update "$FR" --config "{\"op\":\"read\",\"path\":\"$FILEDIR/missing.txt\"}"
run 0 "$NARU" workflow run Filing --input x
[ "$(jqs .status)" = "failed" ] || fail "a missing file fails the run: $STDOUT"
ok "file node: a missing file fails the node and the run, the CLI still exits 0"

for bad in '{"op":"delete","path":"a"}' '{"op":"read"}' '{"op":"read","path":" "}' '{"op":"read","path":"a","content":"x"}' '{"op":"write","path":"a","append":"yes"}' '{"op":"read","path":"a","pins":{}}' '{"zz":1}'; do
  run 1 "$NARU" workflow node create Filing file Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "file bad config $bad: validation"
done
ok "file node: a bad op, a missing or blank path, a stray key, write-only keys on read and pins are validation"

# ================= memory node (naru task 2002) =================
# trigger -> memory add -> memory search -> cli: the entry lands in the named
# project's notebook, the search finds it, hostile text stays inert, a bad
# config / no project / empty text is a failure or validation.
MEM_IN='walnut $(touch /tmp/NARU_MEM_PWN) `x` "q"'
run 0 "$NARU" project create "MemNodes" --no-git
run 0 "$NARU" workflow create Remembering
run 0 "$NARU" workflow node create Remembering trigger Start
MT=$(jqs .id)
run 0 "$NARU" workflow node create Remembering memory Remember --config '{"op":"add","text":"likes {input}","project":"MemNodes"}'
MA=$(jqs .id)
[ "$(jqs '.config.pins.out | map(.name) | join(",")')" = "result,id" ] || fail "memory pins: $STDOUT"
run 0 "$NARU" workflow node create Remembering memory Recall --config '{"op":"search","query":"walnut","project":"MemNodes"}'
MS=$(jqs .id)
run 0 "$NARU" workflow node create Remembering cli Show --config '{"command":"cat"}'
MC=$(jqs .id)
"$NARU" workflow edge create Remembering "$MT" "$MA" >/dev/null
"$NARU" workflow edge create Remembering "$MA" "$MS" >/dev/null
"$NARU" workflow edge create Remembering "$MS" "$MC" >/dev/null
run 0 "$NARU" workflow run Remembering --input "$MEM_IN"
[ "$(jqs .status)" = "succeeded" ] || fail "memory run: $STDOUT"
[ ! -e /tmp/NARU_MEM_PWN ] || { rm -f /tmp/NARU_MEM_PWN; fail "a hostile memory input was executed"; }
[ "$(jqs ".steps[] | select(.node_id == $MC) | .output | contains(\"walnut\")")" = "true" ] || fail "the search found the added entry: $STDOUT"
run 0 "$NARU" memory list --project MemNodes
[ "$(jqs 'map(select(.body | startswith("likes walnut"))) | length')" = "1" ] || fail "the notebook holds the added entry: $STDOUT"
ok "memory node: add writes the project notebook, search finds it, hostile text inert"

run 0 "$NARU" workflow node update "$MA" --config '{"op":"add","text":"x"}'
run 0 "$NARU" workflow run Remembering --input x
[ "$(jqs .status)" = "failed" ] || fail "a memory add with no project fails the run: $STDOUT"
ok "memory node: no node project and a global workflow fails the node and the run"

for bad in '{"op":"drop"}' '{"op":"add","query":"x"}' '{"op":"search","text":"x"}' '{"op":"add","limit":3}' '{"op":"search","limit":0}' '{"op":"add","pins":{}}' '{"zz":1}'; do
  run 1 "$NARU" workflow node create Remembering memory Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "memory bad config $bad: validation"
done
ok "memory node: a bad op, stray keys, a bad limit and pins are validation"

# ================= verify node (naru task 2003) =================
# trigger -> verify: a passing check, a failing one (data, the node and run
# still succeed), an `expect` miss, a timeout (fails the node), a hostile
# input inert, bad config is validation.
VF_IN='it'"'"'s $(touch /tmp/NARU_VF_PWN) `x` "q"'
run 0 "$NARU" workflow create Checking
run 0 "$NARU" workflow node create Checking trigger Start
VT=$(jqs .id)
run 0 "$NARU" workflow node create Checking verify Check --config '{"command":"echo all green; cat >/dev/null","expect":"green"}'
VV=$(jqs .id)
[ "$(jqs '.config.pins.out | map(.name) | join(",")')" = "pass,evidence,exit_code" ] || fail "verify pins: $STDOUT"
"$NARU" workflow edge create Checking "$VT" "$VV" >/dev/null
run 0 "$NARU" workflow run Checking --input "$VF_IN"
[ "$(jqs .status)" = "succeeded" ] || fail "verify run: $STDOUT"
[ "$(jqs ".steps[] | select(.node_id == $VV) | .output | fromjson | [.pass, .evidence, .exit_code] | join(\"|\")")" = "true|all green|0" ] || fail "verify pass output: $STDOUT"
[ ! -e /tmp/NARU_VF_PWN ] || { rm -f /tmp/NARU_VF_PWN; fail "a hostile verify input was executed"; }
ok "verify node: a passing check outputs pass=true with its evidence, hostile input inert"

run 0 "$NARU" workflow node update "$VV" --config '{"command":"echo broke >&2; exit 4"}'
run 0 "$NARU" workflow run Checking --input x
[ "$(jqs .status)" = "succeeded" ] || fail "a failing check is data, the run succeeds: $STDOUT"
[ "$(jqs ".steps[] | select(.node_id == $VV) | .output | fromjson | [.pass, .evidence, .exit_code] | join(\"|\")")" = "false|broke|4" ] || fail "verify fail output: $STDOUT"
run 0 "$NARU" workflow node update "$VV" --config '{"command":"echo 3 passed","expect":"12 passed"}'
run 0 "$NARU" workflow run Checking --input x
[ "$(jqs ".steps[] | select(.node_id == $VV) | .output | fromjson | .pass")" = "false" ] || fail "an expect miss is pass=false: $STDOUT"
ok "verify node: a failing exit and an expect miss are pass=false with the run still succeeding"

run 0 "$NARU" workflow node update "$VV" --config '{"command":"sleep 5","timeout_secs":1}'
run 0 "$NARU" workflow run Checking --input x
[ "$(jqs .status)" = "failed" ] || fail "a verify timeout fails the run: $STDOUT"
ok "verify node: a timeout fails the node and the run"

for bad in '{}' '{"command":" "}' '{"command":"true","mode":"visual"}' '{"command":"true","url":"http://x/"}' '{"command":"true","timeout_secs":0}' '{"command":"true","pins":{}}' '{"zz":1}'; do
  run 1 "$NARU" workflow node create Checking verify Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "verify bad config $bad: validation"
done
ok "verify node: a missing command, a bad mode, url in test mode, a bad timeout, stray keys and pins are validation"

# ================= comment box (naru task 2008) =================
# Editor-only: created by the CLI, refused any edge, never a run step.
run 0 "$NARU" workflow create Boxed
run 0 "$NARU" workflow node create Boxed trigger Start
CT=$(jqs .id)
run 0 "$NARU" workflow node create Boxed output Out --config '{"target":"log","log":"boxed"}'
CO=$(jqs .id)
"$NARU" workflow edge create Boxed "$CT" "$CO" >/dev/null
run 0 "$NARU" workflow node create Boxed comment Group --config '{"text":"x","color":"warn"}'
CC=$(jqs .id)
[ "$(jqs .kind)" = "comment" ] || fail "comment kind: $STDOUT"
run 0 "$NARU" workflow node create Boxed comment Group2 --quiet
[ "$(jqs '.config // "dropped"')" = "dropped" ] || fail "comment --quiet drops config: $STDOUT"
run 1 "$NARU" workflow edge create Boxed "$CT" "$CC"
[ "$(jqe .error.code)" = "validation" ] || fail "an edge into a comment is validation"
run 1 "$NARU" workflow edge create Boxed "$CC" "$CO"
[ "$(jqe .error.code)" = "validation" ] || fail "an edge out of a comment is validation"
for bad in '{"color":"teal"}' '{"zz":1}' '{"pins":{}}'; do
  run 1 "$NARU" workflow node create Boxed comment Bad --config "$bad"
  [ "$(jqe .error.code)" = "validation" ] || fail "comment bad config $bad: validation"
done
run 0 "$NARU" workflow run Boxed --input hi
[ "$(jqs .status)" = "succeeded" ] || fail "a run with a comment succeeds: $STDOUT"
[ "$(jqs "[.steps[] | select(.kind == \"comment\")] | length")" = "0" ] || fail "a comment has no run step: $STDOUT"
[ "$(jqs '.steps | length')" = "2" ] || fail "only the trigger and output ran: $STDOUT"
ok "comment box: created via the CLI, no edge in or out, a bad colour/key/pins validation, a run has no comment step"

# ---- version history (naru task 2053) ----
# A burst of CLI edits is one revision; the same graph edited over the API is a
# different author, so a second one. Restore keeps node ids and adds a revision.
run 0 "$NARU" workflow create Hist
run 0 "$NARU" workflow node create Hist cli HA --config '{"command":"true"}'
run 0 "$NARU" workflow node create Hist cli HB --config '{"command":"true"}'
run 0 "$NARU" workflow revisions Hist
[ "$(jqs length)" = "1" ] && [ "$(jqs '.[0].author')" = "cli" ] && [ "$(jqs '.[0] | has("snapshot")')" = "false" ] ||
  fail "a burst of CLI edits is one revision without its snapshot: $STDOUT"
PORT=17798
"$NARU" serve --port "$PORT" >"$TMP/serve-hist.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null ||
  fail "history server did not start (log: $(cat "$TMP/serve-hist.log"))"
HID=$("$NARU" workflow show Hist | jq -r '.workflow.id')
HN1=$("$NARU" workflow show Hist | jq -r '.nodes[0].id')
api 201 POST "/api/workflows/$HID/nodes" '{"kind":"cli","title":"HC","config":{"command":"true"}}'
api 200 GET "/api/workflows/$HID/revisions"
[ "$(jqb length)" = "2" ] && [ "$(jqb '.[0].author')" = "web" ] && [ "$(jqb '.[0].snapshot.nodes | length')" = "3" ] ||
  fail "an API edit is a second revision by web: $BODY"
run 0 "$NARU" workflow revision show Hist 1 --quiet
[ "$(jqs 'has("snapshot")')" = "false" ] || fail "revision show --quiet drops the snapshot"
run 0 "$NARU" workflow revision diff Hist 1 2
[ "$(jqs .changed)" = "true" ] && [ "$(jqs '[.lines[] | select(startswith("+ node"))] | length')" = "1" ] ||
  fail "the diff shows the added node: $STDOUT"
run 1 "$NARU" workflow revision restore Hist 2
[ "$(jqe .error.code)" = "validation" ] || fail "restoring the current graph is validation"
run 0 "$NARU" workflow revision restore Hist 1
[ "$(jqs '.nodes | length')" = "2" ] && [ "$(jqs '.nodes[0].id')" = "$HN1" ] || fail "restore keeps node ids: $STDOUT"
run 0 "$NARU" workflow revisions Hist
[ "$(jqs length)" = "3" ] && [ "$(jqs '.[0].reason')" = "restore of 1" ] || fail "restore adds a revision, deletes none: $STDOUT"
api 200 POST "/api/workflows/$HID/revisions/2/restore"
[ "$(jqb '.nodes | length')" = "3" ] || fail "restore over the API: $BODY"
api 404 POST "/api/workflows/$HID/revisions/99/restore"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "http://127.0.0.1:$PORT/api/workflows/$HID/revisions")
[ "$STATUS" = "403" ] || fail "revisions refuse a foreign Host: $STATUS"
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=
ok "revisions: a CLI burst is one, an API edit another (author web), show/diff/restore, node ids kept, nothing deleted, gated"

# The task loop is a managed built-in (naru task 2103): global, read-only, reseeded in place as a revision.
NTL='[.[] | select(.name | startswith("Task loop"))] | length'
run 0 "$NARU" project create HistProj --no-git
run 0 "$NARU" workflow defaults --project HistProj --task-loop
TL=$("$NARU" workflow show "Task loop" | jq -r '.workflow.id')
TLN=$("$NARU" workflow show "Task loop" | jq -r '.nodes[1].id')
[ "$("$NARU" workflow show "Task loop" | jq -r '.workflow | "\(.builtin) \(.project_id) \(.enabled)"')" = "true null true" ] || fail "Task loop is a global, enabled built-in"
[ "$("$NARU" workflow list HistProj | jq 'length')" = "0" ] || fail "the built-ins are global, not in the project"
run 1 "$NARU" workflow node update "$TLN" --title "Edited by hand"
grep -q "read-only; duplicate it to customise" <<<"$STDERR" || fail "node update names the way out: $STDERR"
run 1 "$NARU" workflow update "$TL" --name Renamed
run 1 "$NARU" workflow delete "$TL"
run 1 "$NARU" workflow node create "$TL" cli Extra --config '{"command":"true"}'
run 1 "$NARU" workflow node delete "$TLN"
run 1 "$NARU" workflow revision restore "$TL" 1
run 0 "$NARU" workflow update "$TL" --enabled false
run 0 "$NARU" workflow update "$TL" --enabled true
run 0 "$NARU" workflow duplicate "$TL"
[ "$(jqs '.workflow.name + " " + (.workflow.builtin|tostring)')" = "Task loop (custom) false" ] || fail "a duplicate is an ordinary copy: $STDOUT"
run 0 "$NARU" workflow node update "$(jqs '.nodes[1].id')" --title "Edited by hand"
run 0 "$NARU" workflow delete "Task loop (custom)"
# a changed shipped graph is brought back in place, as a seed revision (the edit goes in behind Naru's back)
PATH="/usr/bin:$PATH" sqlite3 "$MESA_DB" "UPDATE workflow_nodes SET title = 'Edited by hand' WHERE id = $TLN"
run 0 "$NARU" workflow defaults --project HistProj --task-loop
[ "$(jq -r '[.created[].workflow.id] | index('"$TL"') != null' <<<"$STDOUT")" = "true" ] || fail "the reseed updated Task loop in place: $STDOUT"
[ "$("$NARU" workflow list | jq "$NTL")" = "2" ] || fail "reseeding left a copy behind"
[ "$("$NARU" workflow revisions "$TL" | jq -r '.[0].reason')" = "seed" ] || fail "the reseed is a seed revision"
[ "$("$NARU" workflow show "$TL" | jq -r '.nodes[1].title')" = "Plan ok?" ] || fail "the reseed restored the shipped graph"
run 0 "$NARU" workflow defaults --project HistProj --task-loop
[ "$(jqs '.created | length')" = "0" ] || fail "an unchanged reseed writes nothing"
ok "built-ins: global and read-only (update/node/delete/restore refused with the way out), duplicate is editable, a changed graph becomes a seed revision of the same workflow, an unchanged one is a no-op, no copies"

# The KB built-ins (naru task 2118): installed off, an install never switches one on or off,
# a deleted one comes back off, and --builtins needs no project.
KBC='KB: ongoing capture'
[ "$("$NARU" workflow show "$KBC" | jq -r '.workflow | "\(.builtin) \(.enabled)"')" = "true false" ] || fail "a KB built-in installs disabled"
run 0 "$NARU" workflow update "$KBC" --enabled true
run 0 "$NARU" workflow defaults --builtins
[ "$("$NARU" workflow show "$KBC" | jq -r '.workflow.enabled')" = "true" ] || fail "an install kept the KB built-in on"
PATH="/usr/bin:$PATH" sqlite3 "$MESA_DB" "PRAGMA foreign_keys=ON; DELETE FROM workflows WHERE name = '$KBC'"
run 0 "$NARU" workflow defaults --builtins
[ "$(jqs '[.created[].workflow | "\(.name) \(.builtin) \(.enabled)"] | join("|")')" = "$KBC true false" ] || fail "a deleted KB built-in comes back off: $STDOUT"
run 2 "$NARU" workflow defaults
ok "KB built-ins: installed off, an install keeps the person's on/off, a deleted one comes back off; defaults --builtins needs no project"

# collapse: old copies fold into revisions of the current workflow, after a backup.
run 0 "$NARU" workflow create "Task loop (pre-1 backup)"
run 0 "$NARU" workflow node create "Task loop (pre-1 backup)" cli OldOne --config '{"command":"true"}'
run 0 "$NARU" workflow history collapse --dry-run
[ "$(jqs '.collapsed | length')" = "1" ] && [ "$(jqs .backup)" = "null" ] || fail "collapse --dry-run plans, backs up nothing: $STDOUT"
[ "$("$NARU" workflow list | jq "$NTL")" = "3" ] || fail "--dry-run deleted something"
run 0 "$NARU" workflow history collapse --backup "$TMP/collapse-backup.db"
[ -s "$TMP/collapse-backup.db" ] && [ "$(jqs '.collapsed | length')" = "1" ] || fail "collapse backs up first: $STDOUT"
[ "$("$NARU" workflow list | jq "$NTL")" = "2" ] || fail "the copy is gone"
run 0 "$NARU" workflow revisions "$TL"
[ "$(jqs '[.[] | select(.reason == "collapsed from Task loop (pre-1 backup)")] | length')" = "1" ] || fail "the copy is a revision: $STDOUT"
run 0 "$NARU" workflow history collapse
[ "$(jqs '.collapsed | length')" = "0" ] && [ "$(jqs .backup)" = "null" ] || fail "a second collapse is a no-op: $STDOUT"
ok "history collapse: dry-run plans, backup then fold, the copy kept as a revision, idempotent"

# ---- export / import (naru task 2102) ----
# A graph with a script and an agent this db lacks: export, import (disabled,
# suffixed, missing listed, config identical), a bad file, and the two routes.
run 0 "$NARU" workflow create "Portable"
run 0 "$NARU" workflow node create Portable trigger Go --config '{"mode":"manual"}'
run 0 "$NARU" workflow node create Portable script Sc --config '{"script":"no-such-script"}'
run 0 "$NARU" workflow edge create Portable "$("$NARU" workflow show Portable | jq -r '.nodes[0].id')" "$("$NARU" workflow show Portable | jq -r '.nodes[1].id')"
run 0 "$NARU" workflow export Portable --out "$TMP/portable.json"
[ "$(jq -r .format "$TMP/portable.json")" = "naru-workflow" ] && [ "$(jq '.nodes|length' "$TMP/portable.json")" = "2" ] || fail "export file shape"
run 0 "$NARU" workflow import "$TMP/portable.json"
[ "$(jqs .workflow.name)" = "Portable (imported)" ] && [ "$(jqs .renamed_from)" = "Portable" ] || fail "import suffixes a taken name: $STDOUT"
[ "$(jqs .workflow.enabled)" = "false" ] && [ "$(jqs '.nodes|length')" = "2" ] && [ "$(jqs '.edges|length')" = "1" ] || fail "import is disabled with the same graph: $STDOUT"
[ "$(jqs '.missing|map(.what+":"+.reference)|join(",")')" = "script:no-such-script" ] || fail "import lists the missing script: $STDOUT"
[ "$(jq -c '[.nodes[]|.config]' <<<"$STDOUT")" = "$(jq -c '[.nodes[]|.config]' "$TMP/portable.json")" ] || fail "configs identical"
echo '{"format":"naru-workflow","version":1}' >"$TMP/bad.json"
run 1 "$NARU" workflow import "$TMP/bad.json"
echo 'not json' >"$TMP/bad2.json"
run 1 "$NARU" workflow import "$TMP/bad2.json"
[ "$(jqe .error.code)" = "validation" ] || fail "an unreadable file is validation: $STDERR"
"$NARU" serve --port "$PORT" >"$TMP/serve-port.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/api/projects" >/dev/null ||
  fail "export server did not start (log: $(cat "$TMP/serve-port.log"))"
PW=$("$NARU" workflow show Portable | jq -r '.workflow.id')
api 200 GET "/api/workflows/$PW/export"
[ "$(jqb .format)" = "naru-workflow" ] || fail "export route body"
api 201 POST /api/workflows/import "{\"document\": $(cat "$TMP/portable.json")}"
[ "$(jqb .workflow.enabled)" = "false" ] && [ "$(jqb '.missing|length')" = "1" ] || fail "import route: $BODY"
api 422 POST /api/workflows/import '{"document":{"format":"x","version":1}}'
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=
ok "export/import: round trip disabled + suffixed + missing listed, bad files validation, both routes"

[ ! -e "$STUB_DIR/bg.calls" ] || fail "a workflow spawned a background agent (--bg): $(cat "$STUB_DIR/bg.calls")"
ok "no --bg agent was spawned anywhere in this gate"

echo "workflow-check: $CHECKS checks passed"
