"""Network recovery never relaxes the pinned SIDER input contract."""

import hashlib
import io
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_sider_cache as builder


class SiderDownloadTests(unittest.TestCase):
    def test_cache_is_reverified_and_never_needs_network_when_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            with mock.patch.object(builder.urllib.request, "urlopen", return_value=io.BytesIO(self.payload)):
                self.assertEqual(builder.download(self.spec, cache), self.payload)
            with mock.patch.object(builder.urllib.request, "urlopen", side_effect=AssertionError("offline")):
                self.assertEqual(builder.download(self.spec, cache), self.payload)
                (cache / self.spec["sha256"]).write_bytes(b"modified cache")
                with self.assertRaisesRegex(SystemExit, "SIDER input changed"):
                    builder.download(self.spec, cache)

    def setUp(self):
        self.payload = b"verified public dataset\n"
        self.spec = {
            "url": "https://sideeffects.embl.de/synthetic-test",
            "bytes": len(self.payload),
            "sha256": hashlib.sha256(self.payload).hexdigest(),
        }

    @mock.patch("build_sider_cache.time.sleep")
    def test_timeout_retries_then_verifies_bytes(self, sleep):
        with mock.patch.object(builder.urllib.request, "urlopen", side_effect=[
            urllib.error.URLError(TimeoutError("timed out")),
            io.BytesIO(self.payload),
        ]) as request:
            self.assertEqual(builder.download(self.spec), self.payload)
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(2)

    @mock.patch("build_sider_cache.time.sleep")
    def test_outage_has_bounded_attempts(self, sleep):
        with mock.patch.object(builder.urllib.request, "urlopen", side_effect=TimeoutError()) as request:
            with self.assertRaises(TimeoutError):
                builder.download(self.spec)
        self.assertEqual(request.call_count, 3)
        self.assertEqual(sleep.call_args_list, [mock.call(2), mock.call(4)])

    @mock.patch("build_sider_cache.time.sleep")
    def test_integrity_failure_does_not_retry(self, sleep):
        with mock.patch.object(builder.urllib.request, "urlopen", return_value=io.BytesIO(b"changed")) as request:
            with self.assertRaisesRegex(SystemExit, "SIDER input changed"):
                builder.download(self.spec)
        request.assert_called_once()
        sleep.assert_not_called()

    @mock.patch("build_sider_cache.time.sleep")
    def test_http_failure_retries_only_transient_statuses(self, sleep):
        for status, expected in [(429, 3), (503, 3), (404, 1), (403, 1)]:
            with self.subTest(status=status):
                error = urllib.error.HTTPError(self.spec["url"], status, "synthetic", {}, io.BytesIO(b""))
                with mock.patch.object(builder.urllib.request, "urlopen", side_effect=error) as request:
                    with self.assertRaises(urllib.error.HTTPError):
                        builder.download(self.spec)
                self.assertEqual(request.call_count, expected)


if __name__ == "__main__":
    unittest.main()


class SiderReuseTests(unittest.TestCase):
    """An index already built from the pinned inputs is reused, never one built from anything else (2026-10-25 outage)."""

    def index(self, directory, **overrides):
        import sqlite3
        path = Path(directory) / "sider-4.1.sqlite"
        connection = sqlite3.connect(path)
        connection.executescript("""
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
            CREATE TABLE drug_names (compound_id TEXT, name TEXT, normalized_name TEXT);
            CREATE TABLE side_effects (compound_id TEXT, concept_id TEXT, effect_name TEXT);
            INSERT INTO drug_names VALUES ('CID1', 'aspirin', 'aspirin');
            INSERT INTO side_effects VALUES ('CID1', 'C1', 'nausea');
        """)
        recorded = {
            "release": "SIDER 4.1 (2015-10-21)",
            "drugNamesSha256": builder.SOURCES["drug_names.tsv"]["sha256"],
            "sideEffectsSha256": builder.SOURCES["meddra_all_se.tsv.gz"]["sha256"],
            "drugNameRows": "1", "sideEffectRows": "1", **overrides,
        }
        connection.executemany("INSERT INTO metadata VALUES (?, ?)", list(recorded.items()))
        connection.commit()
        connection.close()
        return path

    def test_an_index_of_the_pinned_inputs_is_reused(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            self.assertTrue(builder.reusable(self.index(directory)))

    def test_anything_else_is_built_again(self):
        import tempfile
        for overrides in ({"drugNamesSha256": "0" * 64}, {"sideEffectsSha256": "0" * 64}, {"sideEffectRows": "2"},
                          {"release": "SIDER 4.0"}, {"drugNameRows": "0"}):
            with tempfile.TemporaryDirectory() as directory:
                self.assertFalse(builder.reusable(self.index(directory, **overrides)), overrides)
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(builder.reusable(Path(directory) / "absent.sqlite"))
            garbage = Path(directory) / "garbage.sqlite"
            garbage.write_bytes(b"not a database")
            self.assertFalse(builder.reusable(garbage))
