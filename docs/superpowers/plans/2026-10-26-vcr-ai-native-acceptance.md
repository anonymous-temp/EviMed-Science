# VCR AI-native reset: local acceptance

> Historical first-round record. The [PR 17 remediation record](2026-10-26-vcr-pr17-review-remediation.md) supersedes its readiness conclusions, including the original continuation and numerical-test claims. This file is retained as provenance.

Date: 2026-10-26. Base: `1aa0f7c3f`. Branch: `codex/vcr-ai-native-reset-20261025`.
Scope: implementation, local verification and GitHub handoff. No deployment or serving-database operation.

## Delivered product contract

The module is a first-level research workspace above GEO. Four conversation starters replace method selection and compulsory programme startup. Six result destinations remain: overview, matching, population/patients, comparator, trial and evidence/data. Historical calculations remain readable in a separate disclosure; the ordinary Research Tools catalogue no longer offers VCR calculator creation. A complete programme remains available only when requested.

| Task | Product value | Data needed before execution |
| --- | --- | --- |
| Patient matching | Evidence-backed eligibility in either direction, preserving unknowns | One original human case message or owned upload; batch matching needs an authorized patient dataset. Trial criteria come from a provided protocol or an actually read registry record. |
| Virtual cohort | Select an observed population or generate an explicitly synthetic population | Observed selection requires patient data. Literature/scenario populations can begin with preserved published parameters or declared assumptions. |
| Virtual patient | Inspect a member and its complete observations, generate trajectories or apply a scoped prediction | Generated members need a population/scenario; individual prediction additionally needs an executable model and its required predictors, units and horizon. |
| Synthetic/external comparator | Distinguish observed external controls, literature benchmarks, prognostic adjustment, borrowing and descriptive prediction benchmarks | Treatment-effect estimation needs comparable exposure/outcome/time-zero/covariate data. A predicted benchmark supplies neither observed controls nor causal identification. |
| Virtual trial | Compare study designs, precision, power/assurance and full-study duration | Can start from source-backed parameters or explicit assumptions. Individual data are needed for empirical calibration/validation, not every design calculation. |

Cohort and patient views share a workspace because they describe population and individual scales of the same research. Comparator and trial design remain separate scientific questions. Pre-enrolment information plus exit/post-trial care never fills hidden trial-internal treatment or outcomes.

Recruitment OA was removed: contact/referral writers, site CRM, recruiter/site permissions, coordinator notifications and operational forecast feedback. Scientific longitudinal observations, protocol schedules, matching rechecks, dropout/accrual assumptions and historical results remain. The three approved OA tables have an explicit archive/restore-verified retirement utility, not startup deletion. Production retirement has **not** run: old serving writers must first be stopped and fenced during a separately scheduled rollout.

## Implementation and scientific scope

- Authenticated native invocation proof binds each tool to its actual account/project/root conversation. Original messages and owned files become patient sources; model-authored prose is refused as original clinical observation. Independent conversations do not adopt a newest or sole study.
- Durable completion records return finished or failed computations to the originating conversation without specialist rebinding. Local matching and engine work have separate bounded scheduling. Current-run reply checks use saved native turn/request identities, not retained session history. Mixed or incomplete provenance remains ungraded.
- Literature evidence preserves source generation/hash, quote spans and literal units. Only bound baseline evidence invalidates its consumers. Unknown eligibility remains unknown; withdrawn sources and hidden treatment windows cannot reappear through paraphrase.
- Individual records count people separately from visits and preserve complete ordered observations. Stable member identity and explicit pairing coexist with independent replicate streams. Generated/predicted/reconstructed rows do not increase real N.
- `model.survival_fit` and `model.prognostic_apply` execute supported, source-bound methods. Exponential/Weibull control-design adapters preserve source condition/arm; lognormal/loglogistic fits retain curves without silent approximation. Typed linear/logistic/Cox equations never evaluate source code. Missing baseline risk or residual variance limits what may be predicted.
- Exact model result/version and parameter-quantile references connect supported models to design comparisons. Quantile sensitivity is not assurance or patient outcome percentiles. Treatment-effect assumptions remain separate.

## Design and browser verification

Applied the official [huashu-design 3.0 guidance](https://github.com/alchaincyf/huashu-design/blob/master/SKILL.md) and [Impeccable guidance](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/SKILL.md) as an existing-product Operate/Read refinement. Existing EviMed tokens, native composer and frame remain authoritative. No extra prototype-selection approval or new visual identity was introduced.

The task list separates action, purpose and data requirement. Result changes return to the existing conversation with exact identities. Empty and unavailable states stay actionable. Local synthetic fixture walks covered 30 base/history views and four individual variants, with zero findings and zero violations in 17 accessibility scans. Independent Chromium interaction regressions passed 36/36.

The in-app browser additionally exercised the freshly built local app on an isolated PostgreSQL fixture: task entry, the six-result selector, population/individual switching, a patient drawer, history separation and absence of VCR calculator entries in Research Tools. At 1512 and 390 px the document had no horizontal overflow. The fixture intentionally has no live native frame, so its unavailable runtime state is **not** evidence of a working model; live execution is recorded separately below.

## Local test evidence

| Gate | Result |
| --- | --- |
| Full web suite, latest fixtures | 5,211 passed in 417 files |
| VCR server unit collection | 1,060 passed with owned PostgreSQL, no skips |
| VCR PostgreSQL | 49 isolated files: 432 passed, one Docker-context probe skipped; separate required-mode ModelScience 2/2 and final model/replay/native/Workbench follow-ups passed |
| Domain | 1,283 passed |
| Harness port | 376 passed, nine optional environment probes skipped |
| Socket | 299 passed |
| Contracts | 69 passed, five optional external probes skipped |
| Research MCP, isolated Python 3.12 environment | 992 passed, two skipped |
| Memory MCP | 13 passed |
| Source-model/design scientific scope | 255 JavaScript checks plus three generated-help checks; 118 PostgreSQL checks; 30 host-R numerical cases; 34 method references checked |
| Host-R protocol parity | 13 cases passed; 321 core and 51 extension job shapes matched JavaScript validation with zero disagreements |
| Archive/retirement | Seven PostgreSQL cases, including exact high-precision JSON text and a short-lived concurrent writer |
| Build and static checks | Web build, all package/server/web types, lint and source-secret/generated-source checks passed; web retains 15 existing lint warnings |

After the final scientific correction, 29 focused PostgreSQL cases, three actual-R replay cases, 18 R numerical cases, 14 MCP cases and 846 affected web tests passed; regenerated golden fixtures passed 17/17 both while writing and independently reading. Earlier broad-platform results are preserved, not overwritten by focused successes: the macOS whole-server attempt recorded 11,129 tests, 10,759 passes, 227 failures and 143 skips before VCR remediation. Failures included macOS/Linux assumptions, local dependency/resource gaps, unrelated subsystem failures and the VCR defects subsequently fixed. It is **not** a passing whole-platform gate. Linux CI is a separate check.

## Actual native execution

A local control plane and the pinned DSH kernel used the real configured model on synthetic material. Host launch replaced Docker launch for this probe; authentication, tool gateways, persisted runs and receipts used product code. This is not a production-container qualification.

The matching probe `run_0570977e44353abeda74079c648eced9` completed in ordinary `open-domain-answer` conversation without a study/PICO form. The final answer matched all four supplied criteria: three satisfied and the absent myocardial-infarction history unknown, with overall insufficient evidence. It used 25 tools, saved the original message and did not contact anybody. The preceding timed-out attempt is retained: repeated schema/terminology metadata obscured judgments. Default matching reads now prioritize results; full contracts/terminology and one criterion can be read explicitly. The successful rerun validates this correction for this case, not general clinical accuracy.

An initial aggregate probe against the unchanged Linux engine service on macOS failed because `resource.prlimit` and `os.waitid` are unavailable. Resource limits were not disabled. This failed run is not numerical-execution proof. A minimal local Linux R 4.3.3 service subsequently executed the authenticated HTTP path with signed output; the complete pinned production image remains blocked by the configured CRAN snapshot endpoint. Neither host R 4.6 evidence nor this deliberately minimal local container qualifies the full production dependency lock.

## Review and operational limits

Independent specification, TypeScript/JavaScript, scientific/clinical and security reviews covered the changed scopes. Corrections included lossless archive verification, source-lock ordering, result ownership, model/source unit fidelity, current-run attribution, exact reconstruction binding and required-mode test enforcement. Approval of code is not clinical validation.

No real customer data, production migration, deployment, live contact or regulator submission was performed. Full production-container validation, cross-node load/recovery, real partner-cohort clinical validation and deployed user acceptance remain separate gates. No competitor's regulatory status, accuracy or patient reduction is claimed for this implementation.

### Corrections found by actual native execution

The first Linux aggregate answer revealed an existing independent-rounding inconsistency: 90.419 patients per arm became 91 per arm but 181 total. `design.analytic` 1.2 now rounds each arm and sums those integers (91 + 91 = 182), preserves the old 1.0/1.1 behavior for historical jobs, and reports requested versus integer allocation. Unequal-allocation curves and sensitivity calculations use the same rounding policy. A receipt-verified computation basis reaches the saved result and tool status; forged adapter metadata is ignored. The sizing formula is normal approximation; the continuous power check is noncentral pooled-t power. At 91 per arm its checked power is approximately 0.798306, so 182 must not be described as exact-t sizing achieving at least 80%.

The first live completion dispatch also exposed a 79-character identifier exceeding the ledger's 64-character limit. New identifiers use a deterministic 47-character base, retain the full fingerprint, and fit even the largest supported retry suffix. Authenticated legacy pending identifiers are repaired before any runtime start. A real reconciliation-to-dispatch regression verifies one delivery at both default and maximum retry generations, with no duplicate restart/prompt.

Native result and completion acceptance is bounded to the synthetic probes described here. No full native-control ablation or production workload comparison was performed.

### Final cold native calculation and continuation

On the final frozen numerical code, root run `run_56d7769877fb4237fbb6625040081101` succeeded in ordinary conversation with 12 tool calls. The real authenticated Linux R 4.3.3 service returned `design.analytic` 1.2 with 91 treatment, 91 control and 182 total, plus normal-approximation sizing and the separate pooled-t power check. The reply distinguished this from its separately executed exact-t calculation (92 per arm, 184 total), rather than attributing 184 to the analytic engine. This additional model-written script is not a newly qualified platform method.

Automated continuation `run_01ed6f750d86994a533b7355bdd8d591` then succeeded in the **same** originating session and remained `open-domain-answer`. The test waited for continuation settlement before stopping its kernel. No `invalid_id` loop occurred. This verifies actual tool execution, persisted results and same-conversation return for the tested synthetic calculation; it is not a clinical-accuracy benchmark or full production-image acceptance.

The final two review addenda (strict equal-allocation alias and response field order) were approved independently. There are no unresolved review findings in the delivered scope. The GitHub branch is for review and has no deployment marker or production migration.

## Integration with concurrent main changes

Before final handoff, main advanced to `1a799c2db` with the separately developed Frontier round 3. That revision was merged into the VCR branch. Only the progress record and a generated tool graph conflicted; both product histories were retained and the graph was regenerated. Shared server/MCP/native-frame/domain bindings passed independent review with no findings. Incoming byte-preserved XML fixtures were not reformatted.

The merged tree passed 5,284 web tests (422 files), 1,311 domain tests, 377 port tests (nine optional skips), 299 socket tests, 649 shared-server checks (eight explicit environment skips), 999 research MCP tests (two skips), 29 PostgreSQL checks, all five typechecks and lint. Actual Chromium checks ran in the shared-server selection. These passes do not erase the separately documented broad-platform diagnostic failures or establish production acceptance. The handoff remains draft PR #17, not a merge to main or a deployment.
