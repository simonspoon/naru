import { describe, expect, it } from 'vitest'
import {
  defaultListMaximized,
  isListenChild,
  liveActivity,
  liveAgentId,
  liveCardWait,
  pinLiveAgent,
  withoutListen,
} from './agentLive'
import type { AgentChild } from './types/AgentChild'
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

const shell = (command: string | null, name = "zsh -c 'source snap && eval x'", state = 'running') =>
  ({ kind: 'shell', name, command, state }) as unknown as AgentChild
const sub = (name: string) =>
  ({ kind: 'subagent', name, command: null, state: 'running' }) as unknown as AgentChild

describe('listen child', () => {
  it('matches naru and mesa spellings, by command or the wrapper name', () => {
    expect(isListenChild(shell('naru live listen --lease 3'))).toBe(true)
    expect(isListenChild(shell('mesa live listen'))).toBe(true)
    expect(isListenChild(shell(null, "zsh -c 'naru live listen'"))).toBe(true)
  })
  it('leaves other shells and subagents alone', () => {
    expect(isListenChild(shell('naru live say hi'))).toBe(false)
    expect(isListenChild(shell('sleep 5'))).toBe(false)
    expect(isListenChild(sub('naru live listen'))).toBe(false)
  })
  it('withoutListen drops only the listen row', () => {
    const keep = [shell('sleep 5'), sub('Explore')]
    expect(withoutListen([shell('naru live listen'), ...keep])).toEqual(keep)
  })
  it('is listening only while a listen child runs', () => {
    expect(liveActivity([shell('naru live listen'), sub('Explore')])).toBe('listening')
    expect(liveActivity([shell('sleep 5'), sub('Explore')])).toBe('working')
    expect(liveActivity([shell('naru live listen', undefined, 'finished')])).toBe('working')
    expect(liveActivity([])).toBe('working')
  })
})
