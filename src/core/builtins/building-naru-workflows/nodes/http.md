# `http`
One HTTP request. `{input}` is replaced in the url, header values and body. This build has no TLS: only `http://` URLs work (`https://` is refused at create), so it suits local services and webhooks on a LAN, not public APIs.

## Config
- `url` (string, required): must start with `http://` (or with `{input}`, in which case the input is the whole URL and is checked at run time). Elsewhere in the url `{input}` is percent-encoded.
- `method` (string, default `GET`): `GET`, `POST`, `PUT`, `PATCH` or `DELETE`, case-insensitive.
- `headers` (object of strings, optional): header values may hold `{input}`.
- `body` (string, optional): only on `POST`, `PUT`, `PATCH` (any other method is `validation`). `{input}` is not escaped.
- `timeout_secs` (int 1..=600, default 30).

## Pins and output
In `in: any`, out `out: any`. The output is one JSON object: `{"status": 200, "ok": true, "body": "<text>", "json": <parsed body or null>}`, plus `"truncated": true` if the body was cut (it is kept to 32 KiB, and `json` is then null). `ok` is true for 2xx.
A non-2xx status is data, not a failure: check `ok` with a `branch` (`contains` `"ok":true`). A connection error or timeout fails the node (and the run); `http` can't be wrapped in `retry` or `trycatch`, so use a `cli` `curl` inside `retry` if you need retries.

## Use when / not when
Use to call a local service or webhook with no shell. Use `cli` with `curl` only for https or for options `http` lacks. To start a workflow from outside, use the `webhook` trigger instead.

## Example
```
naru workflow node create my-flow http "Ping service" --config '{"method":"POST","url":"http://localhost:9000/hook","headers":{"Content-Type":"application/json"},"body":"{\"text\":\"{input}\"}","timeout_secs":10}'
```
