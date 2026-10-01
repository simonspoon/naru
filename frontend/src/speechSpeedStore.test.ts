import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSpeech = vi.fn()
vi.mock('./api', () => ({ getSpeech }))

describe('loadSpeechSpeed', () => {
  beforeEach(() => {
    vi.resetModules()
    getSpeech.mockReset()
  })

  it('retries after a failed first fetch instead of pinning 1x', async () => {
    getSpeech.mockRejectedValueOnce(new Error('restarting'))
    getSpeech.mockResolvedValueOnce({ speed: 1.25 })
    const { getSpeechSpeed } = await import('./speechSpeedStore')
    expect(getSpeechSpeed()).toBe(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(getSpeech).toHaveBeenCalledTimes(1)
    // The next read starts a fresh fetch.
    expect(getSpeechSpeed()).toBe(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(getSpeech).toHaveBeenCalledTimes(2)
    expect(getSpeechSpeed()).toBe(1.25)
  })

  it('fetches once when the first fetch succeeds', async () => {
    getSpeech.mockResolvedValue({ speed: 0.75 })
    const { getSpeechSpeed } = await import('./speechSpeedStore')
    getSpeechSpeed()
    await new Promise((r) => setTimeout(r, 0))
    getSpeechSpeed()
    expect(getSpeech).toHaveBeenCalledTimes(1)
    expect(getSpeechSpeed()).toBe(0.75)
  })
})
