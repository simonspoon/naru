import { describe, expect, it } from 'vitest'
import { isInside, moveTarget, normalizeDestDir } from './treeMove'

describe('moveTarget', () => {
  it('joins the destination and the entry name', () => {
    expect(moveTarget('a.ts', 'src')).toEqual({ kind: 'move', path: 'src/a.ts' })
    expect(moveTarget('x/y/a.ts', 'src/lib')).toEqual({ kind: 'move', path: 'src/lib/a.ts' })
  })

  it('moves to the project root as a bare name', () => {
    expect(moveTarget('src/a.ts', '')).toEqual({ kind: 'move', path: 'a.ts' })
  })

  it('is a no-op into the current parent, root included', () => {
    expect(moveTarget('src/a.ts', 'src')).toEqual({ kind: 'noop' })
    expect(moveTarget('a.ts', '')).toEqual({ kind: 'noop' })
  })

  it('is a no-op for a folder dropped on itself', () => {
    expect(moveTarget('src', 'src')).toEqual({ kind: 'noop' })
  })

  it('refuses a folder moved inside itself', () => {
    expect(moveTarget('src', 'src/deep')).toEqual({
      kind: 'refused',
      reason: 'Cannot move a folder into itself.',
    })
  })

  it('does not treat a sibling sharing a prefix as inside', () => {
    expect(moveTarget('src', 'src2')).toEqual({ kind: 'move', path: 'src2/src' })
    expect(isInside('src2', 'src')).toBe(false)
    expect(isInside('src/a', 'src')).toBe(true)
  })

  it('refuses the project root', () => {
    expect(moveTarget('', 'src').kind).toBe('refused')
  })
})

describe('normalizeDestDir', () => {
  it('reads blank and slash as the project root', () => {
    expect(normalizeDestDir('')).toEqual({ ok: true, dir: '' })
    expect(normalizeDestDir('  / ')).toEqual({ ok: true, dir: '' })
  })

  it('trims and strips surrounding slashes', () => {
    expect(normalizeDestDir(' /src/lib/ ')).toEqual({ ok: true, dir: 'src/lib' })
  })

  it('rejects traversal, dot and empty components, backslashes', () => {
    for (const bad of ['..', 'a/../b', './a', 'a/./b', 'a//b', 'a\\b']) {
      expect(normalizeDestDir(bad).ok).toBe(false)
    }
  })
})
