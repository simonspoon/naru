import { describe, expect, it } from 'vitest'
import {
  defaultRepo,
  effectiveRepo,
  hashWithRepo,
  repoFromHash,
  repoLabel,
  repoParam,
  showRepoPicker,
} from './gitRepos'
import type { GitRepo } from './types/GitRepo'

const repo = (path: string, branch: string | null = 'main'): GitRepo => ({
  path,
  branch,
})

describe('defaultRepo', () => {
  it('is null with no repos', () => {
    expect(defaultRepo([])).toBeNull()
  })
  it('prefers the root repo wherever it sits in the list', () => {
    expect(defaultRepo([repo('a'), repo('.')])).toBe('.')
  })
  it('is the first found when there is no root repo', () => {
    expect(defaultRepo([repo('a'), repo('b')])).toBe('a')
  })
})

describe('effectiveRepo', () => {
  const repos = [repo('.'), repo('a'), repo('b')]
  it('honours a requested repo that exists', () => {
    expect(effectiveRepo(repos, 'b')).toBe('b')
  })
  it('falls back to the default for an unknown or absent request', () => {
    expect(effectiveRepo(repos, 'gone')).toBe('.')
    expect(effectiveRepo(repos, null)).toBe('.')
    expect(effectiveRepo([], 'a')).toBeNull()
  })
})

describe('showRepoPicker', () => {
  it('only shows for more than one repo', () => {
    expect(showRepoPicker([])).toBe(false)
    expect(showRepoPicker([repo('a')])).toBe(false)
    expect(showRepoPicker([repo('a'), repo('b')])).toBe(true)
  })
})

describe('repoParam', () => {
  it('omits the root repo so the request is unchanged', () => {
    expect(repoParam(null)).toBeUndefined()
    expect(repoParam('.')).toBeUndefined()
    expect(repoParam('a/b')).toBe('a/b')
  })
})

describe('route query', () => {
  it('reads repo from the hash', () => {
    expect(repoFromHash('#/projects/7/git?repo=a%2Fb')).toBe('a/b')
    expect(repoFromHash('#/projects/7/git')).toBeNull()
    expect(repoFromHash('#/projects/7/git?repo=')).toBeNull()
  })
  it('writes and clears repo, keeping other members', () => {
    expect(hashWithRepo('#/projects/7/git', 'a/b')).toBe(
      '#/projects/7/git?repo=a%2Fb',
    )
    expect(hashWithRepo('#/projects/7/git?x=1&repo=a', 'b')).toBe(
      '#/projects/7/git?x=1&repo=b',
    )
    expect(hashWithRepo('#/projects/7/git?repo=a', null)).toBe(
      '#/projects/7/git',
    )
    expect(hashWithRepo('#/projects/7/git?repo=a', '.')).toBe(
      '#/projects/7/git',
    )
  })
  it('round-trips', () => {
    expect(repoFromHash(hashWithRepo('#/projects/7/git', 'a b/c'))).toBe(
      'a b/c',
    )
  })
})

describe('repoLabel', () => {
  it('shows path and branch', () => {
    expect(repoLabel(repo('a', 'dev'))).toBe('a (dev)')
    expect(repoLabel(repo('a', null))).toBe('a')
  })
})
