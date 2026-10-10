import type { Status } from './types/Status'

/** How a task status reads on screen. The stored (and API) value `todo` is
 * shown as "queued" (naru task 1765); every other status shows as stored.
 * Display only: never send this back to the API. */
export function statusLabel(status: Status): string {
  return status === 'todo' ? 'queued' : status
}
