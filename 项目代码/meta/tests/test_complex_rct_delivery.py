from pathlib import Path

from new_meta.core.extraction_ledger import migrate_extractions_to_ledger
from new_meta.core.method_certainty import (
    build_method_certainty_draft,
    build_method_certainty_option_payload,
    complete_method_certainty_conservatively,
)
from new_meta.core.method_manuscript import build_method_manuscript
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.core.provenance import classify_source_provenance
from new_meta.core.rct_design_reconciliation import reconcile_extracted_rct_designs
from new_meta.core.rct_design_reconciliation import canonical_outcome_name
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.method_certainty import MethodCertaintyStatus
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _outcome(**updates) -> OutcomeData:
    payload = {
        "outcome_name": "Treatment response at 12 weeks",
        "outcome_type": "dichotomous",
        "effect_size": 0.8,
        "ci_lower": 0.65,
        "ci_upper": 0.98,
        "reported_effect_measure": "RR",
        "reported_effect_scale": "original",
        "source_quote": "The design-adjusted risk ratio was 0.80 (95% CI 0.65 to 0.98).",
        "source_quote_verified": True,
        "source_location": "Results, Table 2",
        "source_page": 4,
        "comparative_design": "cluster_rct",
        "treatment_arm": "Drug",
        "reference_arm": "Control",
        "contrast_id": "C1:drug-control",
        "estimand_id": "drug-vs-control",
        "precision_basis": "reported_cluster_adjusted",
    }
    payload.update(updates)
    return OutcomeData(**payload)


def _prepared_project(tmp_path: Path):
    project = Project("Complex RCT delivery", output_dir=tmp_path / "project")
    protocol = ResearchProtocol(
        research_question="Does Drug improve treatment response compared with Control?",
        pico=PICO(
            population="Adults with condition X",
            intervention="Drug",
            comparator="Control",
            outcome_primary="Treatment response at 12 weeks",
        ),
        review_family="intervention_rct",
        study_designs=["cluster RCT", "crossover RCT", "multi-arm RCT"],
        primary_outcome_type="dichotomous",
        effect_measure="RR",
        databases=["PubMed", "Embase"],
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="C1", title="Cluster trial", study_design="cluster RCT", total_sample_size=240
            ),
            outcomes=[_outcome()],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="X1", title="Crossover trial", study_design="crossover RCT", total_sample_size=120
            ),
            outcomes=[
                _outcome(
                    effect_size=0.74,
                    ci_lower=0.58,
                    ci_upper=0.95,
                    comparative_design="crossover_rct",
                    contrast_id="X1:drug-control",
                    precision_basis="reported_paired_effect",
                    paired_analysis=True,
                )
            ],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="M1", title="Multi-arm trial", study_design="multi-arm RCT", total_sample_size=300
            ),
            outcomes=[
                _outcome(
                    effect_size=-0.35667494393873245,
                    reported_effect_standard_error=0.20,
                    ci_lower=None,
                    ci_upper=None,
                    reported_effect_scale="log",
                    comparative_design="multi_arm_rct",
                    treatment_arm="Drug dose 1",
                    contrast_id="M1:dose1-control",
                    precision_basis="reported_effect",
                    covariance_with={"M1:dose2-control": 0.02},
                ),
                _outcome(
                    effect_size=-0.2744368457017603,
                    reported_effect_standard_error=0.25,
                    ci_lower=None,
                    ci_upper=None,
                    reported_effect_scale="log",
                    comparative_design="multi_arm_rct",
                    treatment_arm="Drug dose 2",
                    contrast_id="M1:dose2-control",
                    precision_basis="reported_effect",
                    covariance_with={"M1:dose1-control": 0.02},
                ),
            ],
        ),
    ]
    migration = migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    plan = compile_project_method_plan(project, protocol, enforce=True)
    phase = PipelineRunner(project).run_compiled_method_synthesis()
    return project, protocol, studies, migration, plan, phase


def test_complex_rct_has_a_complete_topic_to_manuscript_delivery_chain(tmp_path: Path) -> None:
    project, protocol, studies, migration, plan, phase = _prepared_project(tmp_path)

    assert plan.capability_id == "intervention_rct.complex_design"
    assert plan.capability_status.value == "production"
    assert plan.execution_allowed is True
    assert phase.status.value == "succeeded"
    assert len(migration.result_ids) == 4

    certainty_draft = build_method_certainty_draft(project)
    assert certainty_draft.status is MethodCertaintyStatus.NEEDS_INPUT
    assert certainty_draft.outcomes[0].starting_certainty == "high"
    assert build_method_certainty_option_payload(certainty_draft)["recommended_option_id"] == (
        "conservative"
    )
    certainty = complete_method_certainty_conservatively(project, certainty_draft)
    assert certainty.status is MethodCertaintyStatus.COMPLETED

    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    assert envelope["family"] == "intervention_rct"
    assert envelope["route"] == "method_plugin"
    assert envelope["primary_estimates"][0]["measure"] == "RR"
    assert envelope["engine_payload"]["n_studies"] == 3
    assert envelope["engine_payload"]["n_contrasts"] == 4
    assert envelope["engine_payload"]["diagnostics"]["independent_study_units"] is True

    manuscript = build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=[],
        prisma_data={
            "identification": {"records_identified": 100, "records_after_dedup": 80},
            "eligibility": {"full_text_assessed": 12},
            "included": {"studies_included": 3},
        },
        search_query='"Drug" AND randomized',
        lang="en",
    )
    assert "cluster-randomized" in manuscript
    assert "crossover" in manuscript
    assert "multi-arm" in manuscript
    assert "within-study covariance" in manuscript
    assert "restricted maximum likelihood" in manuscript
    assert "permission" not in manuscript.lower()
    assert "approval" not in manuscript.lower()

    chinese = build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=studies,
        rob_results=[],
        prisma_data={"included": {"studies_included": 3}},
        search_query='"Drug" AND randomized',
        lang="zh",
    )
    assert "整群随机" in chinese
    assert "交叉试验" in chinese
    assert "多臂试验" in chinese


def test_extracted_shared_control_arms_recompile_and_execute_complex_route(tmp_path: Path) -> None:
    project = Project("Detected multi-arm RCT", output_dir=tmp_path / "detected")
    protocol = ResearchProtocol(
        research_question="Does Drug reduce postoperative delirium?",
        pico=PICO(
            population="Older surgical patients",
            intervention="Intravenous Drug",
            comparator="Placebo",
            outcome_primary="Incidence of postoperative delirium",
        ),
        review_family="intervention_rct",
        study_designs=["parallel RCT"],
        primary_outcome_type="dichotomous",
        effect_measure="RR",
    )

    def outcome(*, treatment, events_i, total_i, events_c, total_c):
        return OutcomeData(
            outcome_name=protocol.pico.outcome_primary,
            outcome_type="dichotomous",
            events_intervention=events_i,
            total_intervention=total_i,
            events_control=events_c,
            total_control=total_c,
            treatment_arm=treatment,
            reference_arm="Placebo",
            source_location="Results Table 2",
            source_quote=(
                f"{treatment}: {events_i}/{total_i}; Placebo: {events_c}/{total_c}."
            ),
            source_quote_verified=True,
            extraction_confidence="high",
        )

    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="P1",
                title="Parallel trial",
                study_design="parallel RCT",
                intervention_description="Drug",
                control_description="Placebo",
            ),
            outcomes=[outcome(treatment="Drug", events_i=8, total_i=100, events_c=16, total_c=100)],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="M1",
                title="Dose-ranging trial",
                study_design="RCT",
                intervention_description="Drug low or high dose",
                control_description="Placebo",
            ),
            outcomes=[
                outcome(treatment="Drug low", events_i=5, total_i=80, events_c=14, total_c=80),
                outcome(treatment="Drug high", events_i=4, total_i=80, events_c=14, total_c=80),
            ],
        ),
    ]

    report = reconcile_extracted_rct_designs(protocol, studies)
    project.save_json("protocol.json", protocol)
    migrate_extractions_to_ledger(project, protocol=protocol, extracted_studies=studies)
    plan = compile_project_method_plan(project, protocol, enforce=True)
    phase = PipelineRunner(project).run_compiled_method_synthesis(auto_select_ambiguous=True)

    assert report["multi_arm_studies"] == ["M1"]
    assert protocol.study_designs == ["multi-arm RCT", "parallel RCT"]
    assert plan.capability_id == "intervention_rct.complex_design"
    assert phase.status.value == "succeeded"
    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    assert envelope["engine_payload"]["n_studies"] == 2
    assert envelope["engine_payload"]["n_contrasts"] == 3
    assert envelope["engine_payload"]["design_counts"] == {
        "multi_arm_rct": 1,
        "parallel_rct": 1,
    }
    left, right = studies[1].outcomes
    assert right.contrast_id in left.covariance_with
    assert left.covariance_with[right.contrast_id] == right.covariance_with[left.contrast_id]


def test_reported_effect_recovery_selects_effect_matching_extracted_arm_counts() -> None:
    protocol = ResearchProtocol(
        research_question="Does Drug reduce postoperative delirium?",
        pico=PICO(
            population="Older surgical patients",
            intervention="Drug",
            comparator="Placebo",
            outcome_primary="Incidence of postoperative delirium",
        ),
        effect_measure="RR",
    )
    outcome = OutcomeData(
        outcome_name=protocol.pico.outcome_primary,
        outcome_type="dichotomous",
        events_intervention=20,
        total_intervention=110,
        events_control=33,
        total_control=108,
        source_quote="Overall delirium was 18.2% versus 30.6%.",
        source_quote_verified=True,
    )
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            pmid="S1",
            study_design="RCT",
            intervention_description="Drug",
            control_description="Placebo",
        ),
        outcomes=[outcome],
    )
    source = (
        "On day 1, delirium was lower (RR = 0.542; 95% CI, 0.235–0.915).\n"
        "Across the full assessment, overall delirium was 18.2% versus 30.6%; "
        "RR = 0.595; 95% CI, 0.268–0.952."
    )

    report = reconcile_extracted_rct_designs(
        protocol,
        [study],
        parsed_papers={"S1": {"full_text": source}},
    )

    assert report["reported_effects_recovered"] == 1
    assert outcome.effect_size == 0.595
    assert outcome.ci_lower == 0.268
    assert outcome.ci_upper == 0.952
    assert "overall delirium" in outcome.source_quote.lower()


def test_findings_location_is_primary_report_provenance() -> None:
    tier, _ = classify_source_provenance("Page 2, Findings paragraph")

    assert tier == "primary_report"


def test_postoperative_cognitive_dysfunction_is_not_relabelled_as_delirium() -> None:
    protocol = ResearchProtocol(
        research_question="Does Drug reduce postoperative delirium?",
        pico=PICO(
            population="Older surgical patients",
            intervention="Drug",
            comparator="Placebo",
            outcome_primary="Incidence of postoperative delirium",
        ),
        effect_measure="RR",
    )
    pocd = OutcomeData(
        outcome_name="Incidence of postoperative cognitive dysfunction (POCD)",
        outcome_type="dichotomous",
    )
    pod = OutcomeData(
        outcome_name="Incidence of postoperative delirium (POD)",
        outcome_type="dichotomous",
    )

    assert canonical_outcome_name(pocd, protocol) == pocd.outcome_name
    assert canonical_outcome_name(pod, protocol) == protocol.pico.outcome_primary
