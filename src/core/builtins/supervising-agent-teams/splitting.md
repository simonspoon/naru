# Splitting big tasks

- **Size check first, before any planner call**, from the task text plus at
  most one quick recon. No planner for this. A task is **BIG** if ANY of:
  - (a) it changes more than 5 files, or files in more than 2 areas (an area =
    a crate, package, app target, or top-level source dir, e.g. a frontend vs.
    a backend);
  - (b) it has more than 4 acceptance points (distinct things the result must
    do or be checked for);
  - (c) it touches UI AND non-UI code (frontend + Rust backend, Swift + Rust);
  - (d) you expect one implementer to need more than ~60 tool calls.

  Otherwise **SMALL**: run exactly as today — one implementer brief, no planner
  call. In doubt between the two, small: a planner pass costs more than it
  saves on a small task.
- **Big: the planner splits.** Brief `planner` to split the task into Naru
  subtasks with `naru task create --parent <id> --project <project id>` (it
  runs `naru task create --help` first). Each subtask: one area where possible,
  SMALL by the thresholds above, its own acceptance check (a test, typecheck,
  or command with expected output), and an order (dependencies first). It
  returns the subtask ids + a one-line brief each.
- **Execute: one fresh implementer per subtask.** A new Agent call
  per subtask — never resume or `SendMessage` the previous implementer into
  the next subtask; the saving is fresh context. Serial is the default, one
  after another in the same tree, and is the only mode for subtasks whose files
  overlap. The brief is short: the subtask, its files,
  its acceptance check, and one line of what earlier subtasks already changed
  (commit sha / files), not their transcripts.
- **Parallel mode (optional).** The planner gives each subtask a
  `parallel-group` field and its file list; subtasks in the same group touch
  disjoint files (and no shared lockfile or generated file), and have no
  dependency on each other. Launch up to 3 of a group at once, each with Agent
  `isolation: "worktree"` (own branch), each briefed per
  [briefs.md](briefs.md) "Parallel implementer brief". Parallel implementers
  only write code and run unit/fast tests; shared resources are in
  [resources.md](resources.md). Then merge the pieces back one at a time
  (merge-to-main semantics, supervisor.md Wrapping up); review, verify and the
  full chain run once on the combined tree. Groups run one after another;
  anything without a group runs serially.
- **Verify per subtask, cheaply.** The subtask's own check (tests, typecheck);
  you check the claim per [verifying.md](verifying.md), commit the subtask, and
  set it done: `naru task update <sub> --status done --artifact <sha> --result ...`.
  One `ui-verifier` pass at the end over the whole task, not per slice — unless
  a slice is independently UI-testable AND big (>=1 minute of verification on
  its own). `diff-reviewer` may still review the full diff once at the end.
- **Guardrail and re-split.** An implementer that passes ~120 messages (~60
  tool calls) stops and reports done vs. left. Turn the "left" part into new
  subtask(s) (`naru task create --parent`) and brief a fresh implementer for
  each. Never resume the stopped one to "finish up".
- The parent task closes as normal (supervisor.md, Wrapping up) once every
  subtask is done and the final verification passes.

```
Task <id>: split into Naru subtasks. Run `naru task create --help` first, then `naru task create --parent <id> --project <project id>` per subtask.
Each subtask: one area where possible; small (<=5 files, <=4 acceptance points, <=~60 implementer tool calls, not UI+non-UI); its own acceptance check (test, typecheck, or command + expected output); ordered, dependencies first. Give each a file list and, where its files are disjoint from others' (and no shared lockfile/generated file, no dependency between them), a `parallel-group` label; leave it blank otherwise.
Return: subtask ids in execution order, one-line brief each. Do not edit code.
Reporting: end your turn with the report; never SendMessage it as well.
```

