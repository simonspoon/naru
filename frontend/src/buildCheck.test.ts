import { describe, expect, it } from 'vitest'
import {
  pageStale,
  publishStale,
  requestBuildCheck,
  staleBuild,
  subscribeBuildCheck,
  subscribeStale,
} from './buildCheck'

describe('staleBuild', () => {
  it('is stale only when both commits are known and differ', () => {
    expect(staleBuild('abc1234', 'def5678')).toBe(true)
    expect(staleBuild('abc1234', 'abc1234')).toBe(false)
    expect(staleBuild('abc1234', 'abc1234-dirty')).toBe(true)
  })
  it('never counts unknown or a missing version', () => {
    expect(staleBuild('unknown', 'def5678')).toBe(false)
    expect(staleBuild('abc1234', 'unknown')).toBe(false)
    expect(staleBuild(null, 'def5678')).toBe(false)
    expect(staleBuild('abc1234', null)).toBe(false)
  })
})

describe('channels', () => {
  it('delivers a check request to every subscriber until unsubscribed', () => {
    let n = 0
    const off = subscribeBuildCheck(() => n++)
    requestBuildCheck()
    off()
    requestBuildCheck()
    expect(n).toBe(1)
  })
  it('notifies only on a change of verdict', () => {
    let n = 0
    const off = subscribeStale(() => n++)
    publishStale(true)
    publishStale(true)
    expect(pageStale()).toBe(true)
    publishStale(false)
    off()
    expect(pageStale()).toBe(false)
    expect(n).toBe(2)
  })
})
