"""Isolated hosted MR execution and descriptor-bound publication.

The hosted adapter has its own /tmp tmpfs, outside the customer /data mount.
The worker's in-memory preparation becomes an anonymous read-only pipe for the
fixed runner. Workspace paths are never reopened for runner input or output.
"""

import copy
import hashlib
import json
import os
import stat
import subprocess
import tempfile
import threading
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


def _analysis_access(inputs, directory):
    # Only this private staging tree becomes accessible to the analysis group.
    # Root retains ownership; SETGID suffices, so CHOWN/DAC overrides stay absent.
    os.fchmod(directory, 0o770)
    for name in os.listdir(directory):
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            with inputs.directory_fd(directory, (name,)) as child:
                _analysis_access(inputs, child)
        else:
            with inputs._regular_file(directory, (name,)) as descriptor:
                os.fchmod(descriptor, 0o660)


def execute(inputs: Any, job: Job, environment: dict[str, str], *, analysis_credentials=None) -> dict[str, Any]:
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
                with (
                    tempfile.TemporaryDirectory(prefix="evimed-mr-job-", dir="/tmp") as temporary,
                    tempfile.TemporaryDirectory(prefix="evimed-mr-scratch-", dir="/tmp") as scratch,
                ):
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
                            completed = subprocess.run(
                                command,
                                cwd=str(job.runner.parent),
                                env=child_environment,
                                pass_fds=(proof, stage),
                                stdin=subprocess.DEVNULL,
                                stdout=log,
                                stderr=subprocess.STDOUT,
                                check=False,
                                timeout=job.timeout,
                                **(analysis_credentials or {}),
                            )
                        result = _read_result(inputs, stage)
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
