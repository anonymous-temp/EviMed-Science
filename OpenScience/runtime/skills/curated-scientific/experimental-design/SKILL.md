---
name: experimental-design
description: Design reproducible laboratory, computational, observational, or simulation experiments. Use for hypotheses, estimands, controls, randomization, blocking, sample-size rationale, analysis plans, and failure criteria before data collection.
---

# Experimental design

Define the research question, unit of inference, estimand, primary endpoint, population, intervention or exposure, comparator, and decision threshold. Distinguish biological replicates from technical replicates and prevent pseudoreplication.

Specify inclusion/exclusion rules, controls, randomization, allocation concealment where applicable, blocking or stratification, blinding, batch handling, missing-data strategy, multiplicity, and a sample-size or precision rationale. Use `statistical-power` when a quantitative power calculation is justified; label assumptions and sensitivity ranges.

Predeclare the primary analysis, robustness checks, data-quality gates, stop/failure conditions, and deviations log. Do not invent pilot variance or effect sizes. Do not convert a research design into an individual treatment recommendation.

Write `experimental-design.md`, `analysis-plan.md`, and a machine-readable `design-spec.json` with versioned assumptions.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill experimental-design --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
