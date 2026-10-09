"""`schedule_task` and `update_task`: a scheduled task made and changed from a conversation, through the control plane's gateway."""

import importlib.util
import json
import os
import pathlib
import re
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import task_tools  # noqa: E402

DOMAIN = ROOT.parents[2] / "packages" / "domain" / "src" / "taskTools.mjs"


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_task_tools", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def task_facts(**overrides):
    """One task as the gateway states it: facts, never an instruction to follow."""
    facts = {
        "taskId": "agenda-0123abcd-0000-4000-8000-000000000001", "title": "SGLT2 抑制剂新研究", "created": True,
        "schedule": {"kind": "weekly", "time": "09:00", "weekdays": [5], "timeZone": "Asia/Shanghai"},
        "scheduleText": "每周五 09:00", "timeZone": "Asia/Shanghai", "timeZoneName": "中国标准时间",
        "nextRunAt": "2026-10-09T01:00:00.000Z", "nextRunText": "10月9日 09:00", "state": "scheduled",
    }
    facts.update(overrides)
    return facts


class _Gateway(BaseHTTPRequestHandler):
    """The server's route, scripted: it records what the runtime sent and answers whatever the test put on the class."""

    answer = (200, {"data": {}})
    seen = []

    def do_POST(self):  # noqa: N802 - http.server naming
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        type(self).seen.append({"path": self.path, "authorization": self.headers.get("authorization"), "body": json.loads(body)})
        status, payload = type(self).answer
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args):
        return


class _GatewayCase(unittest.TestCase):
    """A scripted gateway, the runtime token, and the environment a runtime with the feature on is given."""

    def setUp(self):
        _Gateway.seen = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Gateway)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        token_file = pathlib.Path(directory.name) / "gateway-token"
        token_file.write_text("runtime-token-for-tests\n", encoding="utf-8")
        os.chmod(token_file, 0o600)
        base = "http://127.0.0.1:%d" % self.server.server_address[1]
        environment = {
            "EVIMED_TASKS_GATEWAY_URL": base + "/internal/tasks/v1",
            "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": base + "/internal/sources/v1/fetch",
            "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token_file),
            "EVIMED_DISABLED_TOOLS": "",
        }
        patcher = mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)


class TaskToolsTests(_GatewayCase):
    # --- the definitions ------------------------------------------------------------------------------------------------------

    def test_two_tools_one_responsibility_each_with_short_descriptions_and_bounded_schemas(self):
        schedule, update = task_tools.tool_definitions()
        self.assertEqual([schedule["name"], update["name"]], ["schedule_task", "update_task"])
        for definition in (schedule, update):
            self.assertLess(len(definition["description"]), 900, "the description rides every request; details belong in the answer")
            self.assertFalse(definition["inputSchema"]["additionalProperties"])
        self.assertEqual(schedule["inputSchema"]["required"], ["instruction", "schedule"])
        self.assertEqual(update["inputSchema"]["required"], ["taskId"])
        # Neither tool can be told whose task it is, or what it may cost.
        for definition in (schedule, update):
            self.assertFalse({"projectId", "userId", "budget", "maxEpisodeCny"} & set(definition["inputSchema"]["properties"]))
        # The schedule states each field's unit and range where the model reads it.
        properties = schedule["inputSchema"]["properties"]["schedule"]["properties"]
        self.assertEqual(properties["kind"]["enum"], ["once", "daily", "weekly"])
        self.assertEqual(properties["weekdays"]["items"], {"type": "integer", "minimum": 1, "maximum": 7})
        self.assertIn("Monday", properties["weekdays"]["description"])
        self.assertIn("HH:MM", properties["time"]["description"])
        self.assertIn("Asia/Shanghai", properties["timeZone"]["description"])
        # An update's schedule is partial: nothing in it is required.
        self.assertNotIn("required", update["inputSchema"]["properties"]["schedule"])
        self.assertIn("paused", update["inputSchema"]["properties"])

    def test_the_limits_are_the_domains(self):
        source = DOMAIN.read_text(encoding="utf-8")
        instruction = int(re.search(r"TASK_INSTRUCTION_MAX_CHARS = ([\d_]+)", source).group(1).replace("_", ""))
        title = int(re.search(r"TASK_TITLE_MAX_CHARS = ([\d_]+)", source).group(1).replace("_", ""))
        self.assertEqual((task_tools.MAX_INSTRUCTION, task_tools.MAX_TITLE), (instruction, title))
        schedule, _update = task_tools.tool_definitions()
        self.assertEqual(schedule["inputSchema"]["properties"]["instruction"]["maxLength"], instruction)
        # The codes a call can be refused with are the domain's, and the ones the run fixes are the domain's run fixes.
        run_fixes = re.search(r"TASK_TOOL_RUN_FIXES = Object\.freeze\(\[(.*?)\]\)", source, re.S).group(1)
        self.assertEqual(set(re.findall(r"'(task_[a-z_]+)'", run_fixes)), set(task_tools.RUN_FIXES))

    # --- making a task --------------------------------------------------------------------------------------------------------

    def test_a_task_goes_to_the_servers_route_with_the_runtime_token_and_what_was_said_and_nothing_else(self):
        _Gateway.answer = (200, {"data": task_facts()})
        result = task_tools.call("schedule_task", {
            "instruction": "每周五帮我看看 SGLT2 抑制剂的新研究", "title": "SGLT2 抑制剂新研究",
            "schedule": {"kind": "weekly", "weekdays": [5], "time": "09:00"},
        })
        [request] = _Gateway.seen
        self.assertEqual(request["path"], "/internal/tasks/v1/schedule")
        self.assertEqual(request["authorization"], "Bearer runtime-token-for-tests")
        self.assertEqual(request["body"], {
            "instruction": "每周五帮我看看 SGLT2 抑制剂的新研究", "title": "SGLT2 抑制剂新研究",
            "schedule": {"kind": "weekly", "weekdays": [5], "time": "09:00"},
        })
        self.assertEqual(result["status"], "success")
        self.assertIn("每周五 09:00（中国标准时间）", result["summary"])
        self.assertIn("next run 10月9日 09:00", result["summary"])
        self.assertEqual(result["data"]["taskId"], "agenda-0123abcd-0000-4000-8000-000000000001")
        self.assertNotIn("provenance", result["data"])
        self.assertEqual(result["warnings"], [])
        self.assertTrue(any("task card" in action for action in result["next_actions"]))

    def test_a_task_that_already_existed_is_said_not_made_twice(self):
        _Gateway.answer = (200, {"data": task_facts(created=False)})
        result = task_tools.call("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "07:00"}})
        self.assertIn("already exists, so nothing was created", result["summary"])

    def test_a_task_the_schedule_has_no_run_left_for_is_a_warning_and_never_hidden(self):
        _Gateway.answer = (200, {"data": task_facts(state="completed", nextRunAt=None, nextRunText=None)})
        result = task_tools.call("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "07:00"}})
        self.assertEqual(result["status"], "success")
        self.assertIn("no run left", result["summary"])
        self.assertTrue(result["warnings"])

    # --- changing one ---------------------------------------------------------------------------------------------------------

    def test_a_change_names_the_task_and_only_what_changes(self):
        _Gateway.answer = (200, {"data": task_facts(created=None, changed=["schedule"], scheduleText="每周一 08:00", nextRunText="10月12日 08:00")})
        result = task_tools.call("update_task", {
            "taskId": "agenda-0123abcd-0000-4000-8000-000000000001", "schedule": {"weekdays": [1], "time": "08:00"},
        })
        [request] = _Gateway.seen
        self.assertEqual(request["path"], "/internal/tasks/v1/update")
        self.assertEqual(request["body"], {"taskId": "agenda-0123abcd-0000-4000-8000-000000000001", "schedule": {"weekdays": [1], "time": "08:00"}})
        self.assertIn("Updated “SGLT2 抑制剂新研究” (schedule)", result["summary"])
        self.assertIn("每周一 08:00", result["summary"])

    def test_pausing_and_re_enabling_are_the_papers_own_boolean(self):
        _Gateway.answer = (200, {"data": task_facts(changed=["paused"], state="paused", nextRunAt=None, nextRunText=None)})
        result = task_tools.call("update_task", {"taskId": "agenda-abc-1", "paused": True})
        self.assertEqual(_Gateway.seen[0]["body"], {"taskId": "agenda-abc-1", "paused": True})
        self.assertIn("paused", result["summary"])
        task_tools.call("update_task", {"taskId": "agenda-abc-1", "paused": False})
        self.assertEqual(_Gateway.seen[1]["body"], {"taskId": "agenda-abc-1", "paused": False})

    def test_an_execution_may_name_its_task_by_its_own_id(self):
        _Gateway.answer = (200, {"data": task_facts(changed=["schedule"])})
        task_tools.call("update_task", {"taskId": "episode-" + "a" * 32, "schedule": {"time": "08:00"}})
        self.assertEqual(_Gateway.seen[0]["body"]["taskId"], "episode-" + "a" * 32)

    def test_a_wrong_id_comes_back_with_the_projects_tasks_so_the_next_call_can_be_right(self):
        _Gateway.answer = (404, {"error": "No such task in this project.", "code": "task_not_found", "tasks": [
            {"taskId": "agenda-1", "title": "每周文献简报", "scheduleText": "每周一 08:00", "state": "scheduled", "ignored": "x"},
            "not a task",
        ]})
        with self.assertRaises(task_tools.TaskToolError) as raised:
            task_tools.call("update_task", {"taskId": "agenda-nope", "paused": True})
        error = raised.exception
        self.assertEqual(error.code, "task_not_found")
        self.assertEqual(error.stop_reason(), "invalid_input")
        self.assertEqual(error.tasks, [{"taskId": "agenda-1", "title": "每周文献简报", "scheduleText": "每周一 08:00", "state": "scheduled"}])
        self.assertIn("agenda-1 (每周文献简报, 每周一 08:00)", error.next_action())

    # --- refusals -------------------------------------------------------------------------------------------------------------

    def test_malformed_calls_are_refused_before_any_request(self):
        good = {"kind": "daily", "time": "07:00"}
        for name, arguments, code in (
            ("schedule_task", {"schedule": good}, "task_instruction_invalid"),
            ("schedule_task", {"instruction": "  ", "schedule": good}, "task_instruction_invalid"),
            ("schedule_task", {"instruction": "x" * 20_001, "schedule": good}, "task_instruction_invalid"),
            ("schedule_task", {"instruction": "x"}, "task_schedule_invalid"),
            ("schedule_task", {"instruction": "x", "schedule": {"kind": "monthly", "time": "07:00"}}, "task_schedule_invalid"),
            ("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "7:00"}}, "task_schedule_invalid"),
            ("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "24:00"}}, "task_schedule_invalid"),
            ("schedule_task", {"instruction": "x", "schedule": {"kind": "weekly", "time": "07:00", "weekdays": [0]}}, "task_schedule_invalid"),
            ("schedule_task", {"instruction": "x", "schedule": {"kind": "weekly", "time": "07:00", "weekdays": [True]}}, "task_schedule_invalid"),
            ("schedule_task", {"instruction": "x", "schedule": {"kind": "once", "time": "07:00", "date": "next friday"}}, "task_schedule_invalid"),
            ("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "07:00", "budget": 5}}, "task_schedule_invalid"),
            ("schedule_task", {"instruction": "x", "schedule": good, "title": ""}, "task_title_invalid"),
            ("schedule_task", {"instruction": "x", "schedule": good, "projectId": "other"}, "task_tools_request_invalid"),
            ("schedule_task", {"instruction": "x", "schedule": good, "maxEpisodeCny": 500}, "task_tools_request_invalid"),
            ("update_task", {"paused": True}, "task_id_invalid"),
            ("update_task", {"taskId": "../../etc", "paused": True}, "task_id_invalid"),
            ("update_task", {"taskId": "project-1", "paused": True}, "task_id_invalid"),
            ("update_task", {"taskId": "agenda-1", "paused": "yes"}, "task_paused_invalid"),
            ("update_task", {"taskId": "agenda-1", "schedule": {"kind": "sometimes"}}, "task_schedule_invalid"),
            ("update_task", {"taskId": "agenda-1", "instruction": ""}, "task_instruction_invalid"),
        ):
            with self.assertRaises(task_tools.TaskToolError, msg=repr(arguments)) as raised:
                task_tools.call(name, arguments)
            self.assertEqual(raised.exception.code, code, repr(arguments))
            self.assertEqual(raised.exception.stop_reason(), "invalid_input")
        self.assertEqual(_Gateway.seen, [])

    def test_a_partial_schedule_is_fine_for_a_change_and_never_for_a_new_task(self):
        _Gateway.answer = (200, {"data": task_facts(changed=["schedule"])})
        task_tools.call("update_task", {"taskId": "agenda-1", "schedule": {"time": "08:00"}})
        with self.assertRaises(task_tools.TaskToolError):
            task_tools.call("schedule_task", {"instruction": "x", "schedule": {"time": "08:00"}})

    def test_switched_off_the_tools_answer_disabled_without_a_request(self):
        with mock.patch.dict(os.environ, {"EVIMED_TASKS_GATEWAY_URL": ""}):
            with self.assertRaises(task_tools.TaskToolError) as raised:
                task_tools.call("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "07:00"}})
        self.assertEqual(raised.exception.code, "task_tools_disabled")
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(_Gateway.seen, [])

    def test_a_scheduled_execution_is_told_it_may_not_make_tasks_and_is_not_told_to_retry(self):
        _Gateway.answer = (403, {"error": "A scheduled execution cannot make or change tasks.", "code": "task_tools_not_in_conversation"})
        with self.assertRaises(task_tools.TaskToolError) as raised:
            task_tools.call("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "07:00"}})
        self.assertEqual(raised.exception.code, "task_tools_not_in_conversation")
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(raised.exception.stop_reason(), "unsupported")

    def test_the_gateways_own_code_reaches_the_run_and_outages_are_retryable(self):
        for status, code, retryable in ((429, "task_tools_rate_limited", True), (503, "task_tools_unavailable", True),
                                        (503, "task_tools_disabled", False), (409, "task_limit_reached", False), (409, "task_revision_conflict", True),
                                        (400, "autopilot_episode_budget_too_small", False)):
            _Gateway.answer = (status, {"error": "no", "code": code})
            with self.assertRaises(task_tools.TaskToolError) as raised:
                task_tools.call("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "07:00"}})
            self.assertEqual((raised.exception.code, raised.exception.retryable), (code, retryable), code)
        # Words that are not the gateway's own never reach the run as a code.
        _Gateway.answer = (500, {"error": "boom", "code": "Traceback (most recent call last)"})
        with self.assertRaises(task_tools.TaskToolError) as raised:
            task_tools.call("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "07:00"}})
        self.assertEqual(raised.exception.code, "task_tools_upstream_error")

    def test_an_answer_that_names_no_task_is_not_taken_for_one(self):
        for answer in ({"data": {}}, {"data": []}, {"nothing": True}):
            _Gateway.answer = (200, answer)
            with self.assertRaises(task_tools.TaskToolError) as raised:
                task_tools.call("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "07:00"}})
            self.assertEqual(raised.exception.code, "task_tools_response_invalid")

    def test_without_the_runtime_token_the_tool_says_unconfigured(self):
        with mock.patch.dict(os.environ, {"EVIMED_MODEL_GATEWAY_TOKEN_FILE": "", "EVIMED_MODEL_CONFIG_FILE": ""}):
            with self.assertRaises(task_tools.TaskToolError) as raised:
                task_tools.call("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "07:00"}})
        self.assertEqual(raised.exception.code, "task_tools_unconfigured")


class TaskToolsThroughTheServerTests(_GatewayCase):
    """What a run actually receives: the tool as `call_tool` dispatches it, and as `list_tools` offers it."""

    def setUp(self):
        super().setUp()
        self.mcp = load_server()

    def test_the_tools_are_offered_and_optional_so_a_deployment_without_them_can_leave_them_out(self):
        names = [tool["name"] for tool in self.mcp.list_tools()]
        self.assertIn("schedule_task", names)
        self.assertIn("update_task", names)
        self.assertTrue({"schedule_task", "update_task"} <= set(self.mcp.OPTIONAL_TOOLS))
        with mock.patch.dict(os.environ, {"EVIMED_DISABLED_TOOLS": "schedule_task,update_task"}):
            names = [tool["name"] for tool in self.mcp.list_tools()]
        self.assertNotIn("schedule_task", names)
        self.assertNotIn("update_task", names)

    def test_a_task_reaches_the_run_as_the_tools_own_envelope_with_no_provenance_echoing_the_account(self):
        _Gateway.answer = (200, {"data": task_facts()})
        result = self.mcp.call_tool("schedule_task", {"instruction": "每周五帮我看看 SGLT2 抑制剂的新研究",
                                                       "schedule": {"kind": "weekly", "weekdays": [5], "time": "09:00"}})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["scheduleText"], "每周五 09:00")
        self.assertNotIn("provenance", result["data"])
        self.assertNotIn("userId", json.dumps(result))
        self.assertEqual(_Gateway.seen[0]["body"], {"instruction": "每周五帮我看看 SGLT2 抑制剂的新研究", "schedule": {"kind": "weekly", "weekdays": [5], "time": "09:00"}})

    def test_a_refusal_reaches_the_run_as_a_failure_with_its_stop_reason_and_the_next_step(self):
        _Gateway.answer = (404, {"error": "No such task in this project.", "code": "task_not_found",
                                 "tasks": [{"taskId": "agenda-1", "title": "每周文献简报", "scheduleText": "每周一 08:00", "state": "scheduled"}]})
        result = self.mcp.call_tool("update_task", {"taskId": "agenda-nope", "paused": True})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "task_not_found")
        self.assertEqual(result["error"]["stopReason"], "invalid_input")
        self.assertIn("agenda-1", " ".join(result["next_actions"]))
        # The server's own schema check answers first for what the schema states (a kind outside the enum); either way nothing is sent.
        malformed = self.mcp.call_tool("schedule_task", {"instruction": "x", "schedule": {"kind": "monthly", "time": "07:00"}})
        self.assertEqual(malformed["status"], "error")
        self.assertIn("schema", malformed["error"]["stopReason"])
        self.assertEqual(len(_Gateway.seen), 1, "a malformed call is refused before any request")

    def test_switched_off_a_call_that_still_arrives_says_so_and_is_not_retried(self):
        with mock.patch.dict(os.environ, {"EVIMED_TASKS_GATEWAY_URL": ""}):
            result = self.mcp.call_tool("schedule_task", {"instruction": "x", "schedule": {"kind": "daily", "time": "07:00"}})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "task_tools_disabled")
        self.assertFalse(result["error"]["retryable"])
        self.assertEqual(result["error"]["stopReason"], "unsupported")


if __name__ == "__main__":
    unittest.main()
