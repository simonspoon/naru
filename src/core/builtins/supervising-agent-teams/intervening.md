# Intervening

You cannot edit, so intervening means **re-briefing or replacing an agent**
(`SendMessage` once, then stop and replace). When the whole team is blocked and
you have the intended values, brief an agent to apply them. After any
intervention, **broadcast the resulting state to every agent at once**: the
file list, the sha, the exact values. Otherwise the next report is about a
version that no longer exists.

- **A defect outside the task's scope is reported, not fixed** — an inbox item
  naming the file, the defect and the proposed fix; the person decides:
  `naru inbox add --task <task id> --kind change-request --author supervisor "<file>: <defect> — proposed fix: …"`,
  flags before the body (the body is a trailing var-arg); without
  `--kind change-request` it lands as an untriaged `task-summary`. The
  exception is a defect that blocks the task itself; then the closing report
  leads with it.
- **Your own experiments live in scratch and get swept.** Throwaway agents,
  probe scripts and servers go under `$CLAUDE_JOB_DIR/tmp/` with a greppable
  prefix (`probe-`, `trusttest-`), never the home folder. Close-out lists what
  was created and the one command that removed it.
