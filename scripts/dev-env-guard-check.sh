#!/usr/bin/env bash
# dev-env-guard gate (naru task 2094, docs/dev-env.md): the `dev-env-guard`
# library hook, extracted from `naru library show dev-env-guard.sh`, against
# synthetic PreToolUse payloads. Needs jq. No registration or settings needed.
set -euo pipefail
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
export HOME="$TMP/home"
mkdir -p "$HOME"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

HOOK="$TMP/dev-env-guard.sh"
"$BIN/naru" library show dev-env-guard.sh | jq -r .body >"$HOOK"
chmod +x "$HOOK"
head -1 "$HOOK" | grep -q '^#!' || fail "the built-in body must start with a shebang"
bash -n "$HOOK" || fail "bash -n on the built-in body"
ok "dev-env-guard.sh extracted from the library, parses under bash -n"

bash_in() { jq -nc --arg c "$1" --arg a "${2:-}" \
  '{tool_name:"Bash",tool_input:{command:$c}} + (if $a=="" then {} else {agent_type:$a} end)'; }
file_in() { jq -nc --arg t "$1" --arg p "$2" '{tool_name:$t,tool_input:{file_path:$p,content:"x"}}'; }

deny() { # name payload
  local out; out=$("$HOOK" <<<"$2") || fail "$1: nonzero exit"
  [ "$(jq -r .hookSpecificOutput.permissionDecision <<<"$out")" = deny ] || fail "$1: not denied: $out"
  jq -r .hookSpecificOutput.permissionDecisionReason <<<"$out" | grep -q 'docs/dev-env.md' || fail "$1: reason lacks docs/dev-env.md"
  ok "denies $1"
}
allow() {
  local out; out=$("$HOOK" <<<"$2") || fail "$1: nonzero exit"
  [ -z "$out" ] || fail "$1: expected no output, got: $out"
  ok "allows $1"
}

deny "cargo install" "$(bash_in 'cargo install --path .')"
deny "install.sh" "$(bash_in 'scripts/install.sh')"
deny "launchctl on com.naru.serve" "$(bash_in 'launchctl kickstart -k gui/501/com.naru.serve')"
deny "a Bash touch of the app" "$(bash_in 'cp naru /Applications/Naru.app/Contents/MacOS/naru')"
deny "a Write into the app" "$(file_in Write /Applications/Naru.app/x)"
deny "an Edit of the app" "$(file_in Edit /Applications/Naru.app/Contents/Info.plist)"
deny "an install from a subagent" "$(bash_in 'cargo install --path .' implementer)"

allow "dev-env.sh" "$(bash_in 'scripts/dev-env.sh')"
allow "self-deploy.sh" "$(bash_in 'scripts/self-deploy.sh')"
allow "cargo build" "$(bash_in 'cargo build --release')"
allow "launchctl on another label" "$(bash_in 'launchctl list com.apple.Finder')"
allow "a Write elsewhere" "$(file_in Write /tmp/x)"
allow "a similarly named path" "$(file_in Write /Applications/Naru.app.bak/x)"
allow "an Agent tool call" '{"tool_name":"Agent","tool_input":{"prompt":"cargo install"}}'
allow "the naru-live agent" "$(bash_in 'cargo install --path .' naru-live)"

# A live-agent subagent (agent_id present) is not exempt.
out=$("$HOOK" <<<"$(bash_in 'cargo install --path .' | jq -c '. + {agent_id:"a1"}')")
[ "$(jq -r .hookSpecificOutput.permissionDecision <<<"$out")" = deny ] || fail "naru-live subagent must not be exempt"
ok "denies a naru-live subagent (agent_id set)"

for junk in '' 'garbage' '{"tool_name":'; do
  out=$("$HOOK" <<<"$junk") || fail "junk stdin '$junk': nonzero exit"
  [ -z "$out" ] || fail "junk stdin '$junk': output $out"
done
ok "garbage and empty stdin exit 0 silently"

# no jq on PATH: fail open
mkdir "$TMP/nojq"; ln -s "$(command -v bash)" "$TMP/nojq/bash"
nojq_in=$(bash_in 'cargo install x')
out=$(PATH="$TMP/nojq" "$TMP/nojq/bash" "$HOOK" <<<"$nojq_in") || fail "no jq: nonzero exit"
[ -z "$out" ] || fail "no jq: output $out"
ok "no jq: exit 0, no output"

echo "dev-env-guard-check: all passed"
