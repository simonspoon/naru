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
  codesign --force --sign - "$tmp"
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
fi
