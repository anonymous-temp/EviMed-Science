"""A multi-arm trial reporting arm means and SDs is poolable on MD.

On 2026-09-28 a local run of brief ma-001 (tranexamic acid in primary TKA)
extracted two eligible three-arm trials cleanly — total blood loss as mean,
SD and n for every arm — and then dropped every one of their results from the
evidence ledger: a multi-arm row needs estimand_id and precision_basis, and
reconciliation only supplied them for 2x2 counts or a reported effect. The
review ended "No verified or adjudicated typed results are available for
synthesis". The values below are the ones that run extracted.
"""
from __future__ import annotations

import math
from pathlib import Path

import pytest

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.core.rct_design_reconciliation import (
    comparative_effect_from_outcome,
    reconcile_extracted_rct_designs,
)
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics

PRIMARY = "Total blood loss (mL)"


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Tranexamic acid versus placebo for blood loss in primary total knee arthroplasty",
        pico=PICO(
            population="Adults undergoing primary unilateral total knee arthroplasty",
            intervention="Perioperative tranexamic acid administered intravenously, topically, or by combined routes",
            comparator="Placebo or no tranexamic acid",
            outcome_primary=PRIMARY,
        ),
        review_family="intervention_rct",
        study_design="parallel_rct / multi_arm_rct",
        study_designs=["parallel_rct", "multi_arm_rct"],
        primary_outcome_type="continuous",
        effect_measure="MD",
        databases=["PubMed"],
    )


def _row(arm: str, mean_i: float, sd_i: float, n_i: int, mean_c: float, sd_c: float, n_c: int) -> OutcomeData:
    return OutcomeData(
        outcome_name=PRIMARY, outcome_type="continuous",
        mean_intervention=mean_i, sd_intervention=sd_i, n_intervention=n_i,
        mean_control=mean_c, sd_control=sd_c, n_control=n_c,
        source_quote=f"Total blood loss was {mean_i} ± {sd_i} mL versus {mean_c} ± {sd_c} mL.",
        source_quote_verified=True, source_location="Results, Table 2", source_page=4,
        comparative_design="multi_arm_rct", treatment_arm=arm, reference_arm="Placebo",
    )


def _studies() -> list[ExtractedStudy]:
    return [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="29410968", pmid="29410968", title="Topical and IV TXA in MIS-TKA",
                study_design="randomized double-blind trial with three parallel arms",
            ),
            outcomes=[
                _row("IV TXA 1 g (tranexamic acid)", 921.0, 252.0, 31, 1131.0, 336.0, 30),
                _row("Topical TXA 3 g (tranexamic acid)", 795.0, 231.0, 32, 1131.0, 336.0, 30),
            ],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="39673144", pmid="39673144", title="Low- and high-dose intra-articular TXA",
                study_design="randomized controlled trial with three parallel arms",
            ),
            outcomes=[
                _row("Low-dose intra-articular TXA 1 g (tranexamic acid)", 754.0, 409.7, 75, 977.3, 418.7, 75),
                _row("High-dose intra-articular TXA 3 g (tranexamic acid)", 567.7, 408.3, 75, 977.3, 418.7, 75),
            ],
        ),
    ]


def test_arm_summaries_give_each_multi_arm_row_its_precision_and_shared_control_covariance() -> None:
    protocol, studies = _protocol(), _studies()
    report = reconcile_extracted_rct_designs(protocol, studies)

    assert report["multi_arm_studies"] == ["29410968", "39673144"]
    first, second = studies[0].outcomes
    for row in (first, second):
        assert row.comparative_design == "multi_arm_rct"
        assert row.precision_basis == "computed_from_source_verified_arm_summaries"
        assert row.estimand_id and row.contrast_id
    # Cov(MD1, MD2) = Var(control mean) = SD_c^2 / n_c, both ways.
    assert first.covariance_with[second.contrast_id] == pytest.approx(336.0 ** 2 / 30)
    assert second.covariance_with[first.contrast_id] == pytest.approx(336.0 ** 2 / 30)
    effect = comparative_effect_from_outcome(first, protocol)
    assert effect["estimate"] == pytest.approx(921.0 - 1131.0)
    assert effect["variance"] == pytest.approx(252.0 ** 2 / 31 + 336.0 ** 2 / 30)


def test_a_derived_covariance_is_re_derived_by_verification_not_looked_for_in_the_source() -> None:
    """Run 5 of ma-001 (2026-09-28): the verifier asked for a quotation of the
    shared-control covariance on every multi-arm row and failed each one with
    numeric_quote_not_anchored. No paper states it; the row's own verified
    control SD and size determine it."""
    from new_meta.core.extraction_verification import numeric_fields

    protocol, studies = _protocol(), _studies()
    reconcile_extracted_rct_designs(protocol, studies)
    first, second = studies[0].outcomes
    assert first.covariance_basis == {second.contrast_id: "derived:shared_control_arm_summaries"}
    fields = numeric_fields(first)
    assert not any(name.startswith("covariance_with[") for name in fields)
    assert fields["sd_control"] == 336.0 and fields["n_control"] == 30

    # A value the row does not determine is a number to anchor like any other.
    first.covariance_with[second.contrast_id] = 1234.5
    assert f"covariance_with[{second.contrast_id}]" in numeric_fields(first)
    # And so is a covariance with no recorded derivation.
    first.covariance_with[second.contrast_id] = 336.0 ** 2 / 30
    first.covariance_basis = {}
    assert f"covariance_with[{second.contrast_id}]" in numeric_fields(first)


def test_a_mismatched_control_summary_leaves_the_dependency_unresolved() -> None:
    protocol, studies = _protocol(), _studies()
    studies[0].outcomes[1].sd_control = 335.0  # not the same control arm as reported
    reconcile_extracted_rct_designs(protocol, studies)
    first, second = studies[0].outcomes
    assert second.contrast_id not in first.covariance_with


def test_ma001_trials_reach_the_ledger_and_pool(tmp_path: Path) -> None:
    protocol, studies = _protocol(), _studies()
    reconcile_extracted_rct_designs(protocol, studies)
    project = Project("ma-001 multi-arm continuous", output_dir=tmp_path / "project")
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    assert migration.skipped_results == []
    assert len(migration.result_ids) == 4

    plan = compile_project_method_plan(project, protocol, enforce=True)
    assert plan.capability_id == "intervention_rct.complex_design"
    from primary_alignment_fixture import approve_synthetic_method_fixture

    approve_synthetic_method_fixture(project, protocol, studies)
    phase = PipelineRunner(project).run_compiled_method_synthesis()
    assert phase.status.value == "succeeded", phase.summary
    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    payload = envelope["engine_payload"]
    assert envelope["primary_estimates"][0]["measure"] == "MD"
    assert payload["n_studies"] == 2 and payload["n_contrasts"] == 4
    # Each trial contributes one GLS-consolidated contrast against its placebo.
    assert len(payload["study_effects"]) == 2
    assert payload["pooled_effect"] < 0 and math.isfinite(payload["ci_lower"])
