# The `naru workflow` CLI

Output is JSON only. `<wf>` is a workflow id or name everywhere. Errors are `{"error":{"code","message"}}` on stderr, exit 1 (usage errors exit 2).

## Rules (agents kept breaking these)

- Before using a subcommand, run `naru help workflow node` and `naru help workflow node <sub>`. The per-kind `--config` keys are listed there. That list misses `break`, `make`, `parse-json`, `variable` and `memory`: use `nodes/<kind>.md` for those.
- When a call fails, read `error.message`, fix the command, then retry. Never repeat a failed call unchanged.
- The only node subcommands are `create`, `update` and `delete`. There is no `node list` or `node show` (`usage` error); read nodes with `naru workflow show <wf>`.
- Create: `naru workflow node create <wf> <kind> "<title>" [--config '<json object>'] [--x N] [--y N]`. Use the positional or the `--workflow/--kind/--title` flag for an argument, not both. Omitted coordinates place nodes in a row.
- Update: `naru workflow node update <node id> [--title] [--config] [--x] [--y]`, at least one flag. `--config` **replaces** the whole config; the kind cannot change.
- Delete: `naru workflow node delete <node id>`. The id is numeric (a name or title is `usage`). It also deletes the node's edges, with no confirmation, and echoes `{node, edges}`.
- **Pins are fixed for `agent`, `verify`, `break`, `make`, `git`, `file`, `memory` and `comment` nodes**: never put `pins` in `--config` (`validation`).
- Quote `--config` with single quotes around the JSON. Config keys the kind does not accept are `validation`; only the shape is checked, so a script, binary or workflow named in a config may not exist yet.
- Node ids are global across workflows, not per workflow. Capture them: `ID=$(naru workflow node create ... | jq -r .id)`.

## Commands

| Command | Does |
| --- | --- |
| `workflow create <name> [--project P] [--description D]` | new empty workflow |
| `workflow list [PROJECT]` | array of rows (`trigger`, `trigger_phrase`, last run status) |
| `workflow show <wf>` | `{workflow, nodes, edges}`; nodes carry effective `pins` |
| `workflow update <wf> [--name] [--description] [--project]` | `""` clears a field |
| `workflow duplicate <wf> [--name NEW]` | a copy |
| `workflow delete <wf>` | echoes the destroyed `{workflow, nodes, edges}`, no confirmation |
| `workflow type add <wf> <Name> --field n:type ...` / `type remove <wf> <Name>` | struct types |
| `workflow node create\|update\|delete` | see rules above |
| `workflow edge create <wf> <FROM> <TO> [--branch L] [--from-pin P] [--to-pin Q] [--data]` | node ids, not titles |
| `workflow edge delete <edge id>` | |
| `workflow run <wf> [--input TEXT \| --input-file PATH\|-] [--trigger manual\|voice] [--detach]` | the finished run record |
| `workflow runs <wf>` | recent runs, newest first, without steps |
| `workflow run-show <run id>` | one run in full, with `steps` |
| `workflow watch <run id> [--follow]` | status snapshot: running step with elapsed seconds, steps done/total, last output tail |
| `workflow log [<log>] [--workflow <wf>] [--limit N]` | lines written by `output` `target: log` nodes |
| `workflow export <wf> [--out FILE]` / `workflow import FILE [--project P]` | portable file; imported workflows start disabled |
| `workflow gate list\|approve\|reject` | pending `gate` decisions |
| `workflow revisions <wf>` / `revision show\|diff\|restore <wf> <rev>` | history; every save is a revision |

## Edges

- `edge create` takes node **ids**: `naru workflow edge create <wf> <from id> <to id>`.
- `--branch` is required exactly when the source is `branch` (`true|false`), `decide` (an option or `fallback`), `switch` (a case label or `default`), `gate` (`approved|rejected`), `trycatch` (`ok|caught`). On any other source it is refused, except `--branch failure`, which any node accepts.
- `--from-pin`/`--to-pin` name pins; `--data` needs both and never takes `--branch`.
- A self-edge or cycle is `cycle`; an exact duplicate is `conflict`; an edge into the trigger is `validation`.

## Running and reading results

- `workflow run` prints the recorded run and **exits 0 even when the run failed**. Always read the result: `naru workflow run <wf> | jq '{status, error, failed: [.steps[] | select(.status=="failed") | {title, error}]}'`. Exit 1 means it could not run at all (unknown workflow, no or two entry nodes, input over 256 KiB).
- A step is `ok`, `skipped` or `failed`. `skipped` is normal after a branch.
- `--trigger time` is refused; `manual` is the default; `voice` records a voice run.
- `--detach` starts the run in a background job and prints `{"run_id","status":"running"}`; follow it with `workflow watch <run id> --follow`, then `workflow run-show <run id>`.
- `--quiet` (long form only) drops the free text from mutations and `show`: node `config`, run `steps` and `input`. Do not use it when you need to read the config back.

## Worked example

Build a two-node workflow, run it, read the log, export and re-import it as a copy.

```bash
node() { naru workflow node create "$@" | jq -r .id; }
naru workflow create hello-flow >/dev/null
T=$(node hello-flow trigger Start --config '{"mode":"manual"}')
O=$(node hello-flow output "Log greeting" --config '{"target":"log","log":"hello"}')
naru workflow edge create hello-flow $T $O >/dev/null
RUN=$(naru workflow run hello-flow --input "hi there" | jq -r .id)
naru workflow run-show $RUN | jq -r '.status, (.steps[] | "\(.title): \(.status)")'
naru workflow watch $RUN | jq -c '{status, steps_done, steps_total}'
naru workflow log hello --limit 1 | jq -r '.[0].text'
naru workflow export hello-flow --out /tmp/hello-flow.json | jq -c .
naru workflow import /tmp/hello-flow.json | jq -c '{renamed_from}'
```
