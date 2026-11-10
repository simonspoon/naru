//! Agent routing (mesa task 1654, `docs/agent-route.md`): a Claude Code
//! `PreToolUse` hook that reroutes a misrouted general-purpose subagent spawn
//! to a specialist through `naru decide`. Ships as a library hook built-in the
//! user registers with `naru library hook enable`; the keyword table is the
//! decide rules file, not anything here. Since naru task 2684 the same hook
//! also sets the spawn's model through `naru model-router subagent`.

/// The library built-in holding [`AGENT_ROUTE_HOOK`] — the bare id.
pub const AGENT_ROUTE_HOOK_BUILTIN: &str = "agent-route";

/// The built-in's name — the filename it is seeded under in `.claude/hooks/`.
pub const AGENT_ROUTE_HOOK_NAME: &str = "agent-route.sh";

/// The hook script. It **always exits 0** and prints nothing unless it swaps
/// the spawn's `subagent_type` or sets its `model` (the model router's
/// subagent entry point, naru task 2684, in the same hook because Claude Code
/// keeps only one hook's `updatedInput`); the description and prompt reach
/// `naru` only as argv / stdin, never through `eval`. `scripts/agent-route-check.sh` is
/// its gate.
pub const AGENT_ROUTE_HOOK: &str = r##"#!/usr/bin/env bash
# agent-route.sh — a Claude Code PreToolUse hook (mesa task 1654, naru task 2684).
# Installed with:
#   naru library hook enable agent-route.sh --event PreToolUse --matcher 'Agent|Task'
#
# Two steps, one updatedInput (Claude Code keeps only one hook's updatedInput,
# so they cannot be two hooks):
#   1. Reroutes an untyped / general-purpose subagent spawn to a specialist
#      when `naru decide` (the description as question, the prompt as input)
#      is sure of one: confidence >= 0.8, every matching rule agreeing, and the
#      agent definition present.
#   2. Sets the spawn's model from `naru model-router subagent` (the model
#      router, docs/model-router.md), overriding the agent definition's
#      frontmatter model; a null model leaves it untouched.
# Everything else passes through untouched. It never fails a tool call: every
# miss prints nothing and exits 0.
command -v jq >/dev/null 2>&1 || exit 0
command -v naru >/dev/null 2>&1 || exit 0
input=$(cat 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

tool=$(printf '%s' "$input" | jq -r '.tool_name | strings' 2>/dev/null) || exit 0
case "$tool" in Agent|Task) ;; *) exit 0 ;; esac
changed=

# Step 1: the specialist swap. Updates `input` in place on a swap.
swap() {
  local from desc prompt question verdict to next dot session rule conf flat
  from=$(printf '%s' "$input" | jq -r '.tool_input.subagent_type | strings' 2>/dev/null) || return 0
  case "$from" in ""|general-purpose|claude) ;; *) return 0 ;; esac

  desc=$(printf '%s' "$input" | jq -r '.tool_input.description | strings' 2>/dev/null) || return 0
  prompt=$(printf '%s' "$input" | jq -r '.tool_input.prompt | strings | .[0:4000]' 2>/dev/null) || return 0
  question=$desc
  if [ -z "$question" ]; then
    question=$(printf '%s\n' "$prompt" | head -n 1)
  fi
  [ -n "$question" ] || return 0

  verdict=$(printf '%s' "$prompt" | naru decide --question "$question" \
    --option implementer --option swift-implementer --option diff-reviewer \
    --option ui-verifier --option general-purpose --input-file - 2>/dev/null) || return 0
  to=$(printf '%s' "$verdict" | jq -r '.choice | strings' 2>/dev/null) || return 0
  case "$to" in ""|general-purpose) return 0 ;; esac
  printf '%s' "$verdict" | jq -e '(.confidence >= 0.8) and (.agreement >= 1)' >/dev/null 2>&1 || return 0

  # Only a defined agent: a swap to an unknown type would fail the spawn.
  [ -f "${CLAUDE_PROJECT_DIR:-/nonexistent}/.claude/agents/$to.md" ] \
    || [ -f "${HOME:-/nonexistent}/.claude/agents/$to.md" ] || return 0

  next=$(printf '%s' "$input" | jq -c --arg to "$to" '.tool_input.subagent_type = $to' 2>/dev/null) || return 0
  [ -n "$next" ] || return 0
  input=$next
  changed=1

  # One line per swap, best-effort.
  dot="$HOME/.naru"
  { [ -d "$dot" ] || [ ! -d "$HOME/.mesa" ]; } || dot="$HOME/.mesa"
  {
    session=$(printf '%s' "$input" | jq -r '.session_id | strings' 2>/dev/null)
    rule=$(printf '%s' "$verdict" | jq -r '.rule | strings' 2>/dev/null)
    conf=$(printf '%s' "$verdict" | jq -r '.confidence' 2>/dev/null)
    flat=$(printf '%s' "$desc" | tr '\r\n\t' '   ')
    mkdir -p "$dot/logs" \
      && printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        "${session:--}" "${from:--}" "$to" "${rule:--}" "${conf:--}" "$flat" \
        >>"$dot/logs/agent-route.log"
  } 2>/dev/null || true
}
swap

# Step 2: the model, decided on the (possibly swapped) spawn. Any failure
# leaves the model alone.
model=$(printf '%s' "$input" | naru model-router subagent 2>/dev/null | jq -r '.model | strings' 2>/dev/null)
case "$model" in haiku|sonnet|opus|fable) changed=1 ;; *) model= ;; esac

[ -n "$changed" ] || exit 0
out=$(printf '%s' "$input" | jq -c --arg m "$model" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: (.tool_input | if $m == "" then . else .model = $m end)}}' \
  2>/dev/null) || exit 0
[ -n "$out" ] || exit 0
printf '%s\n' "$out"
exit 0
"##;
