# SaaS Product Alignment

Date: 2026-07-20

This is the canonical boundary between EviMed's implemented hosted product and
claims that still require product, operator, or external evidence. The
machine-readable release contract is
`deploy/web/saas-capability-contract.json`; `pnpm audit:saas-alignment` enforces
it in `ci:web`.

## Original Product Intent

The product remains an AI research workbench for individual researchers. Its
moat is the research runtime, reproducible artifacts and provenance, scientific
connectors, and domain-correctness gates. SaaS delivery must make those
capabilities remotely operable without turning the product into a generic chat
page or an organization-administration dashboard.

The desktop edition remains local-first and model-agnostic. The first hosted
SaaS tenant is one authenticated individual account; projects are isolated
research workspaces inside that tenant. Organization membership, shared-project
roles, invitations, billing, and institutional administration are expansion
products, not implied phase-one features.

## Deployment Profiles

| Profile | Intended use | Claim allowed |
| --- | --- | --- |
| `controlled-pilot` | Single-node pilot with a known operator and controlled users | Hosted pilot only; never public SaaS |
| `individual-saas` | Public individual-account service after every readiness boundary passes | Technical individual-account SaaS; not organization or commercial completeness |

The base Compose file defaults to `controlled-pilot`. Public technical SaaS is
an explicit opt-in and must combine the OIDC and SaaS overlays:

```bash
docker compose --env-file deploy/web/.env \
  -f deploy/web/docker-compose.yml \
  -f deploy/web/docker-compose.oidc.yml \
  -f deploy/web/docker-compose.saas.yml \
  -f deploy/web/docker-compose.monitoring.yml \
  --profile monitoring --profile tls up -d
```

The `individual-saas` readiness check fails closed unless it sees HTTPS public
origin, OIDC, shared Postgres state, project isolation, sandboxed per-project
runtime control, server-only model routing, all seven science connectors,
required research memory, release provenance, externally owned recovery with a
restore drill, and protected content-safe observability. Compose acknowledgements
record operator ownership; they do not replace target-host acceptance evidence.

## Tenant and Data Boundary

```text
OIDC identity -> individual tenant -> project -> workspace/runtime/artifacts
                         |              |
                         |              +-- project-scoped quota, logs and audit
                         +-- account export/deletion and owned project list
```

`/api/me` returns the tenant explicitly, persisted users and projects carry the
tenant identity, and runtime workloads receive `OPEN_SCIENCE_TENANT_ID`. This
keeps tenant context available at the API, state, runtime, audit, and operations
boundaries instead of treating authentication alone as isolation.

## Module Disposition

| Module | Current disposition | Boundary |
| --- | --- | --- |
| Research workbench, sessions, files, runs | Adapted | Browser uses the hosted API/runtime boundary |
| Identity and tenant context | Adapted | Individual account is the phase-one tenant |
| Projects and workspace isolation | Adapted | Tenant-owned, project-scoped paths and runtimes |
| Agent runtime | Adapted | Per-project Docker sandbox through an isolated controller |
| Model access | Adapted | Operator key stays server-side; browser and workspace never receive it |
| 38 curated scientific Skills | Adapted | All 38 have executable contracts; 36 share a bounded deterministic executor and two retain dedicated tested pipelines |
| Four Office exporters | Adapted | First-party MIT implementations, packaged for desktop and Hosted, each with artifact smoke tests |
| Seven science connector MCPs | Adapted | Paper Search, BioMCP, Materials Project, FRED, Space Weather, Open-Meteo, and USGS Water are registered by default through the fixed-host server gateway with independent protocol tests |
| Biomedical public-source routes | Adapted | The current 64-source default registry must pass two traceable queries per source through a controlled route; registry source and ordered-ID hashes prevent stale evidence from passing |
| Drug evidence decision support | Adapted | Drug selection, off-label use, and comprehensive evaluation use EviMed retrieval, frozen evidence snapshots bound by compiler input SHA-256, deterministic compilation, independent regression tests, and mandatory human decision boundaries |
| Artifacts, provenance, review | Adapted | Stable traceable project artifacts remain the product core |
| Hosted notebooks | Adapted | Python and R execution are project-scoped and sandboxed when enabled |
| Research memory | Adapted | Required Memos integration is a readiness boundary |
| Account and operator surfaces | Adapted | Project/resource/task/audit/error/security/readiness cards are available |
| Security and isolation | Adapted | CSRF, exact CORS, scoped files, controller boundary and quotas are gated |
| Release and observability | Adapted | Immutable manifest plus protected metrics, alerts and dashboards |
| Backup and disaster recovery | External evidence required | Off-host custody and a real restore drill are deployment responsibilities |
| Async work and capacity | Conditional | Safe for bounded single-node operation; node-local queue/rate state limits replicas |
| Horizontal scaling | Not implemented | Needs distributed queue, rate limiting, shared artifact storage and scheduler coordination |
| Organization collaboration | Out of original phase-one scope | Needs membership, roles, invitations and shared-project policy |
| Commercial billing | Not implemented | Needs plans, subscriptions, metering ledger and billing lifecycle |
| Institutional compliance | External evidence required | Needs jurisdiction, residency, contracts, legal review and assurance decisions |

## Claim Rules

The repository can claim that the core research workflow and individual-account
tenant model are technically adapted for SaaS. A deployment can claim public
technical readiness only when `/api/ready` passes under `individual-saas` and
the target-host acceptance evidence is retained.

The repository must not claim any of the following yet:

- that the default controlled pilot is public SaaS;
- that a particular production deployment has been externally accepted;
- organization/team SaaS readiness;
- commercial SaaS completeness;
- horizontal-scale readiness; or
- institution-specific regulatory or contractual compliance.

These are explicit product decisions and release boundaries, not hidden defects.
They should become new profiles only after their identity, isolation, operations,
consumption, lifecycle, and acceptance contracts exist.

Implemented-but-unproven routes remain disabled. SIDER demonstrates this rule:
its first-query remote dataset download failed the fixed-gateway probe, so that
route was rejected. It was admitted only after SIDER 4.1 became a licensed,
hash-pinned, build-generated, read-only SQLite artifact with retained receipts,
bounded queries, and explicit research-only clinical guidance.

## Release Verification

Run the following before producing a hosted release:

```bash
pnpm audit:saas-alignment
pnpm audit:hosted-compliance
CI=true pnpm ci:web
```

The SaaS alignment contract and audit script are themselves included in the
immutable release-manifest inputs, so the deployed release is bound to the same
product claims used during CI.

## External Design Reference

The tenant context, isolation, tenant-aware operations, and per-tenant
consumption boundaries follow the design principles in the
[AWS Well-Architected SaaS Lens](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/general-design-principles.html)
and its [SaaS identity guidance](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/saas-identity.html).
The product-specific choice here is deliberately narrower: phase one uses an
individual account as the tenant and does not infer organization features from
a working authentication system.
