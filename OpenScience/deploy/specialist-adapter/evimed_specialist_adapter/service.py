"""Authenticated SaaS adapter for fixed-argument EviMed specialist runners.

The service derives project scope exclusively from a short-lived platform token,
launches one reviewed ``evimed_runner.py`` with fixed arguments, and publishes
only workspace-relative artifacts. It intentionally accepts no executable,
environment variable, absolute output path, or caller-supplied tenant scope.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Security

from .security import _authorized_claims, _read_secret, _signing_secret


_SAFE_WORKSPACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$")
_STATE_LIMIT = 256 * 1024
_LOG_TAIL_LIMIT = 16 * 1024
_WORKERS: dict[str, subprocess.Popen[bytes]] = {}


SPECS: dict[str, dict[str, Any]] = {
    "mendelian-randomization": {
        "label": "Mendelian randomization",
        "endpoint": "/api/v1/evimed/mendelian-randomization",
        "prefix": "mr-",
        "directory": "mendelian-randomization-runs",
        "marker": "mr_agent/core/engine.py",
        "required": ("exposure", "outcome"),
        "inputs": ("exposure", "outcome", "outputLanguage", "analysisDirection"),
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
        "inputs": ("researchDirection", "outputLanguage"),
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
            "drug", "reactions", "outputLanguage", "drugAliases", "suspectRoles",
            "administrationRoutes", "studyDateFrom", "studyDateTo",
            "backgroundDateFrom", "backgroundDateTo",
        ),
    },
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _kind() -> str:
    kind = os.getenv("EVIMED_SPECIALIST_KIND", "").strip()
    if kind not in SPECS:
        raise RuntimeError("EVIMED_SPECIALIST_KIND is not a supported specialist")
    return kind


def _spec() -> dict[str, Any]:
    return SPECS[_kind()]


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


def _error(code: str, message: str, retryable: bool = False) -> dict[str, Any]:
    return {
        "status": "error",
        "summary": message,
        "next_actions": ["Correct the reported specialist precondition before retrying."],
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


def _source_evidence(root: Path) -> dict[str, str]:
    digest = hashlib.sha256()
    for target in (root / "evimed_runner.py", root / _spec()["marker"], Path(__file__).resolve()):
        digest.update(target.read_bytes())
    return {"algorithm": "sha256", "digest": digest.hexdigest()}


def _job_paths(workspace: Path, job_id: str) -> tuple[Path, Path]:
    spec = _spec()
    pattern = re.compile(rf"^{re.escape(spec['prefix'])}[a-z0-9-]{{8,80}}$")
    if not pattern.fullmatch(job_id):
        raise ValueError("invalid specialist job id")
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
    else:
        allowed = {"action", "jobId", "waitSeconds"}
    if set(arguments) - allowed:
        raise ValueError("request contains unsupported fields")
    if action == "start":
        for required in spec["required"]:
            if not str(arguments.get(required) or "").strip():
                raise ValueError(f"{required} is required")
    if action == "status" and not str(arguments.get("jobId") or "").strip():
        raise ValueError("jobId is required")
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
        _read_secret(os.getenv("LLM_API_KEY_FILE", "").strip())
        _agent_root()
        _signing_secret()
        if _kind() == "drug-safety-analysis":
            _read_secret(os.getenv("EVIMED_EVIDENCE_SEARCH_KEY_FILE", "").strip())
    except (OSError, UnicodeDecodeError, RuntimeError):
        return False
    return os.getenv("LLM_MODEL", "").strip() == "deepseek-v4-pro"


def _start(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    if not _model_ready():
        return _error(
            "specialist_model_config_unavailable",
            "DeepSeek V4 Pro or the specialist credential boundary is unavailable.",
            True,
        )
    spec = _spec()
    request = {key: arguments[key] for key in spec["inputs"] if key in arguments}
    if _kind() == "peer-review":
        try:
            request["manuscript"] = str(_workspace_file(workspace, request.get("manuscript")))
        except ValueError as exc:
            return _error("specialist_input_path_invalid", str(exc))
    job_id = f"{spec['prefix']}{time.strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(6)}"
    run_root = workspace / spec["directory"]
    for target in (run_root, run_root / ".jobs", run_root / job_id, run_root / job_id / "output"):
        _ensure_directory(workspace, target)
    output_root = run_root / job_id / "output"
    state_path, _ = _job_paths(workspace, job_id)
    root = _agent_root()
    state = {
        "schemaVersion": 1,
        "kind": _kind(),
        "jobId": job_id,
        "status": "queued",
        "request": request,
        "workspace": str(workspace),
        "outputRoot": str(output_root),
        "sourceEvidence": _source_evidence(root),
        "createdAt": _now(),
        "updatedAt": _now(),
        "artifacts": [],
    }
    _atomic_json(state_path, state)
    try:
        worker = subprocess.Popen(
            [sys.executable, "-m", "evimed_specialist_adapter.service", "--run-job", str(state_path)],
            cwd=str(Path(__file__).resolve().parents[1]),
            env=dict(os.environ),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        _WORKERS[job_id] = worker
    except OSError:
        state.update({"status": "failed", "updatedAt": _now(), "error": "Specialist worker could not start."})
        _atomic_json(state_path, state)
        return _error("specialist_worker_unavailable", "Specialist worker could not start.", True)
    return {
        "status": "warning",
        "summary": f"{spec['label']} job {job_id} has started.",
        "data": {"jobId": job_id, "jobStatus": "queued"},
        "sources": [_source(job_id)],
        "warnings": ["The specialist analysis is still running; interim files are not final results."],
        "next_actions": ["Poll this specialist with action=status and the returned jobId."],
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
        state = _read_json(state_path)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError):
        return _error("specialist_job_unavailable", "The requested specialist job is unavailable.")
    if (
        state.get("kind") != _kind()
        or state.get("jobId") != job_id
        or Path(state.get("workspace", "")).resolve() != workspace.resolve()
    ):
        return _error("specialist_job_state_invalid", "The specialist job state is invalid.")
    job_status = state.get("status")
    if job_status in {"queued", "running"}:
        if _managed_worker_alive(job_id, state_path, state):
            return {
                "status": "warning",
                "summary": f"{_spec()['label']} job {job_id} is {job_status}.",
                "data": {"jobId": job_id, "jobStatus": job_status, "updatedAt": state.get("updatedAt")},
                "sources": [_source(job_id)],
                "warnings": ["The specialist analysis is incomplete; do not draw final conclusions."],
                "next_actions": ["Poll this job again after additional processing time."],
            }
        try:
            refreshed = _read_json(state_path)
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
            _atomic_json(state_path, state)
            job_status = "failed"
    worker = _WORKERS.pop(job_id, None)
    if worker is not None:
        try:
            worker.wait(timeout=1)
        except subprocess.TimeoutExpired:
            _WORKERS[job_id] = worker
    if job_status == "failed":
        message = str(state.get("error") or f"{_spec()['label']} execution failed.")
        tail = _log_tail(log_path)
        if tail:
            message = f"{message} Log tail: {tail}"
        return _error("specialist_execution_failed", message, bool(state.get("retryable")))
    if job_status != "succeeded":
        return _error("specialist_job_state_invalid", "The specialist job state is invalid.")
    return {
        "status": "success",
        "summary": f"{_spec()['label']} job {job_id} completed.",
        "data": {"jobId": job_id, "jobStatus": "succeeded"},
        "sources": [_source(job_id)],
        "artifacts": state.get("artifacts") or [],
    }


def call(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    action = arguments["action"]
    if action == "capabilities":
        if not _model_ready():
            return _error(
                "specialist_model_config_unavailable",
                "DeepSeek V4 Pro or the specialist credential boundary is unavailable.",
                True,
            )
        return {
            "status": "success",
            "summary": f"{_spec()['label']} is configured for managed EviMed SaaS execution.",
            "data": {"available": True, "model": "deepseek-v4-pro", "thinking": True},
            "sources": [_source("service")],
        }
    if action == "start":
        return _start(arguments, workspace)
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
    api_key = _read_secret(os.getenv("LLM_API_KEY_FILE", "").strip())
    environment = dict(os.environ)
    environment.update({
        "DEEPSEEK_API_KEY": api_key,
        "DEEPSEEK_BASE_URL": os.getenv("LLM_BASE_URL", "https://api.deepseek.com").rstrip("/"),
        "DEEPSEEK_PRO_MODEL": "deepseek-v4-pro",
        "DEEPSEEK_FLASH_MODEL": "deepseek-v4-pro",
        "LLM_API_KEY": api_key,
        "LLM_MODEL": "deepseek-v4-pro",
        "LLM_ENABLE_THINKING": "true",
        "LLM_REASONING_EFFORT": "high",
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


def run_job(state_file: str) -> int:
    state_path = Path(state_file).resolve()
    data_root = Path(os.getenv("EVIMED_DATA_ROOT", "/data")).resolve()
    if data_root != state_path and data_root not in state_path.parents:
        raise RuntimeError("specialist state escaped the data root")
    state = _read_json(state_path)
    if state.get("kind") != _kind():
        raise RuntimeError("specialist state kind is invalid")
    workspace = Path(state["workspace"]).resolve()
    output_root = Path(state["outputRoot"]).resolve()
    root = _agent_root()
    expected_state, log_path = _job_paths(workspace, state["jobId"])
    if (
        expected_state.resolve() != state_path
        or (workspace != output_root and workspace not in output_root.parents)
        or state.get("sourceEvidence") != _source_evidence(root)
    ):
        raise RuntimeError("specialist state no longer matches its managed source")
    state.update({"status": "running", "workerPid": os.getpid(), "startedAt": _now(), "updatedAt": _now()})
    _atomic_json(state_path, state)
    request_path = output_root / "request.json"
    _atomic_json(request_path, state["request"])
    log_descriptor = os.open(
        log_path,
        os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    command = [sys.executable, str(root / "evimed_runner.py"), "--request", str(request_path), "--output-dir", str(output_root)]
    with os.fdopen(log_descriptor, "ab", buffering=0) as log:
        completed = subprocess.run(
            command,
            cwd=str(root),
            env=_child_environment(),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
    result_path = output_root / "result.json"
    result = _read_json(result_path) if result_path.is_file() else {}
    if completed.returncode != 0 or result.get("status") != "succeeded":
        state.update({
            "status": "failed",
            "updatedAt": _now(),
            "finishedAt": _now(),
            "returnCode": completed.returncode,
            "retryable": completed.returncode in {75, 137, 143},
            "error": str(result.get("error") or f"{_spec()['label']} exited with code {completed.returncode}."),
        })
        _atomic_json(state_path, state)
        return completed.returncode or 1
    if state.get("sourceEvidence") != _source_evidence(root):
        raise RuntimeError("specialist source changed while the job was running")
    state.update({
        "status": "succeeded",
        "updatedAt": _now(),
        "finishedAt": _now(),
        "returnCode": 0,
        "artifacts": _collect_artifacts(workspace, output_root),
    })
    _atomic_json(state_path, state)
    return 0


def _create_app() -> FastAPI:
    spec = _spec()
    instance = FastAPI(title=f"EviMed {spec['label']} Adapter", docs_url=None, redoc_url=None)

    @instance.get("/health")
    def health() -> dict[str, Any]:
        ready = _model_ready()
        return {"status": "ok" if ready else "degraded", "ready": ready, "specialist": _kind()}

    def specialist_call(
        arguments: dict[str, Any] = Body(...),
        claims: dict[str, Any] = Security(_authorized_claims),
    ) -> dict[str, Any]:
        try:
            validated = _validated_arguments(arguments)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return call(validated, workspace_for_claims(claims))

    instance.add_api_route(spec["endpoint"], specialist_call, methods=["POST"])
    return instance


if len(sys.argv) == 3 and sys.argv[1] == "--run-job":
    try:
        raise SystemExit(run_job(sys.argv[2]))
    except Exception as exc:
        try:
            target = Path(sys.argv[2]).resolve()
            failed = _read_json(target)
            failed.update({"status": "failed", "updatedAt": _now(), "finishedAt": _now(), "error": str(exc)})
            _atomic_json(target, failed)
        except Exception:
            pass
        raise SystemExit(1)


app = _create_app()
