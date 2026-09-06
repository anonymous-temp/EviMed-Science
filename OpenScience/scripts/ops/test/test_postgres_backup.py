import importlib.util
import json
import os
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("postgres_backup", Path(__file__).parents[1] / "postgres-backup.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PostgresBackupTests(unittest.TestCase):
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
