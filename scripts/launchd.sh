#!/usr/bin/env bash
# Run `naru serve` as a launchd user agent (naru task 2042, docs/launchd.md).
#
#   scripts/launchd.sh install [--dry-run|--print]
#   scripts/launchd.sh uninstall [--dry-run]
#
# install renders scripts/launchd/com.naru.serve.plist.in to
# ~/Library/LaunchAgents/com.naru.serve.plist (binary $PREFIX/bin/naru, default
# ~/.local/bin; logs ~/.naru/serve.log + serve.err.log; port unchanged), then
# bootstraps and kickstarts it. NARU_DB / MESA_DB / MESA_CONFIG_FILE / NARU_AUDIO_URL
# set in the installing shell are baked in. Quit any hand-run `naru serve` first.
# --print writes the plist to stdout and touches nothing; --dry-run prints the plan.
# Env seams: NARU_LAUNCHD_DIR (plist dir), NARU_LAUNCHCTL (launchctl binary).
# Exit 2 off macOS or on bad usage.
set -euo pipefail

shopt -u patsub_replacement 2>/dev/null || true  # a literal & in a substituted value

[ "$(uname -s)" = Darwin ] || { echo "launchd.sh: macOS only" >&2; exit 2; }
verb="${1:-}"; mode="${2:-}"
case "$verb:$mode" in
  install:|install:--dry-run|install:--print|uninstall:|uninstall:--dry-run) ;;
  *) echo "usage: launchd.sh install [--dry-run|--print] | uninstall [--dry-run]" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
LABEL=com.naru.serve
DIR="${NARU_LAUNCHD_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$DIR/$LABEL.plist"
LAUNCHCTL="${NARU_LAUNCHCTL:-launchctl}"
DOMAIN="gui/$(id -u)"
BIN="${PREFIX:+$PREFIX/bin}"; BIN="${BIN:-$HOME/.local/bin}/naru"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

render() {
  local extra="" v name
  for name in NARU_DB MESA_DB MESA_CONFIG_FILE NARU_AUDIO_URL; do
    v="${!name:-}"
    [ -n "$v" ] && extra="$extra    <key>$name</key>
    <string>$(xml "$v")</string>
"
  done
  local path="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  # Substitute with awk -v-free bash replacement; values are already XML-escaped.
  local out; out="$(cat "$here/launchd/$LABEL.plist.in")"
  out="${out//__BIN__/$(xml "$BIN")}"
  out="${out//__HOME__/$(xml "$HOME")}"
  out="${out//__PATH__/$(xml "$path")}"
  out="${out//__EXTRA_ENV__/$extra}"
  printf '%s\n' "$out"
}

if [ "$mode" = --print ]; then render; exit 0; fi

if [ "$verb" = install ]; then
  if [ "$mode" = --dry-run ]; then
    echo "would write $PLIST (bin $BIN), bootstrap $DOMAIN, kickstart $DOMAIN/$LABEL"; exit 0
  fi
  mkdir -p "$DIR" "$HOME/.naru"
  render >"$PLIST.tmp"
  plutil -lint "$PLIST.tmp" >/dev/null || { rm -f "$PLIST.tmp"; echo "launchd.sh: rendered plist is invalid" >&2; exit 1; }
  mv -f "$PLIST.tmp" "$PLIST"
  # Idempotent: drop a loaded copy first (absent is fine), then load the new one.
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
  "$LAUNCHCTL" kickstart "$DOMAIN/$LABEL"
  echo "ok: installed $PLIST; naru serve now runs under launchd (logs ~/.naru/serve.log)"
  echo "note: a hand-run 'naru serve' on port 7770 must be quit first or the two collide" >&2
else
  if [ "$mode" = --dry-run ]; then echo "would bootout $DOMAIN/$LABEL and remove $PLIST"; exit 0; fi
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  echo "ok: uninstalled $LABEL"
fi
