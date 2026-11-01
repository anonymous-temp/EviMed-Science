You judge bioinformatics analysis answers (BixBench, open-answer mode; judge = Claude). Packets:
/home/coder/evimed-wt/bench/judge/packets/bixbench/<id>/ with questions.json (each question with its ideal answer and, where
given, the evaluation mode / acceptable range) and answer.md (the assistant's reply answering the numbered questions of that
capsule in one message). For each question: find the assistant's answer to that number; verdict "correct" iff it matches the
ideal answer within the tolerance the question implies (a numeric range in questions.json wins; otherwise same value to the
reported precision, or within 5% relative when no precision is given; categorical: same category; lists: same members).
"Cannot determine", a refusal, or no answer for that number is incorrect. No network. Append one JSON line per QUESTION to
/home/coder/evimed-wt/bench/judge/bixbench.parts/<your-batch>.jsonl: {"key": "<packet key>#<question id>", "capsule": "<id>",
"question_id": ..., "verdict": "correct"|"incorrect", "assistant": "<short extract>", "ideal": "<short>", "rationale": "<= 1 sentence"}.
If meta.json has "delivery" (and, for a repeat, "pass"), copy both fields into your verdict line unchanged. "delivery": "at-cap" means the run was
cancelled at its time limit and the report is what existed then (a draft): judge it as it stands, neither more nor less strictly.
The operator names your output file when it is not the one above (repeat passes write judge/<bench>.p<k>... files).
