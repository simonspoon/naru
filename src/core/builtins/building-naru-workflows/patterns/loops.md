# Loops: foreach and mapfilter

A workflow is a DAG: **there are no cycles**, an edge that closes one is `cycle`. "Repeat until" does not exist. Loop over a **list** instead: `mapfilter` and `foreach` take a list and handle every item in one node.

A list is a JSON array, or plain text taken as its non-empty lines (so a `cli` printing one item per line feeds either node). Any other JSON fails the node with `... input must be a list`.

| Node | Does | Output |
| --- | --- | --- |
| `mapfilter` `mode: map` | renders `expr` per item, `{item}` replaced | JSON array of strings |
| `mapfilter` `mode: filter` | keeps items matching `expr` | JSON array of the kept items |
| `foreach` | runs the bash `body` once per item, in order | JSON array of each run's trimmed stdout |

- Filter predicates (`expr`): `contains:X`, `not-contains:X`, `eq:X`, `regex:RE` (Rust regex), `nonempty`. A bad predicate or regex is rejected at create time.
- `mapfilter` runs in-process: no shell, no model. Use it for reshaping and dropping; chain several.
- `foreach` is a shell loop, not a subgraph. The item arrives as `$1`, `$NARU_INPUT` and on stdin, never spliced into the script text, so a hostile item stays literal (`{input}` is not substituted in `body`). A nonzero exit on any item fails the node (`item <i> exited <code>`); `timeout_secs` (1..=3600) bounds each item.
- Per-item work that needs a node (a model call, a branch) cannot live inside `foreach`. Put it in a child workflow and call it from the body with `naru workflow run <child> --input "$1"`, or call the model directly from the body. That body is shell, so keep it to one short command.
- To combine the per-item results into one value, `foreach` already yields a list; pass it on, or reduce with `mapfilter`.
- No node lists tasks. To loop over a project's tasks, read them with a `cli` (`naru task list ... `) whose output is one item per line, then feed `foreach`.

## Worked example

Drop lines containing `skip`, prefix the rest, upper-case each one, log the result. Offline.

```bash
node() { naru workflow node create "$@" | jq -r .id; }
naru workflow create shout >/dev/null
T=$(node shout trigger Start --config '{"mode":"manual"}')
F=$(node shout mapfilter "Drop skipped" --config '{"mode":"filter","expr":"not-contains:skip"}')
M=$(node shout mapfilter "Label" --config '{"mode":"map","expr":"todo: {item}"}')
E=$(node shout foreach "Upper-case each" --config '{"body":"echo \"$1\" | tr a-z A-Z","timeout_secs":30}')
O=$(node shout output "Log results" --config '{"target":"log","log":"shout"}')
naru workflow edge create shout $T $F >/dev/null
naru workflow edge create shout $F $M >/dev/null
naru workflow edge create shout $M $E >/dev/null
naru workflow edge create shout $E $O >/dev/null
naru workflow run shout --input $'buy milk\nskip this\nwrite report' | jq -r .status
```

The log line is `["TODO: BUY MILK","TODO: WRITE REPORT"]`.
