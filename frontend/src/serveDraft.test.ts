import { describe, expect, it } from 'vitest'
import {
  changedServe,
  draftFrom,
  flagName,
  hostsError,
  isDirty,
  isSavable,
  parseHosts,
  portError,
} from './serveDraft'
import type { ConfigServe } from './types/ConfigServe'

const b = (value: boolean | null, flag: boolean | null = null) => ({
  value,
  default: false,
  effective: flag ?? value ?? false,
  flag,
})

function serve(over: Partial<ConfigServe> = {}): ConfigServe {
  return {
    port: { value: null, default: 7770, effective: 7770, flag: null },
    lan: b(null),
    allow_host: { value: null, default: [], effective: [], flag: null },
    watch_todo: b(null),
    watch_inbox: b(null),
    watch_cost: b(null),
    watch_retro: b(null),
    watch_workflows: b(null),
    restart_required: false,
    ...over,
  }
}

describe('draftFrom', () => {
  it('shows unset as blank / default and set as text', () => {
    expect(draftFrom(serve())).toMatchObject({
      port: '',
      allow_host: '',
      lan: false,
      watch_todo: false,
    })
    const set = serve({
      port: { value: 8000, default: 7770, effective: 7770, flag: null },
      allow_host: {
        value: ['a.local', 'b.local'],
        default: [],
        effective: [],
        flag: null,
      },
      watch_todo: b(true),
    })
    expect(draftFrom(set)).toMatchObject({
      port: '8000',
      allow_host: 'a.local\nb.local',
      watch_todo: true,
    })
  })

  it('is pristine when freshly loaded', () => {
    const s = serve({ watch_cost: b(true) })
    expect(isDirty(s, draftFrom(s))).toBe(false)
    expect(changedServe(s, draftFrom(s))).toEqual({})
  })
})

describe('validation', () => {
  it('accepts a blank port and a port in range', () => {
    expect(portError('')).toBeNull()
    expect(portError(' 7770 ')).toBeNull()
    expect(portError('65535')).toBeNull()
  })
  it('names a bad port', () => {
    expect(portError('0')).toMatch(/between/)
    expect(portError('65536')).toMatch(/between/)
    expect(portError('80.5')).toMatch(/whole/)
    expect(portError('http')).toMatch(/whole/)
  })
  it('parses hosts by line, comma or space, lowercased', () => {
    expect(parseHosts('Naru.Local, b.local\n c.local ')).toEqual([
      'naru.local',
      'b.local',
      'c.local',
    ])
    expect(parseHosts('')).toEqual([])
  })
  it('rejects a scheme, path or port in a host', () => {
    expect(hostsError('naru.local')).toBeNull()
    expect(hostsError('http://x')).not.toBeNull()
    expect(hostsError('x:80')).not.toBeNull()
  })
})

describe('changedServe', () => {
  it('sends only the changed keys', () => {
    const s = serve()
    const d = { ...draftFrom(s), port: '9000', watch_todo: true }
    expect(changedServe(s, d)).toEqual({ port: 9000, watch_todo: true })
  })
  it('sends null for a cleared port and an emptied host list', () => {
    const s = serve({
      port: { value: 9000, default: 7770, effective: 7770, flag: null },
      allow_host: {
        value: ['a.local'],
        default: [],
        effective: [],
        flag: null,
      },
    })
    const d = { ...draftFrom(s), port: '', allow_host: '' }
    expect(changedServe(s, d)).toEqual({ port: null, allow_host: null })
  })
  it('sends an explicit false when a set switch is unchecked', () => {
    const s = serve({ lan: b(true) })
    expect(changedServe(s, { ...draftFrom(s), lan: false })).toEqual({
      lan: false,
    })
  })
  it('sends nothing while a value is invalid, and stays dirty', () => {
    const s = serve()
    const d = { ...draftFrom(s), port: '0' }
    expect(isSavable(d)).toBe(false)
    expect(isDirty(s, d)).toBe(true)
    expect(changedServe(s, d)).toEqual({})
  })
})

describe('flagName', () => {
  it('spells the key as its command-line flag', () => {
    expect(flagName('watch_todo')).toBe('--watch-todo')
    expect(flagName('port')).toBe('--port')
  })
})
