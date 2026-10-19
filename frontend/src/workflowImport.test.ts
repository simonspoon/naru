import { describe, expect, it } from 'vitest'
import { downloadName, importHeadline, missingLines, parseExportFile } from './workflowImport'
import type { WorkflowImportResult } from './types/WorkflowImportResult'

const result = (over: Partial<WorkflowImportResult> = {}): WorkflowImportResult =>
  ({
    workflow: { name: 'Flow (imported)' },
    renamed_from: 'Flow',
    missing: [{ node_id: 1, node_title: 'Plan', kind: 'agent', what: 'agent', reference: 'planner' }],
    warnings: [],
    nodes: [],
    edges: [],
    ...over,
  }) as unknown as WorkflowImportResult

describe('parseExportFile', () => {
  it('accepts an export object', () => {
    expect('document' in parseExportFile('{"format":"naru-workflow","version":1}')).toBe(true)
  })
  it('rejects non-JSON, arrays and a wrong format', () => {
    for (const t of ['nope', '[]', '{"format":"x"}', '{}']) {
      expect('error' in parseExportFile(t)).toBe(true)
    }
  })
})

describe('import summary', () => {
  it('names the rename', () => {
    expect(importHeadline(result())).toBe('Imported "Flow (imported)" — disabled — renamed from "Flow"')
    expect(importHeadline(result({ renamed_from: null }))).toBe('Imported "Flow (imported)" — disabled')
  })
  it('lists missing references', () => {
    expect(missingLines(result())).toEqual(['Plan (agent): agent "planner" not found here'])
  })
})

describe('downloadName', () => {
  it('prefers the extended form', () => {
    expect(downloadName(`attachment; filename="a.json"; filename*=UTF-8''b%20c.json`, 'x')).toBe('b c.json')
  })
  it('reads the plain form and falls back', () => {
    expect(downloadName('attachment; filename="a.json"', 'x')).toBe('a.json')
    expect(downloadName(null, 'x')).toBe('x')
  })
})
