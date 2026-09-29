"""Isolated hosted MR execution and descriptor-bound publication.

The hosted adapter has its own /tmp tmpfs, outside the customer /data mount.
The worker's in-memory preparation becomes an anonymous read-only pipe for the
fixed runner. Workspace paths are never reopened for runner input or output.
"""

import copy
import csv
import hashlib
import io
import json
import math
import os
import re
import signal
import sys
import stat
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

AUTHORITY_LIMIT = 64 * 1024
MAX_ARTIFACTS = 100
MAX_PUBLISHED_BYTES = 384 * 1024 * 1024
MAX_DIAGNOSTIC_BYTES = 32 * 1024 * 1024
MAX_DIAGNOSTIC_FILE_BYTES = 8 * 1024 * 1024
MAX_DIAGNOSTIC_FILES = 32
#: How much of the runner's own stdout/stderr a failed job keeps, from the end.
MAX_RUNNER_LOG_BYTES = 64 * 1024
#: The credentials the worker hands the runner. None may leave the job in a
#: diagnostic or in a message shown to the run.
SENSITIVE_ENVIRONMENT = frozenset({
    "LLM_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "OPENGWAS_JWT", "EVIMED_WORKLOAD_TOKEN",
})
_RUNNER_CODE = re.compile(r"[a-z][a-z0-9_]{0,79}")
_FINISH_REASONS = {"stop", "length", "content_filter", "tool_calls", "function_call"}
_CATEGORIES = {"http_error", "timeout", "connection", "response_error", "truncated", "empty_content", "completed", "application_error", "client_error"}
_PLOTS = {name + suffix for name in ("forest_plot", "scatter_plot", "funnel_plot", "loo_plot") for suffix in (".pdf", ".png")}
_NUMERIC_FILES = {"mr_results.csv", "heterogeneity.csv", "pleiotropy.csv", "f_statistics.csv", "conmix.csv", "radial.csv", "mrpresso.csv", "steiger.csv"}
_NUMERIC_COLUMNS = {"b", "beta", "se", "pval", "nsnp", "Q", "Q_df", "Q_pval", "egger_intercept", "F_stat", "F_statistic", "F", "lo_ci", "up_ci", "or", "or_lci95", "or_uci95"}
_METHODS = {"IVW", "Inverse variance weighted", "MR Egger", "Weighted median", "Weighted mode", "Simple mode", "Wald ratio", "Maximum likelihood", "Penalised weighted median", "MR RAPS", "Contamination mixture"}


def _integer(value, low=0, high=1_000_000_000):
    return value if type(value) is int and low <= value <= high else None


def _failure_fields(value):
    if not isinstance(value, dict):
        raise ValueError("invalid failure diagnostic")
    error_type = value.get("error_type")
    return {
        "error_type": error_type if isinstance(error_type, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", error_type) else "Exception",
        "status_code": _integer(value.get("status_code"), 100, 599),
        "finish_reason": value.get("finish_reason") if isinstance(value.get("finish_reason"), str) and value["finish_reason"] in _FINISH_REASONS else None,
        "category": value.get("category") if isinstance(value.get("category"), str) and value["category"] in _CATEGORIES else "application_error",
    }


def _failure_projection(result):
    """Validate the untrusted runner's projection without importing its package."""
    source = result.get("failureDiagnostics")
    if not isinstance(source, dict) or type(source.get("schema_version")) is not int or source["schema_version"] != 1 or source.get("phase") != "interpretation":
        return {"schema_version": 1, "phase": "runner", "failures": []}
    rows = source.get("failures")
    if not isinstance(rows, list) or len(rows) > 8:
        raise ValueError("invalid failure count")
    failures = []
    for row in rows:
        if not isinstance(row, dict) or _integer(row.get("result_index"), 0, 1000) is None:
            raise ValueError("invalid result index")
        raw = row.get("failure")
        failure = _failure_fields(raw)
        calls = raw.get("calls", [])
        if not isinstance(calls, list) or len(calls) > 10:
            raise ValueError("invalid SDK call count")
        observed = []
        for call in calls:
            record = _failure_fields(call)
            if call.get("error_type") is None:
                record["error_type"] = None
            sdk_call = _integer(call.get("sdk_call"), 1, 10)
            retry = _integer(call.get("retry_attempt"), 1, 5)
            if sdk_call is None or retry is None:
                raise ValueError("invalid SDK attempt")
            record.update(sdk_call=sdk_call, retry_attempt=retry,
                          content_present=call.get("content_present") if type(call.get("content_present")) is bool else None)
            for key in ("request_max_tokens", "prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens"):
                record[key] = _integer(call.get(key))
            observed.append(record)
        failure.update(sdk_call_attempts=_integer(raw.get("sdk_call_attempts"), 0, 10), calls=observed)
        failures.append({"result_index": row["result_index"], "failure": failure})
    return {"schema_version": 1, "phase": "interpretation", "failures": failures,
            "omitted_results": _integer(source.get("omitted_results"))}


def _numeric_projection(body):
    """Retain numeric columns and closed method/SNP labels, not free-text metadata."""
    reader = csv.DictReader(io.StringIO(body.decode("utf-8")))
    names = reader.fieldnames or []
    if len(names) != len(set(names)) or len(names) > 64:
        raise ValueError("invalid numeric columns")
    selected = [name for name in names if name in _NUMERIC_COLUMNS or name in {"SNP", "method"}]
    if not set(selected) & _NUMERIC_COLUMNS:
        return None
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=selected)
    writer.writeheader()
    for index, row in enumerate(reader):
        if index >= 5000 or None in row:
            raise ValueError("numeric row limit")
        values = {}
        for name in selected:
            value = (row.get(name) or "").strip()
            if name == "method":
                if value not in _METHODS:
                    raise ValueError("unrecognized method label")
            elif name == "SNP":
                if not re.fullmatch(r"rs[0-9]{1,16}", value):
                    raise ValueError("unrecognized SNP label")
            elif value not in {"", "NA", "NaN"} and (len(value) > 40 or not math.isfinite(float(value))):
                raise ValueError("invalid numeric value")
            values[name] = value
        writer.writerow(values)
    return output.getvalue().encode()


def sensitive_values(environment):
    """The byte strings a diagnostic or a message must never contain."""
    return [value.encode() for key, value in environment.items()
            if key in SENSITIVE_ENVIRONMENT and isinstance(value, str) and len(value) >= 8]


def _log_tail(log):
    """The end of what the runner wrote to stdout/stderr, and whether more came before it."""
    size = log.seek(0, os.SEEK_END)
    log.seek(max(0, size - MAX_RUNNER_LOG_BYTES))
    return log.read(MAX_RUNNER_LOG_BYTES), size > MAX_RUNNER_LOG_BYTES


def _runner_log(runner_log, secrets, record):
    """The runner's log for the private diagnostics, described in ``record``; never a credential."""
    if runner_log is None:
        return None
    body, truncated = runner_log
    if truncated:
        # The cut can fall inside a line, and a credential it splits would
        # pass the check below in part: the partial first line goes.
        newline = body.find(b"\n")
        body = body[newline + 1:] if newline >= 0 else b""
    if not body:
        return None
    if any(secret in body for secret in secrets):
        record["runnerLogWithheld"] = "mr_sensitive_diagnostic_withheld"
        return None
    record["runnerLog"] = {"name": "runner.log", "bytes": len(body),
                           "sha256": hashlib.sha256(body).hexdigest(), "truncated": truncated}
    return body


def _retain_failure(inputs, stage, directory, result, environment, *, artifacts_safe=True, runner_log=None):
    """Persist bounded diagnostics before scratch cleanup, never into workspace output.

    Besides the typed projection, the private directory keeps the tail of the
    runner's own stdout/stderr. Until 2026-09-28 that log was a scratch file
    deleted with the job, so a runner that exited 1 left nothing anywhere to
    say why: three production jobs failed that way in one morning.
    """
    record = {"failed": True, "diagnosticOnly": True, "artifacts": []}
    try:
        record["failureDiagnostics"] = _failure_projection(result)
    except (ValueError, TypeError):
        record["failureDiagnostics"] = {"schema_version": 1, "phase": "unknown", "failures": []}
        record["diagnosticProjectionError"] = "mr_failure_diagnostic_invalid"
    code = result.get("errorCode")
    if isinstance(code, str) and _RUNNER_CODE.fullmatch(code):
        # What the runner named as its reason: a closed identifier, so it may
        # travel with the job state even when the adapter does not forward it.
        record["runnerErrorCode"] = code
    secrets = sensitive_values(environment)
    log_body = _runner_log(runner_log, secrets, record)
    encoded = json.dumps(record, allow_nan=False, sort_keys=True).encode()
    if any(secret in encoded for secret in secrets):
        record = {"failed": True, "diagnosticOnly": True, "artifacts": [],
                  "diagnosticProjectionError": "mr_sensitive_diagnostic_withheld"}
        encoded = json.dumps(record, sort_keys=True).encode()
    if directory is None:
        return record
    facts = os.fstat(directory)
    if not stat.S_ISDIR(facts.st_mode) or facts.st_uid != os.geteuid() or facts.st_mode & 0o077 or os.listdir(directory):
        raise ValueError("unsafe diagnostic directory")
    kept_log = log_body if "runnerLog" in record else None
    if kept_log is not None:
        # The worker's own scratch file, not the analysis-writable stage: kept
        # even when the analysis group could not be confirmed stopped.
        inputs._write_new(directory, "runner.log", kept_log)
    inputs._write_new(directory, "diagnostic.json", encoded)
    if not artifacts_safe:
        record["artifactRetentionError"] = "mr_analysis_group_unconfirmed"
        return record
    total = len(encoded) + (len(kept_log) if kept_log is not None else 0)
    pairs = {}
    try:
        candidates = [(parts, size) for parts, size in _inventory(inputs, stage)
                      if len(parts) == 3 and parts[0] == "analysis-data" and parts[2] in _PLOTS | _NUMERIC_FILES]
        if len(candidates) > MAX_DIAGNOSTIC_FILES or sum(size for _, size in candidates) > MAX_DIAGNOSTIC_BYTES:
            raise ValueError("diagnostic inventory limit")
        for parts, size in candidates:
            if size > MAX_DIAGNOSTIC_FILE_BYTES:
                raise ValueError("diagnostic file limit")
            with inputs._regular_file(stage, parts) as source:
                with os.fdopen(os.dup(source), "rb") as stream:
                    body = stream.read(MAX_DIAGNOSTIC_FILE_BYTES + 1)
            if len(body) != size or any(secret in body for secret in secrets):
                raise ValueError("diagnostic body invalid")
            if parts[2] in _NUMERIC_FILES:
                body = _numeric_projection(body)
                if body is None:
                    continue
            elif not body.startswith(b"%PDF-" if parts[2].endswith(".pdf") else b"\x89PNG\r\n\x1a\n"):
                raise ValueError("diagnostic image format")
            total += len(body)
            if total > MAX_DIAGNOSTIC_BYTES:
                raise ValueError("diagnostic byte limit")
            name = pairs.setdefault(parts[1], f"pair-{len(pairs) + 1:03d}")
            if name not in os.listdir(directory):
                os.mkdir(name, mode=0o700, dir_fd=directory)
            with inputs.directory_fd(directory, (name,)) as parent:
                inputs._write_new(parent, parts[2], body)
            record["artifacts"].append({"name": f"{name}/{parts[2]}", "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(), "numericProjection": parts[2] in _NUMERIC_FILES})
    except (OSError, ValueError, csv.Error, inputs.MRInputError):
        record["artifactRetentionError"] = "mr_diagnostic_artifacts_invalid"
    os.fsync(directory)
    return record


@dataclass(frozen=True)
class Job:
    workspace: Path
    output_root: Path
    data_root: Path
    request: dict[str, Any]
    bindings: dict[str, Any]
    python: str
    runner: Path
    timeout: int = 10800


@contextmanager
def authority_pipe(snapshot: dict[str, Any]) -> Iterator[int]:
    """Give the child only a read end; never publish authority into /data."""
    payload = json.dumps(snapshot, ensure_ascii=False).encode("utf-8")
    if len(payload) > AUTHORITY_LIMIT:
        raise ValueError("MR input authority exceeds its size limit.")
    reader, writer = os.pipe()

    def send() -> None:
        try:
            with os.fdopen(writer, "wb") as stream:
                stream.write(payload)
        except BrokenPipeError:
            # The subprocess may fail before parsing its fixed input contract.
            return

    thread = threading.Thread(target=send, daemon=True)
    thread.start()
    try:
        yield reader
    finally:
        os.close(reader)
        thread.join(timeout=5)
        if thread.is_alive():
            raise RuntimeError("MR input authority channel did not close.")


def _read_result(inputs: Any, directory: int) -> dict[str, Any]:
    try:
        with inputs._regular_file(directory, ("result.json",)) as descriptor:
            with os.fdopen(os.dup(descriptor), "rb") as stream:
                raw = stream.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            raise ValueError("result size")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError("result shape")
        return result
    except (OSError, ValueError):
        return {"status": "failed", "error": "The fixed MR runner did not publish a valid result."}


def _target_is_current(inputs: Any, job: Job, workspace: int, output: int) -> None:
    parts = job.workspace.relative_to(job.data_root).parts
    output_parts = job.output_root.relative_to(job.workspace).parts
    with inputs.directory_fd(job.data_root, parts) as current:
        if inputs._identity(os.fstat(current), directory=True) != inputs._identity(
            os.fstat(workspace), directory=True
        ):
            raise inputs.MRInputError(
                "mr_input_changed", "The workspace changed during MR execution."
            )
        with inputs.directory_fd(current, output_parts) as target:
            if inputs._identity(os.fstat(target), directory=True) != inputs._identity(
                os.fstat(output), directory=True
            ):
                raise inputs.MRInputError(
                    "mr_input_changed", "The MR output directory changed during execution."
                )


def _inventory(
    inputs: Any, root: int, parts: tuple[str, ...] = ()
) -> list[tuple[tuple[str, ...], int]]:
    if len(parts) > 12:
        raise inputs.MRInputError(
            "mr_input_size_limit", "MR artifacts exceed the directory depth limit."
        )
    files = []
    with inputs.directory_fd(root, parts) as directory:
        for name in sorted(os.listdir(directory)):
            if name in {".", ".."} or "\\" in name or any(ord(char) < 32 for char in name):
                raise inputs.MRInputError("mr_input_path_invalid", "MR artifact names are invalid.")
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            relative = (*parts, name)
            if stat.S_ISDIR(info.st_mode):
                files.extend(_inventory(inputs, root, relative))
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                if info.st_size > inputs.MAX_INPUT_BYTES:
                    raise inputs.MRInputError(
                        "mr_input_size_limit", "An MR artifact exceeds its size limit."
                    )
                files.append((relative, info.st_size))
            else:
                raise inputs.MRInputError(
                    "mr_input_path_invalid", "MR artifacts must be ordinary files."
                )
            if len(files) > MAX_ARTIFACTS:
                raise inputs.MRInputError(
                    "mr_input_size_limit", "MR artifacts exceed the file count limit."
                )
    return files


def _publish(inputs: Any, source: int, output: int, prefix: Path) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    files = _inventory(inputs, source)
    if sum(size for _, size in files) > MAX_PUBLISHED_BYTES:
        raise inputs.MRInputError(
            "mr_input_size_limit", "MR artifacts exceed the total byte limit."
        )
    if os.listdir(output):
        raise inputs.MRInputError(
            "mr_input_changed", "The reserved MR output directory is no longer empty."
        )
    artifacts, receipts = [], []
    for parts, size in files:
        parent = os.dup(output)
        try:
            for name in parts[:-1]:
                try:
                    os.mkdir(name, mode=0o700, dir_fd=parent)
                except FileExistsError:
                    pass
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent)
                parent = child
            with inputs._regular_file(source, parts) as descriptor:
                before = inputs._identity(os.fstat(descriptor))
                hasher, copied = hashlib.sha256(), 0
                target = os.open(
                    parts[-1],
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=parent,
                )
                with os.fdopen(os.dup(descriptor), "rb") as src, os.fdopen(target, "wb") as dst:
                    while chunk := src.read(1024 * 1024):
                        copied += len(chunk)
                        if copied > size:
                            raise inputs.MRInputError("mr_input_changed", "An MR artifact changed during publication.")
                        hasher.update(chunk)
                        dst.write(chunk)
                    dst.flush()
                    os.fsync(dst.fileno())
                    if (copied != size or before != inputs._identity(os.fstat(descriptor))
                            or os.fstat(dst.fileno()).st_nlink != 1):
                        raise inputs.MRInputError("mr_input_changed", "An MR artifact changed during publication.")
            relative = prefix.joinpath(*parts)
            receipts.append({"path": relative.as_posix(), "bytes": copied, "sha256": hasher.hexdigest()})
            artifacts.append(
                {"kind": relative.suffix.lstrip(".") or "file", "path": relative.as_posix()}
            )
        finally:
            os.close(parent)
    return artifacts, receipts


def _scientific_rows(body: bytes, name: str) -> tuple[bytes, int]:
    """Project complete numerical rows; an unfinished primary row is never an estimate."""
    variants = name in {"selected-source-rows.csv", "harmonised-rows.csv", "open-exposure.csv", "open-outcome.csv"}
    allowed = (_NUMERIC_COLUMNS | {"samplesize", "samplesize.exposure", "samplesize.outcome", "beta.exposure", "beta.outcome",
                                  "se.exposure", "se.outcome", "pval.exposure", "pval.outcome", "eaf", "pval", "f_statistic"})
    reader = csv.DictReader(io.StringIO(body.decode("utf-8")), strict=True)
    headers = reader.fieldnames or []
    if not headers or len(headers) != len(set(headers)) or len(headers) > 128:
        raise ValueError("invalid columns")
    selected = [key for key in headers if key in allowed or key in {"SNP", "snp", "method"}]
    required = {"method", "nsnp", "b", "se", "pval"} if name == "mr_results.csv" else set()
    if required - set(headers) or not set(selected) & allowed:
        raise ValueError("incomplete numerical module")
    result = io.StringIO(newline="")
    writer = csv.DictWriter(result, fieldnames=selected, lineterminator="\n"); writer.writeheader()
    count = 0
    for row in reader:
        if count >= 5000 or None in row or any(row.get(key) is None for key in headers):
            raise ValueError("incomplete rows")
        projected = {}
        for key in selected:
            value = row[key].strip()
            if key == "method":
                if value not in _METHODS:
                    raise ValueError("unknown method")
            elif key in {"SNP", "snp"}:
                if not re.fullmatch(r"rs[0-9]{1,16}", value):
                    raise ValueError("unsafe variant identifier")
            elif value in {"", "NA", "NaN"}:
                if key in required:
                    raise ValueError("incomplete primary statistic")
            elif len(value) > 40 or not math.isfinite(float(value)):
                raise ValueError("invalid number")
            elif (key in {"se", "nsnp"} and float(value) <= 0) or (key in {"pval", "Q_pval"} and not 0 <= float(value) <= 1):
                raise ValueError("invalid statistic")
            projected[key] = value
        writer.writerow(projected); count += 1
    if not variants and count == 0:
        raise ValueError("no completed statistic")
    return result.getvalue().encode(), count


def _publish_partial_failure(inputs, stage, output, prefix, error_code, environment, *, artifacts_safe=True):
    """Publish only a fresh scientific projection after confirmed analysis quiescence.

    Logs, exception metadata, free text, plots and diagnostic receipts never enter
    this projection. The ordinary held-descriptor publisher still owns writes.
    """
    if not artifacts_safe:
        return [], []
    secrets = sensitive_values(environment)
    summary = {"schema_version": 1, "status": "partial", "primary_estimate_available": False,
               "original_error_code": error_code if isinstance(error_code, str) and _RUNNER_CODE.fullmatch(error_code) else "mr_analysis_failed",
               "available": [], "unavailable": []}
    try:
        with inputs._regular_file(stage, ("mendelian-randomization-open-sources.json",)) as descriptor:
            before = inputs._identity(os.fstat(descriptor))
            with os.fdopen(os.dup(descriptor), "rb") as stream:
                body = stream.read(256 * 1024 + 1)
            if len(body) > 256 * 1024 or before != inputs._identity(os.fstat(descriptor)) or any(secret in body for secret in secrets):
                raise ValueError("invalid source record")
        record = json.loads(body)
        if not isinstance(record, dict):
            raise ValueError("invalid source record")
        summary["source_accessions"] = [record[role]["accession"] for role in ("exposure", "outcome")
                                        if isinstance(record.get(role), dict) and re.fullmatch(r"GCST\d{6,9}", str(record[role].get("accession", "")))]
        selection = record.get("instrumentSelection") or {}
        if not isinstance(selection, dict):
            raise ValueError("invalid selection record")
        summary["selection"] = {key: selection[key] for key in ("genomeWideSignificantVariants", "afterClumping")
                                if type(selection.get(key)) is int and 0 <= selection[key] <= 10_000_000}
        if selection.get("stage") in {"candidates_before_clumping", "selected_after_clumping"}:
            summary["selection"]["stage"] = selection["stage"]
        if type(selection.get("ldChecked")) is bool:
            summary["selection"]["ldChecked"] = selection["ldChecked"]
    except (OSError, ValueError, TypeError, KeyError, inputs.MRInputError):
        pass
    try:
        candidates = [(parts, size) for parts, size in _inventory(inputs, stage)
                      if (len(parts) == 3 and parts[0] == "analysis-data" and parts[-1] in _NUMERIC_FILES | {"selected-source-rows.csv", "harmonised-rows.csv"})
                      or (len(parts) == 2 and parts[0] == "inputs" and parts[-1] in {"open-exposure.csv", "open-outcome.csv"})]
        if len(candidates) > MAX_DIAGNOSTIC_FILES or sum(size for _, size in candidates) > MAX_DIAGNOSTIC_BYTES:
            raise ValueError("bounded projection exceeded")
    except (OSError, ValueError, inputs.MRInputError):
        candidates = []
        summary["unavailable"].append("unsafe_or_oversized_source_artifacts")
    with tempfile.TemporaryDirectory(prefix="evimed-mr-partial-") as temporary:
        pairs = {}
        with inputs.directory_fd(Path(temporary)) as projection:
            for parts, size in candidates:
                try:
                    if size > MAX_DIAGNOSTIC_FILE_BYTES:
                        raise ValueError("file too large")
                    with inputs._regular_file(stage, parts) as source:
                        before = inputs._identity(os.fstat(source))
                        with os.fdopen(os.dup(source), "rb") as stream:
                            body = stream.read(MAX_DIAGNOSTIC_FILE_BYTES + 1)
                        if before != inputs._identity(os.fstat(source)) or len(body) != size or any(secret in body for secret in secrets):
                            raise ValueError("source changed or sensitive")
                    body, count = _scientific_rows(body, parts[-1])
                    pair = pairs.setdefault(parts[1] if parts[0] == "analysis-data" else "source", f"pair-{len(pairs) + 1:03d}")
                    if pair not in os.listdir(projection):
                        os.mkdir(pair, mode=0o700, dir_fd=projection)
                    with inputs.directory_fd(projection, (pair,)) as destination:
                        inputs._write_new(destination, parts[-1], body)
                    summary["available"].append({"path": f"{pair}/{parts[-1]}", "rows": count,
                                                 "scope": "validated_numeric_rows" if parts[-1] in _NUMERIC_FILES else "observed_source_or_harmonised_rows"})
                    if parts[-1] == "mr_results.csv":
                        summary["primary_estimate_available"] = True
                except (OSError, ValueError, UnicodeError, csv.Error, inputs.MRInputError):
                    summary["unavailable"].append(parts[-1])
            if not summary["available"]:
                return [], []
            summary["not_computed"] = [] if summary["primary_estimate_available"] else ["causal_effect_not_available"]
            inputs._write_new(projection, "partial-research.json", json.dumps(summary, indent=2).encode())
            text = ("# Partial Mendelian randomization results\n\nThe job failed. These are validated numerical projections of readable rows, not a completed research report.\n\n"
                    + ("A completed primary estimate is available.\n" if summary["primary_estimate_available"] else "No completed primary causal estimate is available; source or harmonized rows do not establish a causal result.\n")
                    + "\nUnlisted or unavailable modules were not verified as complete. Missing tests are not negative findings. Effect units, cohort overlap and analyzed ancestry proportions remain unknown unless separately documented.\n")
            text += "\n".join(f"- [{item['path']}]({item['path']}): {item['rows']} rows, {item['scope']}" for item in summary["available"])
            inputs._write_new(projection, "partial-research.md", text.encode())
            return _publish(inputs, projection, output, prefix)


@contextmanager
def _analysis_group(credentials):
    previous = os.getegid()
    try:
        if credentials is not None and "group" in credentials:
            os.setegid(credentials["group"])
        yield
    finally:
        if os.getegid() != previous:
            os.setegid(previous)


def _analysis_access(inputs, directory, *, owned_directories_only=False):
    # Only this private staging tree becomes accessible to the analysis group.
    # Root retains ownership; SETGID suffices, so CHOWN/DAC overrides stay absent.
    os.fchmod(directory, 0o770)
    for name in os.listdir(directory):
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if owned_directories_only and info.st_uid != os.geteuid():
            continue
        if stat.S_ISDIR(info.st_mode):
            with inputs.directory_fd(directory, (name,)) as child:
                _analysis_access(inputs, child, owned_directories_only=owned_directories_only)
        elif not owned_directories_only:
            with inputs._regular_file(directory, (name,)) as descriptor:
                os.fchmod(descriptor, 0o660)


class _AnalysisInterrupted(Exception):
    def __init__(self, signum):
        self.signum = signum


@contextmanager
def _worker_signals():
    previous = {}
    state = {"defer": False, "signum": None}
    if threading.current_thread() is threading.main_thread():
        def interrupted(signum, _frame):
            state["signum"] = signum
            if not state["defer"]:
                raise _AnalysisInterrupted(signum)
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, interrupted)
    try:
        yield state
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _analysis_helper(credentials, operation, arguments, *, descriptors=()):
    # This fixed helper imports no workspace code and receives no model/key env.
    # Its own alarm bounds cleanup/stop without granting CAP_KILL to the owner.
    return subprocess.run(
        [sys.executable, "-I", str(Path(__file__).resolve()), operation, *map(str, arguments)],
        env={"PATH": os.defpath}, pass_fds=descriptors,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        check=False, **credentials,
    ).returncode == 0


def _process_identity(pid):
    directory = Path("/proc") / str(pid)
    fields = (directory / "stat").read_text(errors="replace").rsplit(")", 1)[1].split()
    return {"pid": pid, "state": fields[0], "pgid": int(fields[2]),
            "session": int(fields[3]), "started": int(fields[19]),
            "uid": directory.stat().st_uid}


def _wait_without_reaping(process, timeout):
    deadline = time.monotonic() + timeout
    while True:
        result = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if result is not None:
            return result.si_status if result.si_code == os.CLD_EXITED else -result.si_status
        if time.monotonic() >= deadline:
            raise subprocess.TimeoutExpired(process.args, timeout)
        time.sleep(0.02)


def _run_analysis(command, credentials, timeout, **kwargs):
    if credentials is None:
        return subprocess.run(command, timeout=timeout, check=False, **kwargs), None
    with _worker_signals() as signal_state:
        process = subprocess.Popen(command, start_new_session=True, **kwargs, **credentials)
        identity = _process_identity(process.pid)
        if identity["pgid"] != process.pid or identity["session"] != process.pid:
            raise ValueError("The analysis process group is not isolated.")
        try:
            # Retain the exited leader until its group is stopped. This pins
            # the PID/PGID against reuse throughout this bounded stop window.
            code = _wait_without_reaping(process, timeout)
            interruption = None
            if code < 0:
                interruption = {"status": "failed", "errorCode": "mr_analysis_interrupted",
                                "error": "The analysis process was interrupted."}
        except (subprocess.TimeoutExpired, _AnalysisInterrupted) as error:
            timed_out = isinstance(error, subprocess.TimeoutExpired)
            code = 124 if timed_out else 128 + error.signum
            interruption = {"status": "failed",
                "errorCode": "mr_analysis_timeout" if timed_out else "mr_analysis_interrupted",
                "error": "The analysis timed out." if timed_out else "The analysis worker was interrupted."}
        # Every terminal path uses the saved group identity. Defer further
        # worker signals until group shutdown is confirmed and the leader reaped.
        signal_state["defer"] = True
        try:
            stopped = _analysis_helper(credentials, "--stop-analysis", [identity["pgid"], identity["started"]])
        except OSError:
            stopped = False
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            stopped = False
        if signal_state["signum"] and code == 0:
            code = 128 + signal_state["signum"]
            interruption = {"status": "failed", "errorCode": "mr_analysis_interrupted",
                            "error": "The analysis worker was interrupted."}
        if not stopped:
            code = code or 1
            interruption = {"status": "failed", "errorCode": "mr_analysis_stop_failed",
                            "error": "The analysis process group could not be stopped safely."}
        return subprocess.CompletedProcess(command, code), interruption


@contextmanager
def _private_directories(inputs, credentials, cleanup_errors):
    if credentials is None:
        with (tempfile.TemporaryDirectory(prefix="evimed-mr-job-", dir="/tmp") as stage,
              tempfile.TemporaryDirectory(prefix="evimed-mr-scratch-", dir="/tmp") as scratch):
            yield stage, scratch
        return
    owned = []
    try:
        for prefix in ("evimed-mr-job-", "evimed-mr-scratch-"):
            path = tempfile.mkdtemp(prefix=prefix, dir="/tmp")
            owned.append(path)
        yield tuple(owned)
    finally:
        # Keep private inputs intact if the process group was not confirmed stopped.
        if "process_running" not in cleanup_errors:
            for path in reversed(owned):
                try:
                    with inputs.directory_fd(Path(path)) as directory:
                        # Preparation can fail before group access is granted. The
                        # owner adjusts only its own private directories, never
                        # enters analysis-owned children or changes workspace/key access.
                        _analysis_access(inputs, directory, owned_directories_only=True)
                        if not _analysis_helper(credentials, "--cleanup-analysis", [directory], descriptors=(directory,)):
                            cleanup_errors.append(True)
                    # Owner removes only the top-level directory it created.
                    os.rmdir(path)
                except OSError:
                    cleanup_errors.append(True)


def _cleanup_error():
    return {"code": "mr_analysis_cleanup_failed", "message": "Temporary analysis data could not be fully removed."}


def execute(inputs: Any, job: Job, environment: dict[str, str], *, analysis_credentials=None, failure_directory=None) -> dict[str, Any]:
    cleanup_errors = []
    try:
        outcome = _execute(inputs, job, environment, analysis_credentials, cleanup_errors, failure_directory)
    except inputs.MRInputError as error:
        if cleanup_errors:
            error.cleanup_error = _cleanup_error()
        raise
    if cleanup_errors:
        outcome["cleanupError"] = _cleanup_error()
    return outcome


def _execute(inputs: Any, job: Job, environment: dict[str, str], analysis_credentials, cleanup_errors, failure_directory=None) -> dict[str, Any]:
    """Run in the adapter's private mount and publish through the original FD."""
    parts = job.workspace.relative_to(job.data_root).parts
    output_parts = job.output_root.relative_to(job.workspace).parts
    try:
        with _analysis_group(analysis_credentials), inputs.directory_fd(job.data_root, parts) as workspace:
            if inputs._identity(os.fstat(workspace), directory=True) != job.bindings.get(
                "workspace"
            ):
                raise inputs.MRInputError(
                    "mr_input_changed", "The workspace changed after MR admission."
                )
            with inputs.directory_fd(workspace, output_parts) as output:
                with _private_directories(inputs, analysis_credentials, cleanup_errors) as (temporary, scratch):
                    child_environment = {**environment, "TMPDIR": scratch}
                    if analysis_credentials is not None:
                        os.chmod(scratch, 0o770)
                        child_environment.update(HOME=scratch, MPLCONFIGDIR=str(Path(scratch) / "matplotlib"))
                    with inputs.directory_fd(Path(temporary)) as stage:
                        authority = {"request": copy.deepcopy(job.request), "sources": {}}
                        if inputs.validate_request(job.request):
                            authority = inputs.prepare_sources(
                                job.workspace,
                                Path(temporary),
                                job.request,
                                job.bindings,
                                job.data_root,
                                token_available=bool(environment.get("OPENGWAS_JWT", "").strip()),
                                output_directory_fd=stage,
                            )
                        inputs._write_new(
                            stage,
                            "request.json",
                            json.dumps(authority["request"], ensure_ascii=False).encode("utf-8"),
                        )
                        if analysis_credentials is not None:
                            _analysis_access(inputs, stage)
                        with (
                            authority_pipe(authority) as proof,
                            tempfile.TemporaryFile(dir=scratch) as log,
                        ):
                            command = [
                                job.python,
                                str(job.runner),
                                "--request",
                                "request.json",
                                "--output-dir",
                                ".",
                                "--input-authority-fd",
                                str(proof),
                                "--working-directory-fd",
                                str(stage),
                            ]
                            completed, interruption = _run_analysis(
                                command, analysis_credentials, job.timeout,
                                cwd=str(job.runner.parent),
                                env=child_environment,
                                pass_fds=(proof, stage),
                                stdin=subprocess.DEVNULL,
                                stdout=log,
                                stderr=subprocess.STDOUT,
                            )
                            try:
                                runner_log = _log_tail(log)
                            except OSError:
                                runner_log = None
                        if interruption and interruption.get("errorCode") == "mr_analysis_stop_failed":
                            cleanup_errors.append("process_running")
                        result = interruption or _read_result(inputs, stage)
                        if completed.returncode != 0 or result.get("status") != "succeeded":
                            try:
                                diagnostic = _retain_failure(
                                    inputs, stage, failure_directory, result, environment,
                                    artifacts_safe=not interruption or interruption.get("errorCode") != "mr_analysis_stop_failed",
                                    runner_log=runner_log,
                                )
                            except (OSError, ValueError, inputs.MRInputError):
                                diagnostic = {"failed": True, "diagnosticOnly": True,
                                              "retentionError": "mr_failure_diagnostic_retention_failed"}
                            partial, partial_receipts = [], []
                            artifacts_safe = not interruption or interruption.get("errorCode") != "mr_analysis_stop_failed"
                            if artifacts_safe:
                                if authority["sources"]:
                                    inputs.verify_published_inputs(authority["request"], Path(temporary), authority["sources"], output_directory_fd=stage)
                                _target_is_current(inputs, job, workspace, output)
                                partial, partial_receipts = _publish_partial_failure(
                                    inputs, stage, output, job.output_root.relative_to(job.workspace), result.get("errorCode"), environment,
                                )
                                _target_is_current(inputs, job, workspace, output)
                            return {
                                "returnCode": completed.returncode or 1,
                                "result": result,
                                "artifacts": partial,
                                "partialScientificReceipt": {"schemaVersion": 1, "files": partial_receipts} if partial else None,
                                "failureDiagnosticReceipt": diagnostic,
                            }
                        if authority["sources"]:
                            inputs.verify_published_inputs(
                                authority["request"],
                                Path(temporary),
                                authority["sources"],
                                output_directory_fd=stage,
                            )
                        _target_is_current(inputs, job, workspace, output)
                        artifacts, artifact_receipts = _publish(
                            inputs, stage, output, job.output_root.relative_to(job.workspace)
                        )
                        _target_is_current(inputs, job, workspace, output)
                        # These raw receipts come from the worker-held authority,
                        # not the standardized request or mutable workspace files.
                        # Only an uploaded file has bytes to receipt; an OpenGWAS or
                        # GWAS Catalog source is an identifier, and the open-data
                        # rows it produced are published with their own digests.
                        input_receipts = [
                            {key: source[key] for key in ("path", "bytes", "sha256")}
                            for source in authority["sources"].values()
                            if source.get("type") == "local_file"
                        ]
                        return {"returnCode": 0, "result": result, "artifacts": artifacts,
                                "inputReceipts": input_receipts, "artifactReceipts": artifact_receipts,
                                "analysisIsolated": analysis_credentials is not None}
    except inputs.MRInputError:
        raise
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise inputs.MRInputError(
            "mr_input_path_invalid", "The isolated MR job could not safely complete or publish."
        ) from None


def _remove_directory_contents(directory):
    """Restricted UID removes entries without following any child symlink."""
    for name in os.listdir(directory):
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            try:
                _remove_directory_contents(child)
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=directory)
        else:
            os.unlink(name, dir_fd=directory)


def _group_members(pgid, started):
    members = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            member = _process_identity(int(entry.name))
        except FileNotFoundError:
            continue
        if member["pgid"] == pgid and member["state"] not in {"Z", "X"}:
            if (member["uid"] != os.geteuid() or member["session"] != pgid
                    or member["started"] < started):
                raise ValueError("Analysis process group ownership changed.")
            members.append(member)
    return members


def _stop_analysis_group(pgid, started):
    try:
        leader = _process_identity(pgid)
    except FileNotFoundError:
        leader = None
    if leader is not None and (leader["started"] != started or leader["pgid"] != pgid):
        return False
    # The saved PGID remains usable after the leader disappears. In the normal
    # worker path WNOWAIT keeps that leader unreaped until this helper returns.
    for signum, seconds in ((signal.SIGTERM, 1.0), (signal.SIGKILL, 2.0)):
        if not _group_members(pgid, started):
            return True
        try:
            os.killpg(pgid, signum)
        except ProcessLookupError:
            return not _group_members(pgid, started)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not _group_members(pgid, started):
                return True
            time.sleep(0.02)
    return not _group_members(pgid, started)


def _helper_main():
    if len(sys.argv) not in {3, 4}:
        return 2
    signal.alarm(10)
    try:
        value = int(sys.argv[2])
        if sys.argv[1] == "--cleanup-analysis" and len(sys.argv) == 3:
            if not stat.S_ISDIR(os.fstat(value).st_mode):
                return 2
            _remove_directory_contents(value)
        elif sys.argv[1] == "--stop-analysis" and len(sys.argv) == 4 and value > 1:
            return 0 if _stop_analysis_group(value, int(sys.argv[3])) else 1
        else:
            return 2
        return 0
    except (OSError, ValueError):
        return 1


if __name__ == "__main__":
    raise SystemExit(_helper_main())
