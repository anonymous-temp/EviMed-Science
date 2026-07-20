"""Regression tests for cross-section duplicate-sentence removal.

Fixtures use realistic markdown (a blank line after each heading) so prose lives
in its own block, matching how the pipeline emits drafts. Heading-led blocks are
preserved verbatim by the dedup pass and are not the unit under test here.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from new_meta.core.manuscript_text_metrics import remove_near_duplicate_sentences


def test_removes_verbatim_sentence_repeated_across_sections_midparagraph():
    draft = (
        "## Results\n\n"
        "Mortality was lower with treatment in the pooled analysis. "
        "The certainty rating was moderate because GRADE downgraded for risk of bias [24].\n\n"
        "## Discussion\n\n"
        "The result is clinically meaningful for critically ill adults. "
        "The certainty rating was moderate because GRADE downgraded for risk of bias [24].\n"
    )
    out = remove_near_duplicate_sentences(draft, cross_section=True)
    assert out.count("The certainty rating was moderate because GRADE downgraded") == 1


def test_removes_verbatim_standalone_paragraph_repeated_across_sections():
    draft = (
        "## Results\n\n"
        "The certainty rating was moderate because GRADE downgraded for risk of bias in five studies [24].\n\n"
        "## Discussion\n\n"
        "Some other sentence about clinical interpretation of the pooled mortality estimate here.\n\n"
        "The certainty rating was moderate because GRADE downgraded for risk of bias in five studies [24].\n"
    )
    out = remove_near_duplicate_sentences(draft, cross_section=True)
    assert out.count("The certainty rating was moderate because GRADE downgraded") == 1


def test_abstract_restatement_is_preserved():
    draft = (
        "## Abstract\n\n"
        "The pooled effect was OR 0.66 (95% CI 0.53 to 0.82), favoring corticosteroid treatment overall.\n\n"
        "## Results\n\n"
        "The pooled effect was OR 0.66 (95% CI 0.53 to 0.82), favoring corticosteroid treatment overall.\n"
    )
    out = remove_near_duplicate_sentences(draft, cross_section=True)
    assert out.count("The pooled effect was OR 0.66") == 2


def test_conclusion_restatement_is_preserved():
    # The Conclusion legitimately restates the headline result, like the Abstract.
    draft = (
        "## Results\n\n"
        "The pooled effect was OR 0.66 (95% CI 0.53 to 0.82), favoring corticosteroid treatment overall.\n\n"
        "## Conclusion\n\n"
        "The pooled effect was OR 0.66 (95% CI 0.53 to 0.82), favoring corticosteroid treatment overall.\n"
    )
    out = remove_near_duplicate_sentences(draft, cross_section=True)
    assert out.count("The pooled effect was OR 0.66") == 2


def test_default_mode_preserves_cross_section_restatement():
    # Default mode (used during writing) must NOT remove cross-section restatement.
    draft = (
        "## Results\n\n"
        "A distinctive sentence about the pooled mortality estimate appears in results here.\n\n"
        "## Discussion\n\n"
        "A distinctive sentence about the pooled mortality estimate appears in results here.\n"
    )
    out = remove_near_duplicate_sentences(draft)  # default cross_section=False
    assert out.count("A distinctive sentence about the pooled mortality estimate") == 2


def test_distinct_sentences_are_not_removed():
    draft = (
        "## Discussion\n\n"
        "Corticosteroids reduced mortality in critically ill adults with COVID-19 overall. "
        "Future trials should report safety outcomes by respiratory-support stratum.\n"
    )
    out = remove_near_duplicate_sentences(draft, cross_section=True)
    assert "Corticosteroids reduced mortality" in out
    assert "Future trials should report safety outcomes" in out


def test_removes_adjacent_semantic_duplicate_for_who_react_benchmark_claim():
    draft = (
        "## Results\n\n"
        "The present estimate reconstructs the published WHO REACT meta-analysis estimate and closely matches its reported result [13]. "
        "The estimate was compared with the published WHO REACT result [13]. "
        "The seven trial rows remained visible for clinical interpretation.\n"
    )
    out = remove_near_duplicate_sentences(draft)
    assert out.count("WHO REACT") == 1
    assert "seven trial rows" in out


def test_reference_section_is_untouched():
    draft = (
        "## Results\n\n"
        "A unique results sentence about the pooled estimate appears once here only.\n\n"
        "## References\n"
        "[1] Author A. Title. Journal. 2020.\n"
        "[2] Author B. Title. Journal. 2021.\n"
    )
    out = remove_near_duplicate_sentences(draft, cross_section=True)
    assert "[1] Author A. Title. Journal. 2020." in out
    assert "[2] Author B. Title. Journal. 2021." in out
