// Go to line for the Files tab's editor (naru task 2743): what the prompt's
// text means, and where in the document it lands. Pure, like the rest of the
// editor's arithmetic (`editorStatus.ts`), because "line 0", "past the last
// line" and "column past the end of a short line" are each an off-by-one a
// screenshot hides.

import { lineCount, offsetForLine } from './editorStatus'
import type { CaretPosition } from './editorStatus'

/** `line` or `line:column` (a comma is accepted too), both 1-based — or null
 * for anything else. A missing column is column 1. */
export function parseGoToLine(input: string): CaretPosition | null {
  const parts = /^\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(input)
  if (parts === null) return null
  return { line: Number(parts[1]), col: parts[2] === undefined ? 1 : Number(parts[2]) }
}

/**
 * The offset in `text` (LF line breaks, as the editor holds it) the prompt's
 * input names, or null when the input is not a position.
 *
 * Clamped into the document rather than refused: line 0 is line 1, a line past
 * the end is the last line, and a column past the end of its line is the end
 * of that line — never the start of the next one.
 */
export function goToOffset(text: string, input: string): number | null {
  const target = parseGoToLine(input)
  if (target === null) return null
  const line = Math.min(Math.max(target.line, 1), lineCount(text))
  const start = offsetForLine(text, line)
  const lineEnd = text.indexOf('\n', start)
  const end = lineEnd === -1 ? text.length : lineEnd
  return Math.min(start + Math.max(target.col, 1) - 1, end)
}
