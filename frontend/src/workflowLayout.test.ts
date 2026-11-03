import { describe, expect, it } from 'vitest'
import { PANEL_GAP, PANEL_H, PANEL_W, kindColorVar, placePanel } from './workflowLayout'

const vp = { width: 1200, height: 800 }

describe('placePanel', () => {
  it('opens on the right when that side has more room', () => {
    const p = placePanel({ left: 100, top: 300, width: 210, height: 80 }, vp)
    expect(p.side).toBe('right')
    expect(p.left).toBe(100 + 210 + PANEL_GAP)
  })

  it('flips to the left near the right edge', () => {
    const p = placePanel({ left: 950, top: 300, width: 210, height: 80 }, vp)
    expect(p.side).toBe('left')
    expect(p.left).toBe(950 - PANEL_GAP - PANEL_W)
  })

  it('stays inside the viewport', () => {
    const p = placePanel({ left: 5, top: 790, width: 210, height: 80 }, vp)
    expect(p.left).toBeGreaterThanOrEqual(0)
    expect(p.top + PANEL_H).toBeLessThanOrEqual(vp.height)
    expect(p.left + PANEL_W).toBeLessThanOrEqual(vp.width)
  })

  it('runs the wire from the near edge to the node', () => {
    const p = placePanel({ left: 100, top: 300, width: 210, height: 80 }, vp)
    expect(p.to).toEqual({ x: 310, y: 340 })
    expect(p.from.x).toBe(p.left)
  })
})

describe('kindColorVar', () => {
  it('maps kinds to header colours', () => {
    expect(kindColorVar('trigger')).toBe('--red')
    for (const k of ['schedule', 'webhook', 'task-event', 'file-watch'] as const) expect(kindColorVar(k)).toBe('--red')
    expect(kindColorVar('output')).toBe('--green')
    for (const k of ['file', 'memory', 'verify', 'board'] as const) expect(kindColorVar(k)).toBe('--green')
    expect(kindColorVar('decide')).toBe('--violet')
    expect(kindColorVar('script')).toBe('--cyan')
    for (const k of ['parse-json', 'variable', 'mapfilter', 'foreach', 'gate', 'subworkflow'] as const)
      expect(kindColorVar(k)).toBe('--amber')
    expect(kindColorVar('parallel')).toBe(kindColorVar('join'))
    expect(kindColorVar('comment')).toBe('--muted')
  })
})
