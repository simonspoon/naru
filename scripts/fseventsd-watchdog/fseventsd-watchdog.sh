#!/bin/bash
# Restart fseventsd when its memory passes a threshold (naru task 2800).
# macOS runs fseventsd away to tens of GB over a day; launchd respawns it small.
#
#   fseventsd-watchdog.sh [--dry-run]
#
# Size = top MEM, the physical memory footprint (includes compressed pages; RSS undercounts).
# --dry-run prints the size and what it would do; it never kills.
# Env seams: FSEVENTSD_THRESHOLD_MB, FSEVENTSD_WATCHDOG_LOG, FSEVENTSD_TOP_OUTPUT
# (a canned MEM value as `top` prints it, e.g. 1.5G, for tests).

THRESHOLD_MB="${FSEVENTSD_THRESHOLD_MB:-2048}"   # the one knob: restart past this
LOG="${FSEVENTSD_WATCHDOG_LOG:-/var/log/fseventsd-watchdog.log}"

[ "$(uname -s)" = Darwin ] || { echo "fseventsd-watchdog: macOS only, nothing to do"; exit 0; }

dry=0
case "${1:-}" in
  "") ;;
  --dry-run) dry=1 ;;
  *) echo "usage: fseventsd-watchdog.sh [--dry-run]" >&2; exit 2 ;;
esac

# "3856K", "1.5G", "10M+", "0B" -> megabytes (integer)
to_mb() {
  awk -v v="$1" 'BEGIN {
    gsub(/[+-]$/, "", v)
    u = substr(v, length(v)); n = substr(v, 1, length(v) - 1) + 0
    if (u == "B") n = n / 1048576
    else if (u == "K") n = n / 1024
    else if (u == "G") n = n * 1024
    else if (u == "T") n = n * 1048576
    printf "%d\n", n
  }'
}

if [ -n "${FSEVENTSD_TOP_OUTPUT:-}" ]; then
  line="$FSEVENTSD_TOP_OUTPUT"
else
  line="$(top -l 1 -stats command,mem 2>/dev/null | awk '$1 == "fseventsd" { print $2; exit }')"
fi
[ -n "$line" ] || { echo "fseventsd-watchdog: fseventsd not found" >&2; exit 1; }

set -- $line
mb=$(to_mb "$1")

if [ "$mb" -le "$THRESHOLD_MB" ]; then
  echo "fseventsd ${mb} MB <= ${THRESHOLD_MB} MB: no action"
  exit 0
fi

if [ "$dry" = 1 ]; then
  echo "fseventsd ${mb} MB > ${THRESHOLD_MB} MB: would restart (dry run)"
  exit 0
fi

echo "fseventsd ${mb} MB > ${THRESHOLD_MB} MB: restarting"
if killall fseventsd; then
  printf '%s restarted fseventsd, was %s MB\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$mb" >>"$LOG"
else
  echo "fseventsd-watchdog: killall failed (not root?)" >&2
  exit 1
fi
