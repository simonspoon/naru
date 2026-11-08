# `comment`
An editor-only group box: a titled, translucent, coloured rectangle drawn behind other nodes on the canvas to label a stage or group. It has **no runtime effect**: no pins, no edges (an edge to or from it is `validation`), and a run gives it no step. The title is the box heading.

## Config
- `text` (string, optional): shown under the title.
- `color` (optional): `accent` (default) | `accent2` | `good` | `warn` | `bad` | `muted`; anything else is `validation`.
Unknown keys are `validation`. **Never put `pins` in `--config`**: a comment has none and `pins` is `validation`.

## Pins and output
None. It never runs, outputs nothing and cannot be wired. Place it (`--x`, `--y`) behind the nodes it groups; the box is 320x200.

## Use when / not when
Use to document a graph for the next reader: label the intake, review and delivery stages of a long workflow, or flag a risky region with `warn`. Put intent there instead of in node titles. Not for passing data or notes to a run (use `memory` or `board`), and not as an on/off switch for nodes (it does not disable anything).

## Example
```bash
naru workflow node create my-flow comment "Intake" --config '{"text":"Collects and cleans the input","color":"accent2"}' --x 20 --y 20
```
