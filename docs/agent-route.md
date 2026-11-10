# Agent route

`agent-route` (mesa task 1654, body `core::agent_route::AGENT_ROUTE_HOOK`) is a
Claude Code **PreToolUse** hook, a library built-in, that reroutes a misrouted
general-purpose subagent spawn to a specialist through `naru decide`
(`docs/decide.md`).

## Why

The task 1654 audit counted 184 general-purpose spawns, about 43% of them
misrouted, mostly work that belonged to `ui-verifier`. Prose guidance in
the task prompt helps; a hook makes the routing hold.

## Contract

Install (user scope):

```
naru library hook enable agent-route.sh --event PreToolUse --matcher 'Agent|Task'
```

The payload's `tool_name` must be `Agent` (older: `Task`) and its
`tool_input.subagent_type` missing, empty, `general-purpose` or `claude`;
anything else (`fork`, `Explore`, any named type) is never swapped, though the
model step below still applies to it.
The hook then runs

```
naru decide --question <description> --input-file - \
  --option implementer --option swift-implementer --option diff-reviewer \
  --option ui-verifier --option general-purpose
```

with the first 4000 chars of the prompt on stdin (an empty description falls
back to the prompt's first line). Only full-toolset specialists are offered —
`Explore` is read-only, so it never is. It swaps **only** when the choice is
not null and not `general-purpose`, `confidence >= 0.8`, `agreement >= 1`, and
`<project>/.claude/agents/<choice>.md` or `~/.claude/agents/<choice>.md`
exists (a swap to an unknown type would fail the spawn). Either way the model
step below then runs.

A swap prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
"updatedInput":{…}}}` where `updatedInput` is the original `tool_input` with
only `subagent_type` (and, from the model step, `model`) changed (it replaces
the whole input). No
`permissionDecision` is set, so the normal permission flow applies. Every
other case prints nothing unless the model step sets a `model`; the hook always exits 0, never wedges, and treats
description and prompt strictly as data (argv / stdin, never `eval`). No `jq`
or `naru` on PATH is a pass-through.

## The model step (naru task 2684)

After the swap (or none), the hook pipes the payload, with the swapped
`subagent_type` if there was one, to `naru model-router subagent` and, when it
answers a `model`, sets `tool_input.model` in the same `updatedInput`. That
overrides the agent definition's frontmatter model. It runs for **every**
`Agent`/`Task` spawn, named types included; what is routed and how is
`docs/model-router.md` ("Subagent spawns"). A null model, a non-zero exit, or
a `naru` too old to have the subcommand leaves the model alone.

The two steps are one hook on purpose: with two PreToolUse hooks that both
return `updatedInput`, Claude Code keeps only one of them (measured on Claude
Code 2.1.322: a hook setting `model` and a second setting `subagent_type` ran
the second's type on the frontmatter model).

## Log

One tab-separated line per swap in `~/.naru/logs/agent-route.log`
(`~/.mesa/logs/` when only `~/.mesa` exists), best-effort: UTC timestamp,
session id, original type (`-` if none), new type, rule id, confidence,
description (newlines folded to spaces).

## Tuning

The keyword table is the decide rules file, not the hook: edit
`~/.naru/decide-rules.json` (or `decide.rules-file`; start from `naru decide
--print-default-rules`). Setting `decide.backend: off` disables routing.

## Caveat

`ui-verifier` designs and calibrates a harness, so a quick QA brief swapped to
it may come back shaped differently from what a general-purpose agent would
have returned. `scripts/agent-route-check.sh` is the gate.
