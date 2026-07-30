# biomedical-signal-analysis execution report

- Generated: 2026-07-30T06:48:49.561606Z
- Engine schema: 1

## Executed result

```json
{
  "forecast": [
    -0.0854699728632039,
    -0.09389968154254513,
    -0.10232939022188647,
    -0.1107590989012277,
    -0.11918880758056905,
    -0.12761851625991028,
    -0.13604822493925162,
    -0.14447793361859285
  ],
  "residualStd": 0.6594552939918522,
  "signal": {
    "dominantFrequencyHz": 0.125,
    "samplingHz": 4.0
  },
  "trend": {
    "intercept": 0.4540313826146378,
    "slope": -0.008429708679341277
  }
}
```

## Interpretation boundaries

- Linear extrapolation is a baseline; validate stationarity, leakage, autocorrelation, seasonality, and out-of-sample error.

## Required next checks

- Verify data provenance, units, cohort definitions, and missingness.
- Inspect the generated numeric result before making a material scientific claim.
- Escalate to a domain-specific implementation when the bounded baseline does not cover the required method.
