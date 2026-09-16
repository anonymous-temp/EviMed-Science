# Research memory for other agents

An account's research memory — its notes, facts, preferences and earlier
conclusions — can be read and added to by an agent running somewhere else: a
local DSH or Claude profile, a script, another product. Two ways in, one set of
rules: an HTTP API, and an MCP adapter that speaks that API for agents that only
speak MCP. Neither holds memory of its own; both reach the same PostgreSQL
records the workbench's memory page shows.

This page is the operator's and the integrator's reference. There is no
management page for keys yet; everything below is an HTTP call.

## Turning it on

Off by default: it publishes an account's memory to whoever holds one of its
keys, and that is a deployment's decision.

```bash
# deploy/web/.env
OPEN_SCIENCE_AGENT_MEMORY_API_ENABLED=true
```

Recreate `open-science-web` after changing it. While it is off every route under
`/api/agent-memory/v1` answers `503 agent_memory_disabled`, including the
OpenAPI description.

## Keys

Keys belong to an account and are managed with that account's browser session
(cookie and `X-Open-Science-CSRF` header), at `/api/agent-keys`:

| Call | What it does |
|---|---|
| `GET /api/agent-keys` | The account's keys (prefix, scopes, project, expiry, last use) and the scopes a key may carry. |
| `POST /api/agent-keys` `{ "name", "scopes", "projectId"?, "expiresInDays"? }` | Creates a key and returns its secret **once**; it is stored as a digest. |
| `DELETE /api/agent-keys/<id>` | Revokes it. |

- **Scopes:** `memory.read` (recall, list records) and `memory.write` (note,
  episodes). Give a key only what its agent needs.
- **Project binding:** a key created with `projectId` can read and write that
  project (and account-level memory) and nothing else; an unbound key may name
  any project of its own account.
- **Expiry:** `expiresInDays` from 1 to 730; omit it for a key that lasts until
  revoked.
- A key is never written to an audit line or a log.

## The API

Base path `/api/agent-memory/v1`, `Authorization: Bearer <key>`, 120 operations
per key per minute (`429 agent_memory_rate_limited` beyond that).

| Call | Scope | What it does |
|---|---|---|
| `GET /openapi.json` | none | The machine-readable description (no key needed, still behind the enable switch). |
| `GET /` | any | What this key can do: its scopes, its project, the rate limit, the endpoints. An integrator's first call. |
| `POST /recall` `{ "query", "projectId"?, "limit"? (1–50), "factKinds"?, "since"?, "scope"? }` | `memory.read` | Searches the account's memory and returns hits with their source. `scope` is `all`, `capsule`, `conversation` or `agenda`. |
| `POST /note` `{ "factKind", "content", "projectId"? }` | `memory.write` | Adds one note. It arrives as **inferred and pending** whatever the caller says, and takes effect only when the researcher confirms it or it is observed again independently. |
| `GET /records?scope=&kind=&status=&scopeId=&query=&pageSize=` | `memory.read` | Lists structured records, filtered (comma-separated values; `pageSize` up to 200, default 50). **Active records only** unless `status` asks for others: a pending record is a proposal nobody has agreed to. |
| `POST /episodes` `{ "projectId", "sessionId"?, "messages": [{ "role": "user"\|"assistant", "text" }] }` | `memory.write` | Hands over a conversation (1–200 turns) for the platform's own extractor to read. Every candidate must quote the conversation exactly; nothing is activated by this call (`activated` is always 0). |

What an agent can never do through either door: activate a memory, reach a
project its key is not bound to, or outrun the researcher's own switches. If
the account has paused learning (for everything, or for that project) an
episode extracts nothing; if it has paused recall, `recall` returns no research
memory records (capsule entries follow each capsule's own activation). Those
switches are on the memory page (「记忆开关」).

## The MCP adapter

`runtime/mcp/evimed-memory/server.py` is a stdio MCP server with two tools —
`memory_recall` and `memory_note` — over the API above. Listing records and
posting episodes stay HTTP calls: they are integration actions, and a tool per
verb is a catalogue the model pays for on every first turn.

It needs Python 3 and nothing else. Configure it with:

| Variable | Meaning |
|---|---|
| `EVIMED_MEMORY_API_URL` | The API base, e.g. `https://evimed.example.org/api/agent-memory/v1`. |
| `EVIMED_MEMORY_API_KEY_FILE` | A file holding the key (preferred: the key stays out of process listings and shared configs). |
| `EVIMED_MEMORY_API_KEY` | The key itself, for a local profile only. |
| `EVIMED_MEMORY_TIMEOUT_SECONDS` | Per-call timeout, 1–60, default 20. |

With no URL or no key the tools answer that the adapter is unconfigured rather
than making an unauthenticated call.

A local MCP client entry looks like this (the exact file depends on the client;
the shape is the common `command` / `args` / `env` form):

```json
{
  "mcpServers": {
    "evimed-memory": {
      "command": "python3",
      "args": ["/path/to/OpenScience/runtime/mcp/evimed-memory/server.py"],
      "env": {
        "EVIMED_MEMORY_API_URL": "https://evimed.example.org/api/agent-memory/v1",
        "EVIMED_MEMORY_API_KEY_FILE": "/path/to/evimed-memory.key"
      }
    }
  }
}
```

Keep the key file readable by you alone (`chmod 600`), and give the key
`memory.read` alone unless the agent should be able to leave notes.
