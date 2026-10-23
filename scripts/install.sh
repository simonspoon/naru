#!/usr/bin/env bash
# Build the release binary and install it onto this machine.
#
# Runs the pinned build pipeline (scripts/build.sh) and copies the resulting
# `naru` binary to an install dir on PATH, with `mesa` (its pre-rename name)
# as a symlink to it beside it. Override the destination with PREFIX:
#
#   PREFIX=/usr/local scripts/install.sh   # installs to /usr/local/bin/naru
#
# Default install dir is ~/.local/bin (already on PATH on this machine).
#
# --launchd (macOS) also installs the com.naru.serve launchd agent afterwards
# (scripts/launchd.sh install, docs/launchd.md); quit a hand-run `naru serve` first.
# Without it, a running serve reporting another version on /api/version gets one
# NOTICE line (port: NARU_INSTALL_PORT, else the config's serve.port, else 7770);
# nothing is restarted.
set -euo pipefail

cd "$(dirname "$0")/.."

launchd=0
for a in "$@"; do
  case "$a" in
    --launchd) launchd=1 ;;
    *) echo "usage: install.sh [--launchd]" >&2; exit 2 ;;
  esac
done

BIN_DIR="${PREFIX:+$PREFIX/bin}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

scripts/build.sh

mkdir -p "$BIN_DIR"
# Never overwrite the installed file in place: macOS caches a binary's code
# signature per inode, so new bytes under a validated inode get every later run
# SIGKILLed (exit 137). Copy beside it, ad-hoc sign, then rename over it.
tmp="$(mktemp "$BIN_DIR/.naru.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
install -m 0755 target/release/naru "$tmp"
if command -v codesign >/dev/null 2>&1; then
  # Pin the identifier + designated requirement: a bare ad-hoc (cdhash) identity changes
  # every build and drops the CLI's TCC grants on each deploy.
  codesign --force --sign - -i com.naru.cli -r='designated => identifier "com.naru.cli"' "$tmp"
fi
mv -f "$tmp" "$BIN_DIR/naru"
# Replaces an older install's real `mesa` binary with the symlink.
ln -sf naru "$BIN_DIR/mesa"

echo "ok: installed naru -> $BIN_DIR/naru (mesa -> naru)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "warning: $BIN_DIR is not on your PATH; add it to use 'naru' directly" >&2 ;;
esac

if [ "$launchd" = 1 ]; then
  PREFIX="${PREFIX:-}" scripts/launchd.sh install
else
  # A running serve keeps the old build until restarted (naru task 2279): compare the
  # version it reports with the installed one and say so loudly. Port: NARU_INSTALL_PORT,
  # else `serve.port` in the config (resolved like self-deploy.sh, minus its plist lookup), else 7770.
  port="${NARU_INSTALL_PORT:-}"
  if [ -z "$port" ]; then
    cfg="${NARU_CONFIG_FILE:-${MESA_CONFIG_FILE:-}}"
    if [ -z "$cfg" ]; then
      cfg="$HOME/.naru"; [ -e "$cfg" ] || { [ -e "$HOME/.mesa" ] && cfg="$HOME/.mesa"; }
      [ -d "$cfg" ] && cfg="$cfg/config.json"
    fi
    [ -f "$cfg" ] && port="$(jq -r '.serve.port // empty' "$cfg" 2>/dev/null || true)"
    case "$port" in ''|*[!0-9]*) port=7770 ;; esac
  fi
  installed="$("$BIN_DIR/naru" --version 2>/dev/null | awk '{print $2}' || true)"
  running="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/api/version" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)"
  if [ -n "$running" ] && [ -n "$installed" ] && [ "$running" != "$installed" ]; then
    echo "NOTICE: running serve is v$running, installed is v$installed: restart it with scripts/install.sh --launchd" >&2
  fi
fi
