import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from 'react'
import {
  getProjectGit,
  getProjectGitCommit,
  getProjectGitCommitDiff,
  getProjectGitCommitFiles,
  getProjectGitRepos,
} from '../api'
import type { GitCommit } from '../types/GitCommit'
import type { GitCommitFile } from '../types/GitCommitFile'
import type { GitRepo } from '../types/GitRepo'
import type { GitBranch } from '../types/GitBranch'
import type { GitStash } from '../types/GitStash'
import { useLiveContext } from '../liveContext'
import { LiveFocus } from './LiveFocus'
import { useFetch } from '../useFetch'
import { DiffView } from '../components/DiffView'
import { CommitList } from '../components/CommitGraph'
import { GitSidePanel } from '../components/GitSidePanel'
import { GitWorkingTree } from '../components/GitWorkingTree'
import { useGitSide } from '../useGitSide'
import { activeWorktreePath } from '../gitPanel'
import type { BranchScope } from '../gitPanel'
import { statTotals, subjectOrPlaceholder, totalsLabel } from '../gitHistory'
import { usePhoneTier } from '../phoneTier'
import { useCommitLog } from '../useCommitLog'
import { shouldIgnoreShortcut } from '../keyboardScope'
import {
  GIT_KEYS,
  NO_FILTERS,
  filterByPath,
  filterChips,
  filtersKey,
  findByShaPrefix,
  gitKeyAction,
  hasFilters,
  isShaLike,
  normalizeFilters,
  resultLabel,
  stepIndex,
  validPathFilter,
} from '../gitSearch'
import type { FilterField, LogFilters } from '../gitSearch'
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

/** Per-commit status label: a single name-status token (`A`/`M`/`D`/`T`/`U`/
 * `X`, or `R100`/`C100` with a similarity score) — a commit has no staged/
 * unstaged distinction, so this is a small sibling of statusLabel, not a
 * call to it verbatim. */
function commitStatusLabel(status: string): string {
  const word = STATUS_WORDS[status[0]]
  return word ?? status
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
  focusFilesRef,
}: {
  projectId: number
  repo: string | undefined
  commit: GitCommit
  selectedPath: string | null
  onSelectPath: (path: string) => void
  onSelectParent: (hash: string) => Promise<boolean>
  onBack: () => void
  /** Set when Enter opened this commit: focus the first file once the list loads. */
  focusFilesRef: MutableRefObject<boolean>
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
  const [fileQuery, setFileQuery] = useState('')
  const sectionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if ((!files && !filesError) || !focusFilesRef.current) return
    focusFilesRef.current = false
    const first = sectionRef.current?.querySelector<HTMLElement>('[data-git-item]')
    ;(first ?? sectionRef.current)?.focus()
  }, [files, filesError, focusFilesRef])
  const subject = subjectOrPlaceholder(commit.subject)
  const totals = files ? statTotals(files) : null
  const showCommitter =
    detail !== null &&
    (detail.committer !== detail.author ||
      detail.committer_email !== detail.author_email ||
      detail.committer_date !== detail.author_date)

  return (
    <section
      className="git-commit-detail"
      role="region"
      aria-label="Commit details"
      ref={sectionRef}
      tabIndex={-1}
    >
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
          {files.length > 1 && (
            <FileFilter
              value={fileQuery}
              onChange={setFileQuery}
              list="files"
              label="Filter this commit's files"
            />
          )}
          {filterByPath(files, fileQuery).length === 0 && (
            <p className="muted">No files match.</p>
          )}
          <ul className="git-file-rows" data-git-list="files">
            {filterByPath(files, fileQuery).map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className={`git-file-row${f.path === selectedPath ? ' selected' : ''}`}
                  aria-current={f.path === selectedPath ? 'true' : undefined}
                  data-git-item=""
                  data-path={f.path}
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

/** A client-side path filter over one file list (`list` names the
 * `data-git-list` that Escape / ↓ hand focus to). */
function FileFilter({
  value,
  onChange,
  list,
  label,
  search,
}: {
  value: string
  onChange: (v: string) => void
  list: 'tree' | 'files'
  label: string
  /** The box `/` focuses. */
  search?: boolean
}) {
  return (
    <input
      type="search"
      className="git-filter-input git-file-filter"
      placeholder="Filter files"
      aria-label={label}
      value={value}
      data-git-for={list}
      data-git-search={search ? '' : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** Focus the selected item of `list` inside `root`, else its first. */
function focusList(root: HTMLElement | null, list: string): boolean {
  const el = root?.querySelector(`[data-git-list="${list}"]`)
  const item =
    el?.querySelector<HTMLElement>('[data-git-item][aria-current="true"]') ??
    el?.querySelector<HTMLElement>('[data-git-item]')
  if (!item) return false
  item.focus()
  item.scrollIntoView({ block: 'nearest' })
  return true
}

/** The History search: message box, the other filters behind "Filters",
 * removable chips for what is active, and "Go to commit". */
function HistoryFilterBar({
  draft,
  pathOk,
  setField,
  applyNow,
  clearAll,
  onJump,
}: {
  draft: LogFilters
  pathOk: boolean
  setField: (field: FilterField, value: string) => void
  applyNow: () => void
  clearAll: () => void
  onJump: (sha: string) => Promise<string | null>
}) {
  const extraActive = filterChips({ ...draft, q: '' }).length
  const [open, setOpen] = useState(extraActive > 0)
  const [jump, setJump] = useState('')
  const [jumpError, setJumpError] = useState<string | null>(null)
  const [jumping, setJumping] = useState(false)
  const chips = filterChips(draft)
  const onEnter = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') applyNow()
  }
  const go = () => {
    const sha = jump.trim()
    if (!isShaLike(sha)) {
      setJumpError('A commit id is 7 to 64 hex characters.')
      return
    }
    setJumping(true)
    onJump(sha).then((err) => {
      setJumping(false)
      setJumpError(err)
    })
  }
  return (
    <div className="git-search">
      <div className="git-search-row">
        <input
          type="search"
          className="git-filter-input git-search-input"
          placeholder="Search commit messages"
          aria-label="Search commit messages"
          value={draft.q}
          data-git-search=""
          data-git-for="commits"
          onChange={(e) => setField('q', e.target.value)}
          onKeyDown={onEnter}
        />
        <button
          type="button"
          className={`git-search-more${open ? ' active' : ''}`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Filters{extraActive > 0 ? ` (${extraActive})` : ''}
        </button>
      </div>
      {open && (
        <div className="git-search-fields">
          <label>
            <span className="muted">Author</span>
            <input
              type="search"
              className="git-filter-input"
              placeholder="Name or email"
              value={draft.author}
              data-git-for="commits"
              onChange={(e) => setField('author', e.target.value)}
              onKeyDown={onEnter}
            />
          </label>
          <label>
            <span className="muted">Path</span>
            <input
              type="search"
              className="git-filter-input"
              placeholder="File or folder"
              title="Commits that touched this file or folder. Renames are not followed: a renamed file's older commits are under its old path."
              value={draft.path}
              data-git-for="commits"
              onChange={(e) => setField('path', e.target.value)}
              onKeyDown={onEnter}
            />
          </label>
          <label>
            <span className="muted">Since</span>
            <input
              type="date"
              className="git-filter-input"
              value={draft.since}
              data-git-for="commits"
              onChange={(e) => setField('since', e.target.value)}
            />
          </label>
          <label>
            <span className="muted">Until</span>
            <input
              type="date"
              className="git-filter-input"
              value={draft.until}
              data-git-for="commits"
              onChange={(e) => setField('until', e.target.value)}
            />
          </label>
          <label>
            <span className="muted">Go to commit</span>
            <input
              type="search"
              className="git-filter-input git-jump-input"
              placeholder="Full or short sha"
              value={jump}
              data-git-for="commits"
              onChange={(e) => {
                setJump(e.target.value)
                setJumpError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go()
              }}
            />
          </label>
          <button type="button" className="git-jump-go" disabled={jumping} onClick={go}>
            {jumping ? 'Looking…' : 'Go'}
          </button>
          <p className="muted git-search-note">
            Text matches are literal and ignore case. A path filter does not follow renames.
          </p>
          {!pathOk && (
            <p className="error git-search-note">
              A path is relative to the repo, without &apos;..&apos;.
            </p>
          )}
          {jumpError !== null && <p className="error git-search-note">{jumpError}</p>}
        </div>
      )}
      {chips.length > 0 && (
        <div className="git-filter-chips" aria-label="Active filters">
          {chips.map((c) => (
            <button
              key={c.field}
              type="button"
              className="git-filter-chip"
              aria-label={`Remove filter ${c.label}`}
              title="Remove this filter"
              onClick={() => setField(c.field, '')}
            >
              <span>{c.label}</span> <span aria-hidden="true">×</span>
            </button>
          ))}
          {chips.length > 1 && (
            <button type="button" className="git-filter-clear" onClick={clearAll}>
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
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
  branchScope,
  onClearBranchScope,
  openRequest,
  onRequestConsumed,
  backRef,
}: {
  projectId: number
  worktree: string | null
  repo: string | undefined
  branch: string
  /** A branch picked in the side panel: its log, instead of HEAD / all. */
  branchScope: BranchScope | null
  onClearBranchScope: () => void
  /** A commit the side panel asks to open (a stash); `nonce` makes a repeat count. */
  openRequest: { sha: string; nonce: number } | null
  /** The request was taken up: the owner drops it, so a remount cannot replay it. */
  onRequestConsumed: () => void
  /** Where the tab's key handler finds this pane's "back a level". */
  backRef: MutableRefObject<((from: HTMLElement) => boolean) | null>
}) {
  const [all, setAll] = useState(false)
  const phone = usePhoneTier()
  // Filters as typed, and as last sent (300 ms after typing stops, or on Enter).
  const [draft, setDraft] = useState<LogFilters>(NO_FILTERS)
  const [applied, setApplied] = useState<LogFilters>(NO_FILTERS)
  const pathOk = validPathFilter(draft.path)
  useEffect(() => {
    if (filtersKey(draft) === filtersKey(applied) || !validPathFilter(draft.path)) return
    const t = setTimeout(() => setApplied(normalizeFilters(draft)), 300)
    return () => clearTimeout(t)
  }, [draft, applied])
  const setField = (field: FilterField, value: string) => {
    const next = { ...draft, [field]: value }
    setDraft(next)
    // Removing a filter (a chip, or a cleared box) applies at once.
    if (value === '') setApplied(normalizeFilters(next))
  }
  const applyNow = () => {
    if (pathOk && filtersKey(draft) !== filtersKey(applied)) setApplied(normalizeFilters(draft))
  }
  const clearAll = () => {
    setDraft(NO_FILTERS)
    setApplied(NO_FILTERS)
  }
  const { current, previous, loadMore, loadUntil, reload } = useCommitLog(
    projectId,
    worktree,
    repo,
    all,
    applied,
    branchScope,
  )
  const rootRef = useRef<HTMLDivElement>(null)
  // Enter opened a commit: its detail focuses its first file once loaded.
  const focusFilesRef = useRef(false)
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
  const [requestError, setRequestError] = useState<string | null>(null)
  const jumpSeq = useRef(0)
  const scope = `${projectId} ${repo ?? ''} ${worktree ?? ''} ${branchScope?.kind ?? ''} ${branchScope?.name ?? ''}`
  const [prevScope, setPrevScope] = useState(scope)
  if (scope !== prevScope) {
    setPrevScope(scope)
    setRequestError(null)
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

  // Back a level from where focus is: diff -> its file, detail -> its commit.
  useEffect(() => {
    backRef.current = (from) => {
      const root = rootRef.current
      if (!root || selectedCommit === null) return false
      if (from.closest('[data-git-diff]') && selectedCommitPath !== null) {
        const path = selectedCommitPath
        setSelectedCommitPath(null)
        setTimeout(() => {
          const row = root.querySelector<HTMLElement>(
            `[data-git-list="files"] [data-path="${CSS.escape(path)}"]`,
          )
          ;(row ?? root.querySelector<HTMLElement>('.git-commit-detail'))?.focus()
        }, 0)
        return true
      }
      if (from.closest('.git-commit-detail, [data-git-diff]')) {
        const hash = selectedCommit.hash
        setSelectedCommit(null)
        setSelectedCommitPath(null)
        setTimeout(() => {
          const row = root.querySelector<HTMLElement>(`[data-hash="${CSS.escape(hash)}"]`)
          if (row) {
            row.focus()
            row.scrollIntoView({ block: 'nearest' })
          } else focusList(root, 'commits')
        }, 0)
        return true
      }
      return false
    }
  })

  const state = current ?? previous

  // Go to commit: a loaded row by unique prefix, else ask the server (any
  // commit in the repo, loaded or not). Null on success, else what to say.
  const onJump = async (sha: string): Promise<string | null> => {
    // A later jump supersedes this one: a late reply for the older sha is dropped.
    const mine = ++jumpSeq.current
    const open = (c: GitCommit) => {
      setSelectedCommit(c)
      setSelectedCommitPath(null)
      focusFilesRef.current = true
      setTimeout(() => {
        rootRef.current
          ?.querySelector(`[data-hash="${CSS.escape(c.hash)}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      }, 0)
    }
    const loaded = findByShaPrefix(state?.commits ?? [], sha)
    if (loaded) {
      open(loaded)
      return null
    }
    try {
      const d = await getProjectGitCommit(projectId, sha, repo)
      if (mine !== jumpSeq.current) return null
      const fromList = state?.commits?.find((c) => c.hash === d.hash)
      open(
        fromList ?? {
          hash: d.hash,
          short_hash: d.short_hash,
          author: d.author,
          date: d.author_date,
          subject: d.subject,
          parents: d.parents,
          refs: [],
        },
      )
      return null
    } catch {
      return mine === jumpSeq.current ? `No commit ${sha} in this repo.` : null
    }
  }

  // The side panel asked for a commit that is not in the list (a stash).
  const onJumpRef = useRef(onJump)
  useEffect(() => {
    onJumpRef.current = onJump
  })
  useEffect(() => {
    if (openRequest === null) return
    onRequestConsumed()
    void onJumpRef.current(openRequest.sha).then(setRequestError)
  }, [openRequest, onRequestConsumed])

  const setMode = (next: boolean) => {
    if (branchScope !== null) {
      // Either switch leaves the branch scope.
      onClearBranchScope()
      setAll(next)
      setSelectedCommit(null)
      setSelectedCommitPath(null)
      return
    }
    if (next === all) return
    setAll(next)
    setSelectedCommit(null)
    setSelectedCommitPath(null)
  }

  if (state && state.path === null && state.commits === null && state.error === null) {
    return <NoLocalPathPlaceholder projectId={projectId} />
  }
  if (state && state.path !== null && state.commits === null && state.error === null) {
    return <NotARepoPlaceholder path={state.path} />
  }

  const filtered = hasFilters(applied)
  const toolbar = (
    <div className="git-history-toolbar">
      <HistoryFilterBar
        draft={draft}
        pathOk={pathOk}
        setField={setField}
        applyNow={applyNow}
        clearAll={clearAll}
        onJump={onJump}
      />
      <div className="git-mode-toggle" role="group" aria-label="Branches shown">
        <button
          type="button"
          className={all || branchScope !== null ? '' : 'active'}
          aria-pressed={!all && branchScope === null}
          onClick={() => setMode(false)}
        >
          Current branch
        </button>
        <button
          type="button"
          className={all && branchScope === null ? 'active' : ''}
          aria-pressed={all && branchScope === null}
          onClick={() => setMode(true)}
        >
          All branches
        </button>
        {branchScope !== null && (
          <button
            type="button"
            className="git-filter-chip git-branch-chip"
            aria-label={`Remove branch scope ${branchScope.name}`}
            title="Remove branch scope"
            onClick={() => {
              onClearBranchScope()
              setSelectedCommit(null)
              setSelectedCommitPath(null)
            }}
          >
            <span>branch: {branchScope.name}</span> <span aria-hidden="true">×</span>
          </button>
        )}
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
  } else if (commits.length === 0 && filtered && current !== null && selectedCommit === null) {
    body = (
      <div className="git-history-empty-search">
        <p className="muted">
          {current.timedOut
            ? resultLabel(0, false, true)
            : 'No commits match these filters.'}
        </p>
        <button type="button" onClick={clearAll}>
          Clear filters
        </button>
      </div>
    )
  } else if (commits.length === 0 && !filtered) {
    body = (
      <p className="muted">
        {branchScope !== null
          ? `No commits on ${branchScope.name}.`
          : all
            ? 'No commits yet.'
            : `No commits yet on ${branch}.`}
      </p>
    )
  } else {
    const level = selectedCommit === null ? 'list' : selectedCommitPath === null ? 'detail' : 'diff'
    body = (
      <div className="git-history-layout" data-level={level}>
        {commits.length === 0 ? (
          <div className="git-graph-list">
            <p className="muted">No commits match these filters.</p>
          </div>
        ) : (
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
          unlinked={filtered}
        />
        )}
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
                focusFilesRef={focusFilesRef}
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
              <div
                className="git-diff-pane git-history-diff"
                tabIndex={0}
                data-git-diff="commit"
                aria-label="Diff"
              >
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

  const shown = current ?? null
  return (
    <div
      className="git-history"
      ref={rootRef}
      onKeyDown={(e) => {
        // Enter on a commit row opens it (the tab root clicks it); then its
        // first file takes focus, so the keyboard can keep going.
        if (e.key !== 'Enter' || shouldIgnoreShortcut(e.nativeEvent)) return
        const row = (e.target as HTMLElement).closest('[data-git-list="commits"] [data-git-item]')
        if (!row) return
        focusFilesRef.current = true
        if (row.getAttribute('aria-current') === 'true') {
          // Already open: nothing reloads, so focus now.
          setTimeout(() => {
            focusList(rootRef.current, 'files')
            focusFilesRef.current = false
          }, 0)
        }
      }}
    >
      {toolbar}
      {requestError !== null && <p className="error git-search-note">{requestError}</p>}
      {shown && (filtered || shown.timedOut) && shown.commits !== null && shown.commits.length > 0 && (
        <p className="muted git-search-count" role="status">
          {resultLabel(shown.commits.length, shown.hasMore, shown.timedOut)}
        </p>
      )}
      {body}
    </div>
  )
}

/**
 * The GIT tab: working-tree status of the project's linked folder — branch +
 * ahead/behind header, changed/untracked file list on the left, the selected
 * file's diff on the right — plus a History sub-view (commit list → changed
 * files → diff) reachable via a toggle, without leaving the tab (M1/S2). A
 * side panel (`GitSidePanel`, task 2737) lists worktrees, branches and
 * stashes beside both: picking a worktree
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
  const { data, error, refetch } = useFetch(
    () => getProjectGit(projectId, selectedWorktree ?? undefined, repo),
    `git-${projectId}-${repo ?? ''}-${selectedWorktree ?? ''}`,
  )
  // The last view that loaded. A worktree switch changes the fetch key and
  // `data` goes null while the new one loads; the shell and the side panel
  // stay mounted on this (their filter text, groups and scroll must not
  // reset) and only the content area shows its loading state.
  const [lastView, setLastView] = useState<typeof data>(null)
  if (data !== null && data !== lastView) setLastView(data)
  // The working tree's open file (reported by GitWorkingTree, which owns the
  // selection) — only the live focus reads it. Component state, not URL.
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const treeBack = useRef<(() => boolean) | null>(null)
  // Working tree | History — default Working tree (today's behavior,
  // unchanged, S2). History mode is a small component that's only mounted
  // once selected, so its commit-log fetch is lazy for free.
  const [mode, setMode] = useState<'tree' | 'history'>('tree')
  // This component is not remounted when the route moves between projects
  // (App renders ProjectTasksPage at a stable position), so a stale selection
  // would carry project A's file into project B. Reset it when the project
  // changes — during render, off the changed prop.
  const [prevProject, setPrevProject] = useState(projectId)
  // A branch picked in the side panel scopes History; it clears with the
  // worktree (and the repo, which remounts this component).
  const [branchScope, setBranchScope] = useState<BranchScope | null>(null)
  // A stash the panel asked History to open; `nonce` lets a repeat count.
  const [openRequest, setOpenRequest] = useState<{ sha: string; nonce: number } | null>(null)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setSelectedPath(null)
    setSelectedWorktree(null)
    setBranchScope(null)
    setOpenRequest(null)
    setLastView(null)
  }
  const onRequestConsumed = useCallback(() => setOpenRequest(null), [])
  const { shellRef, inline: sideInline, open: sideOpen, toggle: toggleSide, closeDrawer } = useGitSide()
  const contentRef = useRef<HTMLDivElement>(null)
  const refsButtonRef = useRef<HTMLButtonElement>(null)
  const [treeQuery, setTreeQuery] = useState('')
  const [showKeys, setShowKeys] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const historyBack = useRef<((from: HTMLElement) => boolean) | null>(null)
  // Closing the drawer unmounts the focused row: keep keyboard focus alive on
  // the Refs button, and put it on the panel when the drawer opens.
  const closeAndFocus = () => {
    closeDrawer()
    if (!sideInline) refsButtonRef.current?.focus()
  }
  useEffect(() => {
    if (sideInline || !sideOpen) return
    rootRef.current?.querySelector<HTMLElement>('#git-side .git-side-head')?.focus()
  }, [sideInline, sideOpen])

  /**
   * The tab's keys (docs/git-tab.md "Keyboard"). Bound on the tab's own root,
   * so they only fire while focus is inside it — a Custom-layout pane without
   * focus never sees them. A handled key stops here, so the global spatial
   * nav (also j/k and arrows) does not move focus as well; an unhandled one
   * (Left on a top-level list, a key with no list focused) goes on to it.
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current
    const t = e.target as HTMLElement
    if (!root || e.defaultPrevented) return
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (t.closest('input, textarea, select, [contenteditable]')) {
      // Typing wins; Escape or ↓ leaves a Git filter box for its list.
      const box = t.closest<HTMLElement>('.git-filter-input')
      if (!box || (e.key !== 'Escape' && e.key !== 'ArrowDown')) return
      if (box.getAttribute('type') === 'date') return
      if (focusList(root, box.dataset.gitFor ?? '')) handled()
      return
    }
    if (shouldIgnoreShortcut(e.nativeEvent)) return
    if (e.key === 'Enter') {
      // Enter opens the focused row through its own click (explicitly, not
      // the button's default activation); a file then hands focus to its diff.
      const item = t.closest<HTMLElement>('[data-git-list] [data-git-item]')
      if (!item) return
      handled()
      item.click()
      // A commit row or a side-panel row does not hand focus to a diff.
      if (!item.closest('[data-git-list="commits"], .git-side') && !item.hasAttribute('data-wt-head')) {
        setTimeout(() => root.querySelector<HTMLElement>('[data-git-diff]')?.focus(), 0)
      }
      return
    }
    const action = gitKeyAction(e.key)
    if (action === null) return
    if (showKeys && e.key === 'Escape') {
      setShowKeys(false)
      root.querySelector<HTMLElement>('.git-keys-button')?.focus()
      return handled()
    }
    if (e.key === 'Escape' && t.closest('.git-side')) {
      // Esc in the refs panel: back to the content (a drawer closes).
      if (sideInline) contentRef.current?.focus()
      else closeAndFocus()
      return handled()
    }
    switch (action) {
      case 'help':
        setShowKeys((v) => !v)
        return handled()
      case 'search': {
        const box = root.querySelector<HTMLInputElement>('[data-git-search]')
        if (!box) return
        box.focus()
        box.select()
        return handled()
      }
      case 'down':
      case 'up': {
        const dir = action === 'down' ? 1 : -1
        const diff = t.closest<HTMLElement>('[data-git-diff]')
        if (diff) {
          diff.scrollBy({ top: dir * 48 })
          return handled()
        }
        const list = t.closest('[data-git-list]')
        if (!list) return
        const items = Array.from(list.querySelectorAll<HTMLElement>('[data-git-item]'))
        const at = items.indexOf(t.closest<HTMLElement>('[data-git-item]') as HTMLElement)
        const next = items[stepIndex(at, items.length, dir)]
        if (next) {
          next.focus()
          next.scrollIntoView({ block: 'nearest' })
        }
        return handled()
      }
      case 'prevFile':
      case 'nextFile': {
        if (t.closest('.git-side')) return
        const list = root.querySelector('[data-git-list="tree"], [data-git-list="files"]')
        if (!list) return
        // Section and folder headers are items for j/k but not files.
        const items = Array.from(
          list.querySelectorAll<HTMLElement>('[data-git-item]:not([data-wt-head])'),
        )
        const at = items.findIndex((el) => el.getAttribute('aria-current') === 'true')
        const next = items[stepIndex(at, items.length, action === 'nextFile' ? 1 : -1)]
        if (next && items.indexOf(next) !== at) {
          const inList = list.contains(t)
          next.click()
          next.scrollIntoView({ block: 'nearest' })
          if (inList) {
            // A narrow layout drills down to the diff and hides the list.
            setTimeout(() => {
              if (next.isConnected && next.offsetParent !== null) next.focus()
              else root.querySelector<HTMLElement>('[data-git-diff]')?.focus()
            }, 0)
          }
        }
        return handled()
      }
      case 'back': {
        // In a diff only Esc goes back; ← is left to the page.
        if (e.key === 'ArrowLeft' && t.closest('[data-git-diff]')) return
        if (historyBack.current?.(t)) return handled()
        if (mode === 'tree' && t.closest('[data-git-diff]') && treeBack.current?.()) {
          return handled()
        }
        return
      }
    }
  }

  const view = data ?? lastView
  if (error && !view) return <p className="error">{error}</p>
  if (!view) return <p className="muted">Loading…</p>

  // Quiet empty states (M5) — data shapes, not errors.
  if (view.path === null) {
    return <NoLocalPathPlaceholder projectId={projectId} />
  }
  if (view.repo === null) {
    return <NotARepoPlaceholder path={view.path} />
  }

  // `fresh` = this worktree's own view has loaded; otherwise `view` is the
  // previous worktree's, good only for the shell and the panel.
  const fresh = data !== null
  const { status, files } = view.repo
  // The explicit path of the worktree this view is for: the picked one, else
  // the one at the repo. Null (no worktree list) turns the write controls off.
  const worktreePath = activeWorktreePath(view.worktrees ?? [], selectedWorktree)
  // Header shows the directory `repo` actually reflects.
  const repoPath = worktreePath ?? selectedWorktree ?? view.path

  return (
    <div className="git-view" ref={rootRef} onKeyDown={onKeyDown}>
      {/* The working tree's own focus (mesa task 888) — the selected file, said
          by name rather than by path. Mounted only in this mode: History has a
          publisher of its own, and a `null` from here would land on top of it. */}
      {mode === 'tree' && (
        <LiveFocus
          ctx={{
            kind: 'git',
            id: selectedPath,
            label: selectedPath?.split('/').pop() ?? null,
            detail: null,
          }}
        />
      )}
      {!(mode === 'tree' && fresh) && (
      <p className="git-repo-header">
        {fresh && (
          <>
            <span className="git-branch">{status.branch}</span>
            {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
          </>
        )}
        <span className="muted git-repo-path">{repoPath}</span>
      </p>
      )}

      <div
        className={`git-shell ${sideInline ? 'git-shell-inline' : 'git-shell-drawer'}${sideOpen ? ' side-open' : ''}`}
        ref={shellRef}
      >
      {sideOpen && !sideInline && (
        <div className="git-side-scrim" onClick={closeAndFocus} aria-hidden="true" />
      )}
      {(sideOpen || sideInline) && (
        <GitSidePanel
          hidden={!sideOpen}
          projectId={projectId}
          repo={repo}
          worktrees={view.worktrees}
          selectedWorktree={selectedWorktree}
          scope={branchScope}
          onPickWorktree={(path) => {
            // Only an actual change resets the selection and the branch scope.
            if (path !== activeWorktreePath(view.worktrees ?? [], selectedWorktree)) {
              setSelectedWorktree(path)
              setSelectedPath(null)
              setBranchScope(null)
            }
            closeAndFocus()
          }}
          onPickBranch={(b: GitBranch) => {
            setBranchScope({ name: b.name, kind: b.kind })
            setMode('history')
            closeAndFocus()
          }}
          onPickStash={(st: GitStash) => {
            setMode('history')
            setOpenRequest((r) => ({ sha: st.hash, nonce: (r?.nonce ?? 0) + 1 }))
            closeAndFocus()
          }}
        />
      )}
      <div className="git-content" ref={contentRef} tabIndex={-1}>
      <div className="git-mode-row">
        <button
          type="button"
          className={`git-refs-button${sideOpen ? ' active' : ''}`}
          ref={refsButtonRef}
          aria-expanded={sideOpen}
          aria-controls="git-side"
          title="Worktrees, branches and stashes"
          onClick={toggleSide}
        >
          Refs
        </button>
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
        <div className="git-keys">
          <button
            type="button"
            className="git-keys-button"
            aria-label="Keyboard shortcuts"
            aria-expanded={showKeys}
            title="Keyboard shortcuts (?)"
            onClick={() => setShowKeys((v) => !v)}
          >
            ?
          </button>
          {showKeys && (
            <div className="git-keys-pop" role="dialog" aria-label="Git tab keys">
              <table>
                <tbody>
                  {GIT_KEYS.map(([k, what]) => (
                    <tr key={k}>
                      <th scope="row">
                        <kbd>{k}</kbd>
                      </th>
                      <td>{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">Keys work while focus is inside the Git tab, not while typing.</p>
            </div>
          )}
        </div>
      </div>

      {mode === 'history' ? (
        <HistoryPane
          projectId={projectId}
          worktree={selectedWorktree}
          repo={repo}
          branch={status.branch}
          branchScope={branchScope}
          onClearBranchScope={() => setBranchScope(null)}
          openRequest={openRequest}
          onRequestConsumed={onRequestConsumed}
          backRef={historyBack}
        />
      ) : !fresh ? (
        error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>
      ) : (
        <GitWorkingTree
          projectId={projectId}
          repo={repo}
          repoView={view.repo}
          branch={status.branch}
          ahead={status.ahead}
          behind={status.behind}
          worktreePath={worktreePath}
          diffWorktree={selectedWorktree}
          query={treeQuery}
          toolbarStart={
            files.length > 1 ? (
              <FileFilter
                value={treeQuery}
                onChange={setTreeQuery}
                list="tree"
                label="Filter changed files"
                search
              />
            ) : null
          }
          refetch={refetch}
          onSelectedPath={setSelectedPath}
          onOpenCommit={(sha) => {
            setMode('history')
            setOpenRequest((r) => ({ sha, nonce: (r?.nonce ?? 0) + 1 }))
          }}
          backRef={treeBack}
        />
      )}
      </div>
      </div>
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
