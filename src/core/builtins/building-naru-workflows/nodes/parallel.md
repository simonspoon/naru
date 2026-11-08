# `parallel`
A fan-out marker. It passes its input through unchanged; draw an exec edge from it to each branch you want run on the same input. Pair with `join` to gather.

## Config
- None: `{}` or omitted. Any other key is `validation`; `pins` is ignored.

## Pins and output
- In `in` (`any`), out `out` (`any`). Output text = input, unchanged.
- Every outgoing exec edge is active, so all branch targets run. Note the engine is sequential (topological order, ties by node id): `parallel` is structure and documentation, not concurrency; do not rely on speed-up or interleaving.
- A node reachable from several branches receives their outputs joined by newline in edge-id order, which is rarely what you want: end the branches in a `join` instead.

## Use when / not when
- Use to make explicit that several independent steps start from the same input (for example a `prompt` summary plus a `cli` check), ending in a `join`.
- Not needed to give a node two outgoing edges (any node already fans out to all its edges); not for choosing among branches (`branch`/`switch`/`decide`); not for a per-item list (`foreach`).

## Example
```bash
naru workflow node create my-flow parallel "Fan out"
```
