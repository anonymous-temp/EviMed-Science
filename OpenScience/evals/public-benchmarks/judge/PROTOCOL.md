# Claude-as-judge protocol (baseline v1)

The owner asked that Claude judge where a benchmark needs an LLM judge. These are internal scores: the benchmarks'
official judges (GPT-5.5 for DeepResearch Bench, GPT/Claude graders elsewhere) were not used, so no number here is
comparable to a public leaderboard entry without saying so.

Rules for every judge pass:
- The judge sees: the task text, the gold/rubric, and the system's final answer (and files it wrote, where the
  benchmark scores files). It never sees which system produced the answer beyond "the assistant".
- Verdicts are JSON lines in judge/<bench>.verdicts.jsonl: {key, verdict | scores, rationale (<= 2 sentences), judge}.
- Bulk passes run on Sonnet subagents with this protocol; the lead (Opus) re-judges a 10% random sample (seed 20261028)
  and every case a deterministic pre-scorer marked needs_judge; disagreements are resolved by the lead and counted.
- A missing or failed run is scored 0, never skipped (it is what the product delivered).

## MedBrowseComp (short answer)
Pre-scorer tools/score_shortanswer.py marks exact/contains matches; the judge decides needs_judge cases: correct iff
the answer names the same entity/value as the gold (synonyms, salt forms, brand/generic of the same molecule count;
an extra wrong item in a list answer is incorrect; "UNKNOWN" is correct only when the gold is unknown/none).

## AutoResearchBench
Deterministic (tools/score_arb.py): deep = target paper identified (arXiv id or exact title); wide = IoU of the
returned set with gold. The judge only resolves near-title matches the scorer marks needs_judge.

## DeepResearch Bench (RACE-style, internal)
Per task: the dimension weights and criteria in data/drb/criteria/<id>.json and the reference report
data/drb/reference/<id>.md. For each criterion the judge scores the target report and the reference report 0–10 in the
same pass (so the scale is anchored), then
  dim_score(report) = sum_c w_c * s_c / sum_c w_c ;  total(report) = sum_d W_d * dim_score_d
  RACE = total(target) / (total(target) + total(reference))  (0.5 = on par with the reference).
FACT (citation accuracy) is not computed in v1.

## BixBench (open answers)
Per question: correct iff the answer matches the ideal answer within the tolerance the question implies (numeric:
same value to the reported precision or within 5% relative where the question gives no precision; categorical: same
category; lists: same members). Refusal or "cannot determine" is incorrect.

## ResearchClawBench
Per task rubric items (data/rcb/<task>/rubric): each item scored 0–100 following the benchmark's own guidance (Mode A
metric comparison, Mode B evidence/logic), using the run's report/report.md and figures; task score = weighted mean.
The target study is visible to the judge only.

## BioXArena
No judge: predictions scored locally against the held-out 20% split with the task's metric.
