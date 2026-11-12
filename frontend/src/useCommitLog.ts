import { useCallback, useEffect, useRef, useState } from 'react'
import { getProjectGitLog } from './api'
import { PARENT_HUNT_PAGES, focusRefreshable, mergePage } from './gitHistory'
import { filtersKey, type LogFilters } from './gitSearch'
import type { GitCommit } from './types/GitCommit'

/** The loaded history of one (project, repo, worktree, all-branches) scope. */
export type CommitLogState = {
  /** Scope + all-mode this state belongs to; a late response for another key is dropped. */
  key: string
  /** The key without the all-mode, to tell "same repo, other mode" from "other repo". */
  scope: string
  path: string | null
  /** null = no local path / not a repo (see `path`); [] = unborn HEAD. */
  commits: GitCommit[] | null
  /** Rows received from the server so far (the next page's `skip`), counted before dedupe. */
  rawCount: number
  pages: number
  hasMore: boolean
  /** The search was stopped by the server's timeout (no more pages). */
  timedOut: boolean
  /** First-load error (commits stay null). */
  error: string | null
  /** Failed Load more. */
  moreError: string | null
  loadingMore: boolean
}

/**
 * Paged, race-guarded commit log for the History view (naru task 2735).
 *
 * - Page 1 loads on mount / scope change; pages append through `loadMore`,
 *   deduped by hash, never touching what is already loaded.
 * - Every async result is checked against the key it was started for and the
 *   `rawCount` it was started at; a late response for a previous scope, mode
 *   or offset is dropped.
 * - Window focus refreshes page 1 in place, but only while page 1 is the only
 *   page (`focusRefreshable`): a refresh must not throw away pages 2+, and a
 *   refresh failure is ignored. With more pages loaded, focus does nothing.
 */
export function useCommitLog(
  projectId: number,
  worktree: string | null,
  repo: string | undefined,
  all: boolean,
  filters: LogFilters,
) {
  const scope = `${projectId}|${repo ?? ''}|${worktree ?? ''}`
  // Filters are part of the key, so a reply for an older search is dropped.
  const key = `${scope}|${all ? 'all' : 'cur'}|${filtersKey(filters)}`
  const [st, setSt] = useState<CommitLogState | null>(null)
  const [nonce, setNonce] = useState(0)
  const stRef = useRef<CommitLogState | null>(null)
  const keyRef = useRef(key)
  // The page request in flight, so a second caller can await it instead of failing.
  const inflight = useRef<Promise<boolean> | null>(null)
  const put = (s: CommitLogState | null) => {
    stRef.current = s
    setSt(s)
  }

  useEffect(() => {
    keyRef.current = key
    inflight.current = null
    let cancelled = false
    const fetchFirst = () =>
      getProjectGitLog(projectId, worktree ?? undefined, repo, { all, filters })
    const base = { key, scope, rawCount: 0, pages: 1, moreError: null, loadingMore: false }
    fetchFirst().then(
      (log) => {
        if (cancelled) return
        const n = log.commits?.length ?? 0
        put({
          ...base,
          path: log.path,
          commits: log.commits === null ? null : mergePage([], log.commits),
          rawCount: n,
          hasMore: log.has_more,
          timedOut: log.timed_out,
          error: null,
        })
      },
      (e: unknown) => {
        if (cancelled) return
        put({
          ...base,
          path: null,
          commits: null,
          hasMore: false,
          timedOut: false,
          error: e instanceof Error ? e.message : String(e),
        })
      },
    )
    const onFocus = () => {
      const cur = stRef.current
      if (!cur || cur.key !== key || cur.commits === null || cur.error !== null) return
      if (!focusRefreshable(cur.pages) || cur.loadingMore) return
      fetchFirst().then(
        (log) => {
          const now = stRef.current
          if (cancelled || !now || now.key !== key || now.pages !== 1 || now.loadingMore) return
          if (log.commits === null) return
          const same =
            log.commits.length === now.commits?.length &&
            log.commits.every((c, i) => c.hash === now.commits?.[i].hash && c.subject === now.commits[i].subject && c.refs.length === now.commits[i].refs.length)
          if (same && log.has_more === now.hasMore) return
          put({
            ...now,
            commits: mergePage([], log.commits),
            rawCount: log.commits.length,
            hasMore: log.has_more,
            timedOut: log.timed_out,
          })
        },
        () => {},
      )
    }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
    // `put` only touches refs and a state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce])

  const loadPage = useCallback(async (): Promise<boolean> => {
    const s = stRef.current
    if (!s || s.key !== keyRef.current || s.commits === null) return false
    if (!s.hasMore || s.loadingMore) return false
    const k = s.key
    const skip = s.rawCount
    stRef.current = { ...s, loadingMore: true, moreError: null }
    setSt(stRef.current)
    const stale = () => {
      const c = stRef.current
      return !c || c.key !== k || keyRef.current !== k || c.rawCount !== skip
    }
    try {
      const log = await getProjectGitLog(projectId, worktree ?? undefined, repo, {
        all,
        skip,
        filters,
      })
      if (stale()) return false
      const cur = stRef.current!
      const page = log.commits ?? []
      stRef.current = {
        ...cur,
        commits: mergePage(cur.commits ?? [], page),
        rawCount: cur.rawCount + page.length,
        pages: cur.pages + 1,
        // An empty page ends the walk even if the server claims more (no spin).
        hasMore: log.has_more && page.length > 0,
        timedOut: log.timed_out,
        loadingMore: false,
        moreError: null,
      }
      setSt(stRef.current)
      return true
    } catch (e) {
      if (stale()) return false
      stRef.current = {
        ...stRef.current!,
        loadingMore: false,
        moreError: e instanceof Error ? e.message : String(e),
      }
      setSt(stRef.current)
      return false
    }
  }, [projectId, worktree, repo, all, filters])

  /** Load the next page; a call while one is in flight awaits that one. */
  const loadMore = useCallback((): Promise<boolean> => {
    if (inflight.current) return inflight.current
    const p = loadPage().finally(() => {
      if (inflight.current === p) inflight.current = null
    })
    inflight.current = p
    return p
  }, [loadPage])

  /** Load pages (bounded) until `hash` is loaded; null when not found. */
  const loadUntil = useCallback(
    async (hash: string): Promise<GitCommit | null> => {
      const find = () => stRef.current?.commits?.find((c) => c.hash === hash) ?? null
      for (let i = 0; i <= PARENT_HUNT_PAGES; i++) {
        const f = find()
        if (f) return f
        if (i === PARENT_HUNT_PAGES || !(await loadMore())) break
      }
      return find()
    },
    [loadMore],
  )

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const current = st && st.key === key ? st : null
  // Same repo, other all-mode: keep showing the old rows (dimmed) until the new ones arrive.
  const previous = !current && st && st.scope === scope ? st : null
  return { current, previous, loadMore, loadUntil, reload }
}
