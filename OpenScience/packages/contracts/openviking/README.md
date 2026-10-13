# OpenViking

The assertions that must pass before `deps-version.json`'s `openviking` pin may move.

OpenViking is the base stack's **recall index** — it ranks research memory and
capsule facts alike — and it is not a record store. The record stays in the
control-plane PostgreSQL because `POST /api/v1/content/write` offers `replace`,
`append` and `create` and no compare-and-swap: the `expectedVersion` that keeps
two concurrent edits of one record from silently losing one has no equivalent
here.

`fixtures/` was recorded off a running `v0.4.19`, never authored. `provenance.json`
says which server, when, how it was configured, and lists what the wire disagreed
with the documentation about — most importantly that trusted mode requires the API
key on every request once a root key is set, not only when asserting a role.

Run: `pnpm test:contracts`.

## What of OpenViking this deployment uses, and what it leaves off

Reconciled against the upstream capability list on 2026-10-12, when the owner
asked whether EviMed had switched OpenViking's own abilities off. It had not
patched or forked anything; it uses a narrow part, and each part it does not use
is either a decision recorded here or a version it does not run yet.

| Upstream capability | Here | Why |
|---|---|---|
| `content/write`, `DELETE fs`, `fs/ls`, `search/find`, `/health` | **used** — the only five routes `openVikingClient.mjs` calls | the derived recall index: every hit is hydrated from PostgreSQL and re-checked there |
| session memory extraction (`memory.extraction_enabled`) | **off** in the rendered `ov.conf` (`configure-production-state.mjs`) | the profile has one writer, `memoryIntelligence.mjs`, which knows the platform's injected context and the explicit/inferred/system origins; a second writer would duplicate records outside PostgreSQL |
| VikingBot (`OPENVIKING_WITH_BOT`) | **off** (`deploy/web/docker-compose.yml`) | a second agent runtime with shell and web tools, not sandboxed for many users |
| VLM, L0/L1 directory abstracts, native `search` | **not configured** | recall needs only the embedder (recall@5 1.0 with the control-plane rerank, `evals/memory-recall`); a VLM would be model spend outside the model gateway and the usage ledger. Re-evaluate only if `find` degrades on a large library |
| rerank | **in the control plane** (`memoryRerank.mjs`) | scores the record PostgreSQL holds now, not an index copy that may lag |
| Resources, Compile with the official `llm-wiki` and `knowledge-graph` skills | **used** since v0.5.0 (`openVikingResources.mjs`, `knowledgePageService.mjs`) | every readable document is pushed as a resource under its own user and project prefix, and upstream's Compile writes the project's wiki and graph as it ships; the control plane decides when, mirrors the result into its own ledger by content hash, keeps a person's edits, and lays the verbatim-quote check on afterwards as a ✓ / ⚠ label. The Compile agent's model calls go through the model gateway. The self-built compiler this replaced was never switched on and was deleted on 2026-10-13 |
| Agent Evolution, memory consolidation, MCP, Gateway, Studio | **not wired** | method and run ledgers are EviMed's |
| Compile, Studio memory policies (v0.4.20), BM25 and the unified retrieval core (v0.4.23), Gateway (v0.5.0) | **not in the pinned version** | see the upgrade note below |

**Moving the pin past v0.4.21:** from v0.4.22 the local cosine score is reported
as `(cos+1)/2`, so `OPEN_SCIENCE_MEMORY_SEARCH_MIN_SCORE` (0.5, read as a cosine)
has to move to about 0.75 in the same change, from the distribution of the
re-recorded `find.json`, or the memory page's search lists unrelated memories
again (2026-09-26 audit, M-4). From v0.4.22 an unknown `ov.conf` key only warns,
so a renamed `extraction_enabled` would fall back silently to upstream's default
(on): grep the start log for warnings when rehearsing. A rollback is a rebuild —
an empty volume and `pnpm rebuild:memory-index --all` — never a downgrade of the
volume (v0.4.20 task records are unreadable by older releases).
