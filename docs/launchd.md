# Running `naru serve` under launchd

macOS only (naru task 2042). A hand-run `naru serve` gives `scripts/self-deploy.sh` nothing
to restart, so a real redeploy rolls back. The `com.naru.serve` user agent fixes that.

- `scripts/launchd.sh install` renders `scripts/launchd/com.naru.serve.plist.in` to
  `~/Library/LaunchAgents/com.naru.serve.plist`, lints it, then `launchctl bootout`
  (ignored if absent), `bootstrap gui/<uid>` and `kickstart`. `scripts/install.sh --launchd`
  does the same after the binary install. Both are opt-in; nothing loads it automatically.
- `bootout` is asynchronous, so install polls `launchctl print` until the old service is
  gone (up to `NARU_LAUNCHD_WAIT` seconds, default 10), retries a failed `bootstrap` (the
  `5: Input/output error` of a service still tearing down) up to 5 times, and checks the
  service is loaded after `kickstart`. If it is not, it exits 1 with no `ok:` line and
  names the `launchctl bootstrap` command to run by hand (naru task 2164).
  `NARU_LAUNCHD_LABEL` replaces `com.naru.serve` (label and plist name) so the real-launchd
  path can be tested under a dev label without touching the real agent.
- `scripts/install.sh --launchd` then proves the restart took (naru task 2655): it polls
  `/api/version` on the serve port (`NARU_INSTALL_PORT`, else the config's `serve.port`,
  else 7770) for up to `NARU_INSTALL_WAIT` seconds (default 30) until it reports the
  installed binary's `version`, `commit` and `built_at` (the stamp `naru --version` prints
  as `naru <version> (<commit> <built_at>)`), then prints `serving <version> <commit>`. A
  server still on another build exits 1 naming both (`installed … serving …`).
- It runs `$PREFIX/bin/naru serve` (default `~/.local/bin`), no flags, so the `serve` config
  section applies (its `port`, else 7770). `scripts/self-deploy.sh` health-checks that same
  port (`NARU_DEPLOY_PORT` overrides). `RunAtLoad` + `KeepAlive`.
- Logs: `~/.naru/serve.log` and `~/.naru/serve.err.log`.
- Env: launchd starts with a bare environment, so the plist sets `HOME` and a `PATH`.
  The `PATH` is the installing user's interactive login-shell `PATH` (`$SHELL -ilc`, so
  dirs added in `.zshrc` such as pnpm's or nvm's node are kept; absolute entries only),
  followed by `~/.local/bin`, Homebrew and the system dirs, duplicates dropped; a shell that
  fails gives just those fixed dirs. Workflow `cli` nodes inherit it from `naru serve`. It is
  read once at install, so re-run `scripts/launchd.sh install` after adding a tool dir.
  `NARU_LAUNCHD_SHELL` names a different shell to ask (the gate's stub). `NARU_DB`, `MESA_DB`, `MESA_CONFIG_FILE` and
  `NARU_AUDIO_URL` are copied in only if set in the shell that runs the install; run the
  install from the shell that started the manual server to keep the same db. Re-run to change.
- `scripts/launchd.sh install --print` shows the plist; `--dry-run` shows the plan.
  `uninstall` boots the agent out and removes the plist.
- `scripts/launchd.sh restart` (naru task 2817) re-loads the plist already installed,
  unchanged: the same bootout, bootstrap (with its wait and retries) and kickstart, and
  exits 1 with no plist. Why not a bare `kickstart -k`: an agent launchd loaded at login
  is managed by Background Task Management, with a launch constraint (`managed LWCR`,
  `launchctl print` shows it under `properties`) pinned to the binary's cdhash. After the
  binary is swapped, a kickstart leaves it `job state = spawn failed`. A bootstrap from a
  shell carried no such constraint in every case checked (the 2026-11-04 incident was fixed
  by exactly that), so it spawns the new binary. The cost: between bootout and bootstrap
  the job is unloaded, so a restart cut short there leaves no `KeepAlive` to bring it back
  (run `scripts/launchd.sh restart` again).
- Self-deploy: with `NARU_DEPLOY_RESTART_CMD` unset and the plist present
  (`$NARU_LAUNCHD_DIR/$NARU_LAUNCHD_LABEL.plist`, defaults as above) it restarts with
  `scripts/launchd.sh restart`; an explicit value always wins; no plist keeps "unset =
  cannot restart". Other platforms are unchanged.

## One manual cutover

1. Quit the terminal `naru serve` (two servers on 7770 collide).
2. From the shell that has the right db env: `scripts/launchd.sh install`.
3. Check `curl -s http://127.0.0.1:7770/api/version`.

Gate: `scripts/launchd-check.sh` (stub `launchctl`, never touches the real agent).
