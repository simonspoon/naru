# Verifying claims

An agent reporting "done" is a hypothesis about the tree.

- `grep` the tree for each reported item before you believe it, and quote what
  you see back. Expect reported fixes to be missing.
- **Check mtimes on any tree you inherit.** Uncommented edits in a commented
  codebase are how test scaffolding ships (a seeded navigation path, a flipped
  default, an injected timer).
- Prefer the agent that measured over the agent that reasoned. Require numbers;
  "looks right" is not a result.
- Confirm the tree's sha at the moment of a claim; a finding from a stale copy
  is worse than none.
- **Never trust a piped gate's exit code** — a pipeline reports the last
  command's status. Pipe a gate only under `set -o pipefail`, or redirect it
  (`<gate script> full > gate.log 2>&1` then `tail -40 gate.log`). The
  verdict is the gate's own last line — `ok:` or `FAIL:` — and its own exit
  status.
- **Read the verifier's transcript for waiting defects.** An `until grep …
  sleep 30` loop over its own results, or `sleep 8`-style settles after a
  launch or tap, is a defect — send it back with the primitive to use
  (`qorvex wait-for`, `khora`/`loki` `wait-for`).
- **Check for a cold build.** A fresh worktree has no `target/` or derived
  data; confirm the brief said whether a shared cache exists.
- **Scale re-verification to the change.** Comment-only and doc-only edits need
  no gate. Frontend strings need the frontend tests only. A follow-up batch of
  nits does not re-earn the full chain.
