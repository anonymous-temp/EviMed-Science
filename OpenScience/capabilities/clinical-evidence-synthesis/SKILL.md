---
name: clinical-evidence-synthesis
description: Write a clinical evidence deliverable — a focused evidence analysis or a narrative or comprehensive review — in the form and language the person asked for, with reproducible searches, every claim bound to a quotation in a preserved source, and a separate safety-first practice-points section.
---

# Clinical evidence synthesis

This method and the companion skills injected with it are already in front of you; do not load them again.

If the session has no plan yet, write one with `evimed_plan` (capability `clinical-evidence-synthesis`, contractKind `clinical-evidence-report`). Files go in `deliverables/<id>/`: `clinical-evidence-report.md` and `clinical-evidence-matrix.json`. The exact task is at `.evimed-brief/sessions/<session id>/research-brief.md`: read it before outlining and before finishing; never edit it.

## The request decides the form

Before searching, note what the request fixes: language, organisation (sections and order), tables, figures, length, audience, reference style.

- **A named organisation is followed exactly.** Its outline becomes the report's level-two sections, in its order, under its own names; nothing is renamed, merged, reordered or dropped. Add only the apparatus it leaves out, around it: before it an Abstract (Key points if useful), a short Introduction and the search method; after it Limitations, Conclusions, Practice points, References — each only if the outline lacks it.
- **No organisation, focused clinical question:** Abstract (structured), Introduction, Methods, Results, Discussion, Limitations, Conclusions, Practice points, References.
- **No organisation, narrative or comprehensive review:** Abstract (Key points if useful), a short Methods section or "Search strategy" paragraph, topic sections that follow the field's own logic (e.g. mechanisms → phenotypes → assessment → management → open questions), Limitations, Conclusions, Practice points, References.

**One language, all the way through.** The deliverable is written entirely in the language the person asked for, or, if they named none, in the language of their request: title, headings, abstract labels, table headers and cells, figure legends, practice points, notes, and the matrix's `claim`, `applicability` and `uncertainty`. Only a source's own title in the reference list, and a `supportQuote`, stay in the source's language. Never mix. If they asked for planning in one language and the deliverable in another, honour both.

**Practice points** always exist, as their own section after Conclusions, just before References; the safety checks find them by heading. Use one of: Practice points / Clinical practice points / Key points for practice / Implications for practice / Practical answer; in Chinese 临床实践要点 / 临床要点 / 实际处置 / 安全优先的实际处置 / 实用回答 / 怎么办. Keep these words out of every other level-two heading (a summary box is "Key points" / "要点"): the checks take the first heading containing one.

**References** is the last level-two section, headed in the deliverable's language (`## References`, `## 参考文献`).

**Requested tables and figures are delivered.** Tables are Markdown tables in the report; factual cells carry their `[n]`, and the row's claim markers go at the end of the row. A figure to be described is a numbered legend plus a clear description of each panel (and a Mermaid diagram if it helps).

## Search in proportion to the scope

1. **Decompose** the requested outline (or the focused question) into sub-questions — every section, every requested table — and search each. Breadth follows scope: what a focused question needs; dozens to a few hundred references for a comprehensive review.
2. **Search**: `mcp__evimed__literature_search` with `databases: ["pubmed"]` for exact topic queries; `mcp__evimed__guideline_search`; `mcp__evimed__web_read` for official and label pages. For what is new, `mcp__evimed__frontier_search` first — its items are leads; cite the original. Deduplicate with `mcp__evimed__evidence_deduplicate` (omit absent identifier keys).
3. **Fetch abstracts in batches**: the same tool with `pmids: [...]` (up to 200 per call) returns them compact, preserved and quotable. A large result lands in a tool-output file; read it in bounded ranges.
4. **Trace the field's own references**: `mcp__evimed__reference_list` on the newest guideline, key reviews and landmark trials; `direction: "cited_by"` finds later follow-ups.
5. **Read full text for the papers that carry the argument** — key mechanistic studies, pivotal trials, major reviews — with `mcp__evimed__open_access_full_text` (PMCID, PMID or DOI). Read only the sections you need (`read`); check quotes with `mcp__evimed__locate_quote{sourceId, quote}` and copy the passage it returns. Without full text the claim rests on the abstract: `accessLevel: "abstract"`, and say so where it matters.
6. **Before stopping**, place each sub-question: covered (by what), searched and empty, not yet searched, source unavailable. Retry a zero-hit search with two shorter queries and a second source before writing that evidence was not retrieved; never write that it does not exist. An unreachable source is a limitation, not an empty search.
7. Never delegate reading: whatever you quote, you read.

State the search reproducibly in the Methods or Search strategy: sources, search dates, the main queries as sent, reference lists traced, records identified / after deduplication / included (counted; included = references listed), and how many were read in full.

## The evidence matrix

Write claims with `evimed_claim_upsert{deliverableId, claims: [...]}` (up to 60 per call); it answers `verified`/`unverified` per claim by the gate's rules. Fix and rewrite under the same `claimId` (`CLM-001`…). One claim per material finding.

- **direct** (default): `claimId`, `claim`, `referenceNumber`, `sourceUrl` (https), `sourceTitle`, `artifactPath`, `identifier`, `accessLevel` (exactly `full_text`, `official_page`, `abstract` or `structured_record`), `supportQuote`, `applicability`, `uncertainty`.
- **synthesized** (a cross-source conclusion): `claimType: "synthesized"`, `confidence` (`high`/`moderate`/`low`), `referenceNumbers` (≥2, including `referenceNumber`), `supportingSources` — at least two different documents, each with `sourceUrl`, `sourceTitle`, `artifactPath`, `accessLevel` and its own `supportQuote`. "Three trials" needs three documents.
- **derived** (your own estimate, bound or inference): `claimType: "derived"`, `derivedFrom` (claim ids whose chain reaches measured evidence), `method` (the working itself: relation, inputs, result), `assumptions`, `sensitivity`, `applicability`, `uncertainty`. Its printed numbers appear in those fields.

Rules a reader cannot check:
- `supportQuote` is verbatim from the preserved artifact's body, never its title. Quote contiguously; mark a gap with `…`; never elide across a negation or qualifier; keep a threshold and its direction word in one unelided run. The quote carries the claim's numbers and predicate (effect direction, likelihood-ratio type). "The authors argue…" only when the quote states that position.
- `artifactPath` is copied exactly as the preserving tool returned it: it starts with `.evimed-sources/`, never `/workspace/`. Only what a preserving tool returned is citable: abstracts fetched by `pmids`, full texts, read pages, a guideline result carrying an `artifactPath`, trial snapshots, US labels. A search hit is not an artifact: preserve, then cite. Never create or edit files under `.evimed-sources/`.
- A claim telling the reader to call emergency services quotes a passage containing both the call and the symptom condition.

## Writing the report

- Readers see `[n]`; each claim's hidden marker `<!-- claim:CLM-NNN -->` sits on the same physical line as its proposition, and that line carries the claim's own `[n]` (for a synthesized claim, one of its numbers). Every marker resolves to the matrix.
- Every number on a line is carried by that line's claim. A number flagged as unanchored or unsupported is bound to a claim with its quote when the sources support it; a correct, sourced number is never deleted or blurred into words to silence a finding. Only a number no source supports is corrected or removed.
- A derived result is labelled on its line — `[derived]` in English, `〔推导〕` in Chinese — takes no `[n]` of its own, and never appears in Practice points.
- References: numbered by first appearance, each cited at least once, every `[n]` resolving, no PMID or DOI in the citation slot, nothing you did not read beyond its title. After drafting, `evimed_render_report{deliverableId}` renumbers and rebuilds the list; complete any placeholder entry it adds. Vancouver style unless the person names another; metadata copied from the retrieval record, never from memory.
- Argue, do not catalogue: bottom line first, then the case, organised by finding. Name the study (design, population, size); appraise compared arms with one ruler; keep one name per endpoint; take the hedge from the appraisal and write it once. Count studies, not reports. Keep populations apart (evidence in diagnosed stable disease does not transfer to undifferentiated acute symptoms). "Not retrieved" is never "no effect"; where direct evidence is thin, reason by mechanism, analogy or bounding as derived claims, and name the study that would settle it.
- A narrative or comprehensive review meets SANRA (Baethge et al., 2019): why the topic matters to its readers; concrete aims; the search described; key statements referenced specifically; synthesis and argument, contradictory evidence adjudicated explicitly, not listed; data presented appropriately (effect sizes with uncertainty, tables where comparison helps). A review asked to be new or novel states its framework explicitly, defends it with evidence, and gives testable predictions and what would refute them.
- Register: a paper about the clinical question, never about the task. No commissioning vocabulary (brief, item bank, target answer, KPI); no sentences about this report, its role or its audience; no section named after a workflow or verdict ("Proposition A holds"); no source passages pasted into the body (quotations live in the matrix); no tool names, file paths, run details or tool failures. Revision notes go to `revision-notes.md` beside the report.
- Subjects of a supplied dataset get pseudonyms you assign (P1, P2…), never a value from the file.

## Safety

- No individual diagnosis or treatment plan. A time-sensitive differential is never settled by symptoms alone; response to a medicine is never a diagnostic test.
- Every action line in Practice points (bullet or numbered) carries `[n]` and the marker of a direct or synthesized claim supporting that exact action. No derived result, no advice the question did not ask for, nothing beyond the population, dose or setting studied, no "the only safe/correct treatment".
- Emergency triggers — the warning signs that need immediate care, named whenever the topic has them — are symptoms and signs only, never conditioned on how a self-administered medicine worked ("call if not relieved after taking X" is forbidden even when a guideline says it; restate the guideline in the results). Taking a medicine never delays calling emergency services, and Practice points says so when a medicine is named. Localise contact details to the reader's jurisdiction (China: 120).

## Finishing

1. `evimed_package_check{deliverableId}` returns the submission's verdict without spending one. Fix every `blocking` finding (missing file or claim field, quote not in its source, claim bound to no preserved source, unlabelled or ungrounded derived result, unresolved marker) and every `safety` finding. Act on cheap advisory findings; one that conflicts with the person's requested structure or language is noted and left. Never rewrite the report into another language or structure to satisfy one.
2. Edit passage by passage with the edit tool, never by regenerating the report; read it back in bounded `read` ranges. Before the last submission, run in order `traceability-review` (citations resolve, no number without a source; repair what it finds) and `manuscript-humanize` (register cleanup in place; quotes, numbers, `[n]`, markers, derived labels and headings byte-identical).
3. Submission runs it all: `evimed_submit_deliverable{deliverableId}` renders the numbering, runs the gate and the independent reviewer (`evimed_review_run{deliverableId}` asks the reviewer mid-draft). Answer each finding marked 需回应 in the next submission's `responses` (`fixed`, or `declined` with a one-sentence reason). Stop after two rounds of fixes: open findings are shown to the reader, never withheld.
4. When the person asked for a manuscript, a review or a Word file, also write `clinical-evidence-report.docx` from the final report. The renderer prints HTML comments as text, so first copy the report without its claim markers (`sed -E 's/ *<!-- claim:CLM-[0-9]+ -->//g'`; headings, tables, `[n]` and references stay), then render it with the office `docx` skill's `scripts/create_docx.py --input <copy> --output deliverables/<id>/clinical-evidence-report.docx` and run that skill's structural check.
5. Hand the report (and the .docx) over with `present`. If an integrity requirement could not be met, say so plainly in your reply.
