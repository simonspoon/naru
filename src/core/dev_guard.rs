//! Dev-sandbox guard (naru task 2094, `docs/dev-env.md`): a Claude Code
//! `PreToolUse` hook that denies a task-loop agent the commands that would
//! install to, restart or overwrite the person's real install. Ships as a
//! library hook built-in the person registers with `naru library hook enable`.

/// The library built-in holding [`DEV_GUARD_HOOK`] — the bare id.
pub const DEV_GUARD_HOOK_BUILTIN: &str = "dev-env-guard";

/// The built-in's name — the filename it is seeded under in `.claude/hooks/`.
pub const DEV_GUARD_HOOK_NAME: &str = "dev-env-guard.sh";

/// The hook script. It **exits 0 always** and prints a deny decision only for
/// the cases below; every miss (no `jq`, garbage or empty stdin) allows.
/// `scripts/dev-env-guard-check.sh` is its gate.
pub const DEV_GUARD_HOOK: &str = r##"#!/usr/bin/env bash
# dev-env-guard.sh — a Claude Code PreToolUse hook (naru task 2094).
# Installed with:
#   naru library hook enable dev-env-guard.sh --event PreToolUse --matcher 'Bash|Write|Edit'
#
# Denies, for task-loop agents: install.sh, cargo install, launchctl on a
# com.naru.* label, and any write to /Applications/Naru.app. The naru-live main
# agent and scripts/self-deploy.sh / scripts/dev-env.sh command lines pass.
# It also denies `naru serve` / `mesa serve` (naru task 2255) unless NARU_DB /
# MESA_DB / NARU_HOME / MESA_HOME (from an assignment in the command, else the
# hook's environment) name somewhere other than the real data locations, or
# when none is set (the serve would open the real db).
# A guardrail, not a security boundary. Never fails a tool call otherwise.
command -v jq >/dev/null 2>&1 || exit 0

# Is $1 (a path as typed: ~, $HOME, ${HOME} or absolute) a real data location?
real_loc() {
  local p="$1" h="${HOME:-}"
  [ -n "$h" ] || return 1
  case "$p" in
    "~"|"~/"*) p="$h${p#\~}" ;;
    '$HOME'|'$HOME/'*) p="$h${p#\$HOME}" ;;
    '${HOME}'|'${HOME}/'*) p="$h${p#\$\{HOME\}}" ;;
  esac
  local r
  for r in "$h/Library/Application Support/naru" "$h/Library/Application Support/mesa" "$h/.naru" "$h/.mesa"; do
    case "$p" in "$r"|"$r"/*) return 0 ;; esac
  done
  return 1
}

# Echo the serve problem for command $1, or nothing (allow).
serve_problem() {
  local cmd="$1" v val any=0 nl=$'\n' stripped
  # Drop heredoc bodies and quoted spans, so prose that merely mentions
  # `naru serve` (a commit message, an echo) is not a serve.
  stripped=$(printf '%s\n' "$cmd" | awk '
    hd != "" { t = $0; if (hdd) sub(/^\t+/, "", t); if (t == hd) hd = ""; next }
    { line = $0; out = ""; q = ""; n = length(line)
      for (i = 1; i <= n; i++) { c = substr(line, i, 1)
        if (q != "") { if (c == q) q = ""; else if (q == "\"" && c == "\\") i++; continue }
        if (c == "\\") { out = out c substr(line, i + 1, 1); i++; continue }
        if (c == "\047" || c == "\"") { q = c; continue }
        out = out c }
      if (match(line, /<<-?[ \t]*["\047]?[A-Za-z_][A-Za-z0-9_]*/)) {
        d = substr(line, RSTART, RLENGTH); hdd = (d ~ /^<<-/)
        gsub(/^<<-?[ \t]*["\047]?/, "", d); hd = d }
      print out }' 2>/dev/null) || return 0
  local sre='(^|[;&|('"$nl"'])[[:space:]]*(env[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*=([^[:space:]\\]|\\.)*[[:space:]]+)*([^[:space:]]*/)?(naru|mesa)[[:space:]]+serve([[:space:];&|)]|$)'
  [[ "$stripped" =~ $sre ]] || return 0
  for v in NARU_DB MESA_DB NARU_HOME MESA_HOME; do
    local are='(^|[[:space:];&|(])'"$v"'=("[^"]*"|'"'"'[^'"'"']*'"'"'|([^[:space:];&|\\]|\\.)*)'
    if [[ "$cmd" =~ $are ]]; then val="${BASH_REMATCH[2]}"
    else val="${!v:-}"; fi
    val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
    val="${val//\\/}"
    [ -n "$val" ] || continue
    any=1
    if real_loc "$val"; then echo "$v=$val is the real data location"; return 0; fi
  done
  [ "$any" = 1 ] || echo "naru serve with no NARU_HOME/NARU_DB set would open the real database"
  return 0
}
input=$(cat 2>/dev/null) || exit 0
[ -n "$input" ] || exit 0

# The live voice agent (main thread: agent_type naru-live, no agent_id) deploys.
live=$(printf '%s' "$input" | jq -r 'if (.agent_type == "naru-live") and (has("agent_id") | not) then "yes" else "no" end' 2>/dev/null) || exit 0
[ "$live" = yes ] && exit 0

tool=$(printf '%s' "$input" | jq -r '.tool_name | strings' 2>/dev/null) || exit 0
why=""
app="/Applications/Naru.app"
case "$tool" in
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command | strings' 2>/dev/null) || exit 0
    case "$cmd" in
      *self-deploy.sh*|*dev-env.sh*) exit 0 ;;
    esac
    case "$cmd" in
      *install.sh*) why="scripts/install.sh installs onto the real PATH" ;;
      *"cargo install"*) why="cargo install overwrites the real binary" ;;
      *launchctl*com.naru.*|*com.naru.*launchctl*) why="launchctl on a com.naru.* service restarts the real install" ;;
      *"$app"*) why="$app is the real app" ;;
    esac
    if [ -z "$why" ]; then
      sp=$(serve_problem "$cmd")
      [ -z "$sp" ] || why="$sp (a throwaway serve must set NARU_HOME and NARU_DB to a temp dir, or use scripts/dev-env.sh)"
    fi
    ;;
  Write|Edit)
    path=$(printf '%s' "$input" | jq -r '.tool_input.file_path | strings' 2>/dev/null) || exit 0
    case "$path" in
      "$app"|"$app"/*) why="$app is the real app" ;;
    esac
    ;;
esac
[ -n "$why" ] || exit 0

jq -nc --arg r "Dev sandbox: $why. Never install to, restart or overwrite the real install (~/.local/bin/naru, com.naru.serve :7777, com.naru.audio :7870, $app); use scripts/dev-env.sh (:7771). See docs/dev-env.md." \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}' 2>/dev/null
exit 0
"##;

#[cfg(test)]
mod tests {
    use super::DEV_GUARD_HOOK;
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// Run the hook on a Bash `command` with HOME=/h and the given env;
    /// true when it printed a deny. None when `jq` is missing (skip).
    fn denies(command: &str, env: &[(&str, &str)]) -> Option<bool> {
        if Command::new("jq").arg("--version").output().is_err() {
            return None;
        }
        let payload = serde_json::json!({"tool_name": "Bash", "tool_input": {"command": command}});
        let mut c = Command::new("bash");
        c.args(["-c", DEV_GUARD_HOOK])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap())
            .env("HOME", "/h")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        for (k, v) in env {
            c.env(k, v);
        }
        let mut child = c.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.to_string().as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        Some(String::from_utf8_lossy(&out.stdout).contains("\"deny\""))
    }

    #[test]
    fn serve_rule() {
        let real = "/h/Library/Application Support/naru/naru.db";
        type Case<'a> = (&'a str, &'a [(&'a str, &'a str)], bool);
        let cases: &[Case] = &[
            ("naru serve", &[], true),
            ("target/release/naru serve --port 7799", &[], true),
            ("./target/debug/mesa serve", &[], true),
            ("cd x && naru serve", &[], true),
            ("NARU_DB=~/.naru/naru.db naru serve", &[], true),
            (
                "NARU_DB=\"$HOME/Library/Application Support/naru/naru.db\" naru serve",
                &[],
                true,
            ),
            (
                "NARU_DB='/h/Library/Application Support/mesa/mesa.db' mesa serve",
                &[],
                true,
            ),
            ("export NARU_HOME=$HOME/.mesa; naru serve", &[], true),
            ("naru serve", &[("NARU_DB", real)], true),
            (
                "NARU_DB=/tmp/x/n.db naru serve",
                &[("NARU_HOME", "/h/.naru")],
                true,
            ),
            (
                "NARU_HOME=/tmp/x NARU_DB=/tmp/x/naru.db naru serve --port 7799",
                &[],
                false,
            ),
            (
                "naru serve",
                &[("NARU_HOME", "/tmp/x"), ("NARU_DB", "/tmp/x/n.db")],
                false,
            ),
            (
                "NARU_DB=/tmp/x/n.db naru serve",
                &[("NARU_DB", real)],
                false,
            ),
            ("NARU_HOME=~/.naru-dev naru serve", &[], false),
            (
                "NARU_HOME=/h/Library/Application\\ Support/naru naru serve",
                &[],
                true,
            ),
            ("env NARU_DB=/h/.naru/naru.db naru serve", &[], true),
            ("echo hi\nnaru serve", &[], true),
            ("git commit -m \"fix naru serve guard\"", &[], false),
            ("naru live say \"restart naru serve\"", &[], false),
            ("echo naru serve", &[], false),
            ("cat <<EOF\nnaru serve\nEOF", &[], false),
            ("scripts/dev-env.sh", &[], false),
            ("scripts/self-deploy.sh", &[], false),
            ("naru task list", &[], false),
            ("naru live status", &[("NARU_DB", real)], false),
            ("naru live say serve", &[], false),
        ];
        for (cmd, env, want) in cases {
            match denies(cmd, env) {
                Some(got) => assert_eq!(got, *want, "{cmd} {env:?}"),
                None => return,
            }
        }
    }
}
