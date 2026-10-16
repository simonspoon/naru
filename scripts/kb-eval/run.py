#!/usr/bin/env python3
"""Runs `naru kb ask` over kb-eval/questions.json against a seeded throwaway kb
and scores each answer deterministically. Invoked by scripts/kb-eval.sh.

usage: run.py <naru bin> <kb dir> <questions.json> <out.json> [jobs]
"""
import json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

bin_, kb, qfile, out = sys.argv[1:5]
jobs = int(sys.argv[5]) if len(sys.argv) > 5 else 4
ABSTAIN = re.compile(r"(?i)\b(not (in|found|stated|mentioned|known|covered)|no (information|record|note|mention)|does(n't| not) (say|state|mention|contain|answer)|cannot|can't|unknown)\b")


def run(q):
    t = time.time()
    p = subprocess.run([bin_, "kb", "ask", q["question"]], capture_output=True, text=True, timeout=300)
    dt = time.time() - t
    r = {"id": q["id"], "type": q["type"], "question": q["question"], "secs": round(dt, 1), "exit": p.returncode}
    try:
        j = json.loads(p.stdout) if p.returncode == 0 else None
    except ValueError:
        j = None
    if j is None:
        r.update(answer="", sources=[], error=(p.stderr or p.stdout).strip()[:300])
        r["ok"] = False
        r["why"] = "ask failed (exit %d)" % p.returncode
        return r
    ans = j.get("answer", "")
    srcs = [s["path"] for s in j.get("sources", [])]
    r.update(answer=ans, sources=srcs)
    if q["type"] == "negative":
        if ans.strip() == "":
            r["ok"], r["why"] = True, ""
        elif ABSTAIN.search(ans) and not any(re.search(x, ans) for x in q["none"]):
            r["ok"], r["why"] = True, ""
        else:
            r["ok"], r["why"] = False, "invented an answer instead of staying empty"
        return r
    miss = [x for x in q["all"] if not re.search(x, ans)]
    bad = [x for x in q["none"] if re.search(x, ans)]
    nosrc = bool(q["sources"]) and not set(q["sources"]) & set(srcs)
    r["ok"] = not (miss or bad or nosrc)
    why = []
    if not ans.strip():
        why.append("empty answer")
    elif miss:
        why.append("missing " + ", ".join(miss))
    if bad:
        why.append("forbidden " + ", ".join(bad))
    if nosrc:
        why.append("no expected source cited (want one of %s)" % q["sources"])
    r["why"] = "; ".join(why)
    return r


qs = json.load(open(qfile))
with ThreadPoolExecutor(jobs) as ex:
    res = list(ex.map(run, qs))
types = []
for r in res:
    if r["type"] not in types:
        types.append(r["type"])
summary = {}
print("%-12s %3s %7s %6s %8s" % ("type", "n", "correct", "%", "avg s"))
for t in types + ["ALL"]:
    rs = [r for r in res if t == "ALL" or r["type"] == t]
    c = sum(r["ok"] for r in rs)
    avg = sum(r["secs"] for r in rs) / len(rs)
    summary[t] = {"n": len(rs), "correct": c, "pct": round(100 * c / len(rs), 1), "avg_secs": round(avg, 1)}
    print("%-12s %3d %7d %5.1f%% %8.1f" % (t, len(rs), c, summary[t]["pct"], avg))
fails = [r for r in res if not r["ok"]]
if fails:
    print("\nFailing questions:")
    for r in fails:
        print("- [%s] %s\n    why: %s\n    got: %r  sources=%s" % (r["id"], r["question"], r["why"], r["answer"][:200], r["sources"]))
json.dump({"summary": summary, "results": res}, open(out, "w"), indent=1)
print("\nresults: " + out)
