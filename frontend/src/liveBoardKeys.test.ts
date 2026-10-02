import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYMAP } from './keymap'
import { boundFunctionKeys, parseBoardKey } from './liveBoardKeys'

const good = {
  naru: 'board-key',
  key: 'F5',
  code: 'F5',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
}

describe('parseBoardKey', () => {
  it('accepts exactly the relay shape', () => {
    expect(parseBoardKey(good)).toEqual({
      key: 'F5',
      code: 'F5',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
    })
  })
  it('drops extra fields', () => {
    expect(parseBoardKey({ ...good, evil: 1 })).not.toHaveProperty('evil')
  })
  it('rejects a wrong tag, non-objects and bad field types', () => {
    expect(parseBoardKey(null)).toBeNull()
    expect(parseBoardKey('board-key')).toBeNull()
    expect(parseBoardKey({ ...good, naru: 'other' })).toBeNull()
    expect(parseBoardKey({ ...good, key: 5 })).toBeNull()
    expect(parseBoardKey({ ...good, key: '' })).toBeNull()
    expect(parseBoardKey({ ...good, key: 'x'.repeat(33) })).toBeNull()
    expect(parseBoardKey({ ...good, ctrlKey: 'yes' })).toBeNull()
    const missing: Record<string, unknown> = { ...good }
    delete missing.repeat
    expect(parseBoardKey(missing)).toBeNull()
  })
})

describe('parseBoardKey filter', () => {
  it('rejects a forged bare key', () => {
    for (const key of ['a', 'Escape', 'ArrowDown']) {
      expect(parseBoardKey({ ...good, key, code: key })).toBeNull()
    }
    expect(parseBoardKey({ ...good, key: 'a', shiftKey: true })).toBeNull()
  })
  it('accepts a function key and a Meta/Ctrl/Alt chord', () => {
    expect(parseBoardKey({ ...good, key: 'F24' })).not.toBeNull()
    expect(parseBoardKey({ ...good, key: 'l', code: 'KeyL', metaKey: true, shiftKey: true })).not.toBeNull()
    expect(parseBoardKey({ ...good, key: 'a', ctrlKey: true })).not.toBeNull()
    expect(parseBoardKey({ ...good, key: 'a', altKey: true })).not.toBeNull()
  })
})

describe('boundFunctionKeys', () => {
  it('is empty for the shipped keymap', () => {
    expect(boundFunctionKeys(DEFAULT_KEYMAP)).toEqual([])
  })
  it('lists bare function keys only, sorted and unique', () => {
    const km = {
      ...DEFAULT_KEYMAP,
      'live-listen': ['F5', 'Mod+F6'],
      'live-cancel': ['F2', 'F5', 'Escape'],
    }
    expect(boundFunctionKeys(km)).toEqual(['F2', 'F5'])
  })
})
