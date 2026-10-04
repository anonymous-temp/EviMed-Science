"""The recorded wire is what its manifest says it is, and can be re-recorded."""

import hashlib
import importlib.util
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import wire_fixtures as wire  # noqa: E402

sys.dont_write_bytecode = True  # loading the recorder must not leave a __pycache__ among the fixtures
spec = importlib.util.spec_from_file_location("wire_record", wire.DIRECTORY / "record.py")
record = importlib.util.module_from_spec(spec)
spec.loader.exec_module(record)


class ManifestTests(unittest.TestCase):
    def test_every_file_is_listed_and_matches_its_bytes_and_digest(self):
        listed = {entry["file"] for entry in wire.manifest()["files"]}
        on_disk = {path.name for path in wire.DIRECTORY.iterdir() if path.name not in ("manifest.json", "record.py", "__pycache__")}
        self.assertEqual(listed, on_disk, "a fixture nobody listed, or a listing with no file")
        for entry in wire.manifest()["files"]:
            with self.subTest(file=entry["file"]):
                data = (wire.DIRECTORY / entry["file"]).read_bytes()
                self.assertEqual((len(data), hashlib.sha256(data).hexdigest()), (entry["bytes"], entry["sha256"]), "edited after it was recorded")

    def test_each_entry_says_where_it_came_from(self):
        for entry in wire.manifest()["files"]:
            with self.subTest(file=entry["file"]):
                self.assertIn(entry["origin"], ("live", "constructed"))
                self.assertIsInstance(entry["status"], int)
                if entry["origin"] == "live":
                    self.assertRegex(entry["recordedAt"], r"^2026-\d\d-\d\d")
                    self.assertTrue(entry["request"].startswith("GET https://"))
                else:
                    self.assertTrue(entry.get("note"), "a constructed fixture says what it was written from")

    def test_every_live_request_is_a_url_the_recorder_can_ask_again(self):
        urls = [record.request_url(entry) for entry in wire.manifest()["files"] if entry["origin"] == "live"]
        self.assertGreater(len(urls), 30)
        for url in urls:
            self.assertRegex(url, r"^https://[a-z0-9.-]+/\S*$", url)
            self.assertNotIn(" ", url)
        # Query values with spaces and quotes are encoded once; an already-encoded value is left alone.
        self.assertIn("query=DOI:%22", " ".join(urls))
        self.assertIn("email=research%40evimed.example", " ".join(urls))
        self.assertNotIn("%2540", " ".join(urls))

    def test_the_recorder_never_touches_what_it_was_not_asked_to(self):
        self.assertEqual(record.request_url({"file": "x", "request": "GET https://a.example/p?q=a b&r=c"}), "https://a.example/p?q=a%20b&r=c")
        with self.assertRaises(ValueError):
            record.request_url({"file": "x", "request": "POST https://a.example/"})


if __name__ == "__main__":
    unittest.main()
