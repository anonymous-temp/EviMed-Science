import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "image_layer_table", Path(__file__).parents[1] / "image-layer-table.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def add(archive, name, content):
    member = tarfile.TarInfo(name)
    member.size = len(content)
    archive.addfile(member, io.BytesIO(content))


def save_stream(images):
    """A `docker save` stream (OCI layout, manifest last): {reference: [(layer bytes, created_by)]}."""
    buffer = io.BytesIO()
    manifest = []
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for reference, layers in images.items():
            paths, diff_ids, history = [], [], [{"created_by": "LABEL a=b", "empty_layer": True}]
            for content, made_by in layers:
                digest = hashlib.sha256(content).hexdigest()
                paths.append("blobs/sha256/" + digest)
                diff_ids.append("sha256:" + digest)
                history.append({"created_by": made_by})
                add(archive, "blobs/sha256/" + digest, content)
            config = json.dumps({"rootfs": {"type": "layers", "diff_ids": diff_ids}, "history": history}).encode()
            config_path = "blobs/sha256/" + hashlib.sha256(config).hexdigest()
            add(archive, config_path, config)
            manifest.append({"Config": config_path, "RepoTags": [reference], "Layers": paths})
        add(archive, "manifest.json", json.dumps(manifest).encode())
    buffer.seek(0)
    return buffer


class ImageLayerTableTest(unittest.TestCase):
    def test_each_layer_is_named_with_its_bytes_and_the_instruction_that_made_it(self):
        stream = save_stream({"runtime:1": [(b"a" * 4096, "RUN system"), (b"b" * 512, "COPY socket")]})
        images = MODULE.read_stream(stream, {"runtime": "runtime:1"})
        layers = images["runtime"]["layers"]
        self.assertEqual([layer["bytes"] for layer in layers], [4096, 512])
        self.assertEqual([layer["createdBy"] for layer in layers], ["RUN system", "COPY socket"])
        self.assertFalse(any(layer["compressed"] for layer in layers))
        self.assertEqual(images["runtime"]["bytes"], 4608)

    def test_the_comparison_counts_only_the_layers_the_earlier_run_did_not_hold(self):
        base = [(b"system" * 1000, "RUN system"), (b"python" * 1000, "RUN python")]
        before = {"images": MODULE.read_stream(save_stream({"runtime:1": base + [(b"socket-1", "COPY socket")]}), {"runtime": "runtime:1"})}
        after = {"images": MODULE.read_stream(save_stream({"runtime:2": base + [(b"socket-2!", "COPY socket")]}), {"runtime": "runtime:2"})}
        out = io.StringIO()
        self.assertEqual(MODULE.compare(before, after, out=out), len(b"socket-2!"))
        self.assertIn("the first 2 keep their diff IDs; 1 new", out.getvalue())

    def test_a_reference_missing_from_the_stream_is_refused(self):
        with self.assertRaises(SystemExit):
            MODULE.read_stream(save_stream({"web:1": [(b"x", "RUN x")]}), {"runtime": "runtime:1"})


if __name__ == "__main__":
    unittest.main()
