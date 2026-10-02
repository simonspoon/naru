// A timer shell attributed to a subagent (mesa task 1596): a supervisor that
// spawns a subagent and arms `sleep 1200 & … wait` as a deadline for it would
// otherwise get a shell row beside the subagent's card. Here the shell is
// hidden and the subagent's card carries a countdown instead.
//
// Pure, like `agentChild.ts`: `now` is an argument.

import type { AgentChild } from './types/AgentChild'
import { parseTimestamp } from './time'

/** How long before a shell a subagent may have started and still be the one
 * the timer was armed for (the timing fallback of `attributeAlarms`). */
export const ATTRIBUTION_WINDOW_MS = 120 * 1000
/** `ps` etime and a transcript's first line are stamped a second apart at
 * worst; a subagent this far *after* the shell still counts as before it. */
const SKEW_MS = 5 * 1000
/** `naru alarm arm`'s own default for `--after` (cli.rs). */
const ALARM_DEFAULT_SECS = 20 * 60

const UNIT_SECS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

function secondsOf(n: string, unit: string | undefined): number | null {
  const v = Number(n) * UNIT_SECS[unit ?? 's']
  return Number.isFinite(v) && v > 0 ? v : null
}

/** The shell text to judge: the paired Bash call's command, else the body of
 * the `eval '…'` in the raw `zsh -c 'source … && eval …'` ps wrapper. */
function commandText(child: AgentChild): string {
  if (child.command) return child.command.trim()
  const m = /eval '([\s\S]*?)'(?: <|$)/.exec(child.name)
  return (m ? m[1] : child.name).trim()
}

/**
 * The seconds a timer command waits, or `null` when it is not one. Only a
 * command that *is* the timer counts: `sleep <n>[smhd]` alone, or backgrounded
 * (`sleep <n> & …`, the supervisor alarm idiom) with anything after it — a
 * foreground `sleep 5 && curl …` or `sleep 30; npm test` is a pause in some
 * other work, not an alarm — and `naru|mesa alarm arm … [--after <dur>]`
 * (default 20m).
 */
export function timerSeconds(cmd: string): number | null {
  const text = cmd.trim()
  const m = /^sleep\s+(\d+(?:\.\d+)?)([smhd])?\s*(?:$|&(?!&))/.exec(text)
  if (m) return secondsOf(m[1], m[2])
  if (/^(?:naru|mesa)\s+alarm\s+arm(?=\s|$)/.test(text)) {
    const a = /--after[=\s]+(\d+(?:\.\d+)?)([smhd])?(?=\s|$|[&;|])/.exec(text)
    return a ? secondsOf(a[1], a[2]) : ALARM_DEFAULT_SECS
  }
  return null
}

function startOf(child: AgentChild): number | null {
  if (child.startedAt === null) return null
  const t = parseTimestamp(child.startedAt).getTime()
  return Number.isFinite(t) ? t : null
}

function mentions(haystack: string, name: string): boolean {
  const n = name.trim().toLowerCase()
  if (n === '') return false
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w-])${esc}(?![\\w-])`).test(haystack)
}

export type Alarms = {
  /** Subagent -> the epoch ms its attributed timer ends. */
  endsAt: Map<AgentChild, number>
  /** Timer shells attributed to a subagent: not rendered as rows. */
  hidden: Set<AgentChild>
}

/**
 * Attribute each timer shell among one session's `children` to a subagent.
 * Candidates are all the subagents, running or finished (a timer must not
 * resurface as a row when its subagent ends). (1) Label: the shell's description or
 * command names a candidate (its agent type as a whole word, or its
 * description as text); several → the newest-started. (2) Timing: the newest
 * candidate that started at or before the shell, at most 120s earlier.
 * (3) Otherwise unattributed — the shell stays an ordinary row.
 *
 * A shell is hidden whatever its state once attributed (so it never dissolves
 * as a card on exit), and a subagent with several timers shows the latest
 * end. Whether the countdown is still worth drawing — the subagent still
 * running, time left — is the renderer's and `remainingMs`'s call.
 */
export function attributeAlarms(children: AgentChild[]): Alarms {
  const endsAt = new Map<AgentChild, number>()
  const hidden = new Set<AgentChild>()
  const subs = children.filter((c) => c.kind === 'subagent')
  const newestFirst = (a: AgentChild, b: AgentChild) => (startOf(b) ?? 0) - (startOf(a) ?? 0)
  for (const shell of children) {
    if (shell.kind !== 'shell') continue
    const secs = timerSeconds(commandText(shell))
    const started = startOf(shell)
    if (secs === null || started === null) continue
    const text = `${shell.description ?? ''}\n${commandText(shell)}`.toLowerCase()
    const byLabel = subs
      .filter(
        (s) =>
          mentions(text, s.name) ||
          (s.description
            ? text.includes(s.description.trim().toLowerCase()) && s.description.trim() !== ''
            : false),
      )
      .sort(newestFirst)[0]
    const target =
      byLabel ??
      subs
        .filter((s) => {
          const t = startOf(s)
          return t !== null && t <= started + SKEW_MS && started - t <= ATTRIBUTION_WINDOW_MS
        })
        .sort(newestFirst)[0]
    if (!target) continue
    hidden.add(shell)
    if (shell.state !== 'running') continue
    const end = started + secs * 1000
    endsAt.set(target, Math.max(endsAt.get(target) ?? 0, end))
  }
  return { endsAt, hidden }
}

/** Milliseconds left, or `null` once the timer has run out (no badge). */
export function remainingMs(endsAt: number, now: number): number | null {
  const left = endsAt - now
  return left > 0 ? left : null
}

/** `m:ss` under an hour, `h:mm:ss` from one up; rounds up so it never reads
 * `0:00` while time remains. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
