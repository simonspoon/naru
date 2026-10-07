import { describe, expect, it } from 'vitest'
import {
  legacyScriptsRedirect,
  libraryRouteFromPath,
  libraryRunHref,
  libraryTabHref,
} from './libraryTab'

describe('libraryRouteFromPath', () => {
  it('bare and unknown segments are the first tab', () => {
    expect(libraryRouteFromPath('/library')).toEqual({ tab: 'claude-code', runId: null })
    expect(libraryRouteFromPath('/library/nope')).toEqual({ tab: 'claude-code', runId: null })
  })
  it('names the other tabs, case-insensitively', () => {
    expect(libraryRouteFromPath('/library/scripts')?.tab).toBe('scripts')
    expect(libraryRouteFromPath('/library/Workflows')?.tab).toBe('workflows')
  })
  it('tolerates a trailing slash', () => {
    expect(libraryRouteFromPath('/library/')).toEqual({ tab: 'claude-code', runId: null })
    expect(libraryRouteFromPath('/library/scripts/')?.tab).toBe('scripts')
    expect(libraryRouteFromPath('/library/scripts/runs/3/')).toEqual({ tab: 'scripts', runId: 3 })
    expect(legacyScriptsRedirect('/scripts/')).toBe('#/library/scripts')
  })
  it('reads a run inside the Scripts tab', () => {
    expect(libraryRouteFromPath('/library/scripts/runs/42')).toEqual({ tab: 'scripts', runId: 42 })
  })
  it('is null off the library', () => {
    expect(libraryRouteFromPath('/scripts')).toBeNull()
    expect(libraryRouteFromPath('/libraryx')).toBeNull()
    expect(libraryRouteFromPath('/library/scripts/runs/x')).toBeNull()
  })
})

describe('hrefs and the legacy redirect', () => {
  it('round-trips', () => {
    expect(libraryTabHref('claude-code')).toBe('#/library')
    expect(libraryTabHref('workflows')).toBe('#/library/workflows')
    expect(libraryRunHref(7)).toBe('#/library/scripts/runs/7')
  })
  it('redirects the old scripts addresses', () => {
    expect(legacyScriptsRedirect('/scripts')).toBe('#/library/scripts')
    expect(legacyScriptsRedirect('/scripts/runs/9')).toBe('#/library/scripts/runs/9')
    expect(legacyScriptsRedirect('/library')).toBeNull()
  })
})
