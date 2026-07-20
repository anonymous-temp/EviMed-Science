from pathlib import Path

import start
from start import _run_phase1_inner
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol


def test_web_phase1_persists_canonical_project_for_resume(tmp_path: Path, monkeypatch) -> None:
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

    monkeypatch.setattr(
        "new_meta.agents.research_planner.ResearchPlanner.run",
        lambda self, topic: protocol,
    )
    monkeypatch.setattr(
        "new_meta.agents.query_builder.QueryBuilder.run",
        lambda self, protocol: '"Treatment"[tiab] AND mortality[tiab]',
    )
    monkeypatch.setattr(
        "new_meta.agents.paper_retriever.PaperRetriever.search_and_fetch",
        lambda self, query, project, date_range=None: [
            {
                "pmid": "1",
                "title": "Treatment trial",
                "abstract": "Randomized mortality trial.",
                "authors": [],
                "year": 2024,
            }
        ],
    )
    monkeypatch.setattr(
        "new_meta.agents.screening_agent.ScreeningAgent.screen_title_abstract",
        lambda self, papers, protocol, project: (papers, []),
    )

    state = _run_phase1_inner(
        "Treatment for mortality",
        str(tmp_path),
        lambda kind, payload: None,
    )

    project_dir = Path(state["project_dir"])
    resumed = Project("resume check", resume_dir=project_dir)

    assert project_dir.exists()
    assert resumed.base_dir == project_dir
    assert (project_dir / "protocol.json").exists()
    assert (project_dir / "analysis" / "method_plan.json").exists()
    method_plan = resumed.load_json("method_plan.json", subdir="analysis")
    assert method_plan["family"] == "intervention_rct"
    assert method_plan["plan_fingerprint"]
    assert (project_dir / "search_query.txt").exists()
    assert (project_dir / "ta_included.json").exists()
    assert resumed.get_completed_steps() == ["protocol", "search_query", "search", "ta_screening"]


def test_web_pipeline_entrypoints_do_not_create_skip_disk_projects() -> None:
    start_source = Path("start.py").read_text(encoding="utf-8")

    assert "Project(topic, output_dir=Path(output_dir), skip_disk=True)" not in start_source


def test_one_shot_web_pipeline_delegates_to_canonical_phase_runners(monkeypatch, tmp_path: Path) -> None:
    calls: list[tuple[str, object]] = []

    def fake_phase1(topic, output_dir, push):
        calls.append(("phase1", topic))
        push("progress", (0, "PICO"))
        return {
            "topic": topic,
            "project_dir": str(tmp_path / "project"),
            "ta_included": [],
            "protocol": object(),
            "search_query": "query",
            "ctx": {"phase1": True},
        }

    def fake_phase2(phase1_state, output_dir, push, user_pdf_paths):
        calls.append(("phase2", list(user_pdf_paths)))
        assert phase1_state["topic"] == "Treatment for mortality"
        assert phase1_state["ctx"]["phase1"] is True
        push("done", "delegated manuscript")
        return "delegated manuscript"

    def fail_if_legacy_pipeline_runs(self, topic):
        raise AssertionError("one-shot web pipeline should delegate to phase runners")

    monkeypatch.setattr(start, "_run_phase1_inner", fake_phase1)
    monkeypatch.setattr(start, "_run_phase2_inner", fake_phase2)
    monkeypatch.setattr(
        "new_meta.agents.research_planner.ResearchPlanner.run",
        fail_if_legacy_pipeline_runs,
    )

    pushes: list[tuple[str, object]] = []
    result = start._run_pipeline_inner(
        "Treatment for mortality",
        str(tmp_path),
        lambda kind, payload: pushes.append((kind, payload)),
        user_pdf_paths=["a.pdf"],
    )

    assert result == "delegated manuscript"
    assert calls == [("phase1", "Treatment for mortality"), ("phase2", ["a.pdf"])]
    assert pushes[-1] == ("done", "delegated manuscript")
