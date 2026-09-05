# Review and Research Topic Quality Design

Date: 2026-09-05. Base: main 8ce276f. User selected the review/topic iteration from the preceding evidence-backed audit and explicitly requested implementation.

## Scope and ownership

Work in the outer checkout on codex/reviews-topics-20260905. The independent codex/full-saas-delivery-20260905 clone owns native UI, accounts, persistence, CI and deployment. This branch owns clinical review and topic-selection business quality only.

## Chosen design

Preserve the existing DSH composition, existing required outputs and shared delivery gate. Avoid a second review pipeline. Do not add open-vocabulary regex rules or more hard blocking points.

Reviews extend clinical-evidence-search.json with an optional, versioned reviewMethods object. It records reviewType, eligibility, protocol status/deviations, searchCoverage referencing existing query indexes and explicit studyGroups referencing sourceRecords.referenceNumber. Deterministic findings distinguish retrieved reports from independent primary studies, missing/duplicate assignments, title-only inclusion and searches that failed rather than returned no evidence. Unknown identities remain unknown; no title similarity is used to infer identical studies. Existing clinical safety/citation validation remains authoritative. Findings reach both server and runtime through the single clinicalEvidence implementation.

Topic selection accepts optional availableData, population, studySetting and resourceConstraints. These pass from capability/MCP through both job transports into the specialist, are preserved without changing the search direction, and shape M5/M6 planning and final interpretation. A structured research-portfolio.json preserves candidate hypotheses, evidence references, opportunity lineage, required data, design/estimand, falsification and feasibility/novelty uncertainty. Missing design details remain explicit gaps, not invented sample sizes or default scores presented as measurements. The original specialist output remains only one input to the DSH final selection.

Both skills stop asserting old host outages as timeless facts. Capability availability comes from current tool responses. A small result set cannot prove an empty field, and fixed source/channel quotas cannot substitute for question-specific coverage. The topic evidence preflight is updated in every published copy to produce actionable, proportional diagnostics while preserving factual citation/identifier integrity.

## Acceptance

- Legacy packages and topic requests remain supported.
- Review report-count and study-count fixtures stay distinct, including multiple papers from one trial and evidence with unknown study identity.
- Failed/missing searches stay visible; invalid query references and duplicate source assignments produce advisory findings.
- No new finding changes the existing set of blocking decisions.
- Topic constraints survive MCP, local runner, hosted adapter, task state and model planning.
- Portfolio entries preserve source lineage; missing hypothesis/design/falsifier fields are represented honestly.
- At least three realistic briefs for each capability cover an ordinary request, limited evidence, and misleading novelty or overlapping reports.
- All published skill/preflight copies and generated manifests agree.
- Test-first RED/GREEN checkpoints; independent specification and Python/JavaScript code review; focused suites plus relevant build/type/lint checks.
- Live evidence-backed checks use protected existing configuration only, without printing secrets or altering production.

