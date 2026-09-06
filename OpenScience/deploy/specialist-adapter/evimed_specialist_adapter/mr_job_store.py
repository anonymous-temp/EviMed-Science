"""Authoritative MR queue state in project metadata, outside runtime mounts.

Customer runtimes mount workspace and runtime subpaths, never .openscience.
Keeping records under the project also preserves account/project deletion's
existing lifecycle. The workspace contains deliverables, not queue authority.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
from datetime import datetime, timezone
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .security import _SAFE_ID

_WORKSPACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$")
_JOB = re.compile(r"^mr-[a-z0-9-]{8,80}$")
_HEX = re.compile(r"^[a-f0-9]{64}$")
_GENERATION = re.compile(r"^[a-f0-9]{32}$")
_LIMIT = 256 * 1024


class MRJobStore:
    """Resolve every queue lookup from authenticated workspace scope."""

    def __init__(self, data_root: Path, inputs: Any):
        self.root = data_root.resolve()
        self.inputs = inputs

    def _workspace_parts(self, workspace: Path) -> tuple[str, ...]:
        parts = workspace.absolute().relative_to(self.root).parts
        if (
            len(parts) not in {5, 6}
            or parts[0] != "users"
            or parts[2] != "projects"
            or parts[4] != "workspace"
            or not _SAFE_ID.fullmatch(parts[1])
            or not _SAFE_ID.fullmatch(parts[3])
            or len(parts) == 6
            and not _WORKSPACE.fullmatch(parts[5])
        ):
            raise ValueError("Invalid MR workspace scope.")
        return parts

    def context(self, workspace: Path) -> dict[str, Any]:
        parts = self._workspace_parts(workspace)
        identity = {}
        for label, prefix in (
            ("account", parts[:2]),
            ("project", parts[:4]),
            ("baseWorkspace", parts[:5]),
            ("workspace", parts),
        ):
            with self.inputs.directory_fd(self.root, prefix) as directory:
                identity[label] = self.inputs._identity(
                    os.fstat(directory), directory=True
                )
        active = parts[5] if len(parts) == 6 else ""
        return {
            "userId": parts[1],
            "projectId": parts[3],
            "activeWorkspace": active,
            "workspace": str(workspace.absolute()),
            "identity": identity,
        }

    @staticmethod
    def _scope_id(context: dict[str, Any]) -> str:
        return hashlib.sha256(context["activeWorkspace"].encode("utf-8")).hexdigest()

    @staticmethod
    def _child(parent: int, name: str, create: bool, *, private: bool) -> int:
        if create:
            try:
                os.mkdir(name, mode=0o700, dir_fd=parent)
            except FileExistsError:
                pass
        child = os.open(
            name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent
        )
        info = os.fstat(child)
        if private and (
            info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077
        ):
            os.close(child)
            raise ValueError("MR queue directory permissions are not private.")
        return child

    @contextmanager
    def _scope_directory(self, context: dict[str, Any], create: bool) -> Iterator[int]:
        parts = ("users", context["userId"], "projects", context["projectId"])
        with self.inputs.directory_fd(self.root, parts) as project:
            if (
                self.inputs._identity(os.fstat(project), directory=True)
                != context["identity"]["project"]
            ):
                raise ValueError("MR project generation changed.")
            parent = os.dup(project)
            try:
                for name in (".openscience", "mr-jobs", self._scope_id(context)):
                    child = self._child(
                        parent, name, create, private=name != ".openscience"
                    )
                    os.close(parent)
                    parent = child
                yield parent
            finally:
                os.close(parent)

    @staticmethod
    def _read(directory: int, name: str) -> dict[str, Any]:
        descriptor = os.open(
            name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
        )
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) & 0o077
                or not 0 < info.st_size <= _LIMIT
            ):
                raise ValueError("Invalid protected MR state file.")
            raw = stream.read(_LIMIT + 1)
        if len(raw) > _LIMIT:
            raise ValueError("Protected MR state exceeds its size limit.")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Protected MR state must be an object.")
        return value

    def _write(
        self, directory: int, name: str, value: dict[str, Any], *, create: bool
    ) -> None:
        payload = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
        if len(payload) > _LIMIT:
            raise ValueError("Protected MR state exceeds its size limit.")
        temporary = f".{name}.{secrets.token_hex(8)}.tmp"
        self.inputs._write_new(directory, temporary, payload)
        try:
            if create:
                os.link(
                    temporary,
                    name,
                    src_dir_fd=directory,
                    dst_dir_fd=directory,
                    follow_symlinks=False,
                )
            else:
                os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        finally:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass

    def scope(self, workspace: Path, *, create: bool) -> dict[str, Any]:
        context = self.context(workspace)
        with self._scope_directory(context, create) as directory:
            flags = (os.O_RDWR | os.O_CREAT if create else os.O_RDONLY) | os.O_NOFOLLOW
            descriptor = os.open("scope.lock", flags, 0o600, dir_fd=directory)
            try:
                info = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_nlink != 1
                    or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) & 0o077
                ):
                    raise ValueError("Invalid MR scope lock.")
                fcntl.flock(descriptor, fcntl.LOCK_EX if create else fcntl.LOCK_SH)
                if self.context(workspace) != context:
                    raise ValueError("MR scope changed during lookup.")
                try:
                    record = self._read(directory, "scope.json")
                except FileNotFoundError:
                    record = {}
                if record.get("context") != context:
                    if not create:
                        raise ValueError(
                            "MR workspace generation does not match this queue."
                        )
                    record = {"context": context, "generation": secrets.token_hex(16)}
                    self._write(directory, "scope.json", record, create=False)
                generation = record.get("generation", "")
                if not isinstance(generation, str) or not _GENERATION.fullmatch(
                    generation
                ):
                    raise ValueError("Invalid MR queue generation.")
                child = self._child(directory, generation, create, private=True)
                os.close(child)
                return record
            finally:
                os.close(descriptor)

    def paths(
        self,
        workspace: Path,
        job_id: str,
        *,
        create: bool = False,
        record: dict[str, Any] | None = None,
    ) -> tuple[Path, Path]:
        if not _JOB.fullmatch(job_id):
            raise ValueError("Invalid MR job identifier.")
        record = record if record is not None else self.scope(workspace, create=create)
        context = record["context"]
        directory = (
            self.root
            / "users"
            / context["userId"]
            / "projects"
            / context["projectId"]
            / ".openscience"
            / "mr-jobs"
            / self._scope_id(context)
            / record["generation"]
        )
        return directory / f"{job_id}.json", directory / f"{job_id}.log"

    def reserve_output(self, record: dict[str, Any], job_id: str) -> Path:
        """Reserve the public output directory through the admitted workspace FD."""
        if not _JOB.fullmatch(job_id):
            raise ValueError("Invalid MR job identifier.")
        context = record["context"]
        workspace = Path(context["workspace"])
        if self.context(workspace) != context:
            raise ValueError("MR scope changed before output reservation.")
        with self.inputs.directory_fd(
            self.root, self._workspace_parts(workspace)
        ) as parent:
            if (
                self.inputs._identity(os.fstat(parent), directory=True)
                != context["identity"]["workspace"]
            ):
                raise ValueError("MR workspace generation changed.")
            runs = self._child(
                parent, "mendelian-randomization-runs", True, private=False
            )
            try:
                os.mkdir(job_id, mode=0o700, dir_fd=runs)
                job = self._child(runs, job_id, False, private=False)
                try:
                    os.mkdir("output", mode=0o700, dir_fd=job)
                finally:
                    os.close(job)
            finally:
                os.close(runs)
        return workspace / "mendelian-randomization-runs" / job_id / "output"

    def _state_location(self, path: Path) -> tuple[tuple[str, ...], str]:
        parts = path.absolute().relative_to(self.root).parts
        if (
            len(parts) != 9
            or parts[0] != "users"
            or parts[2] != "projects"
            or parts[4:6] != (".openscience", "mr-jobs")
            or not _SAFE_ID.fullmatch(parts[1])
            or not _SAFE_ID.fullmatch(parts[3])
            or not _HEX.fullmatch(parts[6])
            or not _GENERATION.fullmatch(parts[7])
            or not parts[8].endswith(".json")
            or not _JOB.fullmatch(parts[8][:-5])
        ):
            raise ValueError("MR state must be in protected project metadata.")
        return parts, parts[8][:-5]

    def _validate_record(
        self, parts: tuple[str, ...], job_id: str, state: dict[str, Any]
    ) -> None:
        context = state.get("queueContext", {})
        if not isinstance(context, dict) or not isinstance(
            context.get("activeWorkspace"), str
        ):
            raise ValueError("Invalid protected MR queue context.")
        workspace = self.root.joinpath(
            "users", parts[1], "projects", parts[3], "workspace"
        )
        active = context.get("activeWorkspace", "")
        if active:
            if not isinstance(active, str) or not _WORKSPACE.fullmatch(active):
                raise ValueError("Invalid protected MR workspace name.")
            workspace /= active
        if (
            state.get("schemaVersion") != 2
            or state.get("jobId") != job_id
            or state.get("kind") != "mendelian-randomization"
            or context.get("userId") != parts[1]
            or context.get("projectId") != parts[3]
            or state.get("queueGeneration") != parts[7]
            or self._scope_id(context) != parts[6]
            or context.get("workspace") != str(workspace)
            or state.get("workspace") != str(workspace)
        ):
            raise ValueError("Protected MR job does not match its queue scope.")

    def read(self, path: Path) -> dict[str, Any]:
        try:
            parts, job_id = self._state_location(path)
            with self.inputs.directory_fd(self.root, parts[:-1]) as directory:
                state = self._read(directory, parts[-1])
            self._validate_record(parts, job_id, state)
            return state
        except (OSError, ValueError):
            raise ValueError(
                "Protected MR job state is unavailable or unsafe."
            ) from None

    @contextmanager
    def _job_lock(self, directory: int, job_id: str) -> Iterator[None]:
        descriptor = os.open(job_id + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077):
                raise ValueError("Invalid protected MR job lock.")
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    @contextmanager
    def claim(self, path: Path) -> Iterator[dict[str, Any] | None]:
        """Atomically consume queued authority; a crash cannot rearm execution."""
        parts, job_id = self._state_location(path)
        claimed = None
        try:
            with self.inputs.directory_fd(self.root, parts[:-1]) as directory:
                with self._job_lock(directory, job_id):
                    state = self._read(directory, parts[-1])
                    self._validate_record(parts, job_id, state)
                    if state.get("status") == "queued":
                        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                        state.update(status="running", workerPid=os.getpid(), startedAt=now, updatedAt=now)
                        self._write(directory, parts[-1], state, create=False)
                        claimed = state
        except (OSError, ValueError):
            raise ValueError("Protected MR job state is unavailable or unsafe.") from None
        # The durable status rejects a second worker after the atomic lock ends.
        yield claimed

    def write(self, path: Path, state: dict[str, Any], *, create: bool = False) -> None:
        parts, job_id = self._state_location(path)
        self._validate_record(parts, job_id, state)
        with self.inputs.directory_fd(self.root, parts[:-1]) as directory:
            with self._job_lock(directory, job_id):
                if create:
                    context = state["queueContext"]
                    if self.context(Path(state["workspace"])) != context:
                        raise ValueError("MR scope changed before job admission.")
                    if (
                        state.get("mrInputBindings", {}).get("workspace")
                        != context["identity"]["workspace"]
                    ):
                        raise ValueError(
                            "MR input binding differs from accepted workspace."
                        )
                else:
                    accepted = self._read(directory, parts[-1])
                    if accepted.get("status") in {"succeeded", "failed"}:
                        if state != accepted:
                            raise ValueError("Terminal MR job state is immutable.")
                        return
                    if accepted.get("status") == "running" and state.get("status") == "queued":
                        raise ValueError("Running MR jobs cannot be rearmed.")
                    for key in (
                        "schemaVersion",
                        "kind",
                        "jobId",
                        "workspace",
                        "outputRoot",
                        "createdAt",
                        "request",
                        "mrInputBindings",
                        "sourceEvidence",
                        "queueContext",
                        "queueGeneration",
                    ):
                        if accepted.get(key) != state.get(key):
                            raise ValueError("Accepted MR job authority cannot be changed.")
                self._write(directory, parts[-1], state, create=create)
