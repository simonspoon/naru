#!/usr/bin/env bash
# Project notebooks gate (mesa task 1333, docs/project-memory.md): the
# `naru memory` CLI, the folder -> project resolver, `naru memory context`,
# the `project-memory.sh` SessionStart hook built-in and the import from
# Claude Code's memory folder — against a throwaway MESA_DB, a throwaway
# HOME and a real throwaway git repo. Nothing here touches a real ~/.claude.
#
# What it pins:
#   * the CLI round trip on a project notebook (add/list/show/replace/touch/
#     delete/restore/merge/search), --project by id and by name, and the cwd
#     standing in for --project from a subfolder of the repo;
#   * --quiet: accepted by show and the mutations (full record minus `body`),
#     refused by list/search/context/dream/import (usage, exit 2);
#   * the notebooks never mix: a live id is not_found to `naru memory`, a
#     project id is not_found to `naru live memory` and to another project,
#     a merge across notebooks is validation, and `live memory list/search`
#     never show a project entry; `live memory move` files one across;
#   * `memory context` from a subfolder prints the header and the entries,
#     and prints nothing (exit 0) for a folder no project holds;
#   * the hook body, extracted via `library show project-memory.sh`, prints
#     that same context for a SessionStart payload naming the folder, and
#     nothing with exit 0 for an unknown folder, garbage stdin, empty stdin,
#     and (without jq) through its sed fallback;
#   * import: MEMORY.md skipped, frontmatter description + body, a long
#     file cut to fit, --dry-run writing nothing, a re-import adding nothing,
#     a missing folder not_found;
#   * dream (naru task 1690): under two entries nothing starts; with two a
#     detached `naru __job project-dream` makes one `claude -p --json-schema`
#     call (stub claude) through the live-dream template in the project's
#     folder — the project schema without `keep`, a prompt carrying the
#     notebook and the edit ops, receipt `pid:<n>` — and Naru applies the
#     answer itself, each edit on its own (a refused one is logged, a
#     contradiction becomes a backlog task).
#   * the automatic dream (mesa task 1339): a task closing in a project whose
#     notebook is over its 1000 words starts that dream, `task update`'s
#     stdout unchanged; not again while its job (the pid marker) runs; not
#     for a within-budget notebook; a failing start still closes the task
#     with exit 0 and the next close retries.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')
unset CLAUDE_CODE_SESSION_ID

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
BIN="$PWD/target/debug"

TMP=$(mktemp -d)
# Canonical, so the paths naru prints match the ones compared against.
TMP=$(cd "$TMP" && pwd -P)
# A detached memory job (`naru __job …`, naru task 1690) may outlive the last
# check and write into $TMP: wait (bounded, ~10s) for any naming it first.
trap 'rm -f "$TMP/stub/hold-p"
      for _ in $(seq 1 100); do pgrep -f "__job.*$TMP" >/dev/null 2>&1 || break; sleep 0.1; done
      rm -rf "$TMP"' EXIT
export MESA_DB="$TMP/mesa.db"
export HOME="$TMP/home"
mkdir -p "$HOME"
export PATH="$BIN:$PATH"
NARU=naru

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

run() { # <expected exit> <cmd...> — captures STDOUT/STDERR/CODE
  local expected=$1; shift
  set +e
  STDOUT=$("$@" 2>"$TMP/stderr")
  CODE=$?
  set -e
  STDERR=$(cat "$TMP/stderr")
  [ "$CODE" -eq "$expected" ] ||
    fail "expected exit $expected, got $CODE: $* (stdout: $STDOUT, stderr: $STDERR)"
}
jqs() { jq -r "$1" <<<"$STDOUT"; }
jqe() { jq -r "$1" <<<"$STDERR"; }

# ---- fixtures: a real repo bound to a project, and a stranger folder ----
REPO="$TMP/repo"
mkdir -p "$REPO/src/deep" "$TMP/stranger"
git -C "$REPO" init -q
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m root
run 0 "$NARU" project create "Memo" --path "$REPO"
P=$(jqs .id)
[ "$(jqs .local_path)" = "$REPO" ] || fail "fixture: project local_path (got $STDOUT)"
[ "$(jqs .root_commit)" != "null" ] || fail "fixture: project bound to the repo's root commit"
run 0 "$NARU" project create "Other" --no-git
Q=$(jqs .id)
ok "fixtures: project $P bound to a real repo, project $Q with no folder"

# ---- the CLI round trip, --project resolved from the cwd ----
cd "$REPO/src/deep"
run 0 "$NARU" memory add Run cargo fmt before clippy.
E1=$(jqs .id)
[ "$(jqs .project_id)" = "$P" ] || fail "add from a repo subfolder must land in project $P (got $STDOUT)"
[ "$(jqs .body)" = "Run cargo fmt before clippy." ] || fail "add: trailing words joined"
[ "$(jqs .source_session_id)" = "null" ] && [ "$(jqs .last_used_session_id)" = "null" ] ||
  fail "a project entry carries no session provenance"
[ "$(jqs 'has("evicted")')" = "false" ] || fail "add answers the plain entry, no evicted key"
run 0 "$NARU" memory add --project Memo --quiet "scripts/build.sh refuses a dirty types folder."
E2=$(jqs .id)
[ "$(jqs 'has("body")')" = "false" ] || fail "add --quiet drops body"
run 0 "$NARU" memory add --project "$P" A note that mentions --quiet in passing.
E3=$(jqs .id)
grep -q -- "--quiet in passing" <<<"$(jqs .body)" || fail "--quiet after the text is part of the body"
cd "$TMP"
ok "memory add: cwd, --project by name and by id; --quiet before the text only"

run 0 "$NARU" memory list --project "$P"
[ "$(jqs 'map(.id) | join(",")')" = "$E1,$E2,$E3" ] || fail "memory list: oldest first (got $STDOUT)"
run 0 "$NARU" memory show --project "$P" "$E1"
printf '%s' "$STDOUT" >"$TMP/full.json"
run 0 "$NARU" memory get --project "$P" "$E1" --quiet
printf '%s' "$STDOUT" >"$TMP/quiet.json"
jq -e --slurpfile q "$TMP/quiet.json" 'del(.body) == $q[0]' "$TMP/full.json" >/dev/null ||
  fail "memory show --quiet must be the full record minus body and nothing else"
PLAIN=$("$NARU" memory list --project "$P")
run 0 "$NARU" memory list --project "$P" --quiet
[ "$STDOUT" = "$PLAIN" ] || fail "memory list --quiet: accepted and ignored (mesa task 1513)"
run 2 "$NARU" memory context --project "$P"
ok "memory list/show/get; --quiet on show only drops body; list ignores --quiet; context takes no --project"

run 0 "$NARU" memory replace --project "$P" "$E3" A replaced note.
[ "$(jqs .body)" = "A replaced note." ] && [ "$(jqs .last_used_at)" != "null" ] ||
  fail "replace rewrites and stamps last_used_at (got $STDOUT)"
run 0 "$NARU" memory touch --project "$P" "$E1"
[ "$(jqs .last_used_at)" != "null" ] || fail "touch stamps last_used_at with no live session"
run 0 "$NARU" memory delete --project "$P" "$E3"
[ "$(jqs .retired_reason)" = "deleted" ] || fail "delete: soft retire"
run 0 "$NARU" memory list --project "$P"
[ "$(jqs length)" = "2" ] || fail "a deleted entry leaves the list"
run 0 "$NARU" memory list --project "$P" --all
[ "$(jqs length)" = "3" ] || fail "list --all keeps it"
run 0 "$NARU" memory restore --project "$P" "$E3"
[ "$(jqs .retired_at)" = "null" ] || fail "restore un-retires"
run 0 "$NARU" memory merge --project "$P" --ids "$E2,$E3" "build.sh refuses dirty types; replaced note."
EM=$(jqs .id)
[ "$(jqs .project_id)" = "$P" ] || fail "merge stays in the project"
run 0 "$NARU" memory show --project "$P" "$E2"
[ "$(jqs .merged_into)" = "$EM" ] || fail "merge: sources point at the merged row"
run 0 "$NARU" memory search --project "$P" clippy
[ "$(jqs 'map(.ref_id) | join(",")')" = "$E1" ] || fail "memory search finds the project entry (got $STDOUT)"
run 0 "$NARU" memory search --project "$Q" clippy
[ "$(jqs length)" = "0" ] || fail "another project's search sees nothing of this one"
ok "memory replace/touch/delete/restore/merge/search on the project notebook"

# ---- the notebooks never mix ----
run 0 "$NARU" live memory add "Prefers short replies; mentions clippy too."
L1=$(jqs .id)
[ "$(jqs .project_id)" = "null" ] || fail "a live entry has no project"
run 1 "$NARU" memory show --project "$P" "$L1"
[ "$(jqe .error.code)" = "not_found" ] || fail "a live id is not_found to naru memory"
run 1 "$NARU" memory delete --project "$P" "$L1"
[ "$(jqe .error.code)" = "not_found" ] || fail "delete of a live id via naru memory: not_found"
run 1 "$NARU" live memory show "$E1"
[ "$(jqe .error.code)" = "not_found" ] || fail "a project id is not_found to live memory"
run 1 "$NARU" live memory replace "$E1" hijacked
[ "$(jqe .error.code)" = "not_found" ] || fail "live replace of a project id: not_found"
run 1 "$NARU" memory show --project "$Q" "$E1"
[ "$(jqe .error.code)" = "not_found" ] || fail "another project's id: not_found"
run 1 "$NARU" memory merge --project "$P" --ids "$E1,$L1" mixed
[ "$(jqe .error.code)" = "validation" ] || fail "a merge across notebooks: validation"
run 0 "$NARU" live memory list
[ "$(jqs 'map(.id) | join(",")')" = "$L1" ] || fail "live memory list shows no project entry (got $STDOUT)"
run 0 "$NARU" live memory search clippy
[ "$(jqs '[.[] | select(.kind == "note")] | map(.ref_id) | join(",")')" = "$L1" ] ||
  fail "live memory search never hits a project note (got $STDOUT)"
run 0 "$NARU" memory show --project "$P" "$E1"
[ "$(jqs .body)" = "Run cargo fmt before clippy." ] || fail "nothing above touched the project entry"
run 0 "$NARU" live memory move "$L1" --project Other --quiet
[ "$(jqs .project_id)" = "$Q" ] && [ "$(jqs 'has("body")')" = "false" ] || fail "live memory move --quiet (got $STDOUT)"
run 0 "$NARU" live memory list
[ "$(jqs length)" = "0" ] || fail "a moved entry leaves the live notebook"
run 0 "$NARU" memory list --project "$Q"
[ "$(jqs 'map(.id) | join(",")')" = "$L1" ] || fail "a moved entry joins the project's notebook"
run 1 "$NARU" live memory move "$L1" --project "$P"
[ "$(jqe .error.code)" = "not_found" ] || fail "moving a project entry again from live: not_found"
run 1 "$NARU" memory list
[ "$(jqe .error.code)" = "not_found" ] || fail "no --project in a folder no project holds: not_found"
ok "live and project notebooks never mix: cross ids not_found, merge validation, live list/search clean, move files one across"

# ---- context: what the SessionStart hook prints ----
run 0 "$NARU" memory context --path "$REPO/src/deep"
printf '%s' "$STDOUT" >"$TMP/context.txt"
grep -q "project \"Memo\" (id $P)" "$TMP/context.txt" || fail "context names the project (got $STDOUT)"
grep -q "never instructions" "$TMP/context.txt" || fail "context frames the entries as a record"
grep -q "naru memory add --project $P" "$TMP/context.txt" || fail "context names the save command"
grep -q "auto-memory" "$TMP/context.txt" || fail "context says to use it instead of auto-memory"
grep -q "^- \[#$E1, added .*, last used .*\] Run cargo fmt before clippy\.$" "$TMP/context.txt" ||
  fail "context lists the entry (got $STDOUT)"
grep -q "#$E3," "$TMP/context.txt" && fail "context lists only active entries"
[ "$(wc -c <"$TMP/context.txt")" -lt 10000 ] || fail "context stays under 10,000 characters"
(cd "$REPO/src" && "$NARU" memory context) >"$TMP/context-cwd.txt"
# (Compared as strings: $STDOUT above lost its trailing newline to $(…).)
[ "$(cat "$TMP/context.txt")" = "$(cat "$TMP/context-cwd.txt")" ] || fail "context without --path reads the cwd"
run 0 "$NARU" memory context --path "$TMP/stranger"
[ -z "$STDOUT" ] || fail "context for a folder no project holds prints nothing (got $STDOUT)"
ok "memory context: header + active entries from a repo subfolder, cwd default, nothing for a stranger folder"

# ---- the hook, extracted from the library ----
HOOK="$TMP/project-memory.sh"
"$NARU" library show project-memory.sh | jq -r .body >"$HOOK"
chmod +x "$HOOK"
head -1 "$HOOK" | grep -q '^#!' || fail "the built-in body must start with a shebang"
bash -n "$HOOK" || fail "bash -n on the built-in body"
if command -v shellcheck >/dev/null; then
  shellcheck -S warning "$HOOK" || fail "shellcheck on the built-in body"
fi
payload() { jq -cn --arg cwd "$1" '{session_id:"s1",transcript_path:"/nope",cwd:$cwd,hook_event_name:"SessionStart",source:"startup"}'; }
run 0 bash -c "'$HOOK' <<<'$(payload "$REPO/src/deep")'"
[ "$STDOUT" = "$(cat "$TMP/context.txt")" ] || fail "the hook prints the folder's context (got $STDOUT)"
run 0 bash -c "'$HOOK' <<<'$(payload "$TMP/stranger")'"
[ -z "$STDOUT" ] || fail "hook: unknown folder prints nothing"
run 0 bash -c "'$HOOK' <<<'$(payload "$TMP/does-not-exist")'"
[ -z "$STDOUT" ] || fail "hook: a missing folder prints nothing"
run 0 bash -c "echo 'this is {not json' | '$HOOK'"
[ -z "$STDOUT" ] || fail "hook: garbage stdin prints nothing"
run 0 bash -c "'$HOOK' </dev/null"
[ -z "$STDOUT" ] || fail "hook: empty stdin prints nothing"
# Without jq: a PATH holding only what the fallback needs, and naru.
NOJQ="$TMP/nojq"
mkdir -p "$NOJQ"
for t in bash cat sed head git; do ln -s "$(command -v "$t")" "$NOJQ/$t"; done
ln -s "$BIN/naru" "$NOJQ/naru"
run 0 env PATH="$NOJQ" "$(command -v bash)" -c "'$HOOK' <<<'$(payload "$REPO/src/deep")'"
[ "$STDOUT" = "$(cat "$TMP/context.txt")" ] || fail "hook without jq: the sed fallback reads cwd (got $STDOUT)"
# Neither naru nor mesa on PATH: nothing, exit 0.
rm "$NOJQ/naru"
run 0 env PATH="$NOJQ" "$(command -v bash)" -c "'$HOOK' <<<'$(payload "$REPO/src/deep")'"
[ -z "$STDOUT" ] || fail "hook with no naru on PATH prints nothing"
# A naru that fails: its stderr is swallowed and the hook still exits 0.
printf '#!/bin/sh\necho boom >&2; exit 1\n' >"$NOJQ/naru"
chmod +x "$NOJQ/naru"
run 0 env PATH="$NOJQ" "$(command -v bash)" -c "'$HOOK' <<<'$(payload "$REPO/src/deep")'"
[ -z "$STDOUT" ] && [ -z "$STDERR" ] || fail "hook with a failing naru: nothing on either stream"
ok "project-memory.sh: prints the folder's notebook for a SessionStart payload; nothing and exit 0 for an unknown/missing folder, garbage or empty stdin, no naru, a failing naru; the sed fallback works without jq"

# ---- import from Claude Code's memory folder ----
ENC=$(printf '%s' "$REPO" | sed 's/[^A-Za-z0-9]/-/g')
MEM="$HOME/.claude/projects/$ENC/memory"
mkdir -p "$MEM"
printf -- '- [build](build.md) — index line\n' >"$MEM/MEMORY.md"
printf -- '---\nname: build-order\ndescription: "Run the gates in order"\nmetadata:\n  type: project\n---\n\nfmt, then clippy,\nthen the tests.\n' >"$MEM/build.md"
{ printf -- '---\ndescription: A long one\n---\n'; for _ in $(seq 1 200); do printf 'word '; done; } >"$MEM/long.md"
printf -- '---\n---\n\n' >"$MEM/empty.md"
printf 'not markdown\n' >"$MEM/notes.txt"
run 0 "$NARU" memory list --project "$P"
BEFORE=$(jqs length)
run 0 "$NARU" memory import --project "$P" --dry-run
[ "$(jqs .source)" = "$MEM" ] || fail "import: the default source is Claude Code's memory folder (got $STDOUT)"
[ "$(jqs '.imported | map(.file) | join(",")')" = "build.md,long.md" ] || fail "import --dry-run: what would be imported (got $STDOUT)"
[ "$(jqs '[.imported[].id] | map(select(. != null)) | length')" = "0" ] || fail "import --dry-run: no ids"
[ "$(jqs '.skipped | map(.file + "=" + .reason) | join(",")')" = "empty.md=empty" ] || fail "import: empty.md skipped (got $STDOUT)"
run 0 "$NARU" memory list --project "$P"
[ "$(jqs length)" = "$BEFORE" ] || fail "import --dry-run writes nothing"
run 0 "$NARU" memory import --project "$P"
[ "$(jqs '.imported | length')" = "2" ] || fail "import: two entries"
IB=$(jqs '.imported[0].id')
[ "$(jqs 'has("evicted")')" = "false" ] || fail "import: no evicted key"
run 0 "$NARU" memory show --project "$P" "$IB"
[ "$(jqs .body)" = "Run the gates in order — fmt, then clippy, then the tests." ] || fail "import: description + body (got $STDOUT)"
run 0 "$NARU" memory list --project "$P"
LONG=$(jqs '.[] | select(.body | startswith("A long one")) | .body')
[ "${#LONG}" -le 600 ] && [ "${LONG: -1}" = "…" ] || fail "import: a long file is cut to fit with … (got ${#LONG} chars)"
run 0 "$NARU" memory import --project "$P"
[ "$(jqs '.imported | length')" = "0" ] || fail "re-import adds nothing (got $STDOUT)"
[ "$(jqs '[.skipped[] | select(.reason == "already in the notebook")] | length')" = "2" ] || fail "re-import skips both as already present"
run 1 "$NARU" memory import --project "$Q"
[ "$(jqe .error.code)" = "not_found" ] || fail "import for a project with no folder: not_found"
run 0 "$NARU" memory import --project "$Q" --from "$MEM" --dry-run
[ "$(jqs '.imported | length')" = "2" ] || fail "import --from reads the named folder"
run 1 "$NARU" memory import --project "$Q" --from "$TMP/nowhere"
[ "$(jqe .error.code)" = "not_found" ] || fail "import from a missing folder: not_found"
# Past the budget (mesa task 1337): eight 250-word files make 2000 words, and
# every one lands — nothing trims a notebook at write time. A re-import adds
# nothing, and an entry since retired (a delete of 25%) stays skipped.
BIG="$TMP/big-memory"
mkdir -p "$BIG"
for w in a b c d e f g h; do
  for _ in $(seq 1 250); do printf '%s ' "$w"; done >"$BIG/$w.md"
done
run 0 "$NARU" project create "Big" --no-git
B=$(jqs .id)
run 0 "$NARU" memory import --project "$B" --from "$BIG"
[ "$(jqs '.imported | length')" = "8" ] && [ "$(jqs 'has("evicted")')" = "false" ] ||
  fail "import past the budget: eight imported, no evicted key (got $STDOUT)"
BW=$(jqs '.imported[0].id')
run 0 "$NARU" memory list --project "$B" --all
[ "$(jqs 'map(select(.retired_at == null)) | length')" = "8" ] ||
  fail "import past the budget retires nothing (got $STDOUT)"
[ "$(jqs '[.[].body | split(" ") | map(select(. != "")) | length] | add')" = "2000" ] ||
  fail "import past the budget: all 2000 words active (got $STDOUT)"
run 0 "$NARU" memory delete --project "$B" "$BW"
run 0 "$NARU" memory import --project "$B" --from "$BIG"
[ "$(jqs '.imported | length')" = "0" ] || fail "re-import past the budget must add nothing (got $STDOUT)"
[ "$(jqs '[.skipped[] | select(.reason == "already in the notebook, retired")] | length')" = "1" ] ||
  fail "re-import names the deleted entry as retired (got $STDOUT)"
# Over its budget, the context header says so and names the dream (1750 words
# left after the delete).
mkdir -p "$TMP/big-folder"
run 0 "$NARU" project update "$B" --path "$TMP/big-folder"
run 0 "$NARU" memory context --path "$TMP/big-folder"
grep -qF "The notebook holds 1750 of its 1000 words, over its budget; run \`naru memory dream --project $B\` to tidy it." <<<"$STDOUT" ||
  fail "context over the budget names the dream (got $STDOUT)"
ok "memory import: MEMORY.md skipped, description + body, long file cut with …, --dry-run writes nothing, re-import idempotent (past the budget too, nothing retired), missing folder not_found"

# ---- dream: a detached job through the live-dream template, stub claude ----
#
# Since naru task 1690 a project dream is one synchronous `claude -p
# --json-schema` call with no tools, run inside a detached `naru __job
# project-dream`, whose answer Naru applies itself — so the stub's `-p`
# branch records each call (flags, schema, prompt, cwd, a counter), a
# `hold-p` file keeps one running, and `dream-out.json` is the staged answer.
STUB="$TMP/stub"
mkdir -p "$STUB"
cat >"$STUB/claude" <<EOF
#!/usr/bin/env bash
case "\$1" in
  -p)
    for a in "\$@"; do PROMPT=\$a; done
    printf '%s\n' "\${@:1:\$# - 1}" >"$STUB/last-flags"
    for ((i = 1; i < \$#; i++)); do
      if [ "\${!i}" = "--json-schema" ]; then j=\$((i + 1)); printf '%s' "\${!j}" >"$STUB/last-schema"; fi
    done
    printf '%s' "\$PROMPT" >"$STUB/last-prompt"
    pwd -P >"$STUB/last-cwd"
    echo call >>"$STUB/spawns"
    while [ -e "$STUB/hold-p" ]; do sleep 0.1; done
    [ -e "$STUB/dream-out.json" ] || { echo "stub claude: no dream-out.json staged" >&2; exit 1; }
    printf '{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":%s}\n' "\$(cat "$STUB/dream-out.json")"
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$STUB/claude"
export MESA_CLAUDE_BIN="$STUB/claude"
EMPTY_ANSWER='{"edits":[],"contradictions":[],"report":"nothing"}'
printf '%s' "$EMPTY_ANSWER" >"$STUB/dream-out.json"
spawns() { [ -e "$STUB/spawns" ] && wc -l <"$STUB/spawns" | tr -d ' ' || echo 0; }
wait_spawns() { # <n> — blocks until the stub has recorded n calls
  local i
  for i in $(seq 1 100); do
    [ "$(spawns)" -ge "$1" ] && return 0
    sleep 0.1
  done
  fail "the stub never recorded $1 call(s) (got $(spawns))"
}
no_new_spawns() { # <base> <what> — nothing ran since <base>
  sleep 1
  [ "$(spawns)" = "$1" ] || fail "$2 (got $(( $(spawns) - $1 )) new call(s))"
}
wait_for() { # <what> <cmd...> — polls until the command succeeds
  local what=$1 i
  shift
  for i in $(seq 1 100); do
    "$@" && return 0
    sleep 0.1
  done
  fail "timed out waiting for $what"
}
JOB_LOG="$HOME/.naru/logs/memory-jobs.log"

run 0 "$NARU" project create "Lonely" --no-git
R=$(jqs .id)
run 0 "$NARU" memory add --project "$R" only one entry
BASE=$(spawns)
run 0 "$NARU" memory dream --project "$R"
[ "$(jqs .spawned)" = "false" ] && grep -q "1 active entry" <<<"$(jqs .reason)" || fail "dream under two entries spawns nothing (got $STDOUT)"
no_new_spawns "$BASE" "dream under two entries must not start"
run 0 "$NARU" memory dream --project "$P"
case "$(jqs .receipt)" in pid:[0-9]*) ;; *) fail "dream reports a pid:<n> receipt (got $STDOUT)" ;; esac
[ "$(jqs .spawned)" = "true" ] || fail "dream starts (got $STDOUT)"
wait_spawns $((BASE + 1))
[ "$(cat "$STUB/last-cwd")" = "$REPO" ] || fail "dream runs in the project's folder (got $(cat "$STUB/last-cwd"))"
[ "$(head -11 "$STUB/last-flags" | tr '\n' ' ')" = '-p --model sonnet --name project memory dream --tools  --strict-mcp-config --output-format json --json-schema ' ] ||
  fail "dream call argv (got $(head -11 "$STUB/last-flags" | tr '\n' ' '))"
jq -e '[.properties.edits.items.anyOf[].properties.op.const] == ["merge","delete","replace"]' "$STUB/last-schema" >/dev/null ||
  fail "the project dream schema offers merge, delete and replace, no keep (got $(cat "$STUB/last-schema"))"
grep -q '"op":"merge"' "$STUB/last-prompt" || fail "dream prompt teaches the merge edit"
grep -q "notebook of project $P" "$STUB/last-prompt" || fail "dream prompt names the project"
! grep -q "naru memory" "$STUB/last-prompt" || fail "the tool-less dream prompt names no naru memory command"
grep -q "Run cargo fmt before clippy" "$STUB/last-prompt" || fail "dream prompt carries the notebook"
grep -q "of its 1000 words. Entries are listed least recently used first." "$STUB/last-prompt" ||
  fail "dream prompt opens its listing with the word count against the budget"
grep -q '"op":"replace"' "$STUB/last-prompt" || fail "dream prompt names the shorten edit"
wait_for "the dream's report in the job log" grep -q '"report":"nothing"' "$JOB_LOG"
ok "memory dream: nothing under two entries; otherwise a detached job calling the live-dream template in the project folder with the project schema (no keep) and a prompt carrying the notebook and the edit ops, receipt pid:<n>"

# ---- dream: Naru applies the answer, each edit on its own ----
run 0 "$NARU" project create "Applied" --no-git
AP=$(jqs .id)
run 0 "$NARU" memory add --project "$AP" "prefers short replies"
A1=$(jqs .id)
run 0 "$NARU" memory add --project "$AP" "prefers brief replies"
A2=$(jqs .id)
run 0 "$NARU" memory add --project "$AP" "uses tabs"
A3=$(jqs .id)
printf '%s' "{\"edits\":[{\"op\":\"delete\",\"id\":999999},{\"op\":\"keep\",\"id\":$A3},{\"op\":\"merge\",\"ids\":[$A1,$A2],\"body\":\"prefers short replies\"}],\"contradictions\":[{\"ids\":[$A3,$A1],\"description\":\"tabs versus spaces\"}],\"report\":\"applied it\"}" >"$STUB/dream-out.json"
BASE=$(spawns)
run 0 "$NARU" memory dream --project "$AP"
wait_spawns $((BASE + 1))
wait_for "the merge to land" bash -c "'$NARU' memory list --project $AP | jq -e 'length == 2' >/dev/null"
run 0 "$NARU" memory show --project "$AP" "$A1"
[ "$(jqs .retired_reason)" = "merged" ] || fail "the merge retired its source (got $STDOUT)"
run 0 "$NARU" memory show --project "$AP" "$A3"
[ "$(jqs .retired_at)" = "null" ] || fail "the refused keep must not have touched the entry"
wait_for "the contradiction task" bash -c "'$NARU' task list '$AP' | jq -e 'length == 1' >/dev/null"
run 0 "$NARU" task list "$AP"
TASK=$(jqs '.[0].id')
run 0 "$NARU" task show "$TASK"
[ "$(jqs .status)" = "backlog" ] || fail "a contradiction is a backlog task (got $STDOUT)"
grep -q "tabs versus spaces" <<<"$(jqs .description)" || fail "the task carries the description (got $STDOUT)"
wait_for "the job report" grep -q '"report":"applied it"' "$JOB_LOG"
grep '"report":"applied it"' "$JOB_LOG" | tail -1 |
  jq -e '(.failed | length) == 2 and (.applied | length) == 1 and (.tasks | length) == 1 and .kind == "project-dream"' >/dev/null ||
  fail "the job log records a merge applied, a delete and a keep refused, one task (got $(tail -1 "$JOB_LOG"))"
printf '%s' "$EMPTY_ANSWER" >"$STUB/dream-out.json"
ok "project dream: Naru applies the answer — the merge lands, an unknown id and a keep (no such edit in a project notebook) fail alone and are logged, the contradiction becomes a backlog task"

# ---- the automatic dream after a task closes (mesa task 1339) ----
words() { printf 'w%.0s ' $(seq "$1"); }
over_budget() { # <name> — a project whose notebook holds 1001 words in four entries
  run 0 "$NARU" project create "$1" --no-git
  OB=$(jqs .id)
  mkdir -p "$TMP/$1"
  run 0 "$NARU" project update "$OB" --path "$TMP/$1"
  # an entry is capped at 600 characters, so four: 251 + 3 x 250 words
  run 0 "$NARU" memory add --project "$OB" "$(words 251)"
  for _ in 1 2 3; do run 0 "$NARU" memory add --project "$OB" "$(words 250)"; done
}
close_task() { # <project> — creates a task and closes it, STDOUT the update's
  run 0 "$NARU" task create "$1" "a task in project $1"
  local t
  t=$(jqs .id)
  run 0 "$NARU" task update "$t" --status done
  CLOSED=$t
}
over_budget Dreamy
D=$OB
touch "$STUB/hold-p"
BEFORE=$(spawns)
close_task "$D"
UPDATE_OUT=$STDOUT
[ "$(jqs .status)" = "done" ] || fail "the close still closes (got $STDOUT)"
run 0 "$NARU" task show "$CLOSED"
[ "$UPDATE_OUT" = "$STDOUT" ] || fail "task update stdout is the plain task JSON (got $UPDATE_OUT vs $STDOUT)"
wait_spawns $((BEFORE + 1))
[ "$(cat "$STUB/last-cwd")" = "$TMP/Dreamy" ] || fail "the automatic dream runs in the project's folder"
grep -q "notebook of project $D" "$STUB/last-prompt" || fail "the automatic dream is this project's dream"
grep -q "The notebook holds 1001 of its 1000 words." "$STUB/last-prompt" || fail "the automatic dream prompt carries the word count"
# The job (its pid marker) still running: a second close spawns nothing.
close_task "$D"
no_new_spawns $((BEFORE + 1)) "no second dream while the first one's job is running"
# The job finishes. Re-closing a done task is no close, so even now it
# spawns nothing; the next real close spawns again.
rm -f "$STUB/hold-p"
sleep 1.5
run 0 "$NARU" task update "$CLOSED" --status done
no_new_spawns $((BEFORE + 1)) "re-closing a done task spawns no dream"
close_task "$D"
wait_spawns $((BEFORE + 2))
# Within budget (1000 words exactly): a close spawns nothing.
sleep 1.5
for _ in 1 2 3; do run 0 "$NARU" memory add --project "$R" "$(words 299)"; done
run 0 "$NARU" memory add --project "$R" "$(words 100)"
close_task "$R"
no_new_spawns $((BEFORE + 2)) "a close in a within-budget project spawns nothing"
# A start that fails: the close still exits 0 closed, stdout the task, the
# failure on stderr; the claim is dropped, so the next close retries.
over_budget Broken
run 0 env NARU_SELF_BIN="$TMP/no-such-naru" "$NARU" task create "$OB" "doomed dream"
T=$(jqs .id)
run 0 env NARU_SELF_BIN="$TMP/no-such-naru" "$NARU" task update "$T" --status done
[ "$(jqs .status)" = "done" ] && [ "$(jqs .id)" = "$T" ] || fail "a failed dream start leaves the close intact (got $STDOUT)"
grep -q "no automatic dream pass" <<<"$STDERR" || fail "a failed dream start is reported on stderr (got $STDERR)"
no_new_spawns $((BEFORE + 2)) "a failed start ran nothing"
close_task "$OB"
wait_spawns $((BEFORE + 3))
ok "task close: an over-budget notebook's dream started once, stdout unchanged; none while its job runs; none within budget; a failed start exit 0 and retried"

# ---- shared notebook (mesa task 1550): a parent folder owns everything under it ----
SH="$TMP/product"
mkdir -p "$SH/feature-a/notes" "$SH/feature-b/repo"
git -C "$SH/feature-b/repo" init -q
git -C "$SH/feature-b/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m shared-root
run 0 "$NARU" project create "Product" --no-git
S=$(jqs .id)
[ "$(jqs .shared_notebook)" = "false" ] || fail "shared_notebook defaults to false (got $STDOUT)"
run 0 "$NARU" project update "$S" --path "$SH"
run 0 "$NARU" project create "FeatureRepo" --path "$SH/feature-b/repo"
F=$(jqs .id)
cd "$SH/feature-b/repo"; run 0 "$NARU" memory add own repo note
[ "$(jqs .project_id)" = "$F" ] || fail "off: a bound repo resolves to its own project (got $STDOUT)"
run 0 "$NARU" project update "$S" --shared-notebook true
[ "$(jqs .shared_notebook)" = "true" ] || fail "update --shared-notebook true (got $STDOUT)"
cd "$SH/feature-b/repo"; run 0 "$NARU" memory add shared note from a repo
SE=$(jqs .id)
[ "$(jqs .project_id)" = "$S" ] || fail "on: a repo bound to another project resolves to the shared parent (got $STDOUT)"
cd "$SH/feature-a/notes"; run 0 "$NARU" memory list
jq -e --argjson id "$SE" 'map(.id) | index($id) != null' <<<"$STDOUT" >/dev/null ||
  fail "a non-git nested folder lists the parent's notebook (got $STDOUT)"
run 0 "$NARU" memory context --path "$SH/feature-a/notes"
grep -q "project \"Product\" (id $S)" <<<"$STDOUT" || fail "context from a nested folder names the shared parent (got $STDOUT)"
run 0 "$NARU" memory add --project "$F" explicit project is unchanged
[ "$(jqs .project_id)" = "$F" ] || fail "explicit --project still wins (got $STDOUT)"
# Moving the feature folder loses nothing: the notebook is keyed by project.
mv "$SH/feature-a" "$SH/archived-a"
cd "$SH/archived-a/notes"; run 0 "$NARU" memory list
jq -e --argjson id "$SE" 'map(.id) | index($id) != null' <<<"$STDOUT" >/dev/null ||
  fail "after moving a feature folder the notebook is still reached (got $STDOUT)"
run 0 "$NARU" project update "$S" --shared-notebook false
cd "$SH/feature-b/repo"; run 0 "$NARU" memory add back to the repo
[ "$(jqs .project_id)" = "$F" ] || fail "off again: root-commit resolution restored (got $STDOUT)"
ok "shared notebook: nested non-git folders and a bound repo resolve to the parent while on, own project when off, --project unchanged, a moved feature folder loses nothing"

cd "$TMP"
# ---- the hook is a library built-in, enabled on SessionStart ----
run 0 "$NARU" library hook enable project-memory.sh --event SessionStart --matcher 'startup|resume|clear|compact'
[ -x "$HOME/.claude/hooks/project-memory.sh" ] || fail "enable seeds the hook script"
[ "$(cat "$HOOK")" = "$(cat "$HOME/.claude/hooks/project-memory.sh")" ] || fail "the seeded script is the built-in body"
jq -e '.hooks.SessionStart[0].matcher == "startup|resume|clear|compact"' "$HOME/.claude/settings.json" >/dev/null ||
  fail "enable registers it on SessionStart (throwaway HOME)"
ok "library hook enable project-memory.sh --event SessionStart seeds and registers it (throwaway HOME)"

echo "project-memory-check: $CHECKS checks passed"
