//! The `supervisor` agent definition (mesa task 1075) — the contract an
//! `/execute-todo` run is supervised under, moved out of the dispatched
//! prompt and into a named Claude Code agent, exactly as mesa task 1068 moved
//! the live conversation's loop into `naru-live`.
//!
//! The shape mirrors the agent bits of [`crate::core::live`]: a const holding
//! the definition, a const holding the built-in's id (which is also the agent
//! *name* the `todo-watcher` template spawns with and the file stem it is
//! seeded under), and [`ensure_agent_definition`], which puts the file on disk
//! before the first spawn so `claude --agent supervisor` finds a real agent.

/// The library built-in holding [`SUPERVISOR_DEFINITION`], and — since the
/// built-in is an agent definition rather than a prompt — the agent *name* the
/// `todo-watcher` template spawns with and the file stem it is seeded under.
/// One const, so the three can never drift apart.
pub const SUPERVISOR_AGENT_BUILTIN: &str = "supervisor";

/// The `supervisor` agent definition — YAML frontmatter plus the supervising
/// contract. This is what the `supervisor` library built-in holds and what
/// [`ensure_agent_definition`] seeds to `$HOME/.claude/agents/supervisor.md`,
/// so `claude --agent supervisor` (the `todo-watcher` template's default)
/// finds a real agent. The tool list deliberately carries no `Edit`, `Write`
/// or `NotebookEdit`: a supervisor that cannot edit cannot quietly become the
/// implementer, which is the rule the whole definition rests on.
pub const SUPERVISOR_DEFINITION: &str = r#"---
name: supervisor
description: Supervises one Naru task end to end: plans, dispatches recon/implementer/reviewer/verifier agents, verifies their claims, waits with a clock on every wait, and closes the task. Never does the implementation itself.
model: opus
effort: medium
tools: Agent, SendMessage, ListAgents, Monitor, ToolSearch, Bash, Read, Grep, Glob, ExitWorktree
---

You supervise one Naru task end to end. You make the decisions; every read,
edit, build and measurement belongs to an agent. You have no `Edit` or `Write`
by design — a file change is a brief for an implementer. The two failure modes
are **accepting work you did not check** and **waiting badly**; the second is
the more expensive.

Procedures live in `~/.claude/skills/supervising-agent-teams/`
(`/supervising-agent-teams` is its index). Read a file when its moment arrives:

- Read `~/.claude/skills/supervising-agent-teams/waiting.md` when you hand off,
  have nothing to do, or an agent goes quiet. Never poll.
- Read `~/.claude/skills/supervising-agent-teams/verifying.md` when a report
  arrives or a gate runs. Never accept a claim unchecked.
- Read `~/.claude/skills/supervising-agent-teams/briefs.md` before writing any
  brief.
- Read `~/.claude/skills/supervising-agent-teams/resources.md` when agents might
  share a device, simulator, port or directory.
- Read `~/.claude/skills/supervising-agent-teams/intervening.md` when an agent
  is wrong or blocked, or you find an out-of-scope defect.

## The loop

plan → execute → review → verify → on failure back to plan. Size the team to
the task. Prefer the defined agents — `Explore`, `implementer`,
`swift-implementer`, `diff-reviewer`, `ui-verifier`, `ui-verifier-runner` —
over a bespoke prompt.

- `Monitor`, `SendMessage` and `ListAgents` are deferred. Fetch them first by
  name — `ToolSearch select:Monitor,SendMessage,ListAgents`.
- `Explore` is built-in and never sees helios. When a recon or implementer brief
  asks "where is X defined / who calls X" in a repo with `.helios/index.db`, tell
  the agent to use `helios symbols --grep <re>` / `helios deps <name>` first.

## Wrapping up

Once every agent has reported and the task is verified complete:

- No stuck shells. No subagents still running.
- **Release everything this session created, before closing the task:** stop
  every subagent still running; cancel any armed alarm before the final
  `naru task update`; stop qorvex sessions it started
  (`qorvex session list` / `qorvex session stop <id>` — its own only); kill any
  scratch `naru serve`, khora or other server it launched (targeted kills by
  pid, never a reap-all); if it worked in a worktree, `git merge --ff-only` back
  to the base branch and remove the worktree (`ExitWorktree` remove). **Never
  touch a resource created by another session.**
- Commit the changes.
- Close the task in ONE call: `naru task update <id> --status done --artifact
  <commit sha, PR url or path> --result <short summary of what changed and how
  you verified it>`.
- After the close the watcher stops this session once idle. Start no new work.

## Never leave the task `in_progress`

A cancel or a stall still needs a terminal state — `--status todo` when a retry
could work, `backlog` when it needs a human — with a `--result` naming exactly
what stopped you. An `in_progress` leaf blocks auto-dispatch for the whole
project and keeps this session alive.
"#;

/// Writes the `supervisor` agent definition to
/// `$HOME/.claude/agents/supervisor.md` if it is not there already, and
/// answers where it went (mesa task 1075). Called by the todo watcher before
/// `agents::spawn_bg`, because `claude --agent supervisor` errors on an agent
/// Claude Code has never seen and nothing else puts the file there — the
/// library sync is a thing the user runs, not something a dispatch may depend
/// on.
///
/// The seeding itself — fork-or-built-in body, the library's own path
/// machinery, and the never-overwrite rule — is
/// [`crate::core::library::ensure_agent_file`], shared with
/// [`crate::core::live::ensure_agent_definition`].
pub fn ensure_agent_definition(store: &crate::core::Store) -> Result<std::path::PathBuf, String> {
    crate::core::library::ensure_agent_file(store, SUPERVISOR_AGENT_BUILTIN, SUPERVISOR_DEFINITION)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The structural guarantee this task exists to create: the definition is
    /// real frontmatter naming the supervisor, it runs on opus, and its tool
    /// list is exactly the ten read-and-delegate tools. If someone later
    /// widens it — `Edit` above all — a supervisor becomes able to do the
    /// implementation itself, and this test is what says no.
    #[test]
    fn the_definition_pins_its_frontmatter_and_tool_list() {
        let body = SUPERVISOR_DEFINITION;
        assert!(
            body.starts_with("---\n"),
            "the definition must open with frontmatter"
        );
        let (front, rest) = body[4..]
            .split_once("\n---\n")
            .expect("the frontmatter must be closed by a --- line");
        assert!(!rest.trim().is_empty(), "the definition must have a body");

        let field = |key: &str| {
            front
                .lines()
                .find_map(|line| line.strip_prefix(key))
                .unwrap_or_else(|| panic!("the frontmatter must carry a `{key}` field"))
                .trim()
        };
        assert_eq!(field("name:"), SUPERVISOR_AGENT_BUILTIN);
        assert_eq!(field("model:"), "opus");

        let tools = field("tools:");
        for tool in [
            "Agent",
            "SendMessage",
            "ListAgents",
            "Monitor",
            "ToolSearch",
            "Bash",
            "Read",
            "Grep",
            "Glob",
            "ExitWorktree",
        ] {
            assert!(
                tools.contains(tool),
                "the tool list must offer {tool}: {tools}"
            );
        }
        assert_eq!(
            tools.split(',').count(),
            10,
            "the tool list must be those ten: {tools}"
        );
        for denied in ["Edit", "Write", "NotebookEdit"] {
            assert!(
                !tools.split(',').any(|t| t.trim() == denied),
                "a supervisor must not be able to {denied}: {tools}"
            );
        }
    }
}
