#!/usr/bin/env bash
# agent-route gate (mesa task 1654): the `agent-route` library hook against a
# throwaway HOME. The hook is extracted from `naru library show agent-route.sh`
# so what is tested is exactly what `naru library hook enable agent-route.sh
# --event PreToolUse --matcher 'Agent|Task'` would seed.
#
#   * a UI-verification brief typed general-purpose, or untyped -> ui-verifier,
#     every other tool_input field byte-identical, one tab-separated log line;
#   * an implementer-shaped brief -> implementer;
#   * Explore / fork / an already-specialist type, a no-match brief (no log),
#     decide backend off, a missing agent definition -> no output;
#   * a hostile description is logged literally and nothing runs;
#   * garbage / empty stdin, no naru on PATH, no jq -> exit 0, no output;
#   * the model step (naru task 2684), against a stub `claude`: a named role
#     gets the role table's model with no model call, a swap and a model land
#     in one updatedInput, an untyped brief takes the stub's pick, a failing
#     call / the switch off leave the spawn untouched, naru-live (target or
#     spawning session), a fork and an explicit model are never routed, and a
#     rule-routed spawn costs the hook under 0.5 s.
set -euo pipefail
# Drop inherited NARU_* vars: Naru reads them before MESA_*, so one would escape this script's isolation.
unset $(env | sed -n 's/^\(NARU_[A-Za-z0-9_]*\)=.*/\1/p')
unset CLAUDE_CODE_SESSION_ID CLAUDE_PROJECT_DIR

cd "$(dirname "$0")/.."
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cargo build --quiet
BIN="$PWD/target/debug"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MESA_DB="$TMP/mesa.db"
export MESA_CONFIG_FILE="$TMP/cfg/config.json"
# The model router is off for every case before (j): those cases pin the swap alone.
mkdir -p "$TMP/cfg"
ROUTER_OFF='{"watchers": {"model-router": "off"}}'
echo "$ROUTER_OFF" >"$MESA_CONFIG_FILE"
# A stub `claude`: never the real one. Each call is one line in $STUB_CALLS.
mkdir -p "$TMP/stub"
export STUB_CALLS="$TMP/stub/calls"
cat >"$TMP/stub/claude" <<'STUB'
#!/usr/bin/env bash
echo call >>"$STUB_CALLS"
[ "${STUB_MODE:-ok}" = fail ] && { echo "stub failure" >&2; exit 1; }
printf '{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":{"reason":"Task: read-only summary","model":"%s","risky":false}}\n' "${STUB_MODEL:-haiku}"
STUB
chmod +x "$TMP/stub/claude"
export MESA_CLAUDE_BIN="$TMP/stub/claude"
export HOME="$TMP/home"
mkdir -p "$HOME/.claude/agents"
for a in ui-verifier implementer; do echo "# $a" >"$HOME/.claude/agents/$a.md"; done
export PATH="$BIN:$PATH"
NARU="$BIN/naru"
LOG="$HOME/.naru/logs/agent-route.log"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

HOOK="$TMP/agent-route.sh"
"$NARU" library show agent-route.sh | jq -r .body >"$HOOK"
chmod +x "$HOOK"
head -1 "$HOOK" | grep -q '^#!' || fail "the built-in body must start with a shebang"
bash -n "$HOOK" || fail "bash -n on the built-in body"
ok "agent-route.sh extracted from the library, parses under bash -n"

# payload <tool_name> <subagent_type|-> <description> <prompt>
payload() {
  jq -nc --arg t "$1" --arg s "$2" --arg d "$3" --arg p "$4" \
    '{session_id:"sess-1",tool_name:$t,tool_input:({description:$d,prompt:$p,run_in_background:true,extra:{k:[1,2]}}
      + (if $s=="-" then {} else {subagent_type:$s} end))}'
}
lines() { if [ -f "$LOG" ]; then wc -l <"$LOG" | tr -d ' '; else echo 0; fi; }

UI_D="Verify the board UI with khora screenshots"
UI_P="Open the board in the browser with khora and take screenshots of each column."
IMPL_D="Implement the retry cap"
IMPL_P="You own the tree. Add the cap in src/core/store.rs and run the fast gate."

# (a) general-purpose UI brief -> ui-verifier, input otherwise identical
in=$(payload Agent general-purpose "$UI_D" "$UI_P")
out=$("$HOOK" <<<"$in")
[ "$(jq -r .hookSpecificOutput.hookEventName <<<"$out")" = PreToolUse ] || fail "event name: $out"
[ "$(jq -r '.hookSpecificOutput.permissionDecision // "none"' <<<"$out")" = none ] || fail "must not set a permission decision: $out"
[ "$(jq -r .hookSpecificOutput.updatedInput.subagent_type <<<"$out")" = ui-verifier ] || fail "not swapped: $out"
[ "$(jq -cS '.hookSpecificOutput.updatedInput | del(.subagent_type)' <<<"$out")" = "$(jq -cS '.tool_input | del(.subagent_type)' <<<"$in")" ] \
  || fail "other input fields changed: $out"
[ "$(lines)" = 1 ] || fail "expected one log line"
IFS=$'\t' read -r ts sid from to rule conf desc <"$LOG"
[[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]] || fail "timestamp: $ts"
[ "$sid" = sess-1 ] && [ "$from" = general-purpose ] && [ "$to" = ui-verifier ] && [ "$rule" = ui-verifier ] \
  && [ "$conf" = 0.8 ] && [ "$desc" = "$UI_D" ] || fail "log line: $(cat "$LOG")"
ok "a general-purpose UI brief is swapped to ui-verifier, input otherwise byte-identical, one log line"

# (b) missing subagent_type, old Task tool name
out=$("$HOOK" <<<"$(payload Task - "$UI_D" "$UI_P")")
[ "$(jq -r .hookSpecificOutput.updatedInput.subagent_type <<<"$out")" = ui-verifier ] || fail "untyped not swapped: $out"
[ "$(lines)" = 2 ] && tail -1 "$LOG" | cut -f3 | grep -qx -- '-' || fail "untyped log line: $(tail -1 "$LOG")"
ok "an untyped spawn (tool Task) is swapped, from logged as -"

# (c) implementer-shaped brief
out=$("$HOOK" <<<"$(payload Agent - "$IMPL_D" "$IMPL_P")")
[ "$(jq -r .hookSpecificOutput.updatedInput.subagent_type <<<"$out")" = implementer ] || fail "implementer: $out"
ok "an implementer brief is swapped to implementer"

# (c2) a long multibyte prompt: the 4000 cut is by codepoints, never mid-character
LONG_P="$UI_P $(printf '—%.0s' $(seq 1 3000))"
[ "$(printf '%s' "$LONG_P" | wc -c | tr -d ' ')" -gt 4000 ] || fail "long prompt setup"
out=$("$HOOK" <<<"$(payload Agent general-purpose "$UI_D" "$LONG_P")")
[ "$(jq -r .hookSpecificOutput.updatedInput.subagent_type <<<"$out")" = ui-verifier ] || fail "long multibyte prompt not swapped: $out"
[ "$(jq -r .hookSpecificOutput.updatedInput.prompt <<<"$out")" = "$LONG_P" ] || fail "prompt must be passed on whole"
ok "a >4000-byte prompt full of em-dashes still swaps, prompt untouched"

# (d) types the hook leaves alone
for t in Explore fork ui-verifier teammate; do
  out=$("$HOOK" <<<"$(payload Agent "$t" "$UI_D" "$UI_P")")
  [ -z "$out" ] || fail "type $t must pass through: $out"
done
out=$("$HOOK" <<<"$(payload Bash - "$UI_D" "$UI_P")")
[ -z "$out" ] || fail "a non-Agent tool must pass through: $out"
ok "Explore / fork / a specialist / a teammate / another tool pass through"

# (e) no match: no output, no log
before=$(lines)
out=$("$HOOK" <<<"$(payload Agent general-purpose "Summarize the pricing history" "Read the notes and write two paragraphs.")")
[ -z "$out" ] && [ "$(lines)" = "$before" ] || fail "a no-match brief must pass through silently: $out"
ok "a no-match brief passes through, nothing logged"

# (f) target definition missing
mv "$HOME/.claude/agents/ui-verifier.md" "$TMP/ui-verifier.md"
before=$(lines)
out=$("$HOOK" <<<"$(payload Agent general-purpose "$UI_D" "$UI_P")")
[ -z "$out" ] && [ "$(lines)" = "$before" ] || fail "a missing agent definition must pass through: $out"
# ... but CLAUDE_PROJECT_DIR's own .claude/agents counts
mkdir -p "$TMP/proj/.claude/agents"; cp "$TMP/ui-verifier.md" "$TMP/proj/.claude/agents/"
out=$(CLAUDE_PROJECT_DIR="$TMP/proj" "$HOOK" <<<"$(payload Agent general-purpose "$UI_D" "$UI_P")")
[ "$(jq -r .hookSpecificOutput.updatedInput.subagent_type <<<"$out")" = ui-verifier ] || fail "project-scope definition: $out"
mv "$TMP/ui-verifier.md" "$HOME/.claude/agents/ui-verifier.md"
ok "a swap needs the agent definition (project or user scope)"

# (g) backend off
echo '{"decide": {"backend": "off"}, "watchers": {"model-router": "off"}}' >"$MESA_CONFIG_FILE"
before=$(lines)
out=$("$HOOK" <<<"$(payload Agent general-purpose "$UI_D" "$UI_P")")
[ -z "$out" ] && [ "$(lines)" = "$before" ] || fail "decide off must pass through: $out"
echo "$ROUTER_OFF" >"$MESA_CONFIG_FILE"
ok "decide backend off passes through"

# (h) hostile description: logged literally, nothing executed
HOSTILE='Verify $(touch '"$TMP"'/pwned) `touch '"$TMP"'/pwned2` "q" '"'"'s'"'"' screenshot khora'
out=$("$HOOK" <<<"$(payload Agent general-purpose "$HOSTILE" "$UI_P")")
[ "$(jq -r .hookSpecificOutput.updatedInput.description <<<"$out")" = "$HOSTILE" ] || fail "hostile description not preserved: $out"
tail -1 "$LOG" | cut -f7- | grep -qxF -- "$HOSTILE" || fail "hostile log line: $(tail -1 "$LOG")"
[ ! -e "$TMP/pwned" ] && [ ! -e "$TMP/pwned2" ] || fail "a description was executed"
NL=$(payload Agent general-purpose $'Verify with\nkhora screenshot\there' "$UI_P")
"$HOOK" <<<"$NL" >/dev/null
[ "$(tail -1 "$LOG" | cut -f7-)" = "Verify with khora screenshot here" ] || fail "newlines/tabs not folded: $(tail -1 "$LOG")"
ok "a hostile description is data: logged literally, nothing executed, newlines folded"

# (i) never wedges
out=$(echo 'not json {' | "$HOOK") && [ -z "$out" ] || fail "garbage stdin"
out=$("$HOOK" </dev/null) && [ -z "$out" ] || fail "empty stdin"
IN=$(payload Agent general-purpose "$UI_D" "$UI_P") # a here-string: a hook exiting early must not SIGPIPE a writer
out=$(PATH=/usr/bin:/bin "$HOOK" <<<"$IN") && [ -z "$out" ] || fail "no naru on PATH"
# no jq: a PATH holding naru and bash utilities but no jq
mkdir -p "$TMP/nojq"
for b in bash cat head tr date mkdir; do ln -s "$(command -v $b)" "$TMP/nojq/$b"; done
ln -s "$NARU" "$TMP/nojq/naru"
out=$(PATH="$TMP/nojq" "$BASH" "$HOOK" <<<"$IN") && [ -z "$out" ] || fail "no jq"
ok "garbage, empty stdin, no naru and no jq all exit 0 with no output"

# (j) the model step (naru task 2684), the router on
rm -f "$MESA_CONFIG_FILE"
RLOG="$HOME/.naru/logs/model-router.log"
rlines() { if [ -f "$RLOG" ]; then wc -l <"$RLOG" | tr -d ' '; else echo 0; fi; }
calls() { if [ -f "$STUB_CALLS" ]; then wc -l <"$STUB_CALLS" | tr -d ' '; else echo 0; fi; }

in=$(payload Agent verifier "Verify task 9" "You are the verifier. Check the gate output.")
out=$("$HOOK" <<<"$in")
[ "$(jq -r .hookSpecificOutput.updatedInput.model <<<"$out")" = sonnet ] || fail "verifier model: $out"
[ "$(jq -cS '.hookSpecificOutput.updatedInput | del(.model)' <<<"$out")" = "$(jq -cS '.tool_input' <<<"$in")" ] \
  || fail "the model step changed another field: $out"
[ "$(calls)" = 0 ] || fail "a named role must not call the model"
[ "$(tail -1 "$RLOG" | jq -r '[.kind, .source, .model, .subagent_type, .session_id] | join(" ")')" = "subagent rule sonnet verifier sess-1" ] \
  || fail "verifier log line: $(tail -1 "$RLOG")"
out=$("$HOOK" <<<"$(payload Agent planner "Plan it" "Fix one typo in README.md")")
[ "$(jq -r .hookSpecificOutput.updatedInput.model <<<"$out")" = opus ] || fail "planner model: $out"
ok "a named role gets the role table's model (verifier sonnet, planner opus), no model call, one subagent log line"

out=$("$HOOK" <<<"$(payload Agent general-purpose "$UI_D" "$UI_P")")
[ "$(jq -r '.hookSpecificOutput.updatedInput | "\(.subagent_type) \(.model)"' <<<"$out")" = "ui-verifier sonnet" ] \
  || fail "swap and model in one updatedInput: $out"
[ "$(calls)" = 0 ] || fail "a swapped spawn is rule-routed"
ok "a general-purpose UI brief is swapped AND given the swapped role's model in one updatedInput"

before=$(rlines)
out=$("$HOOK" <<<"$(payload Agent general-purpose "Summarize the pricing history" "Read the notes and write two paragraphs.")")
[ "$(jq -r '.hookSpecificOutput.updatedInput | "\(.subagent_type) \(.model)"' <<<"$out")" = "general-purpose haiku" ] \
  || fail "untyped brief model: $out"
[ "$(calls)" = 1 ] && [ "$(rlines)" = $((before + 1)) ] || fail "one model call, one log line"
[ "$(tail -1 "$RLOG" | jq -r '.source')" = haiku ] || fail "haiku log line: $(tail -1 "$RLOG")"
grep -q 'Read the notes and write two paragraphs' "$RLOG" || fail "the log keeps the brief's start"
ok "a no-match general-purpose brief takes the router call's pick, logged source haiku"

out=$(STUB_MODE=fail "$HOOK" <<<"$(payload Agent general-purpose "Summarize the pricing history" "Read the notes.")")
[ -z "$out" ] || fail "a failed router call must leave the spawn untouched: $out"
[ "$(tail -1 "$RLOG" | jq -r '"\(.source) \(.model)"')" = "fallback null" ] || fail "fallback log line: $(tail -1 "$RLOG")"
ok "a failing router call leaves the spawn untouched (fallback, model null, logged)"

before=$(rlines); c0=$(calls)
LIVE=$(payload Agent recon "Look" "Find the file." | jq -c '.agent_type = "naru-live"')
for p in "$LIVE" "$(payload Agent naru-live "Talk" "Say hi.")" "$(payload Agent fork "Fork" "Go on.")" \
  "$(payload Agent recon "Look" "Find the file." | jq -c '.tool_input.model = "haiku"')"; do
  out=$("$HOOK" <<<"$p")
  [ -z "$out" ] || fail "never routed: $out <- $p"
done
[ "$(rlines)" = "$before" ] && [ "$(calls)" = "$c0" ] || fail "a refusal makes no call and logs nothing"
ok "naru-live (target or spawning session), a fork and an explicit model are never routed, nothing logged"

echo "$ROUTER_OFF" >"$MESA_CONFIG_FILE"
out=$("$HOOK" <<<"$(payload Agent verifier "Verify" "Check it.")")
[ -z "$out" ] || fail "the switch off must leave the spawn untouched: $out"
rm -f "$MESA_CONFIG_FILE"
ok "the switch off leaves the spawn untouched"

IN=$(payload Agent recon "Look" "Find the file.")
t0=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
for i in 1 2 3 4 5; do "$HOOK" <<<"$IN" >/dev/null; done
t1=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
per=$(perl -e "printf '%.3f', ($t1 - $t0) / 5")
perl -e "exit(!($per < 0.5))" || fail "a rule-routed spawn costs the hook ${per}s (budget 0.5 s)"
ok "a rule-routed spawn costs the hook ${per}s (budget 0.5 s)"

echo "agent-route-check: all ok"
