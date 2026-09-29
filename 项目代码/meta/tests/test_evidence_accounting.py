"""The counts a report quotes come from the engine, with their arithmetic checked in code.

The delivered ma-001 report (2026-09-28) gave two different totals for the same
categories ("七类计数相加为 165" and "类别之和等于 141") because the run added up
counts itself. The engine now writes package/evidence_accounting.json and the
adapter returns it with the terminal job state.
"""
from __future__ import annotations

import json


def _project(tmp_path):
    from new_meta.core.project import Project
    project = Project("evidence accounting", output_dir=tmp_path)
    # Counts of production ma-001 (prisma_flow.json), in today's shape.
    project.save_json("prisma_flow.json", {
        "identification": {"records_identified": 400, "duplicates_removed": 4, "records_after_dedup": 396,
                           "automation_excluded": 196, "records_removed_other": 0,
                           "records_not_screened": 196,
                           "records_not_screened_reasons": {"relevance cap before screening": 196}},
        "screening": {"title_abstract_screened": 200, "title_abstract_excluded": 141},
        "eligibility": {"full_text_sought": 59, "not_retrieved": 38,
                        "not_retrieved_reasons": {"abstract_only": 33, "no_text": 5},
                        "full_text_assessed": 21, "full_text_excluded": 16},
        "included": {"studies_included": 5}})
    project.save_json("synthesis_result.json", {
        "input_result_ids": ["result:29410968:0", "result:29410968:1", "result:39673144:0"]}, subdir="analysis")
    project.add_warning("synthesis", "left out", code="unverified_results_left_out", context={"results": {
        "result:31348286:0": "clinical_mismatch", "result:39673144:1": "source_numeric_conflict"}})
    return project


def test_accounting_reports_engine_counts_and_checks_their_arithmetic(tmp_path):
    from new_meta.core.evidence_accounting import write_evidence_accounting
    project = _project(tmp_path)
    accounting = write_evidence_accounting(project)
    assert json.loads((project.base_dir / "package" / "evidence_accounting.json").read_text()) == accounting
    assert accounting["counts"]["reports_not_retrieved"] == 38
    assert accounting["synthesis"]["studies_pooled"] == 2 and accounting["synthesis"]["results_pooled"] == 3
    assert accounting["synthesis"]["reasons"] == {"clinical_mismatch": 1, "source_numeric_conflict": 1}
    assert [item["holds"] for item in accounting["arithmetic"]] == [True, True, True, True]


def test_a_broken_identity_is_reported_not_repaired(tmp_path):
    from new_meta.core.evidence_accounting import build_evidence_accounting
    project = _project(tmp_path)
    flow = project.load_json("prisma_flow.json")
    flow["eligibility"]["full_text_assessed"] = 20
    project.save_json("prisma_flow.json", flow)
    checks = {item["identity"]: item for item in build_evidence_accounting(project)["arithmetic"]}
    assert checks["sought - not retrieved = assessed"] == {
        "identity": "sought - not retrieved = assessed", "holds": False, "computed": 21, "recorded": 20}
