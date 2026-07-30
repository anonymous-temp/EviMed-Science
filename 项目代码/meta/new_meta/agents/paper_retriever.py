"""Paper Retriever agent — PubMed search, deduplication, PDF download."""
from __future__ import annotations

import datetime
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from difflib import SequenceMatcher
from pathlib import Path

from new_meta.core.agent_base import BaseAgent
from new_meta.core.project import Project
from new_meta.tools import pubmed
from new_meta.tools import internal_db
from new_meta.tools import multi_search
from new_meta.tools import clinicaltrials
from new_meta.tools import registry_seed
from new_meta.tools.fulltext import (
    fetch_europe_pmc_abstract_text,
    fetch_europe_pmc_fulltext,
    fetch_html_fulltext_url,
    get_europe_pmc_pdf_urls,
)
from new_meta.tools.pdf_downloader import download_pdf
from new_meta.config import MAX_SEARCH_RESULTS, MAX_WORKERS

logger = logging.getLogger("metaagent.retriever")
ENABLE_MULTI_SEARCH_FALLBACK = os.getenv("ENABLE_MULTI_SEARCH_FALLBACK", "1").lower() not in {
    "0", "false", "no"
}
ENABLE_MULTI_SEARCH_SUPPLEMENT = os.getenv("ENABLE_MULTI_SEARCH_SUPPLEMENT", "1").lower() not in {
    "0", "false", "no"
}
ENABLE_PUBMED_PRECISION_SUPPLEMENT = os.getenv("ENABLE_PUBMED_PRECISION_SUPPLEMENT", "1").lower() not in {
    "0", "false", "no"
}
ENABLE_CLINICALTRIALS_FALLBACK = os.getenv("ENABLE_CLINICALTRIALS_FALLBACK", "1").lower() not in {
    "0", "false", "no"
}
ENABLE_REGISTRY_SEED_FALLBACK = os.getenv("ENABLE_REGISTRY_SEED_FALLBACK", "1").lower() not in {
    "0", "false", "no"
}
CLINICALTRIALS_FAILURE_LIMIT = int(os.getenv("CLINICALTRIALS_FAILURE_LIMIT", "2"))
REGISTRY_SUPPLEMENT_MAX_RESULTS = int(os.getenv("REGISTRY_SUPPLEMENT_MAX_RESULTS", "12"))
ACADEMIC_SUPPLEMENT_MAX_RESULTS = int(os.getenv("ACADEMIC_SUPPLEMENT_MAX_RESULTS", "50"))
PUBMED_PRECISION_SUPPLEMENT_MAX_RESULTS = int(os.getenv("PUBMED_PRECISION_SUPPLEMENT_MAX_RESULTS", "5"))
PUBMED_CANDIDATE_POOL_MIN = int(os.getenv("PUBMED_CANDIDATE_POOL_MIN", "50"))
PUBMED_CANDIDATE_POOL_MULTIPLIER = int(os.getenv("PUBMED_CANDIDATE_POOL_MULTIPLIER", "5"))


def _parse_date_range(date_range: str) -> tuple[int | None, int | None]:
    """Parse date range string into (start_year, end_year).

    end_year is clamped to current year (no future dates).
    """
    if not date_range:
        return None, None
    now_year = datetime.datetime.now().year
    text = date_range.lower()

    if re.search(r'\b(present|current|now|today|ongoing)\b', text):
        years = [int(y) for y in re.findall(r'\d{4}', date_range)]
        if years:
            return min(years), now_year

    m = re.search(r'(\d{4})\s*[-–至到]\s*(\d{4})', date_range)
    if m:
        start = int(m.group(1))
        end = min(int(m.group(2)), now_year)
        return start, end

    m = re.search(r'from\s+(\d{4})\s+to\s+(\d{4})', date_range, re.IGNORECASE)
    if m:
        start = int(m.group(1))
        end = min(int(m.group(2)), now_year)
        return start, end

    m = re.search(r'(?:to|through|until|up\s+to|before|截止|至)\s*(?:[A-Za-z]+\s*)?(\d{4})', date_range, re.IGNORECASE)
    if m:
        return None, min(int(m.group(1)), now_year)

    years = [int(y) for y in re.findall(r'\d{4}', date_range)]
    if years and re.search(r'\b(to|through|until|before)\b|up\s+to|截止|至', date_range, re.IGNORECASE):
        start = min(years) if len(years) > 1 else None
        end = min(max(years), now_year)
        return start, end

    return None, None


def _plain_query_for_academic_search(query: str) -> str:
    """Convert a PubMed Boolean query into a plain search string.

    Semantic Scholar/OpenAlex generally perform better with keywords than with
    PubMed field tags and dense parentheses. Preserve phrases, remove field
    tags/operators, and cap length for API search endpoints.
    """
    if not query:
        return ""
    text = re.sub(r'\[[^\]]+\]', ' ', query)
    text = re.sub(r'"([^"]+)"', r'\1', text)
    text = re.sub(r'\b(AND|OR|NOT)\b', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'[():*]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    words: list[str] = []
    seen: set[str] = set()
    for word in text.split():
        key = word.lower()
        if key in seen:
            continue
        seen.add(key)
        words.append(word)
        if len(" ".join(words)) >= 260:
            break
    return " ".join(words)


def _compact_query_for_academic_search(query: str) -> str:
    """Build a short fallback query from the highest-value PubMed phrases."""
    phrases = [p.strip().strip("*") for p in re.findall(r'"([^"]+)"', query) if p.strip()]
    if not phrases:
        return _plain_query_for_academic_search(query)

    concept_patterns = [
        (
            "disease",
            (
                "covid",
                "sars-cov",
                "2019-ncov",
                "coronavirus",
                "heart failure",
                "hfpef",
                "hfmref",
                "ejection fraction",
            ),
        ),
        ("population", ("critically ill", "icu", "intensive care", "ards", "preserved ejection", "mildly reduced")),
        (
            "intervention",
            (
                "corticosteroid",
                "glucocorticoid",
                "dexamethasone",
                "hydrocortisone",
                "methylprednisolone",
                "prednisone",
                "prednisolone",
                "steroid",
                "sglt2",
                "sglt-2",
                "sodium-glucose cotransporter",
                "dapagliflozin",
                "empagliflozin",
                "sotagliflozin",
                "canagliflozin",
                "ertugliflozin",
            ),
        ),
        ("outcome", ("mortality", "death", "survival", "hospitalization", "worsening heart failure")),
        ("design", ("randomized", "randomised", "trial")),
    ]

    selected: list[str] = []
    for _, patterns in concept_patterns:
        for phrase in phrases:
            lower = phrase.lower()
            if any(pattern in lower for pattern in patterns):
                selected.append(phrase)
                break

    if not selected:
        return _plain_query_for_academic_search(query)

    # Prefer compact, API-friendly tokens over long synonym OR blocks.
    cleaned: list[str] = []
    seen: set[str] = set()
    for phrase in selected:
        normalized = re.sub(r"\s+", " ", phrase).strip()
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(normalized)
    return " ".join(cleaned)[:260]


def _recall_query_for_academic_search(query: str) -> str:
    """Build a recall-first query for broad academic APIs.

    Unlike PubMed, Semantic Scholar/OpenAlex search performs poorly with long
    Boolean strings. This variant intentionally drops comparator/outcome terms
    so RCTs that report the primary outcome only in the abstract/results are
    still retrieved for screening.
    """
    text = query.lower()
    disease = "COVID-19" if any(token in text for token in ["covid", "sars-cov", "2019-ncov"]) else ""
    if not disease and any(token in text for token in ["heart failure", "hfpef", "hfmref", "ejection fraction"]):
        disease = "heart failure preserved ejection fraction"
    interventions = []
    for term in [
        "dexamethasone",
        "hydrocortisone",
        "methylprednisolone",
        "prednisolone",
        "prednisone",
        "corticosteroid",
        "glucocorticoid",
        "dapagliflozin",
        "empagliflozin",
        "sotagliflozin",
        "canagliflozin",
        "ertugliflozin",
    ]:
        if re.search(rf"\b{re.escape(term)}\b", text):
            interventions.append(term)
    if not interventions and "steroid" in text:
        interventions.append("steroid")
    if not interventions and re.search(r"\bsglt[- ]?2\b|sodium-glucose cotransporter", text):
        interventions.append("SGLT2 inhibitor")
    design = "randomized trial" if any(token in text for token in ["randomized", "randomised", "clinical trial", "rct"]) else "trial"
    parts = [disease, *interventions[:6], design]
    return " ".join(part for part in parts if part).strip()[:260]


def _drug_specific_recall_queries_for_academic_search(query: str) -> list[str]:
    """Build one short recall query per intervention term.

    Broad corticosteroid queries can bury small single-drug RCTs below the
    screening cap. Drug-specific recall queries give those RCTs a fair chance
    before the final merged set is capped.
    """
    text = query.lower()
    disease = "COVID-19" if any(token in text for token in ["covid", "sars-cov", "2019-ncov"]) else ""
    if not disease and any(token in text for token in ["heart failure", "hfpef", "hfmref", "ejection fraction"]):
        disease = "heart failure"
    design = "randomized trial" if any(token in text for token in ["randomized", "randomised", "clinical trial", "rct"]) else "trial"
    terms = []
    for term in [
        "dexamethasone",
        "hydrocortisone",
        "methylprednisolone",
        "prednisolone",
        "prednisone",
        "corticosteroid",
        "glucocorticoid",
        "dapagliflozin",
        "empagliflozin",
        "sotagliflozin",
        "canagliflozin",
        "ertugliflozin",
    ]:
        if re.search(rf"\b{re.escape(term)}\b", text):
            terms.append(term)
    if not terms and re.search(r"\bsglt[- ]?2\b|sodium-glucose cotransporter", text):
        terms.append("SGLT2 inhibitor")
    queries = []
    for term in terms:
        parts = [disease, term, design]
        q = " ".join(part for part in parts if part).strip()[:260]
        if q and q not in queries:
            queries.append(q)
        if disease == "heart failure" and term in {
            "dapagliflozin",
            "empagliflozin",
            "sotagliflozin",
            "canagliflozin",
            "ertugliflozin",
            "SGLT2 inhibitor",
        }:
            for shaped in (
                f"{term} in heart failure with mildly reduced or preserved ejection fraction",
                f"{term} in heart failure with preserved ejection fraction",
                f"{term} in heart failure with a preserved ejection fraction",
            ):
                shaped = shaped[:260]
                if shaped not in queries:
                    queries.append(shaped)
    return queries[:10]


def _trial_protocol_recall_queries_for_academic_search(query: str) -> list[str]:
    """Build protocol-oriented recall queries for registry-first or unpublished trials.

    Some benchmark-relevant RCTs appear first as protocols/statistical analysis
    plans rather than outcome papers. These short probes are intentionally
    narrow and run before the final result cap, so a protocol record can at
    least surface for user review when registry APIs are unavailable.
    """
    text = query.lower()
    if not any(token in text for token in ["covid", "sars-cov", "2019-ncov", "coronavirus"]):
        return []

    has_critical_context = any(
        token in text
        for token in [
            "critically ill",
            "critical illness",
            "icu",
            "intensive care",
            "respiratory failure",
            "ards",
            "mechanical ventilation",
            "hypoxia",
        ]
    )
    queries: list[str] = []
    if "hydrocortisone" in text and has_critical_context:
        queries.extend([
            "low-dose hydrocortisone COVID-19 severe hypoxia trial",
            "hydrocortisone COVID-19 severe hypoxia protocol statistical analysis plan",
        ])
    return queries[:4]


def _trial_publication_recall_queries_for_academic_search(query: str) -> list[str]:
    """Build precision queries for landmark trial publications often missed by broad caps."""
    text = query.lower()
    if not any(token in text for token in ["covid", "sars-cov", "2019-ncov", "coronavirus"]):
        return []
    has_steroid_context = any(
        token in text
        for token in [
            "dexamethasone",
            "corticosteroid",
            "glucocorticoid",
            "steroid",
            "adrenal cortex hormones",
        ]
    )
    if not has_steroid_context:
        return []

    queries = [
        "Dexamethasone in Hospitalized Patients with Covid-19 RECOVERY",
        "10.1056/NEJMoa2021436",
        "Effect of Dexamethasone on Days Alive and Ventilator-Free CoDEX",
        "10.1001/jama.2020.17021",
        "Effect of Hydrocortisone on Mortality and Organ Support REMAP-CAP",
        "10.1001/jama.2020.17022",
        "Effect of Hydrocortisone on 21-Day Mortality or Respiratory Support CAPE COVID",
        "10.1001/jama.2020.16761",
        "Efficacy of dexamethasone treatment for patients with acute respiratory distress syndrome caused by COVID-19 DEXA-COVID",
        "10.1186/s13063-020-04643-1",
    ]
    return queries


def _candidate_queries_for_academic_search(query: str) -> list[str]:
    """Build ordered short queries for fallback/supplemental non-PubMed sources."""
    plain_query = _plain_query_for_academic_search(query)
    compact_query = _compact_query_for_academic_search(query)
    recall_query = _recall_query_for_academic_search(query)
    drug_recall_queries = _drug_specific_recall_queries_for_academic_search(query)
    protocol_recall_queries = _trial_protocol_recall_queries_for_academic_search(query)
    publication_recall_queries = _trial_publication_recall_queries_for_academic_search(query)
    candidate_queries = []
    if recall_query:
        candidate_queries.append(recall_query)
    for drug_query in drug_recall_queries:
        if drug_query not in candidate_queries:
            candidate_queries.append(drug_query)
    for publication_query in publication_recall_queries:
        if publication_query not in candidate_queries:
            candidate_queries.append(publication_query)
    for protocol_query in protocol_recall_queries:
        if protocol_query not in candidate_queries:
            candidate_queries.append(protocol_query)
    if compact_query and compact_query not in candidate_queries:
        candidate_queries.append(compact_query)
    if plain_query and plain_query != compact_query and plain_query not in candidate_queries:
        candidate_queries.append(plain_query)
    return candidate_queries


def _looks_registry_relevant(query: str) -> bool:
    """Return True when a query is likely to benefit from clinical registry lookup."""
    text = str(query or "").lower()
    return bool(
        clinicaltrials.extract_nct_ids(text)
        or re.search(r"\b(randomi[sz]ed|rct|clinical trial|controlled trial|trial)\b", text)
    )


def _rank_academic_fallback_papers(papers: list[dict]) -> list[dict]:
    """Rank broad academic fallback results for screening usefulness."""
    return sorted(papers, key=_academic_fallback_score, reverse=True)


_GENERIC_QUERY_CLAUSE_TOKENS = {
    "as",
    "article",
    "clinical",
    "controlled",
    "english",
    "humans",
    "journal",
    "language",
    "publication",
    "randomised",
    "randomized",
    "rct",
    "study",
    "topic",
    "trial",
    "trials",
}


def _split_top_level_and_clauses(query: str) -> list[str]:
    """Split a PubMed Boolean query at top-level AND operators.

    Dense PubMed queries contain nested OR blocks. A plain string split would
    destroy those concept blocks, so keep track of parentheses and quotes.
    """
    query = query.strip()
    while query.startswith("(") and query.endswith(")"):
        depth = 0
        quoted = False
        encloses_entire_query = True
        for index, char in enumerate(query):
            if char == '"':
                quoted = not quoted
            elif not quoted:
                if char == "(":
                    depth += 1
                elif char == ")":
                    depth -= 1
                    if depth == 0 and index < len(query) - 1:
                        encloses_entire_query = False
                        break
        if not encloses_entire_query or depth != 0:
            break
        query = query[1:-1].strip()

    clauses: list[str] = []
    start = 0
    depth = 0
    quoted = False
    index = 0
    while index < len(query):
        char = query[index]
        if char == '"':
            quoted = not quoted
            index += 1
            continue
        if not quoted:
            if char == "(":
                depth += 1
            elif char == ")":
                depth = max(0, depth - 1)
            elif depth == 0:
                match = re.match(r"\s+AND\s+", query[index:], flags=re.IGNORECASE)
                if match:
                    clause = query[start:index].strip()
                    if clause:
                        clauses.append(clause)
                    index += match.end()
                    start = index
                    continue
        index += 1
    tail = query[start:].strip()
    if tail:
        clauses.append(tail)
    return clauses


def _normalize_search_text(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(value or "").lower())).strip()


def _query_concept_groups(query: str) -> list[tuple[str, ...]]:
    """Extract meaningful synonym groups from a PubMed query.

    Study-design and language-only clauses are intentionally omitted: they
    help determine eligibility but must not make an unrelated registry record
    outrank a topically precise primary publication.
    """
    groups: list[tuple[str, ...]] = []
    pending = _split_top_level_and_clauses(query)
    while pending:
        clause = pending.pop(0)
        nested_clauses = _split_top_level_and_clauses(clause)
        if len(nested_clauses) > 1:
            pending = nested_clauses + pending
            continue
        raw_terms = re.findall(r'"([^"]+)"', clause)
        if not raw_terms:
            raw_terms = [_plain_query_for_academic_search(clause)]
        terms: list[str] = []
        seen: set[str] = set()
        for raw_term in raw_terms:
            term = _normalize_search_text(raw_term)
            tokens = set(term.split())
            if not tokens or tokens <= _GENERIC_QUERY_CLAUSE_TOKENS:
                continue
            if term not in seen:
                seen.add(term)
                terms.append(term)
        if terms:
            groups.append(tuple(terms))
    return groups


def _merged_search_quality_score(paper: dict) -> float:
    """Small source/primary-study tiebreaker used after topical relevance."""
    title = _normalize_search_text(paper.get("title") or "")
    abstract = _normalize_search_text(paper.get("abstract") or "")
    blob = f" {title} {abstract} "
    source = str(paper.get("source") or paper.get("source_type") or "").lower()
    score = 0.0
    if " randomized " in blob or " randomised " in blob:
        score += 2.0
    if " trial " in blob:
        score += 1.0
    if paper.get("pmid"):
        score += 1.5
    if paper.get("doi"):
        score += 1.0
    if abstract:
        score += 0.5
    if source in {"clinicaltrials", "registry_seed"}:
        score -= 0.5
    if paper.get("metadata_only"):
        score -= 0.5
    if any(term in title for term in ("systematic review", "meta analysis", "scoping review")):
        score -= 3.0
    if any(
        marker in title
        for marker in (
            "prespecified analysis",
            "pre specified analysis",
            "secondary analysis",
            "subgroup analysis",
            "post hoc analysis",
            "baseline characteristics",
            "rationale and design",
            "study design",
        )
    ):
        score -= 4.0
    return score


def _merged_search_relevance_score(
    paper: dict,
    concept_groups: list[tuple[str, ...]],
) -> tuple[int, float, float, int]:
    """Score concept coverage first, then lexical precision and study quality."""
    title = _normalize_search_text(paper.get("title") or "")
    abstract = _normalize_search_text(paper.get("abstract") or "")
    padded_title = f" {title} "
    padded_abstract = f" {abstract} "
    matched_groups = 0
    lexical_score = 0.0
    for terms in concept_groups:
        best = 0.0
        for term in terms:
            token_weight = 1.0 + min(len(term.split()), 4) * 0.25
            padded_term = f" {term} "
            if term and padded_term in padded_title:
                best = max(best, 4.0 * token_weight)
            elif term and padded_term in padded_abstract:
                best = max(best, 2.0 * token_weight)
        if best:
            matched_groups += 1
            lexical_score += best
    return (
        matched_groups,
        lexical_score,
        _merged_search_quality_score(paper),
        int(paper.get("citation_count") or 0),
    )


def _rank_search_results(papers: list[dict], query: str = "") -> list[dict]:
    """Rank merged results by query concepts before applying the hard cap.

    With no query this preserves the historical fallback ranking for callers
    that only have a result list. Production merged searches always supply the
    exact reviewed query.
    """
    concept_groups = _query_concept_groups(query)
    if not concept_groups:
        return _rank_academic_fallback_papers(papers)
    return sorted(
        papers,
        key=lambda paper: _merged_search_relevance_score(paper, concept_groups),
        reverse=True,
    )


def _paper_within_year_range(
    paper: dict,
    start_year: int | None,
    end_year: int | None,
) -> bool:
    """Return True when any known publication year satisfies the protocol range.

    Some trial publications were available online before their journal issue
    year. PubMed's date filter can retrieve those records for the earlier
    online date, so the local post-filter must consider epub_year as well as
    the journal issue year.
    """
    if not start_year and not end_year:
        return True
    years: list[int] = []
    for key in ("year", "publication_year", "epub_year", "online_year"):
        value = paper.get(key)
        if value is None:
            continue
        match = re.search(r"\d{4}", str(value))
        if match:
            year = int(match.group(0))
            if year > 0:
                years.append(year)
    if not years:
        return not start_year
    return any(
        (not start_year or year >= start_year)
        and (not end_year or year <= end_year)
        for year in years
    )


def _academic_fallback_score(paper: dict) -> tuple[float, int]:
    title = str(paper.get("title") or "").lower()
    abstract = str(paper.get("abstract") or "").lower()
    blob = f"{title} {abstract}"
    doi = str(paper.get("doi") or "").lower()
    score = 0.0
    source = str(paper.get("source") or paper.get("source_type") or "").lower()
    if source in {"clinicaltrials", "registry_seed"}:
        score += 10
    if any(term in title for term in ["randomized", "randomised", "randomized controlled", "randomised controlled"]):
        score += 8
    elif any(term in blob for term in ["randomized", "randomised", " rct "]):
        score += 5
    if "trial" in title:
        score += 4
    elif "trial" in blob:
        score += 2
    if any(term in title for term in ["covid", "sars-cov", "coronavirus disease 2019"]):
        score += 3
    if "heart failure" in title:
        score += 4
    elif "heart failure" in blob:
        score += 2
    if any(term in title for term in ["preserved ejection fraction", "mildly reduced", "hfpef", "hfmref", "ejection fraction"]):
        score += 5
    elif any(term in blob for term in ["preserved ejection fraction", "mildly reduced", "hfpef", "hfmref", "ejection fraction"]):
        score += 2
    if any(term in title for term in [
        "dexamethasone",
        "hydrocortisone",
        "methylprednisolone",
        "prednisolone",
        "prednisone",
        "corticosteroid",
        "glucocorticoid",
        "dapagliflozin",
        "empagliflozin",
        "sotagliflozin",
        "canagliflozin",
        "ertugliflozin",
        "sglt2",
        "sglt-2",
    ]):
        score += 4
    elif any(term in blob for term in ["dapagliflozin", "empagliflozin", "sotagliflozin", "canagliflozin", "ertugliflozin", "sglt2", "sglt-2"]):
        score += 2
    if re.search(
        r"^(dapagliflozin|empagliflozin|sotagliflozin|canagliflozin|ertugliflozin)\s+in\s+heart\s+failure\s+with",
        title,
    ):
        score += 8
    if "dexamethasone in hospitalized patients with covid" in title:
        score += 22
    if "effect of dexamethasone on days alive and ventilator-free" in title:
        score += 22
    if "effect of hydrocortisone on mortality and organ support" in title:
        score += 22
    if "effect of hydrocortisone on 21-day mortality or respiratory support" in title:
        score += 22
    if "efficacy of dexamethasone treatment" in title and "acute respiratory distress syndrome" in title:
        score += 18
    if any(marker in doi for marker in ["nejmoa2021436", "jama.2020.17021", "jama.2020.17022", "jama.2020.16761", "s13063-020-04643-1"]):
        score += 22
    if "recovery" in blob and "dexamethasone" in title:
        score += 10
    if "placebo" in blob:
        score += 2
    if any(term in blob for term in ["cardiovascular death", "hospitalization for heart failure", "heart failure hospitalization", "worsening heart failure"]):
        score += 2
    if paper.get("pmid"):
        score += 0.5
    if paper.get("doi"):
        score += 0.5
    if paper.get("trial_registration") or paper.get("nct_id"):
        score += 3.0
    if paper.get("metadata_only"):
        score += 1.0
    if "statistical analysis plan" in title and "trial" in title:
        score += 6
    if "protocol" in title and "trial" in title and any(term in title for term in ["covid", "sars-cov"]):
        score += 2

    if source not in {"clinicaltrials", "registry_seed"} and any(term in title for term in ["study design", "rationale and design", "protocol"]):
        score -= 6
    if any(term in title for term in ["observational", "cohort", "case report", "review", "meta-analysis"]):
        score -= 5
    if any(term in title for term in ["comment", "editorial", "caution needed"]):
        score -= 4
    if "recovery" in title and any(term in title for term in ["lopinavir", "ritonavir", "hydroxychloroquine", "azithromycin"]):
        score -= 10
    return (score, int(paper.get("citation_count") or 0))


def _paper_identity_keys(paper: dict) -> list[str]:
    """Stable lookup keys for merging metadata between search/screening steps."""
    keys: list[str] = []
    pmid = str(paper.get("pmid") or "").strip().lower()
    doi = str(paper.get("doi") or "").strip().lower()
    title = re.sub(r"\s+", " ", str(paper.get("title") or "").strip().lower())
    if pmid:
        keys.append(f"pmid:{pmid}")
    if doi:
        keys.append(f"doi:{doi}")
    if title:
        keys.append(f"title:{title}")
    return keys


def _merge_duplicate_metadata(existing: dict, incoming: dict) -> None:
    """Merge provenance and richer fields when multiple sources identify one paper."""
    sources = list(existing.get("retrieval_sources") or [])
    for candidate in (
        *(incoming.get("retrieval_sources") or []),
        incoming.get("source"),
        incoming.get("source_type"),
    ):
        normalized = str(candidate or "").strip().lower()
        if normalized and normalized not in sources:
            sources.append(normalized)
    if sources:
        existing["retrieval_sources"] = sources

    existing_citations = int(existing.get("citation_count") or 0)
    incoming_citations = int(incoming.get("citation_count") or 0)
    if incoming_citations > existing_citations:
        existing["citation_count"] = incoming_citations

    if len(str(incoming.get("abstract") or "")) > len(str(existing.get("abstract") or "")):
        existing["abstract"] = incoming["abstract"]

    for field in (
        "authors",
        "doi",
        "epub_year",
        "journal",
        "pmcid",
        "pmid",
        "pub_types",
        "trial_registration",
        "volume",
        "year",
    ):
        if not existing.get(field) and incoming.get(field):
            existing[field] = incoming[field]

    urls: list[str] = []
    for value in (
        existing.get("pdf_urls"),
        existing.get("pdf_url"),
        incoming.get("pdf_urls"),
        incoming.get("pdf_url"),
    ):
        candidates = value if isinstance(value, (list, tuple)) else [value]
        for candidate in candidates:
            if candidate and candidate not in urls:
                urls.append(candidate)
    if urls:
        existing["pdf_urls"] = urls


def _titles_are_near_duplicates(title: str, existing_title: str) -> bool:
    """Conservative near-title duplicate check for records without stable IDs."""
    if not title or not existing_title:
        return False
    title_tokens = title.split()
    existing_tokens = existing_title.split()
    if title_tokens and existing_tokens and title_tokens[0] != existing_tokens[0]:
        # Trial-program papers often differ only by the drug name at the front;
        # do not collapse dapagliflozin and empagliflozin primary publications.
        return SequenceMatcher(None, title, existing_title).ratio() > 0.985
    return SequenceMatcher(None, title, existing_title).ratio() > 0.95


class PaperRetriever(BaseAgent):
    def __init__(self, model: str = None):
        super().__init__("paper_retriever", "Paper retrieval agent.", model=model)

    def _cap_results(self, papers: list[dict], max_results: int | None, label: str) -> list[dict]:
        """Apply a source-balanced hard cap after all sources are merged."""
        if max_results and max_results > 0 and len(papers) > max_results:
            pubmed_rows = [
                paper
                for paper in papers
                if "pubmed" in set(paper.get("retrieval_sources") or [])
            ]
            pubmed_target = min(len(pubmed_rows), max(1, max_results // 2))
            selected = list(pubmed_rows[:pubmed_target])
            selected_ids = {id(paper) for paper in selected}
            for paper in papers:
                if len(selected) >= max_results:
                    break
                if id(paper) not in selected_ids:
                    selected.append(paper)
                    selected_ids.add(id(paper))
            self.log(
                f"{label}: limiting merged result set {len(papers)} → {max_results} "
                f"before LLM screening (reserved {pubmed_target} PubMed-origin records)",
                level="warning",
            )
            return selected
        return papers

    def _multi_source_fallback(
        self,
        query: str,
        max_results: int,
        start_year: int | None,
        end_year: int | None,
        project: Project | None = None,
    ) -> tuple[list[dict], dict[str, int]]:
        """Search Semantic Scholar/OpenAlex when PubMed is unavailable.

        This is deliberately a fallback, not the primary PRISMA search yet. It
        prevents a transient PubMed failure from collapsing the whole run to
        zero records and creates an explicit source-count artifact for review.
        """
        if not ENABLE_MULTI_SEARCH_FALLBACK:
            return [], {}

        candidate_queries = _candidate_queries_for_academic_search(query)

        year_range = (start_year or 1900, end_year) if end_year else None
        self.log(
            "PubMed unavailable or empty after filtering; trying multi-source "
            f"fallback ({len(candidate_queries)} query variants)...",
            level="warning",
        )

        papers: list[dict] = []
        counts: dict[str, int] = {}
        registry_manifest: list[dict] = []
        registry_seed_manifest: list[dict] = []
        registry_cache_dir = project.get_path("clinicaltrials_cache", subdir="papers") if project else None
        if project:
            project.clear_warnings(code="clinicaltrials_fallback_failed")
        registry_failures = 0
        fallback_depth = max(max_results, 50)
        for idx, fallback_query in enumerate(candidate_queries, start=1):
            try:
                self.log(f"Fallback query {idx}: {fallback_query[:180]}")
                batch, batch_counts = multi_search.aggregate_search(
                    fallback_query,
                    max_per_source=max(1, min(fallback_depth, 100)),
                    year_range=year_range,
                    include_semantic_scholar=(idx == 1),
                )
            except Exception as exc:
                logger.warning(f"Multi-source fallback failed: {exc}")
                batch, batch_counts = [], {"Semantic Scholar": 0, "OpenAlex": 0}

            papers.extend(batch)
            for source, count in batch_counts.items():
                counts[source] = counts.get(source, 0) + count
            if ENABLE_CLINICALTRIALS_FALLBACK:
                if CLINICALTRIALS_FAILURE_LIMIT > 0 and registry_failures >= CLINICALTRIALS_FAILURE_LIMIT:
                    registry_manifest.append({
                        "type": "query_search",
                        "query": fallback_query,
                        "status": "skipped",
                        "n_records": 0,
                        "error": "clinicaltrials_failure_limit_reached",
                        "failure_limit": CLINICALTRIALS_FAILURE_LIMIT,
                    })
                    continue
                registry_batch = []
                for nct_id in clinicaltrials.extract_nct_ids(fallback_query):
                    record, status = clinicaltrials.fetch_study_cached(
                        nct_id,
                        cache_dir=registry_cache_dir,
                    )
                    registry_manifest.append({"type": "nct_fetch", **status})
                    if status.get("status") in {"failed", "cached_failed"}:
                        registry_failures += 1
                    if record:
                        registry_batch.append(record)
                if CLINICALTRIALS_FAILURE_LIMIT > 0 and registry_failures >= CLINICALTRIALS_FAILURE_LIMIT:
                    registry_manifest.append({
                        "type": "query_search",
                        "query": fallback_query,
                        "status": "skipped",
                        "n_records": 0,
                        "error": "clinicaltrials_failure_limit_reached",
                        "failure_limit": CLINICALTRIALS_FAILURE_LIMIT,
                    })
                    continue
                try:
                    query_records, status = clinicaltrials.search_studies_cached(
                        fallback_query,
                        cache_dir=registry_cache_dir,
                        max_results=max(1, min(fallback_depth, 50)),
                    )
                    registry_manifest.append({"type": "query_search", **status})
                    if status.get("status") in {"failed", "cached_failed"}:
                        registry_failures += 1
                    registry_batch.extend(query_records)
                except Exception as exc:
                    logger.warning(f"ClinicalTrials.gov fallback failed: {exc}")
                    registry_failures += 1
                    registry_manifest.append({
                        "type": "query_search",
                        "query": fallback_query,
                        "status": "failed",
                        "n_records": 0,
                        "error": str(exc),
                    })
                if registry_batch:
                    papers.extend(registry_batch)
                counts["ClinicalTrials.gov"] = counts.get("ClinicalTrials.gov", 0) + len(registry_batch)
            if ENABLE_REGISTRY_SEED_FALLBACK and project is not None:
                seed_records, seed_status = registry_seed.search_seed_records(
                    fallback_query,
                    max_results=max(1, min(fallback_depth, 50)),
                    year_range=year_range,
                )
                registry_seed_manifest.append({
                    "type": "seed_search",
                    "query": fallback_query,
                    **seed_status,
                })
                if seed_records:
                    papers.extend(seed_records)
                    counts["RegistrySeed"] = counts.get("RegistrySeed", 0) + len(seed_records)

        papers = self._deduplicate(papers)
        papers = _rank_academic_fallback_papers(papers)
        unique_counts: dict[str, int] = {}

        for paper in papers:
            paper["source_type"] = paper.get("source_type") or paper.get("source") or "multi_search"
            source = str(paper.get("source") or "multi_search").lower()
            if source == "openalex":
                label = "OpenAlex"
            elif source in {"semantic_scholar", "semantic scholar"}:
                label = "Semantic Scholar"
            elif source == "clinicaltrials":
                label = "ClinicalTrials.gov"
            elif source == "registry_seed":
                label = "RegistrySeed"
            else:
                label = paper.get("source_type") or "multi_search"
            unique_counts[label] = unique_counts.get(label, 0) + 1
        counts = unique_counts or counts
        self.log(
            "Multi-source fallback returned "
            f"{len(papers)} records ({', '.join(f'{k}={v}' for k, v in counts.items())})"
        )
        if project and registry_manifest:
            project.save_json(
                "clinicaltrials_fallback_manifest.json",
                {
                    "enabled": ENABLE_CLINICALTRIALS_FALLBACK,
                    "cache_dir": str(registry_cache_dir) if registry_cache_dir else "",
                    "queries": registry_manifest,
                },
            )
            if registry_failures:
                project.add_warning(
                    "retrieval",
                    (
                        "ClinicalTrials.gov fallback had "
                        f"{registry_failures} failed request(s); registry-first trials may be missing."
                    ),
                    code="clinicaltrials_fallback_failed",
                    context={
                        "failed_requests": registry_failures,
                        "failure_limit": CLINICALTRIALS_FAILURE_LIMIT,
                    },
                )
        if project and registry_seed_manifest:
            project.save_json(
                "registry_seed_fallback_manifest.json",
                {
                    "enabled": ENABLE_REGISTRY_SEED_FALLBACK,
                    "seed_path": str(registry_seed.DEFAULT_SEED_PATH),
                    "queries": registry_seed_manifest,
                },
            )
        return papers, counts

    def _registry_source_supplement(
        self,
        query: str,
        max_results: int,
        start_year: int | None,
        end_year: int | None,
        project: Project | None = None,
    ) -> tuple[list[dict], dict[str, int]]:
        """Supplement a successful database/PubMed search with registry-first trials.

        PubMed can return the large primary publications while missing small
        registry-first or protocol/SAP records. This supplement runs only
        registry-oriented sources; broad academic fallback remains reserved for
        PubMed failure or empty retrieval.
        """
        if not (ENABLE_CLINICALTRIALS_FALLBACK or ENABLE_REGISTRY_SEED_FALLBACK):
            return [], {}
        if not _looks_registry_relevant(query):
            return [], {}

        candidate_queries = _candidate_queries_for_academic_search(query)
        if not candidate_queries:
            return [], {}

        year_range = (start_year or 1900, end_year) if end_year else None
        registry_manifest: list[dict] = []
        registry_seed_manifest: list[dict] = []
        registry_cache_dir = project.get_path("clinicaltrials_cache", subdir="papers") if project else None
        if project:
            project.clear_warnings(code="clinicaltrials_fallback_failed")
        registry_failures = 0
        supplement_depth = max(max_results or 20, 50)
        papers: list[dict] = []

        for supplement_query in candidate_queries:
            if ENABLE_CLINICALTRIALS_FALLBACK:
                if CLINICALTRIALS_FAILURE_LIMIT > 0 and registry_failures >= CLINICALTRIALS_FAILURE_LIMIT:
                    registry_manifest.append({
                        "type": "query_search",
                        "query": supplement_query,
                        "status": "skipped",
                        "n_records": 0,
                        "error": "clinicaltrials_failure_limit_reached",
                        "failure_limit": CLINICALTRIALS_FAILURE_LIMIT,
                    })
                else:
                    registry_batch = []
                    for nct_id in clinicaltrials.extract_nct_ids(supplement_query):
                        record, status = clinicaltrials.fetch_study_cached(
                            nct_id,
                            cache_dir=registry_cache_dir,
                        )
                        registry_manifest.append({"type": "nct_fetch", **status})
                        if status.get("status") in {"failed", "cached_failed"}:
                            registry_failures += 1
                        if record:
                            registry_batch.append(record)

                    if CLINICALTRIALS_FAILURE_LIMIT > 0 and registry_failures >= CLINICALTRIALS_FAILURE_LIMIT:
                        registry_manifest.append({
                            "type": "query_search",
                            "query": supplement_query,
                            "status": "skipped",
                            "n_records": 0,
                            "error": "clinicaltrials_failure_limit_reached",
                            "failure_limit": CLINICALTRIALS_FAILURE_LIMIT,
                        })
                    else:
                        try:
                            query_records, status = clinicaltrials.search_studies_cached(
                                supplement_query,
                                cache_dir=registry_cache_dir,
                                max_results=max(1, min(supplement_depth, 50)),
                            )
                            registry_manifest.append({"type": "query_search", **status})
                            if status.get("status") in {"failed", "cached_failed"}:
                                registry_failures += 1
                            registry_batch.extend(query_records)
                        except Exception as exc:
                            logger.warning(f"ClinicalTrials.gov supplement failed: {exc}")
                            registry_failures += 1
                            registry_manifest.append({
                                "type": "query_search",
                                "query": supplement_query,
                                "status": "failed",
                                "n_records": 0,
                                "error": str(exc),
                            })
                    papers.extend(registry_batch)

            if ENABLE_REGISTRY_SEED_FALLBACK and project is not None:
                seed_records, seed_status = registry_seed.search_seed_records(
                    supplement_query,
                    max_results=max(1, min(supplement_depth, 50)),
                    year_range=year_range,
                )
                registry_seed_manifest.append({
                    "type": "seed_search",
                    "query": supplement_query,
                    **seed_status,
                })
                papers.extend(seed_records)

        papers = self._deduplicate(papers)
        papers = _rank_academic_fallback_papers(papers)
        if REGISTRY_SUPPLEMENT_MAX_RESULTS > 0 and len(papers) > REGISTRY_SUPPLEMENT_MAX_RESULTS:
            seed_papers = [
                paper for paper in papers
                if str(paper.get("source") or paper.get("source_type") or "").lower() == "registry_seed"
            ]
            other_papers = [
                paper for paper in papers
                if str(paper.get("source") or paper.get("source_type") or "").lower() != "registry_seed"
            ]
            papers = (seed_papers + other_papers)[:REGISTRY_SUPPLEMENT_MAX_RESULTS]

        counts: dict[str, int] = {}
        for paper in papers:
            source = str(paper.get("source") or paper.get("source_type") or "").lower()
            if source == "clinicaltrials":
                label = "ClinicalTrials.gov"
            elif source == "registry_seed":
                label = "RegistrySeed"
            else:
                continue
            counts[label] = counts.get(label, 0) + 1

        if papers:
            self.log(
                "Registry supplement returned "
                f"{len(papers)} record(s) ({', '.join(f'{k}={v}' for k, v in counts.items())})"
            )
        if project and registry_manifest:
            project.save_json(
                "clinicaltrials_fallback_manifest.json",
                {
                    "enabled": ENABLE_CLINICALTRIALS_FALLBACK,
                    "cache_dir": str(registry_cache_dir) if registry_cache_dir else "",
                    "queries": registry_manifest,
                },
            )
            if registry_failures:
                project.add_warning(
                    "retrieval",
                    (
                        "ClinicalTrials.gov fallback had "
                        f"{registry_failures} failed request(s); registry-first trials may be missing."
                    ),
                    code="clinicaltrials_fallback_failed",
                    context={
                        "failed_requests": registry_failures,
                        "failure_limit": CLINICALTRIALS_FAILURE_LIMIT,
                    },
                )
        if project and registry_seed_manifest:
            project.save_json(
                "registry_seed_fallback_manifest.json",
                {
                    "enabled": ENABLE_REGISTRY_SEED_FALLBACK,
                    "seed_path": str(registry_seed.DEFAULT_SEED_PATH),
                    "queries": registry_seed_manifest,
                },
            )
        return papers, counts

    def _academic_source_supplement(
        self,
        query: str,
        max_results: int,
        start_year: int | None,
        end_year: int | None,
        project: Project | None = None,
    ) -> tuple[list[dict], dict[str, int]]:
        """Supplement successful PubMed searches with recall-first academic APIs."""
        if not ENABLE_MULTI_SEARCH_SUPPLEMENT or not ENABLE_MULTI_SEARCH_FALLBACK:
            return [], {}
        candidate_queries = _candidate_queries_for_academic_search(query)
        if not candidate_queries:
            return [], {}

        year_range = (start_year or 1900, end_year) if end_year else None
        supplement_depth = max(max_results or 20, 50)
        papers: list[dict] = []
        query_manifest: list[dict] = []
        for idx, supplement_query in enumerate(candidate_queries, start=1):
            try:
                batch, batch_counts = multi_search.aggregate_search(
                    supplement_query,
                    max_per_source=max(1, min(supplement_depth, 100)),
                    year_range=year_range,
                    include_semantic_scholar=(idx == 1),
                )
                query_manifest.append({
                    "query": supplement_query,
                    "status": "ok",
                    "counts": batch_counts,
                    "n_records": len(batch),
                })
            except Exception as exc:
                logger.warning(f"Academic source supplement failed: {exc}")
                batch = []
                query_manifest.append({
                    "query": supplement_query,
                    "status": "failed",
                    "counts": {},
                    "n_records": 0,
                    "error": str(exc),
                })
            papers.extend(batch)

        papers = self._deduplicate(papers)
        papers = _rank_academic_fallback_papers(papers)
        if ACADEMIC_SUPPLEMENT_MAX_RESULTS > 0 and len(papers) > ACADEMIC_SUPPLEMENT_MAX_RESULTS:
            papers = papers[:ACADEMIC_SUPPLEMENT_MAX_RESULTS]
        counts: dict[str, int] = {}
        for paper in papers:
            paper["source_type"] = paper.get("source_type") or paper.get("source") or "multi_search"
            source = str(paper.get("source") or "multi_search").lower()
            if source == "openalex":
                label = "OpenAlex"
            elif source in {"semantic_scholar", "semantic scholar"}:
                label = "Semantic Scholar"
            else:
                label = paper.get("source_type") or "multi_search"
            counts[label] = counts.get(label, 0) + 1
        if papers:
            self.log(
                "Academic supplement returned "
                f"{len(papers)} record(s) ({', '.join(f'{k}={v}' for k, v in counts.items())})"
            )
        if project and query_manifest:
            project.save_json(
                "academic_supplement_manifest.json",
                {
                    "enabled": ENABLE_MULTI_SEARCH_SUPPLEMENT,
                    "queries": query_manifest,
                },
            )
        return papers, counts

    def _pubmed_precision_supplement_pmids(
        self,
        query: str,
        existing_pmids: list[str],
        min_date: str | None,
        max_date: str | None,
        project: Project | None = None,
    ) -> list[str]:
        """Run exact PubMed probes for landmark trial publications missed by broad caps."""
        if not ENABLE_PUBMED_PRECISION_SUPPLEMENT:
            return []
        precision_queries = _trial_publication_recall_queries_for_academic_search(query)
        if not precision_queries:
            return []

        seen = {str(pmid) for pmid in existing_pmids if pmid}
        new_pmids: list[str] = []
        manifest: list[dict] = []
        for precision_query in precision_queries:
            try:
                pmids = pubmed.search(
                    precision_query,
                    max_results=max(1, PUBMED_PRECISION_SUPPLEMENT_MAX_RESULTS),
                    min_date=min_date,
                    max_date=max_date,
                )
                manifest.append({
                    "query": precision_query,
                    "status": "ok",
                    "n_records": len(pmids),
                    "pmids": pmids,
                })
            except Exception as exc:
                logger.warning(f"PubMed precision supplement failed: {exc}")
                manifest.append({
                    "query": precision_query,
                    "status": "failed",
                    "n_records": 0,
                    "pmids": [],
                    "error": str(exc),
                })
                continue
            for pmid in pmids:
                if pmid and pmid not in seen:
                    seen.add(pmid)
                    new_pmids.append(pmid)

        if project and manifest:
            project.save_json(
                "pubmed_precision_supplement_manifest.json",
                {
                    "enabled": ENABLE_PUBMED_PRECISION_SUPPLEMENT,
                    "queries": manifest,
                },
            )
        if new_pmids:
            self.log(f"PubMed precision supplement added {len(new_pmids)} PMID(s)")
        return new_pmids

    def run(self, query: str, project: Project, max_results: int = None) -> list[dict]:
        """Search PubMed, deduplicate, download PDFs (backward-compat wrapper).

        Returns list of paper metadata dicts with 'pdf_path' field added.
        """
        papers = self.search_and_fetch(query, project, max_results=max_results)
        papers_with_pdf, papers_without_pdf = self.download_pdfs(papers, project)
        # Merge back — keep all papers, those without PDF have pdf_path=None
        all_papers = papers_with_pdf + papers_without_pdf
        project.save_json("search_results.json", all_papers)
        project.save_json("prisma_flow.json", project.prisma.to_dict())
        return all_papers

    def search_and_fetch(self, query: str, project: Project, max_results: int = None,
                         date_range: str = "") -> list[dict]:
        """Search both internal DB AND PubMed, merge and deduplicate.

        Args:
            date_range: Protocol date range (e.g. "2010-2024"). If set, internal DB
                        results outside this range are filtered.
        """
        max_results = max_results or MAX_SEARCH_RESULTS
        start_year, end_year = _parse_date_range(date_range)

        all_papers = []
        n_db_raw = 0
        n_pm_raw = 0
        n_multi_raw = 0
        n_registry_raw = 0
        source_counts: dict[str, int] = {}
        pubmed_failed = False

        # Step 1: Internal database
        self.log("Searching internal database...")
        db_papers = internal_db.search_internal_db(query)
        if db_papers:
            n_db_raw = len(db_papers)
            db_papers = self._deduplicate(db_papers)
            self.log(f"Internal DB found {len(db_papers)} unique papers")

            if start_year or end_year:
                before = len(db_papers)
                db_papers = [p for p in db_papers if _paper_within_year_range(p, start_year, end_year)]
                if len(db_papers) < before:
                    self.log(f"年份过滤: {before} → {len(db_papers)} (范围 {start_year or '*'}-{end_year or '*'})")

            all_papers.extend(db_papers)

        # Step 2: PubMed (always search to supplement internal DB)
        self.log(f"Searching PubMed (max {max_results})...")
        try:
            min_date = f"{start_year}/01/01" if start_year else None
            max_date = f"{end_year}/12/31" if end_year else None
            pubmed_candidate_limit = min(
                MAX_SEARCH_RESULTS,
                max(
                    max_results,
                    PUBMED_CANDIDATE_POOL_MIN,
                    max_results * PUBMED_CANDIDATE_POOL_MULTIPLIER,
                ),
            )
            pmids = pubmed.search(
                query,
                max_results=pubmed_candidate_limit,
                min_date=min_date,
                max_date=max_date,
            )
            precision_pmids = self._pubmed_precision_supplement_pmids(
                query=query,
                existing_pmids=pmids,
                min_date=min_date,
                max_date=max_date,
                project=project,
            )
            if precision_pmids:
                pmids = list(dict.fromkeys([*pmids, *precision_pmids]))
            n_pm_raw = len(pmids)
            self.log(f"PubMed found {len(pmids)} records")
        except Exception as e:
            logger.warning(f"PubMed search failed: {e}. Continuing with internal DB results only.")
            pmids = []
            pubmed_failed = True

        if pmids:
            self.log("Fetching PubMed paper details...")
            pm_papers = pubmed.fetch_details(pmids)
            self.log(f"Retrieved details for {len(pm_papers)} PubMed papers")
            all_papers.extend(pm_papers)

        if pubmed_failed:
            fallback_papers, source_counts = self._multi_source_fallback(
                query=query,
                max_results=max_results,
                start_year=start_year,
                end_year=end_year,
                project=project,
            )
            n_multi_raw = len(fallback_papers)
            all_papers.extend(fallback_papers)
        else:
            if pmids:
                academic_papers, academic_counts = self._academic_source_supplement(
                    query=query,
                    max_results=max_results,
                    start_year=start_year,
                    end_year=end_year,
                    project=project,
                )
                n_multi_raw = len(academic_papers)
                all_papers.extend(academic_papers)
                source_counts.update(academic_counts)
            registry_papers, registry_counts = self._registry_source_supplement(
                query=query,
                max_results=max_results,
                start_year=start_year,
                end_year=end_year,
                project=project,
            )
            n_registry_raw = len(registry_papers)
            all_papers.extend(registry_papers)
            source_counts.update(registry_counts)

        if not all_papers:
            project.save_json(
                "search_source_counts.json",
                {
                    "internal_db": n_db_raw,
                    "pubmed": n_pm_raw,
                    **source_counts,
                },
            )
            return []

        pubmed_pmid_set = {str(pmid).strip() for pmid in pmids if str(pmid).strip()}
        if pubmed_pmid_set:
            for paper in all_papers:
                if str(paper.get("pmid") or "").strip() in pubmed_pmid_set:
                    sources = list(paper.get("retrieval_sources") or [])
                    if "pubmed" not in sources:
                        sources.append("pubmed")
                    paper["retrieval_sources"] = sources

        # Step 3: Merge and deduplicate
        all_papers = self._deduplicate(all_papers)
        if start_year or end_year:
            before = len(all_papers)
            all_papers = [p for p in all_papers if _paper_within_year_range(p, start_year, end_year)]
            if len(all_papers) < before:
                self.log(f"年份过滤(合并后): {before} → {len(all_papers)}")

        all_papers = _rank_search_results(all_papers, query=query)
        deduplicated = len(all_papers)

        # Apply user/requested cap to the merged set, not just PubMed.
        all_papers = self._cap_results(all_papers, max_results, "Search")

        # PRISMA: records_identified = pre-dedup total (sum of all sources)
        project.prisma.records_from_database = n_db_raw + n_pm_raw + n_multi_raw + n_registry_raw
        project.prisma.records_identified = n_db_raw + n_pm_raw + n_multi_raw + n_registry_raw
        project.prisma.records_after_dedup = deduplicated
        project.prisma.set_records_not_screened(deduplicated - len(all_papers), "relevance cap before screening")
        self.log(
            f"Combined search: {len(all_papers)} unique papers "
            f"(raw: {n_db_raw} DB + {n_pm_raw} PubMed + {n_multi_raw} fallback + "
            f"{n_registry_raw} registry supplement)"
        )

        project.save_json("search_results.json", all_papers)
        project.save_json(
            "search_source_counts.json",
            {
                "internal_db": n_db_raw,
                "pubmed": n_pm_raw,
                **source_counts,
            },
        )
        project.save_json("prisma_flow.json", project.prisma.to_dict())

        return all_papers

    def search_monotherapy_priority(
        self,
        primary_query: str,
        intervention: str,
        project: Project,
        max_results: int = None,
        date_range: str = "",
    ) -> list[dict]:
        """Two-pass search: monotherapy-focused first, then broad supplement.

        Pass 1: Query with monotherapy preference terms (drug in title + mono keywords)
        Pass 2: Original broad query to catch studies missed by Pass 1

        Results are merged and deduplicated. Monotherapy-priority papers appear first.
        """
        from new_meta.agents.query_builder import build_monotherapy_query

        max_results = max_results or MAX_SEARCH_RESULTS
        start_year, end_year = _parse_date_range(date_range)

        # Build monotherapy-focused query
        # Extract study design filter from primary query if present
        design_filter = ""
        for pattern in [r'("randomized controlled trial"\[pt\][^)]*)',
                        r'(randomized\[tiab\][^)]*)']:
            m = re.search(pattern, primary_query)
            if m:
                design_filter = m.group(1)
                break

        mono_query = build_monotherapy_query(primary_query, intervention, design_filter)
        self.log(f"单药优先查询 ({len(mono_query)} chars)")

        # === Pass 1: Monotherapy-focused ===
        all_papers = []
        seen_pmids = set()
        n_mono_db = 0
        n_mono_pm = 0

        self.log("Pass 1: Searching with monotherapy preference...")

        # Internal DB with monotherapy query
        mono_db = internal_db.search_internal_db(mono_query)
        if mono_db:
            n_mono_db = len(mono_db)
            for p in self._deduplicate(mono_db):
                pmid = p.get("pmid", "")
                if pmid not in seen_pmids:
                    p["_monotherapy_priority"] = True
                    all_papers.append(p)
                    seen_pmids.add(pmid)

        # PubMed with monotherapy query
        try:
            min_date = f"{start_year}/01/01" if start_year else None
            max_date = f"{end_year}/12/31" if end_year else None
            mono_pmids = pubmed.search(mono_query, max_results=max_results, min_date=min_date, max_date=max_date)
            n_mono_pm = len(mono_pmids)
            if mono_pmids:
                mono_pm_papers = pubmed.fetch_details(mono_pmids)
                for p in self._deduplicate(mono_pm_papers):
                    pmid = p.get("pmid", "")
                    if pmid not in seen_pmids:
                        p["_monotherapy_priority"] = True
                        all_papers.append(p)
                        seen_pmids.add(pmid)
        except Exception as e:
            logger.warning(f"Monotherapy PubMed search failed: {e}")

        self.log(f"Pass 1 (单药优先): {len(all_papers)} papers")

        # === Pass 2: Broad supplement ===
        n_broad_db = 0
        n_broad_pm = 0
        broad_papers = []

        self.log("Pass 2: Broad supplement search...")

        broad_db = internal_db.search_internal_db(primary_query)
        if broad_db:
            n_broad_db = len(broad_db)
            broad_papers.extend(broad_db)

        try:
            min_date = f"{start_year}/01/01" if start_year else None
            max_date = f"{end_year}/12/31" if end_year else None
            broad_pmids = pubmed.search(primary_query, max_results=max_results, min_date=min_date, max_date=max_date)
            n_broad_pm = len(broad_pmids)
            if broad_pmids:
                broad_papers.extend(pubmed.fetch_details(broad_pmids))
        except Exception as e:
            logger.warning(f"Broad PubMed search failed: {e}")

        # Deduplicate broad results and add unseen ones (lower priority)
        broad_unique = self._deduplicate(broad_papers)
        added = 0
        for p in broad_unique:
            pmid = p.get("pmid", "")
            if pmid not in seen_pmids:
                p["_monotherapy_priority"] = False
                all_papers.append(p)
                seen_pmids.add(pmid)
                added += 1

        self.log(f"Pass 2 (补充): +{added} new papers")

        # Year filter
        if start_year or end_year:
            before = len(all_papers)
            all_papers = [p for p in all_papers
                          if (not start_year or (p.get("year") or 0) >= start_year)
                          and (not end_year or (p.get("year") or 0) <= end_year)]
            if len(all_papers) < before:
                self.log(f"年份过滤: {before} → {len(all_papers)}")

        # Sort: monotherapy priority first, then by year desc
        all_papers.sort(key=lambda p: (not p.get("_monotherapy_priority", False),
                                       -(p.get("year") or 0)))

        # Clean up priority markers
        for p in all_papers:
            p.pop("_monotherapy_priority", None)

        deduplicated = len(all_papers)
        all_papers = self._cap_results(all_papers, max_results, "Monotherapy-priority search")

        # PRISMA counts
        total_raw = n_mono_db + n_mono_pm + n_broad_db + n_broad_pm
        project.prisma.records_from_database = n_mono_db + n_broad_db
        project.prisma.records_identified = total_raw
        project.prisma.records_after_dedup = deduplicated
        project.prisma.set_records_not_screened(deduplicated - len(all_papers), "relevance cap before screening")
        self.log(f"单药优先检索合计: {len(all_papers)} unique papers "
                 f"(Pass1: {n_mono_db}+{n_mono_pm}, Pass2 补充: {added})")

        project.save_json("search_results.json", all_papers)
        project.save_json("prisma_flow.json", project.prisma.to_dict())

        return all_papers

    def download_pdfs(self, papers: list[dict], project: Project) -> tuple[list[dict], list[dict]]:
        """Download PDFs for given papers.

        Returns:
            (papers_with_pdf, papers_without_pdf)
        """
        self._hydrate_pdf_urls_from_search_results(papers, project)
        self.log(f"Downloading PDFs for {len(papers)} papers...")
        papers = self._download_pdfs(papers, project)

        with_pdf = [p for p in papers if p.get("pdf_path") or p.get("fulltext_path")]
        without_pdf = [p for p in papers if not p.get("pdf_path") and not p.get("fulltext_path")]
        n_pdf = sum(1 for p in with_pdf if p.get("pdf_path"))
        n_html = sum(
            1 for p in with_pdf
            if p.get("fulltext_source") in {"europe_pmc_fulltext", "europe_pmc_html"}
        )
        n_abstract = sum(
            1 for p in with_pdf
            if p.get("text_availability") == "abstract_only"
        )
        n_metadata = sum(
            1 for p in without_pdf
            if p.get("text_availability") == "metadata_only"
        )
        self.log(
            f"Downloaded/retrieved text for {len(with_pdf)}/{len(papers)} papers "
            f"({n_pdf} PDF, {n_html} HTML full text, {n_abstract} abstract-only, "
            f"{n_metadata} metadata-only)"
        )

        return with_pdf, without_pdf

    def _hydrate_pdf_urls_from_search_results(self, papers: list[dict], project: Project) -> None:
        """Backfill OA PDF URLs into cached screening records before download."""
        search_results = project.load_json("search_results.json") or []
        if not search_results:
            return

        by_key: dict[str, dict] = {}
        for record in search_results:
            for key in _paper_identity_keys(record):
                by_key[key] = record

        for paper in papers:
            if paper.get("pdf_urls"):
                continue
            for key in _paper_identity_keys(paper):
                match = by_key.get(key)
                if not match:
                    continue
                if match.get("pdf_url"):
                    paper["pdf_url"] = match["pdf_url"]
                if match.get("pdf_urls"):
                    paper["pdf_urls"] = match["pdf_urls"]
                if match.get("url"):
                    paper["url"] = match["url"]
                break

    def match_user_pdfs(
        self,
        ta_papers: list[dict],
        user_pdf_paths: list[str],
    ) -> tuple[int, list[dict], dict[str, dict]]:
        """Parse ALL user PDFs and match to T/A-screened papers.

        1. Parse every user PDF to extract title and full text
        2. Match to T/A papers by PMID/DOI in filename, then title similarity
        3. Unmatched user PDFs become "extra papers" for full-text screening

        Args:
            ta_papers: T/A-screened papers (modified in-place with pdf_path).
            user_pdf_paths: List of file paths to user-uploaded PDFs.

        Returns:
            (matched_count, extra_papers, parsed_papers)
        """
        if not user_pdf_paths:
            return 0, [], {}

        from new_meta.agents.pdf_parser import parse_pdf, extract_pdf_title

        self.log(f"Parsing {len(user_pdf_paths)} user-uploaded PDFs...")
        matched = 0
        extra_papers: list[dict] = []
        parsed_papers: dict[str, dict] = {}

        for pdf_path in user_pdf_paths:
            pdf_path_str = str(pdf_path)
            pdf_name = Path(pdf_path_str).stem.lower()

            try:
                parsed = parse_pdf(pdf_path_str)
                pdf_title = extract_pdf_title(pdf_path_str).lower().strip()
            except Exception as e:
                logger.warning(f"Failed to parse user PDF {pdf_path_str}: {e}")
                continue

            if not parsed.get("full_text"):
                logger.warning(f"User PDF has no extractable text: {pdf_path_str}")
                continue

            best_match = None
            best_score = 0.0

            for paper in ta_papers:
                if paper.get("pdf_path"):
                    continue

                pmid = paper.get("pmid", "")
                if pmid and pmid in pdf_name:
                    best_match = paper
                    best_score = 1.0
                    break

                doi = paper.get("doi", "").replace("/", "_").lower()
                if doi and doi in pdf_name:
                    best_match = paper
                    best_score = 1.0
                    break

                paper_title = paper.get("title", "").lower().strip()
                if pdf_title and paper_title:
                    score = SequenceMatcher(None, pdf_title, paper_title).ratio()
                    if score > best_score and score > 0.5:
                        best_score = score
                        best_match = paper

            if best_match and not best_match.get("pdf_path"):
                best_match["pdf_path"] = pdf_path_str
                best_match["source_type"] = best_match.get("source_type") or "database"
                best_match["pdf_match_score"] = round(best_score, 3)
                pmid = best_match.get("pmid", "")
                parsed_papers[pmid] = parsed
                matched += 1
            else:
                extra_key = f"user_pdf_{len(extra_papers)}"
                abstract = parsed.get("abstract", "")
                if not abstract:
                    abstract = parsed.get("full_text", "")[:500]
                extra_paper = {
                    "pmid": extra_key,
                    "title": pdf_title if pdf_title else Path(pdf_path_str).stem,
                    "abstract": abstract,
                    "authors": [],
                    "year": 0,
                    "journal": "",
                    "doi": "",
                    "pub_types": [],
                    "pdf_path": pdf_path_str,
                    "source_type": "user_upload",
                    "pdf_match_score": 0.0,
                }
                extra_papers.append(extra_paper)
                parsed_papers[extra_key] = parsed

        self.log(f"Matched {matched} user PDFs to T/A papers, "
                 f"{len(extra_papers)} extra user PDFs")
        return matched, extra_papers, parsed_papers

    def _deduplicate(self, papers: list[dict]) -> list[dict]:
        """Remove duplicate papers based on DOI and title similarity.

        DOI/PMID are treated as exact identities. Title matching is deliberately
        conservative because trial programs often publish design, subgroup, and
        primary-result papers that share long title prefixes.
        """
        seen_dois: dict[str, dict] = {}
        seen_pmids: dict[str, dict] = {}
        seen_titles: dict[str, dict] = {}
        unique = []

        for paper in papers:
            pmid = str(paper.get("pmid") or "").strip().lower()
            doi = str(paper.get("doi") or "").strip().lower()
            title = re.sub(r"\s+", " ", str(paper.get("title") or "").strip().lower())

            duplicate = (
                seen_pmids.get(pmid) if pmid else None
            ) or (
                seen_dois.get(doi) if doi else None
            ) or (
                seen_titles.get(title) if title else None
            )
            if duplicate is not None:
                _merge_duplicate_metadata(duplicate, paper)
                continue

            near_duplicate = None
            for existing_title, existing_paper in seen_titles.items():
                if abs(len(title) - len(existing_title)) > max(10, len(title) * 0.3):
                    continue  # Skip very different-length titles
                if _titles_are_near_duplicates(title, existing_title):
                    near_duplicate = existing_paper
                    break
            if near_duplicate is not None:
                _merge_duplicate_metadata(near_duplicate, paper)
                continue

            if pmid:
                seen_pmids[pmid] = paper
            if doi:
                seen_dois[doi] = paper
            if title:
                seen_titles[title] = paper
            unique.append(paper)

        return unique

    def _download_pdfs(self, papers: list[dict], project: Project) -> list[dict]:
        """Download PDFs for all papers using thread pool."""
        papers_dir = project.base_dir / "papers"

        def download_one(paper):
            source = str(paper.get("source") or paper.get("source_type") or "").lower()
            if source == "clinicaltrials" and _materialize_clinicaltrials_text_source(paper, papers_dir):
                return paper
            if source == "registry_seed" and _materialize_registry_seed_source(paper, papers_dir):
                return paper

            if paper.get("metadata_only") or paper.get("text_availability") == "metadata_only":
                paper["pdf_path"] = None
                paper["fulltext_path"] = None
                paper["text_availability"] = "metadata_only"
                paper["fulltext_source"] = paper.get("fulltext_source") or "registry_metadata"
                paper["needs_user_full_text"] = True
                return paper

            pmid = paper.get("pmid", "")
            doi = paper.get("doi", "")
            identifier = pmid or doi.replace('/', '_') or f"paper_{id(paper)}"
            safe_name = f"{identifier}.pdf"
            save_path = str(papers_dir / safe_name)
            pdf_url = paper.get("pdf_urls") or paper.get("pdf_url") or paper.get("url")
            europe_pmc_pdf_urls, europe_pmc_html_url, pmcid = get_europe_pmc_pdf_urls(
                pmid=pmid,
                doi=doi,
                timeout=10,
            )
            if pmcid and not paper.get("pmcid"):
                paper["pmcid"] = pmcid
            if europe_pmc_html_url and not paper.get("fulltext_url"):
                paper["fulltext_url"] = europe_pmc_html_url
            if europe_pmc_pdf_urls:
                existing_urls = []
                if isinstance(pdf_url, (list, tuple)):
                    existing_urls = [u for u in pdf_url if u]
                elif pdf_url:
                    existing_urls = [pdf_url]
                merged_urls = []
                for candidate in list(europe_pmc_pdf_urls) + existing_urls:
                    if candidate and candidate not in merged_urls:
                        merged_urls.append(candidate)
                pdf_url = merged_urls
                paper["pdf_urls"] = merged_urls
            if not pdf_url and doi:
                from new_meta.tools.multi_search import get_openalex_pdf_urls_for_doi

                pdf_url = get_openalex_pdf_urls_for_doi(doi)
                if pdf_url:
                    paper["pdf_urls"] = pdf_url

            success = download_pdf(doi=doi, pmid=pmid, url=pdf_url, save_path=save_path)
            if success:
                paper["pdf_path"] = save_path
                paper.pop("fulltext_path", None)
                paper["text_availability"] = "full_text"
                paper["fulltext_source"] = "pdf"
            else:
                paper["pdf_path"] = None
                fulltext_path = str(papers_dir / f"{identifier}.fulltext.txt")
                fulltext_ok = fetch_europe_pmc_fulltext(
                    pmid=pmid,
                    doi=doi,
                    save_path=fulltext_path,
                )
                if fulltext_ok:
                    paper["fulltext_path"] = fulltext_path
                    paper["fulltext_source"] = "europe_pmc_fulltext"
                    paper["text_availability"] = "full_text"
                else:
                    abstract_path = str(papers_dir / f"{identifier}.abstract.txt")
                    abstract_ok = fetch_europe_pmc_abstract_text(
                        pmid=pmid,
                        doi=doi,
                        save_path=abstract_path,
                    )
                    if abstract_ok:
                        paper["fulltext_path"] = abstract_path
                        paper["fulltext_source"] = "europe_pmc_abstract"
                        paper["text_availability"] = "abstract_only"
                    else:
                        paper["fulltext_path"] = None
                        paper.pop("fulltext_source", None)
                        paper.pop("text_availability", None)
            return paper

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(download_one, p): p for p in papers}
            results = []
            for future in as_completed(futures):
                try:
                    results.append(future.result())
                except Exception as e:
                    logger.warning(f"Download failed: {e}")
                    paper = futures[future]
                    paper["pdf_path"] = None
                    results.append(paper)

        return results


def _materialize_clinicaltrials_text_source(paper: dict, papers_dir: Path) -> bool:
    """Persist a structured ClinicalTrials.gov record as parsable text."""
    abstract = str(paper.get("abstract") or "").strip()
    if len(abstract) < 500:
        return False
    papers_dir.mkdir(parents=True, exist_ok=True)
    identifier = (
        str(paper.get("trial_registration") or paper.get("nct_id") or paper.get("pmid") or "")
        or re.sub(r"[^a-z0-9]+", "_", str(paper.get("title") or "clinicaltrials").lower()).strip("_")
        or "clinicaltrials"
    )
    fulltext_path = papers_dir / f"{identifier}.clinicaltrials.txt"
    lines = [
        "SOURCE: ClinicalTrials.gov registry record",
        f"URL: {paper.get('url') or ''}",
        f"TRIAL_REGISTRATION: {paper.get('trial_registration') or paper.get('nct_id') or ''}",
        "",
        abstract,
    ]
    fulltext_path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")
    paper["pdf_path"] = None
    paper["fulltext_path"] = str(fulltext_path)
    paper["text_availability"] = "full_text"
    paper["fulltext_source"] = "clinicaltrials_registry"
    paper["fulltext_available"] = True
    paper["needs_user_full_text"] = False
    return True


def _materialize_registry_seed_source(paper: dict, papers_dir: Path) -> bool:
    """Try official source URLs attached to a registry seed before giving up."""
    urls = [str(url) for url in paper.get("source_urls", []) or [] if url]
    if not urls:
        return False
    papers_dir.mkdir(parents=True, exist_ok=True)
    identifier = (
        str(paper.get("trial_registration") or paper.get("nct_id") or "").strip()
        or re.sub(r"[^a-z0-9]+", "_", str(paper.get("title") or "registry_seed").lower()).strip("_")
        or "registry_seed"
    )
    for url in urls:
        if url.lower().endswith(".pdf"):
            pdf_path = str(papers_dir / f"{identifier}.seed.pdf")
            if download_pdf(url=url, save_path=pdf_path):
                paper["pdf_path"] = pdf_path
                paper["fulltext_path"] = None
                paper["text_availability"] = "full_text"
                paper["fulltext_source"] = "registry_seed_source_pdf"
                paper["fulltext_available"] = True
                paper["needs_user_full_text"] = False
                paper["metadata_only"] = False
                return True
            continue

        fulltext_path = str(papers_dir / f"{identifier}.seed.txt")
        if fetch_html_fulltext_url(
            url,
            save_path=fulltext_path,
            source_label="Registry source page",
        ):
            paper["pdf_path"] = None
            paper["fulltext_path"] = fulltext_path
            paper["text_availability"] = "full_text"
            paper["fulltext_source"] = "registry_seed_source"
            paper["fulltext_available"] = True
            paper["needs_user_full_text"] = False
            paper["metadata_only"] = False
            return True
    return False
