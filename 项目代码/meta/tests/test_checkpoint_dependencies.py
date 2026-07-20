from uuid import uuid4
from types import SimpleNamespace
from pathlib import Path
import json
import sys

import pytest

import new_meta.main as main_module
from new_meta.core.project import PIPELINE_STEPS, Project
from new_meta.core.release_contract import ReleaseBlockedError
from new_meta.main import (
    _can_rerun_manuscript_only,
    _can_resume_direct_to_manuscript,
    _can_resume_from_cached_effect_sizes,
    _can_resume_from_cached_meta_analysis,
    _load_parsed_papers_cache,
    _load_figures_b64,
    _parse_fulltext_source,
    _resume_direct_to_manuscript,
    _resume_from_cached_effect_sizes,
    _resume_from_cached_meta_analysis,
    _run_meta_analysis_from_effects,
    _save_parsed_papers_cache,
    meta_engine,
    visualization,
    influence_engine,
)
from new_meta.agents.writing_agent import WritingAgent
from new_meta.agents.grade_agent import GRADEAgent
from new_meta.schemas.grade import GRADEOutcome, GRADEProfile
from new_meta.core.evidence_gate import GateDecision, GateResult
from new_meta.schemas.meta_result import MetaAnalysisResults, PooledEffect, StudyEffect
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.study import ExtractedStudy, StudyCharacteristics


def _fake_plot_write(*args, **kwargs) -> None:
    raw_path = kwargs.get("save_path")
    if raw_path is None:
        for arg in reversed(args[1:]):
            candidate = Path(str(arg))
            if candidate.suffix.lower() in {".png", ".jpg", ".jpeg", ".pdf", ".svg", ".webp"}:
                raw_path = arg
                break
    if raw_path is None:
        return
    path = Path(str(raw_path))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("figure", encoding="utf-8")


def test_clear_downstream_removes_all_protocol_dependents(tmp_path) -> None:
    project = Project("checkpoint dag", output_dir=tmp_path / uuid4().hex)
    for step in PIPELINE_STEPS:
        project.save_checkpoint(step)

    cleared = project.clear_downstream("protocol")

    assert cleared == PIPELINE_STEPS[1:]
    assert project.is_step_done("protocol") is True
    assert project.get_completed_steps() == ["protocol"]


def test_clear_downstream_can_include_starting_step(tmp_path) -> None:
    project = Project("checkpoint dag", output_dir=tmp_path / uuid4().hex)
    for step in ["search", "ta_screening", "extraction", "manuscript"]:
        project.save_checkpoint(step)

    cleared = project.clear_downstream("search", include_self=True)

    assert cleared == ["search", "ta_screening", "extraction", "manuscript"]
    assert project.get_completed_steps() == []


def test_clear_downstream_rejects_unknown_step(tmp_path) -> None:
    project = Project("checkpoint dag", output_dir=tmp_path / uuid4().hex)

    with pytest.raises(ValueError, match="Unknown pipeline step"):
        project.clear_downstream("not-a-step")


def test_evidence_gate_report_state_reconciles_meta_ids_with_final_effect_sizes(monkeypatch, tmp_path) -> None:
    project = Project("gate final effects", output_dir=tmp_path / uuid4().hex)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    extracted = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id=study_id,
                pmid=study_id,
                title=f"Trial {study_id}",
                authors=[f"{study_id} Author"],
                year=2020,
                total_sample_size=100,
            )
        )
        for study_id in ("A", "B", "C")
    ]
    project.save_json(
        "effect_sizes.json",
        [
            StudyEffect(study_id="C", study_label="Trial C", yi=-0.2, vi=0.04, se=0.2).model_dump(),
            StudyEffect(study_id="B", study_label="Trial B", yi=-0.1, vi=0.05, se=0.22).model_dump(),
        ],
        subdir="analysis",
    )

    class FakeGate:
        def __init__(self, gate_protocol):
            self.protocol = gate_protocol

        def evaluate(self, studies):
            return GateResult(
                decision=GateDecision.META,
                reasons=[],
                meta_eligible_studies=["A", "B"],
                evidence_classes={
                    "A": "direct_eligible_rct",
                    "B": "direct_eligible_rct",
                    "C": "direct_eligible_rct",
                },
                evidence_tiers={
                    "A": "direct_eligible_study",
                    "B": "direct_eligible_study",
                    "C": "analyzable_primary_outcome",
                },
                outcome_tiers={
                    "A": "outcome_extractable",
                    "B": "outcome_extractable",
                    "C": "outcome_reported_but_not_extractable",
                },
                prisma_counts={"direct_eligible": 2, "analyzable_primary_outcome": 3, "meta_eligible": 2},
                summary="ready",
            )

    monkeypatch.setattr(main_module, "EvidenceGate", FakeGate, raising=False)

    gate_result, report_state = main_module._evaluate_evidence_gate_for_report(
        project,
        protocol,
        extracted,
        {},
    )

    assert gate_result.meta_eligible_studies == ["C", "B"]
    assert gate_result.evidence_tiers["A"] == "analyzable_primary_outcome"
    assert gate_result.evidence_tiers["C"] == "direct_eligible_study"
    assert gate_result.outcome_tiers["C"] == "outcome_extractable"
    assert report_state.meta_eligible_ids == ["C", "B"]
    assert report_state.direct_eligible_ids == ["B", "C"]
    assert report_state.n_meta_eligible == 2
    assert project.load_json("evidence_gate_result.json", subdir="analysis")["meta_eligible_studies"] == ["C", "B"]


def test_advisory_failure_is_user_visible_and_persisted(tmp_path) -> None:
    project = Project("advisory warning", output_dir=tmp_path / uuid4().hex)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )

    class BrokenPlanner:
        def get_advice(self, stage, count, protocol):
            raise RuntimeError("quota exhausted")

    advice = main_module._get_advisory(
        BrokenPlanner(),
        "search",
        0,
        protocol,
        project=project,
    )

    assert "LLM advisory failed" in advice
    assert "quota exhausted" in advice
    warnings = json.loads((project.base_dir / "pipeline_warnings.json").read_text(encoding="utf-8"))
    assert warnings[-1]["code"] == "advisory_llm_failed"
    assert warnings[-1]["severity"] == "error"
    assert warnings[-1]["context"]["stage"] == "search"
    assert warnings[-1]["context"]["count"] == 0
    assert warnings[-1]["context"]["exception_type"] == "RuntimeError"


def test_require_full_text_sources_blocks_abstract_only_path(tmp_path) -> None:
    project = Project("no full text", output_dir=tmp_path / uuid4().hex)

    with pytest.raises(RuntimeError, match="Full text sources are required"):
        main_module._require_full_text_sources(
            project=project,
            papers_with_full_text=[],
            extra_user_papers=[],
            screened_papers=[{"pmid": "1", "title": "Abstract only"}],
        )

    warnings = json.loads((project.base_dir / "pipeline_warnings.json").read_text(encoding="utf-8"))
    assert warnings[-1]["code"] == "no_full_text_sources"
    assert warnings[-1]["severity"] == "error"
    assert warnings[-1]["context"]["screened_records"] == 1


def test_require_full_text_sources_rejects_abstract_file_misclassified_as_fulltext(
    tmp_path,
) -> None:
    project = Project("abstract file is not full text", output_dir=tmp_path / uuid4().hex)
    abstract_record = {
        "pmid": "1",
        "title": "Structured abstract",
        "fulltext_path": "/tmp/1.abstract.txt",
        "fulltext_source": "europe_pmc_abstract",
        "text_availability": "abstract_only",
    }

    with pytest.raises(RuntimeError, match="Full text sources are required"):
        main_module._require_full_text_sources(
            project=project,
            papers_with_full_text=[abstract_record],
            extra_user_papers=[],
            screened_papers=[abstract_record],
        )


def test_fulltext_partition_excludes_abstract_and_metadata_records() -> None:
    fulltext = {
        "pmid": "full",
        "fulltext_path": "/tmp/full.fulltext.txt",
        "text_availability": "full_text",
    }
    abstract = {
        "pmid": "abstract",
        "fulltext_path": "/tmp/abstract.abstract.txt",
        "text_availability": "abstract_only",
    }
    metadata = {"pmid": "metadata", "text_availability": "metadata_only"}

    usable, unavailable = main_module._partition_full_text_sources(
        [fulltext, abstract, metadata]
    )

    assert usable == [fulltext]
    assert unavailable == [abstract, metadata]


def test_require_full_text_sources_allows_user_or_retrieved_full_text(tmp_path) -> None:
    project = Project("has full text", output_dir=tmp_path / uuid4().hex)

    main_module._require_full_text_sources(
        project=project,
        papers_with_full_text=[{"pmid": "1", "pdf_path": "/tmp/a.pdf"}],
        extra_user_papers=[],
        screened_papers=[],
    )
    main_module._require_full_text_sources(
        project=project,
        papers_with_full_text=[],
        extra_user_papers=[{"pmid": "user_pdf_1", "full_text": "text"}],
        screened_papers=[],
    )


def test_narrative_mode_does_not_fall_back_to_abstract_only_screening_records() -> None:
    ta_only_record = {
        "pmid": "abstract-1",
        "title": "Potentially relevant abstract",
        "text_availability": "abstract_only",
    }
    full_text_record = {
        "pmid": "fulltext-1",
        "title": "Retrieved full text",
        "fulltext_path": "/tmp/fulltext.html",
    }

    selected = main_module._select_narrative_extraction_papers(
        included_papers=[],
        papers_for_ft_screening=[full_text_record],
        ta_included_papers=[ta_only_record, full_text_record],
    )

    assert selected == []
    assert ta_only_record not in selected


def test_narrative_mode_keeps_single_included_full_text_for_evidence_gap_report() -> None:
    included = {
        "pmid": "fulltext-1",
        "title": "One included full-text study",
        "pdf_path": "/tmp/trial.pdf",
    }

    selected = main_module._select_narrative_extraction_papers(
        included_papers=[included],
        papers_for_ft_screening=[included],
        ta_included_papers=[{"pmid": "abstract-1", "text_availability": "abstract_only"}],
    )

    assert selected == [included]


def test_project_rejects_existing_project_root_as_output_dir(tmp_path) -> None:
    existing = tmp_path / "existing_project"
    project = Project("existing project", output_dir=existing)
    project.save_json("protocol.json", {"research_question": "Question"})
    project.save_text("draft.md", "# Manuscript", subdir="manuscript")

    with pytest.raises(ValueError, match="resume_dir"):
        Project("refresh package", output_dir=project.base_dir)

    resumed = Project("refresh package", resume_dir=project.base_dir)
    assert resumed.base_dir == project.base_dir


def test_direct_manuscript_resume_uses_cached_analysis(monkeypatch, tmp_path) -> None:
    project = Project("cached manuscript resume", output_dir=tmp_path / uuid4().hex)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    meta_results = MetaAnalysisResults(
        primary_outcome=PooledEffect(
            outcome_name="mortality",
            n_studies=2,
            effect_measure="RR",
            pooled_effect=0.8,
            ci_lower=0.6,
            ci_upper=1.0,
            p_value=0.05,
            studies=[
                StudyEffect(study_id="S1", study_label="Smith 2020", yi=-0.2, vi=0.04, se=0.2),
                StudyEffect(study_id="S2", study_label="Jones 2021", yi=-0.1, vi=0.05, se=0.22),
            ],
        )
    )
    extracted = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            title="Trial one",
            authors=["Smith John"],
            year=2020,
        )
    )
    project.save_json("protocol.json", protocol)
    project.save_text("search_query.txt", "mortality AND treatment")
    project.save_json("all_extractions.json", [extracted], subdir="extraction")
    project.save_json("rob_results.json", [StudyRoB(study_id="S1", tool_used="RoB 2")], subdir="risk_of_bias")
    project.save_json("meta_results.json", meta_results, subdir="analysis")
    project.save_json(
        "full_text_screening.json",
        [{"decision": "include", "paper": {"pmid": "S1", "title": "Trial one", "authors": ["Smith John"], "year": 2020}}],
        subdir="screening",
    )
    figures_dir = project.base_dir / "figures"
    figures_dir.mkdir(exist_ok=True)
    (figures_dir / "prisma_diagram.png").write_bytes(b"prisma")
    (figures_dir / "forest_plot.png").write_bytes(b"forest")
    for step in [
        "protocol", "search_query", "extraction", "rob", "effect_sizes",
        "meta_analysis", "grade", "figures",
    ]:
        project.save_checkpoint(step)

    captured = {}

    def fake_run(self, **kwargs):
        captured["n_studies"] = kwargs["meta_results"].primary_outcome.n_studies
        captured["n_extractions"] = len(kwargs["extracted_studies"])
        captured["figure_keys"] = sorted(kwargs["figures_b64"])
        kwargs["project"].save_text("draft.md", "cached manuscript", subdir="manuscript")
        return "cached manuscript"

    monkeypatch.setattr(WritingAgent, "run", fake_run)
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)

    assert _can_resume_direct_to_manuscript(project) is True
    with pytest.raises(ReleaseBlockedError):
        _resume_direct_to_manuscript(
            project,
            SimpleNamespace(topic="Does treatment reduce mortality?", analysis_type=None),
            model=None,
        )

    assert captured == {
        "n_studies": 2,
        "n_extractions": 1,
        "figure_keys": ["forest_plot", "prisma_diagram"],
    }
    assert project.is_step_done("manuscript") is True
    assert (project.base_dir / "manuscript" / "draft.md").read_text(encoding="utf-8") == "cached manuscript"


def test_direct_manuscript_resume_passes_evidence_gate_state_to_writer(monkeypatch, tmp_path) -> None:
    project = Project("cached manuscript evidence gate", output_dir=tmp_path / uuid4().hex)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
        date_range="2019-2024",
    )
    meta_results = MetaAnalysisResults(
        primary_outcome=PooledEffect(
            outcome_name="mortality",
            n_studies=2,
            effect_measure="RR",
            pooled_effect=0.8,
            ci_lower=0.6,
            ci_upper=1.0,
            p_value=0.05,
            studies=[
                StudyEffect(study_id="S1", study_label="Smith 2020", yi=-0.2, vi=0.04, se=0.2),
                StudyEffect(study_id="S2", study_label="Jones 2021", yi=-0.1, vi=0.05, se=0.22),
            ],
        )
    )
    extracted = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="S1",
            title="Trial one",
            authors=["Smith John"],
            year=2020,
            total_sample_size=120,
        )
    )
    project.prisma.records_identified = 5
    project.prisma.records_after_dedup = 4
    project.prisma.full_text_assessed = 2
    project.prisma.studies_included = 1
    project.save_json("protocol.json", protocol)
    project.save_text("search_query.txt", "mortality AND treatment")
    project.save_json("all_extractions.json", [extracted], subdir="extraction")
    project.save_json("rob_results.json", [StudyRoB(study_id="S1", tool_used="RoB 2")], subdir="risk_of_bias")
    project.save_json("meta_results.json", meta_results, subdir="analysis")
    project.save_json(
        "full_text_screening.json",
        [{"decision": "include", "paper": {"pmid": "S1", "title": "Trial one", "authors": ["Smith John"], "year": 2020}}],
        subdir="screening",
    )
    figures_dir = project.base_dir / "figures"
    figures_dir.mkdir(exist_ok=True)
    (figures_dir / "prisma_diagram.png").write_bytes(b"prisma")
    (figures_dir / "forest_plot.png").write_bytes(b"forest")
    for step in [
        "protocol", "search_query", "extraction", "rob", "effect_sizes",
        "meta_analysis", "grade", "figures",
    ]:
        project.save_checkpoint(step)

    captured = {}

    class FakeGate:
        def __init__(self, gate_protocol):
            captured["gate_protocol"] = gate_protocol

        def evaluate(self, studies):
            captured["gate_study_ids"] = [s.characteristics.study_id for s in studies]
            return GateResult(
                decision=GateDecision.META,
                reasons=["eligible for meta-analysis"],
                meta_eligible_studies=["S1"],
                evidence_classes={"S1": "direct_eligible_rct"},
                evidence_tiers={"S1": "direct_eligible_study"},
                outcome_tiers={"S1": "outcome_extractable"},
                summary="ready",
            )

    def fake_run(self, **kwargs):
        captured["report_state"] = kwargs.get("report_state")
        captured["evidence_classes"] = kwargs.get("evidence_classes")
        kwargs["project"].save_text("draft.md", "cached manuscript", subdir="manuscript")
        return "cached manuscript"

    monkeypatch.setattr(main_module, "EvidenceGate", FakeGate, raising=False)
    monkeypatch.setattr(WritingAgent, "run", fake_run)
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)

    with pytest.raises(ReleaseBlockedError):
        _resume_direct_to_manuscript(
            project,
            SimpleNamespace(topic="Does treatment reduce mortality?", analysis_type=None),
            model=None,
        )

    assert captured["gate_protocol"] == protocol
    assert captured["gate_study_ids"] == ["S1"]
    assert captured["report_state"].report_type == "meta"
    assert captured["report_state"].direct_eligible_ids == ["S1"]
    assert captured["report_state"].total_sample_size == 120
    assert captured["report_state"].search_end_year == 2024
    assert captured["evidence_classes"] == {"S1": "direct_eligible_rct"}
    gate_payload = project.load_json("evidence_gate_result.json", subdir="analysis")
    assert gate_payload["decision"] == "meta"
    state_payload = project.load_json("report_state.json", subdir="analysis")
    assert state_payload["report_type"] == "meta"


def test_direct_manuscript_resume_waits_for_missing_late_checkpoints(tmp_path) -> None:
    project = Project("cached meta resume after invalidated grade", output_dir=tmp_path / uuid4().hex)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    effects = [
        StudyEffect(study_id="S1", study_label="Smith 2020", yi=-0.2, vi=0.04, se=0.2),
        StudyEffect(study_id="S2", study_label="Jones 2021", yi=-0.1, vi=0.05, se=0.22),
    ]
    meta_results = MetaAnalysisResults(
        primary_outcome=PooledEffect(
            outcome_name="mortality",
            n_studies=2,
            effect_measure="RR",
            pooled_effect=0.8,
            ci_lower=0.6,
            ci_upper=1.0,
            p_value=0.05,
            studies=effects,
        )
    )
    project.save_json("protocol.json", protocol)
    project.save_text("search_query.txt", "mortality AND treatment")
    project.save_json("all_extractions.json", [], subdir="extraction")
    project.save_json("rob_results.json", [], subdir="risk_of_bias")
    project.save_json("effect_sizes.json", [effect.model_dump() for effect in effects], subdir="analysis")
    project.save_json("meta_results.json", meta_results, subdir="analysis")
    project.save_json("grade_profile.json", GRADEProfile(outcomes=[]), subdir="analysis")
    figures_dir = project.base_dir / "figures"
    figures_dir.mkdir(exist_ok=True)
    (figures_dir / "forest_plot.png").write_text("stale figure", encoding="utf-8")
    for step in ["protocol", "search_query", "extraction", "rob", "effect_sizes", "meta_analysis"]:
        project.save_checkpoint(step)

    assert _can_resume_direct_to_manuscript(project) is False
    assert _can_resume_from_cached_meta_analysis(project) is True


def test_load_figures_b64_uses_writing_agent_keys(tmp_path) -> None:
    project = Project("figure b64", output_dir=tmp_path / uuid4().hex)
    figures_dir = project.base_dir / "figures"
    figures_dir.mkdir(exist_ok=True)
    (figures_dir / "prisma_diagram.png").write_bytes(b"prisma")
    (figures_dir / "forest_plot.png").write_bytes(b"forest")
    (figures_dir / "rob_summary.png").write_bytes(b"rob")
    (figures_dir / "empty.png").write_bytes(b"")

    figures_b64 = _load_figures_b64(project)

    assert sorted(figures_b64) == ["forest_plot", "prisma_diagram", "rob_plot"]
    assert figures_b64["forest_plot"].startswith("data:image/png;base64,")


def test_can_rerun_manuscript_only_even_when_checkpoint_is_complete(monkeypatch, tmp_path) -> None:
    project = Project("rerun manuscript", output_dir=tmp_path / uuid4().hex)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    project.save_json("protocol.json", protocol)
    project.save_text("search_query.txt", "mortality AND treatment")
    project.save_json("all_extractions.json", [], subdir="extraction")
    project.save_json("rob_results.json", [], subdir="risk_of_bias")
    project.save_json(
        "meta_results.json",
        MetaAnalysisResults(
            primary_outcome=PooledEffect(
                outcome_name="mortality",
                n_studies=2,
                effect_measure="RR",
                pooled_effect=0.8,
                ci_lower=0.6,
                ci_upper=1.0,
                p_value=0.05,
                studies=[],
            )
        ),
        subdir="analysis",
    )
    for step in ["protocol", "search_query", "extraction", "rob", "effect_sizes", "meta_analysis", "grade", "figures", "manuscript"]:
        project.save_checkpoint(step)

    assert _can_resume_direct_to_manuscript(project) is False
    assert _can_rerun_manuscript_only(project) is True


def test_main_allows_rerun_manuscript_only_without_llm_key(monkeypatch, tmp_path) -> None:
    project = Project("rerun manuscript cli", output_dir=tmp_path / uuid4().hex)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    project.save_json("protocol.json", protocol)
    project.save_text("search_query.txt", "mortality AND treatment")
    project.save_json("all_extractions.json", [], subdir="extraction")
    project.save_json("rob_results.json", [], subdir="risk_of_bias")
    project.save_json(
        "meta_results.json",
        MetaAnalysisResults(
            primary_outcome=PooledEffect(
                outcome_name="mortality",
                n_studies=2,
                effect_measure="RR",
                pooled_effect=0.8,
                ci_lower=0.6,
                ci_upper=1.0,
                p_value=0.05,
                studies=[],
            )
        ),
        subdir="analysis",
    )
    for step in ["protocol", "search_query", "extraction", "rob", "effect_sizes", "meta_analysis", "grade", "figures", "manuscript"]:
        project.save_checkpoint(step)

    called = {}

    monkeypatch.setattr("new_meta.config.LLM_API_KEY", "")
    monkeypatch.setattr(
        main_module,
        "_resume_direct_to_manuscript",
        lambda project_arg, args, model: called.setdefault("project", str(project_arg.base_dir)),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "new_meta.main",
            "--topic",
            "Does treatment reduce mortality?",
            "--resume",
            str(project.base_dir),
            "--rerun-manuscript-only",
        ],
    )

    main_module.main()

    assert called["project"] == str(project.base_dir)


def test_can_rerun_manuscript_only_uses_cached_files_even_if_checkpoint_is_missing(tmp_path) -> None:
    project = Project("rerun manuscript file-based", output_dir=tmp_path / uuid4().hex)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    project.save_json("protocol.json", protocol)
    project.save_text("search_query.txt", "mortality AND treatment")
    project.save_json("all_extractions.json", [], subdir="extraction")
    project.save_json("rob_results.json", [], subdir="risk_of_bias")
    project.save_json(
        "meta_results.json",
        MetaAnalysisResults(
            primary_outcome=PooledEffect(
                outcome_name="mortality",
                n_studies=2,
                effect_measure="RR",
                pooled_effect=0.8,
                ci_lower=0.6,
                ci_upper=1.0,
                p_value=0.05,
                studies=[],
            )
        ),
        subdir="analysis",
    )
    for step in ["protocol", "search_query", "extraction", "effect_sizes", "meta_analysis", "grade", "figures", "manuscript"]:
        project.save_checkpoint(step)

    assert project.is_step_done("rob") is False
    assert _can_rerun_manuscript_only(project) is True


def test_cached_meta_resume_skips_pooling_and_runs_missing_late_steps(monkeypatch, tmp_path) -> None:
    project = Project("cached meta resume", output_dir=tmp_path / uuid4().hex)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    effects = [
        StudyEffect(study_id="S1", study_label="Smith 2020", yi=-0.2, vi=0.04, se=0.2),
        StudyEffect(study_id="S2", study_label="Jones 2021", yi=-0.1, vi=0.05, se=0.22),
    ]
    meta_results = MetaAnalysisResults(
        primary_outcome=PooledEffect(
            outcome_name="mortality",
            n_studies=2,
            effect_measure="RR",
            pooled_effect=0.8,
            ci_lower=0.6,
            ci_upper=1.0,
            p_value=0.05,
            studies=effects,
        )
    )
    extracted = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S1",
                title="Trial one",
                authors=["Smith John"],
                year=2020,
            )
        )
    ]
    project.save_json("protocol.json", protocol)
    project.save_text("search_query.txt", "mortality AND treatment")
    project.save_json("all_extractions.json", extracted, subdir="extraction")
    project.save_json("rob_results.json", [StudyRoB(study_id="S1", tool_used="RoB 2")], subdir="risk_of_bias")
    project.save_json("effect_sizes.json", [effect.model_dump() for effect in effects], subdir="analysis")
    project.save_json("meta_results.json", meta_results, subdir="analysis")
    project.save_json(
        "full_text_screening.json",
        [{"decision": "include", "paper": {"pmid": "S1", "title": "Trial one", "authors": ["Smith John"], "year": 2020}}],
        subdir="screening",
    )
    for step in ["protocol", "search_query", "extraction", "rob", "effect_sizes", "meta_analysis"]:
        project.save_checkpoint(step)

    def fail_pooling(*args, **kwargs):  # pragma: no cover - should not be called
        raise AssertionError("cached meta resume must not recompute pooled effects")

    monkeypatch.setattr(meta_engine, "random_effects_dl", fail_pooling)

    grade_calls = {"n": 0}

    def fake_grade_run(self, **kwargs):
        grade_calls["n"] += 1
        return GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="mortality",
                n_studies=2,
                effect_summary="RR 0.80 (95% CI 0.60 to 1.00)",
                certainty="Low",
            )
        ])

    monkeypatch.setattr(GRADEAgent, "run", fake_grade_run)

    for name in [
        "forest_plot",
        "funnel_plot",
        "contour_funnel_plot",
        "prisma_flow_diagram",
        "galbraith_plot",
        "sensitivity_plot",
        "cumulative_forest_plot",
    ]:
        monkeypatch.setattr(visualization, name, _fake_plot_write)
    monkeypatch.setattr(influence_engine, "influence_diagnostics", lambda *args, **kwargs: [])
    monkeypatch.setattr(influence_engine, "p_curve_analysis", lambda *args, **kwargs: None)

    captured = {}

    def fake_write(self, **kwargs):
        captured["pooled"] = kwargs["meta_results"].primary_outcome.pooled_effect
        captured["grade_outcomes"] = len(kwargs["grade_profile"].outcomes)
        kwargs["project"].save_text("draft.md", "late cached manuscript", subdir="manuscript")
        return "late cached manuscript"

    monkeypatch.setattr(WritingAgent, "run", fake_write)
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)

    assert _can_resume_from_cached_meta_analysis(project) is True
    with pytest.raises(ReleaseBlockedError):
        _resume_from_cached_meta_analysis(
            project,
            SimpleNamespace(topic="Does treatment reduce mortality?", analysis_type=None),
            model=None,
        )

    assert grade_calls["n"] == 1
    assert captured == {"pooled": 0.8, "grade_outcomes": 1}
    assert project.is_step_done("grade") is True
    assert project.is_step_done("figures") is True
    assert project.is_step_done("manuscript") is True
    assert (project.base_dir / "figures" / "forest_plot.png").exists()


def test_cached_effect_size_resume_skips_effect_recomputation(monkeypatch, tmp_path) -> None:
    project = Project("cached effect resume", output_dir=tmp_path / uuid4().hex)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    effects = [
        StudyEffect(study_id="S1", study_label="Smith 2020", yi=-0.2, vi=0.04, se=0.2),
        StudyEffect(study_id="S2", study_label="Jones 2021", yi=-0.1, vi=0.05, se=0.22),
    ]
    extracted = [
        ExtractedStudy(
            characteristics=StudyCharacteristics(
                study_id="S1",
                title="Trial one",
                authors=["Smith John"],
                year=2020,
            )
        )
    ]
    project.save_json("protocol.json", protocol)
    project.save_text("search_query.txt", "mortality AND treatment")
    project.save_json("all_extractions.json", extracted, subdir="extraction")
    project.save_json("rob_results.json", [StudyRoB(study_id="S1", tool_used="RoB 2")], subdir="risk_of_bias")
    project.save_json("effect_sizes.json", [effect.model_dump() for effect in effects], subdir="analysis")
    project.save_json(
        "full_text_screening.json",
        [{"decision": "include", "paper": {"pmid": "S1", "title": "Trial one", "authors": ["Smith John"], "year": 2020}}],
        subdir="screening",
    )
    for step in ["protocol", "search_query", "extraction", "rob", "effect_sizes"]:
        project.save_checkpoint(step)

    def fail_effect_computation(*args, **kwargs):  # pragma: no cover - should not be called
        raise AssertionError("cached effect-size resume must not recompute extraction-derived effects")

    monkeypatch.setattr(main_module, "_compute_study_effect", fail_effect_computation)

    def fake_grade_run(self, **kwargs):
        return GRADEProfile(outcomes=[
            GRADEOutcome(
                outcome_name="mortality",
                n_studies=2,
                effect_summary="RR 0.86 (95% CI 0.56 to 1.30)",
                certainty="Low",
            )
        ])

    monkeypatch.setattr(GRADEAgent, "run", fake_grade_run)

    for name in [
        "forest_plot",
        "funnel_plot",
        "contour_funnel_plot",
        "prisma_flow_diagram",
        "galbraith_plot",
        "sensitivity_plot",
        "cumulative_forest_plot",
    ]:
        monkeypatch.setattr(visualization, name, _fake_plot_write)
    monkeypatch.setattr(influence_engine, "influence_diagnostics", lambda *args, **kwargs: [])
    monkeypatch.setattr(influence_engine, "p_curve_analysis", lambda *args, **kwargs: None)

    captured = {}

    def fake_write(self, **kwargs):
        captured["n_studies"] = kwargs["meta_results"].primary_outcome.n_studies
        captured["grade_outcomes"] = len(kwargs["grade_profile"].outcomes)
        kwargs["project"].save_text("draft.md", "effect cached manuscript", subdir="manuscript")
        return "effect cached manuscript"

    monkeypatch.setattr(WritingAgent, "run", fake_write)
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)

    assert _can_resume_from_cached_effect_sizes(project) is True
    with pytest.raises(ReleaseBlockedError):
        _resume_from_cached_effect_sizes(
            project,
            SimpleNamespace(topic="Does treatment reduce mortality?", analysis_type=None),
            model=None,
        )

    assert captured == {"n_studies": 2, "grade_outcomes": 1}
    assert project.is_step_done("meta_analysis") is True
    assert project.is_step_done("grade") is True
    assert project.is_step_done("figures") is True
    assert project.is_step_done("manuscript") is True
    assert project.load_json("meta_results.json", subdir="analysis")["primary_outcome"]["n_studies"] == 2


def test_run_meta_analysis_from_effects_persists_result_and_checkpoint(tmp_path) -> None:
    project = Project("shared meta helper", output_dir=tmp_path / uuid4().hex)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="mortality",
        ),
        effect_measure="RR",
    )
    effects = [
        StudyEffect(study_id="S1", study_label="Smith 2020", yi=-0.2, vi=0.04, se=0.2),
        StudyEffect(study_id="S2", study_label="Jones 2021", yi=-0.1, vi=0.05, se=0.22),
    ]

    result = _run_meta_analysis_from_effects(
        project,
        protocol=protocol,
        extracted_studies=[],
        study_effects=effects,
    )

    saved = project.load_json("meta_results.json", subdir="analysis")
    assert result.primary_outcome.n_studies == 2
    assert saved["primary_outcome"]["n_studies"] == 2
    assert project.is_step_done("meta_analysis") is True


def test_pdf_parsing_cache_round_trips_without_reparse(tmp_path) -> None:
    project = Project("parsed cache", output_dir=tmp_path / uuid4().hex)
    parsed = {
        "S1": {
            "text": "full text",
            "tables": [{"page": 2, "rows": [["a", "b"]]}],
            "page_map": [{"page": 1, "text": "full text"}],
        }
    }

    _save_parsed_papers_cache(project, parsed)

    assert _load_parsed_papers_cache(project) == parsed


def test_downloaded_fulltext_parser_uses_content_hash_cache(monkeypatch, tmp_path) -> None:
    project = Project("downloaded cache", output_dir=tmp_path / uuid4().hex)
    pdf = tmp_path / "downloaded.pdf"
    pdf.write_bytes(b"%PDF downloaded content")
    calls = {"n": 0}

    def fake_parse_pdf(path: str) -> dict:
        calls["n"] += 1
        return {
            "full_text": f"downloaded text call {calls['n']}",
            "abstract": "",
            "sections": {},
            "tables": [],
            "page_map": [{"page_number": 1, "start_char": 0, "end_char": 22}],
        }

    monkeypatch.setattr("new_meta.main.parse_pdf", fake_parse_pdf)

    first, first_hit = _parse_fulltext_source(project, str(pdf), is_pdf=True)
    second, second_hit = _parse_fulltext_source(project, str(pdf), is_pdf=True)

    assert calls["n"] == 1
    assert first_hit is False
    assert second_hit is True
    assert first["full_text"] == second["full_text"]
    assert second["_parser_used"] == "pdf_parser"


def test_project_add_warning_appends_user_visible_warning(tmp_path) -> None:
    project = Project("warnings", output_dir=tmp_path / uuid4().hex)

    project.add_warning(
        "pdf_parsing",
        "Failed to parse one PDF",
        code="pdf_parse_failed",
        context={"file": "trial.pdf"},
    )
    project.add_warning("grade", "GRADE assessment failed", code="grade_failed")

    warnings = json.loads((project.base_dir / "pipeline_warnings.json").read_text(encoding="utf-8"))
    assert [item["stage"] for item in warnings] == ["pdf_parsing", "grade"]
    assert warnings[0]["code"] == "pdf_parse_failed"
    assert warnings[0]["context"] == {"file": "trial.pdf"}
