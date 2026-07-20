from uuid import uuid4
import json
import zipfile

import new_meta.main as main_module
from start import META_ROOT, _compute_primary_effect_selection, _run_downstream_after_overrides_payload
from new_meta.agents.writing_agent import WritingAgent
from new_meta.core.extraction_review import ExtractionOverride, save_extraction_override
from new_meta.core.project import Project
from new_meta.engines import visualization
from new_meta.schemas.grade import GRADEOutcome, GRADEProfile
from new_meta.schemas.meta_result import MetaAnalysisResults, PooledEffect
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def _project_under_output() -> Project:
    root = META_ROOT / "output" / "pytest_downstream_rerun" / uuid4().hex
    return Project("downstream rerun", output_dir=root)


def test_downstream_rerun_zero_primary_effects_stays_evidence_gap(monkeypatch) -> None:
    project = _project_under_output()
    protocol = ResearchProtocol(
        research_question="Drug versus usual care for mortality in adults",
        pico=PICO(
            population="adults",
            intervention="drug",
            comparator="usual care",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            title="Trial one",
            authors=["Smith John"],
            year=2020,
            population_description="Adults with the target condition",
            intervention_description="Drug",
            control_description="Usual care",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="mortality",
                outcome_type="dichotomous",
                source_location="Table 2",
                source_quote="Mortality was reported, but arm-level counts were not extractable.",
                source_quote_verified=True,
                extraction_confidence="high",
            )
        ],
    )
    project.save_json("protocol.json", protocol)
    project.save_json("all_extractions.json", [study], subdir="extraction")
    project.save_json(
        "extraction_audit.json",
        {"summary": {"rows_requiring_review": 0, "conflict_rows": 0}, "rows": []},
        subdir="extraction",
    )
    save_extraction_override(
        project,
        ExtractionOverride(
            study_id="S1",
            outcome_index=0,
            outcome_name="mortality",
            field="source_location",
            value="Table 3",
            reason="User corrected location before rerun",
            updated_by="tester",
        ),
        expected_revision=0,
    )

    def fake_write(self, **kwargs):
        project_arg = kwargs["project"]
        report_state = kwargs.get("report_state")
        assert report_state.report_type == "evidence_gap"
        project_arg.save_json(
            "manuscript_facts.json",
            {
                "report_type": "evidence_gap",
                "evidence_readiness": {
                    "status": "blocked",
                    "action_required": True,
                    "blocker_codes": [
                        "insufficient_primary_effects",
                        "evidence_gate_evidence_gap",
                    ],
                    "blockers": [
                        {
                            "code": "insufficient_primary_effects",
                            "message": "No computable primary effects were available.",
                        },
                        {
                            "code": "evidence_gate_evidence_gap",
                            "message": "Evidence gate classified the run as an evidence gap.",
                        },
                    ],
                    "warnings": [],
                    "selected_primary_rows": [],
                },
            },
            subdir="manuscript",
        )
        project_arg.save_json(
            "manuscript_validation.json",
            {"passed": True, "issues": [], "facts_summary": {"report_type": "evidence_gap"}},
            subdir="manuscript",
        )
        manuscript = "# Systematic Review Evidence-Gap Report\n\nNo computable primary effects were available."
        project_arg.save_text("draft.md", manuscript, subdir="manuscript")
        return manuscript

    monkeypatch.setattr(WritingAgent, "run", fake_write)
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)

    result = _run_downstream_after_overrides_payload({"project_dir": str(project.base_dir)})
    updated = project.load_json("all_extractions.json", subdir="extraction")
    facts = project.load_json("manuscript_facts.json", subdir="manuscript")
    audit = project.load_json("effect_selection_audit.json", subdir="analysis")
    draft = project.load_text("draft.md", subdir="manuscript")

    assert result["ok"] is True
    assert result["applied_overrides"] == 1
    assert result["n_effects"] == 0
    assert result["report_type"] == "evidence_gap"
    assert result["evidence_readiness"]["action_required"] is True
    assert "insufficient_primary_effects" in result["evidence_readiness"]["blocker_codes"]
    assert result["package_path"].endswith("metaagent_export.zip")
    assert facts["report_type"] == "evidence_gap"
    assert project.is_step_done("effect_sizes") is True
    assert project.is_step_done("manuscript") is True
    assert project.is_step_done("meta_analysis") is False
    assert updated[0]["outcomes"][0]["source_location"] == "Table 3"
    assert updated[0]["outcomes"][0]["user_override_applied"] is True
    assert audit[0]["decision"] == "excluded"
    assert audit[0]["reason"] == "insufficient_data_to_compute_effect_size"
    assert "# Systematic Review Evidence-Gap Report" in draft
    with zipfile.ZipFile(result["package_path"]) as zf:
        names = set(zf.namelist())
        review = json.loads(zf.read("review/evidence_readiness_review.json"))
    assert "package_manifest.json" in names
    assert "insufficient_primary_effects" in review["blocker_codes"]
    assert "evidence_gate_evidence_gap" in review["blocker_codes"]


def test_downstream_rerun_uses_shared_meta_helper(monkeypatch) -> None:
    project = _project_under_output()
    protocol = ResearchProtocol(
        research_question="Drug versus usual care for mortality in adults",
        pico=PICO(
            population="adults",
            intervention="drug",
            comparator="usual care",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S1",
                title="Trial one",
                authors=["Smith John"],
                year=2020,
                population_description="Adults with the target condition",
                intervention_description="Drug",
                control_description="Usual care",
                study_design="randomized controlled trial",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="mortality",
                    outcome_type="dichotomous",
                    events_intervention=10,
                    total_intervention=100,
                    events_control=20,
                    total_control=100,
                    source_location="Table 2",
                    source_quote="Mortality was 10/100 vs 20/100.",
                    source_quote_verified=True,
                    extraction_confidence="high",
                )
            ],
        ),
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S2",
                title="Trial two",
                authors=["Jones Mary"],
                year=2021,
                population_description="Adults with the target condition",
                intervention_description="Drug",
                control_description="Usual care",
                study_design="randomized controlled trial",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="mortality",
                    outcome_type="dichotomous",
                    events_intervention=5,
                    total_intervention=80,
                    events_control=8,
                    total_control=80,
                    source_location="Table 2",
                    source_quote="Mortality was 5/80 vs 8/80.",
                    source_quote_verified=True,
                    extraction_confidence="high",
                )
            ],
        ),
    ]
    project.save_json("protocol.json", protocol)
    project.save_text("search_query.txt", "mortality drug usual care")
    project.save_json("all_extractions.json", studies, subdir="extraction")
    project.save_json(
        "rob_results.json",
        [
            StudyRoB(study_id="S1", tool_used="RoB 2", overall_judgment="Low risk"),
            StudyRoB(study_id="S2", tool_used="RoB 2", overall_judgment="Low risk"),
        ],
        subdir="risk_of_bias",
    )
    project.save_json(
        "extraction_audit.json",
        {"summary": {"rows_requiring_review": 0, "conflict_rows": 0}, "rows": []},
        subdir="extraction",
    )

    calls = {"meta": 0, "grade": 0}

    def fake_meta_helper(project_arg, *, protocol, extracted_studies, study_effects):
        calls["meta"] += 1
        assert len(study_effects) == 2
        pooled = PooledEffect(
            outcome_name=protocol.pico.outcome_primary,
            n_studies=2,
            effect_measure=protocol.effect_measure,
            pooled_effect=0.7,
            ci_lower=0.5,
            ci_upper=0.9,
            p_value=0.01,
            studies=study_effects,
        )
        result = MetaAnalysisResults(primary_outcome=pooled)
        project_arg.save_json("meta_results.json", result, subdir="analysis")
        project_arg.save_checkpoint("meta_analysis")
        return result

    def fake_grade_helper(project_arg, model, *, protocol, meta_results, rob_results, extracted_studies, force=False):
        calls["grade"] += 1
        assert force is True
        profile = GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name=protocol.pico.outcome_primary,
                n_studies=2,
                effect_summary="RR 0.70 (95% CI 0.50 to 0.90)",
                certainty="Low",
            )
        ])
        project_arg.save_json("grade_profile.json", profile, subdir="analysis")
        project_arg.save_checkpoint("grade")
        return profile

    monkeypatch.setattr(main_module, "_run_meta_analysis_from_effects", fake_meta_helper)
    monkeypatch.setattr(main_module, "_run_grade_from_cached_meta", fake_grade_helper)
    figure_langs: list[str] = []

    def fake_figure(*args, **kwargs):
        figure_langs.append(kwargs.get("lang"))
        return "figure-b64"

    monkeypatch.setattr(visualization, "forest_plot", fake_figure)
    monkeypatch.setattr(visualization, "funnel_plot", fake_figure)
    monkeypatch.setattr(visualization, "prisma_flow_diagram", fake_figure)

    captured_write: dict = {}

    def fake_write(self, **kwargs):
        assert self._lang == "zh"
        captured_write["report_state"] = kwargs.get("report_state")
        captured_write["evidence_classes"] = kwargs.get("evidence_classes")
        kwargs["project"].save_text("draft.md", "meta manuscript", subdir="manuscript")
        return "meta manuscript"

    monkeypatch.setattr(WritingAgent, "run", fake_write)
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)

    result = _run_downstream_after_overrides_payload({
        "project_dir": str(project.base_dir),
        "output_language": "中文",
    })

    assert result["ok"] is True
    assert result["n_effects"] == 2
    assert result["package_path"].endswith("metaagent_export.zip")
    assert project.get_path("metaagent_export.zip", subdir="package").exists()
    assert calls == {"meta": 1, "grade": 1}
    assert project.is_step_done("meta_analysis") is True
    assert project.is_step_done("grade") is True
    assert project.is_step_done("figures") is True
    assert figure_langs == ["zh", "zh", "zh"]
    assert project.load_json("meta_results.json", subdir="analysis")["primary_outcome"]["pooled_effect"] == 0.7
    assert captured_write["report_state"].report_type == "meta"
    assert captured_write["report_state"].n_meta_eligible == 2
    assert captured_write["evidence_classes"] == captured_write["report_state"].evidence_classes
    assert project.load_json("evidence_gate_result.json", subdir="analysis")["decision"] == "meta"
    assert project.load_json("report_state.json", subdir="analysis")["report_type"] == "meta"


def test_primary_effect_selection_keeps_audit_id_aligned_with_effect_id_for_pmid_stubs() -> None:
    project = _project_under_output()
    protocol = ResearchProtocol(
        research_question="Drug versus usual care for mortality in adults",
        pico=PICO(
            population="adults",
            intervention="drug",
            comparator="usual care",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="RR",
    )
    studies = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="benchmark_source:dexa_covid_19",
                pmid="32799933",
                title="DEXA-COVID 19",
                authors=["DEXA-COVID"],
                source_type="benchmark_source_review",
            ),
            outcomes=[
                OutcomeData(
                    outcome_name="28-day all-cause mortality",
                    outcome_type="dichotomous",
                    events_intervention=2,
                    total_intervention=7,
                    events_control=2,
                    total_control=12,
                    source_location="Primary report Table 2",
                    source_quote="Deaths were 2/7 vs 2/12.",
                    source_quote_verified=True,
                    extraction_confidence="high",
                    accepted_timepoint="28-day all-cause mortality",
                    manual_adjudication=True,
                    user_override_applied=True,
                )
            ],
        )
    ]

    effects, audit = _compute_primary_effect_selection(
        project,
        protocol,
        studies,
        main_module.logger,
        rob_results=[StudyRoB(study_id="32799933", tool_used="RoB 2", overall_judgment="Low risk")],
    )

    assert effects[0].study_id == "32799933"
    assert audit[0]["study_id"] == "32799933"
    assert audit[0]["in_final_primary_analysis"] is True
    assert audit[0]["accepted_timepoint"] == "28-day all-cause mortality"
    assert audit[0]["manual_adjudication"] is True
    assert audit[0]["user_override_applied"] is True
