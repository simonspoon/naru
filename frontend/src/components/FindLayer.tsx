import { findSegments } from '../fileFind'
import type { FindMatch } from '../fileFind'

/** The read-only pane's find highlights, as an inert copy of the text laid
 * over the real one (task 809).
 *
 * Matches are never spliced into the markup underneath: Prism's nested spans
 * cut across match boundaries, and rewriting that tree by offset is how
 * colouring gets silently corrupted for one file. So this paints a second
 * `<pre>` of identical text with transparent glyphs and lets only the `<mark>`
 * backgrounds show through. `aria-hidden`, because the one readable,
 * selectable copy of the file is the layer beneath.
 *
 * The editor paints the same matches as CodeMirror decorations instead
 * (`CodeEditor.tsx`), with the same two class names — `files-find-hit` and
 * `current` — so the two panes cannot disagree about which match is current
 * or what that looks like.
 */
export function FindLayer({
  text,
  matches,
  current,
  className,
}: {
  /** Exactly the string the matches' offsets were computed against — the
   * alignment is by construction. */
  text: string
  matches: FindMatch[]
  /** Which match is the one being stepped to, or -1. */
  current: number
  className: string
}) {
  return (
    <pre className={className} aria-hidden="true">
      {findSegments(text, matches).map((seg, i) =>
        seg.match < 0 ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <mark
            key={i}
            className={`files-find-hit${seg.match === current ? ' current' : ''}`}
          >
            {seg.text}
          </mark>
        ),
      )}
    </pre>
  )
}
