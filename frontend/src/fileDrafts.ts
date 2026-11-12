// Where the Files tab's per-file state waits while the tab is not on screen
// (naru task 2743).
//
// `FilesView` owns that state for as long as it is mounted, and it is
// unmounted by any other project tab. With every file opening straight into
// the editor, an unsaved draft is the ordinary state of an open tab rather
// than a mode someone entered, so dropping it on a click on "Tasks" would be
// losing work with no prompt — and there is nowhere to put a prompt, since the
// route has already moved by the time the component can know. Keeping the
// state for the page's lifetime needs no prompt at all.
//
// In memory only, never localStorage: an unsaved draft surviving a browser
// restart is a different, riskier feature (`openFiles.ts`). Keyed by project,
// because the paths inside are relative to one — the same `src/main.rs` in two
// projects must never inherit the other's text.
//
// The page-unload warning lives here for the same reason the drafts do: a
// reload while the Files tab is not mounted loses them just the same.

import { dirtyPaths, type DraftState } from './fileDirty'

const stash = new Map<number, ReadonlyMap<string, DraftState>>()
let armed = false

function onBeforeUnload(e: BeforeUnloadEvent) {
  // The browser writes the prompt; a page-supplied string has been ignored
  // for years. `preventDefault` is the whole API that is left.
  e.preventDefault()
}

/**
 * Record a project's per-file state, replacing what was held for it, and keep
 * the `beforeunload` warning armed exactly while any project holds a dirty
 * draft. Armed by adding the listener and disarmed by removing it, never by a
 * flag inside a permanent one: a clean page has no listener at all (a
 * registered `beforeunload` also disables the back/forward cache).
 */
export function stashDrafts(
  projectId: number,
  fileUi: ReadonlyMap<string, DraftState>,
): void {
  if (fileUi.size === 0) stash.delete(projectId)
  else stash.set(projectId, fileUi)
  const dirty = [...stash.values()].some((held) => dirtyPaths(held).size > 0)
  if (dirty === armed) return
  armed = dirty
  if (dirty) window.addEventListener('beforeunload', onBeforeUnload)
  else window.removeEventListener('beforeunload', onBeforeUnload)
}

/**
 * The state held for a project, for the paths still open in it. `T` is the
 * caller's own state type: this module stores what it is handed and reads only
 * the `DraftState` part, so what comes back is what went in.
 */
export function stashedDrafts<T extends DraftState>(
  projectId: number,
  open: Iterable<string>,
): Map<string, T> {
  const held = stash.get(projectId) as ReadonlyMap<string, T> | undefined
  const out = new Map<string, T>()
  if (held === undefined) return out
  for (const path of open) {
    const ui = held.get(path)
    if (ui !== undefined) out.set(path, ui)
  }
  return out
}
