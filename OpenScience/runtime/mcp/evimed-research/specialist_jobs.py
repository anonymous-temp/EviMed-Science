"""Managed execution for EviMed specialist research agents.

The model can select a specialist and provide typed research inputs, but it
cannot provide a command, executable, environment variable, or output path.
Every job runs a fixed operator-installed adapter and writes only below the
current EviMed workspace.
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
_BACKGROUND_WORKERS = {}
PROJECT_ENV_ALLOWLIST = {
    "EVIMED_EVIDENCE_SEARCH_KEY_FILE",
    "EVIMED_EVIDENCE_SEARCH_URL",
    "NCBI_API_KEY",
    "NCBI_EMAIL",
    "OPENFDA_API_KEY",
    "OPENFDA_BASE_URL",
    "OPENGWAS_JWT",
    "PUBMED_EMAIL",
    "UMLS_API_KEY",
}


SPECS = {
    "mendelian_randomization": {
        "id": "mendelian-randomization",
        "label": "Mendelian randomization",
        "prefix": "mr-",
        "rootEnv": "EVIMED_MR_AGENT_ROOT",
        "pythonEnv": "EVIMED_MR_AGENT_PYTHON",
        "marker": "mr_agent/core/engine.py",
        "directory": "mendelian-randomization-runs",
        "required": ("exposure", "outcome"),
        "inputs": ("exposure", "outcome", "outputLanguage", "analysisDirection"),
    },
    "bibliometric_analysis": {
        "id": "bibliometric-analysis",
        "label": "Bibliometric analysis",
        "prefix": "bibliometric-",
        "rootEnv": "EVIMED_BIBLIOMETRIC_AGENT_ROOT",
        "pythonEnv": "EVIMED_BIBLIOMETRIC_AGENT_PYTHON",
        "marker": "src/bibliometric/pipeline.py",
        "directory": "bibliometric-analysis-runs",
        "required": ("topic",),
        "inputs": ("topic", "dateFrom", "dateTo", "maxRecords", "outputLanguage"),
    },
    "research_topic_selection": {
        "id": "research-topic-selection",
        "label": "Research topic selection",
        "prefix": "topic-",
        "rootEnv": "EVIMED_RESEARCH_TOPIC_AGENT_ROOT",
        "pythonEnv": "EVIMED_RESEARCH_TOPIC_AGENT_PYTHON",
        "marker": "services/task_service.py",
        "directory": "research-topic-runs",
        "required": ("researchDirection",),
        "inputs": ("researchDirection", "outputLanguage"),
    },
    "peer_review": {
        "id": "peer-review",
        "label": "Peer review",
        "prefix": "review-",
        "rootEnv": "EVIMED_PEER_REVIEW_AGENT_ROOT",
        "pythonEnv": "EVIMED_PEER_REVIEW_AGENT_PYTHON",
        "marker": "src/main_v2.py",
        "directory": "peer-review-runs",
        "required": ("manuscript",),
        "inputs": ("manuscript", "articleType", "outputLanguage"),
    },
    "drug_safety_analysis": {
        "id": "drug-safety-analysis",
        "label": "Drug safety analysis",
        "prefix": "safety-",
        "rootEnv": "EVIMED_DRUG_SAFETY_AGENT_ROOT",
        "pythonEnv": "EVIMED_DRUG_SAFETY_AGENT_PYTHON",
        "marker": "safety_agent/analysis/pipeline.py",
        "directory": "drug-safety-runs",
        "required": ("drug",),
        "inputs": (
            "drug", "reactions", "outputLanguage", "drugAliases", "suspectRoles",
            "administrationRoutes", "studyDateFrom", "studyDateTo",
            "backgroundDateFrom", "backgroundDateTo",
        ),
    },
}


class SpecialistJobError(Exception):
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
        raise SpecialistJobError("specialist_job_state_invalid", "Specialist job state must not be a symbolic link.")
    temporary = path.with_name(".%s.%s.tmp" % (path.name, secrets.token_hex(8)))
    payload = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
    if len(payload) > MAX_STATE_BYTES:
        raise SpecialistJobError("specialist_job_state_too_large", "Specialist job state exceeded its size limit.")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def _read_json(path):
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size <= 0 or before.st_size > MAX_STATE_BYTES:
            raise SpecialistJobError("specialist_job_state_invalid", "Specialist job state is invalid.")
        raw = os.read(descriptor, MAX_STATE_BYTES + 1)
        after = os.fstat(descriptor)
        if (
            len(raw) > MAX_STATE_BYTES
            or before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
        ):
            raise SpecialistJobError("specialist_job_state_invalid", "Specialist job state changed while it was read.")
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("state must be an object")
        return value
    except SpecialistJobError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise SpecialistJobError("specialist_job_state_invalid", "Specialist job state could not be read.") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _workspace():
    raw = os.environ.get("OPEN_SCIENCE_WORKSPACE_DIR", "").strip()
    if not raw or not os.path.isabs(raw) or "\0" in raw:
        raise SpecialistJobError("specialist_workspace_invalid", "The managed project workspace is unavailable.")
    candidate = Path(raw)
    if candidate.is_symlink():
        raise SpecialistJobError("specialist_workspace_invalid", "The managed project workspace is unavailable.")
    workspace = candidate.resolve()
    if not workspace.is_dir():
        raise SpecialistJobError("specialist_workspace_invalid", "The managed project workspace is unavailable.")
    return workspace


def _execution_timeout_seconds():
    """Wall clock for one specialist process, bounded well inside the server's run monitor."""
    try:
        configured = float(os.environ.get("EVIMED_SPECIALIST_EXECUTION_TIMEOUT_SECONDS", "10800"))
    except ValueError:
        configured = 10800.0
    return int(min(max(configured, 60.0), 14400.0))


def _root(spec):
    raw = os.environ.get(spec["rootEnv"], "").strip()
    if not raw:
        raise SpecialistJobError("specialist_agent_unconfigured", "%s is not installed in this runtime." % spec["label"])
    if not os.path.isabs(raw) or "\0" in raw:
        raise SpecialistJobError("specialist_agent_root_invalid", "%s must be an absolute path." % spec["rootEnv"])
    root = Path(raw).resolve()
    if not root.is_dir() or not (root / spec["marker"]).is_file() or not (root / "evimed_runner.py").is_file():
        raise SpecialistJobError("specialist_agent_unavailable", "The configured %s package is unavailable." % spec["label"], True)
    return root


def _python(spec, root):
    configured = os.environ.get(spec["pythonEnv"], "").strip()
    candidate = Path(configured) if configured else root / ".venv" / "bin" / "python"
    if not candidate.is_absolute() or "\0" in str(candidate):
        raise SpecialistJobError("specialist_python_unavailable", "%s Python runtime must be an absolute path." % spec["label"])
    executable = Path(os.path.abspath(candidate))
    try:
        resolved = executable.resolve(strict=True)
    except OSError as error:
        raise SpecialistJobError("specialist_python_unavailable", "%s Python runtime is unavailable." % spec["label"], True) from error
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise SpecialistJobError("specialist_python_unavailable", "%s Python runtime is not executable." % spec["label"])
    # Execute the lexical venv entry point. Resolving this symlink would launch
    # the base interpreter and silently discard the virtual environment.
    return executable


def _model_environment():
    raw = os.environ.get("EVIMED_MODEL_CONFIG_FILE", "").strip()
    if not raw or not os.path.isabs(raw) or "\0" in raw:
        raise SpecialistJobError("specialist_model_config_unavailable", "The managed model configuration is unavailable.", True)
    config = _read_json(raw)
    provider = config.get("provider", {}).get("deepseek", {})
    options = provider.get("options", {}) if isinstance(provider, dict) else {}
    models = provider.get("models", {}) if isinstance(provider, dict) else {}
    base_url = options.get("baseURL") if isinstance(options, dict) else None
    api_key = options.get("apiKey") if isinstance(options, dict) else None
    if (
        not isinstance(base_url, str)
        or not base_url.startswith(("http://", "https://"))
        or not isinstance(api_key, str)
        or not api_key
        or not isinstance(models, dict)
        or "deepseek-v4-pro" not in models
    ):
        raise SpecialistJobError("specialist_model_config_unavailable", "DeepSeek V4 Pro is not configured for this runtime.", True)
    return {
        "DEEPSEEK_API_KEY": api_key,
        "DEEPSEEK_BASE_URL": base_url.rstrip("/"),
        "DEEPSEEK_PRO_MODEL": "deepseek-v4-pro",
        "DEEPSEEK_FLASH_MODEL": "deepseek-v4-pro",
        "LLM_API_KEY": api_key,
        "LLM_BASE_URL": base_url.rstrip("/"),
        "LLM_MODEL": "deepseek-v4-pro",
        "LLM_ENABLE_THINKING": "true",
        "LLM_REASONING_EFFORT": "high",
        "LLM_MAX_CONCURRENT": "2",
        "MAX_CONCURRENT_REVIEWS": "1",
        "MAX_CONCURRENT_REVIEWS_V2": "1",
    }


def _project_environment(root):
    """Read non-model research credentials from an operator-owned project file."""
    path = Path(root) / ".env"
    if not path.is_file() or path.is_symlink():
        return {}
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        if os.fstat(descriptor).st_size > MAX_STATE_BYTES:
            raise SpecialistJobError("specialist_project_env_invalid", "Specialist project environment is too large.")
        payload = os.read(descriptor, MAX_STATE_BYTES + 1).decode("utf-8")
    finally:
        os.close(descriptor)
    environment = {}
    for raw_line in payload.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or key not in PROJECT_ENV_ALLOWLIST:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if value:
            environment[key] = value
    return environment


def _workspace_file(workspace, value, allowed_suffixes):
    raw = str(value or "").strip()
    if not raw or os.path.isabs(raw) or "\0" in raw:
        raise SpecialistJobError("specialist_input_path_invalid", "Specialist input paths must be workspace-relative.")
    lexical = workspace / raw
    current = workspace
    try:
        for part in lexical.relative_to(workspace).parts:
            current = current / part
            if current.is_symlink():
                raise SpecialistJobError("specialist_input_path_invalid", "Specialist input paths must not contain symbolic links.")
    except ValueError as error:
        raise SpecialistJobError("specialist_input_path_invalid", "Specialist input paths must stay inside the workspace.") from error
    candidate = lexical.resolve()
    if os.path.commonpath([str(workspace), str(candidate)]) != str(workspace) or not candidate.is_file():
        raise SpecialistJobError("specialist_input_path_invalid", "The supplied specialist input file does not exist.")
    if candidate.suffix.casefold() not in allowed_suffixes:
        raise SpecialistJobError("specialist_input_path_invalid", "The supplied specialist input file type is unsupported.")
    return candidate


def _paths(spec, job_id):
    if not isinstance(job_id, str) or not job_id.startswith(spec["prefix"]):
        raise SpecialistJobError("specialist_job_id_invalid", "The specialist job id is invalid.")
    suffix = job_id[len(spec["prefix"]):]
    if not suffix or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in suffix):
        raise SpecialistJobError("specialist_job_id_invalid", "The specialist job id is invalid.")
    workspace = _workspace()
    jobs = workspace / spec["directory"] / ".jobs"
    for managed in (jobs.parent, jobs):
        if managed.exists() and managed.is_symlink():
            raise SpecialistJobError("specialist_job_state_invalid", "Specialist job directories must not be symbolic links.")
    return workspace, jobs / (job_id + ".json"), jobs / (job_id + ".log")


def _ensure_directory(workspace, target):
    target = Path(target)
    target.mkdir(parents=False, exist_ok=True, mode=0o700)
    if target.is_symlink() or os.path.commonpath([str(workspace), str(target.resolve())]) != str(workspace):
        raise SpecialistJobError("specialist_output_scope_invalid", "Specialist output must stay inside the workspace.")


def _source(spec, job_id):
    return {"id": "%s:%s" % (spec["id"], job_id), "source": spec["label"], "retrievedAt": _now()}


def _execution_evidence(root):
    return execution_evidence(root, Path(__file__))


def capabilities(tool_name):
    spec = SPECS[tool_name]
    root = _root(spec)
    python = _python(spec, root)
    _model_environment()
    return {
        "status": "success",
        "summary": "%s is configured for managed EviMed execution." % spec["label"],
        "data": {
            "available": True,
            "model": "deepseek-v4-pro",
            "thinking": True,
            "execution": "managed-background-job",
            "supportedActions": ["capabilities", "start", "status"],
            "python": python.name,
        },
        "sources": [{"id": "%s:local" % spec["id"], "source": spec["label"], "retrievedAt": _now()}],
    }


def start_job(tool_name, arguments):
    spec = SPECS[tool_name]
    for required in spec["required"]:
        if not str(arguments.get(required) or "").strip():
            raise SpecialistJobError("specialist_input_required", "%s requires %s." % (spec["label"], required))
    root = _root(spec)
    python = _python(spec, root)
    model_environment = _model_environment()
    workspace = _workspace()
    request = {key: arguments.get(key) for key in spec["inputs"] if arguments.get(key) is not None}
    if tool_name == "peer_review":
        request["manuscript"] = str(_workspace_file(workspace, request["manuscript"], {".pdf", ".docx", ".txt", ".md"}))
    job_id = "%s%s-%s" % (spec["prefix"], time.strftime("%Y%m%d%H%M%S"), secrets.token_hex(6))
    run_root = workspace / spec["directory"]
    _ensure_directory(workspace, run_root)
    _ensure_directory(workspace, run_root / ".jobs")
    job_root = run_root / job_id
    _ensure_directory(workspace, job_root)
    output_root = job_root / "output"
    _ensure_directory(workspace, output_root)
    _, state_path, _ = _paths(spec, job_id)
    state = {
        "schemaVersion": 1,
        "tool": tool_name,
        "jobId": job_id,
        "status": "queued",
        "request": request,
        "createdAt": _now(),
        "updatedAt": _now(),
        "root": str(root),
        "python": str(python),
        "executionEvidence": _execution_evidence(root),
        "workspace": str(workspace),
        "outputRoot": str(output_root),
        "artifacts": [],
    }
    _atomic_json(state_path, state)
    environment = {key: value for key, value in os.environ.items() if key in {
        "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE",
        "NCBI_API_KEY", "OPENGWAS_JWT", "OPEN_SCIENCE_WORKSPACE_DIR",
    }}
    environment.update(_project_environment(root))
    environment.update(model_environment)
    environment[spec["rootEnv"]] = str(root)
    environment[spec["pythonEnv"]] = str(python)
    if tool_name == "mendelian_randomization" and (root / ".r-lib").is_dir():
        environment["R_LIBS_USER"] = str(root / ".r-lib")
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
        state.update({"status": "failed", "updatedAt": _now(), "finishedAt": _now(), "retryable": True, "error": "The managed specialist worker could not be started."})
        _atomic_json(state_path, state)
        raise SpecialistJobError("specialist_worker_unavailable", "The managed specialist worker could not be started.", True) from error
    return {
        "status": "warning",
        "summary": "%s job %s has started in the background." % (spec["label"], job_id),
        "data": {"jobId": job_id, "jobStatus": "queued"},
        "sources": [_source(spec, job_id)],
        "warnings": ["The specialist analysis is still running; do not present interim files as final results."],
        "next_actions": ["Call %s with action=status and this jobId until it finishes." % tool_name],
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


def _worker_is_alive(job_id, state):
    """True, False, or None when liveness cannot be established."""
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
    except ProcessLookupError:
        return False
    except PermissionError:
        # The pid exists and belongs to someone else. Reading that as "gone"
        # would fail a job that is still running.
        return True
    return True


def _abandon_lost_job(spec, state_path, state):
    """Mark a job whose worker died without writing a terminal state."""
    state.update({
        "status": "failed",
        "updatedAt": _now(),
        "finishedAt": _now(),
        "retryable": True,
        "error": "%s worker exited without writing a result." % spec["label"],
    })
    try:
        _atomic_json(state_path, state)
    except OSError:
        # Best effort. The liveness check below reaches the same conclusion on
        # every later poll, so an unwritable state file no longer strands the
        # job in "running" the way it used to.
        pass
    return state


def status_job(tool_name, arguments):
    spec = SPECS[tool_name]
    job_id = str(arguments.get("jobId") or "").strip()
    _, state_path, log_path = _paths(spec, job_id)
    state = _read_json(state_path)
    if state.get("jobId") != job_id or state.get("tool") != tool_name:
        raise SpecialistJobError("specialist_job_state_invalid", "Specialist job state does not match the request.")
    job_status = state.get("status")
    if job_status in {"queued", "running"} and _worker_is_alive(job_id, state) is False:
        # A SIGKILL, an OOM kill, or a failure while writing the failed state
        # left the job saying "running" forever, and this tool answered "still
        # working, poll again" forever with it. Re-read once first: the worker
        # may have written its terminal state between the two reads.
        reread = _read_json(state_path)
        if reread.get("jobId") == job_id and reread.get("status") not in {"queued", "running"}:
            state = reread
        else:
            state = _abandon_lost_job(spec, state_path, state)
        job_status = state.get("status")
    if job_status in {"queued", "running"}:
        return {
            "status": "warning",
            "summary": "%s job %s is %s." % (spec["label"], job_id, job_status),
            "data": {"jobId": job_id, "jobStatus": job_status, "updatedAt": state.get("updatedAt")},
            "sources": [_source(spec, job_id)],
            "warnings": ["The specialist analysis is not complete; do not draw final conclusions yet."],
            "next_actions": ["Poll this job again after additional processing time."],
        }
    if job_status == "failed":
        tail = _log_tail(log_path)
        message = str(state.get("error") or "%s execution failed." % spec["label"])
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
                "code": "specialist_execution_failed",
                "message": message + ((" Log tail: " + tail[-2000:]) if tail else ""),
                "retryable": bool(state.get("retryable", False)),
                "stopReason": "Stop until the failed specialist job is reviewed.",
            },
        }
    if job_status != "succeeded":
        raise SpecialistJobError("specialist_job_state_invalid", "Specialist job state has an unsupported status.")
    return {
        "status": "success",
        "summary": "%s job %s completed." % (spec["label"], job_id),
        "data": {"jobId": job_id, "jobStatus": job_status},
        "sources": [_source(spec, job_id)],
        "artifacts": state.get("artifacts") or [],
    }


def call(tool_name, arguments):
    try:
        action = arguments.get("action")
        if action == "capabilities":
            return capabilities(tool_name)
        if action == "start":
            return start_job(tool_name, arguments)
        if action == "status":
            return status_job(tool_name, arguments)
        raise SpecialistJobError("specialist_action_invalid", "Unsupported specialist action.")
    except SpecialistJobError as error:
        return {
            "status": "error",
            "summary": str(error),
            "next_actions": ["Correct the specialist configuration or request before retrying."],
            "error": {
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
                "stopReason": "Stop until the specialist precondition is satisfied.",
            },
        }


def _collect_artifacts(workspace, output_root):
    artifacts = []
    for path in sorted(output_root.rglob("*")):
        if path.is_file() and not path.is_symlink():
            artifacts.append({"kind": path.suffix.lstrip(".") or "file", "path": path.relative_to(workspace).as_posix()})
    return artifacts[:100]


def _run_job(state_path):
    state_path = Path(state_path).resolve()
    state = _read_json(state_path)
    spec = SPECS[state["tool"]]
    workspace = _workspace()
    root = _root(spec)
    python = _python(spec, root)
    if state.get("executionEvidence") != _execution_evidence(root):
        raise SpecialistJobError(
            "specialist_source_evidence_mismatch",
            "Specialist source or execution adapter changed after this job was queued.",
        )
    expected_workspace, expected_state_path, _ = _paths(spec, state.get("jobId"))
    output_root = workspace / spec["directory"] / state["jobId"] / "output"
    if (
        expected_workspace != workspace
        or expected_state_path.resolve() != state_path
        or Path(state.get("workspace", "")).resolve() != workspace
        or Path(state.get("root", "")).resolve() != root
        or os.path.abspath(state.get("python", "")) != str(python)
        or Path(state.get("outputRoot", "")).resolve() != output_root.resolve()
        or os.path.commonpath([str(workspace), str(output_root.resolve())]) != str(workspace)
    ):
        raise SpecialistJobError("specialist_job_state_invalid", "Specialist execution state does not match the operator configuration.")
    state.update({"status": "running", "workerPid": os.getpid(), "startedAt": _now(), "updatedAt": _now()})
    _atomic_json(state_path, state)
    request_path = output_root / "request.json"
    _atomic_json(request_path, state["request"])
    _, _, log_path = _paths(spec, state["jobId"])
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(root)
    command = [str(python), str(root / "evimed_runner.py"), "--request", str(request_path), "--output-dir", str(output_root)]
    log_descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(log_descriptor, "ab", buffering=0) as log:
        try:
            completed = subprocess.run(
                command,
                cwd=str(root),
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
                # A specialist process that hangs had no wall clock of its own.
                # The only bound was the server's four-hour run monitor, and
                # that one counts polls rather than time, so a hung child could
                # outlive every limit the platform believed it had.
                timeout=_execution_timeout_seconds(),
            )
        except subprocess.TimeoutExpired:
            state.update({
                "status": "failed",
                "updatedAt": _now(),
                "finishedAt": _now(),
                "returnCode": None,
                "retryable": True,
                "error": "%s exceeded the %d second execution limit." % (spec["label"], _execution_timeout_seconds()),
            })
            _atomic_json(state_path, state)
            return 1
    result_path = output_root / "result.json"
    if completed.returncode != 0 or not result_path.is_file():
        state.update({
            "status": "failed",
            "updatedAt": _now(),
            "finishedAt": _now(),
            "returnCode": completed.returncode,
            "retryable": completed.returncode in {75, 137, 143},
            "error": "%s exited with code %d." % (spec["label"], completed.returncode),
        })
        _atomic_json(state_path, state)
        return completed.returncode or 1
    result = _read_json(result_path)
    if result.get("status") != "succeeded":
        state.update({"status": "failed", "updatedAt": _now(), "finishedAt": _now(), "returnCode": completed.returncode, "retryable": False, "error": str(result.get("error") or "%s did not produce a successful result." % spec["label"])})
        _atomic_json(state_path, state)
        return 1
    if state.get("executionEvidence") != _execution_evidence(root):
        raise SpecialistJobError(
            "specialist_source_evidence_mismatch",
            "Specialist source or execution adapter changed while this job was running.",
        )
    state.update({"status": "succeeded", "updatedAt": _now(), "finishedAt": _now(), "returnCode": completed.returncode, "artifacts": _collect_artifacts(workspace, output_root)})
    _atomic_json(state_path, state)
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--run-job":
        try:
            raise SystemExit(_run_job(sys.argv[2]))
        except Exception as error:
            try:
                state = _read_json(sys.argv[2])
                state.update({"status": "failed", "updatedAt": _now(), "finishedAt": _now(), "retryable": False, "error": str(error)})
                _atomic_json(sys.argv[2], state)
            except Exception as write_error:
                # The job stays non-terminal on disk. status_job's liveness
                # check is what stops that from reading as "still running"
                # forever, so say enough here to tell the two apart in the log.
                sys.stderr.write(
                    "specialist job failed and its failed state could not be written: %s / %s\n"
                    % (error, write_error)
                )
            raise SystemExit(1)
    raise SystemExit(2)
