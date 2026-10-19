import { useRef, useState } from 'react'
import { importWorkflow } from '../api'
import { importHeadline, missingLines, parseExportFile } from '../workflowImport'
import { workflowHref } from '../workflowOverview'
import type { WorkflowImportResult } from '../types/WorkflowImportResult'

/**
 * `import…` — picks a workflow export file and uploads it (naru task 2102).
 * The result panel stays until dismissed so the person can read what the
 * imported graph names that this instance lacks before enabling it; a
 * failure is an inline `.error`. Rendered on the global Workflows page and a
 * project's (`projectId` binds the import to that project).
 */
export function WorkflowImportControl({
  projectId,
  onImported,
}: {
  projectId?: number
  onImported?: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<WorkflowImportResult | null>(null)

  function pick(file: File | undefined) {
    if (!file) return
    setError(null)
    setResult(null)
    setBusy(true)
    file
      .text()
      .then((text) => {
        const parsed = parseExportFile(text)
        if ('error' in parsed) throw new Error(parsed.error)
        return importWorkflow(parsed.document, projectId)
      })
      .then(
        (r) => {
          setResult(r)
          onImported?.()
        },
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false))
  }

  return (
    <>
      <button type="button" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'importing…' : 'import…'}
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label="Workflow export file"
        onChange={(e) => {
          pick(e.target.files?.[0])
          // Reset so the same file can be picked again.
          e.target.value = ''
        }}
      />
      {error && <span className="error">{error}</span>}
      {result && (
        <div className="workflow-import-panel" role="status">
          <p>
            {importHeadline(result)} ·{' '}
            <a href={workflowHref(result.workflow)}>open</a>{' '}
            <button type="button" onClick={() => setResult(null)}>
              dismiss
            </button>
          </p>
          {result.warnings.map((w) => (
            <p key={w} className="muted">
              {w}
            </p>
          ))}
          {result.missing.length === 0 ? (
            <p className="muted">No missing references.</p>
          ) : (
            <>
              <p className="muted">Missing here — fix these before enabling:</p>
              <ul className="muted">
                {missingLines(result).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  )
}
