#!/usr/bin/env python3
"""Tests of the lane's pure parts: the contamination record, the result bundle, the data cache. No Docker, no network.
Run: python3 -I -m unittest discover -s . -p "test_lane.py" (from this directory)."""
import importlib.util
import io
import json
import os
import pathlib
import sys
import tarfile
import tempfile
import unittest
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
TMP = tempfile.mkdtemp()
os.environ["LAB_WORK"] = TMP
spec = importlib.util.spec_from_file_location("lane", HERE / "lane.py")
lane = importlib.util.module_from_spec(spec)
sys.modules["lane"] = lane
spec.loader.exec_module(lane)


def transcript(parts):
    return {"messages": [{"role": "assistant", "parts": parts}]}


class ContaminationTest(unittest.TestCase):
    def scan(self, parts):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp, "transcript.json")
            path.write_text(json.dumps(transcript(parts)), encoding="utf-8")
            return lane.contamination(path)

    def test_a_url_naming_a_benchmark_is_recorded_in_the_call_and_in_the_result(self):
        found = self.scan([
            {"type": "tool", "tool": "web_read", "input": {"url": "https://huggingface.co/datasets/futurehouse/BixBench"}, "output": "ok"},
            {"type": "tool", "tool": "web_search", "input": {"query": "x"}, "output": {"rows": [{"url": "https://github.com/x/MedCalc-Bench/blob/main/a.csv"}]}},
        ])
        self.assertEqual(found["count"], 2)
        self.assertEqual([(h["where"], h["names"]) for h in found["hits"]], [("call", ["bixbench"]), ("result", ["medcalc-bench"])])
        self.assertEqual(found["datasetHostUrls"], 1)
        self.assertTrue(found["scanned"])

    def test_case_insensitive_and_every_listed_name(self):
        urls = [f"https://example.org/{name.upper()}/x" for name in lane.BENCHMARK_NAMES]
        found = self.scan([{"type": "tool", "tool": "web_read", "input": {"url": url}} for url in urls])
        self.assertEqual(found["count"], len(lane.BENCHMARK_NAMES))

    def test_other_urls_and_plain_text_are_not_hits(self):
        found = self.scan([{"type": "tool", "tool": "web_read", "input": {"url": "https://arxiv.org/abs/1706.03762"}, "output": "bixbench is a benchmark"}])
        self.assertEqual((found["count"], found["hits"]), (0, []))

    def test_an_unreadable_transcript_is_reported_as_not_scanned(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(lane.contamination(pathlib.Path(tmp, "missing.json"))["scanned"])

    def test_a_repeated_url_is_one_hit(self):
        part = {"type": "tool", "tool": "web_read", "input": {"url": "https://huggingface.co/datasets/x/bixbench"}}
        self.assertEqual(self.scan([part, part])["count"], 1)


class PackTest(unittest.TestCase):
    def make(self, root, files):
        for name, size in files.items():
            path = root / "item" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(os.urandom(size) if size else b"")
        (root / "driver.log").write_text("log\n")

    def test_big_files_are_dropped_and_recorded_and_the_essentials_stay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            self.make(root, {"result.json": 100, "transcript.json": 2000, "answer.md": 10, "files/report/report.md": 500,
                             "files/data.bin": lane.FILE_CAP + 1, "files/small.csv": 300})
            target = root / "bundle.tgz"
            dropped = lane.pack(root, "item", {"rid": "r1"}, target)
            names = tarfile.open(target).getnames()
            for needed in ("r1/result.json", "r1/transcript.json", "r1/answer.md", "r1/files/report/report.md", "r1/lane.json", "r1/driver.log"):
                self.assertIn(needed, names)
            self.assertEqual([row["path"] for row in dropped], ["files/data.bin"])
            meta = json.loads(tarfile.open(target).extractfile("r1/lane.json").read())
            self.assertEqual(meta["dropped"][0]["reason"], "over the per-file cap")

    def test_the_bundle_cap_drops_the_lowest_tier_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            self.make(root, {"result.json": 100, "transcript.json": 1000, "files/report.md": 1000, "files/a.bin": 9 * 1024 * 1024,
                             "files/b.bin": 9 * 1024 * 1024, "files/c.bin": 9 * 1024 * 1024, "files/d.bin": 9 * 1024 * 1024})
            target = root / "bundle.tgz"
            dropped = lane.pack(root, "item", {"rid": "r2"}, target)
            self.assertLessEqual(target.stat().st_size, lane.BUNDLE_CAP)
            names = tarfile.open(target).getnames()
            self.assertIn("r2/result.json", names)
            self.assertIn("r2/files/report.md", names)
            self.assertGreaterEqual(len(dropped), 1)
            self.assertTrue(all(row["path"].endswith(".bin") for row in dropped))


class DataTest(unittest.TestCase):
    def test_a_zip_is_unpacked_under_the_stripped_prefix_and_not_fetched_twice(self):
        with tempfile.TemporaryDirectory() as tmp:
            lane.BENCH = pathlib.Path(tmp) / "bench"
            source = pathlib.Path(tmp, "src.zip")
            with zipfile.ZipFile(source, "w") as bundle:
                bundle.writestr("CapsuleData-1/a.csv", "x,y\n1,2\n")
                bundle.writestr("CapsuleData-1/sub/b.txt", "b")
                bundle.writestr("Other/skip.txt", "no")
            calls = []
            original = lane.download

            def fake(url, dest, size, digest):
                calls.append(url)
                dest.write_bytes(source.read_bytes())

            lane.download = fake
            try:
                entry = {"url": "https://example.org/x.zip", "bytes": None, "sha256": None, "dest": "/bench/data/bixbench/_zips/x.zip",
                         "unzip": {"into": "/bench/data/bixbench/bix-1", "only_prefix": "CapsuleData-1/", "strip_prefix": True, "delete_zip": True}}
                self.assertEqual(lane.fetch_data([entry]), 1)
                self.assertEqual(lane.fetch_data([entry]), 0)
            finally:
                lane.download = original
            into = lane.BENCH / "data/bixbench/bix-1"
            self.assertEqual((into / "a.csv").read_text(), "x,y\n1,2\n")
            self.assertTrue((into / "sub/b.txt").exists())
            self.assertFalse((into / "skip.txt").exists())
            self.assertEqual(len(calls), 1)

    def test_a_file_the_host_kept_gzipped_is_fetched_and_compressed_once(self):
        import gzip
        with tempfile.TemporaryDirectory() as tmp:
            lane.BENCH = pathlib.Path(tmp) / "bench"
            original = lane.download
            calls = []

            def fake(url, dest, size, digest):
                calls.append(url)
                dest.write_bytes(b"a,b\n1,2\n" * 100)

            lane.download = fake
            try:
                entry = {"url": "https://example.org/t.csv", "bytes": None, "sha256": None, "dest": "/bench/data/rcb/t.csv", "gzip": True}
                self.assertEqual(lane.fetch_data([entry]), 1)
                self.assertEqual(lane.fetch_data([entry]), 0)
            finally:
                lane.download = original
            packed = lane.BENCH / "data/rcb/t.csv.gz"
            self.assertEqual(gzip.decompress(packed.read_bytes()), b"a,b\n1,2\n" * 100)
            self.assertFalse((lane.BENCH / "data/rcb/t.csv").exists())
            self.assertEqual(len(calls), 1)

    def test_a_destination_outside_the_cache_and_a_plain_http_url_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            lane.BENCH = pathlib.Path(tmp) / "bench"
            with self.assertRaises(ValueError):
                lane.fetch_data([{"url": "https://example.org/x", "dest": "/bench/../../etc/x"}])
            with self.assertRaises(ValueError):
                lane.fetch_data([{"url": "http://example.org/x", "dest": "/bench/data/x"}])


class FolderTest(unittest.TestCase):
    def test_item_folder_follows_the_drivers_naming(self):
        self.assertEqual(lane.item_folder("bixbench/bix-18"), "bixbench__bix-18")
        self.assertEqual(lane.item_folder("medcalc-rsi/base/211#r1"), "medcalc-rsi__base__211_r1")


if __name__ == "__main__":
    unittest.main()
