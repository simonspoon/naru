#!/usr/bin/env bash
# Start a dev `naru serve` on :7771 from target/release/naru, with every piece
# of state under ~/.naru-dev (naru task 2091). Never touches the real install
# (~/.local/bin/naru, launchd com.naru.serve :7777, com.naru.audio :7870,
# /Applications/Naru.app) — that is scripts/self-deploy.sh's job alone.
set -euo pipefail

usage="usage: scripts/dev-env.sh  (takes no arguments; NARU_DEV_DIR and NARU_DEV_PORT override ~/.naru-dev and 7771; runs naru serve in the foreground)"
if [ $# -gt 0 ]; then
  case "$1" in
    -h|--help) echo "$usage"; exit 0 ;;
    *) echo "dev-env: unknown argument: $1" >&2; echo "$usage" >&2; exit 2 ;;
  esac
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
bin="$root/target/release/naru"
dev="${NARU_DEV_DIR:-$HOME/.naru-dev}"
port="${NARU_DEV_PORT:-7771}"

if [ ! -x "$bin" ]; then
  echo "dev-env: $bin missing; run scripts/build.sh first" >&2
  exit 1
fi
if [ "$port" = 7777 ]; then
  echo "dev-env: refusing port 7777 (the real install's)" >&2
  exit 1
fi

mkdir -p "$dev"
export NARU_HOME="$dev"
export NARU_DB="$dev/naru.db"
export NARU_CONFIG_FILE="$dev/config.json"
export NARU_KB_DIR="$dev/kb"
export NARU_HOOKS_FILE="$dev/hooks.json"
export NARU_ATTACHMENTS_DIR="$dev/attachments"
export NARU_AUDIO_URL="http://127.0.0.1:7871"

exec "$bin" serve --port "$port" \
  --watch-queue=false --watch-inbox=false --watch-cost=false \
  --watch-retro=false --watch-workflows=false
