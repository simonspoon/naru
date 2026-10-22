import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addVoiceClip,
  addVoicePerson,
  deleteVoiceClip,
  deleteVoicePerson,
  getVoicePeople,
  patchVoicePerson,
  setVoiceGuard,
} from '../api'
import {
  downsample,
  encodeWav,
  frameRms,
  PCM_WORKLET_SOURCE,
  TARGET_SAMPLE_RATE,
  toBase64,
  toPcm16,
} from '../liveAudio'
import { detectNativeHost, onEnrollStatus, type EnrollStatus } from '../nativeHost'
import { useFetch } from '../useFetch'
import {
  canStop,
  clock,
  meterFraction,
  meterStep,
  MIN_SECONDS,
  nearSilent,
  peakDb,
  READ_ALOUD,
  shouldAutoStop,
  startNativeEnroll,
  STOP_SECONDS,
  TARGET_SECONDS,
} from '../voiceEnroll'
import {
  canPlay,
  cleanName,
  clipAudioUrl,
  clipCount,
  clipLine,
  enrollFinished,
  nativeRecording,
  nativeRowLine,
  askNative,
  observeAsk,
  type NativeAsk,
  GUARD_NOTE,
  sortPeople,
  type VoicePerson,
} from '../voicePeople'
import { ConfirmDelete } from './ConfirmDelete'

type Take = { wav: Uint8Array; seconds: number; peak: number }

/** Live capture handles, kept in a ref so unmount can release the mic. */
type Capture = {
  stream: MediaStream
  ctx: AudioContext
  node: AudioWorkletNode
  source: MediaStreamAudioSourceNode
  blobUrl: string
  frames: Float32Array[]
  /** Loudest frame RMS since the last meter tick. */
  windowPeakRms: number
  startedAt: number
}

/**
 * Records one clip in the browser (getUserMedia, echo cancellation, noise
 * suppression and auto gain off) and uploads it to a person. Logic lives in
 * `voiceEnroll.ts`.
 */
function ClipRecorder({
  personId,
  onSaved,
  onCancel,
}: {
  personId: number
  onSaved: () => void
  onCancel: () => void
}) {
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

  // The mic is released however the recorder goes away.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      release()
    }
  }, [release])

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
      // Read before the reset: React runs the updater later, after it.
      const target = meterFraction(cap.windowPeakRms)
      cap.windowPeakRms = 0
      setLevel((prev) => meterStep(prev, target))
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
        windowPeakRms: 0,
        startedAt: performance.now(),
      }
      node.port.onmessage = (e) => {
        const frame = e.data as Float32Array
        cap.frames.push(frame)
        cap.windowPeakRms = Math.max(cap.windowPeakRms, frameRms(frame))
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
    addVoiceClip(personId, toBase64(take.wav)).then(
      () => {
        setBusy(false)
        setTake(null)
        onSaved()
      },
      (e: unknown) => {
        setBusy(false)
        setProblem(e instanceof Error ? e.message : String(e))
      },
    )
  }

  const silent = take ? nearSilent(take.peak) : false

  return (
    <div className="voice-people-recorder">
      <p className="muted settings-command-blurb">
        Read the text aloud at a normal pace; it stops by itself at {TARGET_SECONDS} s. One clip
        works for every mic.
      </p>
      {recording && (
        <div className="voice-enroll-live">
          <div className="voice-enroll-meter" aria-label="microphone level">
            <div className="voice-enroll-meter-fill" style={{ width: `${level * 100}%` }} />
          </div>
          <p className="voice-enroll-clock">
            {clock(elapsed)} / {clock(TARGET_SECONDS)}
          </p>
          <p className="voice-enroll-script">{READ_ALOUD}</p>
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
              {busy ? 'saving…' : 'save clip'}
            </button>
            <button type="button" disabled={busy || starting} onClick={() => void start()}>
              re-record
            </button>
            <button type="button" disabled={busy} onClick={onCancel}>
              cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={starting} onClick={() => void start()}>
              {starting ? 'opening microphone…' : 'record'}
            </button>
            <button type="button" disabled={starting} onClick={onCancel}>
              cancel
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** One person: name, "me" marker, clips, and the actions on them. */
function PersonRow({
  person,
  onChanged,
  onFail,
  hostStatus,
  ask,
  onAsk,
  recorder,
  onRecorder,
  busy,
}: {
  person: VoicePerson
  onChanged: () => Promise<void>
  onFail: (message: string) => void
  hostStatus: EnrollStatus | null
  /** This row asked the Mac app to record; its status is shown here. */
  ask: NativeAsk | null
  onAsk: () => void
  /** This row's browser recorder is open. */
  recorder: boolean
  onRecorder: (open: boolean) => void
  /** Some recording, in the browser or the app, is running anywhere. */
  busy: boolean
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)

  useEffect(
    () => () => {
      audio.current?.pause()
      audio.current = null
    },
    [],
  )

  const run = (work: Promise<unknown>) =>
    work.then(onChanged).catch((e: unknown) => onFail(e instanceof Error ? e.message : String(e)))

  function addClip() {
    const host = detectNativeHost(window as unknown as Record<string, unknown>)
    // Inside the Mac app the app records; the page opens no microphone.
    if (host) {
      onAsk()
      startNativeEnroll(host, person.id)
    } else onRecorder(true)
  }

  function play(clipId: number) {
    audio.current?.pause()
    if (playing === clipId) {
      audio.current = null
      setPlaying(null)
      return
    }
    const el = new Audio(clipAudioUrl(person.id, clipId))
    audio.current = el
    setPlaying(clipId)
    const done = () => {
      if (audio.current === el) {
        audio.current = null
        setPlaying(null)
      }
    }
    el.onended = done
    el.onerror = () => {
      done()
      onFail('Could not play that clip.')
    }
    void el.play().catch(done)
  }

  const newName = renaming === null ? null : cleanName(renaming)
  const nativeLine = ask ? nativeRowLine(ask, hostStatus) : null
  const recordingNative = !!ask && !ask.answer && nativeRecording(hostStatus, person.id)

  // The editor stays open with the typed name when the PATCH fails.
  function rename() {
    if (!newName) return
    patchVoicePerson(person.id, { name: newName })
      .then(onChanged)
      .then(() => setRenaming(null))
      .catch((e: unknown) => onFail(e instanceof Error ? e.message : String(e)))
  }

  return (
    <li className="voice-person">
      <div className="voice-person-head">
        {renaming === null ? (
          <strong>{person.name}</strong>
        ) : (
          <input
            type="text"
            value={renaming}
            aria-label={`new name for ${person.name}`}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName) {
                e.preventDefault()
                rename()
              } else if (e.key === 'Escape') setRenaming(null)
            }}
          />
        )}
        {person.owner && <span className="voice-person-me">me</span>}
        <span className="muted">{clipCount(person)}</span>
      </div>
      <div className="settings-actions">
        {renaming === null ? (
          <button type="button" onClick={() => setRenaming(person.name)}>
            rename
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={!newName}
              onClick={rename}
            >
              save name
            </button>
            <button type="button" onClick={() => setRenaming(null)}>
              cancel
            </button>
          </>
        )}
        {!person.owner && (
          <button
            type="button"
            onClick={() => void run(patchVoicePerson(person.id, { owner: true }))}
          >
            this is me
          </button>
        )}
        <button type="button" disabled={busy} onClick={addClip}>
          add clip
        </button>
        <ConfirmDelete
          label="delete"
          message={`Removes ${person.name} and ${clipCount(person)}.`}
          onDelete={() => deleteVoicePerson(person.id).then(onChanged)}
        />
      </div>
      {nativeLine && <p className="voice-enroll-status">{nativeLine}</p>}
      {recordingNative && <p className="voice-enroll-script">{READ_ALOUD}</p>}
      {recorder && (
        <ClipRecorder
          personId={person.id}
          onCancel={() => onRecorder(false)}
          onSaved={() => {
            onRecorder(false)
            void onChanged()
          }}
        />
      )}
      {person.clips.length > 0 && (
        <ul className="voice-clips">
          {person.clips.map((clip) => (
            <li key={clip.id}>
              <span className={canPlay(clip) ? undefined : 'muted'}>{clipLine(clip)}</span>{' '}
              {canPlay(clip) && (
                <button
                  type="button"
                  aria-label={`${playing === clip.id ? 'stop' : 'play'} clip ${clip.id}`}
                  onClick={() => play(clip.id)}
                >
                  {playing === clip.id ? 'stop' : 'play'}
                </button>
              )}{' '}
              <button
                type="button"
                aria-label={`delete clip ${clip.id}`}
                onClick={() => void run(deleteVoiceClip(person.id, clip.id))}
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * Settings > Voice: the people voice library and the live voice guard switch
 * (naru task 2262, `docs/voice-enrollment.md`). The library is naru-audio's;
 * Naru relays it. Inside the Naru Mac app a clip is recorded by the app
 * (`{type:'enroll', op:'start', person}` on the bridge, progress back through
 * `enrollStatus`); in a plain browser it is recorded here. Logic lives in
 * `voicePeople.ts` and `voiceEnroll.ts`.
 */
export function VoicePeopleSection() {
  const { data, error, refetch } = useFetch(() => getVoicePeople(), 'voice-people')
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [guard, setGuard] = useState<boolean | null>(null)
  const [guardBusy, setGuardBusy] = useState(false)
  const [hostStatus, setHostStatus] = useState<EnrollStatus | null>(null)
  const lastHost = useRef<EnrollStatus | null>(null)
  // The one row the Mac app was asked to record for, and the one with a browser recorder open.
  const [ask, setAsk] = useState<NativeAsk | null>(null)
  const [recorderId, setRecorderId] = useState<number | null>(null)

  // The Mac app's recording progress; a finished recording refreshes the list.
  useEffect(
    () =>
      onEnrollStatus((next) => {
        // The replay on subscribe hands back the object already seen: stale, not an answer.
        const fresh = next !== lastHost.current
        const finished = enrollFinished(lastHost.current, next)
        lastHost.current = next
        setAsk((a) => observeAsk(a, next, fresh))
        setHostStatus(next)
        if (finished) void refetch()
      }),
    [refetch],
  )

  const people = data ? sortPeople(data.people) : []
  const guardOn = guard ?? data?.live_guard ?? false
  const newName = cleanName(name)

  const changed = useCallback(() => {
    setProblem(null)
    return refetch()
  }, [refetch])

  function add() {
    if (!newName) return
    const owner = people.length === 0
    addVoicePerson(newName, owner).then(
      () => {
        setName('')
        void changed()
      },
      (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
    )
  }

  function toggleGuard(live: boolean) {
    setGuardBusy(true)
    setProblem(null)
    setGuard(live)
    setVoiceGuard(live).then(
      () => {
        setGuardBusy(false)
        void refetch().finally(() => setGuard(null))
      },
      (e: unknown) => {
        setGuardBusy(false)
        setGuard(null)
        setProblem(e instanceof Error ? e.message : String(e))
      },
    )
  }

  return (
    <>
      <h2>People</h2>
      <section className="settings-command">
        <p className="muted settings-command-blurb">
          The voices Naru knows. Mark the one that is you, and add a few clips of each person — a
          recording of about 10 seconds reading the text works for every mic. Clips are kept in
          naru-audio.
        </p>
        {error && <p className="error">{error}</p>}
        {problem && <p className="error">{problem}</p>}
        {data && people.length === 0 && <p className="muted">No one yet. Add yourself first.</p>}
        <ul className="voice-people">
          {people.map((p) => (
            <PersonRow
              key={p.id}
              person={p}
              onChanged={changed}
              onFail={setProblem}
              hostStatus={hostStatus}
              ask={ask?.personId === p.id ? ask : null}
              onAsk={() => setAsk(askNative(p.id))}
              recorder={recorderId === p.id}
              onRecorder={(open) => setRecorderId(open ? p.id : null)}
              busy={recorderId !== null || !!hostStatus?.enrolling}
            />
          ))}
        </ul>
        <div className="settings-actions">
          <input
            type="text"
            value={name}
            placeholder={people.length === 0 ? 'your name' : 'add a person'}
            aria-label="new person"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
          />
          <button type="button" disabled={!data || !newName} onClick={add}>
            add
          </button>
        </div>
      </section>

      <h2>Live voice guard</h2>
      <section className="settings-command">
        <label>
          <input
            type="checkbox"
            checked={guardOn}
            disabled={!data || guardBusy}
            onChange={(e) => toggleGuard(e.target.checked)}
          />{' '}
          Drop live speech that is not me
        </label>
        <p className="muted settings-command-blurb">{GUARD_NOTE}</p>
      </section>
    </>
  )
}
