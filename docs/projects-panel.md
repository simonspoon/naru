# Projects panel (naru task 2808)

A dock panel (`projects`, label **Projects**) listing only projects, as the
indented parent / sub-project tree, each row with four task counts. It sits
beside the left nav and the palette and replaces neither. Starts closed in
every preset; open it from the header `⋯` menu, or the palette's **Projects**
row (`#/projects`, a verb like `#/agent-watcher`: docked it reveals the panel
and puts the hash back; on the phone tier it is a page).

## A row

- The name, then **Back / Queue / Run / Done**: the project's tasks in
  `backlog`, `todo`, `in_progress` and `done` (subtasks included; cancelled
  not shown). Zeros are faded.
- **Long names** wrap to two lines (then an ellipsis); the indent is 0.9rem a
  level and the narrow count columns 2.1rem, so the name keeps its room. A name
  still clipped shows in full in a tooltip (`projects-panel-tip`, fixed so the
  row's overflow can't clip it) on hover and on keyboard focus; one that fits
  shows none (naru task 2809).
- **Counts on parents.** An open parent shows only its own counts (its
  children are on screen with theirs). A collapsed parent shows its own plus
  every descendant the panel lists, in italics, so collapsing never hides
  work. A hidden archived child adds nothing.
- **Running**: an amber pulse and dot when the shown `in_progress` count is
  above zero (for a collapsed parent, anything running under it).
- **Needs you**: a red pill (a red "!" when the panel is under 480px wide) when the shown counts hold an open `naru ask`
  question (kind `question`, status `open`, on one of its tasks; a question
  with no task belongs to no project) or a **bounced** task: one sitting in
  `backlog` whose newest status change was `in_progress` → `backlog`. Back to
  `todo` from `in_progress` is a retry and does not count.
- Click opens the project exactly as the palette does
  (`location.hash = projectHref(id)`, the project's remembered tab). The caret
  expands / collapses; the star pins / unpins.

## Sections, filter, archived

- **Pinned and recent** (above **All projects**): pinned projects in pin order,
  then up to three recently opened ones not pinned (`recentProjects.ts`, the
  open project first). No caret; a parent's counts follow its tree row (rolled
  up while collapsed there). Hidden while filtering.
- **Filter**: case-insensitive substring on the name; matches are shown with
  their ancestors for context, all expanded, own counts.
- **Show archived** (the footer switch, with "N hidden" while off): archived
  projects and anything under one are left out unless it is on; then they are
  listed in place, muted and italic.

Pins, collapsed parents and the switch are per browser (localStorage keys
`naru-projects-panel-pinned`, `-collapsed`, `-archived`), like the recents.

## Keyboard

Tab reaches the filter, then the tree (one tab stop, roving focus), then the
switch. In the tree: ↑/↓ (or k/j) move, ← collapses or goes to the parent,
→ expands or goes to the first child, Enter or Space opens, `p` pins, `/`
goes to the filter, Home/End. In the filter: ↓ to the first row, Enter opens
the first row, Escape clears. Handled keys stop propagating, so the spatial nav
never sees them.

## Data

`GET /api/projects/counts` (`Store::project_counts`, `ProjectCounts`): one row
per project, archived included, with `backlog`, `todo`, `in_progress`, `done`,
`questions` and `bounced` for the project's own tasks. The panel polls it every
5 s, only while shown (a hidden panel renders nothing); the project list is
App's existing poll. Until the first counts fetch lands the cells are blank
(never a false 0); a failed fetch shows "Counts unavailable" above the list. Roll-ups are client-side (`projectsPanel.ts`, pure, with
vitest coverage). No CLI command: `naru task list`, `naru ask list` already
answer these per project.
