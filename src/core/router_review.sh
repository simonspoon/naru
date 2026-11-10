set -euo pipefail
command -v jq >/dev/null 2>&1 || { echo "router review: jq is not installed (brew install jq)" >&2; exit 1; }
input="${NARU_INPUT:-}"
arg() { printf '%s' "$input" | grep -Eo "(^|[[:space:]])$1=[^[:space:]]+" | head -1 | sed 's/.*=//' || true; }
min_n=$(arg min_n); min_n=${min_n:-6}
days=$(arg days); days=${days:-28}
since=$(arg since)
max_bounce=$(arg max_bounce); max_bounce=${max_bounce:-0.30}
max_fallback=$(arg max_fallback); max_fallback=${max_fallback:-0.10}
budget=$(arg latency_budget_ms); budget=${budget:-10000}
for v in "$min_n" "$days" "$budget"; do case "$v" in ''|*[!0-9]*) echo "min_n, days and latency_budget_ms must be whole numbers" >&2; exit 1 ;; esac; done
[ "$min_n" -ge 1 ] || { echo "min_n must be at least 1" >&2; exit 1; }
for v in "$max_bounce" "$max_fallback"; do printf '%s' "$v" | grep -Eq '^[0-9]+(\.[0-9]+)?$' || { echo "max_bounce and max_fallback must be numbers like 0.30" >&2; exit 1; }; done
[ -z "$since" ] || printf '%s' "$since" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || { echo "since must be YYYY-MM-DD" >&2; exit 1; }
[ -z "$since" ] && since=$(date -u -v-"${days}"d +%Y-%m-%d 2>/dev/null || date -u -d "$days days ago" +%Y-%m-%d)
naru cc router --since "$since" | jq -r \
  --argjson min "$min_n" --arg since "$since" --arg today "$(date -u +%Y-%m-%d)" \
  --argjson maxb "$max_bounce" --argjson maxf "$max_fallback" --argjson budget "$budget" '
def levels: ["haiku","sonnet","opus","fable"];
def lvl($m): levels | index($m) // -1;
def pct($a; $b): if $b == 0 then "-" else "\($a)/\($b) (\(($a * 100 / $b) | round)%)" end;
def median: sort | if length == 0 then null elif length % 2 == 1 then .[length / 2 | floor]
  else (.[length / 2 - 1] + .[length / 2]) / 2 end;
def p95: sort | if length == 0 then null else .[((length * 0.95) | ceil) - 1] end;
def money: if . == null then "-" else "$\(. * 100 | round / 100)" end;
def mins: if . == null then "-" else "\(. * 10 | round / 10) min" end;
# a spawn that never started is no session: its reuse carries the same attempt on
def finished: map(select(.outcome != null and .outcome_detail != "spawn failed"));
def landed: finished | map(select(.attempt == 1));
def nums($k): map(.[$k] | select(. != null));
# sessions of one attempt (a relay or failed-spawn reuse is the same attempt) count once
def attempts: unique_by([.task_id, .attempt]) | length;
def topwords: map(.reason // "" | ascii_downcase | [scan("[a-z][a-z-]{3,}")] | unique) | add // []
  | map(select(IN("task","with","that","this","from","the","into","rule","signal","named","text","which","work","change","says","than","there","applies","default","only","them","they","have","does","when","same","each","also","single","file","opus","sonnet","haiku","fable") | not))
  | group_by(.) | map({w: .[0], n: length}) | sort_by(-.n, .w) | .[:6] | map("\(.w) (\(.n))") | join(", ");
.rows as $all
# rubric picks only: an escalation (and a relay of one) is a retry, not a pick (naru task 2692);
# a size-hinted session (and a relay of one) was sized by its author, not the rubric (naru task 2685)
| ($all | map(select(.experiment != true and .escalated != true and .hinted != true))) as $rows
| ($all | map(select(.escalated != true and .hinted == true))) as $hinted
| ($all | map(select(.experiment != true and .escalated == true))) as $esc
| ($all | map(select(.experiment == true))) as $exp
# the next attempt of the same task, to see whether a retry went up a level
| ($all | group_by(.task_id) | map(sort_by(.attempt)) | map(. as $g | range(0; length) | {key: "\($g[.].task_id)/\($g[.].attempt)", value: ($g[. + 1].model // null)}) | from_entries) as $next
| (levels | map(. as $m | ($rows | map(select(.model == $m))) as $r | ($r | finished) as $f
    | {model: $m, n: ($r | length), fin: ($f | length),
       landed: ($r | landed | map(select(.landed_first_try == true)) | length), first: ($r | landed | length),
       bounced: ($f | map(select(.outcome == "bounced")) | length),
       failed: ($f | map(select(.outcome == "failed")) | length),
       up: ($f | map(select(.outcome != "done" and (lvl($next["\(.task_id)/\(.attempt)"] // "") > lvl($m)))) | length),
       cost: ($r | nums("est_cost_usd") | median), minutes: ($r | nums("duration_minutes") | median),
       words: ($f | map(select(.outcome == "bounced")) | topwords)})) as $per
| ($rows | map(select(.source == "haiku"))) as $picked
| ($rows | map(select(.est_cost_usd != null)) | sort_by(.decided_at)) as $costed
| ($costed | length) as $cn
| ($costed[: ($cn / 2 | floor)] | nums("est_cost_usd") | median) as $c1
| ($costed[($cn / 2 | floor):] | nums("est_cost_usd") | median) as $c2
| ($exp | group_by(.rubric_model) | map(.[0].rubric_model as $rm
    | ($rows | map(select(.model == $rm and (.source == "haiku" or .source == "reused")))) as $ctl
    | {row: $rm, down: (.[0].model), en: attempts, efin: (finished | length),
       eland: (landed | map(select(.landed_first_try == true)) | length), efirst: (landed | length),
       ebounce: (finished | map(select(.outcome == "bounced")) | length),
       cn: ($ctl | attempts), cfin: ($ctl | finished | length),
       cland: ($ctl | landed | map(select(.landed_first_try == true)) | length), cfirst: ($ctl | landed | length),
       cbounce: ($ctl | finished | map(select(.outcome == "bounced")) | length)})) as $arms
| ($rows | map(select((.reason // "") | startswith("Role ")))) as $deleg
| ($deleg | map(select((.reason | capture("^Role (?<r>[A-Za-z0-9_-]+)").r // "") as $role
    | ($role | IN("verifier","reviewer","diff-reviewer","recon","researcher","ux-designer","implementer","ui-verifier","swift-implementer"))
    and .model != "sonnet"))) as $baddeleg
| ($picked | nums("router_latency_ms") | p95) as $lat
| ($rows | map(select(.source == "fallback")) | length) as $fb
# each check: {ok: enough data, flag: tripped, row, text}
| [ ($per[] | . as $p |
      if $p.fin < $min then {ok: false, text: "\($p.model) bounce rate: not enough data (\($p.fin) finished sessions, need \($min))"}
      elif ($p.bounced / $p.fin) > $maxb then {ok: true, flag: true, row: $p.model,
        text: "\($p.model) bounces \(pct($p.bounced; $p.fin)) of finished sessions, over the \($maxb * 100 | round)% limit. Words in the bounced reasons: \(if $p.words == "" then "-" else $p.words end)."}
      else {ok: true, flag: false} end),
    ($arms[] | . as $a |
      if $a.efirst < $min or $a.cfirst < $min then {ok: false, text: "\($a.row) row exploration: not enough data (\($a.efirst) experiment and \($a.cfirst) control first attempts finished, need \($min) each)"}
      elif ($a.eland / $a.efirst) >= ($a.cland / $a.cfirst) - 0.10 then {ok: true, flag: true, row: $a.row,
        text: "\($a.row) row: sessions sent one level down to \($a.down) land first try \(pct($a.eland; $a.efirst)) vs \(pct($a.cland; $a.cfirst)) on \($a.row) (within 10 points), so \($a.row) may be picked where \($a.down) does the job."}
      else {ok: true, flag: false} end),
    ($picked | length) as $pn | (levels[] | . as $m | ($picked | map(select(.model == $m)) | length) as $c |
      if $pn < 3 * $min then {ok: false, text: "\($m) usage: not enough data (\($pn) router picks, need \(3 * $min))"}
      elif $c == 0 then {ok: true, flag: true, row: $m, text: "\($m) was never picked in \($pn) router decisions."}
      else {ok: true, flag: false} end),
    (if ($deleg | length) < $min then {ok: false, text: "delegate routing: not enough data (\($deleg | length) delegate briefs, need \($min))"}
     elif ($baddeleg | length) > 0 then {ok: true, flag: true, row: "delegates",
       text: "\(pct($baddeleg | length; $deleg | length)) delegate briefs for a sonnet role (verifier, reviewer, recon, implementer...) were routed to another model: \($baddeleg | map("task \(.task_id) \(.model)") | .[:5] | join(", "))."}
     else {ok: true, flag: false} end),
    (if ($rows | length) < $min then {ok: false, text: "fallback share: not enough data (\($rows | length) decisions, need \($min))"}
     elif ($fb / ($rows | length)) > $maxf then {ok: true, flag: true, row: "fallback",
       text: "fallback (router failed, opus used) is \(pct($fb; $rows | length)) of decisions, over \($maxf * 100 | round)%."}
     else {ok: true, flag: false} end),
    (($picked | nums("router_latency_ms") | length) as $ln |
     if $ln < $min then {ok: false, text: "router latency: not enough data (\($ln) timed calls, need \($min))"}
     elif $lat > $budget then {ok: true, flag: true, row: "latency", text: "router latency p95 is \($lat) ms, over the \($budget) ms budget."}
     else {ok: true, flag: false} end),
    (if ($cn / 2 | floor) < $min then {ok: false, text: "cost trend: not enough data (\($cn) costed sessions, need \(2 * $min))"}
     elif $c2 > $c1 * 1.25 then {ok: true, flag: true, row: "cost", text: "median cost per session rose from \($c1 | money) (older half) to \($c2 | money) (newer half)."}
     else {ok: true, flag: false} end)
  ] as $checks
| ($checks | map(select(.flag == true))) as $flags
| ($checks | map(select(.ok == false))) as $thin
| "Router review \($today): \($flags | length) flag(s), \($rows | length) rubric-pick decisions, \($exp | length) experiments and \($esc | length) escalated since \($since)",
  "",
  "Telemetry: `naru cc router --since \($since)` (\(.decisions) decisions, \(.joined) joined to a session). Minimum sample for a flag: \($min). Nothing in this report changes the rubric.",
  "",
  "## 1. Per model (rubric picks; experiments, escalations and size hints excluded)",
  "",
  "| model | sessions | finished | first-try landing | bounced | failed | retried up | median cost | median time |",
  "|---|---|---|---|---|---|---|---|---|",
  ($per[] | "| \(.model) | \(.n) | \(.fin) | \(pct(.landed; .first)) | \(pct(.bounced; .fin)) | \(pct(.failed; .fin)) | \(pct(.up; .fin)) | \(.cost | money) | \(.minutes | mins) |"),
  "",
  "Sources: \($rows | group_by(.source) | map("\(.[0].source // "unknown") \(length)") | join(", ") | if . == "" then "none" else . end). Router latency p95 (haiku calls): \($lat // "-") ms. Median cost, older half vs newer half: \($c1 | money) -> \($c2 | money).",
  "",
  "Escalations (retries one level up, out of the table above): \(.escalations) decisions, \($esc | map(select(.after_experiment == true and .source == "escalation")) | length) after an experiment; \($esc | length) escalated sessions with their relays. Parked with retries spent: \(.parked).",
  "",
  "Size hints (sessions sized by their author, mapped by the fixed table; out of the table above): \($hinted | length) sessions, \($hinted | finished | length) finished, first-try landing \(pct($hinted | landed | map(select(.landed_first_try == true)) | length; $hinted | landed | length)).",
  "",
  "## 2. Exploration (one level down vs control)",
  "",
  (if ($arms | length) == 0 then "No experiment sessions in this window (an experiment is a decision logged with `experiment: true` and its `rubric_model`, naru task 2688)."
   else ("| rubric row | arm | attempts | first-try landing | bounced |", "|---|---|---|---|---|",
     ($arms[] | "| \(.row) | experiment (\(.down)) | \(.en) | \(pct(.eland; .efirst)) | \(pct(.ebounce; .efin)) |",
                "| \(.row) | control (\(.row)) | \(.cn) | \(pct(.cland; .cfirst)) | \(pct(.cbounce; .cfin)) |")) end),
  "",
  "## 3. Flags",
  "",
  (if ($flags | length) == 0 then "No flag raised." else ($flags[] | "- FLAG [\(.row)] \(.text)") end),
  (if ($thin | length) > 0 then "", "Not enough data for:", ($thin[] | "- \(.text)") else empty end),
  "",
  "Flags raised: \($flags | length)",
  "",
  "## 4. Proposed rubric changes",
  "",
  (if ($flags | length) == 0 then (if ($thin | length) > 0 then "None: not enough data for some checks, and no flag raised." else "None: no flag raised." end)
   else "Drafted by a model from the flags above, for a person to approve; nothing is applied. Applying one means editing the router prompt (src/core/model_router.rs) and the rubric table (docs/model-router.md) together." end)
'
