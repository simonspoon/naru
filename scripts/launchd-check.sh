#!/usr/bin/env bash
# launchd gate (naru task 2042, docs/launchd.md): scripts/launchd.sh under a throwaway
# HOME and NARU_LAUNCHD_DIR with a stub `launchctl` logging its argv — never loads the
# real agent. Plist renders and lints (label, RunAtLoad, KeepAlive, binary, `serve`,
# log paths, no port flag); install = bootstrap + kickstart, idempotent (bootout first);
# a db env set at install is baked in, an unset one absent; a hostile HOME (& < space)
# is XML-escaped; uninstall = bootout + plist gone; self-deploy defaults its restart to
# `kickstart -k` when the plist exists, not when absent, and an explicit command wins.
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "skip: launchd-check is macOS only"; exit 0; }
unset $(env | grep -oE "^(NARU|MESA)_[A-Za-z0-9_]*")
cd "$(dirname "$0")/.."
REPO="$PWD"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
export HOME="$TMP/home" PREFIX="$TMP/prefix" NARU_LAUNCHD_DIR="$TMP/agents" NARU_LAUNCHCTL="$TMP/launchctl"
mkdir -p "$HOME"
UID_=$(id -u)
cat >"$NARU_LAUNCHCTL" <<STUB
#!/bin/sh
echo "\$*" >>"$TMP/launchctl.log"
STUB
chmod +x "$NARU_LAUNCHCTL"
PLIST="$NARU_LAUNCHD_DIR/com.naru.serve.plist"
log() { cat "$TMP/launchctl.log" 2>/dev/null || true; }

out=$(scripts/launchd.sh install --print)
echo "$out" | plutil -lint - >/dev/null || fail "printed plist does not lint"
[ ! -e "$PLIST" ] && [ -z "$(log)" ] || fail "--print touched something"
for want in com.naru.serve RunAtLoad KeepAlive "$PREFIX/bin/naru" "<string>serve</string>" "$HOME/.naru/serve.log" "$HOME/.naru/serve.err.log"; do
  echo "$out" | grep -qF "$want" || fail "plist lacks $want"
done
echo "$out" | grep -q -- '--port' && fail "plist names a port flag"
echo "$out" | grep -q NARU_DB && fail "unset NARU_DB leaked into the plist"
ok "plist renders and lints, no port flag, no unset env"

scripts/launchd.sh install --dry-run >/dev/null
[ ! -e "$PLIST" ] && [ -z "$(log)" ] || fail "--dry-run changed something"

NARU_DB="$TMP/x.db" scripts/launchd.sh install >/dev/null 2>&1
plutil -lint "$PLIST" >/dev/null || fail "installed plist does not lint"
grep -qF "$TMP/x.db" "$PLIST" || fail "NARU_DB not baked in"
[ -d "$HOME/.naru" ] || fail "no ~/.naru"
[ "$(log)" = "bootout gui/$UID_/com.naru.serve
bootstrap gui/$UID_ $PLIST
kickstart gui/$UID_/com.naru.serve" ] || fail "install launchctl calls: $(log)"
ok "install bootouts, bootstraps and kickstarts; db env baked in"

scripts/launchd.sh install >/dev/null 2>&1
grep -q NARU_DB "$PLIST" && fail "re-install kept a stale NARU_DB"
[ "$(log | grep -c '^bootstrap')" = 2 ] || fail "re-install did not bootstrap again"
ok "install is idempotent"

# self-deploy default restart
: >"$TMP/launchctl.log"
cat >"$TMP/sd.sh" <<'EOS'
set -e
sed -n '/^restart() {/,/^}/p' scripts/self-deploy.sh >"$1/restart.fn"
EOS
bash "$TMP/sd.sh" "$TMP"
harness() { # run restart() with the given NARU_DEPLOY_RESTART_CMD
  ( LOG="$TMP/sd.log"; log() { :; }; . "$TMP/restart.fn"; restart ) 
}
( cd "$REPO"; harness ) || fail "default restart failed"
[ "$(log)" = "kickstart -k gui/$UID_/com.naru.serve" ] || fail "default restart ran: $(log)"
ok "self-deploy defaults to kickstart -k when the agent is installed"
: >"$TMP/launchctl.log"
( NARU_DEPLOY_RESTART_CMD="echo mine >>'$TMP/mine'"; harness ) || fail "explicit restart failed"
[ -z "$(log)" ] && [ -e "$TMP/mine" ] || fail "explicit command did not win"
ok "an explicit restart command wins"

: >"$TMP/launchctl.log"
scripts/launchd.sh uninstall >/dev/null
[ ! -e "$PLIST" ] || fail "uninstall left the plist"
[ "$(log)" = "bootout gui/$UID_/com.naru.serve" ] || fail "uninstall calls: $(log)"
ok "uninstall boots out and removes the plist"
: >"$TMP/launchctl.log"
( harness ) && fail "restart with no plist and no command should fail"
[ -z "$(log)" ] || fail "restart touched launchctl with no plist"
ok "no plist and no command: still cannot restart"

BAD="$TMP/a & b <c>"
mkdir -p "$BAD"
HOME="$BAD" scripts/launchd.sh install --print | plutil -lint - >/dev/null || fail "hostile HOME breaks the plist"
HOME="$BAD" scripts/launchd.sh install --print | grep -qF 'a &amp; b &lt;c&gt;' || fail "hostile HOME not escaped"
ok "hostile HOME is XML-escaped"

if scripts/launchd.sh bogus 2>/dev/null; then fail "bad verb accepted"; fi
echo "all launchd checks passed"
