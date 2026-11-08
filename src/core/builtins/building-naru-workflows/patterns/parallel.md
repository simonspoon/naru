# Parallel: fork with `parallel`, gather with `join`

`parallel` passes its input to every outgoing edge. `join` collects the outputs of all its incoming edges. Neither takes config (any key is `validation`).

- **The engine is sequential.** Branches run one after another in topological order (ties by node id). `parallel` is a structural fan-out, not concurrency. Do not rely on two branches overlapping in time.
- A `join` runs **only when every incoming exec edge is active** and then outputs a JSON array of the incoming outputs in edge-id order (pin `out: list<string>`). If any incoming branch was skipped (a branch's other verdict) the join is `skipped` and the run still succeeds.
- A failed upstream node fails the run, unless that node has a `failure` edge (see errors-and-waits.md). A `failure` edge into a `join` never satisfies it.
- Data edges never count toward a join; only exec edges do.
- `parallel` is optional: any node with two outgoing exec edges already fans out. Use it to make the fork visible in the editor.
- Each element of the joined array is a **string**: a branch that output JSON appears as an escaped string inside the array (see the example). Parse it downstream with `parse-json` if you need the structure.
- Downstream of a `join` use `mapfilter`/`foreach` to walk the gathered list, or a prompt/`output` to consume it as text.

Typical shape: trigger -> parallel -> (read A, read B) -> join -> decide/branch -> action. For "read tasks and also check a URL, then decide", the two readers are a `cli` (`naru task list ...`) and an `http` node; the join feeds the branch.

## Worked example

Two mapfilter branches run from one fork; the join gathers both. Offline.

```bash
node() { naru workflow node create "$@" | jq -r .id; }
naru workflow create fan >/dev/null
T=$(node fan trigger Start --config '{"mode":"manual"}')
P=$(node fan parallel Fork)
A=$(node fan mapfilter "Branch A" --config '{"mode":"map","expr":"a:{item}"}')
B=$(node fan mapfilter "Branch B" --config '{"mode":"map","expr":"b:{item}"}')
J=$(node fan join Gather)
O=$(node fan output "Log both" --config '{"target":"log","log":"fan"}')
naru workflow edge create fan $T $P >/dev/null
naru workflow edge create fan $P $A >/dev/null
naru workflow edge create fan $P $B >/dev/null
naru workflow edge create fan $A $J >/dev/null
naru workflow edge create fan $B $J >/dev/null
naru workflow edge create fan $J $O >/dev/null
naru workflow run fan --input $'x\ny' | jq -r .status
```
