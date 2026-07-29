# open-domain-answer-quality

Measures the quality of the platform's open-domain answers with an LLM judge.
Other evals grade reports or run metadata; this harness is the feedback loop
for the answer prose itself: direct, readable, useful, correct, honest.

- `questions.yaml` — 30 Chinese questions across three depth tiers:
  `direct` (10 factual/mechanism), `synthesis` (12 evidence + weighed
  conclusion), `report` (8 explicit report requests, verifying the run still
  reaches the heavy report pipeline). Adversarial cases: metadata-only
  evidence (q-synthesis-07), a nonexistent drug (q-synthesis-08), high-risk
  速效救心丸 safety framing (q-synthesis-06), one English question (q-direct-10).
- `run_eval.py` — collects answers (live mode) or normalizes pre-collected
  ones (offline mode) into `results/answers-<timestamp>.json`.
- `judge.py` — DeepSeek judge, scores 0-5 on directness, readability,
  usefulness, correctness, uncertainty_calibration; writes
  `results/report-<timestamp>.json` and prints a per-tier summary table.

## Prerequisites

- Judge: `DEEPSEEK_API_KEY` (or the local `.evimed-local/secrets/deepseek.api-key`
  file). Optional: `OPEN_SCIENCE_EVAL_JUDGE_MODEL` (default `deepseek-v4-pro`),
  `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`).
- Live mode: a reachable server with local password auth (e.g. `pnpm dev:server`).
  `OPEN_SCIENCE_EVAL_BASE_URL` (default `http://127.0.0.1:8798`),
  `OPEN_SCIENCE_EVAL_USERNAME` (default `evimed`),
  `OPEN_SCIENCE_EVAL_PASSWORD` (or the local bootstrap-password file),
  `OPEN_SCIENCE_EVAL_PROJECT` (default `eval-open-domain-quality-v1`).
  The server has no bearer tokens; the script logs in, then sends the session
  cookie + `X-Open-Science-CSRF` + `X-Open-Science-Project` headers, creates an
  open-domain research session per question, dispatches, and polls
  `GET /api/agent-runs` until terminal. OIDC-hosted servers need interactive
  sign-in — use offline mode there.

## Commands

```bash
# sanity check, no network, no keys
python3 evals/open-domain-answer-quality/judge.py --self-test
# live: collect all 30 answers, then judge (long: report tier is slow)
python3 evals/open-domain-answer-quality/run_eval.py

# live, a subset; already-collected ids are skipped unless --rerun
python3 evals/open-domain-answer-quality/run_eval.py --only q-direct-01,q-synthesis-06

# offline: judge answers collected by hand (accepts the answers schema, a
# bare [{"id","answer"}] list, or an {"id": "answer"} mapping)
python3 evals/open-domain-answer-quality/run_eval.py --answers-file my-answers.json

# re-judge the latest collected answers
python3 evals/open-domain-answer-quality/judge.py
```

## Reading the report

`results/report-<timestamp>.json` holds per-case scores, issues, and judge
rationale plus a summary: per-dimension means and overall mean per tier and
across all cases (the printed table shows the same numbers). Cases that
failed to collect or judge are counted separately and excluded from means.
