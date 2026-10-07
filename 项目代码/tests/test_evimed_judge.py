"""Offline contract checks for engine-only judge integration."""
import ast
import importlib.util
import json
import threading
import asyncio
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("evimed_judge", ROOT / "evimed_judge.py")
judge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(judge)

class Response:
    def __init__(self, result):
        self.raw = json.dumps(result).encode()
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def read(self, size):
        return self.raw[:size]

class JudgeTests(unittest.TestCase):
    def test_absent_gateway_is_no_call(self):
        with patch.dict(judge.os.environ, {}, clear=True), patch.object(judge.urllib.request, 'build_opener') as opener:
            self.assertIsNone(judge.ask('J9', {}))
            opener.assert_not_called()

    def test_closed_request_and_uncertainty_fallback(self):
        env = {'EVIMED_JUDGE_GATEWAY_URL':'http://judge.test/internal/judge/v1/ask', 'EVIMED_JUDGE_GATEWAY_TOKEN':'scoped'}
        with patch.dict(judge.os.environ, env, clear=True), patch.object(judge.urllib.request, 'build_opener') as opener:
            opener.return_value.open.return_value = Response({'outcome':'settled','confidence':.95,'value':{'relation':'related'}})
            self.assertEqual(judge.ask('J15', {'title':'Trial'}), {'relation':'related'})
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(json.loads(request.data), {'site':'J15','input':{'title':'Trial'}})
            for result in [{'outcome':'escalated','confidence':1}, {'outcome':'settled','confidence':.8}, {'outcome':'settled','confidence':True}]:
                opener.return_value.open.return_value = Response(result)
                self.assertIsNone(judge.ask('J15', {}))
            opener.return_value.open.side_effect = TimeoutError()
            self.assertIsNone(judge.ask('J15', {}))

    def test_sample_runs_original_callback_without_blocking_delivery(self):
        entered, release, reported = threading.Event(), threading.Event(), threading.Event()
        calls = []
        def baseline():
            entered.set()
            release.wait(2)
            return {"selectedIds": ["gwas-a"]}
        def request(site, payload):
            calls.append((site, payload))
            if site == "comparison":
                reported.set()
                return {"outcome": "settled"}
            return {"outcome": "settled", "confidence": 1, "value": {"candidates": []}, "comparisonReceipt": "a" * 32}
        with patch.object(judge, "_request", side_effect=request):
            self.assertEqual(judge.ask("J9", {"trait": "T"}, baseline=baseline), {"candidates": []})
            self.assertTrue(entered.wait(1))
            self.assertFalse(reported.is_set())
            release.set()
            self.assertTrue(reported.wait(1))
        self.assertEqual(calls[1], ("comparison", {"receipt": "a" * 32, "value": {"selectedIds": ["gwas-a"]}}))

    def test_async_original_callback_and_failure_report(self):
        for fail in [False, True]:
            reported = threading.Event()
            calls = []
            async def baseline():
                await asyncio.sleep(0)
                if fail:
                    raise RuntimeError("private manuscript must never be reported")
                return {"items": [{"id": "a", "decision": "pass"}]}
            def request(site, payload):
                calls.append(payload)
                reported.set()
            with patch.object(judge, "_request", side_effect=request):
                judge._schedule_comparison("a" * 32, baseline)
                self.assertTrue(reported.wait(1))
            self.assertNotIn("private", json.dumps(calls))
            self.assertEqual(calls[0].get("failed", False), fail)

    def test_async_client_keeps_baseline_on_owning_event_loop(self):
        reported = threading.Event()
        async def scenario():
            owning = asyncio.get_running_loop()
            async def baseline():
                self.assertIs(asyncio.get_running_loop(), owning)
                return {"items": [{"id": "a", "decision": "pass"}]}
            def request(site, payload):
                if site == "comparison":
                    reported.set()
                    return {"outcome": "settled"}
                return {"outcome": "settled", "confidence": 1, "value": {"items": []}, "comparisonReceipt": "a" * 32}
            with patch.object(judge, "_request", side_effect=request):
                result = await judge.ask_async("J8", {}, baseline=baseline)
                self.assertEqual(result, {"items": []})
                self.assertTrue(await asyncio.to_thread(reported.wait, 1))
        asyncio.run(scenario())

    def test_greetings_are_whole_messages(self):
        import re
        for path, variable in [('meta/start.py','_GREETING_PATTERNS'),('孟德尔随机化/start.py','_GREETING_PATTERNS_MR'),('科研选题/app/main.py','_GREETING_PATTERNS')]:
            tree = ast.parse((ROOT/path).read_text())
            assignment = next(node for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == variable for target in node.targets))
            pattern = re.compile(ast.literal_eval(assignment.value.args[0]), re.I)
            for text in ['HIV mortality', 'Hip fracture', '帮助糖尿病患者分析', '你好请帮我分析']:
                self.assertIsNone(pattern.match(text), (path,text))
            for text in ['你好！', 'Hello', 'help?', '您好  ']:
                self.assertIsNotNone(pattern.match(text), (path,text))

if __name__ == '__main__':
    unittest.main()
