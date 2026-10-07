// The generated records of a study as a file: synthetic rows only, the file says what it is first, an empirical synthetic table travels
// with its leakage check, the role that reads results is the role that downloads, and every download — or refusal — is a line in the
// module's audit table. Driven through the real routes with doubles of the store and a real directory for the data plane.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test, { after, before } from "node:test";

import { createVcrRecords } from "../src/vcrRecords.mjs";
import { createVcrRoutes, vcrRoutePattern, VCR_ROUTE_ABILITIES } from "../src/vcrRoutes.mjs";
import { HttpError } from "../src/security.mjs";

const OWNER = "owner";
const study = { id: "std_1", userId: OWNER, projectId: "prj_1", name: "EV-201", dataTier: "T0", intendedUse: "exploratory", status: "active", budget: {}, steps: {} };
const config = { vcrEnabled: true, vcrAudience: "all", operatorUsers: [], vcrPreviewUsers: [] };
const sha = (/** @type {string | Buffer} */ bytes) => createHash("sha256").update(bytes).digest("hex");

/** @type {string} */
let plane = "";
const POPULATION_CSV = "age,female\n61.2,0\n55.9,1\n70.4,0\n";
const PATIENTS_CSV = "patientId,time,status,arm\nvp_1,4.2,1,1\nvp_2,9.9,0,0\n";
const COPIES_CSV = "copy,age,sex\n1,59.1,0\n1,61.2,1\n2,58.0,1\n";

before(async () => {
  plane = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-records-"));
  for (const [relative, text] of [["derived/std_1/job_pop/population.csv", POPULATION_CSV], ["derived/std_1/job_vp/virtual-patients.csv", PATIENTS_CSV],
    ["derived/std_1/job_syn/synthetic-population.csv", COPIES_CSV], ["derived/std_1/job_gone/population.csv", POPULATION_CSV]]) {
    await fs.mkdir(path.dirname(path.join(plane, relative)), { recursive: true });
    await fs.writeFile(path.join(plane, relative), text);
  }
  await fs.chmod(plane, 0o700);
});
after(async () => { await fs.rm(plane, { recursive: true, force: true }); });

/** One result of each kind the module can hold, with the execution that made it. */
function world() {
  const table = (/** @type {string} */ name, /** @type {string} */ location, /** @type {string} */ text) => ({ name, location, sha256: sha(text), rows: 3 });
  const quality = { disclosure: { replicationRatio: 0.02, nearestNeighbourInTrainShare: 0.4, membershipAuc: 0.51, dcrMedian: 1.2 },
    fidelity: { global: { sPMSE: 0.012, propensityAuc: 0.52 }, univariate: [] }, generator: { m: 5, trainingObservations: 320 } };
  /** @type {Record<string, any>} */
  const results = {
    res_pop: { id: "res_pop", kind: "population", executionId: "ex_pop", subjectId: "pop_1", tables: [table("population", "derived/std_1/job_pop/population.csv", POPULATION_CSV)], diagnostics: {} },
    res_vp: { id: "res_vp", kind: "patient_set", executionId: "ex_vp", subjectId: "pts_1", tables: [table("virtual-patients", "derived/std_1/job_vp/virtual-patients.csv", PATIENTS_CSV)], diagnostics: {} },
    res_syn: { id: "res_syn", kind: "population", executionId: "ex_syn", subjectId: "pop_2", tables: [table("synthetic-population", "derived/std_1/job_syn/synthetic-population.csv", COPIES_CSV)], diagnostics: { quality } },
    res_syn_noquality: { id: "res_syn_noquality", kind: "population", executionId: "ex_syn", subjectId: "pop_2", tables: [table("synthetic-population", "derived/std_1/job_syn/synthetic-population.csv", COPIES_CSV)], diagnostics: { quality: { disclosure: { available: false } } } },
    res_cohort: { id: "res_cohort", kind: "population", executionId: "ex_cohort", subjectId: "pop_3", tables: [table("population", "derived/std_1/job_pop/population.csv", POPULATION_CSV)], diagnostics: {} },
    res_vp_real: { id: "res_vp_real", kind: "patient_set", executionId: "ex_vp_real", subjectId: "pts_2", tables: [table("virtual-patients", "derived/std_1/job_vp/virtual-patients.csv", PATIENTS_CSV)], diagnostics: {} },
    res_changed: { id: "res_changed", kind: "population", executionId: "ex_pop", subjectId: "pop_1", tables: [{ ...table("population", "derived/std_1/job_gone/population.csv", POPULATION_CSV), sha256: sha("other bytes") }], diagnostics: {} },
    res_trial: { id: "res_trial", kind: "trial_scenario", executionId: "ex_trial", tables: [], diagnostics: {} },
    res_nofile: { id: "res_nofile", kind: "population", executionId: "ex_pop", subjectId: "pop_1", tables: [table("population", "derived/std_1/job_missing/population.csv", POPULATION_CSV)], diagnostics: {} },
    res_nokept: { id: "res_nokept", kind: "population", executionId: "ex_pop", subjectId: "pop_1", tables: [{ name: "population", sha256: sha(POPULATION_CSV), rows: 3 }], diagnostics: {} },
  };
  /** @type {Record<string, any>} */
  const executions = {
    ex_pop: { method: "population.scenario", inputs: [], finished_at: "2026-10-07T11:00:00Z" },
    ex_vp: { method: "patients.time_to_event", inputs: [{ kind: "snapshot_file", id: "res_pop:population", valueSource: "synthetic" }], finished_at: "2026-10-07T11:05:00Z" },
    ex_vp_real: { method: "patients.time_to_event", inputs: [{ kind: "snapshot", id: "snp_1", valueSource: "observed" }], finished_at: "2026-10-07T11:05:00Z" },
    ex_syn: { method: "population.synthpop", inputs: [{ kind: "snapshot", id: "snp_1", valueSource: "observed" }], finished_at: "2026-10-07T11:10:00Z" },
    ex_cohort: { method: "cohort.build", inputs: [{ kind: "snapshot", id: "snp_1", valueSource: "observed" }], finished_at: "2026-10-07T11:10:00Z" },
    ex_trial: { method: "design.simulate", inputs: [], finished_at: "2026-10-07T11:10:00Z" },
  };
  /** @type {any[]} */
  const audits = [];
  const store = {
    async result(/** @type {string} */ _studyId, /** @type {string} */ id) { return results[id] ?? null; },
    async one(/** @type {string} */ sql, /** @type {any[]} */ values) {
      if (/FROM evimed_vcr\.executions/.test(sql)) return executions[String(values[0])] ?? null;
      if (/FROM evimed_vcr\.populations/.test(sql)) return { allowed_uses: ["design", "feasibility"] };
      return null;
    },
    async audit(/** @type {any} */ entry) { audits.push(entry); },
    async rolesOf(/** @type {string} */ _studyId, /** @type {string} */ userId) { return userId === "reader" ? ["viewer"] : userId === "coordinator" ? ["site"] : []; },
  };
  return { store, audits };
}

/** A response that is a stream, as the route writes a file to it. */
function fileResponse() {
  /** @type {Buffer[]} */
  const chunks = [];
  const res = Object.assign(new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }), {
    status: 0, headers: /** @type {Record<string, string>} */ ({}),
    writeHead(/** @type {number} */ status, /** @type {Record<string, string>} */ headers) { this.status = status; this.headers = headers; return this; },
    text() { return Buffer.concat(chunks).toString("utf8"); },
    json() { return JSON.parse(this.text()); },
  });
  return res;
}

function routesFor(/** @type {string} */ who) {
  const { store, audits } = world();
  const service = {
    allows: () => true,
    async requireStudy(/** @type {any} */ user, /** @type {string} */ id) {
      const member = String(user.id) === OWNER || ["reader", "coordinator"].includes(String(user.id));
      if (id !== study.id || !member) throw new HttpError(404, "vcr_study_not_found", "Study not found.");
      return study;
    },
    store,
  };
  const routes = createVcrRoutes({
    store: /** @type {any} */ ({ async ensureSessionUser() { return { user: { id: who } }; }, async assertCsrf() {} }),
    vcrStore: store, service, config, maxJsonBytes: 65_536, audit: async () => {},
    records: createVcrRecords({ store, config: { vcrDataPlaneDir: plane } }),
  });
  /** @param {string} url @param {string} [method] */
  const get = async (url, method = "GET") => {
    const res = fileResponse();
    const req = Object.assign(Readable.from([]), { method, url, headers: {} });
    /** @type {any} */
    let thrown = null;
    try { await routes(req, res); } catch (error) { thrown = error; }
    await new Promise((resolve) => { if (res.writableEnded) resolve(null); else res.on("finish", () => resolve(null)); setTimeout(() => resolve(null), 200); });
    return { res, thrown };
  };
  return { get, audits };
}

test("a generated population is downloaded as a CSV that says what it is before the first row, and the download is audited", async () => {
  const { get, audits } = routesFor(OWNER);
  const { res, thrown } = await get("/api/vcr/studies/std_1/records/res_pop.csv");
  assert.equal(thrown, null);
  assert.equal(res.status, 200);
  assert.match(res.headers["Content-Type"], /^text\/csv/);
  assert.equal(res.headers["Content-Disposition"], 'attachment; filename="synthetic-population.csv"');
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  const body = res.text();
  assert.equal(Number(res.headers["Content-Length"]), Buffer.byteLength(body), "the length is the comment lines and the table");
  const lines = body.split("\n");
  assert.equal(lines[0], "# 合成数据，不是真实患者。");
  assert.equal(lines[1], "# 生成方法：按设定的分布和相关性抽样。");
  assert.match(lines[2], /^# 允许用途：设计、可行性。/);
  assert.ok(body.endsWith(POPULATION_CSV), "then the table exactly as the engine wrote it");
  assert.doesNotMatch(body, /quality\.json/, "only an empirical synthetic table has a sibling");
  assert.equal(audits.length, 1);
  assert.deepEqual([audits[0].action, audits[0].object, audits[0].outcome, audits[0].studyId, audits[0].userId], ["vcr.records.download", "res_pop", "ok", "std_1", OWNER]);
  assert.equal(audits[0].detail.format, "csv");
  assert.equal(audits[0].detail.bytes, Buffer.byteLength(body));

  const patients = await get("/api/vcr/studies/std_1/records/res_vp.csv");
  assert.equal(patients.res.status, 200);
  assert.match(patients.res.text().split("\n")[1], /^# 生成方法：按研究设定的虚拟患者仿真器生成/);
  assert.ok(patients.res.text().endsWith(PATIENTS_CSV));
});

test("a real patient's rows never leave: a cohort, patients generated from real data and a result that is not a table are refused by name, each refusal an audit line", async () => {
  const { get, audits } = routesFor(OWNER);
  for (const [id, code, status] of /** @type {Array<[string, string, number]>} */ ([
    ["res_cohort", "vcr_records_not_synthetic", 403], ["res_vp_real", "vcr_records_not_synthetic", 403],
    ["res_trial", "vcr_records_not_found", 404], ["res_absent", "vcr_records_not_found", 404],
  ])) {
    const { res, thrown } = await get(`/api/vcr/studies/std_1/records/${id}.csv`);
    assert.equal(res.text(), "", `${id}: nothing was written`);
    assert.equal(thrown?.code, code, id);
    assert.equal(thrown?.status, status, id);
  }
  assert.deepEqual(audits.map((entry) => [entry.object, entry.outcome, entry.reason]), [
    ["res_cohort", "refused", "vcr_records_not_synthetic"], ["res_vp_real", "refused", "vcr_records_not_synthetic"],
    ["res_trial", "refused", "vcr_records_not_found"], ["res_absent", "refused", "vcr_records_not_found"]]);
});

test("a table that is no longer what the result recorded, or never kept, or gone, is not handed over", async () => {
  const { get } = routesFor(OWNER);
  for (const id of ["res_changed", "res_nofile", "res_nokept"]) {
    const { res, thrown } = await get(`/api/vcr/studies/std_1/records/${id}.csv`);
    assert.equal(res.text(), "", id);
    assert.equal(thrown?.code, "vcr_records_not_found", id);
  }
});

test("an empirical synthetic table is released with its leakage check and the check is the file beside it; without the check it is refused", async () => {
  const { get, audits } = routesFor(OWNER);
  const csv = await get("/api/vcr/studies/std_1/records/res_syn.csv");
  assert.equal(csv.res.status, 200);
  assert.equal(csv.res.headers["Content-Disposition"], 'attachment; filename="synthetic-population.csv"');
  const lines = csv.res.text().split("\n");
  assert.match(lines[1], /按真实数据经验合成/);
  assert.ok(lines.some((line) => /质量与泄露检查在同名的 \.quality\.json/.test(line)), "the CSV names its sibling");
  assert.ok(csv.res.text().endsWith(COPIES_CSV));

  const quality = await get("/api/vcr/studies/std_1/records/res_syn.quality.json");
  assert.equal(quality.res.status, 200);
  assert.equal(quality.res.headers["Content-Disposition"], 'attachment; filename="synthetic-population.quality.json"');
  const report = quality.res.json();
  assert.match(report.说明, /合成数据，不是真实患者/);
  assert.equal(report.生成方法, "按真实数据经验合成");
  assert.ok(report.质量报告.groups.find((/** @type {any} */ group) => group.key === "leakage").rows.length >= 2, "the leakage measures are in it");
  assert.equal(report.质量报告.copies, 5);
  assert.deepEqual(audits.map((entry) => [entry.detail.format, entry.outcome]), [["csv", "ok"], ["quality", "ok"]]);

  const refused = await get("/api/vcr/studies/std_1/records/res_syn_noquality.csv");
  assert.equal(refused.thrown?.code, "vcr_records_quality_missing");
  assert.equal(refused.res.text(), "");
  // a table that has no quality report has no sibling to hand over
  assert.equal((await get("/api/vcr/studies/std_1/records/res_pop.quality.json")).thrown?.code, "vcr_records_not_found");
});

test("the role that reads the study's results is the role that downloads: a reader may, a coordinator who reads no page may not, a stranger finds no study", async () => {
  assert.deepEqual(VCR_ROUTE_ABILITIES["GET /studies/:id/records/:result.csv"], ["read"]);
  assert.deepEqual(VCR_ROUTE_ABILITIES["GET /studies/:id/records/:result.quality.json"], ["read"]);
  const reader = await routesFor("reader").get("/api/vcr/studies/std_1/records/res_pop.csv");
  assert.equal(reader.res.status, 200);
  const site = await routesFor("coordinator").get("/api/vcr/studies/std_1/records/res_pop.csv");
  assert.equal(site.thrown?.code, "vcr_forbidden");
  assert.equal(site.res.text(), "");
  const stranger = await routesFor("stranger").get("/api/vcr/studies/std_1/records/res_pop.csv");
  assert.equal(stranger.thrown?.code, "vcr_study_not_found");
});

test("the file route answers GET only, folds its metric label, and no other dotted path is a route", async () => {
  assert.equal(vcrRoutePattern("/api/vcr/studies/std_1/records/res_pop.csv"), "/api/vcr/studies/:id/records/:result");
  const post = await routesFor(OWNER).get("/api/vcr/studies/std_1/records/res_pop.csv", "POST");
  assert.equal(post.thrown?.status, 404);
  const dotted = await routesFor(OWNER).get("/api/vcr/studies/std_1/jobs/res_pop.csv");
  assert.equal(dotted.thrown?.status, 404, "the dot is allowed in the one place it names a file");
  const traversal = await routesFor(OWNER).get("/api/vcr/studies/std_1/records/..%2Fsecret.csv");
  assert.equal(traversal.thrown?.status, 404);
});

test("a deployment without the data plane says so by name instead of a missing file", async () => {
  const { store } = world();
  const records = createVcrRecords({ store, config: {} });
  await assert.rejects(records.csv(study, "res_pop"), { code: "vcr_records_unavailable", status: 503 });
});
