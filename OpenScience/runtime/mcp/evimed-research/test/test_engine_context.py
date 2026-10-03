import importlib.util
import pathlib
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import execution_context  # noqa: E402

CONTEXT = {"v": 1, "sessionId": "s-low", "callId": "call-1", "rootCallId": "call-1",
           "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low"}


def load_server():
    spec = importlib.util.spec_from_file_location("context_server", ROOT / "server.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    return server


class EngineContextTests(unittest.TestCase):
    def test_hidden_context_is_removed_before_public_validation_and_passed_separately(self):
        server = load_server()
        context = dict(CONTEXT)
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

    # On a deployment certified for deepseek-v4-pro every engine tool, the
    # deterministic calculator included, was refused here (2026-10-03): the
    # context named a model the gateway serves and this server did not list.
    def test_a_session_on_any_certified_model_reaches_every_engine_tool(self):
        server = load_server()
        self.assertIn("deepseek-v4-pro", execution_context.SUPPORTED_MODELS)
        self.assertGreaterEqual(len(server.ENGINE_CONTEXT_TOOLS), 7)
        for model in sorted(execution_context.SUPPORTED_MODELS):
            for name in sorted(server.ENGINE_CONTEXT_TOOLS):
                context = {**CONTEXT, "model": model}
                with self.subTest(model=model, tool=name), \
                        mock.patch.object(server, "_dispatch", return_value={"status": "success", "summary": "ok"}) as dispatch:
                    result = server.call_tool(name, {"action": "capabilities", "__evimed_execution_context": context})
                    self.assertEqual(result["status"], "success")
                    dispatch.assert_called_once_with(name, {"action": "capabilities"}, execution_context=context)

    def test_the_context_sets_an_engine_s_effort_and_never_its_model(self):
        for effort in sorted(execution_context.REASONING_EFFORTS):
            policy = execution_context.model_environment({**CONTEXT, "model": "deepseek-v4-pro", "reasoningEffort": effort})
            self.assertEqual(policy["LLM_REASONING_EFFORT"], effort)
            self.assertEqual(set(policy), {"LLM_ENABLE_THINKING", "LLM_REASONING_EFFORT", "EVIMED_MODEL_GATEWAY_POLICY"})

    # The refusal used to call `failure` two arguments short, so the caller saw
    # an anonymous "Internal error" and the model went looking for the cause in
    # its container. It is a ToolResult like any other, it names the field that
    # failed, and nothing is dispatched.
    def test_a_refused_context_is_a_structured_failure_that_names_its_field(self):
        server = load_server()
        refused = [
            ("research_calculate", {**CONTEXT, "model": "deepseek-chat"}, "model"),
            ("meta_analysis", {**CONTEXT, "reasoningEffort": "medium"}, "reasoningEffort"),
            ("peer_review", {**CONTEXT, "provider": "another-provider"}, "provider"),
            ("bibliometric_analysis", {**CONTEXT, "v": 2}, "v"),
            ("mendelian_randomization", {**CONTEXT, "sessionId": "not a session id"}, "sessionId"),
            ("research_topic_selection", {**CONTEXT, "owner": "user-1"}, "fields"),
            ("drug_safety_analysis", "forged", "fields"),
            ("term_normalize", dict(CONTEXT), "tool"),
        ]
        with mock.patch.object(server, "_dispatch") as dispatch:
            for name, supplied, field in refused:
                with self.subTest(tool=name, field=field):
                    result = server.call_tool(name, {"action": "capabilities", "__evimed_execution_context": supplied})
                    self.assertEqual(result["status"], "error")
                    self.assertEqual(result["error"]["code"], "engine_execution_context_invalid")
                    self.assertEqual(result["error"]["message"], "The engine execution context is invalid (%s)." % field)
                    self.assertIs(result["error"]["retryable"], False)
                    # The server's own contract for an error result: a stop
                    # reason and next actions, both in words.
                    self.assertEqual(server._normalize_tool_result(name, result, {}, {}), result)
            dispatch.assert_not_called()
        engine = server.call_tool("research_calculate", {"__evimed_execution_context": {**CONTEXT, "model": "deepseek-chat"}})
        other = server.call_tool("term_normalize", {"term": "aspirin", "__evimed_execution_context": dict(CONTEXT)})
        self.assertIn("do not retry", engine["next_actions"][0])
        self.assertIn("only declared inputs", other["next_actions"][0])

    def test_a_value_of_the_wrong_type_is_refused_rather_than_raised(self):
        for field, value in [("model", ["deepseek-flash"]), ("reasoningEffort", {"level": "high"}), ("v", True),
                             ("v", 1.0), ("callId", 7), ("sessionId", None)]:
            with self.subTest(field=field), self.assertRaises(execution_context.InvalidContext) as caught:
                execution_context.validate_context({**CONTEXT, field: value})
            self.assertEqual(caught.exception.field, field)
        self.assertEqual(execution_context.validate_context(dict(CONTEXT)), CONTEXT)
        without_effort = {key: value for key, value in CONTEXT.items() if key != "reasoningEffort"}
        self.assertEqual(execution_context.validate_context(without_effort), without_effort)


if __name__ == "__main__":
    unittest.main()
