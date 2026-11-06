import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('nav mark setting', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('is on when nothing is stored', async () => {
    const m = await import('./navMark')
    expect(m.currentNavMark()).toBe(true)
  })

  it('reads the mirrored off at load, so a reload never mounts the mark', async () => {
    localStorage.setItem('naru-nav-mark', 'off')
    const m = await import('./navMark')
    expect(m.currentNavMark()).toBe(false)
  })

  it('mirrors a change and notifies only when the value changes', async () => {
    const m = await import('./navMark')
    const seen = vi.fn()
    const stop = m.subscribeNavMark(seen)
    m.setNavMark(true)
    expect(seen).not.toHaveBeenCalled()
    m.setNavMark(false)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(m.currentNavMark()).toBe(false)
    expect(localStorage.getItem('naru-nav-mark')).toBe('off')
    stop()
    m.setNavMark(true)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('naru-nav-mark')).toBe('on')
  })
})
