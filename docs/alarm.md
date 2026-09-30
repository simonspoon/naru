# The handoff alarm (`naru alarm`)

Mesa task 1512. A supervisor that hands work to a subagent must not stop its
turn with nothing set, or a stalled agent goes unnoticed. The old ritual was a
hand-rolled `sleep 1200` killed by an awk PID-scrape when the agent reported —
two extra turns and an exit-143 notification. `naru alarm arm` replaces it
with an alarm that **disarms itself**.

## How it works

`naru alarm arm [LABEL] [--after 20m] [--session <id>]` blocks, polling a
marker file. A `SubagentStop` hook (the `alarm-disarm` library built-in) runs
`naru alarm disarm`, which writes the marker for the parent session
atomically (temp file, then rename). Its **mtime** is the signal: the arm
notes the marker's mtime (or its absence) when it begins and disarms once the
marker exists with a different mtime, so a marker already there does not
count, and neither the wall clock nor a coarse filesystem can hide a stop.
The timeout is measured on the wall clock, so it keeps running while the
machine sleeps.

`--after` is `<n>s`, `<n>m`, `<n>h` or bare seconds, 1s to 24h (else
`validation`). The session is `--session`, else `CLAUDE_CODE_SESSION_ID` (set
in every Bash tool call of a Claude Code session; equal to the `session_id` a
`SubagentStop` payload carries for the parent). Neither is `validation`
naming the flag. Exit 0 either way; stdout is JSON:

```
{"outcome":"disarmed","label":"…","session_id":"…","agent_id":"…"|null,"waited_secs":N}
{"outcome":"fired","label":"…","session_id":"…","after_secs":N,"message":"ALARM: <label> has not reported after <after>"}
```

`naru alarm disarm [--session <id>] [--agent-id <id>]` with no `--session`
reads the hook payload JSON from stdin (`session_id`, `agent_id`) and prints
`{"disarmed":true,"session_id":…}`. Neither command takes `--quiet` (exit 2).

## The hook

```
naru library hook enable alarm-disarm --event SubagentStop
```

The body (`core::alarm::ALARM_HOOK`) pipes stdin to `naru alarm disarm`,
discards the output and **always exits 0**; a missing `naru` is fine. It
needs `naru` on the hook's PATH; without it the alarm acts as a plain timer.
Agent-definition frontmatter `hooks:` do not fire for a main `--agent`
session, so this must be a settings.json registration. `SubagentStop` fires
for foreground and background subagents alike.

## Marker location

`<dot dir>/alarms/<session_id>/last-stop` under the home (`~/.naru`, or
`~/.mesa` on an install that still has only that). Content is the agent id or
empty. The session id is untrusted hook input and must be `[A-Za-z0-9_-]`,
1..=128 characters, or it is `validation` (the hook then exits 0 regardless).

## Limitations

- Session-scoped, not agent-scoped: any subagent of the session stopping
  disarms every alarm armed for it.
- A report delivered by `SendMessage` from a still-running agent does not
  stop a subagent, so the alarm is not disarmed and fires as a harmless
  stall-ladder check.
- Without the hook installed it is a plain timer.

Gate: `scripts/alarm-check.sh`.
