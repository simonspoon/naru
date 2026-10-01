# Style guide

The look the live chat panel set (mesa task 1565) is the site-wide style
(mesa task 1566). Presentation only: tokens live in `frontend/src/index.css`,
the rules below are applied across `frontend/src/App.css`.

## Principles

- **Dark navy base** (`--bg`, the faint grid) stays.
- **Soft, tinted, rounded surfaces** instead of heavy bordered boxes. A panel
  is `--surface` (translucent cyan tint) with `--r-md`; a card inside it is
  `--surface-raised`, hover `--surface-hover`. Layout-preserving panels keep a
  `1px solid transparent` border so widths do not move.
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
| `--font-brand` | Orbitron: the wordmark and diagram frame titles only |
| `--font-mono` | Share Tech Mono: see "When to use mono" |
| `--r-sm` / `--r-md` / `--r-lg` / `--r-pill` | 8 chips and icons / 12 cards and panels / 16 bubbles, modals / pill |
| `--surface`, `--surface-raised`, `--surface-hover`, `--surface-field` | tinted fills |
| `--ring`, `--ring-focus`, `--edge-cyan`, `--hairline`, `--border(-bright)` | separation |
| `--cut` | the one remaining chamfer: a diagram frame's rectangular card |

## When to use mono

Only for small meta (ids, times, counts, chips, kbd) and for code: terminal and
pty panes, the editor, diffs, file content, markdown code, script logs. Body
text, buttons, headings and form fields are Inter.

## Exceptions

- The `.frame-*` shape silhouettes, their `::before`/`::after` layers and
  insets are not restyled: `frontend/src/shapeBox.ts` mirrors them.
- Semantic alerts (red unavailable, green ask/toast) keep a coloured border.

## Reference

The live chat panel, `.live-turn`, `.live-meta`, `.live-task-chip`,
`.live-input-row` and `.live-send` in `App.css`: tinted 16px bubbles with an
inset cyan edge, a violet user bubble, mono 10.5px meta, 8px tinted chips and a
single rounded composer field with a ring and focus glow.
