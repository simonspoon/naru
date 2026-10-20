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
# an inconclusive verifier ending in backlog + note + one recorded notify call;
# an oversized task or a repeated finding set going to the Split step (second
# pass skipped, backlog sub-tasks, parent noted, one notify), and a split with
# no usable sub-task falling back to a plain backlog close.
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
mkdir -p "$HOME" "$TMP/work" "$TMP/other" "$TMP/bin"
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
# A `-p` call without `--input-format` (the runner's stages stream) is a typed
# `agent` node's one tool-less call (naru task 2021): by default
# the answer a correct model would give, read off the text between the markers
# (the plan's last line; each report's last line); typed.plan / typed.review
# stage a raw reply instead, and every prompt is logged in typed-msgs.<kind>.
if [ "$1" = "-p" ] && [[ " $* " != *" --input-format "* ]]; then
  prompt="${@: -1}"
  case "$prompt" in *"VERIFY REPORT"*) kind=review ;; *) kind=plan ;; esac
  printf '%s\n' "$prompt" | jq -Rs . >> "$STUB/typed-msgs.$kind"
  last() { grep . | tail -n 1; }
  if [ -f "$STUB/typed.$kind" ]; then reply=$(cat "$STUB/typed.$kind")
  elif [ "$kind" = plan ]; then
    case "$(sed -n '/^<<<PLAN$/,/^PLAN>>>$/p' <<<"$prompt" | grep -v '^<<<PLAN$\|^PLAN>>>$' | last)" in
      "UI: yes") reply='{"ui":true}' ;; *) reply='{"ui":false}' ;; esac
  else
    v() { case "$(last)" in "VERDICT: PASS") echo PASS ;; "VERDICT: FAIL") echo FAIL ;; *) echo NONE ;; esac; }
    a=$(sed -n '/^=== VERIFY REPORT ===$/,/^=== REVIEW REPORT ===$/p' <<<"$prompt" | grep -v '^===' | v)
    b=$(sed -n '/^=== REVIEW REPORT ===$/,/^REPORTS>>>$/p' <<<"$prompt" | grep -v '^===\|^REPORTS>>>$' | v)
    reply=$(jq -nc --arg a "$a" --arg b "$b" '{verify:$a,review:$b}')
  fi
  jq -nc --arg r "$reply" '{type:"result",subtype:"success",is_error:false,result:$r}'
  exit 0
fi
agent=$(sed -n 's/.*--agent \([^ ]*\).*/\1/p' <<<"$*")
[ -f "$STUB/die.$agent" ] && exit 1
while IFS= read -r line; do
  text=$(jq -r '.message.content[0].text' <<<"$line")
  jq -Rn --arg t "$text" '$t' >> "$STUB/msgs.$agent"
  printf 'turn\n' >> "$STUB/turns.$agent"
  [ -f "$STUB/hang.$agent" ] && { while :; do sleep 1; done; }
  if [ "$agent" = implementer ] && [ -f "$STUB/touch.implementer" ]; then while IFS= read -r f; do mkdir -p "$(dirname "$f")"; echo "$RANDOM" >> "$f"; done < "$STUB/touch.implementer"; fi
  n=$(grep -c . "$STUB/turns.$agent")
  reply=ok
  if [ "$agent" = planner ] && [ "$n" -ge 2 ] && [ -f "$STUB/split.json" ]; then reply=$(cat "$STUB/split.json")
  elif [ -f "$STUB/reply.$agent.$n" ]; then reply=$(cat "$STUB/reply.$agent.$n")
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
[ -e "$STUB/die.vox" ] && { echo "vox: down" >&2; exit 1; }
printf '{"ok":true,"message_id":42,"chat_id":7}\n'
STUBEOF
chmod +x "$STUB/vox"
export MESA_VOX_BIN="$STUB/vox"

reset_stub() { rm -f "$STUB"/touch.* "$STUB"/reply.* "$STUB"/die.* "$STUB"/hang.* "$STUB"/turns.* "$STUB"/msgs.* "$STUB"/typed.* "$STUB"/typed-msgs.* "$STUB"/split.json "$STUB/vox.log"; }
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
# Every built-in is installed (naru task 2118): the two loop workflows on, the two KB ones off.
jq -e '(.created|length)==4 and .created[0].workflow.name=="Task loop" and .skipped==[] and (.created[0].nodes|length)==29 and .created[1].workflow.name=="Task loop: implement and review" and (.created[1].nodes|length)==8 and ([.created[] | select(.workflow.name | startswith("KB: ")) | .workflow.enabled] == [false,false])' <<<"$OUT" >/dev/null || fail "defaults: $OUT"
ok "defaults --task-loop creates the Task loop workflow"
OUT=$("$NARU" workflow defaults --task-loop --project loopproj)
jq -e '.created==[] and (.skipped|sort)==["KB: mine past sessions","KB: ongoing capture","Task loop","Task loop: implement and review"]' <<<"$OUT" >/dev/null || fail "rerun: $OUT"
[ "$("$NARU" workflow list | jq length)" = 4 ] || fail "rerun or --task-loop left extra workflows"
WF=$("$NARU" workflow show "Task loop")
ok "a rerun is a no-op; no ambient workflows were created"

mk() { "$NARU" task create loopproj "$1" | jq -r .id; }
run_loop() { "$NARU" workflow run "Task loop" --input "$1"; }
# metric <task id> <verdict> <iterations> <outcome> <label>: the task-loop-metrics
# log holds exactly one line for the run, with that verdict/iterations/outcome.
metric() {
  local got
  got=$("$NARU" workflow log task-loop-metrics --limit 1000 | jq -r --arg t "task=$1 " '.[] | select(.text | startswith($t)) | .text')
  [ "$got" = "task=$1 verdict=$2 iterations=$3 outcome=$4" ] || fail "$5: metric line(s): [$got]"
}

# asked <task id> <outcome> <label>: exactly one notice row in the ask queue for the run
asked() {
  local n
  n=$("$NARU" ask list | jq --arg t "task $1: $2." '[.[] | select(.body | contains("Task loop notice") and contains($t))] | length')
  [ "$n" = 1 ] || fail "$3: expected one '$2' notice for task $1, found $n"
}

# ---- 1. non-UI pass ----
reset_stub
printf 'Plan: edit foo.\nUI: no' > "$STUB/reply.planner"
printf 'looks fine\nVERDICT: PASS' > "$STUB/reply.verifier"
printf 'clean\nVERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf 'foo.txt\nsub dir/bar baz.txt\nseed.txt\n' > "$STUB/touch.implementer"
T=$(mk "Fix the foo bug")
"$NARU" live start --no-agent >/dev/null || fail "pass: live start"
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] || fail "pass: run $(jq -c '{status,error}' <<<"$R")"
[ "$(tstatus "$T")" = done ] || fail "pass: task is $(tstatus "$T")"
"$NARU" task show "$T" | jq -e '.result | test("passed review")' >/dev/null || fail "pass: no result on the task"
[ "$(step "$R" "UX designer")" = skipped ] || fail "pass: UX node was $(step "$R" "UX designer")"
[ "$(step "$R" "Implement + review #2")" = skipped ] || fail "pass: Implement #2 was $(step "$R" "Implement + review #2")"
[ "$(step "$R" "Close: pass")" = ok ] && [ "$(step "$R" "Close: backlog")" = skipped ] || fail "pass: close nodes"
[ "$(turns ux-designer)" = "" ] && [ "$(turns implementer)" = 1 ] && [ "$(turns verifier)" = 1 ] || fail "pass: turn counts"
[ ! -e "$STUB/vox.log" ] || fail "pass: notify was called"
grep -q -- "Fix the foo bug" "$STUB/msgs.planner" || fail "pass: the planner brief lacks the task"
# the multi-repo split rule (naru task 2066) reaches the planner and implementer briefs
for ag in planner implementer; do
  grep -qF "naru task create <project>" "$STUB/msgs.$ag" && grep -qF "naru task block <this task id> --by" "$STUB/msgs.$ag" && grep -qF "Never conclude that this task fails because it is multi-repo" "$STUB/msgs.$ag" || fail "pass: the $ag brief lacks the multi-repo split rule"
done
ls "$HOME"/.naru/loop/"$T"-*/plan.md >/dev/null || fail "pass: no scratch hand-off"
[ "$(step "$R" "Commit")" = ok ] || fail "pass: Commit was $(step "$R" "Commit")"
git -C "$TMP/work" log -1 --format=%s | grep -q "task $T" || fail "pass: commit subject: $(git -C "$TMP/work" log -1 --format=%s)"
[ "$(git -C "$TMP/work" show --name-only --format= HEAD | sort | tr '\n' ',')" = "foo.txt,seed.txt,sub dir/bar baz.txt," ] || fail "pass: commit files: $(git -C "$TMP/work" show --name-only --format= HEAD | tr '\n' ',')"
[ -z "$(git -C "$TMP/work" status --porcelain)" ] || fail "pass: tree not clean after the commit"
# the commit is recorded on the task as <repo>@<sha> (naru task 2098)
[ "$("$NARU" task show "$T" | jq -r .artifact)" = "work@$(git -C "$TMP/work" rev-parse --short HEAD)" ] || fail "pass: artifact is $("$NARU" task show "$T" | jq -r .artifact)"
[ "$(step "$R" "Plan UI verdict")" = ok ] && [ "$(step "$R" "Implement + review #1")" = ok ] || fail "pass: the typed agent nodes or the first pass did not run"
[ "$(step "$R" "Implement + review #2")" = skipped ] || fail "pass: the second pass was $(step "$R" "Implement + review #2")"
grep -q "VERDICT: PASS" "$STUB/typed-msgs.review" || fail "pass: the reports did not reach the typed verdict agent"
metric "$T" PASS 1 done pass
asked "$T" done pass
[ "$(step "$R" "Notify live agent")" = ok ] || fail "pass: notify step was $(step "$R" "Notify live agent")"
# the landing result is one line, sent by Commit, carrying the commit hash (naru task 2088)
# results are handed out by listen, once each: drain them
RES=""
while :; do
  L=$("$NARU" live listen --wait 0)
  [ "$L" = null ] && break
  RES="$RES$(jq -r '.text // .result // empty' <<<"$L")"$'\n'
done
N=$(grep -c "^Task $T done:" <<<"$RES" || true)
[ "$N" = 1 ] || fail "pass: expected one landing result for task $T, found $N in: $RES"
grep -Eq "^Task $T done: .*Commit/artifact: .*@[0-9a-f]{7,}" <<<"$RES" || fail "pass: landing result lacks the commit hash: $RES"
"$NARU" live stop >/dev/null || fail "pass: live stop"
ok "non-UI pass: UX and Implement #2 skipped, task done with a result, no notify, exactly the changed files committed"

# ---- 1b. a plan mentioning HEAD~1: the briefs carry the no-commit rule, "not committed" is no failure (naru task 2047) ----
reset_stub
printf 'Plan: edit baz. Metric: git diff HEAD~1 shows baz.txt.\nUI: no' > "$STUB/reply.planner"
printf "looks fine\nVERDICT: PASS" > "$STUB/reply.verifier"
printf 'clean\nVERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf 'baz.txt\n' > "$STUB/touch.implementer"
T=$(mk "Fix the baz bug")
R=$(run_loop "$T")
for a in planner implementer verifier diff-reviewer; do
  grep -q "Never use .HEAD~1" "$STUB/msgs.$a" || fail "head1: the $a brief lacks the no-commit rule"
done
! grep -q "Live UI check" "$STUB/msgs.verifier" && ! grep -q "Live UI check" "$STUB/msgs.diff-reviewer" || fail "head1: a non-UI brief carries the live-check rule"
grep -q "not committed" "$STUB/typed-msgs.review" && grep -q "only reason for FAIL" "$STUB/typed-msgs.review" || fail "head1: the verdict prompt lacks the guard"
ok "plan, implement, verify and review briefs carry the no-commit rule; the verdict prompt carries the guard"

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
grep -q "Live UI check (required)" "$STUB/msgs.ui-verifier" && grep -q "allowed only if those checks actually ran" "$STUB/msgs.ui-verifier" || fail "ui: the ui-verifier brief lacks the live-check rule"
! grep -q "Live UI check" "$STUB/msgs.diff-reviewer" || fail "ui: the reviewer brief carries the live-check rule"
metric "$T" PASS 1 done ui
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
[ "$(step "$R" "Implement + review #2")" = ok ] || fail "fix: second pass did not run"
[ "$(turns implementer)" = 2 ] || fail "fix: implementer turns $(turns implementer)"
sed -n 2p "$STUB/msgs.implementer" | grep -q "bug in bar()" || fail "fix: findings missing from the second implementer brief"
[ ! -e "$STUB/vox.log" ] || fail "fix: notify was called"
metric "$T" PASS 2 done fix
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
metric "$T" NEEDS-FIX 2 backlog twice
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
[ "$(step "$R" "Implement + review #2")" = skipped ] || fail "inconclusive: looped on an inconclusive verifier"
"$NARU" task show "$T" | jq -e '.notes | length == 1 and (.[0].body | test("INCONCLUSIVE"))' >/dev/null || fail "inconclusive: note: $("$NARU" task show "$T" | jq -c .notes)"
[ "$(grep -c -- '--call--' "$STUB/vox.log")" = 1 ] || fail "inconclusive: notify calls"
grep -q -- "Task $T needs a person" "$STUB/vox.log" || fail "inconclusive: notify message: $(cat "$STUB/vox.log")"
grep -q -- "/open/tasks/$T" "$STUB/vox.log" || fail "inconclusive: notify button: $(cat "$STUB/vox.log")"
[ ! -e "$STUB/typed-msgs.review" ] || fail "inconclusive: the verdict agent read a stage that did not finish"
metric "$T" INCONCLUSIVE 1 backlog inconclusive
ok "inconclusive verifier: backlog + note + one recorded notify call"

# ---- 6. a planner that never answers -> backlog, nothing implemented ----
reset_stub
touch "$STUB/die.planner"
T=$(mk "Fix nothing")
R=$(run_loop "$T")
[ "$(tstatus "$T")" = backlog ] && [ "$(step "$R" "Implement + review #1")" = skipped ] || fail "planner: task $(tstatus "$T"), impl $(step "$R" "Implement + review #1")"
metric "$T" none 0 backlog planner
ok "an inconclusive planner ends in backlog without implementing"

# ---- 6a. a per-stage clock (naru task 2082): NARU_LOOP_DEADLINE_PLAN cuts a hung
# planner well before the global 20s clock would, and the loop still ends in backlog ----
reset_stub
touch "$STUB/hang.planner"
T=$(mk "Fix nothing, hung planner")
t0=$SECONDS
R=$(NARU_LOOP_DEADLINE_PLAN=2 run_loop "$T")
el=$((SECONDS - t0))
[ "$el" -lt 18 ] || fail "per-stage clock: planner took ${el}s, the global clock applied"
[ "$(tstatus "$T")" = backlog ] && [ "$(step "$R" "Implement + review #1")" = skipped ] || fail "per-stage clock: task $(tstatus "$T")"
ok "NARU_LOOP_DEADLINE_PLAN times out only the planner stage"

# ---- 6b. an implementer that never answers: the child ends at Implemented?,
# its output carries no review token, so Verdict #1 takes default -> backlog ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
touch "$STUB/die.implementer"
T=$(mk "Fix nothing either")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] && [ "$(tstatus "$T")" = backlog ] || fail "impl failed: $(jq -c '{status,error}' <<<"$R") task $(tstatus "$T")"
[ "$(step "$R" "Implement + review #1")" = ok ] && [ "$(step "$R" "Implement + review #2")" = skipped ] && [ "$(step "$R" "Close: backlog")" = ok ] || fail "impl failed: the passes or Close: backlog"
ok "a failed implement ends the child pass and the loop in backlog, no second pass"

# ---- 7. a tree dirty before the run -> the task's own file is committed, the stray one is left ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf 'new.txt\n' > "$STUB/touch.implementer"
echo stray > "$TMP/work/stray.txt"
before=$(git -C "$TMP/work" rev-parse HEAD)
T=$(mk "Fix dirty")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] || fail "dirty: run $(jq -c '{status,error}' <<<"$R")"
[ "$(tstatus "$T")" = done ] && [ "$(step "$R" "Commit")" = ok ] || fail "dirty: task $(tstatus "$T"), Commit $(step "$R" "Commit")"
[ "$(git -C "$TMP/work" rev-parse HEAD)" != "$before" ] || fail "dirty: no commit was made"
[ "$(git -C "$TMP/work" show --name-only --format= HEAD)" = new.txt ] || fail "dirty: commit holds $(git -C "$TMP/work" show --name-only --format= HEAD)"
[ "$(git -C "$TMP/work" status --porcelain)" = "?? stray.txt" ] || fail "dirty: tree: $(git -C "$TMP/work" status --porcelain)"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("stray.txt")) and any(test("^Committed "))' >/dev/null || fail "dirty: notes"
ok "a dirty baseline no longer refuses: the task's file is committed, the stray one stays dirty and is noted"
rm -f "$TMP/work/stray.txt"

# ---- 7b. a path dirty before the run and changed again by it rides along; the tree ends clean ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf 'rider.txt\nnew2.txt\n' > "$STUB/touch.implementer"
echo early > "$TMP/work/rider.txt"
T=$(mk "Fix rider")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] && [ "$(step "$R" "Commit")" = ok ] || fail "rider: run $(jq -c '{status,error}' <<<"$R")"
[ "$(git -C "$TMP/work" show --name-only --format= HEAD | sort | tr '\n' ' ')" = "new2.txt rider.txt " ] || fail "rider: commit holds $(git -C "$TMP/work" show --name-only --format= HEAD)"
[ -z "$(git -C "$TMP/work" status --porcelain)" ] || fail "rider: tree not clean: $(git -C "$TMP/work" status --porcelain)"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("rider.txt") and test("earlier edits"))' >/dev/null || fail "rider: notes"
ok "a pre-dirty path the task changed again is committed with a note, and the tree ends clean"

# ---- 7c. a pre-dirty path the committed files need (naru task 2041): the build gate folds it in ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf 'use.txt\n' > "$STUB/touch.implementer"
echo needed > "$TMP/work/dep.txt"
T=$(mk "Fix needs dep")
R=$(NARU_LOOP_COMMIT_CHECK='[ ! -e use.txt ] || [ -e dep.txt ]' run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] && [ "$(step "$R" "Commit")" = ok ] || fail "gate: run $(jq -c '{status,error}' <<<"$R"), Commit $(step "$R" "Commit")"
[ "$(git -C "$TMP/work" show --name-only --format= HEAD | sort | tr '\n' ' ')" = "dep.txt use.txt " ] || fail "gate: commit holds $(git -C "$TMP/work" show --name-only --format= HEAD)"
[ -z "$(git -C "$TMP/work" status --porcelain)" ] || fail "gate: tree not clean: $(git -C "$TMP/work" status --porcelain)"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("did not build") and test("dep.txt"))' >/dev/null || fail "gate: notes"
ok "a skipped pre-dirty path the commit needs is folded in by the build gate, tree clean, noted"

# ---- 7d. a commit that does not build and cannot be fixed: noted, notified, not reported as committed ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf 'broken.txt\n' > "$STUB/touch.implementer"
echo stray2 > "$TMP/work/stray2.txt"
T=$(mk "Fix unbuildable")
R=$(NARU_LOOP_COMMIT_CHECK='[ ! -e broken.txt ]' run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] || fail "gate fail: run $(jq -c '{status,error}' <<<"$R")"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("does not build")) and (any(test("^Committed ")) | not)' >/dev/null || fail "gate fail: notes: $("$NARU" task show "$T" | jq -c .notes)"
[ "$(tstatus "$T")" = backlog ] || fail "gate fail: task is $(tstatus "$T"), not backlog"
grep -q -- "does not build" "$STUB/vox.log" || fail "gate fail: no notify: $(cat "$STUB/vox.log" 2>/dev/null)"
[ "$(git -C "$TMP/work" status --porcelain)" = "?? stray2.txt" ] || fail "gate fail: stray file was swept in: $(git -C "$TMP/work" status --porcelain)"
rm -f "$TMP/work/stray2.txt"
ok "an unfixable unbuildable commit is noted, notified, bounced to backlog and never reported as committed"
# a missing build tool (exit 127, the "cargo: command not found" case) bounces the same way
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf 'missing.txt\n' > "$STUB/touch.implementer"
T=$(mk "Fix no toolchain")
R=$(NARU_LOOP_COMMIT_CHECK='nonexistent-cmd-xyz' run_loop "$T")
[ "$(tstatus "$T")" = backlog ] || fail "gate 127: task is $(tstatus "$T"), not backlog"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("does not build")) and (any(test("^Committed ")) | not)' >/dev/null || fail "gate 127: notes"
ok "a missing build tool bounces the task to backlog too"

# ---- 7e. a bounced run restores its debris; a pre-dirty file goes back as it was ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'still broken\nVERDICT: FAIL' > "$STUB/reply.diff-reviewer"
printf 'draft.txt\nseed.txt\npre.txt\n' > "$STUB/touch.implementer"
echo early > "$TMP/work/pre.txt"
git -C "$TMP/work" status --porcelain > /dev/null
T=$(mk "Fix bounce debris")
R=$(run_loop "$T")
[ "$(tstatus "$T")" = backlog ] || fail "debris: task $(tstatus "$T")"
[ ! -e "$TMP/work/draft.txt" ] || fail "debris: untracked draft left behind"
git -C "$TMP/work" diff --quiet -- seed.txt || fail "debris: tracked file still modified"
[ "$(cat "$TMP/work/pre.txt")" = early ] || fail "debris: pre-dirty file is $(cat "$TMP/work/pre.txt")"
[ "$(git -C "$TMP/work" status --porcelain)" = "?? pre.txt" ] || fail "debris: tree: $(git -C "$TMP/work" status --porcelain)"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("Restored to their state") and test("draft.txt"))' >/dev/null || fail "debris: note"
rm -f "$TMP/work/pre.txt"
ok "a bounced run puts back its debris and leaves a pre-dirty file as it found it"

# ---- 7f. a task in another project: Commit, the baseline and the debris restore run in that project's repo (naru task 2044) ----
git -C "$TMP/other" init -q
git -C "$TMP/other" config user.email t@t
git -C "$TMP/other" config user.name t
echo seed > "$TMP/other/oseed.txt"
git -C "$TMP/other" add oseed.txt
git -C "$TMP/other" commit -q -m seed
"$NARU" project create otherproj --no-git --path "$TMP/other" >/dev/null
mko() { "$NARU" task create otherproj "$1" | jq -r .id; }
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf '%s\n' "$TMP/other/other.txt" > "$STUB/touch.implementer"
echo ostray > "$TMP/other/ostray.txt"
wbefore=$(git -C "$TMP/work" rev-parse HEAD)
obefore=$(git -C "$TMP/other" rev-parse HEAD)
T=$(mko "Fix in the other repo")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] && [ "$(tstatus "$T")" = done ] && [ "$(step "$R" "Commit")" = ok ] || fail "cross: run $(jq -c '{status,error}' <<<"$R") task $(tstatus "$T")"
[ "$(git -C "$TMP/other" rev-parse HEAD)" != "$obefore" ] || fail "cross: nothing committed in the task's repo"
git -C "$TMP/other" log -1 --format=%s | grep -q "task $T" || fail "cross: commit subject: $(git -C "$TMP/other" log -1 --format=%s)"
[ "$(git -C "$TMP/other" show --name-only --format= HEAD)" = other.txt ] || fail "cross: commit holds $(git -C "$TMP/other" show --name-only --format= HEAD)"
[ "$(git -C "$TMP/other" status --porcelain)" = "?? ostray.txt" ] || fail "cross: other tree: $(git -C "$TMP/other" status --porcelain)"
[ "$(git -C "$TMP/work" rev-parse HEAD)" = "$wbefore" ] || fail "cross: the workflow repo got a commit"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("^Committed [0-9a-f]+ by the task loop")) and any(test("ostray.txt"))' >/dev/null || fail "cross: notes"
metric "$T" PASS 1 done cross
ok "a task in another project is committed in that project's repo, its pre-dirty file left, the workflow repo untouched"
rm -f "$TMP/other/ostray.txt"

# a task changing both repos: one commit in each, reported together
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf '%s\n%s\n' "$TMP/other/both-o.txt" "$TMP/work/both-w.txt" > "$STUB/touch.implementer"
wbefore=$(git -C "$TMP/work" rev-parse HEAD)
obefore=$(git -C "$TMP/other" rev-parse HEAD)
T=$(mko "Fix in both repos")
R=$(run_loop "$T")
[ "$(tstatus "$T")" = done ] && [ "$(step "$R" "Commit")" = ok ] || fail "both: task $(tstatus "$T"), Commit $(step "$R" "Commit")"
[ "$(git -C "$TMP/other" show --name-only --format= HEAD)" = both-o.txt ] && [ "$(git -C "$TMP/other" rev-parse HEAD)" != "$obefore" ] || fail "both: other commit"
[ "$(git -C "$TMP/work" show --name-only --format= HEAD)" = both-w.txt ] && [ "$(git -C "$TMP/work" rev-parse HEAD)" != "$wbefore" ] || fail "both: work commit"
[ -z "$(git -C "$TMP/other" status --porcelain)$(git -C "$TMP/work" status --porcelain)" ] || fail "both: a tree is dirty"
"$NARU" task show "$T" | jq -e '[.notes[].body | select(test("^Committed "))] | length == 2' >/dev/null || fail "both: commit notes"
ok "a task changing two repos gets one commit in each"

# a bounce restores debris in the task's repo too, a pre-dirty file there as it was
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'still broken\nVERDICT: FAIL' > "$STUB/reply.diff-reviewer"
printf '%s\n%s\n%s\n' "$TMP/other/odraft.txt" "$TMP/other/oseed.txt" "$TMP/other/opre.txt" > "$STUB/touch.implementer"
echo early > "$TMP/other/opre.txt"
T=$(mko "Fix other bounce")
R=$(run_loop "$T")
[ "$(tstatus "$T")" = backlog ] || fail "cross debris: task $(tstatus "$T")"
[ ! -e "$TMP/other/odraft.txt" ] || fail "cross debris: untracked draft left behind"
git -C "$TMP/other" diff --quiet -- oseed.txt || fail "cross debris: tracked file still modified"
[ "$(cat "$TMP/other/opre.txt")" = early ] && [ "$(git -C "$TMP/other" status --porcelain)" = "?? opre.txt" ] || fail "cross debris: tree: $(git -C "$TMP/other" status --porcelain)"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("Restored to their state") and test("odraft.txt"))' >/dev/null || fail "cross debris: note"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("Diffs saved:") and test("run.diff") and test("Still dirty after restore") and test("opre.txt"))' >/dev/null || fail "cross debris: diff/leftover note"
# the loop is global (naru task 2103) and enters the task's own project first, so that repo's state is the scratch dir itself
grep -q oseed "$HOME"/.naru/loop/"$T"-*/debris/run.diff || fail "cross debris: run.diff missing the edit"
rm -f "$TMP/other/opre.txt"
ok "a bounced run in another project's repo puts back its debris there, saves its diff and reports what is still dirty"

# ---- 7g. a third repo (naru task 2058): committed when the task names it, when a path dependency points at it, and when only the project scan finds it ----
git -C "$TMP/sibling" init -q 2>/dev/null || { mkdir -p "$TMP/sibling"; git -C "$TMP/sibling" init -q; }
git -C "$TMP/sibling" config user.email t@t
git -C "$TMP/sibling" config user.name t
echo seed > "$TMP/sibling/sseed.txt"
git -C "$TMP/sibling" add sseed.txt
git -C "$TMP/sibling" commit -q -m seed
"$NARU" project create siblingproj --no-git --path "$TMP/sibling" >/dev/null
echo spre > "$TMP/sibling/spre.txt"
sib_commit() { # <label> <file>: one new commit in sibling holding exactly <file>, nothing in work/other, pre-dirty file left
  [ "$(git -C "$TMP/sibling" rev-parse HEAD)" != "$sbefore" ] || fail "$1: nothing committed in sibling"
  [ "$(git -C "$TMP/sibling" show --name-only --format= HEAD)" = "$2" ] || fail "$1: sibling commit holds $(git -C "$TMP/sibling" show --name-only --format= HEAD)"
  [ "$(git -C "$TMP/sibling" status --porcelain)" = "?? spre.txt" ] || fail "$1: sibling tree: $(git -C "$TMP/sibling" status --porcelain)"
  [ "$(git -C "$TMP/work" rev-parse HEAD)" = "$wbefore" ] && [ "$(git -C "$TMP/other" rev-parse HEAD)" = "$obefore" ] || fail "$1: work or other got a commit"
  [ -z "$(git -C "$TMP/work" status --porcelain)$(git -C "$TMP/other" status --porcelain)" ] || fail "$1: work or other is dirty"
  "$NARU" task show "$T" | jq -e '.notes | (map(.body) | any(test("^Committed [0-9a-f]+ by the task loop in .*sibling"))) and (map(.body) | any(test("task loop commit \\(.*\\/(work|other)\\)"; "i")) | not)' >/dev/null || fail "$1: notes: $("$NARU" task show "$T" | jq -c .notes)"
}
sib_before() { wbefore=$(git -C "$TMP/work" rev-parse HEAD); obefore=$(git -C "$TMP/other" rev-parse HEAD); sbefore=$(git -C "$TMP/sibling" rev-parse HEAD); }
loop_ok() { [ "$(jq -r .status <<<"$R")" = succeeded ] && [ "$(tstatus "$T")" = done ] && [ "$(step "$R" "Commit")" = ok ] || fail "$1: run $(jq -c '{status,error}' <<<"$R") task $(tstatus "$T")"; }
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"

# named in the description
printf '%s\n' "$TMP/sibling/x.txt" > "$STUB/touch.implementer"
sib_before
T=$("$NARU" task create loopproj "Fix a thing in $TMP/sibling/x.txt" | jq -r .id)
R=$(run_loop "$T")
loop_ok named
# the safety net (naru task 2066): a cross-repo edit with no split is committed and noted, never a failed task
[ "$(tstatus "$T")" != backlog ] || fail "named: a cross-repo edit failed the task"
sib_commit named x.txt
grep -qxF "$(cd "$TMP/sibling" && pwd -P)" "$HOME"/.naru/loop/"$T"-*/repos.txt || fail "named: sibling missing from repos.txt"
ok "a repo the task names is committed, an untouched project repo stays silent, a pre-dirty file is left"

# found by the project scan alone
printf '%s\n' "$TMP/sibling/y.txt" > "$STUB/touch.implementer"
sib_before
T=$(mk "Fix a thing nobody named")
R=$(run_loop "$T")
loop_ok scan
sib_commit scan y.txt
grep -qxF "$(cd "$TMP/sibling" && pwd -P)" "$HOME"/.naru/loop/"$T"-*/repos.txt && fail "scan: sibling should only be scanned, not in repos.txt"
ok "a change in a repo nothing names is committed by the project scan"

# a path dependency in the task project's Package.swift
printf '// swift-tools-version:5.9\nlet p = Package(dependencies: [.package(path: "../sibling")])\n' > "$TMP/other/Package.swift"
printf '%s\n' "$TMP/sibling/z.txt" > "$STUB/touch.implementer"
sib_before
T=$(mko "Fix a thing with a path dependency")
R=$(run_loop "$T")
loop_ok dep
grep -qxF "$(cd "$TMP/sibling" && pwd -P)" "$HOME"/.naru/loop/"$T"-*/repos.txt || fail "dep: sibling missing from repos.txt"
[ "$(git -C "$TMP/sibling" show --name-only --format= HEAD)" = z.txt ] || fail "dep: sibling commit"
rm -f "$TMP/other/Package.swift" "$TMP/sibling/spre.txt"
ok "a path dependency of the task's project pulls its repo in"

# ---- 7h. two loops at once (naru task 2104): a repo another live run owns is not swept into this run's commit ----
# Run Y (a task of loopproj, repo $TMP/work) is live: its registry entry names $TMP/work as its primary and its task is in_progress.
# Run X (a task of otherproj) changes both repos; its Commit must commit only $TMP/other and leave Y's repo alone.
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf '%s\n%s\n' "$TMP/other/x-o.txt" "$TMP/work/y-wip.txt" > "$STUB/touch.implementer"
TY=$(mk "Task Y, running in the work repo")
"$NARU" task update "$TY" --status in_progress >/dev/null
mkdir -p "$HOME/.naru/loop/active"
printf '%s\t%s\n' "$(git -C "$TMP/work" rev-parse --show-toplevel)" "$TMP/ysratch" > "$HOME/.naru/loop/active/$TY"
wbefore=$(git -C "$TMP/work" rev-parse HEAD)
obefore=$(git -C "$TMP/other" rev-parse HEAD)
T=$(mko "Task X, in the other repo")
R=$(run_loop "$T")
[ "$(tstatus "$T")" = done ] && [ "$(step "$R" "Commit")" = ok ] || fail "concurrent: task $(tstatus "$T"), Commit $(step "$R" "Commit")"
[ "$(git -C "$TMP/other" show --name-only --format= HEAD)" = x-o.txt ] && [ "$(git -C "$TMP/other" rev-parse HEAD)" != "$obefore" ] || fail "concurrent: other commit"
[ "$(git -C "$TMP/work" rev-parse HEAD)" = "$wbefore" ] || fail "concurrent: foreign_files_in_commit > 0: the work repo got a commit"
[ "$(git -C "$TMP/work" status --porcelain)" = "?? y-wip.txt" ] || fail "concurrent: Y's file not left dirty: $(git -C "$TMP/work" status --porcelain)"
"$NARU" task show "$T" | jq -e --arg y "$TY" '.notes | map(.body) | any(test("left uncommitted") and test("task " + $y))' >/dev/null || fail "concurrent: skip note"
[ ! -e "$HOME/.naru/loop/active/$T" ] || fail "concurrent: X's registry entry not removed"
ok "a repo another live run owns is left uncommitted and noted; the run's own repo is committed"
# the same run once Y is no longer in progress (a crashed/finished run): the cross-repo change is committed again
"$NARU" task update "$TY" --status done >/dev/null
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf '%s\n' "$TMP/work/z-w.txt" > "$STUB/touch.implementer"
T=$(mko "Task Z, after Y ended")
R=$(run_loop "$T")
[ "$(tstatus "$T")" = done ] || fail "stale entry: task $(tstatus "$T")"
git -C "$TMP/work" show --name-only --format= HEAD | grep -qx z-w.txt || fail "stale entry: work repo not committed"
rm -f "$HOME/.naru/loop/active/$TY" "$TMP/work/y-wip.txt"
ok "an entry whose task is no longer in progress does not block a cross-repo commit"

# ---- 7i. a task whose job is to land a change already dirty before the run (naru task 2169): the run
# changes nothing, the pre-dirty file the task names is committed, an unrelated pre-dirty one is left ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
echo v1 > "$TMP/work/landme.txt"
git -C "$TMP/work" add landme.txt
git -C "$TMP/work" commit -q -m landme
echo v2 > "$TMP/work/landme.txt"
echo stray > "$TMP/work/stray7i.txt"
# a scanned sibling (siblingproj, after the work repo in the driver's loop) holds a pre-dirty file of the same name
echo sib > "$TMP/sibling/landme.txt"
sbefore=$(git -C "$TMP/sibling" rev-parse HEAD)
before=$(git -C "$TMP/work" rev-parse HEAD)
T=$(mk "Land the uncommitted change in landme.txt")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] || fail "named pre-dirty: run $(jq -c '{status,error}' <<<"$R")"
[ "$(tstatus "$T")" = done ] && [ "$(step "$R" "Commit")" = ok ] || fail "named pre-dirty: task $(tstatus "$T"), Commit $(step "$R" "Commit")"
[ "$(git -C "$TMP/work" rev-parse HEAD)" != "$before" ] || fail "named pre-dirty: named_predirty_committed = 0, a silent done with nothing committed"
[ "$(git -C "$TMP/work" show --name-only --format= HEAD)" = landme.txt ] || fail "named pre-dirty: commit holds $(git -C "$TMP/work" show --name-only --format= HEAD)"
[ "$(git -C "$TMP/work" status --porcelain)" = "?? stray7i.txt" ] || fail "named pre-dirty: unrelated_predirty_left = 0: $(git -C "$TMP/work" status --porcelain)"
"$NARU" task show "$T" | jq -e '.artifact | test("^work@[0-9a-f]+$")' >/dev/null || fail "named pre-dirty: artifact $("$NARU" task show "$T" | jq -r .artifact)"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("landme.txt") and test("named by the task")) and any(test("stray7i.txt") and test("left uncommitted"))' >/dev/null || fail "named pre-dirty: notes"
[ "$(git -C "$TMP/sibling" rev-parse HEAD)" = "$sbefore" ] && [ "$(git -C "$TMP/sibling" status --porcelain)" = "?? landme.txt" ] || fail "named pre-dirty: scanned sibling swept: $(git -C "$TMP/sibling" status --porcelain)"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("task loop commit \\(.*/sibling\\)"; "i")) | not' >/dev/null || fail "named pre-dirty: a note for the scanned sibling: $("$NARU" task show "$T" | jq -c .notes)"
ok "a pre-dirty file the task names is committed when the run changes nothing; an unrelated one and a scanned repo's same-named one stay dirty and silent"
rm -f "$TMP/work/stray7i.txt" "$TMP/sibling/landme.txt"

# ---- 7j. the task names a pre-dirty file in another repo by absolute path (naru task 2169): that repo's
# file is committed; the work repo's pre-dirty file of the same name (`/landme.txt` in the text) stays ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
SIBP=$(cd "$TMP/sibling" && pwd -P)
echo v1 > "$TMP/sibling/landme.txt"
git -C "$TMP/sibling" add landme.txt
git -C "$TMP/sibling" commit -q -m landme
echo v2 > "$TMP/sibling/landme.txt"
echo v3 > "$TMP/work/landme.txt"
sbefore=$(git -C "$TMP/sibling" rev-parse HEAD)
before=$(git -C "$TMP/work" rev-parse HEAD)
T=$(mk "Land the uncommitted change in $SIBP/landme.txt")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] || fail "other-repo pre-dirty: run $(jq -c '{status,error}' <<<"$R")"
[ "$(tstatus "$T")" = done ] && [ "$(step "$R" "Commit")" = ok ] || fail "other-repo pre-dirty: task $(tstatus "$T"), Commit $(step "$R" "Commit")"
grep -qxF "$SIBP" "$HOME"/.naru/loop/"$T"-*/repos.txt || fail "other-repo pre-dirty: sibling missing from repos.txt"
[ "$(git -C "$TMP/sibling" rev-parse HEAD)" != "$sbefore" ] || fail "other-repo pre-dirty: named_predirty_committed = 0 in the sibling"
[ "$(git -C "$TMP/sibling" show --name-only --format= HEAD)" = landme.txt ] || fail "other-repo pre-dirty: sibling commit holds $(git -C "$TMP/sibling" show --name-only --format= HEAD)"
[ "$(git -C "$TMP/work" rev-parse HEAD)" = "$before" ] || fail "other-repo pre-dirty: wrong_repo_predirty_committed = 1, work commit holds $(git -C "$TMP/work" show --name-only --format= HEAD)"
[ "$(git -C "$TMP/work" status --porcelain)" = " M landme.txt" ] || fail "other-repo pre-dirty: work tree: $(git -C "$TMP/work" status --porcelain)"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("/sibling\\)") and test("named by the task") and test("landme.txt")) and any(test("/work\\)") and test("left uncommitted") and test("landme.txt"))' >/dev/null || fail "other-repo pre-dirty: notes: $("$NARU" task show "$T" | jq -c .notes)"
ok "a pre-dirty file named by absolute path in another repo is committed there; the work repo's same-named one stays dirty"
git -C "$TMP/work" checkout -q -- landme.txt

# ---- 8. a failing vox send is caught: backlog, run still succeeds ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
touch "$STUB/die.verifier" "$STUB/die.vox"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
T=$(mk "Fix vox down")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] || fail "vox down: run $(jq -c '{status,error}' <<<"$R")"
[ "$(tstatus "$T")" = backlog ] && [ "$(step "$R" "Close: backlog status")" = ok ] || fail "vox down: task $(tstatus "$T")"
[ "$(step "$R" "Close: backlog notify")" = ok ] || fail "vox down: notify step $(step "$R" "Close: backlog notify")"
asked "$T" backlog "vox down"
ok "a failing notify is caught: task in backlog, run succeeded"

# ---- 8b. a node failing mid-run still sends the notice (outcome error) ----
R=$(run_loop 999999)
[ "$(jq -r .status <<<"$R")" = failed ] || fail "error: run $(jq -c '{status,error}' <<<"$R")"
[ "$(step "$R" "Notify live agent")" = ok ] || fail "error: notify step was $(step "$R" "Notify live agent")"
"$NARU" ask list | jq -e '[.[] | select(.body | contains("task 999999: error."))] | length == 1' >/dev/null || fail "error: no error notice queued"
ok "every run ends in one notice, a failed run included (outcome error)"

# ---- 9. a typed verdict that is garbage, or not conclusive -> backlog ----
reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'VERDICT: PASS' > "$STUB/reply.diff-reviewer"
printf 'definitely passes' > "$STUB/typed.review"
T=$(mk "Fix garbage verdict")
R=$(run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] || fail "garbage review: run $(jq -c '{status,error}' <<<"$R")"
[ "$(tstatus "$T")" = backlog ] || fail "garbage review: task is $(tstatus "$T") (a bad reply must never pass)"
[ "$(step "$R" "Implement + review #2")" = skipped ] || fail "garbage review: looped on a bad reply"
[ "$(grep -c . "$STUB/typed-msgs.review")" = 2 ] || fail "garbage review: expected one call and one retry, got $(grep -c . "$STUB/typed-msgs.review")"
"$NARU" task show "$T" | jq -e '.notes | length == 1 and (.[0].body | test("typed verdict"))' >/dev/null || fail "garbage review: note: $("$NARU" task show "$T" | jq -c .notes)"
printf '{"verify":"PASS","review":"NONE"}' > "$STUB/typed.review"
T=$(mk "Fix half a verdict")
R=$(run_loop "$T")
[ "$(tstatus "$T")" = backlog ] && [ "$(step "$R" "Implement + review #2")" = skipped ] || fail "half review: task $(tstatus "$T")"

printf 'definitely ui' > "$STUB/typed.plan"
T=$(mk "Fix garbage plan")
R=$(run_loop "$T")
[ "$(tstatus "$T")" = backlog ] && [ "$(step "$R" "Implement + review #1")" = skipped ] || fail "garbage plan: task $(tstatus "$T"), impl $(step "$R" "Implement + review #1")"
"$NARU" task show "$T" | jq -e '.notes | length == 1 and (.[0].body | test("typed UI verdict"))' >/dev/null || fail "garbage plan: note: $("$NARU" task show "$T" | jq -c .notes)"
ok "a garbage or inconclusive typed verdict ends in backlog with a note, never a pass; no implement stage after a bad plan reply"

# ---- 10. an oversized task, or a repeated finding set -> the split step ----
subs() { "$NARU" task list loopproj | jq -r --argjson p "$1" '[.[] | select(.parent_id == $p)] | length'; }
reset_stub
printf 'Plan: edit src/a.rs and src/b.rs.\nUI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'too much\nVERDICT: FAIL' > "$STUB/reply.diff-reviewer"
printf '[{"description":"part one\\nline two\\nline three"},{"description":"part two"}]' > "$STUB/split.json"
printf 'newpart.sh\n' > "$STUB/touch.implementer"
echo early > "$TMP/work/predirty.txt"
T=$(mk "Build the big thing")
R=$(NARU_LOOP_SPLIT_FILES=1 run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] || fail "split: run $(jq -c '{status,error}' <<<"$R")"
[ "$(step "$R" "Split")" = ok ] && [ "$(step "$R" "Implement + review #2")" = skipped ] || fail "split: second pass ran or Split did not"
[ "$(tstatus "$T")" = backlog ] && [ "$(subs "$T")" = 2 ] || fail "split: task $(tstatus "$T"), sub-tasks $(subs "$T")"
"$NARU" task list loopproj | jq -e --argjson p "$T" '[.[] | select(.parent_id == $p)] | all(.status == "backlog")' >/dev/null || fail "split: sub-tasks not in backlog"
S1=$("$NARU" task list loopproj | jq -r --argjson p "$T" '[.[] | select(.parent_id == $p)] | min_by(.id) | .id')
"$NARU" task show "$S1" | jq -e '.description | test("part one\nline two\nline three")' >/dev/null || fail "split: multi-line sub-task description not kept whole: $("$NARU" task show "$S1" | jq -c .description)"
# the parent's reverted work is carried into each sub-task, and reviewers see the pre-dirty list (naru task 2115)
[ "$("$NARU" task list loopproj | jq -r --argjson p "$T" '.[] | select(.parent_id == $p) | .id' | while read -r s; do "$NARU" task show "$s" | jq -e '.description | test("newpart\\.sh -> .*/debris/newpart\\.sh")' >/dev/null && echo y; done | grep -c y)" = 2 ] || fail "split: sub-tasks lack the debris path: $("$NARU" task show "$S1" | jq -c .description)"
DP=$("$NARU" task show "$S1" | jq -r '.description' | sed -n 's/^- newpart\.sh -> //p')
[ -f "$DP" ] || fail "split: no debris copy at [$DP]"
[ ! -e "$TMP/work/newpart.sh" ] || fail "split: newpart.sh was not reverted"
for a in verifier diff-reviewer; do
  grep -q "Dirty before this run" "$STUB/msgs.$a" && grep -q "predirty.txt" "$STUB/msgs.$a" || fail "split: the $a brief lacks the pre-dirty list"
  ! grep -q "Dirty before this run.*newpart" "$STUB/msgs.$a" || fail "split: the $a pre-dirty list names the run's own file"
done
[ "$(cat "$TMP/work/predirty.txt")" = early ] || fail "split: pre-dirty file changed"
rm -f "$TMP/work/predirty.txt"
"$NARU" task show "$T" | jq -e '.notes | map(.body) | any(test("split this task")) and any(test("Last review findings"))' >/dev/null || fail "split: notes: $("$NARU" task show "$T" | jq -c .notes)"
[ "$(turns implementer)" = 1 ] && [ "$(grep -c -- '--call--' "$STUB/vox.log")" = 1 ] || fail "split: implementer turns $(turns implementer), notify calls"
metric "$T" NEEDS-FIX 1 backlog split
asked "$T" split split
ok "oversized task: Implement #2 and Review #2 skipped, 2 backlog sub-tasks, parent in backlog with a note, one notify"

reset_stub
printf 'UI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'bug in bar()\nVERDICT: FAIL' > "$STUB/reply.diff-reviewer"
printf '[{"description":"half of it"}]' > "$STUB/split.json"
T=$(mk "Fix bar again")
mkdir -p "$HOME/.naru/loop/$T-1-1"
printf 'Iteration 1 verify report:\nVERDICT: PASS\n\nIteration 1 review report:\nBug in bar().\nVERDICT: FAIL\n' > "$HOME/.naru/loop/$T-1-1/findings.md"
R=$(run_loop "$T")
[ "$(step "$R" "Split")" = ok ] && [ "$(step "$R" "Implement + review #2")" = skipped ] && [ "$(tstatus "$T")" = backlog ] && [ "$(subs "$T")" = 1 ] || fail "repeat: Split $(step "$R" "Split"), task $(tstatus "$T"), sub-tasks $(subs "$T")"
ok "a finding set an earlier run already left goes to the split step"

reset_stub
printf 'Plan: edit src/a.rs and src/b.rs.\nUI: no' > "$STUB/reply.planner"
printf 'VERDICT: PASS' > "$STUB/reply.verifier"
printf 'bug in bar()\nVERDICT: FAIL' > "$STUB/reply.diff-reviewer"
T=$(mk "Fix a thing nobody can split")
R=$(NARU_LOOP_SPLIT_FILES=1 run_loop "$T")
[ "$(jq -r .status <<<"$R")" = succeeded ] && [ "$(tstatus "$T")" = backlog ] && [ "$(subs "$T")" = 0 ] || fail "split fallback: task $(tstatus "$T"), sub-tasks $(subs "$T")"
[ "$(step "$R" "Implement + review #2")" = skipped ] && [ "$(step "$R" "Close: backlog")" = ok ] || fail "split fallback: close nodes"
[ "$(grep -c -- '--call--' "$STUB/vox.log")" = 1 ] || fail "split fallback: notify calls"
ok "a split with no usable sub-task falls back to a plain backlog close"

# ---- 6b. a needs-human plan (naru task 2083): backlog + tag + note, no split, no implement ----
reset_stub
printf 'This needs the microphone.\nNEEDS-HUMAN: needs mic consent' > "$STUB/reply.planner"
T=$(mk "Record from the real mic")
R=$(run_loop "$T")
[ "$(tstatus "$T")" = backlog ] && [ "$(subs "$T")" = 0 ] && [ "$(step "$R" "Implement + review #1")" = skipped ] || fail "needs-human: task $(tstatus "$T"), sub-tasks $(subs "$T")"
"$NARU" task show "$T" | jq -e '.tags | index("needs-human")' > /dev/null || fail "needs-human: tag missing"
"$NARU" task show "$T" | jq -r '.notes[-1].body' | head -n 1 | grep -qxF "needs-human: needs mic consent" || fail "needs-human: note"
[ "$(grep -c -- '--call--' "$STUB/vox.log")" = 1 ] || fail "needs-human: notify calls"
ok "a needs-human plan parks the task in backlog with a tag and note, no split"

echo "task-loop-check: all ok"
