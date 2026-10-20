#!/usr/bin/env bash
# mark gate (naru task 2123, docs/mark-skins.md): `naru mark` over the CLI,
# throwaway HOME, MESA_DB and MESA_CONFIG_FILE, no serve.
#
#   * list: the three built-ins first, then custom skins;
#   * add (file and stdin) -> show by id and by name; --quiet drops body;
#     a taken name `conflict`, a reserved name, an empty body and one over
#     64 KiB `validation`, nothing written; a hostile name byte-identical;
#   * use: a built-in, a custom skin by name, an unknown one `validation`;
#     add --use; remove echoes the record and clears the active skin;
#   * preview: a bad skin `validation` and no session `not_found`, no board;
#     with a live session one html board holding the driver and the skin.
set -euo pipefail
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')
unset CLAUDE_CODE_SESSION_ID

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
cargo build --quiet
NARU="$PWD/target/debug/naru"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MESA_DB="$TMP/mesa.db"
export HOME="$TMP/home"
export MESA_CONFIG_FILE="$TMP/config.json"
mkdir -p "$HOME"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
# run <code> cmd… : output in $OUT (stdout) and $ERR (stderr)
run() {
  local want=$1; shift
  set +e; OUT=$("$@" 2>"$TMP/err"); local rc=$?; set -e
  ERR=$(cat "$TMP/err")
  [ "$rc" = "$want" ] || fail "'$*' exited $rc, wanted $want ($ERR)"
}
code() { echo "$ERR" | jq -r .error.code; }
active() { "$NARU" theme use system --quiet | jq -r '.mark_skin // "null"'; }

SKIN="$TMP/orb.html"
cat >"$SKIN" <<'EOF'
<!doctype html>
<html><body>
<svg viewBox="0 0 64 64"><circle id="core" cx="32" cy="32" r="16"/></svg>
<script>naruMark.onFrame(function (f) { document.getElementById('core').setAttribute('fill', f.palette.bars[3]) })</script>
</body></html>
EOF

run 0 "$NARU" mark list
[ "$(echo "$OUT" | jq -c '[.[] | .id]')" = '["waveform","face","blob"]' ] || fail "built-ins: $OUT"
echo "$OUT" | jq -e 'all(.builtin)' >/dev/null || fail "built-ins flagged"
ok "list on a fresh db is the three built-ins"

run 0 "$NARU" mark add Ember --file "$SKIN"
ID=$(echo "$OUT" | jq -r .id)
[[ "$ID" == custom-* ]] || fail "id $ID"
[ "$(echo "$OUT" | jq -r .body)" = "$(cat "$SKIN")" ] || fail "body round trip"
run 0 "$NARU" mark show ember
[ "$(echo "$OUT" | jq -r .id)" = "$ID" ] || fail "show by name"
run 0 "$NARU" mark get "$ID" --quiet
[ "$(echo "$OUT" | jq -c 'keys')" = '["created_at","id","name","updated_at"]' ] || fail "show --quiet keys: $OUT"
run 0 "$NARU" mark list
[ "$(echo "$OUT" | jq -c '.[3] | [.id, .name, .builtin, has("body")]')" = "[\"$ID\",\"Ember\",false,false]" ] ||
  fail "list row: $OUT"
ok "add, show by id and name, --quiet key set, list row"

run 0 "$NARU" mark add Stdin --file - --quiet <"$SKIN"
echo "$OUT" | jq -e 'has("body")|not' >/dev/null || fail "add --quiet kept body"
HOSTILE='$(touch pwned) "q" `x`'
run 0 "$NARU" mark install "$HOSTILE" --file "$SKIN"
[ "$(echo "$OUT" | jq -r .name)" = "$HOSTILE" ] || fail "hostile name changed"
[ ! -e pwned ] && [ ! -e "$HOME/pwned" ] || fail "hostile name ran"
ok "stdin, install alias, hostile name byte-identical and inert"

COUNT=$("$NARU" mark list | jq length)
run 1 "$NARU" mark add EMBER --file "$SKIN"
[ "$(code)" = conflict ] || fail "taken name: $ERR"
run 1 "$NARU" mark add face --file "$SKIN"
[ "$(code)" = validation ] || fail "reserved name: $ERR"
printf '  \n' >"$TMP/empty.html"
run 1 "$NARU" mark add Empty --file "$TMP/empty.html"
[ "$(code)" = validation ] || fail "empty body: $ERR"
head -c 65537 /dev/zero | tr '\0' x >"$TMP/big.html"
run 1 "$NARU" mark add Big --file "$TMP/big.html"
[ "$(code)" = validation ] || fail "big body: $ERR"
run 1 "$NARU" mark add Missing --file "$TMP/nope.html"
[ "$(code)" = validation ] || fail "missing file: $ERR"
[ "$("$NARU" mark list | jq length)" = "$COUNT" ] || fail "a refused add wrote a skin"
run 1 "$NARU" mark show nope
[ "$(code)" = not_found ] || fail "unknown show: $ERR"
run 1 "$NARU" mark show waveform
[ "$(code)" = validation ] || fail "built-in show: $ERR"
run 2 "$NARU" mark add NoFile
ok "conflict / validation / not_found shapes, nothing written"

run 0 "$NARU" mark use Face
[ "$(echo "$OUT" | jq -r .mark_skin)" = face ] || fail "use built-in: $OUT"
run 0 "$NARU" mark use ember --quiet
[ "$(echo "$OUT" | jq -r .mark_skin)" = "$ID" ] || fail "use by name: $OUT"
run 1 "$NARU" mark use nope
[ "$(code)" = validation ] || fail "use unknown: $ERR"
[ "$(active)" = "$ID" ] || fail "a refused use changed the skin"
ok "use: built-in, custom by name, unknown refused"

run 0 "$NARU" mark remove Ember
[ "$(echo "$OUT" | jq -r .id)" = "$ID" ] || fail "remove echo"
[ "$(echo "$OUT" | jq -r .body)" = "$(cat "$SKIN")" ] || fail "remove echo body"
[ "$(active)" = null ] || fail "remove left the active skin set"
run 1 "$NARU" mark show "$ID"
[ "$(code)" = not_found ] || fail "removed skin still there"
run 0 "$NARU" mark add Ember2 --file "$SKIN" --use
ID2=$(echo "$OUT" | jq -r .id)
[ "$(active)" = "$ID2" ] || fail "add --use"
run 0 "$NARU" mark delete "$ID2" --quiet
echo "$OUT" | jq -e 'has("body")|not' >/dev/null || fail "remove --quiet kept body"
[ "$(active)" = null ] || fail "remove --quiet left the active skin set"
ok "remove echoes and clears the active skin; add --use"

run 1 "$NARU" mark preview --file "$SKIN"
[ "$(code)" = not_found ] || fail "preview with no session: $ERR"
run 0 "$NARU" live start --no-agent
run 1 "$NARU" mark preview --file "$TMP/big.html"
[ "$(code)" = validation ] || fail "preview big: $ERR"
run 1 "$NARU" mark preview nope
[ "$(code)" = not_found ] || fail "preview unknown: $ERR"
run 2 "$NARU" mark preview
[ "$("$NARU" live board list | jq length)" = 0 ] || fail "a refused preview pushed a board"
run 0 "$NARU" mark preview --file "$SKIN" --say "Here it is." --title "Ember look"
BOARD=$(echo "$OUT" | jq -r .id)
[ "$(echo "$OUT" | jq -r .kind)" = html ] || fail "preview kind"
[ "$(echo "$OUT" | jq -r .title)" = "Ember look" ] || fail "preview title"
BODY=$(echo "$OUT" | jq -r .body)
[[ "$BODY" == '<!doctype html><style>'* ]] || fail "driver not first after the doctype"
echo "$BODY" | grep -q "window.naruMark=" || fail "driver missing"
echo "$BODY" | grep -q "naruMark.onFrame(function (f)" || fail "skin missing"
"$NARU" live turns | jq -e 'any(.[]; .text == "Here it is.")' >/dev/null || fail "--say turn"
run 0 "$NARU" mark preview "$HOSTILE" --quiet
echo "$OUT" | jq -e 'has("body")|not' >/dev/null || fail "preview --quiet kept body"
[ "$("$NARU" live board list | jq length)" = 2 ] || fail "board count"
# No `live stop`: stopping a session with turns starts a summary job (a
# real `claude -p` call); the trap's rm takes the db with it.
ok "preview: refusals push nothing; a pushed board holds driver + skin (board $BOARD)"

echo "mark-check: all ok"
