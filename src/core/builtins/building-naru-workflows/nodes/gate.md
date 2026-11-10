# `gate`
A human approval. The run pauses (stays `running`) at the gate until a person approves or rejects it, or the timeout passes. Creates a pending gate row, sends a best-effort phone notification (with an "Open Naru" button to the workflow; a missing `vox` is only logged), then polls once a second.

## Config
- `message` (string, optional): shown on the approval card and in the phone notification.
- `timeout_secs` (int 1..=86400, default 3600).
- `on_timeout` (string, optional): only `"reject"` is accepted, and that is the behaviour either way.

## Pins and output
In `in: any`, out `out: any`. The output is the input, unchanged. Routes by edge label:
- `approved`: a person approved it.
- `rejected`: a person rejected it, or `timeout_secs` passed (the gate row records the reason `timed out`).

Every edge leaving a gate needs `--branch approved` or `--branch rejected`; any other label, or none, is `validation`. A rejection is data, not a failure: the run continues down the `rejected` edge and still ends `succeeded`. An unwired branch skips everything behind it.

Decide with `naru workflow gate approve <id>` / `reject <id>`, list with `naru workflow gate list [--run N] [--all]`, or use the Approve / Reject buttons in the web UI.
The phone notification also carries Approve and Cancel buttons, and a reply to it saying `approve` or `cancel` decides the gate too; the first answer wins. This is the only way to wait for a person on the phone: never run `vox ask`, `vox confirm`, `vox pick`, `vox wait` or `vox listen` from a `cli` or `script` node (they would steal the answers Naru's own reader is waiting for). Use a `gate`.
A `serve` restart fails the run; a pending gate does not resume.

## Use when / not when
Use before anything risky or irreversible (a deploy, a delete, a commit to main). Don't use to merely tell the person something (`notify`), or to pick between options automatically (`decide`).

## Example
```
naru workflow node create my-flow gate "Approve deploy" --config '{"message":"Deploy to production?","timeout_secs":1800}'
```
Then wire its two exits with `naru workflow edge create ... --branch approved` and `--branch rejected`.
