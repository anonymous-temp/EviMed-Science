#!/usr/bin/env python3
"""Record the upstream answers ``knowledge_plugin.enrich`` asks for, as enrichment-test fixtures.

Usage (plugin directory, .venv): ``.venv/bin/python tests/fixtures/record_enrich.py [<case> …]``

Each case builds entry rows the way the store would hand them to the text worker — from entries
the adapters parsed out of already-recorded adapter cases (so every DOI, PMID and URL is real) —
runs ``enrich_batch`` on them with ``record.RecordingFetcher`` and stores every exchange plus the
rows in ``provenance.json``. The tests replay the exchanges with ``replay.ReplayFetcher`` and run
the same code on the same rows. Etiquette and redaction are ``record.py``'s.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent))

from record import UA, RecordingFetcher, _now, registry_row  # noqa: E402
from replay import ReplayFetcher, load_case  # noqa: E402

from knowledge_plugin.adapters import REGISTRY  # noqa: E402
from knowledge_plugin.enrich import enrich_batch  # noqa: E402
from knowledge_plugin.enrich import pubmed as pubmed_step  # noqa: E402
from knowledge_plugin.enrich.common import Endpoints, Trace  # noqa: E402
from knowledge_plugin.model import FetchError  # noqa: E402


# The 40 DOIs of the 2026-09-21 dry run's PubMed batch 37 (sorted Crossref DOIs, /tmp/medhot2 cache):
# searched unquoted, that batch named 200 PMIDs of which 175 carried a DOI nobody asked for.
OVER_RETURN_BATCH = [
    "10.1542/peds.2026-077055", "10.1542/peds.2026-077116", "10.1542/peds.2026-077264",
    "10.1542/peds.2026-077329", "10.1542/peds.2026-078069", "10.1542/peds.2026-078328",
    "10.1542/peds.2026-078595", "10.1681/asn.0000001248", "10.1681/asn.0000001252",
    "10.1681/asn.0000001253", "10.1681/asn.0000001255", "10.1681/asn.0000001258",
    "10.1681/asn.0000001269", "10.1681/asn.0000001277", "10.1681/asn.0000001283",
    "10.2196/100426", "10.2196/100446", "10.2196/101137",
    "10.2196/102862", "10.2196/103006", "10.2196/103353",
    "10.2196/105190", "10.2196/105501", "10.2196/106707",
    "10.2196/108093", "10.2196/111307", "10.2196/111559",
    "10.2196/111657", "10.2196/111711", "10.2196/75737",
    "10.2196/79870", "10.2196/84065", "10.2196/87084",
    "10.2196/88732", "10.2196/89400", "10.2196/89720",
    "10.2196/90168", "10.2196/90724", "10.2196/91054",
    "10.2196/91531",
]


def entries_of(case_name: str):
    case = load_case(case_name)
    adapter = REGISTRY[case.source.access]
    found = []
    for result in case.results():
        try:
            found += adapter.parse(result, case.source, case.now).entries
        except FetchError:
            continue  # a recorded upstream fault (Europe PMC's bare version answer) has no entries
    return case, found


def row_of(case, entry) -> dict:
    """An entry row as the store hands it to enrichment (model.Enricher keys)."""
    source = case.provenance["source"]
    key_hash = hashlib.sha256(entry.external_key.encode("utf-8")).hexdigest()[:32]
    return {
        "entry_id": f"{source['id']}:{key_hash}", "revision": 1, "source_id": source["id"],
        "external_key": entry.external_key, "identity_key": entry.identity_hint or (f"doi:{entry.doi}" if entry.doi else None),
        "url": entry.url, "canonical_url": entry.url, "doi": entry.doi, "pmid": entry.pmid,
        "registry_ids": entry.registry_ids, "title": entry.title, "summary": entry.summary, "lang": entry.language,
        "published_at": entry.published_at.isoformat() if entry.published_at else None, "facts": entry.facts,
        "first_seen_at": case.provenance["now"], "source_access": source["access"], "source_egress": source["egress"],
        "source_type": source["source_type"], "source_config": source["config"], "attempts": 0,
    }


def pick(case_name: str, keys: list[str]):
    case, found = entries_of(case_name)
    by_key = {e.external_key: e for e in found}
    return [row_of(case, by_key[k]) for k in keys]


def journal_batch_rows():
    return (pick("crossref-issn/nejm", ["10.1056/nejmicm2609443", "10.1056/nejmp2605442", "10.1056/nejmoa2605659"])
            + pick("crossref-issn/frontiers-pharmacology-paging", ["10.3389/fphar.2026.1852584"])
            + pick("eutils-query/rct-core-journals", ["42748428"]))


def crossref_abstract_rows():
    rows = pick("crossref-issn/frontiers-pharmacology-paging", ["10.3389/fphar.2026.1747506"])
    for row in rows:  # the same article as a journal feed would carry it: DOI, no abstract of its own
        row.update(source_access="rss", source_type="journal", summary=None, source_config={"url": "https://example.invalid/feed"})
    return rows


def preprint_rows():
    case, found = entries_of("europepmc/medrxiv-preprints")
    rows = [row_of(case, found[0])]
    linked = dict(rows[0])  # a medRxiv preprint Europe PMC links to its journal version (seen 2026-09-22)
    linked.update(doi="10.64898/2026.08.25.26361362", external_key="PPR:PPR1308905", url="https://doi.org/10.64898/2026.08.25.26361362",
                  summary=None, title="medRxiv preprint PPR1308905")
    return rows + [linked]


CASES = {
    "enrich/journal-batch": journal_batch_rows,
    "enrich/crossref-abstract": crossref_abstract_rows,
    "enrich/preprint-links": preprint_rows,
    "enrich/trial": lambda: pick("json-api/ctgov-results-first-posted", ["NCT07110077:results-posted:2026-09-21"]),
    "enrich/page-who-news": lambda: pick("json-api/who-news", ["d8ded62d-c7b7-4de1-b3f8-1c546ad22234"]),
    "enrich/page-gov-cn": lambda: pick("html-list/gov-cn-policy", ["https://www.gov.cn/zhengce/202609/content_7081587.htm"]),
    "enrich/page-nmpa-challenge": lambda: pick("html-list/cdr-adr-safety-warnings",
                                               ["https://www.nmpa.gov.cn/xxgk/ggtg/ypggtg/ypshmshxdgg/20260904163246192.html"]),
}


async def record_rows_case(name: str, rows: list[dict]) -> dict:
    case_dir = HERE / name
    case_dir.mkdir(parents=True, exist_ok=True)
    for old in case_dir.iterdir():
        old.unlink()
    fetcher = RecordingFetcher(case_dir)
    try:
        results = await enrich_batch(rows, fetcher, None)
    finally:
        await fetcher.close()
    provenance = {"case": name, "recorded_by": "tests/fixtures/record_enrich.py (package P2)", "user_agent": UA,
                  "recorded_at": _now().isoformat(), "rows": rows,
                  "results_at_recording": [{"status": r.status, "text_kind": r.text_kind, "fetched_from": r.fetched_from,
                                            "enrichment_keys": sorted(r.enrichment), "notes": r.notes} for r in results],
                  "exchanges": fetcher.exchanges}
    (case_dir / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=1, default=str) + "\n",
                                              encoding="utf-8")
    return provenance


async def record_realign_case() -> dict:
    """``pubmed.lookup`` alone (quoted ``"<doi>"[doi]`` terms) on the dry run's over-returning batch."""
    name = "enrich/pubmed-doi-realign"
    case_dir = HERE / name
    case_dir.mkdir(parents=True, exist_ok=True)
    for old in case_dir.iterdir():
        old.unlink()
    dois = list(OVER_RETURN_BATCH)
    fetcher = RecordingFetcher(case_dir)
    trace = Trace()
    try:
        records = await pubmed_step.lookup(fetcher, Endpoints(), dois=dois, pmids=[], trace=trace)
    finally:
        await fetcher.close()
    provenance = {"case": name, "recorded_by": "tests/fixtures/record_enrich.py (package P2)", "user_agent": UA,
                  "recorded_at": _now().isoformat(), "dois": dois,
                  "result_at_recording": {"keys": sorted(records), "notes": trace.notes}, "exchanges": fetcher.exchanges}
    (case_dir / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return provenance


async def record_unquoted_case() -> dict:
    """The dry run's unquoted ``<doi>[doi] OR …`` search for the same 40 DOIs, and the records it names."""
    from urllib.parse import quote

    from knowledge_plugin.model import RequestSpec

    name = "enrich/pubmed-doi-unquoted"
    case_dir = HERE / name
    case_dir.mkdir(parents=True, exist_ok=True)
    for old in case_dir.iterdir():
        old.unlink()
    dois = list(OVER_RETURN_BATCH)
    endpoints = Endpoints()
    term = " OR ".join(f"{doi}[doi]" for doi in dois)
    fetcher = RecordingFetcher(case_dir)
    try:
        search = await fetcher.fetch(RequestSpec(
            url=f"{endpoints.pubmed_esearch}?db=pubmed&retmode=json&retmax=200&term={quote(term, safe='')}",
            conditional=False, api=True))
        ids = json.loads(search.body)["esearchresult"]["idlist"][:40]  # the first 40 named records suffice
        if ids:
            await fetcher.fetch(RequestSpec(url=pubmed_step.efetch_url(endpoints, ids), conditional=False, api=True))
    finally:
        await fetcher.close()
    provenance = {"case": name, "recorded_by": "tests/fixtures/record_enrich.py (package P2)", "user_agent": UA,
                  "recorded_at": _now().isoformat(), "dois": dois,
                  "note": "negative form: the unquoted [doi] search the 2026-09-21 dry run used (14 % of its records were never asked for)",
                  "exchanges": fetcher.exchanges}
    (case_dir / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return provenance


async def record_evimed_case(name: str) -> dict:
    """The two EviMed lookups alone: journal facts by title, and the NMPA label by drug name."""
    from knowledge_plugin.enrich import evimed as evimed_step

    case_dir = HERE / name
    case_dir.mkdir(parents=True, exist_ok=True)
    for old in case_dir.iterdir():
        old.unlink()
    endpoints = Endpoints()
    fetcher = RecordingFetcher(case_dir)
    trace = Trace()
    asked: list = []
    answers: list = []
    try:
        if name == "enrich/evimed-journal-facts":
            _, mr = entries_of("eutils-query/mendelian-randomization-backward-pages")
            _, cn = entries_of("rss/chinjmap-double-escaped")
            _, nejm = entries_of("eutils-query/rct-core-journals")
            picks = [next(e for e in mr if e.pmid == "42748643"), cn[0], next(e for e in nejm if e.pmid == "42748429")]
            for entry in picks:
                asked.append({"title": entry.title, "journal": entry.facts.get("journal")})
                answers.append(await evimed_step.journal_facts(fetcher, endpoints, title=entry.title,
                                                               journal=entry.facts.get("journal"), trace=trace))
        else:
            for names in (["肌苷注射剂"], ["Domperidone"]):
                asked.append(names)
                answers.append(await evimed_step.drug_label(fetcher, endpoints, names, trace))
    finally:
        await fetcher.close()
    provenance = {"case": name, "recorded_by": "tests/fixtures/record_enrich.py (package P2)", "user_agent": UA,
                  "recorded_at": _now().isoformat(), "asked": asked, "answers_at_recording": answers,
                  "notes_at_recording": trace.notes, "exchanges": fetcher.exchanges}
    (case_dir / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return provenance


# ---------------------------------------------------------------------------------------------
# rt-papers (2026-10-22): the paper text chain — OpenAlex, feeds, landing pages, Europe PMC full text
# ---------------------------------------------------------------------------------------------

RT_PAPERS = "tests/fixtures/record_enrich.py (rt-papers, 2026-10-22)"


def paper_row(doi: str, source_id: str | None = None, *, first_seen: str = "2026-10-22T08:00:00+00:00",
              attempts: int = 0) -> dict:
    """A journal entry as the store hands it to enrichment, for a real DOI: the registry row's exit and config when
    the journal is one of ours (its ``abstract_feed`` included), a Crossref ISSN reader's otherwise."""
    source = registry_row(source_id) if source_id else None
    return {
        "entry_id": f"{source_id or 'paper'}:{hashlib.sha256(doi.encode()).hexdigest()[:32]}", "revision": 1,
        "source_id": source_id, "external_key": doi, "identity_key": f"doi:{doi}", "url": f"https://doi.org/{doi}",
        "canonical_url": f"https://doi.org/{doi}", "doi": doi, "pmid": None, "registry_ids": [], "title": None,
        "summary": None, "lang": "en", "published_at": None, "facts": {}, "first_seen_at": first_seen,
        "source_access": source["access"] if source else "crossref-issn",
        "source_egress": source["egress"] if source else "direct",
        "source_type": source["source_type"] if source else "journal",
        "source_config": source["config"] if source else {}, "attempts": attempts,
    }


PAPER_CASES = {
    # Only OpenAlex has the abstract (an Elsevier-hosted journal: Crossref and PubMed without it; the page refuses us).
    "enrich/paper-openalex": lambda: [paper_row("10.1016/s1001-9294(22)00007-4")],
    # A closed Springer article, structured abstract on its landing page through the direct exit.
    "enrich/paper-landing-springer": lambda: [paper_row("10.1007/s00228-026-04200-w", "j-0031-6970")],
    # Nature: a research article published that day (abstract on the page, the body not out yet) and a news piece
    # (no abstract: its standfirst).
    "enrich/paper-landing-nature": lambda: [paper_row("10.1038/s41467-026-78936-5", "j-2041-1723"),
                                            paper_row("10.1038/d41586-026-03374-8", "j-0028-0836")],
    # JAMA answers a Cloudflare challenge: an answer, never something to get round.
    "enrich/paper-challenge": lambda: [paper_row("10.1001/jama.2026.20670", "j-0098-7484")],
    # An open article in PMC: Europe PMC's JATS full text.
    "enrich/paper-fulltext-epmc": lambda: [paper_row("10.1186/s12874-024-02160-2", "j-1471-2288",
                                                     first_seen="2024-02-29T08:00:00+00:00")],
    # An open, CC-BY article no index has a PMC id for yet: its whole text off the landing page.
    "enrich/paper-oa-landing": lambda: [paper_row("10.3389/fpubh.2026.1975587")],
}


def fresh_chain_state() -> None:
    """Each case starts with no host verdicts and no cached feeds, and runs its entries one at a time — the order a
    replay (whose answers never wait) runs them in, so a verdict recorded for one entry is seen by the next."""
    from knowledge_plugin import enrich as enrich_module
    from knowledge_plugin.enrich import feeds as feeds_step
    from knowledge_plugin.enrich import landing as landing_step

    landing_step.VERDICTS.until.clear()
    feeds_step.CACHE.entries.clear()
    feeds_step.CACHE.locks.clear()
    enrich_module.ENTRY_CONCURRENCY = 1


class ExtendingFetcher:
    """The recorded exchanges of a case first; what the code asks beyond them, recorded live (``extend_case``)."""

    def __init__(self, case, recorder: RecordingFetcher) -> None:
        self.replay = ReplayFetcher(case)
        self.recorder = recorder
        self.new: list[str] = []

    async def fetch(self, spec, *, source_id=None, egress="direct", allowed_hosts=None, wait_for=None):
        if ReplayFetcher._key(spec) in self.replay.table:
            return await self.replay.fetch(spec, source_id=source_id, egress=egress, allowed_hosts=allowed_hosts)
        self.new.append(spec.url)
        return await self.recorder.fetch(spec, source_id=source_id, egress=egress, allowed_hosts=allowed_hosts)


async def extend_case(name: str, reason: str) -> dict:
    """Run today's chain on a recorded case: its recorded answers are served as they were, the requests the chain
    makes beyond them are recorded live and appended (``extensions`` in the provenance names them)."""
    case = load_case(name)
    case_dir = HERE / name
    provenance = json.loads((case_dir / "provenance.json").read_text(encoding="utf-8"))
    recorder = RecordingFetcher(case_dir, credentials=False, contact=False, trim_html=True)
    recorder.exchanges = list(provenance["exchanges"])
    before = len(recorder.exchanges)
    fetcher = ExtendingFetcher(case, recorder)
    now = datetime.fromisoformat(provenance["recorded_at"])
    fresh_chain_state()
    try:
        results = await enrich_batch(case.rows, fetcher, None, now=now)
    finally:
        await recorder.close()
    provenance["exchanges"] = recorder.exchanges
    provenance.setdefault("extensions", []).append({
        "recorded_by": RT_PAPERS, "recorded_at": _now().isoformat(), "reason": reason,
        "exchanges": list(range(before, len(recorder.exchanges))),
        "results_at_recording": [{"status": r.status, "text_kind": r.text_kind, "fetched_from": r.fetched_from,
                                  "notes": r.notes} for r in results]})
    (case_dir / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=1, default=str) + "\n",
                                              encoding="utf-8")
    return provenance


async def record_paper_case(name: str, rows: list[dict]) -> dict:
    case_dir = HERE / name
    case_dir.mkdir(parents=True, exist_ok=True)
    for old in case_dir.iterdir():
        old.unlink()
    fetcher = RecordingFetcher(case_dir, credentials=False, contact=False, trim_html=True)
    recorded_at = _now()
    fresh_chain_state()
    try:
        results = await enrich_batch(rows, fetcher, None, now=recorded_at)
    finally:
        await fetcher.close()
    provenance = {"case": name, "recorded_by": RT_PAPERS, "user_agent": UA, "recorded_at": recorded_at.isoformat(),
                  "note": "Unpaywall asked without a contact address (no secret read): its 422 is recorded as it came",
                  "rows": rows,
                  "results_at_recording": [{"status": r.status, "text_kind": r.text_kind, "fetched_from": r.fetched_from,
                                            "abstract_chars": len(r.abstract or ""), "body_chars": len(r.body_text or ""),
                                            "notes": r.notes} for r in results],
                  "exchanges": fetcher.exchanges}
    (case_dir / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=1, default=str) + "\n",
                                              encoding="utf-8")
    return provenance


# Publisher feeds as the feed step reads them (one exchange per feed), for ``feeds.parse_items`` and ``feed_text``.
FEEDS = {
    "oup-cid-advance": "https://academic.oup.com/rss/site_5269/advanceAccess_3135.xml",
    "oup-cid-current": "https://academic.oup.com/rss/site_5269/3135.xml",
    "bmj-recent": "https://www.bmj.com/rss/recent.xml",
    "jama-online-first": "https://jamanetwork.com/rss/site_3/onlineFirst_67.xml",
    "jamanetworkopen-new": "https://jamanetwork.com/rss/site_214/187.xml",
    "lancet-online": "https://www.thelancet.com/rssfeed/lancet_online.xml",
    "gastro-current": "https://www.gastrojournal.org/current.rss",
}


async def record_feeds_case(name: str = "enrich/paper-feeds") -> dict:
    from knowledge_plugin.enrich import feeds as feeds_step

    case_dir = HERE / name
    case_dir.mkdir(parents=True, exist_ok=True)
    for old in case_dir.iterdir():
        old.unlink()
    fetcher = RecordingFetcher(case_dir, credentials=False, contact=False)
    cache = feeds_step.FeedCache()
    read: dict = {}
    try:
        for key, url in FEEDS.items():
            trace = Trace()
            items = await feeds_step.read_feed(fetcher, url, source_id=None, egress="direct", trace=trace, cache=cache)
            read[key] = {"url": url, "items": None if items is None else len(items), "notes": trace.notes,
                         "dois": sorted({d for item in items or [] for d in item.dois})[:5]}
    finally:
        await fetcher.close()
    provenance = {"case": name, "recorded_by": RT_PAPERS, "user_agent": UA, "recorded_at": _now().isoformat(),
                  "feeds": read, "exchanges": fetcher.exchanges}
    (case_dir / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return provenance


# Landing pages for the extractor alone (``article_html.read_article_page``): the DOI's handle record names the page,
# which is read as the landing step reads it (text/html), through the exit named. The browser is a local Chromium at
# ``--cdp`` (the plugin's own browser egress: robots.txt through it, its outcome rules); a page that challenges it is
# recorded as it answered.
PAGES = {
    "nejm-original-article": ("10.1056/nejmoa2605659", "browser"),       # Atypon: section#abstract, h2 headings
    "pnas-research-article": ("10.1073/pnas.2613776123", "browser"),     # Atypon "core": property=abstract, role=paragraph
    "bmjopen-research": ("10.1136/bmjopen-2026-123573", "direct"),       # HighWire: citation_abstract with <h3> sections
    "plos-medicine-research": ("10.1371/journal.pmed.1005265", "direct"),  # PLOS: #artText, CC BY
    "mdpi-ijms-article": ("10.3390/ijms27209345", "direct"),             # MDPI: .html-body, CC BY
}


async def record_pages_case(name: str = "enrich/paper-pages", cdp: str = "http://127.0.0.1:55681") -> dict:
    from knowledge_plugin.enrich import landing as landing_step
    from knowledge_plugin.enrich.common import get
    from knowledge_plugin.model import FetchError

    case_dir = HERE / name
    case_dir.mkdir(parents=True, exist_ok=True)
    for old in case_dir.iterdir():
        old.unlink()
    fetcher = RecordingFetcher(case_dir, credentials=False, contact=False, trim_html=True, browser_cdp=cdp)
    pages: dict = {}
    try:
        for key, (doi, egress) in PAGES.items():
            trace = Trace()
            url = await landing_step.resolve(fetcher, Endpoints(), doi, trace)
            before = len(fetcher.exchanges)
            attempt = await get(fetcher, url, api=False, egress=egress, headers={"Accept": landing_step.ACCEPT_HTML},
                                allowed_hosts=landing_step.site_hosts(url) if egress == "browser" else None)
            error: FetchError | None = attempt.error
            pages[key] = {"doi": doi, "egress": egress, "url": url, "exchange": before if len(fetcher.exchanges) > before else None,
                          "outcome": "ok" if error is None else f"{error.outcome}:{error.detail}"}
    finally:
        await fetcher.close()
    provenance = {"case": name, "recorded_by": RT_PAPERS, "user_agent": UA, "recorded_at": _now().isoformat(),
                  "pages": pages, "exchanges": fetcher.exchanges}
    (case_dir / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return provenance


EXTEND = {
    "enrich/journal-batch": "the paper text chain (rt-papers): OpenAlex, the journal's feeds and the landing page for "
                            "the entries without an abstract, and the open-access check of the others",
    "enrich/crossref-abstract": "the paper text chain (rt-papers): the open-access check of an entry with an abstract",
}


def main(argv: list[str]) -> int:
    names = argv or [*CASES, "enrich/pubmed-doi-realign", "enrich/pubmed-doi-unquoted", "enrich/evimed-journal-facts",
                     "enrich/evimed-drug-label"]
    for name in names:
        if name in PAPER_CASES:
            provenance = asyncio.run(record_paper_case(name, PAPER_CASES[name]()))
            print(name, [e.get("status") for e in provenance["exchanges"]], provenance["results_at_recording"], flush=True)
            continue
        if name == "enrich/paper-pages":
            provenance = asyncio.run(record_pages_case())
            print(name, json.dumps(provenance["pages"])[:1200], flush=True)
            continue
        if name == "enrich/paper-feeds":
            provenance = asyncio.run(record_feeds_case())
            print(name, json.dumps(provenance["feeds"])[:800], flush=True)
            continue
        if name.startswith("extend:"):
            case = name.split(":", 1)[1]
            provenance = asyncio.run(extend_case(case, EXTEND[case]))
            print(name, provenance["extensions"][-1], flush=True)
            continue
        if name in ("enrich/evimed-journal-facts", "enrich/evimed-drug-label"):
            provenance = asyncio.run(record_evimed_case(name))
            print(name, [e.get("status") for e in provenance["exchanges"]], provenance["notes_at_recording"],
                  json.dumps(provenance["answers_at_recording"], ensure_ascii=False)[:600], flush=True)
            continue
        if name == "enrich/pubmed-doi-unquoted":
            provenance = asyncio.run(record_unquoted_case())
            print(name, [e.get("status") for e in provenance["exchanges"]], flush=True)
            continue
        if name == "enrich/pubmed-doi-realign":
            provenance = asyncio.run(record_realign_case())
            print(name, [e.get("status") for e in provenance["exchanges"]], provenance["result_at_recording"]["notes"], flush=True)
            continue
        provenance = asyncio.run(record_rows_case(name, CASES[name]()))
        print(name, [e.get("status") for e in provenance["exchanges"]],
              [(r["status"], r["text_kind"], r["fetched_from"]) for r in provenance["results_at_recording"]], flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
