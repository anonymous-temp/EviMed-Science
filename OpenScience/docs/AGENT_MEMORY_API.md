# Personal memory for other agents

An account's memory — its notes, facts, preferences and earlier
conclusions — can be read and added to by an agent running somewhere else: a
local DSH or Claude profile, a script, another product. Two ways in, one set of
rules: an HTTP API, and an MCP adapter that speaks that API for agents that only
speak MCP. Neither holds memory of its own; both reach the same memory the
workbench's memory page shows: OpenViking's memory engine (see "The engine" below).


This page is the operator's and the integrator's reference. People create, copy
once and revoke keys under 设置 → 账户 → 外部智能体访问（API 密钥）
(`/app/account`); no curl is needed. The section lists names, permissions, creation
and last-use dates. It offers only scopes the service advertises, defaults to
read-only, and is drawn only when `GET /api/me` offers `features.agentMemoryApi: true`
(the account-specific audience decision described below). A missing or false
feature hides the whole section without requesting key routes or `openapi.json`.
If a key route answers `503 agent_memory_disabled` while the page is open, the
section clears its controls and shows a disabled notice. The existing browser session and CSRF protect key
management; a secret is kept only in the open one-time display, never browser storage.

## Internal access first

The public switch stays off. Internal access reuses the existing operator account
IDs and an explicit list of additional account IDs; it creates no new role.

```bash
OPEN_SCIENCE_AGENT_MEMORY_API_ENABLED=false
# Opt in existing OPEN_SCIENCE_OPERATOR_USERS accounts (default false).
OPEN_SCIENCE_AGENT_MEMORY_API_INTERNAL_ENABLED=true
# Optional additional exact account IDs, comma-separated (default empty).
OPEN_SCIENCE_AGENT_MEMORY_API_INTERNAL_USERS=internal-account-id
```

An additional listed account is allowed even when `INTERNAL_ENABLED=false`;
that switch grants access only to the existing operators. Listing an account
does not give it operator privileges. With both internal settings at their
defaults, operators do not acquire API access automatically.

An operator changes these environment values, then recreates `open-science-web`
through the normal release procedure. This documentation does not authorize a
release. Sign in as the allowed account; `/api/me` offers
`features.agentMemoryApi: true`, and the existing account key panel appears.
Create a key with only the required scopes and save it to a local credential
file. Read `GET /api/agent-memory/v1` capabilities before optional operations.

Key creation, listing, revocation, every bearer operation and the feature flag
use one audience decision. Removing the account from the list (and from operator
eligibility, if applicable) disables existing keys on their next request.
In internal-only mode, invalid, unknown, revoked, missing-owner and excluded-owner
keys all receive `503 agent_memory_disabled`; no account/key existence is
disclosed. OpenAPI then also requires an eligible account's key. With the public
switch on, OpenAPI retains anonymous access and ordinary keys remain allowed.
The public switch is not enabled by this change.

Key management previously had no feature gate even while the web panel and
bearer API were off. It now returns the same disabled response when the account
is not eligible, as required by the unified audience policy.

## Keys

Keys belong to an account and are managed with that account's browser session
(cookie and `X-Open-Science-CSRF` header), at `/api/agent-keys`:

| Call | What it does |
|---|---|
| `GET /api/agent-keys` | The account's keys (prefix, scopes, project, expiry, last use) and the scopes a key may carry. |
| `POST /api/agent-keys` `{ "name", "scopes", "projectId"?, "expiresInDays"?, "subjects"? }` | Creates a key and returns its secret **once**; it is stored as a digest. `subjects: true` makes it an integration key (below). |
| `DELETE /api/agent-keys/<id>` | Revokes it. |

- **Scopes:** `memory.read` (recall, list records, the dashboard), `memory.history.read`
  (opt-in raw conversation recall, also requires `memory.read`), `memory.write` (note,
  episodes), `memory.remember` (direct statements with source), `memory.manage` (the dashboard's acts) and `memory.observe`
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
| `GET /openapi.json` | any eligible key in internal mode | The machine-readable description. Anonymous access only while the public switch is on. |
| `GET /` | any | What this key can do: its scopes, its project, the rate limit, the endpoints and per-key `capabilities`. An integrator's first call. |
| `POST /recall` `{ "query", "projectId"?, "limit"? (1–50), "factKinds"?, "since"?, "scope"?, "capsuleIds"? (1–8), "methods"?, "include"? }` | `memory.read` | Searches the account's memory and returns hits with their source: the engine's memory files (the account's own and the project's asked for, never a sensitive one) and the capsule's facts, each item saying which. A caveat on a hit is a label, never a reason to withhold it. `scope` is `all`, `capsule`, `conversation` or `agenda`. `capsuleIds` reads the named capsules instead of the ones in force (a subject may name its institution's). Also returns `methods` — the account's own learned methods first, then the capsules' work-style methods, within the same budget a run mounts (32 methods, 32 KiB); `methods` is `all`, `own`, `capsules` or `none`. |
| `POST /note` `{ "factKind", "content", "projectId"? }` | `memory.write` | Adds one note. It arrives as an **inferred, unconfirmed candidate** whatever the caller says, and takes effect only when the account owner confirms it: on their memory page, where it is listed with 待确认 and the choice 确认 or 不要, or through the dashboard's note operations. Notes are the capsule store's. |
| `GET /records?scope=&kind=&status=&scopeId=&query=&pageSize=` | `memory.read` | Lists the engine's memory files as records, filtered (comma-separated values; `pageSize` up to 200, default 50). Every one is in force (a file is written by the person or by the engine's extraction and takes effect at once), so a `status` that excludes `active` finds none: a proposal is a staged note, never a record. |
| `POST /episodes` `{ "projectId", "sessionId"?, "messages": [{ "role": "user"\|"assistant", "text" }] }` | `memory.write` | Hands over a conversation (1–200 turns). It is **staged as a pending candidate note** (`202`, `state: "pending_confirmation"`, `extracted: 0`, `activated: 0`, `candidateId`, `confirm.path`) and nothing is extracted or written until the account owner confirms it at `POST /notes/{id}/confirm`; a memory already in force is never changed by an episode. |

### Original conversation recall

`POST /recall` with `"include": ["history"]` appends a separate `history` array;
the default response and memory/method selection are unchanged. The key needs
**both `memory.read` and `memory.history.read`**. The existing
`OPEN_SCIENCE_MEMORY_HISTORY_SEARCH_ENABLED` switch must be on, and the native
memory service must be configured. The server uses `MemoryHistory.search`, the
kernel gateway's reader, with the same admission, deletion and secret services.

Hits name `sessionId`, `conversationTitle`, `conversationUrl`, `projectId` and
messages with `sourceRole` and `date` (null when unknown). They carry
`contextOnly: true`, `confirmed: false`: assistant text is not promoted to the
person's statement. Withdrawal notices contain no original text. Recall pause,
deleted/changed sources, withdrawn statements, shared namespaces and unreviewed
archives under the secret-review switch remain excluded. Learning pause alone
does not disable recall. Failed privacy checks never read unfiltered archives.

An unbound key without `projectId` searches its owner's ordinary account history.
An explicit project or project-bound key searches only that project, including
`default`. No request can choose another owner, raw URI, review override or
removal-search mode. History retains the reader's bounds (8 hits in V1, up to 20
in V2) and the gateway timeout; timeout returns no history and does not imply
complete coverage. `factKinds`, `since` and `scope` continue to filter stored
memory/capsules, not optional history.

The standalone DSH connector forwards `include`; `capsule_status` returns server
`capabilities`. Its credential stays file-only. The MCP adapter has not yet been
extended for history or status.

### Capability parity status

The root response reports `available` per key, with `requiredScopes` for offered
operations. Availability describes the service/key offer; pause and privacy
fences can still return no context. Clients must read this status rather than
infer capabilities from error responses.

| Capability | Current API coverage |
|---|---|
| Raw conversation recall | `POST /recall`, `include: ["history"]`, separately scoped. |
| Opening context | `GET /context` (`memory.read`), the resident supplement plus the gateway startup profile and listings. |
| Direct explicit remember | `POST /remember` (`memory.remember`), page-origin direct statement with external source and durable idempotency. `/note` remains a candidate. |
| Statement forget and forgotten list | `POST /forget` uses native statement/line withdrawal; `GET /forgotten` returns original text and the web-equivalent restore action. Requires account-scoped manage authority for withdrawal/restore; see below. |
| Trusted conversation ingest | Unavailable: `external_conversation_history_authority_unavailable`; `/episodes` still waits for confirmation. |
| General work signals | Unavailable; existing prescription observations are unchanged. |
| Capsule sharing / selected-capsule-only recall | Unavailable; `capsuleIds` retains additive semantics. Trials stay web-only. |
| Clients | DSH and MCP provide status, history recall, forget and forgotten tools. Context/remember adapters consult status; context and directly stated remember are offered. |

### Opening context

Call `GET /context?projectId=<owned-project>` once at session start with
`memory.read`. Project binding is identical to recall. `platformText` is the
existing resident producer's exact block, read in peek mode: no conversation
acknowledgement or delivery digest is stored. `layers` identifies profile,
listings, projectCard, standingPreferences, index, safetyNotes, capsules and the
optional mostUsed layer. Present layers carry text; absent ones carry a reason
(`paused`, `trial`, `switch_off`, `budget`, `empty_or_filtered`). A cut native
profile has `omissionReason: "elided"`. `omittedEntries` counts resident entries
that did not fit. `listings.text` is JSON of the two filtered gateway arrays;
it is not the plugin's presentation markup. The native profile text is the
startup read result before the host formats it. These are the same inputs the
kernel receives, not raw history. Shared namespaces are refused. Privacy,
withdrawal and project exclusions are enforced by the gateway, including a
source-version check. These reads never count as explicit use.

```sh
curl -H 'Authorization: Bearer <KEY>' https://example.invalid/api/agent-memory/v1/context
```

### Targeted withdrawal and recovery

`POST /forget` requires `memory.manage`, an **unbound account key**, and
`OPEN_SCIENCE_MEMORY_FORGET_TARGETS_ENABLED=true`. It takes either
`{"statement":"Use metric units."}` or
`{"recordId":"nm_…","lines":["Use metric units."]}`. Omit `lines` to remove
that record; a profile-line record removes only its own line. Empty `lines` is
refused. A raw URI is never accepted. An optional owned `projectId` can label a
record request; a bare statement accepts only the default namespace. The native
withdrawal follows copies across that namespace, so project-bound keys cannot
safely authorize it. Shared namespaces, private records and trial contexts are
refused; learning/recall pause does **not** prevent the owner withdrawing text.

The response is the native store's confirmation, without a synthetic success
message: `removed`, `removedLines`, `fileRemoved`, `historyRejected`, and
`historyScanPending` when present. A statement may record history rejection
without removing a file. Pending means paraphrases/copies may still be recalled.
Missing exact lines return `missingLines`; available-line hints are omitted for
profile-line records so neighbouring profile text cannot leak. Errors leave no
claim that forgetting completed. Clinical/automated admission does not prohibit
withdrawal (the kernel has the same deletion rule); these are write-learning
refusals, not reasons to deny the person's deletion request.

`GET /forgotten` (`memory.read`) returns `data.items` with original `text`, `id`,
`version`, `forgottenAt` and an optional `restore: {path, expectedVersion}`.
Only an unbound key with `memory.manage` receives a restore action. Private and
shared entries remain web-only. This is a deliberate management read of withdrawn
text, never an opening or recall supplement. The optional `projectId` and key
binding filter the list; a project-bound key cannot restore a cross-copy act.
The list inherits the native store's 100-item bound and is not a full export.

`POST /records/{id}/restore` with the returned `expectedVersion` uses exactly the
web page's native status update. `/undo` remains last-change undo; an absent file
now checks the kept before-image version too, returning 409 for a stale version.
The dashboard reads forgotten revisions directly instead of filtering active
files for an archived status they cannot have.

`POST /remember` requires the separate `memory.remember` scope. `memory.write`
continues to authorize proposals only. Send `{statement, source: {client,
sessionId, messageId?, saidAt}, projectId?}` with the person's verbatim words
(maximum 2000 characters), client label (80), session/message reference (200)
and original ISO timestamp. The host must preserve actual human authorship;
this endpoint is not permission for a model to invent a source.

The page's `NativeMemoryStore.remember` entry records the statement as a direct
page-origin request. Its existing native admission ledger stores the external
reference and a digest before contacting the engine. Retries share one owner /
client / session / message key (statement hash when messageId is absent).
Changed words or scope under the same key conflict. An uncertain append is
inspected, never blindly repeated. The engine creates a real one-message
source, with the named project's existing context preamble when needed. It is
not a fabricated conversation import. The native worker performs the same
instruction, forget-request, rejection and verification checks as page writes.
Pending and uncertain states are not completed writes. The page labels the
result with its external client and original date; existing record undo and
forget routes apply. External source metadata is included in account export.

Admission refuses learning pause, trial, automated/clinical context, engine
unreadiness and pre-reset statements using the existing admission reasons
(`error.details.reason` on `memory_scope_denied`). The public path additionally
refuses shared namespaces and does not reintroduce withdrawn statements; the
person can restore one through its existing record action. These checks are
repeated before durable retries. Unknown or changed project generations refuse.

```sh
curl -X POST -H 'Authorization: Bearer <KEY>' -H 'Content-Type: application/json' \
  --data '{"statement":"Use metric units.","source":{"client":"Editor","sessionId":"chat-1","messageId":"msg-1","saidAt":"2026-11-17T01:00:00Z"}}' \
  https://example.invalid/api/agent-memory/v1/remember
```
`memory.write` already existed for candidates and is not expanded silently.
Neither a partial resident supplement nor a candidate confirmation is advertised
as the missing operation. No new configuration default or storage kind is added.

### The dashboard

For an integrator that draws the person's own memory page — the TCM CDSS's
「记忆胶囊看板」 — one read and the acts a person takes on it. The acts need a key
carrying **`memory.manage`**, which a key should hold only when its requests
come from that person's own clicks; it is never a default.

| Call | Scope | What it does |
|---|---|---|
| `GET /dashboard` | `memory.read` | The switches; what is in force, each with `source` (`self` 本人设置, `observed` 从改方学习, `learned`, `inferred`, `research`, `capsule` 来自胶囊), `basis` (依据次数: observations, runs, conversations), `usage` (使用情况), the last quotes and versions, and `wasTrue` (「曾经如此」); `pending` — what waits for the person: the notes and episodes an outside agent proposed (the engine's own files wait for nothing); `forgotten`; `habits` (learned methods, `isNew` for 14 days); `recentChanges` (最近变化, 30 days) with the act that takes each back. |
| `PUT /settings` `{ "learningPaused"?, "recallPaused"? }` | `memory.manage` | The switches (功能开关). |
| `POST /records/{id}/confirm` `{ "expectedVersion" }` | `memory.manage` | Answers `409 memory_not_pending`: a memory file is in force when it is written. A staged episode or note is confirmed at `/notes/{id}/confirm`. |
| `PATCH /records/{id}` `{ "expectedVersion", "value" }` | `memory.manage` | The person's edit: the file's text is replaced. A summary edit without `value` is refused with `400 memory_engine_unsupported`. |
| `POST /records/{id}/forget` · `/restore` · `/undo` `{ "expectedVersion" }` | `memory.manage` | Forget (the file leaves the engine; its text is kept only for the undo, and the learning loop is told not to write it back), or undo the last change. `restore` now uses the memory page status update with the version from `/forgotten`; `undo` reverses the last change. Restore requires an account-scoped key. |
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
`packages/domain/src/clinical-safety-rules.json`; only observations read that
list, and nothing else in the platform does) are never learned from and are
counted for the dashboard's `neverLearned` line. No runtime is involved, and a doctor
who paused learning is not observed.

Every act leaves an audit line naming the key and the account (never the
subject's own identifier). Nothing on the dashboard is stored twice: it is
derived when read from the records, their evidence and revisions, the usage
counter and the method ledger.

What an agent can never do through either door: bypass the scope for a direct
statement, reach a project outside its key binding, or outrun the researcher's own switches. If
the account has paused learning (for everything, or for that project) an
episode extracts nothing; if it has paused recall, `recall` returns no research
memory records (capsule entries follow each capsule's own activation). Those
switches are on the memory page (「记忆开关」). A deployment that has turned
recall off altogether (`OPEN_SCIENCE_MEMORY_RECALL_ENABLED=false`) answers every
`recall` with `{ "items": [], "mode": "disabled" }`.

## The engine

An account's memory is the engine's own files, the ones the workbench's memory page shows (until 2026-10-25 an account could
instead be on the platform's own PostgreSQL records; that engine was deleted and the API serves the one engine only).
`/recall` reads them (the account's own and the project's, never a sensitive one), `/records` and `/dashboard` list them, a forget
removes the file from the engine and keeps its text only for the undo (the forget's answer carries the `version` an undo names), an
edit replaces its text, and `PUT /settings` pauses the engine's own learning too. `/episodes` stages a pending candidate without
extracting or activating memory. Explicit confirmation admits that exact revision through the durable native session; retries
reconcile uncertain appends without duplicating them. Only captured original user turns reach extraction. Candidate notes remain
separate from active files. Native usage counts and recall at a past time (`asOf`, removed on 2026-10-25) are unavailable.
A deployment that cannot reach the engine answers `503 memory_engine_unavailable`.

Notes, observations and methods are the capsule store's and the learning ledger's. The API-only shape
(`deploy/web/docker-compose.api-only.yml`) runs on the same engine as every other shape: it composes the same OpenViking service,
and a CDSS integration that was built on pending records and the confirm step now confirms a staged episode or note with
`POST /notes/{id}/confirm` and reads what the engine wrote through `/records`.

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

## DSH plugin

`packages/dsh-memory-capsule` is the standalone thin connector (English and Chinese
READMEs included), independent of the hosted runtime's socket/universal preset.
It is a **private, unpublished candidate**; publication and index hosting are the
owner's decision, not a prerequisite claimed to have been completed here.

1. Use DSH `0.2.2-rc.1` on Node `>=24.9.0`. Its exact compatibility range is the
   approved DSH pin; another preview version needs a new contract check.
2. On `/app/account`, create a named key with “读取记忆与做法” (`memory.read`),
   optionally “提出待确认的记忆” (`memory.write`). Copy the one-time secret into
   a local file outside repositories, readable only by your OS account; do not
   paste it into plugin configuration or a shell command.
3. Once released, install with
   `dsh plugin --profile web add @evimed/dsh-memory-capsule@0.1.0`; before release,
   a supplied local package directory/tarball can be reviewed with `add <local-path>`.
4. Override the bundle's single row in `$DSH_HOME/profiles/web/cordis.patch.yml`:

   ```yaml
   - id: evimed-memory-capsule
     config:
       baseUrl: 'https://your-evimed-deployment.example'
       apiKeyFile: '/absolute/path/evimed-key.txt'
   ```

5. Restart/reload that profile, ask for `capsule_status`, then a concrete
   `capsule_recall` about earlier work. Status reports key scope/project binding
   and that the key speaks for its creating account; the API does not disclose
   that account's name or ID. Missing configuration points back to the key page.

`capsule_recall` returns memories/facts and method cards, preserving `whenToUse`
when supplied. `capsule_method` re-reads the current bounded recall catalog and
returns one body by digest or exact ID/title/name, so bodies enter context only
on demand. The API currently sends those bodies in recall itself; no new
body-by-digest server route or stale plugin cache is introduced. A method outside
that catalog's selection/budget cannot be loaded this way.
`capsule_propose` calls `/note`; it always waits for the person's confirmation.
`capsule_forget` uses `memory.manage`, and `capsule_forgotten` lists original withdrawn text with restore actions. Context and remember adapters first read status; this server offers context and remember with their respective scopes. Call context at most once at session start, only when offered.

**Raw history is opt-in** with `include: ["history"]` and both read scopes. Automatic external-work learning is unavailable. Share and proposal confirmation stay on the web memory page (`/app/memory`). This is a remote connector, not a local memory engine, transcript
collector, method mount or capsule-isolation mechanism. Ordinary work requires
no recall and continues if memory is unavailable.

The credential is read from its file on every request (never inline or logged),
so replacing the file rotates it. Requests use the public API only, never
`/internal/memory/v1`; no redirects or automatic write retries. Errors for an
unreachable service, 401/403/429 and a disabled/unavailable 503 are plain
sentences. Disposal releases the Cordis registrations and aborts pending calls.
The optional `market-index.example.json` is format 1 and names an **unpublished**
npm target with an illustrative timestamp; it is not a hosted listing. The
package's check scripts use DSH's own validator and boot readers without
installing or publishing anything.

## The MCP adapter

`runtime/mcp/evimed-memory/server.py` is a stdio MCP server with `memory_recall`, `memory_note`, `memory_status`, `memory_context`, `memory_remember`, `memory_forget` and `memory_forgotten`. New operations read server capabilities before calling their endpoint; closed capabilities return `capability_unavailable`. Listing ordinary records and posting episodes stay HTTP calls.

`memory_recall` takes `query`, `factKinds`, `since`, `limit`, `projectId`, optional `include: ["history"]`, and `capsuleIds` (1–8, read these capsules instead
of the ones in force: one school at a time) and `methods` (`all`, `own`,
`capsules` or `none`). The fact kinds are the API's own sixteen. All tools take an
optional `subject`, sent as `X-Subject`, for an integration key (one doctor behind
an institution): set by the host application, not chosen from the conversation;
the process's `EVIMED_MEMORY_SUBJECT` is the default when a call names none, and
whether the key may name a subject at all is the service's to refuse.

It needs Python 3 and nothing else. Configure it with:

| Variable | Meaning |
|---|---|
| `EVIMED_MEMORY_API_URL` | The API base, e.g. `https://evimed.example.org/api/agent-memory/v1`. |
| `EVIMED_MEMORY_API_KEY_FILE` | Required file holding the key; inline environment credentials are no longer accepted. |
| `EVIMED_MEMORY_SUBJECT` | The person calls are for when a call names none (integration keys only; absent, the key's own account). |
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

## Candidates and admission

The URL, key scopes, project binding and `X-Subject` rules are unchanged. Personal recall reads the engine through the shared recall port. Capsule and method selection retain their existing authorization and scope. Native edits change `value`; forgetting uses the rejection ledger, and restoration uses the web-equivalent restore action (or last-change undo). Unsupported operations return `memory_engine_unsupported`.

`POST /episodes` stores the submitted turns in the candidate-note ledger. It returns `202`, `state: "pending_confirmation"`, `extracted: 0`, `activated: 0`, `candidateId`, and `confirm: { path, expectedRevision }`. It opens no extracting engine session at this stage. The full role-labelled transcript stays only in that candidate as evidence. Confirmation sends only original user statements through the captured-message privacy filter; assistant statements, including assistant-authored role labels or quoted instructions, are never promoted into user facts. If no admissible user content remains, confirmation returns `admission.state: "skipped"` and `reason: "no_user_content"` without touching an extracting session. Confirm at the returned `/api/agent-memory/v1/notes/{id}/confirm` path with `expectedRevision`. There is no episode-confirm endpoint.

A confirmation returns `admission` alongside the candidate. Its immutable candidate ID and revision identify one durable admission. `queued` and `submitting` describe submission work; `pending` means the engine accepted the commit but settlement is outstanding; `completed` means the native worker read the resulting changes. `suspended` means current learning policy prevents a retry; `cancelled` means the candidate revision, the account or the project is no longer authorized. Every new engine write and replay rechecks that authority, so rejecting or editing a candidate prevents its older admission from silently learning later. `failed` retains the candidate and an error, while `uncertain` means a timed-out side effect is being inspected and must not be treated as success. The receipt includes `taskId` and `archiveUri` when known and `recordIds` after settlement; one conversation may produce several records. Repeating the same confirmation returns or recovers that admission, without appending the batch twice.

Capsule snapshots record each selected file's hash, version and capture time. Export re-reads the selected engine bytes after the database snapshot and before publication; a concurrent change returns `409 capsule_native_snapshot_changed` so the caller can retry. This is an optimistic consistency check across two stores. Revoking a hosted share prevents future hosted downloads; it does not remotely erase bytes or independent copies already exported.


### Reserved host conversation ingestion (not available)

`memory.ingest` is a reserved, internal-host-only scope, not yet mintable or
shown in the key panel. Neither `/conversations/{externalSessionId}/turns` nor
its `/commit` sibling is served. The status and OpenAPI
`x-unavailable-operations` disclose this without probing an absent endpoint.

The existing history index accepts only canonical kernel conversations
(`memoryHistory.mjs`, `indexArchive`), and `memoryHistorySources.mjs` proves their
project incarnation, native session binding and live run-ledger records on
both ingestion and recall. The worker cannot turn an arbitrary external engine
session into that authority. A durable external conversation identity, batch
idempotency/recovery, human/clinical admission and source-deletion integration
must be completed together before this scope is offered to internal accounts.
Sending turns to the engine alone would not satisfy that contract. `/episodes`
retains its existing candidate-only behavior. No model tool or fabricated kernel
conversation has been added for this operation.
