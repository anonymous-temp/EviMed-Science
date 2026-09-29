"""A source marker that is only a number never rewrites a citation or the reference list.

Production ma-001 (job meta-20260928185649, 2026-09-28): the claim map's
source location "参考文献 [8]：高危患者选择偏倚" reduced to the marker key "8",
which mapped to reference 2, and every "［8］" in the manuscript - the label of
reference 8 in the reference list included - became "［2］". Validation found
reference 8 missing and 2 duplicated and blocked the manuscript; the delivered
draft was the blocked stub with no references, and 17 release gates failed
behind it (citation contract "skipped", reference count 0).

Fixture: the production claim map and selected rows, and the reference list of
draft.rejected.md with the label of reference 8 restored.
"""
from __future__ import annotations

import json
from pathlib import Path

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "ma001_reference_marker_collision.json").read_text())


def _writer():
    from new_meta.agents.writing_agent import WritingAgent
    writer = WritingAgent.__new__(WritingAgent)
    writer._lang = "zh"
    return writer


def _maps(writer, references):
    entries = writer._reference_entries_from_references_section(references)
    refs_text = "\n\n".join(f"[{int(entry['number'])}] {entry['text']}" for entry in entries)
    facts = FIXTURE["facts"]
    return entries, {**writer._source_id_reference_number_map(entries, facts),
                     **writer._claim_marker_reference_number_map(entries, facts, refs_text)}


def test_the_production_source_location_reduces_to_a_bare_number():
    from new_meta.agents.writing.claim_map import ClaimMapMixin
    claim = next(item for item in FIXTURE["facts"]["claim_map"] if item["id"] == "disc-applicability-boundary")
    parts = [part.strip() for part in claim["source_location"].split("；")]
    assert "8" in {ClaimMapMixin._claim_source_marker_key(part) for part in parts}


def test_no_marker_key_is_a_citation_number():
    _, mapping = _maps(_writer(), FIXTURE["references_section"])
    assert mapping, "the production claim map yields source markers"
    assert not [key for key in mapping if key.isdigit() and int(key) < 1000]


def test_citations_and_the_reference_list_survive_marker_replacement():
    writer = _writer()
    references = FIXTURE["references_section"]
    entries, mapping = _maps(writer, references)
    assert [entry["number"] for entry in entries] == list(range(1, 18))
    body = ("## 引言\n\n高危患者常被排除，安全性证据有限［8］。髋关节置换的合并证据见［6］。\n\n"
            "## 讨论\n\n两项试验的剂量不同［2，4］。\n\n")
    manuscript = body + references
    # Even a map that did carry the colliding key cannot touch either.
    for current in (mapping, {**mapping, "8": [2]}):
        replaced = writer._replace_source_id_citation_markers(manuscript, current)
        head, tail = replaced.split("## 参考文献", 1)
        assert "［8］" in head and "［6］" in head and "［2，4］" in head
        assert [entry["number"] for entry in writer._reference_entries_from_references_section(replaced)] == list(range(1, 18))
        assert tail == references.split("## 参考文献", 1)[1]


def test_a_real_source_marker_is_still_replaced():
    writer = _writer()
    replaced = writer._replace_source_id_citation_markers("结果见［PMID 29410968］。\n", {"29410968": 2})
    assert replaced == "结果见［2］。\n"
