#!/usr/bin/env python3
"""Optional ToolUniverse stdio transport through the workload-authenticated control plane."""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from server import NO_REDIRECT_OPENER, PROTOCOL_VERSION, _read_workload_token, _rpc_error, main, process_frame

MAX_RESPONSE_BYTES = 4 * 1024 * 1024
GATEWAY_CODES = {"tooluniverse_upstream_unavailable", "tooluniverse_unavailable", "tooluniverse_busy",
                 "tooluniverse_rate_limited", "tooluniverse_request_invalid", "evimed_workload_token_invalid"}


class GatewayUnavailable(Exception):
    """A bounded, credential-free failure classification from the control plane."""
    def __init__(self, code):
        self.code = code if code in GATEWAY_CODES else "tooluniverse_upstream_unavailable"
        super().__init__(self.code)


def call_gateway(body):
    url = os.environ.get("EVIMED_TOOLUNIVERSE_GATEWAY_URL", "")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("ToolUniverse gateway is not configured")
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
        "Authorization": f"Bearer {_read_workload_token()}", "Content-Type": "application/json"})
    try:
        with NO_REDIRECT_OPENER.open(request, timeout=65) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read(4097))
            code = payload.get("code") if isinstance(payload, dict) else None
        except (ValueError, OSError):
            code = None
        finally:
            error.close()
        raise GatewayUnavailable(code) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise GatewayUnavailable("tooluniverse_upstream_unavailable") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("Scientific tool response is too large")
    payload = json.loads(raw)
    if not isinstance(payload, dict) or "result" not in payload:
        raise ValueError("Scientific tool response is unavailable")
    return payload["result"]


def handle_request(request):
    if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
        return _rpc_error(None, -32600, "Invalid Request")
    if "id" not in request:
        return None
    request_id, method = request["id"], request.get("method")
    if method == "initialize":
        result = {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {"listChanged": False}},
                  "serverInfo": {"name": "tooluniverse", "version": "1.0.0"}}
    elif method == "ping":
        result = {}
    elif method in {"tools/list", "tools/call"}:
        body = {"method": method}
        if "params" in request:
            body["params"] = request["params"]
        try:
            result = call_gateway(body)
        except GatewayUnavailable as error:
            if method == "tools/list":
                return _rpc_error(request_id, -32000, error.code)
            failed = {"status": "error", "errorCode": error.code,
                      "message": "The optional scientific source is unavailable; use other available sources."}
            result = {"isError": True, "structuredContent": failed,
                      "content": [{"type": "text", "text": json.dumps(failed)}]}
    else:
        return _rpc_error(request_id, -32601, "Method not found")
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


if __name__ == "__main__":
    raise SystemExit(main(handler=handle_request))
