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

    def test_local_engine_environments_keep_the_per_call_effort(self):
        import os
        import tempfile
        import meta_agent
        import specialist_jobs
        context = {"v": 1, "sessionId": "s-off", "callId": "call-1", "rootCallId": "call-1",
                   "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "off"}
        with tempfile.TemporaryDirectory() as directory:
            token = pathlib.Path(directory) / "token"
            token.write_text("test-only-token\n")
            token.chmod(0o600)
            with mock.patch.dict(os.environ, {"EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token),
                    "EVIMED_MODEL_GATEWAY_URL": "http://gateway.invalid/v1", "EVIMED_MODEL_GATEWAY_MODEL": "deepseek-flash"}):
                for module in (meta_agent, specialist_jobs):
                    env = module._model_environment(context)
                    self.assertEqual(env["LLM_REASONING_EFFORT"], "off")
                    self.assertEqual(env["LLM_ENABLE_THINKING"], "false")
