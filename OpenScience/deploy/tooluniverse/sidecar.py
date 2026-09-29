#!/usr/bin/env python3
"""Start the pinned restricted sidecar or check its authenticated MCP protocol."""
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import sys
import urllib.request

MCP_TOOLS = {"list_tools", "grep_tools", "get_tool_info", "execute_tool"}
CATALOGUE = {"total_categories": 5, "total_tools": 184,
             "categories": {"pubmed": 5, "EuropePMC": 3, "clinical_trials": 16, "fda_drug_label": 156, "compact_mode": 4}}
MAX_REPLY_BYTES = 2 * 1024 * 1024
KEYLESS_PROVIDER_ENV = ("NCBI_API_KEY", "FDA_API_KEY", "OPENFDA_API_KEY")


def remove_provider_credentials():
    # The selected APIs support public access. Their upstream clients can echo
    # query-string keys in response URLs, so this sidecar deliberately has none.
    for name in KEYLESS_PROVIDER_ENV:
        os.environ.pop(name, None)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def read_token(file):
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 257:
            raise ValueError("Credential must be a regular file")
        token = handle.read(257).decode("ascii").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
        raise ValueError("Invalid service credential")
    return token


def parse_reply(raw, request_id):
    if raw.lstrip().startswith(b"{"):
        candidates = [json.loads(raw)]
    else:
        candidates = [json.loads(line[5:].strip()) for line in raw.decode().splitlines() if line.startswith("data:")]
    for message in candidates:
        if message.get("jsonrpc") == "2.0" and message.get("id") == request_id:
            if "error" in message or "result" not in message:
                raise ValueError("MCP returned an error")
            return message["result"]
    raise ValueError("MCP did not return the requested response")


def request(body, headers, method="POST"):
    outgoing = urllib.request.Request("http://127.0.0.1:8080/mcp", data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
    with urllib.request.build_opener(NoRedirect()).open(outgoing, timeout=3) as response:
        raw = response.read(MAX_REPLY_BYTES + 1)
        session = response.headers.get("Mcp-Session-Id")
    if len(raw) > MAX_REPLY_BYTES:
        raise ValueError("MCP response too large")
    return (parse_reply(raw, body["id"]) if body is not None and "id" in body else None), session


def check(token, full=False):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    initialized, session = request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "evimed-readiness", "version": "1"}}}, headers)
    if not initialized.get("protocolVersion"):
        raise ValueError("MCP initialization failed")
    if session:
        headers["Mcp-Session-Id"] = session
    headers["MCP-Protocol-Version"] = initialized["protocolVersion"]
    try:
        request({"jsonrpc": "2.0", "method": "notifications/initialized"}, headers)
        listed, _ = request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers)
        if {tool["name"] for tool in listed.get("tools", [])} != MCP_TOOLS:
            raise ValueError("Unexpected MCP tools")
        result = {"ready": True, "tools": len(MCP_TOOLS)}
        if full:
            called, _ = request({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
                "name": "list_tools", "arguments": {"mode": "categories"}}}, headers)
            text = "".join(item["text"] for item in called.get("content", []) if item.get("type") == "text")
            if called.get("isError") or json.loads(text) != CATALOGUE:
                raise ValueError("The restricted catalogue did not load")
            result["catalogue"] = CATALOGUE["total_tools"]
        return result
    finally:
        if session:
            try:
                request(None, headers, method="DELETE")
            except Exception:
                pass  # Session cleanup is best effort; the probe's verdict stands.


def main():
    token = read_token(os.environ.get("TOOLUNIVERSE_API_TOKEN_FILE", "/run/secrets/tooluniverse-api-token"))
    if sys.argv[1:] in (["check"], ["check", "--full"]):
        signal.alarm(9)
        print(json.dumps(check(token, full="--full" in sys.argv)))
        return
    if sys.argv[1:] != ["serve"]:
        raise ValueError("Expected serve or check [--full]")
    workspace = Path("/home/tooluniverse/.tooluniverse")
    workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
    profile = workspace / "profile.yaml"
    shutil.copyfile(Path(__file__).with_name("profile.yaml"), profile)
    remove_provider_credentials()
    os.environ.update(TOOLUNIVERSE_API_TOKEN=token, TOOLUNIVERSE_HOME=str(workspace),
                      TOOLUNIVERSE_LAZY_LOADING="true", TOOLUNIVERSE_CACHE_PERSIST="false")
    os.execvp("tooluniverse-smcp", ["tooluniverse-smcp", "--transport", "http", "--host", "0.0.0.0", "--port", "8080",
              "--compact-mode", "--no-search", "--max-workers", "1", "--exclude-categories", "tool_finder", "--load", str(profile)])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # A readiness failure must not print a credential-bearing request.
        print(f"ToolUniverse startup/readiness failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
