"""The runtime's side of the hand-off to source intake, against a stub of the gateway."""

import http.server
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import source_intake  # noqa: E402

FILES = [".evimed-sources/PMC1/supplements/" + "a" * 64 + "/Table_S1.csv"]


class IntakeTests(unittest.TestCase):
    def serve(self, status=200, body=None, delay=0.0):
        seen = []

        class Gateway(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - the stdlib's name
                seen.append((json.loads(self.rfile.read(int(self.headers["content-length"]))), self.headers.get("authorization")))
                payload = json.dumps(body if body is not None else {"results": [{"path": FILES[0], "registered": True, "sourceId": "src_1"}]}).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                return

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        token = pathlib.Path(directory.name) / "gateway.token"
        token.write_text("runtime-token\n")
        os.chmod(token, 0o600)
        environment = mock.patch.dict(os.environ, {
            "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": "http://127.0.0.1:%d/internal/sources/v1/fetch" % server.server_address[1],
            "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token),
        })
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("EVIMED_MODEL_CONFIG_FILE", None)
        return seen

    def test_only_a_group_and_preserved_paths_cross_with_the_runtime_token(self):
        seen = self.serve()
        answer = source_intake.hand_off("PMC1", FILES + FILES)
        self.assertEqual(seen, [({"sourceIntake": {"group": "PMC1", "files": FILES}}, "Bearer runtime-token")])
        self.assertEqual((answer["available"], answer["registered"], answer["refused"]), (True, 1, 0))

    def test_a_refused_file_is_its_own_answer(self):
        self.serve(body={"results": [{"path": FILES[0], "registered": False, "reason": "source_format_unsupported"}]})
        answer = source_intake.hand_off("PMC1", FILES)
        self.assertEqual((answer["registered"], answer["refused"], answer["results"][0]["reason"]), (0, 1, "source_format_unsupported"))

    def test_no_files_asks_nothing(self):
        seen = self.serve()
        self.assertEqual(source_intake.hand_off("PMC1", []), {"available": True, "registered": 0, "refused": 0, "results": []})
        self.assertEqual(seen, [])

    def test_a_gateway_that_refuses_or_is_not_composed_is_reported_and_never_raises(self):
        self.serve(status=503, body={"error": {"code": "public_source_gateway_unavailable", "message": "Source intake is not available in this deployment."}})
        answer = source_intake.hand_off("PMC1", FILES)
        self.assertFalse(answer["available"])
        self.assertIn("stay preserved in the workspace", answer["how"])

    def test_a_runtime_without_a_gateway_says_how_to_add_the_files_instead(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("EVIMED_PUBLIC_SOURCE_GATEWAY_URL", None)
            answer = source_intake.hand_off("PMC1", FILES)
        self.assertEqual((answer["available"], answer["reason"]), (False, "no_gateway"))
        self.assertIn("uploading", answer["how"])


if __name__ == "__main__":
    unittest.main()
