import { useEffect, useRef, useState } from 'react'
import {
  addLiveMemory,
  addVoice,
  deleteLiveMemory,
  designVoice,
  exportVoice,
  getConfig,
  getKeymap,
  getAudio,
  getListen,
  getLiveConfig,
  getPricing,
  getServe,
  getSpeech,
  getSpeechDesign,
  getSystemInfo,
  getWatchers,
  listLibrary,
  listLiveMemory,
  listProjects,
  resetCcIndex,
  restartServer,
  speechPreviewUrl,
  updateConfig,
  updateKeymap,
  transcribeStatus,
  updateAudio,
  updateListen,
  updateLiveConfig,
  updateLiveMemory,
  updatePricing,
  updateServe,
  updateSpeech,
  updateWatchers,
  type CcResetReport,
} from '../api'
import { ConfirmDelete } from '../components/ConfirmDelete'
import {
  ACTIONS,
  DEFAULT_KEYMAP,
  chordFromEvent,
  chordLabel,
  formatChord,
  type KeymapAction,
} from '../keymap'
import {
  changedKeymap,
  conflictingActions,
  draftFrom as keymapDraftFrom,
  isDirty as isKeymapDirty,
  isOverridden,
  isSavable as isKeymapSavable,
  resetAll,
  withChord,
  withReset,
  type KeymapDraft,
} from '../keymapDraft'
import { publishKeymap } from '../keymapStore'
import {
  applyElementSpeed,
  formatSpeed,
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
} from '../speechSpeed'
import { publishSpeechSpeed } from '../speechSpeedStore'
import {
  bodyError as memoryBodyError,
  budgetMeter,
  isSendable as isMemorySendable,
  metaLine,
  notebookWords,
  overBudget,
} from '../memoryDraft'
import {
  SETTINGS_TABS,
  settingsTabHref,
  settingsTabLabel,
  type SettingsTab,
} from '../settingsTab'
import {
  clampPct,
  formatBytes,
  formatUptime,
  systemSeverity,
  usedPct,
} from '../systemMeter'
import {
  RATE_FIELDS,
  TIER_FIELDS,
  addTier,
  addedPricing,
  blankRates,
  changedPricing,
  clearTier,
  draftFrom as pricingDraftFrom,
  editTier,
  isBlank,
  isDirty as isPricingDirty,
  isNewRowStarted,
  isSavable,
  newRow,
  newRowErrors,
  rowErrors,
  shownTier,
  type NewRow,
  type PricingDraft,
  type RateDraft,
  type RateField,
  type TierField,
} from '../pricingDraft'
import type { ModelRates } from '../types/ModelRates'
import type { ConfigPrice } from '../types/ConfigPrice'
import {
  changedCommands,
  draftFrom,
  effectiveCommand,
  isDirty,
  isRowChanged,
  placeholderError,
  type Draft,
} from '../settingsDraft'
import {
  canPick,
  canPickModel as canPickSpeechModel,
  capsFor,
  changedSpeech,
  draftFrom as speechDraftFrom,
  effectiveModel,
  isDirty as isSpeechDirty,
  isSavable as isSpeechSavable,
  modelOptions as speechModelOptions,
  options as voiceOptions,
  sampleButton,
  valueError as voiceError,
  voiceForModel,
  type SpeechDraft,
} from '../speechDraft'
import {
  canPick as canPickModel,
  changedListen,
  draftFrom as listenDraftFrom,
  engineOptions as listenEngineOptions,
  isDirty as isListenDirty,
  isSavable as isListenSavable,
  options as modelOptions,
  valueError as modelError,
  type ListenDraft,
} from '../listenDraft'
import {
  changedAudio,
  draftFrom as audioDraftFrom,
  isDirty as isAudioDirty,
  options as audioEngineOptions,
  engineStatus,
  savedEngine as savedAudioEngine,
  type AudioDraft,
} from '../audioDraft'
import { toBase64 } from '../liveAudio'
import {
  CLIP_ACCEPT,
  addedNote,
  cloneReady,
  nameError as cloneNameError,
} from '../voiceClone'
import {
  auditionLabel,
  canAudition,
  canDesignVoice,
  canKeep,
  canReroll,
  canSave,
  descriptionError,
  type DesignState,
} from '../voiceDesign'
import {
  VOICE_FILE_ACCEPT,
  exportFilename,
  exportText,
  importModelError,
  importReady,
  parseVoiceFile,
} from '../voiceExport'
import type { VoiceExport } from '../types/VoiceExport'
import {
  changedLive,
  draftFrom as liveDraftFrom,
  handoffError,
  isDirty as isLiveDirty,
  isSavable as isLiveSavable,
  MAX_AUTO_SEND_MS,
  MAX_HANDOFF_TOKENS,
  MIN_AUTO_SEND_MS,
  MIN_HANDOFF_TOKENS,
  waitError,
  type LivePromptDraft,
} from '../livePromptDraft'
import type { ConfigCommand } from '../types/ConfigCommand'
import { useLiveContext } from '../liveContext'
import {
  promptPlaceholders,
  type PromptPlaceholder,
} from '../promptPlaceholders'
import { useFetch } from '../useFetch'
import {
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  changedWatchers,
  draftFrom as watchersDraftFrom,
  isDirty as isWatchersDirty,
  isSavable as isWatchersSavable,
  valueError,
  type WatchersDraft,
} from '../watchersDraft'
import {
  WATCH_KEYS,
  changedServe,
  draftFrom as serveDraftFrom,
  flagName,
  hostsError,
  isDirty as isServeDirty,
  isSavable as isServeSavable,
  portError,
  type BoolKey,
  type ServeDraft,
} from '../serveDraft'

/**
 * Human copy for each config key. The server sends the key, the default and
 * the placeholder vocabulary; only "what does this spawn *do*" lives here,
 * because it is prose about mesa's behavior, not config data.
 */
const COPY: Record<string, { title: string; blurb: string }> = {
  'todo-watcher': {
    title: 'Todo watcher',
    blurb:
      '`serve --watch-todo` runs this to pick up the next unblocked task in a project.',
  },
  'inbox-watcher': {
    title: 'Inbox watcher',
    blurb: '`serve --watch-inbox` runs this to triage a new inbox item.',
  },
  'agent-spawn': {
    title: 'Add agent',
    blurb: "The Agents sidebar's + button runs this to start a session.",
  },
}

/**
 * Polls the server with a cheap existing GET until it responds, for use after
 * `restartServer()` — the old process exits and a new one has to open the
 * store and rebind the port before anything answers again.
 */
async function waitForServer(timeoutMs = 15000, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    try {
      await listProjects()
      return
    } catch {
      // Still shutting down or starting back up — keep polling.
    }
  }
  throw new Error(
    'server did not come back within 15s — check the terminal Naru is running in',
  )
}

async function handleRestart(): Promise<void> {
  await restartServer()
  await waitForServer()
  window.location.reload()
}

/**
 * The page title row: "Settings" on the left, Restart server hard right (mesa
 * task 655 — it used to live in the sidebar footer). It renders in *every*
 * branch below, including the unreadable-config error state: relaunching mesa
 * is the one control that must stay reachable even when the page's own data
 * won't load.
 */
function SettingsHeader() {
  return (
    <div className="settings-header">
      <h1>Settings</h1>
      <ConfirmDelete
        label="Restart server"
        message="Relaunches Naru (picks up a rebuilt binary); reloads when it's back."
        onDelete={handleRestart}
      />
    </div>
  )
}

/**
 * Settings: a form over `~/.mesa/config.json` — today, the three command
 * templates mesa uses to start a coding agent (docs/config.md).
 *
 * Two things the page must not soften, because they are the file's actual
 * semantics rather than presentation:
 *
 * - **Blank means "use the built-in default"**, not "run nothing". Every row
 *   shows the default it would fall back to, and clearing a box is the reset.
 * - **Every hook is a bash script** (mesa task 1143), one line or many, and
 *   each `{placeholder}` is substituted shell-quoted so a value is never
 *   re-parsed as shell. The help text says so once, above the rows. Bad
 *   templates are rejected by the server at save time (a placeholder the
 *   action does not offer, a placeholder inside single quotes or arithmetic,
 *   a bash syntax error) rather than failing silently at the next dispatch,
 *   and the message lands here.
 *
 * The file is read fresh on every spawn, so a save takes effect immediately —
 * no server restart, which the page states so nobody goes looking for one.
 *
 * The page is six tabs (mesa task 1140; Memory added by mesa task 1147), the active one named by the hash
 * route (`settingsTab.ts`); this component is the shell and the Hooks tab's
 * own form.
 */
export function SettingsView({ tab }: { tab: SettingsTab }) {
  const { data: commands, error, refetch } = useFetch(() => getConfig(), 'config')
  // The whole page is one subject — the config file — so the page is the whole
  // report (mesa task 888).
  useLiveContext({ kind: 'settings', id: null, label: null, detail: null })
  // The form is edited locally and saved explicitly. `null` = not seeded yet;
  // it is seeded from the first load (and re-seeded after a save, from the
  // echoed settings) rather than derived per render, so typing isn't clobbered
  // by a refetch mid-edit.
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const seeded: Draft = draft ?? (commands ? draftFrom(commands) : {})

  function edit(action: string, value: string) {
    setDraft({ ...seeded, [action]: value })
    setSaved(false)
  }

  function save() {
    if (!commands) return
    setSaving(true)
    setSaveError(null)
    updateConfig(changedCommands(commands, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the form shows what
        // actually landed (trimmed, blanks resolved to their defaults).
        setDraft(draftFrom(fresh))
        setSaving(false)
        setSaved(true)
        refetch()
      },
      (e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  if (error) {
    return (
      <div className="settings-page">
        <SettingsHeader />
        <p className="error">{error}</p>
        <p className="muted">
          Naru found a config file it could not read. Fix{' '}
          <code>~/.mesa/config.json</code> by hand — editing it from here would
          overwrite whatever is in there.
        </p>
      </div>
    )
  }
  if (!commands) {
    return (
      <div className="settings-page">
        <SettingsHeader />
        <p className="muted">Loading…</p>
      </div>
    )
  }

  const dirty = isDirty(commands, seeded)

  return (
    <div className="settings-page">
      <SettingsHeader />
      <p className="muted">
        Stored in <code>~/.mesa/config.json</code> and re-read on every spawn —
        a change takes effect on the next dispatch, with no server restart.
      </p>

      <div className="tabs">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t}
            className={t === tab ? 'active' : ''}
            onClick={() => {
              if (t !== tab) window.location.hash = settingsTabHref(t)
            }}
          >
            {settingsTabLabel(t)}
          </button>
        ))}
      </div>

      {/* Every tab's sections stay mounted and are merely hidden when
          inactive: each holds its draft in component-local state, so
          unmounting on a tab switch would silently discard an unsaved edit. */}
      <div hidden={tab !== 'hooks'}>
        <h2>Hooks</h2>
        <p className="muted">
          The hook Naru runs to start a coding agent. Leave a box empty to use
          the built-in default. Every hook is a bash script, one line or many,
          run as <code>bash -c</code> in the project folder — so <code>cd</code>,{' '}
          <code>export</code>, a pipe or a conditional binary all work. Each{' '}
          <code>{'{}'}</code> placeholder is replaced by its value, quoted for
          where you put it, so the value is never re-parsed as shell; a value
          with nothing to say on this run is the empty string. A placeholder
          inside <code>'…'</code>, <code>$'…'</code>, backticks or arithmetic
          is refused when you save.
        </p>

        <PromptPlaceholderList />

        {commands.map((c) => (
          <CommandRow
            key={c.action}
            command={c}
            draft={seeded}
            onEdit={(value) => edit(c.action, value)}
          />
        ))}

        <div className="settings-actions">
          <button type="button" disabled={!dirty || saving} onClick={save}>
            {saving ? 'saving…' : 'save'}
          </button>
          {dirty && !saving && <span className="muted">unsaved changes</span>}
          {saved && !dirty && <span className="settings-saved">saved</span>}
        </div>
        {saveError && <p className="error">{saveError}</p>}

        <WatchersSection />
      </div>
      <div hidden={tab !== 'keyboard'}>
        <KeymapSection />
      </div>
      <div hidden={tab !== 'voice'}>
        <LivePromptSection />
        <SpeechSection />
        <AudioSection />
        <ListenSection />
      </div>
      <div hidden={tab !== 'memory'}>
        <MemorySection />
      </div>
      <div hidden={tab !== 'pricing'}>
        <PricingSection />
      </div>
      <div hidden={tab !== 'system'}>
        <ServeSection />
        <SystemSection />
      </div>
    </div>
  )
}

/**
 * Keyboard shortcuts: which chord runs each of mesa's five global keyboard
 * listeners (mesa task 1079). Its own section, draft and save button, for the
 * same reason watchers and pricing have theirs — a separate endpoint, so one
 * form's rejection must not strand the other's edits.
 *
 * The draft is the **whole** keymap rather than the overrides, because a
 * conflict is a fact about every binding at once: a chord recorded here has to
 * be judged against the seven actions the user never touched as well. Only what
 * actually changed is PUT (`changedKeymap`), and an action drafted back to the
 * shipped chords is PUT as `null` — a default is an absence, never a stored
 * copy of itself.
 */
function KeymapSection() {
  const { data: config, error, refetch } = useFetch(() => getKeymap(), 'keymap')
  const [draft, setDraft] = useState<KeymapDraft | null>(null)
  const [recording, setRecording] = useState<KeymapAction | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  // A recorded chord's own keyup must not reach the app either: the
  // create-task shortcut is bound on keyup (mesa task 817), so recording `a`
  // would otherwise open the create-task form behind this page.
  const swallowKeyup = useRef(false)

  const seeded: KeymapDraft = draft ?? (config ? keymapDraftFrom(config) : resetAll())

  // The recording listener. Capture phase on `window`, so it runs before every
  // global shortcut listener in the app and `stopPropagation` keeps the chord
  // being recorded from also *firing* — pressing Cmd/Ctrl+Shift+P to rebind
  // the palette must not open the palette.
  useEffect(() => {
    if (recording === null) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        swallowKeyup.current = true
        return
      }
      const chord = chordFromEvent(e)
      // A bare modifier is how every chord starts, not a chord: keep waiting.
      if (chord === null) return
      setDraft((d) => withChord(d ?? seeded, recording, chord))
      setRecording(null)
      setSaved(false)
      swallowKeyup.current = true
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, seeded])

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (recording === null && !swallowKeyup.current) return
      swallowKeyup.current = false
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keyup', onKeyUp, true)
    return () => window.removeEventListener('keyup', onKeyUp, true)
  }, [recording])

  function save() {
    if (!config) return
    setSaving(true)
    setSaveError(null)
    updateKeymap(changedKeymap(config, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the rows show what
        // landed — and hand the same answer to the listeners, which are
        // mounted above this page and would otherwise keep the old chords
        // until a reload.
        setDraft(keymapDraftFrom(fresh))
        publishKeymap(fresh)
        setSaving(false)
        setSaved(true)
        refetch()
      },
      (e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  if (error) {
    return (
      <>
        <h2>Keyboard shortcuts</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!config) {
    return (
      <>
        <h2>Keyboard shortcuts</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isKeymapDirty(config, seeded)
  const savable = isKeymapSavable(seeded)
  const label = (id: KeymapAction) => ACTIONS.find((a) => a.id === id)?.label ?? id

  return (
    <>
      <h2>Keyboard shortcuts</h2>
      <p className="muted settings-command-blurb">
        The shortcuts that work anywhere in the app. A chord is recorded from
        the next key you press — ⌘ and Ctrl are one modifier, so a keymap means
        the same thing on either platform. Shortcuts without a modifier stand
        down while you are typing in a field, a terminal or a workflow canvas; ones with
        a modifier do not. The Files tab's own chords and a form's Escape are
        not here: they belong to one panel while it is on screen, not to the
        app.
      </p>
      {ACTIONS.map((spec) => {
        const chords = seeded[spec.id] ?? []
        const clash = conflictingActions(seeded, spec.id)
        return (
          <section className="settings-command" key={spec.id}>
            <label>
              <span className="settings-command-title">{spec.label}</span>
              <code className="settings-command-key">{spec.id}</code>
            </label>
            <p className="muted settings-command-blurb">{spec.blurb}</p>
            <div className="settings-keymap-row">
              <span className="settings-keymap-chords">
                {recording === spec.id ? (
                  <span className="settings-pending">
                    press a chord — Escape cancels
                  </span>
                ) : (
                  chords.map((chord, i) => (
                    <span className="settings-keymap-chord" key={chord}>
                      {i > 0 && <span className="muted">or </span>}
                      {formatChord(chord).map((cap) => (
                        <kbd key={cap}>{cap}</kbd>
                      ))}
                    </span>
                  ))
                )}
              </span>
              <button
                type="button"
                aria-label={`Change the ${spec.label} shortcut`}
                onClick={() => {
                  setRecording(recording === spec.id ? null : spec.id)
                  setSaved(false)
                }}
              >
                {recording === spec.id ? 'cancel' : 'change'}
              </button>
              <button
                type="button"
                className="settings-reset"
                disabled={!isOverridden(seeded, spec.id)}
                title={`Back to ${DEFAULT_KEYMAP[spec.id].map(chordLabel).join(' or ')}`}
                onClick={() => {
                  setDraft(withReset(seeded, spec.id))
                  setSaved(false)
                }}
              >
                reset
              </button>
            </div>
            {clash.length > 0 && (
              <p className="error">
                also bound to {clash.map(label).join(', ')} — one chord belongs
                to one action
              </p>
            )}
          </section>
        )
      })}

      <div className="settings-actions">
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save shortcuts'}
        </button>
        <button
          type="button"
          className="settings-inline-button"
          onClick={() => {
            setDraft(resetAll())
            setRecording(null)
            setSaved(false)
          }}
        >
          reset all
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}

/**
 * Memory: the live notebook (mesa task 1147) — the bullets earlier
 * conversations left for later ones, every active one riding in every live
 * agent's prompt under a word budget the dream pass keeps. Not a config section: the rows
 * live in the db (`live_notebook`) and each is its own record, so this is a
 * list with an inline edit and a delete per row and an add box at the bottom
 * rather than one draft with one save button. Every write is one request for
 * one entry — the notebook is edited one item at a time, never rewritten
 * whole — and a 422 (the entry length, the 30%-removal guard)
 * shows inline beside the row that asked. The meter is computed here off the
 * same word rule the server judges by (`memoryDraft.ts`).
 *
 * Deliberately no poll: an agent may be writing to the notebook mid
 * conversation, but this page is for reading and correcting it between
 * conversations, and refetching on every write is enough.
 */
function MemorySection() {
  const { data: entries, error, refetch } = useFetch(
    () => listLiveMemory(),
    'live-memory',
  )
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(
    null,
  )
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(
    null,
  )
  const [adding, setAdding] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function fail(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  function saveEdit() {
    if (!editing || !isMemorySendable(editing.body)) return
    const { id, body } = editing
    setBusy(true)
    setRowError(null)
    updateLiveMemory(id, body).then(
      () => {
        setBusy(false)
        setEditing(null)
        refetch()
      },
      (e: unknown) => {
        setBusy(false)
        setRowError({ id, message: fail(e) })
      },
    )
  }

  function remove(id: number) {
    setBusy(true)
    setRowError(null)
    deleteLiveMemory(id).then(
      () => {
        setBusy(false)
        if (editing?.id === id) setEditing(null)
        refetch()
      },
      (e: unknown) => {
        setBusy(false)
        setRowError({ id, message: fail(e) })
      },
    )
  }

  function add() {
    if (!isMemorySendable(adding)) return
    setBusy(true)
    setAddError(null)
    addLiveMemory(adding).then(
      () => {
        setBusy(false)
        setAdding('')
        refetch()
      },
      (e: unknown) => {
        setBusy(false)
        setAddError(fail(e))
      },
    )
  }

  if (error) {
    return (
      <>
        <h2>Memory</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!entries) {
    return (
      <>
        <h2>Memory</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const words = notebookWords(entries)
  const addFieldError = memoryBodyError(adding)

  return (
    <>
      <h2>Memory</h2>
      <p className="muted">
        The live notebook: what earlier conversations left for later ones —
        preferences, working norms, the reasons behind decisions, pointers to
        task ids. Every active entry is read by the agent holding the next
        conversation, so it is budgeted: a write is never refused for the
        budget, and the tidy pass between conversations brings the notebook
        back within it. Entries are
        edited one at a time; an entry no conversation has used for ten
        sessions becomes a candidate the tidy pass reviews — a one-off is
        retired, a standing norm kept — and a retired entry stays searchable
        with{' '}
        <code>mesa live memory search</code>.
      </p>
      <p className={overBudget(words) ? 'error' : 'muted'}>
        {budgetMeter(words)}
      </p>

      {entries.length === 0 && (
        <p className="muted">Nothing remembered yet.</p>
      )}
      {entries.map((entry) => {
        const isEditing = editing?.id === entry.id
        const editFieldError = isEditing ? memoryBodyError(editing.body) : null
        return (
          <section key={entry.id} className="settings-command">
            <p className="muted settings-command-blurb">{metaLine(entry)}</p>
            {isEditing ? (
              <>
                <textarea
                  className="settings-command-input"
                  rows={3}
                  value={editing.body}
                  onChange={(e) =>
                    setEditing({ id: entry.id, body: e.target.value })
                  }
                />
                {editFieldError && <p className="error">{editFieldError}</p>}
                <div className="settings-actions">
                  <button
                    type="button"
                    disabled={busy || !isMemorySendable(editing.body)}
                    onClick={saveEdit}
                  >
                    save
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null)
                      setRowError(null)
                    }}
                  >
                    cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>{entry.body}</p>
                <div className="settings-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing({ id: entry.id, body: entry.body })
                      setRowError(null)
                    }}
                  >
                    edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => remove(entry.id)}
                  >
                    delete
                  </button>
                </div>
              </>
            )}
            {rowError?.id === entry.id && (
              <p className="error">{rowError.message}</p>
            )}
          </section>
        )
      })}

      <section className="settings-command">
        <label htmlFor="memory-add">
          <span className="settings-command-title">Add an entry</span>
        </label>
        <p className="muted settings-command-blurb">
          One bullet — something the person said outright. Never task status
          (tasks hold that), never a guess about the person.
        </p>
        <textarea
          id="memory-add"
          className="settings-command-input"
          rows={3}
          value={adding}
          onChange={(e) => {
            setAdding(e.target.value)
            setAddError(null)
          }}
        />
        {addFieldError && <p className="error">{addFieldError}</p>}
        <div className="settings-actions">
          <button
            type="button"
            disabled={busy || !isMemorySendable(adding)}
            onClick={add}
          >
            {busy ? 'saving…' : 'add entry'}
          </button>
        </div>
        {addError && <p className="error">{addError}</p>}
      </section>
    </>
  )
}

/**
 * Watchers: how the background loops behave (mesa task 777) — today, how many
 * todo-watcher agents one project may have running at once. Its own section,
 * its own draft and its own save button, for the same reason pricing has one:
 * a separate endpoint, so one form's rejection must not strand the other's
 * edits.
 *
 * Blank is the built-in default, exactly as a blank command box is — clearing
 * the box PUTs `null`, which removes the key rather than writing a 1.
 */
function WatchersSection() {
  const { data: watchers, error, refetch } = useFetch(() => getWatchers(), 'watchers')
  const [draft, setDraft] = useState<WatchersDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const seeded: WatchersDraft =
    draft ?? (watchers ? watchersDraftFrom(watchers) : { todo_concurrency: '' })

  function edit(value: string) {
    setDraft({ ...seeded, todo_concurrency: value })
    setSaved(false)
  }

  function save() {
    if (!watchers) return
    setSaving(true)
    setSaveError(null)
    updateWatchers(changedWatchers(watchers, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the box shows what landed.
        setDraft(watchersDraftFrom(fresh))
        setSaving(false)
        setSaved(true)
        refetch()
      },
      (e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  if (error) {
    return (
      <>
        <h2>Watchers</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!watchers) {
    return (
      <>
        <h2>Watchers</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isWatchersDirty(watchers, seeded)
  const savable = isWatchersSavable(seeded)
  const fieldError = valueError(seeded.todo_concurrency)

  return (
    <>
      <h2>Watchers</h2>
      <section className="settings-command">
        <label htmlFor="watch-todo-concurrency">
          <span className="settings-command-title">
            Todo watcher: max concurrent agents per project
          </span>
          <code className="settings-command-key">todo_concurrency</code>
        </label>
        <p className="muted settings-command-blurb">
          blank = {watchers.todo_concurrency_default} (the default); lowering it
          never stops work already in flight
        </p>
        <input
          id="watch-todo-concurrency"
          type="number"
          min={MIN_CONCURRENCY}
          max={MAX_CONCURRENCY}
          step="1"
          className="settings-watcher-input"
          value={seeded.todo_concurrency}
          placeholder={String(watchers.todo_concurrency_default)}
          onChange={(e) => edit(e.target.value)}
        />
        {fieldError && <p className="error">{fieldError}</p>}
      </section>

      <div className="settings-actions">
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save watchers'}
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}

const SERVE_LABELS: Record<BoolKey, { title: string; blurb: string }> = {
  lan: {
    title: 'LAN access',
    blurb:
      'binds 0.0.0.0 and skips the Host check; no authentication, so every device on the network gets full access. Needs a restart.',
  },
  watch_todo: {
    title: 'Todo watcher',
    blurb: 'auto-starts an agent on actionable todo tasks.',
  },
  watch_inbox: {
    title: 'Inbox watcher',
    blurb: 'auto-triages pending change requests.',
  },
  watch_cost: {
    title: 'Cost guard',
    blurb: 'stops and reports runaway sessions.',
  },
  watch_retro: {
    title: 'Retrospective',
    blurb: 'periodically reviews finished task sessions.',
  },
  watch_workflows: {
    title: 'Time workflows',
    blurb: 'runs due time-triggered workflows.',
  },
}

/**
 * Server: every `naru serve` startup flag as a config key (mesa task 1621).
 * The port, LAN access and allowed hosts are read once at start, so a change
 * there shows a restart notice; the five watchers are re-read every tick and
 * take effect within one. A setting a command-line flag pins is shown
 * disabled — the flag wins this run.
 */
function ServeSection() {
  const { data: serve, error, refetch } = useFetch(() => getServe(), 'serve')
  const [draft, setDraft] = useState<ServeDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  if (error) {
    return (
      <>
        <h2>Server</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!serve) {
    return (
      <>
        <h2>Server</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const seeded: ServeDraft = draft ?? serveDraftFrom(serve)
  const dirty = isServeDirty(serve, seeded)
  const savable = isServeSavable(seeded)
  const portProblem = portError(seeded.port)
  const hostsProblem = hostsError(seeded.allow_host)

  function edit(patch: Partial<ServeDraft>) {
    setDraft({ ...seeded, ...patch })
    setSaved(false)
  }

  function save() {
    if (!serve) return
    setSaving(true)
    setSaveError(null)
    updateServe(changedServe(serve, seeded)).then(
      (fresh) => {
        setDraft(serveDraftFrom(fresh))
        setSaving(false)
        setSaved(true)
        refetch()
      },
      (e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  const pin = (key: string, flag: unknown) =>
    flag !== null && flag !== undefined ? (
      <p className="muted settings-command-blurb">
        set by <code>{flagName(key)}</code> on the command line (this run
        ignores the config value)
      </p>
    ) : null
  const portPinned = serve.port.flag !== null
  const hostsPinned = serve.allow_host.flag !== null

  return (
    <>
      <h2>Server</h2>
      <p className="muted">
        What <code>naru serve</code> starts with, so a bare{' '}
        <code>naru serve</code> can run as a service. A command-line flag beats
        these settings.
      </p>
      {serve.restart_required && (
        <section className="settings-command">
          <p className="error">
            Restart required: the port, LAN access or allowed hosts saved here
            differ from what this server is running with.
          </p>
          <ConfirmDelete
            label="Restart server"
            message="Relaunches Naru with the saved settings; reloads when it's back."
            onDelete={handleRestart}
          />
        </section>
      )}

      <section className="settings-command">
        <label htmlFor="serve-port">
          <span className="settings-command-title">Port</span>
          <code className="settings-command-key">port</code>
        </label>
        <p className="muted settings-command-blurb">
          blank = {serve.port.default}; running on {serve.port.effective}. Needs
          a restart.
        </p>
        <input
          id="serve-port"
          type="number"
          min={1}
          max={65535}
          step="1"
          className="settings-watcher-input"
          disabled={portPinned}
          value={seeded.port}
          placeholder={String(serve.port.default)}
          onChange={(e) => edit({ port: e.target.value })}
        />
        {portProblem && <p className="error">{portProblem}</p>}
        {pin('port', serve.port.flag)}
      </section>

      <section className="settings-command">
        <label htmlFor="serve-lan">
          <span className="settings-command-title">
            {SERVE_LABELS.lan.title}
          </span>
          <code className="settings-command-key">lan</code>
        </label>
        <p className="muted settings-command-blurb">{SERVE_LABELS.lan.blurb}</p>
        <input
          id="serve-lan"
          type="checkbox"
          disabled={serve.lan.flag !== null}
          checked={serve.lan.flag ?? seeded.lan}
          onChange={(e) => edit({ lan: e.target.checked })}
        />
        {pin('lan', serve.lan.flag)}
      </section>

      <section className="settings-command">
        <label htmlFor="serve-allow-host">
          <span className="settings-command-title">Allowed hosts</span>
          <code className="settings-command-key">allow_host</code>
        </label>
        <p className="muted settings-command-blurb">
          Under LAN access, also trust these exact hostnames (one per line or
          comma separated). Needs a restart.
        </p>
        <textarea
          id="serve-allow-host"
          rows={3}
          disabled={hostsPinned}
          value={seeded.allow_host}
          onChange={(e) => edit({ allow_host: e.target.value })}
        />
        {hostsProblem && <p className="error">{hostsProblem}</p>}
        {pin('allow_host', serve.allow_host.flag)}
      </section>

      {WATCH_KEYS.map((key) => (
        <section className="settings-command" key={key}>
          <label htmlFor={`serve-${key}`}>
            <span className="settings-command-title">
              {SERVE_LABELS[key].title}
            </span>
            <code className="settings-command-key">{key}</code>
          </label>
          <p className="muted settings-command-blurb">
            {SERVE_LABELS[key].blurb} Takes effect live, {key === 'watch_retro' ? 'within an hour (its tick)' : 'within a minute'}.
          </p>
          <input
            id={`serve-${key}`}
            type="checkbox"
            disabled={serve[key].flag !== null}
            checked={serve[key].flag ?? seeded[key]}
            onChange={(e) => edit({ [key]: e.target.checked })}
          />
          {pin(key, serve[key].flag)}
        </section>
      ))}

      <div className="settings-actions">
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save server'}
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}

/**
 * Live: how long a dictated line sits before the page sends it (mesa task
 * 886). Its own section, draft and save button, for the same reason watchers
 * and pricing have theirs — a separate endpoint, so one form's rejection must
 * not strand the other's edits.
 *
 * The instruction block the conversation's agent is spawned with used to
 * live here too (mesa task 867), but moved to the library as of mesa task
 * 919 — it is now the `naru-live` agent definition (mesa task 1068), edited
 * on `#/library` like any other row, so this section only links there instead
 * of holding a second editor for it.
 *
 * One thing it must not soften: **a blank wait is the two seconds mesa
 * ships**, not "never send" — the box is empty on an unconfigured install
 * and clearing it removes the key.
 */
function LivePromptSection() {
  const { data: live, error, refetch } = useFetch(() => getLiveConfig(), 'live')
  const [draft, setDraft] = useState<LivePromptDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const seeded: LivePromptDraft =
    draft ?? (live ? liveDraftFrom(live) : { auto_send_ms: '', handoff_tokens: '' })

  function edit(patch: Partial<LivePromptDraft>) {
    setDraft({ ...seeded, ...patch })
    setSaved(false)
  }

  function save() {
    if (!live) return
    setSaving(true)
    setSaveError(null)
    updateLiveConfig(changedLive(live, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the box shows what landed.
        setDraft(liveDraftFrom(fresh))
        setSaving(false)
        setSaved(true)
        refetch()
      },
      (e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  if (error) {
    return (
      <>
        <h2>Live conversation</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!live) {
    return (
      <>
        <h2>Live conversation</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isLiveDirty(live, seeded)
  const savable = isLiveSavable(seeded)
  const waitFieldError = waitError(seeded.auto_send_ms)
  const handoffFieldError = handoffError(seeded.handoff_tokens)

  return (
    <>
      <h2>Live conversation</h2>
      <section className="settings-command">
        <span className="settings-command-title">Agent definition</span>
        <p className="muted settings-command-blurb">
          What the agent driving a spoken conversation is told to do now
          lives in the library — see <a href="#/library">the library</a>,
          under the <code>naru-live</code> agent.
        </p>
      </section>

      <section className="settings-command">
        <label htmlFor="live-auto-send">
          <span className="settings-command-title">
            Wait before sending a dictated line
          </span>
          <code className="settings-command-key">live.auto-send-ms</code>
        </label>
        <p className="muted settings-command-blurb">
          How long the person may fall silent, while Naru is listening,
          before the transcribed recording so far is sent as one turn —
          dictation never presses Enter, so this pause is what ends a spoken
          thought. Blank = {live.auto_send_ms_default} ms (the default). It
          does not apply to text typed into the conversation box, which is
          sent by Enter alone (mesa task 977).
        </p>
        <input
          id="live-auto-send"
          type="number"
          min={MIN_AUTO_SEND_MS}
          max={MAX_AUTO_SEND_MS}
          step="50"
          className="settings-watcher-input"
          value={seeded.auto_send_ms}
          placeholder={String(live.auto_send_ms_default)}
          onChange={(e) => edit({ auto_send_ms: e.target.value })}
        />
        {waitFieldError && <p className="error">{waitFieldError}</p>}
      </section>

      <section className="settings-command">
        <label htmlFor="live-handoff">
          <span className="settings-command-title">
            Context size that triggers a handoff
          </span>
          <code className="settings-command-key">live.handoff-tokens</code>
        </label>
        <p className="muted settings-command-blurb">
          When the agent driving a conversation holds this many tokens of
          context, it hands the conversation to a fresh agent. Read when an
          agent is spawned, so it applies to the next one. Blank ={' '}
          {live.handoff_tokens_default} tokens (the default).
        </p>
        <input
          id="live-handoff"
          type="number"
          min={MIN_HANDOFF_TOKENS}
          max={MAX_HANDOFF_TOKENS}
          step="10000"
          className="settings-watcher-input"
          value={seeded.handoff_tokens}
          placeholder={String(live.handoff_tokens_default)}
          onChange={(e) => edit({ handoff_tokens: e.target.value })}
        />
        {handoffFieldError && <p className="error">{handoffFieldError}</p>}
      </section>

      <div className="settings-actions">
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save live settings'}
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}

/**
 * Speech: the voice the Inbox's play button reads an item in (mesa task 822).
 * Its own section, draft and save button, for the same reason watchers and
 * pricing have theirs — a separate endpoint, so one form's rejection must not
 * strand the other's edits.
 *
 * Two things it must not soften:
 * - **Blank is the synthesiser's own default**, not silence: mesa passes no
 *   `-v` at all then, which is exactly what it did before this setting existed.
 * - **The list is what the installed binary reports**, not a list mesa ships.
 *   When mesa could not ask it (no `kokoro-rs` on PATH) there is no list to
 *   pick from, so the box becomes a plain one rather than an empty dropdown
 *   that would look like "no voices exist".
 */
function SpeechSection() {
  const { data: speech, error, refetch } = useFetch(() => getSpeech(), 'speech')
  const [draft, setDraft] = useState<SpeechDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  // The sample being played, if any: the voice it was started for and a nonce
  // that makes pressing test twice on the same voice a second play rather than
  // a no-op (the <audio> is keyed by it). Null is "nothing playing" — the
  // element is unmounted then, which is what stops the sound.
  const [sample, setSample] = useState<{
    voice: string
    model: string
    nonce: number
  } | null>(null)
  // The voices of a drafted model (mesa task 1425), fetched when the model
  // picker changes; `null` until then, when `speech.voices` — the saved
  // model's — is the list.
  const [voicesFor, setVoicesFor] = useState<{
    model: string
    voices: string[]
    cloned: string[]
  } | null>(null)
  // Whether the sample's audio has actually started: synthesis takes seconds,
  // so "asked for it" and "hearing it" are different states, exactly as on the
  // Inbox page's play button.
  const [playing, setPlaying] = useState(false)
  const [sampleError, setSampleError] = useState(false)
  // Adding a cloned voice (mesa task 1418) — offered only when the saved
  // audio engine is naru-audio; the legacy synthesiser clones nothing.
  const audio = useFetch(() => getAudio(), 'speech-audio')
  const [cloneName, setCloneName] = useState('')
  const [cloneText, setCloneText] = useState('')
  const [clip, setClip] = useState<File | null>(null)
  // Remounts the file input to clear it after a success.
  const [clipKey, setClipKey] = useState(0)
  const [cloning, setCloning] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [cloneNote, setCloneNote] = useState<string | null>(null)
  // Exporting and importing a cloned voice as one `naru-voice` file (mesa
  // task 1430), naru-audio only like the clone form.
  const [exporting, setExporting] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [imported, setImported] = useState<VoiceExport | null>(null)
  const [importName, setImportName] = useState('')
  // Remounts the file input to clear it after a success.
  const [importKey, setImportKey] = useState(0)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importNote, setImportNote] = useState<string | null>(null)
  // The latest picked file, so a slower read of an earlier pick is dropped.
  const pickedFile = useRef<File | null>(null)

  const seeded: SpeechDraft =
    draft ?? (speech
        ? speechDraftFrom(speech)
        : { voice: '', model: '', speed: SPEED_DEFAULT })
  const listed =
    voicesFor && voicesFor.model === seeded.model.trim() ? voicesFor : null
  const voices = listed ? listed.voices : (speech?.voices ?? [])
  // The listed voices naru-audio can export: only a cloning model lists them.
  const cloned = listed ? listed.cloned : (speech?.cloned ?? [])

  function edit(value: string) {
    setDraft({ ...seeded, voice: value })
    setSaved(false)
    // A different voice is a different sample; stop the old one rather than
    // leave the previous voice playing under a changed selection.
    setSample(null)
    setPlaying(false)
    setSampleError(false)
  }

  // A different model has different voices: ask for that model's list, and
  // keep the drafted voice only if the new list has it (mesa task 1425).
  function editModel(value: string) {
    setDraft({ ...seeded, model: value })
    setSaved(false)
    setSample(null)
    setPlaying(false)
    setSampleError(false)
    const asked = value.trim()
    getSpeech(asked).then(
      (fresh) => {
        setVoicesFor({ model: asked, voices: fresh.voices, cloned: fresh.cloned })
        setDraft((d) =>
          d && d.model.trim() === asked
            ? { ...d, voice: voiceForModel(d.voice, fresh.voices) }
            : d,
        )
      },
      // No list is "Naru could not ask": the voice box turns into a plain one.
      () => setVoicesFor({ model: asked, voices: [], cloned: [] }),
    )
  }

  // Stops the sample if one is playing, starts one for the drafted voice
  // otherwise — the drafted one, not the saved one, which is the whole point.
  function toggleSample() {
    setSampleError(false)
    setPlaying(false)
    setSample((current) =>
      current
        ? null
        : { voice: seeded.voice, model: seeded.model, nonce: Date.now() },
    )
  }

  // Refetches the drafted model's voices so a just-added voice shows — the
  // draft and the saved voice and model are left alone. Shared by the clone
  // form and the design panel (mesa task 1426).
  async function refreshVoices(): Promise<string[]> {
    const asked = seeded.model.trim()
    const fresh = await getSpeech(asked).then(
      (s) => ({ voices: s.voices, cloned: s.cloned }),
      () => ({ voices: [] as string[], cloned: [] as string[] }),
    )
    setVoicesFor({ model: asked, ...fresh })
    return fresh.voices
  }

  // Downloads the cloned voice `name` as one `naru-voice` file.
  async function downloadVoice(name: string) {
    setExporting(name)
    setExportError(null)
    try {
      const file = await exportVoice(name)
      const blob = new Blob([exportText(file)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = exportFilename(name)
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(null)
    }
  }

  // Reads a picked voice file; the name box takes the file's own name,
  // which the person may change before importing.
  function pickVoiceFile(file: File | null) {
    setImported(null)
    setImportError(null)
    setImportNote(null)
    pickedFile.current = file
    if (file === null) return
    file.text().then(
      (text) => {
        if (pickedFile.current !== file) return
        const parsed = parseVoiceFile(text)
        if ('error' in parsed) {
          setImportError(parsed.error)
          return
        }
        setImported(parsed.voice)
        setImportName(parsed.voice.name)
      },
      (e: unknown) => {
        if (pickedFile.current !== file) return
        setImportError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  // Adds the read voice through the add-voice route, onto the drafted model.
  // A taken name is the daemon's 409, shown as an error: nothing is ever
  // overwritten.
  async function importVoice() {
    if (!imported) return
    setImporting(true)
    setImportError(null)
    setImportNote(null)
    try {
      const added = await addVoice(
        importName.trim(),
        imported.text.trim(),
        imported.wav_base64,
        currentModel,
      )
      const fresh = await refreshVoices()
      setImportNote(addedNote(added, fresh))
      setImported(null)
      setImportName('')
      setImportKey((k) => k + 1)
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  // Sends the clip, then refetches the drafted model's voices so the new one
  // shows — the draft and the saved voice and model are left alone.
  async function addClone() {
    if (!clip) return
    setCloning(true)
    setCloneError(null)
    setCloneNote(null)
    try {
      const bytes = new Uint8Array(await clip.arrayBuffer())
      const added = await addVoice(
        cloneName.trim(),
        cloneText.trim(),
        toBase64(bytes),
        currentModel,
      )
      const fresh = await refreshVoices()
      setCloneNote(addedNote(added, fresh))
      setCloneName('')
      setCloneText('')
      setClip(null)
      setClipKey((k) => k + 1)
    } catch (e: unknown) {
      setCloneError(e instanceof Error ? e.message : String(e))
    } finally {
      setCloning(false)
    }
  }

  function save() {
    if (!speech) return
    setSaving(true)
    setSaveError(null)
    updateSpeech(changedSpeech(speech, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the box shows what landed.
        setDraft(speechDraftFrom(fresh))
        // Every player on the page picks the saved speed up now.
        publishSpeechSpeed(fresh.speed)
        setVoicesFor(null)
        setSaving(false)
        setSaved(true)
        refetch()
      },
      (e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  if (error) {
    return (
      <>
        <h2>Speech</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!speech) {
    return (
      <>
        <h2>Speech</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isSpeechDirty(speech, seeded)
  const savable = isSpeechSavable(seeded)
  const fieldError = voiceError(seeded.voice)
  // The model the clone form, the design panel and export/import actually
  // work with right now (mesa task 1455): the drafted model, or naru-audio's
  // own default when the box is blank — never the daemon's, whatever that
  // happens to be, which is the Breeze-clones-onto-Qwen bug this resolves.
  const currentModel = effectiveModel(seeded.model, speech.capabilities)
  const currentCaps = capsFor(currentModel, speech.capabilities)
  const naruAudio = !!(audio.data && savedAudioEngine(audio.data) === 'naru-audio')

  return (
    <>
      <h2>Speech</h2>
      {/* Only naru-audio lists models; on the legacy engine (or a daemon Naru
          could not ask) there is nothing to pick and no picker. */}
      {canPickSpeechModel(speech) && (
        <section className="settings-command">
          <label htmlFor="speech-model">
            <span className="settings-command-title">Model</span>
            <code className="settings-command-key">model</code>
          </label>
          <p className="muted settings-command-blurb">
            The text-to-speech model <code>naru-audio</code> speaks in. Blank =
            naru-audio's own default. Each model has its own voices, so the
            voice list below follows this choice.
          </p>
          <div className="settings-voice-row">
            <select
              id="speech-model"
              className="settings-voice-input"
              value={seeded.model}
              onChange={(e) => editModel(e.target.value)}
            >
              <option value="">default (naru-audio's own)</option>
              {speechModelOptions(speech, seeded.model).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </section>
      )}
      <section className="settings-command">
        <label htmlFor="speech-voice">
          <span className="settings-command-title">
            Voice
          </span>
          <code className="settings-command-key">voice</code>
        </label>
        <p className="muted settings-command-blurb">
          The voice{' '}
          <code>
            {audio.data && savedAudioEngine(audio.data) === 'naru-audio'
              ? 'naru-audio'
              : 'kokoro-rs'}
          </code>{' '}
          speaks in — a live conversation, or
          an inbox item you press play on. Blank = the voice the synthesiser
          picks itself; a change applies on the next thing spoken, with no
          restart.
        </p>
        <div className="settings-voice-row">
          {canPick(voices) ? (
            <select
              id="speech-voice"
              className="settings-voice-input"
              value={seeded.voice}
              onChange={(e) => edit(e.target.value)}
            >
              {/* Not a count: `options()` may carry a configured voice the
                  binary no longer lists, so any number here would be wrong in
                  exactly the case that matters. */}
              <option value="">default (the synthesiser's own)</option>
              {voiceOptions(voices, seeded.voice).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="speech-voice"
              type="text"
              className="settings-voice-input"
              spellCheck={false}
              value={seeded.voice}
              placeholder="af_heart"
              onChange={(e) => edit(e.target.value)}
            />
          )}
          {/* Hears the *drafted* voice, not the saved one — so the choice can
              be made before it is committed. Refused while the name is one the
              save would reject: there is nothing to audition then. */}
          <button
            type="button"
            disabled={!!fieldError}
            title={sampleButton(!!sample, playing).title}
            onClick={toggleSample}
          >
            {sampleButton(!!sample, playing).label}
          </button>
        </div>
        {!canPick(voices) &&
          (audio.data && savedAudioEngine(audio.data) === 'naru-audio' ? (
            <p className="muted settings-command-blurb">
              Naru could not ask the <code>naru-audio</code> daemon which voices
              it has — type a name.
            </p>
          ) : (
            <p className="muted settings-command-blurb">
              Naru could not ask <code>kokoro-rs</code> which voices it has — type
              a name, or run <code>kokoro-rs --list-voices</code> to see them.
            </p>
          ))}
        {fieldError && <p className="error">{fieldError}</p>}
        {sampleError && (
          <p className="error">could not play a sample in this voice</p>
        )}
      </section>

      <section className="settings-command">
        <label htmlFor="speech-speed">
          <span className="settings-command-title">Speed</span>
          <code className="settings-command-key">speed</code>
        </label>
        <p className="muted settings-command-blurb">
          How fast everything Naru speaks plays — live replies, inbox items and
          the samples on this page — without changing the pitch. The page
          applies it whatever the voice or engine, so a change is heard on the
          next thing spoken; the sample above follows the slider at once.
        </p>
        <div className="settings-voice-row">
          <input
            id="speech-speed"
            type="range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={SPEED_STEP}
            value={seeded.speed}
            onChange={(e) => {
              setDraft({ ...seeded, speed: Number(e.target.value) })
              setSaved(false)
            }}
          />
          <span>{formatSpeed(seeded.speed)}</span>
        </div>
      </section>

      {naruAudio && currentCaps?.clone === true && (
        <section className="settings-command">
          <label htmlFor="clone-name">
            <span className="settings-command-title">Add a cloned voice</span>
          </label>
          <p className="muted settings-command-blurb">
            A short clip of one person speaking — WAV or MP3, about 5–15
            seconds{currentCaps.clone_requires_transcript
              ? ' — and exactly what they say in it'
              : ''}
            . <code>naru-audio</code> copies the voice for{' '}
            <code>{currentModel}</code>; only clone a voice you have
            permission to use.
          </p>
          <div className="settings-voice-row">
            <input
              id="clone-name"
              type="text"
              className="settings-voice-input"
              spellCheck={false}
              placeholder="name, e.g. amy"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
            />
            <input
              key={clipKey}
              type="file"
              accept={CLIP_ACCEPT}
              aria-label="voice clip"
              onChange={(e) => setClip(e.target.files?.[0] ?? null)}
            />
          </div>
          {currentCaps.clone_requires_transcript && (
            <textarea
              className="settings-voice-input"
              aria-label="what the clip says"
              placeholder="Exactly what the clip says"
              rows={3}
              value={cloneText}
              onChange={(e) => setCloneText(e.target.value)}
            />
          )}
          {cloneName.trim() !== '' && cloneNameError(cloneName) && (
            <p className="error">{cloneNameError(cloneName)}</p>
          )}
          <div className="settings-actions">
            <button
              type="button"
              disabled={
                cloning ||
                !cloneReady(
                  {
                    name: cloneName,
                    text: cloneText,
                    hasClip: clip !== null,
                  },
                  currentCaps.clone_requires_transcript,
                )
              }
              onClick={() => void addClone()}
            >
              {cloning ? 'adding…' : 'add voice'}
            </button>
            {cloneNote && <span className="settings-saved">{cloneNote}</span>}
          </div>
          {cloneError && <p className="error">{cloneError}</p>}
        </section>
      )}

      {audio.data && savedAudioEngine(audio.data) === 'naru-audio' && (
        <section className="settings-command">
          <label htmlFor="voice-import">
            <span className="settings-command-title">
              Export or import a cloned voice
            </span>
          </label>
          <p className="muted settings-command-blurb">
            Export saves a cloned voice — its clip and transcript — as one{' '}
            <code>.naru-voice.json</code> file; import adds a voice from such a
            file, on this machine or another. A name already taken is refused,
            never overwritten.
          </p>
          {cloned.length > 0 ? (
            <div className="settings-voice-row">
              {cloned.map((name) => (
                <button
                  key={name}
                  type="button"
                  disabled={exporting !== null}
                  title={`download ${exportFilename(name)}`}
                  onClick={() => void downloadVoice(name)}
                >
                  {exporting === name ? 'exporting…' : `export ${name}`}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted settings-command-blurb">
              The model above lists no cloned voices to export — only a cloning
              model lists them.
            </p>
          )}
          {exportError && <p className="error">{exportError}</p>}
          <div className="settings-voice-row">
            <input
              id="voice-import"
              key={importKey}
              type="file"
              accept={VOICE_FILE_ACCEPT}
              aria-label="voice file"
              onChange={(e) => pickVoiceFile(e.target.files?.[0] ?? null)}
            />
            <input
              type="text"
              className="settings-voice-input"
              aria-label="imported voice name"
              spellCheck={false}
              placeholder="name to add it as"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
            />
          </div>
          {imported && (
            <p className="muted settings-command-blurb">
              “{imported.text}”
            </p>
          )}
          {importName.trim() !== '' && cloneNameError(importName) && (
            <p className="error">{cloneNameError(importName)}</p>
          )}
          {imported && importModelError(imported, currentModel) && (
            <p className="error">{importModelError(imported, currentModel)}</p>
          )}
          <div className="settings-actions">
            <button
              type="button"
              disabled={
                importing ||
                !importReady(
                  imported,
                  importName,
                  currentModel,
                  currentCaps?.clone_requires_transcript ?? true,
                )
              }
              onClick={() => void importVoice()}
            >
              {importing ? 'importing…' : 'import voice'}
            </button>
            {importNote && <span className="settings-saved">{importNote}</span>}
          </div>
          {importError && <p className="error">{importError}</p>}
        </section>
      )}

      {naruAudio && canDesignVoice(currentCaps) && (
        <VoiceDesignPanel
          model={currentModel}
          speed={seeded.speed}
          refreshVoices={refreshVoices}
        />
      )}

      {/* One player, unmounted to stop — the same shape (and the same
          `AbortError` caveat) as the Inbox page's, so a browser that refuses
          autoplay reports a failure instead of leaving the button reading
          "synthesising…" forever. The in-flight synthesis on the server
          finishes and its bytes are discarded. */}
      {sample && (
        <audio
          key={`${sample.model}:${sample.voice}:${sample.nonce}`}
          src={speechPreviewUrl(sample.voice, sample.model)}
          ref={(el) => {
            // A refusal that lands after this element is gone belongs to a
            // sample the user has already replaced or stopped, so it must not
            // report a failure against whatever is playing by then — the
            // Inbox player guards the same race with its item id. The cleanup
            // runs on unmount, which is exactly when this closure goes stale.
            let live = true
            // The drafted speed, so the slider is audible on the sample at once.
            if (el) applyElementSpeed(el, seeded.speed)
            el?.play().catch((err: DOMException) => {
              if (err.name === 'AbortError' || !live) return
              setSampleError(true)
              setSample(null)
              setPlaying(false)
            })
            return () => {
              live = false
            }
          }}
          onPlaying={() => setPlaying(true)}
          onEnded={() => {
            setSample(null)
            setPlaying(false)
          }}
          onError={() => {
            setSampleError(true)
            setSample(null)
            setPlaying(false)
          }}
        />
      )}

      <div className="settings-actions">
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save speech'}
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}

/**
 * **Design a voice** (mesa task 1426), naru-audio only: describe a voice,
 * audition it on a short Naru line (the voice-design model reads it with the
 * description as `instructions`, as many takes as wanted), keep it — the same
 * model reads the longer reference script, which can be re-rolled — and save
 * that clip under a name through the ordinary add-voice route, the reference
 * script as its exact transcript. From then on it is a cloned voice like any
 * other. Every take is a whole WAV fetched once and played from a blob URL;
 * the step rules live in `voiceDesign.ts`.
 */
function VoiceDesignPanel({
  model,
  speed,
  refreshVoices,
}: {
  model: string
  /** The drafted playback speed the takes are auditioned at. */
  speed: number
  refreshVoices: () => Promise<string[]>
}) {
  const info = useFetch(
    () => getSpeechDesign(model),
    `speech-design:${model}`,
  )
  const [state, setState] = useState<DesignState>({
    description: '',
    auditioned: null,
    kept: null,
    busy: null,
  })
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // The two takes on hand, as blob URLs, and the reference clip's bytes for
  // the save. A replaced URL is revoked, and both are on unmount.
  const [sampleUrl, setSampleUrl] = useState<string | null>(null)
  const [referenceUrl, setReferenceUrl] = useState<string | null>(null)
  const [referenceBase64, setReferenceBase64] = useState<string | null>(null)
  const urls = useRef<{ sample: string | null; reference: string | null }>({
    sample: null,
    reference: null,
  })
  // Whether the panel is still mounted: a take that lands after unmount is
  // dropped rather than given a blob URL nothing would revoke.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    // One object for the panel's life, mutated in place: its fields at
    // cleanup are the takes still on hand.
    const taken = urls.current
    return () => {
      mounted.current = false
      if (taken.sample) URL.revokeObjectURL(taken.sample)
      if (taken.reference) URL.revokeObjectURL(taken.reference)
    }
  }, [])

  function setTake(which: 'sample' | 'reference', blob: Blob) {
    const old = urls.current[which]
    if (old) URL.revokeObjectURL(old)
    const url = URL.createObjectURL(blob)
    urls.current[which] = url
    if (which === 'sample') setSampleUrl(url)
    else setReferenceUrl(url)
  }

  async function take(which: 'sample' | 'reference', description: string) {
    setState((s) => ({ ...s, busy: which }))
    setError(null)
    setNote(null)
    try {
      const blob = await designVoice(description, which, model)
      if (!mounted.current) return
      if (which === 'reference') {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (!mounted.current) return
        setReferenceBase64(toBase64(bytes))
      }
      setTake(which, blob)
      setState((s) =>
        which === 'sample'
          ? { ...s, auditioned: description, busy: null }
          : { ...s, kept: description, busy: null },
      )
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setState((s) => ({ ...s, busy: null }))
    }
  }

  async function save() {
    if (!info.data || !referenceBase64) return
    setState((s) => ({ ...s, busy: 'save' }))
    setError(null)
    setNote(null)
    try {
      const added = await addVoice(
        name.trim(),
        info.data.reference,
        referenceBase64,
        model,
      )
      const fresh = await refreshVoices()
      setNote(addedNote(added, fresh))
      setName('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setState((s) => ({ ...s, busy: null }))
    }
  }

  if (!info.data) return null
  const described = descriptionError(state.description)

  return (
    <section className="settings-command">
      <label htmlFor="design-description">
        <span className="settings-command-title">Design a voice</span>
      </label>
      <p className="muted settings-command-blurb">
        Describe a voice and <code>naru-audio</code>'s voice-design model makes
        it up. Audition it on a short line until it sounds right, keep it to
        record a longer reference clip in that voice, then save it under a name
        — it becomes a cloned voice a cloning model speaks in.
      </p>
      {!info.data.available && (
        <p className="muted settings-command-blurb">
          <code>naru-audio</code> doesn't have the voice-design model — pull it
          with <code>naru-audio pull {info.data.model}</code>, or check the
          daemon is running.
        </p>
      )}
      <textarea
        id="design-description"
        className="settings-voice-input"
        placeholder="e.g. A calm, warm female voice with a slight British accent, speaking slowly"
        rows={3}
        value={state.description}
        onChange={(e) => {
          const description = e.target.value
          setState((s) => ({ ...s, description }))
        }}
      />
      {described && <p className="error">{described}</p>}
      <div className="settings-actions">
        <button
          type="button"
          disabled={!info.data.available || !canAudition(state)}
          onClick={() => void take('sample', state.description.trim())}
        >
          {state.busy === 'sample' ? 'synthesising…' : auditionLabel(state)}
        </button>
        <button
          type="button"
          disabled={!info.data.available || !canKeep(state)}
          title="read the longer reference script in this voice"
          onClick={() => void take('reference', state.description.trim())}
        >
          {state.busy === 'reference' ? 'recording…' : 'keep'}
        </button>
      </div>
      {sampleUrl && (
        <audio
          key={sampleUrl}
          src={sampleUrl}
          controls
          autoPlay
          ref={(el) => {
            if (el) applyElementSpeed(el, speed)
          }}
        />
      )}
      {state.kept !== null && referenceUrl && (
        <>
          <p className="muted settings-command-blurb">
            {/* The kept description, not the one in the box: after an edit
                and a new audition, this is still the voice save keeps. */}
            Reference clip — “{state.kept}” — reading: “{info.data.reference}”
          </p>
          <div className="settings-voice-row">
            <audio
              key={referenceUrl}
              src={referenceUrl}
              controls
              ref={(el) => {
                if (el) applyElementSpeed(el, speed)
              }}
            />
            <button
              type="button"
              disabled={!canReroll(state)}
              onClick={() => {
                if (state.kept !== null) void take('reference', state.kept)
              }}
            >
              re-roll
            </button>
          </div>
          <div className="settings-voice-row">
            <input
              type="text"
              className="settings-voice-input"
              aria-label="designed voice name"
              spellCheck={false}
              placeholder="name, e.g. calm_narrator"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="button"
              disabled={!canSave(state, name)}
              onClick={() => void save()}
            >
              {state.busy === 'save' ? 'saving…' : 'save voice'}
            </button>
          </div>
          {name.trim() !== '' && cloneNameError(name) && (
            <p className="error">{cloneNameError(name)}</p>
          )}
        </>
      )}
      {note && <span className="settings-saved">{note}</span>}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

/**
 * Audio: which engine the **server** runs speech through (`audio.engine`,
 * mesa task 1391) — `legacy` (the `auris`/`kokoro-rs` binaries) or
 * `naru-audio` (the daemon) — with the engine in effect (the saved one) and
 * its live probe beside it, from `GET /api/live/transcribe` (`engineStatus`,
 * mesa task 1411). The save drops the server's cached probe, and the probe is
 * refetched after it, so the new engine's state shows with no reload. The
 * daemon URL is not edited here.
 */
function AudioSection() {
  const { data: audio, error, refetch } = useFetch(() => getAudio(), 'audio')
  const probe = useFetch(() => transcribeStatus(), 'transcribe-status')
  const [draft, setDraft] = useState<AudioDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const seeded: AudioDraft =
    draft ?? (audio ? audioDraftFrom(audio) : { engine: 'legacy' })

  function save() {
    if (!audio) return
    setSaving(true)
    setSaveError(null)
    updateAudio(changedAudio(audio, seeded)).then(
      (fresh) => {
        setDraft(audioDraftFrom(fresh))
        setSaving(false)
        setSaved(true)
        refetch()
        probe.refetch()
      },
      (e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  if (error) {
    return (
      <>
        <h2>Audio</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!audio) {
    return (
      <>
        <h2>Audio</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isAudioDirty(audio, seeded)
  // The engine the server is running now — the saved one, not the draft.
  const savedEngine = savedAudioEngine(audio)
  const status = engineStatus(savedEngine, probe.data ?? null)

  return (
    <>
      <h2>Audio</h2>
      <section className="settings-command">
        <label htmlFor="audio-engine">
          <span className="settings-command-title">Server speech engine</span>
          <code className="settings-command-key">engine</code>
        </label>
        <p className="muted settings-command-blurb">
          <code>legacy</code> speaks through the <code>kokoro-rs</code>{' '}
          binary and transcribes through the <code>auris</code> binary;{' '}
          <code>naru-audio</code> sends both speech and transcription (live
          dictation included) to the naru-audio daemon at the configured URL,
          and runs neither binary. A saved change applies to the next request,
          with no restart.
        </p>
        <div className="settings-voice-row">
          <select
            id="audio-engine"
            className="settings-voice-input"
            value={seeded.engine}
            onChange={(e) => {
              setDraft({ engine: e.target.value })
              setSaved(false)
            }}
          >
            {audioEngineOptions(audio).map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
        <p className="settings-command-blurb">{status.headline}</p>
        {dirty && (
          <p className="muted settings-command-blurb">
            Unsaved: {savedEngine} stays in effect until you save.
          </p>
        )}
        {probe.error ? (
          <p className="error">{probe.error}</p>
        ) : (
          <>
            {status.details.map((line) => (
              <p key={line} className="muted settings-command-blurb">
                {line}
              </p>
            ))}
            {probe.data?.engine === savedEngine && probe.data.message && (
              <p className="muted settings-command-blurb">
                {probe.data.message}
              </p>
            )}
          </>
        )}
      </section>

      <div className="settings-actions">
        <button type="button" disabled={!dirty || saving} onClick={save}>
          {saving ? 'saving…' : 'save audio'}
        </button>
        {dirty && !saving && <span className="muted">unsaved changes</span>}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}

/**
 * Listen: the model `live transcribe` runs the external `auris` speech-to-text
 * binary with (mesa task 955). Its own section, draft and save button, for
 * the same reason speech has one — a separate endpoint, so one form's
 * rejection must not strand the other's edits.
 *
 * The input-side mirror of `SpeechSection`, minus a test button: `auris` has
 * nothing like speaking a sample.
 *
 * Two things it must not soften:
 * - **Blank is the binary's own default**, not silence: mesa passes no `-m`
 *   at all then, which is exactly what it did before this setting existed.
 * - **The list is what the installed binary reports**, not a list mesa
 *   ships. When mesa could not ask it (no `auris` on PATH) there is no list
 *   to pick from, so the box becomes a plain one rather than an empty
 *   dropdown that would look like "no models exist".
 */
function ListenSection() {
  const { data: listen, error, refetch } = useFetch(() => getListen(), 'listen')
  const [draft, setDraft] = useState<ListenDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const seeded: ListenDraft =
    draft ?? (listen ? listenDraftFrom(listen) : { model: '', engine: 'server' })

  function edit(value: string) {
    setDraft({ ...seeded, model: value })
    setSaved(false)
  }

  function editEngine(value: string) {
    setDraft({ ...seeded, engine: value })
    setSaved(false)
  }

  function save() {
    if (!listen) return
    setSaving(true)
    setSaveError(null)
    updateListen(changedListen(listen, seeded)).then(
      (fresh) => {
        // Re-seed from what the server read back, so the box shows what landed.
        setDraft(listenDraftFrom(fresh))
        setSaving(false)
        setSaved(true)
        refetch()
      },
      (e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  if (error) {
    return (
      <>
        <h2>Listen</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!listen) {
    return (
      <>
        <h2>Listen</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isListenDirty(listen, seeded)
  const savable = isListenSavable(listen, seeded)
  const fieldError = modelError(seeded.model)

  return (
    <>
      <h2>Listen</h2>
      <section className="settings-command">
        <label htmlFor="listen-model">
          <span className="settings-command-title">
            Live transcription model
          </span>
          <code className="settings-command-key">model</code>
        </label>
        <p className="muted settings-command-blurb">
          The model <code>auris</code> decodes a live-conversation recording
          with. Blank = the model auris picks itself; a change applies on the
          next transcription, with no restart.
        </p>
        <div className="settings-voice-row">
          {canPickModel(listen) ? (
            <select
              id="listen-model"
              className="settings-voice-input"
              value={seeded.model}
              onChange={(e) => edit(e.target.value)}
            >
              {/* Not a count: `options()` may carry a configured model the
                  binary no longer lists, so any number here would be wrong in
                  exactly the case that matters. */}
              <option value="">default (the binary's own)</option>
              {modelOptions(listen).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="listen-model"
              type="text"
              className="settings-voice-input"
              spellCheck={false}
              value={seeded.model}
              placeholder="parakeet-tdt-0.6b-v2-int8"
              onChange={(e) => edit(e.target.value)}
            />
          )}
        </div>
        {!canPickModel(listen) && (
          <p className="muted settings-command-blurb">
            Naru could not ask <code>auris</code> which models it has — type a
            name, or run <code>auris --list-models</code> to see them.
          </p>
        )}
        {fieldError && <p className="error">{fieldError}</p>}
      </section>
      <section className="settings-command">
        <label htmlFor="listen-engine">
          <span className="settings-command-title">Page listening engine</span>
          <code className="settings-command-key">engine</code>
        </label>
        <p className="muted settings-command-blurb">
          What the page listens with: <code>server</code> (the engine above)
          or <code>browser</code> (the browser's own recognizer, a deliberate
          opt-in). Saved to the config; the page does not act on it yet.
        </p>
        <div className="settings-voice-row">
          <select
            id="listen-engine"
            className="settings-voice-input"
            value={seeded.engine}
            onChange={(e) => editEngine(e.target.value)}
          >
            {listenEngineOptions(listen).map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
      </section>

      <div className="settings-actions">
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save listen'}
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {saveError && <p className="error">{saveError}</p>}
    </>
  )
}

/**
 * The library prompts this install offers a hook template, live from
 * `GET /api/library` (mesa task 1138) — never a hardcoded list, since the
 * whole point is that a prompt saved on `#/library` is reachable from a hook
 * without leaving the page.
 *
 * Renders nothing at all when the library holds no prompts, and nothing on a
 * failed read either: this is a hint beside the editor, and an error banner
 * over a list of suggestions would be louder than what it costs to lose them.
 */
function PromptPlaceholderList() {
  const { data: items } = useFetch(() => listLibrary(), 'library-prompts')
  const prompts: PromptPlaceholder[] = items ? promptPlaceholders(items) : []
  if (prompts.length === 0) return null
  return (
    <div className="settings-prompt-placeholders">
      <p className="muted">
        This library's prompts, usable as placeholders in any hook — the body
        is quoted in as one value, so its text is never parsed as shell. Edit
        them on <code>#/library</code>.
      </p>
      <ul className="muted settings-prompt-list">
        {prompts.map((p) => (
          <li key={p.name}>
            <code>{p.placeholder}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CommandRow({
  command,
  draft,
  onEdit,
}: {
  command: ConfigCommand
  draft: Draft
  onEdit: (value: string) => void
}) {
  const copy = COPY[command.action]
  const text = draft[command.action] ?? ''
  const usingDefault = text.trim() === ''
  const scopeError = placeholderError(command, draft)
  // Grow with the script so a multi-line value isn't edited through a slot.
  const rows = Math.min(16, Math.max(2, text.split('\n').length + 1))
  return (
    <section className="settings-command">
      <label htmlFor={`cmd-${command.action}`}>
        <span className="settings-command-title">
          {copy?.title ?? command.action}
        </span>
        <code className="settings-command-key">{command.action}</code>
      </label>
      {copy && <p className="muted settings-command-blurb">{copy.blurb}</p>}
      <textarea
        id={`cmd-${command.action}`}
        className="settings-command-input"
        rows={rows}
        spellCheck={false}
        value={text}
        placeholder={command.default}
        onChange={(e) => onEdit(e.target.value)}
      />
      <div className="settings-command-meta">
        <span className="settings-placeholders">
          {command.placeholders.map((p) => (
            <code key={p}>{p}</code>
          ))}
        </span>
        {!usingDefault && (
          <button
            type="button"
            className="settings-reset"
            title="Clear this box, restoring the built-in default"
            onClick={() => onEdit('')}
          >
            reset to default
          </button>
        )}
      </div>
      <p className="settings-effective">
        <span className="muted">
          {usingDefault ? 'default in use:' : 'will run:'}
        </span>{' '}
        <code className="settings-effective-script">
          {effectiveCommand(command, draft)}
        </code>
        {isRowChanged(command, draft) && (
          <span className="settings-pending"> (unsaved)</span>
        )}
      </p>
      {scopeError && <p className="error">{scopeError}</p>}
    </section>
  )
}

/**
 * Model pricing: the rates the CC Dashboard's est. cost is computed from
 * (mesa task 692). Its own section, its own draft and its own save button —
 * it is a separate endpoint, so merging the two forms would let one form's
 * rejection strand the other's edits.
 *
 * Two rules, both the server's:
 * - matching is by **prefix** (`claude-opus` prices every Opus release), the
 *   longest match winning, so a variant can be priced beside its family;
 * - a blank row is "use the built-in rate" — the reset for a family mesa
 *   ships, the delete for a prefix the user added.
 */
function PricingSection() {
  const { data: prices, error, refetch } = useFetch(() => getPricing(), 'pricing')
  const [draft, setDraft] = useState<PricingDraft | null>(null)
  const [extra, setExtra] = useState<NewRow[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const seeded: PricingDraft = draft ?? (prices ? pricingDraftFrom(prices) : {})

  function editRate(prefix: string, field: RateField, value: string) {
    setDraft({ ...seeded, [prefix]: { ...seeded[prefix], [field]: value } })
    setSaved(false)
  }

  function clearRow(prefix: string) {
    setDraft({ ...seeded, [prefix]: blankRates() })
    setSaved(false)
  }

  function setRow(prefix: string, row: RateDraft) {
    setDraft({ ...seeded, [prefix]: row })
    setSaved(false)
  }

  function editNew(index: number, next: NewRow) {
    setExtra(extra.map((row, i) => (i === index ? next : row)))
    setSaved(false)
  }

  function save() {
    if (!prices) return
    setSaving(true)
    setSaveError(null)
    updatePricing({
      ...changedPricing(prices, seeded),
      ...addedPricing(extra),
    }).then(
      (fresh) => {
        // Re-seed from what landed; an added prefix comes back an ordinary row.
        setDraft(pricingDraftFrom(fresh))
        setExtra([])
        setSaving(false)
        setSaved(true)
        refetch()
      },
      (e: unknown) => {
        setSaving(false)
        setSaveError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  if (error) {
    return (
      <>
        <h2>Model pricing</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!prices) {
    return (
      <>
        <h2>Model pricing</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const dirty = isPricingDirty(prices, seeded) || extra.some(isNewRowStarted)
  const errors = newRowErrors(extra)
  const savable = isSavable(prices, seeded) && errors.length === 0

  return (
    <>
      <h2>Model pricing</h2>
      <p className="muted">
        USD per 1M tokens, used for the CC Dashboard's estimated cost. Models are
        matched by <strong>prefix</strong> — <code>claude-opus</code> prices every
        Opus release — and the longest matching prefix wins, so{' '}
        <code>claude-opus-5-mini</code> can be priced separately. Leave a row
        blank to use the built-in rate shown in the boxes; a model no prefix
        matches is estimated at $0. A change applies on the next dashboard read,
        past sessions included, with no restart.
      </p>

      <div className="settings-prices">
        <div className="settings-price-head muted">
          <span>prefix</span>
          <span>input</span>
          <span>output</span>
          <span>cache read</span>
          <span>cache write</span>
          <span />
        </div>
        {prices.map((p) => (
          <PriceRow
            key={p.prefix}
            price={p}
            draft={seeded}
            onEdit={(field, value) => editRate(p.prefix, field, value)}
            onClear={() => clearRow(p.prefix)}
            onRow={(next) => setRow(p.prefix, next)}
          />
        ))}
        {extra.map((row, i) => (
          <NewPriceRow
            key={i}
            row={row}
            onEdit={(next) => editNew(i, next)}
            onRemove={() => setExtra(extra.filter((_, j) => j !== i))}
          />
        ))}
      </div>

      <div className="settings-actions">
        <button type="button" onClick={() => setExtra([...extra, newRow()])}>
          add model prefix
        </button>
        <button
          type="button"
          disabled={!dirty || !savable || saving}
          onClick={save}
        >
          {saving ? 'saving…' : 'save pricing'}
        </button>
        {dirty && savable && !saving && (
          <span className="muted">unsaved changes</span>
        )}
        {saved && !dirty && <span className="settings-saved">saved</span>}
      </div>
      {errors.map((e) => (
        <p className="error" key={e}>
          {e}
        </p>
      ))}
      {saveError && <p className="error">{saveError}</p>}

      <ResetCcIndex />
    </>
  )
}

/**
 * Purges the stored Claude Code telemetry and re-ingests the transcripts on
 * disk (mesa task 698). It lives in the pricing section because it is the
 * other half of "what the CC Dashboard's cost says" — not in the header row,
 * where Restart is deliberately the one always-reachable control.
 *
 * Confirmed, because it is destructive of history: rows whose transcript file
 * Claude Code has since deleted cannot come back. Nothing on this page reads
 * cc data, so there is nothing to refetch — the counts are the receipt, and
 * the dashboard picks the new rows up on its next read.
 */
function ResetCcIndex() {
  const [pending, setPending] = useState(false)
  const [report, setReport] = useState<CcResetReport | null>(null)

  function reset() {
    setPending(true)
    setReport(null)
    return resetCcIndex()
      .then((r) => setReport(r))
      .finally(() => setPending(false))
  }

  return (
    <div className="settings-actions">
      <ConfirmDelete
        // Remount after a run so the control disarms itself, ready for the next.
        key={report ? 'done' : 'idle'}
        label="Reset CC index"
        message="Deletes the stored Claude Code telemetry and re-reads every transcript on disk (10-30s). Fixes inflated costs recorded before the dedupe fix. Sessions whose transcript file no longer exists are lost permanently."
        onDelete={reset}
      />
      {pending && <span className="muted">re-reading transcripts…</span>}
      {report && !pending && (
        <span className="settings-saved">
          re-indexed {report.files_ingested}/{report.files_scanned} transcripts —{' '}
          {report.sessions} sessions, {report.messages_added} messages
        </span>
      )}
    </div>
  )
}

/** One priced family: four boxes over the built-in rate as placeholder. */
function PriceRow({
  price,
  draft,
  onEdit,
  onClear,
  onRow,
}: {
  price: ConfigPrice
  draft: PricingDraft
  onEdit: (field: RateField, value: string) => void
  onClear: () => void
  onRow: (next: RateDraft) => void
}) {
  const row = draft[price.prefix] ?? blankRates()
  const overridden = !isBlank(row)
  const errors = rowErrors(price.prefix, row, price.default)
  return (
    <>
      <div className="settings-price-row">
        <code className="settings-price-prefix">{price.prefix}</code>
        {RATE_FIELDS.map((field) => (
          <input
            key={field}
            type="number"
            min="0"
            step="any"
            className="settings-price-input"
            aria-label={`${price.prefix} ${field}`}
            value={row[field]}
            placeholder={price.default ? String(price.default[field]) : '0'}
            onChange={(e) => onEdit(field, e.target.value)}
          />
        ))}
        {overridden ? (
          <button
            type="button"
            className="settings-reset"
            title={
              price.default
                ? 'Clear this row, restoring the built-in rate'
                : 'Remove this prefix'
            }
            onClick={onClear}
          >
            {price.default ? 'reset to default' : 'remove'}
          </button>
        ) : (
          <span className="muted settings-price-note">built-in</span>
        )}
      </div>
      <TierRow
        label={`${price.prefix} tier`}
        row={row}
        defaults={price.default}
        onRow={onRow}
      />
      {errors.map((e) => (
        <p className="error" key={e}>
          {price.prefix} — {e}
        </p>
      ))}
    </>
  )
}

/**
 * A row's optional context-size tier: the prompt-token threshold and the four
 * rates a request over it pays. All logic lives in `pricingDraft.ts`.
 */
function TierRow({
  label,
  row,
  defaults,
  onRow,
}: {
  label: string
  row: RateDraft
  defaults?: ModelRates | null
  onRow: (next: RateDraft) => void
}) {
  const tier = shownTier(row, defaults)
  if (!tier) {
    return (
      <div className="settings-price-row">
        <button
          type="button"
          className="settings-reset"
          onClick={() => onRow(addTier(row, defaults))}
        >
          add context tier
        </button>
      </div>
    )
  }
  return (
    <div className="settings-price-row">
      {TIER_FIELDS.map((field: TierField) => (
        <input
          key={field}
          type="number"
          min={field === 'above_tokens' ? '1' : '0'}
          step={field === 'above_tokens' ? '1' : 'any'}
          className="settings-price-input"
          aria-label={`${label} ${field}`}
          title={
            field === 'above_tokens'
              ? 'A prompt (input + cache read + cache write tokens) strictly over this many tokens pays the tier rates'
              : undefined
          }
          placeholder={field === 'above_tokens' ? 'over tokens' : undefined}
          value={tier[field]}
          onChange={(e) => onRow(editTier(row, field, e.target.value, defaults))}
        />
      ))}
      <button
        type="button"
        className="settings-reset"
        title="Price this model at one flat rate"
        onClick={() => onRow(clearTier(row))}
      >
        clear tier
      </button>
    </div>
  )
}

/** A prefix being added: the same row, plus an editable prefix box. */
function NewPriceRow({
  row,
  onEdit,
  onRemove,
}: {
  row: NewRow
  onEdit: (next: NewRow) => void
  onRemove: () => void
}) {
  return (
    <>
    <div className="settings-price-row">
      <input
        type="text"
        className="settings-price-input"
        aria-label="new model prefix"
        placeholder="claude-opus-5-mini"
        spellCheck={false}
        value={row.prefix}
        onChange={(e) => onEdit({ ...row, prefix: e.target.value })}
      />
      {RATE_FIELDS.map((field) => (
        <input
          key={field}
          type="number"
          min="0"
          step="any"
          className="settings-price-input"
          aria-label={`new prefix ${field}`}
          value={row.rates[field]}
          onChange={(e) =>
            onEdit({ ...row, rates: { ...row.rates, [field]: e.target.value } })
          }
        />
      ))}
      <button
        type="button"
        className="settings-reset"
        title="Drop this row"
        onClick={onRemove}
      >
        remove
      </button>
    </div>
    <TierRow
      label="new prefix tier"
      row={row.rates}
      onRow={(rates) => onEdit({ ...row, rates })}
    />
    </>
  )
}

/**
 * The host mesa is running on (mesa task 1093). **Read-only** — unlike every
 * other section on this page it edits nothing, has no draft and no save
 * button, because the machine is not a setting. It is here because Settings
 * is already the page about *this installation* rather than about a project,
 * and because the server is often on a box nobody is sitting at.
 *
 * Polled rather than fetched once: it is a live reading, and `GET /api/system`
 * itself blocks ~200ms taking a second CPU sample, so 3s is as fast as the
 * numbers are worth. `useFetch` drops a poll whose result is unchanged and
 * pauses entirely while the tab is hidden.
 *
 * The rule this section must not soften: **a value the host would not report
 * is `null`, and a `null` is typeset, never metered.** Drawing an empty bar
 * for an unknown figure would claim the machine has none of it.
 */
function SystemSection() {
  const { data: info, error } = useFetch(getSystemInfo, 'system-info', {
    pollMs: 3000,
  })

  if (error) {
    return (
      <>
        <h2>System</h2>
        <p className="error">{error}</p>
      </>
    )
  }
  if (!info) {
    return (
      <>
        <h2>System</h2>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const load = info.load_average
  return (
    <>
      <h2>System</h2>
      <p className="muted">
        The host this server is running on, read fresh every few seconds and
        never stored. A dash means the machine did not report that figure —
        which is not the same as zero.
      </p>
      <section className="settings-command settings-system">
        <Meter
          label="Memory"
          pct={usedPct(info.ram_used_bytes, info.ram_total_bytes)}
          detail={`${formatBytes(info.ram_used_bytes)} of ${formatBytes(info.ram_total_bytes)}`}
        />
        <Meter
          label="Swap"
          pct={usedPct(info.swap_used_bytes, info.swap_total_bytes)}
          detail={
            info.swap_total_bytes > 0
              ? `${formatBytes(info.swap_used_bytes)} of ${formatBytes(info.swap_total_bytes)}`
              : 'none configured'
          }
        />
        <Meter
          label="CPU"
          pct={clampPct(info.cpu_usage_pct)}
          detail={info.cpu_model ?? 'model not reported'}
        />
        <div className="settings-system-cores">
          {info.cpu_per_core_pct.map((p, i) => {
            const pct = clampPct(p) ?? 0
            return (
              <span
                key={i}
                className="settings-system-core"
                title={`core ${i + 1}: ${pct.toFixed(0)}%`}
              >
                <span
                  className={`settings-system-core-fill ${systemSeverity(pct)}`}
                  style={{ height: `${pct}%` }}
                />
              </span>
            )
          })}
        </div>
        <Meter
          label="Disk (Naru database volume)"
          pct={
            info.disk_total_bytes !== null && info.disk_free_bytes !== null
              ? usedPct(
                  info.disk_total_bytes - info.disk_free_bytes,
                  info.disk_total_bytes,
                )
              : null
          }
          detail={
            info.disk_free_bytes !== null
              ? `${formatBytes(info.disk_free_bytes)} free of ${formatBytes(info.disk_total_bytes)}`
              : 'not reported'
          }
        />
        {info.gpu && (
          <Meter
            label="GPU"
            // Always null today: real utilisation needs privileged
            // `powermetrics`, so the row is a fact sheet, not a meter.
            pct={clampPct(info.gpu.usage_pct)}
            detail={
              info.gpu.vram_bytes !== null
                ? `${info.gpu.name} · ${formatBytes(info.gpu.vram_bytes)} VRAM`
                : `${info.gpu.name} · shared memory`
            }
          />
        )}
        <dl className="settings-system-facts">
          <dt>Host</dt>
          <dd>{info.hostname ?? '—'}</dd>
          <dt>OS</dt>
          <dd>{info.os ?? '—'}</dd>
          <dt>Cores</dt>
          <dd>
            {info.cpu_cores !== null
              ? `${info.cpu_cores} physical · ${info.cpu_logical} logical`
              : `${info.cpu_logical} logical`}
          </dd>
          <dt>Load</dt>
          <dd>
            {load
              ? load.map((n) => n.toFixed(2)).join(' · ')
              : 'not reported on this platform'}
          </dd>
          <dt>Uptime</dt>
          <dd>{formatUptime(info.uptime_secs)}</dd>
          <dt>Naru process</dt>
          <dd>{formatBytes(info.process_rss_bytes)}</dd>
        </dl>
      </section>
    </>
  )
}

/**
 * One labelled bar. A `null` percentage draws **no track at all** — just the
 * label and whatever the host did say — which is the whole point of keeping
 * `null` distinct from 0 all the way from `core::system`.
 */
function Meter({
  label,
  pct,
  detail,
}: {
  label: string
  pct: number | null
  detail: string
}) {
  return (
    <div className="settings-system-row">
      <div className="settings-system-rowtop">
        <span className="settings-system-label">{label}</span>
        <span className="settings-system-pct">
          {pct === null ? 'not reported' : `${pct.toFixed(0)}%`}
        </span>
      </div>
      {pct !== null && (
        <div className="settings-system-track">
          <div
            className={`settings-system-fill ${systemSeverity(pct)}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <div className="settings-system-detail muted">{detail}</div>
    </div>
  )
}
