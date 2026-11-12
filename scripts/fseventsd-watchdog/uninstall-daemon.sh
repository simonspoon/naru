#!/bin/bash
# Remove the fseventsd watchdog LaunchDaemon (naru task 2800).
#   sudo scripts/fseventsd-watchdog/uninstall-daemon.sh
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "uninstall-daemon.sh: macOS only" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "uninstall-daemon.sh: run with sudo" >&2; exit 2; }
label=io.naru.fseventsd-watchdog
launchctl bootout "system/$label" 2>/dev/null || true
rm -f "/Library/LaunchDaemons/$label.plist" /usr/local/libexec/fseventsd-watchdog.sh
echo "ok: $label removed (log /var/log/fseventsd-watchdog.log kept)"
