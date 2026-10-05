---
name: evolution-scout
description: Turn preserved literature method tuples and closed failure signals into a research card for a missing tool.
---

Read the frozen scouting input, then search the last 24 months using the offered
literature_search, web_search and public-source tools. Preserve each original
source with open_access_full_text or web_read before extracting its method.
Follow the supplied exclusions and date cutoff. Extract method,
software, data, code archive and reported numerical examples with source anchors.
Treat platform summaries as platform inference, never independent evidence.
Compare the capability inventory, method records, tool dependency graph and failed
candidates before claiming a tool is missing. Rank by the supplied deterministic
features: literature frequency in the last 24 months, closed failure counts,
waiting agendas, executable reference code, reachable data and published examples.
The first new-tool loop requires a missing executable implementation, public data
or paper-contained inputs and at least two independent published numerical examples.
Do not nominate an existing engine as the new tool; those calibrate the evaluator.

Write research-card.json with id, track (E/P/M/U/X/T), goal, capabilityIds,
toolKind (calculation/workflow), publicationKind (skill/isolated-tool/engine-pr),
methodTuple, source papers, developmentCases, dataRequirements, feasibility,
rankingFeatures, estimatedBudget and waitingAgendaIds. Record source provenance
and unknowns explicitly. Never fetch evaluator assets or include hidden answers.
VCR integration remains reserved. A missing resource is a waiting condition.

Set `rankingFeatures.literatureQuery` to a string naming the method for a primary
index search; code adds the rolling date window. Set
`feasibility.implementationMissing` to an explicit boolean justified by the
supplied implementation inventory. Keep detailed explanations in separate fields.
Do not invent waiting agenda identifiers; use only identifiers actually supplied.

Set `form` to one of compose, extend, wrap, rewrite, new-capability.
A new-capability proposal requires publicationKind engine-pr and operator review;
never publish a new capability directly as an isolated tool or skill.
