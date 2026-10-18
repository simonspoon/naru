#!/usr/bin/env bash
# ask gate (naru task 2014): `naru ask` queue over the CLI, throwaway MESA_DB.
#
#   * ask <text> -> open question with task/session; list/show/answer; a second
#     answer is `conflict`; unknown id `not_found`; empty text `validation`;
#   * --quiet drops body (and answer on show/answer);
#   * with no live session a bare `ask` exits 0 and writes no notice; with a
#     live session it writes exactly one `question` notice turn (deduped).
set -euo pipefail
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')
unset CLAUDE_CODE_SESSION_ID

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
cargo build --quiet
NARU="$PWD/target/debug/naru"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MESA_DB="$TMP/mesa.db"
export HOME="$TMP/home"
mkdir -p "$HOME"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
# run <code> cmd… : output in $OUT (stdout) and $ERR (stderr)
run() {
  local want=$1; shift
  set +e; OUT=$("$@" 2>"$TMP/err"); local rc=$?; set -e
  ERR=$(cat "$TMP/err")
  [ "$rc" = "$want" ] || fail "'$*' exited $rc, wanted $want ($ERR)"
}

PROJ=$("$NARU" project create askgate --no-git | jq -r .id)
TASK=$("$NARU" task create "$PROJ" "asker task" | jq -r .id)

run 0 "$NARU" ask --task "$TASK" --session s-1 "keep the old flag?"
Q=$(echo "$OUT" | jq -r .id)
[ "$(echo "$OUT" | jq -r .status)" = open ] || fail "new question must be open"
[ "$(echo "$OUT" | jq -r .task_id)" = "$TASK" ] || fail "task_id"
[ "$(echo "$OUT" | jq -r .session)" = s-1 ] || fail "session"
ok "ask with no live session exits 0 and queues an open question"

run 1 "$NARU" live turns
echo "$ERR" | grep -q not_found || fail "no live session expected"
ok "no live session existed, so no notice was written"

run 0 "$NARU" ask list --status open
[ "$(echo "$OUT" | jq length)" = 1 ] || fail "list --status open"
run 0 "$NARU" ask show "$Q" --quiet
echo "$OUT" | jq -e 'has("body")|not' >/dev/null || fail "show --quiet kept body"
echo "$OUT" | jq -e 'has("answer")|not' >/dev/null || fail "show --quiet kept answer"
run 0 "$NARU" ask --quiet --task "$TASK" "second"
echo "$OUT" | jq -e 'has("body")|not' >/dev/null || fail "ask --quiet kept body"
ok "list, show, --quiet key sets"

run 0 "$NARU" ask answer "$Q" drop it
[ "$(echo "$OUT" | jq -r .answer)" = "drop it" ] || fail "answer text"
[ "$(echo "$OUT" | jq -r .status)" = answered ] || fail "status after answer"
run 1 "$NARU" ask answer "$Q" again
echo "$ERR" | grep -q conflict || fail "second answer must be conflict"
run 1 "$NARU" ask show 9999
echo "$ERR" | grep -q not_found || fail "unknown id must be not_found"
run 1 "$NARU" ask "   "
echo "$ERR" | grep -q validation || fail "empty question must be validation"
run 0 "$NARU" ask list --status open
OPEN=$(echo "$OUT" | jq length)
[ "$OPEN" = 1 ] || fail "one question (the second) should still be open"
ok "answer once, conflict/not_found/validation shapes"

run 0 "$NARU" live start --no-agent
run 0 "$NARU" ask "needs a human"
run 0 "$NARU" ask "and another"
run 0 "$NARU" live turns
N=$(echo "$OUT" | jq '[.[]|select(.notice=="question")]|length')
[ "$N" = 1 ] || fail "wanted exactly one question notice turn, got $N"
ok "live session: one deduped question notice"
echo "open_questions_after_answer=$OPEN live_notice_turns_with_session=$N"
