import { beforeEach, describe, expect, it } from 'vitest'
import { loadNavHidden, saveNavHidden } from './navHidden'

beforeEach(() => localStorage.clear())

describe('navHidden', () => {
  it('is hidden by default', () => {
    expect(loadNavHidden()).toBe(true)
  })
  it('round-trips shown and hidden', () => {
    saveNavHidden(false)
    expect(loadNavHidden()).toBe(false)
    saveNavHidden(true)
    expect(loadNavHidden()).toBe(true)
  })
  it('treats any other stored value as hidden', () => {
    for (const raw of ['1', 'true', '', 'SHOWN', '0']) {
      localStorage.setItem('naru-nav-shown', raw)
      expect(loadNavHidden()).toBe(true)
    }
  })
})
