# Documentation index

Where things are written down. Start with [`../README.md`](../README.md) for the overview and
[`../CLAUDE.md`](../CLAUDE.md) (kept in sync with [`../AGENTS.md`](../AGENTS.md)) for the
authoritative description of the repository, architecture and development principles.
[`../OpenScience/AGENTS.md`](../OpenScience/AGENTS.md) holds the rules for the production
subtree.

Many documents were written during the build and are dated; several are in Chinese, which the
list marks as (zh). When a dated document disagrees with `AGENTS.md`, `CLAUDE.md` or the code,
the newest decision wins and the code is the final word.

## Product, design and operations: `OpenScience/docs/`

| Document | What it is |
|---|---|
| [`PRD.md`](../OpenScience/docs/PRD.md) | Product requirements. The v0.1 product definition from the desktop era; read it for product intent, and note its header on what has since changed. |
| [`TECHNICAL_DESIGN.md`](../OpenScience/docs/TECHNICAL_DESIGN.md) | Technical design. Section 5 (agent runtime) and the repository structure are current; the rest still describes the retired desktop shell. |
| [`REQUEST_PATH.md`](../OpenScience/docs/REQUEST_PATH.md) | One request end to end, with timeouts and the places a failure leaves no trace (zh). Its header lists which parts predate the kernel change. |
| [`SAAS_PRODUCT_ALIGNMENT.md`](../OpenScience/docs/SAAS_PRODUCT_ALIGNMENT.md) | The boundary between the implemented hosted product and claims that need further evidence; deployment profiles. |
| [`WEB_DEPLOYMENT.md`](../OpenScience/docs/WEB_DEPLOYMENT.md) | Hosted deployment: Compose stacks, authentication, OIDC, backup and restore. |
| [`WEB_OPERATIONS_RUNBOOK.md`](../OpenScience/docs/WEB_OPERATIONS_RUNBOOK.md) | Operating a hosted deployment: release switch, alerts, secret rotation, recovery. |
| [`WEB_PRIVACY_AND_COMPLIANCE.md`](../OpenScience/docs/WEB_PRIVACY_AND_COMPLIANCE.md) | Data handling, retention and the third-party license checklist for the hosted image. |
| [`WEB_SECURITY_INCIDENT_RESPONSE.md`](../OpenScience/docs/WEB_SECURITY_INCIDENT_RESPONSE.md) | Incident response for security, tenant-isolation and credential incidents. |
| [`EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md`](../OpenScience/docs/EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md) | Release and delivery checklist (zh). An archival snapshot; its header says which parts are superseded. |
| [`DRUG_EVIDENCE_AGENT_ARCHITECTURE.md`](../OpenScience/docs/DRUG_EVIDENCE_AGENT_ARCHITECTURE.md) | The shared evidence workflow behind drug selection, off-label use and comprehensive evaluation. |
| [`AGENT_MEMORY_API.md`](../OpenScience/docs/AGENT_MEMORY_API.md) | Reading and writing an account's research memory from another agent: HTTP API and MCP adapter. |
| [`CONNECT_YOUR_TOOLS.md`](../OpenScience/docs/CONNECT_YOUR_TOOLS.md) | Adding MCP servers and skills. Written in the desktop era; check the code before relying on its UI wording. |
| [`REQUIREMENTS.md`](../OpenScience/docs/REQUIREMENTS.md) | Community-informed prioritized requirements from the project's early research phase. Historical. |
| [`WEB_DEPLOYMENT_READINESS_REPORT.md`](../OpenScience/docs/WEB_DEPLOYMENT_READINESS_REPORT.md), [`RELEASE_REVIEW_ISSUES_2026-09-14.md`](../OpenScience/docs/RELEASE_REVIEW_ISSUES_2026-09-14.md) | Dated readiness and release-review snapshots. Historical. |
| [`2026-10-07-rename-strings.md`](../OpenScience/docs/2026-10-07-rename-strings.md) | The module renames of 2026-10-07 (循证 GEO, 虚拟临床研究) and where the names appear. |
| [`DESIGN.md`](../OpenScience/DESIGN.md) | The design system: tokens, the generated artifacts and the page structure. |

The frontier feed (前沿动态) as built is described in
[`FRONTIER_FEED_TECHNICAL_DESIGN.md`](../OpenScience/docs/FRONTIER_FEED_TECHNICAL_DESIGN.md) (zh); the plan it
was built from is
[`2026-09-21-frontier-feed-medical-aihot-plan.md`](superpowers/specs/2026-09-21-frontier-feed-medical-aihot-plan.md)
(zh).

## Design specs and plans: `docs/superpowers/`

Design specs and implementation plans, dated and kept as the historical record. Newer decisions
supersede older ones; where a spec names a retired part of the system (for example the earlier
OpenCode kernel) read it in the past tense.

- [`specs/`](superpowers/specs): design specs. The ones to read first:
  - [DSH plug-harness architecture](superpowers/specs/2026-08-22-evimed-dsh-plug-harness-design.md)
    (zh), the authoritative record of the kernel and socket decisions.
  - [Architecture overview](superpowers/specs/2026-08-26-evimed-architecture-overview.md) (zh) and
    [architecture, flows and algorithms](superpowers/specs/2026-09-20-evimed-architecture-and-algorithms.md)
    (zh).
  - [DSH ecosystem adoption and the extension center](superpowers/specs/2026-10-01-dsh-ecosystem-and-extension-center-design.md).
  - [Platform base design](superpowers/specs/2026-07-16-evimed-openscience-platform-design.md) (zh).
  - Virtual clinical research (虚拟临床研究): the
    [platform plan](superpowers/specs/2026-09-28-EviMed虚拟临研平台方案.md) (zh),
    [build contract](superpowers/specs/2026-09-28-vcr-build-contract.md),
    [integration contract](superpowers/specs/2026-09-29-vcr-integration-contract.md) and
    [status and gaps](superpowers/specs/2026-09-30-vcr-status-and-gaps.md) (all zh).
  - [Frontier feed plan](superpowers/specs/2026-09-21-frontier-feed-medical-aihot-plan.md) (zh).
  - [Review and research-topic quality](superpowers/specs/2026-09-05-review-topic-quality-design.md)
    and the [dataset-research-scoping skill](superpowers/specs/dataset-research-scoping-skill.md)
    (zh).
- [`plans/`](superpowers/plans): implementation plans and to-do lists, for example the
  [development principles](superpowers/plans/2026-08-29-development-principles-and-text-output-todo.md)
  (zh), the [DSH ecosystem shortlist](superpowers/plans/2026-08-24-dsh-ecosystem-adoption-shortlist.md)
  (zh), the [tiered review plan](superpowers/plans/2026-09-22-tiered-review-and-repair-plan.md) (zh),
  the [next-stage workbench plan](superpowers/plans/2026-10-02-evimed-next-stage-research-workbench.md),
  the [evidence flywheel](superpowers/plans/2026-10-05-evidence-flywheel.md) (zh) and
  [research evolution 2.0](superpowers/plans/2026-10-06-research-evolution-2.md) (zh).

## UI and UX audits: `docs/ui-ux-audit/`

Frontend audits and design notes (zh; the captures of the live walk-throughs are not distributed), from the first research report
to the latest design reference. Start with
[`2026-10-08-evimed-design-reference.md`](ui-ux-audit/2026-10-08-evimed-design-reference.md);
the earlier reports are listed in [`ui-ux-audit/`](ui-ux-audit). The design system itself is in
[`../OpenScience/DESIGN.md`](../OpenScience/DESIGN.md).

## Other notes

- [`geo/`](geo): run reports from evaluating the GEO method pack (zh).
- [`ops/`](ops): an operations provenance note (zh).

## API specifications: `接口文档/`

Markdown specifications for shared capabilities (zh):

- [`EviMed医学证据检索.md`](../接口文档/EviMed医学证据检索.md): evidence retrieval API.
- [`指南检索.md`](../接口文档/指南检索.md): guideline retrieval, a short companion to the evidence
  retrieval spec.
- [`多模态文档解析.md`](../接口文档/多模态文档解析.md): document structure parsing.
- [`EviMed对外接口文档-v2.md`](../接口文档/EviMed对外接口文档-v2.md): external API reference, v2.

The contract tests and golden fixtures of each tracked upstream dependency (one directory per pin
in `deps-version.json`) live in
[`OpenScience/packages/contracts/`](../OpenScience/packages/contracts/README.md).

## Component READMEs

| Component | README |
|---|---|
| Production system | [`OpenScience/README.md`](../OpenScience/README.md) ([简体中文](../OpenScience/README.zh.md)) |
| Web app | [`OpenScience/apps/web/README.md`](../OpenScience/apps/web/README.md) |
| Control plane | [`OpenScience/apps/server/README.md`](../OpenScience/apps/server/README.md) |
| Upstream contracts | [`OpenScience/packages/contracts/README.md`](../OpenScience/packages/contracts/README.md) |
| Runtime MCP servers | [`OpenScience/runtime/mcp/README.md`](../OpenScience/runtime/mcp/README.md) |
| Runtime skill libraries | [`OpenScience/runtime/skills/README.md`](../OpenScience/runtime/skills/README.md) |
| Scripts | [`OpenScience/scripts/README.md`](../OpenScience/scripts/README.md) |
| Examples | [`bci-trends`](../OpenScience/examples/bci-trends/README.md), [`climate-trends`](../OpenScience/examples/climate-trends/README.md) |
| Meta-analysis agent | [`项目代码/meta/README.md`](../项目代码/meta/README.md) |
| Mendelian randomization | [`项目代码/孟德尔随机化/README.md`](../项目代码/孟德尔随机化/README.md) |
| Peer review | [`项目代码/论文审稿/README.md`](../项目代码/论文审稿/README.md) |
| Research-topic selection | [`项目代码/科研选题/README.md`](../项目代码/科研选题/README.md) |
| Drug-safety analysis | [`项目代码/药物安全分析agent/README.md`](../项目代码/药物安全分析agent/README.md) |
| Bibliometric analysis | [`项目代码/文献剂量分析/CLAUDE.md`](../项目代码/文献剂量分析/CLAUDE.md) (no README) |
| Virtual clinical research engine | [`项目代码/vcr-engine/README.md`](../项目代码/vcr-engine/README.md) |
| Knowledge-source plugin | [`项目代码/knowledge-plugin/README.md`](../项目代码/knowledge-plugin/README.md) |
