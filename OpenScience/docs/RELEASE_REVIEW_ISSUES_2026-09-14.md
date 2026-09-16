# Release review issue inventory — 2026-09-14

## Scope and release decision

This inventory records known findings and validation limits for the release. It is limited to retained review evidence and is not an exhaustive product audit.

Release revision `f000cf96af5ed4948e3b681b587bb6d6e311e906` is deployed as `evimed-f000cf96af5e-1` and is on GitHub `main`. Public cutover at `https://82.156.128.153` completed on 2026-09-14 at **11:24:45 UTC**. The configured 22-service composition was started, with one-time initialization jobs completing successfully. The production `.env` is mode 0600, and the homepage and API health return HTTP 200 with verified TLS.

At **11:41:28 UTC**, the public `/api/ready` returned **HTTP 200, `ok:true`, with all 24 checks passing**, with TLS verified. The earlier model-receipt problem was resolved through deployment configuration: the receipt was minted at **11:37:32.745 UTC**, and its scheduler is healthy with `consecutiveFailures=0`. No source code change was needed for that correction. The native UI on port 8443 returns HTTP 401 without authentication; this is not an authenticated UI acceptance result.

Final CI run `34822231928` succeeded for `web` and `docker-hosted`; real `hosted-production-e2e` was skipped.

**Important incomplete items:**

- **AUTH-01:** two login attempts with the configured initialization-administrator credentials returned 401; the cause is unknown, and existing passwords were not reset.
- **MEM-02:** legacy-memory migration was not executed. The dry-run found 37 unmapped `unknown_namespace` records; all original rows remain retained.
- **META-01/META-03/MR-01:** the recorded clinical-delivery and data-quality issues remain unresolved; successful deployment/readiness does not certify these outputs.
- **EXT-01/MEM-01:** GEO and OpenViking/DashScope semantic recall remain unconfigured; the deployed memory mode is supported builtin recall over PostgreSQL.
- **UX-01/LEARN-01:** authenticated native production E2E and the complete live learning/cost/window/concurrency validation remain incomplete.

The remaining items are a follow-up backlog, not additional deployment gates. Software deployment does not certify blocked Meta or MR outputs as clinically complete.

Status vocabulary:

- **fixed-in-code** — a reviewed implementation and its recorded checks exist; this alone does not prove final production behavior.
- **live-known-issue** — an actual run or retained artifact demonstrates the issue.
- **unverified** — a remaining validation task, uncertain current state, or potential issue not fully demonstrated.
- **ops-constraint** — a configuration, infrastructure, or operational limitation that remains relevant to the chosen deployment scope.

Evidence is primarily under `/tmp/evimed-release-20260910/`; `/private/tmp/` paths in the receipts refer to the same local evidence area. These are private review artifacts, not public deliverables. `release-state.json` contains accumulated historical entries: its older top-level commit, stage, and blocker fields are not authoritative current deployment status. Dated diagnoses and final deployment receipts establish each observation's scope.

## Inventory overview

| ID | Status | Impact |
| --- | --- | --- |
| META-01 | live-known-issue | A line-ending hyphen causes a valid Japanese RoB quotation to fail grounding and blocks clinical delivery. |
| META-02 | unverified | Potential subsequence-matching false positives have not been demonstrated by dedicated negative tests. |
| META-03 | live-known-issue | Japanese event rates occupy person-time fields; current HR calculation is unaffected, but denominator reuse would be unsafe. |
| META-04 | unverified | Verified source values and fixed-effect synthesis do not establish completed RoB, GRADE, or manuscript acceptance. |
| META-05 | fixed-in-code | Adjustment metadata can be repaired safely; the latest live run did not exercise that branch. |
| MR-01 | live-known-issue | Actual interpretation failed; its precise SDK/provider cause remains unknown, and the new diagnostic-retaining path lacks an observed rerun. |
| MR-02 | fixed-in-code | Empty plots and false-success delivery were repaired; complete live MR acceptance remains pending. |
| EXT-01 | ops-constraint | GEO lacks the real provider endpoint/access configuration; full-tool certification is incomplete. |
| MEM-01 | ops-constraint | Deployment uses supported builtin recall over PostgreSQL; OpenViking/DashScope semantic recall is unconfigured. |
| MEM-02 | decided 2026-09-16: not imported | Read row by row, none of the 68 legacy records is worth carrying: 11 are the brief-as-preference pollution, 2 already exist in the canonical store, 55 are per-run summaries of July–September runs. All rows stay retained and unread. |
| LEARN-01 | unverified | Full live learning, effective costs/budgets, scheduling window, and concurrency are not established. |
| BILL-01 | fixed-in-code | The historical Flash alias pricing omission is repaired in current source; live cost validation is tracked under LEARN-01. |
| UX-01 | unverified | Basic public availability/readiness passed; authenticated native production E2E and all-capability acceptance remain unobserved. |
| AUTH-01 | live-known-issue | Two initialization-administrator login attempts returned 401 despite matching configuration/mount evidence; cause unknown, no password reset. |
| OPS-01 | ops-constraint; deployment verified | f000 is public; final image identities, runtime-model receipt and all 24 public readiness checks passed. |
| OPS-02 | ops-constraint | Final ten images are verified; retired candidate data and pending writes were cleaned within scope, with Docker 29 backing-path observation still unavailable. |
| OPS-03 | ops-constraint; backup verified | PostgreSQL backup, restore and drill cleanup succeeded; the existing timer is enabled, while broader notification and post-migration coverage remain scoped separately. |
| OPS-04 | live-known-issue; resolved operationally | Host direct retrieval completed with one reuse of cached data; duplicate host parts and 17 local payload files were removed after verification. |
| SEC-01 | unverified | Historical credential remediation and dated host-alert follow-up lack confirmed current outcomes. |
| FIX-01 | fixed-in-code | Exact DSH rc.2 pins, shared bootstrap, and hosted method restrictions are present. |
| FIX-02 | fixed-in-code | Durable failed attempts no longer duplicate transient output or mix reasoning into answer text. |
| FIX-03 | fixed-in-code | CI validates dependency references before pulling and retains current OpenList/OpenViking coverage. |
| FIX-04 | fixed-in-code | Canonical extraction schemas and source-bound endpoint proofs preserve raw and negative observations. |
| FIX-05 | fixed-in-code | Observed execution design no longer rewrites admitted eligibility or borrows missing row design from siblings. |
| FIX-06 | fixed-in-code | TA/full-text identity handling preserves conservative unknown-source behavior without blocking justified full-text exclusions solely for missing IDs. |
| FIX-07 | fixed-in-code | Reviewed transport, retirement, and configuration tooling preserves bounded ownership and retained credentials. |

## 1. Meta: source verification, numerical synthesis, and clinical delivery

### META-01 — Result-level RoB rejects an actual sentence because of line-ending hyphenation

**Status: live-known-issue; fix not implemented.**

The latest reviewed managed job, `meta-20260914152928-d620d47a5f6c`, ran from `e18e7a585ee5f2d7114ba6af052ff5684f09bf3b`. Both extraction proofs independently validate as current matches, and the job produced `effect_sizes.json` and `meta_results.json`. Both result-specific RoB assessments actually ran. CREDENCE completed; the Japanese trial's assessment remained `insufficient_information`.

The demonstrated failure is Japan RoB domain 2, “Deviations from intended interventions.” The model quoted `placebo-controlled`; the source has `placebo-` at the end of a line and `controlled` on the next. The current matcher removes the source line-ending hyphen and produces a joined token, while the ordinary compound in the quote remains two tokens. Folding only the observed line break while retaining the hyphen makes the complete source sentence equal to the model's unchanged quote. The matcher accepts the original source excerpt but rejects that model quote. The other four Japanese domain quotations and all five CREDENCE domain quotations passed the current grounding check.

**Impact:** `package/release_decision.json` correctly reports `blocked`, `ready_for_submission=false`, with `pairwise_result_rob_incomplete`. This is a demonstrated layout-matching false negative, not a refusal merely because an assessment says “Some concerns” or because information is unreported. No final manuscript/GRADE/package certification follows from the completed numerical analysis.

**Follow-up backlog:** address observed line-ending hyphenation generically while preserving literal word, numeric, dose, and identifier boundaries; replay unchanged judgments rather than rewriting quotations or ratings.

**Evidence:** `/tmp/evimed-release-20260910/meta-e18e7a58-independent-diagnosis-20260914T080613Z/diagnosis.json` (SHA-256 `33de52a914d2af6442e56a759e67e48ef3e77d6a6d9ba4863dfa1a7086b6945e`). Actual job artifacts are under `OpenScience/evals/capability-audit/workspaces/meta-replication-20260914T072928Z/meta-analysis-runs/meta-20260914152928-d620d47a5f6c/output/20260914_152929_Prespecified_bounded_replication_use_only_the_main/` in the integration checkout, particularly `risk_of_bias/rob_result_source_observations.json`, `rob_result_readiness.json`, and `package/release_decision.json`.

### META-02 — Potential overly permissive subsequence quote matching

**Status: unverified potential issue; no fix or new regression suite implemented.**

`RoBAgent._quote_occurs` searches for ordered tokens while permitting intervening source tokens. This creates a potential false-positive class: a quote could omit a negation or intervening qualification yet retain the searched token order. Dedicated negative-regression evidence is not available, and no additional false-positive clinical certification has been demonstrated.

**Impact:** source grounding may be broader than a literal-fragment contract intends. This concern is distinct from the proven line-wrap false negative.

**Follow-up backlog:** evaluate negation, numeric range, dose, identifier, substring, and unrelated-text controls alongside any future layout fix. Do not solve the layout problem by deleting every hyphen, joining arbitrary words, or relaxing clinical judgments.

**Evidence:** `项目代码/meta/new_meta/agents/rob_agent.py`, `_quote_occurs`, in the reviewed source snapshot.

### META-03 — Event rates were stored in unused person-time fields

**Status: live-known-issue; values and production code not altered.**

The Japanese extraction stores `13.88` and `35.15` in `pyears_intervention` and `pyears_control`, with `person_time_unit=per_1000_person_years`. Table 3 labels these values as event rates per 1,000 patient-years, not cumulative person-time denominators. The generated `quality_notes` explicitly describe their use as “proximity markers,” which does not make that field assignment valid.

**Impact:** the actual HR calculation does not use these fields, and the reviewed HR/CI is correct. Reusing the values as person-time denominators in another analysis would be unsafe. A numerical token matching the source is not sufficient evidence that its quantity type and units were mapped correctly.

**Follow-up backlog:** clarify the generic source-unit contract in extraction/refinement/verifier instructions; distinguish rates from person-time totals and retain unavailable totals as unavailable. Do not calculate or fabricate denominators from these columns, and do not rewrite historical observations in place.

**Evidence:** the META-01 diagnosis; the same job's `extraction/all_extractions.json`, `extraction/extraction_audit.json`, and Japanese Table 3. Both source PDF hashes match the previously independently inspected PDFs.

### META-04 — Numerical success is narrower than completed clinical acceptance

**Status: unverified final clinical delivery, with completed numerical checks.**

The latest run's actual fixed-effect result is HR `0.6483108761544032`, normal 95% CI `0.5262372993916149–0.7987023964778031`, with two studies and DL tau-squared `0`. It matches the independently inspected renal-only source results: CREDENCE HR `0.66 [0.53, 0.81]`, events `153/2202` versus `224/2199`; Japan HR `0.38 [0.12, 1.22]`, events `4/154` versus `10/154`. Cardiovascular-inclusive composites are different outcomes and were not substituted in these selected rows.

The protocol requested a fixed primary model. The independent HKSJ reference interval is approximately `0.18734–2.24353`; it crosses 1 and must not be replaced by the normal interval or described as significant under HKSJ. That reference calculation is not a delivered HKSJ result from the blocked run.

The result-specific RoB path is wired after source verification and selection. It deliberately does not promote study-level draft assessments merely because their quotes occur in the paper. Earlier drafts discussing a trial's own primary endpoint were intermediate, non-releasable projections. The latest targeted assessments ran, but Japan failed grounding as described in META-01.

**Follow-up backlog:** review the eventual result-specific reasoning, GRADE, and final report on their own evidence. Genuine NI/unreported information must be distinguished from an unsupported positive claim; neither a rating nor a supporting quotation should be fabricated to make an assessment complete. Study completion, vital-status ascertainment, and the selected renal endpoint's missingness are not interchangeable. A post-hoc test for another endpoint does not automatically describe the renal HR analysis.

**Evidence:** the latest job's `analysis/meta_results.json`, `analysis/model_decision.json`, source-bound extraction proofs, and the META-01 diagnosis. Prior PDF/reference review: `/tmp/evimed-release-20260910/meta-live-review-20260914T065637Z/phase-review.json`.

### META-05 — Adjustment metadata repair exists, but the latest run did not exercise it

**Status: fixed-in-code; actual repair-path acceptance remains unverified.**

Commit `e18e7a585ee5f2d7114ba6af052ff5684f09bf3b` added the missing generic repair path for `reported_effect_adjusted` and `adjustment_covariates`, strict supplied-value validation, and absent-field preservation. Revised metadata requires a fresh source check; an old positive proof cannot authorize a changed payload. Historical serialized defaults remain compatible. The reviewed change passed 242 focused and 2,601 full offline tests with four skips.

In the latest actual run, both checkers completed on their first attempt with no retained data issues. Both rows retain `reported_effect_adjusted=false` and `adjustment_covariates=[]`. Their model-authored notes deliberately distinguish baseline eGFR stratification from an estimate explicitly labeled adjusted, and the verified conditioning evidence retains the baseline stratification. The initial extraction wire body was not separately retained, so initial JSON field presence cannot be reconstructed from the normalized row alone.

**Impact and follow-up:** do not force coefficient covariates or change the adjustment flag solely to match an earlier expectation. The latest successful source proofs do not demonstrate that the new repair branch was used. Any future exercise should retain the source's actual analytical meaning and the original observations.

**Evidence:** `/tmp/evimed-release-20260910/meta-adjustment-metadata-repair-20260914T071827Z/`; independent approval `/tmp/evimed-release-20260910/meta-adjustment-independent-review-1l9iv_kb/approval.json`; latest extraction notes and verification observations.

## 2. MR: correct failure reporting, unresolved actual interpretation failure

### MR-01 — The actual interpretation failure still lacks its exact SDK/provider cause

**Status: live-known-issue; underlying cause unknown.**

The candidate-28389 run started job `mr-20260914063511-29d9d2d48ac4` and failed with `mr_interpretation_failed`. The prior cleanup removed the diagnostics needed to identify the precise SDK/POST failure. The retained audit-driver failure must not be relabeled as a completed clinical result.

Host and bridge read-only availability requests subsequently returned HTTP 200 with `is_available=true`. Those observations establish availability of that GET path, not successful interpretation POST requests, valid model output, or end-to-end MR delivery.

Commit `f000cf96af5ed4948e3b681b587bb6d6e311e906` adds bounded, sanitized SDK-call observations and allowlisted computational diagnostics before failed-job cleanup. Its independent suites recorded 191 MR tests with eight skips and 71 adapter tests with 19 skips. An observed actual rerun of that diagnostic-retention path remains pending.

**Follow-up backlog:** identify the specific provider, request, response, or environment cause from retained sanitized evidence in a later authorized run. The cause remains unknown until that evidence exists.

**Evidence:** `/tmp/evimed-release-20260910/mr-28389-actual-run.json`; `release-state.json` → `mrActual28389`; `PROGRESS.md`, 2026-09-14 16:04.

### MR-02 — Signed success and nonempty filenames previously concealed invalid deliverables

**Status: fixed-in-code; fresh complete MR acceptance remains unverified.**

Independent review of job `mr-20260913133752-6784ddd035cf` found four zero-page diagnostic PDFs because plot lists were not printed, and interpretation generation had failed although the report/runner claimed success. The signed receipt established provenance, not clinical or artifact quality.

Commit `28389d824e1fa13eca3c53654e807a3a3df41434` repaired plotting/delivery checks, required completed interpretations, retained failed numerical runs as diagnostics, and removed stale skipped plots and unsupported methods claims. Recorded validation included 176 offline tests with two existing skips and ten real R rendering tests. The later actual failure now remains a failure; that is correct behavior, but not a successful MR acceptance result.

**Follow-up backlog:** separate deterministic numerical reproducibility, rendered diagnostic validity, interpretation completion, and clinical/report quality in future acceptance records. Do not sign or expose failed work as successful deliverables.

**Evidence:** `release-state.json` → `mrArtifactAcceptance`, `mrDeliveryFix`, `mrActual28389`; `/tmp/evimed-release-20260910/mr-actual-success-54ab066.json` is the historical provenance receipt, not a corrected acceptance verdict.

## 3. External capabilities and memory deployment scope

### EXT-01 — GEO provider probes remain unconfigured; full-tool certification is incomplete

**Status: ops-constraint.**

The real GEO provider-probe service URL and any required signing/session access have not been supplied. A five-provider question corpus is not proof that those provider frontends were actually queried. The existing capability/tool audit includes stale or pending live evidence; successful unit/contract tests do not certify every capability.

**Impact:** GEO measurement cannot be claimed. The existing optional patent-search exclusion does not cover GEO; audit denominators and certification rules remain unchanged.

**Follow-up backlog:** record genuine operator configuration and observed provider behavior if enabled later. Preserve unavailable results and the current audit definitions.

**Evidence:** `/tmp/evimed-release-20260910/release-cutover-map-v2.txt`; `release-state.json` → `mainIntegration20260914.allChecksExceptLiveCapabilities`; `/tmp/evimed-release-20260910/prepare-host-config-v2/source-freeze.json`.

### MEM-01 — OpenViking/DashScope is not configured; the selected deployment uses supported builtin recall over PostgreSQL memory

**Status: ops-constraint.**

The operator-supplied DashScope key is unavailable. OpenViking embedding/reranking therefore remains unconfigured and unverified. The selected deployment mode uses the supported builtin recall path with canonical PostgreSQL memory, not validated OpenViking semantic recall.

The independently reviewed `prepare-host-config-v2` artifact assumes the OpenViking-enabled preparation path: it requires an actual root-owned private DashScope file before parser-copy/environment preparation, permits absent internal OpenViking key/conf files, and leaves their generation to the final source's configuration script. Its validation covers 18 offline mock cases. That review does not establish vendor credential availability or the host's builtin deployment configuration.

**Follow-up backlog:** if OpenViking is enabled later, retain supplied credential bytes, generate/validate internal configuration from the final source, and observe actual embedding/recall/reranking. Do not generate a fake vendor key or rotate retained credentials to satisfy a check.

**Evidence:** `/tmp/evimed-release-20260910/prepare-host-config-v2/source-freeze.json`; its `independent-review-20260914T075033Z/approval.json`; the deployment map and selected builtin/PostgreSQL deployment scope.

### MEM-02 — Legacy-memory migration has unmapped records and was not executed

**Status: decided 2026-09-16 — not imported, rows retained (see Decision below).**

Upstream main `05cf3914d3c8168dbf2670ff21f265bcf8409676` was integrated through `4900ea3e8c4d08a5de294f92a2cbffa8b2035727`. Canonical research memory now belongs to the control plane's `evimed_memory` PostgreSQL schema. The source removes the retired Memos/MemOS composition and provides the migration and index-publication paths.

The actual migration dry-run covered **2 accounts and 68 records: 31 importable and 37 unmapped with `unknown_namespace`**. It also identified **2 importable notes and 0 quarantined items**. Neither import nor purge was executed. All original records and notes remain retained.

**Impact:** the deployed API and builtin PostgreSQL recall do not establish that historical notes/records have been carried into the new canonical schema. Zero quarantine does not mean zero unresolved attribution.

**Follow-up backlog:** resolve the existing unmapped attribution through the supported migration process without inventing ownership, dropping rows, or assigning data to another account. Record any later import/purge and count/ownership verification separately.

**Decision (2026-09-16): not imported.** The 2026-09-16 review (M6) asked for a decision, and reading the 68 rows on production settled it without touching ownership:

- **11 user-scope `preference` rows** all have the key shape `<kind>.explicit.<16 hex>` that only the extractor's deterministic fallback produced, and all are 1,064–4,000 characters: they are the same whole-task-brief pollution archived in the canonical store the same day (8 still carry the `<evimed-brief>` marker, 3 had it stripped). Importing them would restore exactly what was just removed.
- **2 pending rows** (`profile.work_domain`, `behavior.question_format_pico`) already exist in the canonical store as records of their own.
- **55 project-scope `run_summary` rows** summarize runs from 2026-07-22 to 2026-09-10 under the retired namespaces. The canonical store keeps its own summaries, and since 8996eff4b keeps one per question rather than one per run; importing per-run episodes of old runs would reintroduce the recall pollution M3 removed.

Nothing is purged: the table is retained exactly as it was, read by no code path, and any later deletion is a retention decision to record here separately.

**Evidence:** the deployment migration dry-run recorded in `/tmp/evimed-release-20260910/release-state.json` and the operator's final deployment evidence; `PROGRESS.md`, 2026-09-13 15:05 and 2026-09-14 13:42; deployment-map “Memory migration” section.

## 4. Learning, billing, and product-level validation

### LEARN-01 — Stale learning evidence is handled in code; the complete live learning loop is not established

**Status: fixed-in-code / unverified live behavior.**

The reviewed learning change revalidates inferred candidates against the current owner/project baseline and schedules fresh paired evaluations when evidence is stale. Budget forwarding and the executable test fixture were repaired without changing the production timeout. Recorded validation included 2,274 server passes with 166 conditional skips, package checks, lint/typechecks, and independent review.

**Remaining impact:** configuration and isolated tests do not prove the complete trajectory → candidate → paired evaluation → promotion → mounted use → retirement cycle. Effective cost limits, scheduling clock, requested operating window, and concurrency have not been fully observed in production. The preparation map preserves serial concurrency `1`; this is not proof of the effective running value. The intended China-time 22:00–09:00 window must not be declared active merely from an unverified UTC conversion.

**Follow-up backlog:** capture actual lifecycle and budget/window/concurrency evidence when that work resumes. Do not claim active self-improvement from a configured toggle alone.

**Evidence:** `PROGRESS.md`, 2026-09-14 13:08; `release-state.json` → `finalServerValidation`, `pendingCode.learning`; deployment-map learning notes.

### BILL-01 — Historical Flash alias pricing omission is repaired in current source

**Status: fixed-in-code.**

The historical progress note described `deepseek-flash` responses being unpriced by a catalogue that recognized only the legacy Flash name. Commit `a63a2140286091048391d51ffea4d5caa784f3ea` repaired that omission and is an ancestor of release `f000cf96`. The current `REFERENCE_PRICE_LIST` in `packages/domain/src/metering.mjs` uses version `evimed-reference-2026-09-10` and includes `deepseek-flash`, `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp` explicitly. The prior `evimed-reference-2026-09-05` list remains separately registered for historical billed rows.

**Impact:** the known alias omission is not an unresolved current-source defect. Historical unpriced observations and the old catalogue's deliberate behavior remain distinct from the repaired current catalogue.

**Follow-up backlog:** actual runtime usage, charges, and effective spending-limit behavior remain part of LEARN-01 validation; the source-level alias fix alone does not establish those production outcomes.

**Evidence:** commit `a63a2140286091048391d51ffea4d5caa784f3ea`; current `OpenScience/packages/domain/src/metering.mjs` and `OpenScience/packages/domain/test/pricing.test.mjs`. The bounded source comparison confirms the fix is retained; the earlier `PROGRESS.md` note is historical context.

### UX-01 — Native production interaction and capability coverage remain narrower than CI coverage

**Status: unverified.**

The routed session surface is the native runtime UI embedded through `RuntimeUiFrame`. The control-plane stream decoder review does not demonstrate the native renderer's settlement behavior or all browser journeys. Final CI `34822231928` for `f000cf96` passed `web` and `docker-hosted`, but real `hosted-production-e2e` was skipped. Successful final-source CI therefore does not establish complete native production E2E or every-capability acceptance.

Earlier progress also records that some per-deliverable UI work belonged to an unrouted session surface. Its disposition is a product/UI backlog item; current visibility of those controls in the native surface is not established.

**Follow-up backlog:** disclose the actual production journeys exercised at closeout and retain any skipped/unobserved paths. An accepted deployment must not be described as universal clinical-capability acceptance.

**Evidence:** final CI `34822231928`; `/tmp/evimed-release-20260910/integration-review-adapter-71w70qr5/fix-receipt.json`; existing `PROGRESS.md` UI notes.

### AUTH-01 — Initialization-administrator credentials returned 401

**Status: live-known-issue; exact cause undiagnosed.**

Two public login attempts with the configured initialization-administrator credentials returned **HTTP 401**. The configured username matches the running environment, and the password-file bytes match the actual mounted file. The existing password was not reset.

**Impact:** administrator login acceptance has not passed. These two attempts do not establish that every account or every login path is broken. Public health and all 24 readiness checks passed independently; they do not certify this authentication flow.

**Follow-up backlog:** diagnose the specific administrator authentication failure using retained configuration and account evidence. Do not infer a cause or reset existing credentials from this inventory.

**Evidence:** the two operator-observed public login attempts and configuration/mount comparisons retained with the final f000 deployment record.

## 5. Deployment, data protection, and historical operational risks

### OPS-01 — Public deployment, final image identity, and readiness are verified

**Status: ops-constraint; deployment and readiness completed.**

Revision `f000cf96af5ed4948e3b681b587bb6d6e311e906`, release ID `evimed-f000cf96af5e-1`, was publicly cut over at **11:24:45 UTC on 2026-09-14**. The production `.env` is mode 0600. The configured 22-service composition was started; one-time initialization jobs exited successfully and the runtime image pin remains created without being started. The public homepage and API health returned 200 with TLS verified. Unauthenticated native UI access on port 8443 returned 401.

The final **ten-image** archive's ZIP checksum, OCI data, Docker IDs and content were verified. This is final-release evidence, distinct from the earlier intermediate candidates. Docker 29's `backing_observation_unavailable` remains the specific observation limit described in OPS-02.

The initial model-receipt readiness failure was resolved in deployment configuration. Receipt-file mode was corrected from 0400 to 0600, and the Web, controller and receipt-service overrides were aligned to the same **five skill roots actually shipped in the image**. The unused, ignored legacy `external/ai4s-skills` reference was not applicable. The source code was unchanged. The configured default model is `deepseek-flash`. The retained mint receipt records DSH `0.1.5-rc.2`; it does not retain a separate `reportedModel` field, so the requested model value is not presented as such an observed field. Normal receipt minting succeeded at **11:37:32.745 UTC**; the scheduler is healthy with **zero consecutive failures**.

At **11:41:28 UTC**, public `/api/ready` returned **HTTP 200, `ok:true`, and 24/24 checks passing**, with TLS verified. The model-receipt/readiness problem is therefore resolved, not an outstanding release failure. AUTH-01, MEM-02 and clinical capability limitations remain separately disclosed.

**Evidence:** final CI `34822231928`, main/release revision `f000cf96`, `/tmp/evimed-release-20260910/release-state.json`, and the operator's f000 deployment/image/receipt/public-check records.

### OPS-02 — Scoped retirement completed; Docker backing-path observation remains unavailable

**Status: ops-constraint; recorded cleanup and final image verification completed.**

An earlier serving-host build exhausted the filesystem and caused public 502 responses. Existing bounded import/cleanup procedures distinguish owned artifacts from unrelated services; historical free-space values are not current capacity measurements.

The obsolete candidate-28389 twelve-image set and ZIP have been retired; candidate 54 was retired earlier. Unrelated containers, images and historical evidence were preserved. The prior exact source retirement removed only 8,169 pinned source/duplicate leaves from inactive stages `4fff0cd2ae2d`, `8f94e9b14112` and one duplicate archive, preserving directories, untracked files and modified configurations. Those partial stages are not launchable releases, and MR diagnostic history at `98036fb91f51` remains retained.

Four uncommitted writes left by an old OpenViking pull were canceled through the official containerd [Content.Abort operation](https://github.com/containerd/containerd/blob/v2.2.1/api/services/content/v1/content.proto). This was not deletion of committed blobs, leases or snapshots. The old `open-science-tunnel.service` was also retired, with its configuration backup retained.

The final ten-image set passed the recorded archive/OCI/Docker-ID/content checks. The remaining known inspection limit is Docker 29 **`backing_observation_unavailable`**; it is not evidence that the verified image content is corrupt and is not represented as a successful backing-path observation.

**Follow-up backlog:** retain this observation limit and use the established scoped maintenance procedures. No unrelated cleanup or additional capacity gate is introduced here.

**Evidence:** `/tmp/evimed-release-20260910/obsolete-source-retirement/host-executed.json`; `/tmp/evimed-release-20260910/candidate54-retirement-executed.json`; intermediate candidate receipts; `/tmp/evimed-release-20260910/f000-deploy-artifact-ops/` and final retirement/startup records; `PROGRESS.md`, 2026-09-07 00:43.

### OPS-03 — PostgreSQL backup/restore passed; remaining monitoring coverage is separately scoped

**Status: ops-constraint; backup, restore and cleanup verified.**

The PostgreSQL backup completed at **08:47:27 UTC on 2026-09-14** with **`restoreVerified=true` and `cleanupVerified=true`**. The existing backup timer is enabled; no second scheduler is implied. This protects the retained database state. It does not claim post-migration restoration of rows whose import has not been executed (MEM-02).

Parser-token handoff and monitoring-reader fixes were independently reviewed. The parser retains its UID-1000 mode-0400 token and a separate root-owned mode-0400 Web copy. These preserved credentials are separate from the receipt-file permission/configuration correction completed in OPS-01. The final model-receipt scheduler is healthy and public readiness passed all 24 checks.

**Follow-up backlog:** retain the successful backup/restore record and distinguish it from any later migration verification. Broader notification delivery or monitoring journeys require their own observed evidence; a nonsending check is not a delivered alert. Existing passwords, signing keys and passphrases remain retained.

**Evidence:** the 08:47:27 UTC PostgreSQL backup/restore record and enabled-timer observation in the final deployment evidence; `/tmp/evimed-release-20260910/release-state.json`; prior parser/monitoring review receipts.

### OPS-04 — Local relay was replaced by completed direct host retrieval and cache reuse

**Status: live-known-issue; operational correction completed.**

The initial plan routed an approximately 6.1 GB CI artifact through a local download followed by upload to the host, adding avoidable local bandwidth and temporary storage costs. The final transfer instead reused **1,896,169,472 already-cached bytes once** and downloaded the remainder directly from CI to the host. The complete host package was verified and the final ten images loaded successfully. Duplicate host transfer parts were removed after package verification.

At **11:40:24 UTC**, 17 confirmed duplicate local payload files totaling **1,896,169,472 bytes** were removed after the complete host package and image load had been verified. Source files, receipts, the complete host ZIP and loaded images remain retained. Direct retrieval and cache cleanup are completed outcomes, not pending plans.

**Follow-up backlog:** standardize CI build artifact → direct host retrieval with applicable cache reuse → necessary acceptance → publication. Consolidate findings in the issue inventory rather than expanding gates during investigation.

**Evidence:** `/tmp/evimed-release-20260910/f000-deploy-artifact-ops/local-reused-payload-cache-retired.json`; the final host transfer/load and duplicate-part cleanup records in the same operational evidence area.

### SEC-01 — Historical credentials and dated host alerts are not resolved by a source-only pass

**Status: unverified current exposure/operational state.**

Workspace guidance records historical hardcoded credentials in archived Java source. Removing an archived tree from active tracking does not establish that its prior history, external copies, or credentials were remediated. Current historical-exposure remediation is not established by the available review record. A passing source-secret audit covers its scanned source set, not every historical exposure.

Earlier low-disk and certificate-expiry alerts remain historical observations. Public TLS verification passed during cutover and the 11:41:28 UTC readiness check. Those successful checks establish present certificate validation at the observed times, not an independently measured future renewal schedule; old alert values must not be presented as current.

**Follow-up backlog:** track any outstanding historical credential remediation and the operator's actual TLS/monitoring closeout separately. Preserve existing credential bytes during the authorized deployment unless a distinct remediation action is authorized.

**Evidence:** workspace `AGENTS.md` security notes; `PROGRESS.md` historical host-alert entries; `release-state.json` → `finalReview.sourceSecretAudit`.

## 6. Major root-cause groups already repaired in the reviewed source

These entries explain why earlier failed runs must remain in history even where the implementation has since changed. They are not claims that every live capability now succeeds.

| Group | Status and implemented correction | Recorded evidence and remaining limit |
| --- | --- | --- |
| FIX-01 — DSH pin and runtime bootstrap | **fixed-in-code.** The integrated source retains the actual `0.1.5-rc.2` pin and exact package closure; provider-disabled initialization no longer skips shared browser credentials/profile/MCP setup. Pin inventory distinguishes live pins from provenance/history, and unsafe newly exposed host/file methods are denied by the hosted boundary. | `4900ea3e8c4d08a5de294f92a2cbffa8b2035727`; `mainIntegration20260914`, `runtimeBootstrapFinding`; `/tmp/evimed-release-20260910/rc2-config-capture-agent/final-capture-receipt.json`. The recorded local closure has 231 exact packages with zero drift; final image verification and successful runtime-model receipt/readiness are recorded in OPS-01. |
| FIX-02 — DSH transient versus durable assistant events | **fixed-in-code.** Failed persisted attempts settle as existing `message/assistant` events with separate text/reasoning and `interrupted=true`; they no longer append a second mixed delta stream. Native transient deltas retain attempt/index identity and reconnect handling. | Independent adapter/EventPump review passed 60 tests, targeted lint and source hashes; `/tmp/evimed-release-20260910/integration-review-adapter-71w70qr5/fix-receipt.json`. This covers control-plane decoding, not an unobserved native UI rendering result. |
| FIX-03 — CI dependency producer failure | **fixed-in-code.** Retired Ollama references were replaced by pinned OpenViking while preserving OpenList. A checked Node command validates/writes all dependency references before the first pull; redirected input replaces process substitution that swallowed a failed producer. Existing capacity floors, timeouts and checked waits remain. | CI `34811633433` had passed Web/image builds before failing manifest inspection. Independent 15-test shell/Docker-spy review: `/tmp/evimed-release-20260910/ci-diagnosis-34811633433/independent-review-20260914T064649Z/approval.json`. Final CI `34822231928` passed for release `f000cf96`; real hosted-production E2E was skipped. |
| FIX-04 — Canonical extraction types and source-bound clinical proof | **fixed-in-code.** New generation/correction uses closed outcome/design vocabularies while legacy rows remain replayable. V3 selected-result/component membership binds quotations to the correct endpoint; raw observations, negative judgments and incomplete histories survive retries. Empty/failed extraction no longer counts as a completed usable extraction. | `197f15ee89894c37d9aea031f88c8dbfd6fb1af1`, `36f99b6c397f575229f9fce96206e13795ce00a0`, `1cc3be8421398d75b4c94ca7988e9d7e72c68e0f`; `/tmp/evimed-release-20260910/meta-two-pdf-diagnostic/inputs-ea356-20260913/fresh-output/diagnostic-summary.json`. The latest actual proofs pass, but META-03 shows why an unused quantity field still needs semantic scrutiny. |
| FIX-05 — Admitted eligibility versus observed execution design | **fixed-in-code.** Reconciliation no longer rewrites protocol eligibility or invalidates its scope receipt merely because observed studies form a subset. Current extractions select the method plan; typed complex dependencies and unknown computable rows remain visible. Blank primary rows cannot borrow a sibling's design; zero-computable evidence-gap diagnostics remain available. | `/tmp/evimed-release-20260910/meta-eligibility-fix/producer-contract-v2/source-freeze.json`; independent approval under `independent-review-20260914T053127Z/`; 2,551 full offline passes with four skips. Historical raw descriptive design outputs were diagnosed, not silently turned into a new canonical assessment. |
| FIX-06 — Title/abstract and full-text identity handling | **fixed-in-code.** TA responses receive the complete identity item schema and remain conservative when unresolved. Full-text exclusion on an independently supported non-identity basis can retain a missing identifier as unresolved metadata; inclusion, identity-based exclusion, uncertain judgments, abstract fallback and metadata-only sources remain protected. | `ea356467b2a4c118e284204fe1f5552d577bcfc7`; integration repair `c38ea1d993a185612ed318c25fffbc87942ef9ce`; `/tmp/evimed-release-20260910/meta-screening-missing-id-fix-20260914T060839Z/v3/independent-review-20260914T062814Z/approval.json`. All eight saved judgments replayed unchanged; 2,582 full offline passes with four skips. |
| META-05 — Source-backed adjustment metadata repair | **fixed-in-code.** Two previously non-refinable analysis fields can now be repaired from the source with strict supplied-value types; omitted fields do not become explicit empty lists, and changed payloads cannot reuse old positive proofs. | `e18e7a585ee5f2d7114ba6af052ff5684f09bf3b`; 2,601 full offline passes with four skips; evidence in META-05. The latest live run did not invoke this repair branch. |
| MR-02 — MR plotting, failure delivery and diagnostic retention | **fixed-in-code.** Rendered pages and completed interpretation are required for success; failed diagnostics remain distinct from public deliverables, and signing remains success-only. Bounded diagnostic retention now preserves the otherwise-lost failure context. | `28389d824e1fa13eca3c53654e807a3a3df41434`, `f000cf96af5ed4948e3b681b587bb6d6e311e906`; MR-01/MR-02 evidence. The exact latest interpretation failure remains unknown without an observed diagnostic-retaining run. |
| LEARN-01 — Learning baseline freshness and forwarding | **fixed-in-code.** Stale inferred-candidate evidence is revalidated/re-evaluated against the current baseline, and relevant budget settings reach their consumers. | `PROGRESS.md`, 2026-09-14 13:08; 2,274 server passes with 166 conditional skips and independent review. End-to-end live learning and effective cost/window/concurrency remain LEARN-01 backlog. |
| FIX-07 — Release transport, source retirement and private configuration preparation | **fixed-in-code / selected operational steps verified.** Reviewed tooling preserves pinned content identities, bounded ownership, existing credentials and unrelated services; parser-copy logic remains byte-identical in the new preparation artifact. | Existing transfer/load/retirement receipts and `/tmp/evimed-release-20260910/prepare-host-config-v2/independent-review-20260914T075033Z/approval.json`. Final f000 transfer, retirement, startup and readiness results are recorded in OPS-01–OPS-04; missing external configuration remains separate. |

## Closeout note

Release `f000cf96` is public, with successful final-source CI, verified final images and TLS, a healthy runtime-model receipt scheduler, and 24/24 public readiness checks passing. Administrator login verification, legacy-memory migration and the listed clinical/capability validation limits remain incomplete. These disclosed items form the follow-up backlog; blocked specialist outputs are not certified clinical deliverables.
