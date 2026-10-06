# Decide

`naru decide` (mesa task 1653) is a small, fast, local "pick one of these
options" call — a System One — that hooks and workflows shell out to. No
network, no API key, no model. CLI only: there is no API route and no
Settings UI.

```bash
naru decide "Which agent?" --option implementer --option diff-reviewer \
  --option general-purpose --input-file prompt.txt
naru decide --question "Ship it?" --option yes --option no --input "tests are green"
naru decide --print-default-rules > ~/.mesa/decide-rules.json
```

The question is positional or `--question` (exactly one). `--option` repeats:
at least two, distinct, non-empty — else `validation` (exit 1). The context
the rules may also read is `--input <text>` or `--input-file <path>` (`-` =
stdin); both absent means empty. It takes no `--quiet` (accepted and ignored,
like every non-record command).

## Output

One JSON object:

```json
{"choice": "implementer", "confidence": 0.8, "agreement": 1.0,
 "backend": "rules", "rule": "implementer-title-owns"}
```

- `choice` — one of the given options, or `null` for **no decision**
  (`confidence` 0, `agreement` 0, `rule` null, exit 0 — callers pass it
  through; it is not an error).
- `confidence` — the winning rule's confidence.
- `agreement` — matching rules choosing the winner / all matching rules whose
  choice was offered.
- `backend` — `rules` or `off`; `rule` — the winning rule's id.

`unavailable` is never used: nothing here depends on anything outside Naru.

## Config

A read-only `decide` section in `~/.mesa/config.json` (no route, no UI; every
saver preserves it):

```json
{ "decide": { "backend": "rules", "rules-file": "/path/to/rules.json" } }
```

- `backend` — `"rules"` (default when absent) or `"off"` (always no decision,
  `backend: "off"`). Anything else is `validation` naming the value.
- `rules-file` — default `decide-rules.json` beside `config.json`. A missing
  file means the built-in ruleset; a present file that does not parse, or
  holds a bad regex, is `validation` naming the file and the rule id.

The code keeps the backend behind `core::decide::DecideBackend`, so a local
model backend can be added later; none exists.

## Rules file

An ordered list; **first matching rule wins**:

```json
{"rules": [
  {"id": "diff-review", "choice": "diff-reviewer", "confidence": 0.8,
   "all":  [{"field": "input", "pattern": "\\breview the diff"}],
   "none": [{"field": "question", "pattern": "skip"}]},
  {"id": "fallback", "choice": "general-purpose", "confidence": 0.5, "all": []}
]}
```

- `confidence` is optional (default 0.8); `all` conditions must all match,
  `none` conditions must all not match; no conditions always matches.
- A condition is `field` (`question` or `input`), `pattern` (a Rust `regex`
  crate regex, searched not anchored — write `^` to anchor) and an optional
  `max_chars` (match only the first N characters of the normalised field).
- Both fields are normalised first: lowercase, whitespace collapsed to single
  spaces, ends trimmed.
- A rule whose `choice` is not among the offered options is skipped.

To edit: `naru decide --print-default-rules > <rules-file>`, change it, run
`scripts/decide-check.sh` or just call `naru decide`.

## Built-in rules and how far to trust them

The built-in set is a port of the agent-routing keyword rules from the
system-1 survey (`kwrules.py`): the question is the task's description, the
input its prompt. Each OR clause is its own rule; the fall-through is a final
`general-purpose` rule at confidence 0.5. Over the survey's 276 rows the port
agrees with the Python original on every row. Its accuracy on the survey's
test split was 33/43 with 2 false swaps — and that is **optimistic**, since the
rules were written after seeing the test set. Treat the answer as advice:
gate on `agreement`/`confidence`, and keep a fallback for a null choice.
