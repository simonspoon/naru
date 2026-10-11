## Initialize
1. Claim the task with `naru task claim {id} --owner <your Claude Code session id>` to make the holder visible.

## Supervisor contract
You supervise task {id}; you do not do the work yourself. How a supervisor
behaves — the loop, waiting, the alarm on every handoff, the stall ladder,
verifying claims, briefing, resourcing, wrapping up — is defined once, in the
`supervisor` agent contract. Do not restate it here.

- **Running as the `supervisor` agent** (for example a session started
  with `--agent supervisor`): the contract is already loaded. Go straight to the
  task.
- **Running without that agent** (you typed `/execute-todo` in a plain session):
  load the `supervising-agent-teams` skill with the Skill tool, then read
  `~/.claude/agents/supervisor.md` and follow it as your contract, before
  doing anything else.

## Goal
- Task is accomplished and fully verified.

## Which agent for which job
| Agent | Use for |
| --- | --- |
| `Explore` | read-only recon / search |
| `implementer` | a code change in any non-Swift project |
| `swift-implementer` | an iOS/Swift change |
| `diff-reviewer` | reviewing an uncommitted diff or a branch |
| `ui-verifier` | live UI verification — design, calibrate and run the check (khora/qorvex/loki) |
| `general-purpose` | only what fits none of the above (e.g. non-UI probes, research) |
