"""One bounded retry for a model stage whose own output cannot be used.

A model response can fail in its form - not JSON, off-schema, truncated,
empty - without saying anything about the source it was asked about. That
is the model failing, not the evidence. Every evidence stage (screening,
extraction, verification, risk of bias, evidence understanding, the
subgroup vocabulary) asks again through ``bounded_output_call``: a bounded
number of attempts, stricter about the form from the second one. When every
attempt fails, the stage records a classified reason for that entity with
``record_stage_failure`` and says what it did instead (left the result out,
forwarded the record to full text, marked a judgment as not made) - an
entity never falls out, or takes a default, silently.

Transport errors are not retried here; the client already retries them.
On 2026-09-28 (ma-001, production job meta-20260928185649) verification had
its own three-attempt loop while the risk-of-bias stage replaced any failure
with "Full text not available" and title/abstract screening forwarded a
failed call with nothing but an exception name.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Callable, TypeVar

T = TypeVar("T")

#: Attempts per stage call when the model's own output cannot be used.
STAGE_OUTPUT_ATTEMPTS = max(1, int(os.getenv("LLM_STAGE_OUTPUT_ATTEMPTS", "3")))
#: The classified reason every stage records when all attempts were unusable.
MODEL_OUTPUT_UNUSABLE = "model_output_unusable"
FAILURES_FILE = "model_stage_failures.json"
FAILURES_SUBDIR = "quality"
WARNING_CODE = "model_output_unusable"

#: Appended to the prompt from the second attempt on. Only the form is held;
#: the judgment asked for is the same.
STRICT_OUTPUT_NOTICE = (
    "\n\nYour previous response to this request could not be used: it was not one complete JSON "
    "object matching the required schema. Respond with exactly one JSON object that conforms to "
    "the schema - no markdown fences, no text before or after it, every required field present. "
    "Judge the content exactly as you otherwise would; only the form of the response must change."
)

_LOCK = threading.Lock()


def output_unusable(exc: BaseException) -> bool:
    """A failure of the model's own response: unparseable, off-schema, truncated or empty.

    JSONDecodeError and pydantic's ValidationError are ValueErrors; the
    client's LLMOutputError covers truncation and empty text. A transport
    error or a failed durable write is not the model's output and is raised -
    including one the client wrapped as an observer failure: a response that
    could not be recorded must never be regenerated.
    """
    from new_meta.core.llm import LLMOutputError
    if isinstance(exc, LLMOutputError):
        cause = exc.__cause__
        return cause is None or isinstance(cause, (ValueError, LLMOutputError))
    return isinstance(exc, ValueError)


class StageOutputUnusable(RuntimeError):
    """Every bounded attempt of one stage call returned unusable output."""

    reason = MODEL_OUTPUT_UNUSABLE

    def __init__(self, stage: str, entity_id: str, attempts: int, error_type: str):
        self.stage = stage
        self.entity_id = entity_id
        self.attempts = attempts
        self.error_type = error_type
        super().__init__(f"{stage} for {entity_id}: the model's output was unusable in "
                         f"{attempts} attempt(s) ({error_type})")

    @property
    def last_error(self) -> BaseException | None:
        return self.__cause__


def bounded_output_call(call: Callable[[int], T], *, stage: str, entity_id: str,
                        attempts: int | None = None,
                        retry_if: Callable[[BaseException], bool] | None = None,
                        log: Callable[[str], Any] | None = None) -> T:
    """Run ``call(attempt)`` until it returns, at most ``attempts`` times.

    ``call`` receives the 1-based attempt number; from 2 on it should hold
    the form more strictly (``strict_suffix``). Only an unusable output (or
    what ``retry_if`` admits) is asked again; anything else propagates at
    once. Exhaustion raises StageOutputUnusable chained to the last error.
    """
    limit = max(1, int(attempts or STAGE_OUTPUT_ATTEMPTS))
    retryable = retry_if or output_unusable
    last: BaseException | None = None
    for attempt in range(1, limit + 1):
        try:
            return call(attempt)
        except Exception as exc:  # noqa: BLE001 - classified below
            if not retryable(exc):
                raise
            last = exc
            if log is not None and attempt < limit:
                log(f"{stage} for {entity_id}: the model's output was unusable ({type(exc).__name__}); "
                    f"asking again ({attempt + 1}/{limit})")
    raise StageOutputUnusable(stage, entity_id, limit, type(last).__name__) from last


def strict_suffix(attempt: int) -> str:
    """The form notice for attempt ``attempt`` (empty on the first)."""
    return STRICT_OUTPUT_NOTICE if attempt > 1 else ""


def _failures_path(project):
    return project.base_dir / FAILURES_SUBDIR / FAILURES_FILE


def load_stage_failures(project) -> list[dict]:
    path = _failures_path(project)
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = loaded.get("failures") if isinstance(loaded, dict) else None
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def _write_failures(project, failures: list[dict]) -> None:
    path = _failures_path(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    temporary.write_text(json.dumps({"schema_version": 1, "failures": failures}, ensure_ascii=False, indent=2),
                         encoding="utf-8")
    os.replace(temporary, path)


def _refresh_warning(project, stage: str, failures: list[dict]) -> None:
    project.clear_warnings(stage=stage, code=WARNING_CODE)
    entries = [item for item in failures if item.get("stage") == stage]
    if not entries:
        return
    consequences = sorted({str(item.get("consequence") or "") for item in entries} - {""})
    project.add_warning(
        stage,
        f"{len(entries)} {stage} call(s) returned no usable model output in their bounded attempts; "
        + ("; ".join(consequences) if consequences else "recorded in quality/model_stage_failures.json") + ".",
        code=WARNING_CODE,
        context={"entities": sorted(str(item.get("entity_id") or "") for item in entries),
                 "artifact": f"{FAILURES_SUBDIR}/{FAILURES_FILE}"},
    )


def record_stage_failure(project, *, stage: str, entity_id: str, consequence: str,
                         reason: str = MODEL_OUTPUT_UNUSABLE, error_type: str = "",
                         attempts: int = 0, detail: dict | None = None) -> None:
    """Record why one entity of one stage has no model judgment, and what was done instead.

    One entry per (stage, entity): a later failure replaces it and
    ``clear_stage_failure`` removes it when a re-run succeeds. The stage's
    pipeline warning is rewritten to count its current entries.
    """
    if project is None or getattr(project, "skip_disk", False):
        return
    entry = {"stage": stage, "entity_id": str(entity_id), "reason": reason, "error_type": error_type,
             "attempts": int(attempts), "consequence": consequence, "recorded_at": time.time()}
    if detail:
        entry["detail"] = detail
    with _LOCK:
        failures = [item for item in load_stage_failures(project)
                    if (item.get("stage"), item.get("entity_id")) != (stage, str(entity_id))]
        failures.append(entry)
        _write_failures(project, failures)
        _refresh_warning(project, stage, failures)


def record_exhausted(project, error: StageOutputUnusable, *, consequence: str, detail: dict | None = None) -> None:
    record_stage_failure(project, stage=error.stage, entity_id=error.entity_id, consequence=consequence,
                         error_type=error.error_type, attempts=error.attempts, detail=detail)


def clear_stage_failure(project, stage: str, entity_id: str) -> None:
    """Forget an entity's failure once its stage produced a usable judgment."""
    if project is None or getattr(project, "skip_disk", False):
        return
    with _LOCK:
        failures = load_stage_failures(project)
        kept = [item for item in failures if (item.get("stage"), item.get("entity_id")) != (stage, str(entity_id))]
        if len(kept) == len(failures):
            return
        _write_failures(project, kept)
        _refresh_warning(project, stage, kept)
