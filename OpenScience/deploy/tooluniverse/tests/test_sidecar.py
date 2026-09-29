import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

FILE = Path(__file__).resolve().parents[1] / "sidecar.py"
spec = importlib.util.spec_from_file_location("sidecar", FILE)
sidecar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidecar)


class SidecarTests(unittest.TestCase):
    def test_credential_is_bounded_regular_and_never_accepts_newlines(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "token"
            file.write_text("x" * 64)
            self.assertEqual(sidecar.read_token(file), "x" * 64)
            file.write_text("x" * 64 + "\nspoof")
            with self.assertRaises(ValueError):
                sidecar.read_token(file)
            file.unlink()
            file.symlink_to(FILE)
            with self.assertRaises(OSError):
                sidecar.read_token(file)

    def test_protocol_parser_requires_matching_json_rpc_reply(self):
        reply = {"jsonrpc": "2.0", "id": 1, "result": {"tools": []}}
        self.assertEqual(sidecar.parse_reply(json.dumps(reply).encode(), 1), reply["result"])
        body = f'event: message\ndata: {json.dumps(reply)}\n\n'.encode()
        self.assertEqual(sidecar.parse_reply(body, 1), reply["result"])
        with self.assertRaises(ValueError):
            sidecar.parse_reply(body, 2)
        with self.assertRaises(ValueError):
            sidecar.parse_reply(b'{"jsonrpc":"2.0","id":1,"error":{"code":-1}}', 1)

    def test_readiness_checks_protocol_and_actual_restricted_catalogue(self):
        replies = [({"protocolVersion": "2024-11-05"}, "session"), (None, None),
                   ({"tools": [{"name": name} for name in sidecar.MCP_TOOLS]}, None),
                   ({"content": [{"type": "text", "text": json.dumps(sidecar.CATALOGUE)}]}, None)]
        with patch.object(sidecar, "request", side_effect=replies) as send:
            self.assertEqual(sidecar.check("test-token", full=True), {"ready": True, "tools": 4, "catalogue": 187})
            self.assertEqual(send.call_count, 4)
        wrong = [*replies[:3], ({"content": [{"type": "text", "text": json.dumps({**sidecar.CATALOGUE, "total_tools": 2602})}]}, None)]
        with patch.object(sidecar, "request", side_effect=wrong), self.assertRaises(ValueError):
            sidecar.check("test-token", full=True)


if __name__ == "__main__":
    unittest.main()
