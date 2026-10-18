#!/usr/bin/env bash
# self-deploy gate (naru task 2039): scripts/self-deploy.sh steps 1, 2, 4a under
# a throwaway HOME, db and PREFIX with a stub "new" binary (no real build):
# --dry-run changes nothing; a failing check aborts with the install untouched
# and no backup; a pass backs up the db (valid), keeps naru.prev byte-equal to
# the old binary, installs the new one and leaves no .naru.* temp files.
set -euo pipefail
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')
cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
cargo build --quiet
SRC="$PWD/target/debug/naru"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" MESA_DB="$TMP/mesa.db" MESA_CONFIG_FILE="$TMP/no-config.json" PREFIX="$TMP/prefix"
mkdir -p "$HOME" "$PREFIX/bin"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
NARU="$PREFIX/bin/naru"
cp "$SRC" "$NARU"
"$NARU" project create tmp --no-git >/dev/null
printf '#!/bin/sh\necho new\n' >"$TMP/newbin"; chmod +x "$TMP/newbin"
before=$(shasum "$NARU" | cut -d' ' -f1)
backups="$HOME/.naru/backups"

out=$(scripts/self-deploy.sh --dry-run)
[ "$(echo "$out" | jq -r .status)" = plan ] || fail "dry-run verdict"
[ "$(shasum "$NARU" | cut -d' ' -f1)" = "$before" ] && [ ! -e "$PREFIX/bin/naru.prev" ] && [ ! -d "$backups" ] || fail "dry-run changed something"
ok "dry-run prints the plan and changes nothing"

out=$(NARU_DEPLOY_NEW_BIN="$TMP/newbin" scripts/self-deploy.sh --skip-checks 2>/dev/null) || fail "deploy exit"
[ "$(echo "$out" | jq -r .status)" = swapped ] || fail "verdict: $out"
[ "$(shasum "$PREFIX/bin/naru.prev" | cut -d' ' -f1)" = "$before" ] || fail "naru.prev differs from the old binary"
cmp -s "$NARU" "$TMP/newbin" || [ "$("$NARU" 2>&1 | head -1)" = new ] || fail "new binary not installed"
db=$(echo "$out" | jq -r .db_backup)
[ -f "$db" ] && [ "$(dirname "$db")" = "$backups" ] || fail "no timestamped backup: $db"
case "$(basename "$db")" in naru-pre-deploy-*.db) ;; *) fail "backup name" ;; esac
[ "$(MESA_DB="$db" "$PREFIX/bin/naru.prev" project list | jq length)" = 1 ] || fail "backup is not a valid db"
[ -L "$PREFIX/bin/mesa" ] || fail "mesa symlink"
[ -z "$(ls -A "$PREFIX/bin" | grep '^\.naru\.' || true)" ] || fail "stray temp files"
ok "swap kept naru.prev, wrote a valid timestamped backup, left no temp files"

# a failed pre-swap step leaves the install alone: make the backup dir unwritable
old_prev=$(shasum "$PREFIX/bin/naru.prev" | cut -d' ' -f1); cur=$(shasum "$NARU" | cut -d' ' -f1)
set +e
out=$(NARU_DEPLOY_BACKUP_DIR=/dev/null/x NARU_DEPLOY_NEW_BIN="$SRC" scripts/self-deploy.sh --skip-checks 2>/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(echo "$out" | jq -r .status)" = aborted ] || fail "backup failure should abort ($rc)"
[ "$(shasum "$NARU" | cut -d' ' -f1)" = "$cur" ] && [ "$(shasum "$PREFIX/bin/naru.prev" | cut -d' ' -f1)" = "$old_prev" ] || fail "abort changed the install"
ok "backup failure aborts with binary and naru.prev untouched"
echo "self-deploy-check: all passed"
