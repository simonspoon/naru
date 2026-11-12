import { Fragment } from 'react'
import { parseDiff } from '../diffModel'

/**
 * A unified diff rendered as two columns: the file before the change on the
 * left, after it on the right.
 *
 * Diff text is untrusted data — every line is emitted as a plain text node
 * inside a cell, classified by prefix for CSS only and never interpreted as
 * markup, exactly like the Git tab's `DiffView`, which renders from the same
 * parser (`diffModel.ts`). A diff with no hunks (binary files, an empty diff)
 * falls back to rendering the server's text verbatim rather than an empty
 * grid.
 */
export function SideBySideDiff({ diff }: { diff: string }) {
  if (diff === '') return <p className="muted">No diff.</p>
  const { rows } = parseDiff(diff)
  if (rows.length === 0) {
    return <pre className="git-diff-text">{diff}</pre>
  }
  // Cells are emitted straight into one 4-column grid (no per-row wrapper),
  // so both halves of a row share the grid's column tracks and stay aligned
  // however a long line wraps. Tint is per side, not per row: a `chg` row is
  // deletion-tinted on the left and addition-tinted on the right.
  //
  // Each cell also carries which side it belongs to (`diff-split-l`/`-r`).
  // Nothing here reads it, but it is what lets the phone tier collapse this
  // same markup to a *unified* diff in CSS alone (App.css, ≤600px): a
  // 2-column grid plus `display: none` on the right half of a context row
  // and on either half that is empty leaves every remaining cell to reflow
  // into old-above-new order. The side is otherwise unrecoverable from the
  // class list, since a context row is tinted `ctx` on both halves.
  return (
    <div className="diff-split">
      {rows.map((row, i) => {
        if (row.kind === 'hunk' || row.kind === 'meta') {
          return (
            <span key={i} className={`diff-split-full diff-split-${row.kind}`}>
              {row.text}
            </span>
          )
        }
        const leftTint =
          row.kind === 'ctx' ? 'ctx' : row.left !== null ? 'del' : 'empty'
        const rightTint =
          row.kind === 'ctx' ? 'ctx' : row.right !== null ? 'add' : 'empty'
        return (
          <Fragment key={i}>
            <span className={`diff-split-no diff-split-l diff-split-${leftTint}`}>
              {row.left?.no ?? ''}
            </span>
            <span
              className={`diff-split-text diff-split-l diff-split-${leftTint}`}
            >
              {row.left?.text ?? ''}
            </span>
            <span className={`diff-split-no diff-split-r diff-split-${rightTint}`}>
              {row.right?.no ?? ''}
            </span>
            <span
              className={`diff-split-text diff-split-r diff-split-${rightTint}`}
            >
              {row.right?.text ?? ''}
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}
