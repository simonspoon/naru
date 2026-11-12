import { useEffect } from 'react'
import type { RefObject } from 'react'

/** What a Tab can land on inside a dialog: buttons, inputs and the scrollable
 * lists made focusable with `tabindex="0"`. */
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]'

/**
 * What the Git tab's modal dialogs share (GitConfirmDialog, GitFormDialog):
 * focus starts on `initial` and goes back to the opener when the dialog
 * closes, Esc says no (marked as well as stopped, like CreateTaskModal: the
 * live conversation's Escape stands down for one another listener claimed),
 * and Tab is trapped inside `boxRef`. `active: false` (another dialog is on
 * top) suspends the keys, not the focus restore.
 */
export function useModal({
  boxRef,
  initial,
  onEscape,
  active = true,
}: {
  boxRef: RefObject<HTMLElement | null>
  initial: RefObject<HTMLElement | null>
  onEscape: () => void
  active?: boolean
}) {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    initial.current?.focus()
    return () => {
      // The opener may have been unmounted by the refetch; then focus stays
      // wherever the browser puts it.
      if (opener?.isConnected) opener.focus()
    }
  }, [initial])

  useEffect(() => {
    if (!active) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onEscape()
      } else if (e.key === 'Tab') {
        const box = boxRef.current
        if (!box) return
        const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE))
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        const at = document.activeElement
        if (!box.contains(at)) {
          e.preventDefault()
          first.focus()
        } else if (e.shiftKey && at === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && at === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [boxRef, onEscape, active])
}
