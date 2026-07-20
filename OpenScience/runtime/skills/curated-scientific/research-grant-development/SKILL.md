---
name: research-grant-development
description: Develop evidence-grounded scientific grant proposals. Use for specific aims, significance, innovation, approach, milestones, feasibility, risk mitigation, budgets, and reviewer-oriented proposal audits.
---

# Research grant development

Extract the funder, mechanism, scope, eligibility, page limits, review criteria,
deadline, budget rules, and required attachments from authoritative instructions.
Do not invent a funding rule or reuse a requirement from another call.

Build a one-sentence problem, evidence-backed gap, central premise, overall
objective, and two to four logically connected aims. Each aim needs a hypothesis
or objective, rationale, design, measurable outcome, success criterion,
alternative strategy, and contribution. Keep aims valuable even if another aim
fails unless the mechanism explicitly supports a sequential program.

Connect significance and innovation to cited evidence. Make the approach
statistically and operationally credible: population, data, methods, sample-size
rationale, reproducibility, ethics, milestones, personnel, dependencies, and
risk controls. Align the budget and timeline to the actual work without
fabricating institutional resources or preliminary results.

Write `specific-aims.md`, `proposal-outline.md`, `milestones.csv`, and
`grant-audit.md`. The audit maps every review criterion and instruction to a
location, flags missing evidence, and preserves unresolved feasibility risks.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/_runtime/execute_skill.py" --skill research-grant-development --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
