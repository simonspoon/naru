# Resources

Assign them so agents cannot collide.

- **One agent per device, per simulator, per port, per scratch directory.**
  Give each its own `$CLAUDE_JOB_DIR/tmp/<agent>/`; agents sharing a path
  diagnose each other's writes as tampering.
- **Parallel verifiers each get their own set, assigned in the brief by the
  supervisor:** a distinct khora session (own `khora launch`; it has no
  `--profile`/port flag, each launch gets its own temp profile dir and debug
  port, so never share a session id), a distinct leased simulator, a
  distinct scratch dir.
- **Parallel implementers (up to 3, each in its own worktree) use no shared
  resources.** They write code and run unit/fast tests only: no dev server, no
  Naru Beta app, no simulator, no UI check; those run once on the merged
  result, by review/verify. Each worktree builds cold, with its own build dir /
  `-derivedDataPath`; tell the brief so it batches edits. Lockfiles and
  generated files conflict on merge: keep their changes in one piece, or
  regenerate after the merge.
- **Every stand-down gets an expiry**: "until X reports, or 30 minutes,
  whichever comes first."
- **Ask for a shared resource; never take it.** Identify the holder from
  process start times, message that session, and confirm the release (port
  free, runner process gone) before using it.
- **Other sessions' simulators are not yours to shut down.** Boot your own by
  device id and pass that id to every `simctl` and `qorvex` call; never `booted`,
  `all`, or `killall Simulator`. A guard hook, where one is installed, may refuse
  `simctl shutdown|erase|delete|terminate` on devices this session did not
  boot, or that another session leased. Get your device with `qorvex lease
  --model <model> --owner "$CLAUDE_CODE_SESSION_ID"` and give it back with
  `qorvex release <device id>`, not raw `simctl shutdown|delete`. If a test suite insists on a single booted simulator, fix the suite,
  not the neighbour's device.
- **Other sessions' processes are not yours to kill.** Never select a kill
  target by command-line pattern alone — `pgrep -f "^sleep 1200" | head -1`
  once killed a peer supervisor's handoff alarm, because hundreds of sessions
  arm identically named ones. Kill only a pid this session recorded when it
  started the process, or a child of your own wrapper found with
  `pgrep -P <own wrapper pid>`. No `pkill -f`, no `killall`.
- **Never resume a worktree-isolated agent after it has ended its turn.** Its
  worktree may have been auto-removed as unchanged, and the resumed agent runs
  in the main checkout. Spawn a fresh isolated agent.
- **Clean up a worktree only after its work is merged.** First land it with
  `merge-to-main` run from the worktree (merge the base into the piece branch
  and retest first; for parallel pieces, one at a time), never raw `git merge`
  in the main checkout, and never push. The supervisor removes piece worktrees
  it spawned: `git worktree remove <path>` then `git branch -d <branch>`. It has
  `ExitWorktree` but not `EnterWorktree`, and a harness-created agent worktree
  is not its to `ExitWorktree`. If `git worktree remove <path>` then fails because
  the worktree is locked (`git worktree list --porcelain` shows `locked`,
  often with a claude agent as the reason), pick one of two paths:
  - **Let the harness clean it up** when the lock belongs to a live agent or
    session — an isolated agent still running, or this session's own
    worktree. Stop or wait for the agent; the harness removes an unchanged
    worktree itself, and `ExitWorktree` (remove) removes this session's own,
    only one this session entered with `EnterWorktree`; otherwise commit,
    merge it back and leave it.
    Never unlock a worktree a live agent is still using.
  - **`git worktree unlock <path>`, then `git worktree remove <path>`** when
    the agent that locked it has ended and the worktree persisted (it had
    changes, or the harness did not clean it up), and its branch is already
    merged. Only for a worktree this session created; another session's
    worktree is not yours to remove.
