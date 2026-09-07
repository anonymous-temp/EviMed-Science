import gzip
import hashlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("recovery_volume", Path(__file__).parents[1] / "recovery-volume.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RecoveryVolumeTests(unittest.TestCase):
    def archive(self, root: Path, uid=None, gid=None) -> Path:
        uid = os.getuid() if uid is None else uid
        gid = os.getgid() if gid is None else gid
        archive = root / "member.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            directory = tarfile.TarInfo(".")
            directory.type = tarfile.DIRTYPE
            directory.mode = 0o750
            directory.uid = uid
            directory.gid = gid
            output.addfile(directory)
            nested = tarfile.TarInfo("nested")
            nested.type = tarfile.DIRTYPE
            nested.mode = 0o710
            nested.uid = uid
            nested.gid = gid
            output.addfile(nested)
            payload = b"synthetic descriptor-held payload\n"
            item = tarfile.TarInfo("nested/payload.txt")
            item.mode = 0o640
            item.uid = uid
            item.gid = gid
            item.size = len(payload)
            output.addfile(item, io.BytesIO(payload))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.name}\n")
        return archive

    def test_relative_archive_restores_payload_mode_and_numeric_owner_atomically(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value).resolve()
            archive = self.archive(root)
            target = root / "restored"
            cwd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                MODULE.restore_numeric(archive.name, target, cwd_fd=cwd, require_privilege=False)
            finally:
                os.close(cwd)
            payload = target / "nested/payload.txt"
            self.assertEqual(payload.read_bytes(), b"synthetic descriptor-held payload\n")
            self.assertEqual(payload.stat().st_mode & 0o7777, 0o640)
            self.assertEqual((payload.stat().st_uid, payload.stat().st_gid), (os.getuid(), os.getgid()))
            self.assertEqual((target / "nested").stat().st_mode & 0o7777, 0o710)

    def test_encrypted_archive_restores_through_the_descriptor_held_work_directory(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value).resolve()
            plain = self.archive(root)
            encrypted = root / "member.tar.gz.enc"
            passphrase = root / "passphrase"
            passphrase.write_text("synthetic encrypted recovery passphrase\n")
            passphrase.chmod(0o600)
            environment = {**os.environ, "OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE": str(passphrase),
                           "OPEN_SCIENCE_BACKUP_PASSPHRASE": ""}
            subprocess.run(["node", str(Path(__file__).parents[1] / "archive-crypto.mjs"),
                            "encrypt", str(plain), str(encrypted)], env=environment, check=True)
            encrypted_digest = hashlib.sha256(encrypted.read_bytes()).hexdigest()
            encrypted.with_name(encrypted.name + ".sha256").write_text(
                f"{encrypted_digest}  {encrypted.name}\n"
            )
            target = root / "encrypted-restored"
            cwd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with patch.dict(os.environ, environment, clear=True):
                    MODULE.restore_numeric(encrypted.name, target, cwd_fd=cwd, require_privilege=False)
            finally:
                os.close(cwd)
            self.assertEqual((target / "nested/payload.txt").read_bytes(),
                             b"synthetic descriptor-held payload\n")

    def test_limits_are_enforced_incrementally_before_member_writes(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value).resolve()
            archive = self.archive(root)
            payload_size = len(b"synthetic descriptor-held payload\n")
            exact = {
                "OPEN_SCIENCE_RECOVERY_MAX_COMPRESSED_BYTES": str(archive.stat().st_size),
                "OPEN_SCIENCE_RECOVERY_MAX_MEMBERS": "3",
                "OPEN_SCIENCE_RECOVERY_MAX_DEPTH": "2",
                "OPEN_SCIENCE_RECOVERY_MAX_PATH_BYTES": str(len("nested/payload.txt".encode())),
                "OPEN_SCIENCE_RECOVERY_MAX_FILE_BYTES": str(payload_size),
                "OPEN_SCIENCE_RECOVERY_MAX_EXPANDED_BYTES": str(payload_size),
            }
            cwd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with patch.dict(os.environ, exact, clear=False), \
                        patch.object(tarfile.TarFile, "getmembers", side_effect=AssertionError("must iterate")):
                    MODULE.restore_numeric(archive.name, root / "boundary", cwd_fd=cwd, require_privilege=False)
            finally:
                os.close(cwd)
            self.assertEqual((root / "boundary/nested/payload.txt").read_bytes(),
                             b"synthetic descriptor-held payload\n")
            over_limit = {
                "compressed": ("OPEN_SCIENCE_RECOVERY_MAX_COMPRESSED_BYTES", archive.stat().st_size - 1),
                "members": ("OPEN_SCIENCE_RECOVERY_MAX_MEMBERS", 2),
                "depth": ("OPEN_SCIENCE_RECOVERY_MAX_DEPTH", 1),
                "path": ("OPEN_SCIENCE_RECOVERY_MAX_PATH_BYTES", len("nested/payload.txt".encode()) - 1),
                "file": ("OPEN_SCIENCE_RECOVERY_MAX_FILE_BYTES", payload_size - 1),
                "expanded": ("OPEN_SCIENCE_RECOVERY_MAX_EXPANDED_BYTES", payload_size - 1),
            }
            for label, (name, limit) in over_limit.items():
                target = root / f"over-{label}"
                cwd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    with self.subTest(label=label), patch.dict(os.environ, {**exact, name: str(limit)}, clear=False), \
                            self.assertRaises(MODULE.RecoveryError) as raised:
                        MODULE.restore_numeric(archive.name, target, cwd_fd=cwd, require_privilege=False)
                    self.assertEqual(raised.exception.code, "recovery_limit_exceeded")
                    self.assertFalse(target.exists())
                finally:
                    os.close(cwd)

    def test_high_ratio_expansion_is_rejected_before_payload_creation(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value).resolve()
            archive = root / "compressed-small-expanded-large.tar.gz"
            payload = b"\0" * (1024 * 1024)
            with tarfile.open(archive, "w:gz") as output:
                directory = tarfile.TarInfo(".")
                directory.type = tarfile.DIRTYPE
                directory.uid = os.getuid()
                directory.gid = os.getgid()
                output.addfile(directory)
                item = tarfile.TarInfo("large.bin")
                item.size = len(payload)
                item.uid = os.getuid()
                item.gid = os.getgid()
                output.addfile(item, io.BytesIO(payload))
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.name}\n")
            limits = {
                "OPEN_SCIENCE_RECOVERY_MAX_COMPRESSED_BYTES": str(archive.stat().st_size),
                "OPEN_SCIENCE_RECOVERY_MAX_MEMBERS": "10",
                "OPEN_SCIENCE_RECOVERY_MAX_DEPTH": "4",
                "OPEN_SCIENCE_RECOVERY_MAX_PATH_BYTES": "128",
                "OPEN_SCIENCE_RECOVERY_MAX_FILE_BYTES": str(len(payload)),
                "OPEN_SCIENCE_RECOVERY_MAX_EXPANDED_BYTES": "1024",
            }
            cwd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with patch.dict(os.environ, limits, clear=False), self.assertRaises(MODULE.RecoveryError) as raised:
                    MODULE.restore_numeric(archive.name, root / "bomb-target", cwd_fd=cwd, require_privilege=False)
            finally:
                os.close(cwd)
            self.assertEqual(raised.exception.code, "recovery_limit_exceeded")
            self.assertFalse((root / "bomb-target").exists())
            self.assertFalse(any(path.name.startswith(".open-science-restore-") for path in root.iterdir()))

    def test_descriptor_held_archive_survives_ancestor_replacement_without_reading_the_link_target(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value).resolve()
            original = root / "original"
            attacker = root / "attacker"
            original.mkdir()
            attacker.mkdir()
            archive = self.archive(original)
            (attacker / archive.name).write_bytes(gzip.compress(b"attacker bytes"))
            cwd = os.open(original, os.O_RDONLY | os.O_DIRECTORY)
            opened = MODULE.open_archive(archive.name, cwd_fd=cwd)
            os.close(cwd)
            saved = root / "saved"
            original.rename(saved)
            original.symlink_to(attacker, target_is_directory=True)
            try:
                copied = io.BytesIO()
                MODULE.copy_verified_archive(opened, copied)
            finally:
                opened.close()
            self.assertEqual(hashlib.sha256(copied.getvalue()).hexdigest(), hashlib.sha256((saved / archive.name).read_bytes()).hexdigest())

    def test_atomic_commit_never_replaces_a_target_populated_after_preflight(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value).resolve()
            parent_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.mkdir("temporary", dir_fd=parent_fd)
                os.mkdir("target", dir_fd=parent_fd)
                target_fd = os.open("target", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
                try:
                    descriptor = os.open("keep.txt", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=target_fd)
                    os.close(descriptor)
                finally:
                    os.close(target_fd)
                with self.assertRaises(MODULE.RecoveryError):
                    MODULE.commit_staging(parent_fd, "temporary", "target")
            finally:
                os.close(parent_fd)
            self.assertTrue((root / "target/keep.txt").exists())
            self.assertTrue((root / "temporary").is_dir())

    def test_atomic_commit_stays_on_the_held_parent_when_its_name_is_replaced(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value).resolve()
            parent = root / "parent"
            attacker = root / "attacker"
            parent.mkdir()
            attacker.mkdir()
            parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.mkdir("temporary", dir_fd=parent_fd)
                temporary_fd = os.open("temporary", os.O_RDONLY | os.O_DIRECTORY, dir_fd=parent_fd)
                try:
                    payload = os.open("payload.txt", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600,
                                      dir_fd=temporary_fd)
                    os.write(payload, b"held target parent\n")
                    os.close(payload)
                finally:
                    os.close(temporary_fd)
                saved = root / "saved-parent"
                parent.rename(saved)
                parent.symlink_to(attacker, target_is_directory=True)
                MODULE.commit_staging(parent_fd, "temporary", "target")
            finally:
                os.close(parent_fd)
            self.assertEqual((saved / "target/payload.txt").read_bytes(), b"held target parent\n")
            self.assertEqual(list(attacker.iterdir()), [])

    def test_rename_success_followed_by_parent_sync_failure_reports_installed_but_not_durable(self):
        for failure in [OSError("synthetic fsync failure"), InterruptedError("synthetic interruption")]:
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as value:
                root = Path(value).resolve()
                parent_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.mkdir("temporary", dir_fd=parent_fd)
                    temporary_fd = os.open("temporary", os.O_RDONLY | os.O_DIRECTORY, dir_fd=parent_fd)
                    payload = os.open("payload.txt", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600,
                                      dir_fd=temporary_fd)
                    os.write(payload, b"installed payload\n")
                    os.close(payload)
                    os.close(temporary_fd)
                    with patch.object(MODULE.os, "fsync", side_effect=failure), \
                            self.assertRaises(MODULE.RecoveryError) as raised:
                        MODULE.commit_staging(parent_fd, "temporary", "target")
                finally:
                    os.close(parent_fd)
                self.assertEqual(raised.exception.code, "numeric_owner_durability_unknown")
                self.assertTrue(raised.exception.installed)
                self.assertEqual((root / "target/payload.txt").read_bytes(), b"installed payload\n")
                self.assertFalse((root / "temporary").exists())

    def test_linux_capability_mask_requires_every_capability_used_by_restore(self):
        required = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3)
        self.assertTrue(MODULE.linux_capabilities_sufficient(required))
        for bit in range(4):
            with self.subTest(missing_bit=bit):
                self.assertFalse(MODULE.linux_capabilities_sufficient(required & ~(1 << bit)))

    @unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() == 0 and shutil.which("setpriv"),
                         "requires a restricted Linux root/user-namespace runner")
    def test_restricted_linux_capability_preflight_rejects_missing_fowner(self):
        completed = subprocess.run(
            ["setpriv", "--bounding-set=-fowner", sys.executable,
             str(Path(__file__).parents[1] / "recovery-volume.py"), "check-privilege"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("numeric_owner_requires_root", completed.stderr)

    @unittest.skipUnless(os.geteuid() == 0, "requires a privileged root/user-namespace runner with CAP_CHOWN")
    def test_privileged_restore_applies_non_host_numeric_ownership(self):
        try:
            MODULE.validate_privilege()
        except MODULE.RecoveryError:
            self.skipTest("root runner does not hold CAP_CHOWN")
        with tempfile.TemporaryDirectory() as value:
            root = Path(value).resolve()
            archive = self.archive(root, uid=1234, gid=1235)
            target = root / "privileged-restored"
            cwd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                MODULE.restore_numeric(archive.name, target, cwd_fd=cwd)
            finally:
                os.close(cwd)
            restored = target / "nested/payload.txt"
            self.assertEqual(restored.read_bytes(), b"synthetic descriptor-held payload\n")
            self.assertEqual((restored.stat().st_uid, restored.stat().st_gid), (1234, 1235))


if __name__ == "__main__":
    unittest.main()
