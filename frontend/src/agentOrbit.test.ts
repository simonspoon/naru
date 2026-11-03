import { describe, expect, it } from 'vitest'
import {
  VIEW,
  clip,
  dotText,
  groupQueue,
  jobHref,
  layoutBoxes,
  layoutJobs,
  maxDots,
  overlaps,
  pct,
  queuedHref,
  sparkPoints,
  stageText,
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

describe('layoutJobs', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('paints nothing on top of anything else with %i jobs, every dot shown', (n) => {
    const layout = layoutJobs(Array.from({ length: n }, (_, i) => job(i)))
    const boxes = layoutBoxes(layout)
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i].box
      expect(b.x0).toBeGreaterThanOrEqual(0)
      expect(b.y0).toBeGreaterThanOrEqual(0)
      expect(b.x1).toBeLessThanOrEqual(VIEW)
      expect(b.y1).toBeLessThanOrEqual(VIEW)
      for (let j = i + 1; j < boxes.length; j++) {
        // A dot and its own label, or a node and its own title, sit apart by construction.
        const hit = overlaps(b, boxes[j].box)
        if (hit) throw new Error(`${n} jobs: ${boxes[i].owner}/${boxes[i].part} overlaps ${boxes[j].owner}/${boxes[j].part}`)
      }
    }
  })

  it('shows fewer dots as the ring fills, never none', () => {
    expect(maxDots(1)).toBe(6)
    expect(maxDots(5)).toBeGreaterThanOrEqual(3)
    expect(maxDots(8)).toBeGreaterThanOrEqual(1)
    expect(layoutJobs([job(1)])[0].dots).toHaveLength(6)
  })

  it('clips titles to the budget', () => {
    expect(layoutJobs([job(1)])[0].title).toBe('A fairly long t…')
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
    expect(voiceMotion({ active: false, state: 'off', sessionId: null, projectId: null })).toBe('off')
    expect(voiceMotion({ active: true, state: 'speaking', sessionId: 1, projectId: 2 })).toBe('speaking')
    expect(voiceMotion({ active: true, state: 'listening', sessionId: 1, projectId: 2 })).toBe('idle')
  })

  it('links tasks to their panel and workflows to their editor', () => {
    expect(jobHref(job(5))).toBe('#/projects/2/tasks/5')
    expect(jobHref(job(5, { kind: 'workflow', workflowId: 3, projectId: null }))).toBe('#/workflows/3')
    expect(queuedHref(queued(8, { kind: 'workflow' }))).toBe('#/projects/2/workflows/8')
    expect(jobHref(job(5, { kind: 'workflow', workflowId: null }))).toBe('#/projects/2/workflows')
  })
})
