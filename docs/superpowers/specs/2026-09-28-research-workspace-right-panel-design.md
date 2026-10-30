# Native DSH Right Panel: Minimal EviMed Plan

Date: 2026-09-28
Status: Revised proposal. This replaces the earlier, over-scoped workspace construction plan following explicit user feedback. No product code or deployment changed.
Baseline: DSH 0.1.7-rc.2, reported by the user as deployed. Follow upstream native panel behavior as the kernel evolves; a kernel upgrade is a separate decision.

## Decision

Use DSH's native right panel directly: its file tree, document tabs, previews, browser, resize, collapse and fullscreen behavior. Add no new default Results page, permanent Evidence/Activity tabs, layout controller, version system or research dashboard.

First verify and connect what DSH already provides. It is acceptable to add no scientific UI at all if the native experience covers the actual files researchers use.

## Required work

1. Exercise the deployed native panel with a real Markdown report containing a figure, a PDF paper, a CSV/XLSX evidence table and a generated PNG/SVG figure. Also check DOCX/PPTX when the deployed conversion provider exists.
2. Make ordinary file links and file cards open through the existing native document preview where appropriate. Preserve the current EviMed-specific report reader when its citation/checking behavior is needed; keep its entry available rather than rebuilding that reader inside DSH as part of this change.
3. Fix only confirmed integration gaps: disabled/missing preview providers, broken resource links, unreadable files or duplicate panel ownership. Retain native tabs, opening behavior and layout controls.
4. Leave unsupported formats with the existing download/open fallback. Preview support is not full Office editing or spreadsheet recalculation.

Acceptance: the representative report, paper, table and figure can be opened and read in the native right panel beside the conversation. A failure should result in a small targeted fix, not a new application layer.

## Small optional scientific additions

| Candidate | Value | Decision |
| --- | --- | --- |
| Generation-history action on a generated figure or table | Inspect existing generating code, input references or associated conversation | Best small addition, but only when the hosted system already stores usable provenance and the existing viewer can expose it with a thin integration. Otherwise defer. |
| A specialized scientific file renderer | Inspect a molecule or other domain file without downloading | Reuse an existing EviMed/Open Science renderer only when a real supported workflow needs it; register it in the native viewer extension point. No universal format expansion. |
| Selection/figure annotation | Ask for a precise change to the viewed content | Use an already working native/plugin capability if available. Current text-annotation support does not prove figure-preview annotation support. Do not build a new annotation/version subsystem for this scope. |

These are alternatives to evaluate, not three mandatory work packages. Prefer zero additions initially; if adding one, choose the generation-history action with real data behind it. Do not build a provenance pipeline just to populate that button.

## What the comparison supports

- Claude Science documents scientific-format renderers, artifact provenance, and annotations for iterative changes. These are useful local capabilities around the viewed file; its compute, reviewer and environment systems are not right-panel requirements for EviMed.
- Open Science here means the public ai4s-research/open-science workbench. It lists standard previews, CSV/TSV charts, scientific viewers and provenance. Its README explicitly distinguishes desktop and headless provenance coverage, so do not assume its desktop history system transfers directly to hosted EviMed.
- DSH 0.1.7-rc.2 already handles ordinary research documents, PDFs, images, HTML and spreadsheets. Its native Office preview uses conversion and its spreadsheet viewer has read-only limitations.
- Inspected EviMed source already contains ProvenancePanel, MoleculeView and other scientific viewers. These are reuse candidates, not proof that all are connected to the production DSH panel. Notebook support was removed from the inspected current file inspector; restoring a notebook platform is outside this change.

## Implementation scope

Use the existing harness-port integration for DSH-specific resource navigation or a narrowly scoped native viewer extension. Keep host file authorization and current research/evidence behavior intact. No community aggregate UI suite is required. No new database, broad evidence bridge, independent panel shell or second navigation system is part of this plan.

Implement on the current integration branch after checking its actual deployed composition. The older local checkout is not the implementation baseline. This document specifies the direction; it does not assert that production preview checks have already passed.

## Sources

- [DSH native document preview at the deployed baseline](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/packages/client/ui-sidebar-documentpreview/README.md)
- [Claude Science](https://claude.com/product/claude-science)
- [Claude Science artifact tabs and provenance](https://claude.com/docs/claude-science/artifacts)
- [Claude Science lightweight comments](https://claude.com/docs/claude-science/comments)
- [Open Science repository](https://github.com/ai4s-research/open-science)
- [Prior research and scope correction](../../../_knowledge_base/research-agent-workspace-panels-20260928.md)
