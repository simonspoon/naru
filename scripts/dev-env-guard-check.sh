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

# naru serve against the real data (naru task 2255). Synthetic payloads only:
# the hook only reads the command text, serve is never launched.
# the hook sees the environment: a bare serve is only denied when no db/home
# var is set, so drop the throwaway MESA_DB the gate exported above
unset MESA_DB MESA_CONFIG_FILE
REALDB="$HOME/Library/Application Support/naru/naru.db"
deny "serve with NARU_DB at the real db" "$(bash_in 'NARU_DB="$HOME/Library/Application Support/naru/naru.db" naru serve')"
deny "bare serve, no NARU_HOME/NARU_DB" "$(bash_in 'naru serve')"
(export NARU_DB="$REALDB"; deny "serve with env NARU_DB at the real db" "$(bash_in 'target/release/naru serve')")
allow "serve with temp NARU_HOME+NARU_DB" "$(bash_in 'NARU_HOME=/tmp/x NARU_DB=/tmp/x/naru.db naru serve --port 7799')"
deny "serve with an escaped-space real path" "$(bash_in 'NARU_HOME=$HOME/Library/Application\ Support/naru naru serve')"
allow "a commit message mentioning naru serve" "$(bash_in 'git commit -m "fix naru serve guard"')"
allow "a live say mentioning naru serve" "$(bash_in 'naru live say "restart naru serve"')"
allow "naru task list" "$(bash_in 'naru task list')"
allow "naru live status" "$(bash_in 'naru live status')"

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
