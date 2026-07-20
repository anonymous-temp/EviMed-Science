from types import SimpleNamespace

import new_meta.main as main_module
from new_meta.agents.writing_agent import WritingAgent
from new_meta.core.manuscript_facts import _detect_publication_contract_violations
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol


def test_narrative_final_replaces_pooled_effect_placeholder_without_dropping_paragraph() -> None:
    writer = WritingAgent(narrative_mode=True)
    manuscript = (
        "## Results\n\n"
        "One eligible randomized trial was included. "
        "No pooled effect was calculated: RR NR (95% CI NR to NR). "
        "The trial result is described individually.\n"
    )

    repaired = writer._enforce_narrative_final(manuscript)

    assert "One eligible randomized trial was included." in repaired
    assert "The trial result is described individually." in repaired
    assert "Quantitative synthesis was not performed" in repaired
    assert "NR (95% CI" not in repaired
    assert "pooled effect" not in repaired.lower()


def test_narrative_validation_blocked_report_does_not_create_nr_effect_claim() -> None:
    writer = WritingAgent(narrative_mode=True)
    protocol = SimpleNamespace(
        effect_measure="RR",
        pico=SimpleNamespace(outcome_primary="Postoperative delirium"),
    )

    manuscript = writer._write_validation_blocked_report(
        protocol=protocol,
        facts={
            "report_type": "narrative",
            "primary_effect": {},
            "primary_population": {},
            "evidence_readiness": {"warnings": []},
        },
        validation={
            "passed": False,
            "issues": [{"kind": "example", "severity": "error", "message": "Example failure."}],
        },
    )

    assert "Quantitative synthesis: Not performed." in manuscript
    assert "NR (95% CI" not in manuscript
    assert "Pooled effect:" not in manuscript


def test_non_meta_validation_does_not_misread_700_as_zero_participants() -> None:
    issues = _detect_publication_contract_violations(
        "One randomized trial enrolled 700 participants.",
        {"primary_effect": {}},
    )

    assert not any(issue["kind"] == "residual_zero_participants" for issue in issues)


def test_non_meta_validation_still_rejects_actual_zero_participants() -> None:
    issues = _detect_publication_contract_violations(
        "The primary synthesis included 0 participants.",
        {"primary_effect": {}},
    )

    assert any(issue["kind"] == "residual_zero_participants" for issue in issues)


def test_placeholder_cleaner_does_not_corrupt_small_real_p_value() -> None:
    writer = WritingAgent(narrative_mode=True)

    cleaned = writer._clean_placeholder_statistics("The study reported p=0.0001.")

    assert cleaned == "The study reported p=0.0001."
    assert "p<0.0011" not in cleaned


def test_narrative_study_summary_preserves_reported_effect_measure_and_operator() -> None:
    writer = WritingAgent(narrative_mode=True)
    outcome = SimpleNamespace(
        outcome_name="Postoperative delirium",
        effect_size=0.35,
        ci_lower=0.22,
        ci_upper=0.54,
        p_value=0.0001,
        reported_effect_measure="OR",
        source_quote="OR 0.35, 95% CI 0.22-0.54; p<0.0001",
        mean_intervention=None,
        sd_intervention=None,
        n_intervention=None,
        mean_control=None,
        events_intervention=32,
        total_intervention=350,
        events_control=79,
        total_control=350,
        hazard_ratio=None,
        hr_ci_lower=None,
        hr_ci_upper=None,
        events=None,
        total_n=None,
        correlation_r=None,
        correlation_n=None,
    )
    study = SimpleNamespace(
        characteristics=SimpleNamespace(authors=["Su Xian"], year=2016, total_sample_size=700),
        outcomes=[outcome],
    )

    summary = writer._build_study_results_text([study])

    assert "OR=0.35" in summary
    assert "p<0.0001" in summary


def test_publication_polish_removes_automation_self_description() -> None:
    manuscript = (
        "## Methods\n\n"
        "Records were screened using an automated systematic review platform. "
        "The same automated process verified values through automated quote extraction."
    )

    polished = WritingAgent._polish_publication_body_language(manuscript)

    assert "automated" not in polished.lower()
    assert "pipeline" not in polished.lower()


def test_cached_narrative_artifacts_allow_manuscript_only_rerun(tmp_path) -> None:
    project = Project("cached narrative", output_dir=tmp_path)
    protocol = ResearchProtocol(
        research_question="Does dexmedetomidine prevent postoperative delirium?",
        pico=PICO(
            population="Older adults undergoing noncardiac surgery",
            intervention="Intravenous dexmedetomidine",
            comparator="Placebo",
            outcome_primary="Postoperative delirium",
        ),
        effect_measure="RR",
    )
    project.save_json("protocol.json", protocol)
    project.save_text("search_query.txt", "dexmedetomidine AND postoperative delirium")
    project.save_json("all_extractions.json", [], subdir="extraction")
    project.save_json("report_state.json", {"report_type": "narrative"}, subdir="analysis")

    assert main_module._can_write_narrative_manuscript_from_cached_artifacts(project) is True
    assert main_module._can_rerun_manuscript_only(project) is True
