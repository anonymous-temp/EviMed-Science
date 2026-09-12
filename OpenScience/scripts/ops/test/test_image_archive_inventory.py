import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import tracemalloc
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "image_archive_inventory", Path(__file__).parents[1] / "image-archive-inventory.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def add(archive, name, content):
    member = tarfile.TarInfo(name)
    member.size = len(content)
    archive.addfile(member, io.BytesIO(content))


def fixture(*, oci=False, manifest_first=False, reverse=False, count=12, layer_bytes=1024,
            mutate_manifest=None, extra_members=(), transform_config=None, transform_manifest=None):
    members, manifest, expected = [], [], []
    for index in range(count):
        content = json.dumps({
            "os": "linux", "architecture": "amd64",
            "rootfs": {"type": "layers", "diff_ids": ["sha256:" + f"{index:064x}"]},
            "config": {"Labels": {"revision": "synthetic", "number": str(index)}},
        }).encode()
        if transform_config:
            content = transform_config(content)
        digest = hashlib.sha256(content).hexdigest()
        name = f"blobs/sha256/{digest}" if oci else f"{digest}.json"
        layer = f"blobs/sha256/{index:064x}" if oci else f"{index}/layer.tar"
        reference = f"synthetic/image-{index}:test"
        members.extend([(name, content), (layer, b"x" * layer_bytes)])
        manifest.append({"Config": name, "RepoTags": [reference], "Layers": [layer]})
        expected.append(reference)
    if reverse:
        manifest.reverse()
    if mutate_manifest:
        mutate_manifest(manifest)
    manifest_content = json.dumps(manifest).encode()
    if transform_manifest:
        manifest_content = transform_manifest(manifest_content)
    manifest_member = ("manifest.json", manifest_content)
    members = ([manifest_member] + members) if manifest_first else (members + [manifest_member])
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content in [*members, *extra_members]:
            add(archive, name, content)
    return output.getvalue(), expected


def old_inventory(content):
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
        manifest = json.load(archive.extractfile("manifest.json"))
        images = []
        for entry in manifest:
            content = archive.extractfile(entry["Config"]).read()
            config = json.loads(content)
            images.append({"references": entry["RepoTags"],
                           "configDigest": "sha256:" + hashlib.sha256(content).hexdigest(),
                           "platform": config.get("os", "") + "/" + config.get("architecture", ""),
                           "rootfs": config.get("rootfs"), "labels": config.get("config", {}).get("Labels", {})})
    return images


class ForwardOnly(io.BytesIO):
    def __init__(self, content):
        super().__init__(content)
        self.bytes_read = 0

    def read(self, count=-1):
        if count < 0:
            raise AssertionError("unbounded compressed read")
        result = super().read(count)
        self.bytes_read += len(result)
        return result

    def seek(self, *args):
        raise AssertionError("compressed stream must never seek")


class ImageArchiveInventoryTests(unittest.TestCase):
    def test_one_pass_matches_original_inventory_and_order_for_all_layouts(self):
        for oci in (False, True):
            for manifest_first in (False, True):
                for reverse in (False, True):
                    with self.subTest(oci=oci, manifest_first=manifest_first, reverse=reverse):
                        content, expected = fixture(oci=oci, manifest_first=manifest_first, reverse=reverse)
                        source = ForwardOnly(content)
                        images = MODULE.read_inventory(source, expected)
                        self.assertEqual(json.dumps(images, indent=2), json.dumps(old_inventory(content), indent=2))
                        self.assertEqual(source.bytes_read, len(content))

    def test_large_layers_do_not_accumulate_in_memory_or_tar_member_cache(self):
        content, expected = fixture(oci=True, count=3, layer_bytes=12 * 1024 * 1024)
        original_next = tarfile.TarFile.next
        member_cache_sizes = []

        def observe_next(archive):
            member_cache_sizes.append(len(archive.members))
            return original_next(archive)

        tracemalloc.start()
        try:
            with patch.object(tarfile.TarFile, "next", observe_next):
                images = MODULE.read_inventory(ForwardOnly(content), expected)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(len(images), 3)
        self.assertLessEqual(max(member_cache_sizes), 1)
        self.assertLess(peak, 8 * 1024 * 1024)

    def test_missing_config_rejects_instead_of_publishing_partial_inventory(self):
        content, expected = fixture(mutate_manifest=lambda manifest: manifest[0].update(Config="missing.json"))
        with self.assertRaisesRegex(ValueError, "config_missing"):
            MODULE.read_inventory(io.BytesIO(content), expected)

    def test_duplicate_paths_are_rejected(self):
        content, expected = fixture(extra_members=[("manifest.json", b"[]")])
        with self.assertRaisesRegex(ValueError, "duplicate_archive_path"):
            MODULE.read_inventory(io.BytesIO(content), expected)

    def test_json_metadata_accepts_whitespace_without_reserializing_configs(self):
        content, expected = fixture(oci=True, transform_config=lambda data: b" " * 100 + data)
        self.assertEqual(MODULE.read_inventory(io.BytesIO(content), expected), old_inventory(content))

    def test_ambiguous_or_nonfinite_json_metadata_is_rejected(self):
        for raw, reason in ((b'{"Config":"a","Config":"b"}', "duplicate_json_key"),
                            (b'{"Config":NaN}', "nonfinite_json_number")):
            with self.subTest(reason=reason):
                content, expected = fixture(transform_manifest=lambda _data: raw)
                with self.assertRaisesRegex(ValueError, reason):
                    MODULE.read_inventory(io.BytesIO(content), expected)

    def test_oversized_tar_extension_is_rejected_before_reading_its_body(self):
        header = tarfile.TarInfo("PaxHeaders/test")
        header.type = tarfile.XHDTYPE
        header.size = 65537
        compressed = gzip.compress(header.tobuf() + b" " * header.size)
        with self.assertRaisesRegex(ValueError, "pax_metadata_size_limit"):
            MODULE.read_inventory(io.BytesIO(compressed), ["synthetic:test"])

    def test_links_and_parent_paths_are_not_inventory_inputs(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            link = tarfile.TarInfo("manifest.json")
            link.type = tarfile.SYMTYPE
            link.linkname = "/outside"
            archive.addfile(link)
        with self.assertRaisesRegex(ValueError, "unsupported_archive_member"):
            MODULE.read_inventory(io.BytesIO(output.getvalue()), ["synthetic:test"])
        content, expected = fixture(extra_members=[("../unexpected", b"x")])
        with self.assertRaisesRegex(ValueError, "invalid_archive_path"):
            MODULE.read_inventory(io.BytesIO(content), expected)

    def test_duplicate_references_or_configs_are_rejected(self):
        for field in ("RepoTags", "Config"):
            with self.subTest(field=field):
                content, expected = fixture(mutate_manifest=lambda m: m[1].update({field: m[0][field]}))
                with self.assertRaisesRegex(ValueError, "duplicate_manifest"):
                    MODULE.read_inventory(io.BytesIO(content), expected)

    def test_reference_inventory_and_expected_duplicates_are_rejected(self):
        content, expected = fixture()
        for invalid in (expected[:-1], expected + [expected[0]], expected + ["unoffered:test"]):
            with self.subTest(expected_count=len(invalid)):
                with self.assertRaisesRegex(ValueError, "reference"):
                    MODULE.read_inventory(io.BytesIO(content), invalid)

    def test_metadata_and_member_limits_fail_closed(self):
        content, expected = fixture()
        for setting, limit, reason in (
            ("MAX_METADATA_BYTES", 64, "metadata_size_limit"),
            ("MAX_TOTAL_METADATA_BYTES", 512, "metadata_total_limit"),
            ("MAX_MEMBERS", 16, "member_limit"),
        ):
            with self.subTest(setting=setting), patch.object(MODULE, setting, limit):
                with self.assertRaisesRegex(ValueError, reason):
                    MODULE.read_inventory(io.BytesIO(content), expected)

    def test_crc_and_truncation_are_checked_after_tar_end(self):
        content, expected = fixture()
        corrupt = bytearray(content)
        corrupt[-8] ^= 0x01
        for invalid in (bytes(corrupt), content[:-4]):
            with self.subTest(size=len(invalid)):
                with self.assertRaises((OSError, EOFError)):
                    MODULE.read_inventory(io.BytesIO(invalid), expected)

    def test_artifact_report_preserves_identity_types_and_exact_four_files(self):
        content, expected = fixture(reverse=True)
        identity = {"GITHUB_SHA": "a" * 40, "OPEN_SCIENCE_RELEASE_ID": "release-123",
                    "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2"}
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / "images.tar.gz").write_bytes(content)
            (root / "images.tar.gz.sha256").write_text(hashlib.sha256(content).hexdigest() + "  images.tar.gz\n")
            (root / "images.txt").write_text("\n".join(expected) + "\n")
            archive_hash = hashlib.sha256(content).hexdigest()
            MODULE.write_report(root, identity)
            report = json.loads((root / "manifest.json").read_text())
            self.assertEqual(report, {"sourceRevision": "a" * 40, "releaseId": "release-123",
                                      "workflowRun": "123", "workflowAttempt": "2", "images": old_inventory(content)})
            self.assertEqual(hashlib.sha256((root / "images.tar.gz").read_bytes()).hexdigest(), archive_hash)
            self.assertEqual({path.name for path in root.iterdir()},
                             {"images.tar.gz", "images.tar.gz.sha256", "images.txt", "manifest.json"})


if __name__ == "__main__":
    unittest.main()
