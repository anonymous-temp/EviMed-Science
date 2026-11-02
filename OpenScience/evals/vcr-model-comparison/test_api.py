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

    def test_incomplete_or_invalid_usage_does_not_settle_reservation(self):
        invalid = [
            {"prompt_tokens": 10},
            {"prompt_tokens": 10, "completion_tokens": -1},
            {"prompt_tokens": 10, "completion_tokens": float("nan")},
            {"prompt_tokens": 10, "completion_tokens": float("inf")},
            {"prompt_tokens": True, "completion_tokens": 1},
            {"prompt_tokens": 10, "completion_tokens": 1.5},
            {"prompt_tokens": 10, "completion_tokens": 1, "prompt_cache_hit_tokens": 2},
            {"prompt_tokens": 10, "completion_tokens": 1,
             "prompt_cache_hit_tokens": 2, "prompt_cache_miss_tokens": 9},
        ]
        for index, usage in enumerate(invalid):
            with self.subTest(usage=usage):
                result, _ = self.ask({"model": "deepseek-flash", "usage": usage}, str(index))
                self.assertIsNone(result["cost"])
                self.assertIn("unknown", result["billing"])

    def test_complete_pro_usage_uses_pro_prices(self):
        self.payload["model"] = "deepseek-v4-pro"
        usage = {"prompt_tokens": 10, "completion_tokens": 3,
                 "prompt_cache_hit_tokens": 2, "prompt_cache_miss_tokens": 8}
        with patch("urllib.request.build_opener") as opener:
            opener.return_value.open.return_value = Response({"model": "deepseek-v4-pro", "usage": usage})
            result = self.client.request("deepseek", "deepseek-v4-pro", self.payload, "pro")
        self.assertIsNone(result["error"])
        self.assertAlmostEqual(result["cost"], (2 * .3 + 8 * 9 + 3 * 27) / 1e6)

    def test_unknown_usage_retains_budget_reservation(self):
        first, _ = self.ask({"model": "deepseek-flash", "usage": {"prompt_tokens": 10}})
        self.client.config["deepseek"]["budget"] = first["reservation"] * 1.5
        with patch("urllib.request.build_opener") as opener:
            with self.assertRaisesRegex(ValueError, "Conservative provider budget"):
                self.client.request("deepseek", "deepseek-v4-flash", self.payload, "two")
            opener.assert_not_called()

    def test_complete_usage_releases_reservation_for_next_attempt(self):
        body = {"model": "deepseek-flash", "usage": {"prompt_tokens": 10, "completion_tokens": 1}}
        first, _ = self.ask(body)
        self.client.config["deepseek"]["budget"] = first["reservation"] * 1.5
        second, calls = self.ask(body, "two")
        self.assertEqual(calls, 1)
        self.assertIsNone(second["error"])

    def test_nonfinite_settled_cost_retains_reservation(self):
        first, _ = self.ask({"model": "deepseek-flash"})
        receipt_path = self.root / 'receipts/one.json'
        first['cost'] = float('nan')
        receipt_path.write_text(json.dumps(first))
        self.client.config["deepseek"]["budget"] = first["reservation"] * 1.5
        with patch("urllib.request.build_opener") as opener:
            with self.assertRaisesRegex(ValueError, "Conservative provider budget"):
                self.client.request("deepseek", "deepseek-v4-flash", self.payload, "two")
            opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()
