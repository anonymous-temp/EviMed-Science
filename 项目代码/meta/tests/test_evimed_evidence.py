import json
import requests
import subprocess

import new_meta.main as main_module
from new_meta.core.project import Project
from new_meta.main import (
    _add_evidence_context_references,
    _background_paper_matches_protocol,
    _evidence_context_query,
    _pubmed_background_query,
)
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.tools.evimed_evidence import normalize_evidence_response, search_evimed_evidence
from new_meta.tools.reference_manager import ReferenceManager


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Do SGLT2 inhibitors improve outcomes in heart failure?",
        pico=PICO(
            population="Adults with heart failure with preserved or mildly reduced ejection fraction",
            intervention="SGLT2 inhibitors",
            comparator="Placebo",
            outcome_primary="Cardiovascular death or hospitalization for heart failure",
        ),
        effect_measure="HR",
        model_preference="random",
    )


def test_evidence_context_query_uses_concise_research_question_before_verbose_pico() -> None:
    protocol = _protocol()
    protocol.pico.intervention = "SGLT2 inhibitors " + "with extended dosing details " * 40

    query = _evidence_context_query(protocol, search_query="ignored long Boolean query")

    assert query.startswith("SGLT2 inhibitors Adults with heart failure")
    assert len(query) <= 260
    assert "guideline systematic review meta-analysis" in query
    assert "extended dosing details" not in query


def test_evidence_context_query_keeps_drug_after_route_and_timing_modifiers() -> None:
    protocol = ResearchProtocol(
        research_question="Does dexmedetomidine prevent postoperative delirium?",
        pico=PICO(
            population="Adults aged 65 years or older undergoing noncardiac surgery",
            intervention="Perioperative intravenous dexmedetomidine (any dose, any regimen)",
            comparator="Placebo",
            outcome_primary="Incidence of postoperative delirium",
        ),
        effect_measure="RR",
        model_preference="random",
    )

    query = _evidence_context_query(protocol)

    assert query.startswith("dexmedetomidine ")
    assert "Perioperative intravenous Adults" not in query


def test_generic_background_match_rejects_postoperative_but_topic_mismatched_review() -> None:
    protocol = ResearchProtocol(
        research_question="Does dexmedetomidine prevent postoperative delirium?",
        pico=PICO(
            population="Adults aged 65 years or older undergoing noncardiac surgery",
            intervention="Perioperative intravenous dexmedetomidine",
            comparator="Placebo",
            outcome_primary="Incidence of postoperative delirium",
        ),
        effect_measure="RR",
        model_preference="random",
    )

    assert _background_paper_matches_protocol(
        protocol,
        {"title": "Single-dose intravenous ketorolac for acute postoperative pain in adults"},
    ) is False
    assert _background_paper_matches_protocol(
        protocol,
        {"title": "Dexmedetomidine for postoperative delirium after noncardiac surgery: a systematic review"},
    ) is True
    assert _background_paper_matches_protocol(
        protocol,
        {"title": "Postoperative delirium in older adults after noncardiac surgery: a clinical review"},
    ) is True


def test_pubmed_background_query_uses_fielded_sglt2_heart_failure_terms() -> None:
    query = _pubmed_background_query(_protocol())

    assert "SGLT2[Title/Abstract]" in query
    assert "empagliflozin[Title/Abstract]" in query
    assert '"heart failure"[Title/Abstract]' in query
    assert "HFpEF[Title/Abstract]" in query
    assert "guideline[Publication Type]" in query
    assert "Adults with heart failure and left ventricular" not in query


def test_pubmed_background_query_recognizes_spelled_out_sglt2_intervention() -> None:
    protocol = _protocol()
    protocol.pico.intervention = "Sodium-glucose cotransporter-2 inhibitors"

    query = _pubmed_background_query(protocol)

    assert "SGLT2[Title/Abstract]" in query
    assert '"heart failure"[Title/Abstract]' in query
    assert "preserved ejection fraction" in query


def test_background_match_rejects_diabetes_only_review_for_spelled_out_sglt2_hf_protocol() -> None:
    protocol = _protocol()
    protocol.pico.intervention = "Sodium-glucose cotransporter-2 inhibitors"
    paper = {
        "title": "Benefits and harms of drug treatment for type 2 diabetes: systematic review and network meta-analysis",
        "abstract": "Sodium-glucose cotransporter-2 inhibitors were compared with other diabetes drugs.",
    }

    assert _background_paper_matches_protocol(protocol, paper) is False


def test_evimed_evidence_response_is_normalized_for_background_references() -> None:
    payload = {
        "code": 200,
        "msg": "success",
        "data": {
            "paper": [
                {
                    "id": "paper-1",
                    "title": "SGLT2 inhibitors and heart failure outcomes.",
                    "summary": "This review summarizes randomized evidence in heart failure.",
                    "literatureTitle": (
                        "Example A, Example B. SGLT2 inhibitors and heart failure outcomes. "
                        "J Card Fail. 2025;31:1-9. doi:10.1000/hf.2025.001"
                    ),
                    "journal": "Journal of Cardiac Failure",
                    "year": "2025",
                    "url": json.dumps({"Pubmed": "https://pubmed.ncbi.nlm.nih.gov/12345678/"}),
                    "type": "系统评价",
                }
            ],
            "guide": [
                {
                    "guideId": "guide-1",
                    "title": "Heart failure guideline",
                    "formulator": "Example Cardiology Society",
                    "year": "2024",
                    "introduction": "Guideline background text.",
                    "url": "https://www.evimed.com/guide-details?id=guide-1",
                }
            ],
            "clinicalTrials": [
                {
                    "registerNo": "NCT01234567",
                    "title": "Trial registration record",
                    "belong": "ClinicalTrials",
                    "registerDate": "2023-02-01",
                    "url": "https://clinicaltrials.gov/study/NCT01234567",
                }
            ],
        },
    }

    result = normalize_evidence_response("SGLT2 inhibitors heart failure", payload, max_references=6)

    assert result["status"] == "ok"
    refs = result["references"]
    assert [item["source_type"] for item in refs] == ["guide", "paper", "clinical_trial"]
    paper_ref = next(item for item in refs if item["source_type"] == "paper")
    assert paper_ref["study_id"] == "evimed:paper:paper-1"
    assert paper_ref["paper"]["pmid"] == "12345678"
    assert paper_ref["paper"]["doi"] == "10.1000/hf.2025.001"
    assert paper_ref["paper"]["source"] == "evimed_evidence"
    guide_ref = refs[0]
    assert guide_ref["paper"]["authors"] == ["Example Cardiology Society"]
    assert "Guideline background text" in guide_ref["summary"]


def test_evimed_evidence_normalization_balances_source_types_when_guides_are_plentiful() -> None:
    payload = {
        "code": 200,
        "data": {
            "guide": [
                {
                    "guideId": f"guide-{idx}",
                    "title": f"Heart failure guideline {idx}",
                    "formulator": "Example Cardiology Society",
                    "year": "2024",
                }
                for idx in range(1, 10)
            ],
            "paper": [
                {
                    "id": f"paper-{idx}",
                    "title": f"SGLT2 inhibitors heart failure systematic review {idx}",
                    "journal": "Journal of Cardiac Failure",
                    "year": "2025",
                    "doi": f"10.1000/hf-review-{idx}",
                }
                for idx in range(1, 4)
            ],
            "clinicalTrials": [
                {
                    "registerNo": f"NCT0000000{idx}",
                    "title": f"Heart failure SGLT2 trial registry {idx}",
                    "belong": "ClinicalTrials.gov",
                    "registerDate": "2023-02-01",
                }
                for idx in range(1, 3)
            ],
        },
    }

    result = normalize_evidence_response("SGLT2 inhibitors heart failure", payload, max_references=6)

    source_types = [item["source_type"] for item in result["references"]]
    assert len(source_types) == 6
    assert source_types[:3] == ["guide", "paper", "clinical_trial"]
    assert "paper" in source_types
    assert "clinical_trial" in source_types
    assert source_types.count("guide") < 6


def test_evimed_evidence_excludes_drug_labels_from_background_references_by_default() -> None:
    payload = {
        "code": 200,
        "data": {
            "instructions": [
                {
                    "id": "label-1",
                    "genericNames": "DEXAMETHASONE TABLET",
                    "enterpriseName": "Example Pharma",
                    "indication": "Drug label text.",
                    "url": "https://example.test/label",
                }
            ]
        },
    }

    result = normalize_evidence_response("dexamethasone COVID-19 guideline", payload)

    assert result["counts"]["instructions"] == 1
    assert result["counts"]["normalized"] == 0
    assert result["references"] == []


def test_main_adds_evidence_context_references_to_project_and_reference_manager(monkeypatch, tmp_path) -> None:
    project = Project("evimed-context", output_dir=tmp_path)
    ref_manager = ReferenceManager()
    normalized = {
        "status": "ok",
        "query": "SGLT2 inhibitors heart failure",
        "references": [
            {
                "study_id": "evimed:guide:g1",
                "source_type": "guide",
                "title": "Heart failure guideline",
                "summary": "Guideline context.",
                "paper": {
                    "title": "Heart failure guideline",
                    "authors": ["Example Society"],
                    "journal": "Guideline",
                    "year": "2024",
                    "url": "https://example.test/guideline",
                    "source": "evimed_evidence",
                },
            },
                {
                    "study_id": "evimed:paper:p1",
                    "source_type": "paper",
                    "title": "Prior systematic review of SGLT2 inhibitors in heart failure",
                    "summary": "Prior review context for SGLT2 inhibitors in heart failure.",
                    "paper": {
                        "title": "Prior systematic review of SGLT2 inhibitors in heart failure",
                        "authors": ["Author A"],
                        "journal": "Journal",
                    "year": "2023",
                    "doi": "10.1000/prior",
                    "source": "evimed_evidence",
                },
            },
        ],
    }
    monkeypatch.setattr("new_meta.main.search_evimed_evidence", lambda query: normalized)
    monkeypatch.setattr("new_meta.main.pubmed.search", lambda query, max_results=6: [])

    summary = _add_evidence_context_references(
        project,
        _protocol(),
        ref_manager,
        search_query="SGLT2 inhibitors heart failure",
    )

    saved = project.load_json("evidence_context.json", subdir="search")
    assert summary["added_references"] == 2
    assert saved["references"][0]["citation"] == "[1]"
    assert saved["references"][1]["citation"] == "[2]"
    assert "evimed:guide:g1" in ref_manager._id_map
    assert "evimed:paper:p1" in ref_manager._id_map
    assert ref_manager.to_bibtex().count("@article{") == 2


def test_main_filters_population_mismatched_background_references(monkeypatch, tmp_path) -> None:
    project = Project("evimed-adult-context", output_dir=tmp_path)
    ref_manager = ReferenceManager()
    normalized = {
        "status": "ok",
        "query": "COVID adults corticosteroids",
        "references": [
            {
                "study_id": "evimed:guide:adult",
                "source_type": "guide",
                "title": "COVID-19 ICU adult guideline",
                "summary": "Adult ICU guidance.",
                "paper": {"title": "COVID-19 ICU adult guideline", "authors": ["Society"], "year": 2021},
            },
            {
                "study_id": "evimed:guide:child",
                "source_type": "guide",
                "title": "Rapid advice guidelines for management of children with COVID-19",
                "summary": "Pediatric guidance.",
                "paper": {"title": "Rapid advice guidelines for management of children with COVID-19", "authors": ["Society"], "year": 2021},
            },
            {
                "study_id": "evimed:guide:pregnancy",
                "source_type": "guide",
                "title": "Management considerations for pregnant patients with COVID-19",
                "summary": "Pregnancy guidance.",
                "paper": {"title": "Management considerations for pregnant patients with COVID-19", "authors": ["Society"], "year": 2021},
            },
            {
                "study_id": "evimed:guide:diabetes",
                "source_type": "guide",
                "title": "Diabetes care in the hospital: standards of care in diabetes-2024",
                "summary": "General inpatient diabetes guidance.",
                "paper": {"title": "Diabetes care in the hospital: standards of care in diabetes-2024", "authors": ["Society"], "year": 2024},
            },
        ],
    }
    covid_protocol = ResearchProtocol(
        research_question="What is the effect of systemic corticosteroids in critically ill adults with COVID-19?",
        pico=PICO(
            population="Critically ill adults with COVID-19 in the ICU",
            intervention="Systemic corticosteroids",
            comparator="Usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="OR",
        model_preference="fixed",
    )
    monkeypatch.setattr("new_meta.main.search_evimed_evidence", lambda query: normalized)
    monkeypatch.setattr("new_meta.main.pubmed.search", lambda query, max_results=6: [])

    summary = _add_evidence_context_references(project, covid_protocol, ref_manager, search_query="")

    saved = project.load_json("evidence_context.json", subdir="search")
    assert summary["added_references"] == 1
    assert [item["study_id"] for item in saved["references"]] == ["evimed:guide:adult"]


def test_main_filters_topic_irrelevant_evimed_background_references(monkeypatch, tmp_path) -> None:
    project = Project("evimed-sglt2-context", output_dir=tmp_path)
    ref_manager = ReferenceManager()
    normalized = {
        "status": "ok",
        "query": "SGLT2 inhibitors heart failure",
        "references": [
            {
                "study_id": "evimed:guide:hf",
                "source_type": "guide",
                "title": "Heart failure guideline for preserved ejection fraction",
                "summary": "Guideline context for HFpEF treatment.",
                "paper": {"title": "Heart failure guideline for preserved ejection fraction", "authors": ["Society"], "year": 2024},
            },
            {
                "study_id": "evimed:paper:sglt2-review",
                "source_type": "paper",
                "title": "SGLT2 inhibitors and heart failure outcomes",
                "summary": "Systematic review of gliflozins in heart failure.",
                "paper": {"title": "SGLT2 inhibitors and heart failure outcomes", "authors": ["Author"], "year": 2025},
            },
            {
                "study_id": "evimed:guide:gout",
                "source_type": "guide",
                "title": "American College of Rheumatology guideline for gout",
                "summary": "Gout management.",
                "paper": {"title": "American College of Rheumatology guideline for gout", "authors": ["ACR"], "year": 2020},
            },
            {
                "study_id": "evimed:guide:constipation",
                "source_type": "guide",
                "title": "Dietetic guideline for chronic constipation",
                "summary": "Constipation management.",
                "paper": {"title": "Dietetic guideline for chronic constipation", "authors": ["BDA"], "year": 2025},
            },
            {
                "study_id": "evimed:guide:tmd",
                "source_type": "guide",
                "title": "Management of chronic pain associated with temporomandibular disorders",
                "summary": "Dental pain guideline.",
                "paper": {"title": "Management of chronic pain associated with temporomandibular disorders", "authors": ["Panel"], "year": 2023},
            },
            {
                "study_id": "evimed:review:diabetes-sglt2",
                "source_type": "paper",
                "title": "SGLT2 inhibitors for type 2 diabetes: network meta-analysis",
                "summary": "Diabetes glucose-lowering review.",
                "paper": {"title": "SGLT2 inhibitors for type 2 diabetes: network meta-analysis", "authors": ["Author"], "year": 2021},
            },
        ],
    }
    monkeypatch.setattr("new_meta.main.search_evimed_evidence", lambda query: normalized)
    monkeypatch.setattr("new_meta.main.pubmed.search", lambda query, max_results=6: [])

    summary = _add_evidence_context_references(
        project,
        _protocol(),
        ref_manager,
        search_query="SGLT2 inhibitors heart failure",
    )

    saved = project.load_json("evidence_context.json", subdir="search")
    assert summary["added_references"] == 2
    assert [item["study_id"] for item in saved["references"]] == [
        "evimed:guide:hf",
        "evimed:paper:sglt2-review",
    ]
    assert saved["filtered_out_references"] == 4


def test_main_retries_evimed_with_fallback_query_when_primary_query_has_no_references(monkeypatch, tmp_path) -> None:
    project = Project("evimed-fallback-query", output_dir=tmp_path)
    ref_manager = ReferenceManager()
    calls: list[str] = []

    def fake_search(query):
        calls.append(query)
        if len(calls) == 1:
            return {"status": "ok", "query": query, "references": [], "counts": {"instructions": 2, "normalized": 0}}
        return {
            "status": "ok",
            "query": query,
            "references": [
                {
                    "study_id": "evimed:guide:ssc",
                    "source_type": "guide",
                    "title": "Surviving Sepsis Campaign COVID-19 ICU guideline",
                    "summary": "Adult ICU guidance.",
                    "paper": {
                        "title": "Surviving Sepsis Campaign COVID-19 ICU guideline",
                        "authors": ["SCCM"],
                        "journal": "Critical Care Medicine",
                        "year": 2021,
                    },
                }
            ],
            "counts": {"guide": 1, "normalized": 1},
        }

    covid_protocol = ResearchProtocol(
        research_question="What is the effect of systemic corticosteroids in critically ill adults with COVID-19?",
        pico=PICO(
            population="Critically ill adults with COVID-19 in the ICU",
            intervention="Systemic corticosteroids",
            comparator="Usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="OR",
        model_preference="fixed",
    )
    monkeypatch.setattr("new_meta.main.search_evimed_evidence", fake_search)
    monkeypatch.setattr("new_meta.main.pubmed.search", lambda query, max_results=6: [])

    summary = _add_evidence_context_references(project, covid_protocol, ref_manager)

    assert summary["added_references"] == 1
    assert len(calls) >= 2
    assert any("surviving sepsis campaign" in call.lower() for call in calls[1:])


def test_main_uses_pubmed_background_fallback_when_evimed_returns_too_few_references(monkeypatch, tmp_path) -> None:
    project = Project("pubmed-background-fallback", output_dir=tmp_path)
    ref_manager = ReferenceManager()
    monkeypatch.setattr(
        "new_meta.main.search_evimed_evidence",
        lambda query: {"status": "ok", "query": query, "references": [], "counts": {"normalized": 0}},
    )
    monkeypatch.setattr("new_meta.main.pubmed.search", lambda query, max_results=6: ["111", "112", "222", "333", "444"])
    monkeypatch.setattr(
        "new_meta.main.pubmed.fetch_details",
        lambda pmids: [
            {
                "pmid": "111",
                "title": "Guideline on SGLT2 inhibitor treatment in heart failure",
                "authors": ["Author A"],
                "journal": "European Heart Journal",
                "year": 2024,
                "doi": "10.1000/hf-guideline",
                "abstract": "Heart failure guideline context.",
            },
            {
                "pmid": "112",
                "title": "Guideline on SGLT2 inhibitor treatment in heart failure",
                "authors": ["Author A"],
                "journal": "Circulation",
                "year": 2024,
                "doi": "10.1000/hf-guideline-duplicate",
                "abstract": "Duplicate publication venue for the same heart failure guideline.",
            },
            {
                "pmid": "222",
                "title": "Systematic review of SGLT2 inhibitors for heart failure outcomes",
                "authors": ["Author B"],
                "journal": "JAMA Cardiology",
                "year": 2023,
                "doi": "10.1000/hf-review",
                "abstract": "Review context for gliflozins in heart failure.",
            },
            {
                "pmid": "333",
                "title": "American College of Rheumatology guideline for gout",
                "authors": ["Author C"],
                "journal": "Arthritis Care and Research",
                "year": 2020,
                "doi": "10.1000/gout",
                "abstract": "Gout guideline context.",
            },
            {
                "pmid": "444",
                "title": "Comparative effectiveness of glucose-lowering drugs for type 2 diabetes",
                "authors": ["Author D"],
                "journal": "Annals",
                "year": 2020,
                "doi": "10.1000/diabetes",
                "abstract": "SGLT2 inhibitors were compared with other glucose-lowering drugs.",
            },
        ],
    )

    summary = _add_evidence_context_references(project, _protocol(), ref_manager)

    saved = project.load_json("evidence_context.json", subdir="search")
    assert summary["added_references"] == 2
    assert [item["source_type"] for item in saved["references"]] == ["pubmed_background", "pubmed_background"]
    assert [item["study_id"] for item in saved["references"]] == ["pubmed_background:111", "pubmed_background:222"]
    assert {"pubmed_background:112", "pubmed_background:333", "pubmed_background:444"}.isdisjoint(ref_manager._id_map)


def test_main_tops_up_evimed_context_with_pubmed_until_reference_depth_target(monkeypatch, tmp_path) -> None:
    project = Project("evimed-pubmed-top-up", output_dir=tmp_path)
    ref_manager = ReferenceManager()
    evimed_refs = [
        {
            "study_id": f"evimed:paper:{idx}",
            "source_type": "paper",
            "title": f"SGLT2 inhibitors and heart failure background review {idx}",
            "paper": {
                "title": f"SGLT2 inhibitors and heart failure background review {idx}",
                "authors": ["Author A"],
                "journal": "Journal",
                "year": 2024,
                "volume": "1",
                "pages": "1-9",
                "doi": f"10.1000/evimed-{idx}",
            },
        }
        for idx in range(1, 6)
    ]
    monkeypatch.setattr(
        "new_meta.main.search_evimed_evidence",
        lambda query: {"status": "ok", "query": query, "references": evimed_refs, "counts": {"normalized": 5}},
    )
    search_calls: list[int] = []
    monkeypatch.setattr(
        "new_meta.main.pubmed.search",
        lambda query, max_results=6: search_calls.append(max_results) or [str(9000 + idx) for idx in range(1, 11)],
    )
    monkeypatch.setattr(
        "new_meta.main.pubmed.fetch_details",
        lambda pmids: [
            {
                "pmid": pmid,
                "title": f"Heart failure SGLT2 guideline and systematic review {pmid}",
                "authors": ["Author B"],
                "journal": "European Heart Journal",
                "year": 2024,
                "volume": "2",
                "pages": "10-19",
                "doi": f"10.1000/{pmid}",
                "abstract": "Heart failure guideline context for SGLT2 inhibitors.",
            }
            for pmid in pmids
        ],
    )

    summary = _add_evidence_context_references(project, _protocol(), ref_manager)

    saved = project.load_json("evidence_context.json", subdir="search")
    assert search_calls == [30]
    assert len(saved["references"]) == 15
    assert saved["pubmed_background_references"] == 10
    assert summary["added_references"] == 15


def test_main_refreshes_cached_evidence_context_below_reference_depth_target(monkeypatch, tmp_path) -> None:
    project = Project("evimed-stale-cache-refresh", output_dir=tmp_path)
    ref_manager = ReferenceManager()
    query = _evidence_context_query(_protocol())
    project.save_json(
        "evidence_context.json",
        {
            "status": "ok",
            "query": query,
            "cache_version": main_module.EVIMED_CONTEXT_CACHE_VERSION,
            "references": [
                {
                    "study_id": f"evimed:paper:cached-{idx}",
                    "source_type": "paper",
                    "title": f"Cached SGLT2 heart failure review {idx}",
                    "paper": {
                        "title": f"Cached SGLT2 heart failure review {idx}",
                        "authors": ["Cached Author"],
                        "journal": "Journal",
                        "year": 2023,
                        "volume": "1",
                        "pages": "1-9",
                        "doi": f"10.1000/cached-{idx}",
                    },
                }
                for idx in range(1, 4)
            ],
        },
        subdir="search",
    )
    refreshed_refs = [
        {
            "study_id": f"evimed:paper:refreshed-{idx}",
            "source_type": "paper",
            "title": f"Refreshed SGLT2 heart failure guideline and systematic review {idx}",
            "paper": {
                "title": f"Refreshed SGLT2 heart failure guideline and systematic review {idx}",
                "authors": ["Fresh Author"],
                "journal": "Journal",
                "year": 2024,
                "volume": "2",
                "pages": "10-19",
                "doi": f"10.1000/refreshed-{idx}",
            },
        }
        for idx in range(1, main_module.EVIDENCE_CONTEXT_TARGET_REFERENCES + 1)
    ]
    calls: list[str] = []
    monkeypatch.setattr(
        "new_meta.main.search_evimed_evidence",
        lambda query: calls.append(query) or {
            "status": "ok",
            "query": query,
            "references": refreshed_refs,
            "counts": {"normalized": len(refreshed_refs)},
        },
    )
    monkeypatch.setattr("new_meta.main._pubmed_background_references", lambda protocol, max_results=6: [])

    summary = _add_evidence_context_references(project, _protocol(), ref_manager)

    saved = project.load_json("evidence_context.json", subdir="search")
    assert calls == [query]
    assert summary["added_references"] == main_module.EVIDENCE_CONTEXT_TARGET_REFERENCES
    assert len(saved["references"]) == main_module.EVIDENCE_CONTEXT_TARGET_REFERENCES
    assert saved["references"][0]["study_id"] == "evimed:paper:refreshed-1"


def test_evimed_search_falls_back_to_curl_when_requests_tls_fails(monkeypatch) -> None:
    def fail_post(*args, **kwargs):
        raise requests.exceptions.SSLError("unexpected eof")

    def fake_run(cmd, capture_output, text, timeout, input=None):
        assert cmd[:3] == ["curl", "--http1.1", "-sS"]
        assert "Authorization: Bearer secret" not in " ".join(cmd)
        assert "Authorization: Bearer secret" in (input or "")
        payload = {
            "code": 200,
            "data": {
                "guide": [
                    {
                        "guideId": "g1",
                        "title": "COVID-19 ICU guideline",
                        "formulator": "Example Society",
                        "year": "2021",
                        "url": "https://example.test/g1",
                    }
                ]
            },
        }
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr("new_meta.tools.evimed_evidence.requests.post", fail_post)
    monkeypatch.setattr("new_meta.tools.evimed_evidence.subprocess.run", fake_run)

    result = search_evimed_evidence("COVID steroids", api_key="secret", max_references=3)

    assert result["status"] == "ok"
    assert result["references"][0]["study_id"] == "evimed:guide:g1"
