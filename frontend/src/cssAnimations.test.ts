import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// naru task 2606: no looping CSS animation updates more than ~30 times a
// second. Each steps between eased keyframes (`@keyframes wf-step-pulse` in
// App.css explains the pattern), so its rate is steps × segments / duration.
const css = readFileSync('src/App.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Keyframe segments of `name`: its distinct stops, with 0% and 100% always counted. */
function segments(name: string): number {
  const at = css.indexOf(`@keyframes ${name} {`)
  expect(at, `@keyframes ${name}`).toBeGreaterThanOrEqual(0)
  let depth = 0
  let end = at
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  const stops = new Set([0, 100])
  // A stop list sits in a selector (`12.5%, 87.5% {`): strip the
  // declarations first, so a value's `%` (a `color-mix`) is never read.
  const selectors = css.slice(css.indexOf('{', at) + 1, end).replace(/\{[^{}]*\}/g, ';')
  for (const m of selectors.matchAll(/([\d.]+)%/g)) stops.add(Number(m[1]))
  for (const w of selectors.matchAll(/\b(from|to)\b/g)) stops.add(w[1] === 'from' ? 0 : 100)
  return stops.size - 1
}

const seconds = (s: string): number => (s.endsWith('ms') ? Number(s.slice(0, -2)) / 1000 : Number(s.slice(0, -1)))

/** Every `animation:` shorthand entry (rule bodies only, keyframes skipped). */
function loops(): { text: string; name: string; duration: number; steps: number | null }[] {
  const out = []
  for (const decl of css.matchAll(/(?:^|[;{\s])animation:\s*([^;}]+)/g)) {
    for (const entry of decl[1].split(/,(?![^(]*\))/)) {
      const text = entry.trim()
      if (!/\binfinite\b/.test(text)) continue
      const [name] = text.split(/\s+/)
      const dur = text.match(/(?:^|\s)([\d.]+m?s)\b/)
      const steps = text.match(/steps\((\d+)/)
      out.push({ text, name, duration: seconds(dur![1]), steps: steps ? Number(steps[1]) : null })
    }
  }
  return out
}

describe('looping CSS animations', () => {
  it('finds the loops and their stops (so the guard below is not vacuous)', () => {
    expect(loops().length).toBeGreaterThanOrEqual(8)
    for (const loop of loops()) expect(segments(loop.name), loop.name).toBe(8)
  })
  for (const loop of loops()) {
    it(`${loop.text} steps at most 30 times a second`, () => {
      expect(loop.steps, 'a looping animation must use steps(n)').not.toBeNull()
      expect((loop.steps! * segments(loop.name)) / loop.duration).toBeLessThanOrEqual(30)
    })
  }
  it('a shorter animation-duration override re-declares its steps', () => {
    for (const m of css.matchAll(/\{([^{}]*animation-duration:\s*([\d.]+m?s)[^{}]*)\}/g)) {
      const duration = seconds(m[2])
      if (duration >= 1) continue // slows a loop down: only fewer updates
      const steps = m[1].match(/animation-timing-function:\s*steps\((\d+)/)
      expect(steps, m[1]).not.toBeNull()
      // Every looping keyframe set here has 8 segments.
      expect((Number(steps![1]) * 8) / duration).toBeLessThanOrEqual(30)
    }
  })
})
