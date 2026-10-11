#!/usr/bin/env bash
# Themes gate (naru task 1845, parent 1839): `naru theme` over the CLI and
# /api/themes (+ PUT /api/config/appearance) over a throwaway `serve`.
#
# CLI: the four read-only built-ins; create --from; set (slot -> derived var);
# every validation/conflict shape; a contrast failure is a warning (stdout and
# stderr), never a refusal; --quiet drops `vars`; use/delete and
# .appearance.theme; a hostile name round-trips byte-identical and runs nothing.
# API: list/create/patch/delete/preview contracts, a built-in PATCH 422,
# appearance accepting custom-<n> and refusing an unknown one, a foreign Host
# 403 in default mode and a POST without application/json refused.
#
# HOME is a throwaway dir so the config file (appearance) is the real path
# resolution's, never the developer's.
set -euo pipefail
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

if [ -n "${MESA_BIN:-}" ]; then
  MESA=$MESA_BIN
else
  cargo build --quiet
  MESA=$PWD/target/debug/naru
fi

TMP=$(mktemp -d)
PWNED=/tmp/naru-theme-pwned-$$
trap 'rm -rf "$TMP" "$PWNED"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; true' EXIT
export HOME="$TMP/home"
mkdir -p "$HOME"
export MESA_DB="$TMP/mesa.db"
unset MESA_CONFIG_FILE

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

run() {
  local expected=$1; shift
  set +e
  STDOUT=$("$@" 2>"$TMP/stderr")
  CODE=$?
  set -e
  STDERR=$(cat "$TMP/stderr")
  [ "$CODE" -eq "$expected" ] ||
    fail "expected exit $expected, got $CODE: $* (stdout: $STDOUT stderr: $STDERR)"
}
jqs() { jq -r "$1" <<<"$STDOUT"; }
jqe() { jq -r "$1" <<<"$STDERR"; }
appearance() { jq -r '.appearance.theme // "null"' "$HOME/.naru/config.json" 2>/dev/null ||
  jq -r '.appearance.theme // "null"' "$HOME/.mesa/config.json"; }

# ================= CLI =================

run 0 "$MESA" theme list
[ "$(jqs 'map(.id) | join(",")')" = "dark,light,contrast,crimson" ] || fail "list ids: $STDOUT"
[ "$(jqs 'all(.[]; .builtin)')" = "true" ] || fail "list: all builtin"
ok "theme list: exactly dark, light, contrast, crimson, all builtin"

run 0 "$MESA" theme create --from crimson
[ "$(jqs .id)" = "custom-1" ] && [ "$(jqs .name)" = "Crimson copy" ] || fail "create: $STDOUT"
[ "$(jqs .builtin)" = "false" ] || fail "create: builtin false"
ok "theme create --from crimson: custom-1 \"Crimson copy\""

run 0 "$MESA" theme set custom-1 accent '#0f0'
[ "$(jqs '.vars["--cyan-rgb"]')" = "0, 255, 0" ] || fail "set accent: vars: $STDOUT"
[ "$(jqs .slots.accent)" = "#00ff00" ] || fail "set accent: slot normalized"
ok "theme set accent '#0f0': --cyan-rgb \"0, 255, 0\""

run 1 "$MESA" theme set crimson accent '#fff'
[ "$(jqe .error.code)" = "validation" ] || fail "set built-in: $STDERR"
ok "theme set on a built-in: exit 1, validation"

run 1 "$MESA" theme set custom-1 nope '#fff'
[ "$(jqe .error.code)" = "validation" ] || fail "set bad slot: $STDERR"
ok "theme set with an unknown slot: exit 1, validation"

run 1 "$MESA" theme set custom-1 accent 'notacolour'
[ "$(jqe .error.code)" = "validation" ] || fail "set bad colour: $STDERR"
run 0 "$MESA" theme show custom-1
[ "$(jqs .slots.accent)" = "#00ff00" ] || fail "bad colour must write nothing"
ok "theme set with a bad colour: exit 1, validation, nothing written"

run 0 "$MESA" theme set custom-1 text '#0f0608'
jq -e 'any(.warnings[]; .pair == "text/bg")' <<<"$STDOUT" >/dev/null ||
  fail "text = bg: warnings lack text/bg: $STDOUT"
case "$STDERR" in *text/bg*) ;; *) fail "text = bg: stderr has no warning line: $STDERR" ;; esac
ok "theme set text = bg colour: exit 0, warnings name text/bg, stderr warns"
run 0 "$MESA" theme set custom-1 text '#f2d6d8'

run 1 "$MESA" theme rename custom-1 Dark
[ "$(jqe .error.code)" = "validation" ] || fail "rename to built-in name: $STDERR"
ok "theme rename to a built-in name: exit 1, validation"

run 0 "$MESA" theme create --from dark --name Ocean
[ "$(jqs .id)" = "custom-2" ] || fail "create --name: $STDOUT"
run 1 "$MESA" theme rename custom-2 'crimson COPY'
[ "$(jqe .error.code)" = "conflict" ] || fail "rename to existing custom name: $STDERR"
ok "theme rename to an existing custom name (case-insensitive): exit 1, conflict"
run 0 "$MESA" theme delete custom-2

run 0 "$MESA" theme show custom-1 --quiet
jq -e 'has("vars") | not' <<<"$STDOUT" >/dev/null || fail "--quiet must drop vars"
jq -e 'has("slots") and has("id")' <<<"$STDOUT" >/dev/null || fail "--quiet keeps slots/id"
ok "theme show --quiet drops vars"

run 0 "$MESA" theme use custom-1
[ "$(appearance)" = "custom-1" ] || fail "use: .appearance.theme = $(appearance)"
ok "theme use custom-1 writes .appearance.theme"

run 0 "$MESA" theme delete custom-1
[ "$(jqs .id)" = "custom-1" ] || fail "delete echo: $STDOUT"
[ "$(appearance)" = "null" ] || fail "delete must clear .appearance.theme, got $(appearance)"
run 1 "$MESA" theme show custom-1
[ "$(jqe .error.code)" = "not_found" ] || fail "show deleted: $STDERR"
ok "theme delete echoes the record and clears .appearance.theme"

HOSTILE="\$(touch $PWNED)'; x"
run 0 "$MESA" theme create --from dark --name "$HOSTILE"
[ "$(jqs .name)" = "$HOSTILE" ] || fail "hostile name round trip: $STDOUT"
HID=$(jqs .id)
run 0 "$MESA" theme show "$HID"
[ "$(jqs .name)" = "$HOSTILE" ] || fail "hostile name on show"
run 0 "$MESA" theme use "$HID"
[ ! -e "$PWNED" ] || fail "hostile name ran a command"
run 0 "$MESA" theme delete "$HID"
[ ! -e "$PWNED" ] || fail "hostile name ran a command"
ok "hostile theme name round-trips byte-identical and runs nothing"

# ================= API =================

PORT=17893
lsof -i ":$PORT" >/dev/null 2>&1 && fail "port $PORT is busy"
"$MESA" serve --port "$PORT" >"$TMP/serve.log" 2>&1 &
SERVER_PID=$!
BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 100); do
  curl -sf "$BASE/api/themes" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/api/themes" >/dev/null || fail "server did not start (log: $(cat "$TMP/serve.log"))"

api() { # api <expected-status> <method> <path> [json-body]
  local expected=$1 method=$2 path=$3 body=${4:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method")
  case "$method" in
    POST | PUT | PATCH | DELETE)
      args+=(-H 'Content-Type: application/json' -d "${body:-{\}}")
      ;;
  esac
  STATUS=$(curl "${args[@]}" "$BASE$path")
  BODY=$(cat "$TMP/body")
  [ "$STATUS" = "$expected" ] ||
    fail "expected HTTP $expected, got $STATUS: $method $path ($BODY)"
}
jqb() { jq -r "$1" <<<"$BODY"; }

api 200 GET /api/themes
[ "$(jqb 'map(.id) | join(",")')" = "dark,light,contrast,crimson" ] || fail "GET list: $BODY"
ok "GET /api/themes: 200 with the 4 built-ins"

api 201 POST /api/themes '{"from":"light","name":"Paper"}'
[ "$(jqb .name)" = "Paper" ] || fail "POST create: $BODY"
CID=$(jqb .id)
ok "POST /api/themes: 201 custom copy"

api 200 GET "/api/themes/$CID"
[ "$(jqb .name)" = "Paper" ] || fail "GET one: $BODY"

api 200 PATCH "/api/themes/$CID" '{"name":"Paper2","slots":{"accent":"#0f0"}}'
[ "$(jqb .name)" = "Paper2" ] && [ "$(jqb '.vars["--cyan-rgb"]')" = "0, 255, 0" ] || fail "PATCH: $BODY"
ok "PATCH /api/themes/<id>: name + slot applied, vars derived"

api 422 PATCH /api/themes/crimson '{"name":"X"}'
ok "PATCH on a built-in: 422"
api 422 PATCH "/api/themes/$CID" '{"slots":{"accent":"nope"}}'
ok "PATCH with a bad colour: 422"

BEFORE=$(curl -s "$BASE/api/themes")
api 200 POST /api/themes/preview '{"slots":{"bg":"#000000","panel":"#111111","text":"#ffffff","muted":"#aaaaaa","accent":"#00ff00","accent2":"#ff00ff","good":"#00ff00","warn":"#ffff00","bad":"#ff0000"}}'
jq -e 'has("vars") and has("scheme") and has("warnings")' <<<"$BODY" >/dev/null || fail "preview shape: $BODY"
[ "$(curl -s "$BASE/api/themes")" = "$BEFORE" ] || fail "preview must write nothing"
ok "POST /api/themes/preview: scheme/vars/warnings, list unchanged"

api 200 PUT /api/config/appearance "{\"theme\":\"$CID\"}"
api 200 GET /api/config/appearance
[ "$(jqb .custom.id)" = "$CID" ] || fail "appearance custom.id: $BODY"
ok "PUT appearance the custom theme: 200, GET carries custom.id"
api 422 PUT /api/config/appearance '{"theme":"custom-999"}'
api 200 GET /api/config/appearance
[ "$(jqb .theme)" = "$CID" ] || fail "422 must write nothing: $BODY"
ok "PUT appearance custom-999: 422, nothing written"

api 200 DELETE "/api/themes/$CID"
[ "$(jqb .id)" = "$CID" ] || fail "DELETE echo: $BODY"
api 200 GET /api/config/appearance
[ "$(jqb .theme)" != "$CID" ] || fail "delete must clear the saved appearance: $BODY"
api 404 GET "/api/themes/$CID"
ok "DELETE /api/themes/<id>: echo, appearance cleared, then 404"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: evil.example" "$BASE/api/themes")
[ "$STATUS" = "403" ] || fail "foreign Host on GET /api/themes: expected 403, got $STATUS"
ok "foreign Host on GET /api/themes: 403"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' \
  -d '{"from":"dark"}' "$BASE/api/themes")
NOCT=$STATUS
case "$STATUS" in 4*) ;; *) fail "POST without application/json: expected 4xx, got $STATUS" ;; esac
api 200 GET /api/themes
[ "$(jqb length)" = "4" ] || fail "refused POST must create nothing"
ok "POST without Content-Type application/json: refused ($NOCT), nothing created"

echo "PASS: theme-check"
