import { describe, expect, it } from 'vitest'
import { mediaForTurn } from './livePastedImage'

describe('mediaForTurn', () => {
  it('carries nothing when neither is pending', () => {
    expect(mediaForTurn(false, false)).toBe('none')
  })

  it('carries the pasted image alone', () => {
    expect(mediaForTurn(true, false)).toBe('image')
  })

  it('carries the pending ink alone', () => {
    expect(mediaForTurn(false, true)).toBe('ink')
  })

  it('prefers the pasted image over pending ink — the server takes one picture per turn', () => {
    expect(mediaForTurn(true, true)).toBe('image')
  })
})
