import { useEffect, useSyncExternalStore } from 'react'
import { getSpeech } from './api'
import { normalizeSpeed, SPEED_DEFAULT } from './speechSpeed'

/**
 * The one place the page learns how fast Naru speaks (mesa task 1560) — the
 * `keymapStore.ts` shape: one `GET /api/config/speech` per page, the built-in
 * 1x in force until it answers (and for good if the config routes refuse),
 * and Settings publishes a save so every player picks it up with no reload.
 * Players read it once per item (`getSpeechSpeed`), so a turn costs no fetch.
 */

let current = SPEED_DEFAULT
let started = false
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Publishes a speed the Settings page just saved. */
export function publishSpeechSpeed(speed: number): void {
  current = normalizeSpeed(speed)
  emit()
}

/** Fetches the speed once per page; later calls are no-ops. */
export function loadSpeechSpeed(): void {
  if (started) return
  started = true
  getSpeech().then(
    (speech) => publishSpeechSpeed(speech.speed),
    () => {
      // Unreadable config: the built-in speed is already in force.
    },
  )
}

/** The speed in force now, for a player starting an item. Starts the one
 *  fetch if nothing has yet. */
export function getSpeechSpeed(): number {
  loadSpeechSpeed()
  return current
}

/** The speed in force, re-rendering its caller when a save changes it. */
export function useSpeechSpeed(): number {
  useEffect(loadSpeechSpeed, [])
  return useSyncExternalStore(subscribe, () => current)
}
