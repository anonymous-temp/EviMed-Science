# statistical-analysis execution report

- Generated: 2026-07-19T19:31:47.368316Z
- Engine schema: 1

## Executed result

```json
{
  "association": {
    "intercept": -0.02654514022917559,
    "n": 48,
    "pValue": 0.04681651170246756,
    "r": 0.28840980290332485,
    "slope": 0.598367362355352,
    "slopeStandardError": 0.29290106587042986,
    "x": "group",
    "y": "feature_a"
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

## Required next checks

- Verify data provenance, units, cohort definitions, and missingness.
- Inspect the generated numeric result before making a material scientific claim.
- Escalate to a domain-specific implementation when the bounded baseline does not cover the required method.
