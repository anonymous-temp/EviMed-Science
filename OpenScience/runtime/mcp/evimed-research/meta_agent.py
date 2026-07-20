"""Managed MetaAgent execution for the EviMed research MCP server.

The MCP process never accepts a shell command from the model.  It starts the
operator-configured MetaAgent package with a fixed argv contract, writes every
run below the current project workspace, and exposes append-only job state for
later polling.
"""

from __future__ import annotations

import json
import os
import secrets
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from execution_evidence import execution_evidence


MAX_STATE_BYTES = 256 * 1024
MAX_LOG_TAIL_BYTES = 16 * 1024
JOB_ID_PATTERN = "meta-"
_BACKGROUND_WORKERS = {}


class MetaAgentError(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() and path.is_symlink():
        raise MetaAgentError("meta_job_state_invalid", "MetaAgent job state must not be a symbolic link.")
    temporary = path.with_name(".%s.%s.tmp" % (path.name, secrets.token_hex(8)))
    payload = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
    if len(payload) > MAX_STATE_BYTES:
        raise MetaAgentError("meta_job_state_too_large", "MetaAgent job state exceeded its size limit.")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def _read_json_no_follow(path):
    path = Path(path)
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size <= 0 or before.st_size > MAX_STATE_BYTES:
            raise MetaAgentError("meta_job_state_invalid", "MetaAgent job state is not a valid regular file.")
        raw = os.read(descriptor, MAX_STATE_BYTES + 1)
        after = os.fstat(descriptor)
        if (
            len(raw) > MAX_STATE_BYTES
            or before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
        ):
            raise MetaAgentError("meta_job_state_invalid", "MetaAgent job state changed while it was read.")
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("state is not an object")
        return value
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        if isinstance(error, MetaAgentError):
            raise
        raise MetaAgentError("meta_job_state_invalid", "MetaAgent job state could not be read.") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _workspace():
    raw = os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR", "").strip()
    if not raw or not os.path.isabs(raw) or "\0" in raw:
        raise MetaAgentError("meta_workspace_invalid", "The managed project workspace is unavailable.")
    candidate = Path(raw)
    if candidate.is_symlink():
        raise MetaAgentError("meta_workspace_invalid", "The managed project workspace is unavailable.")
    workspace = candidate.resolve()
    if not workspace.is_dir():
        raise MetaAgentError("meta_workspace_invalid", "The managed project workspace is unavailable.")
    return workspace


def _meta_root():
    raw = os.environ.get("EVIMED_META_AGENT_ROOT", "").strip()
    if not raw:
        raise MetaAgentError(
            "meta_agent_unconfigured",
            "MetaAgent is not installed in this runtime.",
        )
    if not os.path.isabs(raw) or "\0" in raw:
        raise MetaAgentError("meta_agent_root_invalid", "EVIMED_META_AGENT_ROOT must be an absolute path.")
    root = Path(raw).resolve()
    if not root.is_dir() or not (root / "new_meta" / "main.py").is_file():
        raise MetaAgentError("meta_agent_unavailable", "The configured MetaAgent package is unavailable.", True)
    return root


def _meta_python(root):
    configured = os.environ.get("EVIMED_META_AGENT_PYTHON", "").strip()
    candidate = Path(configured) if configured else root / ".venv" / "bin" / "python"
    if not candidate.is_absolute() or "\0" in str(candidate):
        raise MetaAgentError(
            "meta_agent_python_unavailable",
            "The MetaAgent Python runtime must be an absolute path.",
        )
    executable = Path(os.path.abspath(candidate))
    try:
        resolved = executable.resolve(strict=True)
    except OSError as error:
        raise MetaAgentError("meta_agent_python_unavailable", "The MetaAgent Python runtime is unavailable.", True) from error
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise MetaAgentError("meta_agent_python_unavailable", "The MetaAgent Python runtime is not executable.")
    # Execute the lexical virtual-environment entry point. Resolving the
    # symlink launches the base interpreter and drops the venv site-packages.
    return executable


def _model_environment():
    raw = os.environ.get("EVIMED_MODEL_CONFIG_FILE", "").strip()
    if not raw or not os.path.isabs(raw) or "\0" in raw:
        raise MetaAgentError("meta_model_config_unavailable", "The managed model configuration is unavailable.", True)
    config = _read_json_no_follow(raw)
    provider = config.get("provider", {}).get("deepseek", {})
    options = provider.get("options", {}) if isinstance(provider, dict) else {}
    models = provider.get("models", {}) if isinstance(provider, dict) else {}
    base_url = options.get("baseURL") if isinstance(options, dict) else None
    api_key = options.get("apiKey") if isinstance(options, dict) else None
    model = "deepseek-v4-pro" if isinstance(models, dict) and "deepseek-v4-pro" in models else None
    if (
        not isinstance(base_url, str)
        or not base_url.startswith(("http://", "https://"))
        or not isinstance(api_key, str)
        or not api_key
        or not model
    ):
        raise MetaAgentError("meta_model_config_unavailable", "DeepSeek V4 Pro is not configured for this runtime.", True)
    return {
        "LLM_BASE_URL": base_url.rstrip("/"),
        "LLM_API_KEY": api_key,
        "LLM_MODEL": model,
        "LLM_ENABLE_THINKING": "true",
        "LLM_REASONING_EFFORT": "high",
        "LLM_TRUST_ENV": "false",
        "LLM_STREAM": "false",
    }


def _job_paths(job_id):
    if not isinstance(job_id, str) or not job_id.startswith(JOB_ID_PATTERN):
        raise MetaAgentError("meta_job_id_invalid", "The MetaAgent job id is invalid.")
    suffix = job_id[len(JOB_ID_PATTERN):]
    if not suffix or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in suffix):
        raise MetaAgentError("meta_job_id_invalid", "The MetaAgent job id is invalid.")
    workspace = _workspace()
    jobs = workspace / "meta-analysis-runs" / ".jobs"
    for managed in (jobs.parent, jobs):
        if managed.exists() and managed.is_symlink():
            raise MetaAgentError("meta_job_state_invalid", "MetaAgent job directories must not be symbolic links.")
    return workspace, jobs / (job_id + ".json"), jobs / (job_id + ".log")


def _ensure_managed_directory(workspace, target):
    target = Path(target)
    target.mkdir(parents=False, exist_ok=True, mode=0o700)
    if target.is_symlink() or os.path.commonpath([str(workspace), str(target.resolve())]) != str(workspace):
        raise MetaAgentError("meta_output_scope_invalid", "MetaAgent job directories must stay inside the workspace.")


def _source(job_id):
    return {
        "id": "meta-job:%s" % job_id,
        "source": "MetaAgent",
        "retrievedAt": _now(),
    }


def _execution_evidence(root):
    return execution_evidence(root, Path(__file__))


def _workspace_input(workspace, value, *, directory, suffix=None):
    if value is None:
        return None
    raw = str(value).strip()
    if not raw or os.path.isabs(raw) or "\0" in raw:
        raise MetaAgentError("meta_input_path_invalid", "MetaAgent input paths must be workspace-relative.")
    lexical = workspace / raw
    current = workspace
    try:
        for part in lexical.relative_to(workspace).parts:
            current = current / part
            if current.is_symlink():
                raise MetaAgentError("meta_input_path_invalid", "MetaAgent input paths must not contain symbolic links.")
    except ValueError as error:
        raise MetaAgentError("meta_input_path_invalid", "MetaAgent input paths must stay inside the workspace.") from error
    candidate = lexical.resolve()
    if os.path.commonpath([str(workspace), str(candidate)]) != str(workspace):
        raise MetaAgentError("meta_input_path_invalid", "MetaAgent input paths must stay inside the workspace.")
    if directory and not candidate.is_dir():
        raise MetaAgentError("meta_input_path_invalid", "The supplied MetaAgent PDF directory does not exist.")
    if not directory and not candidate.is_file():
        raise MetaAgentError("meta_input_path_invalid", "The supplied MetaAgent data file does not exist.")
    if candidate.is_symlink() or (suffix and candidate.suffix.casefold() != suffix):
        raise MetaAgentError("meta_input_path_invalid", "The supplied MetaAgent input has an invalid type.")
    return candidate


def capabilities():
    root = _meta_root()
    python = _meta_python(root)
    _model_environment()
    return {
        "status": "success",
        "summary": "MetaAgent is configured for managed EviMed execution.",
        "data": {
            "available": True,
            "model": "deepseek-v4-pro",
            "thinking": True,
            "execution": "managed-background-job",
            "supportedActions": ["capabilities", "start", "status"],
            "python": python.name,
        },
        "sources": [{"id": "metaagent:local", "source": "MetaAgent", "retrievedAt": _now()}],
    }


def start_job(arguments):
    topic = str(arguments.get("topic") or "").strip()
    if not topic:
        raise MetaAgentError("meta_topic_required", "A concrete meta-analysis topic is required.")
    root = _meta_root()
    python = _meta_python(root)
    model_environment = _model_environment()
    workspace = _workspace()
    job_id = "%s%s-%s" % (JOB_ID_PATTERN, time.strftime("%Y%m%d%H%M%S"), secrets.token_hex(6))
    run_root = workspace / "meta-analysis-runs"
    user_pdf_directory = _workspace_input(
        workspace, arguments.get("userPdfDirectory"), directory=True
    )
    ipd_data = _workspace_input(
        workspace, arguments.get("ipdData"), directory=False, suffix=".json"
    )
    _ensure_managed_directory(workspace, run_root)
    _ensure_managed_directory(workspace, run_root / ".jobs")
    job_root = run_root / job_id
    _ensure_managed_directory(workspace, job_root)
    output_root = job_root / "output"
    _ensure_managed_directory(workspace, output_root)
    _, state_path, log_path = _job_paths(job_id)
    state = {
        "schemaVersion": 1,
        "jobId": job_id,
        "status": "queued",
        "topic": topic,
        "outputLanguage": arguments.get("outputLanguage") or None,
        "maxPapers": arguments.get("maxPapers") or None,
        "analysisType": arguments.get("analysisType") or None,
        "userPdfDirectory": str(user_pdf_directory) if user_pdf_directory else None,
        "ipdData": str(ipd_data) if ipd_data else None,
        "createdAt": _now(),
        "updatedAt": _now(),
        "metaRoot": str(root),
        "metaPython": str(python),
        "executionEvidence": _execution_evidence(root),
        "outputRoot": str(output_root),
        "workspace": str(workspace),
        "artifacts": [],
    }
    _atomic_json(state_path, state)
    environment = {
        key: value
        for key, value in os.environ.items()
        if key in {
            "PATH",
            "HOME",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "SSL_CERT_FILE",
            "REQUESTS_CA_BUNDLE",
            "OPEN_SCIENCE_WORKSPACE_DIR",
        }
    }
    environment.update(model_environment)
    try:
        worker = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--run-job", str(state_path)],
            cwd=str(workspace),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        _BACKGROUND_WORKERS[job_id] = worker
    except OSError as error:
        state.update({
            "status": "failed",
            "updatedAt": _now(),
            "finishedAt": _now(),
            "retryable": True,
            "error": "The managed MetaAgent worker could not be started.",
        })
        _atomic_json(state_path, state)
        raise MetaAgentError(
            "meta_agent_worker_unavailable",
            "The managed MetaAgent worker could not be started.",
            True,
        ) from error
    return {
        "status": "warning",
        "summary": "MetaAgent job %s has started in the background." % job_id,
        "data": {"jobId": job_id, "jobStatus": "queued"},
        "sources": [_source(job_id)],
        "warnings": ["The evidence synthesis is still running; do not present interim files as final results."],
        "next_actions": ["Call evimed_meta_analysis with action=status and this jobId until it finishes."],
    }


def _log_tail(path):
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        size = os.fstat(descriptor).st_size
        os.lseek(descriptor, max(0, size - MAX_LOG_TAIL_BYTES), os.SEEK_SET)
        return os.read(descriptor, MAX_LOG_TAIL_BYTES).decode("utf-8", errors="replace")
    except OSError:
        return ""
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _reap_worker(job_id):
    worker = _BACKGROUND_WORKERS.pop(job_id, None)
    if worker is None:
        return
    try:
        worker.wait(timeout=1)
    except subprocess.TimeoutExpired:
        _BACKGROUND_WORKERS[job_id] = worker


def _worker_is_alive(job_id, state):
    worker = _BACKGROUND_WORKERS.get(job_id)
    if worker is not None:
        return worker.poll() is None
    try:
        worker_pid = int(state.get("workerPid"))
    except (TypeError, ValueError):
        return None
    if worker_pid <= 0:
        return None
    try:
        os.kill(worker_pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _recover_orphaned_terminal_state(state_path, state):
    """Recover a terminal state only from complete, workspace-scoped evidence."""
    workspace = _workspace()
    try:
        recorded_workspace = Path(str(state.get("workspace") or "")).resolve(strict=True)
        lexical_output = Path(str(state.get("outputRoot") or ""))
        resolved_output = lexical_output.resolve(strict=True)
        relative_output = resolved_output.relative_to(workspace)
    except (OSError, ValueError):
        raise MetaAgentError("meta_job_state_invalid", "MetaAgent job paths are invalid.")
    if recorded_workspace != workspace or not lexical_output.is_absolute():
        raise MetaAgentError("meta_job_state_invalid", "MetaAgent job paths are invalid.")
    current = workspace
    for part in relative_output.parts:
        current = current / part
        if current.is_symlink():
            raise MetaAgentError("meta_job_state_invalid", "MetaAgent output paths must not contain symbolic links.")
    output_root = resolved_output
    if os.path.commonpath([str(workspace), str(output_root)]) != str(workspace):
        raise MetaAgentError("meta_job_state_invalid", "MetaAgent output escaped the managed workspace.")
    projects = sorted(
        (
            entry for entry in output_root.iterdir()
            if entry.is_dir() and not entry.is_symlink()
        ),
        key=lambda entry: entry.stat().st_mtime_ns,
        reverse=True,
    )
    project = projects[0].resolve() if projects else None
    release_file = project / "package" / "release_decision.json" if project else None
    release = None
    if release_file and release_file.is_file() and not release_file.is_symlink():
        try:
            candidate = _read_json_no_follow(release_file)
            if isinstance(candidate, dict):
                release = candidate
        except MetaAgentError:
            release = None
    release_status = str((release or {}).get("status") or "unknown")
    if project and release_status in {"ready", "blocked", "review_required", "warning"}:
        state.update({
            "status": "succeeded" if release_status == "ready" else "blocked",
            "updatedAt": _now(),
            "finishedAt": _now(),
            "projectRelativePath": project.relative_to(workspace).as_posix(),
            "releaseStatus": release_status,
            "nextActions": [
                str(item) for item in (release or {}).get("next_actions", [])
                if str(item).strip()
            ][:20],
            "artifacts": _relative_artifacts(workspace, project),
            "recoveredTerminalState": True,
        })
    else:
        state.update({
            "status": "failed",
            "updatedAt": _now(),
            "finishedAt": _now(),
            "retryable": True,
            "error": "MetaAgent worker exited before recording a complete terminal state.",
            "recoveredTerminalState": True,
        })
    _atomic_json(state_path, state)
    return state


def status_job(arguments):
    job_id = str(arguments.get("jobId") or "").strip()
    _, state_path, log_path = _job_paths(job_id)
    state = _read_json_no_follow(state_path)
    if state.get("jobId") != job_id:
        raise MetaAgentError("meta_job_state_invalid", "MetaAgent job state does not match the requested job.")
    job_status = state.get("status")
    if job_status in {"queued", "running"}:
        worker_alive = _worker_is_alive(job_id, state)
        if worker_alive is False:
            state = _recover_orphaned_terminal_state(state_path, state)
            job_status = state.get("status")
        elif worker_alive is None and job_status == "queued":
            # A freshly spawned worker may not have written its PID yet.
            return {
                "status": "warning",
                "summary": "MetaAgent job %s is %s." % (job_id, job_status),
                "data": {"jobId": job_id, "jobStatus": job_status, "updatedAt": state.get("updatedAt")},
                "sources": [_source(job_id)],
                "warnings": ["The evidence synthesis is not complete; do not draw final conclusions yet."],
                "next_actions": ["Poll this job again after additional processing time."],
            }
    if job_status in {"queued", "running"}:
        return {
            "status": "warning",
            "summary": "MetaAgent job %s is %s." % (job_id, job_status),
            "data": {"jobId": job_id, "jobStatus": job_status, "updatedAt": state.get("updatedAt")},
            "sources": [_source(job_id)],
            "warnings": ["The evidence synthesis is not complete; do not draw final conclusions yet."],
            "next_actions": ["Poll this job again after additional processing time."],
        }
    if job_status == "failed":
        _reap_worker(job_id)
        message = str(state.get("error") or "MetaAgent execution failed.")
        tail = _log_tail(log_path)
        return {
            "status": "error",
            "summary": message,
            "data": {
                "jobId": job_id,
                "jobStatus": job_status,
                "updatedAt": state.get("updatedAt"),
            },
            "next_actions": ["Review the bounded job log, correct the reported input or service issue, and start a new job."],
            "error": {
                "code": "meta_agent_execution_failed",
                "message": message + ((" Log tail: " + tail[-2000:]) if tail else ""),
                "retryable": bool(state.get("retryable", False)),
                "stopReason": "Stop until the failed MetaAgent job is reviewed.",
            },
        }
    if job_status not in {"succeeded", "blocked"}:
        raise MetaAgentError("meta_job_state_invalid", "MetaAgent job state has an unsupported status.")
    _reap_worker(job_id)
    release_status = str(state.get("releaseStatus") or "unknown")
    result_status = "success" if job_status == "succeeded" and release_status == "ready" else "warning"
    result = {
        "status": result_status,
        "summary": "MetaAgent job %s completed with release status %s." % (job_id, release_status),
        "data": {
            "jobId": job_id,
            "jobStatus": job_status,
            "releaseStatus": release_status,
            "projectPath": state.get("projectRelativePath"),
        },
        "sources": [_source(job_id)],
        "artifacts": state.get("artifacts") or [],
    }
    if result_status == "warning":
        result["warnings"] = [
            "The generated package has warnings or blocking release gates; preserve that status in every summary."
        ]
        result["next_actions"] = state.get("nextActions") or [
            "Review release_decision.json and resolve its listed gates before treating the package as submission-ready."
        ]
    return result


def call(arguments):
    action = arguments.get("action")
    try:
        if action == "capabilities":
            return capabilities()
        if action == "start":
            return start_job(arguments)
        if action == "status":
            return status_job(arguments)
        raise MetaAgentError("meta_action_invalid", "Unsupported MetaAgent action.")
    except MetaAgentError as error:
        return {
            "status": "error",
            "summary": str(error),
            "next_actions": ["Correct the MetaAgent configuration or request before retrying."],
            "error": {
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
                "stopReason": "Stop until the MetaAgent precondition is satisfied.",
            },
        }


def _relative_artifacts(workspace, project):
    candidates = [
        ("manuscript", project / "manuscript" / "draft.md"),
        ("manuscript_pdf", project / "manuscript" / "draft.pdf"),
        ("manuscript_docx", project / "manuscript" / "draft.docx"),
        ("release_decision", project / "package" / "release_decision.json"),
        ("review_package", project / "package" / "metaagent_export.zip"),
        ("analysis", project / "analysis" / "meta_analysis.json"),
    ]
    artifacts = []
    for kind, path in candidates:
        if path.is_file():
            artifacts.append({"kind": kind, "path": path.relative_to(workspace).as_posix()})
    return artifacts


def _run_job(state_path):
    state_path = Path(state_path).resolve()
    state = _read_json_no_follow(state_path)
    workspace = Path(state["workspace"]).resolve()
    output_root = Path(state["outputRoot"]).resolve()
    root = Path(state["metaRoot"]).resolve()
    python = Path(os.path.abspath(state["metaPython"]))
    if state.get("executionEvidence") != _execution_evidence(root):
        raise MetaAgentError(
            "meta_source_evidence_mismatch",
            "MetaAgent source or execution adapter changed after this job was queued.",
        )
    try:
        resolved_python = python.resolve(strict=True)
    except OSError as error:
        raise MetaAgentError(
            "meta_agent_python_unavailable",
            "The MetaAgent Python runtime is unavailable.",
            True,
        ) from error
    if not resolved_python.is_file() or not os.access(resolved_python, os.X_OK):
        raise MetaAgentError(
            "meta_agent_python_unavailable",
            "The MetaAgent Python runtime is not executable.",
        )
    if os.path.commonpath([str(workspace), str(output_root)]) != str(workspace):
        raise MetaAgentError("meta_output_scope_invalid", "MetaAgent output escaped the managed workspace.")
    state["status"] = "running"
    state["workerPid"] = os.getpid()
    state["startedAt"] = _now()
    state["updatedAt"] = _now()
    _atomic_json(state_path, state)
    command = [
        str(python), "-m", "new_meta.main",
        "--topic", state["topic"],
        "--output-dir", str(output_root),
        "--model", "deepseek-v4-pro",
        "--skip-confirm",
        "--run-mode", "review",
    ]
    if state.get("outputLanguage"):
        command.extend(["--language", str(state["outputLanguage"])])
    if state.get("maxPapers"):
        command.extend(["--max-papers", str(state["maxPapers"])])
    if state.get("analysisType"):
        command.extend(["--analysis-type", str(state["analysisType"])])
    if state.get("userPdfDirectory"):
        command.extend(["--user-pdfs", str(state["userPdfDirectory"])])
    if state.get("ipdData"):
        command.extend(["--ipd-data", str(state["ipdData"])])
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(root)
    _, _, log_path = _job_paths(state["jobId"])
    log_descriptor = os.open(
        log_path,
        os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    with os.fdopen(log_descriptor, "ab", buffering=0) as log:
        completed = subprocess.run(
            command,
            cwd=str(root),
            env=environment,
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
    if not projects:
        state.update({
            "status": "failed",
            "updatedAt": _now(),
            "finishedAt": _now(),
            "returnCode": completed.returncode,
            "retryable": completed.returncode in {75, 137, 143},
            "error": "MetaAgent exited with code %d." % completed.returncode,
        })
        _atomic_json(state_path, state)
        return completed.returncode or 1
    project = projects[0].resolve()
    if os.path.commonpath([str(output_root), str(project)]) != str(output_root):
        raise MetaAgentError("meta_output_scope_invalid", "MetaAgent project output escaped its job directory.")
    release_file = project / "package" / "release_decision.json"
    release = {}
    if release_file.is_file():
        try:
            release = json.loads(release_file.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            release = {}
    release_status = str(release.get("status") or "unknown")
    expected_release_block = (
        completed.returncode == 2
        and release_status in {"blocked", "review_required", "warning"}
    )
    if completed.returncode != 0 and not expected_release_block:
        state.update({
            "status": "failed",
            "updatedAt": _now(),
            "finishedAt": _now(),
            "returnCode": completed.returncode,
            "retryable": completed.returncode in {75, 137, 143},
            "error": "MetaAgent exited with code %d." % completed.returncode,
        })
        _atomic_json(state_path, state)
        return completed.returncode or 1
    if state.get("executionEvidence") != _execution_evidence(root):
        raise MetaAgentError(
            "meta_source_evidence_mismatch",
            "MetaAgent source or execution adapter changed while this job was running.",
        )
    state.update({
        "status": "succeeded" if release_status == "ready" else "blocked",
        "updatedAt": _now(),
        "finishedAt": _now(),
        "returnCode": completed.returncode,
        "projectRelativePath": project.relative_to(workspace).as_posix(),
        "releaseStatus": release_status,
        "nextActions": [str(item) for item in release.get("next_actions", []) if str(item).strip()][:20],
        "artifacts": _relative_artifacts(workspace, project),
    })
    _atomic_json(state_path, state)
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--run-job":
        try:
            raise SystemExit(_run_job(sys.argv[2]))
        except Exception as error:
            try:
                state = _read_json_no_follow(sys.argv[2])
                state.update({
                    "status": "failed",
                    "updatedAt": _now(),
                    "finishedAt": _now(),
                    "retryable": False,
                    "error": str(error),
                })
                _atomic_json(sys.argv[2], state)
            except Exception:
                pass
            raise SystemExit(1)
    raise SystemExit(2)
