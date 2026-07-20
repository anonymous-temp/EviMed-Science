from pathlib import Path

import pytest

from new_meta.core.project import Project
from new_meta.core.run_mode import (
    RunMode,
    configure_project_run_mode,
    load_benchmark_reference_manifest,
    project_run_mode,
)
from new_meta.main import _augment_with_known_source_recovery
from new_meta.schemas.protocol import PICO, ResearchProtocol


def _covid_protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Do systemic corticosteroids reduce mortality in critical COVID-19?",
        pico=PICO(
            population="critically ill adults with COVID-19",
            intervention="systemic corticosteroids",
            comparator="usual care or placebo",
            outcome_primary="28-day all-cause mortality",
        ),
        effect_measure="RR",
        model_preference="random",
        tau_estimator="REML",
    )


def test_project_defaults_to_review_and_ignores_stale_benchmark_manifest(tmp_path: Path) -> None:
    project = Project("safe review", output_dir=tmp_path / "project")
    project.save_json(
        "known_source_reference_set.json",
        {"source_id": "stale-benchmark"},
        subdir="extraction",
    )

    assert project_run_mode(project) is RunMode.REVIEW
    assert load_benchmark_reference_manifest(project) is None


def test_project_mode_is_persisted_and_cannot_silently_change(tmp_path: Path) -> None:
    project = Project("locked benchmark", output_dir=tmp_path / "project")

    assert configure_project_run_mode(project, RunMode.BENCHMARK) is RunMode.BENCHMARK
    assert project_run_mode(project) is RunMode.BENCHMARK
    with pytest.raises(ValueError, match="cannot be changed"):
        configure_project_run_mode(project, RunMode.REVIEW)


def test_known_source_recovery_is_impossible_in_review_mode(tmp_path: Path) -> None:
    project = Project("ordinary review", output_dir=tmp_path / "project")
    protocol = _covid_protocol()

    studies = _augment_with_known_source_recovery(
        protocol,
        [],
        project,
        run_mode=RunMode.REVIEW,
    )

    assert studies == []
    assert protocol.effect_measure == "RR"
    assert protocol.model_preference == "random"
    assert not project.get_path("known_source_recovery.json", subdir="extraction").exists()
    assert not project.get_path("known_source_protocol_preferences.json", subdir="extraction").exists()


def test_known_source_recovery_requires_explicit_benchmark_mode(tmp_path: Path) -> None:
    project = Project("benchmark reproduction", output_dir=tmp_path / "project")
    configure_project_run_mode(project, RunMode.BENCHMARK)
    protocol = _covid_protocol()

    studies = _augment_with_known_source_recovery(
        protocol,
        [],
        project,
        run_mode=RunMode.BENCHMARK,
    )

    assert len(studies) == 7
    assert protocol.effect_measure == "OR"
    assert protocol.model_preference == "fixed"
    assert load_benchmark_reference_manifest(project)["source_id"]

