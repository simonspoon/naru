# `foreach`
Runs one shell body once per list item, in order, and collects each run's stdout. The body is ONE inline step in the node's config, not a subgraph: the graph is a DAG with no back edges, so there is no loop-over-nodes. For a multi-node body per item, run a child workflow from the body (`naru workflow run <child> --input "$1"`); a `subworkflow` node runs once on the whole list, not per item.

## Config
- `body` (string, required): a `bash -c` script. The item arrives as `$1`, `$NARU_INPUT` (when under the env size cap) and on stdin. It is never spliced into the script text, so use the variables; `{input}` is not substituted. Runs in the run's working directory.
- `timeout_secs` (integer 1..=3600, optional; default the cli timeout): per item.
- `pins` ignored (fixed).

## Pins and output
- In pin: `list` (`any`). Out pin: `results` (`list<string>`).
- Input: a JSON array, or plain text split into non-empty lines. Any other JSON (object, number) fails with `foreach input must be a list`.
- Output text: JSON array of each item's trimmed stdout, in order. A nonzero exit or timeout on any item fails the node (`item 2 exited 1: ...`) and the remaining items do not run; add a `failure` edge or wrap handling downstream if that matters.
- No branch routing. Sequential, not concurrent.

## Use when / not when
- Use to apply one command per item (lint each file, `curl` each url) after a list-producing node, then `mapfilter`/`join`-style post-processing.
- Not to just reshape items: `mapfilter`. Not to branch per item: not expressible; filter the list first. Not for one command on the whole input: `cli`.

## Example
```bash
naru workflow node create my-flow foreach "Count chars" --config '{"body":"printf %s \"$1\" | wc -c","timeout_secs":30}'
```
