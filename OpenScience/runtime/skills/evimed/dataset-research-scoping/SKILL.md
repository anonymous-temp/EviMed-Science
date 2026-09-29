---
name: dataset-research-scoping
description: Profile supplied research data and identify supported questions, designs, constraints and useful next steps.
---

# Dataset research scoping

Start from the researcher's actual data and purpose. Distinguish a schema sample from an intended analytic cohort using their context; do not assume a small extract is only a sample. Ask only for information that changes the next analysis. State remaining uncertainty and continue with what can be established.

Inspect locally using `scripts/profile_dataset.py` or an appropriate reproducible Python/R script. Keep source files unchanged, mask identifiers, and show aggregates or masked examples rather than patient rows. Keep the executed profiling code and its numerical outputs. Understand independent patients, repeated episodes, time ranges, missingness and outcome coding. Inspect keys and time-aware joins; a calendar-date match alone may associate a concentration with several prescriptions. Recompute substantive numerical claims from the data and distinguish measured facts from assumptions.

Assess questions in proportion to the data and user intent. Explain each design's estimand, population, available variables, confounding or selection concerns, and what a missing field prevents. Where a stronger claim is unsupported, give the strongest defensible alternative. Do not fabricate sample sizes, force an irrelevant method, substitute observed power for uncertainty, or treat a missing field as a reason to discard unrelated supported work. Use material diagnostics and sensitivity analyses when valid inputs exist.

Read enough relevant literature to support the claims that depend on it. Preserve source identifiers and citations; compare the closest work's population, exposure, outcome and design with this dataset. There is no fixed paper, channel, full-text or method count, no journal-quartile requirement, and no prescribed word count. When retrieval fails or the relevant corpus is small, deliver the profile and supported designs with that limitation. Never describe unperformed retrieval or computation as completed.

Produce a substantive `research-portfolio.md` with the useful findings and next research steps. Prefer a readable combined report over empty companion files. Optional artifacts are `data-profile.md`, `data-profile.json`, `data-profile.py`, `data-quality.md`, `evidence-map.md`, `feasibility-matrix.md`, `external-linkage.md`, `study-protocol.md`, `scoping-run.json`, and `agenda-delta.json`. Keep whichever improve reproducibility or communicate the work; these names do not require ten files or ten sections. If external linkage matters, describe the actual join key, granularity and permission/access constraint.

For local checking, run `scripts/preflight.py --workspace . --input <source>` (repeat `--input` for each source). It checks identifier leakage and recomputes a saved `data-profile.py` when available. Repair a leaking artifact without printing the identifier or discarding independent safe outputs. Missing companions or failed recomputation are explicit notices, not whole-package completion barriers. Keep successful analyses when a later calculation, dependency, retrieval or formatting step fails. A follow-up continues from the existing scripts and verified data; new data require refreshed fingerprints and appropriate recomputation.
