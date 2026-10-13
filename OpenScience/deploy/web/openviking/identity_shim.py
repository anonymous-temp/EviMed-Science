"""identity_shim.py — the pass-through that lets OpenViking v0.5.0's built-in
VikingBot run Compile tasks while the server is in ``trusted`` auth mode.

Written with the standard library only so it can run *inside* the OpenViking
container beside the server — the image ships Python and nothing else we could
run. That placement is the reason for its shape: the bot's gateway stays bound
to 127.0.0.1, no token and no port are published, and there is no second
container whose network namespace would go stale when the first one restarts.
It is started by ``entrypoint.sh`` and mounted read-only from the release
directory (``deploy/web/docker-compose.yml``, service ``evimed-openviking``).

Why it exists: in trusted mode the server forwards only ``X-API-Key`` (the root
key) to its Compile runtime, and the bot refuses a trusted request that does not
also name the account and the user (401, "Trusted OpenViking chat requires
X-OpenViking-Account and X-OpenViking-User"). Upstream fixed the forwarding on
``main`` (PR #5750); no released tag has it. Delete this file, the entrypoint
wrapper that starts it, ``compile_api.base_url`` in the rendered ``ov.conf`` and
the ``compileShim`` fact of the control plane's engine check on the first pin
that forwards identity itself.

  POST /runtime/v1/tasks         the user is read from the canonical target URI
                                 OpenViking already authorized
                                 (``viking://user/<id>/…``); the two identity
                                 headers are added; the session id in the answer
                                 is returned as ``<id>~<session>``.
  POST /runtime/v1/tasks/status  the prefix is taken off again and becomes the
  POST /runtime/v1/tasks/cancel  identity headers of the forwarded call.

No table is kept, so a restart loses nothing.

Environment: SHIM_LISTEN_HOST (127.0.0.1), SHIM_LISTEN_PORT (18791),
SHIM_UPSTREAM (http://127.0.0.1:18790), SHIM_ACCOUNT (evimed),
SHIM_UPSTREAM_TIMEOUT_SECONDS (9; OpenViking gives up at 10),
SHIM_CAPTURE_FILE (optional JSONL of every exchange, credentials replaced).
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN_HOST = os.environ.get("SHIM_LISTEN_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("SHIM_LISTEN_PORT", "18791"))
UPSTREAM = os.environ.get("SHIM_UPSTREAM", "http://127.0.0.1:18790").rstrip("/")
ACCOUNT = os.environ.get("SHIM_ACCOUNT", "evimed")
UPSTREAM_TIMEOUT = float(os.environ.get("SHIM_UPSTREAM_TIMEOUT_SECONDS", "9"))
CAPTURE_FILE = os.environ.get("SHIM_CAPTURE_FILE", "")

# OpenViking's own identifier rule (openviking/core/identifiers.py): its
# alphabet, never "." or "..", at most one "@". "~" is outside the alphabet, so
# the first "~" of a wrapped session id is always the separator.
USER_TARGET = re.compile(r"^viking://user/([A-Za-z0-9_.@-]+)/")
USER_ID = re.compile(r"^[A-Za-z0-9_.@-]+$")


def is_user_id(value):
    return bool(USER_ID.match(value)) and value not in {".", ".."} and value.count("@") <= 1
SEPARATOR = "~"
CREATE = "/runtime/v1/tasks"
ROUTES = {CREATE, "/runtime/v1/tasks/status", "/runtime/v1/tasks/cancel"}
SECRET_HEADERS = {"x-api-key", "authorization", "x-gateway-token"}
HOP_HEADERS = {"host", "content-length", "connection", "accept-encoding"}
MAX_BODY_BYTES = 1024 * 1024


def identity_for_create(body):
    payload = body.get("payload") if isinstance(body, dict) else None
    target = payload.get("to") if isinstance(payload, dict) else None
    match = USER_TARGET.match(target) if isinstance(target, str) else None
    return (match.group(1), body) if match and is_user_id(match.group(1)) else None


def identity_for_session(body):
    wrapped = body.get("session_id") if isinstance(body, dict) else None
    if not isinstance(wrapped, str):
        return None
    user, separator, session = wrapped.partition(SEPARATOR)
    if not separator or not session or not is_user_id(user):
        return None
    return user, {**body, "session_id": session}


def wrap_session_id(user, session_id):
    return f"{user}{SEPARATOR}{session_id}"


def _capture(entry):
    if not CAPTURE_FILE:
        return
    try:
        with open(CAPTURE_FILE, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass  # a capture that cannot be written must not fail a compile


def _printable(headers):
    return {name: ("[redacted]" if name.lower() in SECRET_HEADERS else value) for name, value in headers.items()}


class Shim(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):  # one line per exchange is the capture's job
        return

    def _answer(self, status, payload, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _refuse(self, status, code, message):
        # The shape OpenViking's CompileAPIClient reads: detail.code / detail.message.
        self._answer(status, json.dumps({"detail": {"code": code, "message": message}}).encode("utf-8"))

    def do_POST(self):  # noqa: N802 - http.server's name
        path = self.path.split("?", 1)[0]
        # The body is read before anything is refused: on a kept-alive connection
        # an unread body would be parsed as the next request.
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY_BYTES:
            self.close_connection = True
            self._refuse(400, "INVALID_ARGUMENT", "identity shim: request body is missing or too large")
            return
        raw_body = self.rfile.read(length)
        if path not in ROUTES:
            self._refuse(404, "NOT_FOUND", "identity shim serves the three Compile runtime routes only")
            return
        try:
            body = json.loads(raw_body.decode("utf-8"))
        except ValueError:
            self._refuse(400, "INVALID_ARGUMENT", "identity shim: request body is not JSON")
            return
        creating = path == CREATE
        identity = identity_for_create(body) if creating else identity_for_session(body)
        if identity is None:
            self._refuse(
                400,
                "INVALID_ARGUMENT",
                "identity shim: the Compile target must be inside a user's own root (viking://user/<id>/…)"
                if creating
                else "identity shim: this session was not created through the shim",
            )
            return
        user, forwarded_body = identity
        incoming = {name: value for name, value in self.headers.items()}
        headers = {name: value for name, value in incoming.items() if name.lower() not in HOP_HEADERS}
        headers["X-OpenViking-Account"] = ACCOUNT
        headers["X-OpenViking-User"] = user
        request = urllib.request.Request(
            UPSTREAM + path, data=json.dumps(forwarded_body).encode("utf-8"), method="POST", headers=headers
        )
        try:
            with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT) as response:
                status, raw, content_type = response.status, response.read(), response.headers.get("Content-Type")
        except urllib.error.HTTPError as error:
            status, raw, content_type = error.code, error.read(), error.headers.get("Content-Type")
        except (urllib.error.URLError, OSError) as error:
            _capture({"at": _now(), "path": path, "request": {"headers": _printable(incoming), "body": body}, "error": str(error)})
            # 503 is what OpenViking retries (transient); the task is not lost.
            self._refuse(503, "UNAVAILABLE", "identity shim: the Compile runtime did not answer")
            return
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except ValueError:
            parsed = None
        out = raw
        if creating and 200 <= status < 300 and isinstance(parsed, dict) and isinstance(parsed.get("session_id"), str):
            out = json.dumps({**parsed, "session_id": wrap_session_id(user, parsed["session_id"])}).encode("utf-8")
        _capture(
            {
                "at": _now(),
                "path": path,
                "request": {"headers": _printable(incoming), "body": body},
                "forwarded": {"added": {"X-OpenViking-Account": ACCOUNT, "X-OpenViking-User": user}, "body": forwarded_body},
                "response": {"status": status, "body": parsed if parsed is not None else raw.decode("utf-8", "replace")[:2000]},
            }
        )
        self._answer(status, out, content_type or "application/json")


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def main():
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Shim)
    server.daemon_threads = True
    print(f"identity shim on {LISTEN_HOST}:{LISTEN_PORT} -> {UPSTREAM} (account {ACCOUNT})", file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
