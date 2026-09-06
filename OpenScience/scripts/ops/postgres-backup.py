#!/usr/bin/env python3
"""Managed implementation of the existing host PostgreSQL backup timer."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_ROOT = Path("/srv/evimed-science/shared")
ARCHIVES = re.compile(r"^evimed-postgres-\d{8}T\d{6}Z(?:-[a-f0-9]{8})?\.dump\.enc$")
RESTORE_NAME = re.compile(r"^evimed_restore_\d{8}T\d{6}Z_[a-f0-9]{12}$")
SOURCE_IDENTITY_SQL = """SELECT json_build_object(
  'database', current_database(),
  'databaseOid', (SELECT oid::text FROM pg_database WHERE datname=current_database()),
  'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()));"""
COUNTS_SQL = """
SELECT format('SELECT json_build_object(''schema'', %L, ''table'', %L, ''rows'', count(*)::text) FROM %I.%I;',
  n.nspname, c.relname, n.nspname, c.relname)
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname,c.relname
\\gexec
"""


class BackupError(Exception):
    """A bounded operational code; command output never becomes a diagnostic."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def pinned_copy(source: Path, target: Path, expected_digest: str) -> None:
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, "rb") as input_stream, target.open("xb") as output_stream:
            before = os.fstat(input_stream.fileno())
            for chunk in iter(lambda: input_stream.read(1024 * 1024), b""):
                output_stream.write(chunk)
            after = os.fstat(input_stream.fileno())
            output_stream.flush()
            os.fsync(output_stream.fileno())
    except Exception:
        target.unlink(missing_ok=True)
        raise
    before_identity = (before.st_dev, before.st_ino, before.st_mode, before.st_uid,
                       before.st_gid, before.st_size, before.st_mtime_ns)
    after_identity = (after.st_dev, after.st_ino, after.st_mode, after.st_uid,
                      after.st_gid, after.st_size, after.st_mtime_ns)
    if before_identity != after_identity or digest(target) != expected_digest:
        target.unlink(missing_ok=True)
        raise BackupError("postgres_archive_changed")


def validate_passphrase(path: Path) -> None:
    no_symlink_path(path)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o400 or not 16 <= metadata.st_size <= 8192:
        raise BackupError("postgres_backup_passphrase_invalid")
    raw = path.read_bytes()
    first = raw.removesuffix(b"\n").removesuffix(b"\r")
    # OpenSSL file: reads one line, terminating at NUL. Check those actual
    # bytes instead of allowing padding after a blank or short first line.
    if not 16 <= len(first) <= 8192 or any(value < 32 or value == 127 for value in first):
        raise BackupError("postgres_backup_passphrase_invalid")


def sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_archive(candidate: Path, checksum_candidate: Path, archive: Path, checksum: Path) -> None:
    published = []
    try:
        for temporary, destination in ((candidate, archive), (checksum_candidate, checksum)):
            with temporary.open("rb") as stream:
                os.fsync(stream.fileno())
            os.link(temporary, destination)
            published.append(destination)
        sync_directory(archive.parent)
    except Exception:
        for destination in reversed(published):
            destination.unlink(missing_ok=True)
        raise
    finally:
        candidate.unlink(missing_ok=True)
        checksum_candidate.unlink(missing_ok=True)


def positive_integer(name: str, default: int, maximum: int) -> int:
    value = os.environ.get(name, str(default))
    if not value.isdigit() or not 1 <= int(value) <= maximum:
        raise BackupError("postgres_backup_config_invalid")
    return int(value)


def no_symlink_path(path: Path) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise BackupError("postgres_backup_path_symlink")


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    no_symlink_path(path)
    os.chmod(path.parent, 0o755)
    descriptor, temporary = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        # Status contains counts and hashes, never secrets or customer rows.
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def table_rows(lines: list[str]) -> list[dict]:
    try:
        rows = [json.loads(line) for line in lines if line.strip()]
        if any(set(row) != {"schema", "table", "rows"} or not isinstance(row["schema"], str)
               or not isinstance(row["table"], str) or not isinstance(row["rows"], str)
               or not row["rows"].isdigit() for row in rows):
            raise ValueError()
        keys = [(row["schema"], row["table"]) for row in rows]
        if len(set(keys)) != len(keys):
            raise ValueError()
        return sorted(rows, key=lambda row: (row["schema"], row["table"]))
    except (ValueError, TypeError, KeyError):
        raise BackupError("postgres_inventory_invalid") from None


def table_digest(rows: list[dict]) -> str:
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate_restore_database(source: str, target: str) -> None:
    if target == source or not RESTORE_NAME.fullmatch(target):
        raise BackupError("postgres_restore_target_forbidden")


def source_identity(value: str, database: str) -> dict:
    try:
        identity = json.loads(value)
        if (set(identity) != {"database", "databaseOid", "systemIdentifier"}
                or identity["database"] != database
                or any(not isinstance(identity[key], str) or not re.fullmatch(r"[0-9]{1,20}", identity[key])
                       for key in ("databaseOid", "systemIdentifier"))):
            raise ValueError()
        return identity
    except (ValueError, TypeError, KeyError):
        raise BackupError("postgres_source_identity_invalid") from None


def clear_drill(base: list[str], role: str, database: str, drill: str, identity: dict) -> None:
    validate_restore_database(database, drill)
    sql = base + ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", role, "-d", database, "-c"]
    current = source_identity(command(sql + [SOURCE_IDENTITY_SQL], capture=True, timeout=60), database)
    if current != identity:
        raise BackupError("postgres_restore_cleanup_identity_mismatch")
    command(base + ["dropdb", "--if-exists", "--force", "-U", role, drill], timeout=60)
    # The target is restricted to letters, digits and underscores above.
    absent = command(sql + [f"SELECT count(*) FROM pg_database WHERE datname='{drill}';"], capture=True, timeout=60)
    if absent.strip() != "0":
        raise BackupError("postgres_restore_cleanup_failed")


def command(args: list[str], *, source=None, target=None, timeout=900, capture=False) -> str:
    try:
        completed = subprocess.run(args, stdin=source if source is not None else subprocess.DEVNULL,
                                   stdout=target if target is not None else (subprocess.PIPE if capture else subprocess.DEVNULL),
                                   stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise BackupError("postgres_command_unavailable") from None
    if completed.returncode:
        raise BackupError("postgres_command_failed")
    return completed.stdout.decode("utf-8") if capture else ""


class PsqlSession:
    """Keep the exporting transaction alive while pg_dump imports its snapshot."""

    def __init__(self, base: list[str], role: str, database: str):
        self.process = subprocess.Popen(base + ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", role, "-d", database],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        self.buffer = b""

    def query(self, sql: str) -> list[str]:
        marker = "evimed_" + uuid.uuid4().hex
        self.process.stdin.write((sql + "\n\\echo " + marker + "\n").encode())
        self.process.stdin.flush()
        rows = []
        deadline = time.monotonic() + 900
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while True:
                if b"\n" not in self.buffer:
                    if not selector.select(max(0, deadline - time.monotonic())):
                        raise BackupError("postgres_snapshot_query_timeout")
                    chunk = os.read(self.process.stdout.fileno(), 65536)
                    if not chunk:
                        raise BackupError("postgres_snapshot_query_failed")
                    self.buffer += chunk
                    if len(self.buffer) > 1024 * 1024:
                        raise BackupError("postgres_inventory_too_large")
                    continue
                line, self.buffer = self.buffer.split(b"\n", 1)
                text = line.decode("utf-8")
                if text == marker:
                    return rows
                rows.append(text)

    def close(self) -> None:
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.process.stdout.close()


def retain(backups: Path, days: int, maximum: int) -> None:
    archives = []
    for candidate in backups.iterdir():
        if not ARCHIVES.fullmatch(candidate.name):
            continue
        if candidate.is_symlink() or not candidate.is_file():
            raise BackupError("postgres_retention_unsafe_entry")
        archives.append(candidate)
    archives.sort(key=lambda item: (item.stat().st_mtime_ns, item.name), reverse=True)
    cutoff = time.time() - days * 86400
    for index, archive in enumerate(archives):
        if index < maximum and archive.stat().st_mtime >= cutoff:
            continue
        checksum = archive.with_name(archive.name + ".sha256")
        if checksum.is_symlink() or (checksum.exists() and not checksum.is_file()):
            raise BackupError("postgres_retention_unsafe_entry")
        archive.unlink()
        checksum.unlink(missing_ok=True)


def parse_cli(arguments: list[str]) -> tuple[str, dict]:
    if not arguments:
        return "timer", {}
    if len(arguments) == 3 and arguments[:2] == ["capture-member", "--output-dir"]:
        output = Path(arguments[2])
        if not output.is_absolute():
            raise BackupError("postgres_recovery_cli_invalid")
        return "capture-member", {"output_dir": output}
    if (len(arguments) == 7 and arguments[0] == "restore-clone"
            and arguments[1] == "--archive" and arguments[3] == "--target-database"
            and arguments[5] == "--receipt"):
        archive = Path(arguments[2])
        receipt = Path(arguments[6])
        if not archive.is_absolute() or not receipt.is_absolute():
            raise BackupError("postgres_recovery_cli_invalid")
        source = os.environ.get("EVIMED_POSTGRES_DATABASE", "evimed")
        validate_restore_database(source, arguments[4])
        return "restore-clone", {"archive": archive, "target_database": arguments[4], "receipt": receipt}
    raise BackupError("postgres_recovery_cli_invalid")


def recovery_root() -> Path:
    value = os.environ.get("EVIMED_RECOVERY_SET_STAGING_ROOT", "")
    root = Path(value)
    if not value or not root.is_absolute():
        raise BackupError("postgres_recovery_path_invalid")
    no_symlink_path(root)
    try:
        resolved = root.resolve(strict=True)
    except OSError:
        raise BackupError("postgres_recovery_path_invalid") from None
    if resolved != root or not root.is_dir():
        raise BackupError("postgres_recovery_path_invalid")
    return root


def recovery_path(path: Path, *, kind: str) -> Path:
    root = recovery_root()
    if not path.is_absolute():
        raise BackupError("postgres_recovery_path_invalid")
    no_symlink_path(path)
    try:
        normalized = path.resolve(strict=kind != "new-file")
        normalized.relative_to(root)
    except (OSError, ValueError):
        raise BackupError("postgres_recovery_path_invalid") from None
    if normalized != path:
        raise BackupError("postgres_recovery_path_invalid")
    if kind == "empty-directory":
        if not path.is_dir() or any(path.iterdir()):
            raise BackupError("postgres_recovery_output_not_empty")
    elif kind == "file":
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode):
            raise BackupError("postgres_recovery_path_invalid")
    elif kind == "new-file":
        if path.exists() or not path.parent.is_dir():
            raise BackupError("postgres_recovery_receipt_exists")
    else:
        raise BackupError("postgres_recovery_path_invalid")
    return path


def recovery_config() -> tuple[list[str], str, str, Path, list[str]]:
    container = os.environ.get("EVIMED_POSTGRES_CONTAINER", "web-evimed-postgres-1")
    database = os.environ.get("EVIMED_POSTGRES_DATABASE", "evimed")
    role = os.environ.get("EVIMED_POSTGRES_USER", "evimed")
    if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,127}", value) for value in (container, database, role)):
        raise BackupError("postgres_backup_config_invalid")
    passphrase = Path(os.environ.get(
        "EVIMED_POSTGRES_PASSPHRASE_FILE", str(DEFAULT_ROOT / "secrets/backup-passphrase.txt")
    )).absolute()
    validate_passphrase(passphrase)
    base = ["docker", "exec", "-i", container]
    for tool in ("pg_dump", "pg_restore"):
        if not re.search(r"\(PostgreSQL\) 16\.", command(base + [tool, "--version"], timeout=30, capture=True)):
            raise BackupError("postgres_backup_client_version")
    crypto = ["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "250000", "-md", "sha256",
              "-pass", "file:" + str(passphrase)]
    return base, database, role, passphrase, crypto


def atomic_new_json(path: Path, value: dict) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    sync_directory(path.parent)


def publish_recovery_files(files: list[tuple[Path, Path]], directory: Path) -> None:
    published = []
    try:
        for source, destination in files:
            with source.open("rb") as stream:
                os.fsync(stream.fileno())
            os.link(source, destination)
            published.append(destination)
        sync_directory(directory)
    except Exception:
        for destination in reversed(published):
            destination.unlink(missing_ok=True)
        raise


def capture_member(output_dir: Path) -> dict:
    output = recovery_path(output_dir, kind="empty-directory")
    base, database, role, _passphrase, crypto = recovery_config()
    archive = output / "postgres.dump.enc"
    checksum = output / "postgres.dump.enc.sha256"
    receipt = output / "postgres.dump.enc.capture.json"
    started = now()
    with tempfile.TemporaryDirectory(prefix=".postgres-capture-", dir=output) as temporary_value:
        temporary = Path(temporary_value)
        plain = temporary / "snapshot.dump"
        decrypted = temporary / "verified.dump"
        candidate = temporary / archive.name
        checksum_candidate = temporary / checksum.name
        receipt_candidate = temporary / receipt.name
        session = PsqlSession(base, role, database)
        try:
            session.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;")
            identity = source_identity(session.query(SOURCE_IDENTITY_SQL)[0], database)
            snapshot = session.query("SELECT pg_export_snapshot();")[0]
            if not re.fullmatch(r"[0-9A-Fa-f]+-[0-9A-Fa-f]+-\d+", snapshot):
                raise BackupError("postgres_snapshot_invalid")
            expected = table_rows(session.query(COUNTS_SQL))
            if not expected:
                raise BackupError("postgres_source_application_empty")
            with plain.open("xb") as dump:
                command(base + ["pg_dump", "--format=custom", "--compress=9", "--no-owner", "--no-acl",
                                "--lock-wait-timeout=30000", "--snapshot=" + snapshot,
                                "-U", role, "-d", database], target=dump)
        finally:
            session.close()
        with plain.open("rb") as source:
            command(base + ["pg_restore", "--list"], source=source)
        command(crypto + ["-salt", "-in", str(plain), "-out", str(candidate)])
        encrypted_digest = digest(candidate)
        command(crypto + ["-d", "-in", str(candidate), "-out", str(decrypted)])
        if not encrypted_digest or digest(plain) != digest(decrypted):
            raise BackupError("postgres_backup_digest_mismatch")
        checksum_candidate.write_text(f"{encrypted_digest}  {archive.name}\n", encoding="utf-8")
        capture_receipt = {
            "schemaVersion": 1,
            "status": "captured",
            "database": database,
            "sourceIdentity": identity,
            "captureStartedAt": started,
            "captureFinishedAt": now(),
            "atomicAcrossComponents": False,
            "snapshotId": snapshot,
            "encryption": "aes-256-cbc-pbkdf2-sha256-250000",
            "archive": archive.name,
            "archiveSha256": encrypted_digest,
            "tables": expected,
            "tablesSha256": table_digest(expected),
            "runnerSha256": digest(Path(__file__)),
        }
        receipt_candidate.write_text(json.dumps(capture_receipt, sort_keys=True, separators=(",", ":")) + "\n",
                                     encoding="utf-8")
        publish_recovery_files([(candidate, archive), (checksum_candidate, checksum),
                                (receipt_candidate, receipt)], output)
    return {"status": "captured", "archive": str(archive), "receipt": str(receipt)}


def load_capture_receipt(archive: Path) -> tuple[dict, list[dict]]:
    receipt_path = recovery_path(archive.with_name(archive.name + ".capture.json"), kind="file")
    checksum_path = recovery_path(archive.with_name(archive.name + ".sha256"), kind="file")
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        expected = table_rows([json.dumps(row) for row in receipt["tables"]])
        archive_digest = digest(archive)
        expected_checksum = f"{archive_digest}  {archive.name}\n"
        if (not expected or receipt.get("schemaVersion") != 1 or receipt.get("status") != "captured"
                or receipt.get("database") != os.environ.get("EVIMED_POSTGRES_DATABASE", "evimed")
                or receipt.get("encryption") != "aes-256-cbc-pbkdf2-sha256-250000"
                or not re.fullmatch(r"[0-9A-Fa-f]+-[0-9A-Fa-f]+-\d+", receipt.get("snapshotId", ""))
                or receipt.get("archive") != archive.name
                or receipt.get("archiveSha256") != archive_digest
                or receipt.get("tablesSha256") != table_digest(expected)
                or checksum_path.read_text(encoding="utf-8") != expected_checksum):
            raise ValueError()
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        raise BackupError("postgres_capture_receipt_invalid") from None
    return receipt, expected


def restore_clone(archive_path: Path, target_database: str, receipt_path: Path) -> dict:
    archive = recovery_path(archive_path, kind="file")
    receipt_output = recovery_path(receipt_path, kind="new-file")
    base, database, role, _passphrase, crypto = recovery_config()
    validate_restore_database(database, target_database)
    capture_receipt, expected = load_capture_receipt(archive)
    identity = source_identity(capture_receipt.get("sourceIdentity")
                               and json.dumps(capture_receipt["sourceIdentity"]), database)
    sql = base + ["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", role, "-d", database, "-c"]
    current = source_identity(command(sql + [SOURCE_IDENTITY_SQL], capture=True, timeout=60), database)
    if current != identity:
        raise BackupError("postgres_restore_source_identity_mismatch")
    # target_database is constrained to the owned restore namespace above.
    exists = command(sql + [f"SELECT count(*) FROM pg_database WHERE datname='{target_database}';"],
                     capture=True, timeout=60)
    if exists.strip() != "0":
        raise BackupError("postgres_restore_target_exists")
    created = False
    try:
        with tempfile.TemporaryDirectory(prefix=".postgres-restore-", dir=receipt_output.parent) as temporary_value:
            temporary = Path(temporary_value)
            encrypted = temporary / "snapshot.dump.enc"
            plain = temporary / "restore.dump"
            pinned_copy(archive, encrypted, capture_receipt["archiveSha256"])
            command(crypto + ["-d", "-in", str(encrypted), "-out", str(plain)])
            with plain.open("rb") as source:
                command(base + ["pg_restore", "--list"], source=source)
            created = True
            command(base + ["createdb", "--template=template0", "-U", role, target_database], timeout=60)
            with plain.open("rb") as source:
                command(base + ["pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl",
                                "-U", role, "-d", target_database], source=source)
            verifier = PsqlSession(base, role, target_database)
            try:
                restored = table_rows(verifier.query(COUNTS_SQL))
            finally:
                verifier.close()
            if restored != expected:
                raise BackupError("restore_application_mismatch")
            result = {
                "schemaVersion": 1,
                "status": "verified",
                "archive": archive.name,
                "archiveSha256": capture_receipt["archiveSha256"],
                "sourceIdentity": identity,
                "targetDatabase": target_database,
                "tables": restored,
                "expectedTablesSha256": table_digest(expected),
                "restoredTablesSha256": table_digest(restored),
                "verifiedAt": now(),
            }
            atomic_new_json(receipt_output, result)
            return result
    except Exception as error:
        if created:
            try:
                clear_drill(base, role, database, target_database, identity)
            except Exception:
                raise BackupError("postgres_restore_cleanup_failed") from None
        if isinstance(error, BackupError):
            raise
        raise BackupError("postgres_restore_operation_failed") from None


def backup(backups: Path, state_file: Path, previous: dict) -> dict:
    container = os.environ.get("EVIMED_POSTGRES_CONTAINER", "web-evimed-postgres-1")
    database = os.environ.get("EVIMED_POSTGRES_DATABASE", "evimed")
    role = os.environ.get("EVIMED_POSTGRES_USER", "evimed")
    if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,127}", value) for value in (container, database, role)):
        raise BackupError("postgres_backup_config_invalid")
    passphrase = Path(os.environ.get("EVIMED_POSTGRES_PASSPHRASE_FILE", str(DEFAULT_ROOT / "secrets/backup-passphrase.txt"))).absolute()
    validate_passphrase(passphrase)
    days = positive_integer("EVIMED_POSTGRES_BACKUP_RETENTION_DAYS", 30, 3650)
    # Keep the existing daily 30-day history; the count cap only bounds an
    # exceptional burst and must not silently shorten that retention policy.
    maximum = positive_integer("EVIMED_POSTGRES_BACKUP_MAX_ARCHIVES", 1000, 1000)
    base = ["docker", "exec", "-i", container]
    for tool in ("pg_dump", "pg_restore"):
        if not re.search(r"\(PostgreSQL\) 16\.", command(base + [tool, "--version"], timeout=30, capture=True)):
            raise BackupError("postgres_backup_client_version")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = backups / f"evimed-postgres-{timestamp}-{uuid.uuid4().hex[:8]}.dump.enc"
    checksum = archive.with_name(archive.name + ".sha256")
    candidate = archive.with_name("." + archive.name + ".tmp")
    checksum_candidate = checksum.with_name("." + checksum.name + ".tmp")
    drill = "evimed_restore_" + timestamp + "_" + uuid.uuid4().hex[:12]
    validate_restore_database(database, drill)
    started = now()
    created = False
    identity = None
    stage = "snapshot"
    result = {}
    operation_error = None
    cleanup_failed = False
    try:
        with tempfile.TemporaryDirectory(prefix="evimed-postgres-backup-") as temporary:
            plain = Path(temporary) / "snapshot.dump"
            decrypted = Path(temporary) / "restore.dump"
            session = PsqlSession(base, role, database)
            try:
                session.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;")
                identity = source_identity(session.query(SOURCE_IDENTITY_SQL)[0], database)
                if previous.get("drillDatabase"):
                    stage = "previous-cleanup"
                    if previous.get("sourceIdentity") != identity:
                        raise BackupError("postgres_restore_cleanup_identity_mismatch")
                    clear_drill(base, role, database, previous["drillDatabase"], identity)
                    previous = {**previous, "drillDatabase": None, "cleanupFailed": False}
                snapshot = session.query("SELECT pg_export_snapshot();")[0]
                if not re.fullmatch(r"[0-9A-Fa-f]+-[0-9A-Fa-f]+-\d+", snapshot):
                    raise BackupError("postgres_snapshot_invalid")
                expected = table_rows(session.query(COUNTS_SQL))
                if not expected:
                    raise BackupError("postgres_source_application_empty")
                stage = "dump"
                with plain.open("xb") as output:
                    command(base + ["pg_dump", "--format=custom", "--compress=9", "--no-owner", "--no-acl",
                                    "--lock-wait-timeout=30000", "--snapshot=" + snapshot, "-U", role, "-d", database], target=output)
            finally:
                session.close()
            snapshot_finished = now()
            with plain.open("rb") as source:
                command(base + ["pg_restore", "--list"], source=source)
            stage = "encrypt"
            crypto = ["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", "250000", "-md", "sha256", "-pass", "file:" + str(passphrase)]
            command(crypto + ["-salt", "-in", str(plain), "-out", str(candidate)])
            encrypted_digest = digest(candidate)
            checksum_candidate.write_text(f"{encrypted_digest}  {archive.name}\n", encoding="utf-8")
            command(crypto + ["-d", "-in", str(candidate), "-out", str(decrypted)])
            if digest(candidate) != encrypted_digest or digest(plain) != digest(decrypted):
                raise BackupError("postgres_backup_digest_mismatch")
            stage = "restore"
            # Persist ownership before issuing CREATE: the command can succeed
            # while its acknowledgement is lost, or this process can be killed.
            atomic_json(state_file, {"schemaVersion": 1, "status": "running", "stage": stage,
                                    "database": database, "sourceIdentity": identity, "drillDatabase": drill,
                                    "lastAttemptAt": started, "lastSuccessAt": previous.get("lastSuccessAt"),
                                    "lastDrillAt": previous.get("lastDrillAt"), "archive": previous.get("archive"),
                                    "restoreVerified": False, "cleanupVerified": False})
            created = True
            command(base + ["createdb", "--template=template0", "-U", role, drill])
            with decrypted.open("rb") as source:
                command(base + ["pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", "-U", role, "-d", drill], source=source)
            verifier = PsqlSession(base, role, drill)
            try:
                restored = table_rows(verifier.query(COUNTS_SQL))
            finally:
                verifier.close()
            if expected != restored:
                raise BackupError("restore_application_mismatch")
            result = {"schemaVersion": 1, "status": "healthy", "database": database,
                      "sourceIdentity": identity,
                      "lastAttemptAt": started, "lastSuccessAt": now(), "lastDrillAt": now(),
                      "snapshotStartedAt": started, "snapshotFinishedAt": snapshot_finished,
                      "atomicAcrossComponents": False, "snapshotId": snapshot,
                      "encryption": "aes-256-cbc-pbkdf2-sha256-250000", "archive": archive.name,
                      "archiveSha256": encrypted_digest, "tables": expected,
                      "expectedTablesSha256": table_digest(expected), "restoredTablesSha256": table_digest(restored),
                      "restoreVerified": True, "runnerSha256": digest(Path(__file__))}
    except Exception as error:
        operation_error = error if isinstance(error, BackupError) else BackupError("postgres_backup_operation_failed")
    finally:
        if created:
            try:
                clear_drill(base, role, database, drill, identity)
            except Exception:
                cleanup_failed = True
        if operation_error or cleanup_failed:
            candidate.unlink(missing_ok=True)
            checksum_candidate.unlink(missing_ok=True)
    if operation_error or cleanup_failed:
        code = "postgres_restore_cleanup_failed" if cleanup_failed else operation_error.code
        atomic_json(state_file, {"schemaVersion": 1, "status": "failed", "lastAttemptAt": started,
                                "lastSuccessAt": previous.get("lastSuccessAt"), "lastDrillAt": previous.get("lastDrillAt"),
                                "archive": previous.get("archive"), "restoreVerified": False, "errorCode": code,
                                "stage": stage, "cleanupFailed": cleanup_failed or bool(previous.get("drillDatabase")),
                                "database": database, "sourceIdentity": identity if created else previous.get("sourceIdentity", identity),
                                "drillDatabase": drill if cleanup_failed else previous.get("drillDatabase")})
        raise BackupError(code)
    published = False
    try:
        publish_archive(candidate, checksum_candidate, archive, checksum)
        published = True
        retain(backups, days, maximum)
        sync_directory(backups)
        result["cleanupVerified"] = True
        result["lastSuccessAt"] = now()
        atomic_json(state_file, result)
    except Exception as error:
        code = error.code if isinstance(error, BackupError) else "postgres_backup_publish_failed"
        # A verified, complete pair remains useful if retention/status fails.
        # An incomplete pair is rolled back by publish_archive.
        atomic_json(state_file, {"schemaVersion": 1, "status": "failed", "stage": "publish",
                                "lastAttemptAt": started, "lastSuccessAt": previous.get("lastSuccessAt"),
                                "lastDrillAt": previous.get("lastDrillAt"), "archive": previous.get("archive"),
                                "verifiedArchive": archive.name if published else None,
                                "restoreVerified": False, "cleanupVerified": True, "errorCode": code,
                                "database": database, "sourceIdentity": identity, "drillDatabase": None})
        raise BackupError(code) from None
    finally:
        candidate.unlink(missing_ok=True)
        checksum_candidate.unlink(missing_ok=True)
    return result


def main(arguments=None) -> int:
    os.umask(0o077)
    if arguments is not None:
        mode, values = parse_cli(arguments)
        if mode == "capture-member":
            print(json.dumps(capture_member(values["output_dir"]), sort_keys=True, separators=(",", ":")))
            return 0
        if mode == "restore-clone":
            result = restore_clone(values["archive"], values["target_database"], values["receipt"])
            print(json.dumps({"status": result["status"], "targetDatabase": result["targetDatabase"],
                              "receipt": str(values["receipt"])}, sort_keys=True, separators=(",", ":")))
            return 0
    backups = Path(os.environ.get("EVIMED_POSTGRES_BACKUP_DIR", str(DEFAULT_ROOT / "backups/postgres"))).absolute()
    no_symlink_path(backups)
    backups.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_file = backups / "status/state.json"
    lock = os.open(backups / ".backup.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError("postgres_backup_already_running") from None
        previous = {}
        if state_file.exists():
            no_symlink_path(state_file)
            previous = json.loads(state_file.read_text(encoding="utf-8"))
        try:
            result = backup(backups, state_file, previous)
        except Exception as error:
            code = error.code if isinstance(error, BackupError) else "postgres_backup_operation_failed"
            current = json.loads(state_file.read_text()) if state_file.exists() else {}
            if current.get("status") != "failed":
                atomic_json(state_file, {"schemaVersion": 1, "status": "failed", "lastAttemptAt": now(),
                                        "lastSuccessAt": previous.get("lastSuccessAt"), "lastDrillAt": previous.get("lastDrillAt"),
                                        "restoreVerified": False, "errorCode": code,
                                        "sourceIdentity": current.get("sourceIdentity"),
                                        "drillDatabase": current.get("drillDatabase"),
                                        "cleanupFailed": bool(current.get("drillDatabase"))})
            raise BackupError(code) from None
        print(json.dumps({"status": result["status"], "archive": result["archive"], "restoreVerified": True}))
        return 0
    finally:
        os.close(lock)


if __name__ == "__main__":
    def interrupted(_signal, _frame):
        raise BackupError("postgres_backup_interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as error:
        code = error.code if isinstance(error, BackupError) else "postgres_backup_operation_failed"
        print(json.dumps({"status": "failed", "errorCode": code}), file=sys.stderr)
        raise SystemExit(1)
