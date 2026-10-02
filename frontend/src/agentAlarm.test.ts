import { describe, expect, it } from 'vitest'
import { attributeAlarms, formatCountdown, remainingMs, timerSeconds } from './agentAlarm'
import type { AgentChild } from './types/AgentChild'

const mk = (o: Partial<AgentChild>): AgentChild => ({
  id: null,
  kind: 'shell',
  name: 'x',
  detail: null,
  startedAt: null,
  contextTokens: null,
  model: null,
  description: null,
  command: null,
  state: 'running',
  ...o,
})
const sub = (name: string, startedAt: string, o: Partial<AgentChild> = {}) =>
  mk({ kind: 'subagent', id: `agent-${name}`, name, startedAt, ...o })
const T0 = '2026-01-01 10:00:00'
const T0_MS = Date.parse('2026-01-01T10:00:00Z')

describe('timerSeconds', () => {
  it('reads a lone or backgrounded sleep, and alarm arm', () => {
    expect(timerSeconds('sleep 1200 & echo "alarm pid $!"; wait $!')).toBe(1200)
    expect(timerSeconds('sleep 2m')).toBe(120)
    expect(timerSeconds('naru alarm arm recon --after 20m')).toBe(1200)
    expect(timerSeconds('mesa alarm arm --after 90')).toBe(90)
    expect(timerSeconds('naru alarm arm reviewer')).toBe(1200)
    expect(timerSeconds('sleep 90')).toBe(90)
    expect(timerSeconds('sleep 1200 &')).toBe(1200)
  })
  it('rejects everything else', () => {
    expect(timerSeconds('npm test')).toBeNull()
    expect(timerSeconds('echo hi; sleep 5')).toBeNull()
    expect(timerSeconds('cat x | sleep 5')).toBeNull()
    expect(timerSeconds('sleep infinity')).toBeNull()
    expect(timerSeconds('timeout 30 npm test')).toBeNull()
    expect(timerSeconds('sleep 30; npm test')).toBeNull()
    expect(timerSeconds('sleep 5 && curl http://x')).toBeNull()
    expect(timerSeconds('sleep 5 | x')).toBeNull()
    expect(timerSeconds('naru task list')).toBeNull()
  })
})

describe('attributeAlarms', () => {
  const timer = (startedAt: string, o: Partial<AgentChild> = {}) =>
    mk({ startedAt, command: 'sleep 1200 & wait', ...o })

  it('attributes by label, newest of several', () => {
    const a = sub('Explore', '2026-01-01 09:59:00')
    const b = sub('Explore', '2026-01-01 09:59:30')
    const c = sub('Plan', '2026-01-01 09:59:50')
    const s = timer(T0, { description: 'Arm alarm for explore recon' })
    const r = attributeAlarms([a, b, c, s])
    expect([...r.endsAt.keys()]).toEqual([b])
    expect(r.endsAt.get(b)).toBe(T0_MS + 1200_000)
    expect(r.hidden.has(s)).toBe(true)
  })
  it('falls back to timing', () => {
    const a = sub('Explore', '2026-01-01 09:59:00')
    const b = sub('Plan', '2026-01-01 09:59:50')
    const r = attributeAlarms([a, b, timer(T0)])
    expect([...r.endsAt.keys()]).toEqual([b])
  })
  it('leaves an unattributable timer alone', () => {
    const old = sub('Explore', '2026-01-01 09:50:00')
    const later = sub('Plan', '2026-01-01 10:05:00')
    const s = timer(T0)
    const r = attributeAlarms([old, later, s])
    expect(r.hidden.size).toBe(0)
    expect(r.endsAt.size).toBe(0)
    expect(attributeAlarms([mk({ command: 'npm test', startedAt: T0 })]).hidden.size).toBe(0)
  })
  it('attributes to a finished subagent too, so the timer never resurfaces as a row', () => {
    const done = sub('Explore', '2026-01-01 09:59:50', { state: 'finished' })
    const t = timer(T0)
    const r = attributeAlarms([done, t])
    expect(r.hidden.has(t)).toBe(true)
    expect(r.endsAt.get(done)).toBe(T0_MS + 1200_000)
  })
  it('hides but does not badge a finished timer', () => {
    const live = sub('Explore', '2026-01-01 09:59:50')
    const r = attributeAlarms([live, timer(T0, { state: 'finished' })])
    expect(r.hidden.size).toBe(1)
    expect(r.endsAt.size).toBe(0)
  })
  it('reads the eval body from a raw ps name', () => {
    const live = sub('Explore', '2026-01-01 09:59:50')
    const s = mk({
      startedAt: T0,
      name: "/bin/zsh -c source /x/snap && eval 'sleep 600 & wait' < /dev/null && pwd",
    })
    expect(attributeAlarms([live, s]).endsAt.get(live)).toBe(T0_MS + 600_000)
  })
})

describe('countdown', () => {
  it('formats', () => {
    expect(formatCountdown(1182_000)).toBe('19:42')
    expect(formatCountdown(3725_000)).toBe('1:02:05')
    expect(formatCountdown(400)).toBe('0:01')
  })
  it('ends at zero', () => {
    expect(remainingMs(1000, 1000)).toBeNull()
    expect(remainingMs(2000, 1000)).toBe(1000)
  })
})
