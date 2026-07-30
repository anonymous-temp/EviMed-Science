# pathway-enrichment execution report

- Generated: 2026-07-30T06:49:02.994896Z
- Engine schema: 1

## Executed result

```json
{
  "enrichment": [
    {
      "bhAdjustedP": 0.9999999999999998,
      "overlap": [
        "A",
        "B"
      ],
      "overlapCount": 2,
      "pValue": 0.4999999999999999,
      "pathway": "pathway-1",
      "setSize": 3
    },
    {
      "bhAdjustedP": 1.0,
      "overlap": [],
      "overlapCount": 0,
      "pValue": 1.0,
      "pathway": "pathway-2",
      "setSize": 2
    }
  ]
}
```

## Interpretation boundaries

- Use a prespecified, measured-gene background and versioned gene sets; enrichment is not causal evidence.

## Required next checks

- Verify data provenance, units, cohort definitions, and missingness.
- Inspect the generated numeric result before making a material scientific claim.
- Escalate to a domain-specific implementation when the bounded baseline does not cover the required method.
