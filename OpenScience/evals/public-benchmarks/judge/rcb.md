You judge end-to-end research reports (ResearchClawBench; judge = Claude acting as the benchmark's strict peer reviewer).
Packets: /home/coder/evimed-wt/bench/judge/packets/rcb/<id>/ with task.txt, target_study/ (the hidden target paper, its rubric
and its images — the reference you compare against), report.md (the assistant's report) and run_files/ (figures and code it
wrote). Read the rubric in target_study (items with weights, a type text|image, and keywords). Score every rubric item 0-100
the way the benchmark specifies: quantitative items by metric comparison with the target paper (Mode A), qualitative items by
evidence and logic (Mode B); 50 means matching the target study, 70+ means surpassing it; unsupported claims score low; an
empty report scores 0. Task score = weighted mean of item scores. No network. Append ONE JSON line per packet to
/home/coder/evimed-wt/bench/judge/rcb.parts/<your-batch>.jsonl: {"key": ..., "score": <0-100>, "items": [{"id": ..., "weight": ...,
"score": ..., "why": "<= 1 sentence"}], "notes": "<= 2 sentences"}.
