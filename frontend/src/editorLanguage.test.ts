import { describe, expect, it } from 'vitest'
import {
  EDITOR_LANGUAGE_LOADERS,
  PLAIN_EDITOR_LANGUAGES,
  editorLanguageId,
  loadEditorLanguage,
} from './editorLanguage'

/** Every tag the server's `core::files::language_of` / `language_of_name` can
 * give a file — the `language` the Files tab hands the editor verbatim. */
const SERVER_TAGS = [
  'c', 'cpp', 'csharp', 'css', 'csv', 'dart', 'diff', 'docker', 'elixir', 'go',
  'graphql', 'groovy', 'haskell', 'html', 'ini', 'java', 'javascript', 'json',
  'kotlin', 'kql', 'less', 'lua', 'makefile', 'markdown', 'objectivec', 'perl',
  'php', 'powershell', 'protobuf', 'python', 'r', 'ruby', 'rust', 'scala',
  'scss', 'shell', 'sql', 'svg', 'swift', 'toml', 'tsv', 'typescript', 'xml',
  'yaml',
]

/** What the form mounts pass: the Scripts body (`sh`), the Library body
 * (`sh`, `md`, `html`) and the Artifacts body (`markdown`, `svg`, `html`). */
const FORM_TAGS = ['sh', 'md', 'html', 'markdown', 'svg']

describe('editorLanguageId', () => {
  it('resolves every server tag to a grammar, or names it plain on purpose', () => {
    for (const tag of SERVER_TAGS) {
      const plain = PLAIN_EDITOR_LANGUAGES.includes(tag)
      expect(editorLanguageId(tag) !== undefined, tag).toBe(!plain)
    }
  })

  it('resolves every tag the form mounts pass', () => {
    for (const tag of FORM_TAGS) expect(editorLanguageId(tag), tag).toBeDefined()
  })

  it('covers the languages the task names', () => {
    expect(editorLanguageId('rust')).toBe('rust')
    expect(editorLanguageId('json')).toBe('json')
    expect(editorLanguageId('markdown')).toBe('markdown')
    expect(editorLanguageId('python')).toBe('python')
    expect(editorLanguageId('shell')).toBe('shell')
    expect(editorLanguageId('toml')).toBe('toml')
    expect(editorLanguageId('yaml')).toBe('yaml')
    expect(editorLanguageId('sql')).toBe('sql')
    expect(editorLanguageId('swift')).toBe('swift')
    expect(editorLanguageId('go')).toBe('go')
    expect(editorLanguageId('css')).toBe('css')
  })

  it('edits .tsx and .jsx files, tagged by their base language, with JSX on', () => {
    expect(editorLanguageId('typescript')).toBe('tsx')
    expect(editorLanguageId('javascript')).toBe('jsx')
  })

  it('resolves a token whatever case it arrives in', () => {
    expect(editorLanguageId('Rust')).toBe('rust')
    expect(editorLanguageId('C#')).toBe('csharp')
  })

  it('is undefined for an unknown, absent or inherited-name token', () => {
    expect(editorLanguageId('brainfuck')).toBeUndefined()
    expect(editorLanguageId('')).toBeUndefined()
    expect(editorLanguageId(null)).toBeUndefined()
    expect(editorLanguageId(undefined)).toBeUndefined()
    // Not a key of the table, only of Object.prototype.
    expect(editorLanguageId('constructor')).toBeUndefined()
    expect(editorLanguageId('toString')).toBeUndefined()
  })
})

describe('loadEditorLanguage', () => {
  it('loads a real extension for every grammar in the table', async () => {
    for (const id of Object.keys(EDITOR_LANGUAGE_LOADERS)) {
      expect(await loadEditorLanguage(id), id).not.toBeNull()
    }
  })

  it('answers null, not a rejection, for plain text', async () => {
    expect(await loadEditorLanguage(null)).toBeNull()
    expect(await loadEditorLanguage('csv')).toBeNull()
    expect(await loadEditorLanguage('brainfuck')).toBeNull()
  })
})
