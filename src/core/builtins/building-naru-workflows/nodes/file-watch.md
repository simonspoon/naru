# `file-watch`
A trigger source fired when a path changes. Detection is polling: each time-watcher tick (on by default in `serve`) (default 60 s) compares the path's mtime and size with the last state it saw, kept in memory only. The first sight of a path only records it, so a start-up or restart never fires. A change that happens and reverts between two ticks is missed. An entry node: one per workflow, nothing flows in.

## Config
- `path` (string, required): a file or folder, 1 to 4096 characters, **no globs**.
- `event` (string, default `any`): `any` | `created` | `modified` | `deleted`.
Unknown keys and bad values are `validation`.

## Pins and output
No input pin. Output pin `event` (string): the run input, JSON `{"path","event","mtime","size"}` (`mtime` is epoch seconds; both `mtime` and `size` are null on a deletion). Run trigger is `file-watch`.

## Use when / not when
Use to react to a file or folder changing: a dropped report, a changed config. Prefer it over a `schedule` plus a `cli` running `stat`/`find`. It is a one-minute poll, not real-time; for an immediate push use `webhook`. It watches one path; for many files watch their folder.

## Example
```bash
naru workflow node create my-flow file-watch Watch --config '{"path":"/tmp/x/inbox.txt","event":"modified"}'
```
