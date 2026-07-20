from pathlib import Path

from new_meta.agents.rob_agent import RoBAgent
from new_meta.core.project import Project
from new_meta.schemas.risk_of_bias import RoBDomain, StudyRoB
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def test_rob_agent_assesses_known_source_registry_text_matched_by_nct(
    monkeypatch,
    tmp_path: Path,
) -> None:
    agent = RoBAgent()
    prompts: list[str] = []

    def fake_structured_call(prompt, schema, max_tokens=4096):
        prompts.append(prompt)
        return StudyRoB(
            study_id="",
            tool_used="",
            domains=[
                RoBDomain(domain="Randomization process", judgment="Some concerns", support="Registry says RCT but allocation concealment is not reported."),
                RoBDomain(domain="Deviations from intended interventions", judgment="Some concerns", support="Registry source says unblinded."),
                RoBDomain(domain="Missing outcome data", judgment="High risk", support="Registry enrollment differs from the mortality source row."),
                RoBDomain(domain="Measurement of the outcome", judgment="Some concerns", support="Mortality is objective but adjudication was not reported."),
                RoBDomain(domain="Selection of the reported result", judgment="High risk", support="Mortality was not a registry primary outcome."),
            ],
            overall_judgment="High risk",
            is_synthetic=False,
        )

    monkeypatch.setattr(agent, "call_llm_structured", fake_structured_call)
    project = Project("registry rob", output_dir=tmp_path)
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="known_source:steroids_sari",
            title="Steroids-SARI (NCT04244591)",
            authors=["Steroids-SARI"],
            year=2020,
            study_design="Randomized Controlled Trial",
            source_type="known_source_evidence",
            metadata_source="who_react_figure2",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="All-cause mortality at 28 days",
                events_intervention=13,
                total_intervention=24,
                events_control=13,
                total_control=23,
                source_quote="Steroids-SARI (NCT04244591): deaths/total were 13/24 in the steroid arm and 13/23 in the no-steroid arm.",
                source_quote_verified=True,
            )
        ],
    )
    parsed_papers = {
        "title_e4eac68beef6": {
            "full_text": (
                "[PAGE 1]\n"
                "SOURCE: Registry source page\n"
                "Trial NCT04244591\n"
                "Publication Steroids-SARI - Du, Unpublished (2020)\n"
                "Methods\nRCT\nBlinding: Unblinded\n"
                "Risk of bias\nOverall\nSome concerns\n"
            )
        }
    }

    results = agent.run([study], parsed_papers, project)

    assert len(results) == 1
    assert results[0].study_id == "known_source:steroids_sari"
    assert results[0].tool_used == "RoB 2"
    assert results[0].overall_judgment == "High risk"
    assert results[0].is_synthetic is False
    assert "NCT04244591" in prompts[0]
    saved = project.load_json("rob_results.json", subdir="risk_of_bias")
    assert saved[0]["study_id"] == "known_source:steroids_sari"


def test_rob_agent_reuses_shared_cache_for_same_traceable_study_across_projects(
    monkeypatch,
    tmp_path: Path,
) -> None:
    cache_path = tmp_path / "rob_cache.json"
    monkeypatch.setenv("METAAGENT_ROB_CACHE_PATH", str(cache_path))
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="NCT00000001",
            title="Deterministic corticosteroid trial",
            authors=["Example Author"],
            year=2020,
            study_design="Randomized Controlled Trial",
            source_type="clinicaltrials_registry",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="28-day all-cause mortality",
                events_intervention=1,
                total_intervention=10,
                events_control=3,
                total_control=10,
                source_quote="NCT00000001 reported 1/10 vs 3/10 deaths.",
                source_quote_verified=True,
            )
        ],
    )
    parsed_papers = {
        "NCT00000001": {
            "full_text": "NCT00000001 randomized participants and reported objective mortality outcomes."
        }
    }
    first_agent = RoBAgent()
    calls = {"n": 0}

    def first_call(prompt, schema, max_tokens=4096):
        calls["n"] += 1
        return StudyRoB(
            study_id="",
            tool_used="",
            domains=[
                RoBDomain(domain="Randomization process", judgment="High risk", support="Allocation was unclear."),
            ],
            overall_judgment="High risk",
            is_synthetic=False,
        )

    monkeypatch.setattr(first_agent, "call_llm_structured", first_call)
    first = first_agent.run([study], parsed_papers, Project("rob cache first", output_dir=tmp_path / "p1"))

    assert calls["n"] == 1
    assert first[0].overall_judgment == "High risk"
    assert cache_path.exists()

    second_agent = RoBAgent()

    def fail_if_called(prompt, schema, max_tokens=4096):
        raise AssertionError("RoB LLM should not be called when a shared cache entry exists")

    monkeypatch.setattr(second_agent, "call_llm_structured", fail_if_called)
    second = second_agent.run([study], parsed_papers, Project("rob cache second", output_dir=tmp_path / "p2"))

    assert second[0].study_id == "NCT00000001"
    assert second[0].tool_used == "RoB 2"
    assert second[0].overall_judgment == "High risk"
