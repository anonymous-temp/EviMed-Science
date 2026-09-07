"""Isolated hosted MR execution and descriptor-bound publication.

The hosted adapter has its own /tmp tmpfs, outside the customer /data mount.
The worker's in-memory preparation becomes an anonymous read-only pipe for the
fixed runner. Workspace paths are never reopened for runner input or output.
"""

import copy
import hashlib
import json
import os
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


def execute(inputs: Any, job: Job, environment: dict[str, str], *, analysis_credentials=None) -> dict[str, Any]:
    cleanup_errors = []
    try:
        outcome = _execute(inputs, job, environment, analysis_credentials, cleanup_errors)
    except inputs.MRInputError as error:
        if cleanup_errors:
            error.cleanup_error = _cleanup_error()
        raise
    if cleanup_errors:
        outcome["cleanupError"] = _cleanup_error()
    return outcome


def _execute(inputs: Any, job: Job, environment: dict[str, str], analysis_credentials, cleanup_errors) -> dict[str, Any]:
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
                        if interruption and interruption.get("errorCode") == "mr_analysis_stop_failed":
                            cleanup_errors.append("process_running")
                        result = interruption or _read_result(inputs, stage)
                        if completed.returncode != 0 or result.get("status") != "succeeded":
                            return {
                                "returnCode": completed.returncode or 1,
                                "result": result,
                                "artifacts": [],
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
                        input_receipts = [
                            {key: source[key] for key in ("path", "bytes", "sha256")}
                            for source in authority["sources"].values()
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
