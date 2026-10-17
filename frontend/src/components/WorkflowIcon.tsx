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
    case 'schedule':
      return (
        <Glyph>
          <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
          <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
        </Glyph>
      )
    case 'webhook':
      return (
        <Glyph>
          <path d="M2 8h8" />
          <path d="M7 4.5L10.5 8 7 11.5" />
          <path d="M13 3v10" />
        </Glyph>
      )
    case 'task-event':
      return (
        <Glyph>
          <rect x="2.5" y="3" width="8" height="8" rx="1.5" />
          <path d="M4.5 7l1.5 1.5L8.5 5.5" />
          <path d="M13 6l-2 3h2.5l-2 3" />
        </Glyph>
      )
    case 'file-watch':
      return (
        <Glyph>
          <path d="M3 2.5h5.5L11 5v8.5H3z" />
          <path d="M8.5 2.5V5H11" />
          <circle cx="13" cy="11" r="1.5" />
        </Glyph>
      )
    case 'prompt':
      return (
        <Glyph filled>
          <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13 6.4 8.6 2 7l4.4-1.6z" />
        </Glyph>
      )
    case 'agent':
      return (
        <Glyph>
          <circle cx="8" cy="5.5" r="2.5" />
          <path d="M3 13.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" />
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
    case 'switch':
      return (
        <Glyph>
          <path d="M2 8h4" />
          <path d="M6 8L13 3.5" />
          <path d="M6 8h7.5" />
          <path d="M6 8l7 4.5" />
        </Glyph>
      )
    case 'parse-json':
      return (
        <Glyph>
          <path d="M6 2.5C4.5 2.5 4.5 4 4.5 5.5S4 8 2.5 8c1.5 0 2 .5 2 2.5s0 3 1.5 3" />
          <path d="M10 2.5c1.5 0 1.5 1.5 1.5 3S12 8 13.5 8c-1.5 0-2 .5-2 2.5s0 3-1.5 3" />
        </Glyph>
      )
    case 'mapfilter':
      return (
        <Glyph>
          <path d="M2.5 3h11L9 8.5V13l-2-1.2V8.5z" />
        </Glyph>
      )
    case 'parallel':
      return (
        <Glyph>
          <path d="M2.5 8h4M6.5 8 12 3.5M6.5 8h5.5M6.5 8 12 12.5" />
        </Glyph>
      )
    case 'join':
      return (
        <Glyph>
          <path d="M4 3.5 9.5 8M4 8h5.5M4 12.5 9.5 8M9.5 8h4" />
        </Glyph>
      )
    case 'delay':
      return (
        <Glyph>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 4.8V8l2.2 1.4" />
        </Glyph>
      )
    case 'gate':
      return (
        <Glyph>
          <path d="M3 3.5h10v9H3z" />
          <path d="m5.8 8.2 1.6 1.6 2.8-3.2" />
        </Glyph>
      )
    case 'task':
      return (
        <Glyph>
          <path d="M3 2.5h10v11H3z" />
          <path d="M5.5 6h5M5.5 8.5h5M5.5 11h2.5" />
        </Glyph>
      )
    case 'http':
      return (
        <Glyph>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11" />
        </Glyph>
      )
    case 'notify':
      return (
        <Glyph>
          <path d="M4 11.5h8l-1-1.5V7a3 3 0 0 0-6 0v3z M7 13.5h2" />
        </Glyph>
      )
    case 'board':
      return (
        <Glyph>
          <path d="M2.5 3h11v8h-11z M5 14l1.5-3M11 14l-1.5-3" />
        </Glyph>
      )
    case 'memory':
      return (
        <Glyph>
          <path d="M3.5 2h9v12h-9z M6 2v12 M8 5.5h2.5 M8 8h2.5" />
        </Glyph>
      )
    case 'comment':
      return (
        <Glyph>
          <path d="M2 3h12v8H7l-3 2.5V11H2z M5 6h6 M5 8.2h4" />
        </Glyph>
      )
    case 'verify':
      return (
        <Glyph>
          <path d="M8 1.5l5.5 2v4.2c0 3.3-2.3 5.4-5.5 6.8-3.2-1.4-5.5-3.5-5.5-6.8V3.5z M5.5 8l2 2 3.5-3.8" />
        </Glyph>
      )
    case 'file':
      return (
        <Glyph>
          <path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" />
        </Glyph>
      )
    case 'git':
      return (
        <Glyph>
          <circle cx="4.5" cy="3.5" r="1.5" />
          <circle cx="4.5" cy="12.5" r="1.5" />
          <circle cx="11.5" cy="6" r="1.5" />
          <path d="M4.5 5v6M11.5 7.5c0 2.5-3 2-7 3.5" />
        </Glyph>
      )
    case 'subworkflow':
      return (
        <Glyph>
          <path d="M2.5 3.5h6v4h-6zM7.5 8.5h6v4h-6z" />
          <path d="M5.5 7.5v2h2" />
        </Glyph>
      )
    case 'trycatch':
      return (
        <Glyph>
          <path d="M3 3.5h5.5v9H3z" />
          <path d="M8.5 6h4.5M8.5 10h4.5" />
        </Glyph>
      )
    case 'retry':
      return (
        <Glyph>
          <path d="M13 8a5 5 0 1 1-1.5-3.5" />
          <path d="M13 2.5v3h-3" />
        </Glyph>
      )
    case 'foreach':
      return (
        <Glyph>
          <path d="M3 8a5 5 0 0 1 8.7-3.4M13 8a5 5 0 0 1-8.7 3.4" />
          <path d="M11.8 2v3h-3M4.2 14v-3h3" />
        </Glyph>
      )
    case 'variable':
      return (
        <Glyph>
          <path d="M2.5 4.5h11M2.5 11.5h11" />
          <path d="M6 2.5 5 13.5M11 2.5 10 13.5" />
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
