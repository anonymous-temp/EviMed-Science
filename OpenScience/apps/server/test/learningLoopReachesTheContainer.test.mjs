/**
 * The chain, end to end, through the wiring production uses.
 *
 * Every part of this loop had unit tests and passed them, and the loop did not
 * run: `selectLearnedMethods` had no caller outside its own test, the nightly
 * pass returned before promotion whenever a user held one method, and a run's
 * use of a method was written nowhere. Green suites, one dead loop — the
 * difference between "each part is correct" and "the parts are connected",
 * which is the whole reason this file calls no selector directly.
 *
 * What it walks: a candidate exists → the launch path writes it into the
 * container's method directory → a finished run earns it an observation → the
 * nightly pass leaves a method that is already in force alone and queues
 * nothing → retirement removes it from the next launch. (An evaluation identity
 * used to put a candidate on trial and bind a paired verdict to its text; both
 * went on 2026-10-10, with the study they served.)
 *
 * The seams it defends, one per step, are listed on each assertion.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { METHOD_SKILL_SCHEMA, mountedMethodDigest } from "@evimed/domain";

import { materializeCapsuleMethods } from "../src/capsuleMethods.mjs";
import { LearningService } from "../src/learningService.mjs";
import { MethodConsolidation } from "../src/methodConsolidation.mjs";
import { runMethodObservations } from "../src/methodObservations.mjs";

const USER = "researcher";
const PROJECT = "project-a";
const sha256 = (/** @type {string} */ text) => createHash("sha256").update(text, "utf8").digest("hex");

const BODY = [
  "## Purpose", "Quote the source sentence before writing the number.", "",
  "## When to Use", "When a report states an effect estimate.", "",
  "## Inputs", "The retrieved evidence files.", "",
  "## Workflow", "1. Quote the sentence.", "2. Then write the number.", "",
  "## Verification", "- Every estimate has a quoted source sentence.", "",
  "## Constraints", "- Never restate a number the source does not carry.", "",
  "## Output", "The report.",
].join("\n");

const frontmatter = (/** @type {string} */ name) => ({
  name,
  description: "Quote the source sentence before writing an effect estimate.",
  whenToUse: "When a report states an effect estimate.",
  metadata: {
    role: "functional",
    applies_when: "A report states an effect estimate.",
    not_when: "The number is the analyst's own estimate.",
    derived_from: "run:run_seed",
    evimed_schema: METHOD_SKILL_SCHEMA,
  },
});

/** The product document store, with the behaviours this path depends on. */
function fakeDocuments() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {Map<string, any[]>} */
  const history = new Map();
  const key = (u, k, i) => `${u}:${k}:${i}`;
  const conflict = () => {
    const error = new Error("conflict");
    /** @type {any} */ (error).code = "product_revision_conflict";
    return error;
  };
  return {
    async put(userId, kind, id, payload, { expectedRevision, projectId = null } = {}) {
      const at = key(userId, kind, id);
      const current = rows.get(at);
      if (expectedRevision === 0 && current && !current.deletedAt) throw conflict();
      if (expectedRevision !== 0 && (!current || current.revision !== expectedRevision)) throw conflict();
      const record = current
        ? { ...current, payload, deletedAt: null, revision: current.revision + 1 }
        : { id, kind, projectId, payload, deletedAt: null, revision: 1, createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" };
      rows.set(at, record);
      history.set(at, [...(history.get(at) ?? []), { revision: record.revision, payload }]);
      return record;
    },
    async get(userId, kind, id, { includeDeleted = false } = {}) {
      const row = rows.get(key(userId, kind, id)) ?? null;
      return row && !includeDeleted && row.deletedAt ? null : row;
    },
    async remove(userId, kind, id, expectedRevision) {
      const at = key(userId, kind, id);
      const current = rows.get(at);
      if (!current || current.revision !== expectedRevision) throw conflict();
      rows.set(at, { ...current, deletedAt: "2026-09-10T00:00:00.000Z", revision: current.revision + 1 });
      return rows.get(at);
    },
    async restore(userId, kind, id, expectedRevision) {
      const at = key(userId, kind, id);
      const current = rows.get(at);
      if (!current || current.revision !== expectedRevision) throw conflict();
      rows.set(at, { ...current, deletedAt: null, revision: current.revision + 1 });
      return rows.get(at);
    },
    async list(userId, kind, { filter = {} } = {}) {
      return {
        items: [...rows.values()].filter((row) => row.kind === kind && !row.deletedAt
          && Object.entries(filter).every(([field, value]) => row.payload?.[field] === value)),
        nextCursor: null,
      };
    },
    async history(userId, kind, id) { return { items: [...(history.get(key(userId, kind, id)) ?? [])].reverse() }; },
  };
}

/**
 * The launch path, as `runtimeManager.syncCapsuleMethods` runs it: materialize
 * with the learning ledger. Written out here rather than imported so this test
 * proves the sequence and not a helper's willingness to be called.
 */
async function launch(learning, project) {
  return materializeCapsuleMethods({
    capsules: null,
    learning,
    project,
    directory: path.join(project.rootDir, "runtime", "methods"),
  });
}

/** A finished run as the observation producer reads one. */
function finishedRun(runId, method) {
  return {
    run: { id: runId },
    projection: {
      plan: { items: [{ id: "d1", status: "accepted", capability: "clinical-evidence-synthesis" }] },
      subagents: [{
        deliverableId: "d1",
        capability: "clinical-evidence-synthesis",
        status: "completed",
        methods: [{ name: method.name, digest: method.digest }],
      }],
    },
    methods: [method],
    sessions: [],
  };
}

test("a distilled method reaches a container, earns observations, is left alone by the nightly pass, and leaves when retired", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evimed-learning-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: PROJECT, userId: USER, rootDir: root, workspaceDir: path.join(root, "workspace") };
  const documents = fakeDocuments();
  /** @type {any[]} */ const enqueued = [];
  const learning = new LearningService({
    documents,
    jobs: { async enqueue(userId, kind, payload) { enqueued.push({ userId, kind, payload }); return { id: `job_${enqueued.length}` }; } },
    notifications: { async create() { return {}; } },
    now: () => new Date("2026-09-10T00:00:00.000Z"),
  });

  // --- 1. a candidate exists ------------------------------------------------
  const created = await learning.createCandidate(USER, {
    projectId: PROJECT,
    frontmatter: frontmatter("quote-before-number"),
    body: BODY,
    provenance: { origin: "distilled", runIds: ["run_seed"] },
  });
  assert.equal(created.payload.status, "approved", "a distilled method takes effect the night it is learned");
  const digest = created.payload.contentDigest;

  // --- 2. the launch path writes it into the container's directory (A1) -----
  const mounted = await launch(learning, project);
  assert.equal(mounted.count, 1, "the method did not reach the method directory");
  assert.deepEqual(Object.keys(mounted.learned[0]).sort(), ["digest", "id", "name"], "an approved method needs nothing else to get there");
  const [directoryName] = await readdir(mounted.directory);
  const written = await readFile(path.join(mounted.directory, directoryName, "SKILL.md"), "utf8");
  // The bytes the container reads are the bytes the digest names. A receipt
  // that hashes something else makes every later attribution meaningless.
  assert.equal(mounted.learned[0].digest, mountedMethodDigest(created.payload, sha256));
  assert.match(written, /Quote the source sentence before writing the number\./);

  // --- 3. a finished run earns the method an observation (A3) --------------
  const method = { id: created.id, name: "quote-before-number", digest: mounted.learned[0].digest };
  for (const runId of ["run_a", "run_b", "run_c"]) {
    const derived = runMethodObservations(finishedRun(runId, method));
    assert.equal(derived.observations.length, 1, `${runId} produced no observation for the mounted candidate`);
    for (const { methodId, observation } of derived.observations) {
      await learning.recordObservation(USER, methodId, observation);
    }
  }
  const observed = await learning.getMethod(USER, created.id);
  assert.equal(observed.payload.learning.counts.observed ?? observed.payload.learning.observations.length, 3);

  // --- 4. the nightly pass does not skip a lone method (A4) ----------------
  /** @type {string[]} */ const audited = [];
  const consolidation = new MethodConsolidation({
    dispatch: async () => { throw new Error("the chain must not dispatch a run here"); },
    readResult: async () => { throw new Error("unused"); },
    learning,
    jobs: { async enqueue(userId, kind, payload) { enqueued.push({ userId, kind, payload }); return { id: "job_e" }; } },
    notifications: { async create() { return {}; } },
    audit: async (_job, event) => { audited.push(event); },
    now: () => new Date("2026-09-10T01:00:00.000Z"),
  });
  const job = { userId: USER, projectId: PROJECT, payload: { action: "sleep" } };
  const slept = await consolidation.sleep({ job });
  assert.equal(slept.methods, 1, "the pass must see the one method rather than returning early");
  // Nothing to promote — it is already effective — and nothing to measure
  // offline: the pass reads the method's own runs (`methodHarmTest`) and
  // queues no paired evaluation (ruling of 2026-09-21).
  assert.deepEqual(slept.promoted, [], "an effective method is not promoted again");
  assert.deepEqual(enqueued.filter((entry) => entry.payload?.action === "evaluate"), [],
    "the nightly pass must not queue a paired evaluation");

  // --- 5. a second pass changes nothing about what is mounted ---------------
  const afterSecondPass = await consolidation.sleep({ job });
  assert.deepEqual(afterSecondPass.promoted, [], "it was already in force");
  const approvedMount = await launch(learning, project);
  assert.equal(approvedMount.count, 1);
  assert.deepEqual(Object.keys(approvedMount.learned[0]).sort(), ["digest", "id", "name"]);
  assert.equal((await learning.getMethod(USER, created.id)).payload.contentDigest, digest, "and no pass rewrote the text");

  // --- 6. retirement removes it from the next launch ------------------------
  const approved = await learning.getMethod(USER, created.id);
  await learning.retire(USER, created.id, { expectedRevision: approved.revision, reason: "chain test" });
  const afterRetire = await launch(learning, project);
  assert.equal(afterRetire.count, 0, "a retired method must be gone from the next launch");
  assert.deepEqual(await readdir(afterRetire.directory).catch(() => []), [],
    "the directory is rebuilt every launch, so a retired method leaves no file behind");
});

test("a fresh method takes effect with nothing queued, and its own rejected runs are what retire it", async () => {
  // Ruling of 2026-09-21: production is the detector. No paired evaluation is
  // queued for a new method or a new revision; the runs that mount it decide,
  // through a sequential test (`methodHarmTest`).
  const learning = new LearningService({ documents: fakeDocuments() });
  const created = await learning.createCandidate(USER, {
    projectId: PROJECT, frontmatter: frontmatter("bootstrap-method"), body: BODY,
    provenance: { origin: "inferred", runId: "run_seed" },
  });
  const queued = [];
  const consolidation = new MethodConsolidation({
    learning, dispatch: async () => { throw new Error("no model call in scheduling"); }, readResult: async () => null,
    jobs: { enqueue: async (_userId, _kind, payload) => { queued.push(payload); } },
  });
  await consolidation.sleep({ job: { userId: USER, projectId: PROJECT, payload: { action: "sleep" } } });
  assert.deepEqual(queued, [], "nothing is queued to measure a fresh method");
  assert.equal((await learning.getMethod(USER, created.id)).payload.status, "approved", "it takes effect the night it is learned");

  // Three of its runs used it and were rejected in a row: the harm boundary,
  // and it is retired by the next pass with a reason the researcher can read.
  // `invoked` because the harm test reads only runs that used the method
  // (audit 2026-09-26, L-G2): one that merely carried it says nothing.
  for (let i = 0; i < 3; i += 1) {
    await learning.recordObservation(USER, created.id, { runId: `trial-${i}`, family: `trial-${i}:d1`, outcome: "rejected",
      at: `2026-09-2${i}T00:00:00.000Z`, contentDigest: created.payload.contentDigest, invoked: true });
  }
  await consolidation.sleep({ job: { userId: USER, projectId: PROJECT, payload: { action: "sleep" } } });
  assert.deepEqual(queued, [], "and still nothing queued: the runs decided");
  const retired = await learning.getMethod(USER, created.id);
  assert.equal(retired.payload.status, "retired");
  assert.match(retired.payload.statusReason, /用上它的 3 次研究里有 3 次交付被退回/);
  assert.match(retired.payload.statusReason, /回到上一版/);
});
