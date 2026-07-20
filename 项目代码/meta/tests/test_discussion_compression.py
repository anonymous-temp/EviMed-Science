from types import SimpleNamespace
import re
from uuid import uuid4

import new_meta.main as main_module
from new_meta.agents.writing_agent import WritingAgent
from new_meta.agents.writing_agent import PUBLICATION_DISCUSSION_MAX_PROSE_PARAGRAPHS
from new_meta.agents.writing_agent import PUBLICATION_DISCUSSION_MAX_UNITS_EN
from new_meta.core.project import Project


def test_discussion_compression_preserves_limitations_and_future_sections() -> None:
    paragraphs = [
        "The pooled HR was clinically meaningful and the confidence interval supports a directionally favorable effect for the primary endpoint.",
    ]
    for index in range(30):
        paragraphs.append(
            "Clinical interpretation paragraph "
            f"{index}: baseline risk, absolute benefit, composite endpoint components, "
            "safety monitoring, patient selection, implementation, GRADE certainty, "
            "and shared decision-making all require interpretation before adoption."
        )
    discussion = "\n\n".join([
        "## Discussion",
        *paragraphs,
        "### Strengths and limitations",
        (
            "This synthesis is limited by only two directly pooled trials, limited power "
            "for heterogeneity and publication-bias assessment, and reliance on aggregate "
            "data rather than individual participant data."
        ),
        "### Future research",
        (
            "Future trials and future updates should examine safety, absolute effects, "
            "longer follow-up, and patient-level effect modification."
        ),
    ])
    manuscript = f"# Manuscript\n\n{discussion}\n\n## References\n\n1. Example reference."

    polished = WritingAgent._polish_publication_body_language(manuscript)

    assert "### Strengths and limitations" in polished
    assert "only two directly pooled trials" in polished
    assert "publication-bias assessment" in polished
    assert "### Future research" in polished


def test_disabled_manuscript_polish_does_not_compress_discussion(tmp_path, monkeypatch) -> None:
    project = Project("no polish should be no op", output_dir=tmp_path / uuid4().hex)
    long_discussion = "\n\n".join(
        [
            "# Manuscript",
            "## Discussion",
            *[
                (
                    f"Clinical paragraph {index}: baseline risk, absolute benefit, "
                    "endpoint components, safety, applicability, implementation, "
                    "certainty, and shared decision-making all matter."
                )
                for index in range(30)
            ],
            "### Strengths and limitations",
            (
                "The main limitation is that only two studies contributed, limiting "
                "heterogeneity, publication-bias, and subgroup assessment."
            ),
            "### Future research",
            "Future studies should report safety, quality of life, renal outcomes, and subgroups.",
            "## References",
            "[1] Example reference.",
        ]
    )
    project.save_text("draft.md", long_discussion, subdir="manuscript")
    monkeypatch.setattr(main_module, "MANUSCRIPT_POLISH_USE_LLM", False)

    result = main_module._polish_project_manuscript(
        project,
        SimpleNamespace(no_polish_manuscript=False, polish_manuscript=False),
        model=None,
        lang="en",
    )

    saved = (project.base_dir / "manuscript" / "draft.md").read_text(encoding="utf-8")
    audit = project.load_json("manuscript_polish_audit.json", subdir="manuscript")
    assert result is None
    assert saved == long_discussion
    assert "### Strengths and limitations" in saved
    assert audit["enabled"] is False
    assert audit["publication_body_cleanup"]["applied"] is False


def test_discussion_compression_keeps_limitations_and_future_research_in_formal_fallback() -> None:
    body = "\n\n".join(
        [
            "# Manuscript",
            "## Discussion",
            (
                "The pooled HR was clinically meaningful and should be interpreted with "
                "baseline risk, endpoint components, safety, applicability, and certainty."
            ),
            *[
                (
                    f"Clinical application paragraph {index}: baseline risk, endpoint "
                    "components, safety monitoring, kidney function, patient selection, "
                    "implementation, costs, adherence, and shared decision making all "
                    "shape how the pooled estimate should be used."
                )
                for index in range(32)
            ],
            "### Strengths and limitations",
            (
                "A strength of this synthesis is its focused PICO and reliance on "
                "randomized trial evidence for a clinically important endpoint."
            ),
            (
                "The main limitation is that only two studies contributed to the pooled "
                "estimate, limiting heterogeneity, publication-bias, and subgroup assessment."
            ),
            (
                "Safety outcomes require separate interpretation because harms can alter "
                "net clinical benefit for individual patients."
            ),
            "### Future research",
            (
                "Future studies should report component outcomes, quality of life, renal "
                "outcomes, safety events, and prespecified subgroup effects consistently."
            ),
            "## References",
            "[1] Example reference.",
        ]
    )

    compressed = WritingAgent._compress_overlong_publication_discussions(body)
    discussion = re.search(r"## Discussion\n([\s\S]*?)(?=\n## |\Z)", compressed).group(1)
    prose_paragraphs = [
        block for block in WritingAgent._discussion_blocks(discussion)
        if WritingAgent._discussion_block_is_prose(block)
    ]

    assert "### Strengths and limitations" in discussion
    assert "only two studies contributed" in discussion
    assert "### Future research" in discussion
    assert "Future studies should report component outcomes" in discussion
    assert len(prose_paragraphs) <= PUBLICATION_DISCUSSION_MAX_PROSE_PARAGRAPHS
    assert WritingAgent._text_unit_count(discussion) <= PUBLICATION_DISCUSSION_MAX_UNITS_EN
