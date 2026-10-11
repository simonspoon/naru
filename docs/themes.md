# Themes

The web UI's colours (naru task 1839). A theme is **nine key colours**; every
other CSS variable is derived from them on the server. Built-in themes ship
with Naru and are read-only; custom themes are user-made copies stored in the
db. `src/core/theme.rs` is the single implementation of the slots, the
derivation and the contrast check — the frontend applies the variables the
server sends and never derives anything.

## Slots

Nine slots, in this order (`theme::SLOT_NAMES`): `bg`, `panel`, `text`,
`muted`, `accent`, `accent2`, `good`, `warn`, `bad`. A colour is `#rgb` or
`#rrggbb` in any case, stored and returned normalised to lowercase `#rrggbb`;
anything else is `validation` naming the slot.

## Derivation

`theme::derive` turns the slots into the variable map (`Theme.vars`).
`scheme` is `light` iff `bg`'s relative luminance is >= 0.5, else `dark`.
`mix(a, b, t)` is a per-channel linear blend.

| Variable(s) | Derived from |
| --- | --- |
| `color-scheme` | `scheme` |
| `--bg-rgb`, `--text-rgb`, `--muted-rgb` | `bg`, `text`, `muted` as `r, g, b` |
| `--cyan-rgb`, `--violet-rgb` | `accent`, `accent2` |
| `--green-rgb`, `--amber-rgb`, `--red-rgb` | `good`, `warn`, `bad` |
| `--magenta-rgb` | mix(`accent2`, `bad`, 0.5) |
| `--violet-deep-rgb` | mix(`accent2`, black, 0.25) |
| `--edge-rgb` | mix(`accent`, `bg`, 0.45) |
| `--shadow-rgb` | black on dark, `text` on light |
| `--white-rgb` | white on dark, `text` on light |
| `--panel` | `panel` |
| `--panel-raised` | mix(`panel`, `text`, 0.05) |
| `--text-h` | mix(`text`, white on dark / black on light, 0.5) |
| `--surface-field` | `rgba(var(--bg-rgb), 0.85)` on dark, `panel` at 0.92 on light |
| `--wf-trigger` | mix(`panel`, mix(`accent`, `accent2`, 0.5), 0.25) |
| `--wf-prompt` / `--wf-cli` / `--wf-script` | mix(`panel`, `accent2` / `accent` / `warn`, 0.25 / 0.22 / 0.2) |
| `--wf-branch` / `--wf-decide` / `--wf-output` | mix(`panel`, `bad` / magenta / `good`, 0.22 / 0.22 / 0.18) |
| `--wf-run` | `accent2` |
| `--on-accent`, `--on-accent-alt` | `#ffffff` or `#0a0a0a`, whichever contrasts more with `accent` / `accent2` |
| `--magenta-soft` | magenta mixed 0.5 toward white (dark) or 0.1 toward black (light) |
| `--stderr-text` | mix(`bad`, `warn`, 0.5), 0.3 toward white (dark) or 0.1 toward black (light) |
| `--text-glow`, `-wide`, `-dim`, `-red`, `-magenta` | `none`, light schemes only |

A test in `theme.rs` (`builtins_match_the_stylesheets`) fails if a variable in
the `light` block of `frontend/src/themes.css` is not derived, and checks the
built-ins' slots against the stylesheets; see `docs/style-guide.md` "Themes".

## Built-ins

`dark`, `light`, `contrast` (high-contrast dark) and `crimson`
(`theme::BUILTIN_THEMES`, labels Dark / Light / High contrast / Crimson).
They are code, not rows, have no timestamps (`created_at`/`updated_at` are
`null`) and are **read-only**: editing, renaming or deleting one is
`validation` pointing at `naru theme create --from <id>`. Their key colours
match the `:root` / `themes.css` blocks.

## Custom themes

Stored in the `custom_themes` table (migration index 91), written only through
`Store` (`create_custom_theme`, `update_custom_theme`, `delete_custom_theme`).
Ids are `custom-<n>` from an `AUTOINCREMENT` integer, so a deleted id is never
reissued to a later theme that a stale config or `localStorage` entry could
pick up. A custom theme is always created by copying another theme
(`create --from`).

Name rules (`validate_custom_theme_name`): trimmed, 1 to 40 characters, no
control characters, unique case-insensitively, and not `system`, a built-in id
or label, or `custom-<digits>` (those are selectors). A theme is addressed by
built-in id, `custom-<n>` or name (case-insensitive exact). The default name of
a copy is `<source name> copy`, then `copy 2`, `copy 3`.

## Contrast warnings

`text` and `muted` are each checked against `bg` and `panel` (pairs
`text/bg`, `text/panel`, `muted/bg`, `muted/panel`) with the WCAG 2.x ratio.
A pair under **4.5:1** appears in the theme's `warnings` as
`{pair, ratio, min}`. It is advice only: a theme with warnings is saved,
selectable and applied. The CLI also prints each to stderr.

## API

All routes carry `require_agent_access`, reads included, and the usual
Content-Type gate on mutating verbs.

| Route | Does |
| --- | --- |
| `GET /api/themes` | every theme, built-ins first then custom by id |
| `GET /api/themes/{id}` | one theme (built-in id or `custom-<n>`) |
| `POST /api/themes` `{from, name?}` | copy into a new custom theme, 201 |
| `PATCH /api/themes/{id}` `{name?, slots?}` | rename and/or recolour; `slots` is any subset of the nine, unknown keys rejected; validated whole before anything is written; a built-in is 422 |
| `DELETE /api/themes/{id}` | echoes the deleted theme; if it was the saved appearance the setting is cleared (back to `system`) |
| `POST /api/themes/preview` `{slots}` | `{scheme, vars, warnings}` for nine slots; **writes nothing** (the editor's live preview) |

The saved choice is the `appearance` config section (`docs/config.md`
"Appearance"), which accepts `custom-<n>` and carries the active custom theme.

## CLI

`naru theme` (`src/cli.rs::run_theme_cmd`), JSON like every command:

| Command | Prints |
| --- | --- |
| `theme list` | bare array of `{id, name, builtin, scheme, slots}` (no `--quiet` needed; `vars`, `warnings` and timestamps are not in it) |
| `theme show <THEME>` (alias `get`) | the full theme with `vars` and `warnings` |
| `theme create --from <THEME> [--name N]` | the new custom theme |
| `theme set <THEME> <SLOT> <COLOUR>` | the theme; contrast failures are in `warnings` and on stderr |
| `theme rename <THEME> <NAME>` | the theme |
| `theme delete <THEME>` | the deleted theme |
| `theme use <THEME>` | the appearance setting (`{theme, theme_default, custom}`); `system` follows the OS |

`--quiet` on `show`/`create`/`set`/`rename`/`delete` drops `vars`; on `use` it
drops `vars` from the `custom` member. `list` accepts and ignores it.
`scripts/theme-check.sh` is the end-to-end gate.

## How a change reaches an open page

`frontend/src/theme.ts` turns a custom theme's server `vars` into one
`<style id=…>` block `:root[data-theme='custom-<n>']` (keys and values are
validated before insertion) and sets `data-theme`; the built-ins stay in
`themes.css`. `main.tsx` re-reads `GET /api/config/appearance` every **5 s**
while the tab is visible and on window focus, re-applying only when the answer
changed — that is how a `naru theme set`/`use` from the CLI (or an agent)
reaches a page that is already open. The last css is mirrored in
`localStorage` so a reload does not flash.

Installing or removing the custom block bumps `data-theme-rev` on `<html>`;
`theme.ts::onThemeChange` observes both `data-theme` and `data-theme-rev`, so
script-painted surfaces (terminal, canvases, the syntax highlighter, the live
whiteboard's `--naru-*` variables) repaint when a custom theme is edited in
place, not only when the id changes.

## Settings editor

Settings → Appearance (`AppearanceSection.tsx`, `ThemeEditor.tsx`) lists the
built-ins and custom themes; each row has Duplicate, which creates a custom
copy. When a custom theme is the active one, the editor shows nine colour
pickers whose edits are previewed through `POST /api/themes/preview` and saved
with `PATCH`, plus rename, delete and the contrast warnings. A built-in shows
"Built-in — duplicate to edit."
