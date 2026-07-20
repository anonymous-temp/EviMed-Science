---
name: time-series-forecasting
description: Design, fit, and backtest scientific time-series forecasts. Use for temporal baselines, hierarchical series, interventions, uncertainty intervals, drift monitoring, and reproducible forecast comparison.
---

# Time-series forecasting

Define the target, unit, cadence, forecast origin, horizon, decision use, update
schedule, and admissible predictors. Audit missing intervals, revisions,
seasonality, structural breaks, interventions, aggregation, and data availability
at each historical forecast origin.

Use rolling-origin backtesting and simple seasonal or persistence baselines.
Fit transformations, imputation, scaling, and feature generation within each
training window to prevent future leakage. Match metrics to the decision and
series scale; report interval coverage and calibration in addition to point
error. For multiple series, evaluate both aggregate and subgroup performance.

Compare models over several origins, horizons, and regimes. Quantify uncertainty,
sensitivity to revisions and window choice, and degradation under drift. A good
retrospective fit is not a valid forecast. Causal claims require a separate
identification design.

Write `forecast-analysis.ipynb`, `backtest-results.csv`, `forecasts.csv`, and
`forecast-report.md`. Record data vintages, model versions, seeds, and failed
fits. Never fabricate forecasts when the executable model did not run.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill time-series-forecasting --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
