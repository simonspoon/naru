# Branching: branch vs switch vs decide

All three route by **edge label**: an edge leaving them must carry `--branch <label>`; the label picks which edges are active. Edges not taken leave their targets `skipped`, and a node runs iff at least one incoming exec edge is active. A skipped branch is not an error.

| Need | Node | Labels on its edges |
| --- | --- | --- |
| Yes/no test on the text | `branch` | `true`, `false` |
| Many-way split on exact/substring/regex text | `switch` | each case `label`, plus `default` |
| A judgement from the configured decide rules (is this urgent?) | `decide` | each option, plus optional `fallback` |
| A human says yes/no | `gate` | `approved`, `rejected` |
| Handle a node's failure | any node | `failure` (see errors-and-waits.md) |

## Choosing

- Prefer `branch`/`switch`: deterministic, instant, free. `branch` ops: `contains`, `regex` (`grep -E`), `equals`, `score_above`, `score_below` (numeric `value`).
- Use `decide` only when no text rule works. It judges in-process with the rules file of the `decide` config section (no model call): the choice must reach `threshold` (default 0.5), else the `fallback` edge runs. With no `fallback` edge, a low confidence skips everything downstream and the run still succeeds. A decide error takes `fallback` too, or fails the node when there is none.
- A `branch` passes its input through unchanged to the active side. `switch` and `decide` do **not**: `switch` outputs `{"value","matched","label"}` and `decide` outputs `{"choice","confidence","fallback",...}`. A node behind them that needs the original text takes it from a second edge off an earlier node.
- Wire every label you care about. An unwired label simply ends that path. An unwired `default` means "do nothing for other input".
- Joining branches again: a `join` needs every incoming edge active, so it is `skipped` after a branch. Do not re-join branch outcomes; end each path with its own action.
- To branch on a struct field, put a `break` upstream and leave from its field pin (see inputs-and-pins.md).

## Worked example

Numbers go to one log; other text is split into errors, warnings and the rest. Offline, no model.

```bash
node() { naru workflow node create "$@" | jq -r .id; }
naru workflow create triage >/dev/null
T=$(node triage trigger Start --config '{"mode":"manual"}')
B=$(node triage branch "Is a number" --config '{"op":"regex","value":"^[0-9]+$"}')
S=$(node triage switch "Which kind" --config '{"op":"contains","cases":[{"match":"error","label":"error"},{"match":"warn","label":"warning"}]}')
O1=$(node triage output "Log number" --config '{"target":"log","log":"triage"}')
O2=$(node triage output "Log error" --config '{"target":"log","log":"triage-errors"}')
O3=$(node triage output "Log warning" --config '{"target":"log","log":"triage-warnings"}')
O4=$(node triage output "Log other" --config '{"target":"log","log":"triage"}')
naru workflow edge create triage $T $B >/dev/null
naru workflow edge create triage $B $O1 --branch true >/dev/null
naru workflow edge create triage $B $S --branch false >/dev/null
naru workflow edge create triage $S $O2 --branch error >/dev/null
naru workflow edge create triage $S $O3 --branch warning >/dev/null
naru workflow edge create triage $S $O4 --branch default >/dev/null
naru workflow run triage --input "disk error on sda" | jq -r .status
```

`decide` depends on the configured rules backend. Its node looks like this: `naru workflow node create triage decide Urgent --config '{"question":"Is {input} urgent?","options":["yes","no"]}'`, with edges `--branch yes`, `--branch no`, `--branch fallback`.
