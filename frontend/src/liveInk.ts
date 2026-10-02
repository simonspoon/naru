import { boardTitle, boardViewFor, type BoardView } from './liveBoard'
import type { InkImage } from './liveBoardImages'
import type { LiveBoardKind } from './types/LiveBoardKind'
import type { LiveBoardSummary } from './types/LiveBoardSummary'

/**
 * The whiteboard's pen (mesa task 1353) — the bookkeeping behind drawing on a
 * board, kept here beside a test while `LiveBoardPanel.tsx` owns the canvas
 * and the pointer (jsdom has no canvas).
 *
 * Ink is **the person's, and local** until they speak: strokes are held per
 * board id in this browser, and the agent sees them only as a PNG riding on
 * the next user turn this page sends. Since mesa task 1582 they stay on the
 * board after a send (the unsent mark is `dirty`) and are saved server-side
 * per board so a reload brings them back. So the questions that have historically
 * shipped wrong are all here — whether there is ink the agent has not seen
 * yet, whether the layout is frozen for it, which turn of a flush carries it,
 * and whether a newly pushed board may take the panel away from it.
 */

/** One sampled pointer position, in the content box's **content**
 *  coordinates (CSS px, scroll included), so a stroke stays on what it was
 *  drawn over when the content scrolls. */
export interface InkPoint {
  x: number
  y: number
}

/** One pen-down-to-pen-up line. Never mutated once drawn: undo and send both
 *  compare strokes by identity. */
export type InkStroke = readonly InkPoint[]

/**
 * The content box as it was when the first unsent stroke was drawn — the
 * frozen layout. Its size is pinned inline and its scroll locked while there
 * is unsent ink, so the strokes and the content under them cannot drift
 * apart, and it is also the size the flattened PNG is drawn at.
 */
export interface InkFrame {
  width: number
  height: number
  scrollLeft: number
  scrollTop: number
}

/** One board's ink. */
export interface BoardInk {
  /** Everything drawn on the board, oldest first. A send does **not** take
   *  strokes off the board (mesa task 1582): they stay, editable, and the
   *  next turn carries the whole board again, cumulatively. */
  strokes: readonly InkStroke[]
  /** Pictures dropped or pasted onto the board (mesa task 1580), oldest
   *  first — kept and edited like the strokes. */
  images: readonly InkImage[]
  /** Whether anything changed since the last turn that carried this board —
   *  the unsent mark. A stroke, an image added, moved, resized or removed, an
   *  undo: all set it. A successful send clears it (`markInkSent`) unless the
   *  person changed the board while the turn was on its way. Clearing the
   *  board clears it too: a board with nothing on it has nothing to send. */
  dirty: boolean
  /** The frozen layout — present exactly while the board is `dirty` (a board
   *  restored from the server adopts its frame on first sight, `adoptFrame`). */
  frame: InkFrame | null
}

/** Every board's ink, by board id — ink stays with the board it was drawn on
 *  and never carries over to another. */
export type InkBook = Readonly<Record<number, BoardInk>>

/** A page that has drawn nothing. */
export function emptyInkBook(): InkBook {
  return {}
}

const BLANK: BoardInk = { strokes: [], images: [], dirty: false, frame: null }

/** One board's ink, or none. */
export function boardInk(book: InkBook, boardId: number): BoardInk {
  return book[boardId] ?? BLANK
}

/**
 * Whether a board carries ink the agent has not seen — the dirty flag. Ink
 * stays on the board after a send, so "anything drawn" is no longer the
 * question: it is "anything drawn that changed since the last carrying turn".
 */
export function inkIsNew(ink: BoardInk): boolean {
  return ink.dirty && (ink.strokes.length > 0 || ink.images.length > 0)
}

function withBoard(book: InkBook, boardId: number, ink: BoardInk): InkBook {
  return { ...book, [boardId]: ink }
}

/**
 * The board after an edit: `strokes`/`images` replace the old ones, the board
 * is unsent, and the layout is frozen at `frame` unless it already was (later
 * edits keep the first frame — the content must not move under the ink). An
 * edit that leaves nothing on the board makes it clean and unfrozen.
 */
function edited(
  ink: BoardInk,
  strokes: readonly InkStroke[],
  images: readonly InkImage[],
  frame: InkFrame,
): BoardInk {
  if (strokes.length === 0 && images.length === 0) return BLANK
  return {
    strokes,
    images,
    dirty: true,
    frame: ink.dirty ? (ink.frame ?? frame) : frame,
  }
}

/**
 * A stroke drawn. The **first** unsent change freezes the layout at `frame`,
 * the content box as it stood when the pen went down; later ones keep that
 * frame, since the whole point of a frozen layout is that it does not move
 * under the ink. A stroke with no points is a tap that drew nothing.
 */
export function addStroke(
  book: InkBook,
  boardId: number,
  stroke: InkStroke,
  frame: InkFrame,
): InkBook {
  if (stroke.length === 0) return book
  const ink = boardInk(book, boardId)
  return withBoard(book, boardId, edited(ink, [...ink.strokes, stroke], ink.images, frame))
}

/** A picture dropped or pasted on. Freezes the layout like the first stroke:
 *  its box is in content coordinates over the content under it. */
export function addImage(
  book: InkBook,
  boardId: number,
  image: InkImage,
  frame: InkFrame,
): InkBook {
  const ink = boardInk(book, boardId)
  return withBoard(book, boardId, edited(ink, ink.strokes, [...ink.images, image], frame))
}

/** A placed picture replaced by its moved or resized self, by id. */
export function updateImage(
  book: InkBook,
  boardId: number,
  image: InkImage,
  frame: InkFrame,
): InkBook {
  const ink = boardInk(book, boardId)
  if (!ink.images.some((it) => it.id === image.id)) return book
  const images = ink.images.map((it) => (it.id === image.id ? image : it))
  return withBoard(book, boardId, edited(ink, ink.strokes, images, frame))
}

/** A placed picture taken off the board. */
export function removeImage(
  book: InkBook,
  boardId: number,
  imageId: number,
  frame: InkFrame,
): InkBook {
  const ink = boardInk(book, boardId)
  const images = ink.images.filter((it) => it.id !== imageId)
  if (images.length === ink.images.length) return book
  return withBoard(book, boardId, edited(ink, ink.strokes, images, frame))
}

/** The newest stroke taken back — even one a turn already carried; the next
 *  turn then carries the board without it. */
export function undoStroke(book: InkBook, boardId: number, frame: InkFrame): InkBook {
  const ink = boardInk(book, boardId)
  if (ink.strokes.length === 0) return book
  return withBoard(book, boardId, edited(ink, ink.strokes.slice(0, -1), ink.images, frame))
}

/** Every stroke and image on a board wiped — the one way to empty it. The
 *  layout unfreezes and nothing is unsent: the board is blank, so no turn
 *  carries it until the person draws again. */
export function clearInk(book: InkBook, boardId: number): InkBook {
  if (!(boardId in book)) return book
  return withBoard(book, boardId, BLANK)
}

/**
 * A turn carrying `strokes` and `images` was sent. The board stays as it is;
 * only the unsent mark goes, and the layout unfreezes — unless the person
 * changed the board while the turn was on its way (a stroke or image added,
 * removed, moved or resized, an undo), in which case that change is still
 * unsent and the layout stays where it froze. "Changed" is by identity: the
 * carried arrays' members must be exactly the board's now.
 */
export function markInkSent(
  book: InkBook,
  boardId: number,
  strokes: readonly InkStroke[],
  images: readonly InkImage[] = [],
): InkBook {
  const ink = boardInk(book, boardId)
  if (!ink.dirty) return book
  const same =
    ink.strokes.length === strokes.length &&
    ink.images.length === images.length &&
    ink.strokes.every((stroke, i) => stroke === strokes[i]) &&
    ink.images.every((image, i) => image === images[i])
  if (!same) return book
  return withBoard(book, boardId, { ...ink, dirty: false, frame: null })
}

/** An unsent board that has no frame yet — restored from the server — takes
 *  the layout as it stands now. */
export function adoptFrame(book: InkBook, boardId: number, frame: InkFrame): InkBook {
  const ink = boardInk(book, boardId)
  if (!inkIsNew(ink) || ink.frame !== null) return book
  return withBoard(book, boardId, { ...ink, frame })
}

/** What the server keeps for a board (`PUT /api/live/boards/{id}/ink-state`):
 *  a JSON object only this page reads. */
export function serializeInk(ink: BoardInk): Record<string, unknown> {
  return { v: 1, strokes: ink.strokes, images: ink.images, dirty: ink.dirty }
}

function isPoint(p: unknown): p is InkPoint {
  if (typeof p !== 'object' || p === null) return false
  const q = p as Record<string, unknown>
  return typeof q.x === 'number' && typeof q.y === 'number'
}

function isImage(i: unknown): i is InkImage {
  if (typeof i !== 'object' || i === null) return false
  const q = i as Record<string, unknown>
  return (
    typeof q.id === 'number' &&
    typeof q.src === 'string' &&
    q.src.startsWith('data:image/') &&
    typeof q.x === 'number' &&
    typeof q.y === 'number' &&
    typeof q.width === 'number' &&
    typeof q.height === 'number'
  )
}

/** A saved board's ink, or `null` for anything that is not one (an empty
 *  object, a shape this page did not write). Tolerant by design: a bad saved
 *  state costs the board its ink, never the page. The restored board has no
 *  frame; `adoptFrame` gives an unsent one the layout it is shown in — so
 *  restored unsent ink is read against the current layout's frame, and strokes
 *  drawn at another window size can land misplaced. */
export function deserializeInk(raw: unknown): BoardInk | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.strokes) || !Array.isArray(o.images)) return null
  const strokes = o.strokes.filter(
    (s): s is InkStroke => Array.isArray(s) && s.length > 0 && s.every(isPoint),
  )
  const images = o.images.filter(isImage)
  if (strokes.length === 0 && images.length === 0) return null
  return { strokes, images, dirty: o.dirty === true, frame: null }
}

/** A board's saved ink joined to the book. Where the page holds nothing for
 *  the board the saved ink simply joins; where it holds edits made while the
 *  answer was on its way, the saved strokes and images come first and the
 *  local ones after (an image id the page already holds wins), and the board
 *  is unsent if either side was. A blank local entry counts as nothing. */
export function hydrateInk(book: InkBook, boardId: number, saved: BoardInk): InkBook {
  const local = book[boardId]
  if (local === undefined || (local.strokes.length === 0 && local.images.length === 0)) {
    return withBoard(book, boardId, saved)
  }
  const localIds = new Set(local.images.map((i) => i.id))
  return withBoard(book, boardId, {
    strokes: [...saved.strokes, ...local.strokes],
    images: [...saved.images.filter((i) => !localIds.has(i.id)), ...local.images],
    dirty: local.dirty || saved.dirty,
    frame: local.dirty ? local.frame : null,
  })
}

/** The unsent ink the next turn should carry: which board, and exactly which
 *  strokes and images (so a send marks those, not whatever is drawn by the
 *  time it lands). `null` when nothing is new. */
export function pendingInk(book: InkBook): {
  boardId: number
  strokes: readonly InkStroke[]
  images: readonly InkImage[]
  frame: InkFrame | null
} | null {
  for (const [id, ink] of Object.entries(book)) {
    if (inkIsNew(ink)) {
      return { boardId: Number(id), strokes: ink.strokes, images: ink.images, frame: ink.frame }
    }
  }
  return null
}

/**
 * The board the layout is frozen for, or `null`. While there is new ink the
 * panel may not resize, maximise, restore, step to another board or close,
 * and its content may not scroll: the strokes are pinned to pixels, and any
 * of those would move the content out from under them.
 */
export function frozenBoard(book: InkBook): number | null {
  return pendingInk(book)?.boardId ?? null
}

/** Drops the ink of boards no longer in the conversation's history — pruned,
 *  or the conversation ended. The same book, by identity, when nothing went. */
export function pruneInk(book: InkBook, boards: readonly LiveBoardSummary[]): InkBook {
  const live = new Set(boards.map((board) => board.id))
  const ids = Object.keys(book).map(Number)
  if (ids.every((id) => live.has(id))) return book
  const next: Record<number, BoardInk> = {}
  for (const id of ids) if (live.has(id)) next[id] = book[id]
  return next
}

/**
 * `boardViewFor`, held while a board is frozen for ink: a newly pushed board
 * does not take the panel away from the one the person is drawing on. The
 * view stays on that board — by id, since a push can prune the oldest board
 * and shift every index — and `seen` is left alone, so the moment the ink is
 * sent or cleared the ordinary rule jumps to whatever arrived meanwhile.
 */
export function heldBoardView(
  view: BoardView,
  boards: readonly LiveBoardSummary[],
  heldId: number | null,
): BoardView {
  if (heldId !== null) {
    const index = boards.findIndex((board) => board.id === heldId)
    if (index >= 0) return index === view.index ? view : { index, seen: view.seen }
  }
  return boardViewFor(view, boards)
}

/**
 * Which turn of one send carries the ink: the **last** of `count`, so a
 * recording the page had to split still hands the agent the picture with the
 * whole of what was said about it. `null` when nothing is sent.
 */
export function inkCarrier(count: number): number | null {
  return count > 0 ? count - 1 : null
}

/**
 * How a board's own pixels reach the flattened PNG under the ink.
 *
 * - `image`: an `<img>` of the board's bytes, drawn where it sits.
 * - `svg`: a diagram, whose SVG is fetched from the render route and drawn
 *   where its `<img>` sits.
 * - `dom`: markdown, rendered in Naru's own DOM, serialized into an SVG
 *   `<foreignObject>` with its computed styles inlined.
 * - `caption`: HTML, an opaque sandboxed frame no page can read back — a
 *   white sheet with a caption naming the board. An unknown kind lands here
 *   too, the one background that reads nothing.
 */
export type InkBackground = 'image' | 'svg' | 'dom' | 'caption'

export function inkBackground(kind: LiveBoardKind): InkBackground {
  if (kind === 'image') return 'image'
  if (kind === 'diagram') return 'svg'
  if (kind === 'markdown') return 'dom'
  return 'caption'
}

/** The caption strip's words: the board's title and its kind. */
export function inkCaption(board: LiveBoardSummary): string {
  return `${boardTitle(board)} · ${board.kind}`
}

/** A point in content coordinates, where it lands in the frozen frame. */
export function framePoint(point: InkPoint, frame: InkFrame): InkPoint {
  return { x: point.x - frame.scrollLeft, y: point.y - frame.scrollTop }
}

/** The pen's colour: a saturated magenta that reads on the dark diagram, on
 *  white and on a screenshot alike. */
export const INK_COLOR = '#ff2bd6'

/** The pen's width, CSS px. */
export const INK_WIDTH = 3

/**
 * The server's `LIVE_INK_MAX` (8 MiB decoded), mirrored: a flatten whose PNG
 * would be refused is redrawn at 1× rather than posted and refused.
 */
export const INK_MAX_BYTES = 8 * 1024 * 1024

/** The decoded size of a base64 payload, without decoding it. */
export function base64Bytes(base64: string): number {
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - pad
}
