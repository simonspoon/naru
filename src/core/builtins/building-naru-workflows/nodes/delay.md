# `delay`
Waits, then passes its input through unchanged. Use it to pace a run or hold until a time of day.

## Config
Exactly one of:
- `seconds` (int 0..=3600).
- `until` (string): `HH:MM` (UTC; the next such time of day, today if still ahead) or RFC3339 UTC like `2026-10-17T14:30:00Z` (must end in `Z`; no offsets).

Giving both, neither, or other keys is `validation` at create.

## Limits
- Every wait is at most 3600 s. An `until` more than 3600 s ahead passes create (format check only) but fails the node at run time. An instant already past waits 0.
- The run can't be stopped mid-wait: the engine has no cancel flag, so a delay holds its run until it finishes. Keep waits short.
- For anything longer than an hour, use a `schedule` or `trigger` of mode `time` and start a new run instead of a long delay.

## Pins and output
In `in: any`, out `out: any`. The output is the input, unchanged. No branch labels.

## Use when / not when
Use to rate-limit between calls, or to wait a few minutes for something to settle. Don't use it to wait for a person (use `gate`) or poll for a condition (use `retry` with backoff around a check).

## Example
```
naru workflow node create my-flow delay "Settle" --config '{"seconds":30}'
```
