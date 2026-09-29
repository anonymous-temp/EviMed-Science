"""Make the saved manuscript meet the release gate's text rules by construction.

Runs at save time, after every model pass, on the text that is about to be
written to ``draft.md``:

0. A negative number typed with a Unicode minus is written with the ASCII
   minus the engine renders, and a one-decimal rounding of the pooled
   estimate or its interval bounds is written back as the engine's
   two-decimal rendering (``new_meta.core.manuscript_numbers``), so prose
   numbers are byte-identical to the computation.
1. Cross-references to the manuscript's own tables and figures are generated
   (``new_meta.core.manuscript_cross_references``), never left to the prose.
2. Overlong interpretive sentences are split where no word changes: a
   top-level semicolon between complete clauses becomes a full stop
   (``new_meta.core.readability.split_overlong_sentences``).

What is still overlong stays as the readability check's finding. That check is
advisory (``new_meta.core.release_tiers``), and an advisory finding is never
sent back to the model: until 2026-09-29 each save asked the model for a
split-only edit, and on ma-001's replay all three requests were rejected by
the faithfulness guard while the sentence blocked the release.

The audit is written to ``manuscript/release_conformance_audit.json``.
"""
from __future__ import annotations

import re
from typing import Any

from new_meta.core.manuscript_cross_references import generate_table_figure_cross_references
from new_meta.core.manuscript_numbers import restore_rendered_primary_numbers
from new_meta.core.project import Project
from new_meta.core.readability import (
    overlong_interpretive_sentences,
    split_interpretive_sections,
)

# U+2212 MINUS SIGN and U+FF0D FULLWIDTH HYPHEN-MINUS directly before a digit.
_TYPED_MINUS = re.compile(r"[−－](?=\d)")


def normalize_number_signs(manuscript: str) -> tuple[str, int]:
    """Write every negative number with the ASCII minus the engine renders.

    The engine formats a negative estimate as "-303.23"; a model retyping it
    as "−303.23" (U+2212) produces different bytes that number checks read as
    +303.23. Only a minus sign immediately before a digit is replaced; an en
    dash (a range separator) is left alone.
    """
    text = str(manuscript or "")
    return _TYPED_MINUS.subn("-", text)


RELEASE_CONFORMANCE_AUDIT = "release_conformance_audit.json"
_ACTION_KEYS = (
    "normalized_minus_signs",
    "restored_number_renderings",
    "generated_cross_references",
    "deterministic_sentence_splits",
)


def _record_release_conformance(project: Project, audit: dict[str, Any]) -> None:
    """Append a pass that changed the text; keep the latest remaining findings.

    The hook runs at every save, and a later pass usually finds nothing left to
    do; it must not erase the record of the pass that did the work. The writer
    removes the file when it starts a new manuscript.
    """
    previous = project.load_json(RELEASE_CONFORMANCE_AUDIT, subdir="manuscript")
    passes = (
        list(previous.get("passes") or [])
        if isinstance(previous, dict) and previous.get("schema_version") == 2
        else []
    )
    if any(audit.get(key) for key in _ACTION_KEYS):
        passes.append({key: audit.get(key) for key in _ACTION_KEYS if key in audit})
    project.save_json(
        RELEASE_CONFORMANCE_AUDIT,
        {
            "schema_version": 2,
            "passes": passes,
            "remaining_overlong_sentences": audit.get("remaining_overlong_sentences") or [],
        },
        subdir="manuscript",
    )


class ReleaseConformanceMixin:
    """Save-time conformance with the release gate's cross-reference and sentence rules."""

    def _apply_release_conformance(
        self,
        manuscript: str,
        facts: dict | None,
        *,
        project: Project | None = None,
    ) -> tuple[str, dict[str, Any]]:
        text, normalized_signs = normalize_number_signs(manuscript)
        text, restored_numbers = restore_rendered_primary_numbers(text, facts)
        text, cross_references = generate_table_figure_cross_references(text, facts)
        text, deterministic_splits = split_interpretive_sections(text)
        audit: dict[str, Any] = {
            "schema_version": 1,
            "normalized_minus_signs": normalized_signs,
            "restored_number_renderings": restored_numbers,
            "generated_cross_references": cross_references,
            "deterministic_sentence_splits": deterministic_splits,
        }
        audit["remaining_overlong_sentences"] = overlong_interpretive_sentences(text)
        if project is not None:
            _record_release_conformance(project, audit)
        for record in cross_references:
            self.log(f"Generated cross-reference: {record.get('sentence')}")
        for item in audit["remaining_overlong_sentences"]:
            self.log(
                f"Sentence still exceeds {item.get('threshold')} units in {item.get('section')}: "
                f"{str(item.get('sentence') or '')[:80]}",
                level="warning",
            )
        return text, audit
