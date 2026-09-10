/**
 * The chain, end to end, through the wiring production uses.
 *
 * Every part of this loop had unit tests and passed them, and the loop did not
 * run: `selectLearnedMethods` had no caller outside its own test, `trialMethodIds`
 * had no producer, the nightly pass returned before promotion whenever a user
 * held one method, and an evaluation's verdict was credited to whatever text the
 * method happened to hold when the verdict arrived. Four green suites, one dead
 * loop — the difference between "each part is correct" and "the parts are
 * connected", which is the whole reason this file calls no selector directly.
 *
 * What it walks: a candidate exists → an evaluation identity puts it on trial →
 * the launch path writes it into the container's method directory → a finished
 * run earns it an observation → the nightly pass promotes and queues → an
 * evaluation binds its verdict to the exact text → approval mounts it without a
 * trial → retirement removes it from the next launch.
 *
 * The seams it defends, one per step, are listed on each assertion. Reverting
 * any of A1-A7 in `07-todo.md` fails this file.
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
 * The launch path, exactly as `runtimeManager.syncCapsuleMethods` runs it:
 * read the trial for this project, then materialize with the learning ledger.
 * Written out here rather than imported so this test proves the sequence and
 * not a helper's willingness to be called.
 */
async function launch(learning, project) {
  const trial = await learning.methodTrial(project.userId, project.id);
  return materializeCapsuleMethods({
    capsules: null,
    learning,
    trialMethodIds: trial.methodIds,
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

test("a candidate reaches a container, earns observations, is promoted on a digest-bound verdict, and leaves when retired", async (t) => {
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
  assert.equal(created.payload.status, "candidate");
  const digest = created.payload.contentDigest;

  // A candidate is not mounted by being a candidate. This is the guarantee the
  // trial route is allowed to exist at all: a researcher's own launch never
  // receives unproven text.
  const beforeTrial = await launch(learning, project);
  assert.deepEqual(beforeTrial.learned, [], "a candidate must not mount without a trial");

  // --- 2. an evaluation identity puts it on trial (A2) ----------------------
  await learning.setMethodTrial(USER, {
    projectId: PROJECT, methodIds: [created.id], requestedBy: "evaluator", ttlMs: 3_600_000,
  });

  // --- 3. the launch path writes it into the container's directory (A1) -----
  const mounted = await launch(learning, project);
  assert.equal(mounted.count, 1, "the trialled candidate did not reach the method directory");
  assert.equal(mounted.learned[0].trial, true, "a trialled mount must be marked as one");
  const [directoryName] = await readdir(mounted.directory);
  const written = await readFile(path.join(mounted.directory, directoryName, "SKILL.md"), "utf8");
  // The bytes the container reads are the bytes the digest names. A receipt
  // that hashes something else makes every later attribution meaningless.
  assert.equal(mounted.learned[0].digest, mountedMethodDigest(created.payload, sha256));
  assert.match(written, /Quote the source sentence before writing the number\./);

  // --- 4. a finished run earns the candidate an observation (A3) ------------
  // The observation producer is given the trialled candidate, which is what
  // `recordMethodUse` now assembles; before that it saw approved methods only
  // and a trialled candidate earned nothing, forever.
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

  // --- 5. the nightly pass does not skip a lone candidate (A4) --------------
  /** @type {string[]} */ const audited = [];
  const consolidation = new MethodConsolidation({
    dispatch: async () => { throw new Error("the chain must not dispatch a run here"); },
    readResult: async () => { throw new Error("unused"); },
    learning,
    jobs: { async enqueue(userId, kind, payload) { enqueued.push({ userId, kind, payload }); return { id: "job_e" }; } },
    notifications: { async create() { return {}; } },
    evaluate: async (request) => ({
      verdict: "better",
      report: "evals/method-quality/reports/chain.json",
      baselineDigest: "sha256:baseline",
      candidateDigest: request.candidateDigest,
    }),
    audit: async (_job, event) => { audited.push(event); },
    now: () => new Date("2026-09-10T01:00:00.000Z"),
  });
  const job = { userId: USER, projectId: PROJECT, payload: { action: "sleep" } };
  const slept = await consolidation.sleep({ job });
  assert.equal(slept.methods, 1, "the pass must see the one candidate rather than returning early");
  // It cannot be promoted yet — there is no evaluation — but the pass has to
  // have tried, and to have queued the evaluation that unblocks it.
  assert.deepEqual(slept.promoted, [], "a candidate with no evaluation must not be promoted");
  assert.ok(
    slept.queuedForEvaluation.length > 0 || enqueued.some((entry) => entry.payload?.action === "evaluate"),
    "a lone eligible candidate must reach the evaluation queue; the pass used to return before this line",
  );

  // --- 6. a verdict is credited to the text it measured (A5) ----------------
  // First the failure this replaced: a verdict that arrives for text the
  // method no longer holds is refused, not folded into the new text's score.
  await assert.rejects(
    () => learning.recordEvaluation(USER, created.id, {
      report: "r", baselineDigest: "sha256:baseline", candidateDigest: "sha256:some-other-text", verdict: "better",
    }),
    /method_evaluation_stale|no longer holds/,
    "a verdict for other text must not be recorded",
  );
  const stale = await learning.getMethod(USER, created.id);
  assert.equal(stale.payload.learning.counts.validated, 0, "a refused verdict must not have counted");

  await consolidation.evaluateCandidate({ job: { ...job, payload: { action: "evaluate", methodId: created.id } } });
  const evaluated = await learning.getMethod(USER, created.id);
  assert.equal(evaluated.payload.learning.evaluations.at(-1).candidateDigest, digest,
    "the recorded verdict must name the text it measured");
  assert.equal(evaluated.payload.learning.counts.validated, 1, "a verdict on the current text must count");

  // --- 7. approval, and a mount that is no longer a trial -------------------
  await learning.clearMethodTrial(USER, PROJECT);
  const afterSecondPass = await consolidation.sleep({ job });
  assert.deepEqual(afterSecondPass.promoted, [created.id], "the evaluated candidate was not promoted");
  const approvedMount = await launch(learning, project);
  assert.equal(approvedMount.count, 1, "an approved method must mount without a trial");
  assert.equal(approvedMount.learned[0].trial, undefined, "an approved mount must not be marked as a trial");

  // --- 8. retirement removes it from the next launch ------------------------
  const approved = await learning.getMethod(USER, created.id);
  await learning.retire(USER, created.id, { expectedRevision: approved.revision, reason: "chain test" });
  const afterRetire = await launch(learning, project);
  assert.equal(afterRetire.count, 0, "a retired method must be gone from the next launch");
  assert.deepEqual(await readdir(afterRetire.directory).catch(() => []), [],
    "the directory is rebuilt every launch, so a retired method leaves no file behind");
});

test("a trial expires, and an expired one mounts nothing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evimed-learning-trial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { id: PROJECT, userId: USER, rootDir: root, workspaceDir: path.join(root, "workspace") };
  const documents = fakeDocuments();
  let now = new Date("2026-09-10T00:00:00.000Z");
  const learning = new LearningService({ documents, now: () => now });
  const created = await learning.createCandidate(USER, {
    projectId: PROJECT, frontmatter: frontmatter("expiring-method"), body: BODY,
    provenance: { origin: "distilled", runIds: ["run_seed"] },
  });
  await learning.setMethodTrial(USER, { projectId: PROJECT, methodIds: [created.id], requestedBy: "evaluator", ttlMs: 60_000 });
  assert.equal((await launch(learning, project)).count, 1);
  // Expiry is applied on read, so a trial nobody cleared cannot leave unproven
  // text mounted in front of later runs — there is no sweeper whose failure
  // would make that happen.
  now = new Date("2026-09-10T02:00:00.000Z");
  assert.equal((await launch(learning, project)).count, 0, "an expired trial must mount nothing");
});

test("a fresh inferred candidate is queued for bounded bootstrap evaluation without observations", async () => {
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
  assert.equal(queued.length, 1);
  assert.equal(queued[0].bootstrap, true);
  assert.equal(queued[0].candidateDigest, created.payload.contentDigest);
  assert.equal((await learning.getMethod(USER, created.id)).payload.status, "candidate");
  consolidation.evaluate = async () => ({ verdict: "better", report: "bootstrap-report.json", candidateDigest: created.payload.contentDigest });
  await consolidation.evaluateCandidate({ job: { userId: USER, projectId: PROJECT, payload: queued[0] } });
  assert.equal((await learning.getMethod(USER, created.id)).payload.learning.evaluations.length, 0,
    "a favorable bootstrap result is not a full paired evaluation");
  for (let i = 0; i < 3; i += 1) {
    await learning.recordObservation(USER, created.id, { runId: `trial-${i}`, family: `trial-${i}:d1`, outcome: "accepted", contentDigest: created.payload.contentDigest });
  }
  await consolidation.sleep({ job: { userId: USER, projectId: PROJECT, payload: { action: "sleep" } } });
  assert.equal(queued[1].bootstrap, false, "observations unlock the full evaluation, not approval");
  assert.equal((await learning.getMethod(USER, created.id)).payload.status, "candidate");
});
