#!/usr/bin/env python3
"""How much of the field was read before the judgment was written.

Both research-planning skills need this and neither can import from the other —
skill packages are copied into the runtime independently — so this file is kept
byte-identical in `dataset-research-scoping/scripts/` and
`research-topic-selection/scripts/`, pinned by
`apps/server/test/datasetResearchScoping.test.mjs`. Edit one and you must copy
it to the other; the same discipline the server gate and the run-side preflight
already live under, after drifting three times in production.

The floors exist because a run searched PubMed alone, cited twelve works, linked
none of them, and returned an agenda in which nothing said what was new. Nobody
holding that report could see which searches were never run.
"""

from __future__ import annotations

import re
from pathlib import Path

MIN_DISTINCT_WORKS = 30
MIN_CHANNELS = 5
MIN_FULL_TEXTS = 5
EVIDENCE_MAP = "evidence-map.md"

# A citation identifier, in the forms the sources actually hand back. The DOI
# pattern stops at whitespace and at the punctuation that ends a sentence or
# closes a table cell, so a trailing period does not become part of the DOI.
CITATION_PATTERNS = (
    re.compile(r"(?:PMID|pubmed\.ncbi\.nlm\.nih\.gov)[:/\s]*(\d{6,9})", re.I),
    re.compile(r"\b(PMC\d{5,9})\b", re.I),
    re.compile(r"\b(10\.\d{4,9}/[^\s)\]}|,;\"'<>]+)"),
    re.compile(r"\b(NCT\d{8})\b", re.I),
    re.compile(r"\b(ISRCTN\d{8})\b", re.I),
    re.compile(r"openalex\.org/([WwAa]\d{6,12})", re.I),
)
URL_MENTION = re.compile(r"https?://[^\s)\]}|,\"'<>]+")
# The channels the skills list, recognized either by the name the run writes in
# the map's channel column or by the host of the URL it recorded.
EVIDENCE_CHANNELS = (
    ("pubmed", re.compile(r"pubmed", re.I)),
    ("europe-pmc", re.compile(r"europe[\s_-]?pmc", re.I)),
    ("openalex", re.compile(r"openalex", re.I)),
    ("semantic-scholar", re.compile(r"semantic[\s_-]?scholar", re.I)),
    ("crossref", re.compile(r"crossref|doi\.org", re.I)),
    ("preprint", re.compile(r"\b(?:bio|med)rxiv\b", re.I)),
    ("guideline", re.compile(r"指南|guideline", re.I)),
    ("drug-label", re.compile(r"\b(?:dailymed|openfda|rxnorm|说明书)\b", re.I)),
    ("pharmacogenomics", re.compile(r"pharmgkb|clinpgx|cpic", re.I)),
    ("trial-registry", re.compile(r"clinicaltrials|isrctn|chictr", re.I)),
    ("bibliometrics", re.compile(r"文献计量|bibliometric", re.I)),
)
# Full texts are not self-reported. `evimed_open_access_full_text` writes each
# retrieved article into .evimed-sources/<slug>/, so the count is recomputed
# from the workspace rather than read out of a "full text: yes" column.
FULL_TEXT_DIR = ".evimed-sources"
NOVELTY_STATEMENT = re.compile(r"(?:新颖性|创新点|前沿性|novelty)\s*[:：]", re.I)


def read_text(root: Path, name: str) -> str:
    path = root / name
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def citations_in(text: str) -> set[str]:
    """Every distinct work a piece of prose points at, normalized."""
    found: set[str] = set()
    for pattern in CITATION_PATTERNS:
        for value in pattern.findall(text):
            found.add(value.rstrip(".,;").lower())
    return found


def check_evidence_breadth(root: Path, prose_outputs, issues: list[str]) -> dict:
    """The floors: works, channels, full texts, and citations a reader can open."""
    mapped = read_text(root, EVIDENCE_MAP)
    cited: set[str] = set()
    for name in prose_outputs:
        cited |= citations_in(read_text(root, name))
    mapped_works = citations_in(mapped)

    openable: set[str] = set()
    unopenable: list[str] = []
    for line in mapped.splitlines():
        works = citations_in(line)
        if not works:
            continue
        if URL_MENTION.search(line):
            openable |= works
        else:
            unopenable.extend(sorted(works))

    channels = sorted(name for name, pattern in EVIDENCE_CHANNELS if pattern.search(mapped))
    sources_dir = root / FULL_TEXT_DIR
    full_texts = (
        len([child for child in sources_dir.iterdir() if child.is_dir()])
        if sources_dir.is_dir()
        else 0
    )

    if len(cited) < MIN_DISTINCT_WORKS:
        issues.append(
            f"the deliverables cite {len(cited)} distinct works; the floor is {MIN_DISTINCT_WORKS}. "
            "Search the subject, the method, the comparator, and what is registered or reviewed but "
            "unanswered — across the channels the skill lists, not one of them."
        )
    if len(channels) < MIN_CHANNELS:
        issues.append(
            f"{EVIDENCE_MAP} draws on {len(channels)} channels ({', '.join(channels) or 'none'}); "
            f"the floor is {MIN_CHANNELS}. Europe PMC searches full text, OpenAlex and Semantic Scholar "
            "carry the citation graph, Crossref is ahead of MEDLINE indexing, and the preprint servers "
            "hold what the peer-reviewed record does not have yet."
        )
    if full_texts < MIN_FULL_TEXTS:
        issues.append(
            f"{full_texts} full texts were retrieved into {FULL_TEXT_DIR}/; the floor is {MIN_FULL_TEXTS}. "
            "A method is transferred from a Methods section, not from an abstract — "
            "call evimed_open_access_full_text on the works the design actually depends on."
        )
    missing_from_map = sorted(cited - mapped_works)
    if missing_from_map:
        shown = ", ".join(missing_from_map[:5])
        issues.append(
            f"{len(missing_from_map)} works are cited in the report but absent from {EVIDENCE_MAP} "
            f"({shown}). The map is what tells a reader where each work came from and what it was used for."
        )
    if unopenable:
        shown = ", ".join(sorted(set(unopenable))[:5])
        issues.append(
            f"{len(set(unopenable))} rows of {EVIDENCE_MAP} carry an identifier with no URL ({shown}). "
            "A bare identifier makes the reader do the retrieval that was the point of the run."
        )
    return {
        "worksCited": len(cited),
        "worksMapped": len(mapped_works),
        "worksOpenable": len(openable),
        "channels": channels,
        "fullTextsRetrieved": full_texts,
    }


def check_novelty_statements(root: Path, report: str, required: int, issues: list[str]) -> dict:
    """Every question that reaches the agenda owes the argument that it is new."""
    text = read_text(root, report)
    statements = len(NOVELTY_STATEMENT.findall(text))
    needed = max(1, required) if text.strip() else 0
    if statements < needed:
        issues.append(
            f"{report} carries {statements} novelty statements for {required} surviving questions. "
            "Give each one a labelled `新颖性：` / `Novelty:` line naming the closest published work, "
            "the axis on which this differs, and what a reader gets that they could not already get."
        )
    return {"noveltyStatements": statements}
