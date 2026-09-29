import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("tooluniverse_bridge", ROOT / "tooluniverse_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ToolUniverseBridgeTests(unittest.TestCase):
    def test_init_and_notifications_do_not_expose_credentials(self):
        reply = bridge.handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        self.assertEqual(reply["result"]["serverInfo"]["name"], "tooluniverse")
        self.assertIsNone(bridge.handle_request({"jsonrpc": "2.0", "method": "notifications/initialized"}))

    def test_only_declared_tool_rpcs_go_to_authenticated_bridge(self):
        with patch.object(bridge, "call_gateway", return_value={"tools": []}) as call:
            reply = bridge.handle_request({"jsonrpc": "2.0", "id": "rpc-a", "method": "tools/list"})
            self.assertEqual(reply["id"], "rpc-a")
            self.assertEqual(reply["result"], {"tools": []})
            call.assert_called_once_with({"method": "tools/list"})
            refused = bridge.handle_request({"jsonrpc": "2.0", "id": 2, "method": "resources/read", "params": {"uri": "file:///etc/passwd"}})
            self.assertEqual(refused["error"]["code"], -32601)
            self.assertEqual(call.call_count, 1)

    def test_gateway_failure_does_not_look_like_empty_success_or_echo_request(self):
        with patch.object(bridge, "call_gateway", side_effect=ValueError("private-token")):
            reply = bridge.process_frame(json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}).encode(), bridge.handle_request)
            self.assertEqual(reply["error"]["code"], -32603)
            self.assertNotIn("private-token", json.dumps(reply))


    def test_unavailable_optional_source_is_a_named_tool_error_not_empty_research(self):
        with patch.object(bridge, "call_gateway", side_effect=bridge.GatewayUnavailable("tooluniverse_upstream_unavailable")):
            called = bridge.handle_request({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "list_tools"}})
            self.assertTrue(called["result"]["isError"])
            self.assertEqual(called["result"]["structuredContent"]["errorCode"], "tooluniverse_upstream_unavailable")
            listed = bridge.handle_request({"jsonrpc": "2.0", "id": 5, "method": "tools/list"})
            self.assertIn("error", listed)
            self.assertNotIn("result", listed)


if __name__ == "__main__":
    unittest.main()
