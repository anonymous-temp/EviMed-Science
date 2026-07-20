---
name: bayesian-modeling
description: Specify, fit, diagnose, and compare reproducible Bayesian models. Use for prior elicitation, hierarchical models, posterior prediction, uncertainty propagation, and decision analysis.
---

# Bayesian modeling

Write the generative model before code: observed data, latent quantities,
likelihood, link, hierarchy, missingness, and target estimands. Justify priors on
the scale where they act and run prior-predictive checks. Distinguish weakly
informative priors from external-evidence priors and preserve their provenance.

Fit with a suitable sampler or approximation and record chains, warm-up, seeds,
parameterization, and package versions. Diagnose R-hat, effective sample size,
divergences, energy behavior, tree depth, and chain mixing. A completed sampler
with poor diagnostics is not a valid result.

Use posterior-predictive checks targeted to the scientific question. Report
posterior intervals and decision-relevant probabilities without treating them as
frequentist guarantees. Compare models with predictive criteria only when the
observations and validation scheme make that comparison valid. Run sensitivity
analyses for priors, likelihood, influential observations, and missingness.

Write `bayesian-model.ipynb`, `posterior-summary.csv`, and
`bayesian-model-report.md`. Preserve diagnostics and failed fits. Do not invent
posterior values when a required backend or dependency is unavailable.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill bayesian-modeling --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
