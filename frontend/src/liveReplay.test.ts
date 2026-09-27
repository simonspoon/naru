import { describe, expect, it } from 'vitest'
import { replayControl, type ReplayContext } from './liveReplay'
import type { LiveTurn } from './types/LiveTurn'

function turn(id: number, patch: Partial<LiveTurn> = {}): LiveTurn {
  return {
    id,
    session_id: 1,
    role: 'naru',
    text: 'the board is open',
    action: null,
    target: null,
    notice: null,
    agent_id: null,
    image_path: null,
    board_id: null,
    view: null,
    created_at: '2026-01-01 00:00:00',
    delivered_at: null,
    played_at: null,
    ...patch,
  }
}

function ctx(patch: Partial<ReplayContext> = {}): ReplayContext {
  return {
    unlocked: true,
    speechMuted: false,
    paused: false,
    liveSounding: false,
    replaying: null,
    ...patch,
  }
}

describe('replayControl', () => {
  it('is hidden for a turn with no spoken text', () => {
    expect(replayControl(turn(1, { text: '' }), ctx())).toBe('hidden')
  })

  it('is hidden for a pure navigate turn', () => {
    expect(
      replayControl(turn(1, { text: '', action: 'navigate', target: '#/tasks' }), ctx()),
    ).toBe('hidden')
  })

  it('is hidden for a user turn', () => {
    expect(replayControl(turn(1, { role: 'user' }), ctx())).toBe('hidden')
  })

  it('is play for an ordinary Naru turn with nothing else going on', () => {
    expect(replayControl(turn(1), ctx())).toBe('play')
  })

  it('is stop for the turn this browser is replaying, even muted or paused', () => {
    expect(replayControl(turn(1), ctx({ replaying: 1, speechMuted: true }))).toBe('stop')
    expect(replayControl(turn(1), ctx({ replaying: 1, paused: true }))).toBe('stop')
    expect(replayControl(turn(1), ctx({ replaying: 1, unlocked: false }))).toBe('stop')
  })

  it('stays playable for a different turn while another one replays, so a press can switch', () => {
    expect(replayControl(turn(2), ctx({ replaying: 1 }))).toBe('play')
  })

  it('is disabled with no player unlocked yet', () => {
    expect(replayControl(turn(1), ctx({ unlocked: false }))).toBe('disabled')
  })

  it('is disabled while speech is muted', () => {
    expect(replayControl(turn(1), ctx({ speechMuted: true }))).toBe('disabled')
  })

  it('is disabled while the conversation is paused', () => {
    expect(replayControl(turn(1), ctx({ paused: true }))).toBe('disabled')
  })

  it('is disabled while a live turn is sounding, so replay never interrupts it', () => {
    expect(replayControl(turn(1), ctx({ liveSounding: true }))).toBe('disabled')
  })
})
