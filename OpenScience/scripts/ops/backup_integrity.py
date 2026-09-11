#!/usr/bin/env python3
"""Verify restored bytes against the archive's bounded versioned inventory."""

import hashlib
import json
import os
import posixpath
import re
import stat
import sys
import tarfile
import uuid


# Shared with backup-archive.mjs; round-trip tests bind writer and reader.
MANIFEST_NAME = ".open-science-backup-manifest.json"
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_ENTRIES = 1_000_000
IDENTITY_FIELDS = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_size", "st_mtime_ns", "st_ctime_ns", "st_nlink")


class IntegrityError(Exception):
    """A malformed inventory or a restored tree that differs from it."""


def identity(metadata):
    return tuple(getattr(metadata, field) for field in IDENTITY_FIELDS)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise IntegrityError("backup_inventory_invalid")
        result[key] = value
    return result


def check_archive(filename):
    """Check actual tar members, including aliases and duplicates, before tar writes."""
    seen = set()
    with tarfile.open(filename, mode="r|gz") as archive:
        for member in archive:
            name = member.name
            if name.startswith("/") or "\x00" in name:
                raise IntegrityError("Unsafe archive path: backup_inventory_archive_invalid")
            while name.startswith("./"):
                name = name[2:]
            name = name.rstrip("/") or "."
            if posixpath.normpath(name) != name or name == ".." or name.startswith("../"):
                raise IntegrityError("Unsafe archive path: backup_inventory_archive_invalid")
            if member.issym():
                raise IntegrityError("Refusing to restore archive containing symbolic links.")
            if not (member.isfile() or member.isdir()) or (name == "." and not member.isdir()):
                raise IntegrityError("backup_inventory_unsupported_entry")
            if name in seen:
                raise IntegrityError("backup_inventory_duplicate_archive_entry")
            seen.add(name)
            if len(seen) > MAX_MANIFEST_ENTRIES + 1:
                raise IntegrityError("backup_inventory_limit_exceeded")
            if name.split("/")[0] == MANIFEST_NAME and (
                    name != MANIFEST_NAME or not member.isfile() or member.size > MAX_MANIFEST_BYTES):
                raise IntegrityError("backup_inventory_invalid")


def read_manifest(root_fd):
    try:
        descriptor = os.open(MANIFEST_NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
    except FileNotFoundError:
        return None
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_MANIFEST_BYTES:
            raise IntegrityError("backup_inventory_invalid")
        with os.fdopen(os.dup(descriptor), "rb") as source:
            raw = source.read(MAX_MANIFEST_BYTES + 1)
        if len(raw) != before.st_size or identity(before) != identity(os.fstat(descriptor)):
            raise IntegrityError("backup_inventory_changed")
    finally:
        os.close(descriptor)
    try:
        manifest = json.loads(raw, object_pairs_hook=unique_object)
    except (ValueError, UnicodeError, RecursionError):
        raise IntegrityError("backup_inventory_invalid") from None
    if (not isinstance(manifest, dict) or manifest.get("format") != "open-science-backup-inventory"
            or type(manifest.get("version")) is not int or manifest["version"] != 1):
        raise IntegrityError("backup_inventory_version_unsupported")
    entries = manifest.get("entries")
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_MANIFEST_ENTRIES:
        raise IntegrityError("backup_inventory_invalid")
    expected = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise IntegrityError("backup_inventory_invalid")
        name = entry.get("path")
        kind = entry.get("type")
        size = entry.get("size")
        if (not isinstance(name, str) or not name or "\x00" in name or name.startswith("/")
                or posixpath.normpath(name) != name or name == ".." or name.startswith("../")
                or name.split("/")[0] == MANIFEST_NAME or name in expected
                or kind not in ("file", "directory") or type(size) is not int or not 0 <= size <= 2**53 - 1):
            raise IntegrityError("backup_inventory_invalid")
        if kind == "directory":
            if size != 0 or set(entry) != {"path", "type", "size"}:
                raise IntegrityError("backup_inventory_invalid")
        elif (set(entry) != {"path", "type", "size", "sha256"}
              or not isinstance(entry.get("sha256"), str) or not re.fullmatch("[a-f0-9]{64}", entry["sha256"])):
            raise IntegrityError("backup_inventory_invalid")
        expected[name] = entry
    if expected.get(".") != {"path": ".", "type": "directory", "size": 0}:
        raise IntegrityError("backup_inventory_invalid")
    for name in expected:
        if name != "." and expected.get(posixpath.dirname(name) or ".", {}).get("type") != "directory":
            raise IntegrityError("backup_inventory_invalid")
    return expected


def verify_tree(root_fd, *, remove_manifest=True):
    """Walk pinned directories without following links, then compare exact bytes."""
    expected = read_manifest(root_fd)
    seen = set()
    files = 0
    directories = 0

    def record(entry):
        nonlocal files, directories
        name = entry["path"]
        if len(seen) >= MAX_MANIFEST_ENTRIES:
            raise IntegrityError("backup_inventory_limit_exceeded")
        seen.add(name)
        if expected is not None:
            if name not in expected:
                raise IntegrityError("backup_inventory_extra_entry")
            if expected[name] != entry:
                raise IntegrityError("backup_inventory_entry_mismatch")
        if entry["type"] == "file":
            files += 1
        else:
            directories += 1

    def walk(directory_fd, relative):
        before = os.fstat(directory_fd)
        record({"path": relative or ".", "type": "directory", "size": 0})
        for name in sorted(os.listdir(directory_fd)):
            if not relative and name == MANIFEST_NAME:
                continue
            child = f"{relative}/{name}" if relative else name
            metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
                raise IntegrityError("backup_inventory_unsupported_entry")
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if stat.S_ISDIR(metadata.st_mode):
                flags |= os.O_DIRECTORY
            descriptor = os.open(name, flags, dir_fd=directory_fd)
            try:
                opened = os.fstat(descriptor)
                if identity(opened) != identity(metadata):
                    raise IntegrityError("backup_inventory_source_changed")
                if stat.S_ISDIR(opened.st_mode):
                    walk(descriptor, child)
                else:
                    if opened.st_nlink != 1:
                        raise IntegrityError("backup_inventory_unsupported_entry")
                    entry = {"path": child, "type": "file", "size": opened.st_size}
                    if expected is not None:
                        digest = hashlib.sha256()
                        remaining = opened.st_size
                        while remaining:
                            chunk = os.read(descriptor, min(1024 * 1024, remaining))
                            if not chunk:
                                raise IntegrityError("backup_inventory_source_changed")
                            digest.update(chunk)
                            remaining -= len(chunk)
                        entry["sha256"] = digest.hexdigest()
                    record(entry)
                if identity(opened) != identity(os.fstat(descriptor)):
                    raise IntegrityError("backup_inventory_source_changed")
            finally:
                os.close(descriptor)
            if identity(metadata) != identity(os.stat(name, dir_fd=directory_fd, follow_symlinks=False)):
                raise IntegrityError("backup_inventory_source_changed")
        if identity(before) != identity(os.fstat(directory_fd)):
            raise IntegrityError("backup_inventory_source_changed")

    walk(root_fd, "")
    if expected is not None:
        if seen != set(expected):
            raise IntegrityError("backup_inventory_missing_entry")
        if remove_manifest:
            mode = stat.S_IMODE(os.fstat(root_fd).st_mode)
            if not mode & stat.S_IWUSR:
                os.fchmod(root_fd, mode | stat.S_IWUSR)
            try:
                os.unlink(MANIFEST_NAME, dir_fd=root_fd)
            finally:
                if not mode & stat.S_IWUSR:
                    os.fchmod(root_fd, mode)
    return {"verification": "inventory-v1" if expected is not None else "legacy-shape-only",
            "files": files, "directories": directories}


def write_receipt(receipt, *, root_fd=None):
    """An optional caller-owned report stays outside the customer payload."""
    target = os.environ.get("OPEN_SCIENCE_RESTORE_VERIFICATION_FILE")
    if not target:
        return
    parts = os.path.abspath(target).split(os.sep)[1:]
    directory = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
    temporary = f".backup-verification-{uuid.uuid4().hex}"
    created = False
    payload_identity = identity(os.fstat(root_fd))[:2] if root_fd is not None else None
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
            if payload_identity == identity(os.fstat(directory))[:2]:
                raise IntegrityError("backup_inventory_receipt_inside_payload")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
        created = True
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(receipt, output)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        # link installs atomically without replacing an existing file or link.
        os.link(temporary, parts[-1], src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
        os.unlink(temporary, dir_fd=directory)
        created = False
        os.fsync(directory)
    finally:
        if created:
            os.unlink(temporary, dir_fd=directory)
        os.close(directory)


def main(arguments):
    if len(arguments) == 2 and arguments[0] == "check-archive":
        check_archive(arguments[1])
        return
    if len(arguments) != 1:
        raise IntegrityError("backup_inventory_cli_invalid")
    root = os.open(arguments[0], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        receipt = verify_tree(root)
        write_receipt(receipt, root_fd=root)
    finally:
        os.close(root)
    print(f"restore verification: {receipt['verification']} ({receipt['files']} files)", file=sys.stderr)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as error:
        print(str(error) if isinstance(error, IntegrityError) else "backup_inventory_verification_failed", file=sys.stderr)
        raise SystemExit(1)
