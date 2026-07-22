---
name: clinical-evidence-synthesis
description: Build a concise, source-faithful academic clinical analysis and a separate safety-first practical answer from an open-domain medical question.
---

# Clinical Evidence Synthesis

Use this skill for clinical evidence questions that need an academic analysis, including differential diagnosis, immediate management, and the role of a medicine. This workflow is not a substitute for emergency care.

## Non-negotiable execution contract

1. Start from the current user question. Do not read or reuse a prior report as a factual draft.
2. Convert the question into a short academic title of at most 40 characters. Prefer a direct title such as `压迫性胸部不适与速效救心丸的处置边界`; do not append phrases such as “基于多源证据的分析”. Do not put article-type labels such as “review”, “systematic review”, or “meta-analysis” in the title unless the user explicitly requests that study design.
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
   - `supportQuote`: a verbatim source passage that directly supports the complete claim; normally quote at least 20 characters, but a shorter complete official field such as a labelled review date is acceptable. Preserve the source's wording and punctuation; never join non-contiguous passages with an ellipsis;
   - `applicability`: why the source applies to the question;
   - `uncertainty`: source-specific uncertainty, or `none identified`.
8. Cite claims in `clinical-evidence-report.md` using the exact marker `[claim:CLM-NNN]` beside a Markdown link. Each marker contains exactly one ID; write `[claim:CLM-001] [claim:CLM-002]`, never `[claim:CLM-001, CLM-002]`. Every factual sentence must stay within the exact proposition of its cited matrix claim. If a sentence adds a sample size, study count, date, deadline, timing threshold, indication, contraindication, recommendation, or causal interpretation, create a separate claim with its own direct quote. Never reuse a broad marker to cover new facts. Do not cite EviMed API endpoints as public evidence URLs.
   Avoid stronger wording than the source. Do not change “similar” to “identical”, “seek urgent care” to “the only safe strategy”, “supports” to “proves”, or an evidence limitation to “directly refutes”. Qualify a synthesis as an inference when it combines more than one claim.
9. Clinical urgency takes precedence over product discussion. For acute pressure-like chest symptoms, clearly state that symptoms alone cannot safely distinguish acute coronary syndrome from gastrointestinal disease, provide the emergency action threshold, and prevent a traditional medicine or symptom-relief medicine from delaying emergency evaluation. Do not describe symptom response to Suxiao Jiuxin Wan as a diagnostic test. If a person already has a clinician-issued emergency plan, say to follow that plan while calling emergency services; do not invent individualized dosing or tell every patient categorically to start or stop a medicine.
   A regulatory label revision proves that safety information required revision; it does not by itself prove a specific serious adverse reaction or refute an older trial review. Describe the regulator's action at its actual evidentiary scope.
   In the practical section, write the explicit sentence `不得因服用速效救心丸而延误呼救或急诊评估。` Cite its supporting emergency-triage and medicine-scope claims. Do not make diagnostic claims from symptom response to any medicine, including Suxiao Jiuxin Wan, antacids, or nitroglycerin.
10. The “limitations” section must discuss scientific applicability, bias, indirectness, imprecision, evidence form, evidence age, and population/jurisdiction limits. Describe an ACC key-points page as summary-level evidence that does not expose full recommendation grading; do not say the full text was inaccessible or unavailable. Never mention runtime behavior, tools, allowlists, scraping, fetching, saved artifacts, inaccessible pages, failed searches, or the EviMed execution contract in the academic report. Put those operational details only in the run receipt.
11. Run a final contradiction and arithmetic audit. Verify study identity, organization names, denominators, comparator direction, effect direction, units, years, and every URL against the preserved source artifacts.
12. For the fixed acute-chest/Suxiao case, keep the academic report between roughly 2,500 and 5,000 Chinese characters and use only these sections: `摘要`, `临床问题`, `证据结果`, `综合判断`, `科学局限`, `安全优先的实际处置`, and `参考来源`. Do not add unsupported emergency details such as a 10-minute ECG target, self-driving advice, aspirin, body position, antacid-response claims, nitroglycerin instructions, medicine contraindications, or label indications unless the retrieved source contains a direct quote and the matrix has a dedicated claim. Every numbered practical-action item must contain at least one applicable claim marker. Likewise, do not report page-review dates, trial counts, participant counts, derived “years since” values, regulatory deadlines, or “no evidence exists” assertions without a dedicated claim and exact supporting passage. Do not call symptom patterns “completely identical” or describe any recommendation as the “only safe strategy”.
13. Write valid JSON directly with the `write` tool, then read the files back. Inside JSON string values, escape ASCII double quotes or use Chinese quotation marks. Do not call Bash, Python, a JSON parser, or any shell command to create, repair, or self-audit the three deliverables; a shell error fails the run.

## Required outputs

- `clinical-evidence-report.md`: short title, abstract, clinical framing, evidence analysis, role of the named medicine, evidence-based conclusion, scientific limitations, and the separate practical answer.
- `clinical-evidence-matrix.json`: the claim-level matrix described above. It must be valid JSON and contain at least four independently supported material claims from at least two authoritative source domains.
- `clinical-evidence-run.json`: valid JSON containing `question`, `title`, `startedAt`, `completedAt`, `tools`, `successfulSourceArtifacts`, `failedSources`, `qualityChecks`, and `status`. The schema is strict:
  - `successfulSourceArtifacts` is an array of path strings only, for example `[".evimed-sources/official-pages/abc/page.md"]`. Never put objects, titles, URLs, hashes, or explanations in this array.
  - `qualityChecks` is an object with at least three boolean values, for example `{"claimTraceability": true, "sourceQuoteMatch": true, "contradictionAudit": true, "arithmeticAudit": true}`. Never use nested `{status, detail}` objects here.
  - `failedSources` is an array; use `[]` when all required retrievals succeeded.
  - `status` is exactly `"succeeded"` only when all required outputs and boolean quality checks pass and no source used in the report failed retrieval.
  - The inspected UTF-8 Markdown/text paths under `.evimed-sources/` must contain every matrix support quote; never list binary or XML files.

If the evidence contract cannot be met, write an honest run receipt with `status=failed`, explain the missing evidence in the final answer, and do not present an academic report as completed.
