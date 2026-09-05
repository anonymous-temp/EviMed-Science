"""The canonical-index preset uses upstream config rather than discarding its queue."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("index_profile", Path(__file__).with_name("index_profile.py"))
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)

class IndexProfileTests(unittest.TestCase):
    def test_only_named_mutating_handlers_are_disabled(self):
        class Config:
            @staticmethod
            def get_scheduler_config():
                return {"backend": "optimized_scheduler", "config": {"use_redis_queue": True, "disabled_handlers": ["already_disabled"]}}
        profile.configure_scheduler(Config)
        result = Config.get_scheduler_config()
        self.assertTrue(result["config"]["use_redis_queue"])
        self.assertIn("mem_read", result["config"]["disabled_handlers"])
        self.assertIn("add", result["config"]["disabled_handlers"])
        self.assertIn("already_disabled", result["config"]["disabled_handlers"])
        self.assertNotIn("query", result["config"]["disabled_handlers"])
        self.assertEqual(result["config"]["thread_pool_max_workers"], 2)

    def test_provider_config_requires_protected_file_and_known_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "providers.json"
            file.write_text('{"OPENAI_API_KEY":"test-only-provider-key"}')
            file.chmod(0o600)
            with patch.dict(os.environ, {}, clear=True):
                profile.load_provider_config(file)
                self.assertEqual(os.environ["OPENAI_API_KEY"], "test-only-provider-key")
            file.chmod(0o644)
            with self.assertRaises(ValueError): profile.load_provider_config(file)
            file.chmod(0o600)
            file.write_text('{"NACOS_SERVER_ADDR":"unexpected-host"}')
            with self.assertRaises(ValueError): profile.load_provider_config(file)

if __name__ == "__main__": unittest.main()
