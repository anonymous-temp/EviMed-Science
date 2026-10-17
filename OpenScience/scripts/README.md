# scripts

Repository tooling for the hosted product. Almost everything here is reached through a
`pnpm` script in the root `package.json`; run those from `OpenScience/`. There is no
desktop packaging, and nothing here builds or signs an installer.

## `build/`

Generators whose output is committed, so a check can tell "someone edited the source and
forgot to regenerate" from "nothing changed". Except for `vendor-geo-skills.mjs`, each takes
`--check`, which CI runs.

- `generate-capability-manifests.mjs` turns every `capabilities/*/capability.yaml` into the
  JSON the runtime image carries and validates it (`pnpm build:capabilities`,
  `pnpm check:capabilities`).
- `generate-design-tokens.mjs` writes the design tokens into `apps/web/src/index.css`
  (`pnpm tokens:css`, `pnpm check:tokens-css`).
- `generate-skill-packages.mjs` writes `packages/domain/src/skill-packages.json`, the record of
  every package that ships a skill or capability (`pnpm generate:skill-packages`,
  `pnpm check:skill-packages`).
- `generate-runtime-inventory.mjs` writes `packages/domain/src/runtime-inventory.json`, what a
  runtime session of the image is made of (the composition snapshot's bundles and rows, the agent
  preset, the tool sets, the skill roots, the LoopX CLI's skills) — the list the plugins page is
  held to by `runtime-inventory-zh.json` (`pnpm generate:runtime-inventory`,
  `pnpm check:runtime-inventory`).
- `generate-vcr-scenario-help.mjs` renders the 虚拟临床研究 engine scenario help the research
  MCP server reads (`pnpm generate:vcr-scenario-help`, `pnpm check:vcr-scenario-help`).
- `generate-tcm-caution-rules.mjs` derives the 十八反 / 十九畏 rules in
  `clinical-safety-rules.json` from a curated matrix in the git-ignored data directory; where
  that data is absent its check says so and exits 0.
- `repin-curated-skill-digests.mjs` re-pins the curated-skill inventory digests
  (`pnpm check:skill-digests`); `rewrite-skill-vocabulary.mjs` keeps tool names in every
  `SKILL.md` spelled the way the model sees them (`pnpm check:skill-vocabulary`).
- `vendor-geo-skills.mjs` is a local step that unpacks the proprietary GEO method pack, which
  is not in this repository, into the git-ignored `runtime/skills/geo-private/`, and writes
  `geo-pack-index.json` beside it (name and one sentence per skill, `geo-pack-index.mjs`): the web
  image carries that index and none of the pack (`--index` writes it for a root already vendored).

## `dev/`

Local development helpers.

- `start-evimed-local.mjs` (`pnpm dev:evimed`) starts the control plane for local use, with
  password login, on port 8798; `configure-local-secrets.mjs` (`pnpm configure:evimed-local`)
  creates the local signing secrets under `.evimed-local/secrets/` and reports which keys are
  still missing.
- `fetch-skills.sh` fetches the pinned external skill pack into `runtime/skills/external/`
  and applies `patch-ai4s-integrity-auditor.py` to it; the image build and CI run it too.
- `vendor-community-skills.mjs` vendors the community skills named in
  `runtime/skills/community/sources.json` at their pinned commits
  (`pnpm vendor:community-skills`, `pnpm check:community-skills`);
  `try-community-bundles.mjs` installs tool-form community bundles into a scratch kernel
  profile to see whether they compose.
- `build-tool-graph.mjs`, `collect-executed-edges.mjs` and `generate-briefs.mjs` build the
  evaluation corpus's per-capability tool graph and brief drafts (`pnpm check:tool-graph`,
  `pnpm collect:tool-edges`).
- `open-evolution-pr.mjs` and `open-method-pr.mjs` are run by an operator: they turn a staged
  proposal into a branch, a commit and a pull-request body, and refuse one that touches more
  than it owns.
- `test_domain_check.py`, `test_large_file_probe.py`, `test_pdf_extract.py` and
  `test_stats_integrity.py` are standard-library `unittest` files for the core skills under
  `runtime/skills/core/`; run each directly with `python`. They are not wired into a
  `pnpm` script.

## `ops/`

Operations, release and acceptance tooling for hosted deployments, by purpose.

- Configuration and gates: `configure-*.mjs` (monitoring, backup, local auth, OIDC,
  production state) with their `--check` modes, `audit-hosted-compliance.mjs`,
  `audit-saas-alignment.mjs`, `audit-source-secrets.mjs`, `check-*.mjs` (kernel defaults, pin
  inventory, relational integrity, research billing, runtime image and skill digests,
  evidence connectors), `host-preflight.mjs`, `deployment-smoke.mjs`.
- Kernel and upstream pins: `kernel-install.mjs`, `verify-harness-seams.mjs`,
  `verify-composition-references.mjs`, `wire-surface.mjs`, `record-dsh-golden-frames.mjs`,
  `upstream-compat-matrix.mjs`, `deepseek-compatibility-preflight.mjs`,
  `deepseek-kernel-release-gate.mjs`; `skill-catalogue-size.mjs` measures what the model's skill
  catalogue costs per root, for a GEO project's runtime and for every other.
- Release and host deployment: `generate-release-manifest.mjs`, `release-images.mjs`,
  `release-full-build.mjs`, `release-retention.mjs`, `release-receipt-scheduler.mjs`,
  `host-delta-release.sh`, `host-release-switch.sh`, `host-engine-delta.sh`,
  `host-flatten-runtime-image.sh`, the `host-knowledge-plugin-*.sh` pair, and the AgentBay
  runtime image and bring-up scripts (`agentbay-*`).
- Backup and restore: `backup-data.sh`, `backup-archive.mjs`, `backup-retention.mjs`,
  `backup-scheduler.mjs`, `object-backup.mjs`, `restore-data.sh`, `restore-drill.sh`,
  `postgres-backup.py`, `recovery-volume.py`, `migrate-data-dir.sh`, and the `vcr-backup*`
  and `vcr-restore-drill.mjs` members for the 虚拟临床研究 data plane.
- Index rebuilds and data repair: `rebuild-memory-index.mjs`, `rebuild-kb-index.mjs`,
  `rebuild-frontier-index.mjs`, and one-off corrections for memory, sources and the GEO
  module, most of which report first and change data only when given `--apply`.
- Acceptance and walks: `capability-acceptance.mjs`, `hosted-production-e2e.mjs`,
  `ui-walk.mjs`, `gallery-shot.mjs`, `session-stream-acceptance.mjs`, the `evolution-*`
  and `extension-saas-acceptance*` families, `gate-health.mjs` and
  `replay-clinical-gate.mjs`.
- `test/` holds the unit tests of these scripts (`pnpm test:ops`), `fixtures/` the inputs of
  the extension acceptance campaign, and `native-ui-local/` a disposable local fixture of the
  kernel's own interface; that fixture is never for production.

## `runtime/`

- `validate-personal-skill.mjs` is the fixed entry the control plane runs in a disposable
  container to validate a researcher's personal skill from a read-only input mount.
- `extensions/cowork/` prepares the Cowork document tools as an isolated extension: a pinned
  source manifest, a trusted-operator build, an overlay, a policy and their tests. Its
  descriptor records it as not yet wired into serving.

## `test/`

- `runServerTests.mjs` backs `pnpm test:server`, keeping the PostgreSQL integration files apart
  from each other when a test database is configured.
- `localhostProbeGuard.mjs` is preloaded before every Node test file so that a developer
  tool's port scan cannot make a fake server in a test count a request it never saw.

## `vcr/`

Checks and one-off tools for the 虚拟临床研究 module and its R engine: `verify.sh` runs
everything the module can be checked by, `ci-system-deps.sh` and `r-library.sh` prepare and
verify the engine's R library, `check-numeric-log.sh` and `check-method-references.mjs` read
the numerical validation run, `migrate-check.mjs` rehearses the module's database migration on
a clone, `live-acceptance.mjs` is a live ordinary-user acceptance, and
`backfill-result-subjects.mjs`, `rename-from-definition.mjs` and `profile_snapshot.py` are
data and profiling helpers.

## `evals/`, `release/`

`evals/export-evidence-incidents.mjs` turns recorded evidence incidents into eval cases under
`evals/evidence-incidents/cases/`. `release/` holds only a `.gitkeep`; release tooling lives in
`ops/`.
