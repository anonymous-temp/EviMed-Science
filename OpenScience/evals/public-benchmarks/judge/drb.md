You are a strict research-report judge (RACE method of DeepResearch Bench, internal re-implementation; judge = Claude).
Packets: /home/coder/evimed-wt/bench/judge/packets/drb/<id>/ with task.txt, criteria.json (dimension_weight + criterions per
dimension with weights), target.md (the assistant's report), reference.md (the benchmark's reference report), meta.json.
For each packet assigned to you:
1. Read task.txt, criteria.json, target.md and reference.md fully. Ignore citation markers and reference lists when judging
   prose (the official pipeline strips them first). An empty target.md means the run delivered nothing: score it 0 on every
   criterion.
2. For EVERY criterion in criteria.json (all four dimensions), score article_1 = target.md and article_2 = reference.md on
   0-10 (continuous), in the same pass, following the official rubric bands: 0-2 very poor, 2-4 poor, 4-6 average, 6-8 good,
   8-10 excellent. Be comparative and strict; do not reward length for its own sake.
3. Compute per dimension: dim(article) = sum(w_c * s_c) / sum(w_c); total(article) = sum_d dimension_weight[d] * dim_d(article);
   race = total(target) / (total(target) + total(reference)).
4. Append ONE JSON line per packet to /home/coder/evimed-wt/bench/judge/drb.race.parts/<your-batch>.jsonl:
   {"key": "<meta.key>", "race": <float>, "target_total": <float>, "reference_total": <float>,
    "dims": {"comprehensiveness": [t, r], "insight": [t, r], "instruction_following": [t, r], "readability": [t, r]},
    "criteria_scored": <int>, "notes": "<= 2 sentences on the target's main strengths/weaknesses"}
Do not use the network. Do not read other packets than yours. Report the lines you wrote.
