# `join`
The gather for a fan-out. It waits for ALL of its incoming exec edges and emits one JSON array of their outputs.

## Config
- None: `{}` or omitted. Any other key is `validation`; `pins` is ignored.

## Pins and output
- In `in` (`any`), out `out` (`list<string>`).
- Runs only when every incoming exec edge is active. Output text: a JSON array of the incoming edges' texts in edge-id order (create edges in the order you want results).
- If any incoming branch was skipped (the other side of a `branch`, a skipped upstream), the join is `skipped` and the run still succeeds; a failed upstream node fails the run as usual. A `failure`-labelled edge into a join never satisfies it. Data edges do not count.
- "Waiting" is just graph order: the engine is sequential, so the join runs after every branch has run. No timeout, no config.
- No branch routing.

## Use when / not when
- Use after `parallel` (or any fan-out) to combine branch results into a list, then `mapfilter`, `prompt` (summarise the array) or `output`.
- Not to merge alternative paths (only one of which runs): a plain node with several incoming edges runs if ANY is active; a join would be skipped. Not to combine pin values into a struct: `make`.

## Example
```bash
naru workflow node create my-flow join "Gather"
naru workflow edge create my-flow <BRANCH_A_ID> <GATHER_ID>
naru workflow edge create my-flow <BRANCH_B_ID> <GATHER_ID>
```
