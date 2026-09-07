#!/usr/bin/env python3
"""Descriptor-held numeric-owner restore for recovery-set archives."""

from __future__ import annotations

import errno
import hashlib
import os
import posixpath
import re
import stat
import subprocess
import sys
import tarfile
import uuid
from pathlib import Path


class RecoveryError(Exception):
    pass


IDENTITY_FIELDS = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_size", "st_mtime_ns", "st_ctime_ns")


def identity(metadata):
    return tuple(getattr(metadata, field) for field in IDENTITY_FIELDS)


def safe_parts(value: str, *, absolute: bool) -> list[str]:
    if not value or os.path.isabs(value) != absolute or os.path.normpath(value) != value:
        raise RecoveryError("recovery_path_invalid")
    parts = value.split(os.sep)
    if absolute:
        parts = parts[1:]
    if not parts or any(not part or part in {".", ".."} for part in parts):
        raise RecoveryError("recovery_path_invalid")
    return parts


def open_directory_at(base_fd: int, parts: list[str]) -> int:
    current = os.dup(base_fd)
    try:
        for part in parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        return current
    except Exception:
        os.close(current)
        raise


class OpenedArchive:
    def __init__(self, parent_fd: int, archive_fd: int, checksum_fd: int, name: str):
        self.parent_fd = parent_fd
        self.archive_fd = archive_fd
        self.checksum_fd = checksum_fd
        self.name = name

    def close(self):
        for descriptor in (self.archive_fd, self.checksum_fd, self.parent_fd):
            os.close(descriptor)


def open_archive(argument: str, *, cwd_fd=None) -> OpenedArchive:
    absolute = os.path.isabs(argument)
    parts = safe_parts(argument, absolute=absolute)
    owned_base = None
    if absolute:
        owned_base = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
        base = owned_base
    elif cwd_fd is not None:
        base = cwd_fd
    else:
        owned_base = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
        base = owned_base
    try:
        parent = open_directory_at(base, parts[:-1])
    finally:
        if owned_base is not None:
            os.close(owned_base)
    name = parts[-1]
    archive_fd = None
    checksum_fd = None
    try:
        archive_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        checksum_fd = os.open(name + ".sha256", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        if not stat.S_ISREG(os.fstat(archive_fd).st_mode) or not stat.S_ISREG(os.fstat(checksum_fd).st_mode):
            raise RecoveryError("recovery_archive_identity_invalid")
        return OpenedArchive(parent, archive_fd, checksum_fd, name)
    except Exception:
        for descriptor in (archive_fd, checksum_fd):
            if descriptor is not None:
                os.close(descriptor)
        os.close(parent)
        raise


def copy_verified_archive(opened: OpenedArchive, output) -> str:
    checksum_before = os.fstat(opened.checksum_fd)
    os.lseek(opened.checksum_fd, 0, os.SEEK_SET)
    checksum_bytes = os.read(opened.checksum_fd, 4096)
    if os.read(opened.checksum_fd, 1):
        raise RecoveryError("recovery_archive_identity_invalid")
    checksum_after = os.fstat(opened.checksum_fd)
    try:
        checksum_text = checksum_bytes.decode("ascii")
    except UnicodeDecodeError:
        raise RecoveryError("recovery_archive_identity_invalid") from None
    match = re.fullmatch(r"([0-9a-f]{64})  ([^/\n]+)\n", checksum_text)
    if identity(checksum_before) != identity(checksum_after) or not match or match.group(2) != opened.name:
        raise RecoveryError("recovery_archive_identity_invalid")

    before = os.fstat(opened.archive_fd)
    os.lseek(opened.archive_fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while True:
        chunk = os.read(opened.archive_fd, 1024 * 1024)
        if not chunk:
            break
        output.write(chunk)
        digest.update(chunk)
    after = os.fstat(opened.archive_fd)
    if identity(before) != identity(after) or digest.hexdigest() != match.group(1):
        raise RecoveryError("recovery_archive_identity_invalid")
    return digest.hexdigest()


def validate_privilege() -> None:
    if os.geteuid() != 0:
        raise RecoveryError("numeric_owner_requires_root")
    status_path = Path("/proc/self/status")
    if status_path.exists():
        effective = next((line.split()[1] for line in status_path.read_text().splitlines()
                          if line.startswith("CapEff:")), "0")
        if int(effective, 16) & 1 == 0:
            raise RecoveryError("numeric_owner_requires_root")


def archive_member_parts(name: str) -> list[str]:
    normalized = name.rstrip("/") or "."
    if (not normalized or "\x00" in normalized or normalized.startswith("/")
            or posixpath.normpath(normalized) != normalized or normalized == ".."
            or normalized.startswith("../")):
        raise RecoveryError("numeric_owner_archive_invalid")
    return [] if normalized == "." else normalized.split("/")


def ensure_directory(root_fd: int, parts: list[str]) -> int:
    current = os.dup(root_fd)
    try:
        for part in parts:
            try:
                os.mkdir(part, 0o700, dir_fd=current)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        return current
    except Exception:
        os.close(current)
        raise


def extract_archive(archive_fd: int, staging_fd: int) -> None:
    seen = set()
    directory_metadata = []
    root_metadata = None
    with os.fdopen(os.dup(archive_fd), "rb") as raw, tarfile.open(fileobj=raw, mode="r:gz") as archive:
        members = archive.getmembers()
        if not members:
            raise RecoveryError("numeric_owner_archive_invalid")
        for member in members:
            parts = archive_member_parts(member.name)
            normalized = "/".join(parts) if parts else "."
            if (normalized in seen or not (member.isfile() or member.isdir())
                    or not 0 <= member.uid <= 0xffffffff or not 0 <= member.gid <= 0xffffffff
                    or member.mode < 0 or member.mode > 0o7777
                    or any(key not in {"path", "size", "mtime", "uid", "gid"} for key in member.pax_headers)):
                raise RecoveryError("numeric_owner_archive_invalid")
            seen.add(normalized)
            metadata = (parts, member.uid, member.gid, member.mode)
            if member.isdir():
                descriptor = ensure_directory(staging_fd, parts)
                os.close(descriptor)
                if parts:
                    directory_metadata.append(metadata)
                else:
                    root_metadata = metadata
                continue
            if not parts:
                raise RecoveryError("numeric_owner_archive_invalid")
            parent = ensure_directory(staging_fd, parts[:-1])
            try:
                descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o600, dir_fd=parent)
            finally:
                os.close(parent)
            try:
                source = archive.extractfile(member)
                if source is None:
                    raise RecoveryError("numeric_owner_archive_invalid")
                written = 0
                with source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        view = memoryview(chunk)
                        while view:
                            count = os.write(descriptor, view)
                            written += count
                            view = view[count:]
                if written != member.size:
                    raise RecoveryError("numeric_owner_archive_invalid")
                os.fsync(descriptor)
                os.fchown(descriptor, member.uid, member.gid)
                os.fchmod(descriptor, member.mode)
            finally:
                os.close(descriptor)
    if root_metadata is None:
        raise RecoveryError("numeric_owner_archive_invalid")
    for parts, uid, gid, mode in sorted(directory_metadata, key=lambda value: len(value[0]), reverse=True):
        descriptor = ensure_directory(staging_fd, parts)
        try:
            os.fchown(descriptor, uid, gid)
            os.fchmod(descriptor, mode)
        finally:
            os.close(descriptor)
    _, uid, gid, mode = root_metadata
    os.fchown(staging_fd, uid, gid)
    os.fchmod(staging_fd, mode)


def validate_blank_target(parent_fd: int, target_name: str) -> None:
    try:
        metadata = os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        metadata = None
    if metadata is not None:
        if not stat.S_ISDIR(metadata.st_mode):
            raise RecoveryError("numeric_owner_target_not_blank")
        target_fd = os.open(target_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            if os.listdir(target_fd):
                raise RecoveryError("numeric_owner_target_not_blank")
        finally:
            os.close(target_fd)


def commit_staging(parent_fd: int, staging_name: str, target_name: str) -> None:
    validate_blank_target(parent_fd, target_name)
    try:
        os.rename(staging_name, target_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    except OSError:
        raise RecoveryError("numeric_owner_target_changed") from None
    os.fsync(parent_fd)


def remove_tree(parent_fd: int, name: str) -> None:
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    except FileNotFoundError:
        return
    try:
        for child in os.listdir(descriptor):
            metadata = os.stat(child, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISDIR(metadata.st_mode):
                remove_tree(descriptor, child)
            else:
                os.unlink(child, dir_fd=descriptor)
    finally:
        os.close(descriptor)
    os.rmdir(name, dir_fd=parent_fd)


def decrypt_if_needed(temp_fd: int, input_name: str) -> str:
    descriptor = os.open(input_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=temp_fd)
    try:
        magic = os.read(descriptor, 64).split(b"\n", 1)[0]
    finally:
        os.close(descriptor)
    if magic != b"OPEN_SCIENCE_BACKUP_ENCRYPTED_V1":
        return input_name
    script = str(Path(__file__).with_name("archive-crypto.mjs").resolve())
    try:
        completed = subprocess.run(
            ["node", script, "decrypt", input_name, "archive.tar.gz"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=900,
            check=False,
            preexec_fn=lambda: os.fchdir(temp_fd),
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RecoveryError("numeric_owner_decrypt_failed") from None
    if completed.returncode:
        raise RecoveryError("numeric_owner_decrypt_failed")
    return "archive.tar.gz"


def restore_numeric(archive_argument: str, target: Path, *, cwd_fd=None,
                    require_privilege: bool = True) -> None:
    if require_privilege:
        validate_privilege()
    target_value = str(target)
    target_parts = safe_parts(target_value, absolute=True)
    opened = None
    parent_fd = None
    staging_fd = -1
    staging_name = None
    committed = False
    try:
        opened = open_archive(archive_argument, cwd_fd=cwd_fd)
        root_fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
        try:
            parent_fd = open_directory_at(root_fd, target_parts[:-1])
        finally:
            os.close(root_fd)
        target_name = target_parts[-1]
        validate_blank_target(parent_fd, target_name)
        staging_name = f".open-science-restore-{os.getpid()}-{uuid.uuid4().hex}"
        os.mkdir(staging_name, 0o700, dir_fd=parent_fd)
        staging_fd = os.open(staging_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        immutable_fd = os.open("immutable.backup", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                               0o600, dir_fd=staging_fd)
        try:
            with os.fdopen(immutable_fd, "wb", closefd=False) as output:
                copy_verified_archive(opened, output)
                output.flush()
                os.fsync(output.fileno())
        finally:
            os.close(immutable_fd)
        archive_name = decrypt_if_needed(staging_fd, "immutable.backup")
        archive_fd = os.open(archive_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=staging_fd)
        try:
            extract_root_name = "payload"
            os.mkdir(extract_root_name, 0o700, dir_fd=staging_fd)
            extract_root_fd = os.open(extract_root_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                      dir_fd=staging_fd)
            try:
                extract_archive(archive_fd, extract_root_fd)
            finally:
                os.close(extract_root_fd)
        finally:
            os.close(archive_fd)
        os.unlink("immutable.backup", dir_fd=staging_fd)
        if archive_name != "immutable.backup":
            os.unlink(archive_name, dir_fd=staging_fd)
        os.close(staging_fd)
        staging_fd = -1
        # Move the extracted root out of the private work directory, remove the
        # now-empty work directory, then atomically install the extracted root.
        final_staging = f"{staging_name}-payload"
        os.rename(f"{staging_name}/payload", final_staging, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.rmdir(staging_name, dir_fd=parent_fd)
        commit_staging(parent_fd, final_staging, target_name)
        committed = True
    finally:
        if opened is not None:
            opened.close()
        if staging_fd >= 0:
            os.close(staging_fd)
        if not committed and parent_fd is not None and staging_name is not None:
            remove_tree(parent_fd, staging_name)
            remove_tree(parent_fd, f"{staging_name}-payload")
        if parent_fd is not None:
            os.close(parent_fd)


def main(arguments: list[str]) -> int:
    if len(arguments) != 5 or arguments[0] != "restore" or arguments[1] != "--archive" or arguments[3] != "--target":
        raise RecoveryError("recovery_cli_invalid")
    restore_numeric(arguments[2], Path(arguments[4]))
    print(str(Path(arguments[4])))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as error:
        code = str(error) if isinstance(error, RecoveryError) else "numeric_owner_restore_failed"
        print(code, file=sys.stderr)
        raise SystemExit(1)
