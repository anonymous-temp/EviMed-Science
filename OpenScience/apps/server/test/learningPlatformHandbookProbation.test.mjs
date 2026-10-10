// A lesson on probation is served to a sample of dispatches so that the evolution module can see it (review L-6, owner ruling of 2026-10-10). This composes the real
// evolution module over in-memory records and hands its `onExecution` to the platform-handbook path the way the server does, to show what no unit double can: that a
// served dispatch is a use of the entry's tool, that the researcher's feedback on that run reaches the tool's sequential harm test, and that a dispatch which was not
// served leaves no trace in either. Doubles only: no database, no model, no runtime.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createEvolution } from "../src/evolutionComposition.mjs";
import { EVOLUTION_CONFIG_SCHEMA } from "../src/evolutionConfiguration.mjs";
import { createPlatformHandbooks } from "../src/learningPlatformHandbooks.mjs";

const LESSON = {
  frontmatter: { name: "denominator-check", description: "Check study denominators when summarizing preserved research results." },
  body: ["## Purpose", "Keep every denominator tied to the preserved source before stating a proportion.", "## Workflow", "Name the population each count refers to, and say so when the source gives none."].join("\n"),
  contentDigest: "sha256:aaaa",
};
const NOW = new Date("2026-10-10T04:00:00Z");

/** In-memory records with the ledger's contract: owner and kind scoped, revision-checked, filtered by payload fields. */
function memoryDocuments() {
  /** @type {Map<string, any>} */ const rows = new Map();
  return {
    rows,
    async get(/** @type {string} */ owner, /** @type {string} */ kind, /** @type {string} */ id) { return structuredClone(rows.get(`${owner}:${kind}:${id}`) ?? null); },
    async list(/** @type {string} */ owner, /** @type {string} */ kind, /** @type {any} */ { filter = {} } = {}) {
      return { items: [...rows.entries()].filter(([key, row]) => key.startsWith(`${owner}:${kind}:`) && Object.entries(filter).every(([name, value]) => row.payload[name] === value)).map(([, row]) => structuredClone(row)), nextCursor: null };
    },
    async put(/** @type {string} */ owner, /** @type {string} */ kind, /** @type {string} */ id, /** @type {any} */ payload, /** @type {any} */ { expectedRevision, projectId }) {
      const key = `${owner}:${kind}:${id}`;
      const old = rows.get(key);
      if ((old?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error("conflict"), { code: "product_revision_conflict" });
      const row = { id, payload: structuredClone(payload), projectId, revision: expectedRevision + 1, createdAt: old?.createdAt ?? NOW.toISOString(), updatedAt: NOW.toISOString() };
      rows.set(key, row);
      return structuredClone(row);
    },
  };
}

/** The evolution module, composed for real over in-memory records, with the platform-handbook path joined to it as `server.mjs` joins them. @param {Record<string, any>} [over] */
async function compose(over = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "probation-"));
  const documents = memoryDocuments();
  /** @type {any[]} */ const runs = [];
  const config = { ...Object.fromEntries(Object.entries(EVOLUTION_CONFIG_SCHEMA).map(([key, field]) => [key, field.default])), evolutionEnabled: true, dataDir, operatorUsers: ["operator"], frontierEnabled: false, evolutionDependencyAllowlist: [] };
  const store = {
    userById: async (/** @type {string} */ id) => ({ id }),
    projectFor: async (/** @type {any} */ user, /** @type {string} */ id) => ({ id, userId: user.id }),
    requireProject: async (/** @type {any} */ user, /** @type {string} */ id) => ({ id, userId: user.id }),
  };
  const evolution = createEvolution({ config, database: {}, documents, jobs: { enqueue: async () => ({}) }, usageLedger: {}, store, runtimeManager: {}, registry: Promise.resolve({}), controller: {},
    agentRuns: { list: async () => runs }, evaluationIsolation: {}, autopilot: {}, dataSemantics: {} });
  assert.ok(evolution, "the evolution module is composed");
  const handbooks = createPlatformHandbooks({
    service: evolution.service, supply: evolution.supply, now: () => NOW, facts: async () => ({}),
    judge: async () => ({ general: true, class: "numbers-and-tables" }), review: async () => ({ independent: true, general: true, class: "numbers-and-tables" }),
    established: async () => new Set(["senior-1"]), probationShare: 1, served: (/** @type {any} */ event) => evolution.onExecution(event), ...over,
  });
  await handbooks.consider({ userId: "senior-1", capabilityId: "meta-analysis", handbookId: "h-1", handbook: LESSON, sourceProjectId: "p-senior-1", runId: "r-senior-1" });
  await handbooks.tick();
  const [entry] = [...documents.rows.values()].filter((row) => row.payload.recordType === "evolution-handbook-candidate");
  assert.equal(entry.payload.status, "probation");
  /** A researcher's run, in the ledger the module reads. @param {string} account */
  const run = (account) => { const row = { id: `run-${account}`, effectiveAgentId: "meta-analysis", status: "running" }; runs.push(row); return row; };
  return { evolution, handbooks, documents, entry, run, dispatch: (/** @type {string} */ account) => handbooks.probationFor({ userId: account, projectId: `project-${account}`, runId: `run-${account}`, capabilityId: "meta-analysis" }),
    toolRecord: async () => (await evolution.service.get(entry.payload.toolId)).payload, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

test("a dispatch served the entry on probation is a use of its tool: the run is recorded as the researcher's own, and the tool's record counts one invocation", async () => {
  const f = await compose();
  try {
    f.run("u1");
    const served = await f.dispatch("u1");
    assert.equal(served?.entryId, f.entry.id);
    const uses = await f.evolution.service.list("use", "u1", { runId: "run-u1" });
    assert.equal(uses.length, 1);
    assert.deepEqual([uses[0].payload.toolId, uses[0].payload.researcherOwned, uses[0].payload.evaluation, uses[0].projectId], [f.entry.payload.toolId, true, false, "project-u1"]);
    assert.equal((await f.evolution.maintenance.observationOf(f.entry.payload.toolId, "run-u1")).invoked, true);
    assert.equal((await f.toolRecord()).usage.invoked, 1);
    // Asking about the same dispatch again is the same exposure, not a second one.
    assert.equal((await f.dispatch("u1"))?.entryId, f.entry.id);
    assert.equal((await f.evolution.service.list("use", "u1", { runId: "run-u1" })).length, 1);
    assert.equal((await f.toolRecord()).usage.invoked, 1);
  } finally { await f.cleanup(); }
});

test("what the researcher does with a served run reaches the tool's sequential harm test: a result corrected as wrong is a bad trial, one trial per account, and enough of them read as harm", async () => {
  const f = await compose();
  try {
    // Four, because the test reads nothing before its fourth trial (`EVOLUTION_TOOL_HARM_TEST.minRuns`).
    for (const [index, account] of ["u1", "u2", "u3", "u4"].entries()) {
      f.run(account);
      assert.ok(await f.dispatch(account));
      const result = await f.evolution.observeFeedback({ id: `feedback-${account}`, userId: account, projectId: `project-${account}`, runId: `run-${account}`,
        trigger: "result-corrected", detail: { kind: "analytic" }, occurredAt: new Date(NOW.getTime() + (index + 1) * 60_000).toISOString() });
      assert.deepEqual(result, { observed: 1 }, account);
    }
    const usage = (await f.toolRecord()).usage;
    assert.deepEqual([usage.invoked, usage.corrected], [4, 4]);
    // An ordinary edit of a deliverable is work, not harm: the test's own definition, which is why it is not the trigger here.
    assert.deepEqual([usage.harm.runs, usage.harm.bad, usage.harm.state], [4, 4, "harm"]);
    // The verdict proposes a review, as for any platform tool; it is not itself a retirement.
    const reviews = [...f.documents.rows.values()].filter((row) => row.payload.recordType === "evolution-maintenance-review");
    assert.equal(reviews.length, 1);
    assert.equal((await f.toolRecord()).status, "staged");
  } finally { await f.cleanup(); }
});

test("a run that was not served is no trial of the entry: its feedback finds no use of the tool and the harm test reads nothing", async () => {
  const f = await compose({ probationShare: 0 });
  try {
    f.run("u1");
    assert.equal(await f.dispatch("u1"), null);
    assert.deepEqual(await f.evolution.service.list("use", "u1", { runId: "run-u1" }), []);
    const result = await f.evolution.observeFeedback({ id: "feedback-u1", userId: "u1", projectId: "project-u1", runId: "run-u1", trigger: "result-corrected", detail: { kind: "analytic" }, occurredAt: NOW.toISOString() });
    assert.equal(result.observed, 0);
    assert.equal((await f.toolRecord()).usage?.invoked ?? 0, 0);
  } finally { await f.cleanup(); }
});

test("a harness's run, if it were asked about anyway, is recorded as an evaluation's and counts for nothing: the context layer does not ask, and the module would not learn from it", async () => {
  const f = await compose();
  try {
    const harness = f.run("u1");
    Object.assign(harness, { automated: true });
    // The context layer does not ask for a harness's run (`ownedResearchContext.test.mjs`); asked anyway, the exposure is an evaluation's.
    assert.ok(await f.dispatch("u1"));
    const [use] = await f.evolution.service.list("use", "u1", { runId: "run-u1" });
    assert.deepEqual([use.payload.researcherOwned, use.payload.evaluation], [false, true]);
    assert.equal((await f.toolRecord()).usage?.invoked ?? 0, 0);
  } finally { await f.cleanup(); }
});

test("the server joins the two: the probation share and the recorder are handed to the platform-handbook path, and the context layer asks it by name for a dispatch's entry", async () => {
  const source = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.mjs"), "utf8");
  assert.match(source, /probationShare: config\.learningPlatformHandbooksProbationShare, served: event => evolution\.onExecution\(event\)/);
  assert.match(source, /platformTrial: \(\{ project, run, capabilityId, fits \}\) => platformHandbooks\?\.probationFor\(\{ userId: project\.userId, projectId: project\.id, runId: run\.id, capabilityId, fits \}\) \?\? null/);
});
