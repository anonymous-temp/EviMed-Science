from pathlib import Path

from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.method_validation import load_default_validation_manifest
from new_meta.core.project import Project
from new_meta.schemas.method_policy import CapabilityStatus
from new_meta.schemas.protocol import PICO, ResearchProtocol


def _protocol(**updates) -> ResearchProtocol:
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="28-day mortality",
        ),
        study_designs=["RCT"],
        primary_outcome_type="dichotomous",
        effect_measure="RR",
        model_preference="random",
    )
    return protocol.model_copy(update=updates)


def test_versioned_validation_manifest_has_integrity_checked_production_evidence() -> None:
    manifest = load_default_validation_manifest()

    capability = manifest.capability("intervention_rct.parallel.standard")
    assert capability.release_status is CapabilityStatus.PRODUCTION
    assert set(capability.required_evidence_classes) <= {
        item.evidence_class for item in capability.evidence
    }
    assert all(item.sha256 for item in capability.evidence)
    assert manifest.manifest_fingerprint


def test_parallel_rct_compiles_for_production_without_validation_escape_hatch(tmp_path: Path) -> None:
    project = Project("production RCT", output_dir=tmp_path / "project")

    plan = compile_project_method_plan(project, _protocol(), enforce=True)

    assert plan.capability_id == "intervention_rct.parallel.standard"
    assert plan.capability_status is CapabilityStatus.PRODUCTION
    assert plan.execution_allowed is True
    assert plan.validation_manifest_fingerprint
    assert len(plan.validation_evidence_ids) >= 3


def test_complex_rct_has_its_own_verified_production_capability(tmp_path: Path) -> None:
    project = Project("cluster RCT", output_dir=tmp_path / "project")

    plan = compile_project_method_plan(
        project,
        _protocol(study_designs=["cluster RCT"]),
        enforce=True,
    )

    assert plan.capability_id == "intervention_rct.complex_design"
    assert plan.capability_status is CapabilityStatus.PRODUCTION
    assert plan.execution_allowed is True
    assert set(plan.validation_evidence_ids) == {
        "metafor_complex_rct_reml_2026_07_17",
        "complex_rct_design_policy_cases_2026_07_17",
    }


def test_manifest_rejects_changed_evidence_artifact(tmp_path: Path) -> None:
    source = Path("validation/corpora/metafor_bcg_rr_reml.json")
    changed = tmp_path / source.name
    changed.write_text(source.read_text(encoding="utf-8") + "\n", encoding="utf-8")

    manifest = load_default_validation_manifest()
    evidence = manifest.capability("intervention_rct.parallel.standard").evidence[0]

    assert manifest.verify_evidence(evidence, artifact_override=changed) is False


def test_prevalence_and_incidence_have_separately_validated_production_capabilities(tmp_path: Path) -> None:
    prevalence_project = Project("prevalence production", output_dir=tmp_path / "prevalence")
    prevalence = _protocol(
        review_family="prevalence_incidence",
        study_designs=["cross-sectional"],
        primary_outcome_type="proportion",
        effect_measure="PROP",
    )

    prevalence_plan = compile_project_method_plan(
        prevalence_project,
        prevalence,
        enforce=True,
    )

    assert prevalence_plan.capability_id == "prevalence.proportion.glmm"
    assert prevalence_plan.capability_status is CapabilityStatus.PRODUCTION
    assert prevalence_plan.execution_allowed is True
    assert len(prevalence_plan.validation_evidence_ids) == 2

    incidence_project = Project("incidence production", output_dir=tmp_path / "incidence")
    incidence = _protocol(
        review_family="prevalence_incidence",
        study_designs=["cohort"],
        primary_outcome_type="incidence_rate",
        effect_measure="IR",
    )
    incidence_plan = compile_project_method_plan(incidence_project, incidence)

    assert incidence_plan.capability_id == "incidence.poisson.glmm"
    assert incidence_plan.capability_status is CapabilityStatus.PRODUCTION
    assert incidence_plan.execution_allowed is True
    assert len(incidence_plan.validation_evidence_ids) == 3


def test_common_threshold_reitsma_reml_is_production_but_two_gate_is_not(
    tmp_path: Path,
) -> None:
    dta_project = Project("DTA production", output_dir=tmp_path / "dta")
    dta = _protocol(
        review_family="diagnostic_accuracy",
        study_designs=["diagnostic cross-sectional"],
        primary_outcome_type="diagnostic_accuracy",
        effect_measure="SENS_SPEC",
    )

    dta_plan = compile_project_method_plan(dta_project, dta, enforce=True)

    assert dta_plan.capability_id == "diagnostic_accuracy.reitsma_reml"
    assert dta_plan.capability_status is CapabilityStatus.PRODUCTION
    assert dta_plan.execution_allowed is True
    assert dta_plan.primary_estimator == "REITSMA_BIVARIATE_REML"
    assert len(dta_plan.validation_evidence_ids) == 2

    two_gate_project = Project("two gate blocked", output_dir=tmp_path / "two-gate")
    two_gate = dta.model_copy(update={"study_designs": ["case-control"]})
    two_gate_plan = compile_project_method_plan(two_gate_project, two_gate)

    assert two_gate_plan.capability_id == "diagnostic_accuracy.two_gate"
    assert two_gate_plan.capability_status is CapabilityStatus.BLOCKED
    assert two_gate_plan.execution_allowed is False
