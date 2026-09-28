"""Every declared multi-arm row with named arms is typed, not dropped.

ma-001 on production (2026-09-28, job meta-20260928154619): 37 records past
title/abstract, six studies included at full text, then sixteen results of
three three-armed TXA trials (IV TXA / topical TXA / no TXA) were dropped at
the ledger - "a multi_arm_rct result is missing estimand_id, precision_basis"
- and the synthesis was left one contrast from one study. Reconciliation
typed only the source-backed, computable primary contrasts; every other row
the extractor called multi_arm_rct reached the ledger untyped. The contrast,
its estimand and its precision basis are all determined by the row itself.
"""
from __future__ import annotations

import math
from pathlib import Path

import pytest

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.project import Project
from new_meta.core.rct_design_reconciliation import (
    DESCRIPTIVE_ESTIMAND_PREFIX,
    PRECISION_NOT_COMPUTABLE,
    reconcile_extracted_rct_designs,
)
from new_meta.engines.complex_rct import run_complex_rct
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics

from test_multi_arm_continuous import PRIMARY, _protocol, _row, _two_arm_study

CONTROL_SD, CONTROL_N = 336.0, 30
# As the extraction prompt asks: the source label, plus the review's own term.
CONTROL_ARM = "No TXA (no tranexamic acid)"


def _transfusion(arm: str, events_i: int, events_c: int) -> OutcomeData:
    return OutcomeData(
        outcome_name="Allogeneic transfusion", outcome_type="dichotomous", protocol_outcome_role="secondary",
        events_intervention=events_i, total_intervention=30, events_control=events_c, total_control=CONTROL_N,
        source_quote="Transfusion was required in few patients.", source_quote_verified=True,
        comparative_design="multi_arm_rct", treatment_arm=arm, reference_arm=CONTROL_ARM,
    )


def _three_arm_study() -> ExtractedStudy:
    """IV TXA / topical TXA / no TXA - the shape of 28760121 - with equal active arms."""
    iv = _row("IV TXA 10 mg/kg (tranexamic acid)", 900.0, 250.0, 30, 1130.0, CONTROL_SD, CONTROL_N)
    topical = _row("Topical TXA 3 g (tranexamic acid)", 950.0, 250.0, 30, 1130.0, CONTROL_SD, CONTROL_N)
    for row in (iv, topical):
        row.reference_arm = CONTROL_ARM
        row.protocol_outcome_role = "primary"
    return ExtractedStudy(
        characteristics=StudyCharacteristics(study_id="28760121", pmid="28760121", title="IV versus topical TXA",
                                             study_design="Randomized clinical trial with three groups"),
        outcomes=[iv, topical,
                  _transfusion("IV TXA 10 mg/kg (tranexamic acid)", 2, 15),
                  _transfusion("Topical TXA 3 g (tranexamic acid)", 4, 15)],
    )


def test_a_three_arm_trial_gives_two_contrasts_against_its_shared_control():
    protocol, study = _protocol(), _three_arm_study()
    reconcile_extracted_rct_designs(protocol, [study])
    iv, topical, iv_transfusion, topical_transfusion = study.outcomes

    # Each active arm against the one comparator, with ids derived from the arms.
    assert iv.contrast_id == "28760121:iv-txa-10-mg-kg-tranexamic-acid-vs-no-txa-no-tranexamic-acid:0"
    assert topical.contrast_id == "28760121:topical-txa-3-g-tranexamic-acid-vs-no-txa-no-tranexamic-acid:1"
    assert iv.estimand_id == topical.estimand_id and iv.estimand_id.startswith("primary:")
    assert iv.precision_basis == topical.precision_basis == "computed_from_source_verified_arm_summaries"
    # The shared control enters once: its mean's variance is the covariance of the two contrasts.
    assert iv.covariance_with == {topical.contrast_id: pytest.approx(CONTROL_SD ** 2 / CONTROL_N)}
    assert topical.covariance_with == {iv.contrast_id: pytest.approx(CONTROL_SD ** 2 / CONTROL_N)}

    # Secondary rows are typed too, under an estimand of their own that is never pooled here.
    for row in (iv_transfusion, topical_transfusion):
        assert row.contrast_id and row.estimand_id.startswith(DESCRIPTIVE_ESTIMAND_PREFIX)
        assert "allogeneic-transfusion" in row.estimand_id
        assert row.precision_basis == PRECISION_NOT_COMPUTABLE  # counts give no MD
        assert row.covariance_with == {}


def test_the_three_arm_trial_reaches_the_ledger_whole(tmp_path: Path):
    protocol, study = _protocol(), _three_arm_study()
    reconcile_extracted_rct_designs(protocol, [study])
    project = Project("three-arm ledger", output_dir=tmp_path / "project")
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=[study])
    assert migration.skipped_results == []
    assert migration.result_ids == [f"result:28760121:{index}" for index in range(4)]
    assert not [w for w in migration.warnings if "result:28760121:0" in w or "result:28760121:1" in w]
    assert sum("outside the review's primary estimand" in w for w in migration.warnings) == 2


def test_a_two_arm_trial_is_typed_as_before():
    protocol = _protocol()
    two_arm = _two_arm_study()
    secondary = _transfusion("Tranexamic acid 1 g (tranexamic acid)", 3, 9)
    secondary.comparative_design = "parallel_rct"
    two_arm.outcomes.append(secondary)
    report = reconcile_extracted_rct_designs(protocol, [two_arm])
    primary, transfusion = two_arm.outcomes
    assert report["declared_multi_arm_rows_typed"] == 0
    assert primary.comparative_design == "parallel_rct"
    assert primary.precision_basis == "computed_from_source_verified_arm_summaries"
    assert primary.estimand_id.startswith("primary:") and primary.covariance_with == {}
    # A two-arm secondary row keeps its old path: no typing, ordinary aggregate.
    assert (transfusion.contrast_id, transfusion.estimand_id, transfusion.precision_basis) == ("", "", "")


def test_a_multi_arm_row_without_its_arms_is_dropped_naming_them(tmp_path: Path):
    protocol, study = _protocol(), _three_arm_study()
    study.outcomes[3].treatment_arm = None
    study.outcomes[2].reference_arm = study.outcomes[2].treatment_arm
    reconcile_extracted_rct_designs(protocol, [study])
    project = Project("unnamed arms", output_dir=tmp_path / "project")
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=[study])
    skipped = {item["resultId"]: item["missing"] for item in migration.skipped_results}
    assert set(skipped) == {"result:28760121:2", "result:28760121:3"}
    assert "treatment_arm" in skipped["result:28760121:3"]
    assert "a reference_arm distinct from treatment_arm" in skipped["result:28760121:2"]
    # The rows whose arms are known still stand.
    assert {"result:28760121:0", "result:28760121:1"} <= set(migration.result_ids)


def test_a_primary_multi_arm_row_without_precision_is_kept_and_not_pooled(tmp_path: Path):
    """26514221 / 28760121 in the ma-001 runs: arm means without SDs, or a bare
    difference from the Discussion. Nothing can be pooled from them - which
    the ledger now says - but they are no longer dropped as untyped."""
    protocol, study = _protocol(), _three_arm_study()
    for row in study.outcomes[:2]:
        row.sd_intervention = row.sd_control = None
    reconcile_extracted_rct_designs(protocol, [study])
    assert study.outcomes[0].precision_basis == PRECISION_NOT_COMPUTABLE
    assert study.outcomes[0].estimand_id.startswith("primary:")
    project = Project("no sds", output_dir=tmp_path / "project")
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=[study])
    assert migration.skipped_results == []
    assert any("result:28760121:0" in w and "no computable MD estimate" in w for w in migration.warnings)


def test_a_factorial_trial_has_independent_contrasts():
    """22817651 (ma-001 run 8): a 2x2 factorial, TXA vs placebo within each
    drain policy - two contrasts sharing no arm, so their covariance is 0."""
    protocol = _protocol()
    first = _row("Group B tranexamic acid, no clamping (tranexamic acid)", 724.0, 246.0, 60, 1182.0, 411.0, 60)
    second = _row("Group D tranexamic acid, clamping (tranexamic acid)", 526.0, 222.0, 60, 821.0, 337.0, 60)
    first.reference_arm, second.reference_arm = "Group A placebo, no clamping", "Group C placebo, clamping"
    study = ExtractedStudy(characteristics=StudyCharacteristics(study_id="22817651", pmid="22817651", title="Factorial"),
                           outcomes=[first, second])
    reconcile_extracted_rct_designs(protocol, [study])
    assert first.covariance_with == {second.contrast_id: 0.0}
    assert first.covariance_basis == {second.contrast_id: "derived:no_shared_arm"}
    from new_meta.core.extraction_verification import numeric_fields
    assert not any(name.startswith("covariance_with[") for name in numeric_fields(first))


def _records(study: ExtractedStudy, protocol) -> list[dict]:
    from new_meta.core.rct_design_reconciliation import comparative_effect_from_outcome
    records = []
    for index, row in enumerate(study.outcomes):
        if not row.estimand_id.startswith("primary:"):
            continue
        effect = comparative_effect_from_outcome(row, protocol)
        records.append({
            "result_id": f"{study.characteristics.study_id}:{index}", "study_id": study.characteristics.study_id,
            "design": row.comparative_design, "measure": "MD", "estimate": effect["estimate"],
            "variance": effect["variance"], "precision_basis": row.precision_basis, "estimand_id": row.estimand_id,
            "treatment": row.treatment_arm, "comparator": row.reference_arm, "contrast_id": row.contrast_id,
            "covariance_with": row.covariance_with,
        })
    return records


def test_a_pooled_analysis_never_counts_the_shared_control_twice():
    """With two equal active arms against one control, the trial's single
    contribution must be the combined-arms contrast: Var = SD^2/(2n) + SD_c^2/n_c.
    Reusing the control's n whole in both contrasts as if they were independent
    gives 1/(1/v1 + 1/v2), which is smaller - the unit-of-analysis error."""
    protocol, three_arm, two_arm = _protocol(), _three_arm_study(), _two_arm_study()
    reconcile_extracted_rct_designs(protocol, [three_arm, two_arm])
    records = _records(three_arm, protocol) + _records(two_arm, protocol)
    assert len(records) == 3

    result = run_complex_rct(records)
    assert result.n_studies == 2 and result.n_contrasts == 3
    trial = next(item for item in result.study_effects if item["study_id"] == "28760121")
    assert trial["n_contrasts"] == 2

    arm_variance = 250.0 ** 2 / 30
    control_variance = CONTROL_SD ** 2 / CONTROL_N
    combined_arms = arm_variance / 2 + control_variance  # both TXA arms against the control counted once
    assert trial["variance"] == pytest.approx(combined_arms, rel=1e-9)
    assert trial["analysis_effect"] == pytest.approx(((900.0 + 950.0) / 2) - 1130.0, rel=1e-9)
    control_reused_whole = 1.0 / (2.0 / (arm_variance + control_variance))
    assert trial["variance"] > control_reused_whole * 1.2

    # Drop the covariance and the engine refuses rather than count the control twice.
    for record in records:
        record["covariance_with"] = {}
    with pytest.raises(ValueError, match="explicit covariance"):
        run_complex_rct(records)


def test_ma001_three_arm_trials_pool_end_to_end(tmp_path: Path):
    """Ledger -> analysis set -> design-aware engine, secondary rows riding along unpooled."""
    from new_meta.core.method_planning import compile_project_method_plan
    from new_meta.core.pipeline_runner import PipelineRunner
    from primary_alignment_fixture import approve_synthetic_method_fixture

    protocol = _protocol()
    studies = [_three_arm_study(), _two_arm_study()]
    reconcile_extracted_rct_designs(protocol, studies)
    project = Project("ma-001 three-arm", output_dir=tmp_path / "project")
    project.save_json("all_extractions.json", studies, subdir="extraction")
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    assert migration.skipped_results == []
    compile_project_method_plan(project, protocol, enforce=True)
    approve_synthetic_method_fixture(project, protocol, studies)
    phase = PipelineRunner(project).run_compiled_method_synthesis()
    assert phase.status.value == "succeeded", phase.summary
    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    payload = envelope["engine_payload"]
    assert payload["n_studies"] == 2 and payload["n_contrasts"] == 3
    assert sorted(envelope["input_result_ids"]) == ["result:28760121:0", "result:28760121:1", "result:30000001:0"]
    trial = next(item for item in payload["study_effects"] if item["study_id"] == "study:28760121")
    assert math.isclose(trial["variance"], 250.0 ** 2 / 60 + CONTROL_SD ** 2 / CONTROL_N, rel_tol=1e-9)
