import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import type { Ref } from 'react'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  isolateHistory,
} from '@codemirror/commands'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language'
import { highlightSelectionMatches, selectNextOccurrence } from '@codemirror/search'
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import type { Command, DecorationSet } from '@codemirror/view'
import { usePrismStyle } from '../syntaxHighlighter'
import { normalizeNewlines } from '../editorStatus'
import type { CaretPosition } from '../editorStatus'
import { detectIndentUnit, replacementRange, tabEscapeAfter } from '../editorInput'
import { highlightsAt, loadEditorLanguage } from '../editorLanguage'
import { editorChrome, editorHighlighting } from '../editorTheme'
import type { FindMatch, TextEdit } from '../fileFind'

/** The few things an owner has to be able to *do* to the box rather than
 * describe about it (task 809's find bar): read where the caret is, put it
 * back, and reveal a range the user found. All three are imperative by
 * nature — a selection is editor state, not a value a re-render could
 * restate — so they are an imperative handle rather than more props, and the
 * `EditorView` stays private to this file either way. */
export interface CodeEditorHandle {
  /** The caret's offset, the anchor a fresh search starts from. */
  caretOffset(): number
  /** Return the caret to the code, without moving it. */
  focus(): void
  /** Select `[start, end)` and scroll it onto the screen. */
  reveal(start: number, end: number): void
  /** Apply a find-and-replace (naru task 2743): every edit in **one**
   * transaction, so one undo takes all of it back. Offsets are into the text
   * as it is before any of them, ordered and non-overlapping
   * (`fileFind.ts::replaceEdits`). Reported through `onChange` like typing. */
  applyEdits(edits: readonly TextEdit[]): void
}

type Props = {
  value: string
  language: string | null
  onChange: (next: string) => void
  /** Escape. Optional: a form with no discard action (the Scripts body box)
   * leaves the key to whatever owns the surrounding modal. */
  onCancel?: () => void
  /** Cmd/Ctrl+Enter or Cmd/Ctrl+S. Optional for the same reason. */
  onSave?: () => void
  /** The Files tab opens this editor *as* the action, so it takes focus by
   * default. A form where it is one field among several (the Scripts body)
   * passes `false` so the form's own first field keeps the caret. */
  autoFocus?: boolean
  /** Soft-wrap long lines instead of scrolling sideways. Off by default: that
   * is what this editor shipped with, and the caller that offers the toggle
   * (the Files tab) is the one that persists the choice. */
  wrap?: boolean
  /** Where the caret is, on every move — for a status bar. Optional, because
   * only the Files tab has one. */
  onCaret?: (position: CaretPosition) => void
  /** Find matches over `value`, painted as decorations. Optional: only the
   * Files tab has a find bar. */
  matches?: FindMatch[]
  /** Which of them is the one being stepped to, or -1. */
  current?: number
  /** The imperative handle above. A plain prop, which is all a `ref` is under
   * React 19 — no `forwardRef` wrapper, so the component stays a function of
   * its props for the caller that passes none (the Scripts body box). */
  ref?: Ref<CodeEditorHandle>
}

// The parts of the configuration that change after mount, each in its own
// compartment so a prop change swaps one extension rather than rebuilding the
// state (which would drop the undo history and the caret). A compartment is
// only a key, so one set serves every mounted editor.
const languageConf = new Compartment()
const wrapConf = new Compartment()
const indentConf = new Compartment()
const highlightConf = new Compartment()

/** Marks a transaction that applies a `value` the owner handed down, as
 * opposed to an edit made here — so it is not reported back up as a change. */
const externalSync = Annotation.define<true>()

// Find matches (task 809). The offsets are decided by `fileFind.ts` and handed
// down as props; this field only holds the decorations built from them, mapped
// through edits so a highlight never sits on the wrong text in the frame
// between a keystroke and the owner's re-search.
const setFindMarks = StateEffect.define<DecorationSet>()
const findMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects) if (effect.is(setFindMarks)) return effect.value
    return tr.docChanged ? marks.map(tr.changes) : marks
  },
  provide: (field) => EditorView.decorations.from(field),
})
// The same classes the viewer's `FindLayer` paints with, so the two panes
// cannot disagree about what "current" looks like.
const findHit = Decoration.mark({ class: 'files-find-hit' })
const findHitCurrent = Decoration.mark({ class: 'files-find-hit current' })

function findDecorations(matches: FindMatch[], current: number, length: number): DecorationSet {
  const ranges = []
  for (let i = 0; i < matches.length; i++) {
    // Clamped, and empty ranges dropped: the offsets were computed against the
    // owner's copy of the text, and a mark decoration may not be empty.
    const from = Math.min(Math.max(matches[i].start, 0), length)
    const to = Math.min(Math.max(matches[i].end, 0), length)
    if (from < to) ranges.push((i === current ? findHitCurrent : findHit).range(from, to))
  }
  return Decoration.set(ranges, true)
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)

/** The app's one code editor (task 658, lifted out of FilesView in task 785,
 * moved onto CodeMirror 6 in naru task 2742).
 *
 * This component is the seam between React and one CodeMirror `EditorView`:
 * the view is created once per mount, and every prop is applied to it as a
 * transaction rather than by re-rendering. What that buys over the
 * textarea-and-overlay it replaced is everything that needs the text as
 * per-line structure — line numbers that stay correct under soft wrap, code
 * folding, bracket matching, multiple cursors, rectangular selection,
 * incremental highlighting — plus an undo history that is the editor's own
 * rather than the browser's.
 *
 * `value`/`onChange` are controlled the usual way, with one rule that keeps
 * the caret and the undo history intact: a `value` equal to what the editor
 * already holds is never applied. The owner echoing back the text this editor
 * just reported is the common case, and re-setting the document there would
 * reset both. A `value` that really is different (a reload from the watch
 * stream, the other pane of a split typing into the same draft) is applied as
 * the one contiguous replacement between the two texts (`replacementRange`),
 * so the caret maps through it instead of jumping, and kept out of this
 * editor's undo history, since it is not this editor's edit.
 *
 * CodeMirror holds line breaks as structure, so a CR/CRLF in `value` is read
 * as a line break and every offset here (`caretOffset`, `reveal`, `matches`)
 * is an offset into the LF form of the text — the same thing a `<textarea>`
 * did, and what `normalizeNewlines` gives the Files tab's draft.
 *
 * The keys this file decides itself are few. Escape is `onCancel` (after it
 * has first collapsed a multi-cursor selection, the way every editor spends
 * the first Escape), Cmd/Ctrl+S and Cmd/Ctrl+Enter are `onSave`, and Tab is an
 * indent in the file's own unit (`detectIndentUnit`) — unless Escape was the
 * key before it, in which case that one Tab is left to the browser as a focus
 * move (`tabEscapeAfter`). Without that hatch the Scripts page's body box — one
 * field of a form, with no `onCancel` — has no forward-Tab out of it at all,
 * which is a keyboard trap rather than an editor. Everything else (Enter's
 * auto-indent, auto-closed brackets, undo/redo, folding, Cmd/Ctrl+D) is
 * CodeMirror's own keymap. Its search panel is deliberately not installed:
 * the Files tab's find bar is the only find UI, and it paints through
 * `matches`.
 *
 * The content element carries `.files-content-editor`, which is how
 * `shouldIgnoreFilesShortcut` (keyboardScope.ts) recognises the editor as the
 * one text control the Files chords are still claimed from.
 *
 * There is exactly one of these. Every caller (the Files tab, the Scripts,
 * Library and Artifacts forms) mounts it rather than configuring its own
 * CodeMirror, so an editing behaviour cannot differ between them. */
export function CodeEditor({
  value,
  language,
  onChange,
  onCancel,
  onSave,
  autoFocus = true,
  wrap = false,
  onCaret,
  matches,
  current = -1,
  ref,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // What the view's listeners read. They are registered once, at mount, so
  // they reach the props through this ref rather than closing over the first
  // render's — a handler frozen at mount would keep saving through a stale
  // callback.
  const latest = useRef({ value, onChange, onCancel, onSave, onCaret, autoFocus })
  useLayoutEffect(() => {
    latest.current = { value, onChange, onCancel, onSave, onCaret, autoFocus }
  })
  // The `value` the document is known to agree with: the last one applied
  // from a prop, or the last one reported through `onChange`.
  const synced = useRef(value)
  // Whether the next Tab is a plain focus move rather than an indent — armed by
  // Escape, disarmed by typing (`tabEscapeAfter`) — and whether the keydown
  // being handled right now is that Tab.
  const tabEscape = useRef(false)
  const tabIsFocusMove = useRef(false)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return

    /** Tab: one indent unit at the caret, or a block indent when the selection
     * spans lines. `false` hands the key back to the browser. */
    const indentKey: Command = (view) => {
      if (tabIsFocusMove.current) return false
      const { state } = view
      const spansLines = state.selection.ranges.some(
        (range) => state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number,
      )
      if (spansLines) return indentMore(view)
      view.dispatch(
        state.update(state.replaceSelection(state.facet(indentUnit)), {
          scrollIntoView: true,
          userEvent: 'input.indent',
        }),
      )
      return true
    }
    const dedentKey: Command = (view) => !tabIsFocusMove.current && indentLess(view)

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          // Ahead of every keymap: the keys below are this component's
          // contract with its callers, and no built-in binding may shadow
          // them.
          Prec.highest(
            EditorView.domEventHandlers({
              keydown(event, view) {
                // Mid-composition, every key belongs to the IME — including
                // the Enter or Escape that commits or abandons a candidate.
                // 229 is the same thing on Safari/WKWebView, where the key
                // that ends a composition arrives with `isComposing` false.
                if (event.isComposing || event.keyCode === 229) return false
                // Read before it is updated, so the Tab *after* the Escape is
                // the one that escapes.
                const escaping = tabEscape.current
                tabEscape.current = tabEscapeAfter(escaping, event.key)
                tabIsFocusMove.current = escaping
                const { onCancel, onSave } = latest.current
                if (event.key === 'Escape') {
                  // Several cursors: the first Escape collapses them
                  // (CodeMirror's own binding), the next one is the caller's.
                  // Claimed once it is the caller's, so CodeMirror's own
                  // Escape does not also collapse the selection — a stepped-to
                  // find match stays selected, as it always did.
                  if (view.state.selection.ranges.length !== 1 || !onCancel) return false
                  onCancel()
                  return true
                }
                if (!(event.metaKey || event.ctrlKey) || !onSave) return false
                // Cmd/Ctrl+S is swallowed as well as handled: the browser's
                // own binding opens Save Page, which offers to write an HTML
                // copy of the app over the user's file. Only when there is a
                // save to do, so a form with no `onSave` keeps the browser's
                // behaviour rather than silently eating the key.
                if (event.key === 'Enter' || event.key === 's' || event.key === 'S') {
                  onSave()
                  return true
                }
                return false
              },
            }),
          ),
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          // Alt/Option-click adds a cursor, as does the platform's own
          // Cmd/Ctrl-click; Alt-drag is the rectangular selection below.
          EditorView.clickAddsSelectionRange.of(
            (event) => event.altKey || (isMac ? event.metaKey : event.ctrlKey),
          ),
          rectangularSelection(),
          crosshairCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          EditorState.tabSize.of(4),
          EditorView.contentAttributes.of({ class: 'files-content-editor' }),
          findMarks,
          editorChrome,
          languageConf.of([]),
          wrapConf.of([]),
          indentConf.of([]),
          highlightConf.of([]),
          keymap.of([
            { key: 'Tab', run: indentKey, shift: dedentKey },
            { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
            ...closeBracketsKeymap,
            // Without CodeMirror's Mod-Enter (insert a blank line): that
            // chord is `onSave` here, and in a form with no `onSave` it stays
            // the nothing it was rather than becoming an edit.
            ...defaultKeymap.filter((binding) => binding.key !== 'Mod-Enter'),
            ...historyKeymap,
            ...foldKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            const external = update.transactions.some((tr) => tr.annotation(externalSync))
            if (update.docChanged && !external) {
              const next = update.state.doc.toString()
              synced.current = next
              latest.current.onChange(next)
            }
            if ((update.selectionSet || update.docChanged) && latest.current.onCaret) {
              const head = update.state.selection.main.head
              const line = update.state.doc.lineAt(head)
              latest.current.onCaret({ line: line.number, col: head - line.from + 1 })
            }
          }),
        ],
      }),
    })
    viewRef.current = view
    synced.current = latest.current.value
    if (latest.current.autoFocus) view.focus()
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [])

  // A `value` from outside. See the component comment for why an unchanged one
  // is never applied.
  useLayoutEffect(() => {
    const view = viewRef.current
    if (view === null || value === synced.current) return
    synced.current = value
    const next = value.includes('\r') ? normalizeNewlines(value) : value
    const held = view.state.doc.toString()
    if (next === held) return
    const range = replacementRange(held, next)
    view.dispatch({
      changes: { from: range.start, to: range.end, insert: range.text },
      annotations: [externalSync.of(true), Transaction.addToHistory.of(false)],
    })
  }, [value])

  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapConf.reconfigure(wrap ? EditorView.lineWrapping : []),
    })
  }, [wrap])

  // How *this* file is indented, re-read as it is edited rather than fixed at
  // mount: a file that starts empty (the Files tab's create) learns its
  // indentation from the first block typed into it. Bounded by
  // `detectIndentUnit`'s own line budget, so it costs the same on a
  // multi-megabyte file as on a short one.
  const unit = useMemo(() => detectIndentUnit(value), [value])
  useLayoutEffect(() => {
    viewRef.current?.dispatch({ effects: indentConf.reconfigure(indentUnit.of(unit)) })
  }, [unit])

  const prismStyle = usePrismStyle()
  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: highlightConf.reconfigure(editorHighlighting(prismStyle)),
    })
  }, [prismStyle])

  // The grammar arrives as its own chunk (`editorLanguage.ts`), so the editor
  // is usable — plain — from the first frame and coloured a moment later. A
  // language with no grammar simply stays plain — and so does a document too
  // long to parse without slowing the typing (`highlightsAt`).
  const highlighted = highlightsAt(value.length)
  useEffect(() => {
    let stale = false
    viewRef.current?.dispatch({ effects: languageConf.reconfigure([]) })
    if (!highlighted) return
    void loadEditorLanguage(language).then((extension) => {
      if (stale || extension === null) return
      viewRef.current?.dispatch({ effects: languageConf.reconfigure(extension) })
    })
    return () => {
      stale = true
    }
  }, [language, highlighted])

  // After the `value` effect above, so the offsets are applied to the text
  // they were computed against.
  useLayoutEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const none = matches === undefined || matches.length === 0
    // Nothing to clear: the form mounts never pass matches, and would
    // otherwise pay a transaction per keystroke to restate that.
    if (none && view.state.field(findMarks) === Decoration.none) return
    view.dispatch({
      effects: setFindMarks.of(
        none ? Decoration.none : findDecorations(matches, current, view.state.doc.length),
      ),
    })
  }, [matches, current, value])

  useImperativeHandle(
    ref,
    () => ({
      // The start of the selection, not its head: stepping a find leaves the
      // match selected, and the next search has to start *on* it, not past it.
      caretOffset: () => viewRef.current?.state.selection.main.from ?? 0,
      focus: () => viewRef.current?.focus(),
      // Deliberately does NOT focus: the caller (the find bar) needs the caret
      // to stay in its query box so Enter keeps stepping. The selection is
      // still set, so `focus()` — which the bar calls when it closes — lands
      // the user on the match, ready to type over it. `nearest` on both axes,
      // so a match already on screen does not move the view at all; the
      // editor itself keeps the range clear of its own gutter.
      reveal(start, end) {
        const view = viewRef.current
        if (view === null) return
        const length = view.state.doc.length
        const from = Math.min(Math.max(start, 0), length)
        const to = Math.min(Math.max(end, from), length)
        view.dispatch({
          selection: EditorSelection.single(from, to),
          effects: EditorView.scrollIntoView(EditorSelection.range(from, to), {
            y: 'nearest',
            x: 'nearest',
            yMargin: 36,
            xMargin: 24,
          }),
        })
      },
      applyEdits(edits) {
        const view = viewRef.current
        if (view === null || edits.length === 0) return
        view.dispatch({
          changes: edits.map((edit) => ({ from: edit.start, to: edit.end, insert: edit.text })),
          // Its own undo step on both sides: the history would otherwise join
          // a keystroke typed right after it into the same event.
          annotations: isolateHistory.of('full'),
          userEvent: 'input.replace',
        })
      },
    }),
    [],
  )

  return <div className="files-editor-stack" ref={hostRef} />
}
