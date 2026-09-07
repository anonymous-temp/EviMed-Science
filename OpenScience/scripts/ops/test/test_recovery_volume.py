import gzip
import hashlib
import importlib.util
import io
import os
import subprocess
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
