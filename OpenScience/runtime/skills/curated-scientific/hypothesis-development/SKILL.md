---
name: hypothesis-development
description: Develop falsifiable scientific hypotheses from observations and evidence gaps. Use for competing explanations, mechanistic models, predictions, discriminating experiments, and hypothesis-prioritization work.
---

# Hypothesis development

Separate established evidence, observations, assumptions, and speculation. Map
the current explanatory models and contradictions before proposing a hypothesis;
absence from a narrow search is not evidence of novelty.

Express each hypothesis as a causal or mechanistic statement with a defined
population or system, exposure or intervention, outcome, direction, and time
scale. Add a plausible mechanism, boundary conditions, at least one risky
prediction, and an observation that would refute it. Produce serious alternative
hypotheses, including confounding, measurement, and selection explanations.

Design a discriminating test rather than a confirmatory narrative. Specify the
contrast, controls, measurements, expected result under each hypothesis,
analysis approach, feasibility constraints, and failure modes. Rank hypotheses
by explanatory reach, prior evidence, testability, expected information gain,
and cost without converting the ranking into truth.

Write `hypothesis-matrix.md`, `discriminating-tests.md`, and
`hypothesis-ledger.json`. Cite the evidence used and label every unsupported
premise. Do not invent preliminary data or claim that a generated hypothesis is
novel until a reproducible search supports that conclusion.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill hypothesis-development --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
