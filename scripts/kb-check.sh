#!/usr/bin/env bash
# Knowledge-base gate (naru task 1919, docs/kb.md): `naru kb add|ask|list|show`
# over the CLI against a stub `claude` (MESA_CLAUDE_BIN) that answers the
# tool-less `-p --json-schema` calls from staged files. `kb add` is a detached
# `naru __job kb-add` (its report line lands in $HOME/.naru/logs/kb.log), `kb
# ask` is synchronous. What this pins: the model never writes a file — the
# stub's hostile paths (`../../etc/passwd`, absolute, nonexistent) are dropped
# or refused and nothing appears outside the kb — plus the note/index/log
# counts, a hostile body round trip, 20 concurrent adds and the error codes.
#
# HOME, NARU_KB_DIR, MESA_DB and MESA_CONFIG_FILE are throwaway; nothing here
# touches a real db, kb or the live serve.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MESA_DB="$TMP/mesa.db"
export MESA_CONFIG_FILE="$TMP/config.json"
mkdir -p "$TMP/home"
FAKE_HOME=$(cd "$TMP/home" && pwd -P)
export HOME="$FAKE_HOME"
KB="$TMP/kb"
export NARU_KB_DIR="$KB"
JOBLOG="$FAKE_HOME/.naru/logs/kb.log"

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
errcode() { jq -r '.error.code' <<<"$STDERR"; }
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
# Files outside the kb, the stub's own scratch and the log dir: must never change.
outside_files() {
  find "$TMP" -type f -not -path "$KB/*" -not -path "$STUB_DIR/*" \
    -not -path "$FAKE_HOME/.naru/logs/*" -not -name 'mesa.db*' -not -name stderr -not -name '*.log' | sort
}

# ---- stub claude: answers `-p` calls from staged ask.json / add.json ----
#
# The call's key is `ask` or `add` (the session name is `naru kb ask|add`). It
# logs the flags, schema and prompt, then answers with the result envelope
# around the staged `<key>.json` (exit 1 when none is staged or `fail` exists).
# With `add-dynamic` present an add answers one `create` op whose slug is the
# prompt's checksum, so concurrent adds file distinct notes.
export STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
P_LOG="$TMP/p.log"
BG_CALLS="$TMP/bg-calls.log"
touch "$P_LOG" "$BG_CALLS"
cat > "$STUB_DIR/claude" <<'STUB'
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
    *" ask") KEY=ask ;;
    *" add") KEY=add ;;
    *" lookup") KEY=ask ;;
    *) KEY=other ;;
  esac
  echo "$(pwd)|$NAME|$MODEL" >> "$STUB_DIR/../p.log"
  printf '%s' "${NARU_KB_SKIP:-}" > "$STUB_DIR/skip-$KEY"
  [ -e "$STUB_DIR/slow" ] && sleep 30
  if [ "$KEY" != add ] || [ ! -e "$STUB_DIR/add-dynamic" ]; then
    printf '%s\n' "${@:1:$# - 1}" > "$STUB_DIR/flags-$KEY"
    printf '%s' "$SCHEMA" > "$STUB_DIR/schema-$KEY"
    printf '%s' "$PROMPT" > "$STUB_DIR/prompt-$KEY"
  fi
  if [ -e "$STUB_DIR/fail" ]; then
    echo "stub claude is down" >&2
    exit 1
  fi
  if [ "$KEY" = add ] && [ -e "$STUB_DIR/add-dynamic" ]; then
    SUM=$(printf '%s' "$PROMPT" | cksum | cut -d' ' -f1)
    printf '{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":{"ops":[{"op":"create","topic":"bulk","slug":"c%s","title":"bulk %s","tags":["bulk"],"body":"body %s"}]}}\n' "$SUM" "$SUM" "$SUM"
    exit 0
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
STUB
chmod +x "$STUB_DIR/claude"
export MESA_CLAUDE_BIN="$STUB_DIR/claude"
stage() { printf '%s' "$2" > "$STUB_DIR/$1.json"; } # stage <key> <json>

# ---- an empty kb: ask is an empty answer, exit 0, no model call ----

run 0 "$MESA" kb ask what is the cat named
[ "$(jqs .answer)" = "" ] && [ "$(jqs '.sources | length')" = "0" ] || fail "empty kb ask: $STDOUT"
[ ! -s "$P_LOG" ] || fail "an empty kb must not call the model"
run 0 "$MESA" kb list
[ "$STDOUT" = "[]" ] || fail "empty kb list: $STDOUT"
ok "empty kb: ask is {answer:'',sources:[]} with no model call; list is []"

# ---- add: input validation ----

run 2 "$MESA" kb add
[ "$(errcode)" = "usage" ] || fail "add with no text: $STDERR"
echo hi > "$TMP/in.txt"
run 2 "$MESA" kb add --file "$TMP/in.txt" --stdin
[ "$(errcode)" = "usage" ] || fail "add with two inputs: $STDERR"
run 1 "$MESA" kb add "   "
[ "$(errcode)" = "validation" ] || fail "blank add: $STDERR"
run 1 "$MESA" kb add --file "$TMP/missing.txt"
[ "$(errcode)" = "validation" ] || fail "missing file: $STDERR"
head -c 32769 /dev/zero | tr '\0' 'a' > "$TMP/big.txt"
run 1 "$MESA" kb add --file "$TMP/big.txt"
[ "$(errcode)" = "validation" ] || fail "over 32 KiB: $STDERR"
[ ! -d "$KB/spool" ] || [ -z "$(ls -A "$KB/spool")" ] || fail "a refused add must not spool"
[ ! -s "$P_LOG" ] || fail "refused adds must not call the model"
ok "add: no input / two inputs are usage (2); blank, missing file and over 32 KiB are validation (1), nothing spooled"

# ---- add: the happy path ----

stage add '{"ops":[{"op":"create","topic":"pets","slug":"cat","title":"The cat","tags":["Pets","cat"],"body":"The cat is named Miso."}]}'
run 0 "$MESA" kb add --source standup Miso is the cat
[ "$(jqs .status)" = "queued" ] || fail "add status: $STDOUT"
ADD_ID=$(jqs .id)
wait_jobs 1
[ "$(jq -r '.applied | length' "$JOBLOG")" = "1" ] || fail "job report: $(cat "$JOBLOG")"
run 0 "$MESA" kb list
[ "$(jqs length)" = "1" ] && [ "$(jqs '.[0].path')" = "topics/pets/cat.md" ] || fail "list: $STDOUT"
[ "$(jqs '.[0] | keys | join(",")')" = "path,tags,title,topic,updated" ] || fail "list keys: $STDOUT"
[ "$(jqs '.[0].tags | join(",")')" = "pets,cat" ] || fail "tags: $STDOUT"
[ "$(wc -l < "$KB/INDEX.md" | tr -d ' ')" = "1" ] || fail "INDEX.md: $(cat "$KB/INDEX.md")"
grep -q '^topics/pets/cat.md | The cat | pets, cat | ' "$KB/INDEX.md" || fail "INDEX.md line: $(cat "$KB/INDEX.md")"
[ "$(wc -l < "$KB/log.jsonl" | tr -d ' ')" = "1" ] || fail "log.jsonl: $(cat "$KB/log.jsonl")"
[ "$(jq -r '.op + "|" + .path + "|" + .source' "$KB/log.jsonl")" = "create|topics/pets/cat.md|standup" ] ||
  fail "log line: $(cat "$KB/log.jsonl")"
[ ! -e "$KB/spool/$ADD_ID.md" ] || fail "the spool file must be removed after a good add"
run 0 "$MESA" kb show topics/pets/cat.md
[ "$(jqs .body)" = "The cat is named Miso." ] || fail "show: $STDOUT"
run 0 "$MESA" kb show topics/pets/cat.md --quiet
[ "$(jqs 'keys | join(",")')" = "path" ] || fail "show --quiet keys: $STDOUT"
run 0 "$MESA" kb list --topic nope
[ "$STDOUT" = "[]" ] || fail "list --topic nope: $STDOUT"
run 0 "$MESA" kb list --topic pets --quiet
[ "$(jqs length)" = "1" ] || fail "list --topic pets --quiet: $STDOUT"
grep -q 'Miso is the cat' "$STUB_DIR/prompt-add" || fail "the raw text must reach the add prompt"
grep -q -- '--model' "$STUB_DIR/flags-add" && grep -qx 'haiku' "$STUB_DIR/flags-add" || fail "add must use haiku: $(cat "$STUB_DIR/flags-add")"
grep -qx -- '--tools' "$STUB_DIR/flags-add" || fail "add must be tool-less"
grep -qx -- '--json-schema' "$STUB_DIR/flags-add" || fail "add must pass a schema"
! grep -q -- '--bg' "$STUB_DIR/flags-add" || fail "add must not start a --bg agent"
[ "$(cut -d'|' -f1 "$P_LOG" | sort -u)" = "$FAKE_HOME/.naru/workspace" ] || fail "calls must run in the workspace: $(cat "$P_LOG")"
[ ! -s "$BG_CALLS" ] || fail "no non-print claude call expected: $(cat "$BG_CALLS")"
ok "add: queued, note + INDEX.md + log.jsonl line, spool removed, show/--quiet/list --topic, haiku tool-less -p in the workspace"

# ---- ask: sources are a subset of the index; bogus ones are dropped ----

stage ask '{"answer":"Miso.","sources":["../../etc/passwd","/etc/passwd","topics/pets/nope.md","topics/pets/cat.md","INDEX.md"]}'
run 0 "$MESA" kb ask What is the cat named?
[ "$(jqs .answer)" = "Miso." ] || fail "ask answer: $STDOUT"
[ "$(jqs '.sources | length')" = "1" ] && [ "$(jqs '.sources[0].path')" = "topics/pets/cat.md" ] && [ "$(jqs '.sources[0].title')" = "The cat" ] ||
  fail "ask must keep only the real source: $STDOUT"
INDEXED=$(jq -r '.[].path' <<<"$("$MESA" kb list)")
for p in $(jq -r '.sources[].path' <<<"$STDOUT"); do
  grep -qx "$p" <<<"$INDEXED" || fail "source $p is not in the index"
done
grep -q 'What is the cat named?' "$STUB_DIR/prompt-ask" && grep -q 'topics/pets/cat.md' "$STUB_DIR/prompt-ask" && grep -q 'Miso' "$STUB_DIR/prompt-ask" ||
  fail "the ask prompt must carry the question, the index and the note"
run 0 "$MESA" kb ask What is the cat named? --quiet
[ "$(jqs '.answer')" = "Miso." ] || fail "ask --quiet is accepted and ignored: $STDOUT"
stage ask '{"answer":"Miso.","sources":["../../etc/passwd","/etc/passwd","topics/pets/nope.md"]}'
run 1 "$MESA" kb ask What is the cat named?
[ "$(errcode)" = "unavailable" ] || fail "an answer citing nothing real is unavailable: $STDERR"
stage ask '{"answer":"","sources":["topics/pets/cat.md"]}'
run 0 "$MESA" kb ask What is the cat named?
[ "$(jqs .answer)" = "" ] && [ "$(jqs '.sources | length')" = "0" ] || fail "'not in the notes' is an empty answer: $STDOUT"
run 0 "$MESA" kb ask tax return deadline
[ "$(jqs .answer)" = "" ] || fail "a question with no keyword hit: $STDOUT"
touch "$STUB_DIR/fail"
run 1 "$MESA" kb ask What is the cat named?
[ "$(errcode)" = "unavailable" ] || fail "a failed call is unavailable: $STDERR"
rm -f "$STUB_DIR/fail"
MESA_CLAUDE_BIN=/nonexistent/claude run 1 "$MESA" kb ask What is the cat named?
[ "$(errcode)" = "unavailable" ] || fail "a missing claude is unavailable: $STDERR"
run 1 "$MESA" kb ask "   "
[ "$(errcode)" = "validation" ] || fail "a blank question is validation: $STDERR"
ok "ask: sources ⊆ index (traversal, absolute, nonexistent, INDEX.md dropped), unavailable on no real source / failed call / no claude, empty answers exit 0"

# ---- show: everything outside the kb is not_found ----

for p in ../mesa.db INDEX.md log.jsonl /etc/passwd topics/pets/zzz.md topics/../INDEX.md topics/pets topics/PETS/cat.md; do
  run 1 "$MESA" kb show "$p"
  [ "$(errcode)" = "not_found" ] || fail "show $p: $STDERR"
done
ok "show: traversal, absolute, non-note and unknown paths are not_found"

# ---- hostile ops from the model: refused, nothing outside the kb ----

outside_files > "$STUB_DIR/before.txt"
stage add '{"ops":[
 {"op":"create","topic":"../../etc","slug":"passwd","title":"x","tags":[],"body":"pwned"},
 {"op":"create","topic":"pets","slug":"../../../escape","title":"x","tags":[],"body":"pwned"},
 {"op":"create","topic":"/tmp","slug":"abs","title":"x","tags":[],"body":"pwned"},
 {"op":"append","topic":"pets","slug":"missing","title":"x","tags":[],"body":"pwned"},
 {"op":"create","topic":"pets","slug":"cat","title":"x","tags":[],"body":"clobber"}]}'
run 0 "$MESA" kb add something hostile
wait_jobs 2
LAST=$(tail -1 "$JOBLOG")
[ "$(jq -r '.applied | length' <<<"$LAST")" = "0" ] && [ "$(jq -r '.failed | length' <<<"$LAST")" = "5" ] || fail "all five hostile ops must fail: $LAST"
outside_files > "$STUB_DIR/after.txt"
diff -q "$STUB_DIR/before.txt" "$STUB_DIR/after.txt" >/dev/null || fail "files appeared outside the kb: $(diff "$STUB_DIR/before.txt" "$STUB_DIR/after.txt")"
[ ! -e "$TMP/etc" ] && [ ! -e /tmp/abs.md ] || fail "an op escaped the kb"
run 0 "$MESA" kb show topics/pets/cat.md
[ "$(jqs .body)" = "The cat is named Miso." ] || fail "a create over an existing note must not clobber it: $STDOUT"
[ "$(wc -l < "$KB/log.jsonl" | tr -d ' ')" = "1" ] || fail "refused ops must not be logged as writes"
HOSTILE_SPOOL=$(jq -r '.spool // empty' <<<"$LAST")
[ -n "$HOSTILE_SPOOL" ] && [ -e "$HOSTILE_SPOOL" ] || fail "refused ops must keep the spool and report its path: $LAST"
rm -f "$HOSTILE_SPOOL"
ok "hostile ops (../ topic and slug, absolute, append-to-missing, create-over-existing) all refused; nothing outside the kb; the note intact; spool kept with its path reported"

# ---- append and a hostile body, byte for byte ----

HOSTILE='x $(touch '"$TMP"'/pwn) `touch '"$TMP"'/pwn2` '"'"'"; echo $HOME \n \\ <<EOF DATA>>> tail'
printf '%s' "$HOSTILE" > "$TMP/hostile.txt"
BODY_JSON=$(jq -Rs . < "$TMP/hostile.txt")
stage add "{\"ops\":[{\"op\":\"append\",\"topic\":\"pets\",\"slug\":\"cat\",\"title\":\"ignored\",\"tags\":[],\"body\":$BODY_JSON},{\"op\":\"create\",\"topic\":\"misc\",\"slug\":\"hostile\",\"title\":\"h\",\"tags\":[],\"body\":$BODY_JSON}]}"
run 0 "$MESA" kb add --file "$TMP/hostile.txt"
wait_jobs 3
LAST=$(tail -1 "$JOBLOG")
[ "$(jq -r '.applied | length' <<<"$LAST")" = "2" ] || fail "append + create: $LAST"
run 0 "$MESA" kb show topics/misc/hostile.md
GOT=$(jq -r .body <<<"$STDOUT")
[ "$GOT" = "$HOSTILE" ] || fail "hostile body not byte-identical: got [$GOT]"
run 0 "$MESA" kb show topics/pets/cat.md
[ "$(jqs .body)" = "$(printf 'The cat is named Miso.\n\n%s' "$HOSTILE")" ] || fail "append body: $STDOUT"
[ ! -e "$TMP/pwn" ] && [ ! -e "$TMP/pwn2" ] || fail "hostile text was executed"
# The raw text reached the model as data: byte-identical except the fence-closing marker.
EXPECT_PROMPT=${HOSTILE//DATA>>>/DATA> >>}
grep -qF -- "$EXPECT_PROMPT" "$STUB_DIR/prompt-add" || fail "hostile raw text must reach the prompt unchanged (fence marker defused)"
[ "$(grep -c 'DATA>>>' "$STUB_DIR/prompt-add")" -le 3 ] || fail "a literal DATA>>> must not close a fence early"
run 0 "$MESA" kb list --topic pets
[ "$(jqs '.[0].title')" = "The cat" ] || fail "append must keep the title: $STDOUT"
ok "hostile body: appended and created byte-identical, the prompt carried it fenced, nothing executed"

# ---- concurrency: 20 adds at once ----

touch "$STUB_DIR/add-dynamic"
BASE_LOG=$(wc -l < "$KB/log.jsonl" | tr -d ' ')
BASE_JOBS=$(job_count)
for i in $(seq 1 20); do
  "$MESA" kb add "concurrent item $i" > "$TMP/c$i.out" 2>&1 &
done
wait
for i in $(seq 1 20); do
  [ "$(jq -r .status "$TMP/c$i.out")" = "queued" ] || fail "concurrent add $i: $(cat "$TMP/c$i.out")"
done
wait_jobs $((BASE_JOBS + 20))
# wait for the last writers to finish their log lines
for _ in $(seq 1 100); do
  [ "$(wc -l < "$KB/log.jsonl" | tr -d ' ')" -ge $((BASE_LOG + 20)) ] && break
  sleep 0.1
done
LOGLINES=$(wc -l < "$KB/log.jsonl" | tr -d ' ')
[ "$LOGLINES" = "$((BASE_LOG + 20))" ] || fail "log.jsonl has $LOGLINES lines, want $((BASE_LOG + 20))"
[ "$(jq -c . "$KB/log.jsonl" | wc -l | tr -d ' ')" = "$LOGLINES" ] || fail "log.jsonl has an unparseable line"
[ "$(jq -r 'select(.op == "create" and (.path | startswith("topics/bulk/"))) | .path' "$KB/log.jsonl" | wc -l | tr -d ' ')" = "20" ] || fail "want 20 bulk creates logged"
run 0 "$MESA" kb list --topic bulk
[ "$(jqs length)" = "20" ] || fail "want 20 bulk notes: $STDOUT"
run 0 "$MESA" kb list
TOTAL=$(jqs length)
[ "$(wc -l < "$KB/INDEX.md" | tr -d ' ')" = "$TOTAL" ] || fail "INDEX.md has $(wc -l < "$KB/INDEX.md") lines, list has $TOTAL"
while IFS= read -r line; do
  [ "$(awk -F' [|] ' '{print NF}' <<<"$line")" = "4" ] || fail "INDEX.md line is not 4 fields: $line"
done < "$KB/INDEX.md"
[ -z "$(ls -A "$KB/spool" 2>/dev/null)" ] || fail "spool not empty after good adds: $(ls "$KB/spool")"
ok "20 concurrent adds: 20 intact log lines, a parseable INDEX.md of $TOTAL notes, spool drained"

# ---- a failed add keeps its spool and reports ----

rm -f "$STUB_DIR/add-dynamic"
touch "$STUB_DIR/fail"
JOBS=$(job_count)
run 0 "$MESA" kb add this one fails
FAILED_ID=$(jqs .id)
wait_jobs $((JOBS + 1))
[ -e "$KB/spool/$FAILED_ID.md" ] || fail "a failed add must keep its spool file"
tail -1 "$JOBLOG" | jq -e '.error.code == "unavailable"' >/dev/null || fail "failed job report: $(tail -1 "$JOBLOG")"
rm -f "$STUB_DIR/fail"
ok "failed add: unavailable in the job log, spool kept"

# ---- the automatic lookup hook (naru task 2274) ----
#
# The kb-lookup.sh built-in extracted from `library show`, fed UserPromptSubmit
# payloads, with `naru` on PATH being this build.

HOOK="$TMP/kb-lookup.sh"
"$MESA" library show kb-lookup.sh | jq -r .body > "$HOOK"
chmod +x "$HOOK"
bash -n "$HOOK" || fail "kb-lookup.sh does not parse"
BIN_DIR="$TMP/bin"
mkdir -p "$BIN_DIR"
ln -s "$PWD/target/debug/naru" "$BIN_DIR/naru"
LOOKUPS="$KB/lookups.jsonl"
payload() { # payload <session> <prompt> [cwd]
  jq -nc --arg s "$1" --arg p "$2" --arg c "${3:-$TMP}" \
    '{session_id: $s, prompt: $p, cwd: $c, transcript_path: "", hook_event_name: "UserPromptSubmit"}'
}
hook() { # hook <stdin> -> HOUT, HCODE
  set +e
  HOUT=$(printf '%s' "$1" | PATH="$BIN_DIR:$PATH" "$HOOK" 2>"$TMP/stderr")
  HCODE=$?
  set -e
  [ "$HCODE" -eq 0 ] || fail "the hook must exit 0, got $HCODE: $(cat "$TMP/stderr")"
}
lookups() { if [ -f "$LOOKUPS" ]; then wc -l < "$LOOKUPS" | tr -d ' '; else echo 0; fi; }

# (a) a matching note is injected, and logged
stage ask '{"answer":"The cat is named Miso.","sources":["topics/pets/cat.md"]}'
hook "$(payload s-match 'what is the cat named')"
jq -e '.hookSpecificOutput.hookEventName == "UserPromptSubmit"
  and (.hookSpecificOutput.additionalContext | contains("The cat is named Miso.") and contains("topics/pets/cat.md"))' \
  <<<"$HOUT" >/dev/null || fail "a match must inject the answer and the note path: $HOUT"
[ "$(lookups)" = "1" ] || fail "one lookup logged, got $(lookups)"
tail -1 "$LOOKUPS" | jq -e '.session_id == "s-match" and .outcome == "injected" and .injected == true
  and .sources[0].path == "topics/pets/cat.md" and .question == "what is the cat named" and (.latency_ms | type) == "number"' \
  >/dev/null || fail "log row: $(tail -1 "$LOOKUPS")"
[ "$(cat "$STUB_DIR/skip-ask")" = "1" ] || fail "the kb's own call must carry NARU_KB_SKIP (no recursion)"
hook "$(payload s-match 'what is the cat named again')"
[ -z "$HOUT" ] && [ "$(lookups)" = "1" ] || fail "a second prompt in the same session is not looked up: $HOUT"
ok "hook (a): a match injects additionalContext with the answer and note path, logs one row; the kb call carries NARU_KB_SKIP; only the first prompt"

# (b) no match: nothing injected
stage ask '{"answer":"","sources":[]}'
hook "$(payload s-empty 'what is the cat named')"
[ -z "$HOUT" ] || fail "an empty answer must inject nothing: $HOUT"
tail -1 "$LOOKUPS" | jq -e '.outcome == "empty" and .injected == false' >/dev/null || fail "empty row: $(tail -1 "$LOOKUPS")"
hook "$(payload s-nohit 'tax return deadline')"
[ -z "$HOUT" ] || fail "no keyword hit must inject nothing: $HOUT"
ok "hook (b): no answer / no keyword hit inject nothing, logged as empty"

# (c) fail open: a failing call, a hung call (6 s cap), no naru at all
touch "$STUB_DIR/fail"
hook "$(payload s-fail 'what is the cat named')"
[ -z "$HOUT" ] || fail "a failed call must inject nothing: $HOUT"
tail -1 "$LOOKUPS" | jq -e '.outcome == "failed" and (.error | length) > 0' >/dev/null || fail "failed row: $(tail -1 "$LOOKUPS")"
rm -f "$STUB_DIR/fail"
touch "$STUB_DIR/slow"
T0=$(date +%s)
hook "$(payload s-slow 'what is the cat named')"
T1=$(date +%s)
rm -f "$STUB_DIR/slow"
[ -z "$HOUT" ] || fail "a hung call must inject nothing: $HOUT"
[ $((T1 - T0)) -le 9 ] || fail "a hung call must be cut off near 6 s, took $((T1 - T0)) s"
tail -1 "$LOOKUPS" | jq -e '.outcome == "failed" and .session_id == "s-slow"' >/dev/null || fail "slow row: $(tail -1 "$LOOKUPS")"
set +e
HOUT=$(payload s-nonaru 'what is the cat named' | PATH=/usr/bin:/bin "$HOOK")
HCODE=$?
set -e
[ "$HCODE" -eq 0 ] && [ -z "$HOUT" ] || fail "no naru on PATH must exit 0 silently"
for garbage in '' 'not json' '{"prompt": 7}'; do
  hook "$garbage"
  [ -z "$HOUT" ] || fail "garbage stdin [$garbage] must print nothing"
done
ok "hook (c): a failing call and a hung call (cut off in $((T1 - T0)) s) inject nothing and log failed; no naru / garbage stdin exit 0 silently"

# (d) never inside Naru's own calls, workflow nodes, the workspace or a live driver
N=$(lookups)
set +e
HOUT=$(payload s-skip 'what is the cat named' | NARU_KB_SKIP=1 PATH="$BIN_DIR:$PATH" "$HOOK")
set -e
[ -z "$HOUT" ] || fail "NARU_KB_SKIP must skip"
hook "$(payload s-ws 'what is the cat named' "$FAKE_HOME/.naru/workspace")"
[ -z "$HOUT" ] || fail "a session in the workspace must be skipped"
hook "$(payload s-live 'Drive naru live session 3 (lease 1).')"
[ -z "$HOUT" ] || fail "a naru-live driver must be skipped"
[ "$(lookups)" = "$N" ] || fail "skipped prompts must not be logged"
[ "$(grep -c 'kb_lookup::SKIP_ENV, "1"' src/core/llm.rs)" = 2 ] && grep -q 'kb_lookup::SKIP_ENV, "1"' src/core/workflow.rs ||
  fail "Naru's model calls and workflow nodes must set NARU_KB_SKIP"
ok "hook (d): NARU_KB_SKIP, the workspace and a naru-live driver are skipped and not logged"

run 0 "$MESA" kb usage
[ "$(jqs .lookups)" = "$(lookups)" ] && [ "$(jqs .empty)" = "2" ] && [ "$(jqs .failed)" = "2" ] &&
  [ "$(jqs .unchecked)" = "1" ] && [ "$(jqs '.weeks | length')" = "1" ] || fail "kb usage: $STDOUT"
ok "kb usage: $(jqs .lookups) lookups counted (1 injected, 2 empty, 2 failed) with a weekly row"

echo "kb-check: $CHECKS checks passed"
