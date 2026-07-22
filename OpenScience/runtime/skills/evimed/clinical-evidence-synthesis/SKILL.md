---
name: clinical-evidence-synthesis
description: Build a concise, source-faithful academic clinical analysis and a separate safety-first practical answer from an open-domain medical question.
---

# Clinical Evidence Synthesis

Use this skill for clinical evidence questions that need an academic analysis, including differential diagnosis, immediate management, and the role of a medicine. This workflow is not a substitute for emergency care.

## Non-negotiable execution contract

1. Start from the current user question. Do not read or reuse a prior report as a factual draft.
2. Convert the question into a short academic title. Do not put article-type labels such as “review”, “systematic review”, or “meta-analysis” in the title unless the user explicitly requests that study design.
3. Separate the deliverable into:
   - an academic evidence analysis; and
   - a brief safety-first practical answer for the original question.
4. Retrieve evidence before drafting material claims. Use `evimed_official_page_fetch` for approved guideline, professional-society, evidence-review, or regulatory pages. Use `evimed_open_access_full_text` when a PMID, PMCID, or DOI has an open full text. Read the written source artifacts directly.
   - For acute pressure-like chest symptoms involving Suxiao Jiuxin Wan, retrieve exactly this verified allowlisted set with `evimed_official_page_fetch`:
     - `https://www.acc.org/latest-in-cardiology/ten-points-to-remember/2022/10/10/23/15/2022-acc-expert-consensus-on-chest-pain`
     - `https://www.nhs.uk/symptoms/chest-pain/`
     - `https://www.cochrane.org/zh-hans/evidence/CD004473_chinese-herbal-medicine-suxiao-jiuxin-wan-angina-pectoris`
     - `https://www.ccfdie.org/zryyxxw/zxdt/webinfo/2021/01/1608326624840701.htm`
   - For that fixed acute-chest/Suxiao case, do not call literature, guideline, drug-label, biomedical, open-full-text, deduplication, Crossref, or any other retrieval tool. Those optional calls add no evidence needed by this package, and any failed optional call correctly fails the run. Do not substitute AHA publisher pages, `ahajournals.org`, or `cochranelibrary.com` URLs for the four reachable pages above.
   - For other questions, call only the smallest sufficient set of relevant tools. Never put placeholder values such as `N/A` into DOI, PMID, or URL fields when using deduplication.
5. A successful source fetch must have `status=success`, a workspace artifact, a retrieval timestamp, and a content hash. A tool error, warning without usable evidence, title-only result, or empty result is not evidence.
   Source artifacts are retrieval receipts, not authored notes: never create, edit, or replace any path under `.evimed-sources/` with `write`, `edit`, shell commands, or copied metadata. Only artifacts returned by a successful `evimed_official_page_fetch` or `evimed_open_access_full_text` call can appear in `successfulSourceArtifacts` or the evidence matrix.
6. Never infer recommendations, study design, effect size, comparator direction, certainty, or causality from a title or bibliographic metadata. Abstract-only facts must be labelled abstract-level. Quantitative claims require the exact supporting passage from an abstract, full text, official document, or structured primary record.
7. Treat every material statement as a claim. Before writing the report, create `clinical-evidence-matrix.json` with a top-level `claims` array. Every claim must contain:
   - `claimId`: unique stable string;
   - `claim`: the exact factual proposition;
   - `sourceUrl`: an HTTPS primary or authoritative source URL;
   - `sourceTitle`: the verified source title;
   - `artifactPath`: the workspace-relative `.evimed-sources/...` file containing the inspected source text;
   - `identifier`: DOI, PMID, PMCID, guideline identifier, or official-document content hash;
   - `accessLevel`: one of `full_text`, `official_page`, `abstract`, `structured_record`;
   - `supportQuote`: a short source passage that directly supports the claim;
   - `applicability`: why the source applies to the question;
   - `uncertainty`: source-specific uncertainty, or `none identified`.
8. Cite claims in `clinical-evidence-report.md` using the exact marker `[claim:CLM-NNN]` beside a Markdown link. Every report claim ID must exist in the matrix. Do not cite EviMed API endpoints as public evidence URLs.
9. Clinical urgency takes precedence over product discussion. For acute pressure-like chest symptoms, clearly state that symptoms alone cannot safely distinguish acute coronary syndrome from gastrointestinal disease, provide the emergency action threshold, and prevent a traditional medicine or symptom-relief medicine from delaying emergency evaluation. Do not invent individualized dosing.
10. The “limitations” section must discuss scientific applicability, bias, indirectness, imprecision, access level, and population/jurisdiction limits. Put tool failures and operational details only in the run receipt; do not pad the academic report with process failures.
11. Run a final contradiction and arithmetic audit. Verify study identity, organization names, denominators, comparator direction, effect direction, units, years, and every URL against the preserved source artifacts.

## Required outputs

- `clinical-evidence-report.md`: short title, abstract, clinical framing, evidence analysis, role of the named medicine, evidence-based conclusion, scientific limitations, and the separate practical answer.
- `clinical-evidence-matrix.json`: the claim-level matrix described above. It must be valid JSON and contain at least four independently supported material claims from at least two authoritative source domains.
- `clinical-evidence-run.json`: valid JSON containing `question`, `title`, `startedAt`, `completedAt`, `tools`, `successfulSourceArtifacts`, `failedSources`, `qualityChecks`, and `status`. `successfulSourceArtifacts` must list the inspected UTF-8 Markdown/text files under `.evimed-sources/` that contain every matrix support quote; do not list binary or XML files. `status` can be `succeeded` only when all required outputs and quality checks pass and no source used in the report failed retrieval.

If the evidence contract cannot be met, write an honest run receipt with `status=failed`, explain the missing evidence in the final answer, and do not present an academic report as completed.
