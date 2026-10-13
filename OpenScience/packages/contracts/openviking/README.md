# OpenViking

The assertions that must pass before `deps-version.json`'s `openviking` pin may move, and the account of what this
deployment uses of OpenViking and why.

Run: `pnpm test:contracts` (this directory), and in `apps/server`: `openVikingEngine`, `openVikingModelCaller`,
`openVikingClient`, `openVikingShim`, `openVikingDeploy`, `openVikingBackup`.

## Pinned: v0.5.0 (2026-10-13)

`ghcr.io/volcengine/openviking:v0.5.0`, index digest `sha256:c60a83cd…251ccf`, linux/amd64 `sha256:2c104187…af38`.
Beside it in the pin: the official DSH memory plugin `@openviking/dsh-memory-plugin@0.5.20` (tarball and sha256) and the
two official Compile skills `llm-wiki` and `knowledge-graph` (upstream sha256, and the sha256 the server stores after it
re-wraps the frontmatter — the one the control plane compares). The server is AGPL-3.0 and runs unmodified as its own
service; the plugin, the skills and the examples are Apache-2.0.

## Division of labour

On 2026-10-12 this file reconciled the upstream capability list and said extraction, VikingBot, Compile and the VLM
should stay off. The owner overruled that the same day: reuse the mature engine with the narrowest adapter, and keep in
EviMed only what upstream does not do. Since v0.5.0 OpenViking is the engine; EviMed owns identity, tenancy, money, the
model and the evidence rules around it.

| Capability | Here | Who owns what |
|---|---|---|
| `find` over `memories/evimed/` | **used**, unchanged since 2026-09-11 | the derived recall index of the records PostgreSQL owns (research memory, capsule facts); every hit is hydrated from PostgreSQL and re-checked there; rebuildable with `pnpm rebuild:memory-index --all` |
| session memory extraction | **on** (`memory.extraction_enabled`), with this deployment's templates (`deploy/web/openviking/memory-templates`, eight types, the keep / never-keep policy written in the engine's template language) and the type allowlist in `server.user_config_defaults` | the engine writes `memories/<type>/…`; sessions, the plugin and the memory gateway are WP-OVMEM's (`openVikingSessions.mjs`, `memoryGateway.mjs`) |
| resources, Compile (`llm-wiki`, `knowledge-graph`), the pages and the graph | **on**, the built-in VikingBot as Compile's runtime, command execution off | pushing documents, scheduling compiles, mirroring pages and the knowledge-base views are WP-OVKB's (`openVikingResources.mjs`) |
| VLM (extraction, summaries, Compile rounds) | **on, through this deployment's model gateway** (`/internal/model/v1`) with a service bearer, thinking off; the provider key never enters the engine's container | reserved, settled and reported in `evimed_usage.model_requests` under `memory-extraction` and `knowledge`, booked to the platform account's internal project `evimed-openviking`, held by `OPEN_SCIENCE_OPENVIKING_MODEL_DAILY_BUDGET_CNY` (`openVikingModelCaller.mjs`) |
| rerank | **in the control plane** (`memoryRerank.mjs`) | `/search/find` never reranks |
| query expansion (`retrieval.enable_intent`) | **off** | one model call per recall that the control-plane rerank already replaces |
| `output_language_override` | **not set** | set, it forced every memory and summary into one language (measured: English and Japanese text resolved to `zh`); unset, the engine writes in the language of the content |
| OVPack | **not the backup** | not atomic, carries no `k=v` tags, no user settings, no account registry, no task queue; the volume is captured with the engine frozen instead (`scripts/ops/openviking-backup.mjs`) |
| Studio, Gateway, agent evolution, MCP to a runtime directly, memory links | **not wired** | the runtime reaches memory only through the control plane's memory gateway; nothing else calls the engine |

What makes the engine safe to run for many users here, each asserted by a test: trusted auth mode behind the control
plane, which is the only caller and writes the identity headers in one function (`OpenVikingClient.request`); an opaque
hashed id per account (it reaches the model provider inside extraction prompts, so it is never a name or an address);
no published port; uid 10001, no capabilities, `no-new-privileges`, 3 GB; egress only to the embedding API; the model
reached through the gateway on the internal network; the readiness facts below.

## The identity shim, and when it is deleted

In trusted mode v0.5.0 forwards only the root key to its Compile runtime, and the bot refuses a request that names no
user (401, measured). `deploy/web/openviking/identity_shim.py` — standard library, loopback port 18791, no state — is
started by `entrypoint.sh` beside the server; `compile_api.base_url` points at it, and it adds the account and user from
the target URI the server already authorized, refusing a target outside a user's own root. Delete the shim, the
entrypoint wrapper, `compile_api.base_url` and the `compileShim` fact on the first pin whose Compile forwards identity
itself (upstream PR #5750, on `main`, in no tag yet).

## What the control plane checks (`apps/server/src/openVikingEngine.mjs`)

Each of these fails silently upstream, so it is read off the running service at start and every thirty minutes and
reported under `checks.memoryIndex.engine` in `/api/ready`; a failed fact degrades the feature that needs it and never
a conversation.

| Fact | Read how | Degrades |
|---|---|---|
| `version` | `/health` names the pinned release | both |
| `modelKey` | the gateway's service key is loaded | both |
| `memoryTemplates` | the template route answers 400 `not editable` for the types this deployment adds (404 when the directory is not loaded), and a registered user's settings read back exactly the eight types | native memory |
| `skills` | `content/download` of each `SKILL.md` matches the installed sha256; a missing one is installed from the pinned bytes, a different one is reported and left alone | knowledge |
| `compileShim` | a Compile submission to a shared root, which the shim refuses by rule in 0.3 s with its own sentence; nothing is written and no model is called | knowledge |

The recordings in `fixtures/engine/` are that check run against real engines: the container started from this
repository's configuration and compose definition, the two lab instances that each lack one half, the same container
with the shim stopped, and an account it had never seen.

## Limits at v0.5.0

- A Compile target holds at most 128 typed pages, and the check is destructive: the task still completes and the agent
  rewrites existing pages to pass it. The scheduler stops submitting to a target at about 100.
- `content/write` has no version precondition: a write-back and a compile on one target must never overlap.
- A failed extraction commit is never retried by the server (a 4xx immediately; a 429 or 5xx after sixteen calls in
  about thirty seconds): the overlay replays it. The model gateway answers a spent budget with 402 for that reason.
- Task records expire 24 h after completion (7 days after failure); mirror by content hash, never from the task record.
- An unknown `ov.conf` key only warns (since v0.4.22), and a template directory that is not mounted is silent: the
  startup check is the proof that the configuration took effect, not the file.
- Identities are registered in batches up to five minutes after their first request; until then the admin routes answer
  404 about the account (the check reads `openviking_registration_pending`).
- A v0.5.0 volume is not readable by v0.4.x: the way back is a restore of an older copy, never a downgrade in place.

## The fixtures

`fixtures/*.json` are the exchanges `OpenVikingClient`'s five original calls make, recorded on 2026-10-13 by running the
client itself against a v0.5.0 lab instance. `fixtures/memory/` (76 exchanges of sessions, native memory, admin routes and
MCP) and `fixtures/knowledge/` (55 of resources, Compile, tasks, search and skills) are the two labs' recordings;
`fixtures/engine/` the engine check's. `provenance.json` in each says how, and what the wire disagreed with the
documentation about. Nothing was authored: a hand-written fixture once certified a shape the wire never produced.

A find score is `(cosine + 1) / 2` since v0.4.22 and unchanged at v0.5.0 (the production volume rehearsed under v0.5.0
on 2026-10-12: same entries, same hits, every score `(old + 1) / 2`), so `OPEN_SCIENCE_MEMORY_SEARCH_MIN_SCORE` stays
0.75.
