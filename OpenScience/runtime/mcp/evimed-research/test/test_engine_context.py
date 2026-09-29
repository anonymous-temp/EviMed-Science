import importlib.util
import pathlib
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class EngineContextTests(unittest.TestCase):
    def test_hidden_context_is_removed_before_public_validation_and_passed_separately(self):
        spec = importlib.util.spec_from_file_location("context_server", ROOT / "server.py")
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        context = {"v": 1, "sessionId": "s-low", "callId": "call-1", "rootCallId": "call-1",
                   "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low"}
        args = {"action": "start", "topic": "A review", "__evimed_execution_context": context}
        with mock.patch.dict(server.os.environ, {"EVIMED_META_ANALYSIS_URL": "https://adapter.example/meta"}), \
                mock.patch.object(server, "_adapter_call", return_value={"status": "success", "summary": "ok", "data": {}}) as call:
            result = server.call_tool("meta_analysis", args)
        self.assertEqual(result["status"], "success")
        self.assertEqual(call.call_args.args, ("meta_analysis", {"action": "start", "topic": "A review"}))
        self.assertEqual(call.call_args.kwargs["execution_context"], context)
        self.assertIn("__evimed_execution_context", args)
