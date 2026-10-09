import { describe, expect, it } from 'vitest'
import { boardViewFor, emptyBoardView } from './liveBoard'
import {
  addImage,
  addStroke,
  base64Bytes,
  adoptFrame,
  boardInk,
  clearInk,
  deserializeInk,
  emptyInkBook,
  framePoint,
  frozenBoard,
  heldBoardView,
  hydrateInk,
  inkBackground,
  inkCaption,
  inkCarrier,
  inkIsNew,
  markInkSent,
  pendingInk,
  pruneInk,
  removeImage,
  serializeInk,
  undoStroke,
  updateImage,
  type InkFrame,
  type InkStroke,
} from './liveInk'
import type { InkImage } from './liveBoardImages'
import type { LiveBoardSummary } from './types/LiveBoardSummary'

function board(id: number, patch: Partial<LiveBoardSummary> = {}): LiveBoardSummary {
  return {
    id,
    session_id: 1,
    kind: 'markdown',
    title: 'the plan',
    created_at: '2026-01-01 00:00:00',
    pinned_at: null,
    ...patch,
  }
}

const FRAME: InkFrame = { width: 600, height: 400, scrollLeft: 0, scrollTop: 120 }
const LATER: InkFrame = { width: 900, height: 700, scrollLeft: 0, scrollTop: 0 }

function stroke(x: number): InkStroke {
  return [
    { x, y: 1 },
    { x: x + 1, y: 2 },
  ]
}

describe('strokes', () => {
  it('adds, undoes and clears, one board at a time', () => {
    const a = stroke(1)
    const b = stroke(2)
    let book = addStroke(emptyInkBook(), 7, a, FRAME)
    book = addStroke(book, 7, b, FRAME)
    expect(boardInk(book, 7).strokes).toEqual([a, b])
    expect(boardInk(book, 8).strokes).toEqual([])
    book = undoStroke(book, 7, FRAME)
    expect(boardInk(book, 7).strokes).toEqual([a])
    book = clearInk(book, 7)
    expect(boardInk(book, 7).strokes).toEqual([])
    expect(frozenBoard(book)).toBeNull()
  })

  it('ignores a stroke with no points and an undo with nothing to undo', () => {
    const book = emptyInkBook()
    expect(addStroke(book, 7, [], FRAME)).toBe(book)
    expect(undoStroke(book, 7, FRAME)).toBe(book)
    expect(clearInk(book, 7)).toBe(book)
  })
})

describe('the dirty flag and the freeze', () => {
  it('freezes at the frame of the first new stroke and keeps it', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    book = addStroke(book, 7, stroke(2), LATER)
    expect(boardInk(book, 7).frame).toEqual(FRAME)
    expect(frozenBoard(book)).toBe(7)
  })

  it('is clean again once every stroke is undone', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    book = undoStroke(book, 7, FRAME)
    expect(inkIsNew(boardInk(book, 7))).toBe(false)
    expect(frozenBoard(book)).toBeNull()
    expect(pendingInk(book)).toBeNull()
  })

  it('keeps the strokes after a send, only clearing the unsent mark and the freeze', () => {
    const a = stroke(1)
    let book = addStroke(emptyInkBook(), 7, a, FRAME)
    const pending = pendingInk(book)
    expect(pending?.boardId).toBe(7)
    book = markInkSent(book, 7, pending!.strokes)
    expect(pendingInk(book)).toBeNull()
    expect(frozenBoard(book)).toBeNull()
    expect(boardInk(book, 7).frame).toBeNull()
    expect(boardInk(book, 7).strokes).toEqual([a])
  })

  it('stays dirty and frozen when the person drew more while the turn was on its way', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    const sent = pendingInk(book)!.strokes
    book = addStroke(book, 7, stroke(2), LATER)
    book = markInkSent(book, 7, sent)
    expect(frozenBoard(book)).toBe(7)
    expect(boardInk(book, 7).frame).toEqual(FRAME)
    // The next turn carries the whole board.
    expect(pendingInk(book)?.strokes).toHaveLength(2)
  })

  it('stays dirty when the send failed — nothing marks it', () => {
    const book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    expect(pendingInk(book)).not.toBeNull()
  })

  it('makes the second send cumulative: old strokes plus the new, a fresh freeze', () => {
    const a = stroke(1)
    const b = stroke(2)
    let book = addStroke(emptyInkBook(), 7, a, FRAME)
    book = markInkSent(book, 7, pendingInk(book)!.strokes)
    expect(pendingInk(book)).toBeNull()
    book = addStroke(book, 7, b, LATER)
    expect(boardInk(book, 7).frame).toEqual(LATER)
    expect(pendingInk(book)?.strokes).toEqual([a, b])
    book = markInkSent(book, 7, pendingInk(book)!.strokes)
    expect(pendingInk(book)).toBeNull()
    expect(boardInk(book, 7).strokes).toEqual([a, b])
  })

  it('counts an undo of a sent stroke as a change to send', () => {
    const a = stroke(1)
    const b = stroke(2)
    let book = addStroke(addStroke(emptyInkBook(), 7, a, FRAME), 7, b, FRAME)
    book = markInkSent(book, 7, pendingInk(book)!.strokes)
    book = undoStroke(book, 7, LATER)
    expect(frozenBoard(book)).toBe(7)
    expect(pendingInk(book)?.strokes).toEqual([a])
    expect(boardInk(book, 7).frame).toEqual(LATER)
  })

  it('clearing a sent board leaves nothing to send', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    book = markInkSent(book, 7, pendingInk(book)!.strokes)
    book = clearInk(book, 7)
    expect(boardInk(book, 7).strokes).toEqual([])
    expect(pendingInk(book)).toBeNull()
  })

  it('does not refreeze a board cleared while its turn was on its way', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    const sent = pendingInk(book)!.strokes
    book = clearInk(book, 7)
    const after = markInkSent(book, 7, sent)
    expect(after).toBe(book)
    expect(frozenBoard(after)).toBeNull()
  })
})

function picture(id: number): InkImage {
  return { id, src: 'data:image/png;base64,AAAA', x: 10, y: 10, width: 100, height: 50 }
}

describe('images', () => {
  it('make the board dirty and freeze it like a stroke', () => {
    const a = picture(1)
    let book = addImage(emptyInkBook(), 7, a, FRAME)
    expect(inkIsNew(boardInk(book, 7))).toBe(true)
    expect(boardInk(book, 7).frame).toEqual(FRAME)
    expect(frozenBoard(book)).toBe(7)
    expect(pendingInk(book)?.images).toEqual([a])
    book = addImage(book, 7, picture(2), LATER)
    expect(boardInk(book, 7).frame).toEqual(FRAME)
  })

  it('stay frozen while an image remains though every stroke is undone', () => {
    let book = addImage(emptyInkBook(), 7, picture(1), FRAME)
    book = addStroke(book, 7, stroke(1), FRAME)
    book = undoStroke(book, 7, FRAME)
    expect(frozenBoard(book)).toBe(7)
    book = removeImage(book, 7, 1, FRAME)
    expect(frozenBoard(book)).toBeNull()
  })

  it('are updated by id, and an unknown id changes nothing', () => {
    const book = addImage(emptyInkBook(), 7, picture(1), FRAME)
    const moved = { ...picture(1), x: 99 }
    expect(boardInk(updateImage(book, 7, moved, FRAME), 7).images).toEqual([moved])
    expect(updateImage(book, 7, picture(5), FRAME)).toBe(book)
    expect(removeImage(book, 7, 5, FRAME)).toBe(book)
  })

  it('stay after a send; moving one afterwards is a new unsent change', () => {
    let book = addImage(emptyInkBook(), 7, picture(1), FRAME)
    book = addStroke(book, 7, stroke(1), FRAME)
    const sent = pendingInk(book)!
    book = markInkSent(book, 7, sent.strokes, sent.images)
    expect(frozenBoard(book)).toBeNull()
    expect(boardInk(book, 7).images).toHaveLength(1)
    const moved = { ...picture(1), x: 50 }
    book = updateImage(book, 7, moved, LATER)
    expect(frozenBoard(book)).toBe(7)
    expect(pendingInk(book)?.images).toEqual([moved])
    expect(pendingInk(book)?.strokes).toHaveLength(1)
  })

  it('stay dirty when one is moved while the turn is on its way; clear wipes both', () => {
    let book = addImage(emptyInkBook(), 7, picture(1), FRAME)
    const sent = pendingInk(book)!
    const withMove = updateImage(book, 7, { ...picture(1), x: 3 }, FRAME)
    expect(frozenBoard(markInkSent(withMove, 7, sent.strokes, sent.images))).toBe(7)
    expect(frozenBoard(markInkSent(book, 7, sent.strokes, sent.images))).toBeNull()
    book = addStroke(book, 7, stroke(1), FRAME)
    expect(frozenBoard(clearInk(book, 7))).toBeNull()
    expect(boardInk(clearInk(book, 7), 7).images).toEqual([])
  })
})

describe('saved state', () => {
  it('round-trips through the server as sent ink, with no frame', () => {
    const a = stroke(1)
    let book = addImage(addStroke(emptyInkBook(), 7, a, FRAME), 7, picture(1), FRAME)
    book = markInkSent(book, 7, pendingInk(book)!.strokes, pendingInk(book)!.images)
    const raw = JSON.parse(JSON.stringify(serializeInk(boardInk(book, 7))))
    const restored = deserializeInk(raw)!
    expect(restored.strokes).toEqual([a])
    expect(restored.images).toEqual([picture(1)])
    expect(restored.dirty).toBe(false)
    expect(restored.frame).toBeNull()
    const hydrated = hydrateInk(emptyInkBook(), 9, restored)
    expect(frozenBoard(hydrated)).toBeNull()
    expect(pendingInk(hydrated)).toBeNull()
  })

  it('restores unsent ink as unsent, and adopts the layout it is shown in', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    const restored = deserializeInk(JSON.parse(JSON.stringify(serializeInk(boardInk(book, 7)))))!
    book = hydrateInk(emptyInkBook(), 7, restored)
    expect(inkIsNew(boardInk(book, 7))).toBe(true)
    expect(boardInk(book, 7).frame).toBeNull()
    book = adoptFrame(book, 7, LATER)
    expect(boardInk(book, 7).frame).toEqual(LATER)
    expect(adoptFrame(book, 7, FRAME)).toBe(book)
  })

  it('merges saved ink under edits made while the answer was on its way, and ignores junk', () => {
    const book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    const saved = deserializeInk({
      strokes: [stroke(5)],
      images: [picture(2)],
      dirty: false,
    })!
    const merged = boardInk(hydrateInk(book, 7, saved), 7)
    expect(merged.strokes).toEqual([stroke(5), stroke(1)])
    expect(merged.images).toEqual([picture(2)])
    expect(merged.dirty).toBe(true)
    expect(merged.frame).toEqual(FRAME)
    expect(deserializeInk(null)).toBeNull()
    expect(deserializeInk({})).toBeNull()
    expect(deserializeInk({ strokes: [], images: [], dirty: true })).toBeNull()
    expect(deserializeInk({ strokes: [[{ x: 'a' }]], images: [{ id: 1 }] })).toBeNull()
    expect(
      deserializeInk({
        strokes: [],
        images: [{ ...picture(1), src: 'javascript:alert(1)' }],
      }),
    ).toBeNull()
  })
})

describe('pruneInk', () => {
  it('drops ink on boards that are gone and keeps the rest', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    book = addStroke(book, 8, stroke(2), FRAME)
    const pruned = pruneInk(book, [board(8)])
    expect(Object.keys(pruned)).toEqual(['8'])
    expect(pruneInk(pruned, [board(8), board(9)])).toBe(pruned)
    expect(pruneInk(pruned, [])).toEqual({})
  })
})

describe('heldBoardView', () => {
  it('does not advance to a newly pushed board while one is frozen', () => {
    const view = boardViewFor(emptyBoardView(), [board(1), board(2)])
    expect(view.index).toBe(1)
    const pushed = [board(1), board(2), board(3)]
    const held = heldBoardView(view, pushed, 2)
    expect(held.index).toBe(1)
    expect(held.seen).toBe(2)
    // Released: the ordinary rule shows the newest.
    const released = heldBoardView(held, pushed, null)
    expect(released).toEqual({ index: 2, seen: 3 })
  })

  it('follows the held board by id when a push prunes the oldest', () => {
    const view = { index: 1, seen: 2 }
    const held = heldBoardView(view, [board(2), board(3)], 2)
    expect(held.index).toBe(0)
  })

  it('is the ordinary rule when the held board is gone', () => {
    const view = { index: 0, seen: 1 }
    expect(heldBoardView(view, [board(3)], 1)).toEqual({ index: 0, seen: 3 })
  })

  it('answers the same view when nothing moved', () => {
    const view = { index: 1, seen: 2 }
    expect(heldBoardView(view, [board(1), board(2)], 2)).toBe(view)
  })
})

describe('inkCarrier', () => {
  it('puts the ink on the last turn of a flush', () => {
    expect(inkCarrier(1)).toBe(0)
    expect(inkCarrier(3)).toBe(2)
    expect(inkCarrier(0)).toBeNull()
  })
})

describe('backgrounds', () => {
  it('reads each kind the one way it can be read', () => {
    expect(inkBackground('image')).toBe('image')
    expect(inkBackground('diagram')).toBe('svg')
    expect(inkBackground('markdown')).toBe('dom')
    expect(inkBackground('html')).toBe('caption')
    expect(inkBackground('whatever' as never)).toBe('caption')
  })

  it('captions a board by its title and kind', () => {
    expect(inkCaption(board(4, { kind: 'html', title: 'Mockup' }))).toBe('Mockup · html')
    expect(inkCaption(board(4, { kind: 'html', title: null }))).toBe('Board 4 · html')
  })
})

describe('framePoint', () => {
  it('moves a content point into the frozen frame', () => {
    expect(framePoint({ x: 10, y: 150 }, FRAME)).toEqual({ x: 10, y: 30 })
  })
})

describe('base64Bytes', () => {
  it('counts decoded bytes, padding included', () => {
    expect(base64Bytes(btoa('abc'))).toBe(3)
    expect(base64Bytes(btoa('ab'))).toBe(2)
    expect(base64Bytes(btoa('a'))).toBe(1)
  })
})
