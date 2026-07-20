from pathlib import Path

from new_meta.core.evidence_gap_delivery import complete_zero_record_review
from new_meta.core.project import Project
from new_meta.schemas.protocol import PICO, ResearchProtocol


def _protocol() -> ResearchProtocol:
    return ResearchProtocol(
        research_question="Does treatment X reduce 30-day mortality in adults?",
        pico=PICO(
            population="Adults with condition Y",
            intervention="Treatment X",
            comparator="Usual care",
            outcome_primary="30-day mortality",
        ),
        study_designs=["RCT"],
        primary_outcome_type="dichotomous",
        effect_measure="RR",
        databases=["PubMed", "OpenAlex"],
    )


def test_zero_search_results_produce_complete_editable_evidence_gap_article(
    tmp_path: Path,
) -> None:
    project = Project("zero search", output_dir=tmp_path / "projects")
    protocol = _protocol()
    query = '"condition Y"[tiab] AND "treatment X"[tiab]'

    manuscript = complete_zero_record_review(
        project=project,
        protocol=protocol,
        search_query=query,
        prisma_data=project.prisma.to_dict(),
        reason="no_records_identified",
        lang="en",
    )

    assert "# Evidence availability for 30-day mortality" in manuscript
    assert all(
        heading in manuscript
        for heading in (
            "## Abstract",
            "## Introduction",
            "## Methods",
            "## Results",
            "## Discussion",
            "## Conclusions",
            "## Declarations",
        )
    )
    assert "No records were identified" in manuscript
    assert query in manuscript
    assert "pooled risk ratio" not in manuscript.lower()
    assert "permission" not in manuscript.lower()
    assert project.load_text("draft.md", subdir="manuscript") == manuscript
    assert project.load_text("references.bib") == ""
    assert project.load_json("manuscript_facts.json", subdir="manuscript")["report_type"] == "evidence_gap"
    validation = project.load_json("manuscript_validation.json", subdir="manuscript")
    assert validation["passed"] is True
    assert validation["publication_ready"] is False
    assert project.is_step_done("manuscript")


def test_zero_screen_inclusions_produce_chinese_evidence_gap_article(tmp_path: Path) -> None:
    project = Project("zero screen", output_dir=tmp_path / "projects")
    project.prisma.records_identified = 12
    project.prisma.records_after_dedup = 10
    project.prisma.title_abstract_screened = 10
    project.prisma.title_abstract_excluded = 10

    manuscript = complete_zero_record_review(
        project=project,
        protocol=_protocol(),
        search_query="condition Y AND treatment X",
        prisma_data=project.prisma.to_dict(),
        reason="no_records_eligible",
        lang="zh",
    )

    assert "# 30天死亡的证据可得性" in manuscript
    assert "共筛选10条题名/摘要，未发现符合预设标准的记录" in manuscript
    assert "未进行定量合并" in manuscript
    assert "## 结论" in manuscript
    assert "权限" not in manuscript
