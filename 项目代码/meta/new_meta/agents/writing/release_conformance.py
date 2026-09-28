"""Make the saved manuscript meet the release gate's text rules by construction.

Runs at save time, after every model pass, on the text that is about to be
written to ``draft.md``:

0. A negative number typed with a Unicode minus is written with the ASCII
   minus the engine renders, so it is byte-identical to the computation.
1. Cross-references to the manuscript's own tables and figures are generated
   (``new_meta.core.manuscript_cross_references``), never left to the prose.
2. Overlong interpretive sentences are split where no word changes: a
   top-level semicolon between complete clauses becomes a full stop
   (``new_meta.core.readability.split_overlong_sentences``).
3. What is still overlong is handed to the model as a split-only edit and
   accepted only when ``sentence_split_issues`` finds nothing changed but
   punctuation and a few connectives; a rejected split leaves the sentence as
   the gate's finding.

The audit is written to ``manuscript/release_conformance_audit.json``.
"""
from __future__ import annotations

import json
import re
from typing import Any

from new_meta.agents.writing.contracts import SentenceSplitRevision
from new_meta.core.manuscript_cross_references import generate_table_figure_cross_references
from new_meta.core.project import Project
from new_meta.core.readability import (
    overlong_interpretive_sentences,
    sentence_length_rule,
    sentence_split_issues,
    split_interpretive_sections,
)

_MAX_MODEL_SPLITS = 12

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


def _llm_configured() -> bool:
    """Whether a model endpoint key is configured (read at call time)."""
    import new_meta.config as config

    return bool(str(getattr(config, "LLM_API_KEY", "") or "").strip())


class ReleaseConformanceMixin:
    """Save-time conformance with the release gate's cross-reference and sentence rules."""

    def _apply_release_conformance(
        self,
        manuscript: str,
        facts: dict | None,
        *,
        project: Project | None = None,
        allow_model: bool = True,
    ) -> tuple[str, dict[str, Any]]:
        text, normalized_signs = normalize_number_signs(manuscript)
        text, cross_references = generate_table_figure_cross_references(text, facts)
        text, deterministic_splits = split_interpretive_sections(text)
        audit: dict[str, Any] = {
            "schema_version": 1,
            "normalized_minus_signs": normalized_signs,
            "generated_cross_references": cross_references,
            "deterministic_sentence_splits": deterministic_splits,
        }
        pending = overlong_interpretive_sentences(text)
        if pending and allow_model:
            if _llm_configured():
                text, audit["model_sentence_splits"] = self._llm_split_overlong_sentences(text, pending)
            else:
                audit["model_sentence_splits"] = {"status": "skipped", "reason": "missing_llm_api_key"}
        audit["remaining_overlong_sentences"] = overlong_interpretive_sentences(text)
        if project is not None:
            project.save_json("release_conformance_audit.json", audit, subdir="manuscript")
        for record in cross_references:
            self.log(f"Generated cross-reference: {record.get('sentence')}")
        for item in audit["remaining_overlong_sentences"]:
            self.log(
                f"Sentence still exceeds {item.get('threshold')} units in {item.get('section')}: "
                f"{str(item.get('sentence') or '')[:80]}",
                level="warning",
            )
        return text, audit

    def _llm_split_overlong_sentences(
        self,
        manuscript: str,
        pending: list[dict[str, Any]],
    ) -> tuple[str, dict[str, Any]]:
        """Ask the model to split each overlong sentence; keep only faithful splits."""
        items = [
            {
                "index": index,
                "section": item.get("section"),
                "sentence": item.get("sentence"),
                "units": item.get("units"),
                "limit": item.get("threshold"),
                "language": item.get("language"),
            }
            for index, item in enumerate(pending[:_MAX_MODEL_SPLITS])
        ]
        audit: dict[str, Any] = {"status": "ok", "requested": len(items), "accepted": [], "rejected": []}
        language = str(items[0].get("language") or ("zh" if getattr(self, "_zh", False) else "en"))
        prompt = (
            "You are the copy editor of a medical systematic review. Each item below is one sentence that is "
            "longer than the journal allows. " + sentence_length_rule(language) + "\n\n"
            "Rewrite each item as two or more consecutive sentences, each within the limit. This is a split, "
            "not a rewrite: keep the wording and its order, every number and unit, every confidence interval, "
            "every citation marker attached to the same words (for example ［3］ or [3]), every study name, "
            "every negation and hedge (不, 未, 无, 可能, not, no, may), and the meaning. Change punctuation and "
            "add or drop at most a few connective words. Do not add, remove, merge, soften, or strengthen any "
            "claim. Write in the sentence's own language. Omit an item you cannot split this way.\n\n"
            "Return JSON only: {\"rewrites\": [{\"index\": <item index>, \"replacement\": \"<sentences>\"}]}\n\n"
            f"ITEMS:\n{json.dumps(items, ensure_ascii=False, indent=2)}"
        )
        try:
            revision = self.call_llm_structured(
                prompt,
                SentenceSplitRevision,
                temperature=0.0,
                max_tokens=4096,
            )
        except Exception as exc:  # noqa: BLE001 - a failed edit leaves the gate's finding in place
            audit.update({"status": "failed", "error": str(exc)[:500]})
            return manuscript, audit
        text = manuscript
        seen: set[int] = set()
        for rewrite in getattr(revision, "rewrites", None) or []:
            index = getattr(rewrite, "index", None)
            if not isinstance(index, int) or index < 0 or index >= len(items) or index in seen:
                continue
            seen.add(index)
            item = items[index]
            original = str(item.get("sentence") or "")
            replacement = str(getattr(rewrite, "replacement", "") or "").strip()
            issues = sentence_split_issues(original, replacement, language=str(item.get("language") or language))
            if not issues and original not in text:
                issues = ["sentence_not_located"]
            record = {"section": item.get("section"), "original": original, "replacement": replacement}
            if issues:
                audit["rejected"].append({**record, "issues": issues})
                continue
            text = text.replace(original, replacement, 1)
            audit["accepted"].append(record)
        return text, audit
