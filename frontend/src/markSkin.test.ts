import { describe, expect, it } from 'vitest'
import {
  currentMarkSkin,
  DEFAULT_MARK_SKIN,
  MARK_SKIN_IDS,
  MARK_SKIN_LABELS,
  markSkinId,
  setMarkSkin,
  subscribeMarkSkin,
} from './markSkin'

describe('markSkinId', () => {
  it('knows exactly the waveform (the default), the face and the blob, each labelled', () => {
    expect([...MARK_SKIN_IDS]).toEqual(['waveform', 'face', 'blob'])
    expect(DEFAULT_MARK_SKIN).toBe('waveform')
    expect(MARK_SKIN_IDS.map((id) => MARK_SKIN_LABELS[id])).toEqual(['Waveform', 'Face', 'Blob'])
  })
  it('falls back to the default for an unknown, blank or absent id', () => {
    expect(markSkinId('waveform')).toBe('waveform')
    expect(markSkinId(' waveform ')).toBe('waveform')
    expect(markSkinId('face')).toBe('face')
    expect(markSkinId('blob')).toBe('blob')
    for (const bad of ['nope', '', '  ', null, undefined, 'Waveform', 'Face']) expect(markSkinId(bad)).toBe('waveform')
  })
})

describe('setMarkSkin', () => {
  it('starts on the default and notifies only when the id changes', () => {
    expect(currentMarkSkin()).toBe('waveform')
    let calls = 0
    const off = subscribeMarkSkin(() => calls++)
    setMarkSkin('waveform')
    setMarkSkin(null)
    setMarkSkin('bogus')
    expect(calls).toBe(0)
    expect(currentMarkSkin()).toBe('waveform')
    off()
  })
})
