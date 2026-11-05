// A table study screened by its rules is read a page at a time and leaves as a file: sixty people uploaded through the plane, evaluated by the rules, then the
// tab's server-cut page (25 a page, a verdict to narrow to, the counts the whole table's) and the rule file of every person. PostgreSQL and the real plane; the model is a double.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { DataSemanticsService } from "../src/dataSemanticsService.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { composeVcr } from "../src/vcrComposition.mjs";
import { rulesExporter } from "../src/vcrMatchRulesExport.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "An isolated PostgreSQL is required", timeout: 60_000 };
let isolated, database, directory, vcr, semantics;
const PEOPLE = 60;
const COHORT = ["ID,AGE,DIABETES", ...Array.from({ length: PEOPLE }, (_, index) => `S${String(index + 1).padStart(3, "0")},${index % 10 === 0 ? 12 : 50 + (index % 7)},${index % 3 === 0 ? 1 : 0}`)].join("\n");
const MAP = [
  { table: "cohort.csv", column: "ID", role: "subject_key", identifier: true },
  { table: "cohort.csv", column: "AGE", role: "covariate", alias: "age", unit: "year", concept: "age", type: "integer" },
  { table: "cohort.csv", column: "DIABETES", role: "covariate", alias: "diabetes", concept: "diabetes" },
];

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "vcrrulespage");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('owner','Owner','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner','project','Project',100000000)");
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-rulespage-"));
  await fs.mkdir(path.join(directory, "plane"));
  semantics = new DataSemanticsService({ documents: new ProductDocuments(database) });
  const fetchImpl = async () => new Response(JSON.stringify({ id: "x", model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ columns: [{ name: "diabetes", concept: "diabetes", measurement: false, values: { 1: "present", 0: "absent" } }] }) } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  vcr = composeVcr({ productDatabase: database, fetchImpl, dataSemantics: () => semantics, config: { vcrEnabled: true, vcrAudience: "all", vcrDataPlaneDir: await fs.realpath(path.join(directory, "plane")), deepseekBaseUrl: "https://api.example.org", deepseekApiKey: "test", deepseekModel: "deepseek-flash", vcrProviderAgreements: true } });
  await vcr.store.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

test("sixty people screened by rules: the page is 25 with the whole table's counts, a verdict narrows it, and the file holds everyone", options, async () => {
  const study = await vcr.store.createStudy({ userId: "owner", projectId: "project", name: "Table", question: "q", dataTier: "T1" });
  const source = await vcr.dataPlane.registerSource({ userId: "owner", studyId: study.id, name: "基线表", ownerParty: "医院", allowedUses: ["vcr", "matching"] });
  await vcr.dataPlane.storeUpload({ actor: "owner", studyId: study.id, sourceId: source.id, name: "cohort.csv", stream: Readable.from([Buffer.from(COHORT)]) });
  const proposed = await vcr.dataPlane.proposeFieldMap({ actor: "owner", studyId: study.id, sourceId: source.id, columns: MAP });
  await vcr.dataPlane.confirmFieldMap({ actor: "owner", studyId: study.id, sourceId: source.id, hash: proposed.hash });
  await vcr.dataPlane.freezeSnapshot({ userId: "owner", studyId: study.id, sourceId: source.id });
  await vcr.matchStore.saveProtocolVersion({ studyId: study.id, userId: "owner", title: "P", criteria: [
    { kind: "inclusion", criterionType: "demographic", sourceText: "Age >= 18", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "year" } },
    { kind: "exclusion", criterionType: "diagnosis", sourceText: "Diabetes", requirement: { op: "not", operand: { op: "present", variable: "diabetes" } } },
  ] });
  await vcr.matching.enqueuePanel(study, { direction: "trial_to_patient" }, "page");
  for (let turn = 0; turn < 40; turn += 1) {
    const claimed = await vcr.jobs.claim({});
    if (!claimed.length) break;
    for (const job of claimed) await vcr.jobs.advance(job, { mayYield: true });
  }
  const stored = await database.query("SELECT summary, count(*)::int AS n FROM evimed_vcr.matching_assessments WHERE study_id = $1 GROUP BY 1", [study.id]);
  const whole = Object.fromEntries(stored.rows.map((row) => [row.summary, row.n]));
  assert.equal(Object.values(whole).reduce((sum, n) => sum + n, 0), PEOPLE);
  assert.ok(whole.eligible > 0 && whole.ineligible > 0);

  const first = await vcr.service.tab({ id: "owner" }, study.id, "matching", {});
  assert.equal(first.candidates.length, 25, "a page is 25 people, not 50 and not everyone");
  assert.deepEqual([first.people.total, first.people.offset, first.people.limit, first.people.more], [PEOPLE, 0, 25, true]);
  assert.equal(first.funnel.find((step) => step.key === "candidates").count, PEOPLE, "the count is the whole table's");
  assert.equal(first.funnel.find((step) => step.key === "eligible").count, whole.eligible);
  assert.ok(first.candidates.every((candidate, at) => at === 0 || candidate.eligibility !== "eligible" || first.candidates[at - 1].eligibility === "eligible"), "those still in play come first");
  const last = await vcr.service.tab({ id: "owner" }, study.id, "matching", { offset: "50" });
  assert.equal(last.candidates.length, PEOPLE - 50);
  assert.equal(last.people.more, false);
  const seen = new Set([...first.candidates, ...(await vcr.service.tab({ id: "owner" }, study.id, "matching", { offset: "25" })).candidates, ...last.candidates].map((candidate) => candidate.id));
  assert.equal(seen.size, PEOPLE, "the pages do not overlap and leave nobody out");

  const narrowed = await vcr.service.tab({ id: "owner" }, study.id, "matching", { verdict: "ineligible" });
  assert.equal(narrowed.people.total, whole.ineligible);
  assert.ok(narrowed.candidates.every((candidate) => candidate.eligibility === "ineligible"));
  await assert.rejects(vcr.service.tab({ id: "owner" }, study.id, "matching", { verdict: "possible" }), /verdict is/u);
  await assert.rejects(vcr.service.tab({ id: "owner" }, study.id, "matching", { limit: "1000" }), /whole numbers/u);
  const named = await vcr.service.tab({ id: "owner" }, study.id, "matching", { candidate: last.candidates[0].id });
  assert.ok(named.candidates.some((candidate) => candidate.id === last.candidates[0].id), "a person asked for by name is on the page");

  // The file: everyone, not the page in view.
  const written = async (/** @type {any} */ options) => {
    const file = await rulesExporter(vcr.matchStore, study, options);
    let text = "";
    await file.run({ write: async (chunk) => { text += chunk; } });
    return { file, text };
  };
  const pairs = await written({ format: "csv", kind: "pairs", protocolVersionId: null });
  assert.equal(pairs.file.rows, PEOPLE);
  assert.equal(pairs.text.trim().split("\r\n").length, PEOPLE + 1);
  assert.match(pairs.text, /^\uFEFF患者,结论,满足,不满足,未知,待复评,评估时间,判定方式/u);
  const json = JSON.parse((await written({ format: "json", kind: "clauses", protocolVersionId: null })).text);
  assert.equal(json.rows.length, PEOPLE * 2, "a row for each rule of each person");
  assert.equal(json.source, "rules");
});
