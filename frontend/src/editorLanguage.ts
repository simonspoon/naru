// Which CodeMirror language a file's `language` tag edits with, and how to
// fetch it (naru task 2742). The one place that mapping lives: `CodeEditor`
// asks `loadEditorLanguage` and applies what it answers, and holds no table of
// its own.
//
// Every grammar is a dynamic `import()`, so each is its own chunk fetched the
// first time a file of that language is edited — the main bundle carries the
// editor's core and none of the grammars. A proper Lezer parser (`lang-*`) is
// used where CodeMirror ships one for a language this app's users open most;
// the long tail rides `@codemirror/legacy-modes` stream parsers, wrapped by
// `StreamLanguage`.
//
// The tokens are the same vocabulary `prismGrammar` (syntaxHighlighter.ts)
// accepts: the server's `core::files::language_of` tags plus the aliases the
// other mounts pass (`sh` from the Scripts body box). The read-only viewer,
// markdown fences and the diff views stay on Prism; only the editor reads this.

import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import type { StreamParser } from '@codemirror/language'

/** A grammar this module can load, by its own name. */
export type EditorLanguageId =
  | 'rust'
  | 'jsx'
  | 'tsx'
  | 'json'
  | 'markdown'
  | 'html'
  | 'xml'
  | 'css'
  | 'scss'
  | 'less'
  | 'python'
  | 'shell'
  | 'toml'
  | 'yaml'
  | 'sql'
  | 'swift'
  | 'go'
  | 'php'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'java'
  | 'kotlin'
  | 'objectivec'
  | 'dart'
  | 'scala'
  | 'ruby'
  | 'lua'
  | 'perl'
  | 'r'
  | 'haskell'
  | 'docker'
  | 'diff'
  | 'ini'
  | 'powershell'
  | 'protobuf'
  | 'groovy'

// A language token -> the grammar it edits with. Anything absent is plain
// text, the same answer `prismGrammar` gives the viewer for an unknown token.
const EDITOR_LANGUAGE: Record<string, EditorLanguageId> = {
  rust: 'rust',
  rs: 'rust',
  // The server tags `.tsx` as `typescript` and `.jsx` as `javascript` (the
  // editor is handed a language, never a file name), so the two bare tags
  // load the JSX-aware dialects: a component file is far more common here
  // than the `<T>value` cast that only the non-JSX TypeScript dialect reads.
  typescript: 'tsx',
  ts: 'tsx',
  tsx: 'tsx',
  javascript: 'jsx',
  js: 'jsx',
  jsx: 'jsx',
  python: 'python',
  py: 'python',
  json: 'json',
  markdown: 'markdown',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  shell: 'shell',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  console: 'shell',
  // CodeMirror carries no Makefile grammar. A recipe line *is* shell, and the
  // shell stream parser colours `#` comments, strings and `$(VAR)` the way a
  // Makefile reads them, so it is the closest grammar rather than none.
  makefile: 'shell',
  make: 'shell',
  html: 'html',
  xml: 'xml',
  svg: 'xml',
  markup: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  go: 'go',
  golang: 'go',
  ruby: 'ruby',
  rb: 'ruby',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  cs: 'csharp',
  'c#': 'csharp',
  dotnet: 'csharp',
  sql: 'sql',
  swift: 'swift',
  kotlin: 'kotlin',
  kt: 'kotlin',
  java: 'java',
  objectivec: 'objectivec',
  objc: 'objectivec',
  php: 'php',
  dart: 'dart',
  scala: 'scala',
  lua: 'lua',
  perl: 'perl',
  r: 'r',
  haskell: 'haskell',
  hs: 'haskell',
  docker: 'docker',
  dockerfile: 'docker',
  diff: 'diff',
  patch: 'diff',
  ini: 'ini',
  env: 'ini',
  dotenv: 'ini',
  powershell: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  protobuf: 'protobuf',
  proto: 'protobuf',
  groovy: 'groovy',
  gradle: 'groovy',
}

/** Language tags the Files tab can pass that deliberately edit as plain text:
 * `csv`/`tsv` have no syntax to colour, and CodeMirror ships no grammar for
 * Elixir, GraphQL or Kusto (the viewer still colours those three with Prism).
 * Named here so the test that walks the server's vocabulary can tell "plain on
 * purpose" from "forgotten". */
export const PLAIN_EDITOR_LANGUAGES: readonly string[] = [
  'csv',
  'tsv',
  'elixir',
  'graphql',
  'kql',
]

/** Resolve a free-form language token to the grammar it edits with, or
 * `undefined` for plain text (unknown, empty, or deliberately plain). */
export function editorLanguageId(
  token: string | null | undefined,
): EditorLanguageId | undefined {
  if (!token) return undefined
  const key = token.toLowerCase()
  return Object.prototype.hasOwnProperty.call(EDITOR_LANGUAGE, key)
    ? EDITOR_LANGUAGE[key]
    : undefined
}

function stream(parser: StreamParser<unknown>): Extension {
  return StreamLanguage.define(parser)
}

/** One lazy loader per grammar. Each `import()` is a literal so the bundler
 * can split it into its own chunk. */
export const EDITOR_LANGUAGE_LOADERS: Record<EditorLanguageId, () => Promise<Extension>> = {
  rust: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  tsx: () =>
    import('@codemirror/lang-javascript').then((m) =>
      m.javascript({ jsx: true, typescript: true }),
    ),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  scss: () => import('@codemirror/legacy-modes/mode/css').then((m) => stream(m.sCSS)),
  less: () => import('@codemirror/legacy-modes/mode/css').then((m) => stream(m.less)),
  shell: () => import('@codemirror/legacy-modes/mode/shell').then((m) => stream(m.shell)),
  toml: () => import('@codemirror/legacy-modes/mode/toml').then((m) => stream(m.toml)),
  swift: () => import('@codemirror/legacy-modes/mode/swift').then((m) => stream(m.swift)),
  c: () => import('@codemirror/legacy-modes/mode/clike').then((m) => stream(m.c)),
  cpp: () => import('@codemirror/legacy-modes/mode/clike').then((m) => stream(m.cpp)),
  csharp: () => import('@codemirror/legacy-modes/mode/clike').then((m) => stream(m.csharp)),
  java: () => import('@codemirror/legacy-modes/mode/clike').then((m) => stream(m.java)),
  kotlin: () => import('@codemirror/legacy-modes/mode/clike').then((m) => stream(m.kotlin)),
  objectivec: () =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => stream(m.objectiveC)),
  dart: () => import('@codemirror/legacy-modes/mode/clike').then((m) => stream(m.dart)),
  scala: () => import('@codemirror/legacy-modes/mode/clike').then((m) => stream(m.scala)),
  ruby: () => import('@codemirror/legacy-modes/mode/ruby').then((m) => stream(m.ruby)),
  lua: () => import('@codemirror/legacy-modes/mode/lua').then((m) => stream(m.lua)),
  perl: () => import('@codemirror/legacy-modes/mode/perl').then((m) => stream(m.perl)),
  r: () => import('@codemirror/legacy-modes/mode/r').then((m) => stream(m.r)),
  haskell: () => import('@codemirror/legacy-modes/mode/haskell').then((m) => stream(m.haskell)),
  docker: () =>
    import('@codemirror/legacy-modes/mode/dockerfile').then((m) => stream(m.dockerFile)),
  diff: () => import('@codemirror/legacy-modes/mode/diff').then((m) => stream(m.diff)),
  ini: () =>
    import('@codemirror/legacy-modes/mode/properties').then((m) => stream(m.properties)),
  powershell: () =>
    import('@codemirror/legacy-modes/mode/powershell').then((m) => stream(m.powerShell)),
  protobuf: () =>
    import('@codemirror/legacy-modes/mode/protobuf').then((m) => stream(m.protobuf)),
  groovy: () => import('@codemirror/legacy-modes/mode/groovy').then((m) => stream(m.groovy)),
}

/** The longest document (in characters) the editor still parses for colours
 * (naru task 2803). Measured on Rust source: up to 2 MB typing costs what it
 * does on a small file; from 3 MB the parse adds ~20 ms to every keystroke
 * near the end of the file, where the colours also arrive seconds late.
 * Plain text holds its typing speed up to the server's 5 MiB edit cap, so
 * past this the file is edited without a grammar rather than not at all. */
export const HIGHLIGHT_MAX_CHARS = 2 * 1024 * 1024

/** Whether a document of `length` characters gets its grammar. */
export function highlightsAt(length: number): boolean {
  return length <= HIGHLIGHT_MAX_CHARS
}

/** The CodeMirror extension for a language token, or `null` for plain text.
 * Resolves `null` rather than rejecting when a chunk fails to load: an editor
 * without colours is still an editor. */
export function loadEditorLanguage(token: string | null | undefined): Promise<Extension | null> {
  const id = editorLanguageId(token)
  if (id === undefined) return Promise.resolve(null)
  return EDITOR_LANGUAGE_LOADERS[id]().catch(() => null)
}
