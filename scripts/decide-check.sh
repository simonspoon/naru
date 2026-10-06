#!/usr/bin/env bash
# Decide gate (mesa task 1653): `naru decide` (src/core/decide.rs), the local
# "pick one of these options" call. CLI only, no server, no network.
#
# Covers, in order:
#   1. default rules pick (an implementer prompt, a diff-review prompt, the
#      fall-through), the printed key set, `--question` flag form, the prompt
#      read from `--input-file -`, an option not offered is never chosen;
#   2. no rule matching is `choice: null`, confidence 0, exit 0;
#   3. `decide.backend: "off"` -> null with backend "off"; an unknown backend
#      is `validation` naming it;
#   4. a custom rules file (beside config.json, then via `rules-file`)
#      overrides the built-ins, and `none` vetoes;
#   5. a bad rules file / bad regex is `validation` (exit 1) naming file + rule;
#   6. usage and validation: missing question / options -> exit 2, one option,
#      duplicates, empty question -> exit 1;
#   7. `--print-default-rules` is valid JSON that, saved as the rules file,
#      decides the same as the built-in set.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
MESA=target/debug/mesa

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MESA_DB="$TMP/mesa.db"
export HOME=$(mkdir -p "$TMP/home" && cd "$TMP/home" && pwd -P)
mkdir -p "$TMP/cfg"
export MESA_CONFIG_FILE="$TMP/cfg/config.json" # absent until section 3

CHECKS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { CHECKS=$((CHECKS + 1)); echo "ok: $*"; }

AGENTS=(--option implementer --option diff-reviewer --option general-purpose)

# expect_code <code> <args...> — runs decide, fails unless the exit status is <code>.
expect_code() {
  local want=$1; shift
  set +e
  "$MESA" decide "$@" >"$TMP/out" 2>"$TMP/err"
  local got=$?
  set -e
  [ "$got" -eq "$want" ] || fail "decide $*: exit $got, want $want ($(cat "$TMP/err"))"
}

# --- 1. default rules ---
OUT=$("$MESA" decide "Implement the retry" "${AGENTS[@]}" --input "You are the implementer. Edit src/lib.rs.")
[ "$(jq -r .choice <<<"$OUT")" = implementer ] || fail "implementer prompt: $OUT"
[ "$(jq -r .backend <<<"$OUT")" = rules ] || fail "backend: $OUT"
[ "$(jq -r '.rule' <<<"$OUT")" != null ] || fail "rule id missing: $OUT"
[ "$(jq -c 'keys' <<<"$OUT")" = '["agreement","backend","choice","confidence","rule"]' ] || fail "keys: $OUT"
ok "default rules pick an implementer, printing the five keys"

OUT=$("$MESA" decide --question "Check the work" "${AGENTS[@]}" --input "Please review the uncommitted diff.")
[ "$(jq -r .choice <<<"$OUT")" = diff-reviewer ] || fail "diff review: $OUT"
ok "--question flag form, diff-review prompt"

OUT=$(printf 'review the branch carefully' | "$MESA" decide "Check" "${AGENTS[@]}" --input-file -)
[ "$(jq -r .choice <<<"$OUT")" = diff-reviewer ] || fail "stdin input: $OUT"
ok "--input-file - reads the prompt from stdin"

OUT=$("$MESA" decide "Implement x" --option diff-reviewer --option general-purpose --input "you implement x")
[ "$(jq -r .choice <<<"$OUT")" = general-purpose ] || fail "unoffered choice chosen: $OUT"
ok "a rule whose choice is not offered is skipped"

OUT=$("$MESA" decide "Write docs" "${AGENTS[@]}")
[ "$(jq -r .choice <<<"$OUT")" = general-purpose ] || fail "fall-through: $OUT"
[ "$(jq .confidence <<<"$OUT")" = 0.5 ] || fail "fall-through confidence: $OUT"
ok "the fall-through rule picks general-purpose at 0.5"

# --- 2. no decision ---
OUT=$("$MESA" decide "Pick" --option red --option blue --input "whatever")
[ "$(jq -c '[.choice,.confidence,.agreement]' <<<"$OUT")" = '[null,0.0,0.0]' ] || fail "no decision: $OUT"
ok "no rule matching is choice null, confidence 0, exit 0"

# --- 3. backend off / unknown ---
echo '{"decide": {"backend": "off"}}' > "$MESA_CONFIG_FILE"
OUT=$("$MESA" decide "Implement x" "${AGENTS[@]}" --input "you implement x")
[ "$(jq -c '[.choice,.backend]' <<<"$OUT")" = '[null,"off"]' ] || fail "off: $OUT"
ok "backend off decides nothing"

echo '{"decide": {"backend": "gpt"}}' > "$MESA_CONFIG_FILE"
expect_code 1 "Q" "${AGENTS[@]}"
[ "$(jq -r .error.code "$TMP/err")" = validation ] || fail "unknown backend code: $(cat "$TMP/err")"
grep -q gpt "$TMP/err" || fail "unknown backend not named: $(cat "$TMP/err")"
ok "unknown backend is validation naming it"

# --- 4. custom rules ---
echo '{"decide": {"backend": "rules"}}' > "$MESA_CONFIG_FILE"
cat > "$TMP/cfg/decide-rules.json" <<'EOF'
{"rules": [
  {"id": "veto", "choice": "diff-reviewer", "all": [{"field": "input", "pattern": "alpha"}],
   "none": [{"field": "question", "pattern": "skip"}]},
  {"id": "alpha-rule", "choice": "implementer", "confidence": 0.9,
   "all": [{"field": "input", "pattern": "alpha"}]}
]}
EOF
OUT=$("$MESA" decide "go" "${AGENTS[@]}" --input "ALPHA")
[ "$(jq -r .rule <<<"$OUT")" = veto ] || fail "custom file beside config: $OUT"
[ "$(jq .agreement <<<"$OUT")" = 0.5 ] || fail "agreement: $OUT"
OUT=$("$MESA" decide "please skip" "${AGENTS[@]}" --input "alpha")
[ "$(jq -r .rule <<<"$OUT")" = alpha-rule ] || fail "none veto: $OUT"
[ "$(jq .confidence <<<"$OUT")" = 0.9 ] || fail "custom confidence: $OUT"
ok "a rules file beside config.json overrides the built-ins; none vetoes"

cp "$TMP/cfg/decide-rules.json" "$TMP/elsewhere.json"
rm "$TMP/cfg/decide-rules.json"
echo "{\"decide\": {\"rules-file\": \"$TMP/elsewhere.json\"}}" > "$MESA_CONFIG_FILE"
OUT=$("$MESA" decide "go" "${AGENTS[@]}" --input "alpha")
[ "$(jq -r .rule <<<"$OUT")" = veto ] || fail "rules-file key: $OUT"
ok "decide.rules-file names the rules file"

# --- 5. bad rules file ---
echo 'not json' > "$TMP/elsewhere.json"
expect_code 1 "go" "${AGENTS[@]}"
[ "$(jq -r .error.code "$TMP/err")" = validation ] || fail "bad file code: $(cat "$TMP/err")"
grep -q elsewhere.json "$TMP/err" || fail "bad file not named: $(cat "$TMP/err")"
echo '{"rules":[{"id":"oops","choice":"implementer","all":[{"field":"input","pattern":"("}]}]}' > "$TMP/elsewhere.json"
expect_code 1 "go" "${AGENTS[@]}"
grep -q oops "$TMP/err" && grep -q elsewhere.json "$TMP/err" || fail "bad regex not named: $(cat "$TMP/err")"
ok "an unparseable file and a bad regex are validation naming file and rule"

# --- 6. usage / validation ---
rm "$MESA_CONFIG_FILE"
expect_code 2 --option a --option b
expect_code 2 "Q"
expect_code 2 "Q" --question "R" --option a --option b
expect_code 1 "Q" --option a
expect_code 1 "Q" --option a --option a
expect_code 1 "  " --option a --option b
expect_code 1 "Q" --option a --option ""
ok "usage errors exit 2; one/duplicate/empty options and an empty question exit 1"

# --- 7. print-default-rules ---
"$MESA" decide --print-default-rules > "$TMP/default.json"
jq -e '.rules | length > 0' "$TMP/default.json" >/dev/null || fail "default rules not valid JSON"
cp "$TMP/default.json" "$TMP/cfg/decide-rules.json"
OUT=$("$MESA" decide "Implement the retry" "${AGENTS[@]}" --input "You are the implementer.")
[ "$(jq -r .choice <<<"$OUT")" = implementer ] || fail "printed rules as file: $OUT"
ok "--print-default-rules is valid JSON and works as the rules file"

echo "decide-check: $CHECKS checks passed"
