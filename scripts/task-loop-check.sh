#!/usr/bin/env bash
# Task-loop gate (naru task 1960, docs/task-loop-workflow.md): `naru workflow
# defaults --task-loop` and the whole "Task loop" graph run end to end, against
# a throwaway HOME / MESA_DB, a stub `claude` (MESA_CLAUDE_BIN) steered per
# agent by files in the stub dir, and a stub `vox` (MESA_VOX_BIN) recording
# every notify call. Stage clocks are shrunk through NARU_LOOP_DEADLINE /
# NARU_LOOP_SILENCE / NARU_LOOP_GRACE.
#
# Covers: defaults creating the workflow, a rerun skipping it (idempotent, and
# no ambient workflows came with it); a non-UI pass (UX node and Implement #2
# skipped, task done with a result, no notify); a UI pass (UX designer and the
# ui-verifier ran); fix-then-pass (the findings reach the second implementer
# brief, task done); two NEEDS-FIX passes ending in backlog + note + notify;
# an inconclusive verifier ending in backlog + note + one recorded notify call.
set -euo pipefail
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')
unset CLAUDE_CODE_SESSION_ID

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
export MESA_CONFIG_FILE="$TMP/config.json"
mkdir -p "$HOME" "$TMP/work" "$TMP/bin"
echo '{"notify":{"base-url":"http://127.0.0.1:7770"}}' > "$MESA_CONFIG_FILE"
# The workflow's cli nodes run a bare `naru`.
ln -s "$NARU" "$TMP/bin/naru"
export PATH="$TMP/bin:$PATH"

export NARU_LOOP_DEADLINE=20 NARU_LOOP_SILENCE=10 NARU_LOOP_GRACE=3

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# ---- stubs ----
STUB="$TMP/stub"
mkdir -p "$STUB"
export STUB
# claude: per message, the reply is reply.<agent>.<n-th turn of that agent>,
# else reply.<agent>, else "ok"; die.<agent> makes the agent exit at once;
# every message is logged as one JSON string per line in msgs.<agent>.
cat > "$STUB/claude" <<'STUBEOF'
#!/usr/bin/env bash
agent=$(sed -n 's/.*--agent \([^ ]*\).*/\1/p' <<<"$*")
[ -f "$STUB/die.$agent" ] && exit 1
while IFS= read -r line; do
  text=$(jq -r '.message.content[0].text' <<<"$line")
  jq -Rn --arg t "$text" '$t' >> "$STUB/msgs.$agent"
  printf 'turn\n' >> "$STUB/turns.$agent"
  if [ "$agent" = implementer ] && [ -f "$STUB/touch.implementer" ]; then while IFS= read -r f; do mkdir -p "$(dirname "$f")"; echo "$RANDOM" >> "$f"; done < "$STUB/touch.implementer"; fi
  n=$(grep -c . "$STUB/turns.$agent")
  reply=ok
  if [ -f "$STUB/reply.$agent.$n" ]; then reply=$(cat "$STUB/reply.$agent.$n")
  elif [ -f "$STUB/reply.$agent" ]; then reply=$(cat "$STUB/reply.$agent"); fi
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":%s}]}}\n' "$(jq -Rn --arg t "$reply" '$t')"
  printf '{"type":"result","subtype":"success","is_error":false,"result":%s}\n' "$(jq -Rn --arg t "$reply" '$t')"
done
exit 0
STUBEOF
chmod +x "$STUB/claude"
export MESA_CLAUDE_BIN="$STUB/claude"
cat > "$STUB/vox" <<'STUBEOF'
#!/usr/bin/env bash
{ echo "--call--"; printf '%s\n' "$@"; } >> "$STUB/vox.log"
printf '{"ok":true,"message_id":42,"chat_id":7}\n'
STUBEOF
chmod +x "$STUB/vox"
export MESA_VOX_BIN="$STUB/vox"

reset_stub() { rm -f "$STUB"/touch.* "$STUB"/reply.* "$STUB"/die.* "$STUB"/turns.* "$STUB"/msgs.* "$STUB/vox.log"; }
turns() { grep -c . "$STUB/turns.$1" 2>/dev/null || true; }
# step <run json> <node title>: the status of that node's step (node ids from
# the workflow's own node list, since a step carries the id only).
step() {
  local id
  id=$(jq -r --arg t "$2" '[.nodes[] | select(.title == $t)][0].id' <<<"$WF")
  jq -r --argjson i "$id" '[.steps[] | select(.node_id == $i)][0].status // "absent"' <<<"$1"
}
tstatus() { "$NARU" task show "$1" | jq -r .status; }

# ---- setup ----
git -C "$TMP/work" init -q
git -C "$TMP/work" config user.email t@t
git -C "$TMP/work" config user.name t
echo seed > "$TMP/work/seed.txt"
git -C "$TMP/work" add seed.txt
git -C "$TMP/work" commit -q -m seed
"$NARU" project create loopproj --no-git --path "$TMP/work" >/dev/null
OUT=$("$NARU" workflow defaults --task-loop --project loopproj)
jq -e '(.created|length)==1 and .created[0].workflow.name=="Task loop" and .skipped==[] and (.created[0].nodes|length)==17' <<<"$OUT" >/dev/null || fail "defaults: $OUT"
ok "defaults --task-loop creates the Task loop workflow"
OUT=$("$NARU" workflow defaults --task-loop --project loopproj)
jq -e '.created==[] and .skipped==["Task loop"]' <<<"$OUT" >/dev/null || fail "rerun: $OUT"
[ "$("$NARU" workflow list | jq length)" = 1 ] || fail "rerun or --task-loop left extra workflows"
WF=$("$NARU" workflow show "Task loop")
ok "a rerun is a no-op; no ambient workflows were created"

mk() { "$NARU" task create loopproj "$1" | jq -r .id; }
run_loop() { "$NARU" workflow run "Task loop" --input "$1"; }

# ---- 1. non-UI pass ----
reset_stub
printf 'Plan: edit foo.\nUI: no' > "$STUB/reply.planner"
printf 'looks fine\nVERDICT: PASS' > "$STUB/reply.verifier"
printf 'clean\nVERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf 'foo.txt\nsub dir/bar baz.txt\nseed.txt\n' > "$STUB/touch.implementer"
T=$(mk "Fix the foo bug")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] || fail "pass: run $(jq -c '{status,error}' <<<"$R")"
[ "$(tstatus "$T")" = done ] || fail "pass: task is $(tstatus "$T")"
"$NARU" task show "$T" | jq -e '.result | test("passed review")' >/dev/null || fail "pass: no result on the task"
[ "$(step "$R" "UX designer")" = skipped ] || fail "pass: UX node was $(step "$R" "UX designer")"
[ "$(step "$R" "Implement #2")" = skipped ] || fail "pass: Implement #2 was $(step "$R" "Implement #2")"
[ "$(step "$R" "Close: pass")" = ok ] && [ "$(step "$R" "Close: backlog")" = skipped ] || fail "pass: close nodes"
[ "$(turns ux-designer)" = "" ] && [ "$(turns implementer)" = 1 ] && [ "$(turns verifier)" = 1 ] || fail "pass: turn counts"
[ ! -e "$STUB/vox.log" ] || fail "pass: notify was called"
grep -q -- "Fix the foo bug" "$STUB/msgs.planner" || fail "pass: the planner brief lacks the task"
ls "$HOME"/.naru/loop/"$T"-*/plan.md >/dev/null || fail "pass: no scratch hand-off"
[ "$(step "$R" "Commit")" = ok ] || fail "pass: Commit was $(step "$R" "Commit")"
git -C "$TMP/work" log -1 --format=%s | grep -q "task $T" || fail "pass: commit subject: $(git -C "$TMP/work" log -1 --format=%s)"
[ "$(git -C "$TMP/work" show --name-only --format= HEAD | sort | tr '\n' ',')" = "foo.txt,seed.txt,sub dir/bar baz.txt," ] || fail "pass: commit files: $(git -C "$TMP/work" show --name-only --format= HEAD | tr '\n' ',')"
[ -z "$(git -C "$TMP/work" status --porcelain)" ] || fail "pass: tree not clean after the commit"
ok "non-UI pass: UX and Implement #2 skipped, task done with a result, no notify, exactly the changed files committed"

# ---- 2. UI pass ----
reset_stub
printf 'Plan: edit the page.\nUI: yes' > "$STUB/reply.planner"
printf 'layout: a list' > "$STUB/reply.ux-designer"
printf 'VERDICT: PASS' > "$STUB/reply.ui-verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
T=$(mk "Add a settings page")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] && [ "$(tstatus "$T")" = done ] || fail "ui: $(jq -c '{status,error}' <<<"$R") task $(tstatus "$T")"
[ "$(step "$R" "UX designer")" = ok ] || fail "ui: UX node was $(step "$R" "UX designer")"
[ "$(turns ux-designer)" = 1 ] && [ "$(turns ui-verifier)" = 1 ] && [ "$(turns verifier)" = "" ] || fail "ui: agents used"
grep -q "layout: a list" "$STUB/msgs.implementer" || fail "ui: the design brief did not reach the implementer"
ok "UI path: UX designer and ui-verifier ran, the design reached the implementer"

# ---- 3. fix then pass ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'bug in bar()\nVERDICT: FAIL' > "$STUB/reply.diff-reviewer.1"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer.2"
T=$(mk "Fix bar")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] && [ "$(tstatus "$T")" = done ] || fail "fix: $(jq -c '{status,error}' <<<"$R") task $(tstatus "$T")"
[ "$(step "$R" "Implement #2")" = ok ] && [ "$(step "$R" "Review + verify #2")" = ok ] || fail "fix: second pass did not run"
[ "$(turns implementer)" = 2 ] || fail "fix: implementer turns $(turns implementer)"
sed -n 2p "$STUB/msgs.implementer" | grep -q "bug in bar()" || fail "fix: findings missing from the second implementer brief"
[ ! -e "$STUB/vox.log" ] || fail "fix: notify was called"
ok "fix-then-pass: findings reached Implement #2, task done"

# ---- 4. NEEDS-FIX twice -> backlog ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'still broken\nVERDICT: FAIL' > "$STUB/reply.diff-reviewer"
T=$(mk "Fix baz")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] || fail "twice: run $(jq -c '{status,error}' <<<"$R")"
[ "$(tstatus "$T")" = backlog ] || fail "twice: task is $(tstatus "$T")"
[ "$(turns implementer)" = 2 ] || fail "twice: not capped at two iterations ($(turns implementer))"
[ "$(step "$R" "Close: backlog")" = ok ] && [ "$(step "$R" "Close: pass")" = skipped ] || fail "twice: close nodes"
"$NARU" task show "$T" | jq -e '.notes | length == 1 and (.[0].body | test("still broken"))' >/dev/null || fail "twice: note: $("$NARU" task show "$T" | jq -c .notes)"
[ "$(grep -c -- '--call--' "$STUB/vox.log")" = 1 ] || fail "twice: notify calls"
[ "$(step "$R" "Commit")" = skipped ] || fail "twice: Commit was $(step "$R" "Commit")"
ok "two NEEDS-FIX passes end in backlog + note + notify, nothing committed"

# ---- 5. inconclusive verifier -> backlog ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
touch "$STUB/die.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
T=$(mk "Fix qux")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] || fail "inconclusive: run $(jq -c '{status,error}' <<<"$R")"
[ "$(tstatus "$T")" = backlog ] || fail "inconclusive: task is $(tstatus "$T")"
[ "$(step "$R" "Implement #2")" = skipped ] || fail "inconclusive: looped on an inconclusive verifier"
"$NARU" task show "$T" | jq -e '.notes | length == 1 and (.[0].body | test("INCONCLUSIVE"))' >/dev/null || fail "inconclusive: note: $("$NARU" task show "$T" | jq -c .notes)"
[ "$(grep -c -- '--call--' "$STUB/vox.log")" = 1 ] || fail "inconclusive: notify calls"
grep -q -- "Task $T needs a person" "$STUB/vox.log" || fail "inconclusive: notify message: $(cat "$STUB/vox.log")"
grep -q -- "/open/tasks/$T" "$STUB/vox.log" || fail "inconclusive: notify button: $(cat "$STUB/vox.log")"
ok "inconclusive verifier: backlog + note + one recorded notify call"

# ---- 6. a planner that never answers -> backlog, nothing implemented ----
reset_stub
touch "$STUB/die.planner"
T=$(mk "Fix nothing")
R=$(run_loop "$T")
[ "$(tstatus "$T")" = backlog ] && [ "$(step "$R" "Implement #1")" = skipped ] || fail "planner: task $(tstatus "$T"), impl $(step "$R" "Implement #1")"
ok "an inconclusive planner ends in backlog without implementing"

# ---- 7. a tree dirty before the run -> pass, but the commit is refused ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf 'new.txt\n' > "$STUB/touch.implementer"
echo stray > "$TMP/work/stray.txt"
before=$(git -C "$TMP/work" rev-parse HEAD)
T=$(mk "Fix dirty")
R=$(run_loop "$T")
[ "$(tstatus "$T")" = done ] && [ "$(step "$R" "Commit")" = failed ] || fail "dirty: task $(tstatus "$T"), Commit $(step "$R" "Commit")"
[ "$(git -C "$TMP/work" rev-parse HEAD)" = "$before" ] || fail "dirty: a commit was made"
[ "$(git -C "$TMP/work" status --porcelain | sort | tr '\n' ',')" = "?? new.txt,?? stray.txt," ] || fail "dirty: tree: $(git -C "$TMP/work" status --porcelain)"
"$NARU" task show "$T" | jq -e '.notes | length == 1 and (.[0].body | test("stray.txt"))' >/dev/null || fail "dirty: note"
[ "$(grep -c -- '--call--' "$STUB/vox.log")" = 1 ] || fail "dirty: notify calls"
ok "a dirty baseline refuses the commit: nothing staged, task noted, one notify"

echo "task-loop-check: all ok"
