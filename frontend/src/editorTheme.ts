// How the CodeMirror editor is coloured (naru task 2742).
//
// Two halves, with two different sources of truth:
//
// - The chrome (text, gutter, caret, selection, active line, brackets, fold
//   marks) is written entirely in the app's CSS variables. CodeMirror injects
//   these rules as a stylesheet, so a `var(--…)` in them is resolved by the
//   browser at paint time and every theme in docs/themes.md — a custom one
//   being dragged around in the ThemeEditor included — recolours the editor
//   live, with no listener here.
// - The token colours are read out of the same Prism palette object the
//   read-only viewer beside it renders with (`usePrismStyle`), so a file looks
//   the same before and after Edit is pressed and there is no second palette
//   to keep in step. Prism has two palettes (dark and light), so there are two
//   highlight styles, built once each.

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { TagStyle } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { Tag } from '@lezer/highlight'
import type { CSSProperties } from 'react'

/** A Prism style object as react-syntax-highlighter ships it: token name (or
 * selector) -> CSS. */
export type PrismPalette = { [key: string]: CSSProperties }

export const editorChrome: Extension = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text)',
    backgroundColor: 'transparent',
  },
  // The box around the editor is the caller's (a pane, or a bordered form
  // field); CodeMirror's own dotted focus outline would be a second one.
  '&.cm-focused': { outline: 'none' },
  // The font is stated once, on `.files-editor-stack`, and inherited — the
  // same single-source rule the viewer's `.files-code-layout` follows.
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'inherit',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': {
    color: 'var(--muted)',
    backgroundColor: 'var(--panel)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.25rem 0 0.5rem' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 0.25rem', cursor: 'pointer' },
  '.cm-activeLine': { backgroundColor: 'rgba(var(--cyan-rgb), 0.05)' },
  '.cm-activeLineGutter': {
    color: 'var(--text)',
    backgroundColor: 'rgba(var(--cyan-rgb), 0.08)',
  },
  // Focused or not: stepping find matches leaves focus in the find bar, and
  // the match it selected still has to read as selected.
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
    { backgroundColor: 'rgba(var(--cyan-rgb), 0.3)' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(var(--cyan-rgb), 0.14)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgba(var(--cyan-rgb), 0.18)',
    outline: '1px solid var(--cyan-dim)',
  },
  '&.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'rgba(var(--red-rgb), 0.25)',
  },
  '.cm-foldPlaceholder': {
    color: 'var(--muted)',
    backgroundColor: 'var(--surface-raised)',
    border: '1px solid var(--border)',
  },
})

// Which Prism token each CodeMirror highlight tag takes its colour from. A
// tag whose Prism token has no colour in a palette is left unstyled there, so
// it reads in the editor's own text colour.
//
// Plain identifiers (`variableName`) are deliberately absent: Prism does not
// tokenise them at all, so in the viewer they are body text, and colouring
// every identifier here is what would make the two panes disagree most.
// `propertyName` takes Prism's `constant` rather than its `property`: the two
// are the same colour in the dark palette, but the light one paints `property`
// red, which suits the handful of JSON keys Prism applies it to and not every
// member access in a source file, which is what CodeMirror applies it to.
const TOKEN_SOURCES: readonly (readonly [string, readonly Tag[], Omit<TagStyle, 'tag'>?])[] = [
  ['comment', [t.comment]],
  ['prolog', [t.processingInstruction, t.documentMeta]],
  ['keyword', [t.keyword, t.self, t.definitionKeyword, t.modifier, t.operatorKeyword]],
  ['keyword.control-flow', [t.controlKeyword, t.moduleKeyword]],
  ['string', [t.string, t.special(t.string), t.character]],
  ['attr-value', [t.attributeValue]],
  ['regex', [t.regexp]],
  ['escape', [t.escape]],
  ['number', [t.number]],
  ['boolean', [t.bool, t.null, t.atom]],
  ['function', [t.function(t.variableName), t.function(t.propertyName), t.macroName]],
  ['class-name', [t.typeName, t.className, t.namespace]],
  ['constant', [t.propertyName, t.constant(t.variableName), t.labelName]],
  ['builtin', [t.standard(t.variableName)]],
  ['tag', [t.tagName]],
  ['attr-name', [t.attributeName]],
  ['operator', [t.operator]],
  ['punctuation', [t.punctuation]],
  ['tag.punctuation', [t.angleBracket]],
  ['inserted', [t.inserted]],
  ['deleted', [t.deleted]],
  ['keyword', [t.heading], { fontWeight: 'bold' }],
  ['string', [t.link, t.url], { textDecoration: 'underline' }],
  ['comment', [t.quote, t.meta]],
]

const built = new WeakMap<PrismPalette, Extension>()

/** The syntax-highlighting extension that paints with `palette`'s colours. */
export function editorHighlighting(palette: PrismPalette): Extension {
  const cached = built.get(palette)
  if (cached !== undefined) return cached
  const specs: TagStyle[] = [
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
  ]
  for (const [token, tag, extra] of TOKEN_SOURCES) {
    const color = palette[token]?.color
    if (typeof color === 'string') specs.push({ ...extra, tag, color })
    else if (extra !== undefined) specs.push({ ...extra, tag })
  }
  const extension = syntaxHighlighting(HighlightStyle.define(specs))
  built.set(palette, extension)
  return extension
}
