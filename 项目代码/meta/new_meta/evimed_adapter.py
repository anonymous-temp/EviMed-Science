"""EviMed SaaS adapter for managed MetaAgent jobs.

The adapter accepts the platform's short-lived workload token, derives the
tenant workspace from signed claims, and launches MetaAgent with a fixed argv.
It never accepts a shell command or a caller-supplied absolute output path.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
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

from fastapi import APIRouter, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field


_BEARER = HTTPBearer(auto_error=False, scheme_name="EviMedWorkloadBearer")
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SAFE_WORKSPACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$")
_SAFE_JOB = re.compile(r"^meta-[a-z0-9-]{8,80}$")
_STATE_LIMIT = 256 * 1024
_LOG_TAIL_LIMIT = 16 * 1024
_WORKERS: dict[str, subprocess.Popen] = {}


class EviMedMetaRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: str = Field(pattern=r"^(capabilities|start|status)$")
    topic: str | None = Field(default=None, min_length=1, max_length=4000)
    jobId: str | None = Field(default=None, pattern=r"^meta-[a-z0-9-]{8,80}$")
    outputLanguage: str | None = Field(default=None, pattern=r"^(zh|en)$")
    maxPapers: int | None = Field(default=None, ge=2, le=200)
    analysisType: str | None = Field(default=None, pattern=r"^(pairwise|network)$")
    userPdfDirectory: str | None = Field(default=None, min_length=1, max_length=512)
    ipdData: str | None = Field(default=None, min_length=1, max_length=512)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _b64url_decode(value: str) -> bytes:
    if not value or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("invalid base64url")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if base64.urlsafe_b64encode(decoded).decode().rstrip("=") != value:
        raise ValueError("non-canonical base64url")
    return decoded


def _read_signing_secret() -> str:
    secret_file = os.getenv("EVIMED_WORKLOAD_SIGNING_SECRET_FILE", "").strip()
    if secret_file:
        if not os.path.isabs(secret_file) or "\0" in secret_file:
            raise RuntimeError("invalid workload secret file")
        descriptor = os.open(secret_file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > 8192:
                raise RuntimeError("invalid workload secret file")
            value = os.read(descriptor, 8193).decode("utf-8")
        finally:
            os.close(descriptor)
        value = value[:-1] if value.endswith("\n") else value
    else:
        value = os.getenv("EVIMED_WORKLOAD_SIGNING_SECRET", "")
    if value != value.strip() or any(character in value for character in "\r\n\0") or len(value.encode()) < 32:
        raise RuntimeError("invalid workload signing secret")
    return value


def verify_workload_token(token: str, *, now_seconds: int | None = None) -> dict[str, Any]:
    try:
        if not isinstance(token, str) or len(token) > 8192:
            raise ValueError("invalid token")
        header_part, body_part, signature_part = token.split(".")
        signed = f"{header_part}.{body_part}"
        expected = base64.urlsafe_b64encode(
            hmac.new(_read_signing_secret().encode(), signed.encode(), hashlib.sha256).digest()
        ).decode().rstrip("=")
        if not hmac.compare_digest(signature_part, expected):
            raise ValueError("invalid signature")
        header = json.loads(_b64url_decode(header_part))
        payload = json.loads(_b64url_decode(body_part))
        if header != {"alg": "HS256", "typ": "JWT"}:
            raise ValueError("invalid header")
        if not isinstance(payload, dict) or set(payload) != {
            "v", "aud", "userId", "projectId", "iat", "exp", "jti"
        }:
            raise ValueError("invalid claims")
        now = int(time.time()) if now_seconds is None else int(now_seconds)
        if (
            payload["v"] != 1
            or payload["aud"] != "evimed-adapter"
            or not _SAFE_ID.fullmatch(payload["userId"])
            or not _SAFE_ID.fullmatch(payload["projectId"])
            or type(payload["iat"]) is not int
            or type(payload["exp"]) is not int
            or payload["iat"] > now + 30
            or payload["exp"] <= now
            or payload["exp"] <= payload["iat"]
            or payload["exp"] - payload["iat"] > 900
            or not isinstance(payload["jti"], str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{3,256}", payload["jti"])
        ):
            raise ValueError("invalid claims")
        return payload
    except (KeyError, TypeError, ValueError, json.JSONDecodeError, UnicodeDecodeError, RuntimeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Valid EviMed workload token required",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


def _authorized_claims(
    credentials: HTTPAuthorizationCredentials | None = Security(_BEARER),
) -> dict[str, Any]:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Valid EviMed workload token required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return verify_workload_token(credentials.credentials)


def _no_symlink_tree(root: Path, target: Path) -> None:
    root = root.resolve()
    target = target.absolute()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail="Workspace path escaped the EviMed data root")
    current = root
    for part in target.relative_to(root).parts:
        current = current / part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise HTTPException(status_code=400, detail="Symbolic links are not allowed in workspace paths")
    if target.resolve() != target:
        raise HTTPException(status_code=400, detail="Symbolic links are not allowed in workspace paths")


def workspace_for_claims(claims: dict[str, Any], data_root: str | Path | None = None) -> Path:
    root = Path(data_root or os.getenv("EVIMED_DATA_ROOT", "/data")).resolve()
    base = root / "users" / claims["userId"] / "projects" / claims["projectId"] / "workspace"
    try:
        _no_symlink_tree(root, base)
    except FileNotFoundError as exc:
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
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Active EviMed workspace not found") from exc
    return workspace


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and path.is_symlink():
        raise RuntimeError("job state must not be a symbolic link")
    payload = json.dumps(value, ensure_ascii=False, indent=2).encode()
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


def _read_state(path: Path) -> dict[str, Any]:
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


def _job_paths(workspace: Path, job_id: str) -> tuple[Path, Path]:
    if not _SAFE_JOB.fullmatch(job_id):
        raise ValueError("invalid MetaAgent job id")
    root = workspace / "meta-analysis-runs" / ".jobs"
    if root.exists():
        _no_symlink_tree(workspace, root)
    return root / f"{job_id}.json", root / f"{job_id}.log"


def _ensure_managed_directory(workspace: Path, target: Path) -> None:
    target.mkdir(parents=False, exist_ok=True, mode=0o700)
    _no_symlink_tree(workspace, target)


def _source(job_id: str) -> dict[str, str]:
    return {"id": f"meta-job:{job_id}", "source": "MetaAgent", "retrievedAt": _now()}


def _error(code: str, message: str, retryable: bool = False) -> dict[str, Any]:
    return {
        "status": "error",
        "summary": message,
        "next_actions": ["Correct the reported MetaAgent precondition before retrying."],
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
            "stopReason": "Stop until the MetaAgent precondition is satisfied.",
        },
    }


def _workspace_input(workspace: Path, value: str | None, *, directory: bool, suffix: str | None = None) -> Path | None:
    if value is None:
        return None
    if os.path.isabs(value) or "\0" in value:
        raise ValueError("MetaAgent input paths must be workspace-relative")
    lexical = workspace / value
    try:
        _no_symlink_tree(workspace, lexical)
    except (FileNotFoundError, HTTPException) as exc:
        raise ValueError("MetaAgent input path is unavailable") from exc
    candidate = lexical.resolve()
    if candidate != workspace and workspace not in candidate.parents:
        raise ValueError("MetaAgent input paths must stay inside the workspace")
    if candidate.is_symlink() or (directory and not candidate.is_dir()) or (not directory and not candidate.is_file()):
        raise ValueError("MetaAgent input path is unavailable")
    if suffix and candidate.suffix.casefold() != suffix:
        raise ValueError("MetaAgent input has an invalid type")
    return candidate


def _model_ready() -> bool:
    try:
        _load_api_key_file()
    except (OSError, UnicodeDecodeError, RuntimeError):
        return False
    return (
        bool(os.getenv("LLM_API_KEY", "").strip())
        and os.getenv("LLM_MODEL", "").strip() == "deepseek-v4-pro"
        and os.getenv("LLM_ENABLE_THINKING", "true").lower() == "true"
    )


def _load_api_key_file() -> None:
    if os.getenv("LLM_API_KEY", "").strip():
        return
    key_file = os.getenv("LLM_API_KEY_FILE", "").strip()
    if not key_file or not os.path.isabs(key_file) or "\0" in key_file:
        return
    descriptor = os.open(key_file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > 8192:
            raise RuntimeError("invalid LLM API key file")
        value = os.read(descriptor, 8193).decode("utf-8")
    finally:
        os.close(descriptor)
    value = value[:-1] if value.endswith("\n") else value
    if not value or value != value.strip() or any(character in value for character in "\r\n\0"):
        raise RuntimeError("invalid LLM API key file")
    os.environ["LLM_API_KEY"] = value


def call(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    action = arguments.get("action")
    if action == "capabilities":
        if not _model_ready():
            return _error("meta_model_config_unavailable", "DeepSeek V4 Pro thinking mode is not configured.", True)
        return {
            "status": "success",
            "summary": "MetaAgent is configured for EviMed SaaS execution.",
            "data": {"available": True, "model": "deepseek-v4-pro", "thinking": True},
            "sources": [{"id": "metaagent:service", "source": "MetaAgent", "retrievedAt": _now()}],
        }
    if action == "start":
        return _start(arguments, workspace)
    if action == "status":
        return _status(arguments, workspace)
    return _error("meta_action_invalid", "Unsupported MetaAgent action.")


def _start(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    topic = str(arguments.get("topic") or "").strip()
    if not topic:
        return _error("meta_topic_required", "A concrete meta-analysis topic is required.")
    if not _model_ready():
        return _error("meta_model_config_unavailable", "DeepSeek V4 Pro thinking mode is not configured.", True)
    try:
        pdfs = _workspace_input(workspace, arguments.get("userPdfDirectory"), directory=True)
        ipd = _workspace_input(workspace, arguments.get("ipdData"), directory=False, suffix=".json")
    except ValueError as exc:
        return _error("meta_input_path_invalid", str(exc))
    job_id = f"meta-{time.strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(6)}"
    run_root = workspace / "meta-analysis-runs"
    _ensure_managed_directory(workspace, run_root)
    _ensure_managed_directory(workspace, run_root / ".jobs")
    job_root = run_root / job_id
    _ensure_managed_directory(workspace, job_root)
    output_root = job_root / "output"
    _ensure_managed_directory(workspace, output_root)
    state_path, _ = _job_paths(workspace, job_id)
    state = {
        "schemaVersion": 1,
        "jobId": job_id,
        "status": "queued",
        "topic": topic,
        "outputLanguage": arguments.get("outputLanguage"),
        "maxPapers": arguments.get("maxPapers"),
        "analysisType": arguments.get("analysisType"),
        "userPdfDirectory": str(pdfs) if pdfs else None,
        "ipdData": str(ipd) if ipd else None,
        "workspace": str(workspace),
        "outputRoot": str(output_root),
        "createdAt": _now(),
        "updatedAt": _now(),
        "artifacts": [],
    }
    _atomic_json(state_path, state)
    try:
        worker = subprocess.Popen(
            [sys.executable, "-m", "new_meta.evimed_adapter", "--run-job", str(state_path)],
            cwd=str(Path(__file__).resolve().parents[1]),
            env=dict(os.environ),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        _WORKERS[job_id] = worker
    except OSError:
        state.update({"status": "failed", "updatedAt": _now(), "error": "MetaAgent worker could not start."})
        _atomic_json(state_path, state)
        return _error("meta_agent_worker_unavailable", "MetaAgent worker could not start.", True)
    return {
        "status": "warning",
        "summary": f"MetaAgent job {job_id} has started.",
        "data": {"jobId": job_id, "jobStatus": "queued"},
        "sources": [_source(job_id)],
        "warnings": ["The synthesis is still running; interim files are not final results."],
        "next_actions": ["Poll evimed_meta_analysis with action=status and this jobId."],
    }


def _reap(job_id: str) -> None:
    worker = _WORKERS.pop(job_id, None)
    if worker is None:
        return
    try:
        worker.wait(timeout=1)
    except subprocess.TimeoutExpired:
        _WORKERS[job_id] = worker


def _status(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    job_id = str(arguments.get("jobId") or "")
    try:
        state_path, log_path = _job_paths(workspace, job_id)
        state = _read_state(state_path)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError, HTTPException):
        return _error("meta_job_unavailable", "The requested MetaAgent job is unavailable.")
    if state.get("jobId") != job_id or Path(state.get("workspace", "")).resolve() != workspace.resolve():
        return _error("meta_job_state_invalid", "The MetaAgent job state is invalid.")
    job_status = state.get("status")
    if job_status in {"queued", "running"}:
        return {
            "status": "warning",
            "summary": f"MetaAgent job {job_id} is {job_status}.",
            "data": {"jobId": job_id, "jobStatus": job_status, "updatedAt": state.get("updatedAt")},
            "sources": [_source(job_id)],
            "warnings": ["The synthesis is not complete; do not draw final conclusions."],
            "next_actions": ["Poll this job again after additional processing time."],
        }
    _reap(job_id)
    if job_status == "failed":
        tail = ""
        descriptor = None
        try:
            descriptor = os.open(log_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            size = os.fstat(descriptor).st_size
            os.lseek(descriptor, max(0, size - _LOG_TAIL_LIMIT), os.SEEK_SET)
            tail = os.read(descriptor, _LOG_TAIL_LIMIT).decode(errors="replace")[-2000:]
        except OSError:
            pass
        finally:
            if descriptor is not None:
                os.close(descriptor)
        message = str(state.get("error") or "MetaAgent execution failed.")
        if tail:
            message = f"{message} Log tail: {tail}"
        return _error("meta_agent_execution_failed", message, bool(state.get("retryable")))
    if job_status != "succeeded":
        return _error("meta_job_state_invalid", "The MetaAgent job state is invalid.")
    release_status = str(state.get("releaseStatus") or "unknown")
    result: dict[str, Any] = {
        "status": "success" if release_status == "ready" else "warning",
        "summary": f"MetaAgent job {job_id} completed with release status {release_status}.",
        "data": {
            "jobId": job_id,
            "jobStatus": "succeeded",
            "releaseStatus": release_status,
            "projectPath": state.get("projectRelativePath"),
        },
        "sources": [_source(job_id)],
        "artifacts": state.get("artifacts") or [],
    }
    if result["status"] == "warning":
        result["warnings"] = ["Release warnings or blockers must be preserved in every summary."]
        result["next_actions"] = state.get("nextActions") or ["Review release_decision.json before publication."]
    return result


def _artifact_list(workspace: Path, project: Path) -> list[dict[str, str]]:
    candidates = [
        ("manuscript", project / "manuscript" / "draft.md"),
        ("manuscript_pdf", project / "manuscript" / "draft.pdf"),
        ("manuscript_docx", project / "manuscript" / "draft.docx"),
        ("release_decision", project / "package" / "release_decision.json"),
        ("review_package", project / "package" / "metaagent_export.zip"),
        ("analysis", project / "analysis" / "meta_analysis.json"),
    ]
    return [
        {"kind": kind, "path": candidate.relative_to(workspace).as_posix()}
        for kind, candidate in candidates
        if candidate.is_file()
    ]


def run_job(state_file: str) -> int:
    _load_api_key_file()
    state_path = Path(state_file).resolve()
    state = _read_state(state_path)
    workspace = Path(state["workspace"]).resolve()
    output_root = Path(state["outputRoot"]).resolve()
    if output_root != workspace and workspace not in output_root.parents:
        raise RuntimeError("MetaAgent output escaped its workspace")
    state.update({"status": "running", "workerPid": os.getpid(), "startedAt": _now(), "updatedAt": _now()})
    _atomic_json(state_path, state)
    command = [
        sys.executable, "-m", "new_meta.main",
        "--topic", state["topic"],
        "--output-dir", str(output_root),
        "--model", "deepseek-v4-pro",
        "--skip-confirm",
        "--run-mode", "review",
    ]
    for field, option in [
        ("outputLanguage", "--language"),
        ("maxPapers", "--max-papers"),
        ("analysisType", "--analysis-type"),
        ("userPdfDirectory", "--user-pdfs"),
        ("ipdData", "--ipd-data"),
    ]:
        if state.get(field) is not None:
            command.extend([option, str(state[field])])
    _, log_path = _job_paths(workspace, state["jobId"])
    log_descriptor = os.open(
        log_path,
        os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    with os.fdopen(log_descriptor, "ab", buffering=0) as log:
        completed = subprocess.run(
            command,
            cwd=str(Path(__file__).resolve().parents[1]),
            env=dict(os.environ),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
    projects = sorted(
        (entry for entry in output_root.iterdir() if entry.is_dir()),
        key=lambda entry: entry.stat().st_mtime_ns,
        reverse=True,
    )
    if completed.returncode != 0 or not projects:
        state.update({
            "status": "failed",
            "updatedAt": _now(),
            "finishedAt": _now(),
            "returnCode": completed.returncode,
            "retryable": completed.returncode in {75, 137, 143},
            "error": f"MetaAgent exited with code {completed.returncode}.",
        })
        _atomic_json(state_path, state)
        return completed.returncode or 1
    project = projects[0].resolve()
    if output_root not in project.parents:
        raise RuntimeError("MetaAgent project escaped its output directory")
    release: dict[str, Any] = {}
    release_file = project / "package" / "release_decision.json"
    try:
        release = json.loads(release_file.read_text(encoding="utf-8")) if release_file.is_file() else {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        pass
    state.update({
        "status": "succeeded",
        "updatedAt": _now(),
        "finishedAt": _now(),
        "returnCode": 0,
        "projectRelativePath": project.relative_to(workspace).as_posix(),
        "releaseStatus": str(release.get("status") or "unknown"),
        "nextActions": [str(item) for item in release.get("next_actions", []) if str(item).strip()][:20],
        "artifacts": _artifact_list(workspace, project),
    })
    _atomic_json(state_path, state)
    return 0


def create_evimed_adapter_router(data_root: str | Path | None = None) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["EviMed MetaAgent adapter"])

    @router.post("/evimed/meta-analysis")
    def meta_analysis(
        request: EviMedMetaRequest,
        claims: dict[str, Any] = Security(_authorized_claims),
    ) -> dict[str, Any]:
        workspace = workspace_for_claims(claims, data_root)
        return call(request.model_dump(exclude_none=True), workspace)

    return router


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--run-job":
        try:
            raise SystemExit(run_job(sys.argv[2]))
        except Exception as exc:
            try:
                target = Path(sys.argv[2]).resolve()
                failed = _read_state(target)
                failed.update({"status": "failed", "updatedAt": _now(), "finishedAt": _now(), "error": str(exc)})
                _atomic_json(target, failed)
            except Exception:
                pass
            raise SystemExit(1)
    raise SystemExit(2)
