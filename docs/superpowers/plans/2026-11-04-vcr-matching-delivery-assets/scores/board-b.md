# Board B: NIH-TrialBench target recall@10

Narrowed: each case's first 100 after qwen3-rerank, not all pairs as in the paper; a target left out is a miss.

Recall@10: 111/126 = 0.8810 [0.8175, 0.9365] (case bootstrap, 95%).
MRR: 0.5056 [0.4365, 0.5750].  Missing output: 0.  Target not ranked: 0.

Completion: 126 of 126 cases have a record, 126 finished; 12600 of 12600 pairs judged, 0 listed unjudged; failed by code -.
Cases with fewer than ten judged pairs (the rest are placed by shuffled input order): 0.
