#!/usr/bin/env bash
# Replay of the kb's automatic lookup (naru task 2553, docs/kb.md "Replaying
# the automatic lookup"). Copies the real kb's notes into a THROWAWAY kb (the
# real kb is only read: its notes and its lookups.jsonl), replays the last N
# distinct lookup questions through the real `naru kb hook` (real `claude`
# haiku), then has a strict blind judge (sonnet) grade every injection.
# Costs ~N haiku calls + one sonnet call per injection.
#
#   scripts/kb-lookup-replay.sh [label]
# env: NARU_BIN (default target/release/naru), KB_SRC (default ~/.naru/kb),
#      REPLAY_N (questions, default 90), REPLAY_JOBS (parallel, default 6),
#      EVAL_OUT (default a fresh temp dir)
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="${NARU_BIN:-$PWD/target/release/naru}"
[ -x "$BIN" ] || { echo "no binary at $BIN (cargo build --release)" >&2; exit 1; }
SRC="${KB_SRC:-$HOME/.naru/kb}"
[ -f "$SRC/lookups.jsonl" ] || { echo "no lookups.jsonl in $SRC" >&2; exit 1; }
OUT="${EVAL_OUT:-$(mktemp -d /tmp/kb-replay.XXXXXX)}"
mkdir -p "$OUT"
KB="$OUT/kb"
rm -rf "$KB"
mkdir -p "$KB"
cp -R "$SRC/topics" "$KB/topics"
[ -f "$SRC/INDEX.md" ] && cp "$SRC/INDEX.md" "$KB/INDEX.md"
export NARU_KB_DIR="$KB" NARU_DB="$OUT/replay.db"
unset MESA_KB_DIR MESA_DB NARU_KB_SKIP MESA_KB_SKIP
echo "kb copy: $KB ($(ls "$KB"/topics/*/*.md | wc -l | tr -d ' ') notes)  bin: $BIN"
exec python3 -I scripts/kb-lookup-replay/run.py "$BIN" "$SRC/lookups.jsonl" "$KB" "$OUT" \
  "${1:-run}" "${REPLAY_N:-90}" "${REPLAY_JOBS:-6}"
