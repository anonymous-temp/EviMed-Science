#!/usr/bin/env python3
"""Build the runtime registry ``registry/sources.json`` from the probe registry (plan 10.2.9).

Usage (from the plugin directory):
    python tools/build_registry.py                 # write registry/sources.json
    python tools/build_registry.py --check         # exit 1 when the committed file differs from a fresh build

Input: ``registry/probe-sources.json`` (the plan's 753-row probe registry, reduced to the fields a
build reads) and ``registry/overrides.json`` (hand-kept fields keyed by source id; they win over
everything derived here). The output is deterministic: same inputs, same bytes — the load test
rebuilds it and compares.

What the conversion does, and why:

- **Vocabularies.** Lane ``news`` becomes ``mixed`` (the platform's screening model picks a lane per
  entry; "综合资讯" is not one of the eight), ``conference`` becomes ``evidence``. Access ``wechat``
  becomes ``wechat-bridge``; json-api rows that are E-utilities ``esearch`` queries become
  ``eutils-query`` and Europe PMC searches ``europepmc``; an ``html-list`` read through the
  headless browser becomes ``browser-list``.
- **Not loaded:** egress ``none`` (no feasible exit today) and the paid-api / email-only / login
  rows, and the three enrichment endpoints (PubMed esummary, Europe PMC by DOI, Unpaywall) that
  the probe list carried as if they were sources — they live in ``settings.EnrichmentEndpoints``.
- **Loaded but off** (with a named ``disabled_reason``, so ``/v1/sources`` shows the whole plan
  honestly): anything this build cannot read. Batch 2 (2026-09-22) turns on: P0 sources on every
  exit the build has (direct, api, relay, browser); P1 list pages whose selectors exist; the team's
  EviMed API scans (``registry/extra-sources.json``); and every relay source the Tokyo node read
  with the honest identity in the 2026-09-22 acceptance (``registry/research/``). A row the
  adapter's own ``validate_config`` rejects stays off, with the adapter's reason.
- **URL templates, never dates.** 162 probe endpoints carried the check day. Journal queries read
  a rolling window (``{since}``), and so do openFDA, medRxiv, ClinicalTrials.gov, OpenAlex and
  ISRCTN. Crossref journal windows filter on ``from-created-date`` (first registration): the plan's
  wording names ``from-index-date``, but ``indexed`` moves whenever Crossref re-indexes a record
  (cited-by counts included), so an index window returns old articles every day.
- **Runtime fields:** ``source_type`` (by category, then subcategory; the registry decides it,
  never a model), ``authority`` 1-5, ``safety_feed`` (official alert/recall/label-change feeds
  only), ``owner_entity`` (the operating entity: publisher, agency, company — independent-source
  counts for heat are by entity), cadence floor/ceiling (plan 6.1: safety and regulators 30 min,
  media and AI 1 h, journal APIs 3 h, preprints and trial registries 6 h, societies and
  conferences daily) and ``config.allowed_hosts``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from knowledge_plugin.model import IMPLEMENTED_ACCESSES, IMPLEMENTED_EGRESSES  # noqa: E402
from knowledge_plugin.registry import list_configured, validate_row  # noqa: E402

PROBE = ROOT / "registry" / "probe-sources.json"
OVERRIDES = ROOT / "registry" / "overrides.json"
OUTPUT = ROOT / "registry" / "sources.json"
EXTRA = ROOT / "registry" / "extra-sources.json"
RELAY_ACCEPTANCE = ROOT / "registry" / "research" / "probe-edge-honest-ua-2026-09-22.jsonl"

NOT_LOADED_ACCESS = {"paid-api", "email-only", "login"}
ENRICHMENT_TOOL_IDS = {"pubmed-eutils-esummary", "europepmc-doi-abstract-enrich", "unpaywall-oa-status"}
LANE_MAP = {"news": "mixed", "conference": "evidence"}

JOURNAL_CATEGORIES = {
    "journal-general", "journal-specialty", "journal-tcm", "journal-cn", "journal-pharmacy",
    "journal-methods", "journal-ai-med", "literature-stream",
}
MEDIA_CATEGORIES = {"industry-media", "cn-media-pharma", "med-news-en", "cn-media-clinical", "ai-media",
                    "cn-wechat", "cn-media-science"}

# Source type by category; subcategory rules and per-id overrides refine it.
SOURCE_TYPE_BY_CATEGORY = {
    **{c: "journal" for c in JOURNAL_CATEGORIES},
    **{c: "media" for c in MEDIA_CATEGORIES},
    "preprint": "preprint",
    "regulator": "regulator",
    "drug-safety": "regulator",
    "public-health": "regulator",
    "trial-registry": "regulator",
    "evidence": "evidence-body",
    "guideline": "evidence-body",
    "conference": "evidence-body",
    "methods": "evidence-body",
    "company": "company",
    "ai-vendor": "company",
    "ai-research-tools": "company",
    "scholarly-signal": "journal",
    "ai-benchmark": "evidence-body",
    "ai-medicine": "media",
    "hta-access": "evidence-body",
    "funding-policy": "regulator",
}
SOURCE_TYPE_BY_SUBCATEGORY = {
    ("hta-access", "reimbursement-cn"): "regulator",
    ("hta-access", "procurement-cn"): "regulator",
    ("hta-access", "policy-cn"): "regulator",
    ("hta-access", "reimbursement"): "regulator",
    ("hta-access", "essential-medicines"): "regulator",
    ("hta-access", "health-policy"): "journal",
    ("drug-safety", "society-cn"): "evidence-body",
    ("drug-safety", "off-label-cn"): "evidence-body",
    ("drug-safety", "medication-error"): "evidence-body",
    ("ai-medicine", "vendor-health"): "company",
    ("ai-medicine", "ai-drug-discovery"): "company",
    ("ai-medicine", "provider-industry"): "company",
    ("ai-medicine", "regulator-cn"): "regulator",
    ("ai-medicine", "regulator-eu"): "regulator",
    ("ai-medicine", "academic-center"): "evidence-body",
    ("ai-medicine", "association-cn"): "evidence-body",
    ("public-health", "outbreak-news"): "media",
    ("public-health", "data-explainer"): "media",
    ("public-health", "global-health-policy"): "media",
    ("public-health", "burden-of-disease"): "evidence-body",
    ("public-health", "vaccine-rd"): "evidence-body",
    ("public-health", "immunization"): "evidence-body",
    ("funding-policy", "science-policy"): "media",
    ("funding-policy", "policy-media-cn"): "media",
    ("methods", "biostatistics"): "media",
    ("methods", "research-integrity-cn"): "regulator",
    ("methods", "journal-quality"): "company",
}

AUTHORITY_BY_CATEGORY = {
    "journal-general": 4, "journal-specialty": 4, "journal-tcm": 3, "journal-cn": 3, "journal-pharmacy": 3,
    "journal-methods": 3, "journal-ai-med": 3, "literature-stream": 3, "preprint": 2, "regulator": 5,
    "drug-safety": 5, "public-health": 4, "trial-registry": 4, "evidence": 4, "guideline": 4,
    "conference": 3, "methods": 3, "company": 2, "ai-vendor": 2, "ai-research-tools": 2,
    "scholarly-signal": 3, "ai-benchmark": 3, "ai-medicine": 3, "hta-access": 4, "funding-policy": 4,
    "industry-media": 3, "med-news-en": 3, "cn-media-pharma": 2, "cn-media-clinical": 2, "ai-media": 2,
    "cn-wechat": 2, "cn-media-science": 2,
}
# Authority by the final source type where the category default is too generous.
AUTHORITY_CAP_BY_TYPE = {"media": 3, "company": 2, "preprint": 2}

SAFETY_SUBCATEGORIES = {"safety-alert", "recall", "label-change", "regulator-cn"}

# owner_entity: first matching alias wins; otherwise the org without a trailing parenthetical.
OWNER_ALIASES = [
    (re.compile(r"^U\.S\. (?:FDA|Food and Drug Administration)\b"), "U.S. Food and Drug Administration"),
    (re.compile(r"^European Medicines Agency"), "European Medicines Agency"),
    (re.compile(r"^World Health Organization"), "World Health Organization"),
    (re.compile(r"^(?:国家药品监督管理局|国家药监局$)"), "国家药品监督管理局"),
    (re.compile(r"^U\.S\. (?:Centers for Disease Control|CDC)\b"), "U.S. Centers for Disease Control and Prevention"),
    (re.compile(r"^中国疾病预防控制中心"), "中国疾病预防控制中心"),
    (re.compile(r"^Cochrane"), "Cochrane"),
    (re.compile(r"^Google"), "Google"),
    (re.compile(r"^(?:U\.S\. National Institutes of Health|NIH\b)"), "U.S. National Institutes of Health"),
    (re.compile(r"^U\.S\. National Library of Medicine"), "U.S. National Library of Medicine"),
    (re.compile(r"^国家医疗保障局"), "国家医疗保障局"),
    (re.compile(r"^国家卫生健康委员会"), "国家卫生健康委员会"),
    (re.compile(r"Springer|^Nature Portfolio$|^BioMed Central$"), "Springer Nature"),
    (re.compile(r"Elsevier|^Cell Press$"), "Elsevier"),
    (re.compile(r"Wiley"), "Wiley"),
    (re.compile(r"Lippincott|Wolters Kluwer|^Ovid Technologies"), "Wolters Kluwer"),
    (re.compile(r"^BMJ"), "BMJ"),
    (re.compile(r"^medRxiv"), "medRxiv"),
    (re.compile(r"^bioRxiv"), "bioRxiv"),
    (re.compile(r"^Health Canada"), "Health Canada"),
    (re.compile(r"^European Commission"), "European Commission"),
    (re.compile(r"中国药学会"), "中国药学会"),
    (re.compile(r"^中华医学会"), "中华医学会"),
    (re.compile(r"科学网|中国科学报社"), "中国科学报社"),
    (re.compile(r"^丁香园"), "丁香园"),
    (re.compile(r"^梅斯医学"), "梅斯医学"),
    (re.compile(r"^Microsoft"), "Microsoft"),
    (re.compile(r"^Stanford"), "Stanford University"),
    (re.compile(r"^Boston Globe Media"), "Boston Globe Media"),
]

EUTILS_DATETYPES = {"edat", "pdat", "mdat", "crdt", "mhda"}
CROSSREF_SELECT = "DOI,title,created,published,type,update-to,abstract,author,container-title"


class BuildError(ValueError):
    """The probe row does not have the shape its read method's conversion expects."""


# --------------------------------------------------------------------------------------------- helpers

def host_of(url: str) -> str | None:
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return None
    return host.lower() if host else None


def owner_entity(row: dict) -> str:
    org = re.sub(r"\s+", " ", (row.get("org") or "").strip())
    if not org:
        return row["name"].strip()
    for pattern, canonical in OWNER_ALIASES:
        if pattern.search(org):
            return canonical
    stripped = re.sub(r"\s*[（(][^（）()]*[)）]\s*$", "", org).strip()
    return stripped or org


def map_access(row: dict) -> str:
    access = row["access"]
    endpoint = row.get("endpoint") or ""
    if access == "wechat":
        return "wechat-bridge"
    if access == "json-api" and "eutils.ncbi.nlm.nih.gov" in endpoint and "esearch.fcgi" in endpoint:
        return "eutils-query"
    if access == "json-api" and "ebi.ac.uk/europepmc" in endpoint:
        return "europepmc"
    if access == "html-list" and row["egress"] == "browser":
        return "browser-list"
    return access


def source_type(row: dict) -> str:
    key = (row["category"], row.get("subcategory") or "")
    if key in SOURCE_TYPE_BY_SUBCATEGORY:
        return SOURCE_TYPE_BY_SUBCATEGORY[key]
    return SOURCE_TYPE_BY_CATEGORY.get(row["category"], "media")


def cadence(stype: str, lane: str, safety: bool, access: str, category: str) -> tuple[int, int]:
    """(poll_floor_s, poll_ceiling_s) per plan 6.1; the ceiling bounds the adaptive slow-down."""
    if safety:
        floor = 1800
    elif category == "trial-registry" or stype == "preprint":
        floor = 21600
    elif stype == "regulator" and lane in ("regulatory", "safety", "public-health"):
        floor = 1800
    elif access in ("crossref-issn", "eutils-query", "europepmc") or stype == "journal":
        floor = 10800
    elif stype in ("media", "company") or lane == "ai":
        floor = 3600
    elif stype == "regulator":
        floor = 21600          # funders, research-integrity offices: official but not time-critical
    else:
        floor = 86400          # societies, guideline bodies, HTA agencies, conferences
    factor = 4 if floor <= 1800 else (3 if floor >= 86400 else 6)
    return floor, min(floor * factor, 604800)


def issns_from(row: dict) -> list[str]:
    found = re.findall(r"\b(\d{4}-\d{3}[\dXx])\b", row.get("note") or "")
    primary = row["id"][2:].upper()
    ordered = [primary] + [i.upper() for i in found if i.upper() != primary]
    return list(dict.fromkeys(ordered))


def query_of(url: str) -> list[tuple[str, str]]:
    return parse_qsl(urlsplit(url).query, keep_blank_values=True)


_PLACEHOLDER_TEXT = re.compile(r"\{[a-z_]+(?::[^{}]*)?\}")
_QUERY_SAFE = "-._~:/,*()"


def encode_value(value: str) -> str:
    """Percent-encode a query value strictly, keeping ``{name:format}`` placeholders verbatim."""
    out, last = [], 0
    for match in _PLACEHOLDER_TEXT.finditer(value):
        out.append(quote(value[last:match.start()], safe=_QUERY_SAFE))
        out.append(match.group(0))
        last = match.end()
    out.append(quote(value[last:], safe=_QUERY_SAFE))
    return "".join(out)


def encode_pairs(pairs: list[tuple[str, str]]) -> str:
    return "&".join(f"{quote(key, safe='$.')}={encode_value(value)}" for key, value in pairs)


# --------------------------------------------------------------------------------------------- per-access config

def crossref_config(row: dict) -> dict:
    match = re.match(r"^https://api\.crossref\.org/journals/([0-9]{4}-[0-9]{3}[0-9Xx])/works\?", row["endpoint"])
    if not match:
        raise BuildError(f"{row['id']}: not a Crossref journal-works endpoint")
    issns = issns_from(row)
    url = ("https://api.crossref.org/journals/{issn}/works?filter=from-created-date:{since:%Y-%m-%d},"
           "type:journal-article&rows=100&sort=created&order=desc&select=" + CROSSREF_SELECT + "&cursor={cursor}")
    return {"url": url, "issn": issns[0], "issns": issns, "cursor_start": "*", "page_size": 100, "max_pages": 5,
            "lookback_days": 7, "overlap_days": 1, "incremental": True}


def eutils_config(row: dict) -> dict:
    parts = urlsplit(row["endpoint"])
    params = query_of(row["endpoint"])
    reldate = next((v for k, v in params if k == "reldate"), None)
    datetype = next((v for k, v in params if k == "datetype"), "edat")
    if datetype not in EUTILS_DATETYPES:
        raise BuildError(f"{row['id']}: datetype {datetype!r} is not one E-utilities honours")
    lookback = int(reldate) if reldate and reldate.isdigit() else 7
    kept = [(k, v) for k, v in params if k not in ("reldate", "mindate", "maxdate", "datetype", "tool", "email", "api_key")]
    # Queries use the Entrez date (plan 10.2.4: a wrong datetype returns 0 hits without an error).
    kept += [("datetype", "edat"), ("mindate", "{since:%Y/%m/%d}"), ("maxdate", "{today:%Y/%m/%d}")]
    url = f"{parts.scheme}://{parts.netloc}{parts.path}?{encode_pairs(kept)}"
    retmax = next((int(v) for k, v in params if k == "retmax" and v.isdigit()), 100)
    return {"url": url, "datetype": "edat", "page_size": retmax, "max_pages": 6, "lookback_days": lookback,
            "overlap_days": 1, "incremental": True}


def europepmc_config(row: dict) -> dict:
    parts = urlsplit(row["endpoint"])
    params = query_of(row["endpoint"])
    query = next((v for k, v in params if k == "query"), None)
    if not query:
        raise BuildError(f"{row['id']}: Europe PMC endpoint without a query")
    # Europe PMC: read new records by index date; MEDLINE first-publication dates sit weeks in the future.
    windowed = f"({query}) AND FIRST_IDATE:[{{since:%Y-%m-%d}} TO {{today:%Y-%m-%d}}]"
    kept = [(k, v) for k, v in params if k not in ("query", "cursorMark", "pageSize", "sort")]
    kept = [("query", windowed)] + kept + [("pageSize", "100"), ("cursorMark", "{cursor}")]
    url = f"{parts.scheme}://{parts.netloc}{parts.path}?" + encode_pairs(kept)
    return {"url": url, "cursor_start": "*", "page_size": 100, "max_pages": 5, "lookback_days": 7,
            "overlap_days": 1, "incremental": True}


def json_family(url: str) -> str:
    rules = [
        ("api.fda.gov/drug/drugsfda", "openfda-drugsfda"),
        ("api.fda.gov/drug/enforcement", "openfda-enforcement"),
        ("api.fda.gov/drug/event", "openfda-event"),
        ("api.fda.gov/drug/shortages", "openfda-shortages"),
        ("api.fda.gov/drug/label", "openfda-label"),
        ("clinicaltrials.gov/api/v2", "ctgov"),
        ("api.crossref.org/works", "crossref-works"),
        ("www.who.int/api", "who-odata"),
        ("api.medrxiv.org", "biorxiv"),
        ("api.biorxiv.org", "biorxiv"),
        ("federalregister.gov", "federalregister"),
        ("api.openalex.org", "openalex"),
        ("isrctn.com/api", "isrctn"),
        ("api.semanticscholar.org", "semanticscholar"),
        ("huggingface.co/api", "huggingface"),
        ("api.github.com", "github-commits"),
        ("euclinicaltrials.eu", "ctis"),
    ]
    for needle, family in rules:
        if needle in url:
            return family
    return "generic"


# ClinicalTrials.gov: which date each query reads, and which registry event an entry is.
CTGOV_QUERIES = {
    "ctgov-phase3-new-registrations": ("StudyFirstPostDate", "registered"),
    "ctgov-results-first-posted": ("ResultsFirstPostDate", "results-posted"),
    "ctgov-china-interventional": ("StudyFirstPostDate", "registered"),
    "ctgov-tcm-interventions": ("StudyFirstPostDate", "registered"),
    "ctgov-stopped-phase3": ("LastUpdatePostDate", "status"),
}


def ctgov_config(row: dict) -> dict:
    if row["id"] not in CTGOV_QUERIES:
        raise BuildError(f"{row['id']}: ClinicalTrials.gov query without a declared date field")
    date_field, event = CTGOV_QUERIES[row["id"]]
    parts = urlsplit(row["endpoint"])
    params = query_of(row["endpoint"])
    advanced = next((v for k, v in params if k == "filter.advanced"), "")
    # Drop a MIN,MAX range on the same field (the results query had one) and add the rolling window.
    advanced = re.sub(rf"\s*(?:AND\s+)?AREA\[{date_field}\]RANGE\[[^\]]*\]", "", advanced).strip()
    window = f"AREA[{date_field}]RANGE[{{since:%Y-%m-%d}},MAX]"
    advanced = f"{advanced} AND {window}" if advanced else window
    kept = [(k, v) for k, v in params if k not in ("filter.advanced", "pageToken")]
    kept = [("filter.advanced", advanced)] + kept
    url = f"{parts.scheme}://{parts.netloc}{parts.path}?" + encode_pairs(kept)
    return {"url": url, "family": "ctgov", "date_field": date_field, "trial_event": event, "page_size": 50,
            "max_pages": 5, "lookback_days": 7, "overlap_days": 1, "incremental": True}


def openfda_config(row: dict, family: str) -> dict:
    base = row["endpoint"].split("?", 1)[0]
    if family == "openfda-drugsfda":
        url = (base + "?search=submissions.submission_status_date:%5B{since:%Y%m%d}+TO+{today:%Y%m%d}%5D"
               "&limit=100&sort=submissions.submission_status_date:desc")
        return {"url": url, "family": family, "date_field": "submissions.submission_status_date",
                "date_format": "%Y%m%d", "id_field": "application_number", "page_size": 100, "max_pages": 3,
                "lookback_days": 30, "overlap_days": 1, "incremental": True}
    if family == "openfda-enforcement":
        url = base + "?search=report_date:%5B{since:%Y%m%d}+TO+{today:%Y%m%d}%5D&sort=report_date:desc&limit=100"
        return {"url": url, "family": family, "date_field": "report_date", "date_format": "%Y%m%d",
                "id_field": "recall_number", "page_size": 100, "max_pages": 3, "lookback_days": 30,
                "overlap_days": 1, "incremental": True}
    if family == "openfda-event":
        # FAERS is refreshed quarterly and lags months: the only news is the refresh itself
        # (meta.last_updated), so one record is enough.
        return {"url": base + "?limit=1", "family": family, "date_field": "meta.last_updated",
                "date_format": "%Y-%m-%d", "max_pages": 1}
    if family == "openfda-shortages":
        return {"url": base + "?sort=update_date:desc&limit=100", "family": family, "date_field": "update_date",
                "date_format": "%m/%d/%Y", "page_size": 100, "max_pages": 1}
    return {"url": row["endpoint"], "family": family}


def json_api_config(row: dict) -> dict:
    endpoint = row["endpoint"]
    family = json_family(endpoint)
    if family.startswith("openfda-"):
        return openfda_config(row, family)
    if family == "ctgov":
        return ctgov_config(row)
    if family == "biorxiv":
        match = re.match(r"^(https://api\.(?:med|bio)rxiv\.org/details/(?:med|bio)rxiv)/", endpoint)
        if not match:
            raise BuildError(f"{row['id']}: unexpected medRxiv/bioRxiv endpoint")
        return {"url": match.group(1) + "/{since:%Y-%m-%d}/{today:%Y-%m-%d}/{cursor}/json", "family": family,
                "cursor_start": "0", "page_size": 100, "max_pages": 10, "lookback_days": 7, "overlap_days": 1,
                "incremental": True}
    if family == "openalex":
        parts = urlsplit(endpoint)
        params = [(k, v) for k, v in query_of(endpoint) if k != "mailto"]   # the fetcher adds mailto
        params = [(k, re.sub(r"from_publication_date:\d{4}-\d{2}-\d{2}", "from_publication_date:{since:%Y-%m-%d}", v))
                  for k, v in params]
        lookback = 30 if "most-cited" in row["id"] else 7
        return {"url": f"{parts.scheme}://{parts.netloc}{parts.path}?" + encode_pairs(params),
                "family": family, "lookback_days": lookback, "max_pages": 1}
    if family == "isrctn":
        url = re.sub(r"lastEdited%20GE%20\d{4}-\d{2}-\d{2}T00:00:00Z", "lastEdited%20GE%20{since:%Y-%m-%dT00:00:00Z}", endpoint)
        return {"url": url, "family": family, "lookback_days": 7, "overlap_days": 1, "max_pages": 1}
    config: dict = {"url": endpoint, "family": family, "max_pages": 3}
    if family == "who-odata":
        config["link_base"] = "https://www.who.int"
    return config


def adapter_config(row: dict, access: str) -> dict:
    endpoint = row.get("endpoint") or ""
    if access == "crossref-issn":
        return crossref_config(row)
    if access == "eutils-query":
        return eutils_config(row)
    if access == "europepmc":
        return europepmc_config(row)
    if access == "json-api":
        return json_api_config(row)
    if access == "wechat-bridge":
        account = re.search(r"微信号\s*([A-Za-z][A-Za-z0-9_-]{4,})", endpoint)
        config = {"wechat_name": row["name"]}
        if account:
            config["wechat_account"] = account.group(1)
        return config
    # rss / atom / html-list / browser-list: the endpoint is the list; a year in a list URL
    # (FDA "novel-drug-approvals-2026") rolls with the calendar.
    url = re.sub(r"(?<=-)20\d{2}(?=$|[/?#])", "{today:%Y}", endpoint)
    return {"url": url, "max_pages": 1}


# --------------------------------------------------------------------------------------------- build

FIELD_ORDER = ("id", "name", "homepage", "lane", "source_type", "access", "egress", "authority", "safety_feed",
               "owner_entity", "launch_tier", "language", "region", "poll_floor_s", "poll_ceiling_s", "enabled",
               "disabled_reason", "category", "config")


def derive(row: dict) -> dict:
    lane = LANE_MAP.get(row["lane"], row["lane"])
    access = map_access(row)
    stype = source_type(row)
    authority = AUTHORITY_BY_CATEGORY.get(row["category"], 3)
    authority = min(authority, AUTHORITY_CAP_BY_TYPE.get(stype, 5))
    safety = (row["category"] == "drug-safety" and stype == "regulator"
              and (row.get("subcategory") or "") in SAFETY_SUBCATEGORIES)
    safety = safety or (row["category"] == "public-health" and row.get("subcategory") == "safety-alert")
    floor, ceiling = cadence(stype, lane, safety, access, row["category"])
    config = adapter_config(row, access)
    hosts = [h for h in (host_of(config.get("url") or ""), host_of(row.get("homepage") or "")) if h]
    if hosts:
        config["allowed_hosts"] = sorted(set(hosts))
    homepage = (row.get("homepage") or "").strip()
    language = {"multi": "mul"}.get(row.get("lang") or "", row.get("lang") or None)
    return {
        "id": row["id"],
        "name": row["name"].strip(),
        "homepage": homepage if homepage.startswith(("http://", "https://")) else None,
        "lane": lane,
        "source_type": stype,
        "access": access,
        "egress": row["egress"],
        "authority": authority,
        "safety_feed": safety,
        "owner_entity": owner_entity(row),
        "launch_tier": row["launch_tier"],
        "language": language,
        "region": row.get("region") or None,
        "poll_floor_s": floor,
        "poll_ceiling_s": ceiling,
        "category": row["category"],
        "config": config,
    }


def apply_override(entry: dict, override: dict) -> dict:
    """Override fields win; ``config`` merges key by key; ``_``-prefixed keys are comments."""
    merged = dict(entry)
    for key, value in override.items():
        if key.startswith("_"):
            continue
        if key == "config":
            merged["config"] = {**merged.get("config", {}), **{k: v for k, v in value.items() if not k.startswith("_")}}
        else:
            merged[key] = value
    return merged


LIST_ACCESSES = ("html-list", "browser-list")


def relay_accepted(path: Path) -> set[str]:
    """Source ids the Tokyo node read with the honest identity on 2026-09-22 (plan 10.2.5 acceptance)."""
    accepted = set()
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                if row.get("verdict") in ("feed-ok", "api-ok", "page-ok"):
                    accepted.add(row["id"])
    return accepted


def decide_enabled(entry: dict, accepted_relay: set[str]) -> tuple[bool, str | None]:
    """Batch 2 (plan 14.6): P0 sources on every exit this build has; the list pages (html-list,
    browser-list) of tiers P0/P1 once their selectors exist; the team's EviMed API scans; and every
    relay source the Tokyo node read on 2026-09-22 with the honest identity."""
    egress, access, tier = entry["egress"], entry["access"], entry["launch_tier"]
    if egress not in IMPLEMENTED_EGRESSES:
        return False, f"egress_{egress}_not_in_this_build"
    if access not in IMPLEMENTED_ACCESSES:
        return False, f"access_{access}_not_in_this_build"
    if access in LIST_ACCESSES and not list_configured(entry["config"]):
        return False, "selectors_missing"
    if egress == "relay":
        if entry["id"] not in accepted_relay:
            return False, "relay_not_accepted"
        return True, None
    if tier == "P0":
        return True, None
    if tier == "P1" and (access in LIST_ACCESSES or access == "evimed-api"):
        return True, None
    return False, f"launch_tier_{tier}"


def adapter_problems(entry: dict) -> list[str]:
    """What this build's adapter says about the row's configuration (none when it has no opinion)."""
    try:
        from knowledge_plugin.adapters import validate_config
    except ImportError:
        return []
    from knowledge_plugin.model import SourceConfig
    source = SourceConfig(**{key: entry.get(key) for key in (
        "id", "name", "homepage", "lane", "source_type", "access", "egress", "authority", "safety_feed", "owner_entity",
        "launch_tier", "language", "region", "poll_floor_s", "poll_ceiling_s", "config")})
    return list(validate_config(source))


def build(probe_rows: list[dict], overrides: dict, extra_rows: list[dict] | None = None,
          accepted_relay: set[str] | None = None) -> dict:
    sources = []
    accepted_relay = accepted_relay or set()
    skipped = {"egress_none": 0, "access_not_loaded": 0, "enrichment_endpoint": 0}
    for row in probe_rows:
        if row["id"] in ENRICHMENT_TOOL_IDS:
            skipped["enrichment_endpoint"] += 1
            continue
        if row["egress"] == "none":
            skipped["egress_none"] += 1
            continue
        if row["access"] in NOT_LOADED_ACCESS:
            skipped["access_not_loaded"] += 1
            continue
        sources.append(finish(derive(row), overrides.get(row["id"]), accepted_relay))
    for row in extra_rows or []:
        entry = {key: row.get(key) for key in FIELD_ORDER if key not in ("enabled", "disabled_reason")}
        sources.append(finish(entry, overrides.get(row["id"]), accepted_relay))
    known = {r["id"] for r in probe_rows} | {r["id"] for r in extra_rows or []}
    unknown = sorted(set(overrides) - known - {"_about"})
    if unknown:
        raise BuildError(f"overrides name unknown source ids: {unknown}")
    return {"registry_version": 1, "skipped": skipped, "sources": sources}


def finish(entry: dict, override: dict | None, accepted_relay: set[str]) -> dict:
    if override:
        entry = apply_override(entry, override)
    if override and "enabled" in override:
        entry["disabled_reason"] = None if entry["enabled"] else (override.get("disabled_reason") or "operator")
    else:
        entry["enabled"], entry["disabled_reason"] = decide_enabled(entry, accepted_relay)
        if entry["enabled"]:
            problems = adapter_problems(entry)
            if problems:
                entry["enabled"], entry["disabled_reason"] = False, ("adapter_config: " + problems[0])[:120]
    return {key: entry.get(key) for key in FIELD_ORDER}


def validate(registry: dict) -> list[str]:
    """Every problem the runtime would refuse (the same ``validate_row`` the load test and the service use)."""
    problems = []
    seen = set()
    for row in registry["sources"]:
        if row["id"] in seen:
            problems.append(f"{row['id']}: duplicate id")
        seen.add(row["id"])
        problems.extend(validate_row(row))
    return problems


def render(registry: dict) -> str:
    return json.dumps(registry, ensure_ascii=False, indent=1) + "\n"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="compare with the committed registry instead of writing")
    parser.add_argument("--probe", type=Path, default=PROBE)
    parser.add_argument("--overrides", type=Path, default=OVERRIDES)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args(argv)
    probe_rows = json.loads(args.probe.read_text(encoding="utf-8"))
    overrides = json.loads(args.overrides.read_text(encoding="utf-8")) if args.overrides.exists() else {}
    extra_rows = json.loads(EXTRA.read_text(encoding="utf-8"))["sources"] if EXTRA.exists() else []
    registry = build(probe_rows, overrides, extra_rows, relay_accepted(RELAY_ACCEPTANCE))
    registry["probe_sha256"] = hashlib.sha256(args.probe.read_bytes()).hexdigest()
    problems = validate(registry)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    text = render(registry)
    if args.check:
        current = args.output.read_text(encoding="utf-8") if args.output.exists() else ""
        if current != text:
            print(f"{args.output} is stale: run tools/build_registry.py", file=sys.stderr)
            return 1
        return 0
    args.output.write_text(text, encoding="utf-8")
    enabled = sum(1 for s in registry["sources"] if s["enabled"])
    print(json.dumps({"sources": len(registry["sources"]), "enabled": enabled, "skipped": registry["skipped"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
