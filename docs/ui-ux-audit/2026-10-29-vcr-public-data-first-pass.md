# Virtual clinical research: first public-data product audit

Date2026-10-29. Requested scope: prepare four datasets and evaluate functionality, presentation, interaction, observable reasoning/tool use and final outputs. Execution primarily used the platform backend, with no screenshot-per-record collection. Two agents handled data preparation and independent review; the parent operated hosted tasks and consolidated evidence.

> Historical diagnostic baseline. Subsequent implementation and current-code verification are recorded in [the remediation acceptance report](2026-10-29-vcr-remediation-acceptance.md).

## Verdict

The platform can deliver useful analyses and files, but a succeeded conversation is not yet sufficient evidence of a completed scientific workflow. The main immediate priorities are dataset-to-object binding, distinct patient/observation semantics, evidence-constrained eligibility and time interpretation, and result-level completion/readback. Preserve conversation as the entry; do not expand into recruitment operations or another calculator catalogue.

This is a diagnostic pilot, not a completed clinical benchmark, leaderboard submission, or a claim of representative clinical performance. Current serving health reported evimed-0c75bad189f6-1; local code inspected/tested was43d19e043. No deployment or product-source patch was performed. Six temporary accounts (five agent tasks, one direct intake diagnostic) were removed through the normal deletion API.

## Data and execution coverage

- TrialGPT:1,015clean rows,53synthetic patients; evaluator gold separated. A purposive12-case pack covered the available criterion-type/label combinations, including9original non-training and3training examples. All12 were answered in an actual hosted run.
- TREC2021/22/23:75/50/40topics and35,832/35,394/33,870qrels acquired. Original historical corpus downloads returned406 and exceed the preparation size cap. Two6-candidate author-derived historical pools were exercised.2023current registry records are kept separately and were not scored as historical corpus data.
- PhysioNet2012:A/B/C raw archives and outcome files acquired. Hosted test used80baseline patients and4,407original HR measurements from78patients; outcomes withheld. A local engine audit and a direct serving data-plane import also ran.
- ACTG175:2,139records from documented CRAN source,521composite events. Source-data rights unresolved, so no patient rows sent to hosted model. Local real-engine KM/RMST results checked against independently implemented references.

The six account deletions succeeded. All five model tasks ended succeeded:12criteria27tool calls, inline criterion26 59calls, PhysioNet89calls, TREC21 49calls, TREC22 82calls. Those statuses are execution evidence, not content or native-object acceptance.

## Findings

| ID | Priority | Finding and evidence | Repair target and acceptance |
|---|---|---|---|
| VCR-A01 | P1 | Local profile.snapshot on the longitudinal HR file reports realPatients=4407 although diagnostic USUBJID distinct=78. Shared row counting in inputs.R is used by profile and analogous cohort paths. | Make grain and identity explicit; visit/event rows must not count as people. Assert80baseline people,78HR people,4407observations; verify multi-event and duplicate-ID variants. Reject undefined grain where counts would be ambiguous. |
| VCR-A02 | P1 | Uploaded CSVs are readable by the agent, but its formal cohort build returnsSnapshot not found. It delivers correct80/52CSV cohorts instead. Detailed text discloses failure, while other completion wording/waterfall suggests cohort creation. Direct serving upload/map/freeze separately succeeds80/80. | Reuse existing supported data intake to bind source→map→snapshot→population before calculation. Distinguish file analysis, saved definition and computed cohort. Read back exact object/result versions before announcing scientific completion. |
| VCR-A03 | P1 | In the12-case batch, criterion26 infers cleared childbearing exclusion from age58;120 turns absent family/index/OGTT evidence into failed inclusion. All three reference not_applicable cases lose applicability. | Separate applicability from satisfaction/unknown; require source-supported facts. Add counterexamples for menopause, family history, procedure prerequisites, tests/modalities and time windows. Do not force conservative unknowns into known labels merely to improve gold agreement. |
| VCR-A04 | P1 | TREC22 uses datasetyear2022 as the patient's encounter date, derives birth~2003 and excludes a trial by age/calendar logic absent from the case. | Separate dataset/snapshot dates, encounter dates and clinical event dates. No manufactured calendar anchor; missing clinical dates stay unknown. Check date-shift invariance when only dataset metadata changes. |
| VCR-A05 | P2 | One criterion required59tool calls. The captured trace contains24vcr_write calls,20refused; an empty patient_set and a probe decision were actually saved while discovering syntax. | Expose complete contracts before task scope exists; validation/discovery must not create empty scientific objects. Return typed missing prerequisites and reusable handles. Test no schema-guessing writes and no probe objects. Attribute automation refusals correctly. |
| VCR-A06 | P2 | The PhysioNet waterfall mixes80→78→52 with28excluded from the original80, not a consistent sequential denominator. Age mean66/median71 and independently negative skew are described as right-skewed. Missingness differences are presented as established selection bias. | Attach denominator/grain/filter definition to every count. Derive explanation from computed statistics, label bias as a risk unless identified, and independently check narrative against machine values. |
| VCR-A07 | P2 | ACTG day-valued RMST inputs without timeUnit default to months; explicitdays agrees with reference. This is a caller-contract hazard, not yet demonstrated serving mapping failure. | Carry units from source mapping through scenario and output. Test omitted/conflicting units; do not silently claim a derived unit. Preserve composite event, correct censoring and baseline-only covariates. |
| VCR-A08 | P2 | Earlier hosted captures retained only user/assistant text; TREC22 live transcript fetch failed409 after runtime stopped even though ledger identifies an archived transcript. | Capture permitted persisted run evidence independently from live kernel lifetime; before account deletion preserve artifacts, exact object readbacks and sanitized tool traces. Clearly separate capture failure from product failure. |
| VCR-A09 | P2 | File production, object creation, actual calculation and validation are easy to confuse in the final reader journey. Some native writes are proven, others only claimed. | Show a compact result card with separate statuses and links: data ready, definition saved, computation completed, evidence verified. Keep usable partial files; do not withhold them or add an approval/OA workflow. |

## Matching score and adjudication limits

The12-case batch matched expert eligibility labels5/12 and exact evidence sentence sets7/12. This is diagnostic label agreement, not a population accuracy estimate. All predicted sentence IDs existed. Criterion20's conservative geographic uncertainty differs from an expert convention that used an appended compliance statement;46's missing CT versus documented X-ray is also a conservative/reference distinction.155has the correct eligibility with a sufficient subset of the expert evidence sentences. These must not be lumped together as seven clinical errors.

A single inline re-run of26 preserved unknown with sentence0 and the correct missing-evidence explanation. Its prompt/batch/context changed, and its raw label schema wasunknown rather than the original vocabulary. It is not proof that the failure class is repaired.

TREC21 eligible reference trials ranked1and2 in the supplied6; TREC22 ranked1and4. These are gold-informed diagnostic candidate pools, not full retrieval or an official comparable score. Possible eligibility overstatements and unsupported treatment progression in21 are distinct from agreement with pooled qrels.

## Automation and provenance confound

All model runs used automated=true so test traffic does not teach memory. Current isHumanMessage explicitly excludes automated runs. Empty patient_context candidates and refusal of inline intake therefore do not establish failure for an attended human user. The raw workspace upload also did not itself create a verified source-service patient upload. Prepare evaluator-owned source/snapshot inputs through supported intake rather than weakening provenance or pretending automated messages are human.

The full inline trace does prove native writes: one empty patient collection, one trial/criterion and probe/substantive decisions. Its candidate-trial response has evaluated=[] andsubject_not_found. Thus neither “no native objects” nor “patient matching completed” is justified. Hidden task scopes are intentionally absent from the study list; empty lists and the driver's wrong /api/vcr/home path are not product defects.

## What passed

- Serving direct intake: source registration,upload,confirmedfieldmap and frozen snapshot with80distinctpatients/80subjectrows. The subsequently attempted job lacked requiredsubjectId and was refused before queuing; that is a diagnostic-driver omission, not proof of valid-job failure.
- PhysioNet delivered CSVs: all80sourceIDs/values preserved; age>=65membership52exact; HR4407/78 and missing counts33/7match.200distinctsyntheticrows exported,disjointfromrealIDs and internallyconsistentwithsavedrowarrays. Retained evidence does not independently establish the claimed engine origin of those200rows.
- ACTG local engine withtimeUnit=days: KM at1000days0.6295850234/0.7784062126; RMST827.8806389/913.7144455days; difference85.8338066days. Independentreferenceagreement withinfloatingprecision. InvalidCNSR=2refused. Logranknotproducedbythetestedcomparator and remainsunvalidated.
- Frontend component contracts:123checks in5suites passed after the current locked dependency was installed. This covers home/study/data/frame/version interaction logic, not serving pixels or all browser actions.

## Layout and interaction scope

The built-in browser was attempted repeatedly but page inspection timed out; inventory could see the page title, but neither authenticated layout nor reliable geometry/click acceptance was established. Do not fabricate screenshot or responsive-layout findings. Backend flow, saved artifacts, current component behavior and code were inspected.

Recommended interaction changes derived from actual failures:
1. Put input readiness on the current task:uploadedfile≠mappedsubjecttable≠frozensnapshot. Show the specific missing step and allow the agent to complete supported transformations.
2. In the result area keep real people,observations,events andsyntheticrecords as separate quantities. Avoid a generic“大样本”headline.
3. Make file-only/partial output obvious next to the primary result, with a direct path to the exact saved object when one exists.
4. Present matching decisions with criterion applicability,knownfacts,missingfacts,evidence andnextneededinput; never make unknown look like excluded or eligible.
5. Keep conversation and existing result views; do not add recruitment,contact or seven-step approval screens.

## Next implementation order

First repair evaluator/provenance integration and dataset-to-snapshot binding, then distinct-entity counts/units and narrative consistency, then matching uncertainty/time reasoning and side-effect-free tool discovery. Re-run these exact cases plus counterexamples before scaling to all1015criteria. After those pass, run patient-grouped untouched samples and largerTRECcoverage; do not optimize to this gold-selected12-case pack.

A proper next acceptance requires: supported automated source intake without learning, exact snapshot/cohort/result readback, no fabricated facts/dates, no patient inflation, coherent output denominators, persisted traces after runtime stop, and a small authenticated desktop/mobile visual walk. This audit did not implement those product repairs, run full clinical validation or submit leaderboard results.

## Evidence location

The complete local pack is `.evimed-local/acceptance/vcr-benchmark-20261029/` in this managed worktree. Its README indexes input manifests/checksums, isolated gold, original model artifacts, reviewed scores, source/serving identities and cleanup receipts. Raw data and transcripts are ignored, not committed or published. Local R execution used a read-only source mount and networking disabled. ACTG data stayed local because original data rights remain unresolved.
