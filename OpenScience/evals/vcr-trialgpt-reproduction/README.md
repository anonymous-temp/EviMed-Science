# TrialGPT prompt reproduction and matching repair

The 2026-11-02 experiment did not match historical TrialGPT GPT-4 label agreement.
It identified and repaired engineering defects in the actual matching path.
[Aggregate results](results/2026-11-02-summary.json) contain no patient notes or keys.

Interpretation update, 2026-11-03: every Flash arm below explicitly disabled
thinking and called the provider directly, without DSH. These results do not
measure Flash reasoning, Flash with DSH, or general superiority to GPT-4.
The legacy Flash request alias returned `deepseek-flash`; current official
documentation maps that alias to V4.1 Flash. The [Flash-only remediation plan](../../../docs/superpowers/plans/2026-11-03-vcr-flash-matching-remediation.md)
re-analyzes the preserved errors and defines the missing controlled experiments.
Pro rows remain historical records, not a recommendation to use Pro.
The [platform comparison protocol](../../../docs/superpowers/plans/2026-11-03-evimed-trialgpt-platform-comparison.md)
now owns the main benchmark: measure EviMed's actual feature before and after
remediation. Direct API experiments are component diagnostics only.

| Arm | All 1,015 annotations | 837 evaluation annotations |
|---|---:|---:|
| Historical cached GPT-4 | 87.29% | See aggregate |
| Original prompt, Flash | 73.89% | 73.60% |
| Original prompt, Pro | 73.10% | 72.76% |
| Strict missingness, Flash | 55.67% | 56.87% |
| Strict missingness, Pro | 51.92% | 52.57% |
| Pro reasoning, secondary | 65.02% | 62.84% |
| Development calibration, rejected | 74.68% | 73.24% |

These are expert-label agreements on previously used public synthetic cases,
not clinical accuracy. Ten entire patients calibrate the diagnostic; the other
43 form the evaluation partition. Twelve reasoning replies truncated at the
8,192 output-token cap remain failures. The calibration's development gain
does not transfer, so it is not activated. No default model change or deployment.

## Reproduction contract

Acquire official source from commit `1b3242cd50c153a9c324661d4a0bd94fc68a4226`:
`trialgpt_matching/TrialGPT.py`, `dataset/sigir/retrieved_trials.json`,
`dataset/sigir/corpus.jsonl`, and `LICENSE`. Put them in the private run's
`upstream/` directory, naming the retrieval file `sigir-retrieved_trials.json`.
The code uses the acquired allowlisted inputs and group split from the earlier
comparison; `prepare.py` names these paths. No SDK or model installation is needed.

The loader checks the official source blob before executing only the three pure
prompt functions. Full background is retained. Raw source segmentation covers
891 annotation units uniquely; the primary uses original prompts with the
benchmark annotation units instead. Three upstream-parser omissions remain in
the 1,015 denominator. This is not a byte-identical paper-era input claim.

Expert targets are primary. Stored GPT-4 answers are a historical comparator.
Six closed equivalent JSON object forms are converted without changing labels
or evidence; strict array compliance is also reported. Frozen data, target,
request, patient and served-model bindings are checked. First responses and
failures are retained. Post-inference parser/accounting repairs and registration
timing are qualified in the private report and linked amendments.

```sh
python3 -m unittest discover -s OpenScience/evals/vcr-trialgpt-reproduction -p 'test_*.py'
python3 OpenScience/evals/vcr-trialgpt-reproduction/prepare.py
python3 OpenScience/evals/vcr-trialgpt-reproduction/run.py --help
python3 OpenScience/evals/vcr-trialgpt-reproduction/calibrate.py --help
```

`freeze` precedes inference. `bind-targets` links complete expert/generation
targets before scoring; its timestamp must be disclosed when bound after
inference began. Set `VCR_EVAL_PROVIDER_CONFIG` to an operator-owned configuration
of key-file paths, as documented in `../vcr-model-comparison/`. Do not put
credentials, real notes or per-patient caches into Git. Data-dependent tests skip
only when their acquired public fixture is absent.

## Shipped repair scope

`matching.extract` 1.1.0 / `match-extract-4` preserves full question context,
chunks output work, prices every chunk, and invalidates legacy/changed reading
budgets before paid work. Scoped clinical intervals survive source verification.
Historical events and partial negatives do not prove absence over later windows.
Date-only database bindings are UTC; historical rows and fact keys stay intact.
Metric version 2 separates unknown eligible cases from explicit false exclusions.
Language predicates remain pending conversation work after fact extraction.

Local verification: 104 matching/storage tests (including ten PostgreSQL tests),
62 related tests, 11 domain tests, four error-code tests, 21 reproduction tests,
31 prior comparison tests, and nine drafted Chinese synthetic live-model controls.
Typechecks and lint pass. This does not establish hosted DSH/browser acceptance
or independent clinical validity. Private receipts, reports and reviews are at
`.evimed-local/acceptance/vcr-trialgpt-reproduction-20261102/`.

Upstream: [TrialGPT](https://github.com/ncbi-nlp/TrialGPT/tree/1b3242cd50c153a9c324661d4a0bd94fc68a4226),
[annotations](https://huggingface.co/datasets/ncbi/TrialGPT-Criterion-Annotations).
