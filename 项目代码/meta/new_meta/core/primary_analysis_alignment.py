"""Deterministic version/quote checks for independent primary-analysis judgments.

Clinical meaning is judged in the existing extraction checker. This module only
binds that judgment to the exact protocol, row and source the checker saw.
"""
from __future__ import annotations

from bisect import bisect_right
from collections import Counter
from contextlib import contextmanager
import hashlib
import json
import os
import stat
from pathlib import Path
import re
import unicodedata

from new_meta.schemas.study import PrimaryAlignmentAssessment, PrimaryAnalysisAlignment

DIMENSIONS = ("outcome", "population", "contrast")
_PROOF_DIR = "extraction/primary_alignment"
_HASH = re.compile(r"^[a-f0-9]{64}$")
_SUPERSCRIPT_RUN = re.compile(r"[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+")
_SUPERSCRIPT_ASCII = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻", "0123456789+-")
_NUMBER_ATOM = (
    r"(?:(?:[<>]=?|[≤≥≠≈≃≅~])\s*)?(?:(?:\+/-|[+\-−±])\s*)?"
    r"(?:\d+(?:[.,]\d+)*|[.,]\d+)(?:e[+\-−]?\d+)?"
    r"(?:\s*(?:\^|\*\*)\s*(?:[+\-−]\s*)?\d+)?(?:\s*(?:[%‰]|[′″‴⁗]+))?"
)
_NUMERIC_TOKEN = re.compile(_NUMBER_ATOM + r"(?:\s*(?:\+/-|[/⁄∕±×·*–—−-])\s*" + _NUMBER_ATOM + r")*")
_WORD_JOINERS = frozenset("-'’")
_ROW_METADATA = {
    "primary_analysis_alignment", "source_quote_verified", "source_quote_match",
    "extraction_confidence", "conflicts", "user_override_applied", "override_revision",
    "manual_adjudication", "timepoint_adjudication", "timepoint_adjudication_note",
}


def digest(value) -> str:
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def protocol_fingerprint(protocol) -> str:
    from new_meta.schemas.protocol import ResearchProtocol
    # Canonicalize redundant legacy study_design exactly as persisted reload does.
    return digest(ResearchProtocol.model_validate(protocol.model_dump()).model_dump(mode="json"))


def row_fingerprint(study, index: int) -> str:
    return digest({
        "study": study.characteristics.model_dump(mode="json"),
        "outcome": study.outcomes[index].model_dump(mode="json", exclude=_ROW_METADATA - {"conflicts"}),
        "outcome_index": index,
    })


def _normalized_quote(text: str) -> str:
    # Compatibility normalization must not concatenate a base and its exponent.
    text = _SUPERSCRIPT_RUN.sub(lambda match: "^" + match.group().translate(_SUPERSCRIPT_ASCII), text)
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def _word_character(character: str) -> bool:
    return character.isalnum() or character == "_" or unicodedata.category(character).startswith("M")


def _complete_quote_occurs(source, quote, numeric_spans, numeric_starts, *, continuous_scripts=False):
    def word_character(character):
        # These scripts do not require spaces between lexical phrases.
        code = ord(character)
        if continuous_scripts and (0x3400 <= code <= 0x9FFF or 0x20000 <= code <= 0x323AF
                                   or 0x3040 <= code <= 0x30FF or 0xAC00 <= code <= 0xD7AF):
            return False
        return _word_character(character)

    def inside_number(position):
        index = bisect_right(numeric_starts, position) - 1
        return index >= 0 and numeric_spans[index][0] < position < numeric_spans[index][1]

    offset = 0
    while True:
        start = source.find(quote, offset)
        if start < 0:
            return False
        end = start + len(quote)
        left_clipped = start > 0 and word_character(quote[0]) and (
            word_character(source[start - 1]) or (
                start > 1 and source[start - 1] in _WORD_JOINERS and word_character(source[start - 2])
            )
        )
        right_clipped = end < len(source) and word_character(quote[-1]) and (
            word_character(source[end]) or (
                end + 1 < len(source) and source[end] in _WORD_JOINERS and word_character(source[end + 1])
            )
        )
        if not left_clipped and not right_clipped and not inside_number(start) and not inside_number(end):
            return True
        offset = start + 1


def _anchored(assessment, source_text: str) -> bool:
    source = _normalized_quote(source_text)
    numeric_spans = [match.span() for match in _NUMERIC_TOKEN.finditer(source)]
    numeric_starts = [start for start, _ in numeric_spans]
    for name in DIMENSIONS:
        dimension = getattr(assessment, name)
        if dimension.status == "uncertain":
            continue
        quote = _normalized_quote(dimension.quote)
        if len(quote) < 16 or not dimension.source_location.strip():
            return False
        if not _complete_quote_occurs(source, quote, numeric_spans, numeric_starts):
            return False
    return True


@contextmanager
def _parent_descriptor(project, relative: str, *, create=False):
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts or not path.name:
        raise ValueError("alignment source must stay in its project")
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(project.base_dir, flags)
    try:
        for part in path.parts[:-1]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor, path.name
    finally:
        os.close(descriptor)


def _read_scoped(project, relative: str, *, max_bytes: int = 64 * 1024 * 1024) -> bytes:
    with _parent_descriptor(project, relative) as (parent, name):
        descriptor = os.open(name, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > max_bytes:
            raise ValueError("alignment source is not a bounded regular file")
        chunks, size = [], 0
        while size <= max_bytes:
            chunk = os.read(descriptor, min(1024 * 1024, max_bytes + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        after = os.fstat(descriptor)
        stable = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_nlink")
        if size > max_bytes or any(getattr(before, key) != getattr(after, key) for key in stable):
            raise ValueError("alignment source changed while being read")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _write_scoped_once(project, relative: str, payload: bytes):
    with _parent_descriptor(project, relative, create=True) as (parent, name):
        try:
            descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                                 0o600, dir_fd=parent)
        except FileExistsError:
            if _read_scoped(project, relative) != payload:
                raise ValueError("alignment immutable artifact changed")
            return
        try:
            offset = 0
            while offset < len(payload):
                offset += os.write(descriptor, payload[offset:])
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _write_scoped_atomic(project, relative: str, payload: bytes):
    """Atomically replace a derived record without following leaf/parent symlinks."""
    import uuid
    with _parent_descriptor(project, relative, create=True) as (parent, name):
        temporary = f".{name}.{uuid.uuid4().hex}.tmp"
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                             0o600, dir_fd=parent)
        try:
            offset = 0
            while offset < len(payload):
                written = os.write(descriptor, payload[offset:])
                if written <= 0:
                    raise OSError("Scoped artifact write made no progress")
                offset += written
            os.fsync(descriptor)
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(descriptor)
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass


def _authenticated_proof(project, proof):
    """Authenticate history without rebinding it to a newer row or document."""
    if proof is None:
        return None
    try:
        if not _HASH.fullmatch(proof.proof_id):
            return None
        payload = proof.model_dump(mode="json")
        record = json.loads(_read_scoped(project, f"{_PROOF_DIR}/{proof.proof_id}.json", max_bytes=1024 * 1024))
        if record != payload or digest({key: value for key, value in payload.items() if key != "proof_id"}) != proof.proof_id:
            return None
        return proof
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def _checkpoint_path(study):
    from new_meta.tools.utils import safe_identifier
    sid = study.characteristics.pmid or study.characteristics.study_id
    return f"extraction/{safe_identifier(sid)}.json"


def _current_checkpoint(project, study, index):
    from new_meta.schemas.study import ExtractedStudy
    current = ExtractedStudy.model_validate(json.loads(_read_scoped(project, _checkpoint_path(study))))
    if (current.characteristics.pmid or current.characteristics.study_id) != (
            study.characteristics.pmid or study.characteristics.study_id) or index >= len(current.outcomes):
        raise ValueError("Current extraction checkpoint does not contain this row")
    proof = _authenticated_proof(project, current.outcomes[index].primary_analysis_alignment)
    if proof is None or proof.current_checkpoint_path != _checkpoint_path(study) or proof.assessment.outcome_index != index:
        raise ValueError("Current extraction checkpoint lacks authenticated row provenance")
    return current, proof


def _persist_alignment_checkpoint(project, study):
    _write_scoped_atomic(project, _checkpoint_path(study), study.model_dump_json(indent=2).encode())


def recover_issue_history(project, study, index, *, allow_new=False):
    previous = study.outcomes[index].primary_analysis_alignment
    proof = _authenticated_proof(project, previous)
    try:
        _, current_proof = _current_checkpoint(project, study, index)
    except FileNotFoundError:
        current_proof = None
    except (OSError, ValueError, TypeError, AttributeError):
        return list(proof.unresolved_data_issues) if proof else [], False
    if current_proof is not None:
        # The aggregate and an in-memory caller may predate the latest per-study
        # checkpoint. Recover newer issue origins before any replacement write.
        issues = list(current_proof.unresolved_data_issues)
        if proof is not None and proof.proof_id != current_proof.proof_id:
            known = {digest(item.model_dump(mode="json")) for item in issues}
            issues.extend(item for item in proof.unresolved_data_issues
                          if digest(item.model_dump(mode="json")) not in known)
        return issues, bool(proof is not None and proof.issue_history_complete and current_proof.issue_history_complete)
    if proof is not None:
        # Every runtime proof is published with a durable current checkpoint.
        # Deleting that checkpoint cannot recover an older approval.
        return list(proof.unresolved_data_issues), False
    if proof is None:
        # No previous proof is normal only at the independent checker's initial
        # extraction boundary. A review screen cannot reconstruct lost history.
        if not allow_new or previous is not None:
            return [], False
        # A persisted row whose proof was deleted is not an initial extraction.
        # First-pass extraction creates its pending proof before saving the row.
        from new_meta.tools.utils import safe_identifier
        sid = study.characteristics.pmid or study.characteristics.study_id
        try:
            _read_scoped(project, f"extraction/{safe_identifier(sid)}.json")
            return [], False
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            return [], False
        try:
            saved = json.loads(_read_scoped(project, "extraction/all_extractions.json"))
            if not isinstance(saved, list) or any(
                    not isinstance(item, dict) or not isinstance(item.get("characteristics"), dict)
                    or (item["characteristics"].get("pmid") or item["characteristics"].get("study_id")) == sid
                    for item in saved):
                return [], False
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            return [], False
        return [], True
    return list(proof.unresolved_data_issues), proof.issue_history_complete


def _store_proof(project, study, index, payload):
    payload["current_checkpoint_path"] = _checkpoint_path(study)
    proof_id = digest(payload)
    proof = PrimaryAnalysisAlignment(**payload, proof_id=proof_id)
    _write_scoped_once(project, f"{_PROOF_DIR}/{proof_id}.json",
                       json.dumps(proof.model_dump(mode="json"), ensure_ascii=False, indent=2).encode())
    study.outcomes[index].primary_analysis_alignment = proof
    return proof


def invalidate_alignment_proofs(project, protocol, study, histories, *, reason):
    """Revoke an old approval on early failure while preserving issue origins.

    An unreadable or replaced source cannot furnish a new approval context. Its
    previous bindings can still describe a pending proof and authenticated issue
    history; alignment_status separately insists on current readable sources.
    """
    for index, outcome in enumerate(study.outcomes):
        previous = _authenticated_proof(project, outcome.primary_analysis_alignment)
        issues, complete = histories[index]
        pending = PrimaryAlignmentAssessment.model_validate({"outcome_index": index,
            **{name: {"status": "uncertain", "rationale": reason} for name in DIMENSIONS}})
        payload = {"schema_version": 1, "assessment": pending.model_dump(mode="json"),
            "assessor": "pending-review-v1", "assessor_id": "",
            "protocol_sha256": protocol_fingerprint(protocol), "row_sha256": row_fingerprint(study, index),
            **{name: getattr(previous, name, "") for name in (
                "source_path", "source_sha256", "checked_source_path", "checked_source_sha256")},
            "unresolved_data_issues": [item.model_dump(mode="json") for item in issues],
            "issue_history_complete": complete}
        _store_proof(project, study, index, payload)
    _persist_alignment_checkpoint(project, study)


def _record_proof(project, protocol, study, index, assessment, *, source_text, source_path, expected_source_sha256=None,
                  assessor="extraction-check-v1", assessor_id="", issue_history=None, publish_checkpoint=True):
    source_bytes = source_text.encode()
    checked_sha = hashlib.sha256(source_bytes).hexdigest()
    checked_path = f"{_PROOF_DIR}/{checked_sha}.txt"
    _write_scoped_once(project, checked_path, source_bytes)
    if source_path is None:
        relative_source = checked_path
    else:
        relative_source = Path(source_path).absolute().relative_to(project.base_dir.absolute()).as_posix()
    source_sha = hashlib.sha256(_read_scoped(project, relative_source)).hexdigest()
    if expected_source_sha256 is not None and source_sha != expected_source_sha256:
        raise ValueError("Source changed after independent verification")
    issues, complete = issue_history if issue_history is not None else recover_issue_history(project, study, index)
    payload = {
        "schema_version": 1, "assessment": assessment.model_dump(mode="json"),
        "assessor": assessor, "assessor_id": assessor_id,
        "protocol_sha256": protocol_fingerprint(protocol), "row_sha256": row_fingerprint(study, index),
        "source_path": relative_source, "source_sha256": source_sha,
        "checked_source_path": checked_path, "checked_source_sha256": checked_sha,
        "unresolved_data_issues": [item.model_dump(mode="json") for item in issues],
        "issue_history_complete": complete,
    }
    proof = _store_proof(project, study, index, payload)
    if publish_checkpoint:
        _persist_alignment_checkpoint(project, study)
    return proof


def record_checked_alignments(project, protocol, study, assessments, *, source_text: str,
                              source_path=None, checked_rows: dict[int, str] | None = None, expected_source_sha256=None, assessor_id="",
                              pending_reasons: dict | None = None, issue_histories: dict | None = None):
    """Discard model provenance, validate unique row judgments, then stamp in code."""
    histories = issue_histories if issue_histories is not None else {
        index: recover_issue_history(project, study, index, allow_new=True) for index in range(len(study.outcomes))}
    # Every row keeps a runtime-owned source/version context for explicit review,
    # including rows omitted by an incomplete or failed verification response.
    for index in range(len(study.outcomes)):
        reasons = (pending_reasons or {}).get(index) or [{"code": "verification_not_completed"}]
        pending_message = "Independent verification incomplete: " + "; ".join(str(item.get("code", "unknown")) for item in reasons)
        pending = PrimaryAlignmentAssessment.model_validate({
            "outcome_index": index, **{
                name: {"status": "uncertain", "rationale": pending_message}
                for name in DIMENSIONS
            },
        })
        _record_proof(project, protocol, study, index, pending, source_text=source_text,
                      source_path=source_path, expected_source_sha256=expected_source_sha256, assessor="pending-review-v1",
                      issue_history=histories[index], publish_checkpoint=False)
    parsed = []
    counts = Counter(
        item.outcome_index if isinstance(item, PrimaryAlignmentAssessment) else item.get("outcome_index")
        for item in assessments if isinstance(item, (dict, PrimaryAlignmentAssessment))
        and isinstance(item.outcome_index if isinstance(item, PrimaryAlignmentAssessment) else item.get("outcome_index"), int)
    )
    for payload in assessments:
        try:
            assessment = PrimaryAlignmentAssessment.model_validate(payload)
        except (ValueError, TypeError):
            continue
        if 0 <= assessment.outcome_index < len(study.outcomes):
            parsed.append(assessment)
    from new_meta.core.extraction_verification import validate_check_batch
    validation_errors = validate_check_batch(study, list(range(len(study.outcomes))), parsed, source_text, protocol)
    rejected_indices = {item["outcome_index"] for item in validation_errors if item.get("outcome_index") is not None}
    for assessment in parsed:
        index = assessment.outcome_index
        if histories[index][0] or not histories[index][1]:
            validation_errors.append({"code": "verification_data_issues_unresolved" if histories[index][1]
                                      else "verification_issue_history_required", "outcome_index": index})
            continue
        if index in rejected_indices:
            continue
        if counts[index] != 1 or not _anchored(assessment, source_text):
            continue
        if checked_rows is not None and checked_rows.get(index) != row_fingerprint(study, index):
            validation_errors.append({"code": "verification_row_snapshot_changed", "outcome_index": index})
            continue
        _record_proof(project, protocol, study, index, assessment,
                      source_text=source_text, source_path=source_path, expected_source_sha256=expected_source_sha256,
                      assessor="extraction-check-v2", assessor_id=assessor_id, issue_history=histories[index], publish_checkpoint=False)
    _persist_alignment_checkpoint(project, study)
    return validation_errors


def alignment_status(project, protocol, study, index: int) -> dict:
    """Return match/mismatch only for a current runtime-recorded anchored proof."""
    unknown = {"status": "unknown", "reason": "primary_alignment_required", "dimensions": {}}
    proof = study.outcomes[index].primary_analysis_alignment
    if proof is None:
        return unknown
    if _authenticated_proof(project, proof) is None:
        return {**unknown, "reason": "verification_issue_history_required"}
    try:
        checkpoint, current_proof = _current_checkpoint(project, study, index)
        if (proof.current_checkpoint_path != _checkpoint_path(study)
                or current_proof.proof_id != proof.proof_id
                or row_fingerprint(checkpoint, index) != row_fingerprint(study, index)):
            return {**unknown, "reason": "current_extraction_checkpoint_changed"}
    except (OSError, ValueError, TypeError, AttributeError):
        return {**unknown, "reason": "current_extraction_checkpoint_required"}
    try:
        if proof.assessor not in {"extraction-check-v2", "human-review-v1", "pending-review-v1"}:
            return unknown
        if proof.assessor == "human-review-v1" and proof.assessor_id in {"", "unknown"}:
            return unknown
        if proof.protocol_sha256 != protocol_fingerprint(protocol) or proof.row_sha256 != row_fingerprint(study, index):
            return unknown
        source = _read_scoped(project, proof.source_path)
        checked = _read_scoped(project, proof.checked_source_path)
        if hashlib.sha256(source).hexdigest() != proof.source_sha256 or hashlib.sha256(checked).hexdigest() != proof.checked_source_sha256:
            return unknown
        if proof.assessment.outcome_index != index or not _anchored(proof.assessment, checked.decode()):
            return unknown
    except (OSError, ValueError, TypeError, UnicodeDecodeError, AttributeError):
        return unknown
    dimensions = {name: getattr(proof.assessment, name).status for name in DIMENSIONS}
    status = "mismatch" if "mismatch" in dimensions.values() else "match" if set(dimensions.values()) == {"match"} else "unknown"
    reason = "primary_alignment_" + status
    from new_meta.core.extraction_verification import validate_check_batch, verification_verdict
    if not proof.issue_history_complete:
        status, reason = "unknown", "verification_issue_history_required"
    elif proof.unresolved_data_issues:
        status, reason = "unknown", "verification_data_issues_unresolved"
    elif proof.assessor == "pending-review-v1":
        status, reason = "unknown", "verification_not_completed"
    elif validate_check_batch(study, [index], [proof.assessment], checked.decode(), protocol):
        status, reason = "unknown", "extraction_verification_invalid"
    else:
        verified = verification_verdict(proof.assessment, protocol)
        if verified["status"] != "match":
            status, reason = verified["status"], verified["reason"]
    return {"status": status, "reason": reason,
            "dimensions": dimensions, "proof_id": proof.proof_id,
            "protocol_sha256": proof.protocol_sha256, "row_sha256": proof.row_sha256,
            "source_sha256": proof.source_sha256,
            "issue_history_complete": proof.issue_history_complete,
            "unresolved_data_issues": [item.model_dump(mode="json") for item in proof.unresolved_data_issues]}


def ensure_review_context(project, protocol, study, index):
    """Prepare an unverified current context for human review, never a match."""
    status = alignment_status(project, protocol, study, index)
    if status.get("protocol_sha256"):
        return status
    previous = study.outcomes[index].primary_analysis_alignment
    history = recover_issue_history(project, study, index)
    source_text = None
    source_path = None
    expected_sha = None
    try:
        if _authenticated_proof(project, previous) is not None:
            source = _read_scoped(project, previous.source_path)
            checked = _read_scoped(project, previous.checked_source_path)
            if hashlib.sha256(source).hexdigest() == previous.source_sha256 and hashlib.sha256(checked).hexdigest() == previous.checked_source_sha256:
                source_text, source_path, expected_sha = checked.decode(), project.base_dir / previous.source_path, previous.source_sha256
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    if source_text is None:
        try:
            sid = study.characteristics.pmid or study.characteristics.study_id
            parsed_all = json.loads(_read_scoped(project, "papers/parsed_papers.json"))
            parsed = parsed_all.get(sid) or {}
            records = json.loads(_read_scoped(project, "pdf_download_results.json"))
            source_record = next(item for item in records if str(item.get("pmid") or item.get("study_id") or item.get("id") or "") == sid)
            source_path = Path(source_record.get("pdf_path") or source_record.get("fulltext_path") or "")
            relative = source_path.absolute().relative_to(project.base_dir.absolute()).as_posix()
            source = _read_scoped(project, relative)
            expected_sha = hashlib.sha256(source).hexdigest()
            if not parsed.get("full_text") or parsed.get("_source_sha256") != expected_sha:
                raise ValueError("A current parsed source is required")
            source_text = parsed["full_text"]
            if parsed.get("tables"):
                source_text += "\n\n" + "\n\n".join(parsed["tables"])
        except (OSError, ValueError, TypeError, KeyError, AttributeError, StopIteration):
            return {**status, "recovery_action": "Refresh or upload the full text and resume source processing before alignment review."}
    pending = PrimaryAlignmentAssessment.model_validate({
        "outcome_index": index, **{name: {"status": "uncertain", "rationale": "A current dimension-specific review is required."} for name in DIMENSIONS},
    })
    try:
        _record_proof(project, protocol, study, index, pending, source_text=source_text,
                      source_path=source_path, expected_source_sha256=expected_sha, assessor="pending-review-v1",
                      issue_history=history)
    except (OSError, ValueError):
        return {**status, "recovery_action": "Refresh or upload the full text and resume source processing before alignment review."}
    return alignment_status(project, protocol, study, index)


class PrimaryAlignmentRequired(RuntimeError):
    def __init__(self, phase):
        self.phase = phase
        super().__init__(phase.summary)


def needs_input_phase(project, rows, *, reason="primary_analysis_alignment_required"):
    from new_meta.schemas.phase_result import ArtifactRef, NextAction, PhaseIssue, PhaseResult
    row_ids = [str(row.get("row_id") or "") for row in rows]
    trial_independence = any(row.get("reason") in {"overlapping_trial_units", "trial_identity_required"} for row in rows)
    primary_choice = any(row.get("reason") == "primary_result_choice_required" for row in rows)
    only_primary_choices = bool(rows) and all(row.get("reason") == "primary_result_choice_required" for row in rows)
    if only_primary_choices:
        reason = "primary_result_choice_required"
    action_title = "Choose the primary result among the current aligned candidates" if primary_choice else "Review primary-analysis alignment dimensions"
    summary = "Multiple distinct source-approved results remain within a study; choose the primary result explicitly." if only_primary_choices else "Primary synthesis requires complete source-backed numeric, outcome, population and estimand verification."
    if trial_independence:
        reason = "trial_independence_required"
        summary = "Contributing trial units overlap or are unresolved; publication identifiers do not establish independent studies."
        action_title = "Clarify source-backed trial contributions and restart with an explicit independent analysis set"
    return PhaseResult(
        run_id=project.base_dir.name, phase="effect_selection", status="needs_input",
        summary=summary,
        retryable=False, error_code=reason,
        issues=[PhaseIssue(code=reason, message="Review each unresolved primary-analysis alignment dimension against the source.",
                           blocking=True, entity_ids=row_ids)],
        next_actions=[NextAction(action_id="extraction_review_decision", title=action_title)],
        artifacts=[ArtifactRef(artifact_id="effect_selection_audit", kind="audit",
                               path="analysis/effect_selection_audit.json", media_type="application/json")],
        data={"selection_audit": rows, "effects": [], "decision_type": "primary_result_choice" if only_primary_choices else "primary_analysis_alignment",
              "row_ids": row_ids, "review_action": "extraction_review_decision"},
    )


def selection_input_fingerprint(study, index):
    return digest({"study": study.characteristics.model_dump(mode="json"),
                   "outcome": study.outcomes[index].model_dump(mode="json", exclude={"primary_analysis_alignment"}),
                   "outcome_index": index})


def primary_choice_decisions_fingerprint(project):
    manifest = project.load_json("extraction_review_decisions.json", subdir="extraction")
    if manifest is None:
        return digest([])
    if not isinstance(manifest, dict) or not isinstance(manifest.get("decisions"), list):
        raise ValueError("Primary-choice review manifest is malformed")
    choices = []
    for decision in manifest["decisions"]:
        if not isinstance(decision, dict):
            raise ValueError("Primary-choice review decision is malformed")
        if decision.get("primary_analysis_choice") is not None:
            choices.append({key: decision.get(key) for key in (
                "row_id", "primary_analysis_choice", "primary_choice_candidates_sha256", "primary_choice_proof_id",
            )})
    return digest(choices)


def save_selection_binding(project, protocol, studies, audit, effects):
    """Bind the generated effect dataset to all input rows and admitted proofs."""
    project.save_json("primary_alignment_selection.json", {
        "schema_version": 1, "protocol_sha256": protocol_fingerprint(protocol),
        "rows": {f"{study.characteristics.pmid or study.characteristics.study_id}:{index}": selection_input_fingerprint(study, index)
                 for study in studies for index in range(len(study.outcomes))},
        "proofs": {row["row_id"]: row.get("alignment", {}).get("proof_id")
                   for row in audit if row.get("alignment", {}).get("status") in {"match", "mismatch"}},
        "selected_row_ids": [row["row_id"] for row in audit if row.get("in_final_primary_analysis")],
        "effects_sha256": digest([effect.model_dump(mode="json") for effect in effects]),
        "primary_choice_decisions_sha256": primary_choice_decisions_fingerprint(project),
        "selection_gate_sha256": selection_gate_fingerprint(project),
    }, subdir="analysis")


def cached_alignment_is_current(project) -> bool:
    from new_meta.schemas.protocol import ResearchProtocol
    from new_meta.schemas.study import ExtractedStudy
    try:
        binding = project.load_json("primary_alignment_selection.json", subdir="analysis")
        if not isinstance(binding, dict) or binding.get("schema_version") != 1:
            return False
        protocol = ResearchProtocol.model_validate(project.load_json("protocol.json"))
        studies = [ExtractedStudy.model_validate(item) for item in project.load_json("all_extractions.json", subdir="extraction") or []]
        current = {f"{study.characteristics.pmid or study.characteristics.study_id}:{index}": (study, index)
                   for study in studies for index in range(len(study.outcomes))}
        if binding["protocol_sha256"] != protocol_fingerprint(protocol):
            return False
        if binding.get("primary_choice_decisions_sha256") != primary_choice_decisions_fingerprint(project):
            return False
        if binding.get("selection_gate_sha256") != selection_gate_fingerprint(project):
            return False
        if not project.is_step_done("effect_sizes") or binding["rows"] != {key: selection_input_fingerprint(study, index) for key, (study, index) in current.items()}:
            return False
        for row_id, proof_id in binding["proofs"].items():
            study, index = current[row_id]
            status = alignment_status(project, protocol, study, index)
            if status.get("proof_id") != proof_id or status["status"] not in {"match", "mismatch"}:
                return False
            if row_id in binding["selected_row_ids"] and status["status"] != "match":
                return False
        if any(row_id not in binding["proofs"] for row_id in binding["selected_row_ids"]):
            return False
        for study in studies:
            candidate_ids = {f"{study.characteristics.pmid or study.characteristics.study_id}:{index}" for index in range(len(study.outcomes))}
            choice = current_primary_choice(project, protocol, study, candidate_ids)
            if choice["status"] not in {"none", "current"}:
                return False
            if choice["status"] == "current" and choice["row_id"] not in binding["selected_row_ids"]:
                return False
        from new_meta.core.method_planning import infer_review_family
        from new_meta.schemas.method_policy import ReviewFamily
        from new_meta.core.extraction_verification import trial_unit_issues
        if infer_review_family(protocol) is ReviewFamily.INTERVENTION_RCT:
            candidates = [(row_id, current[row_id][0].outcomes[current[row_id][1]].primary_analysis_alignment.assessment)
                          for row_id in binding["selected_row_ids"]]
            if trial_unit_issues(candidates):
                return False
        effects = project.load_json("effect_sizes.json", subdir="analysis")
        return isinstance(effects, list) and digest(effects) == binding["effects_sha256"]
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return False


def require_current_cached_alignment(project, *, protocol=None, effects=None, meta_results=None):
    valid = cached_alignment_is_current(project)
    binding = project.load_json("primary_alignment_selection.json", subdir="analysis") or {}
    if protocol is not None:
        valid = valid and binding.get("protocol_sha256") == protocol_fingerprint(protocol)
    if effects is not None:
        valid = valid and binding.get("effects_sha256") == digest([effect.model_dump(mode="json") for effect in effects])
    if meta_results is not None:
        pool = project.load_json("primary_alignment_pool.json", subdir="analysis") or {}
        valid = valid and pool.get("selection_sha256") == digest(binding) and pool.get("meta_sha256") == digest(meta_results.model_dump(mode="json"))
    if not valid:
        raise PrimaryAlignmentRequired(needs_input_phase(project, [], reason="cached_primary_alignment_stale"))


def save_pool_binding(project, meta_results):
    project.save_json("primary_alignment_pool.json", {
        "schema_version": 1,
        "selection_sha256": digest(project.load_json("primary_alignment_selection.json", subdir="analysis")),
        "meta_sha256": digest(meta_results.model_dump(mode="json")),
    }, subdir="analysis")


def is_verified_direct_ipd(project, plan, result_ids) -> bool:
    """Recognize the existing imported participant-dataset contract, not a label."""
    if plan.capability_id != "ipd_meta.parallel_two_stage" or not result_ids:
        return False
    from new_meta.core.evidence_ledger import EvidenceLedger, LedgerError
    from new_meta.core.ipd_ingestion import IPDIngestionReport
    from new_meta.schemas.evidence_ledger import IPDStudyData, ResultEntity
    try:
        report = IPDIngestionReport.model_validate(project.load_json("ipd_ingestion.json", subdir="evidence"))
        if report.review_id != plan.review_id or not set(result_ids).issubset(report.result_ids):
            return False
        ledger = EvidenceLedger(project.get_path("ledger.jsonl", subdir="evidence"), review_id=plan.review_id)
        ledger.assert_valid()
        latest = {event.entity_id: event for event in ledger.events()}
        for result_id in result_ids:
            event = latest[result_id]
            if (event.actor.actor_id != "ipd_dataset_import" or event.actor.actor_type.value != "import"
                    or event.actor.code_version != "ipd-ledger-v1"):
                return False
            result = ResultEntity.model_validate(event.payload)
            if not isinstance(result.raw_data, IPDStudyData) or result.evidence_state.value not in {"verified", "adjudicated"}:
                return False
            if result.derivation.get("dataset_sha256") != report.dataset_sha256:
                return False
            if result.derivation.get("participant_rows") != len(result.raw_data.participants):
                return False
            if not any(locator.section == "participant_dataset" and locator.quote_verified
                       and locator.file_sha256 == result.derivation.get("source_sha256")
                       and bool(locator.quote.strip()) for locator in result.source_locators):
                return False
        return True
    except (OSError, ValueError, TypeError, KeyError, LedgerError):
        return False


def save_method_pool_binding(project, plan, execution, envelope, source_studies, *, direct_ipd):
    protocol_data = project.load_json("protocol.json")
    project.save_json("primary_alignment_method_pool.json", {
        "schema_version": 1,
        "scope": "direct_ipd_dataset_contract" if direct_ipd else "source_verified_literature",
        "plan_sha256": digest(plan.model_dump(mode="json")),
        "protocol_sha256": digest(protocol_data) if protocol_data else None,
        "ledger_head_hash": execution.input_ledger_head_hash,
        "analysis_set_sha256": digest(project.load_json("analysis_set.json", subdir="analysis")),
        "method_sha256": digest(execution.model_dump(mode="json")),
        "synthesis_sha256": digest(envelope.model_dump(mode="json")),
        "source_rows_sha256": digest([study.model_dump(mode="json") for study in source_studies]),
    }, subdir="analysis")


def require_method_source_alignment(project, plan, result_ids, *, entities):
    """Enforce current literature provenance at the actual executor boundary."""
    from new_meta.core.extraction_ledger import current_extraction_matches_result, result_entity_id
    from new_meta.core.extraction_verification import trial_unit_issues
    from new_meta.schemas.method_policy import ReviewFamily
    from new_meta.schemas.protocol import ResearchProtocol
    from new_meta.schemas.study import ExtractedStudy
    if is_verified_direct_ipd(project, plan, result_ids):
        return
    try:
        protocol = ResearchProtocol.model_validate(project.load_json("protocol.json"))
        studies = [ExtractedStudy.model_validate(item) for item in
                   project.load_json("all_extractions.json", subdir="extraction") or []]
        rows = {result_entity_id(study, index): (study, index)
                for study in studies for index in range(len(study.outcomes))}
        unresolved, candidates = [], []
        selected_entities = {entity.entity_id: entity for entity in entities}
        for result_id in result_ids:
            row = rows.get(result_id)
            verdict = alignment_status(project, protocol, *row) if row else {"status": "unknown", "reason": "source_row_required"}
            if verdict["status"] == "match" and (result_id not in selected_entities or not
                    current_extraction_matches_result(*row, protocol, selected_entities[result_id])):
                verdict = {"status": "unknown", "reason": "ledger_extraction_refresh_required"}
            row_id = f"{row[0].characteristics.pmid or row[0].characteristics.study_id}:{row[1]}" if row else result_id
            if verdict["status"] != "match":
                unresolved.append({"row_id": row_id, "result_id": result_id, "alignment": verdict})
            else:
                candidates.append((row_id, row[0].outcomes[row[1]].primary_analysis_alignment.assessment))
        if not unresolved and plan.family is ReviewFamily.INTERVENTION_RCT:
            unresolved.extend(trial_unit_issues(candidates))
    except (OSError, ValueError, TypeError, AttributeError):
        unresolved = [{"row_id": result_id, "alignment": {"status": "unknown", "reason": "source_row_provenance_required"}}
                      for result_id in result_ids]
    if unresolved:
        phase = needs_input_phase(project, unresolved)
        if any(item.get("alignment", {}).get("reason") == "ledger_extraction_refresh_required" for item in unresolved):
            phase.summary = "Refresh the evidence ledger through the existing extraction migration before executing corrected source rows."
            phase.data["review_action"] = "rerun_after_overrides"
        project.save_json("primary_alignment_status.json", phase, subdir="analysis")
        raise PrimaryAlignmentRequired(phase)


def require_current_compiled_alignment(project):
    """Never reuse a compiled pool from before its current input/proof binding."""
    from new_meta.core.evidence_ledger import EvidenceLedger, LedgerError
    from new_meta.schemas.method_policy import MethodPlan, MethodExecutionResult
    from new_meta.schemas.study import ExtractedStudy
    from new_meta.schemas.synthesis_result import SynthesisResultEnvelope
    from new_meta.schemas.protocol import ResearchProtocol
    try:
        binding = project.load_json("primary_alignment_method_pool.json", subdir="analysis") or {}
        plan = MethodPlan.model_validate(project.load_json("method_plan.json", subdir="analysis"))
        execution = MethodExecutionResult.model_validate(project.load_json("method_result.json", subdir="analysis"))
        envelope = SynthesisResultEnvelope.model_validate(project.load_json("synthesis_result.json", subdir="analysis"))
        protocol_data = project.load_json("protocol.json")
        valid = binding.get("schema_version") == 1 and project.is_step_done("meta_analysis")
        valid = valid and binding.get("plan_sha256") == digest(plan.model_dump(mode="json"))
        valid = valid and binding.get("protocol_sha256") == (digest(protocol_data) if protocol_data else None)
        valid = valid and binding.get("analysis_set_sha256") == digest(project.load_json("analysis_set.json", subdir="analysis"))
        valid = valid and binding.get("method_sha256") == digest(execution.model_dump(mode="json"))
        valid = valid and binding.get("synthesis_sha256") == digest(envelope.model_dump(mode="json"))
        ledger = EvidenceLedger(project.get_path("ledger.jsonl", subdir="evidence"), review_id=plan.review_id)
        valid = valid and ledger.assert_valid().head_hash == binding.get("ledger_head_hash") == execution.input_ledger_head_hash
        if binding.get("scope") == "direct_ipd_dataset_contract":
            valid = valid and is_verified_direct_ipd(project, plan, execution.input_result_ids)
        elif binding.get("scope") == "source_verified_literature":
            from new_meta.core.extraction_ledger import result_entity_id
            studies = [ExtractedStudy.model_validate(item) for item in project.load_json("all_extractions.json", subdir="extraction") or []]
            valid = valid and binding.get("source_rows_sha256") == digest([study.model_dump(mode="json") for study in studies])
            protocol = ResearchProtocol.model_validate(protocol_data)
            rows = {result_entity_id(study, index): (study, index) for study in studies for index in range(len(study.outcomes))}
            valid = valid and all(result_id in rows and alignment_status(project, protocol, *rows[result_id])["status"] == "match"
                                  for result_id in execution.input_result_ids)
            from new_meta.schemas.method_policy import ReviewFamily
            from new_meta.core.extraction_verification import trial_unit_issues
            if valid and plan.family is ReviewFamily.INTERVENTION_RCT:
                candidates = [(f"{rows[key][0].characteristics.pmid or rows[key][0].characteristics.study_id}:{rows[key][1]}",
                    rows[key][0].outcomes[rows[key][1]].primary_analysis_alignment.assessment) for key in execution.input_result_ids]
                valid = not trial_unit_issues(candidates)
        else:
            valid = False
        if valid:
            return
    except (OSError, ValueError, TypeError, KeyError, AttributeError, LedgerError):
        pass
    phase = needs_input_phase(project, [], reason="cached_compiled_alignment_stale")
    phase.summary = "Recompute the compiled method through its current input and source-alignment gates before reusing this package."
    phase.data["review_action"] = "rerun_after_overrides"
    phase.data["decision_type"] = "compiled_method_rerun"
    phase.next_actions[0].action_id = "rerun_after_overrides"
    phase.next_actions[0].title = "Rerun the existing compiled method with current source inputs"
    raise PrimaryAlignmentRequired(phase)


def primary_choice_fingerprint(protocol, study):
    return digest({"protocol": protocol_fingerprint(protocol),
                   "rows": [selection_input_fingerprint(study, index) for index in range(len(study.outcomes))],
                   "proofs": [outcome.primary_analysis_alignment.proof_id if outcome.primary_analysis_alignment else None
                              for outcome in study.outcomes]})


def primary_effect_identity(outcome, effect):
    """Only exact numerical and clinical duplicates may bypass a primary choice."""
    clinical = outcome.model_dump(mode="json", exclude=_ROW_METADATA | {
        "source_quote", "source_location", "source_section", "source_page", "contrast_id", "estimand_id",
    })
    proof = getattr(outcome, "primary_analysis_alignment", None)
    details = proof.assessment.verification if proof is not None else None
    units = sorted({("registry:" + _normalized_quote(unit.registry_id)) if unit.registry_id.strip()
                    else ("name:" + _normalized_quote(unit.trial_name))
                    for unit in details.trial_units if unit.role == "contributing"}) if details else []
    return digest({"clinical": clinical, "yi": effect.yi, "vi": effect.vi, "contributing_units": units})


def selection_gate_fingerprint(project):
    return digest({
        "study_rob": project.load_json("rob_results.json", subdir="risk_of_bias"),
        "result_rob": project.load_json("rob_result_assessments.json", subdir="risk_of_bias"),
        "rob_adjudications": project.load_json("rob_adjudications.json", subdir="risk_of_bias"),
        "sources": project.load_json("pdf_download_results.json"),
        "screening": project.load_json("full_text_screening.json", subdir="screening"),
    })


def selectable_primary_rows(project, protocol, study):
    import math
    allowed = {"primary_result_choice_required", "primary_result_choice_unavailable",
               "unique_aligned_primary_result", "duplicate_equivalent_primary_result",
               "explicit_primary_choice", "explicit_primary_choice_excluded"}
    audit = project.load_json("effect_selection_audit.json", subdir="analysis") or []
    current_gate = selection_gate_fingerprint(project)
    indices = {f"{study.characteristics.pmid or study.characteristics.study_id}:{index}": index
               for index in range(len(study.outcomes))}
    rows = []
    for row in audit:
        index = indices.get(row.get("row_id"))
        if index is None or row.get("reason") not in allowed or row.get("selection_gate_sha256") != current_gate:
            continue
        if row.get("selection_input_sha256") != selection_input_fingerprint(study, index):
            continue
        if alignment_status(project, protocol, study, index)["status"] != "match":
            continue
        if not isinstance(row.get("effect"), (int, float)) or not isinstance(row.get("se"), (int, float)):
            continue
        if math.isfinite(row["effect"]) and math.isfinite(row["se"]) and row["se"] > 0:
            rows.append(row)
    return rows


def current_primary_choice(project, protocol, study, candidate_ids):
    context = primary_choice_fingerprint(protocol, study)
    prefix = f"{study.characteristics.pmid or study.characteristics.study_id}:"
    stale = {"status": "stale", "row_id": None}
    try:
        decisions = json.loads(_read_scoped(project, "extraction/extraction_review_decisions.json", max_bytes=1024 * 1024))
    except FileNotFoundError:
        return {"status": "none", "row_id": None}
    except (OSError, ValueError, TypeError):
        return stale
    if not isinstance(decisions, dict) or not isinstance(decisions.get("decisions"), list):
        return stale
    selected = []
    for decision in decisions["decisions"]:
        if not isinstance(decision, dict):
            return stale
        if decision.get("primary_analysis_choice") != "include":
            continue
        row_id = decision.get("row_id")
        if not isinstance(row_id, str) or not row_id:
            return stale
        if not row_id.startswith(prefix):
            continue
        # An active choice is a constraint even when its receipt is damaged.
        # Failure to verify it must never be reinterpreted as no prior choice.
        proof_id = str(decision.get("primary_choice_proof_id") or "")
        if not _HASH.fullmatch(proof_id):
            return stale
        try:
            proof = json.loads(_read_scoped(project, f"{_PROOF_DIR}/primary-choice-{proof_id}.json", max_bytes=256 * 1024))
            if not isinstance(proof, dict) or digest(proof) != proof_id:
                return stale
            if proof.get("schema_version") != 1 or proof.get("assessor") != "human-review-v1":
                return stale
            if not proof.get("assessor_id") or not str(proof.get("reason") or "").strip() or proof.get("selected_row_id") != row_id:
                return stale
            if proof.get("context_sha256") != decision.get("primary_choice_candidates_sha256") or proof.get("context_sha256") != context:
                return stale
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            return stale
        selected.append(row_id)
    if len(selected) == 1:
        return {"status": "current" if selected[0] in candidate_ids else "unavailable", "row_id": selected[0]}
    return stale if selected else {"status": "none", "row_id": None}
