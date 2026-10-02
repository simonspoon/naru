import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DragEvent } from 'react'
import { PANEL_DRAG_MIME } from '../dockLayout'
import { beginPanelDrag, currentPanelDrag, endPanelDrag } from './panelDrag'

function fakeDrag() {
  const data: Record<string, string> = {}
  const e = { dataTransfer: { effectAllowed: '', setData: (k: string, v: string) => (data[k] = v) } }
  return { e: e as unknown as DragEvent, data }
}

describe('panelDrag', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    endPanelDrag()
    vi.useRealTimers()
  })

  it('writes the payload at once and raises the shield one tick later', () => {
    const { e, data } = fakeDrag()
    beginPanelDrag(e, 'chat')
    expect(data[PANEL_DRAG_MIME]).toBe('chat')
    expect(data['text/plain']).toBe('Chat')
    expect(currentPanelDrag()).toBeNull()
    vi.advanceTimersByTime(0)
    expect(currentPanelDrag()).toBe('chat')
  })

  it('a drag that ends inside the tick never raises the shield', () => {
    beginPanelDrag(fakeDrag().e, 'orb')
    endPanelDrag()
    vi.advanceTimersByTime(10)
    expect(currentPanelDrag()).toBeNull()
  })

  it('ends a raised shield', () => {
    beginPanelDrag(fakeDrag().e, 'board')
    vi.advanceTimersByTime(0)
    endPanelDrag()
    expect(currentPanelDrag()).toBeNull()
  })
})
