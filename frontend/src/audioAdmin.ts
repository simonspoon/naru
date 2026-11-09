// The Audio dock panel (naru task 2676, docs/dock.md): naru-audio's own admin
// page, embedded. Naru rebuilds none of it; this module only decides where the
// page is and whether this browser can load it.
import type { AudioTestResult } from './types/AudioTestResult'

/** The admin page of the daemon at `daemonUrl` (the address in force, as the
 *  server's probe answers it). */
export function audioAdminUrl(daemonUrl: string): string {
  return `${daemonUrl.replace(/\/+$/, '')}/admin`
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || h === '::' || h === '0.0.0.0' || h.startsWith('127.')
}

/** What the panel shows: the frame, or the sentence saying why not. The probe
 *  runs on the Naru server, so a loopback daemon address only means this
 *  browser can reach it when the page itself is on a loopback host. */
export type AudioAdminView = { kind: 'frame'; src: string } | { kind: 'down'; message: string }

export function audioAdminView(probe: AudioTestResult, pageHost: string): AudioAdminView {
  if (probe.state === 'daemon_down' || probe.state === 'error') {
    return { kind: 'down', message: probe.message ?? `naru-audio is not running at ${probe.url}.` }
  }
  let daemonHost: string
  try {
    daemonHost = new URL(probe.url).hostname
  } catch {
    return { kind: 'down', message: `naru-audio's address is not a URL: ${probe.url}` }
  }
  if (isLoopback(daemonHost) && !isLoopback(pageHost)) {
    return {
      kind: 'down',
      message: `naru-audio listens at ${probe.url} on the Naru server's own machine, which this browser cannot reach. Open Naru on that machine to use its admin page.`,
    }
  }
  return { kind: 'frame', src: audioAdminUrl(probe.url) }
}
