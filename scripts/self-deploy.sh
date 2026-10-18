#!/usr/bin/env bash
# Safe self-redeploy (naru tasks 2039 + 2040, parts of task 2035):
#
#   1 build the release into a temp target dir, run cargo tests + checks
#     (any failure aborts; nothing installed, backed up or paused has changed)
#   2 pause the queue, wait for idle (NARU_DEPLOY_DRAIN_TIMEOUT s; a timeout aborts
#     and resumes), back up the db to <naru home>/backups/naru-pre-deploy-<ts>.db
#   3 atomically swap the binary at $PREFIX/bin/naru, keeping naru.prev
#   4 restart the server (NARU_DEPLOY_RESTART_CMD, e.g. a launchctl kickstart),
#     re-run `naru workflow defaults --task-loop` with the new binary, then check
#     health: /api/version reports the new version, defaults succeeded, and a live
#     conversation open before the swap is still live (same or new agent_id) and a
#     `live say` round trip works
#   5 healthy: resume the queue. Unhealthy: restore naru.prev and the db backup,
#     restart, resume (rolled_back); if that is unhealthy too, rollback_failed and
#     the queue stays paused.
#
# Queue verbs run on the NEW binary (the installed one may predate `queue`).
#
# Flags: --dry-run (print the plan, change nothing), --skip-checks (no build or
#        checks; deploy NARU_DEPLOY_NEW_BIN — for tests).
# Env: PREFIX (default ~/.local), NARU_DEPLOY_CHECKS (scripts/*-check.sh names),
#      NARU_DEPLOY_NEW_BIN, NARU_DEPLOY_BACKUP_DIR (default ~/.naru/backups),
#      NARU_DEPLOY_RESTART_CMD (bash; unset = on macOS with the com.naru.serve
#      launchd agent installed (scripts/launchd.sh), `launchctl kickstart -k
#      gui/$(id -u)/com.naru.serve`; otherwise no restart, so the deploy is judged
#      unhealthy and rolled back), NARU_DEPLOY_DB (db path; default NARU_DB, MESA_DB,
#      then the platform default), NARU_DEPLOY_PORT (default: the config's serve.port, else 7770), NARU_DEPLOY_HEALTH_CMD
#      (replaces the /api/version check; gets NARU_DEPLOY_EXPECT = the version that should be serving), NARU_DEPLOY_LIVE_CHECK=0 (skip the
#      live-session check), NARU_DEPLOY_DRAIN_TIMEOUT (600), NARU_DEPLOY_HEALTH_TIMEOUT
#      (60), NARU_DEPLOY_POLL (seconds between polls, 3).
# PATH: a launchd or live-agent shell has neither cargo nor node, so (unless
#      --skip-checks) ~/.cargo/bin, ~/Library/pnpm/bin and ~/.local/bin are prepended
#      when present, and a missing cargo/node exits 2 before anything is changed.
# Db: the one the server uses — NARU_DEPLOY_DB/NARU_DB/MESA_DB, else the
#      com.naru.serve plist's NARU_DB/MESA_DB, else whichever platform-default db
#      exists (both holding data = abort). The restore only overwrites that file.
# Prints one JSON verdict: swapped | aborted | rolled_back | rollback_failed | plan.
# Exit 0 swapped/plan, 1 otherwise.
set -uo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

dry=0 skip=0
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    --skip-checks) skip=1 ;;
    *) echo "usage: self-deploy.sh [--dry-run] [--skip-checks]" >&2; exit 2 ;;
  esac
done
command -v jq >/dev/null || { echo "self-deploy: jq is required" >&2; exit 2; }

BIN_DIR="${PREFIX:+$PREFIX/bin}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
INSTALLED="$BIN_DIR/naru"
BACKUP_DIR="${NARU_DEPLOY_BACKUP_DIR:-$HOME/.naru/backups}"
CHECKS="${NARU_DEPLOY_CHECKS:-cli-check api-check task-loop-check todo-watcher-check runner-check concurrent-check}"
work="$(mktemp -d "${TMPDIR:-/tmp}/naru-self-deploy.XXXXXX")"
trap 'rm -rf "$work"' EXIT
LOG="$work/self-deploy.log"
backup_db=""
DRAIN_TIMEOUT="${NARU_DEPLOY_DRAIN_TIMEOUT:-600}"
HEALTH_TIMEOUT="${NARU_DEPLOY_HEALTH_TIMEOUT:-60}"
POLL="${NARU_DEPLOY_POLL:-3}"
PORT="${NARU_DEPLOY_PORT:-}"
paused=0 restarted=false

log() { echo "self-deploy: $*" >&2; }
verdict() { jq -cn --arg s "$1" --arg r "$2" --arg db "$backup_db" --arg prev "$BIN_DIR/naru.prev" \
  --argjson restarted "$restarted" --argjson paused "$paused" \
  '{status:$s,reason:$r,db_backup:$db,binary_backup:(if $s=="swapped" then $prev else "" end),restarted:$restarted,healthy:($s=="swapped"),queue_resumed:($paused==0)}'; }
resume_queue() { [ "$paused" -eq 1 ] && "$new_bin" queue resume >>"$LOG" 2>&1 && paused=0; }
abort() { log "ABORT: $1"; [ -s "$LOG" ] && tail -n 30 "$LOG" >&2; resume_queue; verdict aborted "$1"; exit 1; }

if [ "$dry" -eq 1 ]; then
  jq -cn --arg checks "$CHECKS" --arg bin "$INSTALLED" --arg dir "$BACKUP_DIR" --argjson skip "$skip" \
    '{status:"plan",steps:["build release into a temp target dir","cargo test + checks","backup db","pause queue, drain","atomic swap, previous kept as naru.prev","restart server, re-run workflow defaults --task-loop","health check","resume queue or roll back"],checks:($checks|split(" ")),skip_checks:($skip==1),install:$bin,backup_dir:$dir,restart:true}'
  exit 0
fi

if [ "$skip" -eq 0 ]; then
  for d in "$HOME/.cargo/bin" "$HOME/Library/pnpm/bin" "$HOME/.local/bin"; do
    [ -d "$d" ] && PATH="$d:$PATH"
  done
  export PATH
  for t in cargo node; do
    command -v "$t" >/dev/null || { echo "self-deploy: $t not found on PATH (looked in ~/.cargo/bin, ~/Library/pnpm/bin, ~/.local/bin); install it or fix PATH" >&2; exit 2; }
  done
fi

NARU="$INSTALLED"
[ -x "$NARU" ] || NARU="$(command -v naru || true)"
[ -x "$NARU" ] || { echo "self-deploy: no installed naru found" >&2; exit 2; }

# ---- 1 build aside + test (nothing installed or backed up yet) -----------------
if [ "$skip" -eq 1 ]; then
  new_bin="${NARU_DEPLOY_NEW_BIN:?--skip-checks needs NARU_DEPLOY_NEW_BIN}"
  log "skipping build and checks; deploying $new_bin"
else
  export CARGO_TARGET_DIR="$work/target"
  log "building into $CARGO_TARGET_DIR (scripts/build.sh --verify, runs cargo test)"
  scripts/build.sh --verify >>"$LOG" 2>&1 || abort "build/test failed"
  new_bin="$CARGO_TARGET_DIR/release/naru"
  for c in $CHECKS; do
    log "check $c"
    NARU_BIN="$new_bin" MESA_BIN="$new_bin" scripts/"$c.sh" >>"$LOG" 2>&1 || abort "$c failed"
  done
  unset CARGO_TARGET_DIR
fi
[ -x "$new_bin" ] || abort "no binary at $new_bin"

# ---- 2 pause + drain ---------------------------------------------------------------
"$new_bin" queue pause >>"$LOG" 2>&1 || abort "queue pause failed"
paused=1
trap 'resume_queue; rm -rf "$work"' EXIT
deadline=$(( $(date +%s) + DRAIN_TIMEOUT ))
until "$new_bin" queue idle >>"$LOG" 2>&1; do
  [ "$(date +%s)" -ge "$deadline" ] && abort "drain timeout after ${DRAIN_TIMEOUT}s"
  sleep "$POLL"
done
log "queue paused and idle"

# ---- 2b db backup ----------------------------------------------------------------
# Resolve the db the server really uses, once, before anything is backed up or swapped.
plist_env() { # plist_env <key>: the string under that EnvironmentVariables key
  local f="${NARU_LAUNCHD_DIR:-$HOME/Library/LaunchAgents}/com.naru.serve.plist"
  [ -f "$f" ] && awk -v k="$1" '$0 ~ "<key>"k"</key>" {getline; gsub(/.*<string>|<\/string>.*/, ""); print; exit}' "$f"
}
holds_data() { [ -s "$1" ] && command -v sqlite3 >/dev/null && [ "$(sqlite3 -readonly "$1" 'select (select count(*) from projects)+(select count(*) from tasks)' 2>/dev/null || echo 0)" != 0 ]; }
db="${NARU_DEPLOY_DB:-${NARU_DB:-${MESA_DB:-}}}"
[ -n "$db" ] || db="$(plist_env NARU_DB)"
[ -n "$db" ] || db="$(plist_env MESA_DB)"
if [ -z "$db" ]; then
  d="$HOME/Library/Application Support"; ndb="$d/naru/naru.db"; odb="$d/mesa/mesa.db"
  if [ -e "$ndb" ] && [ -e "$odb" ]; then
    if holds_data "$ndb" && holds_data "$odb"; then abort "both $ndb and $odb hold data; set NARU_DEPLOY_DB to the one the server uses"
    elif holds_data "$ndb"; then db="$ndb"
    elif holds_data "$odb"; then db="$odb"
    else abort "both $ndb and $odb exist and the live one cannot be told; set NARU_DEPLOY_DB"; fi
  elif [ -e "$odb" ]; then db="$odb"
  else db="$ndb"; fi
fi
[ -e "$db" ] || abort "resolved db $db does not exist; set NARU_DEPLOY_DB"
# The port the server listens on: NARU_DEPLOY_PORT, else `serve.port` in the config it
# reads (core::config::config_file: NARU_/MESA_CONFIG_FILE, else ~/.naru or ~/.mesa,
# the file itself or config.json in it), else the built-in 7770. A bare `naru serve`
# under launchd carries no port flag, so the config is the only place it can come from.
if [ -z "$PORT" ]; then
  cfg="${NARU_CONFIG_FILE:-${MESA_CONFIG_FILE:-}}"
  [ -n "$cfg" ] || cfg="$(plist_env NARU_CONFIG_FILE)"
  [ -n "$cfg" ] || cfg="$(plist_env MESA_CONFIG_FILE)"
  if [ -z "$cfg" ]; then
    cfg="$HOME/.naru"; [ -e "$cfg" ] || { [ -e "$HOME/.mesa" ] && cfg="$HOME/.mesa"; }
    [ -d "$cfg" ] && cfg="$cfg/config.json"
  fi
  [ -f "$cfg" ] && PORT="$(jq -r '.serve.port // empty' "$cfg" 2>/dev/null)"
  case "$PORT" in ''|*[!0-9]*) PORT=7770 ;; esac
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || PORT=7770
fi
log "health port: $PORT"
export NARU_DB="$db"
log "db: $db"
mkdir -p "$BACKUP_DIR" || abort "cannot create $BACKUP_DIR"
backup_db="$BACKUP_DIR/naru-pre-deploy-$(date +%Y%m%d-%H%M%S).db"
"$NARU" backup "$backup_db" >>"$LOG" 2>&1 || { backup_db=""; abort "db backup failed"; }
log "db backed up -> $backup_db"

# ---- 4a atomic swap ---------------------------------------------------------------
# Never write over the installed file: macOS SIGKILLs an overwritten binary (137).
mkdir -p "$BIN_DIR"
tmp="$(mktemp "$BIN_DIR/.naru.XXXXXX")" || abort "cannot create a temp file in $BIN_DIR"
prev="$(mktemp "$BIN_DIR/.naru.XXXXXX")" || { rm -f "$tmp"; abort "cannot create a temp file in $BIN_DIR"; }
if [ -e "$INSTALLED" ]; then
  cp -p "$INSTALLED" "$prev" && mv -f "$prev" "$BIN_DIR/naru.prev" || { rm -f "$tmp" "$prev"; abort "cannot keep naru.prev"; }
else
  rm -f "$prev"
fi
install -m 0755 "$new_bin" "$tmp" || { rm -f "$tmp"; abort "cannot stage the new binary"; }
command -v codesign >/dev/null 2>&1 && codesign --force --sign - "$tmp" >/dev/null 2>&1
mv -f "$tmp" "$INSTALLED" || { rm -f "$tmp"; abort "swap failed"; }
ln -sf naru "$BIN_DIR/mesa"
log "swapped $INSTALLED (previous kept as naru.prev)"

# ---- 4 restart + health, rollback on failure ----------------------------------------
live_before="$("$NARU" live status 2>/dev/null | jq -r 'select(.status=="live") | .agent_id // "none"')"

restart() {
  local cmd="${NARU_DEPLOY_RESTART_CMD:-}"
  if [ -z "$cmd" ] && [ "$(uname -s)" = Darwin ] && [ -e "${NARU_LAUNCHD_DIR:-$HOME/Library/LaunchAgents}/com.naru.serve.plist" ]; then
    cmd="${NARU_LAUNCHCTL:-launchctl} kickstart -k gui/$(id -u)/com.naru.serve"
    log "NARU_DEPLOY_RESTART_CMD unset: using the launchd agent ($cmd)"
  fi
  [ -n "$cmd" ] || { log "NARU_DEPLOY_RESTART_CMD unset: cannot restart"; return 1; }
  bash -c "$cmd" >>"$LOG" 2>&1 || return 1
  restarted=true
}
# The live agent survives a server restart and reconnects under the same agent_id, so
# the check is: the session is still `live`, and a say round trip works (the new turn
# reads back from `live turns`). `listen` is not used: it would consume a pending utterance.
live_ok() {
  local bin="$1" tid
  "$bin" live status 2>/dev/null | jq -e '.status=="live"' >/dev/null 2>&1 || return 1
  tid="$("$bin" live say --quiet "Deploy health check." 2>>"$LOG" | jq -r '.id // empty')"
  [ -n "$tid" ] || return 1
  "$bin" live turns --after "$((tid - 1))" 2>>"$LOG" | jq -e --argjson id "$tid" 'any(.[]; .id==$id)' >/dev/null 2>&1
}
# healthy <bin> <check live session 0|1>
healthy() {
  local bin="$1" live="$2" want end
  want="$("$bin" --version 2>/dev/null | awk '{print $2}')"
  end=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    if [ -n "${NARU_DEPLOY_HEALTH_CMD:-}" ]; then
      NARU_DEPLOY_EXPECT="$want" bash -c "$NARU_DEPLOY_HEALTH_CMD" >>"$LOG" 2>&1 && ok=1 || ok=0
    else
      curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/version" 2>>"$LOG" | jq -e --arg v "$want" '.version==$v' >/dev/null 2>&1 && ok=1 || ok=0
    fi
    if [ "$ok" -eq 1 ] && [ "$live" -eq 1 ]; then
      live_ok "$bin" || ok=0
    fi
    [ "$ok" -eq 1 ] && return 0
    [ "$(date +%s)" -ge "$end" ] && return 1
    sleep "$POLL"
  done
}

# Park the old Task loop (and its child) under a backup name, then reseed: defaults
# skips an existing name, so without the rename a changed graph never lands. A rollback
# restores the db backup, which undoes the renames.
seed_task_loop() {
  local pid ts wf id name
  pid="$("$new_bin" project resolve "$repo" 2>/dev/null | jq -r '.id // empty')"
  [ -n "$pid" ] || pid="$("$new_bin" project resolve naru 2>/dev/null | jq -r '.id // empty')"
  [ -n "$pid" ] || { echo "self-deploy: cannot resolve the naru project id" >>"$LOG"; return 1; }
  ts="$(date +%Y%m%d-%H%M%S)"
  for name in "Task loop" "Task loop: implement and review"; do
    id="$("$new_bin" workflow list "$pid" 2>>"$LOG" | jq -r --arg n "$name" '.[] | select(.name==$n) | .id' | head -n 1)"
    [ -n "$id" ] || continue
    "$new_bin" workflow update "$id" --name "$name (pre-$ts backup)" --enabled false >>"$LOG" 2>&1 || return 1
  done
  "$new_bin" workflow defaults --project "$pid" --task-loop >>"$LOG" 2>&1
}

fail_reason=""
if ! restart; then fail_reason="server restart failed"
elif ! seed_task_loop; then fail_reason="workflow defaults --task-loop failed"
else
  chk=1; { [ -z "$live_before" ] || [ "${NARU_DEPLOY_LIVE_CHECK:-1}" = 0 ]; } && chk=0
  healthy "$INSTALLED" "$chk" || fail_reason="health check failed (version, live session)"
fi

if [ -z "$fail_reason" ]; then
  resume_queue
  log "healthy; queue resumed"
  verdict swapped "binary swapped, server restarted and healthy"
  exit 0
fi

log "UNHEALTHY: $fail_reason; rolling back"
[ -s "$LOG" ] && tail -n 20 "$LOG" >&2
rb=""
# naru.prev was signed when installed: copy it as is, re-signing would change its bytes.
rtmp="$(mktemp "$BIN_DIR/.naru.XXXXXX")" && cp -p "$BIN_DIR/naru.prev" "$rtmp" \
  && mv -f "$rtmp" "$INSTALLED" || rb="binary restore failed"
[ -n "$rb" ] || cmp -s "$BIN_DIR/naru.prev" "$INSTALLED" || rb="binary restore not byte-identical"
if [ -z "$rb" ] && [ -f "$backup_db" ]; then
  # Only ever overwrite the db the server uses: it must already exist, so a restore can
  # never create a second db beside it.
  # Restore via temp file + mv (the running server keeps the old inode until the
  # restart below), then drop the stale WAL/SHM so the restored file is read alone.
  dtmp="$db.restore.$$"
  if [ -f "$db" ] && cp "$backup_db" "$dtmp"; then
    mv -f "$dtmp" "$db" && rm -f "$db-wal" "$db-shm" || rb="db restore failed"
  else
    rm -f "$dtmp"; rb="db restore failed"
  fi
fi
if [ -z "$rb" ]; then
  restart || rb="restart after rollback failed"
fi
if [ -z "$rb" ]; then
  healthy "$INSTALLED" 0 || rb="rolled-back server unhealthy"
fi
if [ -z "$rb" ]; then
  resume_queue
  verdict rolled_back "$fail_reason"
else
  log "ROLLBACK FAILED: $rb; queue left paused"
  paused=1 ; trap 'rm -rf "$work"' EXIT
  verdict rollback_failed "$fail_reason; $rb"
fi
exit 1
