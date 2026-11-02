#!/usr/bin/env python3
"""Tests of brokerctl's local parts (no ssh): reading requests, attaching public input files, refusing answers.
Run: python3 -I -m unittest discover -s . -p "test_brokerctl.py" (from this directory)."""
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("brokerctl", HERE / "brokerctl.py")
brokerctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brokerctl)

HOST = "/srv/evimed-science/shared/benchmarks/data"


def manifest(tmp, entries):
    path = pathlib.Path(tmp, "fetch.json")
    path.write_text(json.dumps(entries))
    return str(path)


def request(rid, files):
    return {"rid": rid, "image": "base", "item": {"key": f"b/{rid}", "prompt": "p", "files": files}, "probe": {"preamble": None, "line": None}}


class AttachTest(unittest.TestCase):
    def test_a_zip_covers_the_files_under_its_unzip_target_and_a_plain_file_covers_itself(self):
        with tempfile.TemporaryDirectory() as tmp:
            fetch = manifest(tmp, [
                {"url": "https://h/x.zip", "bytes": 10, "sha256": "aa", "dest": f"{HOST}/bixbench/_zips/x.zip",
                 "unzip": {"into": f"{HOST}/bixbench/bix-1", "only_prefix": "C/", "strip_prefix": True, "delete_zip": True}},
                {"url": "https://h/y.xlsx", "bytes": 5, "sha256": None, "dest": f"{HOST}/rcb/T/y.xlsx", "unzip": None},
                {"url": "https://h/other.zip", "bytes": 1, "sha256": None, "dest": f"{HOST}/bixbench/_zips/o.zip",
                 "unzip": {"into": f"{HOST}/bixbench/bix-2"}},
            ])
            out = brokerctl.attach_data([request("a", [{"src": "/bench/data/bixbench/bix-1/a.csv", "dest": "inputs/a.csv"}]),
                                         request("b", [{"src": "/bench/data/rcb/T/y.xlsx", "dest": "inputs/y.xlsx"}]), request("c", [])], [fetch])
            self.assertEqual([d["dest"] for d in out[0]["data"]], ["/bench/data/bixbench/_zips/x.zip"])
            self.assertEqual(out[0]["data"][0]["unzip"]["into"], "/bench/data/bixbench/bix-1")
            self.assertEqual([d["dest"] for d in out[1]["data"]], ["/bench/data/rcb/T/y.xlsx"])
            self.assertNotIn("data", out[2])

    def test_a_gz_input_is_made_from_the_public_file_without_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            fetch = manifest(tmp, [{"url": "https://h/t.csv", "bytes": 5, "sha256": "bb", "dest": f"{HOST}/rcb/T/t.csv", "unzip": None}])
            out = brokerctl.attach_data([request("a", [{"src": "/bench/data/rcb/T/t.csv.gz", "dest": "inputs/t.csv.gz"}])], [fetch])
            self.assertEqual([(d["dest"], d.get("gzip")) for d in out[0]["data"]], [("/bench/data/rcb/T/t.csv", True)])


class ReadTest(unittest.TestCase):
    def test_a_file_may_hold_one_object_a_list_or_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            one = pathlib.Path(tmp, "one.json")
            one.write_text(json.dumps({"rid": "a"}, indent=2))
            many = pathlib.Path(tmp, "many.jsonl")
            many.write_text(json.dumps({"rid": "b"}) + "\n" + json.dumps({"rid": "c"}) + "\n")
            array = pathlib.Path(tmp, "array.json")
            array.write_text(json.dumps([{"rid": "d"}, {"rid": "e"}]))
            self.assertEqual([r["rid"] for r in brokerctl.read_requests([str(one), str(many), str(array)])], ["a", "b", "c", "d", "e"])


class RefusalTest(unittest.TestCase):
    def test_the_same_validation_the_host_applies_refuses_an_answer_key(self):
        bad = request("a", [])
        bad["item"]["gold"] = "x"
        with self.assertRaises(ValueError):
            brokerctl.broker.validate_request(bad)
        brokerctl.broker.validate_request(request("ok", []))


if __name__ == "__main__":
    unittest.main()
