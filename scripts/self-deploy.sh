#!/usr/bin/env bash
# Safe self-redeploy, steps 1, 2 and 4a (naru task 2039, part of task 2035):
#
#   1 build the release into a temp target dir, run cargo tests + check scripts
#     (any failure aborts; nothing installed or backed up has changed)
#   2 back up the db to <naru home>/backups/naru-pre-deploy-<ts>.db
#   4a atomically swap the binary at $PREFIX/bin/naru, keeping the previous
#     one as naru.prev. No restart: the running server keeps the old build.
#
# After install, re-run `naru workflow defaults --task-loop` so the Notify live
# agent node exists (this script only reminds you; it does not run it).
#
# Flags: --dry-run (print the plan, change nothing), --skip-checks (no build or
#        checks; deploy NARU_DEPLOY_NEW_BIN — for tests).
# Env: PREFIX (default ~/.local), NARU_DEPLOY_CHECKS (scripts/*-check.sh names),
#      NARU_DEPLOY_NEW_BIN, NARU_DEPLOY_BACKUP_DIR (default ~/.naru/backups).
# Prints one JSON verdict: swapped | aborted | plan. Exit 0 swapped/plan, 1 aborted.
set -uo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

dry=0 skip=0
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    --skip-checks) skip=1 ;;
    *) echo "usage: self-deploy.sh [--dry-run] [--skip-checks]" >&2; exit 2 ;;
  esac
done
command -v jq >/dev/null || { echo "self-deploy: jq is required" >&2; exit 2; }

BIN_DIR="${PREFIX:+$PREFIX/bin}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
INSTALLED="$BIN_DIR/naru"
BACKUP_DIR="${NARU_DEPLOY_BACKUP_DIR:-$HOME/.naru/backups}"
CHECKS="${NARU_DEPLOY_CHECKS:-cli-check api-check task-loop-check todo-watcher-check runner-check concurrent-check}"
work="$(mktemp -d "${TMPDIR:-/tmp}/naru-self-deploy.XXXXXX")"
trap 'rm -rf "$work"' EXIT
LOG="$work/self-deploy.log"
backup_db=""

log() { echo "self-deploy: $*" >&2; }
verdict() { jq -cn --arg s "$1" --arg r "$2" --arg db "$backup_db" --arg prev "$BIN_DIR/naru.prev" \
  '{status:$s,reason:$r,db_backup:$db,binary_backup:(if $s=="swapped" then $prev else "" end)}'; }
abort() { log "ABORT: $1"; [ -s "$LOG" ] && tail -n 30 "$LOG" >&2; verdict aborted "$1"; exit 1; }

if [ "$dry" -eq 1 ]; then
  jq -cn --arg checks "$CHECKS" --arg bin "$INSTALLED" --arg dir "$BACKUP_DIR" --argjson skip "$skip" \
    '{status:"plan",steps:["build release into a temp target dir","cargo test + checks","backup db","atomic swap, previous kept as naru.prev"],checks:($checks|split(" ")),skip_checks:($skip==1),install:$bin,backup_dir:$dir,restart:false}'
  exit 0
fi

NARU="$INSTALLED"
[ -x "$NARU" ] || NARU="$(command -v naru || true)"
[ -x "$NARU" ] || { echo "self-deploy: no installed naru found" >&2; exit 2; }

# ---- 1 build aside + test (nothing installed or backed up yet) -----------------
if [ "$skip" -eq 1 ]; then
  new_bin="${NARU_DEPLOY_NEW_BIN:?--skip-checks needs NARU_DEPLOY_NEW_BIN}"
  log "skipping build and checks; deploying $new_bin"
else
  export CARGO_TARGET_DIR="$work/target"
  log "building into $CARGO_TARGET_DIR (scripts/build.sh --verify, runs cargo test)"
  scripts/build.sh --verify >>"$LOG" 2>&1 || abort "build/test failed"
  new_bin="$CARGO_TARGET_DIR/release/naru"
  for c in $CHECKS; do
    log "check $c"
    NARU_BIN="$new_bin" MESA_BIN="$new_bin" scripts/"$c.sh" >>"$LOG" 2>&1 || abort "$c failed"
  done
  unset CARGO_TARGET_DIR
fi
[ -x "$new_bin" ] || abort "no binary at $new_bin"

# ---- 2 db backup ----------------------------------------------------------------
mkdir -p "$BACKUP_DIR" || abort "cannot create $BACKUP_DIR"
backup_db="$BACKUP_DIR/naru-pre-deploy-$(date +%Y%m%d-%H%M%S).db"
"$NARU" backup "$backup_db" >>"$LOG" 2>&1 || { backup_db=""; abort "db backup failed"; }
log "db backed up -> $backup_db"

# ---- 4a atomic swap ---------------------------------------------------------------
# Never write over the installed file: macOS SIGKILLs an overwritten binary (137).
mkdir -p "$BIN_DIR"
tmp="$(mktemp "$BIN_DIR/.naru.XXXXXX")" || abort "cannot create a temp file in $BIN_DIR"
prev="$(mktemp "$BIN_DIR/.naru.XXXXXX")" || { rm -f "$tmp"; abort "cannot create a temp file in $BIN_DIR"; }
if [ -e "$INSTALLED" ]; then
  cp -p "$INSTALLED" "$prev" && mv -f "$prev" "$BIN_DIR/naru.prev" || { rm -f "$tmp" "$prev"; abort "cannot keep naru.prev"; }
else
  rm -f "$prev"
fi
install -m 0755 "$new_bin" "$tmp" || { rm -f "$tmp"; abort "cannot stage the new binary"; }
command -v codesign >/dev/null 2>&1 && codesign --force --sign - "$tmp" >/dev/null 2>&1
mv -f "$tmp" "$INSTALLED" || { rm -f "$tmp"; abort "swap failed"; }
ln -sf naru "$BIN_DIR/mesa"
log "swapped $INSTALLED (previous kept as naru.prev); the server was NOT restarted"
log "next: restart the server, then run: naru workflow defaults --task-loop"
verdict swapped "binary swapped, server not restarted"
