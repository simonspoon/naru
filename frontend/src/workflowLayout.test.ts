import { describe, expect, it } from 'vitest'
import { PANEL_GAP, PANEL_H, PANEL_W, kindColorVar, pinsFor, placePanel } from './workflowLayout'

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

describe('pinsFor / kindColorVar', () => {
  it('gives an agent an input pin and result and status pins', () => {
    const pins = pinsFor('agent')
    expect(pins.inputs.map((p) => p.label)).toEqual(['input'])
    expect(pins.outputs.map((p) => p.label)).toEqual(['result', 'status'])
  })

  it('gives a git node an input pin and result, ok and status pins', () => {
    const pins = pinsFor('git')
    expect(pins.inputs.map((p) => p.label)).toEqual(['input'])
    expect(pins.outputs.map((p) => `${p.label}:${p.type}`)).toEqual(['result:string', 'ok:bool', 'status:string'])
  })

  it('gives a file node an input pin and result and path pins', () => {
    const pins = pinsFor('file')
    expect(pins.inputs.map((p) => p.label)).toEqual(['input'])
    expect(pins.outputs.map((p) => `${p.label}:${p.type}`)).toEqual(['result:string', 'path:string'])
    expect(kindColorVar('file')).toBe('--green')
  })

  it('gives a memory node an input pin and result and id pins', () => {
    const pins = pinsFor('memory')
    expect(pins.inputs.map((p) => p.label)).toEqual(['input'])
    expect(pins.outputs.map((p) => `${p.label}:${p.type}`)).toEqual(['result:string', 'id:string'])
    expect(kindColorVar('memory')).toBe('--green')
  })

  it('gives a verify node pass, evidence and exit_code pins', () => {
    const pins = pinsFor('verify')
    expect(pins.inputs.map((p) => p.label)).toEqual(['input'])
    expect(pins.outputs.map((p) => `${p.label}:${p.type}`)).toEqual(['pass:bool', 'evidence:string', 'exit_code:number'])
    expect(kindColorVar('verify')).toBe('--green')
  })

  it('gives a board node an any pin each way in the action colour', () => {
    const pins = pinsFor('board')
    expect(pins.inputs.map((p) => `${p.label}:${p.type}`)).toEqual(['in:any'])
    expect(pins.outputs.map((p) => `${p.label}:${p.type}`)).toEqual(['out:any'])
    expect(kindColorVar('board')).toBe('--green')
  })

  it('gives a prompt a model pin in and a result pin out', () => {
    const pins = pinsFor('prompt')
    expect(pins.inputs.map((x) => x.type)).toEqual(['string', 'model'])
    expect(pins.outputs.map((x) => x.type)).toEqual(['result'])
  })

  it('gives a schedule the trigger shape: no inputs, one event pin, the trigger colour', () => {
    const pins = pinsFor('schedule')
    expect(pins.inputs).toEqual([])
    expect(pins.outputs.map((x) => x.label)).toEqual(['event'])
    expect(kindColorVar('schedule')).toBe('--red')
  })

  it('gives a webhook the trigger shape: no inputs, one body pin, the trigger colour', () => {
    const pins = pinsFor('webhook')
    expect(pins.inputs).toEqual([])
    expect(pins.outputs.map((x) => x.label)).toEqual(['body'])
    expect(kindColorVar('webhook')).toBe('--red')
  })

  it('gives a task-event the trigger shape: no inputs, one task pin, the trigger colour', () => {
    const pins = pinsFor('task-event')
    expect(pins.inputs).toEqual([])
    expect(pins.outputs.map((x) => x.label)).toEqual(['task'])
    expect(kindColorVar('task-event')).toBe('--red')
  })

  it('gives a file-watch the trigger shape: no inputs, one event pin, the trigger colour', () => {
    const pins = pinsFor('file-watch')
    expect(pins.inputs).toEqual([])
    expect(pins.outputs.map((x) => x.label)).toEqual(['event'])
    expect(kindColorVar('file-watch')).toBe('--red')
  })

  it('maps kinds to header colours', () => {
    expect(kindColorVar('trigger')).toBe('--red')
    expect(kindColorVar('output')).toBe('--green')
    expect(kindColorVar('decide')).toBe('--violet')
    expect(kindColorVar('script')).toBe('--cyan')
  })
})

describe('parse-json node (naru task 1985)', () => {
  it('takes a string, gives any, and is amber', () => {
    expect(pinsFor('parse-json').inputs.map((p) => [p.label, p.type])).toEqual([['text', 'string']])
    expect(pinsFor('parse-json').outputs.map((p) => p.type)).toEqual(['any'])
    expect(kindColorVar('parse-json')).toBe('--amber')
  })
})

describe('variable node (naru task 1986)', () => {
  it('has a value pin each side and is amber', () => {
    expect(pinsFor('variable').inputs.map((p) => p.label)).toEqual(['value'])
    expect(pinsFor('variable').outputs.map((p) => p.label)).toEqual(['value'])
    expect(kindColorVar('variable')).toBe('--amber')
  })
})

describe('mapfilter node (naru task 1987)', () => {
  it('has a list pin each side and is amber', () => {
    expect(pinsFor('mapfilter').inputs.map((p) => p.label)).toEqual(['list'])
    expect(pinsFor('mapfilter').outputs.map((p) => p.label)).toEqual(['list'])
    expect(kindColorVar('mapfilter')).toBe('--amber')
  })
})

describe('foreach node (naru task 1988)', () => {
  it('has list in, results out, amber', () => {
    expect(pinsFor('foreach').inputs.map((p) => p.label)).toEqual(['list'])
    expect(pinsFor('foreach').outputs.map((p) => p.label)).toEqual(['results'])
    expect(kindColorVar('foreach')).toBe('--amber')
  })
})

describe('parallel / join nodes (naru task 1989)', () => {
  it('have one flow pin each side, joined output a list', () => {
    expect(pinsFor('parallel').inputs).toHaveLength(1)
    expect(pinsFor('parallel').outputs).toHaveLength(1)
    expect(pinsFor('join').inputs).toHaveLength(1)
    expect(pinsFor('join').outputs[0].label).toBe('all')
    expect(kindColorVar('parallel')).toBe(kindColorVar('join'))
  })
})

describe('gate node (naru task 1993)', () => {
  it('has one in pin, flow-handle outputs, and the amber flow colour', () => {
    expect(pinsFor('gate').inputs.map((p) => [p.label, p.type])).toEqual([['in', 'any']])
    expect(pinsFor('gate').outputs).toEqual([])
    expect(kindColorVar('gate')).toBe('--amber')
  })
})

describe('subworkflow node (naru task 1994)', () => {
  it('has an in and an out pin and the amber flow colour', () => {
    expect(pinsFor('subworkflow').inputs.map((p) => [p.label, p.type])).toEqual([['in', 'any']])
    expect(pinsFor('subworkflow').outputs.map((p) => [p.label, p.type])).toEqual([['out', 'any']])
    expect(kindColorVar('subworkflow')).toBe('--amber')
  })
})

describe('comment node (naru task 2008)', () => {
  it('has no pins and the muted colour', () => {
    expect(pinsFor('comment')).toEqual({ inputs: [], outputs: [] })
    expect(kindColorVar('comment')).toBe('--muted')
  })
})
