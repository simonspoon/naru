#!/usr/bin/env bash
# alarm gate (mesa task 1512): `naru alarm arm|disarm` and the `alarm-disarm`
# library hook against a throwaway HOME. The hook is extracted from
# `naru library show alarm-disarm.sh` so what is tested is exactly what
# `naru library hook enable alarm-disarm --event SubagentStop` would seed.
#
#   * arm with no disarm            -> outcome fired, message `ALARM: …`;
#   * a SubagentStop payload fed to the hook while an arm waits -> the arm
#     exits within seconds, outcome disarmed, carrying the agent id;
#   * a disarm BEFORE the arm, or for another session, does not disarm;
#   * no session / bad --after -> validation (exit 1); --quiet accepted and ignored;
#   * the hook with garbage stdin, or no naru on PATH, exits 0.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')
unset CLAUDE_CODE_SESSION_ID

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
BIN="$PWD/target/debug"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MESA_DB="$TMP/mesa.db"
export HOME="$TMP/home"
mkdir -p "$HOME"
export PATH="$BIN:$PATH"
NARU="$BIN/naru"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

HOOK="$TMP/alarm-disarm.sh"
"$NARU" library show alarm-disarm.sh | jq -r .body >"$HOOK"
chmod +x "$HOOK"
head -1 "$HOOK" | grep -q '^#!' || fail "the built-in body must start with a shebang"
bash -n "$HOOK" || fail "bash -n on the built-in body"
ok "alarm-disarm.sh extracted from the library, parses under bash -n"

payload() { printf '{"session_id":"%s","agent_id":"%s","hook_event_name":"SubagentStop"}' "$1" "$2"; }

# (a) no disarm -> fires
out=$("$NARU" alarm arm reviewer --after 2s --session sess-a)
[ "$(jq -r .outcome <<<"$out")" = fired ] || fail "expected fired: $out"
jq -r .message <<<"$out" | grep -q '^ALARM: reviewer has not reported' || fail "message: $out"
[ "$(jq -r .after_secs <<<"$out")" = 2 ] || fail "after_secs: $out"
ok "an unanswered arm fires with ALARM:"

# (b) a stop while armed disarms it quickly, carrying the agent id
"$NARU" alarm arm --after 30s --session sess-b >"$TMP/b.out" &
PID=$!
sleep 1
payload sess-b agent-42 | "$HOOK"
for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
kill -0 "$PID" 2>/dev/null && { kill "$PID"; fail "arm still blocked 6s after the hook ran"; }
wait "$PID"
[ "$(jq -r .outcome "$TMP/b.out")" = disarmed ] || fail "expected disarmed: $(cat "$TMP/b.out")"
[ "$(jq -r .agent_id "$TMP/b.out")" = agent-42 ] || fail "agent_id: $(cat "$TMP/b.out")"
[ "$(jq -r .label "$TMP/b.out")" = agent ] || fail "default label: $(cat "$TMP/b.out")"
ok "the hook disarms a waiting arm, agent id carried"

# (c) a disarm before the arm does not count
payload sess-c old | "$HOOK"
sleep 1
out=$("$NARU" alarm arm --after 2s --session sess-c)
[ "$(jq -r .outcome <<<"$out")" = fired ] || fail "an older marker disarmed: $out"
ok "a marker older than the arm does not disarm"

# (d) another session's stop does not disarm
"$NARU" alarm arm --after 2s --session sess-d >"$TMP/d.out" &
PID=$!
sleep 0.5
payload sess-other agent-1 | "$HOOK"
wait "$PID"
[ "$(jq -r .outcome "$TMP/d.out")" = fired ] || fail "another session disarmed: $(cat "$TMP/d.out")"
ok "a stop in another session does not disarm"

# (e) error shapes
set +e
err=$("$NARU" alarm arm --after 2s 2>&1 >/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(jq -r .error.code <<<"$err")" = validation ] || fail "missing session: rc=$rc $err"
grep -q -- '--session' <<<"$err" || fail "missing-session error must name --session: $err"
set +e
err=$("$NARU" alarm arm --after 5x --session s 2>&1 >/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(jq -r .error.code <<<"$err")" = validation ] || fail "bad --after: rc=$rc $err"
set +e
err=$("$NARU" alarm arm --after 0 --session s 2>&1 >/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(jq -r .error.code <<<"$err")" = validation ] || fail "zero --after: rc=$rc $err"
set +e
err=$("$NARU" alarm arm --after 2s --session '../x' 2>&1 >/dev/null); rc=$?
set -e
[ "$rc" = 1 ] && [ "$(jq -r .error.code <<<"$err")" = validation ] || fail "unsafe session: rc=$rc $err"
# --quiet is accepted and ignored (mesa task 1513): the same outcome as without
# it, never a usage error. A failing arm (bad --after) and a disarm keep it fast.
set +e
"$NARU" alarm arm --after 5x --session s >/dev/null 2>"$TMP/q0"; rc0=$?
"$NARU" alarm arm --after 5x --session s --quiet >/dev/null 2>"$TMP/q1"; rc1=$?
out0=$("$NARU" alarm disarm --session s 2>&1); d0=$?
out1=$("$NARU" alarm disarm --session s --quiet 2>&1); d1=$?
set -e
[ "$rc0" = 1 ] && [ "$rc1" = 1 ] && cmp -s "$TMP/q0" "$TMP/q1" || fail "arm --quiet must behave as without it (got $rc0, $rc1)"
[ "$d0" = "$d1" ] && [ "$d1" != 2 ] && [ "$out0" = "$out1" ] || fail "disarm --quiet must behave as without it (got $d0, $d1)"
ok "missing session, bad/zero --after and an unsafe session id are validation; --quiet is an accepted no-op"

# (f) the hook never wedges
echo 'not json {' | "$HOOK" || fail "garbage stdin must exit 0"
"$HOOK" </dev/null || fail "empty stdin must exit 0"
echo '{"session_id":"../x"}' | "$HOOK" || fail "unsafe session must exit 0"
echo '{}' | PATH=/usr/bin:/bin "$HOOK" || fail "no naru on PATH must exit 0"
ok "the hook exits 0 on garbage, empty, unsafe and no-naru"

echo "alarm-check: all ok"
