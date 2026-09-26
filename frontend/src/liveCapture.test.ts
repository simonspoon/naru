import { describe, expect, it } from 'vitest'
import {
  AUTO_SEND_IDLE_MS,
  autoSendIdleMs,
  MAX_AUTO_SEND_IDLE_MS,
  MIN_AUTO_SEND_IDLE_MS,
} from './liveCapture'
import type { ConfigLive } from './types/ConfigLive'

describe('autoSendIdleMs', () => {
  const live = (auto_send_ms: number | null): ConfigLive => ({
    auto_send_ms,
    auto_send_ms_default: AUTO_SEND_IDLE_MS,
  })

  it('is the built-in wait before the config has been read', () => {
    expect(autoSendIdleMs(null)).toBe(AUTO_SEND_IDLE_MS)
  })

  it('is the built-in wait when the config says nothing', () => {
    expect(autoSendIdleMs(live(null))).toBe(AUTO_SEND_IDLE_MS)
  })

  it('is the configured wait when there is one', () => {
    expect(autoSendIdleMs(live(4500))).toBe(4500)
  })

  it('clamps a hand-edited value into the bounds the editor writes', () => {
    expect(autoSendIdleMs(live(0))).toBe(MIN_AUTO_SEND_IDLE_MS)
    expect(autoSendIdleMs(live(999999))).toBe(MAX_AUTO_SEND_IDLE_MS)
  })
})
