# Inputs and pins

## The run input

- The trigger's output **is** the run input: `naru workflow run <wf> --input TEXT` (or `--input-file PATH`, `-` = stdin). Default empty; over 256 KiB is an error. A `schedule`/`task-event`/`file-watch`/`webhook` trigger supplies its own (see triggers.md).
- Every other node's input is the outputs of its **active** upstream exec edges joined by `\n`, in edge-id order.
- Text reaches a node three ways, depending on its kind:
  - `{input}` replaced inside config text: `agent` `prompt` (else the input follows after a blank line), `decide` `question`, `task`, `http` (url, headers, body), `board`, `notify`, `memory`, `output` `reply` `message`, `verify` `url`. A `prompt` node does not substitute: its text, a blank line, then the input go in as one message.
  - stdin and `NARU_INPUT` for `cli`, `verify`; for `foreach` the item is `$1`/`$NARU_INPUT`/stdin. `{input}` is **not** substituted in shell commands. Read the env var or stdin.
  - Plain pass-through for `output`, `board`, `notify`, `delay`, `gate` (they act on or forward the input).

## Typed pins

A node has input pins and output pins. A pin type is `string`, `number`, `bool`, `any`, `list<T>`, or the name of a struct defined on the workflow. Nodes without `config.pins` are `any`. Each kind has default pins (the first input feeds `{input}`): `prompt` in `input`, `model`, out `result`; `cli` in `stdin`, out `stdout`, `stderr`, `exit_code`; `task`/`http`/`notify`/`delay` in `in`, out `out`; `git` out `result`, `ok`, `status`; `verify` out `pass`, `evidence`, `exit_code`; `file` out `result`, `path`. `naru workflow show <wf>` prints each node's effective `pins`.

Wires name pins: `--from-pin P --to-pin Q` on `edge create` (default: the first pin of that side, else `any`). A wire between two different types is `validation` ("can't connect number to Review"); `any` matches everything.

Never put `pins` in the config of `agent`, `verify`, `break`, `make`, `git`, `file`, `memory`, `comment` (their pins are fixed; `validation`). Other kinds may declare `"pins":{"in":[{"name":"x","ty":"number"}],"out":[...]}`.

## Exec vs data edges

- An **exec** edge (default) is run order and carries the source's text output. Naming a pin makes it carry that pin.
- A **data** edge (`--data`, needs both `--from-pin` and `--to-pin`, never a `--branch`) carries one value into one input pin and **never makes the target run**. The target still needs an exec edge. A data edge into a node's input pin replaces `{input}` for that node; into a `prompt`'s `model` pin it overrides the configured model.
- If a data edge's source was skipped or failed, the reading node is `skipped`.
- A data edge still orders execution (the source runs first) and counts for cycle checks.
- Use data edges to feed a value other than the main text: a `cli`'s `stderr`, a `parse-json` field, a model name.

## Structs: parse-json, break, make, variable

- `naru workflow type add <wf> <Name> --field score:number --field note:string` defines a struct (replaces a same-named one); `type remove <wf> <Name>`. Names are unique case-insensitively, not `string/number/bool/any/list`.
- `parse-json` `{"type":"Review"}` turns text into a typed value (fails the node when the text does not fit). `type` defaults to `any`. In `text`, out `value`.
- `break` `{"struct":"Review"}`: one input pin `value`, one output pin per field. An edge leaving a field pin carries that field (a string raw, anything else compact JSON).
- `make` `{"struct":"Review"}`: the reverse, one input pin per field, builds the object. Data edges into its field pins set the fields.
- `variable` `{"op":"set"|"get","name":"x","type":"..."}` stores a value for the rest of the run (`set`: pass-through, typed; `get`: needs an upstream exec edge to run and fails if never set). Use it to carry a value across a branch that a plain edge cannot reach.
- Removing a type still used by a pin, node or wire is `conflict`.

## Worked example

A review arrives as JSON; it is typed, split, and routed by its `score` field; the `note` goes to its own log. Offline.

```bash
node() { naru workflow node create "$@" | jq -r .id; }
naru workflow create review-gate >/dev/null
naru workflow type add review-gate Review --field score:number --field note:string >/dev/null
T=$(node review-gate trigger Start --config '{"mode":"manual"}')
P=$(node review-gate parse-json "Parse review" --config '{"type":"Review"}')
K=$(node review-gate break "Split review" --config '{"struct":"Review"}')
B=$(node review-gate branch "Score above 7" --config '{"op":"score_above","value":"7"}')
H=$(node review-gate output "Log high" --config '{"target":"log","log":"reviews-high"}')
L=$(node review-gate output "Log low" --config '{"target":"log","log":"reviews-low"}')
N=$(node review-gate output "Log note" --config '{"target":"log","log":"review-notes"}')
naru workflow edge create review-gate $T $P >/dev/null
naru workflow edge create review-gate $P $K >/dev/null
naru workflow edge create review-gate $K $B --from-pin score >/dev/null
naru workflow edge create review-gate $B $H --branch true >/dev/null
naru workflow edge create review-gate $B $L --branch false >/dev/null
naru workflow edge create review-gate $K $N --from-pin note >/dev/null
naru workflow run review-gate --input '{"score":9,"note":"solid"}' | jq -r .status
```
