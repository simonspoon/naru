import { describe, expect, it } from 'vitest'
import { buildStatuses, NO_STATUS, statusFor } from './projectStatus'

const git = (branch: string, dirty = 0, ahead = 0) => ({ branch, dirty, ahead, behind: 0 })

describe('buildStatuses', () => {
  it('counts todo as queued and in_progress as running, per project', () => {
    const m = buildStatuses(
      [
        { project_id: 1, status: 'todo' },
        { project_id: 1, status: 'todo' },
        { project_id: 1, status: 'in_progress' },
        { project_id: 2, status: 'in_progress' },
        { project_id: 2, status: 'done' },
        { project_id: 2, status: 'backlog' },
      ],
      [],
    )
    expect(statusFor(m, 1)).toMatchObject({ queued: 2, running: 1 })
    expect(statusFor(m, 2)).toMatchObject({ queued: 0, running: 1 })
  })
  it('shows a branch only when it is not main or master', () => {
    const m = buildStatuses([], [
      { project_id: 1, git: git('main') },
      { project_id: 2, git: git('master') },
      { project_id: 3, git: git('feature/x') },
    ])
    expect(statusFor(m, 1).branch).toBeNull()
    expect(statusFor(m, 2).branch).toBeNull()
    expect(statusFor(m, 3).branch).toBe('feature/x')
  })
  it('marks dirty on changes or ahead, not behind alone', () => {
    const m = buildStatuses([], [
      { project_id: 1, git: git('main', 2) },
      { project_id: 2, git: git('main', 0, 1) },
      { project_id: 3, git: { ...git('main'), behind: 4 } },
    ])
    expect(statusFor(m, 1).dirty).toBe(true)
    expect(statusFor(m, 2).dirty).toBe(true)
    expect(statusFor(m, 3).dirty).toBe(false)
  })
  it('returns the all-zero status for an unknown project', () => {
    expect(statusFor(new Map(), 9)).toBe(NO_STATUS)
  })
})
