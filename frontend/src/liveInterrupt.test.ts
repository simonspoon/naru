import { describe, expect, it } from 'vitest'
import { shouldInterruptAgent } from './liveInterrupt'

describe('shouldInterruptAgent', () => {
  for (const live of [false, true]) {
    for (const joined of [false, true]) {
      for (const working of [false, true]) {
        const expected = live && joined && working
        it(`live=${live} joined=${joined} working=${working} -> ${expected}`, () => {
          expect(shouldInterruptAgent({ live, joined, working })).toBe(expected)
        })
      }
    }
  }
})
