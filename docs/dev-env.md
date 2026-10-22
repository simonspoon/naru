# Dev environment (naru tasks 2090–2094)

Dev work never touches the person's real install. This page is the one place
the ports, paths and ids live; agents' rules point here.

## Never touch (the real install)

Except through `scripts/self-deploy.sh` (the live agent's deploy path):

- `~/.local/bin/naru` (and `mesa`)
- launchd `com.naru.serve`, port **:7777**
- launchd `com.naru.audio`, port **:7870** (`~/.naru-audio`)
- `/Applications/Naru.app` (bundle id `com.naru.mac`)

So: no `scripts/install.sh`, no `cargo install`, no `launchctl` on a
`com.naru.*` label, no write under `/Applications/Naru.app`, no QA against :7777.

## Use instead

| Piece | Dev value | How |
| --- | --- | --- |
| naru serve | **:7771** | `scripts/dev-env.sh` (after `scripts/build.sh`; naru task 2091) |
| naru-audio daemon | **:7871** | `scripts/dev-audio.sh` in this repo (naru task 2092); state in `~/.naru-audio-dev` |
| Mac app | **Naru Beta**, bundle id `com.naru.mac.beta` | naru-mac `build.sh --beta` (naru task 2093), pointed at :7771 |
| State | `~/.naru-dev` | all of the variables below |

`scripts/dev-env.sh` exports `NARU_HOME`, `NARU_DB`, `NARU_CONFIG_FILE`,
`NARU_KB_DIR`, `NARU_HOOKS_FILE` and `NARU_ATTACHMENTS_DIR` (all under
`~/.naru-dev`) and `NARU_AUDIO_URL=http://127.0.0.1:7871`, and runs
`serve --port 7771` with every watcher off. It refuses port 7777. The binary
id of the CLI is `com.naru.cli`.

## The guard hook (naru task 2094)

`dev-env-guard` is a library built-in `PreToolUse` hook (`core::dev_guard`)
that denies, with a reason naming this page: a Bash command containing
`install.sh`, `cargo install`, or `launchctl` together with `com.naru.`, and a
Bash/Write/Edit touching `/Applications/Naru.app`. `scripts/self-deploy.sh` and
`scripts/dev-env.sh` command lines pass, and so does the `naru-live` main
agent (`agent_type` `naru-live`, no `agent_id`). It fails open (no `jq`,
garbage stdin) and is a guardrail, not a security boundary: an obfuscated
`bash -c` can dodge it. Since naru task 2255 it also denies a Bash `naru serve` / `mesa serve` (also
`target/release/naru serve`, `./…/mesa serve`) whose `NARU_DB`/`MESA_DB`/
`NARU_HOME`/`MESA_HOME` — read from an assignment in the command, else from the
hook's environment — is a real data location (`~/Library/Application
Support/{naru,mesa}`, `~/.naru`, `~/.mesa`, spelled `~`, `$HOME` or absolute),
or when none of the four is set at all (it would open the real db). Fix: use
`scripts/dev-env.sh`, or set `NARU_HOME` and `NARU_DB` to a temp dir. Plain CLI
(`naru task list`, `naru live say`…) is never touched; other db-opening runs
are left alone on purpose, since blocking them would block normal CLI use.
Enable it (it edits `~/.claude/settings.json`, so the
person runs this):

```
naru library hook enable dev-env-guard.sh --event PreToolUse --matcher 'Bash|Write|Edit'
```

Gate: `scripts/dev-env-guard-check.sh`.
