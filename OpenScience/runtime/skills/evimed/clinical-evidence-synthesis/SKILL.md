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

State the bottom line first, then what would have to hold for it to be true, then attack each of those conditions with everything available. The reader should be able to see the argument being built, and see which load-bearing piece is weakest.

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

In the report, mark every line asserting a derived result with `〔推导〕` so it is never read as a measurement, and give it a hidden claim marker as usual. A derived result takes no numbered citation of its own — it is not a source; its inputs carry the citations.

**A derived result may never appear in `安全优先的实际处置`.** Reason as far as the evidence allows in the analysis; what a reader is told to actually do must rest on measured evidence. If a derivation implies a more cautious action, state the caution in the analysis and give the practical step a directly supported claim.

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

The structure carries the argument. Sections 2 through 6 are the argument being built and are the substance of the report; use these core sections, merge adjacent analytical sections when that improves the argument, and add a medicine-specific subsection only when relevant:

1. `摘要` — the bottom line first, then the strength it is held with
2. `论点与判定条件` — the thesis, and what would have to hold for it to be true or false
3. `证据基础与检索方法` — what was searched and what was found, reported as scholarly method; keep it proportionate, it is the ground of the argument and not the argument
4. `逐角度论证与结果` — one subsection per angle attempted (direct evidence, mechanism, quantitative bounding, analogy, adjacent-population extrapolation, converse evidence), each saying what it establishes and what it cannot
5. `三角互证与冲突处理` — where angles agree, whether that agreement is informative; where they conflict, which wins and why
6. `推导与外推` — the derived results, each marked `〔推导〕`, with its working, assumptions, and sensitivity
7. `讨论` — what the argument as a whole establishes, and what would settle the question
8. `证据局限`
9. `结论`
10. `安全优先的实际处置`
11. `参考文献`

Sections 4, 5, and 6 are what distinguishes an analysis from a lookup. A report that reaches section 7 having only restated sources and declared a gap has not done the work — go back and attempt the angles.

Keep `参考文献` as the final level-two section. Never append the practical answer, an operational note, or another report section after the numbered reference list.

The methods section must report databases/source classes, complete query concepts, search date, eligibility criteria, deduplication, screening counts, access levels, and appraisal dimensions. Describe this as a scholarly method, not as a runtime log.

The per-angle section must argue by angle, not list sources one by one. Each angle states what it establishes, how strongly, and what it cannot reach; compare agreement, conflict, directness, and certainty. Tables are encouraged for evidence characteristics and decision boundaries. An angle you attempted and that failed is worth reporting — say what you looked for, why it did not deliver, and what that absence itself implies.

The discussion must explain what the argument as a whole establishes, distinguish acute undifferentiated symptoms from diagnosed chronic disease, separate measured evidence from derived reasoning, and name the study or measurement that would settle the question.

The limitations section must discuss only limitations that materially change interpretation, such as risk of bias, indirectness, imprecision, evidence form, publication bias, recency, population transferability, jurisdiction, or health-system applicability. Synthesize them into an argument rather than a checklist. Do not report tool, gateway, file, or page-retrieval failures in the academic report.

## Safety boundaries

These hold for any question where a reader might act on the answer:

- do not let a differential be settled by symptoms alone when a time-sensitive cause is in it;
- do not present response to any medicine as a diagnostic test;
- give every action in the practical section its own direct evidence, not an inference from an adjacent finding;
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
- the practical answer is medically correct, source-supported, and does not encourage delay.

Then run the deterministic structural preflight from the loaded skill directory:

```bash
python "$XDG_CONFIG_HOME/opencode/skills/clinical-evidence-synthesis/scripts/preflight.py" --workspace .
```

If it exits non-zero, fix every listed issue and run it again. Do not finish
until it returns `"ok": true`. The server performs a stricter independent
evidence and source-integrity gate after this preflight.

If these integrity requirements cannot be met, write an honest failed run receipt and do not present the report as publication-grade.
