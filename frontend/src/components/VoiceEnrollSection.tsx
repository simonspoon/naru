import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteVoiceEnrollment, getVoiceEnrollment, saveVoiceEnrollment } from '../api'
import {
  downsample,
  encodeWav,
  frameRms,
  PCM_WORKLET_SOURCE,
  TARGET_SAMPLE_RATE,
  toBase64,
  toPcm16,
} from '../liveAudio'
import { detectNativeHost } from '../nativeHost'
import { useFetch } from '../useFetch'
import {
  awaitingMacApp,
  canStop,
  clock,
  meterFraction,
  MIN_SECONDS,
  nearSilent,
  peakDb,
  promptAt,
  shouldAutoStop,
  STOP_SECONDS,
  statusLine,
  TARGET_SECONDS,
} from '../voiceEnroll'
import { ConfirmDelete } from './ConfirmDelete'

/** How long to keep asking whether the Mac app has built the enrollment. */
const POLL_MAX_MS = 2 * 60 * 1000

type Take = { wav: Uint8Array; seconds: number; peak: number }

/** Live capture handles, kept in a ref so unmount can release the mic. */
type Capture = {
  stream: MediaStream
  ctx: AudioContext
  node: AudioWorkletNode
  source: MediaStreamAudioSourceNode
  blobUrl: string
  frames: Float32Array[]
  lastRms: number
  startedAt: number
}

/**
 * Settings > Voice: record ~90 s of the person's voice for the voice guard
 * (naru task 1744, `docs/voice-enrollment.md`). The server only keeps the WAV;
 * the Naru Mac app builds `ambient-enrollment.json` from it. Logic lives in
 * `voiceEnroll.ts`.
 */
export function VoiceEnrollSection() {
  const { data: status, error, refetch } = useFetch(() => getVoiceEnrollment(), 'voice-enrollment')
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [take, setTake] = useState<Take | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const capture = useRef<Capture | null>(null)
  const mounted = useRef(true)

  const release = useCallback(() => {
    const cap = capture.current
    capture.current = null
    if (!cap) return
    cap.node.port.onmessage = null
    cap.source.disconnect()
    cap.node.disconnect()
    cap.stream.getTracks().forEach((t) => t.stop())
    void cap.ctx.close()
    URL.revokeObjectURL(cap.blobUrl)
  }, [])

  // The mic is released however the section goes away.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      release()
    }
  }, [release])

  // Poll while a saved sample waits for the Mac app's enrollment file.
  const waiting = awaitingMacApp(status)
  useEffect(() => {
    if (!waiting) return
    const until = Date.now() + POLL_MAX_MS
    const id = window.setInterval(() => {
      if (Date.now() >= until) window.clearInterval(id)
      else if (!document.hidden) refetch()
    }, 3000)
    return () => window.clearInterval(id)
  }, [waiting, refetch])

  const stop = useCallback(() => {
    const cap = capture.current
    if (!cap) return
    const samples = new Float32Array(cap.frames.reduce((n, f) => n + f.length, 0))
    let offset = 0
    for (const f of cap.frames) {
      samples.set(f, offset)
      offset += f.length
    }
    const rate = cap.ctx.sampleRate
    release()
    setRecording(false)
    setLevel(0)
    const pcm = toPcm16(downsample(samples, rate, TARGET_SAMPLE_RATE))
    // Length of what will be saved, not the wall clock: the server judges samples.
    setTake({
      wav: encodeWav(pcm, TARGET_SAMPLE_RATE),
      seconds: pcm.length / TARGET_SAMPLE_RATE,
      peak: peakDb(samples),
    })
  }, [release])

  // The clock: elapsed, the meter, and the auto-stop at the target.
  useEffect(() => {
    if (!recording) return
    const id = window.setInterval(() => {
      const cap = capture.current
      if (!cap) return
      const t = (performance.now() - cap.startedAt) / 1000
      setElapsed(t)
      setLevel(meterFraction(cap.lastRms))
      if (shouldAutoStop(t)) stop()
    }, 100)
    return () => window.clearInterval(id)
  }, [recording, stop])

  async function start() {
    if (starting || capture.current) return
    setStarting(true)
    setProblem(null)
    setTake(null)
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let blobUrl: string | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      try {
        ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      } catch {
        ctx = new AudioContext()
      }
      await ctx.resume()
      blobUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'text/javascript' }))
      await ctx.audioWorklet.addModule(blobUrl)
      const node = new AudioWorkletNode(ctx, 'mesa-pcm')
      const source = ctx.createMediaStreamSource(stream)
      const cap: Capture = {
        stream,
        ctx,
        node,
        source,
        blobUrl,
        frames: [],
        lastRms: 0,
        startedAt: performance.now(),
      }
      node.port.onmessage = (e) => {
        const frame = e.data as Float32Array
        cap.frames.push(frame)
        cap.lastRms = frameRms(frame)
      }
      // Not connected onward: that would play the microphone back.
      source.connect(node)
      capture.current = cap
      if (!mounted.current) {
        // Unmounted while the awaits ran: nothing will ever stop this capture.
        release()
        return
      }
      setElapsed(0)
      setRecording(true)
    } catch (e) {
      // Whatever was opened before the failure must not outlive it.
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      if (mounted.current) {
        setProblem(
          e instanceof Error
            ? `Could not open the microphone: ${e.message}`
            : 'Could not open the microphone.',
        )
      }
    } finally {
      if (mounted.current) setStarting(false)
    }
  }

  function save() {
    if (!take) return
    setBusy(true)
    setProblem(null)
    saveVoiceEnrollment(toBase64(take.wav)).then(
      () => {
        setBusy(false)
        setTake(null)
        // Tell the Naru Mac app, when we are inside it, to build the enrollment.
        detectNativeHost(window as unknown as Record<string, unknown>)?.post({ type: 'enroll' })
        refetch()
      },
      (e: unknown) => {
        setBusy(false)
        setProblem(e instanceof Error ? e.message : String(e))
      },
    )
  }

  const prompt = promptAt(elapsed)
  const silent = take ? nearSilent(take.peak) : false

  return (
    <>
      <h2>Voice guard enrollment</h2>
      <section className="settings-command">
        <p className="muted settings-command-blurb">
          Record about {TARGET_SECONDS} seconds of your voice so the voice guard can tell you from
          everyone else. Read the paragraph, then answer the short prompts. The Naru Mac app
          builds the enrollment from the recording.
        </p>
        {error && <p className="error">{error}</p>}
        <p className="voice-enroll-status">{statusLine(status)}</p>

        {recording && (
          <div className="voice-enroll-live">
            <div className="voice-enroll-meter" aria-label="microphone level">
              <div className="voice-enroll-meter-fill" style={{ width: `${level * 100}%` }} />
            </div>
            <p className="voice-enroll-clock">
              {clock(elapsed)} / {clock(TARGET_SECONDS)}
            </p>
            <p className={prompt.kind === 'script' ? 'voice-enroll-script' : 'voice-enroll-reply'}>
              {prompt.text}
            </p>
          </div>
        )}

        {take && !recording && (
          <div className="voice-enroll-take">
            <p>
              Recorded {clock(take.seconds)}; peak level {take.peak.toFixed(0)} dBFS.
            </p>
            {take.seconds < MIN_SECONDS && (
              <p className="error">
                That is shorter than the {MIN_SECONDS} seconds needed. Record again.
              </p>
            )}
            {silent && (
              <p className="error">
                Your mic barely picked anything up — check the input device / mic permission.
              </p>
            )}
          </div>
        )}

        {problem && <p className="error">{problem}</p>}

        <div className="settings-actions">
          {recording ? (
            <button type="button" disabled={!canStop(elapsed)} onClick={stop}>
              {canStop(elapsed) ? 'stop' : `stop (from ${STOP_SECONDS} s)`}
            </button>
          ) : take ? (
            <>
              <button
                type="button"
                disabled={busy || silent || take.seconds < MIN_SECONDS}
                onClick={save}
              >
                {busy ? 'saving…' : 'save'}
              </button>
              <button type="button" disabled={busy || starting} onClick={() => void start()}>
                re-record
              </button>
            </>
          ) : (
            <>
              <button type="button" disabled={starting} onClick={() => void start()}>
                {starting
                  ? 'opening microphone…'
                  : status?.sample
                    ? 'Re-record'
                    : 'Record your voice'}
              </button>
              {(status?.sample || status?.enrolled_at) && (
                <ConfirmDelete
                  label="delete"
                  message="Removes the recording and the enrollment; the voice guard turns off."
                  onDelete={() => deleteVoiceEnrollment().then(() => refetch())}
                />
              )}
            </>
          )}
        </div>
      </section>
    </>
  )
}
