# Notify

`naru notify` reaches the person's phone (mesa task 1482) by shelling out to
the external [`vox`](../../vox) CLI, which sends a Telegram message. CLI only —
there is no API route to send one.

```bash
naru notify "Deploy finished"
naru notify "Result is ready" --title Naru --open live
naru notify "Look" --open live --base-url http://192.168.1.5:7770
```

Output is one JSON object, `{"sent": true, "message_id": …, "chat_id": …,
"open_url": "<url>" | null}`. It takes no `--quiet` (it is not a record).

## argv

Always argv, never a shell: `vox notify --json [--title T] [--choice
"<label>=<data>"]… [--button "Open Naru=<url>"] -- <message>` (`--choice` only
for an approval gate, see "Answering from Telegram"). The `--` means a message starting with `-` is
still the message. `MESA_VOX_BIN` / `NARU_VOX_BIN` name a different binary
(the test seam, as `MESA_LOKI_BIN` is for `live look`).

## Dev and sandbox runs never notify

When `NARU_HOME` (or `MESA_HOME`) is set to anything but the account's real
`~/.naru` / `~/.mesa` — the dev environment (`docs/dev-env.md`), a throwaway
`serve`, a temp home — `notify::send` (so `naru notify`, workflow `notify` nodes
and approval gates, the agent-stalled ping) does **not** call `vox`: it logs
`naru: notification skipped …` to stderr and returns `{"sent": false,
"skipped": true, …}`. Setting `NARU_VOX_BIN` (a stub or a real binary) opts back
in so QA can exercise the path on purpose. The real install is unchanged.
(naru task 2696)

## `--open` and the `/open` page

Telegram only accepts `http`, `https` and `tg` URLs in a button, so a button
cannot point at the iOS app's `naru://<route>` link directly. `--open <route>`
instead points the button at `<base>/open/<route>`, a page Naru serves:
`GET /open/{route}` answers `200 text/html` with a `<meta http-equiv="refresh"
content="0;url=naru://<route>">` and a visible "Open Naru" link to the same URL
(a Telegram in-app browser may ignore the refresh). `naru://live` is the route
the iOS app knows today.

A route is non-empty, at most 200 characters, and only `[A-Za-z0-9/_-]` — the
same rule on the CLI (`validation`, exit 1) and the page (422), so nothing can
inject markup or another scheme.

The route is ungated beyond the global guard, like `/api/version`. That guard
rejects a foreign `Host` in default mode, so **a phone reaches the page only
when `serve` runs `--lan`** (and, with a DNS name, `--allow-host`).

## Base URL

In order: `--base-url`; the `notify.base-url` key in `~/.mesa/config.json`
(read-only from the CLI, no Settings UI, preserved by every other section's
save); otherwise `http://<host>:<port>`, where `<host>` is this machine's **Tailscale IPv4** when Tailscale is up (asked of `tailscale ip -4` at send time, PATH then the macOS app's binary, override `NARU_TAILSCALE_BIN`; only a 100.64.0.0/10 answer counts) so the button works off home wifi, else its LAN IPv4. The server must listen beyond loopback (`serve --lan`, which binds 0.0.0.0 and so answers on the Tailscale address too); default `serve` binds 127.0.0.1 and answers on neither. `<port>` is `serve.port`
from the same config file (7770 when unset); the LAN address is found by asking
the OS which interface routes outward (no packet is sent). A `serve --port N`
given only as a flag is invisible to the CLI; set `serve.port` or `--base-url`. With no LAN address the
command is `unavailable` and asks for `--base-url`. The base must be `http://`
or `https://`; a trailing slash is dropped.

## Errors

- `vox` not installed: `unavailable`, naming the binary and `vox init`.
- `vox` not set up (stderr says to run `vox init`): `unavailable` naming
  `vox init`.
- Any other non-zero exit: `unavailable` with a stderr excerpt.
- Bad `--open`, a non-http `--base-url`, an empty message: `validation`.

## The live agent

The `naru-live` definition's rule 13 lets the agent run `naru notify
"<sentence>" --open live` when the person may be away from the screen — a long
delegate finished with nobody listening on the page. Sparingly, never for an
ordinary reply.

## `naru task digest --notify`

`naru task digest --since <ts|auto> --notify [--base-url <url>]` (naru task
1725) sends the "while you were away" digest of task outcomes (see
`docs/live.md`) as one message titled "While you were away". Each line links
to the web UI as `<base>/#/projects/<pid>/tasks/<id>` (base resolved as
above), so a phone needs `serve --lan`; there is no per-task button. An empty
digest sends nothing and calls no `vox`.

## Answering from Telegram

A workflow approval gate (`docs/workflows.md`) can be decided inside Telegram
(naru task 2699): its notification carries **Approve** and **Cancel** buttons
above the Open Naru button, and a reply to that message decides it too. The web
UI, `naru workflow gate approve|reject` and the live voice keep working; the
first answer wins, because every path ends in the one conditional
`Store::decide_workflow_gate`.

**Sending.** `notify::send_choices` adds `--choice "<label>=<data>"` items before
`--button`. A gate sends `Approve=gate:<gate id>:approve` and
`Cancel=gate:<gate id>:reject`, and its text ends "Tap a button, or reply
approve / cancel." The Telegram message id vox returns is stored with the text
in `phone_prompts(message_id, kind, ref_id, text)` (`kind` is `gate`, `ref_id`
the gate id; the table is generic so another kind can join it).

**The single reader.** Telegram delivers a bot's updates to one consumer only,
so `naru serve` runs exactly one supervised `vox events --json` child
(`core::phone::start_reader`, on its own thread; the store lock is held only
while one line is applied). It is restarted with backoff (1 s doubling to 60 s)
when it exits and killed when `serve` shuts down or restarts; if `serve` is
killed outright, vox's own parent watchdog ends it within a second. vox also
holds an `events.lock`, so a second reader on the same account exits and is
retried rather than competing.

The reader does **not** start:

- when `NARU_HOME` / `MESA_HOME` is not the real home (the dev environment, a
  sandbox, a temp home — the rule of "Dev and sandbox runs never notify"), or
  when `NARU_DB` / `MESA_DB` names a db other than the account's own
  `…/naru/naru.db` / `…/mesa/mesa.db` (a throwaway `serve` on the real home
  must not consume the real bot's updates), unless `NARU_VOX_BIN` names a
  binary explicitly;
- when the vox on hand has no `events` subcommand (not installed, or older than
  vox task 2698): `serve` logs one line and looks again every five minutes. With
  such a vox a gate sends the plain notification it always did, with no choice
  buttons, and nothing errors.

**Handling a line.** A line is untrusted input: it is parsed as JSON and
matched, never executed, and the only thing it can cause is a gate decision
with the reason `telegram`.

- `{"kind":"choice","message_id":N,"data":"gate:<id>:approve|reject"}` decides
  gate `<id>` only when `N` is the message Naru sent for that same gate. vox
  does not bind a button's data to its message, so Naru checks both; a tap
  whose data names a gate its message was not sent for changes nothing. Any
  other data shape is ignored.
- `{"kind":"reply","reply_to_message_id":N,"message_id":M,"text":"…"}` to a
  gate's message: the trimmed, lowercased text `approve`, `approved`, `yes`,
  `y` or `ok` approves; `cancel`, `reject`, `rejected`, `no` or `n` rejects.
  Any other text decides nothing and is answered once, as a reply to `M`:
  "Reply approve or cancel, or tap a button."
- An unknown message, an unknown gate and an already-decided gate are not
  errors. Delivery is at-least-once (vox re-delivers its last batch after a
  crash), and a repeated event for a decided gate changes nothing.

**Closing the message.** A decided gate's message is edited with `vox progress
<message_id> -- "<text> - Approved|Cancelled (from Telegram|in Naru|timed
out)"`, which also removes the buttons: by the reader for an answer from
Telegram (so a gate whose run is gone still loses its buttons), and by the
waiting run for every other path (web, CLI, timeout). A tap or reply for a gate
that is already decided triggers the same edit. Best-effort: a failure is only
logged.

Buttons are only sent from an environment whose `serve` runs the reader. A
gate reached by `naru workflow run` while no `serve` is up still gets them;
Telegram holds the tap and the reader applies it when `serve` starts, if the
gate is still pending.

**Security.** Only the person's own Telegram account may answer. vox drops
every update that is not from the configured chat, but **an empty
`user_id_allowlist` accepts anyone in that chat**: set the allowlist in
`~/.config/vox/config.toml` to the person's own Telegram user id. Naru does
not rely on vox alone: it accepts only well-formed data for a gate that
exists, is pending, and whose message id matches, and trusts no text beyond the
two fixed word lists.

**Naru is the only one waiting on this bot.** Because the reader is the bot's
single update consumer, nothing else — no workflow node, script, hook or agent
brief — may run `vox ask`, `vox confirm`, `vox pick`, `vox wait` or
`vox listen` on it: each polls for updates itself and would take the answers
meant for the reader (or fail with a 409). To wait for a person, use a workflow
`gate` or `naru ask`. Nothing in this repo or its built-in library calls those
commands.

### Agent questions (naru task 2700)

A `naru ask` question can be answered in Telegram too; when it is sent at all
is the routing rule of `docs/ask.md` (live conversation: the live agent first,
`naru ask escalate <id>` to send it; no live conversation: sent at ask time).
`core::phone::send_question` sends title `Naru: question`, the body (cut to
900 characters) plus ` (task N)`, the line "Tap a choice or reply to this
message with your answer." ("Reply to this message with your answer." without
choices), and one button per choice, `A: <label>` with data
`q:<question id>:<index>`, no Open Naru button. It records
`phone_prompts(message_id, "question", id, <text without the hint line>)`. It
runs only where `reader_bin()` is `Some`, and every vox call is bounded, so
`naru ask` never waits on a hung vox. A vox without `events` gets plain text.

The reader's handling, in addition to the gate lines above:

- `choice` with data exactly `q:<digits>:<digits>` answers the question with the
  stored label at that index, only when the tapped message is the one sent for
  that question and the index is in range.
- `reply` to a question's message: the trimmed text is the answer, verbatim
  (data: stored, never interpreted); empty text does nothing; a single letter
  `a`..`h` (either case) naming a choice answers with that choice's label.
- The message is then edited to `<text> - Answered: <answer>` (the stored
  answer, cut to 900 characters), which removes the buttons; an `expired`
  question's becomes `<text> - No longer needed`. A tap or reply on an already
  answered question does the same edit and changes nothing. `naru ask answer`
  edits the message the same way (best-effort, bounded, logged only) when the
  question had been sent to the phone.
- Out-of-range index, unknown id or message, malformed data and a validation
  error (an over-long reply) are logged and change nothing.

Security as for gates: well-formed data for an open question whose message id
matches, and the answer is always the stored label or the person's own text.

Gates: `scripts/notify-check.sh`, `scripts/phone-answer-check.sh`.
