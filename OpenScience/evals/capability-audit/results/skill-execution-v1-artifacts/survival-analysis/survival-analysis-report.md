# survival-analysis execution report

- Generated: 2026-07-30T06:49:10.523019Z
- Engine schema: 1

## Executed result

```json
{
  "events": 5,
  "kaplanMeier": [
    {
      "atRisk": 8,
      "events": 1,
      "survival": 0.875,
      "time": 5.0
    },
    {
      "atRisk": 7,
      "events": 1,
      "survival": 0.75,
      "time": 6.0
    },
    {
      "atRisk": 5,
      "events": 1,
      "survival": 0.6000000000000001,
      "time": 8.0
    },
    {
      "atRisk": 3,
      "events": 1,
      "survival": 0.4000000000000001,
      "time": 12.0
    },
    {
      "atRisk": 1,
      "events": 1,
      "survival": 0.0,
      "time": 18.0
    }
  ],
  "n": 8
}
```

## Interpretation boundaries

- Check censoring assumptions, delayed entry, competing risks, clustering, and proportional hazards before further inference.

## Required next checks

- Verify data provenance, units, cohort definitions, and missingness.
- Inspect the generated numeric result before making a material scientific claim.
- Escalate to a domain-specific implementation when the bounded baseline does not cover the required method.
