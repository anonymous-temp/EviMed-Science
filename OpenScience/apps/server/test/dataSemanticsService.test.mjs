// What a project's datasets mean, in the product ledger: facts merge by basis, a correction is a revision and
// survives a later inference, the same dataset id in two projects is two assets, a lost race is retried, and a
// record that cannot fit is refused by name — on a ledger double that has the real one's bounds.
import assert from "node:assert/strict";
import test from "node:test";

import { DATA_SEMANTICS_LIMITS } from "@evimed/domain";
import { DataSemanticsService, dataSemanticsDocumentId } from "../src/dataSemanticsService.mjs";
import { HttpError } from "../src/security.mjs";
import { productDocumentsDouble } from "./helpers/productDocumentsDouble.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const inferred = { basis: "model_inferred", inferredFrom: ["data-profile.json"] };

/** The shared ledger double, with a switch that loses the next N writes to a concurrent writer and a count of the writes tried. */
function ledger() {
  const documents = productDocumentsDouble();
  const control = { conflicts: 0, puts: 0 };
  const put = documents.put.bind(documents);
  documents.put = async (...args) => {
    control.puts += 1;
    if (control.conflicts > 0) {
      control.conflicts -= 1;
      throw new HttpError(409, "product_revision_conflict", "The record changed; reload before saving.");
    }
    return put(...args);
  };
  return Object.assign(documents, { control });
}

function fixture() {
  const documents = ledger();
  let tick = 0;
  const service = new DataSemanticsService({ documents, now: () => `2026-10-04T08:00:${String(tick++).padStart(2, "0")}.000Z` });
  return { documents, service };
}

/** @param {any} outcomes @param {string} target */
const outcomeOf = (outcomes, target) => outcomes.find((item) => item.target === target)?.outcome;

test("a second analysis of the same dataset in the same project starts from the stored interpretation", async () => {
  const { service } = fixture();
  const first = await service.write("u", "p1", {
    datasetId: "visits", title: "Sepsis visits", ...inferred,
    tables: [{ name: "visits.csv", observationUnit: "one row per patient visit", subjectKey: ["patient_id"], observationKey: ["patient_id", "visit_no"] }],
    variables: [{ table: "visits.csv", name: "creatinine", unit: "umol/L", type: "number" }],
    bindings: [{ table: "visits.csv", path: "data/visits.csv", sha256: HASH_A, bytes: 100, rows: 180, columns: [{ name: "creatinine", type: "number", missing: 0, distinct: 150 }] }],
  }, { via: "conversation" });
  assert.equal(first.revision, 1);
  assert.deepEqual(first.issues, []);
  assert.equal(first.summary.modelInferred, 5);

  // The next run reads it instead of re-inferring.
  const again = await service.get("u", "p1", "visits");
  assert.equal(again.asset.tables[0].variables[0].facts.unit.value, "umol/L");
  assert.equal(again.asset.bindings[0].sha256, HASH_A);
  assert.equal(again.interpretation, first.interpretation);
  assert.equal((await service.list("u", "p1")).length, 1);
  assert.equal((await service.list("u", "p1"))[0].tables[0].rows, 180);
});

test("a researcher's correction is kept as a confirmed fact and is not overwritten by a later inference", async () => {
  const { service, documents } = fixture();
  await service.write("u", "p", { datasetId: "labs", ...inferred, variables: [{ table: "l.csv", name: "glucose", unit: "mg/dL" }] }, { via: "conversation" });
  const corrected = await service.write("u", "p", {
    datasetId: "labs", basis: "researcher_confirmed", statement: "这一列的单位是 mmol/L", variables: [{ table: "l.csv", name: "glucose", unit: "mmol/L" }],
  }, { via: "conversation" });
  assert.equal(outcomeOf(corrected.outcomes, "variable:l.csv/glucose:unit"), "applied");
  const later = await service.write("u", "p", { datasetId: "labs", ...inferred, variables: [{ table: "l.csv", name: "glucose", unit: "mg/dL" }] }, { via: "conversation" });
  assert.equal(outcomeOf(later.outcomes, "variable:l.csv/glucose:unit"), "kept_stronger");
  const stored = (await service.get("u", "p", "labs")).asset.tables[0].variables[0].facts.unit;
  assert.equal(stored.value, "mmol/L");
  assert.equal(stored.basis, "researcher_confirmed");
  assert.equal(stored.contested[0].value, "mg/dL");
  // The ledger kept every version: the correction is a revision, not an overwrite.
  const history = await documents.history("u", "dataset-semantics", dataSemanticsDocumentId("p", "labs"));
  assert.deepEqual(history.map((entry) => entry.revision), [3, 2, 1]);
  assert.equal(history[2].payload.tables[0].variables[0].facts.unit.value, "mg/dL");
  assert.equal(history[1].payload.tables[0].variables[0].facts.unit.value, "mmol/L");
});

test("writing what is already recorded is not a new revision", async () => {
  const { service, documents } = fixture();
  const patch = { datasetId: "d", ...inferred, variables: [{ table: "t.csv", name: "c", unit: "mg" }] };
  await service.write("u", "p", patch, { via: "conversation" });
  const second = await service.write("u", "p", patch, { via: "conversation" });
  assert.equal(second.changed, false);
  assert.equal(second.revision, 1);
  assert.equal(documents.control.puts, 1);
});

test("a new delivery rebinds the source version and the old one stays in the history", async () => {
  const { service } = fixture();
  const bind = (sha256, rows) => ({ datasetId: "d", bindings: [{ table: "t.csv", path: "t.csv", sha256, bytes: 1, rows, columns: [] }] });
  await service.write("u", "p", bind(HASH_A, 180), { via: "conversation" });
  const second = await service.write("u", "p", bind(HASH_B, 183), { via: "conversation" });
  assert.equal(outcomeOf(second.outcomes, "binding:t.csv"), "rebound");
  const { asset } = await service.get("u", "p", "d");
  assert.equal(asset.bindings[0].sha256, HASH_B);
  assert.deepEqual(asset.bindingHistory.map((entry) => [entry.sha256, entry.rows]), [[HASH_A, 180]]);
});

test("one dataset id in two projects is two assets, and one account never reads another's", async () => {
  const { service } = fixture();
  await service.write("u", "p1", { datasetId: "visits", title: "in p1" }, { via: "conversation" });
  await service.write("u", "p2", { datasetId: "visits", title: "in p2" }, { via: "conversation" });
  assert.equal((await service.get("u", "p1", "visits")).asset.title, "in p1");
  assert.equal((await service.get("u", "p2", "visits")).asset.title, "in p2");
  assert.notEqual(dataSemanticsDocumentId("p1", "visits"), dataSemanticsDocumentId("p2", "visits"));
  assert.equal(await service.get("other", "p1", "visits"), null);
  assert.deepEqual(await service.list("other", "p1"), []);
  await assert.rejects(() => service.recordCheck("other", "p1", "visits", { checkedAt: "2026-10-04T08:00:00.000Z" }, {}), (error) => error.code === "semantics_asset_not_found");
});

test("a lost race is read again and the patch applied to what is there; a loser that keeps losing is told", async () => {
  const { service, documents } = fixture();
  await service.write("u", "p", { datasetId: "d", ...inferred, variables: [{ table: "t.csv", name: "a", unit: "mg" }] }, { via: "conversation" });
  documents.control.conflicts = 2;
  const done = await service.write("u", "p", { datasetId: "d", ...inferred, variables: [{ table: "t.csv", name: "b", unit: "kg" }] }, { via: "conversation" });
  assert.equal(done.revision, 2);
  assert.deepEqual((await service.get("u", "p", "d")).asset.tables[0].variables.map((variable) => variable.name), ["a", "b"]);
  documents.control.conflicts = 99;
  await assert.rejects(() => service.write("u", "p", { datasetId: "d", title: "x" }, { via: "conversation" }), (error) => error.code === "semantics_revision_conflict");
});

test("a bad item is refused by name and the rest is written; a bad dataset id writes nothing", async () => {
  const { service, documents } = fixture();
  const result = await service.write("u", "p", {
    datasetId: "d", ...inferred,
    variables: [{ table: "t.csv", name: "good", unit: "mg" }, { table: "t.csv", name: "bad", type: "decimal" }],
  }, { via: "conversation" });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, "type_invalid");
  assert.equal(result.summary.variables, 2 - 1);
  await assert.rejects(() => service.write("u", "p", { datasetId: "Bad Id" }, { via: "conversation" }), (error) => error.code === "semantics_dataset_invalid");
  await assert.rejects(() => service.get("u", "p", "../x"), (error) => error.code === "semantics_dataset_invalid");
  assert.equal(documents.rows.size, 1);
});

test("the page confirms what it shows with the researcher's basis and cannot state a source version", async () => {
  const { service } = fixture();
  await service.write("u", "p", { datasetId: "d", ...inferred, variables: [{ table: "t.csv", name: "c", unit: "mg", type: "number" }] }, { via: "conversation" });
  const confirmed = await service.confirm("u", "p", "d", ["variable:t.csv/c:unit", "variable:t.csv/c:nope"]);
  assert.deepEqual(confirmed.unknown, ["variable:t.csv/c:nope"]);
  assert.equal(outcomeOf(confirmed.outcomes, "variable:t.csv/c:unit"), "upgraded");
  const { asset } = await service.get("u", "p", "d");
  const facts = asset.tables[0].variables[0].facts;
  assert.deepEqual([facts.unit.basis, facts.unit.via, facts.type.basis], ["researcher_confirmed", "page", "model_inferred"]);
  await assert.rejects(() => service.confirm("u", "p", "missing", ["x"]), (error) => error.code === "semantics_asset_not_found");
  await assert.rejects(() => service.confirm("u", "p", "d", []), (error) => error.code === "semantics_request_invalid");
});

test("a check's findings are kept with the denominators it saw, and a transformation says what changed", async () => {
  const { service, documents } = fixture();
  await service.write("u", "p", { datasetId: "d", title: "d" }, { via: "conversation" });
  const report = { checkedAt: "2026-10-04T09:00:00.000Z", bindings: [], findings: [{ outcome: "duplicate_exact", subject: { table: "t.csv" }, count: 3, rows: [4, 9] }], notChecked: [], clean: [] };
  const before = (await documents.history("u", "dataset-semantics", dataSemanticsDocumentId("p", "d"))).length;
  const recorded = await service.recordCheck("u", "p", "d", report, { analysed: { rows: 150, subjects: 35 } });
  assert.equal(recorded.recorded, true);
  // A check is how the data looked, not a change of its meaning: it moves the revision and adds no history row.
  assert.equal((await documents.history("u", "dataset-semantics", dataSemanticsDocumentId("p", "d"))).length, before);
  assert.equal(recorded.revision, 2);
  const stored = (await service.get("u", "p", "d")).asset;
  assert.deepEqual(stored.lastCheck.summary, { attention: 1, information: 0, notChecked: 0, clean: 0 });
  assert.deepEqual(stored.denominators.analysed, { rows: 150, subjects: 35, source: "measured", at: stored.denominators.analysed.at });

  const record = (extra = {}) => ({ name: "egfr", kind: "derive", inputs: [{ table: "t.csv", columns: ["creatinine"] }], code: { path: "a/egfr.py", sha256: HASH_A }, ...extra });
  assert.deepEqual(pick(await service.recordTransformation("u", "p", "d", record())), { status: "new", version: 1, changed: [] });
  assert.deepEqual(pick(await service.recordTransformation("u", "p", "d", record())), { status: "same", version: 1, changed: [] });
  assert.deepEqual(pick(await service.recordTransformation("u", "p", "d", record({ code: { path: "a/egfr.py", sha256: HASH_B } }))), { status: "changed", version: 2, changed: ["code"] });
  await assert.rejects(() => service.recordTransformation("u", "p", "d", { name: "bad name" }), (error) => error.code === "semantics_request_invalid");
  await assert.rejects(() => service.recordCheck("u", "p", "d", { nope: 1 }, {}), (error) => error.code === "semantics_request_invalid");
});

/** @param {any} result */
function pick(result) { return { status: result.status, version: result.version, changed: result.changed }; }

test("a transformation can be recorded before any meaning is, and starts the dataset", async () => {
  const { service } = fixture();
  const done = await service.recordTransformation("u", "p", "fresh", { name: "t", kind: "filter", inputs: [{ table: "a.csv" }] });
  assert.equal(done.status, "new");
  assert.equal((await service.get("u", "p", "fresh")).asset.transformations[0].name, "t");
});

test("a project records at most its limit of datasets, and an asset that cannot fit is refused by name", async () => {
  const { service } = fixture();
  for (let index = 0; index < DATA_SEMANTICS_LIMITS.datasetsPerProject; index += 1) await service.write("u", "p", { datasetId: `d${index}`, title: "x" }, { via: "conversation" });
  await assert.rejects(() => service.write("u", "p", { datasetId: "one-more", title: "x" }, { via: "conversation" }), (error) => error.code === "semantics_too_many_datasets");
  // Another project has its own allowance.
  await service.write("u", "q", { datasetId: "one-more", title: "x" }, { via: "conversation" });

  const roomy = fixture().service;
  const tables = Array.from({ length: 20 }, (_, index) => ({
    table: `t${index}.csv`, path: `t${index}.csv`, sha256: HASH_A, bytes: 1, rows: 1,
    columns: Array.from({ length: 300 }, (_x, column) => ({ name: `column_${column}_${"x".repeat(100)}`, type: "number", missing: 1, distinct: 9 })),
  }));
  await assert.rejects(() => roomy.write("u", "p", { datasetId: "huge", bindings: tables }, { via: "conversation" }), (error) => error.code === "semantics_asset_too_large");
});

test("a consumer of the change cannot fail the write it was told about, nor make it run twice", async () => {
  const documents = ledger();
  const seen = [];
  // A consumer whose own failure looks exactly like the write's lost race: the write must not read it as one.
  const service = new DataSemanticsService({ documents, now: () => "2026-10-05T08:00:00.000Z",
    onChanged: async (event) => { seen.push(event); throw new HttpError(409, "product_revision_conflict", "the consumer's own record changed"); } });
  const written = await service.write("u", "p1", { datasetId: "visits", title: "Sepsis visits", ...inferred,
    tables: [{ name: "visits.csv", observationUnit: "one row per patient visit" }] }, { via: "conversation" });
  assert.equal(written.revision, 1);
  assert.equal(documents.control.puts, 1, "the record was written once");
  assert.equal(seen.length, 1);
  assert.equal((await service.get("u", "p1", "visits")).revision, 1);
  const synchronous = new DataSemanticsService({ documents, now: () => "2026-10-05T08:00:01.000Z", onChanged: () => { throw new Error("not even a synchronous one"); } });
  assert.equal((await synchronous.write("u", "p2", { datasetId: "visits", title: "Other", ...inferred, tables: [{ name: "visits.csv", observationUnit: "one row per visit" }] }, { via: "conversation" })).revision, 1);
});
