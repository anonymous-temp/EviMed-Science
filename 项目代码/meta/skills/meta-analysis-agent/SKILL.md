---
name: meta-analysis-agent
description: Run the local MetaAgent from one clinical or scientific research topic to a complete editable systematic-review and meta-analysis article with source-linked extraction, validated statistics, figures, and references. Use when the user asks to conduct, generate, resume, or update a systematic review or meta-analysis manuscript from a topic or research question.
---

# Meta Analysis Agent

Use the canonical MetaAgent repository at `/Users/wangzeyuan/Desktop/meta`. Keep the interaction simple: accept a topic and return the article and its output files.

## Run

1. Extract these inputs from the request:
   - research topic or question, required;
   - output language, optional and otherwise inferred from the topic;
   - full-auto mode, only when the user explicitly asks for unattended execution;
   - resume directory or PDF directory, only when supplied.
2. Run from `/Users/wangzeyuan/Desktop/meta` with the repository virtual environment:

```bash
.venv/bin/metaagent --topic "<topic>" [--output-language zh|en]
```

Add `--skip-confirm` only for explicit full-auto mode. Add `--resume <absolute-project-path>` to continue an existing run. Add `--user-pdfs <absolute-directory>` only when the user supplies full text proactively or after automatic retrieval fails.

3. Use a TTY so a normal run can pause at a genuine method decision.
4. Let automatic retrieval, screening, extraction, method routing, statistics, figures, references, and writing run without asking workflow questions.

## Handle the only decision points

In normal mode, pause and relay the generated options only when:

- multiple clinically distinct analysis sets are defensible; or
- context-dependent certainty domains require a choice.

Show the recommended option first, wait for the user's selection, send that selection to the running process, and continue the same project. Do not invent a choice on the user's behalf.

In explicit full-auto mode, allow MetaAgent to rank the primary analysis set and apply the documented conservative certainty option. Do not treat unknown certainty domains as having no concern.

If no usable full text is retrieved, report the resumable project directory and request source files. Do not extract quantitative results from metadata-only or abstract-only records.

## Return

On success, return clickable absolute paths to:

- `manuscript/draft.md` as the primary deliverable;
- `figures/`;
- `references.bib`;
- `package/metaagent_export.zip` when generated;
- the project directory for later resume or updates.

State clearly when the result is a narrative systematic review or evidence-gap article rather than a quantitative meta-analysis. Keep internal ledgers and validation files in the project, but do not turn them into extra user-facing ceremony.

## Boundaries

- Never enable benchmark mode or validating methods for a real review.
- Never substitute pairwise pooling for an unsupported review family.
- Never ask the user to manage permissions, principals, signatures, or release approvals.
- Never claim that a blocked or sparse result is a completed quantitative meta-analysis.
