from pathlib import Path

from new_meta.agents.evidence_understanding_agent import EvidenceUnderstandingAgent
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData, StudyCharacteristics


def test_evidence_understanding_persists_auditable_fallback_when_llm_fails(tmp_path: Path) -> None:
    project = Project("evidence understanding fallback", output_dir=tmp_path)
    protocol = ResearchProtocol(
        research_question="Does treatment reduce mortality?",
        pico=PICO(
            population="Adults",
            intervention="Treatment",
            comparator="Control",
            outcome_primary="Mortality",
        ),
        effect_measure="OR",
    )
    study = ExtractedStudy(
        characteristics=StudyCharacteristics(
            study_id="TRIAL-1",
            pmid="123",
            title="Trial of treatment for mortality",
            authors=["Example Author"],
            year=2024,
            study_design="Randomized trial",
            population_description="Hospitalized adults",
            intervention_description="Treatment",
            control_description="Usual care",
        ),
        outcomes=[
            OutcomeData(
                outcome_name="Mortality",
                outcome_type="binary",
                events_intervention=10,
                total_intervention=100,
                events_control=20,
                total_control=100,
                source_location="Table 2",
                source_page=5,
                source_quote="Mortality occurred in 10 of 100 treatment patients and 20 of 100 control patients.",
                source_quote_verified=True,
                extraction_confidence="high",
            )
        ],
    )
    agent = EvidenceUnderstandingAgent()

    def fail_llm(*args, **kwargs):
        raise RuntimeError("LLM unavailable")

    agent.call_llm_structured = fail_llm
    report = agent.run(
        included_papers=[
            {
                "pmid": "123",
                "title": "Trial of treatment for mortality",
                "abstract": "Randomized trial abstract.",
            }
        ],
        parsed_papers={
            "123": {
                "full_text": "Full text with Table 2 mortality data.",
                "tables": ["Table 2 mortality data"],
            }
        },
        extracted_studies=[study],
        rob_results=[],
        protocol=protocol,
        project=project,
    )

    saved = project.load_json("evidence_understanding.json", subdir="extraction")
    md = (project.base_dir / "extraction" / "evidence_understanding.md").read_text()

    assert report.status == "ok"
    assert saved["study_cards"][0]["study_id"] == "123"
    assert saved["study_cards"][0]["source_backed_claims"][0]["source_location"] == "Table 2"
    assert saved["study_cards"][0]["source_backed_claims"][0]["manuscript_use"] == "main"
    assert "LLM understanding failed" in saved["audit_notes"][0]
    assert "## Author 2024" in md
    assert "Mortality occurred in 10 of 100 treatment patients" in md
