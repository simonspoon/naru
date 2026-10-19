#!/usr/bin/env bash
# Run a dev naru-audio daemon on 127.0.0.1:7871 (naru task 2092), the other half
# of scripts/dev-env.sh (whose NARU_AUDIO_URL points here). On demand only, in
# the foreground (models use a lot of RAM): no launchd, no autostart. Never
# touches the real install (~/.naru-audio, launchd com.naru.audio :7870) — the
# dev home ~/.naru-audio-dev only *links* the shared, read-mostly pieces.
#
# Note: models/ is a symlink to the real one, so a model pulled by the dev
# daemon lands in the real models dir. Everything else (state/, tmp/, logs,
# mlx/ scripts, config.toml) is dev-local.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bin="${NARU_AUDIO_BIN:-$root/../naru-audio/target/release/naru-audio}"
dev="${NARU_AUDIO_DEV_DIR:-$HOME/.naru-audio-dev}"
real="$HOME/.naru-audio"
port="${NARU_AUDIO_DEV_PORT:-7871}"

if [ ! -x "$bin" ]; then
  echo "dev-audio: $bin missing; build naru-audio first (cargo build --release in its repo)" >&2
  exit 1
fi
if [ "$port" = 7870 ] || [ "$port" = 7777 ]; then
  echo "dev-audio: refusing port $port (the real install's)" >&2
  exit 1
fi
if [ "$dev" = "$real" ]; then
  echo "dev-audio: refusing the real home $real" >&2
  exit 1
fi

mkdir -p "$dev" "$dev/mlx"

# models: shared by symlink (multi-GB).
if [ -d "$real/models" ]; then
  ln -sfn "$real/models" "$dev/models"
fi

# mlx/: a real dir, because the daemon rewrites naru_audio_mlx/*.py there at
# startup and must not overwrite the real install's scripts; only the venv is
# linked.
if [ -d "$real/mlx/.venv" ]; then
  ln -sfn "$real/mlx/.venv" "$dev/mlx/.venv"
else
  echo "dev-audio: no $real/mlx/.venv; MLX will be unavailable" >&2
fi

# config.toml: copied once (its [mlx] python is an absolute path into the real
# venv, which still works); dev writes never reach the real file.
if [ -f "$real/config.toml" ] && [ ! -e "$dev/config.toml" ]; then
  cp "$real/config.toml" "$dev/config.toml"
fi

echo "dev-audio: pid $$ port $port home $dev" >&2
export NARU_AUDIO_HOME="$dev"
exec "$bin" serve --listen "127.0.0.1:$port"
