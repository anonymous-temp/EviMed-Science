import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  UNEXPORTED_DOCUMENT_KINDS,
  accountExportDocumentKinds,
  exportDocumentRow,
  withAccountExportSnapshot,
} from "../src/accountExport.mjs";
import {
  EXTENSION_CUSTOMER_KINDS,
  EXTENSION_DERIVED_KINDS,
} from "../src/extensionAccountExport.mjs";
import { PLUGIN_ID, pluginEntry } from "../src/pluginService.mjs";
import { PRODUCT_KINDS } from "../src/productPersistence.mjs";
import { captureResultDelivery } from "../src/resultDeliveryCapture.mjs";
import { ResultImpactService } from "../src/resultImpact.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultReplayService } from "../src/resultReplayService.mjs";
import { ResultRevisionService } from "../src/resultRevision.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

// Which document kinds the account export carries, which it leaves out and
// why, and what it does with one nobody decided. Reproduced on a pilot on
// 2026-10-03: the export answered 503 for every account with one captured
// result, because the result kinds had been added to PRODUCT_KINDS and not to
// the export's list, and the guard for that was a refusal at run time rather
// than a test. The first test below is that guard now.
// `accountExport.integration.test.mjs` holds the same behaviour against
// PostgreSQL.

const OWNER = "owner";
/** A second identity acting on the owner's project: its id is not the owner's
 * data and must not leave in the owner's archive. */
const COLLABORATOR = "collaborator-7f3a";
const GENERATION = "2026-10-03 00:00:00+00";
const sha = (/** @type {string | Buffer} */ value) =>
  createHash("sha256").update(value).digest("hex");

test("every stored document kind is either exported or declared unexported with a reason", () => {
  // The list this walks has to be the one the database enforces, or deciding
  // every kind in it decides nothing. Every definition of the documents CHECK
  // constraint is generated from PRODUCT_KINDS; a second list would show here.
  const persistence = readFileSync(
    new URL("../src/productPersistence.mjs", import.meta.url),
    "utf8",
  );
  const definitions = [
    ...persistence.matchAll(/CONSTRAINT product_documents_kind_check\s+CHECK/g),
  ].length;
  const constraintLists = [
    ...persistence.matchAll(
      /CONSTRAINT product_documents_kind_check\s+CHECK \(kind IN \(\$\{(\w+)\.map/g,
    ),
  ].map(([, list]) => list);
  assert.ok(
    definitions >= 2,
    `the migration scan found only ${definitions} definitions of the kind constraint`,
  );
  assert.equal(
    constraintLists.length,
    definitions,
    "a definition of the kind constraint is not generated from a list of kinds",
  );
  assert.deepEqual([...new Set(constraintLists)], ["PRODUCT_KINDS"]);

  // The walk has to prove it walked: an empty or truncated list would make
  // every loop below vacuously true and this guard permanently green.
  assert.ok(
    PRODUCT_KINDS.length >= 26,
    `only ${PRODUCT_KINDS.length} document kinds were found`,
  );
  for (const anchor of ["capsule", "plugin", "method-trial", "document-export", "result-version", "skill"]) {
    assert.ok(PRODUCT_KINDS.includes(anchor), `${anchor} was never seen by the walk`);
  }

  const exported = accountExportDocumentKinds();
  for (const kind of PRODUCT_KINDS) {
    assert.ok(
      exported.includes(kind) || Object.hasOwn(UNEXPORTED_DOCUMENT_KINDS, kind),
      `${kind} is a stored document kind and the account export neither carries it nor says why it does not`,
    );
  }
  // The two declarations are exclusive, and they are about real kinds: an
  // entry that named nothing the store accepts, or named a kind twice, would
  // let a genuinely undecided kind hide behind it.
  assert.equal(new Set(exported).size, exported.length, "a kind is exported twice");
  for (const kind of exported) {
    assert.ok(PRODUCT_KINDS.includes(kind), `${kind} is exported but is not a kind the store accepts`);
    assert.ok(
      !Object.hasOwn(UNEXPORTED_DOCUMENT_KINDS, kind),
      `${kind} is exported and declared unexported`,
    );
  }
  for (const [kind, reason] of Object.entries(UNEXPORTED_DOCUMENT_KINDS)) {
    assert.ok(
      PRODUCT_KINDS.includes(kind),
      `${kind} is declared unexported but is not a kind the store accepts`,
    );
    assert.ok(reason.length > 30, `${kind} is left out without a stated reason`);
  }
});

test("the extension module's split of its own kinds is the one the export applies", () => {
  // `extensionAccountExport.mjs` says which of its kinds are authored data and
  // which are derived authority. A kind it moved from one list to the other
  // would otherwise change sides here without anyone deciding it should.
  assert.ok(EXTENSION_CUSTOMER_KINDS.length >= 1 && EXTENSION_DERIVED_KINDS.length >= 1);
  const exported = accountExportDocumentKinds();
  for (const kind of EXTENSION_CUSTOMER_KINDS) {
    assert.ok(exported.includes(kind), `${kind} is authored extension data and is not exported`);
  }
  for (const kind of EXTENSION_DERIVED_KINDS) {
    assert.ok(
      Object.hasOwn(UNEXPORTED_DOCUMENT_KINDS, kind),
      `${kind} is derived extension state and the export does not say why it leaves it out`,
    );
  }
});

/**
 * A database double over the in-memory document store: enough PostgreSQL for
 * the snapshot assembly. Unlike a double that hands back whatever it holds, it
 * applies the kind filters the real queries carry — the kinds are the thing
 * under test, and a double that ignored them would export any row it was given.
 * @param {ReturnType<typeof productDocumentsDouble>} documents
 */
function databaseOver(documents) {
  const held = (/** @type {string} */ userId, /** @type {string[] | null} */ kinds = null) =>
    [...documents.rows.values()]
      .filter((row) => row.userId === userId && (!kinds || kinds.includes(row.kind)))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const database = {
    /** The kind lists the document queries were actually filtered by.
     * @type {string[][]} */
    kindFilters: [],
    /** @param {(client: any) => Promise<any>} operation */
    transaction: (operation) =>
      operation({
        query: (/** @type {string} */ text, /** @type {any[]} */ values) =>
          database.query(text, values),
      }),
    /** @param {string} text @param {any[]} [values] */
    async query(text, values = []) {
      if (text.startsWith("SELECT count(*)"))
        return { rows: [{ rows: "1", bytes: "32" }], rowCount: 1 };
      if (text.includes("FROM evimed_control.users")) {
        return {
          rowCount: 1,
          rows: [{
            id: values[0],
            name: "Owner",
            accountCreatedAt: GENERATION,
            sameGeneration: true,
            snapshotAt: "2026-10-03T00:00:00.000Z",
          }],
        };
      }
      if (text.includes("NOT(kind=ANY(")) {
        /** @type {Map<string, number>} */
        const counts = new Map();
        for (const row of held(values[0])) {
          if (!values[1].includes(row.kind)) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
        }
        const rows = [...counts].map(([kind, count]) => ({ kind, documents: count }));
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith("SELECT id,kind")) {
        database.kindFilters.push(values[1]);
        const rows = held(values[0], values[1]).map((row) =>
          structuredClone({
            id: row.id,
            kind: row.kind,
            projectId: row.projectId,
            payload: row.payload,
            revision: row.revision,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
          }),
        );
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith("SELECT r.id,r.kind")) {
        database.kindFilters.push(values[1]);
        const rows = [];
        for (const row of held(values[0], values[1])) {
          const history = await documents.history(row.userId, row.kind, row.id, { limit: 50 });
          for (const entry of history.reverse()) {
            rows.push({
              id: row.id,
              kind: row.kind,
              projectId: row.projectId,
              payload: entry.payload,
              revision: entry.revision,
              deletedAt: entry.deletedAt,
              recordedAt: entry.recordedAt,
            });
          }
        }
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return database;
}

/** The owner's archive state, and what the export told the operator.
 * @param {ReturnType<typeof productDocumentsDouble>} documents */
async function exportOf(documents) {
  const database = databaseOver(documents);
  /** @type {string[]} */
  const reported = [];
  const state = await withAccountExportSnapshot(
    database,
    { id: OWNER, accountCreatedAt: GENERATION },
    {},
    async (snapshot) => JSON.parse(snapshot.data.toString()),
    { report: (line) => reported.push(line) },
  );
  // Both document queries ran, each filtered by the exported kinds and nothing
  // else: this is what makes "a kind is absent" below mean the export left it
  // out, rather than the double never having been asked.
  assert.deepEqual(database.kindFilters, [
    accountExportDocumentKinds(),
    accountExportDocumentKinds(),
  ]);
  return { state, reported };
}

/** Every key that appears anywhere inside a value.
 * @param {unknown} value @param {Set<string>} [found] */
function keysWithin(value, found = new Set()) {
  if (Array.isArray(value)) for (const item of value) keysWithin(item, found);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      found.add(key);
      keysWithin(item, found);
    }
  }
  return found;
}

const QUOTE = "The observed reduction was 20 percent in the selected study.";
const REPORT = "# Research result\n\nObserved reduction [1].\n";
const MACHINE_VALUES = [{ key: "pooled.estimate", value: 0.42, unit: "log-odds" }];

/**
 * One project with everything the result modules write, written by them: a
 * delivered report with its evidence matrix and preserved source, a tool
 * write, a source correction that reached the report and was continued, a
 * selection the collaborator staged and submitted, a calculation and its
 * recalculation. Only the queue and the engine are doubles.
 */
async function resultFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evimed-export-kinds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = {
    userId: OWNER,
    id: "one",
    rootDir: root,
    baseDir: root,
    workspaceDir: path.join(root, "workspace"),
    metaDir: path.join(root, ".openscience"),
  };
  await mkdir(project.workspaceDir);
  await mkdir(project.metaDir);
  const workspaceFile = (/** @type {string} */ relativePath) =>
    path.join(project.workspaceDir, relativePath);
  const write = async (/** @type {string} */ relativePath, /** @type {string} */ text) => {
    await mkdir(path.dirname(workspaceFile(relativePath)), { recursive: true });
    await writeFile(workspaceFile(relativePath), text);
  };
  const documents = productDocumentsDouble();
  const results = new ResultProvenanceService({
    documents,
    authorizeProject: async (userId, projectId) => {
      assert.ok([OWNER, COLLABORATOR].includes(userId));
      assert.equal(projectId, project.id);
      return project;
    },
    authorizeReference: async (_userId, _project, reference) => reference,
  });

  // A delivery, as a finished run's verified receipt hands it to capture.
  const run = { id: "run-one", sessionId: "session-one" };
  const sourceText = `# Study\n\n- DOI: 10.9999/paper\n\n${QUOTE}\n`;
  const sourceManifest = { "fulltext.md": sha(sourceText) };
  const sourceVersion = sha(JSON.stringify(sourceManifest));
  const sourcePath = `.evimed-sources/paper/${sourceVersion}/fulltext.md`;
  await write(sourcePath, sourceText);
  await write(
    `${path.posix.dirname(sourcePath)}/capture.json`,
    JSON.stringify({ schemaVersion: 1, version: sourceVersion, artifacts: sourceManifest }),
  );
  const matrixText = JSON.stringify({
    claims: [
      { claimId: "CLM-001", claimType: "direct", identifier: "10.9999/paper", artifactPath: sourcePath, supportQuote: QUOTE, accessLevel: "full_text" },
      { claimId: "CLM-002", claimType: "derived", derivedFrom: ["CLM-001"] },
    ],
  });
  const matrixPath = "deliverables/d1/clinical-evidence-matrix.json";
  const reportPath = "deliverables/d1/clinical-evidence-report.md";
  await write(matrixPath, matrixText);
  await write(reportPath, REPORT);
  const delivery = await captureResultDelivery({
    results,
    project,
    run,
    receipt: {
      entries: [{
        deliverableId: "d1",
        files: [[matrixPath, matrixText], [reportPath, REPORT]].map(([file, text]) => ({
          path: file,
          sha256: sha(text),
          bytes: Buffer.byteLength(text),
        })),
      }],
    },
  });
  assert.deepEqual(delivery.failures, []);
  const report = delivery.items.find((item) => item.path === reportPath);
  const matrix = delivery.items.find((item) => item.path === matrixPath);
  const source = delivery.sourceItems[0];

  // A tool write, as the kernel event feed hands it to capture.
  await write("notes/draft.md", "A working note.");
  const note = await results.captureFile({
    userId: OWNER,
    project,
    relativePath: "notes/draft.md",
    expectedDigest: sha("A working note."),
    producer: { kind: "tool", sessionId: run.sessionId, runId: run.id, callId: "call-write", eventId: "17" },
  });

  // A correction to the source, and the owner continuing research from it.
  await documents.put(OWNER, "agenda", "agenda-one", { title: "Follow the evidence", enabled: true, status: "active" }, { expectedRevision: 0, projectId: project.id });
  const impacts = new ResultImpactService({
    documents,
    results,
    autopilot: { schedule: async () => ({ episode: { id: "episode-one" } }) },
  });
  const changed = await impacts.reconcileSourceUpdate(OWNER, {
    projectId: project.id,
    source: { id: "10.9999/paper", doi: "10.9999/paper", digest: sha(sourceText), versionId: source.versionId },
    status: { state: "changed", checkedAt: "2026-10-02T00:00:00Z", updates: [{ kind: "correction", noticeDoi: "10.9999/correction", date: "2026-10-01", source: "crossref" }] },
  });
  const impact = changed.items.find((item) => item.payload.versionId === report.versionId);
  await impacts.continueImpact(OWNER, project.id, impact.id, { agendaId: "agenda-one" });

  // A selection staged and submitted by the collaborator.
  const revisions = new ResultRevisionService({ results, documents });
  const staged = await revisions.stage(COLLABORATOR, report.versionId, {
    projectId: project.id,
    digest: report.digest,
    requestId: "selection-one",
    sessionId: run.sessionId,
    anchor: { kind: "text", elementId: "paragraph-1", selectedText: "Observed reduction" },
  });
  await revisions.bind(COLLABORATOR, project, {
    sessionId: run.sessionId,
    requestId: "kernel-request-one",
    evimedResultRevision: { referenceId: staged.referenceId },
    content: [{ type: "text", text: `${staged.draft}Clarify the limitation.` }],
  });

  // A calculation the collaborator's conversation asked for, then the owner
  // recalculating its result.
  /** @type {Map<string, any>} */
  const queue = new Map();
  const jobs = {
    async enqueue(userId, kind, payload, { projectId }) {
      const job = { id: `job_${queue.size + 1}`, userId, kind, projectId, payload, status: "queued", leaseToken: `lease_${queue.size + 1}` };
      queue.set(job.id, job);
      return job;
    },
    get: async (_userId, id) => queue.get(id) ?? null,
    withLease: async (_userId, _id, _leaseToken, operation) => operation(null),
    renew: async () => true,
    async finishWithLease(_userId, id, _leaseToken, _result, operation) {
      await operation(null);
      queue.get(id).status = "succeeded";
    },
  };
  const capability = { available: true, method: "meta.dl", version: "1", codeDigest: "c".repeat(64), environmentDigest: "e".repeat(64) };
  const replays = new ResultReplayService({
    results,
    documents,
    jobs,
    engine: { configured: () => true, capabilities: async () => ({ methods: [capability] }), start: async () => ({ state: "running" }) },
  });
  /** What the replay worker does with a claimed job, the engine's output
   * written the way the numerical adapter writes it. */
  const finish = async (/** @type {string} */ replayId) => {
    const job = [...queue.values()].find((item) => item.payload.replayId === replayId);
    const prepared = await replays.prepare(job);
    await replays.start(job, prepared);
    const resultPath = `result-replays/${job.id}/output/result.json`;
    const output = JSON.stringify({ receipt: { recipeDigest: prepared.execution.recipeDigest }, machineValues: MACHINE_VALUES });
    await write(resultPath, output);
    return replays.complete(job, prepared, {
      jobId: job.id,
      recipeDigest: prepared.execution.recipeDigest,
      state: "succeeded",
      cleanup: "confirmed",
      resultPath,
      artifacts: [{ path: resultPath, sha256: sha(output), bytes: Buffer.byteLength(output) }],
      machineValues: MACHINE_VALUES,
    });
  };
  await write("input.json", '{"studies":[]}');
  const calculation = await replays.calculate(
    COLLABORATOR,
    project,
    { method: "meta.dl", inputPath: "input.json", parameters: {} },
    { kind: "engine", sessionId: run.sessionId, callId: "call-calculate", runId: run.id, parentSessionId: null, branchId: null },
  );
  const calculated = await finish(calculation.id);
  const recalculation = await replays.request(OWNER, calculated.versionId, {
    projectId: project.id,
    digest: calculated.digest,
    requestId: "recalculate-one",
  });
  const recalculated = await finish(recalculation.id);

  // A conversion, as `DocumentExportService.requestFrozen` stores it and
  // `complete` settles it. That service writes through PostgreSQL only, so
  // this one record is typed here from those two functions.
  const conversion = {
    ownerId: OWNER,
    requestedBy: COLLABORATOR,
    projectId: project.id,
    source: { artifactId: reportPath, root: "workspace", workspace: "" },
    sourceDigest: "d".repeat(64),
    sourceRevision: sha(REPORT),
    title: "clinical-evidence-report.md",
    rendererVersion: "pandoc-chromium-v1",
    reservedBytes: 67108950,
    sourceBytes: Buffer.byteLength(REPORT),
    attempts: 0,
    state: "queued",
    formats: { docx: { state: "queued" }, pdf: { state: "queued" } },
    jobId: "job_render_1",
    inputDigest: "1".repeat(64),
  };
  const conversionId = `dex_${"a".repeat(48)}`;
  await documents.put(OWNER, "document-export", conversionId, conversion, { expectedRevision: 0, projectId: project.id });
  await documents.put(OWNER, "document-export", conversionId, {
    ...conversion,
    attempt: null,
    attempts: 1,
    state: "partial",
    findings: ["document_image_unavailable"],
    formats: {
      docx: { state: "ready", path: "attempts/3f0c/output/document.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sha256: "b".repeat(64), bytes: 20480, sourceDigest: "d".repeat(64) },
      pdf: { state: "failed", code: "document_render_failed" },
    },
  }, { expectedRevision: 1, projectId: project.id });

  return { documents, project, run, report, matrix, source, note, impact, staged, calculation, calculated, recalculation, recalculated,
    conversionId, reportPath, matrixText, workspaceFile, write };
}

/** The kinds whose stored payload is not what leaves. */
const PROJECTED_KINDS = ["document-export", "result-version", "result-impact", "result-revision", "result-replay"];
/** Fields those payloads hold that are not the customer's. */
const INTERNAL_KEYS = ["storagePath", "requestedBy", "ownerId", "jobId", "execution", "capability", "fingerprint", "changeKey",
  "instructionDigest", "promptRequestId", "expiresAt", "draft", "inputDigest", "attempt", "attempts", "reservedBytes", "sourceBytes", "sourceDigest"];

test("an account with captured results exports them, and nothing the customer did not write leaves with them", async (t) => {
  const f = await resultFixture(t);
  const { state, reported } = await exportOf(f.documents);

  // The incident itself: this account used to be refused whole.
  assert.equal(state.version, 1);
  assert.deepEqual(state.omissions, []);
  assert.deepEqual(reported, []);
  for (const kind of PROJECTED_KINDS) {
    assert.ok(state.documents.some((row) => row.kind === kind), `no ${kind} document was exported`);
    assert.ok(state.revisions.some((row) => row.kind === kind), `no ${kind} revision was exported`);
  }

  // The stored payloads really did hold each of these, or their absence from
  // the archive below would prove nothing.
  const stored = keysWithin([...f.documents.rows.values()].filter((row) => PROJECTED_KINDS.includes(row.kind)).map((row) => row.payload));
  for (const key of INTERNAL_KEYS) assert.ok(stored.has(key), `no stored result record holds ${key}`);
  const exportedRows = [...state.documents, ...state.revisions].filter((row) => PROJECTED_KINDS.includes(row.kind));
  const exported = keysWithin(exportedRows.map((row) => row.payload));
  for (const key of INTERNAL_KEYS) assert.ok(!exported.has(key), `${key} left in the archive`);
  // A collaborator staged the selection, asked for the calculation and
  // requested the conversion. Their id is not the owner's data.
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes(COLLABORATOR), "another user's id left in the owner's archive");
  assert.ok(!serialized.includes("result-snapshots/"), "a platform storage path left in the archive");
  // A record's pointer into the queue stays behind with the queue: the
  // conversion's job is named nowhere. A calculation's job id is a different
  // thing by the result module's own design — it is the directory its files
  // are written to in the customer's workspace and the call its output version
  // names as its producer — so it is in the archive in exactly those places.
  assert.ok(!serialized.includes("job_render_1"), "a conversion's queue job left in the archive");
  const calculationOutput = state.documents.find((row) => row.id === f.calculated.versionId).payload;
  assert.equal(calculationOutput.path, `result-replays/${calculationOutput.producer.callId}/output/result.json`);
});

test("a result version leaves as the record the product serves, its bytes referenced by path and digest", async (t) => {
  const f = await resultFixture(t);
  const { state } = await exportOf(f.documents);
  const row = state.documents.find((item) => item.id === f.report.versionId);
  assert.equal(row.kind, "result-version");
  assert.equal(row.projectId, f.project.id);
  const version = row.payload;
  assert.equal(version.recordType, "result-version");
  assert.equal(version.path, f.reportPath);
  assert.equal(version.digest, sha(REPORT));
  assert.equal(version.size, Buffer.byteLength(REPORT));
  assert.equal(version.mimeType, f.report.mimeType);
  assert.deepEqual(version.producer, { kind: "deliverable", sessionId: f.run.sessionId, runId: f.run.id, callId: null, eventId: "d1", parentSessionId: null, branchId: null });
  assert.equal(version.coverage.snapshot, "complete");

  // What it was built from: the preserved source and the matrix, each by the
  // version and digest captured with it.
  const paper = version.inputs.find((input) => input.id === "10.9999/paper");
  assert.deepEqual(Object.keys(paper).sort(), ["availability", "digest", "id", "kind", "path", "versionId"]);
  assert.equal(paper.versionId, f.source.versionId);
  assert.equal(paper.availability, "captured");
  assert.equal(version.inputs.find((input) => input.id === f.matrix.artifactId).digest, sha(f.matrixText));
  // The claim-to-source links, and the verdict on each quotation.
  const claim = version.findings.find((finding) => finding.elementId === "CLM-001");
  assert.equal(claim.status, "verified");
  assert.deepEqual(Object.keys(claim.sourceRefs[0]).sort(), ["availability", "digest", "id", "kind", "path", "versionId"]);
  assert.equal(version.review.status, "available");
  assert.equal(version.review.matrixVersionId, f.matrix.versionId);
  assert.equal(version.review.matrixDigest, sha(f.matrixText));
  assert.equal(version.review.matrixText, f.matrixText);
  assert.equal(version.review.verification.claims.find((item) => item.claimId === "CLM-001").status, "verified");

  // A tool write is a version like any other, with the call that wrote it.
  const note = state.documents.find((item) => item.id === f.note.versionId).payload;
  assert.equal(note.path, "notes/draft.md");
  assert.equal(note.producer.callId, "call-write");
  // A result version is written once, so its history is that one revision.
  assert.deepEqual(state.revisions.filter((item) => item.id === f.report.versionId).map((item) => [item.revision, item.payload.digest]), [[1, sha(REPORT)]]);

  // The convention the record follows: it names the workspace file and its
  // SHA-256, and the workspace is where the archive carries bytes. While the
  // file is unchanged a reader can check one against the other ...
  assert.equal(sha(await readFile(f.workspaceFile(version.path))), version.digest);
  // ... and once the workspace has moved on, the record still says what the
  // result was, so the difference is visible rather than silent.
  await f.write(f.reportPath, "A later edit.");
  const later = (await exportOf(f.documents)).state.documents.find((item) => item.id === f.report.versionId).payload;
  assert.equal(later.digest, sha(REPORT));
  assert.notEqual(sha(await readFile(f.workspaceFile(later.path))), later.digest);
});

test("selections, source corrections and calculations leave as what the researcher did and what came of it", async (t) => {
  const f = await resultFixture(t);
  const { state } = await exportOf(f.documents);
  const payloadOf = (/** @type {string} */ id) => state.documents.find((row) => row.id === id).payload;

  assert.deepEqual(payloadOf(f.staged.referenceId), {
    recordType: "result-revision",
    id: f.staged.referenceId,
    projectId: f.project.id,
    versionId: f.report.versionId,
    digest: f.report.digest,
    sessionId: f.run.sessionId,
    state: "bound",
    stagedAt: payloadOf(f.staged.referenceId).stagedAt,
    boundAt: payloadOf(f.staged.referenceId).boundAt,
    instruction: "Clarify the limitation.",
    inputPath: `artifacts/result-revisions/${f.staged.referenceId}/input.md`,
    anchor: { kind: "text", elementId: "paragraph-1", selectedText: "Observed reduction", matchMode: "raw_text" },
  });
  // Staged, then submitted: both states are in the history.
  assert.deepEqual(state.revisions.filter((row) => row.id === f.staged.referenceId).map((row) => row.payload.state), ["staged", "bound"]);

  const impact = payloadOf(f.impact.id);
  assert.equal(impact.recordType, "result-impact");
  assert.equal(impact.versionId, f.report.versionId);
  assert.deepEqual(impact.source, { id: "10.9999/paper", digest: f.source.digest, versionId: f.source.versionId, doi: "10.9999/paper" });
  assert.equal(impact.sourceStatus.state, "changed");
  assert.deepEqual(impact.sourceStatus.updates, [{ kind: "correction", noticeDoi: "10.9999/correction", date: "2026-10-01", source: "crossref" }]);
  assert.equal(impact.effect, "potentially_affected");
  assert.deepEqual(impact.claimIds, ["CLM-001", "CLM-002"]);
  assert.equal(impact.historicalResultPreserved, true);
  assert.equal(impact.continuation.status, "scheduled");
  assert.equal(impact.continuation.agendaId, "agenda-one");
  assert.equal(impact.continuation.episodeId, "episode-one");
  assert.deepEqual(state.revisions.filter((row) => row.id === f.impact.id).map((row) => row.payload.continuation.status), ["awaiting_user", "preparing", "scheduled"]);

  // The first calculation: what was asked, by which call, and what came out.
  const calculation = payloadOf(f.calculation.id);
  assert.equal(calculation.recordType, "result-replay");
  assert.equal(calculation.state, "succeeded");
  assert.equal(calculation.cleanup, "confirmed");
  assert.equal(calculation.versionId, null);
  assert.equal(calculation.outputVersionId, f.calculated.versionId);
  assert.equal(calculation.partial, false);
  assert.equal(calculation.comparison, null);
  assert.equal(calculation.initial.recipe.method, "meta.dl");
  assert.deepEqual(calculation.initial.recipe.input, { path: "input.json", sha256: sha('{"studies":[]}') });
  assert.deepEqual(calculation.initial.producer, { kind: "engine", sessionId: f.run.sessionId, runId: f.run.id, callId: "call-calculate", parentSessionId: null, branchId: null });
  assert.deepEqual(Object.keys(calculation.artifacts[0]).sort(), ["bytes", "path", "sha256"]);
  // Its output is a workspace file, named the way a result version names one.
  assert.equal(sha(await readFile(f.workspaceFile(calculation.artifacts[0].path))), calculation.artifacts[0].sha256);
  assert.equal(payloadOf(f.calculated.versionId).producer.kind, "engine");
  assert.deepEqual(payloadOf(f.calculated.versionId).machineValues, MACHINE_VALUES);

  // The frozen recipe that makes it reproducible.
  const recipe = payloadOf(`recipe_${f.calculated.versionId}`);
  assert.deepEqual(Object.keys(recipe).sort(), ["capturedAt", "inputVersionId", "machineValues", "projectId", "receipt", "recipe", "recipeDigest", "recordType", "versionId"]);
  assert.equal(recipe.recordType, "result-replay-recipe");
  assert.equal(recipe.recipe.codeDigest, "c".repeat(64));
  assert.equal(recipe.receipt.outputDigest, f.calculated.digest);
  assert.deepEqual(recipe.machineValues, MACHINE_VALUES);

  // The recalculation: which result it reran and how the numbers compared.
  const recalculation = payloadOf(f.recalculation.id);
  assert.equal(recalculation.versionId, f.calculated.versionId);
  assert.equal(recalculation.outputVersionId, f.recalculated.versionId);
  assert.equal(recalculation.comparison.numbers.status, "identical");
  assert.equal(recalculation.comparison.scientificApplicability, "not_assessed");
  assert.equal(recalculation.initial, undefined);
  assert.equal(payloadOf(f.recalculated.versionId).supersedesVersionId, f.calculated.versionId);
});

test("a document conversion leaves as what was converted and what came out, each file by digest", async (t) => {
  const f = await resultFixture(t);
  const { state } = await exportOf(f.documents);
  assert.deepEqual(state.documents.find((row) => row.id === f.conversionId).payload, {
    projectId: f.project.id,
    title: "clinical-evidence-report.md",
    sourceRevision: sha(REPORT),
    rendererVersion: "pandoc-chromium-v1",
    state: "partial",
    source: { artifactId: f.reportPath, root: "workspace", workspace: "" },
    formats: {
      docx: { state: "ready", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sha256: "b".repeat(64), bytes: 20480 },
      pdf: { state: "failed", code: "document_render_failed" },
    },
    findings: ["document_image_unavailable"],
  });
  // Requested, then settled.
  assert.deepEqual(state.revisions.filter((row) => row.id === f.conversionId).map((row) => [row.payload.state, Object.values(row.payload.formats).map((format) => format.state)]),
    [["queued", ["queued", "queued"]], ["partial", ["ready", "failed"]]]);
  // A conversion of a study report names the study, not a workspace file.
  assert.deepEqual(exportDocumentRow({ id: "dex_study", kind: "document-export", payload: { source: { studyId: "study-one", exportId: "export-one", token: "private" }, formats: { html: { state: "queued" }, exe: { state: "ready" } } } }).payload,
    { source: { studyId: "study-one", exportId: "export-one" }, formats: { html: { state: "queued" } }, findings: [] });
  // A conversion of a result version names the version and its digest, never a path that may hold other bytes by now.
  const versionId = `rv_${"a".repeat(64)}`;
  assert.deepEqual(exportDocumentRow({ id: "dex_version", kind: "document-export", payload: { source: { versionId, digest: "d".repeat(64), token: "private" }, formats: {} } }).payload.source,
    { versionId, digest: "d".repeat(64) });
});

test("a settled revision leaves with what the run left, in the domain's own closed shape, and a staged one is unchanged", () => {
  const base = { recordType: "result-revision", id: `rr_${"b".repeat(64)}`, projectId: "p", versionId: `rv_${"a".repeat(64)}`, digest: "d".repeat(64), sessionId: "s", state: "bound",
    instruction: "Check the denominator.", anchor: { kind: "text", elementId: "paragraph-1", selectedText: "n = 12", token: "private" }, reach: { calculations: [], alsoPrintedFrom: [] } };
  const staged = exportDocumentRow({ id: base.id, kind: "result-revision", payload: base }).payload;
  assert.equal(Object.hasOwn(staged, "outcome"), false);
  assert.equal(Object.hasOwn(staged, "reach"), false, "what the run was told is the platform's working record, not the researcher's");
  const settled = exportDocumentRow({ id: base.id, kind: "result-revision", payload: { ...base, outcome: { status: "settled", successorVersionId: `rv_${"c".repeat(64)}`, settledAt: "2026-10-04T10:00:00.000Z",
    outputs: [{ versionId: `rv_${"c".repeat(64)}`, path: "o/report.md", role: "successor", secret: "x" }, { versionId: "bad", path: "x" }], calculations: [], reach: { calculations: [], alsoPrintedFrom: [] }, token: "private" } } }).payload;
  assert.equal(settled.outcome.status, "settled");
  assert.deepEqual(settled.outcome.outputs.map((item) => [item.path, item.role, item.consistency]), [["o/report.md", "successor", "not_checked"]]);
  assert.equal(JSON.stringify(settled).includes("private"), false);
  assert.equal(JSON.stringify(settled).includes("secret"), false);
});

/** One stored document for a kind whose own export rule refuses a plain
 * record. A kind absent here is seeded with a plain record, which is what
 * every kind without a projection is exported as. */
const SEEDS = {
  plugin: { id: `project:one:${PLUGIN_ID}`, projectId: "one", payload: { schemaVersion: 1, pluginId: PLUGIN_ID, binaryVersion: pluginEntry(PLUGIN_ID).version, enabled: true, settings: { timeoutMs: 4000 } } },
  skill: { id: "skill:one", payload: { title: "Review", description: "Review sources", instructions: "Use these sources.", resources: [], invocation: { userInvocable: true, modelInvocable: true } } },
  "extension-installation": { id: "extension:one", payload: { catalogueId: "one", coordinate: { kind: "npm", name: "example-tool", version: "1.0.0" } } },
  "extension-defaults": { id: "skills:defaults", payload: { skills: [] } },
};

test("an account holding a document of every declared kind exports, each kind carried or left out as declared", async (t) => {
  const f = await resultFixture(t);
  for (const kind of PRODUCT_KINDS) {
    if ([...f.documents.rows.values()].some((row) => row.kind === kind)) continue;
    const seed = SEEDS[kind] ?? { id: `${kind}-one`, payload: { label: `${kind} record`, canary: `canary-of-${kind}` } };
    await f.documents.put(OWNER, kind, seed.id, seed.payload, { expectedRevision: 0, projectId: seed.projectId ?? null });
  }
  const held = [...f.documents.rows.values()];
  for (const kind of PRODUCT_KINDS) assert.ok(held.some((row) => row.kind === kind), `the account holds no ${kind} document`);
  // Row by row first, so a kind whose rule refuses its document is named here
  // rather than surfacing as an anonymous refusal of the whole archive.
  for (const row of held.filter((item) => accountExportDocumentKinds().includes(item.kind))) {
    let exported = null;
    assert.doesNotThrow(() => { exported = exportDocumentRow(structuredClone(row)); }, `the export refuses a ${row.kind} document`);
    assert.ok(exported, `the export cannot read a ${row.kind} document`);
  }

  const { state, reported } = await exportOf(f.documents);
  const carried = new Set(state.documents.map((row) => row.kind));
  for (const kind of PRODUCT_KINDS) {
    if (Object.hasOwn(UNEXPORTED_DOCUMENT_KINDS, kind)) {
      assert.ok(!carried.has(kind), `${kind} is declared unexported and was exported`);
    } else {
      assert.ok(carried.has(kind), `${kind} is declared exported and the archive does not carry it`);
    }
  }
  const serialized = JSON.stringify(state);
  // A kind exported as stored leaves with its marker, so the marker's absence
  // for a kind left out is the export's doing.
  assert.ok(serialized.includes("canary-of-capsule"));
  for (const kind of Object.keys(UNEXPORTED_DOCUMENT_KINDS)) {
    assert.ok(held.some((row) => row.kind === kind && row.payload.canary === `canary-of-${kind}`), `no ${kind} document carries a marker`);
    assert.ok(!serialized.includes(`canary-of-${kind}`), `a ${kind} payload left in the archive`);
  }
  // A kind left out on purpose is a decision, not a gap in this archive.
  assert.deepEqual(state.omissions, []);
  assert.deepEqual(reported, []);
});

test("a stored kind with no export decision is left out and named, and the rest of the account still exports", async (t) => {
  const f = await resultFixture(t);
  // What a database written by a newer release looks like to this code. The
  // in-memory store accepts any kind; PostgreSQL would accept one only from a
  // release whose PRODUCT_KINDS names it.
  await f.documents.put(OWNER, "future-kind", "future-one", { body: "future-payload-body" }, { expectedRevision: 0, projectId: f.project.id });
  await f.documents.put(OWNER, "future-kind", "future-two", { body: "future-payload-body" }, { expectedRevision: 0 });
  await f.documents.put(OWNER, "another-future-kind", "one", { body: "future-payload-body" }, { expectedRevision: 0 });
  const { state, reported } = await exportOf(f.documents);

  assert.deepEqual(state.omissions, [
    { kind: "future-kind", reason: "no_export_contract", documents: 2 },
    { kind: "another-future-kind", reason: "no_export_contract", documents: 1 },
  ].sort((a, b) => a.kind.localeCompare(b.kind)));
  // Named, never exported as stored.
  assert.ok(!JSON.stringify(state).includes("future-payload-body"));
  assert.ok(!state.documents.some((row) => row.kind.includes("future")));
  assert.ok(!state.revisions.some((row) => row.kind.includes("future")));
  // Everything with a contract is still there.
  assert.equal(state.documents.find((row) => row.id === f.report.versionId).payload.digest, sha(REPORT));
  assert.ok(state.documents.some((row) => row.kind === "agenda"));
  // And whoever runs the deployment is told, by kind and count.
  assert.deepEqual(reported, [
    "account export left out another-future-kind: no_export_contract, 1 documents\n",
    "account export left out future-kind: no_export_contract, 2 documents\n",
  ]);
});

test("a result record that does not read as one is left out and counted, not a refusal of the archive", async (t) => {
  const f = await resultFixture(t);
  const broken = { recordType: "result-version", versionId: "rv_not-a-version", artifactId: "ra_unknown", projectId: f.project.id, path: "report.md", digest: "short", size: 3, body: "unreadable-payload-body" };
  assert.equal(exportDocumentRow({ id: "rv_broken", kind: "result-version", projectId: f.project.id, payload: broken }), null);
  // A record filed under a result kind that is some other record entirely.
  for (const kind of ["result-version", "result-impact", "result-revision", "result-replay"]) {
    assert.equal(exportDocumentRow({ id: "misfiled", kind, payload: { recordType: "something-else", body: "x" } }), null, kind);
  }
  await f.documents.put(OWNER, "result-version", "rv_broken", broken, { expectedRevision: 0, projectId: f.project.id });
  const { state, reported } = await exportOf(f.documents);

  assert.deepEqual(state.omissions, [{ kind: "result-version", reason: "unreadable_record", documents: 1, revisions: 1 }]);
  assert.ok(!JSON.stringify(state).includes("unreadable-payload-body"));
  assert.ok(!state.documents.some((row) => row.id === "rv_broken"));
  assert.equal(state.documents.find((row) => row.id === f.report.versionId).payload.digest, sha(REPORT));
  assert.deepEqual(reported, ["account export left out result-version: unreadable_record, 1 documents, 1 revisions\n"]);
});
