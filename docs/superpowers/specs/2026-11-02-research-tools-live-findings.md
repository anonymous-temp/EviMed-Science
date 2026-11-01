# Research tools: live findings, 2026-11-02

These observations are from the deployed production revision `evimed-77ba0a43657b-1`, not the local candidate. The tests use public or synthetic data. They do not establish readiness of all tools.

## Drug selection: source version and regulatory status

The completed NVAF DOAC comparison (run `run_ce2834372b2fb74dc8ad01c0bb31c411`) correctly withheld a ranking without an institutional rubric and described differences between the RE-LY trial abstract and a later US label. Its summary nevertheless combined the original article's 1.11% annual dabigatran rate with the later label's 1.72% warfarin rate and 0.65 hazard ratio as one result. The [original RE-LY article](https://www.nejm.org/doi/full/10.1056/NEJMoa0905561) reports 1.11%, 1.69% and 0.66; the [PRADAXA label](https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=ba74e3cd-b06f-4145-b284-5fd6b84ff3c9) reports 1.12%, 1.72% and 0.65. These source versions must not be merged into a single row without labeling their provenance.

The report used a 2025 apixaban label to discuss andexanet and contrasted it with the rivaroxaban label, while describing the latter as current. The [FDA's withdrawn accelerated approvals](https://www.fda.gov/drugs/accelerated-approval-program/withdrawn-non-malignant-hematological-neurological-and-other-disorder-indications-accelerated) records Andexxa's withdrawal on 2025-12-23, and its [2026 apixaban labeling approval](https://www.accessdata.fda.gov/drugsatfda_docs/appletter/2026/202155Orig1s042%2C%20220073Orig1s001ltr.pdf) removes that language. This is US regulatory evidence; it does not establish Chinese approval or hospital availability. The report separately called local status unverified, but its current-availability implication remains unreliable. The report also stated a renal threshold without its lower boundary and drew an overbroad safety contrast from separate warfarin-controlled trials. The run's own record noted two review suggestions not addressed. A current-label and numerical-source check on the candidate model is still required.

## Statistical comparison

Synthetic comparison run `run_fb5f44ac2ff68ab9329a54a6274d5671` matched independent Welch calculation for its mean difference and interval, but reported a nonsignificant Brown–Forsythe result and identical sample variances as establishing equal population variances. The updated skill gives the correct interpretation and offers a deterministic helper; `diagnostic-interpretation` is an independent natural-language regression case. No candidate model run has yet established that the prose defect is fixed.

## Concurrent artifacts

Overlapping statistical analysis, ADR and selection runs in the same project each listed files from other runs. The new local code retains witnessed plan writes across status reads, excludes independently identified foreign directories from workspace discovery, and warns when attribution remains uncertain. Ordinary files, shared identifiers and same-path writes in one project still cannot be fully attributed or recovered from timestamps alone. Existing historical records were not rewritten. Full per-run isolation or another reliable provenance mechanism and a real concurrent candidate run remain necessary.
