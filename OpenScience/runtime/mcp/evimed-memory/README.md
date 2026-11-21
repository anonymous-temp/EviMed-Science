# EviMed memory for MCP

Install this directory or its wheel in the host's Python environment with
`python3 -m pip install /path/to/evimed-memory`. It has no runtime dependencies.
For a source checkout, use `python3 /path/to/evimed-memory/server.py` directly.
Register this stdio server with Claude Code, Codex or another MCP client.
For example, the server entry in a Claude Code MCP configuration is

```json
{"mcpServers":{"evimed-memory":{"command":"evimed-memory-mcp","env":{
  "EVIMED_MEMORY_API_URL":"https://your-deployment.example/api/agent-memory/v1",
  "EVIMED_MEMORY_API_KEY_FILE":"/absolute/path/to/private-key-file"
}}}}
```

Create a personal key in account settings, save the one-time value to that file,
and restrict its permissions to the host account. For an integration, set
`EVIMED_MEMORY_SUBJECT` to the host's opaque identifier for the authenticated
person. Use HTTPS or a loopback test service. Start with `memory_status`.
The `memory_` tools mirror the API including conversation admission, verified
work feedback, sharing and revision-based management. Use host-captured messages
with the original role and UTC timestamp. Each operation uses the account's
permissions and billed usage. See the deployment's `/static/agent-memory.html`.

To release, build with `python3 -m build`, install the wheel into a clean
environment, send an MCP initialize and tools/list over stdin, and verify the
wheel with `python3 -m twine check dist/*`. The owner uploads the tested build
with their registry account and uses the versioned command in their MCP catalogue.
