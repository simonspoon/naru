# Spike 1797: a shared real-Chrome browser

A visible Chrome the person browses in, which the agent can take over through
khora and hand back. Prototype: `scripts/shared-browser.sh`. Exercised against
khora v0.4.0 and a real Google Chrome on macOS.

## 1. Start / reuse

`scripts/shared-browser.sh start [--port N]` (default 9333). State lives in
`~/.naru/browser/state.json` (`pid`, `port`, `profile`, `started_at`). If the
pid is alive, its args contain our profile dir and `/json/version` answers, it
prints `{"reused":true,...}` and does nothing. Otherwise it launches Chrome
non-headless and detached (`nohup`, log to `~/.naru/browser/chrome.log`) with
`--user-data-dir=~/.naru/browser/profile --remote-debugging-port=<port>
--no-first-run --no-default-browser-check`, waits up to 10s for the port, and
writes the state file. A port held by anything else is a JSON error, exit 1.
Binary override: `NARU_CHROME_BIN`. `stop` kills only the state-file pid, after
checking its `ps` args name our profile.

**Shutdown must be graceful.** `stop` sends CDP `Browser.close` over the browser
websocket (stdlib-only python client in the script), waits up to 15s for the
pid, and only then falls back to SIGTERM. Plain SIGTERM lost a just-set cookie
and all localStorage in verification. Not `osascript`/`quit`: it shares the
bundle id of the person's daily Chrome. The person quitting with Cmd+Q is also a
clean shutdown, so that path is fine. `Browser.close` exits in about 0.7s.

Measured on `https://en.wikipedia.org` with a fresh profile (`NARU_BROWSER_DIR`
override, a test seam): set a cookie and a localStorage key, `stop` immediately,
`start --port 9335`, takeover, navigate, read. Two rounds, each with a new
timestamp value, both survived (cookie and exact localStorage value) both times.
Finding on the real profile `~/.naru/browser/profile`: localStorage was still
lost after a clean `Browser.close` there, though the key was present in
`Local Storage/leveldb/000004.log` (`_https://en.wikipedia.org\0\1naru_p`). That
profile's `LOG` showed ~61 `Corruption: checksum mismatch / missing start of
fragmented record` lines at every open, with a ~2 MB log, so Chrome dropped the
damaged records on recovery. That log was already damaged by the earlier
non-graceful runs or wikipedia's large ResourceLoader writes; I did not isolate
which. A fresh profile does not show it, and a quiet origin (example.org) in the
damaged profile persisted. Treat a damaged profile as needing a reset; I left it
in place as asked.

## 2. Take over, act, hand back

`takeover [--target ID]` runs `khora attach --port <port> [--target ID]`, which
stores a session with `attached: true`, pid 0, no data dir, and pins one tab.
Then the ordinary khora verbs work against the person's visible tab. Observed:
`navigate`, `text`, `click` all worked (a click on a link navigated the real
tab, after a short delay). `release <session>` is `khora kill`, which only
forgets the session; Chrome and its tabs stay up (confirmed: `status` still
`running` with the tab where the agent left it). Emulation verbs change the
real tab, so the agent should not use them on a shared browser.

Note: `khora text <s> h1` on example.com returned "No value found" because
example.com currently has no `h1` (same in headless launch mode); that is the
page, not attach. Headless `launch`/`navigate`/`text body`/`kill` is unbroken
on 0.4.0.

## 3. How the live voice agent drives it

- Which tab: `shared-browser.sh status` lists page tabs (id/title/url only),
  so the agent can pick one by what the person says ("the GitHub tab") and
  call `takeover --target <id>`.
- Default pin, observed: without `--target`, khora pins the **first page in
  `/json/list`**. Chrome orders that list most-recently-activated first: a
  tab opened with `/json/new` was pinned (it is activated on creation), and
  after `/json/activate/<id>` of the older tab, that older tab was pinned. So
  the default is "the tab the person is looking at", which is what we want.
  Caveat: the person has to have focused that tab; a background-window tab
  switch by the person is reflected as soon as Chrome reorders the list.
- Release: the agent calls `release <session>` when done or when the person
  says "I've got it". The person can always just use the window; there is no
  lock, so a take-over is cooperative. A live hook should announce it
  ("taking over the browser") and `naru live` should treat release as the end
  of the turn's browser work.

## 4. Security

- Debug port is loopback only (Chrome binds 127.0.0.1 when no
  `--remote-debugging-address` is given):

  ```
  COMMAND     PID       USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
  Google    52892 simonspoon   61u  IPv4 0x94a3b22163afb72e      0t0  TCP 127.0.0.1:9333 (LISTEN)
  ```
- Separate profile `~/.naru/browser/profile`. Chrome 136+ ignores
  `--remote-debugging-port` on the default profile anyway, so a dedicated
  `--user-data-dir` is required, and the person's everyday profile is never
  exposed.
- The script and khora log nothing of cookies, storage or page content;
  `status` prints titles and URLs only. (khora's own `text`/`screenshot` output
  is whatever the agent asks for.)
- **Risk to state plainly:** CDP access is full control of every session that
  is logged in inside that profile. While Chrome runs with the port open, any
  local process of the same machine (any user-level process, a malicious npm
  script, a browser page via DNS rebinding is blocked by Chrome's Host check
  but not a local binary) can read cookies and drive logged-in sites. Mitigations:
  random port per start instead of fixed 9333 (state file already carries it);
  `stop` when idle (a timer in `naru browser`); keep only accounts the person is
  willing to expose in that profile; state file `0600` and profile dir `0700`;
  never expose the port with `--remote-debugging-address`/`--lan`.

## 5. Docked-view options

| Option | How | Effort |
| --- | --- | --- |
| Separate window (what this prototype does) | Chrome's own window; person arranges it beside Naru | Done. 0 days |
| CDP screencast in a Naru dock panel | Server opens a CDP session to the tab, `Page.startScreencast` (JPEG frames + ack), streams over a websocket/SSE route, panel draws to canvas and relays mouse/key/wheel back as `Input.dispatch*`. Needs the route under `require_agent_access`, IME/clipboard/popups/downloads/file pickers are the long tail | ~1.5-3 weeks for a usable panel; the long tail is open-ended |
| naru-mac embedded `WKWebView` | Not Chrome: different engine, no shared Chrome profile, no CDP. Would make it a different feature | ~1 week for the view, but it does not satisfy "real Chrome, khora can drive" |
| naru-mac window arrangement (position the Chrome window next to Naru via accessibility, e.g. loki) | Reuses the real window | ~2-3 days, macOS only |

Recommendation: ship the separate window now, add window docking via loki
later, and only build screencast if a remote/phone view is wanted.

## Recommended build task

Add `naru browser start|status|stop|takeover|release` (CLI only, JSON out,
`--quiet` per project rules) wrapping the prototype's logic in Rust in
`core::browser` (state file, pid/profile check, random port, idle auto-stop,
state `0600`), with `start` refusing a port it does not own. Add a `naru live`
take-over hook: the live agent definition gains a rule to call
`naru browser status`, then `naru browser takeover [--target]` before browser
work and `naru browser release` after, announcing both aloud. Add a
`browser-check.sh` gate against a stub Chrome (`NARU_CHROME_BIN`) and a docs
page.

## Open item: manual OAuth login by the person still to be verified

Not exercised in this spike: the person signing in to a Google/OAuth site by
hand in the shared window, the session persisting in the dedicated profile
across `stop`/`start`, and the agent then acting as that user after takeover.
Things to check: Google may flag a Chrome launched with
`--remote-debugging-port` or an automation-controlled window as suspicious and
block sign-in; whether the "Chrome is being controlled" banner appears; and
whether cookies survive a restart of the profile.
