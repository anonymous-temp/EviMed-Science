import importlib.util
import json
import os
import shutil
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("postgres_backup", Path(__file__).parents[1] / "postgres-backup.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PostgresBackupTests(unittest.TestCase):
    def recovery_environment(self, root):
        directory = Path(root).resolve()
        passphrase = directory / "passphrase"
        passphrase.write_text("synthetic-recovery-passphrase\n")
        passphrase.chmod(0o400)
        return {
            "EVIMED_RECOVERY_SET_STAGING_ROOT": str(directory),
            "EVIMED_POSTGRES_PASSPHRASE_FILE": str(passphrase),
            "EVIMED_POSTGRES_CONTAINER": "synthetic-postgres",
            "EVIMED_POSTGRES_DATABASE": "evimed",
            "EVIMED_POSTGRES_USER": "evimed",
        }

    def fake_snapshot_session(self, commands):
        identity = {"database": "evimed", "databaseOid": "16384", "systemIdentifier": "12345"}
        count = json.dumps({"schema": "public", "table": "memo", "rows": "2"})

        class Session:
            def __init__(self, _base, _role, database):
                self.database = database

            def query(self, sql):
                if sql.startswith("BEGIN"):
                    return []
                if sql == MODULE.SOURCE_IDENTITY_SQL:
                    return [json.dumps(identity)]
                if "pg_export_snapshot" in sql:
                    return ["0001-0001-1"]
                if sql == MODULE.COUNTS_SQL:
                    return [count]
                raise AssertionError(sql)

            def close(self):
                pass

        def command(args, *, source=None, target=None, timeout=900, capture=False):
            commands.append(args)
            tool = args[args.index("exec") + 3] if "exec" in args else args[0]
            if args[-1:] == ["--version"]:
                return f"{tool} (PostgreSQL) 16.14"
            if tool == "pg_dump":
                target.write(b"synthetic custom-format dump")
                return ""
            if tool == "pg_restore" and "--list" in args:
                return ""
            if tool == "openssl":
                source_path = Path(args[args.index("-in") + 1])
                target_path = Path(args[args.index("-out") + 1])
                shutil.copyfile(source_path, target_path)
                return ""
            raise AssertionError(args)

        return Session, command, identity

    def test_capture_member_writes_one_verified_snapshot_without_creating_a_drill_database(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root).resolve() / "member"
            output.mkdir()
            commands = []
            session, command, identity = self.fake_snapshot_session(commands)
            with patch.dict(os.environ, self.recovery_environment(root), clear=False), \
                    patch.object(MODULE, "PsqlSession", session), patch.object(MODULE, "command", side_effect=command):
                result = MODULE.capture_member(output)

            archive = output / "postgres.dump.enc"
            capture_receipt = output / "postgres.dump.enc.capture.json"
            self.assertEqual(result["archive"], str(archive))
            self.assertTrue(archive.is_file())
            self.assertTrue(archive.with_name(archive.name + ".sha256").is_file())
            receipt = json.loads(capture_receipt.read_text())
            self.assertEqual(receipt["sourceIdentity"], identity)
            self.assertEqual(receipt["tables"], [{"schema": "public", "table": "memo", "rows": "2"}])
            flattened = [value for call in commands for value in call]
            self.assertNotIn("createdb", flattened)
            self.assertNotIn("dropdb", flattened)
            self.assertFalse(any("restoreVerified" in key for key in receipt))

    def test_restore_clone_creates_only_the_validated_absent_target_and_keeps_it_for_semantic_probes(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root).resolve()
            output = directory / "member"
            output.mkdir()
            archive = output / "postgres.dump.enc"
            archive.write_bytes(b"synthetic encrypted archive")
            archive.with_name(archive.name + ".sha256").write_text(f"{MODULE.digest(archive)}  {archive.name}\n")
            expected = [{"schema": "public", "table": "memo", "rows": "2"}]
            identity = {"database": "evimed", "databaseOid": "16384", "systemIdentifier": "12345"}
            archive.with_name(archive.name + ".capture.json").write_text(json.dumps({
                "schemaVersion": 1,
                "archive": archive.name,
                "archiveSha256": MODULE.digest(archive),
                "database": "evimed",
                "sourceIdentity": identity,
                "tables": expected,
                "tablesSha256": MODULE.table_digest(expected),
            }))
            restore_receipt = directory / "restore.json"
            target = "evimed_restore_20260907T120000Z_0123456789ab"
            commands = []

            class Session:
                def __init__(self, _base, _role, database):
                    self.database = database

                def query(self, sql):
                    self.assert_target()
                    return [json.dumps(expected[0])]

                def assert_target(self):
                    if self.database != target:
                        raise AssertionError(self.database)

                def close(self):
                    pass

            def command(args, *, source=None, target=None, timeout=900, capture=False):
                commands.append(args)
                tool = args[args.index("exec") + 3] if "exec" in args else args[0]
                if args[-1:] == ["--version"]:
                    return f"{tool} (PostgreSQL) 16.14"
                if tool == "psql":
                    sql = args[-1]
                    if "count(*) FROM pg_database" in sql:
                        return "0\n"
                    if sql == MODULE.SOURCE_IDENTITY_SQL:
                        return json.dumps(identity)
                if tool == "openssl":
                    Path(args[args.index("-out") + 1]).write_bytes(b"synthetic plain dump")
                    return ""
                if tool in {"createdb", "pg_restore"}:
                    return ""
                raise AssertionError(args)

            with patch.dict(os.environ, self.recovery_environment(root), clear=False), \
                    patch.object(MODULE, "PsqlSession", Session), patch.object(MODULE, "command", side_effect=command):
                result = MODULE.restore_clone(archive, target, restore_receipt)

            self.assertEqual(result["status"], "verified")
            self.assertEqual(json.loads(restore_receipt.read_text())["targetDatabase"], target)
            tools = [call[call.index("exec") + 3] for call in commands if "exec" in call]
            self.assertIn("createdb", tools)
            self.assertIn("pg_restore", tools)
            self.assertNotIn("dropdb", tools)

    def test_recovery_member_paths_and_cli_are_closed_before_any_database_mutation(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root).resolve()
            output = directory / "member"
            output.mkdir()
            (output / "already-here").write_text("do not replace")
            calls = []
            with patch.dict(os.environ, self.recovery_environment(root), clear=False), \
                    patch.object(MODULE, "command", side_effect=lambda *args, **kwargs: calls.append(args)):
                with self.assertRaises(MODULE.BackupError):
                    MODULE.capture_member(output)
            self.assertEqual(calls, [])
            for arguments in [
                ["capture-member", "--output-dir", "relative"],
                ["capture-member", "--output-dir", str(directory), "--container", "other"],
                ["restore-clone", "--archive", str(directory / "missing"), "--target-database", "evimed", "--receipt", str(directory / "new.json")],
            ]:
                with self.subTest(arguments=arguments), self.assertRaises(MODULE.BackupError):
                    MODULE.parse_cli(arguments)

    def test_main_fallback_preserves_the_current_persisted_drill_intent(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root).resolve()
            drill = "evimed_restore_20260906T023000Z_0123456789ab"
            identity = {"database": "evimed", "databaseOid": "16384", "systemIdentifier": "12345"}
            def interrupted_backup(_backups, state_file, _previous):
                MODULE.atomic_json(state_file, {"schemaVersion": 1, "status": "running",
                                               "drillDatabase": drill, "sourceIdentity": identity})
                raise MODULE.BackupError("synthetic_failed_status_write")
            with patch.dict(os.environ, {"EVIMED_POSTGRES_BACKUP_DIR": str(directory)}), \
                    patch.object(MODULE, "backup", side_effect=interrupted_backup), \
                    self.assertRaises(MODULE.BackupError):
                MODULE.main()
            receipt = json.loads((directory / "status/state.json").read_text())
            self.assertEqual(receipt["status"], "failed")
            self.assertEqual(receipt["drillDatabase"], drill)
            self.assertEqual(receipt["sourceIdentity"], identity)
            self.assertTrue(receipt["cleanupFailed"])

    def test_passphrase_checks_the_single_line_openssl_reads(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root).resolve() / "passphrase"
            for value in [b"\n" + b"x" * 32, b"short\n" + b"x" * 32, b"x" * 16 + b"\0hidden", b"x" * 24 + b"\nsecond"]:
                if target.exists():
                    target.chmod(0o600)
                target.write_bytes(value)
                target.chmod(0o400)
                with self.subTest(value_length=len(value)), self.assertRaises(MODULE.BackupError):
                    MODULE.validate_passphrase(target)
            target.chmod(0o600)
            target.write_bytes(b"synthetic-valid-passphrase\n")
            target.chmod(0o400)
            MODULE.validate_passphrase(target)

    def test_partial_publication_removes_only_this_attempt_files(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            candidate, checksum_candidate = directory / ".candidate", directory / ".checksum"
            archive, checksum = directory / "new.dump.enc", directory / "new.dump.enc.sha256"
            prior = directory / "previous.dump.enc"
            prior.write_bytes(b"preserve verified previous backup")
            candidate.write_bytes(b"synthetic ciphertext")
            checksum_candidate.write_text("synthetic checksum")
            real_link = os.link
            def link(source, destination):
                if destination == checksum:
                    raise OSError("synthetic second-link failure")
                return real_link(source, destination)
            with patch.object(MODULE.os, "link", side_effect=link), self.assertRaises(OSError):
                MODULE.publish_archive(candidate, checksum_candidate, archive, checksum)
            self.assertEqual(sorted(p.name for p in directory.iterdir()), [prior.name])

    def test_restore_target_never_accepts_source_or_unowned_database(self):
        for target in ["evimed", "postgres", "evimed_restore_other", "another_customer"]:
            with self.subTest(target=target), self.assertRaises(MODULE.BackupError):
                MODULE.validate_restore_database("evimed", target)
        valid = "evimed_restore_20260906T023000Z_0123456789ab"
        MODULE.validate_restore_database("evimed", valid)
        with self.assertRaises(MODULE.BackupError):
            MODULE.validate_restore_database(valid, valid)

    def test_atomic_status_is_readable_by_the_read_only_web_mount(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root).resolve() / "status/state.json"
            previous = os.umask(0o077)
            try:
                MODULE.atomic_json(target, {"schemaVersion": 1, "status": "failed"})
            finally:
                os.umask(previous)
            self.assertEqual(target.parent.stat().st_mode & 0o777, 0o755)
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            self.assertEqual(json.loads(target.read_text())["status"], "failed")
            self.assertEqual([p.name for p in target.parent.iterdir()], ["state.json"])

    def test_inventory_rejects_duplicate_or_non_numeric_counts(self):
        row = json.dumps({"schema": "public", "table": "memo", "rows": "0"})
        self.assertEqual(MODULE.table_rows([row])[0]["rows"], "0")
        for rows in [[row, row], ['{"schema":"public","table":"memo","rows":-1}'], ["not JSON"]]:
            with self.subTest(rows=rows), self.assertRaises(MODULE.BackupError):
                MODULE.table_rows(rows)

    def test_retention_removes_old_pairs_and_keeps_unrelated_files(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            old = directory / "evimed-postgres-20200101T000000Z.dump.enc"
            current = directory / "evimed-postgres-20260906T023000Z-01234567.dump.enc"
            for archive in [old, current]:
                archive.write_bytes(b"synthetic ciphertext")
                archive.with_name(archive.name + ".sha256").write_text("synthetic receipt")
            os.utime(old, (time.time() - 86400 * 60,) * 2)
            other = directory / "customer.txt"
            other.write_text("preserve")
            MODULE.retain(directory, 30, 14)
            self.assertFalse(old.exists())
            self.assertFalse(old.with_name(old.name + ".sha256").exists())
            self.assertTrue(current.exists())
            self.assertTrue(other.exists())

    def test_retention_does_not_follow_a_linked_archive_or_sidecar(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            source = directory / "preserve.txt"
            source.write_text("preserve")
            archive = directory / "evimed-postgres-20200101T000000Z.dump.enc"
            archive.symlink_to(source)
            with self.assertRaises(MODULE.BackupError):
                MODULE.retain(directory, 1, 1)
            self.assertEqual(source.read_text(), "preserve")


if __name__ == "__main__":
    unittest.main()
