# `subworkflow`
Runs another workflow as a single step: the child starts as a manual run with this node's input as its run input, and the **last successful step's output** of the child comes out. A failed child fails this node (`subworkflow "<name>" failed: ...`). Use it to share a block or to keep a big graph readable.

## Config
- `workflow` (string or integer id, required): the child workflow's id or name. Resolved when saved and again when it runs.
Unknown keys are `validation`. A workflow that would call itself (directly or through a chain), or a chain deeper than 8 workflows, is `validation`/a node failure.

## Pins and output
Input pin `in`, output pin `out` (any): the child's last ok step's output text. The child's own trigger, and any `trigger` mode, does not matter; it is entered with the input. A child that ends in an `output` node outputs that node's receipt.

## Use when / not when
Use when two workflows need the same block (clean, summarise, notify) or a graph has grown past what fits on one canvas. Use `foreach` to run a body over a list, and `parallel` to fan out inside one graph. Do not use it just to run one `cli`; add that node directly. The child runs inside the parent's run: it blocks until done.

## Example
```bash
naru workflow node create my-flow subworkflow Child --config '{"workflow":"clean-input"}'
```
