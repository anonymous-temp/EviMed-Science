"""Network recovery never relaxes the pinned SIDER input contract."""

import hashlib
import io
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_sider_cache as builder


class SiderDownloadTests(unittest.TestCase):
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
