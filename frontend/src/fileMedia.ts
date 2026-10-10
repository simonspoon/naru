/** The playable-media allowlist, keyed off a path's lowercased final
 * extension (naru task 1751). A MIRROR of `core::files::media_mime` in the
 * Rust crate, the way `fileImage.ts` mirrors `image_mime`: the server decides
 * what `/files/raw` will serve as media, the client decides what it renders
 * as a player. Keep the two in step.
 *
 * `mov` and `m4a` play only when the browser has the codec; the player's
 * `error` event is what falls back to a download link. */
const MEDIA: Record<string, { kind: 'video' | 'audio'; mime: string }> = {
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  webm: { kind: 'video', mime: 'video/webm' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  oga: { kind: 'audio', mime: 'audio/ogg' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  flac: { kind: 'audio', mime: 'audio/flac' },
}

export type MediaKind = 'video' | 'audio'

function entryFor(path: string) {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  // `dot <= 0`: no extension, or a dotfile (`.mp4` is a file called mp4).
  if (dot <= 0) return null
  return MEDIA[base.slice(dot + 1).toLowerCase()] ?? null
}

/** `'video'` / `'audio'` for an allowlisted media path, else `null`. */
export function mediaKindForPath(path: string): MediaKind | null {
  return entryFor(path)?.kind ?? null
}

/** The MIME type the raw route serves this path as, or `null`. */
export function mediaMimeForPath(path: string): string | null {
  return entryFor(path)?.mime ?? null
}

/** Whether this path should be rendered as a video/audio player. */
export function isMediaPath(path: string): boolean {
  return entryFor(path) !== null
}
