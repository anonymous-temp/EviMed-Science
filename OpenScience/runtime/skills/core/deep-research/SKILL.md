---
name: deep-research
description: Research a question across several sources and synthesize a sourced answer or report, scaled to the question. General sources first — the open web, official pages, primary documents and data; literature, guideline and regulatory sources when the topic is biomedical. Use when a question needs more than a short factual answer or a single lookup.
---

# Deep Research

Use this skill when a question needs more than a short factual answer or a single-source lookup: a market or technology comparison, a policy question, a state-of-the-evidence question.

## Scale to the question

Size the work to what was asked. A three-page market overview rests on a handful of good sources; a broad literature question may need many. Write down the subquestions the answer actually has to cover — there is no fixed number of them and no source quota — and stop when further searching no longer changes the answer.

For an explicitly bounded task, the supplied call budget overrides any search expansion below. Count each attempted search or source-read tool invocation, including failures and retries, before making it; returned document counts are separate. When the next call would exceed the budget, stop acquisition and report the gap rather than silently extending the task.

## Workflow

1. List the subquestions and what would count as a good source for each.
2. Start with general sources: `mcp__evimed__web_search` to find them and `mcp__evimed__web_read` to read them. An official page, a primary document, a filing or a statistics release is often the primary source — a vendor's release schedule, a regulator's notice, a company's annual report.
3. When the topic is biomedical, add the literature and guideline sources (`mcp__evimed__literature_search`, `mcp__evimed__guideline_search`, `mcp__evimed__biomedical_source_search`, `mcp__evimed__open_access_full_text`; `mcp__evimed__data_source_catalog` lists what is configured) and deduplicate large result sets with `mcp__evimed__evidence_deduplicate`. There a search record is a discovery record: it establishes no study design, recommendation, effect or causality unless the returned record shows the supporting content.
4. Try a second phrasing when the first results miss the point.
5. Read the sources that carry the answer, not their search snippets, and say at what depth you read each one.
6. Keep a source list as you go: address, title, date, what it supports.
7. Synthesize agreement, conflict, recency and applicability. Do not write a source-by-source annotated list as the final analysis.
8. Narrow the conclusion when the sources cannot support the requested scope.

## Iterative retrieval

Run retrieval as a search → read → refine → re-search loop:

1. Search with the initial queries.
2. Read the most relevant results at the deepest available access level, noting which subquestions remain uncovered.
3. Refine the query from what was read: add newly found names, synonyms and terms, and drop terms that returned only irrelevant results.
4. Re-search with the refined queries and deduplicate against earlier results.

Stop when two consecutive refined queries add no new relevant source, or after three refinement iterations, whichever comes first; then say what the loop covered and what it could not reach.

## Quality rules

- Every material factual claim resolves to a source you actually read; give its link.
- Prefer primary and official sources to aggregators, and date time-sensitive facts.
- Cross-check consequential claims against a second independent source.
- Label your own synthesis and inference separately from what a source states.
- Report negative or conflicting findings rather than selecting only supportive ones.
- Do not count duplicates, inaccessible pages, empty searches, or failed tools as support.
- Source quantity never excuses low relevance or incorrect citation metadata.

## Deliverable standard

Deliver what was asked for, at the length asked for: a sourced answer in the conversation, or a report file. A report states the question and scope, the findings by theme, conflicts and uncertainty, and its sources with links. When a specialist workflow calls this skill for a biomedical review, also provide the search, selection, appraisal, citation and provenance artifacts that workflow requires.
