# OpenViking

The assertions that must pass before `deps-version.json`'s `openviking` pin may move, and the account of what this
deployment uses of OpenViking and why.

Run: `pnpm test:contracts` (this directory), and in `apps/server`: `openVikingEngine`, `openVikingModelCaller`,
`openVikingClient`, `openVikingResources`, `openVikingDeploy`, `openVikingBackup`.

## Pinned: v0.5.1.1 (2026-10-23; v0.5.0 from 2026-10-13)

`ghcr.io/volcengine/openviking:v0.5.1.1`, index digest `sha256:551b1ae0…5b23217`, linux/amd64 `sha256:c8bc3cb8…2a334e4e`.
v0.5.1 itself is excluded: its second and later commits of one session wrote memories that `find` did not see (fixed in
v0.5.1.1, PR #6331), and `nativeTurnCommit` commits one long session once per attended turn. The release the pin moved from
was v0.5.0. Beside the engine in the pin: the official DSH memory plugin `@openviking/dsh-memory-plugin` (the version, tarball and sha256 are `openviking.plugin` in
`deps-version.json`; 0.5.26, which is what the v0.5.1 and v0.5.1.1 tags ship — read at the tag's source, like the engine) and the
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
| session memory extraction | **on** (`memory.extraction_enabled`), with this deployment's templates (`deploy/web/openviking/memory-templates`, eight types, the keep / never-keep policy written in the engine's template language) and the type allowlist in `server.user_config_defaults` | the engine writes `memories/<type>/…`; the sessions and the memory gateway are the control plane's (`openVikingSessions.mjs`, `memoryGateway.mjs`), and the official plugin reaches them through the loopback bridge row `evimed-memory-bridge` |
| Resources, Compile with the official `llm-wiki` and `knowledge-graph` skills | **on**, the built-in VikingBot as Compile's runtime, command execution off | every readable document is pushed as a resource under its own user and project prefix (`openVikingResources.mjs`, `openVikingSourceSync.mjs`), and upstream's Compile writes the project's wiki and graph as it ships; the control plane decides when (`knowledgePageService.mjs`), mirrors the result into its own ledger by content hash, keeps a person's edits (written back as a checked `batch-write` operation, below), and lays the verbatim-quote check on afterwards as a ✓ / ⚠ label. The Compile agent's model calls go through the model gateway. The self-built compiler this replaced was never switched on and was deleted on 2026-10-13 |
| VLM (extraction, summaries, Compile rounds) | **on, through this deployment's model gateway** (`/internal/model/v1`) with a service bearer, thinking off; the provider key never enters the engine's container | reserved, settled and reported in `evimed_usage.model_requests` under `memory-extraction` and `knowledge`, booked to the platform account's internal project `evimed-openviking`, held by `OPEN_SCIENCE_OPENVIKING_MODEL_DAILY_BUDGET_CNY` (`openVikingModelCaller.mjs`) |
| rerank | **in the control plane** (`memoryRerank.mjs`) | `/search/find` never reranks |
| query expansion (`retrieval.enable_intent`) | **off** | one model call per recall that the control-plane rerank already replaces |
| `output_language_override` | **not set** | set, it forced every memory and summary into one language (measured: English and Japanese text resolved to `zh`); unset, the engine detects the language of the user's messages and tells the model to write in it — but the templates' Chinese examples pulled an English conversation into Chinese in 2 of 3 live runs, so every template opens with a language block (`memory-templates-src/_language.txt`, `{{ language }}`): 0 of 8 afterwards, Chinese conversations unchanged |
| OVPack | **not the backup** | not atomic, carries no `k=v` tags, no user settings, no account registry, no task queue; the volume is captured with the engine frozen instead (`scripts/ops/openviking-backup.mjs`) |
| Studio, Gateway, agent evolution, MCP to a runtime directly, memory links | **not wired** | the runtime reaches memory only through the control plane's memory gateway; nothing else calls the engine |

What makes the engine safe to run for many users here, each asserted by a test: trusted auth mode behind the control
plane, which is the only caller and writes the identity headers in one function (`OpenVikingClient.request`); an opaque
hashed id per account (it reaches the model provider inside extraction prompts, so it is never a name or an address);
no published port; uid 10001, no capabilities, `no-new-privileges`, 3 GB; egress only to the embedding API; the model
reached through the gateway on the internal network; the readiness facts below.

## Who commits a native conversation, and when

Extraction runs on a commit: the engine archives the session's pending messages and extracts from them. The unmodified
plugin (`@openviking/dsh-memory-plugin`, `runtime.mjs`) commits in exactly three cases: at the end of a turn when
the session reports `pending_tokens >= commitTokenThreshold` (the upstream default 20000, minimum 1000, which the engine
counts about twice DeepSeek's tokens for Chinese); when the kernel appends `compaction/start`, whatever the threshold (new in
0.5.25: it commits before the history is summarized, so a conversation long enough to compact is committed by its first
compaction, and `/compact` does the same; unchanged at 0.5.26, whose one change is that a capture filter's substitutions
also reach tool calls and results); and when its session is disposed — the kernel's shutdown or a release of the
container. `commitTurnThreshold` and `autoCommitOnCompact` are in its schema and no code of the DSH runtime reads them (the
compaction commit is not the latter's switch: it is unconditional). Every one of the three reaches the engine through the
memory gateway's commit path, so the admission rule below applies to a compaction commit exactly as to a turn's. An ordinary conversation is a few hundred to a few thousand tokens in a runtime that lives for hours, so on
production (2026-10-14) a stated profession and city and three project facts were not in memory after twenty minutes and
`native_commits` held no row of the session; the engine's own idle commit (`auto_commit_policy.idle_timeout_seconds: 900`,
scanned every 300 s) was the only net, 15 to 20 minutes after the last message.

So the control plane commits (`apps/server/src/nativeTurnCommit.mjs`). When an attended run of a native account ends it
arms a timer for the conversation; after the quiet (`OPEN_SCIENCE_NATIVE_MEMORY_TURN_COMMIT_DEBOUNCE_MS`, 8 s) it reads the
engine session until two reads agree and something is pending (the plugin's writes are asynchronous), then commits through
`commitSession` of the memory gateway — the function the HTTP commit route uses — so the admission rule, the hourly bound
and the ledger row are the plugin's own commit's. Two turns inside the quiet are one commit; a turn the platform started (an
automated run, a scheduled task, a LoopX continuation) starts none; a legacy account is not touched; an engine that does not
answer is a counted failure and the messages stay pending for the next commit, the plugin's disposal commit or the idle
commit. The plugin's threshold stays at 20000 and is not lowered: a token count would still leave a one-line statement
waiting, and a second trigger would make two paths race for the same messages. The plugin's disposal commit that follows a
release finds nothing pending and extracts nothing again (asserted against the pinned plugin through the real bridge).

Cost: one extraction call per attended turn that left something pending — about 6.8 K input tokens, most of it the cached
system prompt, and 0.15 K output with thinking off, as this deployment runs it (lab measurement: ¥0.003; ¥0.013 with
thinking on) — under purpose `memory-extraction`, booked to `evimed-openviking` within
`OPEN_SCIENCE_OPENVIKING_MODEL_DAILY_BUDGET_CNY`, bounded by the gateway's 120 commits an hour per account. Counted in
`open_science_native_memory_turn_commits_total{outcome}`.

## Compile runs as the caller, and what stands in for the shim

Until v0.5.1 the server, in trusted mode, forwarded only the root key to its Compile runtime and the bot refused a request that
named no user (401, measured on v0.5.0). The deployment carried `deploy/web/openviking/identity_shim.py` — standard library,
loopback port 18791 — started by an `entrypoint.sh` wrapper, with `compile_api.base_url` pointing at it. From v0.5.1 the server
forwards the caller's account and user itself (`X-OpenViking-Account`, `-User`, `-Actor-Peer`), so all of that was deleted with
the pin to v0.5.1.1: the shim and the wrapper, the compose `entrypoint:` override and two bind mounts, the init check that named
them, `SHIM_ACCOUNT`, the `compile_api` section of the rendered `ov.conf`, and the `compileShim` fact. Measured on the
v0.5.1.1 lab with no `compile_api` at all: a compile submitted as a user runs as that user and completes; the server looks at
its own local Compile endpoint every 30 s, so a finished task is seen up to 30 s late (a tiny compile took 31 s end to end; a
round that takes minutes does not notice). Writing `compile_api: { base_url: "http://127.0.0.1:18790", poll_interval_ms: 5000 }`
would make it 5 s; that wiring has **not** been probed (the bot's gateway-token handling is the open question), and the local
default is the one upstream tests.

What the shim also did, by rule, was refuse a target outside a user's own root. The engine now refuses another user's root
itself (403 PERMISSION_DENIED at submission, for a `to` and for a `from`) but **takes** a target under the account-shared
`viking://resources/…` or `viking://agent/…`, so that rule moved to the control plane: `OpenVikingResources.submitCompile`
refuses every root that is not inside the acting user's own resources (`openVikingResources.test.mjs`).

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
| `compileIdentity` | `GET /compile/capabilities` says Compile is configured, and one real submission whose source is an empty directory ends, about 30 s later, with `Compile sources contain no files`: the bot ran the task as the caller, nothing is written and no model is called | knowledge |

The recordings in `fixtures/engine/` are that check run against a real engine (`record.mjs` runs the repository's own
`OpenVikingEngine`): an account the server had never seen (registration pending, the two skills installed from the pinned
bytes) and the same account once registered. What the lab cannot show — a server that mounts no template directory, a
Compile runtime that is not configured — is recorded where it was (`engine-check-no-templates.json`, v0.5.0) or authored in
the test, and the test says which.

## Limits at v0.5.1.1

Measured on the lab of 2026-10-23 unless a line says it is read from upstream's source or kept from the v0.5.0 lab.

- **No page cap.** A Compile target of 140 typed pages (the v0.5.0 cap was 128, and past it the model rewrote existing pages
  into one-line stubs while the task said `completed`) was compiled twice: once with new sources, once asked to touch every
  page. All 140 pages stayed byte for byte, no stub, no refusal. The second run ended `completed` with a partial-output
  warning and read 1.58 M input tokens (1.49 M cached) against 17 k for the first: a compile reads the existing wiki, so its
  cost grows with the wiki, not with the change. What was *not* seen is a compile that rewrites more than a hundred pages
  (the agent's plan failed on that run); "no cap" is shown, "safe at any size" is not. The platform's own stop at 100 typed
  pages (`KNOWLEDGE_PAGE_SUBMIT_LIMIT`, the `limited` state and `page_limit`) is removed, in its own commit (the last of the
  package, so that it can be dropped on its own).
- **`completed` is not "complete".** A failed job of the pipeline leaves the task `completed` with `meta.pipeline.errors` and a
  "Partial output" line in `result.warnings` (reported as `warnings` on the task and on the round). And a compile of the same
  three short documents wrote only `index.md`, with no error and no warning, on 2 of 9 runs (4 to 6 pages on the others, and the recorder asks again until a run writes the pages the other fixtures are read against);
  `result.page_count` is 0 even on a good run, so `created` is the only count that says what was written.
- **A write-back is a checked write.** `content/write` has no version precondition; `content/batch-write` has one per operation
  (`expected_sha256`, the digest of the bytes `content/download` returns). A changed page is a 409 `CONFLICT` "Content revision
  changed" (a missing one "Expected content no longer exists"; with `skip_conflicts` a 200 whose `result.conflicts` lists them),
  and a directory whose previous write is still being summarised and embedded is a 409 `CONFLICT` with
  `details.conflict_type: "path_busy"` and `retryable: true` (the lock is on `root_uri` for a batch, on the file for a single
  write). `wait: true` answers when that processing is done (about 7 s a page); `wait: false` at once.
- **Compile polling is 30 s.** With no `compile_api` section the server looks at its Compile runtime every 30 s, so a task is
  seen finished up to 30 s late (the engine check's probe takes about 31 s). `compile_api.base_url` on the bot's loopback with
  `poll_interval_ms: 5000` would make it 5 s; not probed.
- **Another user's root is refused, a shared one is not.** `to` or `from` in another user's root: 403 at submission. A `to` under
  `viking://resources/…` or `viking://agent/…` runs. The control plane refuses both (`submitCompile`).
- **Tokens are under `meta.pipeline.tokens`** (`input`, `output`, `cached`); v0.5.0's `meta.token_usage` is gone.
- A failed extraction commit: the server's retry follows the model error's body code (read from upstream's source at the tag, not
  measured here, since the lab's model gateway is not this repository's to switch). A spent budget answers 402 with the code
  `insufficient_quota`, which it reads as an exhausted quota and does not retry; a refusal it does not recognise is retried up to
  `vlm.max_retries` (3), as v0.5.0 retried only a 429 or 5xx. The overlay replays a commit that failed.
- Task records expire 24 h after completion (7 days after failure; kept from the v0.5.0 lab and upstream's documentation, not re-measured);
  mirror by content hash, never from the task record.
- An unknown `ov.conf` key only warns (since v0.4.22; not re-measured), and a template directory that is not mounted is silent: the
  startup check is the proof that the configuration took effect, not the file.
- Identities are registered in batches about five minutes after their first request; until then the admin routes answer 404 about the
  account or the user (the check reads `openviking_registration_pending`). An account that is not registered cannot be deleted either.
- `fs/mkdir` on a directory that exists is a 409; `content/write` takes no `timeout` field (an unknown field is refused).
- A v0.5.1.1 volume is not readable by v0.5.0, nor a v0.5.0 volume by v0.4.x: the way back is a restore of an older copy, never a
  downgrade in place. The task store has no migration code, so the switch is made with no task in flight.

## The fixtures

Every fixture is recorded by `record.mjs` (`OV_URL=… OV_KEY_FILE=… OV_ACCOUNT=<throwaway account> node record.mjs fixtures [top|engine|memory|knowledge]`)
against a running server of the pinned release; the account it used is deleted afterwards and written as `evimed`. The root key
never reaches a file. `fixtures/*.json` are the exchanges `OpenVikingClient`'s five original calls make, recorded by running the
client itself. `fixtures/memory/` (76 exchanges of sessions, native memory, admin routes and MCP) and `fixtures/knowledge/`
(resources, Compile, tasks, search, skills and the checked write) are plain HTTP calls the recorder makes; `fixtures/engine/` is
the engine check's own run. `provenance.json` in each says how, what the wire disagreed with the documentation about, and
what could not be recorded again (`notRecorded`): the two failed-extraction recordings of `memory/` and
`engine-check-no-templates.json` are still the v0.5.0 ones. Nothing was authored: a hand-written fixture once certified a shape
the wire never produced. The v0.5.0 -> v0.5.1.1 differences found by comparing the two recordings: `create` and `replace`
(200, no 409/404), deletes carry a `task_id`, `meta.token_usage` -> `meta.pipeline.tokens`, `conflicts` and `link_report` in a
compile's result, `last_idle_commit_accepted_at` on a session, a user deleted a moment ago answers 404 where it answered 412.

A find score is `(cosine + 1) / 2` since v0.4.22 and unchanged at v0.5.1.1 (the same four records score the same four numbers as
on v0.5.0; the production volume rehearsed under v0.5.0 on 2026-10-12 gave every score `(old + 1) / 2`), so
`OPEN_SCIENCE_MEMORY_SEARCH_MIN_SCORE` stays 0.75.

## Shared project resource compilation

Shared knowledge generations use the same official Compile pipeline with fresh
resource inputs and output trees. `compile-scope-proof.json` binds the reviewed
upstream lifecycle/reader source hashes to the image pin. The ordinary production
configuration explicitly selects `direct` with both execution flags false.
The existing runtime controller provides a parameter-free, read-only observer
for its own Compose stack: immutable image identity, fixed installed source
hashes, the actual managed server/Bot processes, and the read-only configuration
file before both processes started. It never returns configuration contents or
environment values. The control plane additionally checks the official ROOT
configuration API's current/startup equality and the installed Skills API's
locked integrity manifest. Neither operation submits a task or calls a model.

This is **startup-configuration evidence under the pinned lifecycle**, not a
direct read of Bot's live Python object or an attestation against an operator
who adversarially replaces and restores configuration. The two generated hidden
skill summaries are recorded in the package revision, not treated as pinned
instructions. Only the pinned `SKILL.md` and those two standard summary paths
are admitted. An unavailable or changed observation leaves original documents
readable and defers shared compilation. The binding excludes transient process
identities, so a normal restart with unchanged qualified bytes retains existing
generation identity. The local replay tests are separate from a live engine
acceptance; the new observation protocol has not been deployed by this change.

Completed local mirrors use a separate historical read mode. One internal
`knowledge-compile-qualification` product document belongs to the existing
platform engine project; it records the qualified environment and each of the
two Skills, with independent epochs. A known environment rejection invalidates
both slots across all projects; a known Skill rejection invalidates that slot.
Transport/liveness loss does not erase an earlier positive authority. An
optimistic revision is read before observation, so a stale success cannot
overwrite a newer rejection. Live qualification and reference capture happen
before the leased settlement transaction; that transaction locks and checks the
authority reference before saving the generation and selected pointer. A
request's `execution` field alone cannot supply historical authority.

The web process runs as root with all capabilities dropped, while `ov.conf`
belongs to UID 10001 at mode 0600. It cannot read that secret file. The ordinary
Compose init therefore atomically writes only `ov.conf.sha256`, owned by root
at mode 0600, beside the configuration it copied. Historical reads compare this
installation digest with the retained authority and current shipped pin/proof;
they make no current-engine claim and call no engine API. Live admission also
compares that digest with the actual configuration observed inside the engine.
No extra secret copy, permission expansion, manually supplied qualification or
online deployment is part of this change.
