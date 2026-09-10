"""A preserved source carries the digests that prove it was not edited.

`.evimed-sources/` was writable by the run until 2026-09-10 and every
verbatim-quote check in the clinical gate reads the bytes on disk, so editing a
preserved full text was enough to make any quote match. Two things changed. The
write guard now names the directory, which stops the model's own write and edit
tools. And every capture now records the digests `preserve()` was already
computing, so an edit that arrives some other way is provable after the fact
rather than only preventable in advance.

Reproduced before the change: capture a page, overwrite it on disk, and nothing
anywhere could tell that the bytes had moved — the digests existed for the
length of one function call and were discarded.
"""

import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module():
    sys.path.insert(0, str(ROOT))
    spec = importlib.util.spec_from_file_location("evimed_immutable_capture_test", ROOT / "immutable_capture.py")
    try:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


class CaptureManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def setUp(self):
        self._temp = tempfile.TemporaryDirectory()
        self.workspace = pathlib.Path(self._temp.name)
        self.root = pathlib.Path(".evimed-sources") / "PMC123456"
        self.artifacts = {"fulltext.md": b"# Title\n\nA sentence a claim will quote.\n", "fulltext.xml": b"<article/>"}

    def tearDown(self):
        self._temp.cleanup()

    def capture(self, artifacts=None):
        paths = self.module.preserve(self.workspace, self.root, artifacts or self.artifacts)
        directory = pathlib.Path(paths["fulltext.md"]).parent
        return paths, directory

    def test_a_capture_records_a_digest_for_every_artifact(self):
        _, directory = self.capture()
        manifest = json.loads((self.workspace / directory / self.module.CAPTURE_MANIFEST_NAME).read_text("utf-8"))
        self.assertEqual(manifest["schemaVersion"], self.module.CAPTURE_MANIFEST_SCHEMA)
        self.assertEqual(manifest["version"], directory.name)
        self.assertEqual(
            manifest["artifacts"],
            {name: hashlib.sha256(payload).hexdigest() for name, payload in self.artifacts.items()},
        )
        self.assertEqual(self.module.verify_capture(self.workspace, directory), [])

    def test_the_manifest_is_not_returned_as_an_artifact(self):
        # Callers publish `artifactSha256s` from what `preserve` returns, and a
        # ledger listed among the sources would be quotable as evidence.
        paths, _ = self.capture()
        self.assertEqual(sorted(paths), ["fulltext.md", "fulltext.xml"])

    def test_recapturing_identical_bytes_writes_an_identical_manifest(self):
        _, directory = self.capture()
        before = (self.workspace / directory / self.module.CAPTURE_MANIFEST_NAME).read_bytes()
        _, again = self.capture()
        self.assertEqual(again, directory, "identical content must reuse the same version directory")
        self.assertEqual((self.workspace / directory / self.module.CAPTURE_MANIFEST_NAME).read_bytes(), before)

    def test_an_edited_artifact_is_named_by_file_and_by_digest(self):
        _, directory = self.capture()
        edited = self.workspace / directory / "fulltext.md"
        edited.write_bytes(b"# Title\n\nA sentence the report claims it quotes.\n")
        findings = self.module.verify_capture(self.workspace, directory)
        self.assertEqual(len(findings), 1, findings)
        self.assertIn("fulltext.md", findings[0])
        self.assertIn("was edited after capture", findings[0])

    def test_a_deleted_artifact_is_reported_rather_than_read_as_intact(self):
        _, directory = self.capture()
        (self.workspace / directory / "fulltext.xml").unlink()
        findings = self.module.verify_capture(self.workspace, directory)
        self.assertTrue(any("fulltext.xml" in finding and "not on disk" in finding for finding in findings), findings)

    def test_a_manifest_rewritten_to_describe_the_edit_still_fails(self):
        # The interesting attack: edit the artifact, then rewrite the ledger to
        # match. The directory name is sha256 over the digests, so a consistent
        # lie has to move the capture — and the evidence rows and citations
        # point at the old path.
        _, directory = self.capture()
        forged = b"# Title\n\nA sentence the report claims it quotes.\n"
        (self.workspace / directory / "fulltext.md").write_bytes(forged)
        hashes = {
            "fulltext.md": hashlib.sha256(forged).hexdigest(),
            "fulltext.xml": hashlib.sha256(self.artifacts["fulltext.xml"]).hexdigest(),
        }
        (self.workspace / directory / self.module.CAPTURE_MANIFEST_NAME).write_bytes(
            json.dumps(
                {"schemaVersion": 1, "version": directory.name, "artifacts": hashes},
                sort_keys=True, separators=(",", ":"),
            ).encode("utf-8")
        )
        findings = self.module.verify_capture(self.workspace, directory)
        self.assertTrue(any("does not match the digests its manifest records" in finding for finding in findings), findings)

    def test_a_capture_with_no_manifest_is_unverifiable_not_intact(self):
        _, directory = self.capture()
        (self.workspace / directory / self.module.CAPTURE_MANIFEST_NAME).unlink()
        findings = self.module.verify_capture(self.workspace, directory)
        self.assertEqual(len(findings), 1, findings)
        self.assertIn("cannot be verified", findings[0])

    def test_re_retrieval_still_refuses_a_tampered_capture(self):
        # The protection that already existed, pinned so the manifest is not
        # mistaken for it: a second claim citing the same source re-preserves
        # the same artifact set, and the byte comparison refuses. It costs a
        # second retrieval, which is exactly why `verify_capture` exists — the
        # control plane holds a path and no bytes.
        _, directory = self.capture()
        (self.workspace / directory / "fulltext.xml").write_bytes(b"<article>edited</article>")
        with self.assertRaises(self.module.ImmutableCaptureError):
            self.module.preserve(self.workspace, self.root, self.artifacts)
        # And without re-retrieving anything at all:
        self.assertTrue(any("fulltext.xml" in finding for finding in self.module.verify_capture(self.workspace, directory)))

    def test_an_artifact_may_not_be_called_capture_json(self):
        with self.assertRaises(self.module.ImmutableCaptureError):
            self.module.preserve(self.workspace, self.root, {self.module.CAPTURE_MANIFEST_NAME: b"{}"})


if __name__ == "__main__":
    unittest.main()
