#!/usr/bin/env bash
# Knowledge-base ask eval (naru task 1944, docs/kb.md "Evaluating `kb ask`").
# Seeds scripts/kb-eval/facts/ into a THROWAWAY kb (never ~/.naru/kb), runs the
# real `naru kb ask` (real `claude` haiku) over scripts/kb-eval/questions.json
# and scores each answer deterministically. Costs ~26 haiku calls.
#
#   scripts/kb-eval.sh [label]            # label names the results file
# env: NARU_BIN (default target/release/naru), EVAL_OUT (default a fresh temp dir),
#      EVAL_JOBS (parallel asks, default 4)
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="${NARU_BIN:-$PWD/target/release/naru}"
[ -x "$BIN" ] || { echo "no binary at $BIN (cargo build --release)" >&2; exit 1; }
LABEL="${1:-run}"
OUT="${EVAL_OUT:-$(mktemp -d /tmp/kb-eval.XXXXXX)}"
mkdir -p "$OUT"
export NARU_KB_DIR="$OUT/kb" NARU_DB="$OUT/eval.db"
unset MESA_KB_DIR MESA_DB
rm -rf "$NARU_KB_DIR"
mkdir -p "$NARU_KB_DIR/topics"
cp -R scripts/kb-eval/facts/. "$NARU_KB_DIR/topics/"
# INDEX.md in the shape Naru regenerates: path | title | tags | updated
: > "$NARU_KB_DIR/INDEX.md"
for f in $(cd "$NARU_KB_DIR" && ls topics/*/*.md); do
  t=$(sed -n 's/^title: //p' "$NARU_KB_DIR/$f"); g=$(sed -n 's/^tags: //p' "$NARU_KB_DIR/$f"); u=$(sed -n 's/^updated: //p' "$NARU_KB_DIR/$f")
  echo "$f | $t | $g | $u" >> "$NARU_KB_DIR/INDEX.md"
done
echo "kb: $NARU_KB_DIR ($(ls "$NARU_KB_DIR"/topics/*/*.md | wc -l | tr -d ' ') notes)  bin: $BIN"
[ "$("$BIN" kb list | python3 -I -c 'import json,sys;print(len(json.load(sys.stdin)))')" -gt 0 ] || { echo "seeded kb is empty" >&2; exit 1; }
exec python3 -I scripts/kb-eval/run.py "$BIN" "$NARU_KB_DIR" scripts/kb-eval/questions.json "$OUT/$LABEL.json" "${EVAL_JOBS:-4}"
