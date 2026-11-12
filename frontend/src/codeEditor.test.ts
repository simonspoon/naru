import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CodeEditor } from './components/CodeEditor'
import type { CodeEditorHandle } from './components/CodeEditor'
import { normalizeNewlines } from './editorStatus'
import { findMatches } from './fileFind'

// The one component test in the suite (naru task 2742): `CodeEditor` is the
// seam between React props and a CodeMirror view, and what ships wrong there —
// a prop that is not applied, a key that is not claimed, an offset that is off
// by the CRs CodeMirror dropped — is state, not pixels, so jsdom can see it.
// Mounted with `createRoot` directly; there is no testing library here.

type EditorProps = Parameters<typeof CodeEditor>[0]

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom lays nothing out, and has no Range geometry at all; CodeMirror's
  // measure pass asks for it.
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }
  const box = { ...rect, toJSON: () => rect } as DOMRect
  Range.prototype.getBoundingClientRect = () => box
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
})

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function mount(props: Partial<EditorProps> & { value: string }) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const full: EditorProps = { language: null, onChange: () => {}, ...props }
  const render = (next: Partial<EditorProps>) => {
    Object.assign(full, next)
    act(() => root!.render(createElement(CodeEditor, { ...full })))
  }
  render({})
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
  return { view, render }
}

function type(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main
  act(() =>
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.type',
    }),
  )
}

/** Dispatch a keydown at the content element; answers whether it was claimed
 * (`preventDefault`), i.e. whether the browser would NOT do its own thing. */
function press(view: EditorView, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    view.contentDOM.dispatchEvent(event)
  })
  return event.defaultPrevented
}

describe('CodeEditor', () => {
  it('mounts a CodeMirror view holding the value, on the class the Files chords look for', () => {
    const { view } = mount({ value: 'fn main() {}\n' })
    expect(view.state.doc.toString()).toBe('fn main() {}\n')
    expect(view.contentDOM.classList.contains('files-content-editor')).toBe(true)
    // A contenteditable div, not a textarea: what keyboardScope's selector sees.
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('true')
  })

  it('reports typing through onChange, and the caret through onCaret', () => {
    const onChange = vi.fn()
    const onCaret = vi.fn()
    const { view } = mount({ value: 'ab\ncd', onChange, onCaret })
    act(() => view.dispatch({ selection: { anchor: 4 } }))
    expect(onCaret).toHaveBeenLastCalledWith({ line: 2, col: 2 })
    type(view, 'X')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('ab\ncXd')
    expect(onCaret).toHaveBeenLastCalledWith({ line: 2, col: 3 })
  })

  it('applies an external value without reporting it, keeping the caret and the undo history', () => {
    const onChange = vi.fn()
    const { view, render } = mount({ value: 'one\ntwo\nthree', onChange })
    act(() => view.dispatch({ selection: { anchor: 13 } }))
    type(view, '!')
    render({ value: 'one\ntwo\nthree!' }) // the owner echoing the edit back
    expect(view.state.selection.main.head).toBe(14)
    onChange.mockClear()

    render({ value: 'ZERO\none\ntwo\nthree!' }) // a reload from the watch stream
    expect(view.state.doc.toString()).toBe('ZERO\none\ntwo\nthree!')
    expect(onChange).not.toHaveBeenCalled()
    // The caret rode the insertion instead of being reset.
    expect(view.state.selection.main.head).toBe(19)

    // Undo takes back this editor's own edit, not the reload.
    act(() => {
      undo(view)
    })
    expect(view.state.doc.toString()).toBe('ZERO\none\ntwo\nthree')
  })

  it('saves on Cmd/Ctrl+S and Cmd/Ctrl+Enter, swallowing the key', () => {
    const onSave = vi.fn()
    const { view } = mount({ value: 'x', onSave })
    expect(press(view, 's', { ctrlKey: true })).toBe(true)
    expect(press(view, 's', { metaKey: true })).toBe(true)
    expect(press(view, 'Enter', { metaKey: true })).toBe(true)
    expect(onSave).toHaveBeenCalledTimes(3)
    expect(view.state.doc.toString()).toBe('x')
  })

  it('leaves Cmd/Ctrl+S to the browser when there is no save to do', () => {
    const { view } = mount({ value: 'x' })
    expect(press(view, 's', { metaKey: true })).toBe(false)
  })

  it('does not turn Cmd/Ctrl+Enter into an edit when there is no save to do', () => {
    const onChange = vi.fn()
    const { view } = mount({ value: 'x', onChange })
    press(view, 'Enter', { ctrlKey: true })
    press(view, 'Enter', { metaKey: true })
    expect(view.state.doc.toString()).toBe('x')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('leaves a key that belongs to an IME composition alone', () => {
    const onCancel = vi.fn()
    const { view } = mount({ value: 'x', onCancel })
    press(view, 'Escape', { isComposing: true })
    press(view, 'Escape', { keyCode: 229 })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('keeps the selection when Escape cancels', () => {
    const onCancel = vi.fn()
    const { view } = mount({ value: 'abc', onCancel })
    act(() => view.dispatch({ selection: { anchor: 0, head: 2 } }))
    press(view, 'Escape')
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(view.state.selection.main.to).toBe(2)
  })

  it('cancels on Escape through the latest callback', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { view, render } = mount({ value: 'x', onCancel: first })
    render({ onCancel: second })
    press(view, 'Escape')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('spends the first Escape on collapsing several cursors', () => {
    const onCancel = vi.fn()
    const { view } = mount({ value: 'aa\naa', onCancel })
    act(() =>
      view.dispatch({
        selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)]),
      }),
    )
    expect(view.state.selection.ranges.length).toBe(2)
    press(view, 'Escape')
    expect(onCancel).not.toHaveBeenCalled()
    expect(view.state.selection.ranges.length).toBe(1)
    press(view, 'Escape')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("indents on Tab in the file's own unit, and dedents on Shift+Tab", () => {
    const onChange = vi.fn()
    const { view } = mount({ value: 'if x {\n\ty()\n}\nz', onChange })
    act(() => view.dispatch({ selection: { anchor: 14 } }))
    expect(press(view, 'Tab')).toBe(true)
    expect(view.state.doc.toString()).toBe('if x {\n\ty()\n}\n\tz')
    expect(press(view, 'Tab', { shiftKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('if x {\n\ty()\n}\nz')
  })

  it('lets the Tab after an Escape through as a focus move, once', () => {
    const { view } = mount({ value: 'x' })
    press(view, 'Escape')
    expect(press(view, 'Tab')).toBe(false)
    expect(view.state.doc.toString()).toBe('x')
    // The hatch is one Tab wide: the next one indents again.
    expect(press(view, 'Tab')).toBe(true)
    expect(view.state.doc.toString()).not.toBe('x')
  })

  it('does not take focus when autoFocus is off', () => {
    const { view } = mount({ value: 'x', autoFocus: false })
    expect(view.hasFocus).toBe(false)
    expect(document.activeElement).not.toBe(view.contentDOM)
  })

  it('takes focus by default', () => {
    const { view } = mount({ value: 'x' })
    expect(document.activeElement).toBe(view.contentDOM)
  })

  it('toggles soft wrap without rebuilding the view', () => {
    const { view, render } = mount({ value: 'x' })
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false)
    render({ wrap: true })
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true)
    expect(EditorView.findFromDOM(host!.querySelector<HTMLElement>('.cm-editor')!)).toBe(view)
  })

  it("does not install CodeMirror's search panel", () => {
    const { view } = mount({ value: 'x' })
    press(view, 'f', { ctrlKey: true })
    press(view, 'f', { metaKey: true })
    expect(host!.querySelector('.cm-search, .cm-panels')).toBeNull()
  })

  it('edits an unknown language as plain text', async () => {
    const { view } = mount({ value: 'x', language: 'brainfuck' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(view.state.doc.toString()).toBe('x')
  })

  for (const [name, source] of [
    ['LF', 'let a = 1\nlet b = 2\n// a b a\n'],
    ['CRLF-origin', 'let a = 1\r\nlet b = 2\r\n// a b a\r\n'],
    ['wide characters', 'let a = "😀é"\nlet b = "שלום"\n// a b a\n'],
  ] as const) {
    it(`agrees with the find offsets on ${name} text`, () => {
      // The Files tab searches its normalised draft and hands those offsets
      // down; the document they index must be that same string.
      const draft = normalizeNewlines(source)
      const ref = createRef<CodeEditorHandle>()
      const { matches } = findMatches(draft, 'b', { caseSensitive: true, wholeWord: false })
      expect(matches.length).toBeGreaterThan(1)
      // Mounted with the raw text on purpose: the editor must normalise it the
      // same way the owner does.
      const { view } = mount({ value: source, ref, matches, current: 1 })
      expect(view.state.doc.toString()).toBe(draft)
      for (const match of matches) {
        act(() => ref.current!.reveal(match.start, match.end))
        const { from, to } = view.state.selection.main
        expect(view.state.sliceDoc(from, to)).toBe('b')
        expect(from).toBe(match.start)
        expect(ref.current!.caretOffset()).toBe(match.start)
      }
      const marks = [...host!.querySelectorAll('.files-find-hit')]
      expect(marks.map((m) => m.textContent)).toEqual(matches.map(() => 'b'))
      expect(marks.filter((m) => m.classList.contains('current')).length).toBe(1)
      expect(marks[1].classList.contains('current')).toBe(true)
    })
  }

  it('applies a replace-all as one change that one undo takes back', () => {
    const ref = createRef<CodeEditorHandle>()
    const onChange = vi.fn()
    const { view } = mount({ value: 'foo bar foo', ref, onChange })
    act(() =>
      ref.current!.applyEdits([
        { start: 0, end: 3, text: 'x' },
        { start: 8, end: 11, text: 'yy' },
      ]),
    )
    expect(view.state.doc.toString()).toBe('x bar yy')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('x bar yy')
    // A keystroke straight after must not join the replace's undo step.
    type(view, '!')
    act(() => {
      undo(view)
    })
    expect(view.state.doc.toString()).toBe('x bar yy')
    act(() => {
      undo(view)
    })
    expect(view.state.doc.toString()).toBe('foo bar foo')
  })

  it('clamps a reveal past the end instead of throwing', () => {
    const ref = createRef<CodeEditorHandle>()
    const { view } = mount({ value: 'abc', ref })
    act(() => ref.current!.reveal(10, 20))
    expect(view.state.selection.main.from).toBe(3)
  })
})
