# experimental-design execution report

- Generated: 2026-07-19T19:31:31.058200Z
- Engine schema: 1

## Executed result

```json
{
  "plan": {
    "comparator": "Control",
    "constraints": [
      "allocation concealment",
      "intention-to-treat",
      "missing-data sensitivity"
    ],
    "designChecks": [
      "Randomization or confounding control",
      "Independent replication unit",
      "Sample-size justification",
      "Protocol deviations"
    ],
    "exposure": "Intervention",
    "objective": "Estimate the mean treatment effect with uncertainty",
    "outcome": "Continuous primary outcome at 12 weeks",
    "population": "Adults meeting the prespecified eligibility criteria",
    "qualityGates": [
      "Define the estimand and analysis population.",
      "Predeclare primary outcome, time point, and multiplicity handling.",
      "Record allocation, masking, missing-data, and sensitivity procedures.",
      "Link every material claim to evidence or an executed result."
    ]
  }
}
```

## Required next checks

- Verify data provenance, units, cohort definitions, and missingness.
- Inspect the generated numeric result before making a material scientific claim.
- Escalate to a domain-specific implementation when the bounded baseline does not cover the required method.
