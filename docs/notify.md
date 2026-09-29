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

Always argv, never a shell: `vox notify --json [--title T] [--button "Open
Naru=<url>"] -- <message>`. The `--` means a message starting with `-` is
still the message. `MESA_VOX_BIN` / `NARU_VOX_BIN` name a different binary
(the test seam, as `MESA_LOKI_BIN` is for `live look`).

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
save); otherwise `http://<this machine's LAN IPv4>:7770`, found by asking the OS
which interface routes outward (no packet is sent). With no LAN address the
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

Gate: `scripts/notify-check.sh`.
