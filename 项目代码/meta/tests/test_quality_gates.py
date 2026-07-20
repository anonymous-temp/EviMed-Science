import json
from pathlib import Path

from new_meta.core.claim_alignment import claim_alignment_input_hash
from new_meta.core.quality_gates import run_quality_gate
from new_meta.core.real_smoke import build_real_smoke_manifest, write_real_smoke_manifest


def _write_authoring_audit(project_dir: Path, *, accepted_sections: int = 1) -> None:
    (project_dir / "manuscript" / "claim_map_authoring_audit.json").write_text(
        json.dumps({
            "schema_version": 1,
            "enabled": True,
            "status": "ok",
            "accepted_sections": accepted_sections,
            "rejected_sections": 0,
            "issues": [
                {
                    "code": "claim_map_authoring_section_accepted",
                    "heading": "Introduction",
                    "claims_used": ["intro_bg"],
                }
            ],
        }),
        encoding="utf-8",
    )


def test_quality_gate_requires_claim_source_audit_when_claim_map_exists(tmp_path: Path) -> None:
    (tmp_path / "analysis").mkdir()
    (tmp_path / "manuscript").mkdir()
    (tmp_path / "analysis" / "effect_selection_audit.json").write_text(
        json.dumps([
            {
                "row_id": "S1:0",
                "in_final_primary_analysis": True,
                "source_provenance_tier": "primary_report",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_map.json").write_text("[]", encoding="utf-8")

    gate = run_quality_gate(tmp_path)

    assert gate["status"] == "fail"
    assert any(item["name"] == "claim_source_resolution" and item["status"] == "fail" for item in gate["checks"])


def test_quality_gate_requires_citation_contract_for_writable_claims(tmp_path: Path) -> None:
    (tmp_path / "analysis").mkdir()
    (tmp_path / "manuscript").mkdir()
    (tmp_path / "analysis" / "effect_selection_audit.json").write_text(
        json.dumps([
            {
                "row_id": "S1:0",
                "in_final_primary_analysis": True,
                "source_provenance_tier": "primary_report",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_map.json").write_text(
        json.dumps([
            {
                "id": "intro_bg",
                "claim": "The condition is clinically important.",
                "can_write_main_text": True,
                "manuscript_use": "main",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_source_resolution_audit.json").write_text(
        json.dumps({"summary": {"unresolved_count": 0}}),
        encoding="utf-8",
    )

    gate = run_quality_gate(tmp_path)

    assert gate["status"] == "fail"
    assert any(item["name"] == "citation_contract" and item["status"] == "fail" for item in gate["checks"])


def test_quality_gate_rejects_empty_claim_map_for_submission_ready_run(tmp_path: Path) -> None:
    (tmp_path / "analysis").mkdir()
    (tmp_path / "manuscript").mkdir()
    (tmp_path / "analysis" / "effect_selection_audit.json").write_text(
        json.dumps([
            {
                "row_id": "S1:0",
                "in_final_primary_analysis": True,
                "source_provenance_tier": "primary_report",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_map.json").write_text("[]", encoding="utf-8")
    (tmp_path / "manuscript" / "claim_source_resolution_audit.json").write_text(
        json.dumps({"summary": {"unresolved_count": 0}}),
        encoding="utf-8",
    )

    gate = run_quality_gate(tmp_path)

    assert gate["status"] == "fail"
    source_check = next(item for item in gate["checks"] if item["name"] == "claim_source_resolution")
    assert source_check["status"] == "fail"
    assert "no writable" in source_check["message"]


def test_quality_gate_accepts_complete_citation_contract_with_optional_smoke_warning(tmp_path: Path) -> None:
    (tmp_path / "analysis").mkdir()
    (tmp_path / "manuscript").mkdir()
    (tmp_path / "analysis" / "effect_selection_audit.json").write_text(
        json.dumps([
            {
                "row_id": "S1:0",
                "in_final_primary_analysis": True,
                "source_provenance_tier": "primary_report",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_map.json").write_text(
        json.dumps([
            {
                "id": "intro_bg",
                "claim": "The condition is clinically important.",
                "can_write_main_text": True,
                "manuscript_use": "main",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_source_resolution_audit.json").write_text(
        json.dumps({"summary": {"unresolved_count": 0}}),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "citation_contract.json").write_text(
        json.dumps({
            "schema_version": 1,
            "status": "ok",
            "items": [
                {
                    "claim_id": "intro_bg",
                    "citation": "[1]",
                    "reference_numbers": [1],
                    "reference_ids": ["pmid:123"],
                    "source_spans": [
                        {
                            "source_id": "pmid:123",
                            "reference_id": "pmid:123",
                            "source_type": "background_reference",
                            "location": "Background paper",
                            "quote": "The condition is clinically important.",
                            "verified": True,
                            "support_strength": "direct",
                        }
                    ],
                }
            ],
        }),
        encoding="utf-8",
    )
    _write_authoring_audit(tmp_path)

    gate = run_quality_gate(tmp_path)

    assert gate["status"] == "warn"
    assert any(item["name"] == "citation_contract" and item["status"] == "pass" for item in gate["checks"])
    assert any(item["name"] == "real_llm_pdf_web_smoke" and item["status"] == "warn" for item in gate["checks"])


def test_quality_gate_fails_when_writable_claim_lacks_contract_entry(tmp_path: Path) -> None:
    (tmp_path / "analysis").mkdir()
    (tmp_path / "manuscript").mkdir()
    (tmp_path / "analysis" / "effect_selection_audit.json").write_text(
        json.dumps([
            {
                "row_id": "S1:0",
                "in_final_primary_analysis": True,
                "source_provenance_tier": "primary_report",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_map.json").write_text(
        json.dumps([
            {
                "id": "intro_bg",
                "claim": "The condition is clinically important.",
                "can_write_main_text": True,
                "manuscript_use": "main",
            },
            {
                "id": "disc_context",
                "claim": "The finding should be interpreted alongside baseline risk.",
                "can_write_main_text": True,
                "manuscript_use": "main",
            },
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_source_resolution_audit.json").write_text(
        json.dumps({"summary": {"unresolved_count": 0}}),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "citation_contract.json").write_text(
        json.dumps({
            "schema_version": 1,
            "status": "ok",
            "items": [
                {
                    "claim_id": "intro_bg",
                    "citation": "[1]",
                    "reference_numbers": [1],
                    "reference_ids": ["pmid:123"],
                    "source_spans": [
                        {
                            "source_id": "pmid:123",
                            "reference_id": "pmid:123",
                            "source_type": "background_reference",
                            "location": "Background paper",
                            "quote": "The condition is clinically important.",
                            "verified": True,
                            "support_strength": "direct",
                        }
                    ],
                }
            ],
        }),
        encoding="utf-8",
    )
    _write_authoring_audit(tmp_path)

    gate = run_quality_gate(tmp_path)

    citation_check = next(item for item in gate["checks"] if item["name"] == "citation_contract")
    assert gate["status"] == "fail"
    assert citation_check["status"] == "fail"
    assert citation_check["rows"] == ["disc_context"]


def test_quality_gate_accepts_structured_fact_contract_without_reference_marker(tmp_path: Path) -> None:
    (tmp_path / "analysis").mkdir()
    (tmp_path / "manuscript").mkdir()
    (tmp_path / "analysis" / "effect_selection_audit.json").write_text(
        json.dumps([
            {
                "row_id": "S1:0",
                "in_final_primary_analysis": True,
                "source_provenance_tier": "primary_report",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_map.json").write_text(
        json.dumps([
            {
                "id": "intro_obj",
                "claim": "This review evaluates the prespecified PICO question.",
                "can_write_main_text": True,
                "manuscript_use": "main",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_source_resolution_audit.json").write_text(
        json.dumps({"summary": {"unresolved_count": 0}}),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "citation_contract.json").write_text(
        json.dumps({
            "schema_version": 1,
            "status": "ok",
            "items": [
                {
                    "claim_id": "intro_obj",
                    "citation": "",
                    "reference_numbers": [],
                    "reference_ids": [],
                    "source_spans": [
                        {
                            "source_id": "pico",
                            "source_type": "structured_fact",
                            "location": "Protocol PICO",
                            "quote": "Population, intervention, comparator, and outcome were prespecified.",
                            "verified": True,
                            "support_strength": "structured",
                        }
                    ],
                }
            ],
        }),
        encoding="utf-8",
    )
    _write_authoring_audit(tmp_path)

    gate = run_quality_gate(tmp_path)

    citation_check = next(item for item in gate["checks"] if item["name"] == "citation_contract")
    assert gate["status"] == "warn"
    assert citation_check["status"] == "pass"


def test_quality_gate_requires_alignment_audit_for_indirect_external_sources(tmp_path: Path) -> None:
    (tmp_path / "analysis").mkdir()
    (tmp_path / "manuscript").mkdir()
    (tmp_path / "analysis" / "effect_selection_audit.json").write_text(
        json.dumps([
            {
                "row_id": "S1:0",
                "in_final_primary_analysis": True,
                "source_provenance_tier": "primary_report",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_map.json").write_text(
        json.dumps([
            {
                "id": "intro_bg",
                "claim": "指南强调解释治疗获益时应结合基线风险和患者偏好。",
                "can_write_main_text": True,
                "manuscript_use": "main",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_source_resolution_audit.json").write_text(
        json.dumps({"summary": {"unresolved_count": 0}}),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "citation_contract.json").write_text(
        json.dumps({
            "schema_version": 1,
            "status": "ok",
            "items": [
                {
                    "claim_id": "intro_bg",
                    "citation": "[1]",
                    "reference_numbers": [1],
                    "reference_ids": ["pmid:123"],
                    "source_spans": [
                        {
                            "source_id": "pmid:123",
                            "reference_id": "pmid:123",
                            "source_type": "background_reference",
                            "location": "Background paper",
                            "quote": "Translated background summary.",
                            "verified": False,
                            "support_strength": "indirect",
                        }
                    ],
                }
            ],
        }),
        encoding="utf-8",
    )

    gate = run_quality_gate(tmp_path)

    alignment_check = next(item for item in gate["checks"] if item["name"] == "claim_source_alignment")
    assert gate["status"] == "fail"
    assert alignment_check["status"] == "fail"
    assert alignment_check["rows"] == ["intro_bg"]


def test_quality_gate_accepts_indirect_external_sources_after_alignment_audit(tmp_path: Path) -> None:
    (tmp_path / "analysis").mkdir()
    (tmp_path / "manuscript").mkdir()
    (tmp_path / "analysis" / "effect_selection_audit.json").write_text(
        json.dumps([
            {
                "row_id": "S1:0",
                "in_final_primary_analysis": True,
                "source_provenance_tier": "primary_report",
            }
        ]),
        encoding="utf-8",
    )
    claim_map = [
            {
                "id": "intro_bg",
                "claim": "指南强调解释治疗获益时应结合基线风险和患者偏好。",
                "can_write_main_text": True,
                "manuscript_use": "main",
                "support_source": "guideline2026",
                "source_location": "Background paper",
                "source_quote": "Translated background summary.",
            }
        ]
    facts = {
        "output_language": "zh",
        "research_question": "SGLT2 inhibitors in HFpEF",
        "background_evidence": {
            "references": [
                {
                    "id": "pmid:123",
                    "title": "Background paper",
                    "abstract": "Guidelines recommend considering baseline risk and patient preferences.",
                }
            ]
        },
    }
    (tmp_path / "manuscript" / "claim_map.json").write_text(
        json.dumps(claim_map),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "manuscript_facts.json").write_text(
        json.dumps(facts),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_source_resolution_audit.json").write_text(
        json.dumps({"summary": {"unresolved_count": 0}}),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "citation_contract.json").write_text(
        json.dumps({
            "schema_version": 1,
            "status": "ok",
            "items": [
                {
                    "claim_id": "intro_bg",
                    "citation": "[1]",
                    "reference_numbers": [1],
                    "reference_ids": ["pmid:123"],
                    "source_spans": [
                        {
                            "source_id": "pmid:123",
                            "reference_id": "pmid:123",
                            "source_type": "background_reference",
                            "location": "Background paper",
                            "quote": "Translated background summary.",
                            "verified": False,
                            "support_strength": "indirect",
                        }
                    ],
                }
            ],
        }),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_source_alignment_audit.json").write_text(
        json.dumps({
            "schema_version": 1,
            "enabled": True,
            "status": "ok",
            "reviewed_claims": 1,
            "reviewed_claim_ids": ["intro_bg"],
            "alignment_input_hash": claim_alignment_input_hash(claim_map, facts, output_language="zh"),
            "revised_claims": [],
            "excluded_claims": [],
            "summary": "The translated background claim was semantically aligned with the supplied reference.",
        }),
        encoding="utf-8",
    )
    _write_authoring_audit(tmp_path)

    gate = run_quality_gate(tmp_path)

    alignment_check = next(item for item in gate["checks"] if item["name"] == "claim_source_alignment")
    assert gate["status"] == "warn"
    assert alignment_check["status"] == "pass"


def test_quality_gate_requires_claim_map_authoring_audit(tmp_path: Path) -> None:
    (tmp_path / "analysis").mkdir()
    (tmp_path / "manuscript").mkdir()
    (tmp_path / "analysis" / "effect_selection_audit.json").write_text(
        json.dumps([
            {
                "row_id": "S1:0",
                "in_final_primary_analysis": True,
                "source_provenance_tier": "primary_report",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_map.json").write_text(
        json.dumps([
            {
                "id": "intro_bg",
                "claim": "The condition is clinically important.",
                "can_write_main_text": True,
                "manuscript_use": "main",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_source_resolution_audit.json").write_text(
        json.dumps({"summary": {"unresolved_count": 0}}),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "citation_contract.json").write_text(
        json.dumps({
            "schema_version": 1,
            "status": "ok",
            "items": [
                {
                    "claim_id": "intro_bg",
                    "citation": "[1]",
                    "reference_numbers": [1],
                    "reference_ids": ["pmid:123"],
                    "source_spans": [
                        {
                            "source_id": "pmid:123",
                            "reference_id": "pmid:123",
                            "source_type": "background_reference",
                            "location": "Background paper",
                            "quote": "The condition is clinically important.",
                            "verified": True,
                            "support_strength": "direct",
                        }
                    ],
                }
            ],
        }),
        encoding="utf-8",
    )

    gate = run_quality_gate(tmp_path)

    authoring_check = next(item for item in gate["checks"] if item["name"] == "claim_map_authoring")
    assert gate["status"] == "fail"
    assert authoring_check["status"] == "fail"
    assert "claim_map_authoring_audit.json is required" in authoring_check["message"]


def test_quality_gate_rejects_stale_claim_source_alignment_audit(tmp_path: Path) -> None:
    (tmp_path / "analysis").mkdir()
    (tmp_path / "manuscript").mkdir()
    claim_map = [
        {
            "id": "intro_bg",
            "claim": "The background source supports baseline-risk interpretation.",
            "can_write_main_text": True,
            "manuscript_use": "main",
            "support_source": "guideline2026",
            "source_location": "Background paper",
            "source_quote": "Baseline risk matters.",
        }
    ]
    facts = {"output_language": "en", "research_question": "Treatment question"}
    (tmp_path / "analysis" / "effect_selection_audit.json").write_text(
        json.dumps([
            {
                "row_id": "S1:0",
                "in_final_primary_analysis": True,
                "source_provenance_tier": "primary_report",
            }
        ]),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_map.json").write_text(json.dumps(claim_map), encoding="utf-8")
    (tmp_path / "manuscript" / "manuscript_facts.json").write_text(json.dumps(facts), encoding="utf-8")
    (tmp_path / "manuscript" / "claim_source_resolution_audit.json").write_text(
        json.dumps({"summary": {"unresolved_count": 0}}),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "citation_contract.json").write_text(
        json.dumps({
            "schema_version": 1,
            "status": "ok",
            "items": [
                {
                    "claim_id": "intro_bg",
                    "citation": "[1]",
                    "reference_numbers": [1],
                    "reference_ids": ["pmid:123"],
                    "source_spans": [
                        {
                            "source_id": "pmid:123",
                            "reference_id": "pmid:123",
                            "source_type": "background_reference",
                            "location": "Background paper",
                            "quote": "Baseline risk matters.",
                            "verified": False,
                            "support_strength": "indirect",
                        }
                    ],
                }
            ],
        }),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "claim_source_alignment_audit.json").write_text(
        json.dumps({
            "schema_version": 1,
            "enabled": True,
            "status": "ok",
            "reviewed_claims": 1,
            "reviewed_claim_ids": ["intro_bg"],
            "alignment_input_hash": "stale",
            "revised_claims": [],
            "excluded_claims": [],
        }),
        encoding="utf-8",
    )

    gate = run_quality_gate(tmp_path)

    alignment_check = next(item for item in gate["checks"] if item["name"] == "claim_source_alignment")
    assert gate["status"] == "fail"
    assert alignment_check["status"] == "fail"
    assert "hash does not match" in alignment_check["message"]


def test_real_smoke_manifest_checks_llm_pdf_web_and_quality_artifacts(tmp_path: Path) -> None:
    (tmp_path / "manuscript").mkdir()
    (tmp_path / "user_fulltexts").mkdir()
    (tmp_path / "pdf_parse_cache").mkdir()
    (tmp_path / "search").mkdir(parents=True)
    (tmp_path / "manuscript" / "claim_map_authoring_audit.json").write_text(
        json.dumps({"accepted_sections": 2}),
        encoding="utf-8",
    )
    (tmp_path / "manuscript" / "manuscript_quality_gate.json").write_text(
        json.dumps({"passed": True}),
        encoding="utf-8",
    )
    (tmp_path / "user_fulltexts" / "trial.pdf").write_bytes(b"%PDF-1.4\n")
    (tmp_path / "pdf_parse_cache" / "trial.json").write_text("{}", encoding="utf-8")
    (tmp_path / "search_results.json").write_text(json.dumps([{"title": "Trial"}]), encoding="utf-8")
    (tmp_path / "search_source_counts.json").write_text(json.dumps({"pubmed": 1}), encoding="utf-8")

    manifest = write_real_smoke_manifest(tmp_path)

    assert manifest["ok"] is True
    assert (tmp_path / "quality" / "real_llm_pdf_web_smoke.json").exists()
    gate = run_quality_gate(tmp_path)
    assert any(item["name"] == "real_llm_pdf_web_smoke" and item["status"] == "pass" for item in gate["checks"])


def test_real_smoke_manifest_fails_without_llm_authoring(tmp_path: Path) -> None:
    (tmp_path / "manuscript").mkdir()

    manifest = build_real_smoke_manifest(tmp_path)

    assert manifest["ok"] is False
    assert any(item["name"] == "real_llm_authoring" and item["status"] == "fail" for item in manifest["checks"])
