import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('live ambient flag', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('is off until published', async () => {
    const m = await import('./liveAmbient')
    expect(m.currentLiveAmbient()).toBe(false)
  })

  it('notifies only when the value changes', async () => {
    const m = await import('./liveAmbient')
    const seen = vi.fn()
    const stop = m.subscribeLiveAmbient(seen)
    m.setLiveAmbient(false)
    expect(seen).not.toHaveBeenCalled()
    m.setLiveAmbient(true)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(m.currentLiveAmbient()).toBe(true)
    m.setLiveAmbient(true)
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
    m.setLiveAmbient(false)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(m.currentLiveAmbient()).toBe(false)
  })
})
