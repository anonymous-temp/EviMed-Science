import json
from pathlib import Path

import numpy as np

from new_meta.core.ipd_ingestion import ingest_ipd_studies_to_ledger, load_ipd_json
from new_meta.core.method_certainty import (
    build_method_certainty_draft,
    complete_method_certainty_conservatively,
)
from new_meta.core.method_manuscript import build_method_manuscript
from new_meta.core.method_planning import compile_project_method_plan
from new_meta.core.pipeline_runner import PipelineRunner
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.method_certainty import MethodCertaintyStatus


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Does Drug improve symptom score using individual participant data?",
        pico=PICO(
            population="Adults with condition X",
            intervention="Drug",
            comparator="Placebo",
            outcome_primary="Symptom score at 12 weeks",
        ),
        review_family="ipd_meta",
        study_designs=["parallel RCT"],
        primary_outcome_type="continuous",
        effect_measure="MD",
        databases=["PubMed", "Embase"],
    )


def _records() -> list[dict]:
    rng = np.random.default_rng(20260720)
    records = []
    for study_index in range(4):
        participants = []
        for participant_index in range(80):
            treatment = participant_index % 2
            baseline = float(rng.normal())
            outcome = (
                12
                + study_index
                - 1.8 * treatment
                + 0.7 * baseline
                - 0.25 * treatment * baseline
                + rng.normal(0, 2)
            )
            participants.append({
                "participant_id": f"P{study_index}-{participant_index}",
                "treatment": treatment,
                "outcome": float(outcome),
                "covariates": {"baseline": baseline},
            })
        records.append({"study_id": f"IPD{study_index + 1}", "participants": participants})
    return records


def test_ipd_has_complete_dataset_to_article_delivery(tmp_path: Path) -> None:
    project = Project("IPD delivery", output_dir=tmp_path / "project")
    protocol = _protocol()
    ingestion = ingest_ipd_studies_to_ledger(
        project,
        protocol=protocol,
        records=_records(),
    )
    repeated = ingest_ipd_studies_to_ledger(
        project,
        protocol=protocol,
        records=_records(),
    )
    plan = compile_project_method_plan(project, protocol, enforce=True)
    phase = PipelineRunner(project).run_compiled_method_synthesis(
        options={"covariates": ["baseline"], "effect_modifier": "baseline"}
    )

    assert ingestion.created_entities > 0
    assert len(ingestion.result_ids) == 4
    assert repeated.result_ids == ingestion.result_ids
    assert repeated.superseded_entities == 0
    assert repeated.unchanged_entities == ingestion.created_entities
    assert plan.capability_id == "ipd_meta.parallel_two_stage"
    assert plan.capability_status.value == "production"
    assert plan.execution_allowed is True
    assert phase.status.value == "succeeded"

    certainty_draft = build_method_certainty_draft(project)
    assert certainty_draft.status is MethodCertaintyStatus.NEEDS_INPUT
    assert certainty_draft.outcomes[0].starting_certainty == "high"
    certainty = complete_method_certainty_conservatively(project, certainty_draft)
    assert certainty.status is MethodCertaintyStatus.COMPLETED

    envelope = project.load_json("synthesis_result.json", subdir="analysis")
    assert envelope["family"] == "ipd_meta"
    assert envelope["route"] == "method_plugin"
    assert envelope["engine_payload"]["n_studies"] == 4
    assert envelope["engine_payload"]["n_participants"] == 320
    assert envelope["engine_payload"]["effect_measure"] == "MD"
    assert envelope["engine_payload"]["one_stage_sensitivity"]["model"] == (
        "fixed_study_intercepts"
    )
    assert envelope["engine_payload"]["effect_modification"]["modifier"] == "baseline"
    assert envelope["engine_payload"]["diagnostics"]["modifier_centering"] == "within_study"

    manuscript = build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=[],
        rob_results=[],
        prisma_data={"included": {"studies_included": 4}},
        search_query='"Drug" AND randomized',
        lang="en",
    )
    assert "individual participant data" in manuscript.lower()
    assert "two-stage" in manuscript.lower()
    assert "restricted maximum likelihood" in manuscript.lower()
    assert "one-stage sensitivity" in manuscript.lower()
    assert "within each study" in manuscript.lower()
    assert "permission" not in manuscript.lower()
    assert "approval" not in manuscript.lower()
    assert project.load_json("manuscript_validation.json", subdir="manuscript")["passed"] is True

    chinese = build_method_manuscript(
        project=project,
        protocol=protocol,
        extracted_studies=[],
        rob_results=[],
        prisma_data={"included": {"studies_included": 4}},
        search_query='"Drug" AND randomized',
        lang="zh",
    )
    assert "个体参与者数据" in chinese
    assert "两阶段" in chinese
    assert "限制性最大似然" in chinese
    assert "单阶段敏感性分析" in chinese
    assert project.load_json("manuscript_validation.json", subdir="manuscript")["passed"] is True


def test_ipd_without_participant_data_pauses_with_two_real_options(tmp_path: Path) -> None:
    project = Project("IPD needs data", output_dir=tmp_path / "project")
    protocol = _protocol()
    compile_project_method_plan(project, protocol, enforce=True)

    phase = PipelineRunner(project).run_compiled_method_synthesis()

    assert phase.status.value == "needs_input"
    assert phase.error_code == "ipd_data_required"
    assert phase.data["decision_type"] == "ipd_data_availability"
    assert {item["option_id"] for item in phase.data["options"]} == {
        "provide_ipd_dataset",
        "switch_to_aggregate_data",
    }


def test_ipd_json_cli_shape_loads_studies_and_model_options(tmp_path: Path) -> None:
    path = tmp_path / "ipd.json"
    path.write_text(
        json.dumps({
            "outcome_type": "continuous",
            "covariates": ["baseline"],
            "effect_modifier": "baseline",
            "studies": _records(),
        }),
        encoding="utf-8",
    )

    records, outcome_type, options = load_ipd_json(path)

    assert len(records) == 4
    assert outcome_type == "continuous"
    assert options == {"covariates": ["baseline"], "effect_modifier": "baseline"}
