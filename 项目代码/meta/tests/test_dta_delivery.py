from pathlib import Path

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_certainty import (
    build_method_certainty_draft,
    save_method_certainty_adjudication,
)
from new_meta.core.method_manuscript import build_method_manuscript
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.method_release import build_method_release_review
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.schemas.method_certainty import CertaintyDomainRating, MethodCertaintyStatus
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.risk_of_bias import (
    ResultRoBAssessment,
    RoBAssessmentStatus,
    RoBDomain,
    RoBTargetEffect,
)
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _prepared_dta_project(tmp_path: Path):
    project = Project("DTA delivery", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="What is the accuracy of IndexTest for condition X?",
        pico=PICO(
            population="Adults with suspected condition X",
            intervention="IndexTest at 10 ng/mL",
            comparator="Reference standard",
            outcome_primary="Sensitivity and specificity",
        ),
        effect_measure="SENS_SPEC",
        review_family="diagnostic_accuracy",
        primary_outcome_type="diagnostic_accuracy",
        study_designs=["diagnostic cross-sectional"],
        databases=["PubMed", "Embase"],
    )
    data = (
        ("D1", 45, 5, 20, 80),
        ("D2", 70, 30, 5, 95),
        ("D3", 30, 20, 30, 70),
        ("D4", 90, 10, 15, 85),
        ("D5", 50, 50, 2, 98),
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                title=f"Diagnostic study {study_id}",
                authors=[f"Author{index} Jane"],
                year=2020 + index,
                study_design="diagnostic cross-sectional",
                country="Country",
                total_sample_size=tp + fn + fp + tn,
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="IndexTest accuracy",
                    outcome_type="diagnostic_accuracy",
                    true_positive=tp,
                    false_negative=fn,
                    false_positive=fp,
                    true_negative=tn,
                    diagnostic_threshold="10 ng/mL",
                    source_quote=(
                        f"At 10 ng/mL, TP={tp}, FN={fn}, FP={fp}, and TN={tn}."
                    ),
                    source_quote_verified=True,
                    source_location="Results, Table 2",
                    source_page=index,
                )
            ],
        )
        for index, (study_id, tp, fn, fp, tn) in enumerate(data, start=1)
    ]
    migration = migrate_extractions_to_ledger(
        project,
        protocol=protocol,
        extracted_studies=studies,
    )
    plan = compile_project_method_plan(project, protocol, enforce=True)
    phase = PipelineRunner(project).run_compiled_method_synthesis()
    assert phase.status.value == "succeeded"
    assessments = [
        ResultRoBAssessment(
            assessment_id=f"rob:{result_id}:complete",
            result_id=result_id,
            study_id=study_id,
            outcome_name="IndexTest accuracy",
            tool_used="QUADAS-2",
            tool_version="QUADAS-2 (2011)",
            target_effect=RoBTargetEffect.DIAGNOSTIC_ACCURACY,
            assessment_status=RoBAssessmentStatus.COMPLETE,
            assessed_by="reviewer@example.org",
            domains=[
                RoBDomain(
                    domain="Patient selection",
                    judgment="Low risk",
                    support="Consecutive eligible participants were enrolled.",
                    source_page=2,
                    source_section="Methods",
                    source_quote="We prospectively enrolled consecutive eligible adults.",
                )
            ],
            overall_judgment="Low risk",
            requires_adjudication=False,
        )
        for result_id, (study_id, *_cells) in zip(migration.result_ids, data)
    ]
    project.save_json("rob_result_assessments.json", assessments, subdir="risk_of_bias")
    return project, protocol, studies, assessments, plan


def _render(project, protocol, studies, assessments, *, lang="en"):
    return build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=assessments,
        prisma_data={
            "identification": {"records_identified": 100, "records_after_dedup": 80},
            "eligibility": {"full_text_assessed": 12},
            "included": {"studies_included": 5},
        },
        search_query='"IndexTest" AND (sensitivity OR specificity)',
        lang=lang,
    )


def test_dta_certainty_manuscript_and_release_are_one_versioned_delivery_chain(
    tmp_path: Path,
) -> None:
    project, protocol, studies, assessments, plan = _prepared_dta_project(tmp_path)

    draft = build_method_certainty_draft(project)

    assert draft.status is MethodCertaintyStatus.NEEDS_INPUT
    assert draft.family.value == "diagnostic_accuracy"
    assert "diagnostic test accuracy" in draft.framework.lower()
    domains = {item.domain: item for item in draft.outcomes[0].domains}
    assert domains["risk_of_bias"].rating is CertaintyDomainRating.NO_CONCERN
    assert {
        name for name, domain in domains.items() if domain.requires_human_judgment
    } == {"inconsistency", "indirectness", "imprecision", "publication_bias"}

    pending_manuscript = _render(project, protocol, studies, assessments)
    assert "certainty assessment requires human adjudication" in pending_manuscript.lower()

    completed = save_method_certainty_adjudication(
        project,
        expected_revision=0,
        adjudicated_by="reviewer@example.org",
        reason="Joint clinical review of accuracy, applicability, and reporting domains.",
        domain_overrides={
            "inconsistency": {
                "rating": "serious",
                "rationale": "Sensitivity and false-positive-rate heterogeneity may alter decisions.",
            },
            "indirectness": {
                "rating": "no_concern",
                "rationale": "Population, index test, reference standard, and threshold match the review question.",
            },
            "imprecision": {
                "rating": "serious",
                "rationale": "The joint confidence region crosses a clinically important decision boundary.",
            },
            "publication_bias": {
                "rating": "serious",
                "rationale": "Selective non-publication of small accuracy studies cannot be excluded.",
            },
        },
    )
    assert completed.status is MethodCertaintyStatus.COMPLETED
    assert completed.revision == 1

    stale_review = build_method_release_review(project)
    stale_checks = {item["id"]: item for item in stale_review["checks"]}
    assert stale_checks["method_manuscript_current_certainty"]["passed"] is False

    manuscript = _render(project, protocol, studies, assessments)
    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    sensitivity = envelope["primary_estimates"][0]
    specificity = envelope["primary_estimates"][1]
    for heading in (
        "# Diagnostic accuracy of IndexTest",
        "## Abstract",
        "## Introduction",
        "## Methods",
        "## Results",
        "## Discussion",
        "## Conclusions",
        "## Declarations",
    ):
        assert heading in manuscript
    assert "Reitsma bivariate random-effects model" in manuscript
    assert "restricted maximum likelihood" in manuscript
    assert "logit false-positive rate" in manuscript
    assert "10 ng/mL" in manuscript
    assert f"{100 * sensitivity['estimate']:.1f}%" in manuscript
    assert f"{100 * specificity['estimate']:.1f}%" in manuscript
    assert "SROC AUC" in manuscript
    assert completed.outcomes[0].certainty.replace("_", " ") in manuscript.lower()
    assert "DerSimonian-Laird" not in manuscript

    validation = project.load_json("manuscript_validation.json", subdir="manuscript")
    assert validation["passed"] is True
    assert validation["method_family"] == "diagnostic_accuracy"
    assert validation["method_certainty_revision"] == 1
    assert validation["method_certainty_status"] == "completed"
    assert validation["method_plan_fingerprint"] == plan.plan_fingerprint

    release = build_method_release_review(project)
    assert release["passed"] is True
    assert release["status"] == "ready"

    chinese = _render(project, protocol, studies, assessments, lang="zh")
    assert "## 摘要" in chinese
    assert "双变量随机效应模型" in chinese
    assert "敏感度" in chinese
    assert "特异度" in chinese
