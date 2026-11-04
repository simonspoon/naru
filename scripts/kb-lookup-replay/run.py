"""Replay driver for scripts/kb-lookup-replay.sh (naru task 2553).

argv: naru-binary  source-lookups.jsonl  kb-copy  out-dir  label  n  jobs
Writes <out>/<label>.json (every lookup and verdict) and prints the summary.
"""
import concurrent.futures as cf
import json
import os
import random
import subprocess
import sys

BIN, LOG, KB, OUT, LABEL, N, JOBS = sys.argv[1:8]
N, JOBS = int(N), int(JOBS)

rows = [json.loads(l) for l in open(LOG) if l.strip()]
rows.sort(key=lambda r: r.get("unix", 0), reverse=True)
questions = []
for r in rows:
    q = (r.get("question") or "").strip()
    if q and q not in questions:
        questions.append(q)
    if len(questions) == N:
        break


def replay(i_q):
    i, q = i_q
    payload = {"session_id": f"replay-{i}", "prompt": q, "cwd": OUT,
               "transcript_path": "", "hook_event_name": "UserPromptSubmit"}
    p = subprocess.run([BIN, "kb", "hook"], input=json.dumps(payload),
                       capture_output=True, text=True, timeout=60)
    ctx = None
    if p.stdout.strip():
        ctx = json.loads(p.stdout)["hookSpecificOutput"]["additionalContext"]
    return {"i": i, "prompt": q, "context": ctx, "exit": p.returncode}


with cf.ThreadPoolExecutor(JOBS) as ex:
    results = list(ex.map(replay, enumerate(questions)))
log = {}
for l in open(os.path.join(KB, "lookups.jsonl")):
    r = json.loads(l)
    log[r["session_id"]] = r
for r in results:
    r["row"] = log.get(f"replay-{r['i']}")

JUDGE_SCHEMA = {"type": "object", "additionalProperties": False,
                "required": ["score", "relevant", "misleading"],
                "properties": {"score": {"type": "integer"}, "relevant": {"type": "boolean"},
                               "misleading": {"type": "boolean"}}}


def note_excerpt(path):
    try:
        text = open(os.path.join(KB, path)).read()
    except OSError:
        return "(missing)"
    return text.split("\n---\n", 1)[-1][:400].strip()


def judge(r):
    srcs = (r["row"] or {}).get("sources") or []
    notes = "\n".join(f"- {s['title']}: {note_excerpt(s['path'])}" for s in srcs)
    prompt = f"""You are judging an automatic knowledge-base injection shown to a coding agent just before it starts a task. You see only this one injection.

TASK:
{r['prompt'][:1500]}

INJECTION:
{r['context']}

CITED NOTES (excerpts):
{notes}

Give a usefulness score 0-3 to someone starting this task: 0 = irrelevant or wrong; 1 = loosely related, little value; 2 = relevant and somewhat useful; 3 = directly relevant, specific, would change what the agent does. Set relevant true only for a score of 2 or 3. Set misleading true if the injection is irrelevant to the task or could steer the agent wrongly (a false positive). Be strict."""
    env = dict(os.environ, NARU_KB_SKIP="1")
    p = subprocess.run(["claude", "-p", "--model", "sonnet", "--tools", "", "--strict-mcp-config",
                        "--output-format", "json", "--json-schema", json.dumps(JUDGE_SCHEMA)],
                       input=prompt, capture_output=True, text=True, env=env, cwd=OUT, timeout=300)
    try:
        return json.loads(p.stdout).get("structured_output")
    except ValueError:
        return None


injected = [r for r in results if r["context"]]
with cf.ThreadPoolExecutor(JOBS) as ex:
    for r, v in zip(injected, ex.map(judge, injected)):
        r["verdict"] = v

n = len(results)
lat = sorted((r["row"] or {}).get("latency_ms", 0) for r in results)
failed = sum((r["row"] or {}).get("outcome") == "failed" for r in results)
judged = [r for r in injected if r.get("verdict")]
sample = random.Random(2553).sample(judged, min(30, len(judged)))
rel = lambda rs: sum(r["verdict"]["relevant"] and not r["verdict"]["misleading"] for r in rs)
summary = {
    "questions": n,
    "injected": len(injected),
    "injected_pct": round(100 * len(injected) / max(n, 1), 1),
    "failed": failed,
    "failed_pct": round(100 * failed / max(n, 1), 1),
    "nonzero_exit": sum(r["exit"] != 0 for r in results),
    "latency_ms_p50": lat[len(lat) // 2] if lat else 0,
    "latency_ms_p95": lat[min(len(lat) - 1, int(0.95 * len(lat)))] if lat else 0,
    "latency_ms_max": lat[-1] if lat else 0,
    "judged": len(judged),
    "misleading": sum(r["verdict"]["misleading"] for r in judged),
    "relevant_all_pct": round(100 * rel(judged) / max(len(judged), 1), 1),
    "sample": len(sample),
    "relevant_sample_pct": round(100 * rel(sample) / max(len(sample), 1), 1),
}
json.dump({"summary": summary, "results": results}, open(os.path.join(OUT, f"{LABEL}.json"), "w"), indent=1)
print(json.dumps(summary, indent=1))
print("details:", os.path.join(OUT, f"{LABEL}.json"))
