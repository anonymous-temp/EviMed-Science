"""Network-free credential and receipt-boundary regressions."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

from api import ENDPOINTS, NoRedirect, ProviderClient


class Response:
    status = 200

    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, limit):
        return self.body[:limit]


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.secret = "synthetic-credential-sentinel-only"
        key = self.root / "key"
        key.write_text(self.secret)
        config = self.root / "config.json"
        config.write_text(json.dumps({"deepseek": {"key_file": str(key), "endpoint": ENDPOINTS["deepseek"]}}))
        self.client = ProviderClient(self.root / "receipts", config)
        self.payload = {"model": "deepseek-v4-flash", "messages": [], "max_tokens": 10}

    def ask(self, body, label="one"):
        with patch("urllib.request.build_opener") as opener:
            opener.return_value.open.return_value = Response(body)
            result = self.client.request("deepseek", "deepseek-v4-flash", self.payload, label)
            return result, opener.call_count

    def test_documented_alias_allowed_foreign_model_rejected(self):
        result, _ = self.ask({"model": "deepseek-flash", "usage": {"prompt_tokens": 10}})
        self.assertIsNone(result["error"])
        result, _ = self.ask({"model": "another-model"}, "two")
        self.assertEqual(result["error"], "served_model_mismatch")

    def test_echoed_credential_never_persisted(self):
        result, _ = self.ask({"model": "deepseek-flash", "echo": self.secret})
        self.assertIsNotNone(result["error"])
        self.assertNotIn(self.secret, (self.root / "receipts/one.json").read_text())

    def test_resume_does_not_purchase_again(self):
        self.ask({"model": "deepseek-flash"})
        _, calls = self.ask({"model": "unused"})
        self.assertEqual(calls, 0)
        self.payload["max_tokens"] = 11
        with self.assertRaisesRegex(ValueError, "Cached request differs"):
            self.ask({"model": "unused"})

    def test_uncertain_reserved_attempt_is_not_retried(self):
        self.ask({"model": "deepseek-flash"})
        (self.root / "receipts/one.json").unlink()
        with self.assertRaisesRegex(ValueError, "outcome and billing are uncertain"):
            self.ask({"model": "unused"})

    def test_redirect_does_not_forward_authorization(self):
        with self.assertRaises(urllib.error.URLError):
            NoRedirect().redirect_request(None, None, 302, "", {}, "https://another.invalid")


if __name__ == "__main__":
    unittest.main()
