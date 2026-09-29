"""Why an extracted result was left out: one classified reason per unverified row.

Independent verification leaves a row out of synthesis for very different
reasons - the verifier judged it not to be the review's comparison, the
source contradicts itself, a number the effect reads was not found where the
verifier said, the verifier's own output never parsed. On 2026-09-28 (ma-001,
production job meta-20260928185649) three of five included trials were left
out and reported as "verification_not_completed" or
"verification_issue_history_required": bookkeeping states that hid a correct
comparator mismatch (every arm of one trial received intravenous TXA), a real
abstract-versus-results conflict, and two anchoring defects in the checker's
own code. The reason a reader sees is now the cause, from a closed
vocabulary, with its evidence.

The classification reads only codes this engine writes (a closed vocabulary),
never the model's prose; the model's own rationale travels along as detail.
"""
from __future__ import annotations

import json
from typing import Any

from new_meta.core.primary_analysis_alignment import (
    TRIAL_IDENTITY_UNRESOLVED, VERIFICATION_COULD_NOT_COMPLETE, _read_scoped, _write_scoped_atomic,
    protocol_fingerprint, row_fingerprint,
)

OUTCOME_DIR = "extraction/verification_outcomes"

#: Left-out reasons, most decisive first: a clinical judgment outranks a
#: numeric conflict, which outranks an anchoring or contract defect.
CLINICAL_MISMATCH = "clinical_mismatch"
SOURCE_NUMERIC_CONFLICT = "source_numeric_conflict"
ROW_DATA_ISSUE = "row_data_issue_unresolved"
NUMERIC_NOT_CONFIRMED = "numeric_value_not_confirmed"
NUMERIC_QUOTE_NOT_ANCHORED = "numeric_quote_not_anchored"
TRIAL_IDENTITY_NOT_ANCHORED = "trial_identity_not_anchored"
QUOTE_NOT_ANCHORED = "source_quote_not_anchored"
SOURCE_UNAVAILABLE = "verification_source_unavailable"
INPUTS_CHANGED = "verification_inputs_changed"
CONTRACT_INVALID = "verification_contract_invalid"

LEFT_OUT_REASONS: dict[str, str] = {
    CLINICAL_MISMATCH: "the verifier judged the result not to be the review's comparison, population or outcome",
    SOURCE_NUMERIC_CONFLICT: "the source reports conflicting numbers for it that nobody adjudicated",
    ROW_DATA_ISSUE: "the verifier found a defect in the extracted numbers that was not repaired",
    NUMERIC_NOT_CONFIRMED: "the verifier did not confirm a number its effect is computed from",
    NUMERIC_QUOTE_NOT_ANCHORED: "a number its effect is computed from was not in the passage the verifier quoted",
    TRIAL_IDENTITY_NOT_ANCHORED: "its trial registration or name was not in the passage the verifier quoted",
    QUOTE_NOT_ANCHORED: "a passage the verifier quoted was not found in the source",
    VERIFICATION_COULD_NOT_COMPLETE: "the verifier gave no usable response in its bounded attempts",
    TRIAL_IDENTITY_UNRESOLVED: "its trial could not be told apart from the other trials (no registration or name, "
                               "and the verifier was unsure which cohort contributes)",
    SOURCE_UNAVAILABLE: "no usable source text was available to verify it against",
    INPUTS_CHANGED: "the row, protocol or source changed while it was being verified",
    CONTRACT_INVALID: "the verifier's response did not cover it completely",
}
_ORDER = list(LEFT_OUT_REASONS)

_CODE_REASONS = {
    "verification_partial_clinical_judgment_retained": CLINICAL_MISMATCH,
    "verification_observed_clinical_judgment_incomplete": CLINICAL_MISMATCH,
    "verification_clinical_nonmatch_retained": CLINICAL_MISMATCH,
    "numeric_conflict_requires_adjudication": SOURCE_NUMERIC_CONFLICT,
    "row_source_conflict_requires_adjudication": SOURCE_NUMERIC_CONFLICT,
    "row_data_issue": ROW_DATA_ISSUE,
    "verification_data_issues_unresolved": ROW_DATA_ISSUE,
    "numeric_value_mismatch": NUMERIC_NOT_CONFIRMED,
    "numeric_value_unverified": NUMERIC_NOT_CONFIRMED,
    "numeric_status_unresolved": NUMERIC_NOT_CONFIRMED,
    "numeric_field_coverage": NUMERIC_NOT_CONFIRMED,
    "numeric_quote_not_anchored": NUMERIC_QUOTE_NOT_ANCHORED,
    "p_value_inequality_not_anchored": NUMERIC_QUOTE_NOT_ANCHORED,
    "trial_identifier_not_anchored": TRIAL_IDENTITY_NOT_ANCHORED,
    "clinical_quote_not_anchored": QUOTE_NOT_ANCHORED,
    "verification_quote_not_anchored": QUOTE_NOT_ANCHORED,
    "verification_data_issue_quote_not_anchored": QUOTE_NOT_ANCHORED,
    "verification_component_support_not_anchored": QUOTE_NOT_ANCHORED,
    "verification_component_label_not_anchored": QUOTE_NOT_ANCHORED,
    "verification_output_unusable": VERIFICATION_COULD_NOT_COMPLETE,
    "verification_source_version_invalid": SOURCE_UNAVAILABLE,
    "verification_source_context_unavailable": SOURCE_UNAVAILABLE,
    "verification_source_changed": INPUTS_CHANGED,
    "verification_inputs_changed_during_observation": INPUTS_CHANGED,
    "verification_protocol_changed_during_check": INPUTS_CHANGED,
    "verification_row_changed_during_check": INPUTS_CHANGED,
    "verification_source_changed_during_check": INPUTS_CHANGED,
    "verification_row_snapshot_changed": INPUTS_CHANGED,
}
#: Clinical verdict reasons of a complete verification (extraction_verification.verification_verdict).
_MISMATCH_VERDICTS = frozenset({"endpoint_components_incompatible", "source_estimand_incompatible",
                                "randomized_total_effect_required", "primary_alignment_mismatch"})
_DETAIL_LIMIT = 600


def _short(value: Any) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= _DETAIL_LIMIT else text[:_DETAIL_LIMIT - 1] + "…"


def classify(codes: list[dict], retained_clinical_judgments: list[dict] | None = None) -> dict:
    """The decisive reason among one row's final verification findings, with its evidence."""
    retained = [item for item in retained_clinical_judgments or [] if isinstance(item, dict)]
    found: dict[str, list[dict]] = {}
    for item in codes or []:
        if not isinstance(item, dict):
            continue
        code = str(item.get("code") or "")
        reason = _CODE_REASONS.get(code) or (CONTRACT_INVALID if code.startswith("verification_") else None)
        if reason is not None:
            found.setdefault(reason, []).append(item)
    if retained:
        found.setdefault(CLINICAL_MISMATCH, [])
    if not found:
        return {"reason": CONTRACT_INVALID, "codes": [], "detail": []}
    reason = min(found, key=_ORDER.index)
    detail: list[dict] = []
    if reason == CLINICAL_MISMATCH:
        for item in retained:
            judgment = item.get("judgment") if isinstance(item.get("judgment"), dict) else {}
            verdict = item.get("verdict") if isinstance(item.get("verdict"), dict) else {}
            detail.append({key: value for key, value in {
                "dimension": item.get("dimension"), "field": item.get("field"),
                "verdict": verdict.get("reason"),
                "rationale": _short(judgment.get("rationale")),
                "quote": _short(judgment.get("quote") or (judgment.get("estimand_support") or {}).get("quote")),
            }.items() if value})
    elif reason == SOURCE_NUMERIC_CONFLICT:
        for item in found[reason]:
            for conflict in item.get("conflicts") or [item]:
                if isinstance(conflict, dict):
                    detail.append({key: value for key, value in {
                        "field": conflict.get("field"),
                        "message": _short(conflict.get("message") or conflict.get("rationale")),
                        "observed_values": conflict.get("observed_values"),
                    }.items() if value})
    else:
        for item in found[reason]:
            detail.append({key: value for key, value in {
                "code": item.get("code"), "field": item.get("field"),
                "quote": _short(item.get("quote")), "reported": item.get("reported"),
                "error_type": item.get("error_type"), "attempts": item.get("attempts"),
            }.items() if value not in (None, "")})
    return {"reason": reason, "codes": sorted({str(item.get("code") or "") for item in codes or []
                                                if isinstance(item, dict)} - {""}),
            "detail": detail[:8]}


def _path(study) -> str:
    from new_meta.tools.utils import safe_identifier
    return f"{OUTCOME_DIR}/{safe_identifier(study.characteristics.pmid or study.characteristics.study_id)}.json"


def save_outcomes(project, protocol, study, rows: dict[int, dict]) -> None:
    """Persist this verification's per-row outcome, bound to the row and protocol it judged."""
    payload = {"schema_version": 1,
               "study_id": study.characteristics.pmid or study.characteristics.study_id,
               "protocol_sha256": protocol_fingerprint(protocol),
               "rows": {str(index): {"row_sha256": row_fingerprint(study, index), **outcome}
                        for index, outcome in sorted(rows.items())}}
    _write_scoped_atomic(project, _path(study), json.dumps(payload, ensure_ascii=False, indent=2).encode())


def saved_outcome(project, protocol, study, index: int) -> dict | None:
    """The recorded outcome of this exact row under this protocol, or None when stale or absent."""
    try:
        record = json.loads(_read_scoped(project, _path(study), max_bytes=4 * 1024 * 1024))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict) or record.get("protocol_sha256") != protocol_fingerprint(protocol):
        return None
    row = (record.get("rows") or {}).get(str(index))
    if not isinstance(row, dict) or row.get("row_sha256") != row_fingerprint(study, index):
        return None
    return row


def left_out_reason(project, protocol, study, index: int, status: dict) -> dict:
    """Classify a non-match alignment status for the report: {reason, description, detail, status_reason}."""
    status_reason = str(status.get("reason") or "")
    recorded = saved_outcome(project, protocol, study, index)
    if status.get("status") == "mismatch" or status_reason in _MISMATCH_VERDICTS:
        classified = {"reason": CLINICAL_MISMATCH, "detail": [{"verdict": status_reason}]}
        if recorded and recorded.get("reason") == CLINICAL_MISMATCH and recorded.get("detail"):
            classified["detail"] = recorded["detail"]
    elif recorded and recorded.get("status") == "left_out" and recorded.get("reason") in LEFT_OUT_REASONS:
        classified = {"reason": recorded["reason"], "detail": recorded.get("detail") or []}
    elif status_reason == VERIFICATION_COULD_NOT_COMPLETE:
        classified = {"reason": VERIFICATION_COULD_NOT_COMPLETE, "detail": []}
    else:
        # A state this verification did not record (a changed checkpoint, a
        # missing proof): report the gate's own reason rather than guess.
        classified = {"reason": status_reason or "primary_alignment_unknown", "detail": []}
    classified["description"] = LEFT_OUT_REASONS.get(classified["reason"], "")
    classified["status_reason"] = status_reason
    return classified
