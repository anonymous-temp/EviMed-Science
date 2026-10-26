# Analysis Continuity and Live Acceptance Implementation Plan

**Goal:** Verify a real DeepSeek/DSH analyst across corrections and additional data, with selective recomputation and independently checked results; commit and push without deployment.

**Architecture:** The LLM owns the research question, method choice, code and interpretation. Reuse the existing dataset-semantics service and native execution receipts. A workspace dependency manifest adds verified step reuse; a local prediction audit supplies numerical findings, never a delivery veto. No second agent orchestrator or mandatory form.

**Tech stack:** Python standard library for continuity, scikit-learn/statsmodels for numerical checks, existing Node control-plane and DSH acceptance harness.

## 1. Step continuity

Files: `OpenScience/capabilities/statistical-analysis/scripts/analysis_session.py`, its injected copy, and `OpenScience/evals/statistical-analysis/test_analysis_session.py`.

- [x] Reproduce missing selective invalidation, stale outputs, failed corrections and unsafe path protection in tests. Run `python -m unittest discover -s OpenScience/evals/statistical-analysis -p test_analysis_session.py`; checkpoint RED.
- [x] Implement `status` and `run --step ID` over a JSON step manifest (`id`, `script`, `interpreter`, `inputs`, `outputs`, `results`, `dependsOn`, `context`). Signatures bind data, code, semantic context, runtime versions and upstream signatures. Verify output hashes before reuse. Record actual execution through `run_analysis.py`; only successful, changed, finite outputs can become reusable. Keep prior receipts and results on a failed correction.
- [x] Test that changing report units invalidates only the report, changing data invalidates all dependants, changing one branch leaves a sibling reusable, and corrupt/missing state never silently reuses a result. Checkpoint GREEN.

## 2. Result checks

Files: `OpenScience/capabilities/statistical-analysis/scripts/analysis_checks.py`, injected copy, and `OpenScience/evals/statistical-analysis/test_analysis_checks.py`.

- [x] Reproduce reversed outcome/probability coding, overlapping patients, preprocessing fitted on test patients, missing observations, duplicate patient rows, single-class calibration and inconsistent reported values. Checkpoint RED.
- [x] Compute held-out discrimination, Brier score and calibration from explicit positive-class probabilities. Label what is unknown; distinguish repeated observations from independent subjects. Expose exact report-value checks with tolerances; reuse existing report rendering rather than parse arbitrary prose or claim all leakage is detectable from a table.
- [x] Run independent reference checks and negative controls; checkpoint GREEN.

## 3. Real multi-turn acceptance

Files: `OpenScience/evals/statistical-analysis/live/`, existing capability acceptance briefs and acceptance ledger.

- [x] Reuse the current pinned DSH and real control-plane model gateway in an isolated local acceptance environment. Keep operator keys in the gateway, mark turns automated, disable learning, use public/synthetic fixtures only.
- [x] Run natural-language comparison, unit correction, added patients and prediction scenarios. Do not prescribe functions or give gold answers to the Agent. Preserve each turn's transcript, code, data hashes, results, state and actual route/model.
- [x] Independently check counts/effects, positive-class direction, split integrity, calibration, report bindings and unaffected-step reuse. An unexecuted or unobservable criterion stays unverified. Repair actual failures and rerun affected scenarios.

## 4. Delivery

- [x] Update statistical skill, capability version, audit spec and `OpenScience/PROGRESS.md` with measured results and environment limits.
- [x] Run statistical suite, capability contracts/copy parity, changed-file checks and independent code reviews. Resolve findings.
- [ ] Commit and push `codex/research-tools-data-analysis-20261026`; verify the remote SHA. Do not deploy or modify production data.

## Verification notes

The real suite ran five cases and eleven turns. Primary numbers, state reuse and report interpretation have independent evidence in the 2026-10-26 multi-turn report. Original failures are preserved and targeted later runs close them; the source is not described as production-accepted. Final registered suite: 179 Python and 11 Node tests. Deployment-contract checks: 75 macOS tests plus the remaining GNU-Bash-specific test in Linux. Independent reviewers approved the implementations and evaluator corrections.
