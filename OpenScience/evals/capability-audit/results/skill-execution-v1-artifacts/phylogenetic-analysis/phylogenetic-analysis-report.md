# phylogenetic-analysis execution report

- Generated: 2026-07-30T06:49:03.611890Z
- Engine schema: 1

## Executed result

```json
{
  "pairwiseDistances": [
    {
      "alignedSites": 12,
      "left": "sample-a",
      "pDistance": 0.08333333333333333,
      "right": "sample-b"
    },
    {
      "alignedSites": 12,
      "left": "sample-a",
      "pDistance": 0.16666666666666666,
      "right": "sample-c"
    },
    {
      "alignedSites": 12,
      "left": "sample-b",
      "pDistance": 0.08333333333333333,
      "right": "sample-c"
    }
  ],
  "sequences": {
    "sample-a": {
      "ambiguous": 0,
      "gcFraction": 0.4166666666666667,
      "length": 12
    },
    "sample-b": {
      "ambiguous": 0,
      "gcFraction": 0.4166666666666667,
      "length": 12
    },
    "sample-c": {
      "ambiguous": 0,
      "gcFraction": 0.3333333333333333,
      "length": 12
    }
  }
}
```

## Interpretation boundaries

- Confirm sequence alphabet, orientation, reference build, alignment method, and evolutionary model before inferential use.

## Required next checks

- Verify data provenance, units, cohort definitions, and missingness.
- Inspect the generated numeric result before making a material scientific claim.
- Escalate to a domain-specific implementation when the bounded baseline does not cover the required method.
