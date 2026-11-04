# Claude-as-judge protocol (baseline v1)

The owner asked that Claude judge where a benchmark needs an LLM judge. These are internal scores: the benchmarks'
official judges (GPT-5.5 for DeepResearch Bench, GPT/Claude graders elsewhere) were not used, so no number here is
comparable to a public leaderboard entry without saying so.

Rules for every judge pass:
- The judge sees: the task text, the gold/rubric, and the system's final answer (and files it wrote, where the
  benchmark scores files). It never sees which system produced the answer beyond "the assistant".
- Verdicts are JSON lines in judge/<bench>.verdicts.jsonl: {key, verdict | scores, rationale (<= 2 sentences), judge}.
- Who judges, and how (`tools/claude_judge.py judge`): one independent `claude -p --model <claude-*> --effort <e>` call per packet and pass, with the brief of
  `judge/briefs/<dialect>.md` (bixbench, rcb, drb-abs, drb-pair; the per-benchmark files below are the protocol those briefs implement). Model, effort and judge id
  are required and refused unless the model is a Claude id (owner 2026-11-03: an offline judge is never DeepSeek or Qwen); Sonnet for routine bulk judging, Opus
  for a demanding judge, named in the round registration and pinned with the brief's digest in the parts directory (`judge.json`), so a resume cannot change judge
  and the exporter refuses a verdict whose stamps differ from the registration. No session is kept. The call runs in a scratch copy of its one packet (links
  followed) with read-only file tools confined there (`--safe-mode --restricted --tools Read,Glob,Grep`, `dontAsk`): no shell, web, write or MCP. A verdict is
  accepted only if it matches its packet (every question once; one item per rubric item; every criterion once; race = target / (target + reference)) and is
  otherwise asked again (three attempts); a part that exists is never asked for again, so a stopped run continues by running the same command.
- No second model re-judges a sample: every packet is judged by one Claude model in repeated passes, and the judge's own noise is what is measured.
  `noise_sample.py band` writes `judge-noise/2`: per family and per form, the band of the verdict on its own 0–1 scale and an agreement computed by the
  tool (sign agreement between repeated judgings, ties excluded: pairwise across the two orders of a swapped couple, absolute as whether two passes order two
  reports the same way; a judge that only ties gets none). `register_round.py` takes that file only, and the lab admits the judge with agreement ≥ 0.9 and
  band/√passes within the registered margin. On the 2026-10/11 verdicts this admits RCB (band 0.044, agreement 1.0) and not DRB (absolute 0.895, pairwise
  0.896) or BixBench (per-capsule band 0.358). The cases a deterministic pre-scorer marks needs_judge are what a BixBench packet holds
  (`judge_packets.py --bix-unsettled`, `judged_packets_round.py`).
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

## BixBench: code first (2026-10-31)
tools/score_bixbench.py settles what the benchmark's own verifiers settle (futurehouse/BixBench `bixbench/graders.py`): a
`str_verifier` question is correct when the answer equals the ideal after removing everything but letters and digits (or is a
substring of it), a `range_verifier` question when the number lies in (lower, upper); everything else, and every `llm_verifier`
question, goes to the judge with the question, the ideal answer and the extracted answer. The judge's verdicts for the questions code
settled are not asked for. `--deterministic-only` prints the strict and upper-bound figures of the range and str questions;
`--compare` lists every question where the judge and the code differ, which are looked at, never silently resolved. The benchmark
itself sends open-answer range questions to an LLM and str questions that miss both rules to an LLM; code settles the first two
steps only.

## Delivery at the cap, and repeated judging (2026-10-31)
- A run cancelled at its time limit that had written a report-like file is judged on that file: the packet says
  `"delivery": "at-cap"` and the judge copies the field into its verdict line. report.py reports two figures: strict (a timeout is 0)
  and at-cap (the judged score of what existed). Nothing else about the judging changes; the judge is not told which figure
  a packet feeds.
- To measure the judge's own noise, or to average it out, the same report is judged N times: `judge_packets.py <bench> --repeats N`
  writes N independent packet sets (p1 … pN). Each pass goes to a separate judge call that has seen no verdict of the same report,
  writes judge/<name>.p<k>.jsonl (pass 1 is the plain file), and report.py aggregates the passes (mean per report, pooled SD).
- The judge-noise sample of phase 0.4 is built and read by tools/noise_sample.py (`packets`, `band`).


## DeepResearch Bench, pairwise (A/B between our arms, internal)
- RACE against the fixed reference compresses at the top (a perfect 10 gives 0.573), so arms are compared directly with `tools/drb_pairwise.py`.
- Per task, `packets` writes two packets per pair, with the report order swapped, and keeps the order in `order.json` (operator only).
- The judge sees `report_1` and `report_2` and, for every criterion in `criteria.json`, gives an integer `pref` from -3 to +3. Positive means `report_1` is better; 0 is equal, 1 slight, 2 clear, 3 decisive.
- Each packet goes to a separate judge call that has seen no verdict of the same pair. The judge never sees arm names, order or other passes.
- Verdict line: `{"key": "drb-pair/<task>/p<k>", "scores": {dimension: [{"idx": i, "pref": n}]}, "notes": …}`.
- A missing or invalid criterion or pass excludes that task from the means, and it is listed, never scored as zero.
- `aggregate` reports the mean signed preference by dimension, the position-bias estimate and the order-swap agreement.
- A future calibration would run the official judge (GPT-5.5 since 2026-05-11, Gemini-2.5-Pro on the legacy board) on the same tasks for both arms and compare the sign and rank of the differences. It needs the owner's decision on a paid judge first.
