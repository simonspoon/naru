import { describe, expect, it } from 'vitest'
import { defaultListMaximized, liveAgentId, liveCardWait, pinLiveAgent } from './agentLive'
import type { AgentSession } from './types/AgentSession'
import type { LiveState } from './types/LiveState'

const agent = (id: string | null): AgentSession => ({ id, sessionId: `s-${id}` }) as AgentSession
const live = (status: string, agent_id: string | null) =>
  ({ session: { status, agent_id } }) as unknown as LiveState

describe('liveAgentId', () => {
  it('names the driver of a live session only', () => {
    expect(liveAgentId(live('live', 'abc'))).toBe('abc')
    expect(liveAgentId(live('ended', 'abc'))).toBeNull()
    expect(liveAgentId(live('live', null))).toBeNull()
    expect(liveAgentId({ session: null })).toBeNull()
    expect(liveAgentId(undefined)).toBeNull()
  })
})

describe('pinLiveAgent', () => {
  const list = [agent('a'), agent('b'), agent(null)]
  it('lifts the live agent out of the list, keeping the rest in order', () => {
    const { live: l, rest } = pinLiveAgent(list, 'b')
    expect(l?.id).toBe('b')
    expect(rest.map((a) => a.id)).toEqual(['a', null])
  })
  it('omits the card when nothing is live or the job is not listed', () => {
    expect(pinLiveAgent(list, null)).toEqual({ live: null, rest: list })
    expect(pinLiveAgent(list, 'zzz')).toEqual({ live: null, rest: list })
  })
})

describe('liveCardWait', () => {
  it('shows only a permission wait', () => {
    expect(liveCardWait({ state: 'blocked', waitingFor: 'permission prompt' })).toBe('permission prompt')
    expect(liveCardWait({ state: 'blocked', waitingFor: 'tool permission prompt' })).toBe('tool permission prompt')
  })
  it('says nothing for any other state', () => {
    expect(liveCardWait({ state: 'blocked', waitingFor: 'input needed' })).toBeNull()
    expect(liveCardWait({ state: 'blocked', waitingFor: null })).toBeNull()
    expect(liveCardWait({ state: 'done', waitingFor: null })).toBeNull()
    expect(liveCardWait({ state: 'working', waitingFor: 'permission prompt' })).toBeNull()
  })
})

describe('defaultListMaximized', () => {
  it('is the card view off the phone tier', () => {
    expect(defaultListMaximized(false)).toBe(true)
    expect(defaultListMaximized(true)).toBe(false)
  })
})
