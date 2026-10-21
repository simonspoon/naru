# Waiting

**While any dispatched agent is running, do not end your turn.** The cost
guard once counted background implementers' cache reads against the
supervisor's session and stopped healthy supervisors, killing their implementers
with them; the spin rule now judges only the main thread, but a stopped session
still takes its background agents with it. Never end the turn on a promise to wait;
end it only once the task is closed (or set to queued (`todo`) or `backlog`).

Never poll for an agent — no `echo`, no repeated `log | tail`, no `ListAgents`
on a timer. Each filler turn re-reads and grows your whole context. A guard hook, where one is installed, may block bare no-ops and any command repeated 5 times in 3
minutes; if it refuses a command you were about to spin — never answer it with
a cleverer poll.

## What to do when you have nothing to do

| Situation | Move |
|---|---|
| An agent is running | **One blocking wait** (below), then act on its report. |
| External state the harness cannot see (a build, CI, a device) | The same kind of blocking until-loop on that state. Never wait on a process with `pgrep -f "<pattern>"` where the pattern also appears in your own wait command: it matches your own shell and never exits (session 218 hung 30 min this way). Wait on a pid you recorded (`kill -0 $PID`), on a file the job writes, or bracket the first character: `pgrep -f '[s]cripts/build.sh'`. |
| Independent work exists that does not depend on the answer | Do that first, then wait. |

## The blocking wait

One foreground `Bash` call that returns when the agent's transcript shows it
finished, or at the deadline. Set the Bash `timeout` above the deadline
(`1700000` ms for 1500 s). Repeat after each report; never more than one live.

```
F=~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl; D=$(( $(date +%s) + 1500 ))
until tail -n1 "$F" | jq -e '.message.stop_reason=="end_turn"' >/dev/null 2>&1; do
  [ "$(date +%s)" -ge "$D" ] && { echo "TIMEOUT: <agent> still running"; exit 1; }
  [ -n "$NARU_RUN_DIR" ] && [ -e "$NARU_RUN_DIR/message-pending" ] && { echo "MESSAGE: a person's message is waiting"; exit 0; }
  sleep 15
done; echo "DONE: <agent> finished"
```

Several agents (parallel verifiers): one call, every listed transcript, exit
when all have ended or at the deadline, printing which finished.

```
FS=(<f1>.jsonl <f2>.jsonl <f3>.jsonl); D=$(( $(date +%s) + 1500 ))
fin() { tail -n1 "$1" | jq -e '.message.stop_reason=="end_turn"' >/dev/null 2>&1; }
while :; do n=0; for f in "${FS[@]}"; do fin "$f" && n=$((n+1)); done
  [ "$n" -eq "${#FS[@]}" ] && { echo "DONE: all finished"; exit 0; }
  [ "$(date +%s)" -ge "$D" ] && { echo "TIMEOUT: $n/${#FS[@]} finished:"; for f in "${FS[@]}"; do fin "$f" && echo "  $f"; done; exit 1; }
  [ -n "$NARU_RUN_DIR" ] && [ -e "$NARU_RUN_DIR/message-pending" ] && { echo "MESSAGE: a person's message is waiting"; exit 0; }
  sleep 15; done
```

- **`MESSAGE`** means a person sent a message while you were waiting (the
  loop sees it only in a `naru run` session, via `NARU_RUN_DIR`). The agents
  are still running: answer the message, then resume the same wait.
- **Finished signal:** the transcript's last record is an assistant message with
  `stop_reason: "end_turn"`. A running agent's last record is `tool_use` (or a
  tool result).
- The `<id>` is the `agentId` the Agent tool returned; the file is
  `agent-<id>.jsonl` (named agents: `agent-<name>-<hash>.jsonl`, `ls` the dir).
- A foreground call keeps your turn open. `Monitor` returns at once and only
  streams notifications, so nothing holds the turn open. Do not wait with `Monitor`
  or a `run_in_background` sleep.
- `DONE` means read the report (it also arrives as a harness notification,
  possibly during the wait; you still see it afterward). Then verify.
- `TIMEOUT` is step one of the stall ladder. After acting, wait again.
- Only the agent's transcript is watched: check every other running agent's
  last tool-call time yourself.

## The stall ladder

- **Watch every running agent, not just the one you are waiting on.** Act on a
  *gap* in its last tool-call timestamp, not on silence: mid-build quiet is
  fine; a last tool call 25 minutes ago is not.
- **20 minutes silent** (the wait timed out) — `ListAgents`; read that agent's transcript at
  `~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl` (a long gap
  between its tool calls means stalled); then `SendMessage` once.
- **Background-job stall**: the agent's last tool call is a
  `run_in_background` job and its last message says it is waiting for a
  notification. It will never wake. **Check the job's output directory on disk
  first; the results are often already there.** Then take the results from disk
  (and brief a fresh agent with them) or re-brief/replace the agent — you
  cannot do the work yourself.
- **45 minutes silent** — **stop.** Return the task to queued (`--status todo`) with a result
  naming the stall, and report to the user.

## Duplicate notifications

Reports tend to arrive twice: the message, then an "idle" notification
restating it. When a notification restates a report you have already acted on,
**do not answer it in prose** — say nothing and resume the blocking wait (end the turn only if the task is
closed). **Ending the turn means replying without a tool call** — never a
placeholder like `true`, `:` or `echo`; the hook denies those, and the denial
costs you another turn. Only a notification
carrying something new (a different agent, a changed claim, a question) earns
a turn.
