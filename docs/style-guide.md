# Style guide

The look the live chat panel set (mesa task 1565) is the site-wide style
(mesa task 1566). Presentation only: tokens live in `frontend/src/index.css`,
the rules below are applied across `frontend/src/App.css`.

## Principles

- **Dark navy base** (`--bg`, the faint grid) stays.
- **Soft, tinted, rounded surfaces** instead of heavy bordered boxes. A panel
  is `--surface` (translucent cyan tint) with `--r-md`; a card inside it is
  `--surface-raised`, hover `--surface-hover`. Buttons, fields, panels, cards and chips keep a
  `1px solid transparent` border (the ring is a box-shadow), so a control is the
  same size it was when it wore a visible border.
- **Separation by ring, edge or spacing**, not outline: `--ring` (a 1px
  box-shadow), `--edge-cyan` (inset 2px left edge on cards and bubbles),
  `--hairline` for row dividers. Floating layers (modals, palette, popovers)
  stay opaque and keep a faint `--border`.
- **Accents as glow and edge.** Cyan/violet appear as `--ring-focus`, hover
  tints and edges, not as outlines everywhere.
- **Rounded inputs with a ring**, a focus glow, and controls inside the field.
- **Buttons** are rounded and tinted, no clip-path. Primary is solid cyan,
  `.danger` a red tint.
- **Quiet labels**: sentence case, shown once. No uppercase chrome labels.

## Tokens (`index.css`)

| Token | Use |
| --- | --- |
| `--font-sans` | Inter: body, buttons, inputs, headings (semibold, no uppercase) |
| `--font-brand` | Orbitron: the wordmark only |
| `--font-mono` | Share Tech Mono: see "When to use mono" |
| `--r-sm` / `--r-md` / `--r-lg` / `--r-pill` | 8 chips and icons / 12 cards and panels / 16 bubbles, modals / pill |
| `--surface`, `--surface-raised`, `--surface-hover`, `--surface-field` | tinted fills |
| `--ring`, `--ring-focus`, `--edge-cyan`, `--hairline`, `--border(-bright)` | separation |
| `--wf-trigger` … `--wf-output`, `--wf-run` | the workflow builder's per-kind node tints and its Run pill |
| `--wf-flow` | the parallel / join pair's shared tint (naru task 1989) |

## Themes

Every colour in `index.css` / `App.css` flows through `:root` variables
(channel triplets such as `--cyan-rgb` so `rgba(var(--cyan-rgb), a)` retints).
`:root` is the `dark` theme; `frontend/src/themes.css` holds one
`:root[data-theme='<id>']` block per other theme (`light`, `contrast`, `crimson`) that
overrides the same variables and sets `color-scheme`. `theme.ts` picks the id
(Settings → Appearance, `docs/config.md` "Appearance") and sets `data-theme` on
`<html>`.

- **Adding a variable to `:root` means adding it to every theme block**, or
  deciding it is theme-independent. Never put a colour literal in a rule.
  A themed variable also needs its derivation decided in
  `src/core/theme.rs::derive` (`docs/themes.md`), since custom themes get only
  what `derive` emits; `builtins_match_the_stylesheets` fails if a variable in
  the `light` block is not derived.
- The built-in key-colour table (`theme.rs::BUILTIN_THEMES`) must match the
  `:root` / `themes.css` blocks.
- Script-painted chrome (xterm, canvas export, the workflow dots) reads the
  variables with `theme.ts::cssVar` at use time and repaints on
  `onThemeChange`.
- Theme-independent on purpose: the live orb/mark state colours, timeline kind
  colours, chart/agent palettes, iframe/board white, the image checkerboard.
- Light accents are the dark hues darkened for >= 4.5:1 on `--bg`/`--panel`;
  check that when adding a theme.

## When to use mono

Only for small meta (ids, times, counts, chips, kbd) and for code: terminal and
pty panes, the editor, diffs, file content, markdown code, script logs. Body
text, buttons, headings and form fields are Inter.

## Colour tokens

Values below are the `dark` theme; every one is re-defined per theme
(`themes.css`). Use the variable, never the literal. A translucent shade is
`rgba(var(--<name>-rgb), a)`, never a new hex.

| Variable | Use |
| --- | --- |
| `--bg` | page canvas (with the `--grid-line` grid on `body`) |
| `--panel`, `--panel-raised` | opaque layers: floating UI, `select option`, `code` fill |
| `--text` | body text; `--text-h` headings and bright text (`h1`/`h2`, bubbles) |
| `--muted` | meta, hints, labels, disabled |
| `--cyan` | the accent: links, primary action, unread edge, focus; `--cyan-dim` its 0.35 tint |
| `--violet` (`-dim`, `-edge`) | second accent: the person's side, change-request kind, agent panes |
| `--magenta` | blocked, rare emphasis (`--magenta-soft` one-off text) |
| `--amber` | in progress, medium priority, warnings |
| `--green` | done, success, task-summary kind |
| `--red` | errors, danger, high priority (`--stderr-text` for stderr) |
| `--on-accent` | ink on a solid accent fill |
| `--border`, `--border-bright`, `--hairline` | faint edge on opaque layers, hover edge, row divider |
| `--surface` / `-raised` / `-hover` / `-field` | translucent fills: panel, card-in-panel, hover, input |
| `--ring`, `--ring-focus`, `--edge-cyan` | box-shadow separation: control ring, focus glow, left edge |
| `--text-glow*` | neon text-shadows; `none` in `light`, so never hand-write one |

Status mapping (`.badge.status-*`): todo cyan, in_progress amber, done green,
cancelled muted + line-through, blocked magenta. Priority: high red, medium
amber, low muted.

## Type scale

Body is Inter 14.5px / line-height 1.5, colour `--text`. Sizes actually used,
smallest first:

| Size | Where |
| --- | --- |
| 10.5px mono, letter-spacing 1.2px | `.live-meta`: speaker and clock |
| 0.68-0.75rem | table headers, chips, nav meta, hints (`.cc-hint` is 0.8rem) |
| 0.8-0.85rem | badges, `.inbox-origin` (600), table cells (`.cc-table` 0.82rem), nav items |
| 0.9-0.95rem | buttons (500), inputs |
| 14px / 1.55 | chat bubbles (`.live-turn`) |
| 1rem | `h2` (600, 1.25) |
| 1.5rem | `h1` (600, 1.25) |

Weights: 400 body, 500 buttons, 600 headings, row titles and unread previews,
700 only for the tiny uppercase `.live-who`. Headings are `--text-h`, sentence
case.

## Spacing

Everything is rem, in this ladder: 0.25 / 0.35 / 0.5 / 0.75 / 1 / 1.5 / 2.5.
`gap`: 0.5rem is the default between siblings (most common), 0.75rem between
fields or groups, 0.25-0.4rem inside a control cluster, 1rem between sections
of a row. Padding: chips `0 0.5em`, buttons `0.3rem 0.9rem`, inputs
`0.3rem 0.6rem`, cards `0.5rem 0.75rem`, panels `1rem 1.1rem 1.1rem`, page
(`main`) `1rem 1.5rem 3rem`. Cards stack with `margin-bottom: 0.5rem`, panels
with `1rem`; sections inside a page with `2.5rem` (`.project-settings`).

## Card, table, panel

- **Card** (`.card-list li`, `.inbox-item`): `--surface` fill, `--r-md`,
  `1px solid transparent`, padding `0.5rem 0.75rem`. Hover turns the border
  `--border-bright` and adds a faint cyan glow. A state is an edge, not a
  recolour: unread is a 3px `--cyan` left border (padding reduced by 2px so
  rows still line up); kind is a faint wash over `--panel` (violet
  change-request, green task-summary) and is also named in words in the meta.
  A subtask is indented 1.5rem with a 2px `--cyan-dim` rail.
- **Panel** (`.cc-panel`): `--surface`, `--r-md`, padding `1rem 1.1rem 1.1rem`,
  `h2` with `0 0 0.6rem` margin, then an optional `.cc-hint` (0.8rem muted).
  Floating layers (modals, palette) are opaque `--panel` with a faint `--border`.
- **Table** (`.cc-table`, wrapped in `.cc-table-wrap { overflow-x: auto }`):
  full width, collapsed borders, 0.82rem, cells `0.35rem 0.6rem` on a
  `--hairline` bottom rule, `nowrap`. Headers 0.7rem `--cyan`, normal weight;
  sortable ones pointer, hover `--text-h`. Numbers are right-aligned with
  `tabular-nums`. Row hover is `--grid-line`. The scroll lives on the wrapper,
  not the panel.

## Empty state

Quiet, centred, no illustration. Muted text at 0.8rem
(`.agent-chat-empty`, `.dock-empty`), optionally a dashed `--border` box with
2rem padding (`.files-placeholder`) or `.placeholder` (3rem top margin,
centred). One sentence says what is missing, and a second muted line or one
button says what to do about it (`.dock-empty` stacks them with 0.75rem gap).
It is never red: red is an error.

## Dense text

Agent and user text is free text: assume long lines, bare URLs and many lines.

- Wrap: `overflow-wrap: anywhere` on every container that renders it
  (`.inbox-body`, `.live-turn`), and `min-width: 0` on the flex child holding
  it, or a bare URL widens the row.
- Keep line breaks: `white-space: pre-wrap` for previews and bubbles.
- Clamp, don't cut in JS: `.inbox-preview` is `-webkit-line-clamp: 3` (plus
  `line-clamp`) with `overflow: hidden`; a click expands it.
- One-line names (nav items, branch names, project names) use
  `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on a
  `flex: 1; min-width: 0` element. Never truncate the only copy of the
  information: put it in `title` or expand.
- Meta (ids, times, counts, chips) is mono, small, `--muted`, one line,
  joined by a `·`. Task numbers are the `.live-task-chip` pattern: mono
  13px, cyan text on a 0.1 cyan fill, 8px radius.
- Inline `code` is `--panel-raised`, mono 0.9em, 6px radius, `1px 5px` padding.

## Examples

`docs/style-guide-examples.html` renders each of the above with the real
variables and a theme switcher (opens from disk). It links
`../frontend/src/index.css` and `themes.css` directly, so tokens and themes
never drift; only the few component rules it demonstrates (card, panel, table,
empty, inbox preview, chip, badge) are copied from `App.css` into its own
`<style>`, so re-check those after changing them.

## Exceptions

- The `.frame-*` shape silhouettes, their `::before`/`::after` layers and
  insets are not restyled: `frontend/src/shapeBox.ts` mirrors them.
- Semantic alerts (red unavailable, green ask/toast) keep a coloured border.

## Reference

The live chat panel, `.live-turn`, `.live-meta`, `.live-task-chip`,
`.live-input-row` and `.live-send` in `App.css`: tinted 16px bubbles with an
inset cyan edge, a violet user bubble, mono 10.5px meta, 8px tinted chips and a
single rounded composer field with a ring and focus glow.
