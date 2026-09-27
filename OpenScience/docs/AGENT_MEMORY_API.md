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
| `POST /api/agent-keys` `{ "name", "scopes", "projectId"?, "expiresInDays"?, "subjects"? }` | Creates a key and returns its secret **once**; it is stored as a digest. `subjects: true` makes it an integration key (below). |
| `DELETE /api/agent-keys/<id>` | Revokes it. |

- **Scopes:** `memory.read` (recall, list records, the dashboard), `memory.write` (note,
  episodes), `memory.manage` (the dashboard's acts) and `memory.observe`
  (prescription edits) — see below. Give a key
  only what its agent needs.
- **Project binding:** a key created with `projectId` can read and write that
  project (and account-level memory) and nothing else; an unbound key may name
  any project of its own account.
- **Expiry:** `expiresInDays` from 1 to 730; omit it for a key that lasts until
  revoked.
- A key is never written to an audit line or a log.

### Integration keys: one institution, many people

A key created with `"subjects": true` is an **integration key**: it is held by
an institution (for example the TCM CDSS behind a hospital's HIS) and a request
made with it may name the person it is for in an `X-Subject` header — an
opaque identifier of 1–128 letters, digits and `. _ : @ / + = -`, never a name.

- With `X-Subject`, every read and write of that request is that person's own
  memory and nobody else's: each subject is an account of its own, made the
  first time something is written for it. Reading a subject that has nothing
  yet answers as an empty memory and creates nothing. A subject's memory has
  one project, `default`; naming another is refused.
- Without `X-Subject`, the request is the key's own account — the institution
  level, which is where personalisation lives until the HIS sends a doctor id.
- Any other key naming a subject is refused (`agent_key_subject_unsupported`).
- An integration key cannot be bound to a project (`agent_key_subjects_unbound`).
- The HIS identifier itself is never stored, only a digest. Nobody can sign in
  as a subject; its memory is reached only through its institution's keys, and
  it is deleted when the institution's account is.

## The API

Base path `/api/agent-memory/v1`, `Authorization: Bearer <key>`, 120 operations
per key per minute (`429 agent_memory_rate_limited` beyond that).

| Call | Scope | What it does |
|---|---|---|
| `GET /openapi.json` | none | The machine-readable description (no key needed, still behind the enable switch). |
| `GET /` | any | What this key can do: its scopes, its project, the rate limit, the endpoints. An integrator's first call. |
| `POST /recall` `{ "query", "projectId"?, "limit"? (1–50), "factKinds"?, "since"?, "scope"?, "capsuleIds"? (1–8), "methods"? }` | `memory.read` | Searches the account's memory and returns hits with their source. `scope` is `all`, `capsule`, `conversation` or `agenda`. `capsuleIds` reads the named capsules instead of the ones in force (a subject may name its institution's). Also returns `methods` — the account's own learned methods first, then the capsules' work-style methods, within the same budget a run mounts (32 methods, 32 KiB); `methods` is `all`, `own`, `capsules` or `none`. |
| `POST /note` `{ "factKind", "content", "projectId"? }` | `memory.write` | Adds one note. It arrives as an **inferred, unconfirmed candidate** whatever the caller says, and takes effect only when the account owner confirms it. |
| `GET /records?scope=&kind=&status=&scopeId=&query=&pageSize=` | `memory.read` | Lists structured records, filtered (comma-separated values; `pageSize` up to 200, default 50). **Active records only** unless `status` asks for others: a pending record is a proposal nobody has agreed to. |
| `POST /episodes` `{ "projectId", "sessionId"?, "messages": [{ "role": "user"\|"assistant", "text" }] }` | `memory.write` | Hands over a conversation (1–200 turns) for the platform's own extractor to read. Every candidate must quote the conversation exactly, and **every record it writes is `pending`** until the account owner confirms it (`activated` is always 0). It may add evidence to a memory already in force; a candidate that would change or replace one is refused. |

### The dashboard

For an integrator that draws the person's own memory page — the TCM CDSS's
「记忆胶囊看板」 — one read and the acts a person takes on it. The acts need a key
carrying **`memory.manage`**, which a key should hold only when its requests
come from that person's own clicks; it is never a default.

| Call | Scope | What it does |
|---|---|---|
| `GET /dashboard` | `memory.read` | The switches; what is in force, each with `source` (`self` 本人设置, `observed` 从改方学习, `learned`, `inferred`, `research`, `capsule` 来自胶囊), `basis` (依据次数: observations, runs, conversations), `usage` (使用情况), the last quotes and versions, and `wasTrue` (「曾经如此」); `pending` — what waits for the person: records held for them and notes an outside agent proposed; `forgotten`; `habits` (learned methods, `isNew` for 14 days); `recentChanges` (最近变化, 30 days) with the act that takes each back. |
| `PUT /settings` `{ "learningPaused"?, "recallPaused"? }` | `memory.manage` | The switches (功能开关). |
| `POST /records/{id}/confirm` `{ "expectedVersion" }` | `memory.manage` | A proposal becomes the person's own statement. |
| `PATCH /records/{id}` `{ "expectedVersion", "summary"?, "value"? }` | `memory.manage` | The person's edit. |
| `POST /records/{id}/forget` · `/restore` · `/undo` `{ "expectedVersion" }` | `memory.manage` | Forget (restorable, and remembered so the extractor does not write it back), restore, or undo the last change. |
| `GET /methods/{id}` | `memory.read` | One habit and its versions — text changes only, earlier texts marked `wasTrue`. |
| `POST /methods/{id}/retire` · `/restore` `{ "expectedRevision" }`, `/rollback` `{ "expectedRevision", "targetRevision" }` | `memory.manage` | Stop a habit, take the stop back (the last version in force), or go back to a named version. |
| `POST /notes/{id}/confirm` · `/reject` `{ "expectedRevision" }` | `memory.manage` | A proposed note, confirmed or rejected. |
| `DELETE /subject` | `memory.manage` | Integration keys, with `X-Subject`: forget that person entirely — their account and everything in it, the recall index first. |

### Habits from prescription edits

`POST /observations` (scope **`memory.observe`**) is the learning signal of a
prescription-review step: `{ "observationId"?, "syndrome", "lineage"?, "changes":
[{ "type": "replace", "from", "to" } | { "type": "add" | "remove", "herb" }] }`.
Names only: a herb name cannot carry a digit and an unknown field is refused,
so a dose or a patient field has nowhere to go. The platform counts, in code,
each change across the doctor's last 30 edits under that syndrome; a change
seen at least 3 times and in at least half of them becomes a habit — worded
once through the model gateway (metered as `learning`; a line that states a
number or does not name the herbs is replaced by a fixed sentence), written to
the method ledger, in effect at once and returned by `recall`. A habit whose
share falls below a quarter over enough later edits is retired with the reason
said. Changes naming a toxic herb (the `tcmToxicHerbs` rows of
`packages/domain/src/clinical-safety-rules.json`, the list the memory
checkpoint and the capsule import scan read) are never learned from and are
counted for the dashboard's `neverLearned` line. No runtime is involved, and a doctor
who paused learning is not observed.

Every act leaves an audit line naming the key and the account (never the
subject's own identifier). Nothing on the dashboard is stored twice: it is
derived when read from the records, their evidence and revisions, the usage
counter and the method ledger.

What an agent can never do through either door: activate a memory, reach a
project its key is not bound to, or outrun the researcher's own switches. If
the account has paused learning (for everything, or for that project) an
episode extracts nothing; if it has paused recall, `recall` returns no research
memory records (capsule entries follow each capsule's own activation). Those
switches are on the memory page (「记忆开关」). A deployment that has turned
recall off altogether (`OPEN_SCIENCE_MEMORY_RECALL_ENABLED=false`) answers every
`recall` with `{ "items": [], "mode": "disabled" }`.

## Lineage cards as capsules

A TCM CDSS lineage card (流派卡 — `LineageCard`, optionally with its
`LineageQuestionStrategy`) becomes a `.evimedcap` with:

```bash
node scripts/ops/pack-lineage-capsule.mjs --card card.json --identity governance-key.json \
  --password-file pack.password --out packs/ [--version 2] [--new-identity] [--allow-unreviewed]
```

The pack holds one method per stage the card speaks to (M02 追问 from the
question strategy, M03 辨病辨证, M04 候选方药与加减), the card's safety deference
and cautions as standards, and the card itself with its governance, signed and
encrypted exactly as an export is; the pack's own card (title, author, summary,
changelog) names the lineage and the governance group, and is the title an
import takes. It is laid out as the platform's own importer
requires, so the institution imports it like any shared capsule (记忆胶囊 ›
导入) and a recall names it in `capsuleIds`. `--new-identity` writes the
governance signing key once (0600) and never overwrites it; until an importing
deployment knows that key the pack shows as 「发布者未验证」. A card that states a
dose, carries an identifier or credential, is retired, or is not yet reviewed
(without `--allow-unreviewed`) is refused before anything is written. The
password is read from a file, never from the command line.

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
