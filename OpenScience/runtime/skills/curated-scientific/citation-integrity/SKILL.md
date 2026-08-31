---
name: citation-integrity
description: Verify, reconcile, and manage scientific citations. Use for DOI or PMID resolution, exact-paper reconstruction from a published title, reference deduplication, claim-to-source checks, retraction or correction checks, BibTeX export, and citation audits.
---

# Citation integrity

Build a claim-to-source ledger before formatting references. Retrieve each record
from an authoritative index or the publisher, preserve DOI, PMID, PMCID, title,
authors, venue, year, version, and retrieval time, and record whether full text,
abstract, or metadata was actually inspected.

Normalize identifiers and deduplicate by DOI, PMID, then normalized title. Check
for corrections, expressions of concern, retractions, and version changes. Never
turn an unresolved identifier into a plausible-looking citation, and never cite
a bibliographic record as support for a claim that requires methods or results.

For each material claim, record the supporting passage or structured result and
whether the source directly supports, qualifies, or conflicts with it. Flag
secondary citations where the primary source is available. Respect license and
quotation limits; paraphrase while preserving the source's meaning.

Write `citation-ledger.csv`, `references.bib`, and `citation-audit.md`. The audit
must list unresolved, duplicate, retracted, corrected, metadata-only, and
claim-mismatched references. Do not report a clean audit while any material
claim remains unsupported.

## Exact-paper reconstruction gate

When the user supplies one published title and asks for a rewritten paper,
replication, or structured account, resolve the exact published record first.
Use `open_access_full_text` to save its complete JATS XML and Markdown,
then read that local full text in bounded sections. The title plus DOI, PMID, or
PMCID must match. A companion paper, preprint, citing paper, search snippet, or
third-party summary may help locate the target but is not evidence for what the
target paper itself reports.

Before delivery, build a compact internal claim ledger and verify all of these
against the exact target full text:

- authorship and bibliographic identifiers;
- study design, population, sample and denominators;
- every reported number, comparison group, effect direction, and conclusion;
- repository links, citation counts, preprint identifiers, and implementation
  status;
- limitations, distinguishing limitations stated by the authors from the
  assistant's own critique.

Remove any item that cannot be located in the target full text, or label it
explicitly as not reported. Never manufacture a conventional limitations
paragraph merely to fill a requested section. A five-section structure is not
permission to invent content absent from a narrative review, guideline, case
report, or methods paper.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill citation-integrity --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
