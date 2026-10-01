import { describe, expect, it } from 'vitest'
import {
  applyElementSpeed,
  formatSpeed,
  normalizeSpeed,
  SPEED_DEFAULT,
} from './speechSpeed'

describe('normalizeSpeed', () => {
  it('keeps an in-range step value', () => {
    expect(normalizeSpeed(1.25)).toBe(1.25)
    expect(normalizeSpeed(0.75)).toBe(0.75)
    expect(normalizeSpeed(1.5)).toBe(1.5)
  })

  it('clamps and snaps', () => {
    expect(normalizeSpeed(3)).toBe(1.5)
    expect(normalizeSpeed(0.1)).toBe(0.75)
    expect(normalizeSpeed(1.12)).toBe(1.1)
  })

  it('falls back to 1 for anything that is not a finite number', () => {
    for (const bad of [NaN, Infinity, '1.2', null, undefined]) {
      expect(normalizeSpeed(bad)).toBe(SPEED_DEFAULT)
    }
  })
})

describe('formatSpeed', () => {
  it('reads as a multiplier without float noise', () => {
    expect(formatSpeed(1)).toBe('1×')
    expect(formatSpeed(1.25)).toBe('1.25×')
    expect(formatSpeed(0.1 + 0.2 + 0.45)).toBe('0.75×')
  })
})

describe('applyElementSpeed', () => {
  it('sets both rates and keeps the pitch', () => {
    const el = { playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: false }
    applyElementSpeed(el, 1.3)
    expect(el).toEqual({
      playbackRate: 1.3,
      defaultPlaybackRate: 1.3,
      preservesPitch: true,
    })
  })
})
