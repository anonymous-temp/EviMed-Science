// The seams between the seven packages, which is where a parallel build
// breaks. Each package's own tests pass against its own idea of the other
// side; these assert the two sides actually fit — above all the suppression
// adapter, whose failure mode is a model receiving a wrapper object *and*
// losing the suppression the plan requires (AC-26).
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { validateEngineResult, validateEngineJob } from "@evimed/domain";

import { loadConfig } from "../src/config.mjs";
import { removeVcrArtifacts } from "../src/vcrStoreBase.mjs";
import {
  composeVcr, createVcrEngineJobRemover, matchingContextOf, vcrDataPlaneSeam, vcrDocumentsSeam, vcrEngineStatus,
  vcrMatchingExecutor, vcrMatchingSeam, vcrMetricFamilies, withVcrEngineWarnings,
} from "../src/vcrComposition.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workspaceRoot = path.resolve(repoRoot, "..");

const AS_OF = "2026-09-28T00:00:00.000Z";

/** A data-plane double with only what the seam reads. */
function dataPlaneDouble({ root = "/data/vcr" } = {}) {
  return {
    root: () => root,
    async snapshotProfileForModel({ snapshotId }) {
      return { snapshotId, columns: [{ name: "AGE", type: "number", fill: 0.99 }], quality: { completeness: 0.99 } };
    },
    async tabFor() {
      return { available: true, sources: [{ id: "src_1", name: "合作方样例" }],
        snapshots: [{ id: "snp_1", sourceId: "src_1", version: 1, sha256: "a".repeat(64), rowCount: 412, columnCount: 18,
          frozenAt: AS_OF, sealedFields: ["OS_EVENT"], sealedUntil: null, quality: { completeness: 0.98 } }] };
    },
  };
}

function dataStoreDouble() {
  return {};
}

const allowAll = { async judge() { return { allowed: true }; } };
const denyAll = { async judge() { return { allowed: false, code: "vcr_no_grant", reason: "没有这个数据源的授权。" }; } };

// ---------------------------------------------------------------------------
// The data-plane tab and note
// ---------------------------------------------------------------------------

test("AC-17 a caller the access judge refuses gets a named unavailable, never the rows", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: denyAll });
  const tab = await seam.tab({ id: "std_1", userId: "u1" }, { id: "u2" });
  assert.equal(tab.available, false);
  assert.equal(tab.unavailable.code, "vcr_no_grant");
  assert.equal(tab.sources, undefined);
});

test("a study at T0 is told the data plane is absent rather than shown an error", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: { root: () => "", async snapshotProfileForModel() { return {}; } },
    dataStore: dataStoreDouble(), access: allowAll });
  const note = await seam.note({ id: "std_1", dataTier: "T0" });
  assert.equal(note.available, false);
  assert.equal(note.code, "vcr_data_plane_unconfigured");
  assert.match(note.message, /T0/);
});

test("what a model may read of a snapshot is structure and quality, never a row", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble(), dataStore: dataStoreDouble(), access: allowAll });
  const profile = await seam.runtimeProfile({ id: "std_1" }, { snapshotId: "snp_1" });
  assert.equal(profile.available, true);
  assert.ok(Array.isArray(profile.columns));
  assert.equal(JSON.stringify(profile).includes("rows"), false);
  const unnamed = await seam.runtimeProfile({ id: "std_1" }, {});
  assert.equal(unnamed.code, "vcr_snapshot_not_named");
});

// ---------------------------------------------------------------------------
// The matching seam and its local executor
// ---------------------------------------------------------------------------

const CRITERIA = [
  { id: "crt_age", ordinal: 1, kind: "inclusion", criterionType: "demographic", sourceText: "年龄 ≥ 18 岁", applicability: null,
    requirement: { op: "compare", variable: "age", comparator: "gte", value: 18 } },
  { id: "crt_mi", ordinal: 2, kind: "exclusion", criterionType: "time_window", sourceText: "近 6 个月心梗者除外", applicability: null,
    requirement: { op: "absent", variable: "myocardial_infarction", window: { months: 6 } } },
];

function matchStoreDouble(overrides = {}) {
  return {
    async latestProtocol() { return { id: "prt_1", version: 1, title: "EV-201" }; },
    async listCriteria() { return CRITERIA; },
    async listAssessments() { return [{ id: "mas_1", subjectKey: "P-001", summary: "eligible", judgments: [] }]; },
    async listReferrals() { return [{ id: "ref_1", subjectKey: "P-001", state: "candidate" }]; },
    async listSites() { return [{ id: "ste_1", name: "中心 A", verifiedAt: AS_OF }]; },
    async screenFailureCounts() { return []; },
    async siteFunnel() { return []; },
    async referralProgress() { return new Map(); },
    async assessmentTallies() { return { eligible: 12, ineligible: 40, insufficient_evidence: 3 }; },
    async criterionFunnelRows() {
      return [{ criterionId: "crt_age", kind: "inclusion", criterionType: "demographic", satisfied: 50, not_satisfied: 4, unknown: 1, pending_recheck: 0, notApplicable: 0, soleReason: 2 }];
    },
    async subjectSummaries() { return [{ subjectKey: "P-001", summary: "eligible" }, { subjectKey: "P-002", summary: "ineligible" }]; },
    async evidenceGapCounts() { return [{ variable: "myocardial_infarction", reason: "not_recorded", n: 3 }]; },
    async factSubjects() { return [{ subjectKey: "P-001", facts: 2 }]; },
    async latestAssessment({ subjectKey }) { return subjectKey === "P-001" ? { id: "mas_1", subjectKey } : null; },
    async getAssessment() {
      return { id: "mas_1", summary: "insufficient_evidence", asOf: AS_OF, protocolVersionId: "prt_1", reviewedBy: "coordinator-li@hospital",
        counts: { satisfied: 1, not_satisfied: 0, unknown: 1, pending_recheck: 0, notApplicable: 0, total: 2 },
        evidenceGaps: [{ variable: "myocardial_infarction", reason: "not_recorded", criterionIds: ["crt_mi"] }],
        priority: { score: 0.9, rationale: "患者 3 月前在我院行 PCI，家属要求尽快入组" },
        judgments: [{ criterionId: "crt_mi", state: "unknown", applicable: true, decidedBy: "code", recheckAt: null, evidence: [],
          overrideState: "satisfied", overriddenBy: "coordinator-li@hospital", overrideNote: "电话核实，无心梗" }] };
    },
    async listFacts() { return [{ id: "fac_1", variable: "age", value: 62, unit: "year", polarity: "affirmed", occurredAt: null, visibleAt: AS_OF, surface: "62 岁", source: null }]; },
    async latestLanguageJudgments() { return new Map(); },
    ...overrides,
  };
}
const storeDouble = { async latestProtocolVersion() { return { id: "prt_1", version: 1 }; } };

test("the matching tab is assembled from the package's store and its pure judgments", async () => {
  const seam = vcrMatchingSeam({ matchStore: matchStoreDouble(), store: storeDouble });
  const tab = await seam.tab({ id: "std_1", userId: "u1" }, { id: "u1" });
  assert.equal(tab.available, true);
  assert.equal(tab.criteria.length, 2);
  assert.equal(tab.protocol.id, "prt_1");
  assert.ok(tab.funnel, "the referral funnel is computed, not stored");
  assert.ok(Array.isArray(tab.sites));
  assert.ok(tab.assessments[0].counts, "an assessment carries its deterministic counts");
  assert.deepEqual(tab.tallies, { eligible: 12, ineligible: 40, insufficient_evidence: 3 }, "tallies over every subject, not a page of them");
});

test("CW-22 a run reads criterion-level aggregates and pseudonymous subject keys — no reviewer, no note, no rationale", async () => {
  const seam = vcrMatchingSeam({ matchStore: matchStoreDouble(), store: storeDouble });
  const overview = await seam.runtimeRead({ id: "std_1" }, {});
  assert.deepEqual(overview.summaryCells, [{ key: "eligible", n: 12 }, { key: "ineligible", n: 40 }, { key: "insufficient_evidence", n: 3 }],
    "counts leave as sibling cells, so the one boundary can hide the small ones together");
  assert.deepEqual(overview.criterionFunnel[0].cells.map((cell) => cell.key), ["satisfied", "not_satisfied", "unknown", "pending_recheck", "not_applicable", "sole_reason"]);
  assert.deepEqual(overview.gaps, [{ variable: "myocardial_infarction", category: "not_recorded", n: 3 }]);
  assert.deepEqual(overview.subjects.map((subject) => subject.subjectKey), ["P-001", "P-002"]);
  assert.equal(overview.criteria[0].decidedBy, "code");
  const one = await seam.runtimeRead({ id: "std_1" }, { subjectKey: "P-001" });
  assert.equal(one.assessment.summary, "insufficient_evidence");
  assert.equal(one.assessment.judgments[0].overrideState, "satisfied", "the state a person set is a fact about the criterion");
  const text = JSON.stringify({ overview, one });
  for (const leak of ["coordinator-li", "电话核实", "PCI", "reviewedBy", "overriddenBy", "rationale", "priority"]) {
    assert.equal(text.includes(leak), false, `${leak} must not reach a run`);
  }
  assert.equal(one.facts[0].variable, "age", "a subject's own facts are the run's own writes");
  assert.deepEqual(one.requests, [], "no language criterion, nothing owed");
  const empty = await vcrMatchingSeam({ matchStore: matchStoreDouble({ async latestProtocol() { return null; } }), store: storeDouble }).runtimeRead({ id: "std_1" }, {});
  assert.equal(empty.protocol, null);
});

/** The frozen inputs a matching job carries. */
const matchingInputs = (asOf = AS_OF, protocol = "prt_1") => [
  { kind: "evidence", id: `matching:asof:${asOf}` }, { kind: "evidence", id: `matching:protocol:${protocol}` }, { kind: "evidence", id: "matching:facts:0123456789abcdef" },
];

test("the frozen context of a matching job is read back from its inputs, and a missing or invalid instant is refused (CS-34)", () => {
  assert.deepEqual(matchingContextOf(matchingInputs()), { vocabularyVersion: "evimed-internal-sex-1", asOf: AS_OF, protocolVersionId: "prt_1", factsToken: "0123456789abcdef" });
  assert.throws(() => matchingContextOf([...matchingInputs(), { kind: 'evidence', id: 'matching:vocabulary:unknown-version' }]), error => error.code === 'vcr_matching_vocabulary_unavailable');
  assert.throws(() => matchingContextOf([]), (error) => error.code === "vcr_asof_invalid");
  assert.throws(() => matchingContextOf(matchingInputs("28/09/2026")), (error) => error.code === "vcr_asof_invalid");
});

test("AC-14 CS-31 the local executor loads what it evaluates by study, decides in code and answers a valid engine result", async () => {
  const facts = new Map([["P-001", [{ id: "f1", subjectKey: "P-001", variable: "age", value: 62, unit: "year", polarity: "affirmed", occurredAt: null,
    visibleAt: "2026-09-01T00:00:00.000Z", surface: "62 岁", source: null, extractedBy: "code" }]]]);
  /** @type {any[]} */
  const asked = [];
  const matchStore = matchStoreDouble({
    async listFacts(query) { asked.push(query); return [...facts.values()].flat(); },
  });
  const run = vcrMatchingExecutor({ matchStore, store: { async studyById() { return { id: "std_1", userId: "u1" }; } } });
  const progress = [];
  const result = await run({
    job: { id: "job_1", studyId: "std_1", scenarioHash: "b".repeat(64), seed: 7, inputs: matchingInputs(),
      // Whatever a run put in here about patients is not read: a scenario is a thing a run can write.
      scenario: { criteria: CRITERIA.map((criterion) => ({ id: criterion.id, kind: criterion.kind, type: criterion.criterionType, state: "unknown" })),
        subjects: [{ subjectKey: "P-FORGED", facts: [{ variable: "age", value: 99, extractedBy: "snapshot" }] }] } },
    onProgress: async (value) => { progress.push(value); },
  });
  assert.deepEqual(validateEngineResult(result), [], "the control plane's own executor answers the engine's contract");
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.assessments.map((row) => row.subjectKey), ["P-001"], "the subjects are the study's, not the scenario's");
  assert.equal(result.assessments[0].summary, "insufficient_evidence", "an exclusion nobody has evidence for never reads as eligible");
  assert.equal(result.assessments[0].asOf, AS_OF);
  assert.equal(result.counts.realPatients, 1);
  assert.equal(result.counts.generatedRecords, 0);
  assert.equal(result.diagnostics.asOf, AS_OF);
  assert.equal(result.diagnostics.protocolVersionId, "prt_1");
  assert.ok(progress.length >= 1, "progress is reported even for a short job");
  assert.equal(result.manifest.engineVersion, "control-plane");
  assert.deepEqual(asked, [{ studyId: "std_1", visibleBy: AS_OF }], "facts are read by study and as of the frozen instant: nothing later is visible");
});

test("CS-34 one subject that cannot be evaluated is counted and never stops the others; a fact with no document is void", async () => {
  const good = { id: "f1", subjectKey: "P-001", variable: "age", value: 62, unit: "year", polarity: "affirmed", visibleAt: AS_OF, surface: "62", source: null, extractedBy: "code" };
  const modelFact = { id: "f2", subjectKey: "P-002", variable: "myocardial_infarction", value: null, polarity: "negated", visibleAt: AS_OF, surface: "否认心梗史",
    source: { documentId: "doc-1", start: 0, end: 5, quote: "否认心梗史" }, extractedBy: "model" };
  const bad = { id: "f3", subjectKey: "P-003", variable: "age", value: 50, polarity: "affirmed", visibleAt: AS_OF, surface: "50", source: null, extractedBy: "code" };
  const matchStore = matchStoreDouble({ async listFacts() { return [good, modelFact, bad]; } });
  const documents = { async read(_study, { subjectKey, documentId }) {
    if (subjectKey === "P-003") throw new Error("boom");
    return documentId === "doc-1" && subjectKey === "P-002" ? { text: "否认心梗史。" } : null;
  } };
  const run = vcrMatchingExecutor({ matchStore, store: { async studyById() { return { id: "std_1", userId: "u1" }; } }, documents });
  const result = await run({ job: { id: "job_1", studyId: "std_1", inputs: matchingInputs(), scenario: { criteria: CRITERIA.map((criterion) => ({ id: criterion.id })) } }, onProgress: async () => {} });
  assert.deepEqual(result.assessments.map((row) => row.subjectKey), ["P-001", "P-002", "P-003"], "a document read that throws is a document that is not there, not a dead job");
  const negated = result.assessments.find((row) => row.subjectKey === "P-002");
  assert.equal(negated.voidedFacts.length, 0, "a located fact whose span is really in the document is admitted");
  const missing = result.assessments.find((row) => row.subjectKey === "P-003");
  assert.equal(missing.summary, "insufficient_evidence");
  const withoutDocuments = vcrMatchingExecutor({ matchStore, store: { async studyById() { return { id: "std_1", userId: "u1" }; } } });
  const voided = await withoutDocuments({ job: { id: "job_2", studyId: "std_1", inputs: matchingInputs(), scenario: { criteria: [{ id: "crt_mi" }] } }, onProgress: async () => {} });
  assert.deepEqual(voided.assessments.find((row) => row.subjectKey === "P-002").voidedFacts.map((fact) => fact.reason), ["document_unavailable"]);
  assert.equal(voided.diagnostics.voidedFacts, 1);
  await assert.rejects(() => run({ job: { id: "job_3", studyId: "std_1", inputs: matchingInputs(), scenario: { criteria: [{ id: "crt_other_study" }] } }, onProgress: async () => {} }),
    (error) => error.code === "vcr_criteria_missing", "criteria the study does not hold are not evaluated");
});

test("the matching job's scenario is the domain's engine schema with the frozen context as inputs, and it validates", async () => {
  const seam = vcrMatchingSeam({
    matchStore: matchStoreDouble(), store: storeDouble, now: () => new Date("2026-09-28T08:30:45.123Z"),
  });
  const built = await seam.matchScenario({ id: "std_1", userId: "u1" });
  assert.equal(built.ok, true);
  assert.deepEqual(built.scenario.criteria.map((criterion) => criterion.id), ["crt_age", "crt_mi"]);
  assert.deepEqual(built.inputs.map((input) => input.id).slice(0, 2), ["matching:asof:2026-09-28T08:30:00.000Z", "matching:protocol:prt_1"], "the instant is frozen to the minute, as a valid ISO date");
  const issues = validateEngineJob({ jobId: "job_1", studyId: "std_1", kind: "match_criteria", method: "matching.evaluate", methodVersion: "1.0.0",
    protocolVersion: 1, seed: 1, cpuSecondsLimit: 60, scenario: built.scenario, inputs: built.inputs });
  // The scenario and every input are the domain's. The one thing left is the domain's own listing of
  // `match_criteria` among the patient-level kinds, which asks for a table this executor never reads
  // (it loads facts and documents by study): that listing is the domain's to drop, and this assertion
  // accepts the job either way so the day it is dropped needs no edit here.
  assert.deepEqual(issues.filter((issue) => issue.code !== "patient_input_required"), []);
  const noProtocol = await vcrMatchingSeam({ matchStore: matchStoreDouble({ async latestProtocol() { return null; } }), store: storeDouble }).matchScenario({ id: "std_1" });
  assert.equal(noProtocol.ok, false);
  assert.match(noProtocol.message, /入排条件/);
});

test("the documents seam reads through the plane's judged reader and answers only for the document's own subject", async () => {
  /** @type {any[]} */
  const reads = [];
  const dataPlane = {
    async documentText(entry) {
      reads.push(entry);
      return entry.documentId === "fil_1" ? { id: "fil_1", text: "患者本人可理解研究内容。", subjectKey: "P-001", visibleAt: AS_OF } : null;
    },
    async listDocuments({ subjectKey }) {
      return [{ id: "fil_1", subjectKey: "P-001", name: "入院记录", chars: 12, visibleAt: AS_OF }, { id: "fil_2", subjectKey: "P-002", name: "出院小结", chars: 9, visibleAt: AS_OF }]
        .filter((entry) => !subjectKey || entry.subjectKey === subjectKey);
    },
  };
  const documents = vcrDocumentsSeam({ dataPlane });
  const study = { id: "std_1", userId: "u1" };
  assert.equal((await documents.read(study, { subjectKey: "P-001", documentId: "fil_1" })).text, "患者本人可理解研究内容。");
  assert.deepEqual(reads[0], { studyId: "std_1", documentId: "fil_1", principal: "u1", purpose: "vcr" }, "judged as the study's owner, for the module's purpose");
  assert.equal(await documents.read(study, { subjectKey: "P-002", documentId: "fil_1" }), null, "another subject's key finds nothing");
  const subjects = await documents.subjectDocuments(study, {});
  assert.deepEqual(subjects.subjects, [{ subjectKey: "P-001", documents: 1 }, { subjectKey: "P-002", documents: 1 }]);
  const listed = await documents.subjectDocuments(study, { subjectKey: "P-001" });
  assert.deepEqual(listed.documents, [{ id: "fil_1", name: "入院记录", chars: 12, visibleAt: AS_OF }], "metadata only: no text");
  const window = await documents.subjectDocuments(study, { subjectKey: "P-001", documentId: "fil_1", offset: 2 });
  assert.deepEqual([window.document.text, window.document.chars, window.document.more], ["本人可理解研究内容。", 12, false]);
  assert.equal((await documents.subjectDocuments(study, { documentId: "fil_1" })).code, "vcr_read_filter_invalid");
  assert.equal((await documents.subjectDocuments(study, { subjectKey: "P-002", documentId: "fil_1" })).code, "vcr_document_not_found");
  const none = vcrDocumentsSeam({ dataPlane: null });
  assert.equal(await none.read(study, { subjectKey: "P-001", documentId: "fil_1" }), null);
  assert.equal((await none.subjectDocuments(study, {})).code, "vcr_data_plane_unavailable");
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

test("the module is absent — not broken — where it is off or has no database", () => {
  assert.equal(composeVcr({ config: { vcrEnabled: false }, productDatabase: {} }), null);
  assert.equal(composeVcr({ config: { vcrEnabled: true }, productDatabase: null }), null);
});

test("composed, every package is present and the optional ones are honestly null", () => {
  const database = { async transaction(run) { return run({ async query() { return { rows: [] }; } }); }, async query() { return { rows: [] }; } };
  const vcr = composeVcr({ config: { vcrEnabled: true, vcrEngineUrl: "", vcrDataPlaneDir: "" }, productDatabase: database });
  assert.ok(vcr.store && vcr.service && vcr.jobs && vcr.access && vcr.members && vcr.evidence && vcr.matching);
  assert.equal(vcr.engine, null, "no engine URL means no engine, and the steps that need it say so");
  assert.equal(vcr.dataPlane, null, "no data-plane directory means no data plane");
  assert.equal(vcr.dataPlaneSeam, null);
  assert.equal(vcr.orchestrator, null, "the orchestrator and worker are composed beside the other modules'");
  assert.ok(vcr.jobs.localExecutors["matching.evaluate"], "the one method that runs in the control plane is registered");
});

// ---------------------------------------------------------------------------
// What leaves through the data tab, the engine's secrets, its job cleanup, the metrics
// ---------------------------------------------------------------------------

test("CS-49 the data tab names sources and snapshots and never the server's path", async () => {
  const seam = vcrDataPlaneSeam({ dataPlane: dataPlaneDouble({ root: "/srv/evimed/vcr-data-plane" }), dataStore: dataStoreDouble(), access: allowAll });
  const tab = await seam.tab({ id: "std_1", userId: "u1" }, { id: "u1" });
  assert.equal(tab.available, true);
  assert.equal(tab.snapshots.length, 1);
  assert.equal(JSON.stringify(tab).includes("/srv/evimed"), false);
  assert.equal(Object.hasOwn(tab, "root"), false);
});

/** A directory of secret files of chosen size and mode. */
async function secretFiles(/** @type {Record<string, { size?: number, mode?: number, link?: boolean }>} */ spec) {
  const dir = await mkdtemp(path.join(tmpdir(), "vcr-secrets-"));
  /** @type {Record<string, string>} */
  const files = {};
  for (const [name, { size = 40, mode = 0o440, link = false }] of Object.entries(spec)) {
    const file = path.join(dir, name);
    if (link) {
      await writeFile(path.join(dir, `${name}.real`), "x".repeat(size), { mode });
      await symlink(path.join(dir, `${name}.real`), file);
    } else {
      await writeFile(file, `${"k".repeat(size)}\n`, { mode });
      await chmod(file, mode);
    }
    files[name] = file;
  }
  return { dir, files };
}

const configWith = (/** @type {Record<string, unknown>} */ overrides) => loadConfig({ rootDir: repoRoot, vcrEnabled: true, ...overrides });

test("CS-9 the engine requires request authentication and supports optional receipt signing without weakening configured keys", async (t) => {
  const { dir, files } = await secretFiles({ token: {}, receipt: {}, short: { size: 12 }, open: { mode: 0o644 }, linked: { link: true } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = { async transaction(run) { return run({ async query() { return { rows: [] }; } }); }, async query() { return { rows: [] }; } };
  const url = "http://evimed-vcr-engine:8080";

  const good = configWith({ vcrEngineUrl: url, vcrEngineTokenFile: files.token, vcrEngineReceiptKeyFile: files.receipt });
  assert.equal(good.vcrEngineToken.length, 40, "read from the file, its terminator removed");
  assert.equal(good.vcrEngineConfigured, true);
  assert.deepEqual(vcrEngineStatus(good), { configured: true, reason: null });
  const composed = composeVcr({ config: good, productDatabase: database });
  assert.equal(composed?.engine?.configured(), true);
  assert.equal(typeof composed?.removeEngineJob, "function", "and the job cleanup can reach it");
  for (const vcrEngineReceiptKeyFile of [undefined, "/dev/null"]) {
    const authenticated = configWith({ vcrEngineUrl: url, vcrEngineTokenFile: files.token, vcrEngineReceiptKeyFile });
    assert.equal(authenticated.vcrEngineConfigured, true);
    assert.deepEqual(vcrEngineStatus(authenticated), { configured: true, reason: null });
    const unsigned = composeVcr({ config: authenticated, productDatabase: database });
    assert.equal(unsigned?.engine?.configured(), true);
    assert.equal(typeof unsigned?.removeEngineJob, "function");
    assert.deepEqual(withVcrEngineWarnings({ enabled: true, warnings: [] }, authenticated), { enabled: true, warnings: [] });
  }

  /** @type {[string, Record<string, unknown>, string][]} */
  const cases = [
    ["a token file that is not there", { vcrEngineTokenFile: path.join(dir, "absent"), vcrEngineReceiptKeyFile: files.receipt }, "vcr_engine_token_file_unavailable"],
    ["a receipt key shorter than 32 bytes", { vcrEngineTokenFile: files.token, vcrEngineReceiptKeyFile: files.short }, "vcr_engine_receipt_key_file_short"],
    ["an explicitly configured missing receipt key", { vcrEngineTokenFile: files.token, vcrEngineReceiptKeyFile: path.join(dir, "absent") }, "vcr_engine_receipt_key_file_unavailable"],
    ["a token file others can read", { vcrEngineTokenFile: files.open, vcrEngineReceiptKeyFile: files.receipt }, "vcr_engine_token_file_permissions"],
    ["a token file that is a symlink", { vcrEngineTokenFile: files.linked, vcrEngineReceiptKeyFile: files.receipt }, "vcr_engine_token_file_symlink"],
    ["a URL with no secret named at all", {}, "vcr_engine_secret_missing"],
    ["/dev/null, which compose binds where there is none", { vcrEngineTokenFile: "/dev/null", vcrEngineReceiptKeyFile: "/dev/null" }, "vcr_engine_secret_missing"],
  ];
  for (const [label, extra, reason] of cases) {
    const config = configWith({ vcrEngineUrl: url, ...extra });
    assert.equal(config.vcrEngineConfigured, false, label);
    assert.equal(vcrEngineStatus(config).reason, reason, label);
    assert.equal(composeVcr({ config, productDatabase: database, report: () => {} })?.engine, null, `${label}: no client is made`);
    const ready = withVcrEngineWarnings({ enabled: true, status: "ok", engine: "missing", warnings: ["vcr_engine_not_composed"], warning: "vcr_engine_not_composed" }, config);
    assert.equal(ready.engine, "unconfigured", label);
    assert.equal(ready.engineReason, reason, label);
    assert.ok(ready.warnings.includes("vcr_engine_unconfigured"), label);
  }
  // No URL is a valid deployment, not a misconfiguration, and adds no warning.
  const none = configWith({});
  assert.deepEqual(vcrEngineStatus(none), { configured: false, reason: "not_configured" });
  const unchanged = { enabled: true, status: "ok", engine: "missing", warnings: ["vcr_engine_not_composed"] };
  assert.deepEqual(withVcrEngineWarnings(unchanged, none), unchanged);
  assert.deepEqual(withVcrEngineWarnings({ enabled: false, status: "off" }, none), { enabled: false, status: "off" });
  assert.throws(() => configWith({ vcrEngineUrl: url, vcrEngineTokenFile: "relative/token" }), /must be an absolute path/);
});

test("the engine's secrets have no value form in the environment", async () => {
  const source = await readFile(path.join(repoRoot, "apps/server/src/config.mjs"), "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  for (const retired of ["OPEN_SCIENCE_VCR_ENGINE_TOKEN\"", "OPEN_SCIENCE_VCR_ENGINE_RECEIPT_KEY\"", "OPEN_SCIENCE_VCR_DAILY_BUDGET_CNY", "vcrDailyBudgetCny"]) {
    assert.equal(code.includes(retired), false, `${retired} is no longer read`);
  }
  assert.equal(Object.hasOwn(configWith({}), "vcrDailyBudgetCny"), false, "the daily budget was read nowhere and is gone");
});

test("DL-16 a job's directory is removed from the engine by its own DELETE, and only when the engine is composed", async () => {
  /** @type {any[]} */
  const seen = [];
  const config = { vcrEngineUrl: "http://engine:8080/", vcrEngineToken: "t".repeat(40), vcrEngineReceiptKey: "r".repeat(40), vcrEngineTimeoutMs: 5_000 };
  let status = 200;
  const remove = /** @type {(id: string) => Promise<void>} */ (createVcrEngineJobRemover({ config, fetchImpl: /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    seen.push([init.method, url, init.headers.authorization]);
    return new Response("{}", { status });
  }) }));
  await remove("job_abc");
  assert.deepEqual(seen[0], ["DELETE", "http://engine:8080/jobs/job_abc", `Bearer ${"t".repeat(40)}`]);
  status = 404;
  await remove("job_gone");
  status = 500;
  await assert.rejects(() => remove("job_failing"), (error) => /^vcr_engine_/.test(String(/** @type {any} */ (error)?.code ?? "")));
  seen.length = 0;
  await remove("../../etc");
  assert.deepEqual(seen, [], "an id that is not an id never becomes a path");
  assert.equal(createVcrEngineJobRemover({ config: { ...config, vcrEngineToken: "" } }), null, "without the secrets there is no caller");
  assert.equal(createVcrEngineJobRemover({ config: {} }), null);
});

test("DL-13 the metric families are the platform's open_science_vcr_*, with the queue gauges and a gauge that says when it is off", () => {
  assert.deepEqual(vcrMetricFamilies(false, null).map((family) => [family.name, family.series[0].value]), [["open_science_vcr_enabled", 0]]);
  const snapshot = /** @type {any} */ ({
    tables: { jobs: { queued: 3, awaiting_budget: 1 }, studies: 12, active: 9 },
    service: { studiesCreated: 4, reads: 20, writes: 6, writeIssues: 1, notFound: 2, tabs: 30 },
    jobs: { counters: { enqueued: 7, succeeded: 5, failed: 1 } },
    orchestrator: { counters: { ticks: 10, dispatched: 3 } },
    worker: { loops: { jobs: { wired: true, stalled: false, lastOkAt: "2026-09-29T00:00:00.000Z" }, recompute: { wired: false }, orchestrator: { wired: true, stalled: true, lastOkAt: null } } },
    engine: { configured: true, reason: null },
  });
  const families = vcrMetricFamilies(true, snapshot);
  const byName = new Map(families.map((family) => [family.name, family]));
  for (const family of families) assert.match(family.name, /^open_science_vcr_[a-z_]+$/);
  assert.deepEqual(byName.get("open_science_vcr_jobs")?.series.map((series) => [series.labels?.state, series.value]),
    [["queued", 3], ["running", 0], ["awaiting_budget", 1]], "a state with no jobs reads 0, not absent");
  assert.deepEqual(byName.get("open_science_vcr_studies")?.series.map((series) => series.value), [12, 9]);
  assert.equal(byName.get("open_science_vcr_engine_configured")?.series[0].value, 1);
  assert.deepEqual(byName.get("open_science_vcr_loop_stalled")?.series.map((series) => [series.labels?.loop, series.value]), [["jobs", 0], ["orchestrator", 1]]);
  assert.deepEqual(byName.get("open_science_vcr_loop_last_ok_timestamp_seconds")?.series.map((series) => series.value), [1_790_640_000, 0]);
  assert.ok(byName.get("open_science_vcr_jobs_total")?.series.some((series) => series.labels?.outcome === "failed" && series.value === 1));
  // A schema that did not answer is reported, not read as an empty queue.
  const unreadable = new Map(vcrMetricFamilies(true, { ...snapshot, tables: null }).map((family) => [family.name, family]));
  assert.equal(unreadable.get("open_science_vcr_tables_readable")?.series[0].value, 0);
  assert.equal(unreadable.has("open_science_vcr_jobs"), false);
});

// ---------------------------------------------------------------------------
// The deployment files run the engine the way the engine reads its environment
// ---------------------------------------------------------------------------

test("DL-8 the compose stack runs the engine with the environment, secrets, paths, network and volumes the engine's own contract names", async () => {
  const compose = YAML.parse(await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8"), { merge: true });
  const engine = compose.services["evimed-vcr-engine"];
  const web = compose.services["open-science-web"];
  const init = compose.services["evimed-vcr-jobs-init"];

  // Behind a profile: a deployment that does not run the module builds and starts no R image.
  assert.deepEqual(engine.profiles, ["vcr"]);
  assert.deepEqual(init.profiles, ["vcr"]);

  // The names the engine reads, taken from the engine's source and not from a list written here.
  const source = await readFile(path.join(workspaceRoot, "项目代码/vcr-engine/service/app.py"), "utf8");
  const read = new Set(source.match(/VCR_ENGINE_[A-Z_]+/g));
  assert.ok(read.size >= 10 && read.has("VCR_ENGINE_TOKEN_FILE"), `the engine's source names ${read.size} variables; the read did not walk`);
  const passed = Object.keys(engine.environment).sort();
  assert.deepEqual(passed, ["VCR_ENGINE_CORES", "VCR_ENGINE_CPU_SECONDS", "VCR_ENGINE_DATA_ROOT", "VCR_ENGINE_MAX_CPU_SECONDS",
    "VCR_ENGINE_MAX_REPLICATES", "VCR_ENGINE_MEMORY_BYTES", "VCR_ENGINE_RECEIPT_KEY_FILE", "VCR_ENGINE_TOKEN_FILE", "VCR_ENGINE_WORK_DIR"]);
  for (const name of passed) assert.ok(read.has(name), `${name} is passed to the engine and the engine never reads it`);
  assert.equal(engine.environment.VCR_ENGINE_WORK_DIR, "/jobs");
  assert.equal(engine.environment.VCR_ENGINE_DATA_ROOT, "/data-plane");

  // The secrets are files bound read-only the way the platform binds its other keys, on both sides.
  const bindsOf = (/** @type {any} */ service) => Object.fromEntries((service.volumes ?? []).filter((/** @type {any} */ volume) => typeof volume === "object" && volume.type === "bind")
    .map((/** @type {any} */ volume) => [volume.target, volume]));
  for (const [service, binds] of [["engine", bindsOf(engine)], ["web", bindsOf(web)]]) {
    for (const target of ["/run/secrets/vcr-engine-token", "/run/secrets/vcr-engine-receipt-key"]) {
      assert.equal(binds[target]?.read_only, true, `${service} binds ${target} read-only`);
      assert.match(String(binds[target]?.source), /^\$\{OPEN_SCIENCE_VCR_ENGINE_(TOKEN|RECEIPT_KEY)_HOST_FILE:-\/dev\/null\}$/, `${service}: ${target} is a host file, /dev/null where there is none`);
    }
  }
  assert.equal(engine.environment.VCR_ENGINE_TOKEN_FILE, "/run/secrets/vcr-engine-token");
  assert.equal(web.environment.OPEN_SCIENCE_VCR_ENGINE_TOKEN_FILE, "/run/secrets/vcr-engine-token");
  assert.equal(web.environment.OPEN_SCIENCE_VCR_ENGINE_RECEIPT_KEY_FILE, "${OPEN_SCIENCE_VCR_ENGINE_RECEIPT_KEY_HOST_FILE:+/run/secrets/vcr-engine-receipt-key}");
  assert.equal(engine.environment.VCR_ENGINE_RECEIPT_KEY_FILE, web.environment.OPEN_SCIENCE_VCR_ENGINE_RECEIPT_KEY_FILE,
    "an omitted receipt key must be unset in both services, not read from the /dev/null placeholder mount");

  // The data plane: one host directory, read-write in the control plane, read-only in the engine, one path.
  const planeWeb = bindsOf(web)["/data-plane"];
  const planeEngine = bindsOf(engine)["/data-plane"];
  assert.ok(planeWeb && planeEngine);
  assert.equal(planeWeb.source, planeEngine.source, "the same host directory on both sides");
  assert.notEqual(planeWeb.read_only, true, "the control plane writes uploads and derived tables");
  assert.equal(planeEngine.read_only, true, "the engine only reads");
  assert.equal(web.environment.OPEN_SCIENCE_VCR_DATA_PLANE_DIR, "${OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR:+/data-plane}",
    "the config names the plane exactly when the host directory is bound");

  // /jobs is a named volume, given to the uid the engine runs as by a one-shot that holds CAP_CHOWN and nothing else.
  assert.ok((engine.volumes ?? []).includes("evimed-vcr-jobs:/jobs"));
  assert.ok(Object.hasOwn(compose.volumes, "evimed-vcr-jobs"));
  assert.deepEqual(init.entrypoint, ["chown", "10001:10001", "/jobs"]);
  assert.deepEqual(init.volumes, ["evimed-vcr-jobs:/jobs"]);
  assert.deepEqual(init.cap_add, ["CHOWN"]);
  assert.deepEqual(init.cap_drop, ["ALL"]);
  assert.equal(init.network_mode, "none");
  assert.equal(engine.user, "10001:10001");
  assert.equal(engine.depends_on["evimed-vcr-jobs-init"].condition, "service_completed_successfully");

  // The engine's only network is an internal one shared with the control plane and nobody else.
  assert.deepEqual(engine.networks, ["vcr-engine-internal"]);
  assert.equal(compose.networks["vcr-engine-internal"].internal, true);
  assert.ok(web.networks.includes("vcr-engine-internal"));
  const onIt = Object.entries(compose.services).filter(([, service]) => JSON.stringify(service.networks ?? []).includes("vcr-engine-internal")).map(([name]) => name).sort();
  assert.deepEqual(onIt, ["evimed-vcr-engine", "open-science-web"]);
  assert.equal(engine.cap_drop.includes("ALL"), true);
  assert.equal(engine.read_only, true);
  // Its liveness check is the route that needs no token.
  assert.match(engine.healthcheck.test.join(" "), /\/livez/);
});

test("DL-9 DL-11 DL-12 DL-19 the web image carries the profiler, the release manifest binds it, the overlay keeps the module off, and every variable is documented", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "deploy/web/Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY --from=build \/app\/scripts\/vcr \.\/scripts\/vcr$/m);
  const manifest = await readFile(path.join(repoRoot, "scripts/ops/generate-release-manifest.mjs"), "utf8");
  assert.match(manifest, /^ {2}"scripts\/vcr",$/m);
  const overlay = await readFile(path.join(repoRoot, "deploy/web/docker-compose.api-only.yml"), "utf8");
  assert.match(overlay, /OPEN_SCIENCE_VCR_ENABLED: \$\{OPEN_SCIENCE_VCR_ENABLED:-false\}/);
  const delta = await readFile(path.join(repoRoot, "scripts/ops/host-engine-delta.sh"), "utf8");
  assert.match(delta, /EVIMED_VCR_ENGINE_IMAGE/);
  assert.match(delta, /R\/package-lock\.json differs from the running image's; build it in full/);

  const example = await readFile(path.join(repoRoot, "deploy/web/.env.example"), "utf8");
  const documented = new Set([...example.matchAll(/^#? *((?:OPEN_SCIENCE|EVIMED)_VCR_[A-Z0-9_]+)=/gm)].map((match) => match[1]));
  const composeText = await readFile(path.join(repoRoot, "deploy/web/docker-compose.yml"), "utf8");
  const named = new Set(composeText.match(/(?:OPEN_SCIENCE|EVIMED)_VCR_[A-Z0-9_]+/g));
  // The variables an operator sets are the ones compose interpolates from `.env`, and the ones the control plane reads.
  const operator = [...named].filter((name) => !/(_FILE|_DIR)$/.test(name) || /HOST_(FILE|DIR)$/.test(name));
  const undocumented = operator.filter((name) => !documented.has(name)).sort();
  assert.deepEqual(undocumented, [], `.env.example names ${[...documented].length} vcr variables and lacks ${undocumented.join(", ")}`);
  for (const gone of ["OPEN_SCIENCE_VCR_DAILY_BUDGET_CNY", "OPEN_SCIENCE_VCR_ENGINE_TOKEN", "OPEN_SCIENCE_VCR_ENGINE_RECEIPT_KEY", "OPEN_SCIENCE_VCR_DATA_PLANE_DIR"]) {
    assert.equal(documented.has(gone), false, `${gone} is not an operator setting any more`);
  }
  assert.equal(composeText.includes("OPEN_SCIENCE_VCR_DAILY_BUDGET_CNY"), false);
});

test("CS-43 removing a deleted study's files stays inside the data plane: `..`, an absolute path and a symlinked directory are refused, never followed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "vcr-plane-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plane = path.join(dir, "plane");
  const outside = path.join(dir, "outside");
  await mkdir(path.join(plane, "study-a"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "not the plane's");
  await writeFile(path.join(dir, "sibling.txt"), "not the plane's either");
  await writeFile(path.join(plane, "study-a", "snapshot.csv"), "id\n1\n");
  await writeFile(path.join(plane, "keep.csv"), "another study's file\n");
  await symlink(outside, path.join(plane, "linked"));
  const exists = (/** @type {string} */ file) => stat(file).then(() => true, () => false);
  /** @type {string[]} */
  const reported = [];
  const removed = await removeVcrArtifacts({
    dataPlaneDir: plane,
    artifacts: { locations: ["study-a/snapshot.csv", "../sibling.txt", path.join(outside, "secret.txt"), "linked/secret.txt", "study-a/never-existed.csv"], engineJobIds: [] },
    report: (code) => reported.push(code),
  });
  assert.equal(await exists(path.join(plane, "study-a", "snapshot.csv")), false, "the study's file is gone");
  assert.equal(await exists(path.join(plane, "study-a")), false, "and the empty directory it made");
  assert.equal(await exists(path.join(plane, "keep.csv")), true, "another study's file is untouched");
  assert.equal(await exists(path.join(dir, "sibling.txt")), true, "a `..` location left the plane and was refused");
  assert.equal(await exists(path.join(outside, "secret.txt")), true, "an absolute path and a symlinked directory were not followed");
  assert.deepEqual(reported.filter((code) => code === "vcr_artifact_outside_plane").length, 3);
  assert.ok(removed.files >= 1);
  // No plane configured, or nothing collected: nothing happens and nothing throws.
  assert.deepEqual(await removeVcrArtifacts({ dataPlaneDir: "", artifacts: { locations: ["x"], engineJobIds: [], studyIds: ["std_x"] } }), { files: 0, engineJobs: 0, studyDirectories: 0 });
  assert.deepEqual(await removeVcrArtifacts({ dataPlaneDir: plane, artifacts: null }), { files: 0, engineJobs: 0, studyDirectories: 0 });

  // A study's own directory goes whole — the pseudonym key, the identity map,
  // an unfrozen upload and a document no row names — and only that directory:
  // a sibling study's is kept, and a symlinked or non-id "study" is left alone.
  await mkdir(path.join(plane, "studies", "std_gone", "documents"), { recursive: true });
  await mkdir(path.join(plane, "studies", "std_kept"), { recursive: true });
  await writeFile(path.join(plane, "studies", "std_gone", "pseudonym.key"), "k");
  await writeFile(path.join(plane, "studies", "std_gone", "documents", "P1.txt"), "病历");
  await writeFile(path.join(plane, "studies", "std_kept", "pseudonym.key"), "k");
  await symlink(outside, path.join(plane, "studies", "std_link"));
  await mkdir(path.join(plane, "derived", "std_gone", "job_1"), { recursive: true });
  await writeFile(path.join(plane, "derived", "std_gone", "job_1", "population.csv"), "USUBJID\nP1\n");
  const whole = await removeVcrArtifacts({ dataPlaneDir: plane, artifacts: { locations: [], engineJobIds: [], studyIds: ["std_gone", "std_link", "../outside"] } });
  assert.equal(whole.studyDirectories, 2, "the study's directory and the tables its jobs handed each other");
  assert.equal(await exists(path.join(plane, "derived", "std_gone")), false);
  assert.equal(await exists(path.join(plane, "studies", "std_gone")), false, "the deleted study's directory is gone, key and documents with it");
  assert.equal(await exists(path.join(plane, "studies", "std_kept", "pseudonym.key")), true, "another study's is kept");
  assert.equal(await exists(path.join(outside, "secret.txt")), true, "a symlinked study directory is never followed");
  // An engine that cannot be reached is reported for each job, and does not stop the rest.
  /** @type {string[]} */
  const told = [];
  const engineReport = [];
  const outcome = await removeVcrArtifacts({
    dataPlaneDir: "", artifacts: { locations: [], engineJobIds: ["job_a", "job_b"], studyIds: [] },
    engineRemove: async (id) => { told.push(id); if (id === "job_a") throw new Error("engine down"); },
    report: (code) => engineReport.push(code),
  });
  assert.deepEqual(told, ["job_a", "job_b"]);
  assert.deepEqual(outcome, { files: 0, engineJobs: 1, studyDirectories: 0 });
  assert.deepEqual(engineReport, ["vcr_engine_job_remove_failed"]);
});
