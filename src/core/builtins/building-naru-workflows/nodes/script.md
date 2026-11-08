# `script`
Runs a script already stored in Naru (`naru script`) by id or name, with arguments built from `values`. Use it **only for a stored script you already have**; prefer purpose-built nodes (`git`, `file`, `http`, `verify`, `task`, `notify`, ...) and do not create a script just to wrap a shell line (that is what `cli` is for, and even then prefer a dedicated node).

## Config
- `script` (string or positive integer, required): the script's id or name. Whether it exists is checked when the node runs, not when you save.
- `values` (object of **string** values, optional): the script's declared args by name. Any value may contain the literal `{input}`, replaced by the node's input. The substituted text reaches the script as one argument (`$1`..., `NARU_ARG_<NAME>`), never as shell syntax, so quotes and `$()` stay literal. Validated against the script's declared args at run time; the total is capped (shorten the input upstream).
- `timeout_secs` (int 1..=86400, default 600).
Unknown keys, or a non-string value, are `validation`. A nonzero exit fails the node.

## Pins and output
Input pin `stdin`. Output pins `stdout`, `stderr` and `exit_code` like `cli`; the exec-edge text is stdout. The script runs in its own project's `local_path` (which must exist), else `~/.naru/workspace`.

## Use when / not when
Use when a parameterised script already exists and is shared (a deploy, a backup). Not for new logic: use `git`, `file`, `http`, `verify`, `task` or `notify`. Not for ad-hoc commands: `cli`.

## Example
```bash
naru workflow node create my-flow script Stored --config '{"script":"deploy","values":{"target":"{input}"},"timeout_secs":300}'
```
