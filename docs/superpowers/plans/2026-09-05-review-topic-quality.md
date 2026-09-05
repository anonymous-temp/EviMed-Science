# Review and Research Topic Optimization Implementation Plan

> For agentic workers: use subagent-driven-development for the independent topic task, followed by specification and code-quality review. The root agent owns review methods and integration. Keep file ownership disjoint.

**Goal:** Make reviews methodologically transparent and topic recommendations constrained, traceable and executable within the existing DSH capability architecture.

**Architecture:** Extend the existing search ledger and topic tool contract, retain shared domain validation and deterministic Python execution, and preserve backward compatibility. New scientific findings are advisory; no new hard blocking points.

**Tech Stack:** Node ESM/JSDoc, Python, existing YAML capability projections, node:test and pytest.

## Task 1 — Clinical review methods and study accounting (root)

Files: create OpenScience/packages/domain/src/reviewMethods.mjs and test/reviewMethods.test.mjs; modify src/clinicalEvidence.mjs and the small clinical metrics projection in src/contractRegistry.mjs; extend the clinical capability manifest/skill and its existing copies; add OpenScience/evals/clinical-review-quality/briefs.json.

- [ ] Write and execute tests before code, including:
~~~js
const output = reviewMethodsFindings({
  queries: [{database: 'PubMed', query: 'trial question'}],
  sourceRecords: [
    {referenceNumber: 1, identifier: 'PMID 100001', included: true, accessLevel: 'full_text'},
    {referenceNumber: 2, identifier: 'PMID 100002', included: true, accessLevel: 'full_text'}
  ],
  reviewMethods: {
    schemaVersion: 1, reviewType: 'systematic',
    eligibility: {inclusionCriteria: ['Randomized trials'], exclusionCriteria: ['Protocols without results']},
    protocol: {status: 'unregistered', deviations: []},
    searchCoverage: [{domain: 'intervention effects', status: 'searched', queryIndexes: [0]}],
    studyGroups: [{studyId: 'NCT00000001', evidenceType: 'primary', referenceNumbers: [1, 2]}]
  }
});
assert.equal(output.metrics.includedReports, 2);
assert.equal(output.metrics.independentPrimaryStudies, 1);
~~~
- [ ] Verify intended RED through existing runGate before adding the helper, then commit the test checkpoint.
- [ ] Implement pure reviewMethodsFindings(searchLog), returning issues and deterministic metrics. Validate only the declared structured vocabulary, reference identity and relationships.
- [ ] Integrate findings inside validateClinicalEvidencePackage; preserve original blockingIssues, append attributed advisory findings, and project metrics into runGate.
- [ ] Teach the capability to populate the optional ledger extension, distinguish review types and preserve study-family evidence; regenerate manifests.
- [ ] Run domain and clinical single-implementation tests, lint/checkJs; commit GREEN.

## Task 2 — Constrained research-topic planning (one implementer)

Files: OpenScience/capabilities/research-topic-selection and its skill copies; runtime/mcp/evimed-research/server.py and specialist_jobs.py plus relevant tests; deploy/specialist-adapter service and tests; 项目代码/科研选题 task/model/module/prompt/runner files and tests; add research-topic-quality briefs. Do not edit domain or clinical-review files.

- [ ] Add executed RED tests showing optional availableData, population, studySetting and resourceConstraints are lost in both job transports and task planning.
- [ ] Preserve optional fields through the transport allowlists and a bounded schema; reject malformed structured values while leaving scientific prose open.
- [ ] Persist constraints in task options/state, carry them into standardized_input.research_context and M5/M6 model context, and keep the original retrieval direction separate.
- [ ] Write research-portfolio.json from validated M6 candidates with traceable sources and explicit missing-design/novelty/feasibility gaps; do not invent numerical feasibility or sample size.
- [ ] Ensure final reports receive the same resource assumptions and include the portfolio artifact in the result receipt.
- [ ] Replace stale host/source claims and source-count quota requirements in the owned topic skill/preflight with current-response and coverage-based instructions; keep all preflight copies aligned.
- [ ] Run Python grounding/failure/transport regressions and commit RED/GREEN stages, owned files only.

## Task 3 — Integration and qualification (root after task reviews)

- [ ] Review specification compliance, then independent Python and JavaScript code quality; fix actionable findings.
- [ ] Run build:capabilities/check:capabilities and copy-consistency checks.
- [ ] Run domain, MCP, specialist-adapter, topic Python and affected clinical/server suites.
- [ ] Run lint/typecheck relevant packages and source-secret audit before commits.
- [ ] Execute realistic review/topic briefs or replay preserved real source snapshots, clearly separating live model results from deterministic fixtures.
- [ ] Record checks, limitations and final commits in PROGRESS.md and hand commits to the parallel release owner. No independent production deployment.

