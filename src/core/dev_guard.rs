//! Dev-sandbox guard (naru task 2094, `docs/dev-env.md`): a Claude Code
//! `PreToolUse` hook that denies a task-loop agent the commands that would
//! install to, restart or overwrite the person's real install. Ships as a
//! library hook built-in the person registers with `naru library hook enable`.

/// The library built-in holding [`DEV_GUARD_HOOK`] — the bare id.
pub const DEV_GUARD_HOOK_BUILTIN: &str = "dev-env-guard";

/// The built-in's name — the filename it is seeded under in `.claude/hooks/`.
pub const DEV_GUARD_HOOK_NAME: &str = "dev-env-guard.sh";

/// The hook script. It **exits 0 always** and prints a deny decision only for
/// the cases below; every miss (no `jq`, garbage or empty stdin) allows.
/// `scripts/dev-env-guard-check.sh` is its gate.
pub const DEV_GUARD_HOOK: &str = r##"#!/usr/bin/env bash
# dev-env-guard.sh — a Claude Code PreToolUse hook (naru task 2094).
# Installed with:
#   naru library hook enable dev-env-guard.sh --event PreToolUse --matcher 'Bash|Write|Edit'
#
# Denies, for task-loop agents: install.sh, cargo install, launchctl on a
# com.naru.* label, and any write to /Applications/Naru.app. The naru-live main
# agent and scripts/self-deploy.sh / scripts/dev-env.sh command lines pass.
# A guardrail, not a security boundary. Never fails a tool call otherwise.
command -v jq >/dev/null 2>&1 || exit 0
input=$(cat 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

# The live voice agent (main thread: agent_type naru-live, no agent_id) deploys.
live=$(printf '%s' "$input" | jq -r 'if (.agent_type == "naru-live") and (has("agent_id") | not) then "yes" else "no" end' 2>/dev/null) || exit 0
[ "$live" = yes ] && exit 0

tool=$(printf '%s' "$input" | jq -r '.tool_name | strings' 2>/dev/null) || exit 0
why=""
app="/Applications/Naru.app"
case "$tool" in
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command | strings' 2>/dev/null) || exit 0
    case "$cmd" in
      *self-deploy.sh*|*dev-env.sh*) exit 0 ;;
    esac
    case "$cmd" in
      *install.sh*) why="scripts/install.sh installs onto the real PATH" ;;
      *"cargo install"*) why="cargo install overwrites the real binary" ;;
      *launchctl*com.naru.*|*com.naru.*launchctl*) why="launchctl on a com.naru.* service restarts the real install" ;;
      *"$app"*) why="$app is the real app" ;;
    esac
    ;;
  Write|Edit)
    path=$(printf '%s' "$input" | jq -r '.tool_input.file_path | strings' 2>/dev/null) || exit 0
    case "$path" in
      "$app"|"$app"/*) why="$app is the real app" ;;
    esac
    ;;
esac
[ -n "$why" ] || exit 0

jq -nc --arg r "Dev sandbox: $why. Never install to, restart or overwrite the real install (~/.local/bin/naru, com.naru.serve :7777, com.naru.audio :7870, $app); use scripts/dev-env.sh (:7771). See docs/dev-env.md." \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}' 2>/dev/null
exit 0
"##;
