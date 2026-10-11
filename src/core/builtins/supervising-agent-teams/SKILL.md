---
name: supervising-agent-teams
description: How to run a team of subagents on one task without burning the budget or stalling — waiting correctly, verifying agents' claims instead of accepting them, briefing the verifier with a named acceptance metric and a wall-clock budget, assigning devices and scratch paths so agents don't collide, expiring stand-downs, and knowing when to stop. Use when supervising two or more agents on a single piece of work, when an agent has gone quiet and you are deciding what to do, or when a long agent-team session is running up a cost.
---

# Supervising agent teams

A supervisor decides; agents read, edit, build and measure. The contract is
the `supervisor` agent definition; this is the index. Read each file only at
its moment.

- **Never poll, and never end the turn while an agent runs; use one blocking
  wait.** Read [waiting.md](waiting.md) when you hand off, have nothing to do,
  an agent goes quiet, or a duplicate notification arrives.
- **An agent's "done" is a hypothesis; check it with grep, mtimes, numbers and
  sha.** Read [verifying.md](verifying.md) when a report arrives or a gate runs.
- **Every brief names its metric, budget, paths and gate tier.** Read
  [briefs.md](briefs.md) when you write an implementer, verifier or
  reproduction brief, or launch `ui-verifier`.
- **One agent per device, simulator, port and scratch dir; stand-downs expire.**
  Read [resources.md](resources.md) when two agents might share something, or
  before you touch a simulator or resume an agent.
- **You cannot edit: re-brief or replace.** Read [intervening.md](intervening.md)
  when an agent is wrong or blocked, or you find a defect outside the task's
  scope (inbox change request).
