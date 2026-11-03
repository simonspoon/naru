# System monitor

A live reading of the **host the Naru server is running on** — memory, CPU,
disk, GPU, uptime — read on every request and never stored. Naru is often
served from a machine nobody is sitting at, so this is the one place that
machine describes itself.

## The one rule

**Every value a platform may decline to report is `Option`, and "could not
determine" is `null`.** Never a sentinel, never a zero, never an error — the
`get_project_version` posture (`{"version":null,…}`). `core::system::snapshot`
is therefore **infallible**: it returns a `SystemInfo` in every circumstance,
including a host that answers almost nothing.

A `null` and a reading of `0` are different facts and must stay
distinguishable end to end: `frontend/src/systemMeter.ts` carries the unknown
case through as `null` rather than defaulting it, and the Settings section
draws **no track at all** for a `null`, printing "not reported" instead. A bar
at 0% would claim the machine has none of that.

## What is read, and what it costs

`sysinfo` (a new dependency, `system` + `disk` features only) supplies
everything except the GPU. Two costs are handled deliberately:

- **CPU utilisation needs two samples.** A percentage is the difference
  between two refreshes of the *same* `System`, so `snapshot()` refreshes,
  sleeps `sysinfo::MINIMUM_CPU_UPDATE_INTERVAL`, and refreshes again — making
  it a **~200 ms blocking call**. The `System` lives in a process-global
  `OnceLock<Mutex<…>>` so consecutive calls also see a real delta. The API
  handler runs it on `spawn_blocking` (like `get_git_status`); the CLI, one
  shot per process, calls it directly.
- **The GPU is a subprocess** — `system_profiler SPDisplaysDataType -json`,
  **macOS only** — and a slow one, so it is asked **once for the life of the
  process** and cached in a `OnceLock`: the hardware does not change under a
  running server. `MESA_SYSTEM_PROFILER_BIN` is the test seam
  (the same env-override seam `MESA_CLAUDE_BIN` is). Not a Mac, a missing binary, a non-zero
  exit, oversized or unparseable output are all `gpu: null`.

Two smaller judgements worth knowing:

- The GPU's name comes from `sppci_model`, **not** `_name` — `_name` is a
  localization key on real hardware (`kHW_IntelUHDGraphics630Item`), so it is
  only the last resort. VRAM is a human string ("1536 MB", "8 GB") under one
  of three keys, and is simply absent on Apple silicon, where the GPU shares
  system memory: `vram_bytes: null` there.
- `gpu.usage_pct` is **always `null`** on `/api/system`. GPU utilisation is
  read only by the stats feed below (`ioreg`, no privileges).
- `disk_*` is the volume holding **Naru's own database** (`default_db_path()`),
  not the whole machine's storage — that is the one disk a Naru user can fill.
  The `sysinfo::Disks` entry chosen is the mount point that is the **longest**
  prefix of that path, since `/` is a prefix of everything.
- `load_average` is `None` on Windows, which has no such idea; `sysinfo`
  answers three zeroes there, which would read as an idle machine.

## Route

`GET /api/system` → `SystemInfo`. Behind the **standard guard only** — no
`require_agent_access` — the posture `GET /api/version` and
`GET /api/git-status` already take for a plain informational read: it names no
project, task or file, and a `--lan` page needs it for the same reason a local
one does. The global Host allowlist and Content-Type gate still apply.

Always `200`. There is no error path, no cache in `AppState` (the GPU's cache
is inside `core::system`), and nothing is written anywhere.

## Stats feed (naru task 2540)

`GET /api/system/stats` → `SystemStats { sample, history, intervalSecs,
gpuAvailable }`, camelCase — the agent watcher's sparklines. A `SystemSample`
is `at` (Unix s), `cpuPct`, `memUsedBytes`/`memTotalBytes`, `gpuPct`,
`diskUsedBytes`/`diskTotalBytes` (the database's volume, as above;
used = total − available).

- **Poll-driven, no thread.** `core::system::stats` takes a new sample only
  when the newest is at least `STATS_INTERVAL_SECS` (2) old, and keeps the
  last `STATS_HISTORY` (60) in a process-global buffer, so any number of
  pollers share one history and an unwatched server samples nothing.
  `history` is oldest first and ends with `sample`.
- **CPU** is the delta since the previous sample on the feed's own
  `sysinfo::System` (so it averages the interval, as Activity Monitor does,
  and `/api/system` refreshes do not shorten it). The first call, or one
  after 10 s of quiet, primes it with `snapshot`'s two-refresh ~200 ms wait.
- **GPU** is `ioreg -r -d 1 -c IOAccelerator`'s first `"Device Utilization
  %"` — macOS, unprivileged, ~20 ms per sample (`MESA_IOREG_BIN` /
  `NARU_IOREG_BIN` is the test seam). Off macOS, a failure or a value outside
  0..100 is `gpuPct: null`, and `gpuAvailable` is false when no sample in the
  history has one: the page says "unavailable", never 0.
- **Memory used** is `sysinfo`'s used figure, which tracks Activity
  Monitor's "Memory Used" (app + wired + compressed; 29.0 GB against
  `vm_stat`'s 29.9 GB when checked), not `top`'s PhysMem "used", which
  counts the file cache too.
- **Disk used** is total − available as `sysinfo` reports available, which on
  APFS includes purgeable space, so it reads a few percent under `df`'s Used.
- The `ioreg` call has a 1 s deadline (`agents::capture`, its process group
  killed past it), because it runs under the feed's lock. After 10 s with
  no poll the history restarts, so a sparkline never joins old samples to new.

Same standard-guard-only posture as `/api/system`; always 200.

## Voice models (naru-audio)

`GET /api/system/audio-models` → `AudioModels { models }` lists what the
naru-audio daemon holds resident (`GET {daemon}/api/ps`: name, kind
`stt`/`tts`, `resident_bytes`, and a derived state `loading`/`busy`/`idle`),
shown under Memory with a total. It is a route of its own because it is a
blocking network call (2 s cap, `audio::loaded_models`, URL from
`audio::daemon_url`, the one resolution of `audio.url`/`NARU_AUDIO_URL`) that
must not slow or fail `snapshot()`. `models` is `null` — shown as "naru-audio
not running" — when the daemon cannot be asked; an
empty list means nothing is loaded. Same standard-guard-only posture as
`/api/system`; always 200.

## CLI

`mesa system` prints the same object, byte-comparable with the route's body.
It is a **flat leaf with no `--quiet`** — there is no unbounded free-text
field to drop, so clap rejects the flag as an unknown argument, exit 2 (the
`backup`/`turns` contract).

## Frontend

`getSystemInfo()` (`frontend/src/api.ts`) feeds a **read-only** `SystemSection`
at the bottom of `#/settings`, polled at 3 s through the shared `useFetch`
hook (which drops an unchanged poll and pauses on a hidden tab). Read-only is
the point: unlike every other section on that page it has no draft, no `PUT`
and no save button, because the machine is not a setting. It is on Settings
because that page is already about *this installation* rather than a project.

The arithmetic lives in `frontend/src/systemMeter.ts` (`usedPct`, `clampPct`,
`systemSeverity`, `formatBytes`, `formatUptime`) with `systemMeter.test.ts`
covering it, per CLAUDE.md's rule that logic worth testing belongs in a pure
module rather than inline in a `.tsx`. The severity bands are `usageMeter.ts`'s
own — warn from 70 %, crit from 90 % — so a meter never means one thing here
and another on the CC dashboard.

## No end-to-end check script

Deliberately none. A single ungated read with a CLI mirror and no store
writes is exactly what `version` and `git-status` already do without one; the
Rust tests in `src/core/system.rs` and `src/api.rs` cover the contract.
