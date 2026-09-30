// Pure logic behind the Git tab's repo picker (mesa task 1509): which of the
// repos discovered under a project's folder is selected, and how that choice
// rides in the route (`#/projects/7/git?repo=a%2Fb`) so it survives a reload.
// A repo is named by its `path` relative to the project folder, `.` being the
// folder itself — exactly the value the server's `?repo=` accepts.
import type { GitRepo } from './types/GitRepo'

export const ROOT_REPO = '.'

/** The repo shown when nothing is picked: the folder's own repo if it is
 *  one, else the first found; null when there are none (today's empty
 *  state). */
export function defaultRepo(repos: GitRepo[]): string | null {
  if (repos.length === 0) return null
  return repos.find((r) => r.path === ROOT_REPO)?.path ?? repos[0].path
}

/** The repo to read: `requested` when it is one of `repos`, else the
 *  default — a stale `?repo=` (repo deleted, hand-edited) falls back rather
 *  than 404ing the whole tab. */
export function effectiveRepo(
  repos: GitRepo[],
  requested: string | null,
): string | null {
  if (requested !== null && repos.some((r) => r.path === requested)) {
    return requested
  }
  return defaultRepo(repos)
}

/** The picker is offered only when there is something to choose between; a
 *  lone repo is selected silently. */
export function showRepoPicker(repos: GitRepo[]): boolean {
  return repos.length > 1
}

/** The `repo` argument for the git API: undefined for the folder's own repo
 *  (the server's byte-identical default), else the relative path. */
export function repoParam(repo: string | null): string | undefined {
  return repo === null || repo === ROOT_REPO ? undefined : repo
}

/** `repo` from a route hash's query, or null when absent/empty. */
export function repoFromHash(hash: string): string | null {
  const q = hash.indexOf('?')
  if (q < 0) return null
  const v = new URLSearchParams(hash.slice(q + 1)).get('repo')
  return v === null || v === '' ? null : v
}

/** `hash` with its `repo` query set to `repo` (removed for null or the
 *  folder's own repo), other query members kept. */
export function hashWithRepo(hash: string, repo: string | null): string {
  const q = hash.indexOf('?')
  const base = q < 0 ? hash : hash.slice(0, q)
  const params = new URLSearchParams(q < 0 ? '' : hash.slice(q + 1))
  if (repo === null || repo === ROOT_REPO) params.delete('repo')
  else params.set('repo', repo)
  const rest = params.toString()
  return rest === '' ? base : `${base}?${rest}`
}

/** Picker row text: relative path plus current branch. */
export function repoLabel(r: GitRepo): string {
  return r.branch === null ? r.path : `${r.path} (${r.branch})`
}
