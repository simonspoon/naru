/**
 * Level helpers for the conversation mark (mesa task 1544). The aperture
 * canvas this file used to draw is gone — `liveMark.ts` and
 * `components/NaruMark.tsx` draw the Naru waveform now — and what is left is
 * the two numbers it still shares.
 */

/**
 * A level meter needs a fast attack and a slow release to be readable: jump
 * up the instant a sound arrives (so the meter doesn't lag behind speech
 * starting) but fall back down gradually (so it doesn't flicker to zero in
 * the gaps between syllables). `0.55` vs `0.14` is the ported mockup's own
 * tuning — ported rather than re-derived, since it is the number that made
 * the reference read as continuous motion rather than a series of steps.
 */
export function smoothLevel(prev: number, raw: number): number {
  return prev + (raw - prev) * (raw > prev ? 0.55 : 0.14)
}

/**
 * mesa's simulated speaking envelope — now only the **fallback**. Real
 * playback is tapped through an `AnalyserNode` on both paths
 * (`speechTap.ts`), and the mark reads that; this is drawn only when the
 * `<audio>` element could not be tapped. A slow phrase-shaped rise and fall with two
 * faster, mutually awkward syllable oscillations riding on top of it, which
 * is what makes the drawing read as a voice rather than as a metronome. This
 * is the mockup's own `simLevel`, ported unchanged.
 */
export function simEnvelope(t: number): number {
  const phrase = Math.max(0, Math.sin(t * 0.34) * 0.5 + 0.42)
  const syll = 0.5 + 0.5 * Math.sin(t * 11.3)
  const syll2 = 0.5 + 0.5 * Math.sin(t * 7.1 + 1.4)
  return Math.min(1, phrase * (0.35 + 0.5 * syll * syll2 + 0.15 * Math.sin(t * 23)))
}
