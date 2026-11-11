//! Dev-sandbox guard (naru task 2094, `docs/dev-env.md`): a Claude Code
//! `PreToolUse` hook that denies an agent the commands that would
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
# naru-hook: PreToolUse Bash|Write|Edit
# dev-env-guard.sh — a Claude Code PreToolUse hook (naru task 2094).
# Installed with:
#   naru library hook enable dev-env-guard.sh --event PreToolUse --matcher 'Bash|Write|Edit'
#
# Denies, for agents: install.sh, cargo install, launchctl on a
# com.naru.* label, and any write to /Applications/Naru.app. The naru-live main
# agent and scripts/self-deploy.sh / scripts/dev-env.sh command lines pass.
# It also denies `naru serve` / `mesa serve` (naru task 2255) unless NARU_DB /
# MESA_DB / NARU_HOME / MESA_HOME (from an assignment in the command, else the
# hook's environment) name somewhere other than the real data locations, or
# when none is set (the serve would open the real db).
# An install.sh / cargo install / launchctl-on-com.naru.* mention that sits
# only inside quotes, as an argument of a command that just reads or records
# text (git commit -m, naru task note, echo, grep ...), is data and passes.
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
    esac
    # The match above can only be lifted, never added to: python prints
    # "data" when every mention sits inside quotes as an argument of a
    # text-only command (git commit -m, naru task note, echo, grep ...) in a
    # plain command list. Any pipe, redirect, subshell, brace, heredoc,
    # command substitution (even inside quotes), ANSI-C quote, unbalanced
    # quote, assignment of a mention, a mention outside quotes, or a glob,
    # $ or backslash in any other segment (a decoy mention must not wave an obfuscated run
    # through) keeps the deny; so does a missing python3.
    # One unquoted form also lifts (naru task 2709): install.sh named as a
    # plain path argument of a pure reader (cat less more head tail grep rg
    # ls wc diff touch, find without -exec/-ok/-delete/-fprint) or of git
    # add/commit/diff/log/show/status, with no option that runs or writes
    # (rg --pre, less +cmd/-o, git --ext-diff/--output ...). Then every
    # segment must be such a command or a text-only one, with no assignment
    # prefix, so no export, alias, git config or env var set alongside can
    # turn the reader into a runner; the option bans hold in every segment,
    # any $ anywhere keeps the deny (zsh ${(e)...} inside double quotes runs
    # code), and naru/mesa must be bare. cp and mv stay denied: a copy under
    # another name could be run later, out of the hook's sight.
    if [ -n "$why" ]; then
      data=$(printf '%s' "$cmd" | python3 -c '
import re, sys
cmd = sys.stdin.read()
FR = ("install.sh", "cargo install", "launchctl", "com.naru.")
DATA = set("echo grep egrep fgrep cat head tail ls wc jq helios git naru mesa".split())
SUB = {"git": set("add commit log show diff status tag".split()), "naru": set("task inbox live memory kb ask notify".split())}
SUB["mesa"] = SUB["naru"]
UREAD = set("cat less more head tail grep egrep fgrep rg ls wc diff touch find".split())
UGIT = set("add commit diff log show status".split())
OK = DATA | UREAD | {"cd", "pwd", "true"}
FIND_BAN = set("-exec -execdir -ok -okdir -delete -rm -fprint -fprint0 -fprintf -fls".split())
def loose_ok(s):
    u = " ".join(x[1] for x in s)
    if "cargo install" in u or "com.naru." in u or re.search(r"[*?\[\]$\\#]", u): return False
    r0, u0 = s[0][0], s[0][1]
    args = [x[2] for x in s[1:]]
    if r0 != u0 or (r0 not in UREAD and not (r0 == "git" and args and args[0] in UGIT)): return False
    if any("install.sh" in u and v[:1] in ("-", "+") for w, u, v in s[1:]): return False
    return opts_ok(s)
def opts_ok(s):
    r0 = s[0][0]
    for w, u, v in s[1:]:
        if r0 == "find" and v in FIND_BAN: return False
        if r0 == "rg" and v.startswith(("--pre", "--hostname-bin")): return False
        if r0 in ("grep", "egrep", "fgrep") and re.match(r"--(?:filter|pager|view)|-[A-Za-z]*Q", v): return False
        if r0 == "git" and v.startswith(("--ext-diff", "--textconv", "--output")): return False
        if r0 in ("less", "more") and re.match(r"\+|-[A-Za-z]*[oOk]|--(?:log|LOG|lesskey)", v): return False
    return True
if "$\x27" in cmd or "$(" in cmd or "`" in cmd: sys.exit(0)
segs, raw, unq, val, bare, q, w, i = [[]], "", "", "", "", "", False, 0
def flush():
    global raw, unq, val, w
    if w: segs[-1].append((raw, unq, val))
    raw, unq, val, w = "", "", "", False
while i < len(cmd):
    c = cmd[i]
    if q:
        raw += c
        if c == q: q = ""
        elif q == "\"" and c == "\\" and i + 1 < len(cmd): i += 1; raw += cmd[i]; val += cmd[i]
        else: val += c
    elif c in "\x27\"": q, raw, w = c, raw + c, True
    elif c == "\\": raw += cmd[i:i+2]; unq += cmd[i:i+2]; val += cmd[i+1:i+2]; bare += cmd[i:i+2]; w = True; i += 1
    elif c in " \t": flush(); bare += c
    elif c in ";&|\n": flush(); segs.append([]); bare += c
    else: raw += c; unq += c; val += c; bare += c; w = True
    i += 1
flush()
if q or re.search(r"[<>(){}]", bare) or "|" in bare.replace("||", ""): sys.exit(0)
loose = False
for s in segs:
    if not any(f in " ".join(x[2] for x in s) for f in FR):
        if any(re.search(r"[*?\[$\\]", x[0]) for x in s): sys.exit(0)
        continue
    if any(f in " ".join(x[1] for x in s) for f in FR):
        if not loose_ok(s): sys.exit(0)
        loose = True
        continue
    k = 0
    while k < len(s) and re.match(r"[A-Za-z_]\w*=", s[k][0]):
        if any(f in s[k][2] for f in FR): sys.exit(0)
        k += 1
    if k == len(s): sys.exit(0)
    r0, u0 = s[k][0], s[k][1]
    base = r0.rsplit("/", 1)[-1]
    if r0 != u0 or "$" in r0 or "\\" in r0 or base not in DATA or ("/" in r0 and base not in ("naru", "mesa")): sys.exit(0)
    args = [x[0] for x in s[k+1:]]
    if base in SUB and (not args or args[0] not in SUB[base]): sys.exit(0)
if loose and "$" in cmd: sys.exit(0)
for s in segs if loose else []:
    if not s: continue
    r0 = s[0][0]
    args = [x[0] for x in s[1:]]
    if r0 != s[0][1] or r0 not in OK or not opts_ok(s): sys.exit(0)
    if r0 in SUB and (not args or args[0] not in SUB[r0]): sys.exit(0)
print("data")
' 2>/dev/null) || data=""
      [ "$data" = data ] && why=""
    fi
    case "$cmd" in
      *"$app"*) [ -n "$why" ] || why="$app is the real app" ;;
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

    /// The quote-aware lift (naru task 2707): a mention inside quotes as an
    /// argument of a text-only command passes; everything the plain
    /// substring match blocked before still blocks.
    #[test]
    fn install_rule_quoted_mentions() {
        let cases: &[(&str, bool)] = &[
            // blocked before, still blocked
            ("scripts/install.sh", true),
            ("./scripts/install.sh", true),
            ("\"scripts/install.sh\"", true),
            ("bash scripts/install.sh", true),
            ("bash \"scripts/install.sh\"", true),
            ("sh -c \"scripts/install.sh\"", true),
            ("eval \"scripts/install.sh\"", true),
            ("env \"scripts/install.sh\"", true),
            ("echo \"scripts/install.sh\" | bash", true),
            ("(echo \"scripts/install.sh\") | sh", true),
            ("bash <(echo \"scripts/install.sh\")", true),
            ("echo \"scripts/install.sh\" > f", true),
            ("echo \"$(scripts/install.sh)\"", true),
            ("echo \"`scripts/install.sh`\"", true),
            ("echo $'scripts/install.sh'", true),
            ("x=\"scripts/install.sh\"; bash \"$x\"", true),
            ("export X=\"scripts/install.sh\"; bash \"$X\"", true),
            ("printf -v x \"scripts/install.sh\"; bash \"$x\"", true),
            ("GIT_PAGER=\"scripts/install.sh\" git log", true),
            ("git -c core.pager=\"scripts/install.sh\" log", true),
            ("git grep -O\"scripts/install.sh\" x", true),
            ("rg --pre \"scripts/install.sh\" x", true),
            ("echo \"'$(scripts/install.sh)'\"", true),
            ("echo \"'`scripts/install.sh`'\"", true),
            ("printf '-v' x 'scripts/install.sh'; bash \"$x\"", true),
            ("echo \"install.sh\"; bash scripts/inst*ll.sh", true),
            (
                "x=scripts/inst; echo \"install.sh\"; bash \"$x\"all.sh",
                true,
            ),
            ("echo \"install.sh\"; bash scripts/ins''tall.sh", true),
            ("echo \"install.sh\"; bash scripts/ins\\\ntall.sh", true),
            ("echo \"install.sh\"; bash scripts/ins\"\\\n\"tall.sh", true),
            (
                "rg --hostname-bin 'scripts/install.sh' --hyperlink-format x .",
                true,
            ),
            ("naru script create x --body \"scripts/install.sh\"", true),
            ("echo \"install.sh\"; scripts/install\".sh\"", true),
            ("echo \"install.sh", true),
            ("cat <<EOF\nscripts/install.sh\nEOF", true),
            ("git commit -m \"x\" # install.sh", true),
            ("cargo install --path .", true),
            ("echo \"x\" && cargo install --path .", true),
            (
                "git commit -m \"cargo install\" && cargo install --path .",
                true,
            ),
            ("launchctl kickstart -k gui/501/com.naru.serve", true),
            ("launchctl kickstart -k \"gui/501/com.naru.serve\"", true),
            (
                "L=\"gui/501/com.naru.serve\"; launchctl kickstart -k \"$L\"",
                true,
            ),
            ("git commit -m \"install.sh\" && naru serve", true),
            (
                "git commit -m \"install.sh\" && cp x /Applications/Naru.app/x",
                true,
            ),
            // a merely quoted mention is data
            ("git commit -m \"fix the scripts/install.sh guard\"", false),
            ("naru task note 1 \"ran scripts/install.sh\"", false),
            (
                "target/release/naru task update 5 --result 'install.sh ok'",
                false,
            ),
            ("naru live say 'install.sh is done'", false),
            ("echo \"cargo install\"", false),
            ("grep -n \"install.sh\" docs/dev-env.md", false),
            ("cargo test && git commit -m \"task 1: install.sh\"", false),
            ("git commit -m 'launchctl kickstart com.naru.serve'", false),
        ];
        for (cmd, want) in cases {
            match denies(cmd, &[]) {
                Some(got) => assert_eq!(got, *want, "{cmd}"),
                None => return,
            }
        }
    }

    /// The unquoted reader lift (naru task 2709): a pure reader or git
    /// staging/inspection command may name install.sh as a plain path; no
    /// execution form passes.
    #[test]
    fn install_rule_unquoted_readers() {
        let cases: &[(&str, bool)] = &[
            // readers and git naming the path
            ("cat scripts/install.sh", false),
            ("less scripts/install.sh", false),
            ("more scripts/install.sh", false),
            ("head -n 20 scripts/install.sh", false),
            ("tail scripts/install.sh", false),
            ("grep -n launchctl scripts/install.sh", false),
            ("rg -n codesign scripts/install.sh", false),
            ("ls -l scripts/install.sh", false),
            ("wc -l scripts/install.sh", false),
            ("diff scripts/install.sh /tmp/old", false),
            ("touch scripts/install.sh", false),
            ("find scripts -name install.sh", false),
            ("git add scripts/install.sh", false),
            ("git add \"scripts/install.sh\"", false),
            ("git diff scripts/install.sh", false),
            ("git diff -- scripts/install.sh", false),
            ("git log -p -- scripts/install.sh", false),
            ("git status scripts/install.sh", false),
            ("git show HEAD:scripts/install.sh", false),
            ("git commit scripts/install.sh -m \"task 1: fix\"", false),
            ("cat ./scripts/install.sh", false),
            ("cd /tmp/x && cat scripts/install.sh", false),
            (
                "git add src/a.rs scripts/install.sh && git commit -m \"task 1: x\"",
                false,
            ),
            (
                "git add scripts/install.sh\ngit commit -m \"x\" && naru task note 1 \"done\"",
                false,
            ),
            // execution forms
            ("scripts/install.sh", true),
            ("bash scripts/install.sh", true),
            ("sh scripts/install.sh", true),
            ("zsh scripts/install.sh", true),
            ("source scripts/install.sh", true),
            (". scripts/install.sh", true),
            ("bash -c scripts/install.sh", true),
            ("sh -c 'scripts/install.sh'", true),
            ("eval scripts/install.sh", true),
            ("exec scripts/install.sh", true),
            ("env scripts/install.sh", true),
            ("time scripts/install.sh", true),
            ("nohup scripts/install.sh", true),
            ("command cat scripts/install.sh", true),
            ("bash <<EOF\nscripts/install.sh\nEOF", true),
            ("bash <<< scripts/install.sh", true),
            ("cat scripts/install.sh | bash", true),
            ("cat scripts/install.sh | sh -s", true),
            ("ls scripts/install.sh | xargs bash", true),
            ("cat $(scripts/install.sh)", true),
            ("cat `scripts/install.sh`", true),
            ("cat scripts/install.sh $(bash x)", true),
            ("X=scripts/install.sh; bash $X", true),
            (
                "X=bash; cat scripts/install.sh; $X scripts/install.sh",
                true,
            ),
            (
                "export GIT_EXTERNAL_DIFF=bash; git diff scripts/install.sh",
                true,
            ),
            ("GIT_EXTERNAL_DIFF=bash git diff scripts/install.sh", true),
            (
                "git config diff.external bash && git diff scripts/install.sh",
                true,
            ),
            ("git diff --ext-diff scripts/install.sh", true),
            ("git show --textconv HEAD:scripts/install.sh", true),
            ("git log -p --output=/tmp/x.sh scripts/install.sh", true),
            ("git -c core.editor=bash commit scripts/install.sh", true),
            ("GIT_EDITOR=bash git commit scripts/install.sh", true),
            ("git x scripts/install.sh", true),
            ("git grep -Obash x scripts/install.sh", true),
            ("find scripts -name install.sh -exec bash {} \\;", true),
            ("find scripts/install.sh -exec bash {} +", true),
            ("find scripts/install.sh -execdir sh {} +", true),
            ("find scripts/install.sh -ok bash {} \\;", true),
            ("cp scripts/install.sh /tmp/x && bash /tmp/x", true),
            ("cp scripts/install.sh /tmp/x", true),
            ("mv scripts/install.sh /tmp/x", true),
            ("rg --pre bash x scripts/install.sh", true),
            ("rg --pre=bash x scripts/install.sh", true),
            ("rg --hostname-bin scripts/install.sh x", true),
            ("less +!bash scripts/install.sh", true),
            ("less -o /tmp/x.sh scripts/install.sh", true),
            ("less --lesskey-src=k scripts/install.sh", true),
            ("export LESSOPEN='|bash %s'; less scripts/install.sh", true),
            ("LESSOPEN='|bash %s' less scripts/install.sh", true),
            ("alias cat=bash; cat scripts/install.sh", true),
            ("alias cat=bash\ncat scripts/install.sh", true),
            ("sed e scripts/install.sh", true),
            ("awk 1 scripts/install.sh", true),
            ("sort --compress-program=bash scripts/install.sh", true),
            ("open scripts/install.sh", true),
            ("vim scripts/install.sh", true),
            ("chmod +x scripts/install.sh", true),
            ("cat scripts/install.sh > /tmp/x.sh", true),
            ("head scripts/install.sh >> /tmp/x.sh", true),
            ("cat scripts/install.sh; bash x", true),
            ("cat scripts/install.sh & bash x", true),
            ("cat scripts/install.sh\nbash scripts/install.sh", true),
            ("cat scripts/install.sh && cargo install --path .", true),
            ("cat scripts/install.sh cargo install", true),
            ("cat scripts/install.sh com.naru.serve", true),
            ("cat scripts/inst*.sh scripts/install.sh", true),
            ("cat scripts/install.sh # x", true),
            ("cat -- -scripts/install.sh", true),
            (
                "cat scripts/install.sh && launchctl kickstart -k gui/501/com.naru.serve",
                true,
            ),
            (
                "cat scripts/install.sh && cp x /Applications/Naru.app/x",
                true,
            ),
            ("cat scripts/install.sh && naru serve", true),
            ("/bin/bash scripts/install.sh", true),
            ("cat scripts/install.sh && rg --pre bash x .", true),
            ("grep --filter=sh:bash x scripts/install.sh", true),
            ("cat scripts/install.sh && grep --pager=bash x .", true),
            ("cat scripts/install.sh && grep --view=bash x .", true),
            ("grep -nQ x scripts/install.sh", true),
            ("find scripts -name install.sh -rm", true),
            (
                "cat scripts/install.sh && find scripts -type f -exec bash \"{}\" \";\"",
                true,
            ),
            (
                "cat scripts/install.sh && find . -type f \"-ok\" bash \"{}\" \";\"",
                true,
            ),
            ("cat scripts/install.sh; ls; less +!bash x", true),
            (
                "git add scripts/install.sh && git diff --output=/tmp/x.sh HEAD",
                true,
            ),
            ("cat scripts/install.sh && /tmp/naru task show 1", true),
            (
                "cat scripts/install.sh \"${(e)${:-${(#)${:-36}}${(#)${:-40}}cmd)}}\"",
                true,
            ),
            ("cat scripts/install.sh && git commit -m \"cost $5\"", true),
        ];
        for (cmd, want) in cases {
            match denies(cmd, &[]) {
                Some(got) => assert_eq!(got, *want, "{cmd}"),
                None => return,
            }
        }
    }

    /// Without python3 on PATH the lift never happens: the old substring
    /// match decides.
    #[test]
    fn install_rule_without_python_denies() {
        let dir = tempfile::tempdir().unwrap();
        for tool in ["bash", "jq", "cat", "awk"] {
            let Ok(out) = Command::new("which").arg(tool).output() else {
                return;
            };
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if p.is_empty() {
                return;
            }
            std::os::unix::fs::symlink(p, dir.path().join(tool)).unwrap();
        }
        let path = dir.path().to_str().unwrap();
        assert_eq!(
            denies("git commit -m \"install.sh\"", &[("PATH", path)]),
            Some(true)
        );
    }
}
