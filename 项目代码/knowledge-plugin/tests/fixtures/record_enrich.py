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
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent))

from record import UA, RecordingFetcher, _now  # noqa: E402
from replay import load_case  # noqa: E402

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


def main(argv: list[str]) -> int:
    names = argv or [*CASES, "enrich/pubmed-doi-realign", "enrich/pubmed-doi-unquoted", "enrich/evimed-journal-facts",
                     "enrich/evimed-drug-label"]
    for name in names:
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
