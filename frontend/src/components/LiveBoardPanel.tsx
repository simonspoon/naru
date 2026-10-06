import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SyntheticEvent,
} from 'react'
import { liveBoardRenderUrl } from '../api'
import { useKeymap } from '../keymapStore'
import { boundFunctionKeys } from '../liveBoardKeys'
import { imageFilesFromClipboard } from '../clipboardFiles'
import {
  boardAt,
  boardRender,
  boardTitle,
  clampBoardIndex,
  emptyBoardView,
  stepBoard,
  type BoardView,
} from '../liveBoard'
import {
  moveImage,
  nextImageId,
  placeImage,
  resizeImage,
  type InkImage,
} from '../liveBoardImages'
import {
  INK_COLOR,
  INK_MAX_BYTES,
  INK_WIDTH,
  addImage,
  addStroke,
  base64Bytes,
  adoptFrame,
  boardInk,
  clearInk,
  framePoint,
  frozenBoard,
  heldBoardView,
  inkBackground,
  inkCaption,
  inkIsNew,
  removeImage,
  undoStroke,
  updateImage,
  type InkBook,
  type InkFrame,
  type InkPoint,
  type InkStroke,
} from '../liveInk'
import type { LiveBoardSummary } from '../types/LiveBoardSummary'
import { useFetch } from '../useFetch'
import { Markdown } from './Markdown'

/**
 * The live conversation's whiteboard (mesa task 1071) — a **section** of the
 * conversation panel (mesa task 1447, folded in from a floating overlay of
 * its own) showing the one board the agent pushed last, with the history
 * behind it a step away. `LiveHub` renders this component in one fixed place
 * in the panel's tree whether or not the section is showing — see `expanded`
 * below for why it is never conditionally rendered.
 *
 * The panel is a **reader**. Boards are pushed by the CLI, which is the agent
 * running as the person (the one write it makes itself is "New board", a
 * blank canvas — mesa task 1580), and the fold
 * button here folds exactly like the conversation panel's own close — a
 * picture put away is not a write. The one request it makes is the render
 * route, and only for the board being looked at: `LiveState.boards` is
 * bodiless, so the poll carries the history as pointers and a megabyte-scale
 * body is fetched once.
 *
 * It also holds a **pen** (mesa task 1353): with the pen on, a drag draws on a
 * canvas laid over the board. The ink is this browser's own, held by the hub
 * per board id (`liveInk.ts`), and reaches the agent only as a PNG on the
 * next turn the person sends — which the hub asks this panel to flatten
 * through `flattenRef`, since only the panel can see the board's pixels. The
 * first unsent stroke freezes the section — no maximise, restore, stepping,
 * folding or arrangement change — until that turn is sent or the ink cleared;
 * `LiveHub` pins the section's own size for the same reason, since it now
 * owns the layout this panel sits inside.
 */

/**
 * The rendered board itself, and the branch that carries the security
 * argument — `ArtifactPreview` in `pages/ArtifactsView.tsx`, deliberately
 * mirrored, because it is the same problem: agent-written markup shown to a
 * person.
 *
 * `html` needs no fetch here at all; the `<iframe>` loads the render route
 * by URL and the route streams the body server-side. Its
 * `sandbox="allow-scripts"` is a SECOND, INDEPENDENT layer over the render
 * route's own CSP header (`RENDER_CSP` in `src/api.rs`, the byte-identical
 * policy the artifact route serves): the header protects a direct navigation
 * to the URL, the attribute protects this framed case even if the header ever
 * regressed. Never add `allow-same-origin` — that hands the framed document
 * mesa's own origin, and with it mesa's storage and every mesa route, the
 * terminal and agents ones included. Never `srcDoc`, never
 * `dangerouslySetInnerHTML`: the whole point is that the body is parsed by
 * the browser as a document at an opaque origin, never injected into mesa's
 * own DOM.
 *
 * `image` and `diagram` are an `<img>`, so the bytes are never treated as
 * markup (and the pen's flatten draws the diagram back exactly where it
 * sits), and `markdown` is the one kind whose body the page fetches itself, since
 * `<Markdown>` renders text rather than loading a URL — and the one kind that
 * is safe in mesa's own DOM, because that component passes no raw HTML
 * through.
 *
 * **Exported** (mesa task 1448) so the CC session detail page's whiteboard
 * history section can render a past session's boards through the exact same
 * branch — the render route answers identically whether the session is live
 * or has ended, so there is nothing here that needs to differ. Typed on the
 * three fields it actually reads rather than `LiveBoardSummary` itself,
 * since a `LiveBoardHistoryEntry` (that history's own row shape) has them
 * too but no `session_id`.
 */
export function BoardBody({ board }: { board: Pick<LiveBoardSummary, 'id' | 'kind' | 'title'> }) {
  const url = liveBoardRenderUrl(board.id)
  const render = boardRender(board.kind)
  if (render === 'markdown') return <BoardMarkdown id={board.id} />
  if (render === 'image') {
    return <img className="live-board-image" src={url} alt={boardTitle(board)} />
  }
  return <BoardFrame url={url} title={boardTitle(board)} />
}

/**
 * The sandboxed document frame an html board renders in (mesa task 1599). The frame
 * is an opaque origin, so its keydowns never reach the app's global
 * shortcuts; the render route's key relay posts them to the hub, and this
 * side hands the relay the one thing it cannot know — which bare function
 * keys the keymap binds, so it can `preventDefault` those (a rebound F5 must
 * not also reload the tab). Sent on `load` and again whenever the keymap
 * changes; `'*'` because an opaque-origin frame has no origin to name.
 */
function BoardFrame({ url, title }: { url: string; title: string }) {
  const keymap = useKeymap()
  const ref = useRef<HTMLIFrameElement>(null)
  const send = useCallback(() => {
    ref.current?.contentWindow?.postMessage(
      { naru: 'board-keys', prevent: boundFunctionKeys(keymap) },
      '*',
    )
  }, [keymap])
  useEffect(send, [send])
  return (
    <iframe
      ref={ref}
      className="live-board-frame"
      title={title}
      src={url}
      sandbox="allow-scripts"
      onLoad={send}
    />
  )
}

/**
 * The markdown branch's own fetch, keyed by board id — `useFetch`'s ordinary
 * shape, and the same split `ArtifactMarkdownPreview` makes: the list is one
 * request, the body being looked at is another. The render route answers
 * `text/markdown` rather than JSON, so it is read with `fetch` directly
 * instead of through `api.ts`'s `request()` — the URL itself still comes from
 * there (`liveBoardRenderUrl`), like every other URL this app builds.
 */
function BoardMarkdown({ id }: { id: number }) {
  const { data, error } = useFetch(
    () =>
      fetch(liveBoardRenderUrl(id)).then((res) => {
        if (!res.ok) throw new Error(`board ${id} could not be read`)
        return res.text()
      }),
    `live-board-${id}`,
  )
  if (error) return <p className="error">{error}</p>
  if (data === null) return <p className="muted">Loading…</p>
  return (
    <div className="live-board-markdown markdown-body markdown-doc">
      <Markdown text={data} />
    </div>
  )
}

/** Maximise/restore, drawn as four corner brackets pointing out or in —
 *  `AgentSidebar`'s own `MaximizeGlyph`, redrawn on the 24-unit grid every
 *  `.live-icon-mark` uses (as `CloseMark` above is `LiveHub`'s close glyph
 *  redrawn), rather than a glyph-font character whose weight and baseline
 *  differ per platform. */
function MaximizeMark({ restore }: { restore: boolean }) {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      {restore ? (
        <>
          <path d="M4 9h5V4" />
          <path d="M20 9h-5V4" />
          <path d="M20 15h-5v5" />
          <path d="M4 15h5v5" />
        </>
      ) : (
        <>
          <path d="M4 9V4h5" />
          <path d="M15 4h5v5" />
          <path d="M20 15v5h-5" />
          <path d="M9 20H4v-5" />
        </>
      )}
    </svg>
  )
}

/** The pen, undo and clear glyphs, on the same 24-unit grid. */
function PenMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 20l1-5L16 4l4 4L9 19z" />
      <path d="M14 6l4 4" />
    </svg>
  )
}

function PlusMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function UndoMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 010 12h-3" />
    </svg>
  )
}

function ClearMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </svg>
  )
}

/** Flattens one board with its ink into a base64 PNG — `LiveHub` calls this
 *  when a turn is about to carry the ink. */
export type InkFlatten = (
  boardId: number,
  strokes: readonly InkStroke[],
  images: readonly InkImage[],
  frame: InkFrame,
) => Promise<string>

/** One stroke onto a 2D context, points already in the context's space. A
 *  one-point stroke — a tap — is a dot. */
function strokeOnto(ctx: CanvasRenderingContext2D, points: readonly InkPoint[]) {
  if (points.length === 0) return
  ctx.strokeStyle = INK_COLOR
  ctx.fillStyle = INK_COLOR
  ctx.lineWidth = INK_WIDTH
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (points.length === 1) {
    ctx.beginPath()
    ctx.arc(points[0].x, points[0].y, INK_WIDTH / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (const p of points.slice(1)) ctx.lineTo(p.x, p.y)
  ctx.stroke()
}

/**
 * One picture the person placed on the board (mesa task 1580): dragged to
 * move, its corner handle dragged to resize, its × to remove. Its own
 * component so the drag's bookkeeping stays out of the panel's. Sits under
 * the ink canvas, so it takes the pointer only while the pen is up.
 */
function PlacedImage({
  image,
  bounds,
  getOrigin,
  onChange,
  onRemove,
}: {
  image: InkImage
  bounds: { width: number; height: number }
  getOrigin: () => { x: number; y: number }
  onChange: (next: InkImage) => void
  onRemove: (imageId: number) => void
}) {
  const drag = useRef<{
    mode: 'move' | 'resize'
    startX: number
    startY: number
    orig: InkImage
  } | null>(null)

  function down(e: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { mode, startX: e.clientX, startY: e.clientY, orig: image }
  }

  function move(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current
    if (d === null) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    onChange(
      d.mode === 'move'
        ? moveImage(d.orig, dx, dy, bounds, getOrigin())
        : resizeImage(d.orig, dx, dy, bounds),
    )
  }

  function up() {
    drag.current = null
  }

  return (
    <div
      className="live-board-ink-image"
      style={{
        left: `${image.x}px`,
        top: `${image.y}px`,
        width: `${image.width}px`,
        height: `${image.height}px`,
      }}
      onPointerDown={(e) => down(e, 'move')}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <img src={image.src} alt="" draggable={false} />
      <button
        type="button"
        className="live-board-ink-image-remove"
        aria-label="remove the picture"
        title="Remove"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onRemove(image.id)}
      >
        ×
      </button>
      <div
        className="live-board-ink-image-handle"
        title="Resize"
        onPointerDown={(e) => down(e, 'resize')}
      />
    </div>
  )
}

/** An `<img>` loaded from `src`, or a rejection. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('the board image could not be loaded'))
    img.src = src
  })
}

/** A dropped or pasted picture, read into a data URL with its natural size
 *  (a size-less SVG falls back to a default). Rejects on anything the browser
 *  cannot decode. */
async function readImage(file: File): Promise<{ src: string; width: number; height: number }> {
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('the picture could not be read'))
    reader.readAsDataURL(file)
  })
  const img = await loadImage(src)
  return { src, width: img.naturalWidth || 300, height: img.naturalHeight || 200 }
}

/** Where an element sits inside the content box, in the frame's space — the
 *  same visible window the canvas overlay covers. */
function rectIn(el: Element, content: HTMLElement) {
  const r = el.getBoundingClientRect()
  const c = content.getBoundingClientRect()
  return { x: r.left - c.left, y: r.top - c.top, width: r.width, height: r.height }
}

/** A deep clone of `src` with every element's computed style written inline,
 *  so it renders the same inside an SVG `<foreignObject>`, where Naru's
 *  stylesheet does not reach. */
function cloneWithStyles(src: HTMLElement): HTMLElement {
  const clone = src.cloneNode(true) as HTMLElement
  const inline = (from: Element, to: Element) => {
    const cs = getComputedStyle(from)
    let css = ''
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i]
      css += `${prop}:${cs.getPropertyValue(prop)};`
    }
    to.setAttribute('style', css)
    for (let i = 0; i < from.children.length; i++) {
      const child = to.children[i]
      if (child !== undefined) inline(from.children[i], child)
    }
  }
  inline(src, clone)
  return clone
}

/**
 * The board's own pixels under the ink, per kind (`liveInk.ts::inkBackground`),
 * drawn at the frame's size into a context already scaled to CSS px. Throws
 * on anything it cannot draw; the caller then draws the caption instead.
 */
async function drawBoardBackground(
  ctx: CanvasRenderingContext2D,
  board: LiveBoardSummary,
  content: HTMLElement,
  frame: InkFrame,
) {
  const background = inkBackground(board.kind)
  if (background === 'caption') throw new Error('an html board cannot be read back')
  // The panel's own backdrop first, so whatever the board does not cover
  // looks as it did on screen: the section paints the opaque dark stage.
  ctx.fillStyle = getComputedStyle(content.closest('.live-board-section') ?? content).backgroundColor
  // Filled in device pixels: the canvas is rounded up from a fractional box, so a CSS-unit fill leaves the last column/row partly clear.
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.restore()
  if (background === 'image') {
    const img = content.querySelector<HTMLImageElement>('img.live-board-image')
    if (img === null) throw new Error('no image on the board')
    await img.decode()
    const at = rectIn(img, content)
    ctx.drawImage(img, at.x, at.y, at.width, at.height)
    return
  }
  if (background === 'svg') {
    const img = content.querySelector<HTMLImageElement>('img.live-board-image')
    if (img === null) throw new Error('no diagram on the board')
    const res = await fetch(liveBoardRenderUrl(board.id))
    if (!res.ok) throw new Error(`board ${board.id} could not be read`)
    const url = URL.createObjectURL(
      new Blob([await res.text()], { type: 'image/svg+xml' }),
    )
    try {
      const svg = await loadImage(url)
      const at = rectIn(img, content)
      ctx.drawImage(svg, at.x, at.y, at.width, at.height)
    } finally {
      URL.revokeObjectURL(url)
    }
    return
  }
  // Markdown: the content box itself, cloned with its styles inlined, shifted
  // by the frozen scroll and cut to the frame — what was visible, and only
  // that.
  const clone = cloneWithStyles(content)
  // The person's pictures are drawn once, by the flatten, over this.
  clone.querySelectorAll('.live-board-ink-image').forEach((node) => node.remove())
  clone.style.width = `${frame.width}px`
  clone.style.height = 'auto'
  clone.style.overflow = 'visible'
  clone.style.margin = `${-frame.scrollTop}px 0 0 ${-frame.scrollLeft}px`
  const box = document.createElement('div')
  box.style.width = `${frame.width}px`
  box.style.height = `${frame.height}px`
  box.style.overflow = 'hidden'
  box.appendChild(clone)
  const xhtml = new XMLSerializer().serializeToString(box)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  ctx.drawImage(img, 0, 0, frame.width, frame.height)
}

/** The background no board can fail to have: the app's dark canvas, with a strip naming the
 *  board. What an HTML board always gets, and any other kind whose own pixels
 *  could not be drawn or read back. */
function drawCaptionBackground(
  ctx: CanvasRenderingContext2D,
  board: LiveBoardSummary | null,
  frame: InkFrame,
) {
  ctx.fillStyle = '#060a10'
  ctx.fillRect(0, 0, frame.width, frame.height)
  ctx.fillStyle = '#0e1722'
  ctx.fillRect(0, 0, frame.width, 32)
  ctx.fillStyle = '#b8dde8'
  ctx.font = '14px sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(board === null ? 'Whiteboard' : inkCaption(board), 10, 16, frame.width - 20)
}

/**
 * One flatten at one scale: background, then the ink on top. `real` asks for
 * the board's own pixels; when those fail to draw — or taint the canvas, which
 * is Safari's answer to a `<foreignObject>` — the answer is `null` and the
 * caller retries with the caption, so the ink itself is never dropped.
 */
async function flattenAt(
  scale: number,
  real: boolean,
  board: LiveBoardSummary | null,
  content: HTMLElement | null,
  strokes: readonly InkStroke[],
  images: readonly InkImage[],
  frame: InkFrame,
): Promise<string | null> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(frame.width * scale))
  canvas.height = Math.max(1, Math.round(frame.height * scale))
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('this browser cannot draw the ink')
  ctx.scale(scale, scale)
  if (real && board !== null && content !== null) {
    try {
      await drawBoardBackground(ctx, board, content, frame)
    } catch {
      return null
    }
  } else {
    drawCaptionBackground(ctx, board, frame)
  }
  // The person's pictures over the board, under the strokes.
  for (const image of images) {
    const el = await loadImage(image.src).catch(() => null)
    if (el !== null) {
      ctx.drawImage(el, image.x - frame.scrollLeft, image.y - frame.scrollTop, image.width, image.height)
    }
  }
  for (const stroke of strokes) strokeOnto(ctx, stroke.map((p) => framePoint(p, frame)))
  try {
    return canvas.toDataURL('image/png').split(',')[1] ?? null
  } catch {
    return null
  }
}

export function LiveBoardPanel({
  boards,
  expanded,
  onHide,
  micCapturing,
  ink,
  onInk,
  flattenRef,
  showingRef,
  onNewBoard,
  onShowBoard,
}: {
  /** The conversation's whole board history, oldest first and bodiless — the
   *  `boards` array of the poll `LiveHub` already makes, never a second one. */
  boards: LiveBoardSummary[]
  /** Whether the section is showing — CSS-driven, never a reason to skip
   *  mounting this component: an `<iframe>` that is torn down reloads its
   *  document on every re-show, and a board is a snapshot that should look the
   *  same each time it is looked at. */
  expanded: boolean
  /** Hides the section (Escape, once nothing is maximised) and nothing else:
   *  there is no route behind this. */
  onHide: () => void
  /** The microphone is capturing: Escape belongs to `live-cancel` first. */
  micCapturing: boolean
  /** Every board's ink, held by the hub so a turn it sends can carry it. */
  ink: InkBook
  /** The one write path for `ink`. */
  onInk: (update: (book: InkBook) => InkBook) => void
  /** Set by this panel to its flatten, for the hub to call on send. */
  flattenRef: RefObject<InkFlatten | null>
  /** Set by this panel to the id of the board it is showing, for the hub's
   *  view line (mesa task 1424). */
  showingRef: RefObject<number | null>
  /** Starts a blank board in the live conversation and answers its id, or
   *  `null` on failure (the hub reports it). Absent when no conversation is
   *  live, which hides the button (mesa task 1580). */
  onNewBoard?: () => Promise<number | null>
  /** A board came on screen: the hub restores its saved ink (mesa task 1582). */
  onShowBoard?: (boardId: number) => void
}) {
  // The board the layout is frozen for, while it carries unsent ink (mesa
  // task 1353): a new push does not take the panel away from it
  // (`heldBoardView`), and every control that would move its content is off.
  const held = frozenBoard(ink)
  const frozen = held !== null
  // Which board is showing, and how much of the history this panel has
  // accounted for. State rather than a prop: stepping back is this browser's
  // own business, exactly as pausing and closing are, and the hub has no say
  // in it. `boardViewFor` is what re-applies the rule that a push replaces
  // what is showing on every poll.
  // Seeded from the boards on hand rather than empty: a page that reloads
  // mid-conversation mounts this with a history already in it, and a view that
  // waited for the next poll to notice would show the head's `N/M` as `0`.
  const [view, setView] = useState<BoardView>(() =>
    heldBoardView(emptyBoardView(), boards, held),
  )
  // Re-applied during render off the changed prop rather than in an effect —
  // `useFetch.ts`'s own pattern, and for its reason: an effect would render
  // the previous board once before correcting itself, and the repo lints
  // against that cascade. `heldBoardView` answers with the view it was given
  // when nothing moved, so this settles in one pass. The freeze lifting is a
  // change too: it is when a board pushed meanwhile is finally shown.
  const [prevBoards, setPrevBoards] = useState(boards)
  const [prevHeld, setPrevHeld] = useState(held)
  if (boards !== prevBoards || held !== prevHeld) {
    setPrevBoards(boards)
    setPrevHeld(held)
    setView(heldBoardView(view, boards, held))
  }

  // The index the panel is actually on: `null` means the newest, so the head's
  // counter has to read the clamped answer rather than the held one.
  const index = clampBoardIndex(view.index, boards.length)
  const showing = boardAt(boards, index)
  const at = index === null ? 0 : index + 1
  const first = at <= 1
  const last = at >= boards.length

  function step(delta: number) {
    setView((held) => ({ ...held, index: stepBoard(held.index, delta, boards.length) }))
  }

  // Maximised: the board fills the viewport (mesa task 1447; it used to be
  // `width: 100%` of `.main-slot`, back when the panel was a floating overlay
  // positioned inside that slot — now that it is a section of the
  // conversation panel, `position: fixed; inset: 0` in App.css is what takes
  // it there, since `.main-slot` is no longer this component's containing
  // block).
  const [maximized, setMaximized] = useState(false)
  const asideRef = useRef<HTMLDivElement | null>(null)

  // Escape is the way out of whatever the section is currently doing: it
  // restores a maximised board first, and only hides the section once the
  // board is back at its normal size — one press should never do both. Bound
  // only while expanded, so it never swallows an Escape the rest of the app
  // wants while there is nothing to see.
  // Frozen for ink, it does neither: both would move the content out from
  // under the strokes.
  useEffect(() => {
    if (!expanded || frozen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // A capturing microphone has the first Escape (`live-cancel`): leaving
      // the key unmarked lets the hub discard and mute, and the board stays.
      if (micCapturing) return
      // Marked, so the conversation's own Escape (discard and mute, mesa task
      // 1354) stands down while it is closing the board.
      e.preventDefault()
      if (maximized) setMaximized(false)
      else onHide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, frozen, maximized, onHide, micCapturing])

  // ---- the pen (mesa task 1353) ----

  // Opt-in, so a board with the pen off scrolls and its frame takes clicks
  // exactly as before; this browser's own switch, like pausing.
  const [pen, setPen] = useState(false)
  // A board this panel just asked for (mesa task 1580): the pen opens once the
  // poll delivers it, so the person lands on it ready to draw. Applied during
  // render off the changed prop, the pattern the view above uses.
  const [openPenFor, setOpenPenFor] = useState<number | null>(null)
  if (openPenFor !== null && showing?.id === openPenFor) {
    setOpenPenFor(null)
    setPen(true)
  }
  const contentRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // The stroke being drawn, before the pen lifts and it joins the book — and
  // the frame the content box stood in when it went down.
  const drawing = useRef<{ points: InkPoint[]; frame: InkFrame } | null>(null)
  // The content box's size, which the overlay canvas is kept exactly over.
  const [box, setBox] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  // Read after an await (`addFiles`), where the render's own `box` is stale.
  const boxRef = useRef(box)
  useEffect(() => {
    boxRef.current = box
  }, [box])
  const showingInk = showing === null ? null : boardInk(ink, showing.id)
  const frame = showing !== null && held === showing.id ? (showingInk?.frame ?? null) : null
  // Whether the content box had a vertical scrollbar when it froze: the
  // frozen box hides its overflow, and reserving the gutter the scrollbar
  // took is what keeps its text from reflowing into the freed width.
  const [gutter, setGutter] = useState(false)

  const currentFrame = useCallback((): InkFrame | null => {
    const content = contentRef.current
    if (content === null) return null
    const rect = content.getBoundingClientRect()
    setGutter(content.offsetWidth - content.clientWidth > 0)
    return {
      width: rect.width,
      height: rect.height,
      scrollLeft: content.scrollLeft,
      scrollTop: content.scrollTop,
    }
  }, [])

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const content = contentRef.current
    if (canvas === null || content === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // Content coordinates onto the visible window: the canvas does not
    // scroll, the content under it does.
    const scroll: InkFrame = {
      width: 0,
      height: 0,
      scrollLeft: content.scrollLeft,
      scrollTop: content.scrollTop,
    }
    const strokes = showingInk?.strokes ?? []
    for (const stroke of strokes) strokeOnto(ctx, stroke.map((p) => framePoint(p, scroll)))
    if (drawing.current !== null) {
      strokeOnto(ctx, drawing.current.points.map((p) => framePoint(p, scroll)))
    }
  }, [showingInk])

  // The canvas follows the content box's size; a resize clears a canvas, so
  // every size change redraws.
  useLayoutEffect(() => {
    const content = contentRef.current
    if (content === null) return
    const measure = () => {
      const rect = content.getBoundingClientRect()
      setBox((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  // Pinned to where the ink was drawn, whatever reflowed around it.
  useLayoutEffect(() => {
    const content = contentRef.current
    if (content === null || frame === null) return
    content.scrollLeft = frame.scrollLeft
    content.scrollTop = frame.scrollTop
  }, [frame])

  useLayoutEffect(() => {
    redraw()
  }, [redraw, box])

  // Ink restored from the server that was still unsent has no frame yet
  // (mesa task 1582): it freezes the layout as it stands now.
  const needsFrame = showingInk !== null && inkIsNew(showingInk) && showingInk.frame === null
  const showingId = showing?.id ?? null
  useLayoutEffect(() => {
    if (!needsFrame || showingId === null) return
    const at = currentFrame()
    if (at !== null) onInk((book) => adoptFrame(book, showingId, at))
  }, [needsFrame, showingId, currentFrame, onInk])

  // The hub restores a board's saved ink the first time it is shown.
  useEffect(() => {
    if (showingId !== null) onShowBoard?.(showingId)
  }, [showingId, onShowBoard])

  function pointAt(e: ReactPointerEvent<HTMLCanvasElement>): InkPoint | null {
    const content = contentRef.current
    if (content === null) return null
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: e.clientX - rect.left + content.scrollLeft,
      y: e.clientY - rect.top + content.scrollTop,
    }
  }

  function penDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!pen || showing === null) return
    const point = pointAt(e)
    const at = currentFrame()
    if (point === null || at === null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = { points: [point], frame: at }
    redraw()
  }

  function penMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (drawing.current === null) return
    const point = pointAt(e)
    if (point === null) return
    drawing.current.points.push(point)
    redraw()
  }

  function penUp() {
    const stroke = drawing.current
    drawing.current = null
    if (stroke === null || showing === null) return
    const id = showing.id
    onInk((book) => addStroke(book, id, stroke.points, stroke.frame))
  }

  // ---- pictures dropped or pasted on (mesa task 1580) ----

  const scrollOrigin = () => ({
    x: contentRef.current?.scrollLeft ?? 0,
    y: contentRef.current?.scrollTop ?? 0,
  })

  function changeImage(next: InkImage) {
    if (showing === null) return
    const id = showing.id
    const at = currentFrame()
    if (at === null) return
    onInk((book) => updateImage(book, id, next, at))
  }

  function removeImageById(imageId: number) {
    if (showing === null) return
    const id = showing.id
    const at = currentFrame()
    if (at === null) return
    onInk((book) => removeImage(book, id, imageId, at))
  }

  async function newBoard() {
    if (onNewBoard === undefined) return
    const id = await onNewBoard()
    if (id === null) return
    setOpenPenFor(id)
    // So a paste lands on the board without a click first.
    contentRef.current?.focus()
  }

  async function addFiles(files: File[]) {
    if (showing === null) return
    const id = showing.id
    for (const file of files) {
      const loaded = await readImage(file).catch(() => null)
      const content = contentRef.current
      if (loaded === null || content === null) continue
      const at = currentFrame()
      if (at === null) break
      const origin = { x: content.scrollLeft, y: content.scrollTop }
      onInk((book) => {
        const images = boardInk(book, id).images
        const placed = placeImage(loaded, boxRef.current, images.length, origin)
        return addImage(book, id, { id: nextImageId(images), src: loaded.src, ...placed }, at)
      })
    }
    // Pictures are moved and resized with the pen up.
    setPen(false)
  }

  function stageDragOver(e: DragEvent<HTMLElement>) {
    if (showing !== null && Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault()
    }
  }

  // A drop or a paste carrying pictures; anything else falls through.
  function takeImages(e: SyntheticEvent, data: DataTransfer) {
    const files = imageFilesFromClipboard(data, Math.round(e.timeStamp))
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
  }

  function undo() {
    if (showing === null) return
    const id = showing.id
    const at = currentFrame()
    if (at === null) return
    onInk((book) => undoStroke(book, id, at))
  }

  function clear() {
    if (showing === null) return
    const id = showing.id
    onInk((book) => clearInk(book, id))
  }

  useEffect(() => {
    showingRef.current = showing?.id ?? null
  })

  // The hub's way to the pixels: only this panel can see the board, so the
  // flatten lives here and is handed up through a ref, refreshed every render
  // so it always reads the board that is showing now.
  useEffect(() => {
    flattenRef.current = async (boardId, strokes, images, at) => {
      const board = boards.find((b) => b.id === boardId) ?? null
      // Only the board on screen has pixels to read; any other falls to the
      // caption, and still carries its ink.
      const content = showing?.id === boardId ? contentRef.current : null
      const dpr = window.devicePixelRatio || 1
      let png: string | null = null
      for (const scale of dpr > 1 ? [dpr, 1] : [1]) {
        png =
          (await flattenAt(scale, true, board, content, strokes, images, at)) ??
          (await flattenAt(scale, false, board, content, strokes, images, at))
        // Past the server's cap it would be refused; redrawn at 1× instead.
        if (png !== null && base64Bytes(png) <= INK_MAX_BYTES) return png
      }
      // Still past the cap at 1×, or not drawn at all: the server would
      // refuse the whole turn, so the words go without it and the ink waits.
      if (png === null) throw new Error('the ink could not be drawn')
      throw new Error('the drawing is too large to attach')
    }
  })

  return (
    <div
      ref={asideRef}
      className={`live-board-section${
        maximized ? ' maximized' : ''
      }`}
      aria-label="the live whiteboard"
    >
      <div className="live-board-body">
        {/* No title header (mesa task 1483): the pane toggles live in the
            panel's toolbar. What is left is the board's own tools — the
            history, the pen and maximise — as a small cluster floating over
            the stage's top-right corner, and the board's title and kind as
            its tooltip. */}
        <div
          className="live-board-tools"
          title={showing === null ? 'Whiteboard' : `${boardTitle(showing)} · ${showing.kind}`}
        >
          {/* The history, and the pen/maximize controls beside it. */}
          {/* Shown once there is more than one board: a single board
              has nothing to step through, and `‹ 1/1 ›` reads as two
              buttons that are broken. */}
          {boards.length > 1 && (
            <div className="live-board-steps">
              <button
                type="button"
                className="live-board-step"
                aria-label="the previous board"
                disabled={first || frozen}
                onClick={() => step(-1)}
              >
                ‹
              </button>
              <span className="live-board-count">
                {at}/{boards.length}
              </span>
              <button
                type="button"
                className="live-board-step"
                aria-label="the next board"
                disabled={last || frozen}
                onClick={() => step(1)}
              >
                ›
              </button>
            </div>
          )}
          {/* A fresh blank board to draw on (mesa task 1580). */}
          {onNewBoard !== undefined && (
            <button
              type="button"
              className="live-icon live-board-new"
              aria-label="start a new blank board"
              title="New board"
              disabled={frozen}
              onClick={() => void newBoard()}
            >
              <PlusMark />
            </button>
          )}
          {/* The pen, and while it is on, its undo and clear. */}
          {showing !== null && (
            <button
              type="button"
              className="live-icon live-board-pen"
              aria-label={pen ? 'put the pen down' : 'draw on the whiteboard'}
              aria-pressed={pen}
              title={pen ? 'Stop drawing' : 'Draw on the board'}
              onClick={() => setPen((on) => !on)}
            >
              <PenMark />
            </button>
          )}
          {pen && showing !== null && (
            <>
              <button
                type="button"
                className="live-icon live-board-undo"
                aria-label="undo the last stroke"
                title="Undo"
                disabled={(showingInk?.strokes.length ?? 0) === 0}
                onClick={undo}
              >
                <UndoMark />
              </button>
              <button
                type="button"
                className="live-icon live-board-clear"
                aria-label="clear the ink"
                title="Clear the ink"
                disabled={(showingInk?.strokes.length ?? 0) + (showingInk?.images.length ?? 0) === 0}
                onClick={clear}
              >
                <ClearMark />
              </button>
            </>
          )}
          <button
            type="button"
            className="live-icon live-board-maximize"
            aria-label={
              maximized
                ? 'restore the whiteboard'
                : 'fill the page with the whiteboard'
            }
            title={maximized ? 'Restore (Esc)' : 'Fill the page'}
            disabled={frozen}
            onClick={() => setMaximized((m) => !m)}
          >
            <MaximizeMark restore={maximized} />
          </button>
        </div>

        {/* The stage holds the content box and the ink canvas laid exactly
            over it. Frozen, the box is pinned to the px size it had when the
            first unsent stroke went down, and its overflow hidden, so neither
            a window resize nor a scroll can move the content under the ink. */}
        <div
          className="live-board-stage"
          onDragOver={stageDragOver}
          onDrop={(e) => takeImages(e, e.dataTransfer)}
          onPaste={(e) => takeImages(e, e.clipboardData)}
        >
          <div
            ref={contentRef}
            className={`live-board-content${frozen ? ' inked' : ''}`}
            // Focusable by click, never by Tab (mesa task 1439): a mousedown
            // on the board moves focus here natively — selection untouched —
            // so ⌘C copies the board's selected text rather than whatever
            // field held the keyboard. A framed html board takes focus itself.
            tabIndex={-1}
            onScroll={redraw}
            style={
              frame === null
                ? undefined
                : {
                    flex: 'none',
                    width: `${frame.width}px`,
                    height: `${frame.height}px`,
                    overflow: 'hidden',
                    scrollbarGutter: gutter ? 'stable' : undefined,
                  }
            }
          >
            {showing === null ? (
              <p className="muted">Nothing on the whiteboard yet.</p>
            ) : (
              // Keyed by board id so a switch to another board mounts a fresh
              // frame/image/fetch rather than re-pointing the one on screen —
              // the previous board's pixels must not sit under the new one's
              // while it loads.
              <BoardBody key={showing.id} board={showing} />
            )}
            {/* The person's dropped and pasted pictures (mesa task 1580), in
                the strokes' content coordinates. Under the ink canvas, so
                they take the pointer only while the pen is up. */}
            {(showingInk?.images ?? []).map((image) => (
              <PlacedImage
                key={image.id}
                image={image}
                bounds={box}
                getOrigin={scrollOrigin}
                onChange={changeImage}
                onRemove={removeImageById}
              />
            ))}
          </div>
          <canvas
            ref={canvasRef}
            className={`live-board-ink${pen ? ' drawing' : ''}`}
            width={Math.max(1, Math.round(box.width * (window.devicePixelRatio || 1)))}
            height={Math.max(1, Math.round(box.height * (window.devicePixelRatio || 1)))}
            style={{ width: `${box.width}px`, height: `${box.height}px` }}
            onPointerDown={penDown}
            onPointerMove={penMove}
            onPointerUp={penUp}
            onPointerCancel={penUp}
          />
        </div>
      </div>
    </div>
  )
}
