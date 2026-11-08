# `notify`
Tells a person something and passes the input through. Two modes: a push to the phone, or a spoken message in the live conversation.

## Config
- `mode` (string, default `phone`): `phone` or `speak`.
- `message` (string, optional, at most 4096 bytes): `{input}` is replaced. Defaults to the node's input. If both are empty the node fails. A longer configured `message` is `validation`; a longer input is cut at 4096 bytes at run time.
- `title` (string, `phone` only): the push notification's title.
- `open` (string, `phone` only): an in-app route such as `workflows/3` (letters, digits, `/`, `_`, `-` only), `{input}` allowed. Adds an "Open Naru" button that deep-links there. A bad route is `validation`.

`title` or `open` with `mode: speak` is `validation`.

## What it reaches
- `phone`: sends a push through `vox` to the person's phone. It needs `vox` installed and a LAN address (or `notify.base-url` in config) when `open` is set; a failed send fails the node.
- `speak`: adds a Naru turn to the current live conversation (spoken aloud). Fails with `unavailable` if no live conversation is running.

## Pins and output
In `in: any`, out `out: any`. The output is the input, unchanged. Plain edges.

## Use when / not when
Use to report a result, or to flag a failure from a `trycatch` `caught` edge. To wait for an answer, use `gate`; to put a longer document on screen, use `board`. Don't call `vox` from a `cli` node.

## Example
```
naru workflow node create my-flow notify "Tell me" --config '{"mode":"phone","title":"Build","message":"Build finished: {input}","open":"workflows/1"}'
```
