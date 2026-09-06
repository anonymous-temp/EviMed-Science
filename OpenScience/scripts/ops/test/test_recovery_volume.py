import gzip
import hashlib
import importlib.util
import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("recovery_volume", Path(__file__).parents[1] / "recovery-volume.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RecoveryVolumeTests(unittest.TestCase):
    def archive(self, root: Path) -> Path:
        archive = root / "member.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            directory = tarfile.TarInfo(".")
            directory.type = tarfile.DIRTYPE
            directory.mode = 0o750
            directory.uid = os.getuid()
            directory.gid = os.getgid()
            output.addfile(directory)
            nested = tarfile.TarInfo("nested")
            nested.type = tarfile.DIRTYPE
            nested.mode = 0o710
            nested.uid = os.getuid()
            nested.gid = os.getgid()
            output.addfile(nested)
            payload = b"synthetic descriptor-held payload\n"
            item = tarfile.TarInfo("nested/payload.txt")
            item.mode = 0o640
            item.uid = os.getuid()
            item.gid = os.getgid()
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

    def test_descriptor_held_archive_survives_ancestor_replacement_without_reading_the_link_target(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value).resolve()
            original = root / "original"
            attacker = root / "attacker"
            original.mkdir()
            attacker.mkdir()
            archive = self.archive(original)
            (attacker / archive.name).write_bytes(gzip.compress(b"attacker bytes"))
            opened = MODULE.open_archive(archive.name, cwd_fd=os.open(original, os.O_RDONLY | os.O_DIRECTORY))
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


if __name__ == "__main__":
    unittest.main()
