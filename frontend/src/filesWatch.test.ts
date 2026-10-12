import { describe, expect, it } from 'vitest'
import { levelsToRefetch, parseWatchLine, reconnectDelayMs } from './filesWatch'

describe('parseWatchLine', () => {
  it('reads ready and ping', () => {
    expect(parseWatchLine('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseWatchLine('{"type":"ping"}')).toEqual({ type: 'ping' })
  })
  it('reads a change with a list', () => {
    expect(parseWatchLine('{"type":"change","dirs":["","src"]}')).toEqual({
      type: 'change',
      dirs: ['', 'src'],
    })
  })
  it('reads a change with null dirs', () => {
    expect(parseWatchLine('{"type":"change","dirs":null}')).toEqual({ type: 'change', dirs: null })
  })
  it('returns null for garbage, unknown types and bad dirs', () => {
    expect(parseWatchLine('not json')).toBeNull()
    expect(parseWatchLine('')).toBeNull()
    expect(parseWatchLine('42')).toBeNull()
    expect(parseWatchLine('null')).toBeNull()
    expect(parseWatchLine('{"type":"nope"}')).toBeNull()
    expect(parseWatchLine('{"type":"change","dirs":[1]}')).toBeNull()
    expect(parseWatchLine('{"type":"change","dirs":"src"}')).toBeNull()
  })
})

describe('levelsToRefetch', () => {
  it('null refetches the root and every loaded dir', () => {
    expect(levelsToRefetch(null, ['src', 'src/a'])).toEqual({ root: true, dirs: ['src', 'src/a'] })
  })
  it('the root alone', () => {
    expect(levelsToRefetch([''], ['src'])).toEqual({ root: true, dirs: [] })
  })
  it('a loaded dir only', () => {
    expect(levelsToRefetch(['src'], ['src', 'docs'])).toEqual({ root: false, dirs: ['src'] })
  })
  it('an unloaded dir fetches nothing', () => {
    expect(levelsToRefetch(['src'], ['docs'])).toEqual({ root: false, dirs: [] })
  })
  it('treats whatever is passed as loaded, and never lists the root twice', () => {
    expect(levelsToRefetch(['', 'x'], new Set(['', 'x']))).toEqual({ root: true, dirs: ['x'] })
  })
})

describe('reconnectDelayMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect([0, 1, 2, 3, 4].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(reconnectDelayMs(5)).toBe(30000)
    expect(reconnectDelayMs(100)).toBe(30000)
  })
})
