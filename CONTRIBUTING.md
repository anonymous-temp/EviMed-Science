# Contributing to EviMed Science

Thank you for helping. This repository is **AI-native**: [`AGENTS.md`](AGENTS.md) and
[`CLAUDE.md`](CLAUDE.md) at the root, and [`OpenScience/AGENTS.md`](OpenScience/AGENTS.md)
inside the production subtree, are the instructions that AI coding agents (Claude Code,
Codex, Cursor and others) follow when they work here. They are also the authoritative
long-form description of the architecture and the rules below, and the best place to start
reading, whether you are a person or an agent. Pull requests written with an agent are
welcome and are held to the same checks as any other.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security
problems privately, as described in [SECURITY.md](SECURITY.md), not in an issue.

## Setup

There is no root build; `cd` into the subtree you are changing.

- **Production system** (`OpenScience/`): Node.js 22.22.0 or newer and pnpm 9.4.0
  (`engines` and `packageManager` in `OpenScience/package.json`); `python3` for the MCP,
  ops and eval tests.

  ```bash
  cd OpenScience
  pnpm install
  pnpm dev            # web frontend (Vite dev server)
  pnpm dev:server     # control-plane HTTP API
  ```

- **Python engines** (`项目代码/`): each is an independent project with its own
  `requirements.txt` and `tests/`. Use a virtual environment per engine; running an engine's
  suite with a system interpreter that lacks its dependencies fails in confusing ways. Read the
  engine's own `README.md` (or `CLAUDE.md`) first. `vcr-engine` additionally needs R.
- **PostgreSQL** is needed for the server's `*.integration.test.mjs` files. Set
  `OPEN_SCIENCE_TEST_POSTGRES_URL` to a loopback database whose name starts with
  `evimed_test`; `pnpm test:server` then runs those files one at a time, and
  `node scripts/ops/test-product-state.mjs` runs them the way CI does, each in a database of
  its own. Without the variable they are skipped.
- Never commit API keys, `.env` files or credentials. Local secrets live under
  `.evimed-local/secrets/`, which is gitignored; `pnpm configure:evimed-local` sets the local
  ones up.

## Before you open a pull request

Run the checks for the area you changed, from `OpenScience/`:

| You changed | Run |
|---|---|
| `apps/web` | `pnpm lint`, `pnpm typecheck`, `pnpm test`. One test: `pnpm --filter @ai4s/web exec vitest run <file> -t "<name>"` |
| `apps/server` | `pnpm lint:server`, `pnpm typecheck:server`, `pnpm test:server`. One file: `pnpm --filter @ai4s/server exec node --test test/<file>.test.mjs` |
| `packages/*` | `pnpm test:packages`, `pnpm lint:domain`, `pnpm lint:port`, `pnpm lint:socket`, the matching `typecheck:*`; `pnpm verify:seams` when you touch `harness-port` |
| `runtime/mcp` | `pnpm test:mcp` |
| `capabilities/`, skills | `pnpm check:capabilities` (`pnpm build:capabilities` regenerates), `pnpm check:skill-packages`, `pnpm check:skill-digests`, `pnpm check:skill-vocabulary`, `pnpm test:eval-briefs`, then `pnpm test:server`; a skill or manifest edit ripples into several tests |
| design tokens | edit `packages/design-tokens/src/index.mjs`, run `pnpm tokens:build`, then `pnpm tokens:check` |
| `deploy/`, `scripts/ops` | `pnpm test:ops`, `pnpm audit:hosted-compliance` |
| a Python engine | the engine's own tests, in its own virtual environment |
| anything | `pnpm audit:source-secrets` before you commit |

The full pipeline CI runs is `pnpm ci:web` (`pnpm test:web` plus the audits and
`pnpm build:web`). It also audits production dependencies against the npm registry, and CI
supplies PostgreSQL and system tools your machine may lack; see
[`.github/workflows/web.yml`](.github/workflows/web.yml). `pnpm audit:capabilities` needs
recent evidence from a live runtime, so it can be red on a development machine without that
meaning your change is wrong. Say in the pull request which checks you ran and which you could
not.

Evaluation harnesses (`pnpm eval:*`) call live models and are separate from tests. A change to
conversation behavior (persona, guidance, a socket plugin, a tool description, routing) is
verified on a real DSH + DeepSeek session, covering multi-turn follow-up, a data supplement, a
subject switch and a tool failure; mocks and HTTP 200 prove nothing. If you cannot run one,
say so in the pull request and a maintainer will.

## Language

- **Code, comments, file names, commit messages and documentation are in English.** The
  working language of discussion may be English or Chinese.
- **User-facing UI copy is Simplified Chinese**, and the interface never explains the system:
  no subtitles under card titles, no internal state shown as text. Use the module names the
  product uses, **循证 GEO** and **虚拟临床研究**; identifiers, routes, schemas and
  `OPEN_SCIENCE_*` keys keep `geo` and `vcr`.
- **Design tokens are the single source of truth** for visual values
  (`@evimed/design-tokens`, described in [`OpenScience/DESIGN.md`](OpenScience/DESIGN.md)). ESLint
  rejects new arbitrary values (`text-[Npx]`, `rounded-[Npx]`, bare shadows) and hand-made
  bordered buttons or pills outside `components/ui/`. Use the `components/ui/` primitives and
  keep the four states on every list page: loading, empty, error with retry, success.

## Design principles

Keep it **simple, explicit, clear, complete**: no over-engineering, no ambiguity, readable at a
glance, safety first. Prefer minimal, verifiable changes, and do not write an inference as a
verified fact. The development principles in [`CLAUDE.md`](CLAUDE.md) are the long form; in
short:

- Deterministic properties (schemas, files, quote matching, numbers, closed vocabularies) are
  code; language judgment is the model's. The model never does statistics and regexes never do
  language. Do not add open-vocabulary prose regexes; write an eval case instead.
- Contracts bind outputs, not inputs. A gate verdict is a return value with specific, repairable
  findings, not a silent block. Blocking checks are budgeted, and a new check ships as a notice
  first.
- Native DSH + DeepSeek is the control. A plugin, rule or route earns its place with measured
  improvement over it. Plain questions get zero-tool answers, and no length, section or keyword
  condition gates a reply.
- Engineering boundaries (authentication, tenancy, ownership, authorization, input validity, the
  path guard, budgets) stay in code, and a failed operation never blocks the rest of the
  conversation.
- Domain knowledge goes in editable context (`SKILL.md`, prompts, data files), not in control
  flow. The delivery rules exist once, in `packages/domain`; medicine and scenario safety rules
  go in `packages/domain/src/clinical-safety-rules.json`.
- Only `packages/harness-port` may import `@deepseek-ai/*`. An upstream pin is written once, in
  `OpenScience/deps-version.json`, and tests hold every derived copy equal to it. Never patch
  `node_modules`.
- Every incident becomes an evaluation case, not a keyword. Fix the class of a defect, not the
  instance.

### Adding a rule, a route or a validation

If your pull request adds one, answer these five questions in it:

1. Is it language understanding, or an exact engineering operation?
2. Could better data, tool results or a short instruction solve it instead?
3. Does it stop a question that native DSH + DeepSeek could answer?
4. Does it touch only the operation that needs it, or the whole conversation?
5. Is there a real reproduction and a control result? No evidence, no gate.

## New features are capability packages

A new user-facing capability is a package under `OpenScience/capabilities/<id>/`, not a new code
path: a `capability.yaml` (its only definition), a `SKILL.md`, scripts, a contract validator, and
**at least three real briefs** in `OpenScience/evals/`. Shared skill bodies live in
`OpenScience/capability-skills/`. Run `pnpm build:capabilities` after editing a manifest. Write a
DSH plugin only to touch a seam, and prefer the extension points in this order: tool, plugin row,
preset row, skill, MCP server, storage domain. Internal capabilities dispatched only by a platform
job are exempt from the briefs rule and are evaluated by `evals/method-quality`.

A feature module in the control plane has one shape: a `<x>Service.mjs`, its routes, an optional
leased worker, one `OPEN_SCIENCE_<X>_ENABLED` switch in `config.mjs`, and its own migration,
registered by one line in `createWebApiApp`. With the switch off, the core must still work.

## Commits and pull requests

- Commit subjects follow `type(scope): sentence`, where `type` is `fix`, `feat`, `test`,
  `refactor`, `docs`, `chore` or `perf` and the scope is optional (`fix(vcr): ...`,
  `feat(runtime-ui): ...`). Capability work may use the capability name as the prefix
  (`vcr-matching: ...`). The sentence starts in lower case and says what is true after the
  change, for example:

  ```text
  fix(vcr): an age or a duration in any spelling of the time-unit table is judged, not left unknown
  ```

  Use the body for the why.
- Keep commits small and focused, and keep a test with the fix it covers.
- Open pull requests against `main` and fill in the template. Describe the behavior change, name
  the checks you ran, and attach screenshots for UI changes.
- Avoid adding new Markdown documents unless a maintainer asks; too many documents become debt.
  Milestones are recorded as one line in `OpenScience/PROGRESS.md` (newest on top), which
  maintainers keep.

Documentation index: [`docs/README.md`](docs/README.md).
