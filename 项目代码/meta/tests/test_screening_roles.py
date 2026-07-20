from pathlib import Path

from new_meta.agents.screening_agent import ScreeningAgent, ScreeningDecision
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Do SGLT2 inhibitors improve HFpEF outcomes?",
        pico=PICO(
            population="adults with HFpEF or HFmrEF",
            intervention="SGLT2 inhibitors",
            comparator="placebo",
            outcome_primary="cardiovascular death or heart failure hospitalization",
        ),
        study_design="Randomized Controlled Trial",
        effect_measure="HR",
    )


def _covid_protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Systemic corticosteroids compared with usual care in critically ill adults with COVID-19",
        pico=PICO(
            population="critically ill adults with COVID-19",
            intervention="systemic corticosteroids including dexamethasone and hydrocortisone",
            comparator="usual care without systemic corticosteroids",
            outcome_primary="28-day all-cause mortality",
        ),
        study_design="Randomized Controlled Trial",
        effect_measure="OR",
    )


def test_title_abstract_retains_known_source_protocol_publications_for_source_audit(tmp_path: Path) -> None:
    project = Project("known source screening", output_dir=tmp_path)
    agent = ScreeningAgent(dual_screening=False)
    paper = {
        "pmid": "32799933",
        "doi": "10.1186/s13063-020-04643-1",
        "title": (
            "Efficacy of dexamethasone treatment for patients with the acute respiratory "
            "distress syndrome caused by COVID-19: study protocol for a randomized "
            "controlled superiority trial."
        ),
        "abstract": "This is a study protocol and does not report outcome data.",
        "authors": ["Villar J"],
        "year": 2020,
    }

    def exclude_protocol(*args, **kwargs):
        return ScreeningDecision(
            decision="exclude",
            priority_tier="indirect",
            reason="Protocol without outcome data.",
            exclusion_criterion="Protocols without outcome data",
            confidence="high",
        )

    agent.call_llm_structured = exclude_protocol

    included, excluded = agent.screen_title_abstract([paper], _covid_protocol(), project)
    rows = project.load_json("title_abstract_screening.json", subdir="screening")

    assert included == [paper]
    assert excluded == []
    assert rows[0]["decision"] == "include"
    assert rows[0]["priority_tier"] == "uncertain"
    assert rows[0]["known_source_audit_retained"] is True
    assert "known-source primary-source audit" in rows[0]["reason"]


def test_full_text_role_policy_routes_secondary_and_design_records_to_audit_only(tmp_path: Path) -> None:
    project = Project("screening roles", output_dir=tmp_path)
    agent = ScreeningAgent(dual_screening=False)
    papers = [
        {
            "pmid": "36027570",
            "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
            "authors": ["Solomon SD"],
            "year": 2022,
        },
        {
            "pmid": "34449189",
            "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
            "authors": ["Anker SD"],
            "year": 2021,
        },
        {
            "pmid": "36029467",
            "title": "Efficacy and Safety of Dapagliflozin in Heart Failure With Mildly Reduced or Preserved Ejection Fraction According to Age: The DELIVER Trial",
            "authors": ["Peikert A"],
            "year": 2022,
        },
        {
            "pmid": "34051124",
            "title": "Dapagliflozin in heart failure with preserved and mildly reduced ejection fraction: rationale and design of the DELIVER trial",
            "authors": ["Solomon SD"],
            "year": 2021,
        },
        {
            "pmid": "37534453",
            "title": "Cardiac and Metabolic Effects of Dapagliflozin in Heart Failure With Preserved Ejection Fraction: The CAMEO-DAPA Trial",
            "authors": ["Borlaug BA"],
            "year": 2023,
        },
    ]
    parsed = {
        paper["pmid"]: {"full_text": f"[PAGE 1]\n{paper['title']}\nprimary outcome results with or without diabetes subgroup language"}
        for paper in papers
    }

    def always_include(*args, **kwargs):
        return ScreeningDecision(
            decision="include",
            reason="LLM included for possible relevance.",
            confidence="high",
        )

    agent.call_llm_structured = always_include

    included, excluded = agent.screen_full_text(papers, _protocol(), parsed, project)
    rows = project.load_json("full_text_screening.json", subdir="screening")
    by_pmid = {row["paper"]["pmid"]: row for row in rows}

    assert [paper["pmid"] for paper in included] == ["36027570", "34449189"]
    assert {paper["pmid"] for paper in excluded} == {"36029467", "34051124", "37534453"}
    assert by_pmid["36027570"]["evidence_role"] == "primary_publication"
    assert by_pmid["36027570"]["analysis_route"] == "primary_extraction"
    assert by_pmid["34449189"]["evidence_role"] == "primary_publication"
    assert by_pmid["34449189"]["analysis_route"] == "primary_extraction"
    assert by_pmid["36029467"]["evidence_role"] == "secondary_analysis"
    assert by_pmid["36029467"]["analysis_route"] == "related_source_only"
    assert by_pmid["36029467"]["decision"] == "exclude"
    assert by_pmid["36029467"]["original_decision"] == "include"
    assert by_pmid["34051124"]["evidence_role"] == "design_or_protocol"
    assert by_pmid["34051124"]["exclusion_criterion"] == "design_or_protocol_not_independent_primary_publication"
    assert by_pmid["37534453"]["evidence_role"] == "adjacent_outcome_trial"
    assert by_pmid["37534453"]["analysis_route"] == "related_source_only"


def test_full_text_prefilter_keeps_registry_records_with_nct_identity(tmp_path: Path) -> None:
    project = Project("registry identity", output_dir=tmp_path)
    agent = ScreeningAgent(dual_screening=False)
    paper = {
        "pmid": "",
        "doi": "",
        "title": "Hydrocortisone for COVID-19 and Severe Hypoxia",
        "authors": [],
        "year": 2020,
        "source": "registry_seed",
        "source_type": "registry_seed",
        "trial_registration": "NCT04348305",
        "nct_id": "NCT04348305",
    }
    seen = {}

    def fake_screen_full_text(papers, protocol, parsed_papers):
        seen["papers"] = papers
        return [
            {
                "paper": papers[0],
                "decision": "include",
                "reason": "Registry identity is traceable through NCT.",
                "confidence": "high",
            }
        ]

    agent._screen_full_text = fake_screen_full_text

    included, excluded = agent.screen_full_text([paper], _protocol(), {}, project)

    assert seen["papers"] == [paper]
    assert included == [paper]
    assert excluded == []


def test_full_text_prefilter_keeps_collective_author_trials(tmp_path: Path) -> None:
    # Large collaborative trials (CRASH-3, RECOVERY) carry collective/corporate
    # authorship that PubMed does not expand, so the parsed authors list is empty.
    # They are still fully traceable by PMID/DOI and must not be pre-filtered out.
    project = Project("collective author identity", output_dir=tmp_path)
    agent = ScreeningAgent(dual_screening=False)
    paper = {
        "pmid": "31623894",
        "doi": "10.1016/S0140-6736(19)32233-0",
        "title": "Effects of tranexamic acid on death, disability... (CRASH-3): a randomised trial",
        "authors": [],
        "year": 2019,
    }
    seen = {}

    def fake_screen_full_text(papers, protocol, parsed_papers):
        seen["papers"] = papers
        return [{"paper": papers[0], "decision": "include", "reason": "Traceable by PMID/DOI.", "confidence": "high"}]

    agent._screen_full_text = fake_screen_full_text
    included, excluded = agent.screen_full_text([paper], _protocol(), {}, project)

    assert seen.get("papers") == [paper]  # reached screening, not dropped as "untraceable"
    assert included == [paper]
