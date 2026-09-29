#!/usr/bin/env bash
# Notify gate (mesa task 1482): `naru notify` (src/core/notify.rs) against a
# stub `vox` (MESA_VOX_BIN) that records its argv, plus the `GET /open/<route>`
# page its button lands on, over a throwaway `serve`.
#
# Covers, in order:
#   1. argv exactly `notify --json --title=T --button "Open Naru=<base>/open/live"
#      -- <message>`, argv only (a message full of `$()`, backticks and quotes
#      arrives byte-identical), the printed JSON, no --title/--button when not
#      asked for;
#   2. base-URL precedence: --base-url, then `notify.base-url` in the config,
#      then the auto-detected LAN address (or `unavailable` naming --base-url);
#      a trailing slash on the base is handled;
#   3. failures: a missing binary and a stub saying "Run `vox init` first" are
#      `unavailable` (exit 1) naming what to do; a bad --open, a non-http
#      --base-url and an empty message are `validation`;
#   4. `GET /open/live` in default mode: 200 text/html carrying `naru://live`
#      (meta refresh + visible link), nosniff; a bad route is 422; a foreign
#      Host is 403 (the global guard — so a phone needs `serve --lan`);
#   5. under `--lan` a foreign Host is served.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP";
      [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null;
      [ -n "${LAN_PID:-}" ] && kill "$LAN_PID" 2>/dev/null; true' EXIT
export MESA_DB="$TMP/mesa.db"
export HOME=$(mkdir -p "$TMP/home" && cd "$TMP/home" && pwd -P)
export MESA_CONFIG_FILE="$TMP/config.json" # absent until section 2

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

STUB_DIR="$TMP/stub"
mkdir -p "$STUB_DIR"
# One argv element per line, so a message is compared as a whole line.
export STUB_DIR
cat > "$STUB_DIR/vox" <<'STUB_EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$STUB_DIR/last-argv"
if [ -e "$STUB_DIR/vox-uninit" ]; then
  echo 'Error: vox is not configured. Run `vox init` first.' >&2
  exit 1
fi
printf '{"ok":true,"message_id":42,"chat_id":7}\n'
STUB_EOF
chmod +x "$STUB_DIR/vox"
export MESA_VOX_BIN="$STUB_DIR/vox"

# run_ok <args...> — sets OUT (stdout); fails on a nonzero exit.
run_ok() { OUT=$("$MESA" notify "$@" 2>"$TMP/err") || fail "notify $*: exit $? ($(cat "$TMP/err"))"; }
# run_err <code> <args...> — expects exit 1 and that error code on stderr.
run_err() {
  local code=$1
  shift
  set +e
  "$MESA" notify "$@" >"$TMP/out" 2>"$TMP/err"
  local rc=$?
  set -e
  [ "$rc" = 1 ] || fail "notify $*: expected exit 1, got $rc"
  [ ! -s "$TMP/out" ] || fail "notify $*: an error must print nothing on stdout"
  [ "$(jq -r .error.code <"$TMP/err")" = "$code" ] ||
    fail "notify $*: expected error code $code, got $(cat "$TMP/err")"
  ERR=$(jq -r .error.message <"$TMP/err")
}
argv() { cat "$STUB_DIR/last-argv"; }

# =====================================================================
# 1. argv
# =====================================================================
HOSTILE='hi $(touch '"$TMP"'/pwned) `id` "q" '"'"'s'"'"' \n {}'
run_ok --title "Naru" --open live --base-url http://10.0.0.5:7770 "$HOSTILE"
EXPECT=$(printf '%s\n' notify --json --title=Naru --button "Open Naru=http://10.0.0.5:7770/open/live" -- "$HOSTILE")
[ "$(argv)" = "$EXPECT" ] || fail "argv mismatch: $(argv)"
[ ! -e "$TMP/pwned" ] || fail "the message was executed"
ok "argv is exactly notify --json --title= --button -- <message>, and a hostile message arrives byte-identical"

[ "$(jq -cS . <<<"$OUT")" = '{"chat_id":7,"message_id":42,"open_url":"http://10.0.0.5:7770/open/live","sent":true}' ] ||
  fail "unexpected output: $OUT"
ok "prints {sent, message_id, chat_id, open_url}"

run_ok "plain"
[ "$(argv)" = "$(printf '%s\n' notify --json -- plain)" ] || fail "bare argv: $(argv)"
[ "$(jq -c .open_url <<<"$OUT")" = "null" ] || fail "open_url must be null without --open"
ok "no --title/--button unless asked for; open_url null"

# =====================================================================
# 2. base-URL precedence
# =====================================================================
run_ok --open live --base-url http://10.0.0.5:7770/ "x"
[ "$(jq -r .open_url <<<"$OUT")" = "http://10.0.0.5:7770/open/live" ] || fail "trailing slash: $OUT"
ok "--base-url: a trailing slash is handled"

echo '{"notify":{"base-url":"https://naru.example/"}}' >"$MESA_CONFIG_FILE"
run_ok --open live/x "x"
[ "$(jq -r .open_url <<<"$OUT")" = "https://naru.example/open/live/x" ] || fail "config base: $OUT"
run_ok --open live --base-url http://10.0.0.5:7770 "x"
[ "$(jq -r .open_url <<<"$OUT")" = "http://10.0.0.5:7770/open/live" ] || fail "flag must beat config: $OUT"
ok "notify.base-url in the config is used, and --base-url beats it"

rm "$MESA_CONFIG_FILE"
set +e
"$MESA" notify --open live "x" >"$TMP/out" 2>"$TMP/err"
rc=$?
set -e
if [ "$rc" = 0 ]; then
  jq -r .open_url <"$TMP/out" | grep -Eq '^http://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:7770/open/live$' ||
    fail "auto-detected base: $(cat "$TMP/out")"
  ok "no flag, no config: the LAN IPv4 on :7770 is used"
else
  grep -q -- '--base-url' "$TMP/err" || fail "no LAN address must name --base-url: $(cat "$TMP/err")"
  ok "no flag, no config, no LAN address: unavailable naming --base-url"
fi

# =====================================================================
# 3. failures
# =====================================================================
MESA_VOX_BIN="$STUB_DIR/no-such-vox" run_err unavailable "x"
case "$ERR" in *"not installed"*"vox init"*) ;; *) fail "missing binary message: $ERR" ;; esac
ok "a missing vox binary is unavailable and says how to fix it"

touch "$STUB_DIR/vox-uninit"
run_err unavailable "x"
case "$ERR" in *"vox init"*) ;; *) fail "uninitialised message must name vox init: $ERR" ;; esac
rm "$STUB_DIR/vox-uninit"
ok "an uninitialised vox is unavailable naming \`vox init\`"

for bad in "a b" 'a"b' "<x>" "naru://x" "a.b" ""; do
  run_err validation --open "$bad" --base-url http://h:1 "x"
done
run_err validation --open "$(printf 'a%.0s' $(seq 1 201))" --base-url http://h:1 "x"
ok "a bad --open is validation"

for bad in "ftp://h" "tg://x" "h:1" "http://"; do
  run_err validation --open live --base-url "$bad" "x"
done
ok "a non-http --base-url is validation"

run_err validation "   "
ok "an empty message is validation"

# =====================================================================
# 4. GET /open/<route>, default mode
# =====================================================================
PORT=17795
BASE="http://127.0.0.1:$PORT"
"$MESA" serve --port "$PORT" >"$TMP/serve.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do curl -sf "$BASE/api/version" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "$BASE/api/version" >/dev/null || fail "server did not start (log: $(cat "$TMP/serve.log"))"

STATUS=$(curl -s -D "$TMP/hdr" -o "$TMP/body" -w '%{http_code}' "$BASE/open/live")
[ "$STATUS" = 200 ] || fail "GET /open/live: expected 200, got $STATUS"
grep -qi '^content-type: text/html' "$TMP/hdr" || fail "GET /open/live: not text/html"
grep -qi '^x-content-type-options: nosniff' "$TMP/hdr" || fail "GET /open/live: no nosniff"
grep -q 'http-equiv="refresh" content="0;url=naru://live"' "$TMP/body" || fail "no meta refresh: $(cat "$TMP/body")"
grep -q '<a href="naru://live"' "$TMP/body" || fail "no visible link: $(cat "$TMP/body")"
ok "GET /open/live: 200 text/html, meta refresh and a visible link to naru://live"

STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' "$BASE/open/nested/route-1")
{ [ "$STATUS" = 200 ] && grep -q 'naru://nested/route-1' "$TMP/body"; } || fail "nested route: $STATUS"
ok "GET /open/nested/route-1: a nested route reaches the deep link"

for bad in 'a%22b' 'a%3Cb%3E' 'a.b' 'a%20b' 'javascript%3Aalert'; do
  STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' "$BASE/open/$bad")
  [ "$STATUS" = 422 ] || fail "GET /open/$bad: expected 422, got $STATUS"
  [ "$(jq -r .error.code <"$TMP/body")" = validation ] || fail "GET /open/$bad: not a validation body"
done
ok "a bad route is 422 validation"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "$BASE/open/live")
[ "$STATUS" = 403 ] || fail "default mode, foreign Host: expected 403, got $STATUS"
ok "default mode: a foreign Host is 403 (a phone needs serve --lan)"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=

# =====================================================================
# 5. --lan
# =====================================================================
LAN_PORT=17796
"$MESA" serve --lan --port "$LAN_PORT" >"$TMP/lan.log" 2>&1 &
LAN_PID=$!
LAN_BASE="http://127.0.0.1:$LAN_PORT"
for _ in $(seq 1 50); do curl -sf "$LAN_BASE/api/version" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "$LAN_BASE/api/version" >/dev/null || fail "LAN server did not start (log: $(cat "$TMP/lan.log"))"

STATUS=$(curl -s -o "$TMP/body" -w '%{http_code}' -H "Host: 192.168.1.5:$LAN_PORT" "$LAN_BASE/open/live")
{ [ "$STATUS" = 200 ] && grep -q 'naru://live' "$TMP/body"; } || fail "--lan foreign Host: expected the page, got $STATUS"
ok "--lan: a LAN Host is served the page"

kill "$LAN_PID" 2>/dev/null || true
wait "$LAN_PID" 2>/dev/null || true
LAN_PID=

echo "all $CHECKS checks passed"
