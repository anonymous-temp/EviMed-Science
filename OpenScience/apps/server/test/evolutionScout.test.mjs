import test from "node:test";
import assert from "node:assert/strict";
import { createEvolutionScout, measureEvolutionLiterature, evolutionPriority, evolutionToolGraph, evolutionResearchEligibility } from "../src/evolutionScout.mjs";

test("evolution demand uses observed primary-index counts in an explicit rolling window", async () => {
  let requested;
  const result = await measureEvolutionLiterature({ rankingFeatures: { literature24Months: 999999, literatureQuery: '"cohort state-transition"' } }, {
    now: new Date("2026-10-04T09:00:00Z"), fetchImpl: async url => {
      requested = new URL(url);
      return new Response(JSON.stringify({ hitCount: 68, resultList: { result: [{ source: "MED", id: "12345", title: "Primary study", doi: "10.1000/example" }, { source: "PPR", id: "987" }] } }));
    },
  });
  assert.equal(result.count, 68);
  assert.equal(result.papers.length, 1);
  assert.equal(requested.origin, "https://www.ebi.ac.uk");
  assert.match(requested.searchParams.get("query"), /FIRST_PDATE:\[2024-10-04 TO 2026-10-04\]/);
  assert.match(result.responseHash, /^[a-f0-9]{64}$/);
});

test("an absent or unavailable observation never adopts a model's demand claim", async () => {
  const missing = await measureEvolutionLiterature({ rankingFeatures: { literature24Months: 100 } }, { now: new Date() });
  assert.equal(missing.verified, false);
  const failed = await measureEvolutionLiterature({ rankingFeatures: { literatureQuery: "x", literature24Months: 100 } }, {
    now: new Date(), fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });
  assert.equal(failed.verified, false);
  assert.equal(failed.count, undefined);
  assert.ok(evolutionPriority({ literature24Months: 100, reachableData: true }) > evolutionPriority({ literature24Months: 2 }));
});

test("scouting preserves the full shipped graph inventory without repeating every tool schema", async () => {
  const inventory = await evolutionToolGraph();
  assert.ok(inventory.some(item => item.capability === "statistical-analysis"));
  assert.ok(inventory.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.ok(inventory.every(item => item.nodes.every(node => !Object.hasOwn(node, "inputSchema"))));
});

test("only the first tool requires two published examples; later independent simulation and workflow routes remain reachable", () => {
  const input = { card: { track: "M", toolKind: "calculation" }, features: { coverageGap: true, unresolvedDependencies: 0, reachableData: false, publishedExamples: 0, literature24Months: 12 },
    reference: { noPublishedExamples: true, simulationReady: true }, firstTool: true };
  assert.equal(evolutionResearchEligibility(input).eligible, false);
  assert.equal(evolutionResearchEligibility({ ...input, firstTool: false }).route, "simulation");
  assert.equal(evolutionResearchEligibility({ ...input, firstTool: false, card: { track: "T" } }).eligible, true);
  assert.equal(evolutionResearchEligibility({ ...input, firstTool: false, card: { track: "X", toolKind: "calculation" } }).eligible, false);
  assert.equal(evolutionResearchEligibility({ ...input, firstTool: false, card: { track: "X", toolKind: "workflow" }, reference: { workflowSmokeReady: true } }).route, "workflow");
  assert.equal(evolutionResearchEligibility({ ...input, firstTool: false, reference: {} }).eligible, false);
  assert.equal(evolutionResearchEligibility({ ...input, firstTool: false, features: { ...input.features, unresolvedDependencies: 1 } }).eligible, false);
});

test("an already completed scout can recover missing structural fields once without repeating its research", async () => {
  const rows = new Map(); let normalizations = 0, executions = 0;
  const card = { methodId: "new-method", goal: "Reusable calculation", track: "M", capabilityIds: ["statistical-analysis"], toolKind: "calculation", feasibility: {}, rankingFeatures: { literature24Months: { proposed: 9999 } }, waitingAgendaIds: ["invented"] };
  const service = { now: () => new Date("2026-10-04T12:00:00Z"), owner: async () => "operator", get: async id => rows.get(id),
    list: async () => [], tools: async () => [], callbacks: {},
    save: async (_kind, id, payload) => { const row = { id, payload }; rows.set(id, row); return row; },
    addDossier: async payload => service.save("dossier", payload.id, { ...payload, status: "planned" }),
    dossiers: async () => [...rows.values()].filter(row => row.payload.methodId), queueBuild: async () => {} };
  const scout = createEvolutionScout({ config: { evolutionDependencyAllowlist: [] }, service, registry: Promise.resolve({ list: () => [] }), decisions: { propose: async () => {} },
    runs: { execute: async () => { executions++; return { run: { id: "durable-run" }, output: structuredClone(card) }; } },
    normalizeFeatures: async () => { normalizations++; return { literatureQuery: "the named method", implementationMissing: true, reason: "The supplied inventory has no implementation." }; },
    references: async () => ({ ok: true, publicInputCount: 2, publishedReferenceCount: 2, independentImplementation: true }),
    fetchImpl: async () => new Response(JSON.stringify({ hitCount: 12, resultList: { result: [] } })) });
  const first = await scout.scout({}, { job: { id: "job" } });
  await scout.scout({}, { job: { id: "job" } });
  assert.equal(executions, 2); assert.equal(normalizations, 1);
  const dossier = rows.get(first.dossierId).payload;
  assert.equal(dossier.eligibility.eligible, true); assert.equal(dossier.rankingFeatures.literature24Months, 12);
  assert.deepEqual(dossier.waitingAgendaIds, []);
});

test('J11 semantic coverage recognizes an existing method without allowing invented inventory IDs', async () => {
  for (const matchedId of ['existing-method', 'invented-method', null]) {
    const rows = new Map();
    const tools = [{ id: 'existing-tool', payload: { methodId: 'existing-method', status: 'active', name: 'Equivalent method', description: 'Reusable estimator' } }];
    const service = { now: () => new Date('2026-10-04T12:00:00Z'), owner: async () => 'operator', get: async id => rows.get(id), list: async () => [], tools: async () => tools, callbacks: {},
      save: async (_kind, id, payload) => { const row = { id, payload }; rows.set(id, row); return row; }, addDossier: async payload => service.save('dossier', payload.id, { ...payload, status: 'planned' }),
      dossiers: async () => [...rows.values()].filter(row => row.payload.methodId), queueBuild: async () => {} };
    const scout = createEvolutionScout({ config: { evolutionDependencyAllowlist: [] }, service, registry: Promise.resolve({ list: () => [] }), decisions: { propose: async () => {} },
      runs: { execute: async () => ({ run: { id: 'scout-run' }, output: { methodId: 'alias-method', goal: 'Reusable estimator', track: 'M', capabilityIds: ['statistical-analysis'], feasibility: { implementationMissing: true }, rankingFeatures: { literatureQuery: 'estimator' } } }) },
      references: async () => ({ ok: true, publicInputCount: 2, publishedReferenceCount: 2, independentImplementation: true }), fetchImpl: async () => new Response(JSON.stringify({ hitCount: 12, resultList: { result: [] } })),
      judgeService: { judge: async (site, input) => { assert.equal(site, 'J11'); assert.ok(input.methods.some(item => item.id === 'existing-method')); return { outcome: 'settled', value: { methodId: matchedId } }; } } });
    const result = await scout.scout({}, { job: { id: 'job' } });
    assert.equal(rows.get(result.dossierId).payload.rankingFeatures.coverageGap, matchedId !== 'existing-method');
  }
});
