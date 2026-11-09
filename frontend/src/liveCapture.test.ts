import { describe, expect, it } from 'vitest'
import {
  AUTO_SEND_IDLE_MS,
  autoSendIdleMs,
  endsMidSentence,
  FRAGMENT_GRACE_MS,
  fragmentGraceMs,
  MAX_AUTO_SEND_IDLE_MS,
  MAX_FRAGMENT_GRACE_MS,
  MIN_AUTO_SEND_IDLE_MS,
  silenceWaitMs,
} from './liveCapture'
import type { ConfigLive } from './types/ConfigLive'

describe('autoSendIdleMs', () => {
  const live = (auto_send_ms: number | null): ConfigLive => ({
    auto_send_ms,
    auto_send_ms_default: AUTO_SEND_IDLE_MS,
    handoff_tokens: null,
    handoff_tokens_default: 150000,
    fragment_grace_ms: null,
    fragment_grace_ms_default: FRAGMENT_GRACE_MS,
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

describe('fragmentGraceMs', () => {
  const live = (fragment_grace_ms: number | null): ConfigLive => ({
    auto_send_ms: null,
    auto_send_ms_default: AUTO_SEND_IDLE_MS,
    handoff_tokens: null,
    handoff_tokens_default: 150000,
    fragment_grace_ms,
    fragment_grace_ms_default: FRAGMENT_GRACE_MS,
  })

  it('is the shipped grace unread or unconfigured, else the configured one', () => {
    expect(fragmentGraceMs(null)).toBe(FRAGMENT_GRACE_MS)
    expect(fragmentGraceMs(live(null))).toBe(FRAGMENT_GRACE_MS)
    expect(fragmentGraceMs(live(4000))).toBe(4000)
    expect(fragmentGraceMs(live(0))).toBe(0)
    expect(fragmentGraceMs(live(999999))).toBe(MAX_FRAGMENT_GRACE_MS)
  })
})

describe('endsMidSentence', () => {
  it('holds the fragments seen in live session 222', () => {
    expect(endsMidSentence('Alright, so how can')).toBe(true)
    expect(endsMidSentence('The')).toBe(true)
    expect(
      endsMidSentence(
        "Alright, let's go ahead and add the ability to use the band's name in the capital. Should we have a",
      ),
    ).toBe(true)
    expect(endsMidSentence('so I was thinking,')).toBe(true)
    expect(endsMidSentence('to make it uh')).toBe(true)
    expect(endsMidSentence('and um')).toBe(true)
  })

  it('never holds a short complete reply', () => {
    for (const t of [
      'yes', 'Yes.', 'no', 'No', '2', "That's all I had.", "that's all I had",
      'okay', 'go ahead', '', 'I think so', "I don't think so", 'yes I will',
      'yes you can', 'go on', 'I did that', 'A', 'not sure why', 'He said "so."',
      "I'll take option (A.)", 'Go with option A',
    ]) {
      expect(endsMidSentence(t), t).toBe(false)
    }
  })

  it('holds a fragment the transcriber punctuated as finished', () => {
    // live QA, naru-audio's own transcript of the spoken fragment
    expect(endsMidSentence('Alright, so how can?')).toBe(true)
    expect(endsMidSentence('Should we have a.')).toBe(true)
    expect(endsMidSentence('The.')).toBe(true)
  })

  it('reads other punctuated endings as finished', () => {
    for (const t of [
      'What can I do for?', "What's it for?", 'Can you?', 'Why?', 'Yes I can!',
      'Where is it from?', 'Do it now…', 'Yeah.',
    ]) {
      expect(endsMidSentence(t), t).toBe(false)
    }
  })
})

describe('silenceWaitMs', () => {
  it('adds the grace only for text that ends mid-sentence', () => {
    expect(silenceWaitMs('Alright, so how can ', 2000, 2500)).toBe(4500)
    expect(silenceWaitMs('yes', 2000, 2500)).toBe(2000)
    expect(silenceWaitMs('Alright, so how can', 2000, 0)).toBe(2000)
  })
})
