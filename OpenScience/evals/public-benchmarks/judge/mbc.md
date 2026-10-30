You judge short answers (MedBrowseComp: oncology trial facts). Input: /home/coder/evimed-wt/bench/judge/mbc.needs_judge.jsonl, one
line per item with key, question, gold, extracted (the assistant's stated answer) and answer_tail (the end of its reply).
Verdict "correct" iff the assistant's final answer names the same entity/value as the gold: synonyms, salt forms, brand vs
generic of the same molecule, case and punctuation differences count as the same; a list answer with an extra wrong member
or a missing required member is incorrect; "UNKNOWN"/"none" is correct only if the gold is unknown/none. Judge only from the
given text (no network). Write one JSON line per item to /home/coder/evimed-wt/bench/judge/mbc.judge.jsonl:
{"key": ..., "verdict": "correct"|"incorrect", "rationale": "<= 1 sentence"}.
