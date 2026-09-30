"""Authenticated SaaS adapter for fixed-argument EviMed specialist runners.

The service derives project scope exclusively from a short-lived platform token,
launches one reviewed ``evimed_runner.py`` with fixed arguments, and publishes
only workspace-relative artifacts. It intentionally accepts no executable,
environment variable, absolute output path, or caller-supplied tenant scope.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from fastapi import Header, Body, FastAPI, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .mr_job_store import MRJobStore
from . import audit_receipt, engine_model, isolated_job, usage_report
from .security import _authorized_claims, _read_secret, _signing_secret


_SAFE_WORKSPACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$")
_STATE_LIMIT = 256 * 1024
_LOG_TAIL_LIMIT = 16 * 1024
_WORKERS: dict[str, subprocess.Popen[bytes]] = {}
#: How often a running job's state is rewritten while its engine works. A
#: poller tells a slow job from a dead one by `updatedAt`: on 2026-09-27 a
#: research-topic job PubMed was throttling still carried its start time after
#: fifteen minutes, was recorded as dead, and succeeded six minutes later.
_HEARTBEAT_SECONDS = 30.0
#: Where an engine that knows its own stage says so: `{"stage", "percent"}`.
_PROGRESS_ENV = "EVIMED_JOB_PROGRESS_FILE"
_PROGRESS_LIMIT = 4 * 1024
#: The failure codes a failed MR runner may hand the run: its closed families
#: and three named delivery codes. `mr_open_` is the token-free GWAS Catalog
#: path. Until it was added here (2026-09-28) every one of its refusals — a
#: PubMed id with two studies, a study EBI has no harmonised file for, the same
#: study on both sides — reached the run as "The fixed MR runner failed." with
#: no code, and three production jobs in a row read as a broken engine.
_MR_RUNNER_CODE = re.compile(r"mr_(?:input|analysis|open)_[a-z_]{1,80}")
_MR_RUNNER_NAMED_CODES = frozenset({
    "mr_interpretation_failed", "mr_interpretation_incomplete", "mr_plot_generation_failed",
    "analysis_failed", "no_instruments", "no_outcome_data", "insufficient_harmonised_snps", "ld_clumping_failed",
    "opengwas_auth_failed", "opengwas_rate_limited", "opengwas_unavailable", "mr_analysis_incomplete", "mr_no_instruments",
})
_MR_RUNNER_FAILED = "The fixed MR runner failed."
_MR_RUNNER_MESSAGE_LIMIT = 2000


SPECS: dict[str, dict[str, Any]] = {
    "mendelian-randomization": {
        "label": "Mendelian randomization",
        "endpoint": "/api/v1/evimed/mendelian-randomization",
        "prefix": "mr-",
        "directory": "mendelian-randomization-runs",
        "marker": "mr_agent/core/engine.py",
        "required": ("exposure", "outcome"),
        "inputs": (
            "exposure",
            "outcome",
            "outputLanguage",
            "analysisDirection",
            "exposureSource",
            "outcomeSource",
        ),
    },
    "bibliometric-analysis": {
        "label": "Bibliometric analysis",
        "endpoint": "/api/v1/evimed/bibliometric-analysis",
        "prefix": "bibliometric-",
        "directory": "bibliometric-analysis-runs",
        "marker": "src/bibliometric/pipeline.py",
        "required": ("topic",),
        "inputs": ("topic", "dateFrom", "dateTo", "maxRecords", "outputLanguage"),
    },
    "research-topic-selection": {
        "label": "Research topic selection",
        "endpoint": "/api/v1/evimed/research-topic-selection",
        "prefix": "topic-",
        "directory": "research-topic-runs",
        "marker": "services/task_service.py",
        "required": ("researchDirection",),
        "inputs": (
            "researchDirection",
            "outputLanguage",
            "availableData",
            "population",
            "studySetting",
            "resourceConstraints",
        ),
    },
    "peer-review": {
        "label": "Peer review",
        "endpoint": "/api/v1/evimed/peer-review",
        "prefix": "review-",
        "directory": "peer-review-runs",
        "marker": "src/main_v2.py",
        "required": ("manuscript",),
        "inputs": ("manuscript", "articleType", "outputLanguage"),
    },
    "drug-safety-analysis": {
        "label": "Drug safety analysis",
        "endpoint": "/api/v1/evimed/drug-safety-analysis",
        "prefix": "safety-",
        "directory": "drug-safety-runs",
        "marker": "safety_agent/analysis/pipeline.py",
        "required": ("drug",),
        "inputs": (
            "drug",
            "reactions",
            "outputLanguage",
            "drugAliases",
            "suspectRoles",
            "administrationRoutes",
            "studyDateFrom",
            "studyDateTo",
            "backgroundDateFrom",
            "backgroundDateTo",
        ),
    },
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _job_id(arguments: dict[str, Any], spec: dict[str, Any]) -> str:
    requested = arguments.get("jobId")
    if requested is None:
        return f"{spec['prefix']}{time.strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(6)}"
    if not isinstance(requested, str) or not re.fullmatch(
        re.escape(spec["prefix"]) + r"[a-z0-9-]{8,80}", requested
    ):
        raise ValueError(
            "jobId must use the specialist prefix and contain only lowercase letters, numbers, and hyphens"
        )
    return requested


def _kind() -> str:
    kind = os.getenv("EVIMED_SPECIALIST_KIND", "").strip()
    if kind not in SPECS:
        raise RuntimeError("EVIMED_SPECIALIST_KIND is not a supported specialist")
    return kind


def _spec() -> dict[str, Any]:
    return SPECS[_kind()]


def _accepted_start_inputs() -> list[str]:
    inputs = [*_spec()["inputs"]]
    if _kind() == "research-topic-selection":
        inputs.append("jobId")
    return inputs


def _agent_root() -> Path:
    root = Path(os.getenv("EVIMED_AGENT_ROOT", "/agent"))
    if not root.is_absolute() or "\0" in str(root):
        raise RuntimeError("invalid specialist root")
    resolved = root.resolve()
    spec = _spec()
    if (
        not resolved.is_dir()
        or not (resolved / spec["marker"]).is_file()
        or not (resolved / "evimed_runner.py").is_file()
    ):
        raise RuntimeError("specialist source is unavailable")
    return resolved


def _no_symlink_tree(root: Path, target: Path) -> None:
    root = root.resolve()
    target = target.absolute()
    if target != root and root not in target.parents:
        raise ValueError("workspace path escaped the EviMed data root")
    current = root
    for part in target.relative_to(root).parts:
        current = current / part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("symbolic links are not allowed in workspace paths")
    if target.resolve() != target:
        raise ValueError("symbolic links are not allowed in workspace paths")


def workspace_for_claims(claims: dict[str, Any], data_root: str | Path | None = None) -> Path:
    root = Path(data_root or os.getenv("EVIMED_DATA_ROOT", "/data")).resolve()
    base = root / "users" / claims["userId"] / "projects" / claims["projectId"] / "workspace"
    try:
        _no_symlink_tree(root, base)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail="EviMed project workspace not found") from exc
    active = ""
    project_file = base.parent / "project.json"
    if project_file.exists():
        if project_file.is_symlink() or project_file.stat().st_size > 128 * 1024:
            raise HTTPException(status_code=400, detail="Invalid EviMed project metadata")
        try:
            active = str(json.loads(project_file.read_text(encoding="utf-8")).get("activeWorkspace") or "")
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail="Invalid EviMed project metadata") from exc
        if active and not _SAFE_WORKSPACE.fullmatch(active):
            raise HTTPException(status_code=400, detail="Invalid active workspace")
    workspace = base / active if active else base
    try:
        _no_symlink_tree(root, workspace)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=404, detail="Active EviMed workspace not found") from exc
    return workspace


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and path.is_symlink():
        raise RuntimeError("job state must not be a symbolic link")
    payload = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
    if len(payload) > _STATE_LIMIT:
        raise RuntimeError("job state exceeded its size limit")
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def _mr_store() -> MRJobStore:
    return MRJobStore(Path(os.getenv("EVIMED_DATA_ROOT", "/data")), _mr_inputs())


def _read_state(state_path: Path) -> dict[str, Any]:
    if _kind() == "mendelian-randomization":
        return _mr_store().read(state_path)
    return _read_json(state_path)


def _write_state(
    state_path: Path, state: dict[str, Any], *, create: bool = False
) -> None:
    if _kind() == "mendelian-randomization":
        _mr_store().write(state_path, state, create=create)
    else:
        _atomic_json(state_path, state)


def _read_json(path: Path) -> dict[str, Any]:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size <= 0 or before.st_size > _STATE_LIMIT:
            raise RuntimeError("invalid job state")
        raw = os.read(descriptor, _STATE_LIMIT + 1)
        after = os.fstat(descriptor)
        if (
            len(raw) > _STATE_LIMIT
            or before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
        ):
            raise RuntimeError("job state changed while it was read")
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise RuntimeError("invalid job state")
        return value
    finally:
        os.close(descriptor)


def _moment(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def _seconds_since(value: Any, now: datetime) -> int | None:
    moment = _moment(value)
    return None if moment is None else max(0, int((now - moment).total_seconds()))


def _liveness(state: dict[str, Any]) -> dict[str, Any]:
    """What a poller needs to tell a slow job from a dead one."""
    now = datetime.now(timezone.utc)
    facts: dict[str, Any] = {
        "updatedAt": state.get("updatedAt"),
        "heartbeatSeconds": int(_HEARTBEAT_SECONDS),
    }
    for key, moment in (("secondsSinceUpdate", "updatedAt"), ("elapsedSeconds", "createdAt")):
        seconds = _seconds_since(state.get(moment), now)
        if seconds is not None:
            facts[key] = seconds
    if isinstance(state.get("progress"), dict):
        facts["progress"] = state["progress"]
    return facts


def _engine_progress(path: Path | None) -> dict[str, Any] | None:
    """The engine's own `{"stage", "percent"}`, when it reports one; None otherwise."""
    if path is None:
        return None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= _PROGRESS_LIMIT:
            return None
        value = json.loads(os.read(descriptor, _PROGRESS_LIMIT + 1).decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    finally:
        os.close(descriptor)
    stage = value.get("stage") if isinstance(value, dict) else None
    if not isinstance(stage, str) or not stage.strip() or len(stage) > 200 or not stage.isprintable():
        return None
    progress: dict[str, Any] = {"stage": stage.strip()}
    if type(value.get("percent")) is int and 0 <= value["percent"] <= 100:
        progress["percent"] = value["percent"]
    return progress


def _log_line(log_path: Path | None, text: str) -> None:
    if log_path is None:
        return
    try:
        descriptor = os.open(
            log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600
        )
        with os.fdopen(descriptor, "ab", buffering=0) as log:
            log.write(f"\n{text}\n".encode("utf-8"))
    except OSError:
        pass


@contextmanager
def _heartbeat(
    state_path: Path,
    state: dict[str, Any],
    *,
    read: Callable[[Path], dict[str, Any]],
    write: Callable[[Path, dict[str, Any]], None],
    progress_path: Path | None = None,
) -> Iterator[None]:
    """Advance a running job's `updatedAt` while its engine works.

    The state keeps one writer at a time: the worker writes before this starts
    and after it has stopped, and the status handler writes only for a worker
    that is gone. Each beat still re-reads first and stops as soon as the state
    on disk is not this worker's running job, so a beat does not revive a job
    someone else has ended; the MR store refuses that write under its lock. A
    beat that cannot be written stops the heartbeat and says why in the job
    log; the engine goes on and the job ends as it would have.
    """
    stop = threading.Event()
    pid = os.getpid()
    log_path = state_path.with_suffix(".log")

    def beat() -> None:
        while not stop.wait(_HEARTBEAT_SECONDS):
            try:
                current = read(state_path)
                if current.get("status") != "running" or current.get("workerPid") != pid:
                    return
                state["updatedAt"] = _now()
                elapsed = _seconds_since(state.get("createdAt"), datetime.now(timezone.utc))
                if elapsed is not None:
                    state["elapsedSeconds"] = elapsed
                progress = _engine_progress(progress_path)
                if progress is not None:
                    state["progress"] = progress
                write(state_path, state)
            except Exception as error:  # noqa: BLE001 — the engine keeps running; the log says why the state stopped advancing
                _log_line(log_path, f"heartbeat stopped: {type(error).__name__}: {error}")
                return

    thread = threading.Thread(target=beat, name="evimed-job-heartbeat", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join()


def _error(
    code: str,
    message: str,
    retryable: bool = False,
    next_actions: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "status": "error",
        "summary": message,
        "next_actions": next_actions
        or ["Correct the reported specialist precondition before retrying."],
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
            "stopReason": "Stop until the specialist precondition is satisfied.",
        },
    }


def _source(job_id: str) -> dict[str, str]:
    return {
        "id": f"{_kind()}:{job_id}",
        "source": _spec()["label"],
        "retrievedAt": _now(),
    }


class MRInputSupportUnavailable(ValueError):
    """A missing reviewed helper is a recoverable deployment dependency."""

    code = "specialist_agent_unavailable"


def _mr_inputs(root: Path | None = None) -> Any:
    """Load the fixed dependency-free helper from the reviewed MR source tree."""
    try:
        location = (root or _agent_root()) / "evimed_local_inputs.py"
        spec = importlib.util.spec_from_file_location(
            "evimed_managed_mr_inputs", location
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("missing loader")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:
        raise MRInputSupportUnavailable(
            "Managed MR input support is unavailable."
        ) from None


def _mr_job(root: Path) -> Any:
    try:
        spec = importlib.util.spec_from_file_location(
            "evimed_managed_mr_job", root / "evimed_mr_job.py"
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("missing loader")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:
        raise MRInputSupportUnavailable(
            "Managed MR execution support is unavailable."
        ) from None


def _source_evidence(root: Path) -> dict[str, Any]:
    """The whole auditable engine tree and this adapter, hashed one way for every engine.

    The same evidence a worker observation carries and a clean checkout recomputes
    (audit_receipt.current_evidence). It used to be three files for every
    engine but MR, which no verifier could reproduce, so only MR could ever be
    certified.
    """
    return audit_receipt.current_evidence(root)


def _job_paths(workspace: Path, job_id: str) -> tuple[Path, Path]:
    spec = _spec()
    pattern = re.compile(rf"^{re.escape(spec['prefix'])}[a-z0-9-]{{8,80}}$")
    if not pattern.fullmatch(job_id):
        raise ValueError("invalid specialist job id")
    if _kind() == "mendelian-randomization":
        return _mr_store().paths(workspace, job_id)
    root = workspace / spec["directory"] / ".jobs"
    if root.exists():
        _no_symlink_tree(workspace, root)
    return root / f"{job_id}.json", root / f"{job_id}.log"


def _ensure_directory(workspace: Path, target: Path) -> None:
    target.mkdir(parents=False, exist_ok=True, mode=0o700)
    _no_symlink_tree(workspace, target)


def _workspace_file(workspace: Path, value: Any) -> Path:
    raw = str(value or "").strip()
    if not raw or os.path.isabs(raw) or "\0" in raw:
        raise ValueError("manuscript must be a workspace-relative path")
    target = workspace / raw
    try:
        _no_symlink_tree(workspace, target)
    except (FileNotFoundError, ValueError) as exc:
        raise ValueError("manuscript is unavailable") from exc
    resolved = target.resolve()
    if not resolved.is_file() or resolved.suffix.casefold() not in {".pdf", ".docx", ".txt", ".md"}:
        raise ValueError("manuscript must be a supported managed file")
    return resolved


def _validated_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        raise ValueError("request body must be a JSON object")
    action = arguments.get("action")
    if action not in {"capabilities", "start", "status"}:
        raise ValueError("action must be capabilities, start, or status")
    spec = _spec()
    if action == "capabilities":
        allowed = {"action"}
    elif action == "start":
        allowed = {"action", *spec["inputs"]}
        if _kind() == "research-topic-selection":
            allowed.add("jobId")
    else:
        allowed = {"action", "jobId", "waitSeconds"}
    if set(arguments) - allowed:
        raise ValueError("request contains unsupported fields")
    if action == "start":
        if "jobId" in arguments:
            _job_id(arguments, spec)
        if _kind() == "mendelian-randomization":
            _mr_inputs().validate_request(arguments)
        if _kind() == "research-topic-selection":
            for key, limit in (("researchDirection", 4000), ("availableData", 4000), ("population", 1000), ("studySetting", 1000)):
                if key in arguments and (not isinstance(arguments[key], str) or not arguments[key].strip() or len(arguments[key]) > limit):
                    raise ValueError(f"{key} must be a nonempty string of at most {limit} characters")
            if "resourceConstraints" in arguments:
                value = arguments["resourceConstraints"]
                if not isinstance(value, list) or len(value) > 20 or any(
                    not isinstance(item, str) or not item.strip() or len(item) > 200 for item in value
                ):
                    raise ValueError("resourceConstraints must be at most 20 nonempty strings of at most 200 characters")
        for required in spec["required"]:
            if not str(arguments.get(required) or "").strip():
                raise ValueError(f"{required} is required")
    if action == "status" and not str(arguments.get("jobId") or "").strip():
        raise ValueError("jobId is required")
    if (
        action == "start"
        and _kind() == "bibliometric-analysis"
        and "maxRecords" in arguments
        and (
            type(arguments["maxRecords"]) is not int
            or not 20 <= arguments["maxRecords"] <= 5000
        )
    ):
        raise ValueError("maxRecords must be an integer from 20 through 5000")
    if "waitSeconds" in arguments and (
        type(arguments["waitSeconds"]) is not int
        or not 0 <= arguments["waitSeconds"] <= 60
    ):
        raise ValueError("waitSeconds must be an integer from 0 through 60")
    for key, value in arguments.items():
        if isinstance(value, str) and len(value) > 4000:
            raise ValueError(f"{key} is too long")
        if isinstance(value, list) and (
            len(value) > 50 or any(not isinstance(item, str) or not item.strip() or len(item) > 200 for item in value)
        ):
            raise ValueError(f"{key} contains an invalid list")
    return {key: arguments[key] for key in arguments if arguments[key] is not None}


def _model_ready() -> bool:
    try:
        # Through the gateway a job's credential is issued per job, so this
        # container needs no provider key; directly, it needs the mounted one.
        if engine_model.enabled():
            engine_model.token_url()
        else:
            _read_secret(os.getenv("LLM_API_KEY_FILE", "").strip())
        root = _agent_root()
        if _kind() == "mendelian-randomization" and not all(
            (root / name).is_file()
            for name in ("evimed_local_inputs.py", "evimed_mr_job.py")
        ):
            raise RuntimeError("Managed MR input support is unavailable.")
        _signing_secret()
        if _kind() == "drug-safety-analysis":
            _read_secret(os.getenv("EVIMED_EVIDENCE_SEARCH_KEY_FILE", "").strip())
    except (OSError, UnicodeDecodeError, RuntimeError):
        return False
    return os.getenv("LLM_MODEL", "").strip() == "deepseek-flash"


# The connectors this adapter's engine reads directly, outside the control
# plane's public-source gateway, keyed by the environment variable the engine
# expects. Every other source goes through the gateway, which applies the same
# precedence — deployment first, then the researcher's own — without our help.
_JOB_CONNECTOR_ENV = {"mendelian-randomization": {"opengwas": "OPENGWAS_JWT"}}
_JOB_ENV_PREFIX = "EVIMED_JOB_CREDENTIAL_"


def _job_credentials(workload_token: str | None) -> dict[str, str]:
    """Credentials for one job, resolved from the control plane for the workload that asked.

    Asked with the runtime's own workload token while it is still valid, and
    handed to the worker only through its spawn environment: the value never
    reaches the queued state file. A control plane without the endpoint, or a
    connector nobody configured, leaves the engine on this container's own
    environment exactly as before.
    """
    wanted = _JOB_CONNECTOR_ENV.get(_kind(), {})
    url = os.getenv("EVIMED_CONNECTOR_CREDENTIAL_URL", "").strip()
    if not wanted or not url or not workload_token:
        return {}
    resolved: dict[str, str] = {}
    for connector, env_name in wanted.items():
        request = urllib.request.Request(
            f"{url}?connector={connector}",
            headers={"accept": "application/json", "Authorization": f"Bearer {workload_token}"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 — operator-configured internal URL
                payload = json.loads(response.read(64 * 1024).decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError, TimeoutError):
            continue
        value = payload.get("data", {}).get("value") if isinstance(payload, dict) else None
        if isinstance(value, str) and value and len(value) <= 8 * 1024 and not re.search(r"[\r\n\0\s]", value):
            resolved[f"{_JOB_ENV_PREFIX}{env_name}"] = value
    return resolved


_OPENGWAS_NEXT_ACTIONS = [
    "Without an OpenGWAS token, start with both sources from the open GWAS Catalog: "
    'exposureSource and outcomeSource as {"type": "gwas_catalog", "accession": "GCST..."} '
    '(or {"type": "gwas_catalog", "pubmedId": "..."} for a paper with one such study), '
    "forward direction; or two uploaded GWAS files with declared preclumped instruments.",
    "Tell the researcher OpenGWAS itself is blocked: a token is saved under 账户→连接器 "
    "(issued at api.opengwas.io, valid 14 days) or set by the operator as "
    "OPEN_SCIENCE_OPENGWAS_JWT; do not retry an OpenGWAS request without one.",
]


def _open_data_sources() -> list[str]:
    """The open repositories this engine reads with no credential at all."""
    try:
        return [str(name) for name in getattr(_mr_inputs(), "OPEN_DATA_SOURCES", ())]
    except MRInputSupportUnavailable:
        return []


def _opengwas_state(job_credentials: dict[str, str] | None = None) -> dict[str, Any]:
    """OpenGWAS readiness for one caller: their own token first, else the deployment's.

    The same precedence the worker applies (`_child_environment`), so admission
    and execution judge the same token. Nothing here calls OpenGWAS.
    """
    own = (job_credentials or {}).get(f"{_JOB_ENV_PREFIX}OPENGWAS_JWT", "")
    deployment = os.getenv("OPENGWAS_JWT", "")
    state = _mr_inputs().opengwas_credential_state(own or deployment)
    source = "account" if own else ("deployment" if deployment.strip() else "none")
    return {**state, "source": source}


def _start(
    arguments: dict[str, Any],
    workspace: Path,
    job_credentials: dict[str, str] | None = None,
    owner: dict[str, str] | None = None,
    workload_token: str | None = None,
    execution_context: dict | None = None,
) -> dict[str, Any]:
    if not _model_ready():
        return _error(
            "specialist_model_config_unavailable",
            "DeepSeek V4.1 Flash or the specialist credential boundary is unavailable.",
            True,
        )
    spec = _spec()
    request = {key: arguments[key] for key in spec["inputs"] if key in arguments}
    # What the worker record binds the job to: the request exactly as the caller
    # sent it, before a manuscript path is resolved inside the workspace.
    try:
        request_sha256 = audit_receipt.digest(audit_receipt.canonical(request))
    except ValueError:
        request_sha256 = None  # noncanonical input cannot produce a canonical observation
    if _kind() == "mendelian-randomization":
        # A job that can only fail for want of OpenGWAS is refused here, by
        # name, instead of being queued to fail inside the engine.
        helper = _mr_inputs()
        try:
            helper.require_admission_credential(request, _opengwas_state(job_credentials))
        except helper.MRInputError as error:
            return _error(
                error.code,
                str(error),
                next_actions=(
                    _OPENGWAS_NEXT_ACTIONS
                    if error.code == "mr_input_remote_auth_required"
                    else None
                ),
            )
    if _kind() == "peer-review":
        try:
            request["manuscript"] = str(
                _workspace_file(workspace, request.get("manuscript"))
            )
        except ValueError as exc:
            return _error("specialist_input_path_invalid", str(exc))
    input_bindings = None
    if _kind() == "mendelian-randomization":
        helper = _mr_inputs()
        try:
            input_bindings = helper.capture_bindings(
                workspace, request, Path(os.getenv("EVIMED_DATA_ROOT", "/data"))
            )
        except helper.MRInputError as error:
            return _error(error.code, str(error))
    job_id = _job_id(arguments, spec)
    # With the lever on, the job's model calls go through the gateway under a
    # credential issued for this job alone. Asked for before anything is
    # reserved on disk, so a refusal leaves nothing behind.
    model_credentials: dict[str, str] = {}
    if engine_model.enabled():
        try:
            model_credentials = engine_model.request_credential(
                url=engine_model.token_url(),
                secret=_signing_secret(),
                workload_token=workload_token,
                kind=_kind(),
                job_id=job_id,
                execution_context=execution_context,
            )
        except (engine_model.EngineModelUnavailable, OSError, RuntimeError, UnicodeDecodeError) as error:
            return _error(
                "specialist_model_gateway_unavailable",
                f"The model gateway did not admit this job: {error}.",
                True,
            )
    run_root = workspace / spec["directory"]
    queue_record = None
    if _kind() == "mendelian-randomization":
        try:
            store = _mr_store()
            queue_record = store.scope(workspace, create=True)
            if (
                input_bindings["workspace"]
                != queue_record["context"]["identity"]["workspace"]
            ):
                raise ValueError("MR workspace changed before admission.")
            state_path, _ = store.paths(workspace, job_id, record=queue_record)
            output_root = store.reserve_output(queue_record, job_id)
        except FileExistsError:
            return _error(
                "specialist_job_id_conflict", "jobId already exists in this project."
            )
        except (OSError, ValueError):
            return _error(
                "specialist_worker_unavailable",
                "The protected MR queue or workspace scope is unavailable.",
                True,
            )
    else:
        state_path, _ = _job_paths(workspace, job_id)
        if (run_root / job_id).exists() or state_path.exists():
            return _error(
                "specialist_job_id_conflict",
                "jobId already exists in this project workspace.",
            )
        for target in (
            run_root,
            run_root / ".jobs",
            run_root / job_id,
            run_root / job_id / "output",
        ):
            _ensure_directory(workspace, target)
        output_root = run_root / job_id / "output"
    root = _agent_root()
    state = {
        "schemaVersion": 2 if queue_record is not None else 1,
        "kind": _kind(),
        **(
            {
                "queueContext": queue_record["context"],
                "queueGeneration": queue_record["generation"],
            }
            if queue_record is not None
            else {}
        ),
        "jobId": job_id,
        "status": "queued",
        "request": request,
        **({"mrInputBindings": input_bindings} if input_bindings is not None else {}),
        "workspace": str(workspace),
        "outputRoot": str(output_root),
        "sourceEvidence": _source_evidence(root),
        # Whose spend this job is, from the token that admitted it: the usage
        # report at the end names the account and project, and by then the
        # token is long expired. MR carries the same in its queue context.
        **({"owner": owner} if owner and queue_record is None else {}),
        **({"requestSha256": request_sha256} if queue_record is None and request_sha256 else {}),
        # How the engine reaches the model; never the credential itself.
        **({"modelRoute": "gateway"} if model_credentials else {}),
        **({"modelPolicy": json.loads(model_credentials[engine_model.POLICY_ENV])} if engine_model.POLICY_ENV in model_credentials else {}),
        "createdAt": _now(),
        "updatedAt": _now(),
        "artifacts": [],
    }
    try:
        _write_state(state_path, state, create=True)
    except (OSError, ValueError):
        if _kind() != "mendelian-randomization":
            raise
        return _error(
            "specialist_worker_unavailable",
            "The protected MR queue changed before admission.",
            True,
        )
    try:
        worker = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "evimed_specialist_adapter.service",
                "--run-job",
                str(state_path),
            ],
            cwd=str(Path(__file__).resolve().parents[1]),
            env={**os.environ, **(job_credentials or {}), **model_credentials},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        _WORKERS[job_id] = worker
    except OSError:
        state.update(
            {
                "status": "failed",
                "updatedAt": _now(),
                "error": "Specialist worker could not start.",
            }
        )
        _write_state(state_path, state)
        return _error(
            "specialist_worker_unavailable", "Specialist worker could not start.", True
        )
    return {
        "status": "warning",
        "summary": f"{spec['label']} job {job_id} has started.",
        "data": {"jobId": job_id, "jobStatus": "queued"},
        "sources": [_source(job_id)],
        "warnings": [
            "The specialist analysis is still running; interim files are not final results."
        ],
        "next_actions": [
            "Poll this specialist with action=status and the returned jobId."
        ],
    }


def _log_tail(path: Path) -> str:
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        size = os.fstat(descriptor).st_size
        os.lseek(descriptor, max(0, size - _LOG_TAIL_LIMIT), os.SEEK_SET)
        return os.read(descriptor, _LOG_TAIL_LIMIT).decode("utf-8", errors="replace")[-2000:]
    except OSError:
        return ""
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _managed_worker_alive(job_id: str, state_path: Path, state: dict[str, Any]) -> bool:
    worker = _WORKERS.get(job_id)
    if worker is not None:
        if worker.poll() is None:
            return True
        _WORKERS.pop(job_id, None)
        return False
    worker_pid = state.get("workerPid")
    if type(worker_pid) is not int or worker_pid <= 1:
        return False
    try:
        command = Path(f"/proc/{worker_pid}/cmdline").read_bytes().split(b"\0")
    except OSError:
        return False
    return (
        (
            str(Path(__file__).resolve()).encode() in command
            or (b"-m" in command and b"evimed_specialist_adapter.service" in command)
        )
        and b"--run-job" in command
        and str(state_path.resolve()).encode() in command
    )


def _status(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    job_id = str(arguments.get("jobId") or "")
    try:
        state_path, log_path = _job_paths(workspace, job_id)
        state = _read_state(state_path)
    except MRInputSupportUnavailable as error:
        return _error(error.code, str(error), True)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError):
        return _error(
            "specialist_job_unavailable", "The requested specialist job is unavailable."
        )
    if (
        state.get("kind") != _kind()
        or state.get("jobId") != job_id
        or Path(state.get("workspace", "")).absolute() != workspace.absolute()
    ):
        return _error("specialist_job_state_invalid", "The specialist job state is invalid.")
    job_status = state.get("status")
    if job_status in {"queued", "running"}:
        if _managed_worker_alive(job_id, state_path, state):
            return {
                "status": "warning",
                "summary": f"{_spec()['label']} job {job_id} is {job_status}.",
                "data": {"jobId": job_id, "jobStatus": job_status, **_liveness(state)},
                "sources": [_source(job_id)],
                "warnings": ["The specialist analysis is incomplete; do not draw final conclusions."],
                "next_actions": ["Poll this job again after additional processing time."],
            }
        try:
            refreshed = _read_state(state_path)
        except (OSError, RuntimeError, json.JSONDecodeError):
            refreshed = state
        if refreshed.get("status") not in {"queued", "running"}:
            state = refreshed
            job_status = state.get("status")
        else:
            state.update({
                "status": "failed",
                "updatedAt": _now(),
                "finishedAt": _now(),
                "retryable": True,
                "error": "The specialist worker stopped before publishing a terminal result.",
            })
            try:
                _write_state(state_path, state)
            except ValueError:
                if _kind() != "mendelian-randomization":
                    raise
                state = _read_state(state_path)
                if state.get("status") not in {"succeeded", "failed"}:
                    raise
            job_status = state["status"]
    worker = _WORKERS.pop(job_id, None)
    if worker is not None:
        try:
            worker.wait(timeout=1)
        except subprocess.TimeoutExpired:
            _WORKERS[job_id] = worker
    cleanup = state.get("cleanupError") if _kind() == "mendelian-randomization" else None
    if job_status == "failed":
        message = str(state.get("error") or f"{_spec()['label']} execution failed.")
        if _kind() == "mendelian-randomization":
            # No `data` on an error: the runtime's tool contract refuses it and
            # turned this failure into `adapter_contract_failure`, hiding the
            # engine's own code from the run. The cleanup note goes in the text.
            if cleanup:
                message = f"{message} Cleanup: {cleanup.get('message') or cleanup.get('code') or 'incomplete'}."
            failure = _error(
                state.get("errorCode") or "specialist_execution_failed",
                message,
                bool(state.get("retryable")),
            )
            if state.get("partialScientificReceipt") and state.get("artifacts"):
                failure["artifacts"] = state["artifacts"]
                failure["warnings"] = ["Partial scientific outputs from an incomplete MR job; uncomputed or skipped modules are not negative findings."]
                failure["next_actions"] = ["Preserve the published numerical/source projections and report only their stated available scope."]
            return failure
        tail = _log_tail(log_path)
        if tail:
            message = f"{message} Log tail: {tail}"
        failure = _error("specialist_execution_failed", message, bool(state.get("retryable")))
        if state.get("artifacts"):
            failure["artifacts"] = state["artifacts"]
            failure["warnings"] = ["These are partial outputs from a failed job; verify their scope before drawing conclusions."]
            failure["next_actions"] = ["Preserve and inspect the available partial outputs; repair only the failed or missing work."]
            failure["error"]["stopReason"] = "The failed step is incomplete; available partial outputs remain usable after review."
        return failure
    if job_status != "succeeded":
        return _error("specialist_job_state_invalid", "The specialist job state is invalid.")
    finished = _moment(state.get("finishedAt"))
    elapsed = _seconds_since(state.get("createdAt"), finished) if finished else None
    return {
        "status": "success",
        "summary": f"{_spec()['label']} job {job_id} completed.",
        "data": {"jobId": job_id, "jobStatus": "succeeded",
                 **({"elapsedSeconds": elapsed} if elapsed is not None else {}),
                 **({"cleanupError": cleanup} if cleanup else {}),
                 **({"auditReceipt": state["auditReceipt"]} if state.get("auditReceipt") else {})},
        "sources": [_source(job_id)],
        "artifacts": state.get("artifacts") or [],
        **({"warnings": [cleanup["message"]]} if cleanup else {}),
    }


def call(
    arguments: dict[str, Any],
    workspace: Path,
    job_credentials: dict[str, str] | None = None,
    owner: dict[str, str] | None = None,
    workload_token: str | None = None,
    execution_context: dict | None = None,
) -> dict[str, Any]:
    action = arguments["action"]
    if action == "capabilities":
        if not _model_ready():
            return _error(
                "specialist_model_config_unavailable",
                "DeepSeek V4.1 Flash or the specialist credential boundary is unavailable.",
                True,
            )
        opengwas = (
            _opengwas_state(job_credentials)
            if _kind() == "mendelian-randomization"
            else None
        )
        result = {
            "status": "success",
            "summary": f"{_spec()['label']} is configured for managed EviMed SaaS execution.",
            "data": {
                "available": True,
                "model": "deepseek-flash",
                "thinking": True,
                **(
                    {"acceptedStartInputs": _accepted_start_inputs()}
                    if _kind()
                    in {"research-topic-selection", "mendelian-randomization"}
                    else {}
                ),
                **({"opengwas": opengwas} if opengwas is not None else {}),
            },
            "sources": [_source("service")],
        }
        if _kind() == "mendelian-randomization":
            result["data"]["openDataSources"] = _open_data_sources()
        if opengwas is not None and not opengwas["ready"]:
            # The capability's own first step reads this: OpenGWAS data and
            # online clumping are blocked; GWAS Catalog studies and two
            # preclumped local files are not.
            result.update(
                status="warning",
                warnings=[
                    "blocked: OpenGWAS token "
                    + ("expired" if opengwas["reason"] == "opengwas_token_expired" else "missing")
                    + " — OpenGWAS sources, text-based GWAS selection and online LD clumping "
                    "cannot run for this researcher; "
                    + (
                        "open GWAS Catalog studies (type gwas_catalog) and uploaded files can."
                        if result["data"].get("openDataSources") else
                        "only uploaded files with declared preclumped instruments can."
                    )
                ],
                next_actions=_OPENGWAS_NEXT_ACTIONS,
            )
        return result
    if action == "start":
        return _start(arguments, workspace, job_credentials, owner, workload_token, execution_context)
    deadline = time.monotonic() + int(arguments.get("waitSeconds", 0))
    while True:
        result = _status(arguments, workspace)
        if (
            (result.get("data") or {}).get("jobStatus") not in {"queued", "running"}
            or time.monotonic() >= deadline
        ):
            return result
        time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))


def _child_environment() -> dict[str, str]:
    environment = dict(os.environ)
    environment.pop("EVIMED_SPECIALIST_AUDIT_SIGNING_KEY_FILE", None)
    gateway_token = environment.pop(engine_model.TOKEN_ENV, "")
    gateway_base = environment.pop(engine_model.BASE_URL_ENV, "")
    policy_raw = environment.pop(engine_model.POLICY_ENV, "")
    # A credential resolved for this job at submission arrives prefixed in the
    # worker's own environment; the engine sees it under the name it expects,
    # in place of whatever this container was started with.
    for name in list(environment):
        if name.startswith(_JOB_ENV_PREFIX):
            environment[name[len(_JOB_ENV_PREFIX):]] = environment.pop(name)
    if gateway_token and gateway_base:
        # The job was admitted through the gateway: its own credential, and
        # not so much as the path of a provider key.
        environment.pop("LLM_API_KEY_FILE", None)
        environment.update(engine_model.child_environment(gateway_token, gateway_base, json.loads(policy_raw) if policy_raw else None))
    else:
        api_key = _read_secret(os.getenv("LLM_API_KEY_FILE", "").strip())
        environment.update({
            "DEEPSEEK_API_KEY": api_key,
            "DEEPSEEK_BASE_URL": os.getenv("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/"),
            "LLM_API_KEY": api_key,
        })
    environment.update({
        "DEEPSEEK_PRO_MODEL": "deepseek-flash",
        "DEEPSEEK_FLASH_MODEL": "deepseek-flash",
        "LLM_MODEL": "deepseek-flash",
        "LLM_ENABLE_THINKING": environment.get("LLM_ENABLE_THINKING", "true"),
        "LLM_REASONING_EFFORT": environment.get("LLM_REASONING_EFFORT", "high"),
        "LLM_MAX_CONCURRENT": "2",
        "MAX_CONCURRENT_REVIEWS": "1",
        "MAX_CONCURRENT_REVIEWS_V2": "1",
        "PYTHONPATH": str(_agent_root()),
    })
    return environment


def _collect_artifacts(workspace: Path, output_root: Path) -> list[dict[str, str]]:
    artifacts = []
    for path in sorted(output_root.rglob("*")):
        if path.is_file() and not path.is_symlink():
            artifacts.append({
                "kind": path.suffix.lstrip(".") or "file",
                "path": path.relative_to(workspace).as_posix(),
            })
    return artifacts[:100]


def _report_usage(state: dict[str, Any], log_path: Path | None) -> None:
    """Forward a finished job's model spend to the control plane, once.

    After the terminal state is written, never before: the job's outcome is
    settled whatever happens to the report. What happened to it goes to the
    job log, where an operator reading a job finds it.
    """
    usage = state.get("usage")
    context = state.get("queueContext") if _kind() == "mendelian-randomization" else state.get("owner")
    if not isinstance(usage, dict) or not isinstance(context, dict):
        return
    if state.get("modelRoute") == "gateway":
        # Every call was reserved and settled by the gateway as it happened;
        # reporting the totals again would book the job twice.
        _log_line(log_path, "usage report: not sent (metered per call by the model gateway)")
        return
    try:
        secret = _signing_secret()
    except Exception:  # noqa: BLE001 — a missing secret is a report that cannot be signed, not a failed job
        outcome = "unsigned (workload signing secret unavailable)"
    else:
        try:
            outcome = usage_report.report(
                url=os.getenv("EVIMED_USAGE_REPORT_URL", "").strip(),
                secret=secret,
                kind=_kind(),
                job_id=str(state.get("jobId") or ""),
                user_id=str(context.get("userId") or ""),
                project_id=str(context.get("projectId") or ""),
                status=str(state.get("status") or ""),
                finished_at=str(state.get("finishedAt") or _now()),
                usage=usage,
            )
        except Exception as error:  # noqa: BLE001 — the job has ended; its log says why no report went
            outcome = f"failed ({type(error).__name__})"
    _log_line(log_path, f"usage report: {outcome}")


def _mr_runner_failure(result: dict[str, Any], secrets: list[bytes]) -> tuple[str | None, str]:
    """The code and message a failed runner's result may give the run.

    The runner's text is withheld by default: an interpretation failure's
    message can carry a model provider's error body. An open-data refusal
    (`mr_open_*`) is raised before any model is called, and its text is the
    catalogue's and EBI's facts — the studies to choose from, the study with no
    harmonised file, the HTTP status and the route — which is what the run needs
    to correct its request. It is shown on one line, bounded, and not at all if
    it holds a credential the runner was given. A code this adapter does not
    forward is still named in the message when it is a plain identifier.
    """
    code = result.get("errorCode")
    if isinstance(code, str) and any(secret in code.encode("utf-8", "replace") for secret in secrets):
        return None, _MR_RUNNER_FAILED
    if not isinstance(code, str) or not (
        _MR_RUNNER_CODE.fullmatch(code) or code in _MR_RUNNER_NAMED_CODES
    ):
        named = isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code)
        return None, (f"{_MR_RUNNER_FAILED[:-1]} ({code})." if named else _MR_RUNNER_FAILED)
    message = result.get("error")
    if not code.startswith("mr_open_") or not isinstance(message, str):
        return code, _MR_RUNNER_FAILED
    text = "".join(character for character in " ".join(message.split()) if character.isprintable())
    if not text or any(
        secret in candidate.encode("utf-8", "replace") for secret in secrets for candidate in (message, text)
    ):
        return code, _MR_RUNNER_FAILED
    if len(text) > _MR_RUNNER_MESSAGE_LIMIT:
        text = text[: _MR_RUNNER_MESSAGE_LIMIT - 1] + "…"
    return code, text


def _run_isolated_mr(
    state_path: Path, state: dict[str, Any], root: Path, data_root: Path
) -> int:
    """The hosted worker retains authority and never executes in the shared volume."""
    helper = _mr_inputs(root)
    state.update(
        status="running", workerPid=os.getpid(), startedAt=_now(), updatedAt=_now()
    )
    _write_state(state_path, state)
    try:
        jobs = _mr_job(root)
        job = jobs.Job(
            workspace=Path(state["workspace"]),
            output_root=Path(state["outputRoot"]),
            data_root=data_root,
            request=state["request"],
            bindings=state.get("mrInputBindings", {}),
            python=sys.executable,
            runner=root / "evimed_runner.py",
        )
        environment = _child_environment()
        credentials = None
        try:
            store = _mr_store()
            with store.diagnostic_directory(state_path) as diagnostic_directory:
                with _heartbeat(state_path, state, read=store.read, write=store.write):
                    outcome = jobs.execute(helper, job, environment, analysis_credentials=credentials,
                                           failure_directory=diagnostic_directory)
        except helper.MRInputError:
            raise
        except (OSError, ValueError):
            raise helper.MRInputError(
                "mr_analysis_diagnostics_unavailable", "Protected MR diagnostics are unavailable."
            ) from None
        if outcome.get("cleanupError"):
            state["cleanupError"] = outcome["cleanupError"]
        if state.get("sourceEvidence") != _source_evidence(root):
            raise helper.MRInputError(
                "mr_input_changed", "Managed MR source changed during execution."
            )
        result = outcome["result"]
        success = outcome["returnCode"] == 0 and result.get("status") == "succeeded"
        usage = usage_report.normalize(result.get("usage"))
        state.update(
            status="succeeded" if success else "failed",
            finishedAt=_now(),
            updatedAt=_now(),
            returnCode=outcome["returnCode"],
            artifacts=outcome["artifacts"] if success or outcome.get("partialScientificReceipt") else [],
            retryable=outcome["returnCode"] in {75, 137, 143},
            **({"usage": usage} if usage else {}),
        )
        if success:
            receipt = audit_receipt.produce(state, outcome, data_root)
            if receipt is not None:
                candidate = {**state, "auditReceipt": receipt}
                if len(json.dumps(candidate, ensure_ascii=False, indent=2).encode("utf-8")) <= _STATE_LIMIT:
                    state["auditReceipt"] = receipt
            # Full source evidence includes the worker record implementation itself.
            if state.get("sourceEvidence") != _source_evidence(root):
                state.pop("auditReceipt", None)
                raise helper.MRInputError("mr_input_changed", "Managed MR source changed during execution.")
        if not success:
            if outcome.get("partialScientificReceipt"):
                state["partialScientificReceipt"] = outcome["partialScientificReceipt"]
            code, message = _mr_runner_failure(result, jobs.sensitive_values(environment))
            if code:
                state["errorCode"] = code
            state["error"] = message
            if outcome.get("failureDiagnosticReceipt"):
                state["failureDiagnosticReceipt"] = outcome["failureDiagnosticReceipt"]
        _write_state(state_path, state)
        # The terminal state is written: nothing past this line may turn into
        # the job's failure. Without a log path the report still goes, unlogged.
        try:
            _, log_path = _mr_store().paths(Path(state["workspace"]), str(state["jobId"]))
        except Exception:  # noqa: BLE001
            log_path = None
        _report_usage(state, log_path)
        return 0 if success else outcome["returnCode"] or 1
    except helper.MRInputError as error:
        if getattr(error, "cleanup_error", None):
            state["cleanupError"] = error.cleanup_error
        state.update(
            status="failed",
            finishedAt=_now(),
            updatedAt=_now(),
            returnCode=1,
            errorCode=error.code,
            error=str(error),
            retryable=False,
            artifacts=[],
        )
        _write_state(state_path, state)
        return 1
    except MRInputSupportUnavailable as error:
        state.update(
            status="failed",
            finishedAt=_now(),
            updatedAt=_now(),
            returnCode=1,
            errorCode=error.code,
            error=str(error),
            retryable=True,
            artifacts=[],
        )
        _write_state(state_path, state)
        return 1


def run_job(state_file: str) -> int:
    state_path = Path(state_file).absolute()
    data_root = Path(os.getenv("EVIMED_DATA_ROOT", "/data")).resolve()
    if data_root != state_path and data_root not in state_path.parents:
        raise RuntimeError("specialist state escaped the data root")
    if _kind() == "mendelian-randomization":
        with _mr_store().claim(state_path) as state:
            if state is None:
                return 1
    else:
        state = _read_state(state_path)
    if state.get("kind") != _kind():
        raise RuntimeError("specialist state kind is invalid")
    workspace = Path(state["workspace"]).absolute()
    output_root = Path(state["outputRoot"]).absolute()
    if _kind() == "mendelian-randomization" and (
        output_root != workspace / _spec()["directory"] / state["jobId"] / "output"
    ):
        raise RuntimeError("Managed MR job scope does not match its location.")
    root = _agent_root()
    if state.get("sourceEvidence") != _source_evidence(root):
        if _kind() == "mendelian-randomization":
            state.update(status="failed", finishedAt=_now(), updatedAt=_now(),
                         errorCode="mr_input_changed", retryable=False, artifacts=[],
                         error="Managed MR source changed after admission.")
            _write_state(state_path, state)
            return 1
        raise RuntimeError("specialist state no longer matches its managed source")
    if _kind() == "mendelian-randomization":
        return _run_isolated_mr(state_path, state, root, data_root)
    expected_state, log_path = _job_paths(workspace, state["jobId"])
    if expected_state.resolve() != state_path or workspace not in output_root.parents:
        raise RuntimeError("specialist state no longer matches its managed source")
    # Use a private staging directory for stable input/output observations.
    # No signing key or privileged UID transition is needed for an ordinary job.
    isolation = {}
    state.update(
        {
            "status": "running",
            "workerPid": os.getpid(),
            "startedAt": _now(),
            "updatedAt": _now(),
        }
    )
    _write_state(state_path, state)
    request_path = output_root / "request.json"
    request = state["request"]
    _atomic_json(request_path, request)
    log_descriptor = os.open(
        log_path,
        os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    command = [
        sys.executable,
        str(root / "evimed_runner.py"),
        "--request",
        str(request_path),
        "--output-dir",
        str(output_root),
    ]
    # Beside the state, not in the output: it is the engine's word on where it
    # is, not a deliverable, and it is gone once the job has ended.
    progress_path = state_path.with_name(f"{state['jobId']}.progress.json")
    receipt_rows: dict[str, list[dict[str, Any]]] | None = None
    try:
        with os.fdopen(log_descriptor, "ab", buffering=0) as log:
            if isolation is None:
                with _heartbeat(state_path, state, read=_read_json, write=_atomic_json, progress_path=progress_path):
                    return_code = subprocess.run(
                        command,
                        cwd=str(root),
                        env={**_child_environment(), _PROGRESS_ENV: str(progress_path)},
                        stdin=subprocess.DEVNULL,
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        check=False,
                    ).returncode
            else:
                try:
                    return_code, receipt_rows = _run_isolated(
                        state, state_path, root, workspace, output_root, request_path, log, isolation
                    )
                except (OSError, ValueError, isolated_job.IsolatedJobError) as error:
                    _log_line(log_path, f"isolated run failed: {type(error).__name__}: {error}")
                    return_code, receipt_rows = 1, None
    finally:
        try:
            progress_path.unlink()
        except OSError:
            pass
    result_path = output_root / "result.json"
    try:
        result = _read_json(result_path)
    except (OSError, ValueError, RuntimeError):
        # A final serialization failure must not hide the files already
        # published through the worker's verified directory descriptors.
        result = {"status": "failed", "error": "The engine's final result metadata is missing or invalid."}
    # What the engine spent at the provider, success or not: a failed job's
    # tokens were paid for as well.
    usage = usage_report.normalize(result.get("usage"))
    if return_code != 0 or result.get("status") != "succeeded" or (isolation is not None and receipt_rows is None):
        state.update(
            {
                "status": "failed",
                "updatedAt": _now(),
                "finishedAt": _now(),
                "returnCode": return_code,
                "artifacts": [
                    {"kind": Path(row["path"]).suffix.lstrip(".") or "file", "path": row["path"]}
                    for row in (receipt_rows or {}).get("artifacts", [])
                    if Path(row["path"]).name not in {"request.json", "result.json"}
                ][:100],
                "retryable": return_code in {75, 137, 143},
                "error": str(
                    result.get("error")
                    or f"{_spec()['label']} exited with code {return_code}."
                ),
                **({"usage": usage} if usage else {}),
            }
        )
        _write_state(state_path, state)
        _report_usage(state, log_path)
        return return_code or 1
    if state.get("sourceEvidence") != _source_evidence(root):
        raise RuntimeError("specialist source changed while the job was running")
    # Which of the engine's own steps did not do what they were meant to.
    #
    # The status is still `succeeded`: the engine finished and produced its
    # artifacts, and a job that renames that outcome breaks every consumer that
    # switches on it. What was missing is a channel at all. On 2026-09-09 a
    # bibliometric run lost query generation, translation and MeSH mapping to a
    # missing dependency, degraded its search to a bare `GLP-1`, and finished
    # `succeeded` with nothing anywhere saying which steps had not run -- the
    # report said so, and only because the model chose to.
    #
    # Passed through verbatim rather than derived. An engine that does not
    # populate `modules` yet leaves both fields absent, which is honestly
    # "not reported" and not "nothing was degraded".
    degradation = {}
    modules = result.get("modules")
    if isinstance(modules, dict):
        degradation["modules"] = modules
    if isinstance(result.get("degraded"), bool):
        degradation["degraded"] = result["degraded"]
    elif isinstance(modules, dict):
        degradation["degraded"] = any(
            isinstance(entry, dict) and entry.get("status") in {"degraded", "failed"}
            for entry in modules.values()
        )
    state.update(
        {
            "status": "succeeded",
            "updatedAt": _now(),
            "finishedAt": _now(),
            "returnCode": 0,
            "artifacts": _collect_artifacts(workspace, output_root),
            **degradation,
            **({"usage": usage} if usage else {}),
            **({"analysisStaged": True} if receipt_rows is not None else {}),
        }
    )
    if receipt_rows is not None:
        receipt = audit_receipt.produce_job_receipt(
            state,
            tool=_kind().replace("-", "_"),
            output_prefix=f"{_spec()['directory']}/{state['jobId']}/output/",
            inputs=receipt_rows["inputs"],
            artifacts=receipt_rows["artifacts"],
            data_root=data_root,
        )
        if receipt is None:
            _log_line(log_path, "job evidence: observation unavailable; completed artifacts remain available")
        elif len(json.dumps({**state, "auditReceipt": receipt}, ensure_ascii=False, indent=2).encode("utf-8")) <= _STATE_LIMIT:
            state["auditReceipt"] = receipt
        # Full source evidence includes the worker record implementation itself.
        if state.get("sourceEvidence") != _source_evidence(root):
            state.pop("auditReceipt", None)
            raise RuntimeError("specialist source changed while the job was running")
    _write_state(state_path, state)
    _report_usage(state, log_path)
    return 0


#: Credentials an engine reads from a mounted file, which the analysis UID
#: cannot open; under isolation the owner reads them and hands over the value
#: under the name the engine also accepts.
_ISOLATED_FILE_CREDENTIALS = {
    "drug-safety-analysis": {"EVIMED_EVIDENCE_SEARCH_KEY_FILE": "EVIMED_EVIDENCE_SEARCH_KEY"},
}


def _run_isolated(
    state: dict[str, Any],
    state_path: Path,
    root: Path,
    workspace: Path,
    output_root: Path,
    request_path: Path,
    log: Any,
    credentials: dict[str, Any],
) -> tuple[int, dict[str, list[dict[str, Any]]]]:
    """Run the engine in a private stage and publish its regular output files.

    Returns its exit code and the owner's receipt rows: the inputs it was
    handed and every file published into the job's output, the request the
    owner wrote there included.
    """
    request = dict(state["request"])
    inputs, handed = [], {}
    if _kind() == "peer-review":
        manuscript = Path(request["manuscript"]).relative_to(workspace).as_posix()
        blob, row = isolated_job.read_input(workspace, manuscript)
        handed["manuscript"] = (blob, manuscript)
        inputs.append(row)
    with isolated_job.stage(credentials) as stage:
        for field, (blob, name) in handed.items():
            request[field] = str(isolated_job.hand_over(blob, name, stage / "input"))
        staged_request = stage / "request.json"
        descriptor = os.open(staged_request, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(json.dumps(request, ensure_ascii=False).encode("utf-8"))
        os.chmod(staged_request, 0o640)
        progress = stage / "progress.json"
        environment = {
            **_child_environment(),
            _PROGRESS_ENV: str(progress),
            "HOME": str(stage / "home"),
            "TMPDIR": str(stage / "tmp"),
            "MPLCONFIGDIR": str(stage / "home" / "matplotlib"),
        }
        for file_name, value_name in _ISOLATED_FILE_CREDENTIALS.get(_kind(), {}).items():
            location = environment.pop(file_name, "")
            if location:
                try:
                    environment[value_name] = _read_secret(location)
                except (OSError, RuntimeError, UnicodeDecodeError):
                    pass
        command = [
            sys.executable,
            str(root / "evimed_runner.py"),
            "--request",
            str(staged_request),
            "--output-dir",
            str(stage / "output"),
        ]
        with _heartbeat(state_path, state, read=_read_json, write=_atomic_json, progress_path=progress):
            return_code = isolated_job.run(command, credentials=credentials, cwd=str(root), env=environment, log=log)
        artifacts = isolated_job.publish(stage / "output", output_root, workspace)
    artifacts.append(isolated_job.file_row(workspace, request_path))
    return return_code, {"inputs": inputs, "artifacts": sorted(artifacts, key=lambda row: row["path"])}


def _create_app() -> FastAPI:
    spec = _spec()
    instance = FastAPI(title=f"EviMed {spec['label']} Adapter", docs_url=None, redoc_url=None)

    @instance.get("/health")
    def health() -> dict[str, Any]:
        # `serving`: the process, its model and its credential boundary are up
        # — what the container healthcheck reads, so a missing third-party
        # token never stops the web service that depends on this container.
        # `ready`: it can run the analysis it advertises. The MR engine reported
        # ready for weeks with no OpenGWAS JWT at all, while every remote
        # request it accepted could only fail.
        serving = _model_ready()
        opengwas = None
        if _kind() == "mendelian-randomization" and serving:
            try:
                state = _opengwas_state()
            except MRInputSupportUnavailable:
                # The reviewed helper is part of the engine: unloadable, it is
                # not serving, and /health says so instead of answering 500.
                serving, state = False, None
            if state is not None:
                opengwas = {
                    **state,
                    # A researcher's own token (账户→连接器) still unlocks their jobs.
                    "perAccountCredentials": bool(
                        os.getenv("EVIMED_CONNECTOR_CREDENTIAL_URL", "").strip()
                    ),
                }
        # `ready` means the engine can run an analysis with what this
        # deployment holds. Open GWAS Catalog studies need no credential, so an
        # engine that reads them is ready without OpenGWAS; the `opengwas`
        # block still says, separately, that OpenGWAS sources are blocked.
        open_sources = _open_data_sources() if _kind() == "mendelian-randomization" and serving else []
        ready = serving and (opengwas is None or opengwas["ready"] or bool(open_sources))
        return {
            "status": "ok" if ready else "degraded",
            "ready": ready,
            "serving": serving,
            "specialist": _kind(),
            "modelRoute": "gateway" if engine_model.enabled() else "direct",
            **({"opengwas": opengwas} if opengwas is not None else {}),
            **({"openDataSources": open_sources} if _kind() == "mendelian-randomization" else {}),
            "auditReceiptsReady": audit_receipt.ready(fixture=_kind() == "mendelian-randomization"),
            **(
                {"acceptedStartInputs": _accepted_start_inputs()}
                if _kind() in {"research-topic-selection", "mendelian-randomization"}
                else {}
            ),
        }

    def specialist_call(
        arguments: dict[str, Any] = Body(...),
        claims: dict[str, Any] = Security(_authorized_claims),
        bearer: HTTPAuthorizationCredentials | None = Security(HTTPBearer(auto_error=False)),
        execution_header: str | None = Header(default=None, alias="X-EviMed-Execution-Context"),
    ) -> dict[str, Any]:
        try:
            execution_context = engine_model.context_header(execution_header)
            validated = _validated_arguments(arguments)
        except engine_model.EngineModelUnavailable as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except MRInputSupportUnavailable as exc:
            return _error(exc.code, str(exc), True)
        except ValueError as exc:
            if _kind() == "mendelian-randomization" and str(
                getattr(exc, "code", "")
            ).startswith("mr_input_"):
                return _error(exc.code, str(exc))
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        # `capabilities` resolves them too, so it answers for this researcher:
        # their own OpenGWAS token, not only the deployment's, decides it.
        job_credentials = (
            _job_credentials(bearer.credentials if bearer is not None else None)
            if validated.get("action") in {"start", "capabilities"}
            else None
        )
        return call(
            validated,
            workspace_for_claims(claims),
            job_credentials,
            {"userId": claims["userId"], "projectId": claims["projectId"]},
            bearer.credentials if bearer is not None and validated.get("action") == "start" else None,
            execution_context,
        )

    instance.add_api_route(spec["endpoint"], specialist_call, methods=["POST"])
    return instance


if len(sys.argv) == 3 and sys.argv[1] == "--run-job":
    try:
        raise SystemExit(run_job(sys.argv[2]))
    except Exception as exc:
        # MR failures are published only while the original scope remains owned.
        # Reopening this path after a scope failure could adopt a replacement job.
        if _kind() == "mendelian-randomization":
            raise SystemExit(1)
        try:
            target = Path(sys.argv[2]).absolute()
            failed = _read_state(target)
            failed.update({"status": "failed", "updatedAt": _now(), "finishedAt": _now(), "error": str(exc)})
            _write_state(target, failed)
        except Exception:
            pass
        raise SystemExit(1)


app = _create_app()
