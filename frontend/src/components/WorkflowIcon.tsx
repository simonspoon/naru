// The workflow builder's icons (mesa task 1610): small inline SVGs painted in
// `currentColor`, the style InboxView's transport icons use, in place of the
// emoji the node kinds used to carry.

import type { WorkflowNodeKind } from '../types/WorkflowNodeKind'

function Glyph({ children, filled }: { children: React.ReactNode; filled?: boolean }) {
  return (
    <svg
      className="wf-icon"
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** The icon for one node kind. */
export function KindIcon({ kind }: { kind: WorkflowNodeKind }) {
  switch (kind) {
    case 'trigger':
      return (
        <Glyph>
          <circle cx="8" cy="8.5" r="5.5" />
          <path d="M8 5.5v3l2 1.5" />
        </Glyph>
      )
    case 'prompt':
      return (
        <Glyph filled>
          <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13 6.4 8.6 2 7l4.4-1.6z" />
        </Glyph>
      )
    case 'cli':
      return (
        <Glyph>
          <path d="M3 4.5l4 3.5-4 3.5" />
          <path d="M9 12h4" />
        </Glyph>
      )
    case 'script':
      return (
        <Glyph>
          <path d="M5.5 4L2 8l3.5 4" />
          <path d="M10.5 4L14 8l-3.5 4" />
        </Glyph>
      )
    case 'branch':
      return (
        <Glyph>
          <path d="M8 1.5L14.5 8 8 14.5 1.5 8z" />
        </Glyph>
      )
    case 'decide':
      return (
        <Glyph>
          <path d="M8 2v5" />
          <path d="M8 7L3.5 13" />
          <path d="M8 7l4.5 6" />
        </Glyph>
      )
    case 'output':
      return (
        <Glyph>
          <path d="M8 11V2.5" />
          <path d="M4.5 6L8 2.5 11.5 6" />
          <path d="M2.5 10v3.5h11V10" />
        </Glyph>
      )
  }
}

export function PlayIcon() {
  return (
    <Glyph filled>
      <polygon points="4,2 14,8 4,14" />
    </Glyph>
  )
}

export function SpeakIcon() {
  return (
    <Glyph>
      <path d="M2.5 3h11v7.5H7L4 13.5v-3H2.5z" />
    </Glyph>
  )
}
