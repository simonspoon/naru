import type { WorkflowImportResult } from './types/WorkflowImportResult'

/** The file `naru workflow export` writes (naru task 2102). */
export const EXPORT_FORMAT = 'naru-workflow'

/**
 * Cheap pre-flight on a picked file: it must be JSON, an object, with the
 * right `format`. The server judges everything else (version, graph) and its
 * message is shown as-is; this only spares a round trip for an obviously
 * wrong file.
 */
export function parseExportFile(text: string): { document: Record<string, unknown> } | { error: string } {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { error: 'That file is not JSON, so it is not a Naru workflow export.' }
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { error: 'That file is not a Naru workflow export (expected a JSON object).' }
  }
  const d = doc as Record<string, unknown>
  if (d.format !== EXPORT_FORMAT) {
    return { error: `That file is not a Naru workflow export (its "format" is not "${EXPORT_FORMAT}").` }
  }
  return { document: d }
}

/** One line per thing the imported graph names that this instance lacks. */
export function missingLines(result: WorkflowImportResult): string[] {
  return result.missing.map(
    (m) => `${m.node_title} (${m.kind}): ${m.what} "${m.reference}" not found here`,
  )
}

/** The panel headline: what was created, and under what name. */
export function importHeadline(result: WorkflowImportResult): string {
  const renamed = result.renamed_from ? ` — renamed from "${result.renamed_from}"` : ''
  return `Imported "${result.workflow.name}" — disabled${renamed}`
}

/** The filename the server proposed in `Content-Disposition`, else a fallback. */
export function downloadName(header: string | null, fallback: string): string {
  if (!header) return fallback
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim())
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="((?:[^"\\]|\\.)*)"/i.exec(header)
  return plain ? plain[1].replace(/\\(.)/g, '$1') : fallback
}
