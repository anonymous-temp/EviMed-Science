# runtime/mcp

The platform's MCP (Model Context Protocol) servers.

| Server | Used by | What it is |
| --- | --- | --- |
| `evimed-research/` | every hosted runtime | The research server: 41 tools, exactly `MCP_TOOL_BASE_NAMES` in `packages/domain/src/toolNames.mjs` — retrieval, full text and web pages, pharmacy data, deterministic compilers, the specialist engines as managed jobs, the first-party science connectors (`science_connectors.py`), local tools, the knowledge base and the frontier feed. |
| `evimed-memory/` | external agents | Two tools (recall, note) over the control plane's `/api/agent-memory/v1`. Not in the runtime image. |

In a hosted runtime the kernel mounts one MCP server. The profile patch
(`apps/server/src/dshProfilePatch.mjs`) inserts the row `mcp-evimed`:
`@deepseek-ai/dsh-mcp-client` over `stdio`, `serverName: evimed`, running
`python3 /opt/evimed/mcp/evimed-research/server.py`, with
`failOnStartupError: true`. The model sees each tool as `mcp__evimed__<name>`.
A deployment can switch single tools off with `EVIMED_DISABLED_TOOLS`.

The process holds the workload token and nothing else. Public sources are
reached through the control plane's gateways, so the runtime container keeps
its internal-only network, and upstream credentials (Materials Project's key
among them) stay in the web container (`apps/server/src/publicSourceGateway.mjs`).

The one optional second server is the ToolUniverse sidecar: when the deployment
sets `OPEN_SCIENCE_TOOLUNIVERSE_MCP_URL`, the patch adds `mcp-tooluniverse`
over `streamable-http` with `failOnStartupError: false`.

Tests: `pnpm test:mcp`.
