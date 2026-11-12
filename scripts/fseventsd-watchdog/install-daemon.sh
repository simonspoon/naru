#!/bin/bash
# Install the fseventsd watchdog as a root LaunchDaemon (naru task 2800).
#   sudo scripts/fseventsd-watchdog/install-daemon.sh
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "install-daemon.sh: macOS only" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "install-daemon.sh: run with sudo" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
label=io.naru.fseventsd-watchdog
mkdir -p /usr/local/libexec
install -m 755 -o root -g wheel "$here/fseventsd-watchdog.sh" /usr/local/libexec/fseventsd-watchdog.sh
install -m 644 -o root -g wheel "$here/$label.plist" "/Library/LaunchDaemons/$label.plist"
launchctl bootout "system/$label" 2>/dev/null || true
sleep 1
launchctl bootstrap system "/Library/LaunchDaemons/$label.plist"
echo "ok: $label installed (every 5 min, log /var/log/fseventsd-watchdog.log)"
