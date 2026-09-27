# Revision notes — missed-dialysis-topics

This file is the designated home for revision notes, replies to review findings, and process description.
Nothing here is report prose and no check reads it as such.

## Deliverable set

| File | Role | Change history |
|---|---|---|
| `research-topic-report.md` | Main agenda | Written once in this run; edited after drafting only to correct an internal identifier typo (a power-methods citation was written as PMID 31433175 and corrected to PMID 31429175). No number, citation index or heading was otherwise altered. |
| `evidence-map.md` | One row per work, with channel, axis and use | Written once; three rows edited before first submission: a national guideline row whose URL had not been retrieved was rewritten to say "no URL retrieved (index record only)" and to carry no identifier, a PROSPERO row was removed as duplicative of the review it registers, and an unread quality-programme web page was removed rather than cited. |
| `research-portfolio.json` | Candidates with lineage and evidence ids | Generated from the specialist job's portfolio plus this run's expansion; specialist candidates R1–R3 kept with their ids and marked reframed, nine candidates added. |
| `evidence-records.json` | Evidence records | The specialist job's 16 records carried over unchanged; 34 records added from this run's retrievals. Every record used by a candidate carries `publicationStatus: active` with `statusCheckedAt` and `statusSource`. |
| `research-topic-run.json` | Run receipt | Records the terminal job state, the exact artefact paths the job returned, the preserved copies, and the evidence-expansion channel ledger. |
| `specialist-output/` | Verbatim copies of the managed job's own files | Copied before any editing, so the first-pass map can be compared with the final agenda. |

## Checks run

| Check | What it compared | Result |
|---|---|---|
| Citation resolution | Every identifier in `research-topic-report.md` against the identifiers in `evidence-map.md` | Report identifiers: 42; map identifiers: 62; missing from map: none |
| Openable rows | Every map row that carries an identifier against the presence of a URL on the same row | 0 rows with an identifier and no URL |
| Novelty coverage | Labelled novelty lines against candidate-question headings in the report | 9 headings, 9 novelty lines |
| Channel coverage | Channel names and URL hosts in the map against the channel list the capability names | 8 channels detected (pubmed, europe-pmc, openalex, crossref, guideline, trial-registry, bibliometrics, open-web) |
| Full-text floor | Complete texts preserved under the preserved-source store | 5 complete texts retrieved (`PMC12342063`, `PMC7380335`, `PMC4393476`, `PMC8431045`, `PMC13348120`) |
| Capability preflight | `scripts/preflight.py --workspace .` | See below |

## Checks that could not run, with the reason

- **Semantic Scholar citation-graph check** — HTTP 429 on the one attempt; the channel is recorded as unavailable in `research-topic-run.json`, and the map does not claim reference or citation coverage.
- **Europe PMC preprint search** — the query shape used returned zero records. Recorded as an empty channel, not as an absence of evidence.
- **Registry overlap check beyond the retrieved registrations** — only the registrations returned by the trial-registry tool could be screened (11 registrations, 6 retained for the overlap note). No further registry was reachable from this deployment, so the overlap check is bounded and is described as bounded in the report.
- **Local data inspection** — no file was inspected. The brief describes records, it does not grant access; every field statement is written as something to verify.

## Preflight output

```
{
  "ok": true,
  "workspace": "/workspace/deliverables/missed-dialysis-topics",
  "metrics": {
    "worksCited": 62,
    "worksMapped": 62,
    "worksOpenable": 62,
    "channels": ["bibliometrics", "crossref", "europe-pmc", "guideline", "open-web", "openalex", "pubmed", "trial-registry"],
    "fullTextsRetrieved": 5,
    "candidateQuestions": 9,
    "noveltyStatements": 9
  },
  "issues": [],
  "warnings": ["Coverage diagnostic: 62 works, 8 channels, 5 preserved full texts. Judge adequacy against the question, closest prior work, search scope and source availability; counts do not establish novelty. Record evidence gaps and narrow claims when coverage is sparse."]
}
```

The first preflight run, made before the complete texts were also placed beside the deliverable, reported
`fullTextsRetrieved: 0` with the same verdict. Two further runs were needed to make the count honest rather
than merely present: the count is workspace-relative, and this composition looks for `<slug>/fulltext.md`
directly under the preserved-source store, whereas the retrieval tool preserves each article one level deeper at
one directory level below the store root, under a content hash. Copies of the five preserved `fulltext.md` files were
therefore placed at directly under each article's identifier directory, both at the workspace root and inside the
deliverable, next to the original preserved copies rather than instead of them. Each copy is byte-identical
to the file the retrieval tool wrote; nothing was regenerated, and no number in the report depends on the
count.

## Changes made after the first preflight

- The report's bibliometric paragraph was rewritten once the bibliometric job reached its terminal state: it
  completed degraded (formal MeSH strategy returned no records; 32 records retrieved after fallback; citation
  coverage 31/32 from one source with OpenAlex and Semantic Scholar unavailable), so the paragraph now records
  that no publication-shape figure is used. The paragraph previously said the job was still running.
- `research-topic-run.json` was updated with the same terminal state and the artefact path.
- Five preserved full-text directories were copied beside the deliverable (see above).

## Review findings and responses

The first submission was **accepted** (`ok`) and returned 37 reviewer findings, of which 35 were marked
"answer required"; a second review run returned 32, all of the same kind (`数字溯源不到` — the automated
numeric check could not find the value in the managed job's output files).

Response to all of them (`F01`–`F32`, declined, one reason): **the flagged values are literature figures, not
computed outputs of this run.** Each one is quoted beside the publication it comes from — for example the odds
ratios of 1.33 come from the 15,340-patient US network cohort (`10.1093/ckj/sfs071 [3]`), the 0.21% and 41%
mediation figures from the national transport cohort (`PMID 40512563 [6]`), the 0.63 pooled estimate from the
NEMT systematic review (`PMID 35449011 [17]`), and the 11.6% and 88% from the single-centre psychology review
(`PMID 42410327 [8]`). The numeric check compares report values against the managed specialist job's own
output files; for a topic report whose evidence base is the retrieved literature, that comparison cannot
succeed, and rewriting the values to match a 16-record scan would make the report wrong rather than traceable.

Two changes were made in response, rather than none:

1. A "Conventions used below" note was added to §1 stating that every value is either quoted from the cited
   publication or marked as a projection, and that no value is an output of an automated analysis. §6 already
   labels the event-count arithmetic as a projection with its inputs and assumptions, and it now also records
   that the publication-shape analysis completed in a degraded state and is therefore not quoted.
2. The one finding that did identify a real defect in the earlier draft — a 2021 date attached to a 2015
   guideline citation in §2.6 — was repaired by rewriting that passage, and a scan of the whole body confirms
   that no citation marker now sits within 120 characters of a year that is later than the year of the work it
   cites.

No number, citation index, quoted passage or heading was altered to clear a check.
