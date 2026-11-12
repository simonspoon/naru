import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getProjectGit,
  getProjectGitCommit,
  getProjectGitCommitDiff,
  getProjectGitCommitFiles,
  getProjectGitDiff,
  getProjectGitRepos,
} from '../api'
import type { GitCommit } from '../types/GitCommit'
import type { GitCommitFile } from '../types/GitCommitFile'
import type { GitFile } from '../types/GitFile'
import type { GitRepo } from '../types/GitRepo'
import type { GitWorktree } from '../types/GitWorktree'
import { useLiveContext } from '../liveContext'
import { LiveFocus } from './LiveFocus'
import { useFetch } from '../useFetch'
import { DiffView } from '../components/DiffView'
import { CommitList } from '../components/CommitGraph'
import { statTotals, subjectOrPlaceholder, totalsLabel } from '../gitHistory'
import { usePhoneTier } from '../phoneTier'
import { useCommitLog } from '../useCommitLog'
import {
  effectiveRepo,
  hashWithRepo,
  repoFromHash,
  repoLabel,
  repoParam,
  showRepoPicker,
} from '../gitRepos'

// Human word for one porcelain-v2 status char. X = staged column,
// Y = unstaged column, '.' = unchanged in that column.
const STATUS_WORDS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
  U: 'conflict',
}

/** "MM" → "modified (staged), modified (unstaged)"; "??" → "untracked";
 * any unknown char → the raw pair verbatim. */
function statusLabel(status: string): string {
  if (status === '??') return 'untracked'
  const parts: string[] = []
  const columns: [string | undefined, string][] = [
    [status[0], 'staged'],
    [status[1], 'unstaged'],
  ]
  for (const [c, column] of columns) {
    if (c === undefined || c === '.') continue
    const word = STATUS_WORDS[c]
    if (word === undefined) return status
    parts.push(`${word} (${column})`)
  }
  return parts.length > 0 ? parts.join(', ') : status
}

/** Per-commit status label: a single name-status token (`A`/`M`/`D`/`T`/`U`/
 * `X`, or `R100`/`C100` with a similarity score) — a commit has no staged/
 * unstaged distinction, so this is a small sibling of statusLabel, not a
 * call to it verbatim. */
function commitStatusLabel(status: string): string {
  const word = STATUS_WORDS[status[0]]
  return word ?? status
}

/** The selected working-tree file's unified diff vs HEAD, scoped to
 * `worktree` when a non-default one is selected (same selector GitView's
 * own file list/diff already resolved `path` against). */
function DiffPane({
  projectId,
  path,
  worktree,
  repo,
}: {
  projectId: number
  path: string
  worktree: string | null
  repo: string | undefined
}) {
  const { data, error } = useFetch(
    () => getProjectGitDiff(projectId, path, worktree ?? undefined, repo),
    `git-diff-${projectId}-${repo ?? ''}-${worktree ?? ''}-${path}`,
  )
  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>
  return <DiffView key={`${worktree ?? ''} ${path}`} diff={data.diff} path={path} />
}

/** The selected file's unified diff as introduced by one commit. Sibling of
 * DiffPane: same rendering, fetched via `git show <sha> -- path` instead of
 * against the working tree. */
function CommitDiffPane({
  projectId,
  sha,
  path,
  repo,
}: {
  projectId: number
  sha: string
  path: string
  repo: string | undefined
}) {
  const { data, error } = useFetch(
    () => getProjectGitCommitDiff(projectId, sha, path, repo),
    `git-commit-diff-${projectId}-${repo ?? ''}-${sha}-${path}`,
  )
  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>
  return <DiffView key={`${sha} ${path}`} diff={data.diff} path={path} />
}

function fileLabel(f: GitFile): string {
  // Rename/copy lines carry the source path: show "orig → path".
  return f.orig_path !== null ? `${f.orig_path} → ${f.path}` : f.path
}

function commitFileLabel(f: GitCommitFile): string {
  // Same rename display convention as fileLabel.
  return f.orig_path !== null ? `${f.orig_path} → ${f.path}` : f.path
}

/** Same "no linked folder" copy for both Working-tree and History modes
 * (M9) — factored out once so the two ladders can't drift. */
function NoLocalPathPlaceholder({ projectId }: { projectId: number }) {
  return (
    <div className="git-placeholder muted">
      <p>
        This project has no linked folder, so Naru cannot see its git
        status. Run <code>mesa project resolve</code> inside the repo, or{' '}
        <code>mesa project update {projectId} --path &lt;dir&gt;</code>, to
        link one.
      </p>
    </div>
  )
}

/** Same "not a repo" copy for both Working-tree and History modes (M9). */
function NotARepoPlaceholder({ path }: { path: string }) {
  return (
    <div className="git-placeholder muted">
      <p>
        <code>{path}</code> is not a git repository (or the folder no
        longer exists).
      </p>
    </div>
  )
}

/** Copy `text` to the clipboard: the async API when there is one (secure
 * contexts only), else a hidden textarea + execCommand, else report failure so
 * the caller can say so. The hash stays selectable either way. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(t)
  }, [state])
  return (
    <button
      type="button"
      className="git-copy"
      aria-label="Copy full commit hash"
      onClick={() => {
        copyText(text).then((ok) => setState(ok ? 'copied' : 'failed'))
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  )
}

const fmtDate = (iso: string) =>
  Number.isNaN(Date.parse(iso)) ? iso : new Date(iso).toLocaleString()

/**
 * Detail panel for one selected commit: full message, author/committer, full
 * sha + Copy, parent links, and the changed-file list (per-file +added −deleted
 * and a total). A merge's files and diffs are against its first parent.
 * Every string here comes from repo history and is rendered as a text node.
 */
function CommitDetail({
  projectId,
  repo,
  commit,
  selectedPath,
  onSelectPath,
  onSelectParent,
  onBack,
}: {
  projectId: number
  repo: string | undefined
  commit: GitCommit
  selectedPath: string | null
  onSelectPath: (path: string) => void
  onSelectParent: (hash: string) => Promise<boolean>
  onBack: () => void
}) {
  const { data: detail, error: detailError } = useFetch(
    () => getProjectGitCommit(projectId, commit.hash, repo),
    `git-commit-${projectId}-${repo ?? ''}-${commit.hash}`,
  )
  const { data: files, error: filesError } = useFetch(
    () => getProjectGitCommitFiles(projectId, commit.hash, repo),
    `git-commit-files-${projectId}-${repo ?? ''}-${commit.hash}`,
  )
  // Parents the bounded page hunt could not reach, and the one being hunted.
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [hunting, setHunting] = useState<string | null>(null)
  const subject = subjectOrPlaceholder(commit.subject)
  const totals = files ? statTotals(files) : null
  const showCommitter =
    detail !== null &&
    (detail.committer !== detail.author ||
      detail.committer_email !== detail.author_email ||
      detail.committer_date !== detail.author_date)

  return (
    <section className="git-commit-detail" role="region" aria-label="Commit details">
      <button type="button" className="git-back git-back-narrow" onClick={onBack}>
        ← Commits
      </button>
      <h3 className={`git-detail-subject${subject.empty ? ' muted' : ''}`}>{subject.text}</h3>
      {detailError && <p className="error">{detailError}</p>}
      {detail && detail.body.trim() !== '' && <p className="git-detail-body">{detail.body}</p>}
      <p className="git-detail-meta">
        <span title={detail?.author_email}>{detail?.author ?? commit.author}</span>
        <span className="muted"> · {fmtDate(detail?.author_date ?? commit.date)}</span>
      </p>
      {showCommitter && detail && (
        <p className="git-detail-meta muted">
          Committed by <span title={detail.committer_email}>{detail.committer}</span> ·{' '}
          {fmtDate(detail.committer_date)}
        </p>
      )}
      <p className="git-detail-sha">
        <code className="git-sha-full">{commit.hash}</code>
        <CopyButton text={commit.hash} />
      </p>
      <p className="git-detail-parents">
        {commit.parents.length === 0 ? (
          <span className="muted">Root commit</span>
        ) : (
          <>
            <span className="muted">{commit.parents.length > 1 ? 'Parents' : 'Parent'}</span>
            {commit.parents.map((p) => (
              <button
                key={p}
                type="button"
                className="git-parent"
                aria-label={`Parent ${p.slice(0, 7)}`}
                disabled={missing.has(p) || hunting !== null}
                title={missing.has(p) ? 'Not loaded yet' : p}
                onClick={() => {
                  setHunting(p)
                  onSelectParent(p).then((ok) => {
                    if (!ok) setMissing((m) => new Set(m).add(p))
                    setHunting(null)
                  })
                }}
              >
                {hunting === p ? 'Loading…' : p.slice(0, 7)}
              </button>
            ))}
          </>
        )}
      </p>
      {commit.parents.length > 1 && (
        <p className="muted git-detail-note">
          Merge commit: changes shown against first parent {commit.parents[0].slice(0, 7)}
        </p>
      )}
      {filesError && <p className="error">{filesError}</p>}
      {!files && !filesError && <p className="muted">Loading…</p>}
      {files && files.length === 0 && <p className="muted">This commit changed no files.</p>}
      {files && files.length > 0 && totals && (
        <>
          <p className="muted git-detail-total">{totalsLabel(totals)}</p>
          <ul className="git-file-rows">
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className={`git-file-row${f.path === selectedPath ? ' selected' : ''}`}
                  aria-current={f.path === selectedPath ? 'true' : undefined}
                  onClick={() => onSelectPath(f.path)}
                >
                  <span className="badge git-status-badge" title={commitStatusLabel(f.status)}>
                    {f.status}
                  </span>
                  <span className="git-file-path">{commitFileLabel(f)}</span>
                  <span className="git-file-stat">
                    {f.added === null || f.deleted === null ? (
                      <span className="muted" title="Binary file">-</span>
                    ) : (
                      <>
                        <span className="git-stat-add">+{f.added}</span>{' '}
                        <span className="git-stat-del">−{f.deleted}</span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/**
 * The History sub-view: a lane-graph commit list (paged, newest first) beside a
 * detail panel over the selected file's diff. Desktop shows list | detail over
 * diff; at narrow widths (container query on `.git-history`, so a narrow Custom
 * pane counts) it drills down list -> detail -> diff, driven by `data-level`,
 * with the selection kept in component state — never the route.
 * Follows the tab's worktree/repo selection (mesa task 805); the empty-state
 * ladder mirrors ProjectGitView's, one level deeper (M9). "Current branch" is
 * the default; switching to All (or back) resets paging and selection.
 */
function HistoryPane({
  projectId,
  worktree,
  repo,
  branch,
}: {
  projectId: number
  worktree: string | null
  repo: string | undefined
  branch: string
}) {
  const [all, setAll] = useState(false)
  const phone = usePhoneTier()
  const { current, previous, loadMore, loadUntil, reload } = useCommitLog(
    projectId,
    worktree,
    repo,
    all,
  )
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null)
  const [selectedCommitPath, setSelectedCommitPath] = useState<string | null>(
    null,
  )
  // What the person is looking at while History is open (mesa task 888).
  // Reported from here rather than from `GitView` because the commit selection
  // lives here — and `GitView` mounts no publisher of its own in this mode, so
  // the two never talk over each other. A commit's subject line is its sayable
  // name; the sha is its identity.
  useLiveContext({
    kind: 'git',
    id: selectedCommit?.hash ?? null,
    label: selectedCommit?.subject ?? null,
    detail: selectedCommitPath,
  })

  // Same prevProject-during-render reset pattern as GitView itself: this
  // component is not remounted on project change (nor on a worktree switch)
  // while History mode stays open, so a stale commit selection from one scope
  // must not leak into the next.
  const scope = `${projectId} ${repo ?? ''} ${worktree ?? ''}`
  const [prevScope, setPrevScope] = useState(scope)
  if (scope !== prevScope) {
    setPrevScope(scope)
    setSelectedCommit(null)
    setSelectedCommitPath(null)
  }

  // Stable callbacks, so memoised rows do not re-render on every selection.
  const selectedHashRef = useRef<string | null>(null)
  useEffect(() => {
    selectedHashRef.current = selectedCommit?.hash ?? null
  })
  const onSelectRow = useCallback((c: GitCommit) => {
    if (c.hash === selectedHashRef.current) return
    setSelectedCommit(c)
    setSelectedCommitPath(null)
  }, [])
  const onLoadMore = useCallback(() => {
    loadMore()
  }, [loadMore])

  const setMode = (next: boolean) => {
    if (next === all) return
    setAll(next)
    setSelectedCommit(null)
    setSelectedCommitPath(null)
  }

  const state = current ?? previous
  if (state && state.path === null && state.commits === null && state.error === null) {
    return <NoLocalPathPlaceholder projectId={projectId} />
  }
  if (state && state.path !== null && state.commits === null && state.error === null) {
    return <NotARepoPlaceholder path={state.path} />
  }

  const toolbar = (
    <div className="git-history-toolbar">
      <div className="git-mode-toggle" role="group" aria-label="Branches shown">
        <button
          type="button"
          className={all ? '' : 'active'}
          aria-pressed={!all}
          onClick={() => setMode(false)}
        >
          Current branch
        </button>
        <button
          type="button"
          className={all ? 'active' : ''}
          aria-pressed={all}
          onClick={() => setMode(true)}
        >
          All branches
        </button>
      </div>
    </div>
  )

  const commits = state?.commits ?? null
  let body
  if (state && state.error !== null && commits === null) {
    body = (
      <div>
        <p className="error">{state.error}</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </div>
    )
  } else if (!state || commits === null) {
    body = <p className="muted">Loading…</p>
  } else if (commits.length === 0) {
    body = (
      <p className="muted">{all ? 'No commits yet.' : `No commits yet on ${branch}.`}</p>
    )
  } else {
    const level = selectedCommit === null ? 'list' : selectedCommitPath === null ? 'detail' : 'diff'
    body = (
      <div className="git-history-layout" data-level={level}>
        <CommitList
          commits={commits}
          selectedHash={selectedCommit?.hash ?? null}
          phone={phone}
          dim={current === null}
          hasMore={state.hasMore}
          loadingMore={state.loadingMore}
          moreError={state.moreError}
          onSelect={onSelectRow}
          onLoadMore={onLoadMore}
        />
        <div className="git-history-right">
          {selectedCommit === null ? (
            <div className="git-diff-pane git-history-empty">
              <p className="muted">Select a commit to see its details.</p>
            </div>
          ) : (
            <>
              <CommitDetail
                key={selectedCommit.hash}
                projectId={projectId}
                repo={repo}
                commit={selectedCommit}
                selectedPath={selectedCommitPath}
                onSelectPath={setSelectedCommitPath}
                onSelectParent={async (hash) => {
                  const found = await loadUntil(hash)
                  if (!found) return false
                  setSelectedCommit(found)
                  setSelectedCommitPath(null)
                  return true
                }}
                onBack={() => {
                  setSelectedCommit(null)
                  setSelectedCommitPath(null)
                }}
              />
              {selectedCommitPath !== null && (
                <button
                  type="button"
                  className="git-back git-back-narrow git-back-diff"
                  onClick={() => setSelectedCommitPath(null)}
                >
                  ← {selectedCommit.short_hash}
                </button>
              )}
              <div className="git-diff-pane git-history-diff">
                {selectedCommitPath !== null ? (
                  <CommitDiffPane
                    projectId={projectId}
                    repo={repo}
                    sha={selectedCommit.hash}
                    path={selectedCommitPath}
                  />
                ) : (
                  <p className="muted">Select a file to see its diff.</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="git-history">
      {toolbar}
      {body}
    </div>
  )
}

/** Short label for one worktree row: branch name, or the first 8 chars of
 * its HEAD sha when detached (same "short id stands in for a branch name"
 * convention as `parse_status`'s detached-HEAD branch field). */
function worktreeLabel(w: GitWorktree): string {
  return w.branch ?? w.head.slice(0, 8)
}

/**
 * Worktree selector: one row of chips, one per `git worktree list` entry,
 * highlighting whichever is active — the explicitly `selected` one, or (no
 * explicit selection yet) the repo's own `is_current` entry, i.e. the
 * worktree at the project's `local_path`. Hidden entirely when the repo has
 * only one worktree (the common case) — nothing to select between (S2-style
 * quiet default, mirrors the History toggle only mattering once there's
 * history to browse).
 */
function WorktreeList({
  worktrees,
  selected,
  onSelect,
}: {
  worktrees: GitWorktree[]
  selected: string | null
  onSelect: (path: string) => void
}) {
  if (worktrees.length <= 1) return null
  return (
    <div className="git-worktree-list">
      {worktrees.map((w) => {
        const active = selected === null ? w.is_current : w.path === selected
        return (
          <button
            key={w.path}
            type="button"
            className={active ? 'active' : ''}
            title={w.path}
            onClick={() => onSelect(w.path)}
          >
            {worktreeLabel(w)}
            {w.is_current && <span className="muted"> (current)</span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The GIT tab: working-tree status of the project's linked folder — branch +
 * ahead/behind header, changed/untracked file list on the left, the selected
 * file's diff on the right — plus a History sub-view (commit list → changed
 * files → diff) reachable via a toggle, without leaving the tab (M1/S2). A
 * worktree selector (`WorktreeList`) sits above both: picking a worktree
 * re-points the branch header, file list, and diff pane at that worktree's
 * directory instead of the project's own `local_path` (server-validated —
 * `getProjectGit`/`getProjectGitDiff`'s `worktree` param only ever accepts a
 * path from this same repo's own worktree list) — History included, since a
 * worktree's HEAD is its own and so is the history behind it (mesa task 805).
 * Rendered in place
 * inside ProjectTasksPage's frame. Read-only; refetches on
 * window focus (no poll — git state changes from terminal work outside the
 * app, and the server caches the status call for 5s anyway).
 */
function GitRepoPane({
  projectId,
  repo,
}: {
  projectId: number
  repo: string | undefined
}) {
  // null = no explicit pick yet, i.e. "whichever worktree is_current" (the
  // server's own default when `?worktree=` is omitted).
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(
    null,
  )
  const { data, error } = useFetch(
    () => getProjectGit(projectId, selectedWorktree ?? undefined, repo),
    `git-${projectId}-${repo ?? ''}-${selectedWorktree ?? ''}`,
  )
  // Selected path is component state, not URL (no deep-linking a file).
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // Working tree | History — default Working tree (today's behavior,
  // unchanged, S2). History mode is a small component that's only mounted
  // once selected, so its commit-log fetch is lazy for free.
  const [mode, setMode] = useState<'tree' | 'history'>('tree')
  // This component is not remounted when the route moves between projects
  // (App renders ProjectTasksPage at a stable position), so a stale selection
  // would carry project A's file into project B. Reset it when the project
  // changes — during render, off the changed prop.
  const [prevProject, setPrevProject] = useState(projectId)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setSelectedPath(null)
    setSelectedWorktree(null)
  }

  if (error && !data) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

  // Quiet empty states (M5) — data shapes, not errors.
  if (data.path === null) {
    return <NoLocalPathPlaceholder projectId={projectId} />
  }
  if (data.repo === null) {
    return <NotARepoPlaceholder path={data.path} />
  }

  const { status, files } = data.repo
  // Selection survives refetches by path; a file that left the list (e.g.
  // committed from a terminal) simply drops back to "select a file" instead
  // of fetching a diff the server would now 404.
  const selected =
    selectedPath !== null
      ? (files.find((f) => f.path === selectedPath) ?? null)
      : null
  // Header shows the directory `repo` actually reflects: the selected
  // worktree once one's picked, else the project's own local_path.
  const repoPath = selectedWorktree ?? data.path

  return (
    <div className="git-view">
      {/* The working tree's own focus (mesa task 888) — the selected file, said
          by name rather than by path. Mounted only in this mode: History has a
          publisher of its own, and a `null` from here would land on top of it. */}
      {mode === 'tree' && (
        <LiveFocus
          ctx={{
            kind: 'git',
            id: selected?.path ?? null,
            label: selected?.path.split('/').pop() ?? null,
            detail: null,
          }}
        />
      )}
      <p className="git-repo-header">
        <span className="git-branch">{status.branch}</span>
        {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
        {status.behind > 0 && (
          <span className="git-behind">↓{status.behind}</span>
        )}
        <span className="muted git-repo-path">{repoPath}</span>
      </p>

      {data.worktrees !== null && (
        <WorktreeList
          worktrees={data.worktrees}
          selected={selectedWorktree}
          onSelect={(path) => {
            setSelectedWorktree(path)
            setSelectedPath(null)
          }}
        />
      )}

      <div className="git-mode-toggle">
        <button
          type="button"
          className={mode === 'tree' ? 'active' : ''}
          onClick={() => setMode('tree')}
        >
          Working tree
        </button>
        <button
          type="button"
          className={mode === 'history' ? 'active' : ''}
          onClick={() => setMode('history')}
        >
          History
        </button>
      </div>

      {mode === 'history' ? (
        <HistoryPane
          projectId={projectId}
          worktree={selectedWorktree}
          repo={repo}
          branch={status.branch}
        />
      ) : files.length === 0 ? (
        <p className="muted">Working tree clean — no changed files.</p>
      ) : (
        <div className="git-layout">
          <ul className="card-list git-file-list">
            {files.map((f) => (
              <li
                key={f.path}
                className={f.path === selectedPath ? 'selected' : ''}
                onClick={() => setSelectedPath(f.path)}
              >
                <span className="badge git-status-badge">{f.status}</span>
                <span className="git-file-path">{fileLabel(f)}</span>
                <div className="muted git-file-label">{statusLabel(f.status)}</div>
              </li>
            ))}
          </ul>
          <div className="git-diff-pane">
            {selected !== null ? (
              <DiffPane
                projectId={projectId}
                path={selected.path}
                worktree={selectedWorktree}
                repo={repo}
              />
            ) : (
              <p className="muted">Select a file to see its diff.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Repo picker (mesa task 1509): a project folder may hold several checked-out
 * repos (or nest one inside another), discovered server-side. One chip per
 * repo — relative path plus branch — shown only when there is more than one;
 * a lone repo is selected silently and none is today's empty state (the pane
 * below explains it). The choice rides in the route's `?repo=` so a reload
 * keeps it (`gitRepos.ts` holds the rules).
 */
function RepoList({
  repos,
  selected,
  onSelect,
}: {
  repos: GitRepo[]
  selected: string | null
  onSelect: (path: string) => void
}) {
  return (
    <div className="git-worktree-list git-repo-list">
      {repos.map((r) => (
        <button
          key={r.path}
          type="button"
          className={r.path === selected ? 'active' : ''}
          title={r.path}
          onClick={() => onSelect(r.path)}
        >
          {repoLabel(r)}
        </button>
      ))}
    </div>
  )
}

/** The Git tab: repo picker over the selected repo's `GitRepoPane`. */
export function GitView({ projectId }: { projectId: number }) {
  const { data, error } = useFetch(
    () => getProjectGitRepos(projectId),
    `git-repos-${projectId}`,
  )
  // The pick, seeded from the route when it is this project's git route.
  // Component state after that — the hash is written, not re-read, so the tab
  // also works as a pane in the Custom layout, which has no git route.
  const readRoute = () =>
    window.location.hash.startsWith(`#/projects/${projectId}/git`)
      ? repoFromHash(window.location.hash)
      : null
  const [requested, setRequested] = useState<string | null>(readRoute)
  const [prevProject, setPrevProject] = useState(projectId)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setRequested(readRoute())
  }
  // Back/Forward or a re-click of the tab rewrites the hash without
  // remounting; follow it while this is the routed view (a Custom pane has no
  // git route and keeps its local pick).
  useEffect(() => {
    const onChange = () => {
      if (window.location.hash.startsWith(`#/projects/${projectId}/git`)) {
        setRequested(repoFromHash(window.location.hash))
      }
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [projectId])

  if (error && !data) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

  const selected = effectiveRepo(data.repos, requested)
  const pick = (path: string) => {
    setRequested(path)
    if (window.location.hash.startsWith(`#/projects/${projectId}/git`)) {
      window.location.hash = hashWithRepo(window.location.hash, path)
    }
  }
  return (
    <>
      {showRepoPicker(data.repos) && (
        <RepoList repos={data.repos} selected={selected} onSelect={pick} />
      )}
      <GitRepoPane
        key={selected ?? ''}
        projectId={projectId}
        repo={repoParam(selected)}
      />
    </>
  )
}
