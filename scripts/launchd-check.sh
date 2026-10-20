#!/usr/bin/env bash
# launchd gate (naru task 2042, docs/launchd.md): scripts/launchd.sh under a throwaway
# HOME and NARU_LAUNCHD_DIR with a stub `launchctl` logging its argv — never loads the
# real agent. Plist renders and lints (label, RunAtLoad, KeepAlive, binary, `serve`,
# log paths, no port flag); install = bootstrap + kickstart, idempotent (bootout first);
# a db env set at install is baked in, an unset one absent; a hostile HOME (& < space)
# is XML-escaped; uninstall = bootout + plist gone; self-deploy defaults its restart to
# `kickstart -k` when the plist exists, not when absent, and an explicit command wins.
# PATH (naru task 2161) comes from a stub login shell (NARU_LAUNCHD_SHELL, so the real
# ~/.zshrc is never read): its dirs first, deduped, relative entries dropped, the fixed
# dirs appended; a failing shell gives exactly the fixed list; an `&` is escaped.
# Bootstrap race (naru task 2164): the stub keeps state (a bootout that lingers for N
# `print`s, a bootstrap failing with 5 N times, a bootstrap that loads nothing): install
# waits for the old service to go before bootstrapping, retries error 5, fails loudly
# (exit 1, no `ok:`, the manual command named) when it never loads, stays bounded under
# a service that never goes, and NARU_LAUNCHD_LABEL reaches the plist and every call.
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
# State: linger-init = prints a bootout keeps answering "still there"; bsfail = bootstraps
# left to fail with 5; noload = bootstrap succeeds but loads nothing.
cat >"$NARU_LAUNCHCTL" <<STUB
#!/bin/sh
echo "\$*" >>"$TMP/launchctl.log"
S="$TMP"
case "\$1" in
  bootout) rm -f "\$S/loaded"; [ -e "\$S/linger-init" ] && cp "\$S/linger-init" "\$S/linger" ;;
  print)
    n=\$(cat "\$S/linger" 2>/dev/null || echo 0)
    if [ "\$n" -gt 0 ]; then echo \$((n - 1)) >"\$S/linger"; exit 0; fi
    [ -e "\$S/loaded" ] || exit 113 ;;
  bootstrap)
    n=\$(cat "\$S/bsfail" 2>/dev/null || echo 0)
    if [ "\$n" -gt 0 ]; then echo \$((n - 1)) >"\$S/bsfail"; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    [ -e "\$S/noload" ] || touch "\$S/loaded" ;;
esac
exit 0
STUB
chmod +x "$NARU_LAUNCHCTL"
cat >"$TMP/shell-fail" <<'STUB'
#!/bin/sh
exit 1
STUB
cat >"$TMP/shell-ok" <<'STUB'
#!/bin/sh
echo "rc-file noise __NARU_PATH__=/nope"
printf '\n__NARU_PATH__=%s\n' "$HOME/Library/pnpm/bin:/usr/bin:/usr/bin:relative:$HOME/a & b"
STUB
chmod +x "$TMP/shell-fail" "$TMP/shell-ok"
export NARU_LAUNCHD_SHELL="$TMP/shell-fail"
PLIST="$NARU_LAUNCHD_DIR/com.naru.serve.plist"
rawlog() { cat "$TMP/launchctl.log" 2>/dev/null || true; }
log() { rawlog | grep -v '^print' || true; }

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

plist_path() { sed -n '/<key>PATH<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}'; }
FIXED="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ "$(scripts/launchd.sh install --print | plist_path)" = "$FIXED" ] || fail "failing shell: PATH is not the fixed list"
ok "a failing login shell falls back to the fixed PATH"
out=$(NARU_LAUNCHD_SHELL="$TMP/shell-ok" scripts/launchd.sh install --print)
echo "$out" | plutil -lint - >/dev/null || fail "login-shell PATH breaks the plist"
[ "$(echo "$out" | plist_path)" = "$HOME/Library/pnpm/bin:/usr/bin:$HOME/a &amp; b:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin" ] \
  || fail "login-shell PATH: $(echo "$out" | plist_path)"
ok "login-shell PATH first, deduped, relative dropped, fixed dirs appended, & escaped"

BAD="$TMP/a & b <c>"
mkdir -p "$BAD"
HOME="$BAD" scripts/launchd.sh install --print | plutil -lint - >/dev/null || fail "hostile HOME breaks the plist"
HOME="$BAD" scripts/launchd.sh install --print | grep -qF 'a &amp; b &lt;c&gt;' || fail "hostile HOME not escaped"
ok "hostile HOME is XML-escaped"

reset() { rm -f "$TMP/launchctl.log" "$TMP/linger" "$TMP/linger-init" "$TMP/bsfail" "$TMP/noload" "$TMP/loaded"; }
reset; echo 3 >"$TMP/linger-init"
scripts/launchd.sh install >/dev/null 2>&1 || fail "lingering bootout: install failed"
[ "$(rawlog | sed -n '1,6p' | tr '\n' '|')" = "bootout gui/$UID_/com.naru.serve|print gui/$UID_/com.naru.serve|print gui/$UID_/com.naru.serve|print gui/$UID_/com.naru.serve|print gui/$UID_/com.naru.serve|bootstrap gui/$UID_ $PLIST|" ] \
  || fail "bootstrap did not wait for the bootout: $(rawlog)"
ok "install waits until the old service is gone before bootstrapping"

reset; echo 2 >"$TMP/bsfail"
out=$(scripts/launchd.sh install 2>/dev/null) || fail "bootstrap error 5 twice: install failed"
[ "$(log | grep -c '^bootstrap')" = 3 ] || fail "expected 3 bootstraps: $(log)"
echo "$out" | grep -q '^ok: installed' || fail "no ok line after a retried bootstrap"
ok "bootstrap error 5 is retried"

reset; echo 99 >"$TMP/bsfail"
if out=$(NARU_LAUNCHD_WAIT=1 scripts/launchd.sh install 2>"$TMP/err"); then fail "a bootstrap that always fails exited 0"; fi
echo "$out" | grep -q '^ok:' && fail "printed ok: with the service down"
grep -qF "launchctl bootstrap gui/$UID_ $PLIST" "$TMP/err" || fail "failure names no manual command: $(cat "$TMP/err")"
log | grep -q '^kickstart' && fail "kickstarted after a failed bootstrap"
ok "a bootstrap that never succeeds fails loudly with the manual command"

reset; touch "$TMP/noload"
if out=$(scripts/launchd.sh install 2>"$TMP/err"); then fail "a service that never loads exited 0"; fi
echo "$out" | grep -q '^ok:' && fail "printed ok: for a service that is not loaded"
grep -q 'NOT running' "$TMP/err" || fail "not-loaded failure is silent"
ok "a service not loaded after bootstrap fails loudly"

reset; echo 100000 >"$TMP/linger-init"
start=$SECONDS
NARU_LAUNCHD_WAIT=1 scripts/launchd.sh install >/dev/null 2>&1 || fail "never-gone bootout: install failed"
[ $((SECONDS - start)) -le 5 ] || fail "never-gone bootout took $((SECONDS - start))s"
ok "a bootout that never finishes is waited on for a bounded time"

reset
out=$(NARU_LAUNCHD_LABEL=com.naru.dev-x scripts/launchd.sh install --print)
echo "$out" | grep -qF '<string>com.naru.dev-x</string>' || fail "dev label not in the plist"
echo "$out" | grep -qF '<string>com.naru.serve</string>' && fail "default label left in a dev plist"
NARU_LAUNCHD_LABEL=com.naru.dev-x scripts/launchd.sh install >/dev/null 2>&1 || fail "dev-label install failed"
[ -e "$NARU_LAUNCHD_DIR/com.naru.dev-x.plist" ] || fail "dev-label plist not written"
rawlog | grep -q 'com.naru.serve' && fail "dev-label install touched com.naru.serve: $(rawlog)"
[ "$(log)" = "bootout gui/$UID_/com.naru.dev-x
bootstrap gui/$UID_ $NARU_LAUNCHD_DIR/com.naru.dev-x.plist
kickstart gui/$UID_/com.naru.dev-x" ] || fail "dev-label calls: $(log)"
NARU_LAUNCHD_LABEL=com.naru.dev-x scripts/launchd.sh uninstall >/dev/null
[ ! -e "$NARU_LAUNCHD_DIR/com.naru.dev-x.plist" ] || fail "dev-label uninstall left the plist"
ok "NARU_LAUNCHD_LABEL reaches the plist, its file name and every launchctl call"

if scripts/launchd.sh bogus 2>/dev/null; then fail "bad verb accepted"; fi
echo "all launchd checks passed"
