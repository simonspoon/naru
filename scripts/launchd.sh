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
# The plist PATH is the installing user's login-shell PATH plus fixed fallback dirs.
# bootout is asynchronous, so install waits (up to NARU_LAUNCHD_WAIT s, default 10) for
# the old service to go, retries a failed bootstrap (`5: Input/output error`) and fails
# loudly, never printing `ok:`, if the service is still not loaded (naru task 2164).
# Env seams: NARU_LAUNCHD_DIR (plist dir), NARU_LAUNCHCTL (launchctl binary),
# NARU_LAUNCHD_SHELL (shell asked for that PATH, default $SHELL), NARU_LAUNCHD_LABEL
# (agent label, default com.naru.serve — a dev label for testing against real launchd),
# NARU_LAUNCHD_WAIT (seconds to wait for a bootout).
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
LABEL="${NARU_LAUNCHD_LABEL:-com.naru.serve}"
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
  # PATH: the installing user's interactive login-shell PATH (pnpm/nvm dirs usually come
  # from .zshrc), absolute entries only, then the fixed fallback dirs, first occurrence wins.
  local shell_path dir path="" sep=""
  shell_path="$("${NARU_LAUNCHD_SHELL:-${SHELL:-/bin/sh}}" -ilc 'printf "\n__NARU_PATH__=%s\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^__NARU_PATH__=//p' | tail -n 1)" || shell_path=""
  local dirs=()
  IFS=: read -r -a dirs <<<"$shell_path" || true
  for dir in ${dirs[@]+"${dirs[@]}"} "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    case "$dir" in /*) ;; *) continue ;; esac
    case ":$path:" in *":$dir:"*) continue ;; esac
    path="$path$sep$dir"; sep=:
  done
  # Substitute with awk -v-free bash replacement; values are already XML-escaped.
  local out; out="$(cat "$here/launchd/com.naru.serve.plist.in")"
  out="${out//__LABEL__/$(xml "$LABEL")}"
  out="${out//__BIN__/$(xml "$BIN")}"
  out="${out//__HOME__/$(xml "$HOME")}"
  out="${out//__PATH__/$(xml "$path")}"
  out="${out//__EXTRA_ENV__/$extra}"
  printf '%s\n' "$out"
}

if [ "$mode" = --print ]; then render; exit 0; fi

loaded() { "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
# bootout returns before the service is torn down; poll (bounded) until it is gone.
bootout() {
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  local i n=$(( ${NARU_LAUNCHD_WAIT:-10} * 5 ))
  for ((i = 0; i < n; i++)); do loaded || return 0; sleep 0.2; done
}

if [ "$verb" = install ]; then
  if [ "$mode" = --dry-run ]; then
    echo "would write $PLIST (bin $BIN), bootstrap $DOMAIN, kickstart $DOMAIN/$LABEL"; exit 0
  fi
  mkdir -p "$DIR" "$HOME/.naru"
  render >"$PLIST.tmp"
  plutil -lint "$PLIST.tmp" >/dev/null || { rm -f "$PLIST.tmp"; echo "launchd.sh: rendered plist is invalid" >&2; exit 1; }
  mv -f "$PLIST.tmp" "$PLIST"
  # Idempotent: drop a loaded copy first (absent is fine), then load the new one,
  # retrying while launchd is still tearing the old one down (bootstrap error 5).
  bootout
  tries=0
  until "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 5 ]; then
      echo "launchd.sh: bootstrap of $LABEL failed $tries times; naru serve is NOT running. Retry by hand: launchctl bootstrap $DOMAIN $PLIST" >&2
      exit 1
    fi
    sleep 1
  done
  "$LAUNCHCTL" kickstart "$DOMAIN/$LABEL"
  loaded || { echo "launchd.sh: $LABEL is not loaded after bootstrap; naru serve is NOT running" >&2; exit 1; }
  echo "ok: installed $PLIST; naru serve now runs under launchd (logs ~/.naru/serve.log)"
  echo "note: a hand-run 'naru serve' on port 7770 must be quit first or the two collide" >&2
else
  if [ "$mode" = --dry-run ]; then echo "would bootout $DOMAIN/$LABEL and remove $PLIST"; exit 0; fi
  bootout
  rm -f "$PLIST"
  echo "ok: uninstalled $LABEL"
fi
