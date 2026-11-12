# Briefs

- **Name every file by a path the implementer can reach.** A file outside its
  repo goes in as an absolute path (`/abs/path/to/other-repo/src/File.tsx`) or
  with its relevant lines quoted. Recon reports that feed a brief carry
  absolute paths.
- **Every agent, including ad-hoc ones:** its final report is the message it
  ends its turn with, never also a `SendMessage`.
- **Every agent, including ad-hoc ones:** the shell tool is `Bash` with a capital B ('Bash'); lowercase 'bash' does not exist.
- **An isolated agent is told its worktree path in the brief.** Only the
  supervisor receives `worktreePath`/`worktreeBranch` (on the background-task
  notification); there is no `CLAUDE_WORKTREE*` variable and `$CLAUDE_JOB_DIR`
  is job scratch, not the checkout. The agent's only check is
  `git rev-parse --show-toplevel` against the path you named.
- In a worktree, Claude Code's guard refuses shell loops and commands with
  variable or computed operands ("too complex to verify that it stays inside
  the worktree"). Use `git -C <absolute-worktree-path> ...` with literal
  absolute paths, and send several simple commands as one parallel batch of
  Bash calls instead of a loop. On a refusal, retry once in that literal form.
- Edit files with Read/Edit, not sed. If sed is needed, macOS has BSD sed: use
  `sed -i '' ...` on a named file (never bare `-i`, never `-i` with stdin), or
  `perl -pi -e ...`.

## Verifier brief

- **Name the acceptance metric up front**, as a measurable quantity with a pass
  value. The verifier measures it first.
- **A rate series runs only when the baseline reproduces.** Three trials at
  HEAD; if none reproduces the failure, the verifier stops that line and
  reports. Zero versus zero is not evidence.
- **Give a wall-clock budget — 45 minutes by default.** Over budget, the
  verifier checks in (what it has, what remains, how long it needs) and waits
  for your decision.
- **Tell the verifier how to wait.** A trial series runs as one **foreground**
  Bash command with an explicit `timeout` it computes (trial count × per-trial
  budget, plus margin) and states in its report.
- **State the deadline as a clock time** (see `waiting.md`, "Deadlines"), and tell
  the agent to report partial results by it rather than overrun, listing what was
  and was not checked. Same line goes in every implementer brief.

```
Metric: <measurable quantity> = <pass value> (e.g. failing requests after a restart = 0). Measure this first.
Baseline rule: rate series only if HEAD reproduces within 3 trials; otherwise stop and report.
Budget: 45 minutes wall clock; over budget, check in with evidence so far instead of continuing.
Deadline: <HH:MM clock time>. Report partial results by then rather than overrun — list what was and was not checked.
Waiting: one foreground command per trial series, with a timeout you compute and state. Inside trials use wait-for, not sleep.
Handoff: <path to handoff.md or scripts/verify/>, or "none — design one".
Audio (when the check touches sound): input only from files or a virtual loopback device (e.g. BlackHole 2ch) by name; never `sox -d`, `rec` or any default-input capture — the real mic records the person's conversation.
Reporting: end your turn with the report; never SendMessage it as well — SendMessage is for mid-run questions only.
```

Check before sending: the brief shows a named metric, its pass value, and a
number of minutes.

### Launching ui-verifier

Launch `ui-verifier` (medium) with the metric brief. It designs, calibrates and
runs the whole check. If the repo has a checked-in harness
(`scripts/verify/` or equivalent) or a handoff file from an earlier run, pass
its path so it reuses it instead of redesigning.

## Implementer brief

- **Fast tier after each edit** — formatter, linter, and the test target the
  change touched (`cargo test <module>`, `xcodebuild test -only-testing:…`,
  `vitest <file>`).
- **Full chain once, run by the supervisor, on the committed tree** —
  the repo's full build script, its end-to-end check scripts, every test suite. Run it
  in the background after the commit; the notification wakes you. Never ask the
  implementer to run it; never run it twice on the same sha.
- If the repo has no shared build cache, say so, so the implementer batches
  edits before the first build.

```
Task: <scoped change>. Files: <absolute paths, or quoted lines for files outside your repo>.
Worktree: <absolute worktree path>; confirm with `git rev-parse --show-toplevel` before editing.
Gates: fast tier after each edit — <formatter>, <linter>, <the one test target touched>. Do not run the full chain; the supervisor runs it once on the committed tree.
Cold build: <shared cache available | none — batch your edits before the first build>.
Deadline: <HH:MM clock time>. Report partial results by then rather than overrun — list what was and was not done.
Reporting: end your turn with the report; never SendMessage it as well — SendMessage is for mid-run questions and interim results you asked for.
```

## Parallel implementer brief

For pieces of one `parallel-group` (up to 3 at once, see `splitting.md`), each
launched with Agent `isolation: "worktree"`. Name the worktree path from the
launch notification.

```
Task: <piece>. You are one of <n> parallel implementers; others edit other files at the same time.
Worktree: <absolute worktree path>; confirm with `git rev-parse --show-toplevel` before editing. Use `git -C <absolute path> ...`, one plain command per call.
Owned files: <absolute paths>. Touch these and nothing else; no lockfile or generated-file changes unless listed. Need another file? Stop and report.
Shared resources: none. No dev servers, Naru Beta, simulators or UI checks; write code and run unit/fast tests only.
Gates: fast tier only — <formatter>, <linter>, <the one test target touched>. Commit in the worktree. Do not merge; the supervisor merges pieces one at a time.
Cold build: <none — own build dir, batch your edits before the first build>.
Deadline: <HH:MM clock time>. Report partial results by then rather than overrun — list what was and was not done.
Reporting: end your turn with the report (branch, commit sha, files changed); never SendMessage it as well.
```

## Reproduce before you implement

When a task rests on a *reported* behaviour (a prompt that keeps appearing, a
crash "one time in six"), the reproduction or measurement agent reports
**before** the implementer is briefed.

- Reproduction first, implementation second, unless the mechanism is already
  proven with numbers in the task itself.
- Reproduction and verification agents get **their own detached worktree of
  the ref under test** (`git worktree add <scratch> <sha> --detach`), never the
  tree an implementer is editing. Provenance caveats in a report mean you
  shared a tree.
- A premise that fails to reproduce is a finding. Put it in the task result
  and, if the person reported it, in the inbox as a change request (form in
  `intervening.md`, with "did not reproduce: …" as the defect), and re-scope
  before spending an implementer on it.
