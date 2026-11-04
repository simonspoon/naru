import { beforeEach, describe, expect, it } from 'vitest'
import {
  AGE_FULL_S,
  RING,
  RING_MIN,
  VIEW,
  ageRadius,
  chatTurns,
  NARU_CLEAR,
  clip,
  discOverlaps,
  dotText,
  groupQueue,
  jobHref,
  layoutBoxes,
  layoutOrbit,
  loadCollapsed,
  panelKey,
  saveCollapsed,
  maxDots,
  overlaps,
  pct,
  placeHover,
  queuedHref,
  sparkPoints,
  stageText,
  subagentRef,
  visibleAgents,
  voiceMotion,
} from './agentOrbit'
import type { OrbitAgent } from './types/OrbitAgent'
import type { OrbitJob } from './types/OrbitJob'
import type { OrbitQueued } from './types/OrbitQueued'

function agent(role: string, state: string, at = 0): OrbitAgent {
  return { key: `${role}-${at}`, role, label: role, detail: null, state, startedAt: at, lastEventAt: at }
}

function job(id: number, over: Partial<OrbitJob> = {}): OrbitJob {
  return {
    kind: 'task',
    id,
    workflowId: null,
    title: 'A fairly long task title that will be clipped',
    projectId: 2,
    projectName: 'naru-audio',
    color: '#3fb950',
    stage: 'build',
    progress: 0.5,
    progressEstimated: true,
    state: 'working',
    sessionId: null,
    startedAt: null,
    agents: [agent('recon', 'done', 1), agent('build', 'done', 2), agent('review', 'done', 3), agent('test', 'working', 4), agent('check', 'waiting', 5), agent('build', 'done', 6)],
    ...over,
  }
}

function queued(id: number, over: Partial<OrbitQueued> = {}): OrbitQueued {
  return { kind: 'task', id, title: `T${id}`, projectId: 2, projectName: 'naru', color: '#3fb950', blocked: false, nextRunAt: null, ...over }
}

const NOW = 100_000
/** Every job the same age, alternating new and hours old, or spread over the scale. */
const AGES: Record<string, (i: number) => number> = {
  new: () => 0,
  old: () => AGE_FULL_S * 2,
  alternating: (i) => (i % 2 ? AGE_FULL_S : 5),
  spread: (i) => [10, 300, 1800, 3600, 7200, 20, 900, 14400][i % 8],
}
const naruAgents = [agent('agent', 'working', NOW - 30), agent('agent', 'done', NOW - 4000), agent('review', 'waiting', NOW - 600)]

describe('layoutOrbit', () => {
  const cases = Object.keys(AGES).flatMap((ages) =>
    [0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [true, false].map((naru) => [n, ages, naru] as const)),
  ).filter(([n, , naru]) => (n > 0 || naru) && n + (naru ? 1 : 0) <= 8)
  it.each(cases)('paints nothing on top of anything else with %i jobs aged %s, Naru agents %s', (n, ages, naru) => {
    const jobs = Array.from({ length: n }, (_, i) => job(i, { startedAt: NOW - AGES[ages](i) }))
    const layout = layoutOrbit(jobs, naru ? naruAgents : [], NOW)
    const boxes = layoutBoxes(layout)
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i].box
      expect(b.x0).toBeGreaterThanOrEqual(0)
      expect(b.y0).toBeGreaterThanOrEqual(0)
      expect(b.x1).toBeLessThanOrEqual(VIEW)
      expect(b.y1).toBeLessThanOrEqual(VIEW)
      for (let j = i + 1; j < boxes.length; j++) {
        // A dot and its own label, or a node and its own title, sit apart by construction.
        const naru = boxes[i].part === 'naru'
        const hit = naru ? discOverlaps({ x: VIEW / 2, y: VIEW / 2 }, NARU_CLEAR, boxes[j].box) : overlaps(b, boxes[j].box)
        if (hit) throw new Error(`${n} jobs: ${boxes[i].owner}/${boxes[i].part} overlaps ${boxes[j].owner}/${boxes[j].part}`)
      }
    }
  })

  it('shows fewer dots as the ring fills, never none', () => {
    expect(maxDots(1)).toBe(6)
    expect(maxDots(5)).toBeGreaterThanOrEqual(3)
    expect(maxDots(8)).toBeGreaterThanOrEqual(1)
    expect(layoutOrbit([job(1)]).jobs[0].dots).toHaveLength(6)
  })

  it('clips titles to the budget', () => {
    expect(layoutOrbit([job(1)]).jobs[0].title).toBe('A fairly long t…')
  })

  it('puts older jobs farther from Naru, and moves them out as they age', () => {
    const dist = (p: { x: number; y: number }) => Math.hypot(p.x - VIEW / 2, p.y - VIEW / 2)
    const l = layoutOrbit([job(1, { startedAt: NOW - 3600 }), job(2, { startedAt: NOW - 30 })], [], NOW)
    expect(dist(l.jobs[0].at)).toBeGreaterThan(dist(l.jobs[1].at) + 30)
    const later = layoutOrbit([job(2, { startedAt: NOW - 30 })], [], NOW + 600)
    expect(dist(later.jobs[0].at)).toBeGreaterThan(dist(layoutOrbit([job(2, { startedAt: NOW - 30 })], [], NOW).jobs[0].at))
  })

  it('keeps ages apart when two dots clash with each other (narrowing cannot move dots)', () => {
    const step = (k: string) => ({ ...agent('cli', 'done', 1), key: k, label: 'Summarise the inbox' })
    const flows = [180, 1500, 4500].map((age, i) =>
      job(i, { kind: 'workflow', startedAt: NOW - age, agents: [step(`a${i}`), step(`b${i}`), step(`c${i}`)] }),
    )
    const r = layoutOrbit(flows, [], NOW).jobs.map((l) => Math.hypot(l.at.x - VIEW / 2, l.at.y - VIEW / 2))
    expect(r[1]).toBeGreaterThan(r[0] + 15)
    expect(r[2]).toBeGreaterThan(r[1] + 10)
  })

  it("places Naru's own agents in a slot of their own, each by its age", () => {
    const l = layoutOrbit([job(1)], naruAgents, NOW)
    expect(l.naru.map((d) => d.text)).toEqual(['agent', 'agent ✓', 'review'])
    const r = l.naru.map((d) => Math.hypot(d.at.x - VIEW / 2, d.at.y - VIEW / 2))
    expect(r[1]).toBeGreaterThan(r[2])
    expect(r[2]).toBeGreaterThan(r[0])
    expect(layoutOrbit([job(1)], [], NOW).naru).toEqual([])
  })
})

describe('ageRadius', () => {
  it('runs from the inner edge to the outer one on a log scale, clamped', () => {
    expect(ageRadius(0)).toBe(RING_MIN)
    expect(ageRadius(null)).toBe(RING_MIN)
    expect(ageRadius(-50)).toBe(RING_MIN)
    expect(ageRadius(AGE_FULL_S)).toBeCloseTo(RING)
    expect(ageRadius(AGE_FULL_S * 10)).toBe(RING)
    // A minute and five minutes are told apart as clearly as one hour and four.
    expect(ageRadius(300) - ageRadius(60)).toBeGreaterThan(10)
    expect(ageRadius(4 * 3600) - ageRadius(3600)).toBeGreaterThan(10)
  })
})

describe('hover block', () => {
  it('keeps the newest prompts and replies, tool calls out, squashed', () => {
    const t = (kind: 'prompt' | 'response' | 'tool', text: string) => ({ id: text, kind, ts: null, model: null, name: null, text })
    const chat = { session_id: 's', truncated: false, pending_question: null, turns: [t('prompt', 'one'), t('response', 'two'), t('tool', 'ls'), t('response', '  '), t('prompt', 'three\n\n  four'), t('response', 'x'.repeat(400))] }
    const turns = chatTurns(chat, 3)
    expect(turns.map((x) => x.who)).toEqual(['agent', 'asked', 'agent'])
    expect(turns[1].text).toBe('three four')
    expect(turns[2].text.length).toBe(280)
    expect(turns[2].text.endsWith('…')).toBe(true)
  })

  it('splits a sub-agent key into its session and transcript id', () => {
    expect(subagentRef('abc-1/agent-9f')).toEqual({ sessionId: 'abc-1', agentId: 'agent-9f' })
    expect(subagentRef('run1/node2')).toEqual({ sessionId: 'run1', agentId: 'node2' })
    expect(subagentRef('nokey')).toBeNull()
    expect(subagentRef('/x')).toBeNull()
  })

  it('never leaves the window', () => {
    const a = { left: 100, top: 100, right: 140, bottom: 140 }
    expect(placeHover(a, 300, 200, 1000, 800)).toEqual({ left: 152, top: 100 })
    // No room on the right: to the left.
    expect(placeHover({ left: 800, top: 100, right: 840, bottom: 140 }, 300, 200, 1000, 800)).toEqual({ left: 488, top: 100 })
    // Near the bottom: pulled up.
    expect(placeHover({ left: 100, top: 750, right: 140, bottom: 790 }, 300, 200, 1000, 800).top).toBe(592)
    // Narrower than the block: pinned to the margin.
    expect(placeHover(a, 300, 200, 200, 150)).toEqual({ left: 8, top: 8 })
  })
})

describe('visibleAgents', () => {
  it('keeps unfinished agents first, then the newest done, in feed order', () => {
    const list = [agent('recon', 'done', 1), agent('build', 'done', 5), agent('test', 'working', 3), agent('review', 'done', 4)]
    expect(visibleAgents(list, 2).map((a) => a.role)).toEqual(['build', 'test'])
    expect(visibleAgents(list, 9)).toBe(list)
  })
})

describe('words', () => {
  it('names the stage, or the state when the job is not simply working', () => {
    expect(stageText(job(1))).toBe('building')
    expect(stageText(job(1, { stage: 'verify' }))).toBe('testing')
    expect(stageText(job(1, { state: 'waiting' }))).toBe('needs you')
    expect(stageText(job(1, { kind: 'workflow', stage: 'Send Brief' }))).toBe('send brief')
  })

  it('ticks a done dot, and uses the node title for a workflow step', () => {
    expect(dotText(job(1), agent('review', 'done'))).toBe('review ✓')
    expect(dotText(job(1), agent('test', 'waiting'))).toBe('test')
    expect(dotText(job(1, { kind: 'workflow' }), { ...agent('agent', 'working'), label: 'Summarise inbox' })).toBe('Summari…')
  })

  it('clips with an ellipsis only when needed', () => {
    expect(clip('short', 10)).toBe('short')
    expect(clip('exactly ten', 11)).toBe('exactly ten')
    expect(clip('much too long', 5)).toBe('much…')
  })
})

describe('groupQueue', () => {
  it('groups by project in project order, workflows last, empty groups dropped', () => {
    const projects = [
      { id: 7, name: 'uriel', color: '#d29922' },
      { id: 2, name: 'naru', color: '#3fb950' },
      { id: 9, name: 'empty', color: '#000000' },
    ]
    const q = [
      queued(1),
      queued(2, { projectId: 7, projectName: 'uriel', color: '#d29922' }),
      queued(3, { kind: 'workflow', projectId: 2, color: '#3fb950' }),
      queued(4),
    ]
    const g = groupQueue(q, projects)
    expect(g.map((x) => x.name)).toEqual(['uriel', 'naru', 'Workflows'])
    expect(g[1].items.map((x) => x.id)).toEqual([1, 4])
    expect(g[1].color).toBe('#3fb950')
    expect(g[2].workflow).toBe(true)
  })

  it('still lists a task whose project is not in the projects list', () => {
    const g = groupQueue([queued(1, { projectId: 40, projectName: 'loom', color: '#58a6ff' })], [])
    expect(g).toEqual([{ key: 'p40', name: 'loom', color: '#58a6ff', workflow: false, items: [g[0].items[0]] }])
  })
})

describe('sparkPoints / pct', () => {
  it('maps values onto the box, clamped, newest at the right', () => {
    expect(sparkPoints([0, 50, 100, 150], 30, 10)).toBe('0.0,10.0 10.0,5.0 20.0,0.0 30.0,0.0')
    expect(sparkPoints([40], 30, 10)).toBe('30.0,6.0')
    expect(sparkPoints([], 30, 10)).toBe('')
  })

  it('is null when a figure is missing', () => {
    expect(pct(1, 4)).toBe(25)
    expect(pct(null, 4)).toBeNull()
    expect(pct(1, 0)).toBeNull()
  })
})

describe('voiceMotion / hrefs', () => {
  it('moves the bars only while live', () => {
    expect(voiceMotion({ active: false, state: 'off', sessionId: null, projectId: null, agentSessionId: null, agents: [], recent: [] })).toBe('off')
    expect(voiceMotion({ active: true, state: 'speaking', sessionId: 1, projectId: 2, agentSessionId: null, agents: [], recent: [] })).toBe('speaking')
    expect(voiceMotion({ active: true, state: 'listening', sessionId: 1, projectId: 2, agentSessionId: null, agents: [], recent: [] })).toBe('idle')
  })

  it('links tasks to their panel and workflows to their editor', () => {
    expect(jobHref(job(5))).toBe('#/projects/2/tasks/5')
    expect(jobHref(job(5, { kind: 'workflow', workflowId: 3, projectId: null }))).toBe('#/workflows/3')
    expect(queuedHref(queued(8, { kind: 'workflow' }))).toBe('#/projects/2/workflows/8')
    expect(jobHref(job(5, { kind: 'workflow', workflowId: null }))).toBe('#/projects/2/workflows')
  })
})

describe('watcher panel collapse state', () => {
  beforeEach(() => localStorage.clear())

  it('defaults expanded and round-trips per panel', () => {
    expect(loadCollapsed('stats')).toBe(false)
    expect(loadCollapsed('queue')).toBe(false)
    saveCollapsed('stats', true)
    expect(loadCollapsed('stats')).toBe(true)
    expect(loadCollapsed('queue')).toBe(false)
    expect(localStorage.getItem(panelKey('stats'))).toBe('1')
    saveCollapsed('stats', false)
    expect(loadCollapsed('stats')).toBe(false)
    expect(localStorage.getItem(panelKey('stats'))).toBeNull()
  })
})
