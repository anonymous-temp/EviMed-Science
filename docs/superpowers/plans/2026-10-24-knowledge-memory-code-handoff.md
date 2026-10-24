# Knowledge and memory code handoff

Date: 2026-10-24, Asia/Shanghai.

## Scope and owner decision

The owner requested completion of the approved implementation, local verification and code submission, and explicitly stopped further online deployment and testing. This document records code delivery, not production acceptance. No subsequent iteration is started.

- Branch: `codex/release-knowledge-memory-20261023`.
- Pull request: [#16](https://github.com/anonymous-temp/EviMed-Science/pull/16).
- Tested product revision: `2e161a5fff67312d431f59e593b46dd10d102fe8`.
- Latest main integrated: `7e6bfad7b47f414f57e9c44879ee57936c6f0bff`; its only change after the already integrated main is a progress-log line.
- The final handoff commit changes documentation only. Application, lockfile and test bytes match the tested product revision.

## Implemented behavior

| Area | Resulting behavior |
|---|---|
| Source identity and history | Logical publications retain immutable source versions. Delete/reupload, independent identical notes, A-B-A edits and concurrent publication use revision/generation checks. Historical readers and citations remain addressable and read-only. |
| Source lifecycle and retrieval | Source/library changes publish durable jobs, revoke stale retrieval immediately, and replay dependent page, graph and memory updates. Fair reconciliation includes library-only projects and projects whose last source was deleted. |
| Scope and Compile | Explicitly selected-empty sources remain empty. Native reads validate current file/source/ancestor eligibility. Partial engine synchronization defers Compile rather than claiming all expected inputs were prepared. |
| External Agent Memory API | Native and legacy accounts use their own engines. External native episodes remain pending until explicit confirmation, then use durable idempotent admission. Engine lookup failure does not expose legacy memory; project-bound credentials cannot act on another project's candidates. |
| Capsule integration | The latest main's one-capsule-per-account and account-wide received-pack policy is retained. Native export rechecks captured files, and sharing does not grant access to another account's private memory. |
| Knowledge UI | Scope changes clear stale actionable state; polling recovers; zero-result searches stay empty; removed selections stay removed. Reader/history, graph evidence, graph controls, conflict drafts and prepared unsent conversation references use existing UI and DSH surfaces. |
| Runtime and verification | Native catalogue wire arguments and file-hardlink handling are corrected. The pinned runtime's Zod security backport includes the cowork overlay lock. Evaluation binding distinguishes container init from the actual native server process. |

The final focused code review identified no additional implementation blocker in the source lifecycle, selection scope, native admission or knowledge-reader/graph changes. This is scoped review evidence, not a claim that unexecuted live journeys passed.

## Verification

These groups overlap and must not be summed.

| Check | Evidence and result |
|---|---|
| Complete Linux PUSH CI | [Run 40089690348](https://github.com/anonymous-temp/EviMed-Science/actions/runs/40089690348) succeeded for the exact product revision. Includes Web/API and PostgreSQL checks, types/lint/audits, frontend build, VCR checks, image builds, and isolated hosted-stack/backup/runtime checks. |
| Frontend full local run | 408 files / 5,144 tests passed on the integrated implementation. |
| Source/engine/security regressions | 110 passed. |
| Actual PostgreSQL source/Compile regressions | 70 passed; 12 explicitly Linux-only cases skipped locally. These are not 82 local passes. Linux CI is recorded separately. |
| External memory/capsule regressions | 74 passed, including actual PostgreSQL/admission cases. |
| Final evaluation guards | Repeated locally at handoff: 132 passed, zero failures or skips; no paid model calls. |
| Final release-repair regressions | Runtime controller, security-lock and tombstone-double cases: 40 passed, zero skips. |
| Final static checks | Server and frontend type checks and source credential audit passed. |
| Independent review | Generic, JavaScript, security and database reviews addressed the identified defects; the final focused review found no new product-code blocker. |

Final local commands, from `OpenScience/`:

```sh
pnpm test:knowledge-product
node --test --test-concurrency=1 apps/server/test/runtimeController.test.mjs apps/server/test/runtimeZodSecurity.test.mjs apps/server/test/sourceRegisterRevives.test.mjs
pnpm typecheck:server
pnpm typecheck
pnpm audit:source-secrets
```

Local operator logs remain under `.evimed-local/acceptance/knowledge-integration-20261023/`; credentials and private runtime fixtures are not published.

## Explicitly unexecuted or incomplete live acceptance

- Final candidate DSH/source-reader/graph user journeys and native memory/capsule lifecycle acceptance.
- Shared Compile/recall/chat load measurements and a compatible two-store checkpoint/isolated restore with the final held fixture. CI's isolated PostgreSQL restore is a different check.
- The original official-Wiki C comparison and the 90-question/540-observation product comparison. The original 318-file C corpus and aggregate CNY50 ledger are preserved; earlier pilots and failures are not replacement results.
- Candidate serving replacement, Tencent production activation and post-release user acceptance. The generated image artifact was not imported or activated by this handoff; its local download was interrupted on the owner's instruction.

No retrieval-quality improvement, production readiness or completion of these live checks is asserted. These items require a later owner decision to resume. Preserve original data, native volumes, retained experimental failures and the same budget ledger; do not reset them to manufacture a clean rerun.
