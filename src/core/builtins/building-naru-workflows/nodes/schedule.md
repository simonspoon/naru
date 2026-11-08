# `schedule`
A trigger source that starts a run on a fixed interval or a cron expression. An entry node: one per workflow, nothing flows in, and a second entry node (`trigger`, `webhook`, ...) in the same workflow is refused. Fired by the time watcher (on by default in `serve`); a disabled workflow never fires by itself.

## Config
Exactly one of:
- `every_minutes` (int 1..=10080): run every N minutes.
- `cron` (string): 5 fields `minute hour day-of-month month day-of-week`, evaluated in **UTC**. Supports `*`, `n`, `a-b`, `*/s`, `a-b/s` and comma lists; day-of-week is 0-6 (7 also Sunday). Whitespace is normalised.
Giving both, or neither, is `validation`. Unknown keys are `validation`.

## Pins and output
No input pin. Output pin `event` carries the run input (text) to the next node. Wire the schedule straight into the first working node.

## Use when / not when
Use for "every morning at 9", "weekdays", "every 30 minutes". Prefer it over `trigger` with `mode: time` when you need a clock time or weekday (`trigger time` only has an interval). For a one-off run by hand use `trigger` `manual`. Do not build a `delay` loop or a `cli` that sleeps to imitate a schedule.

## Example
```bash
naru workflow node create my-flow schedule Weekdays --config '{"cron":"0 9 * * 1-5"}'
```
Or `--config '{"every_minutes":30}'`.
