# clinical-machine-learning execution report

- Generated: 2026-07-30T06:48:53.301700Z
- Engine schema: 1

## Executed result

```json
{
  "model": {
    "crossValidatedAccuracy": 0.7708333333333334,
    "folds": 5,
    "target": "group",
    "task": "classification"
  },
  "numericSummary": [
    {
      "column": "group",
      "count": 48,
      "max": 1.0,
      "mean": 0.5,
      "median": 0.5,
      "min": 0.0,
      "missing": 0,
      "std": 0.5052911526399113
    },
    {
      "column": "feature_a",
      "count": 48,
      "max": 3.3087471992656643,
      "mean": 0.27263854094850043,
      "median": 0.07621761335627325,
      "min": -1.6404298821333358,
      "missing": 0,
      "std": 1.0483337639115797
    },
    {
      "column": "feature_b",
      "count": 48,
      "max": 1.8677363489172076,
      "mean": 0.009294265502765913,
      "median": -0.2378576355631656,
      "min": -1.8803199776760502,
      "missing": 0,
      "std": 0.8687635149928787
    },
    {
      "column": "outcome",
      "count": 48,
      "max": 6.008030749390383,
      "mean": 0.8630497512812604,
      "median": 0.683415576815763,
      "min": -2.6922235033939437,
      "missing": 0,
      "std": 1.836153543733723
    }
  ],
  "table": {
    "columns": 5,
    "duplicateRows": 0,
    "missingCells": 0,
    "numericColumns": [
      "group",
      "feature_a",
      "feature_b",
      "outcome"
    ],
    "rows": 48
  }
}
```

## Interpretation boundaries

- This is a bounded baseline, not a clinically validated predictive model.

## Required next checks

- Verify data provenance, units, cohort definitions, and missingness.
- Inspect the generated numeric result before making a material scientific claim.
- Escalate to a domain-specific implementation when the bounded baseline does not cover the required method.
