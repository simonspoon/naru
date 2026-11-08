# `file`
Reads or writes one file. A relative path resolves against the run's working folder; an absolute path is used as is.

## Config
- `op` (required): `read` or `write`.
- `path` (string, required, non-empty; `{input}` is NOT replaced here).
- `content` (string, `write` only): `{input}` replaced. Defaults to the node's input.
- `append` (bool, `write` only): append instead of truncating.

`content` or `append` with `read` is `validation`. `pins` can't be set: they are fixed.

## Pins and output
In `input: any`. Two out pins: `result` (string) and `path` (string, the resolved path). An edge leaves from the pin it names (`--from-pin`); with none it carries `result`.
- read: result = the file's text (capped; the cut is marked).
- write: result = the text written; parent folders are created.
A missing file or a write error fails the node.

## Use when / not when
Use to load a file into a flow or save a result, instead of `cli` with `cat`/`tee`. To record a run's result use `output`; for a file change to trigger a run use the `file-watch` trigger.

## Example
```
naru workflow node create my-flow file "Save report" --config '{"op":"write","path":"/tmp/report.md","content":"# Report\n\n{input}","append":false}'
```
