"""EviMed extras for ``/text``: impact factor / core-journal tags, and the NMPA label excerpt.

Recorded 2026-09-22 against the owner's API: three literature searches by title (an NEJM RCT —
matched through another NEJM record, the same-journal fallback — plus two titles the index did not
have) and two v1 label searches (肌苷注射剂 from an NMPA label-revision notice, Domperidone from an
MHRA Drug Safety Update title). The key was added on the wire only and appears in no fixture.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.enrich import enrich_batch, evimed_extras
from knowledge_plugin.enrich import evimed as evimed_step
from knowledge_plugin.enrich.common import Endpoints, Trace
from knowledge_plugin.model import EntryTextResult
from replay import ReplayFetcher, load_case

CONFIGURED = SimpleNamespace(evimed_api_key_file="/run/secrets/evimed-api-key")  # only the path is looked at
NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)


def parsed_entries(case_name):
    case = load_case(case_name)
    return case, [e for r in case.results() for e in REGISTRY[case.source.access].parse(r, case.source, case.now).entries]


def row_of(case, entry):
    source = case.provenance["source"]
    return {"entry_id": f"{source['id']}:x", "revision": 1, "source_id": source["id"], "external_key": entry.external_key,
            "url": entry.url, "doi": entry.doi, "pmid": entry.pmid, "registry_ids": entry.registry_ids, "title": entry.title,
            "summary": entry.summary, "facts": entry.facts, "first_seen_at": case.now, "source_access": source["access"],
            "source_egress": source["egress"], "source_type": source["source_type"], "source_config": source["config"]}


async def test_journal_facts_by_exact_title_else_same_journal():
    case = load_case("enrich/evimed-journal-facts")
    fetcher = ReplayFetcher(case)
    answers = []
    for asked in case.provenance["asked"]:
        answers.append(await evimed_step.journal_facts(fetcher, Endpoints(), title=asked["title"],
                                                       journal=asked["journal"], trace=Trace()))
    assert answers == [{}, {}, {"impact_factor": 78.5, "core_journal_tags": ["MEDICINE, GENERAL & INTERNAL - SCIE(Q1)"]}]
    assert len(fetcher.calls) == 3 and all(source is None for _, _, source in fetcher.calls)


async def test_label_excerpt_for_named_drugs():
    case = load_case("enrich/evimed-drug-label")
    fetcher = ReplayFetcher(case)
    inosine = await evimed_step.drug_label(fetcher, Endpoints(), ["肌苷注射剂"], Trace())
    assert inosine.startswith("【药品】肌苷注射液（山西国润制药有限公司，2 mL：0.1 g）")
    assert "【禁忌】对本品过敏者禁用。" in inosine and "【不良反应】静脉注射偶有恶心、颜面潮红。" in inosine
    assert "未进行该项实验" not in inosine  # label boilerplate is not an excerpt
    assert inosine.endswith(".pdf") and "https://www.evimed.com/drug-details?source=nmpa" in inosine
    domperidone = await evimed_step.drug_label(fetcher, Endpoints(), ["Domperidone"], Trace())
    assert domperidone.startswith("【药品】多潘立酮片")  # matched through the label's English name


def test_drug_names_come_only_from_closed_title_forms():
    _, cdr = parsed_entries("html-list/cdr-adr-safety-warnings")
    named = {e.title: evimed_step.drug_mentions(e.title, "regulator") for e in cdr}
    assert named["国家药监局关于修订肌苷注射剂说明书的公告（2026年第87号）"] == ["肌苷注射剂"]
    assert named["国家药监局关于修订四季感冒片和四季感冒胶囊药品说明书的公告（2026年第28号）"] == ["四季感冒片", "四季感冒胶囊"]
    assert named["国家药监局关于愈美制剂非处方药转换为处方药的公告（2026年第83号）"] == ["愈美制剂"]
    assert named["药物警戒快讯2026年第8期（总第280期）"] == []
    _, mhra = parsed_entries("atom/mhra-drug-safety-update")
    titles = {e.title for e in mhra}
    assert evimed_step.drug_mentions(next(t for t in titles if t.startswith("Domperidone:")), "regulator") == ["Domperidone"]
    assert evimed_step.drug_mentions(next(t for t in titles if t.startswith("Filters should")), "regulator") == []
    assert evimed_step.drug_mentions("Domperidone: new contraindication", "media") == []  # regulator titles only


def test_label_matching_needs_ingredient_and_dosage_form():
    tablet = {"genericNames": "肌苷片", "englishName": "Inosine Tablets"}
    injection = {"genericNames": "肌苷注射液", "englishName": "Inosine Injection"}
    assert not evimed_step.label_matches(tablet, "肌苷注射剂") and evimed_step.label_matches(injection, "肌苷注射剂")
    assert evimed_step.label_matches({"genericNames": "注射用肌苷"}, "肌苷注射剂")
    assert evimed_step.label_matches({"genericNames": "多潘立酮片", "englishName": "Domperidone Tablets"}, "Domperidone")
    assert not evimed_step.label_matches({"genericNames": "莫沙必利片", "englishName": "Mosapride Tablets"}, "Domperidone")


async def test_safety_notice_with_a_challenged_page_still_gets_the_label():
    page = load_case("enrich/page-nmpa-challenge")
    fetcher = ReplayFetcher(page, load_case("enrich/evimed-drug-label"))
    (result,) = await enrich_batch(page.rows, fetcher, CONFIGURED, now=NOW)
    assert result.status == "available" and result.text_kind == "none"  # something to show: the label
    assert result.enrichment["drug_label_excerpt"].startswith("【药品】肌苷注射液")
    assert "page_challenge:ruishu" in result.notes
    unconfigured = ReplayFetcher(page)  # no EviMed exchange: any EviMed request would fail the test
    (plain,) = await enrich_batch(page.rows, unconfigured, None, now=NOW)
    assert plain.status == "unavailable" and "drug_label_excerpt" not in plain.enrichment


async def test_journal_facts_join_a_final_answer_only():
    case, entries = parsed_entries("eutils-query/rct-core-journals")
    row = row_of(case, next(e for e in entries if e.pmid == "42748429"))
    fetcher = ReplayFetcher(load_case("enrich/evimed-journal-facts"))
    final = EntryTextResult(status="available", text_kind="abstract", abstract="BACKGROUND: …", fetched_from="pubmed")
    result = await evimed_extras(row, final, fetcher, Endpoints())
    assert result.enrichment == {"impact_factor": 78.5, "core_journal_tags": ["MEDICINE, GENERAL & INTERNAL - SCIE(Q1)"]}
    pending = EntryTextResult(status="pending", retry_after_s=43200)
    assert (await evimed_extras(row, pending, ReplayFetcher(), Endpoints())) is pending  # no call on a retry


async def test_evimed_api_records_are_their_own_text():
    case, entries = parsed_entries("evimed-api/chictr-v1")
    row = row_of(case, entries[0])
    assert row["source_access"] == "evimed-api" and row["url"].startswith("https://www.chictr.org.cn/")
    fetcher = ReplayFetcher()  # nothing may be fetched: ChiCTR answers 405 to programs
    (result,) = await enrich_batch([row], fetcher, None, now=NOW)
    assert (result.status, result.notes) == ("unavailable", ["record_is_the_text"]) and fetcher.calls == []
