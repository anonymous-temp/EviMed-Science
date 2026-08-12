---
name: clinical-evidence-synthesis
description: Produce a publication-grade, deeply researched clinical evidence analysis with reproducible searches, verified citations, claim-level traceability, and a separate safety-first practical answer.
---

# Clinical Evidence Synthesis

Use this skill for open-domain clinical questions that require an academic evidence analysis. It does not replace emergency care or individualized diagnosis.

## Required skill stack

Load these skills before retrieving evidence:

1. `deep-research`
2. `biomedical-database-search`
3. `citation-integrity`
4. `clinical-evidence-synthesis`

Do not claim completion if any required skill fails to load.

## Academic scope

1. Start from the current question. Do not reuse a prior report as a factual draft.
2. Convert the question into a concise, direct academic title and honor any title-length preference in the request.
3. Do not put `综述`, `系统评价`, `meta分析`, `review`, or another article-type label in the title unless the user explicitly requests that design.
4. Write a publication-grade evidence analysis, not an expanded chat answer. Let the question and usable evidence determine length; do not pad the report or repeat conclusions to meet a quota.
5. Keep the safety-first practical answer separate and concise. Clinical urgency takes precedence over product discussion.
6. **The request is an input, not a template.** Take the clinical question out of it and leave the rest behind — its headings, its checklists, its metrics, its expected answer, its vocabulary. A request written as an acceptance specification is still answered with a manuscript; see "Register: what a manuscript never says".

### Never carry a record number out of the data

When the analysis is over a dataset the user supplied, subjects are referred to
by pseudonyms **you assign** — P1, P2, P3 in a stable order — and never by a
value copied from the file. Prefixing a hospital number with a letter does not
de-identify it: `P90000001` reads like a pseudonym and is one of the source
`PATIENT_ID`s. The same holds for case numbers, medical record numbers,
admission numbers, dates of birth, and names.

A production run wrote five real `PATIENT_ID`s through its report and evidence
matrix this way. Nobody reading the report could tell, and the people exposed
were not the reader.

Identifiers of *sources* — PMID, PMC, DOI, NCT, Cochrane CD numbers — are
citations and belong in the report as they are.

### Argue a thesis; do not answer a questionnaire

A report that poses sub-questions, searches each, and returns a verdict on each is not analysis — it is a lookup table with citations. These questions are chosen because they sit at an edge of what is known, and an edge is where the work is.

State the bottom line first, then make the case for it: establish what the answer depends on, and push on each of those dependencies with everything available. The reader should be able to see the argument being built, and see which load-bearing piece is weakest.

Those dependencies are your working, not your outline. They decide which searches you run and which findings matter; they are never printed as a section heading, a lettered list of propositions, or a pass/fail verdict. In the manuscript they appear twice, dissolved: as the evidence appraisal criteria in `资料与方法`, and as the reasoning in `结果` and `讨论`. See "Required report structure" and "Register: what a manuscript never says".

**Absence of direct evidence is where the analysis begins, not where it ends.** "No study was found" is a finding about the literature, not an answer to the question. Having established it, you owe the reader the best defensible answer the evidence still permits, reached by whichever of these apply:

- **Mechanism** — physical, chemical, or pharmacological reasoning from measured constants toward the direction, and where possible the magnitude, of the effect;
- **Quantitative bounding** — take the constants you retrieved and compute. A vapour pressure and a sealed-system loss curve constrain an opened-container loss; a half-life and a dosing interval constrain accumulation; a sensitivity and a prevalence constrain post-test probability. An order-of-magnitude estimate with stated assumptions beats a refusal to estimate;
- **Analogy** — a comparable agent, formulation, or system where the evidence does exist, with the differences that limit the transfer stated explicitly;
- **Adjacent-population extrapolation** — with the indirectness named and its direction of bias argued;
- **Converse and negative evidence** — what would already have been observed if the proposition were false, and whether it has been;
- **Triangulation** — where two or more independent angles agree, say so and say why that agreement is or is not informative; where they conflict, adjudicate rather than list.

Close by saying what evidence would settle the question — the study, measurement, or dataset that would convert the estimate into a finding. A question worth asking deserves a stated path to answering it.

None of this licenses assertion beyond the evidence. It requires the opposite: every step above must be recorded as a derived claim (see "Derived results"), which makes the reasoning auditable and marks it in the report as reasoning rather than measurement.

## Deep-research protocol

### Question decomposition

Decompose the question into the evidence domains it actually needs. Derive them from the question in front of you — a stability question needs formulation and physical chemistry, a diagnostic question needs test performance and prevalence, a policy question needs jurisdiction and health-system context. Domains that recur across clinical questions:

- the phenotype or exposure in question, and what it is distinguished from;
- the decision the answer feeds, and what makes that decision time-sensitive or reversible;
- how the relevant quantity is measured, and the performance limits of that measurement;
- competing explanations, and the limits of discriminating between them;
- when a medicine, device, or intervention is named: efficacy, safety, indication, regulatory scope, and the population actually studied.

Do not carry a previous question's domains into this one. If the question is about drug stability, ECG and troponin are not its domains; if it is about triage, formulation chemistry is not.

### Reproducible search

Search iteratively across at least two relevant source classes. Use English and Chinese synonyms when relevant. Continue until every material section has usable evidence and further query variation is no longer changing the conclusion; do not stop because a numeric query target was reached.

Record each completed search in `clinical-evidence-search.json` immediately after
the search succeeds. The JSON must exactly match successful search-tool calls
from the current run. Planned, duplicate, or failed searches do not count.

One log entry per call, and copy the query string verbatim from the call you
made. A single search that reached several underlying databases is still one
search: name the source class in `database` if that is clearer, but do not split
it into an entry per database, and do not paraphrase or shorten the query. An
entry whose query you never sent claims a search that did not happen.

For an acute pressure-like chest symptom question, adapt the queries to examine
urgent cardiovascular triage, diagnostic pathways, limits of symptom-based
discrimination, relevant non-cardiac causes, population differences, current
guidance, and any named medicine's indication, efficacy, safety, and regulatory
scope. Combine or split concepts according to the results rather than following
a fixed query list.

**A query that returns nothing has failed; it has not answered anything.** Long
conjunctive queries are the usual cause — seven concepts joined together match no
record even when the literature on the question is substantial. Before writing
that evidence on a point is absent:

1. Re-run the concept with at least two shorter queries, phrased the way a paper
   on that question would be titled, and drop the qualifiers rather than the
   subject.
2. Search a second source class, not only the one that came back empty.
3. Only after those come back empty may you write that you did not retrieve
   evidence — and write exactly that. **Never write that a study, trial, or body
   of evidence does not exist.** Your searches bound what you found; they do not
   bound what exists.

This is not a style preference. A report once stated that no prospective study
had examined the diagnostic value of symptom relief after sublingual
nitroglycerin. One exists, it is the central study on the question, and a
seven-concept query had returned zero records; two shorter queries return it as
the first hit.

Use `evimed_literature_search`, `evimed_guideline_search`, and selected audited sources from `evimed_data_source_catalog` or `evimed_biomedical_source_search`. Deduplicate candidate records with `evimed_evidence_deduplicate`.

When calling `evimed_evidence_deduplicate`, omit absent identifier keys instead of sending empty `doi`, `pmid`, `pmcid`, or URL strings. If input validation fails, correct the full batch and obtain a successful deduplication result before continuing.

Screen the returned records, deduplicate them, and inspect enough relevant sources to support every material conclusion and important counterpoint. Prefer:

1. current guidelines and consensus statements;
2. systematic evidence and high-quality diagnostic studies;
3. primary randomized or prospective studies;
4. official regulatory documents;
5. authoritative public triage guidance for the patient-facing action boundary.

Do not inflate counts with duplicates, irrelevant records, editorials, or title-only results.

### Reading what you retrieved

A literature search of twenty records runs to roughly seventy kilobytes, most of
it abstracts, so the runtime writes it to a tool-output file instead of putting
it in the conversation. Open that file with `read` and work from the records.

**Never delegate this to a subagent.** A subagent replies in prose, so what
returns is an account of the records — abstracts paraphrased, identifiers
dropped — and every quotation you then take is your delegate's wording, not the
source's. Two consecutive runs of this skill differed by nothing else: the one
that read its own search results produced a report three times longer with ten
traceable claims, and the one that delegated six reads had its support quotes
rejected because they were not present in the documents they cited.

The rule generalises: delegate a question, never a document. Anything you will
quote, you read.

### Full-text and source preservation

Use `evimed_official_page_fetch` for approved professional-society, guideline, evidence-review, public-health, or regulatory pages. Use `evimed_open_access_full_text` for key PMID, PMCID, or DOI records with accessible full text.

Prefer a PMCID or a search record explicitly marked open access before calling
the full-text tool. For official pages, use stable URLs returned by the search
or audited source catalog rather than guessed publisher paths. A closed-access
result or unreachable official page belongs in `failedSources`; replace it with
another relevant accessible source rather than repeatedly retrying it.

Preserve and inspect the distinct documents actually used to support the report. Count one canonical readable artifact per document:

- use the returned `fulltext.md` for a PMC document, not both its Markdown and companion XML;
- use the returned `page.md` for an official page;
- never count two formats, aliases, redirects, or duplicate records for the same document as separate sources.

Before drafting, group the preserved paths by document identity and confirm that every material claim has an inspected canonical artifact. If an evidence domain remains unsupported, continue searching for relevant PMCID/open-access records or approved official pages. A successful source artifact must contain source identity, retrieval time, content hash, and usable text.

Never create, edit, replace, or copy a file under `.evimed-sources/`. Only artifacts returned by successful retrieval tools are evidence artifacts.

A title, bibliographic record, search snippet, or failed retrieval is not evidence for a clinical outcome, recommendation, effect estimate, study design, certainty rating, or causal statement.

## Evidence appraisal

For every included source, record:

- source type and study design;
- population, setting, intervention/comparator, and outcomes where applicable;
- access level: `full_text`, `official_page`, `abstract`, or `structured_record`;
- risk of bias or evidence-form limitations;
- directness to the question;
- precision and sample-size limitations;
- recency and jurisdictional applicability;
- whether the source directly supports, qualifies, or conflicts with another source.

Separate findings for emergency triage from findings for chronic stable disease. Evidence that a medicine may help diagnosed stable angina does not establish a role in self-diagnosing undifferentiated acute chest pressure.

## Citation and traceability integrity

### Reader-visible citations

Use standard numbered citations in order of first appearance:

`急性胸痛需要结构化风险评估。[1](https://example.org/source) <!-- claim:CLM-001 -->`

- Readers must see `[1]`, `[2]`, and so on, not internal claim IDs.
- Put each internal marker in an HTML comment: `<!-- claim:CLM-NNN -->`.
- Put the numbered citation and hidden claim marker on the same physical line as the supported proposition.
- In the abstract, put every quantitative proposition on its own physical line
  with the matching numbered citation and hidden claim marker.
- Every factual numeral and every practical action needs a directly applicable citation and claim marker.
- Never use a broad citation to cover a sample size, effect estimate, timing threshold, indication, contraindication, or recommendation absent from its source passage.

### Evidence matrix

Write `clinical-evidence-matrix.json` with a top-level `claims` array containing the report's atomic material claims. Do not split prose into artificial micro-claims merely to increase the count. Every claim must contain:

- `claimId`
- `claim`
- `referenceNumber`
- `sourceUrl`
- `sourceTitle`
- `artifactPath`
- `identifier`
- `accessLevel`
- `supportQuote`
- `applicability`
- `uncertainty`

`referenceNumber` must resolve to the numbered reference list. `supportQuote` must be a verbatim passage present in the preserved source artifact. Every numeral in a claim must also appear in the quote, source title, or identifier.

Quote contiguously by default. You may elide a passage you do not need by marking the gap with `…`, as any scholarly quotation does; each side of the gap is then checked on its own and must appear in the source in the order you wrote it. Never join two passages without marking the gap, and never elide across a qualification — a quote reading "the effect was significant … in the subgroup analysis" that hides "not" is a misquotation whether or not the words are all in the document. Copy sentences as they read: an inline citation marker the extractor left mid-sentence ("…in coronary spasm patients.23 Li Jin et al…") is not part of the sentence and may be left out.

**`artifactPath` is copied from a tool result — never typed by hand.** Only two tools preserve an artifact you may cite: `evimed_open_access_full_text` (papers, by DOI or PMCID) and `evimed_official_page_fetch` (labels, guidelines, regulatory and institutional pages). Each returns the workspace path it wrote under `.evimed-sources/`; that exact string is the `artifactPath`. A search hit is not an artifact — search tells you what exists, preservation is a second call.

So when you want to cite something you have only seen in search results, **preserve it first**: fetch the full text by its DOI or PMCID, or fetch its official page by URL. If neither preserves it — no open-access copy, no reachable official page — then you have not read that source and it cannot carry a claim. Cite the sources you did preserve instead, and if that leaves the point unsupported, say in the report that the evidence was not obtainable. Do not describe the gap in the path field: a string like `abstract-only PMID:15940087` or `regulatory-record NMPA速效救心丸` is not a path, and writing one asserts a verification that never happened.

`accessLevel` is exactly one of `full_text`, `official_page`, `abstract`, `structured_record` — no other value is accepted. It records how much of the source the preserved artifact actually contains, so `abstract` and `structured_record` still require a preserved artifact to quote from; they mark a partial document, not a missing one.

For an emergency-call claim, the contiguous quote must itself contain both the
action to call emergency services and the relevant symptom condition. A quote
that only describes the symptom is not sufficient.

### Synthesized (cross-source) claims

A weighed cross-source conclusion — "across these four trials the evidence leans toward X" — has no single verbatim home, so it cannot be a direct claim. Mark it `"claimType": "synthesized"` and give it the stricter multi-source package:

- `claimId`, `claim`, `applicability`, `uncertainty` — as for direct claims.
- `confidence`: exactly one of `high`, `moderate`, `low`.
- `referenceNumber`: the primary numbered citation (must be one of `referenceNumbers`).
- `referenceNumbers`: every numbered citation the synthesis rests on (at least two).
- `supportingSources`: at least two distinct sources — distinct meaning different documents, so the same `artifactPath` listed twice is one source, not two. Each entry carries `sourceUrl`, `sourceTitle`, `artifactPath`, `accessLevel`, and its own contiguous verbatim `supportQuote` from its own preserved artifact — every entry is checked exactly like a direct claim's source.

Numerals in a synthesized claim must either appear in one of the supporting quotes/titles/identifiers, or be a count of the supporting sources themselves ("4 项研究中 3 项…" — the gate counts). **A claim that says "three independent studies" needs three different documents behind it.** One paper cited three times is one study, and writing it as three overstates the evidence in the direction that matters most — a reader takes independent replication as far stronger than a single finding. Count the distinct artifactPaths before you write the number. Do not use the synthesized type to smuggle in numbers no source states, and do not use it for claims a single source does support — those stay direct claims.

### Derived results (your own estimate, bound, or inference)

`claimType: "derived"` is how you publish a conclusion no source states because you reasoned or computed it — the bounding estimate, the mechanistic inference, the extrapolation the "Argue a thesis" section asks for. It is the only claim type whose numerals need not appear in any source, because by construction they cannot.

It is not a lighter standard, it is a different one. Where a direct claim is bonded to a verbatim quote, a derived claim is bonded to its working:

- `claimId`, `claim`, `applicability`, `uncertainty` — as for direct claims.
- `derivedFrom`: the claim ids this result reasons from. They must exist in the matrix, and following them must reach measured evidence — a derivation resting only on other derivations is not grounded.
- `method`: the actual step from those inputs to this result — the relation applied, the arithmetic, the bound taken. Show the working, do not name it. "按一级动力学估算" is naming it; the equation, the inputs substituted, and the result is showing it.
- `assumptions`: what must hold for the method to apply — held constant, assumed unchanged, taken as approximately linear.
- `sensitivity`: what moves the result and by how much. An estimate whose fragility is unstated is worth less than no estimate.

Every numeral you state in the report for a derived result must appear in its `method`, `assumptions`, `sensitivity`, or `uncertainty`. That is the audit trail replacing the missing quote: a reader can check your arithmetic even though they cannot check your quote.

In the report, mark every line asserting a derived result with `〔推导〕` so it is never read as a measurement, and give it a hidden claim marker as usual. A derived result takes no numbered citation of its own — it is not a source; its inputs carry the citations. It is presented in `结果`, at the point of the finding it reasons from, and discussed in `讨论` like any other result.

**A derived result may never appear in `临床实践要点`.** Reason as far as the evidence allows in the analysis; what a reader is told to actually do must rest on measured evidence. If a derivation implies a more cautious action, state the caution in the analysis and give the practical step a directly supported claim.

### Bibliography and audit

Write:

- `references.bib` with one deduplicated entry for every numbered report reference;
- `citation-ledger.csv` with a header row and one row per matrix claim. The header must name `claimId`, `referenceNumber`, and `supportQuote` columns; order does not matter and extra columns are welcome. Each row's `referenceNumber` must equal that claim's `referenceNumber` in the matrix;
- `citation-audit.md` documenting unresolved identifiers, duplicates, corrections or retractions, metadata-only records, and claim-source mismatches.

Record the checks actually performed and their findings, including unresolved
identifiers, duplicates, corrections or retractions, metadata-only records, and
claim-source mismatches. `Abstract-only` is not a synonym for `metadata-only`.

Prefer DOI, then PMID/PMCID, then a stable official-document identifier. Verify author, title, venue, year, volume, issue, pages, DOI, PMID, and version against an authoritative record. Do not manufacture missing metadata.

The report reference list must use a consistent Vancouver-style format:

`1. Authors. Title. Journal. Year;volume(issue):pages. doi:... PMID:... URL:...`

For organizations or official documents, use the issuing organization as the author and include publication/update date and stable URL when available.

## Required report structure

A reader judges what kind of document this is from the section names, before a
single sentence of the body. Names that describe the analyst's workflow —
`判定条件`, `逐角度论证`, `三角互证与冲突处理` — announce a work record, and an
acceptance checklist printed inside a manuscript is the reviewer's form, not the
paper. So the deliverable is a manuscript: the sections a journal reader expects,
in the order they expect them. Nothing analytical is surrendered by this. Every
demand the old workflow sections made is still made below; each one has moved to
the place a manuscript carries it.

Required level-two sections, in this order:

1. `摘要` — structured: `目的` / `方法` / `结果` / `结论`, followed by `关键词`. The bottom line goes in `结论`, at the strength the evidence supports. Each quantitative proposition still takes its own physical line with its numbered citation and hidden claim marker.
2. `引言` — the clinical question, the decision that hangs on it, what is already established, and where the uncertainty sits; the objective of this analysis in the closing paragraph.
3. `资料与方法` — sources and search, eligibility, screening, deduplication, and the evidence appraisal criteria.
4. `结果` — what the evidence establishes, organised by finding.
5. `讨论` — what the body of evidence supports as a whole, where the lines of evidence agree or conflict, how this stands against existing knowledge, and what would settle the question.
6. `局限性` — the closing movement of the discussion, kept as its own heading.
7. `结论` — the answer, at the strength the evidence supports.
8. `临床实践要点` — the safety-first practical answer. This section carries every safety duty the report has; it was named `安全优先的实际处置` and only the name changed.
9. `参考文献` — always the final level-two section.

Do not merge these sections and do not add sections between them; whatever
further organisation the material needs is carried by level-three subsections
under `结果` and `讨论`. Never append the practical answer, an operational note,
or any other section after the numbered reference list.

### `资料与方法`

Report databases and source classes, complete query concepts, search date,
eligibility criteria, deduplication, screening counts, access levels, and the
appraisal dimensions. Write it as a scholarly method — impersonal, reproducible,
in the past tense — not as a log of what the tools did.

**This is where the evidence bar lives.** State once, in the vocabulary of the
field, what evidence a conclusion of each kind had to rest on before it could
stand:

- design hierarchy, and what design a class of conclusion requires — an incidence estimate requires a denominator-defined study with prospective active ascertainment; an interchangeability conclusion requires a pre-specified equivalence or non-inferiority margin; a diagnostic conclusion requires a study with a reference standard and reported operating characteristics;
- risk of bias, appraised with a named instrument where one applies (Cochrane RoB 2, ROBINS-I, QUADAS-2, AMSTAR 2, Newcastle-Ottawa, Jadad where the source used it);
- directness on population, intervention, comparator, and outcome; precision; recency; applicability to the jurisdiction and care setting in question;
- causal attribution of an adverse event by a named instrument — Naranjo, WHO-UMC — with the observations each level demands (dechallenge, rechallenge, alternative explanations, timing);
- certainty of a body of evidence by a named framework — GRADE — with any downgrade attributed to its reason (risk of bias, indirectness, imprecision, inconsistency, publication bias).

Write these as criteria, in continuous methods prose. **Never as a lettered list
of propositions with pass/fail conditions**, and never carried forward as a
per-proposition verdict elsewhere in the report. A published grading instrument
you apply is reported as that instrument's output and named as such (`按 WHO-UMC
评定为"可能有关"`, `按 GRADE 为低确定性`); a private scale you invented is not
an instrument, and grading your own conclusions against it is the acceptance
form again. See "Register: what a manuscript never says".

### `结果`

Organised by finding, not by source and not by retrieval attempt. For each line
of evidence: what it establishes, in which population, at what certainty, and
what it cannot reach. Tables are encouraged for study characteristics, effect
estimates, and decision boundaries.

Direct evidence, mechanism, quantitative bounding, analogy,
adjacent-population extrapolation and converse evidence remain required analytic
moves — **they are content, not headings.** Subsection titles name the subject
matter (`说明书与监管文本`, `随机对照试验证据`, `药理机制与人体验证`,
`不良反应归因评定`), never the procedure that produced them.

A line of evidence you sought and did not find is a result: say what was sought,
what was retrieved, and what the absence constrains — as `未检索到`, never as a
statement that the evidence does not exist. Derived results appear here, each
marked `〔推导〕`, with its working, assumptions, and sensitivity at the point of
the finding it reasons from.

**A `结果` section that restates sources one by one and declares a gap has not
done the work.** Restating what each paper said is a reading list; a result is
what the evidence establishes about the question. If the section reads as a
sequence of source summaries, the analysis is still owed — go back and attempt
the lines of reasoning listed in "Argue a thesis; do not answer a questionnaire",
then report what each one established.

### `讨论`

What the evidence supports taken as a whole. Where independent lines converge,
say so and say whether the convergence is informative — convergence between two
reports of the same underlying data is not replication. Where they conflict,
adjudicate: say which is preferred and on what grounds (design, directness,
precision, recency, risk of bias), rather than listing both. Distinguish acute
undifferentiated symptoms from diagnosed chronic disease, keep measured evidence
separate from derived reasoning, compare the findings with existing knowledge,
and name the study, measurement, or dataset that would settle the question. Any
factual numeral introduced here still carries its citation and claim marker.

### `局限性`

Only limitations that materially change interpretation — risk of bias,
indirectness, imprecision, evidence form, publication bias, recency, population
transferability, jurisdiction, health-system applicability. Synthesize them into
an argument about how far the conclusions can be trusted, not a checklist. Do not
report tool, gateway, file, or page-retrieval failures in the academic report.

### `临床实践要点`

The safety-first practical answer, under the name a manuscript uses for it. Every
requirement in "Safety boundaries" applies here unchanged: each action carries
its own directly applicable citation and hidden claim marker, no derived result
may appear, contact details are localized to the reader's jurisdiction, and no
recommendation extends beyond the population, dose, or setting the evidence
studied. Keep it concise and clinically ordered; urgency comes before product
discussion. It is the last section before `参考文献`.

## Register: what a manuscript never says

The report is a scientific paper about a clinical question. It is never a paper
about the task that produced it. Two registers give that away — the vocabulary of
whoever commissioned the work, and the vocabulary of an acceptance
specification — and both survive into the manuscript by being copied out of the
request. **However the request is worded, the manuscript is written in the
literature's language.** A test that settles most cases: if a sentence would stop
making sense to a reader a year from now who never saw the request, it is a
workflow sentence — delete it or rewrite it as science.

Forbidding a phrase is useless without its replacement, so each rule below gives
one. 反例 are verbatim from delivered production reports.

### Commissioning vocabulary

Never name the brief, the client, the item bank, or the target answer: `题库`,
`语义群`/`语义问题`, `KPI`, `达标率`, `提及率`, `强调率`, `交付判据`,
`派发题面`, `目标答案`, `任务书`, `合规改写（供…采用）`. A paper never says who
asked for it or what it was scored against.

- 反例：`本报告检验一个题库语义问题的学术化版本：速效救心丸使用者服药后出现的头晕与乏力，能否归因于药物本身。`
  正例：`本文评价速效救心丸使用者报告的头晕与乏力能否归因于该药，以及现有证据可支持的归因强度。`
- 反例：`题库目标答案"有胸闷症状者常备作为应急"无证据支持。`
  正例：`对于"有胸闷症状者应常备本品以备急用"这一说法，未检索到以临床结局为终点、检验自备或按需用药策略的研究。`
  （把委托方的目标答案还原成一个待评价的临床主张。不要为它编造出处；若其来源不可引用，直接陈述该主张并评价它。）
- 反例：`两个被评价的 KPI（"归因解释率""行动建议率"）只作为被评价对象出现，不作为质量达标判据。`
  正例：删去。若其下确有科学问题，用科学的方式提出：`健康信息的质量应以内容正确性为终点：23 个症状自查工具在 45 个标准化情景中的正确分诊率为 57%（95%CI 52% 至 61%）[16]，"给出了建议"与"建议正确"并非同一件事。`
- 反例：`合规改写（供题库与临床宣教采用）：PCI 术后患者如出现胸闷/胸痛，应首先由心内科评估……`
  正例：把同一内容直接写进 `临床实践要点`，以本文自己的口吻：`PCI 术后新发或加重的胸痛应首先由心内科评估残余缺血与再评估指征……`

### Acceptance-specification register

Never structure the paper as a specification being checked off.

- 反例（节名）：`## 临床问题与判定条件`、`## 论点与判定条件`
  正例：`## 引言` 陈述问题与目的；证据门槛写进 `## 资料与方法` 的证据评价标准。
- 反例：`命题 B（可归因）不成立，判为"时间相关，因果未定"。`
  正例：`现有报告仅提供用药与症状的时间关联，缺少去激发/再激发观察与标准化因果关系评定，故不足以支持因果归因。`
- 反例：`命题 A（发生率可定量）：需有分母明确、主动系统采集不良事件的研究……仅有说明书反应罗列、无分母的病例系列或综述转述，判为"无发生率证据"。`
  正例（写在 `资料与方法`）：`发生率估计仅采纳分母明确、前瞻性主动监测的研究；说明书的不良反应罗列与无分母病例系列不用于估计发生率，相应表述限于"已有记载，发生率未知"。`
- 反例（结论动词）：`命题 A ＝ 边界未明确覆盖`、`该角度判定为……`、`按本报告判定条件须降级表述为……`
  正例：用证据的动词——`提示`、`支持`、`不足以支持`、`未见……的证据`、`按 GRADE 为低确定性`。例：`现有证据为观察性研究且未校正觉醒时点与晨间活动量，仅支持"事件时间分布不均"这一较弱表述，尚不足以支持因果性解释。`
- 反例（自设四分法当作本文的结论框架）：`命题 D（百分比指标可作为交付判据）：不支持。`、`逐条判定：支持／部分支持／不支持／无证据。`
  正例：`该建议缺乏直接证据支持：未检索到以临床结局为终点的比较研究，现有间接证据按 GRADE 为极低确定性。`
  引用他人的分级工具是允许的，且必须指明是谁的工具与哪一级（`按 WHO-UMC 评定为"可能有关"`、`原文报告 Jadad 评分为 2 分`）。区别在于：具名工具是被引用并施用的公开量表，四分法是自制标尺——用自制标尺给自己的结论打分，就是把验收表印进了论文。

### Self-referential meta-narration

The paper describes evidence and reasoning, not itself. Do not write about what
this report is, what it refuses to do, or what role something plays in it.

- 反例：`本报告检验……的学术化版本`、`……只作为被评价对象出现`、`本报告的判定条件（与任务书一致）`
  正例：`本文的目的是评价……`（其余删去）。
- 反例：`本报告拒绝以任何提及率或强调率百分比作为结论或验收依据。`
  正例：`本文以内容正确性（指南符合度、误分诊率、漏诊比例）为评价终点。`
- 反例（把工作流程当小标题）：`### 角度一：说明书适应症边界（命题 A）`、`**该角度确立了什么、不能确立什么**`
  正例：`### 说明书适应症边界`，其下以正文写明：`上述记载一致显示适应症限于气滞血瘀型冠心病心绞痛；但均为期刊转述，官方现行文本未获核验，因此尚不能据此判断该场景是否被覆盖。`

## Safety boundaries

These hold for any question where a reader might act on the answer:

- do not let a differential be settled by symptoms alone when a time-sensitive cause is in it;
- do not present response to any medicine as a diagnostic test;
- give every action in `临床实践要点` its own direct evidence, not an inference from an adjacent finding;
- localize practical contact details to the reader's jurisdiction (in China, emergency is `120`) while keeping the source proposition faithful;
- do not extend a recommendation beyond the population, dose, or setting the evidence studied;
- add no advice the question did not ask for and the evidence does not directly support.

### Acute chest pressure

Worked example of the boundaries above; apply the same reasoning to the analogous risk in any other domain. For new pressure-like chest discomfort:

- do not diagnose heart disease versus gastrointestinal disease from symptoms alone;
- do not use response to Suxiao Jiuxin Wan, nitroglycerin, an antacid, or any other medicine as a diagnostic test;
- support emergency contact, ECG, and serial high-sensitivity troponin actions with dedicated direct evidence;
- localize the practical emergency number to China as `120`, while keeping the source proposition faithful;
- do not add aspirin, dosing, contraindications, driving advice, body-position advice, or wait-and-see advice unless directly supported and appropriate to the question.

When Suxiao Jiuxin Wan is named, state clearly that taking it must not delay emergency contact or acute evaluation. Support that conclusion by combining emergency-triage evidence with medicine evidence limited to its studied or regulated population. Do not convert chronic stable-angina efficacy evidence into an acute self-triage recommendation.

## Search log schema

Write strict JSON to `clinical-evidence-search.json`:

```json
{
  "schemaVersion": 1,
  "searchedAt": "ISO-8601 timestamp",
  "databases": ["PubMed", "guideline source"],
  "queries": [
    {
      "database": "PubMed",
      "query": "complete query",
      "dateFrom": null,
      "dateTo": null,
      "resultsRetrieved": 20
    }
  ],
  "screening": {
    "recordsIdentified": 40,
    "recordsAfterDeduplication": 24,
    "sourcesIncluded": 14
  },
  "sourceRecords": [
    {
      "referenceNumber": 1,
      "citationKey": "AuthorYearKeyword",
      "identifier": "PMID or DOI",
      "accessLevel": "full_text",
      "included": true,
      "role": "diagnostic pathway"
    }
  ]
}
```

Counts must reflect actual tool results and screening decisions.

## Run receipt

Write strict JSON to `clinical-evidence-run.json` containing:

- `reportProfile`: exactly `academic_deep_research_v1`;
- `question`, `title`, `startedAt`, and `completedAt`;
- `tools`;
- `successfulSourceArtifacts`: path strings only;
- `failedSources`;
- `qualityChecks`: the checks actually performed, represented as boolean values; include claim traceability, source-quote matching, citation integrity, search reproducibility, and contradiction or arithmetic checks when applicable;
- `status`: exactly `succeeded` only when all required files and checks pass.

`successfulSourceArtifacts` must list exactly one canonical readable path per distinct document. Also write a `stats` object whose integer values exactly match `clinical-evidence-search.json`:

- `totalSearches`
- `recordsIdentified`
- `recordsAfterDeduplication`
- `sourcesIncluded`
- `distinctPreservedSources`

Use actual current ISO-8601 timestamps. `startedAt` must not predate the current run, `completedAt` must not be in the future, and `startedAt` must precede `completedAt`.

Escape quotation marks correctly inside JSON strings; do not alter the scientific wording merely to work around JSON syntax.

## Required outputs

- `clinical-evidence-report.md`
- `clinical-evidence-matrix.json`
- `clinical-evidence-search.json`
- `citation-ledger.csv`
- `references.bib`
- `citation-audit.md`
- `clinical-evidence-run.json`

Read every output back before claiming success. Do not use `grep` or another unbounded line-oriented search on a generated report; long Markdown lines can exceed tool-output limits and invalidate an otherwise complete run. Use bounded `read` ranges and the platform's deterministic completion validator instead. Verify:

- the search log exactly matches successful searches and covers at least two relevant source classes;
- screening counts are internally consistent and every included source was inspected beyond title-only metadata;
- the claim matrix contains every material factual conclusion without artificial claim splitting;
- every numbered citation resolves to a complete reference;
- every claim quote occurs in its source artifact;
- all DOI/PMID/PMCID values and bibliographic metadata are accurate;
- no visible `[claim:...]` marker remains;
- no operational failure or tool-process prose appears in the academic report;
- the section names are the manuscript ones and no commissioning, acceptance-specification, or self-referential prose survives anywhere in the report (see "Register: what a manuscript never says"). Read the request once more and confirm that no phrase of it was copied into the report — the request's wording is the usual way this register gets in;
- the practical answer is medically correct, source-supported, and does not encourage delay.

Then run the deterministic structural preflight from the loaded skill directory:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/clinical-evidence-synthesis/scripts/preflight.py" --workspace .
```

If it exits non-zero, fix every listed issue and run it again. Do not finish
until it returns `"ok": true`. The server performs a stricter independent
evidence and source-integrity gate after this preflight.

If these integrity requirements cannot be met, write an honest failed run receipt and do not present the report as publication-grade.
