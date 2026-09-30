// 「虚拟临研」 in the real hosted app, over HTTP, against a real PostgreSQL:
// `createWebApiApp` with the module on, every `/api/vcr/*` route driven as the
// owner and as each member role, and the data each write leaves in the module's
// own schema read back.
//
// This is the test that would have caught the first defect of the 2026-09-29
// review (CS-1): the composition handed the routes the platform's store for the
// module's data, so every write, member read and role check threw `is not a
// function` on the first real request. The build's route tests ran on doubles
// that had the methods the real store lacks, and nothing composed the routes
// with the store they are composed with in production. Nothing here is a
// double of a module: the routes, the service, the stores, the members service,
// the contact stop, the job queue and the orchestrator are the real ones. The
// two things that leave the process are replaced — the run dispatch (a run
// needs a kernel) and `fetch` (the engine is not started).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { roleAllows, VCR_EXPORT_KINDS, DOCUMENT_EXPORT_MIME } from "@evimed/domain";
import { exportHash } from "../src/documentExport.mjs";
import { documentExportDirectory } from "../src/documentRenderController.mjs";
import { vcrRuntimeWrite } from "../src/vcrGateway.mjs";

import { VcrStore } from "../src/vcrStore.mjs";
import { VCR_ROUTE_ABILITIES } from "../src/vcrRoutes.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
// The browser's own body builders: what the page posts is proven against the real routes, not against a copy of their allow-lists.
import { confirmFieldMapBody, fieldMapBody, freezeBody, grantBody, sourceBody, uploadQuery } from "../../web/src/lib/vcrIntakeBodies.ts";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const suffix = randomUUID().slice(0, 8);
const PASSWORD = "test-only-vcr-password";
/** The accounts, by the role they hold in the study. `owner` is a lead by owning the study. */
const accounts = {
  owner: `own${suffix}`, lead: `lead${suffix}`, statistician: `stat${suffix}`, clinician: `clin${suffix}`, datamanager: `dm${suffix}`,
  recruiter: `rec${suffix}`, second: `rec2${suffix}`, site: `site${suffix}`, viewer: `view${suffix}`, stranger: `str${suffix}`, leaver: `gone${suffix}`,
};
/** The role each account holds; the owner and the stranger hold none by membership. */
const ROLE_OF = /** @type {Record<string, string>} */ ({
  lead: "lead", statistician: "statistical_reviewer", clinician: "clinical_reviewer", datamanager: "data_manager",
  recruiter: "recruiter", second: "recruiter", site: "site", viewer: "viewer",
});
const ENGINE = "http://engine.test:8080";

/** @type {any} */
let context = null;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;
/** @type {string[]} */
const engineCalls = [];
/** @type {any[]} */
const dispatches = [];

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "vcrapp");
  const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-vcr-app-"));
  const plane = path.join(dataDir, "plane");
  await mkdir(plane, { recursive: true });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, operatorMetricsToken: "test-only-metrics-token",
    rateLimitMaxRequests: 100_000, authRateLimitMaxRequests: 1_000,
    vcrEnabled: true, vcrAudience: "all", vcrPollMs: 3_600_000, vcrDataPlaneDir: plane,
    // The two things that leave the process. The engine is a fake that answers
    // its health and accepts a job's deletion; a run is recorded, not started.
    vcrEngineUrl: ENGINE, vcrEngineToken: "t".repeat(40), vcrEngineReceiptKey: "r".repeat(40),
    vcrFetch: async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
      const target = new URL(String(url));
      engineCalls.push(`${init.method ?? "GET"} ${target.pathname}`);
      const body = target.pathname === "/health" ? { ok: true, engineVersion: "test", rVersion: "test", methods: [], packageLockHash: "" } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
    documentExportController: {
      async inspectRuntimeImage() { return { imageId: "sha256:test-renderer" }; },
      async cancelDocumentRender() { return { canceled: true }; },
      async renderDocument(reference) {
        const root = path.join(documentExportDirectory({ dataDir }, reference), "attempts", reference.attemptId);
        const input = JSON.parse(await readFile(path.join(root, "input/document.json"), "utf8"));
        const formats = {};
        for (const format of input.formats) {
          const bytes = Buffer.from(input.canonicalMarkdown);
          await writeFile(path.join(root, "output", `document.${format}`), bytes);
          formats[format] = { state: "ready", path: `document.${format}`, mime: DOCUMENT_EXPORT_MIME[format], sha256: exportHash(bytes), bytes: bytes.length };
        }
        await writeFile(path.join(root, "output/manifest.json"), JSON.stringify({ sourceDigest: input.sourceDigest, rendererVersion: input.rendererVersion, formats }));
      },
    },
    vcrDispatchRun: async (/** @type {any} */ input) => {
      dispatches.push(input);
      return { runId: `run_${dispatches.length}`, sessionId: `session_${dispatches.length}`, status: "running" };
    },
  });
  for (const id of Object.values(accounts)) await app.store.createUser(id, PASSWORD, id);
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  /** @type {Record<string, Record<string, string>>} */
  const sessions = {};
  for (const [name, id] of Object.entries(accounts)) {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: id, password: PASSWORD }) });
    const body = await login.json();
    sessions[name] = { "content-type": "application/json", cookie: String(login.headers.get("set-cookie")).split(";")[0],
      "x-open-science-csrf": body.data.csrfToken };
  }
  context = { app, base, sessions, dataDir, plane };
});

after(async () => {
  if (context) {
    await context.app.close();
    await rm(context.dataDir, { recursive: true, force: true });
  }
  await isolated?.drop();
});

/** @param {string} who @param {string} method @param {string} route @param {unknown} [body] */
async function call(who, method, route, body) {
  const response = await fetch(`${context.base}${route}`, { method, headers: context.sessions[who], body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  /** @type {any} */
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { unparsed: text.slice(0, 200) }; }
  return { status: response.status, body: parsed, text };
}

/** @param {string} sql @param {unknown[]} [values] */
const rows = async (sql, values = []) => (await context.app.vcr.store.database.query(sql, values)).rows;

/** A study owned by `owner`, with the whole cast added the way a lead does it: through the members route. */
async function furnishedStudy(name = "EV-201") {
  const created = await call("owner", "POST", "/api/vcr/studies", { name, question: "在 ITT 人群中 X 相对 Y 的总生存期", dataTier: "T0", intendedUse: "exploratory" });
  assert.equal(created.status, 201, created.text);
  const { id, projectId } = created.body.data;
  const site = await context.app.vcr.matchStore.upsertSite({ site: { studyId: id, name: "中心 A" }, userId: accounts.owner });
  for (const [who, role] of Object.entries(ROLE_OF)) {
    const detail = role === "site" ? { siteId: site.id } : undefined;
    const added = await call("owner", "POST", `/api/vcr/studies/${id}/members`, { userId: accounts[/** @type {keyof typeof accounts} */ (who)], role, ...(detail ? { detail } : {}) });
    assert.equal(added.status, 201, `${who} as ${role}: ${added.text}`);
  }
  return { id, projectId, siteId: site.id };
}

/** @type {Promise<{ id: string, projectId: string, siteId: string }> | null} */
let evidenceAndLedgerStudy = null;
/**
 * One furnished study for the evidence and ledger cases: an account may hold twenty projects and this
 * file makes most of them, so what does not need a study of its own shares one.
 */
const sharedStudy = () => (evidenceAndLedgerStudy ??= furnishedStudy("证据与台账研究"));

let counter = 0;
/**
 * One request per route in the ability table (keyed exactly like it), built for
 * one study. `disposable` makes a study nobody else uses, for the route that
 * deletes it.
 * @param {{ id: string, siteId: string }} target
 * @param {{ contact: string, transition: string, exportId: string, disposable: () => Promise<string> }} ids
 * @returns {Record<string, () => Promise<[string, string, any]>>}
 */
function requests(target, ids) {
  const S = `/api/vcr/studies/${target.id}`;
  return {
    "GET /studies/:id": async () => ["GET", S, undefined],
    "GET /studies/:id/:tab": async () => ["GET", `${S}/overview`, undefined],
    "PATCH /studies/:id name,question,action": async () => ["PATCH", S, { name: "改个名字", question: "同一个问题" }],
    "PATCH /studies/:id dataTier,intendedUse,status": async () => ["PATCH", S, { status: "active" }],
    "DELETE /studies/:id": async () => ["DELETE", `/api/vcr/studies/${await ids.disposable()}`, undefined],
    "POST /studies/:id/run": async () => ["POST", `${S}/run`, { step: "definition" }],
    "GET /studies/:id/jobs": async () => ["GET", `${S}/jobs`, undefined],
    "GET /studies/:id/jobs/:job": async () => ["GET", `${S}/jobs/job_none`, undefined],
    "POST /studies/:id/jobs": async () => ["POST", `${S}/jobs`, { kind: "design_simulation", scenario: {} }],
    "POST /studies/:id/jobs/:job/cancel": async () => ["POST", `${S}/jobs/job_none/cancel`, {}],
    "POST /studies/:id/budget": async () => ["POST", `${S}/budget`, { cpuSeconds: 600 }],
    "POST /studies/:id/assumptions": async () => ["POST", `${S}/assumptions`, { key: "dropout_rate", name: "脱落率", pointValue: 0.15, sourceKind: "expert_set" }],
    "POST /studies/:id/reviews clinical": async () => ["POST", `${S}/reviews`, { kind: "clinical", nodes: ["result:res_1@1"], note: "临床复核" }],
    "POST /studies/:id/reviews statistical": async () => ["POST", `${S}/reviews`, { kind: "statistical", nodes: ["result:res_1@1"], note: "统计复核" }],
    "POST /studies/:id/reviews data": async () => ["POST", `${S}/reviews`, { kind: "data", nodes: ["result:res_1@1"], note: "数据复核" }],
    "POST /studies/:id/decisions": async () => ["POST", `${S}/decisions`, { question: "选哪个设计", chosen: { design: "B" }, rationale: "功效更高" }],
    "POST /studies/:id/export": async () => ["POST", `${S}/export`, { kind: "study_package" }],
    "GET /studies/:id/export/:export": async () => ["GET", `${S}/export/${ids.exportId}`, undefined],
    "GET /studies/:id/members": async () => ["GET", `${S}/members`, undefined],
    "POST /studies/:id/members": async () => ["POST", `${S}/members`, { userId: `newcomer${suffix}`, role: "viewer" }],
    "DELETE /studies/:id/members/:user": async () => ["DELETE", `${S}/members/newcomer${suffix}?role=viewer`, undefined],
    "GET /studies/:id/referrals": async () => ["GET", `${S}/referrals`, undefined],
    "POST /studies/:id/referrals/:referral/transition": async () => ["POST", `${S}/referrals/${ids.transition}/transition`, { to: "contactable" }],
    "POST /studies/:id/referrals/:referral/contact": async () => ["POST", `${S}/referrals/${ids.contact}/contact`, { reason: "符合入选标准" }],
    // A person's hand on an assessment: allowed roles reach the seam, which
    // answers 404 for an assessment this study does not have.
    "POST /studies/:id/assessments/:assessment/judgments/:criterion/override": async () => ["POST", `${S}/assessments/asm_none/judgments/crt_none/override`, { state: "not_satisfied", note: "病历写明曾用过该药" }],
    "POST /studies/:id/assessments/:assessment/review": async () => ["POST", `${S}/assessments/asm_none/review`, {}],
    "POST /models (with a study)": async () => { counter += 1; return ["POST", "/api/vcr/models", { studyId: target.id, name: `model-${suffix}-${counter}` }]; },
    // Data intake: a lead and a data manager may; nobody else may, whatever else they hold.
    "POST /studies/:id/data/sources": async () => { counter += 1; return ["POST", `${S}/data/sources`, { name: `数据源-${counter}`, ownerParty: "合作方" }]; },
    "POST /studies/:id/data/sources/:source/files": async () => ["POST", `${S}/data/sources/src_none/files?name=cohort.csv`, undefined],
    "DELETE /studies/:id/data/files/:file": async () => ["DELETE", `${S}/data/files/sfl_none`, undefined],
    "POST /studies/:id/data/sources/:source/fieldmap": async () => ["POST", `${S}/data/sources/src_none/fieldmap`, { columns: [] }],
    "POST /studies/:id/data/sources/:source/fieldmap/confirm": async () => ["POST", `${S}/data/sources/src_none/fieldmap/confirm`, { hash: "a".repeat(64) }],
    "POST /studies/:id/data/sources/:source/snapshots": async () => ["POST", `${S}/data/sources/src_none/snapshots`, {}],
    "POST /studies/:id/data/snapshots/:snapshot/tables": async () => ["POST", `${S}/data/snapshots/snp_none/tables`, {}],
    "POST /studies/:id/data/sources/:source/grants": async () => ["POST", `${S}/data/sources/src_none/grants`, { grantee: "role:viewer" }],
    "POST /studies/:id/data/grants/:grant/revoke": async () => ["POST", `${S}/data/grants/grt_none/revoke`, {}],
  };
}

/** Whether a role (or the owner) holds one of these abilities — the same table the routes read. @param {readonly string[]} held @param {readonly string[]} abilities */
const holdsAny = (held, abilities) => abilities.some((ability) => held.some((role) => roleAllows(role, ability) || (ability === "manage_study" && roleAllows(role, "manage_members"))));

test("CS-45 every route, driven through the real server as the owner and as each member role: 403 exactly where the role lacks the ability, no 500 anywhere", options, async () => {
  const study = await furnishedStudy("矩阵研究");
  const walked = { allowed: 0, denied: 0 };
  /** @type {string[]} */
  const problems = [];
  const cast = /** @type {[string, string[]][]} */ ([["owner", ["lead"]], ...Object.entries(ROLE_OF).map(([who, role]) => [who, [role]])]);
  for (const [who, held] of cast) {
    // Fresh referrals per caller, each at the start of the ledger and at this study's site.
    const fresh = async () => (await context.app.vcr.matchStore.createReferral({
      referral: { studyId: study.id, subjectKey: `S-${who}-${++counter}`, siteId: study.siteId, actor: "test" }, userId: accounts.owner })).id;
    const exportRow = await context.app.vcr.store.createExport({ studyId: study.id, userId: accounts.owner, kind: "study_package" });
    const ids = {
      contact: await fresh(), transition: await fresh(), exportId: exportRow.id,
      disposable: async () => {
        const made = await call("owner", "POST", "/api/vcr/studies", { name: `可删除-${who}-${++counter}` });
        assert.equal(made.status, 201, made.text);
        if (who !== "owner") {
          const role = ROLE_OF[who];
          const site = role === "site" ? { detail: { siteId: (await context.app.vcr.matchStore.upsertSite({ site: { studyId: made.body.data.id, name: "处置中心" }, userId: accounts.owner })).id } } : {};
          await call("owner", "POST", `/api/vcr/studies/${made.body.data.id}/members`, { userId: accounts[/** @type {keyof typeof accounts} */ (who)], role, ...site });
        }
        return made.body.data.id;
      },
    };
    const built = requests(study, ids);
    assert.deepEqual(Object.keys(built).sort(), Object.keys(VCR_ROUTE_ABILITIES).sort(), "a request for every route in the ability table");
    for (const [key, abilities] of Object.entries(VCR_ROUTE_ABILITIES)) {
      const [method, route, body] = await built[key]();
      const answer = await call(who, method, route, body);
      const allowed = holdsAny(held, abilities);
      const label = `${who} (${held.join("+")}) ${key} -> ${answer.status} ${String(answer.body?.code ?? "")}`;
      if (answer.status >= 500) problems.push(`${label}: a server error — ${answer.text.slice(0, 160)}`);
      else if (allowed && answer.status === 403) problems.push(`${label}: refused, but the role holds ${abilities.join(" or ")}`);
      else if (!allowed && answer.status !== 403) problems.push(`${label}: not refused, and the role holds none of ${abilities.join(", ")}`);
      else if (allowed) walked.allowed += 1;
      else walked.denied += 1;
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.ok(walked.allowed >= 70 && walked.denied >= 90, `walked ${walked.allowed} allowed and ${walked.denied} refused requests; the grid was not driven`);
  // Someone who is not in the study finds none of it.
  for (const [method, route, body] of await Promise.all(Object.values(requests(study, { contact: "ref_x", transition: "ref_x", exportId: "exp_x", disposable: async () => study.id })).map((build) => build()))) {
    const answer = await call("stranger", method, route, body);
    assert.equal(answer.status, 404, `${method} ${route}: ${answer.text.slice(0, 100)}`);
    assert.equal(answer.body.code, "vcr_study_not_found");
  }
});

test("CS-1 what the routes write reaches the module's own tables, under the session's account", options, async () => {
  const study = await furnishedStudy("写入研究");
  const S = `/api/vcr/studies/${study.id}`;
  assert.equal((await call("datamanager", "POST", `${S}/assumptions`, { key: "event_rate", name: "事件率", pointValue: 0.3, sourceKind: "expert_set" })).status, 201);
  assert.equal((await call("statistician", "POST", `${S}/reviews`, { kind: "statistical", nodes: ["assumption:event_rate@1"], note: "针对假设卡 v1" })).status, 201);
  assert.equal((await call("clinician", "POST", `${S}/reviews`, { kind: "clinical", nodes: ["assumption:event_rate@1"] })).status, 201);
  assert.equal((await call("lead", "POST", `${S}/decisions`, { question: "分配比例", chosen: { ratio: "1:1" } })).status, 201);
  const assumption = (await rows(`SELECT key, version, user_id, review_state FROM evimed_vcr.assumptions WHERE study_id = $1`, [study.id]))[0];
  assert.deepEqual([assumption.key, assumption.version, assumption.user_id, assumption.review_state], ["event_rate", 1, accounts.datamanager, "reviewed"]);
  const reviews = await rows(`SELECT kind, reviewer FROM evimed_vcr.reviews WHERE study_id = $1 ORDER BY kind`, [study.id]);
  assert.deepEqual(reviews.map((row) => [row.kind, row.reviewer]), [["clinical", accounts.clinician], ["statistical", accounts.statistician]],
    "each countersignature names the account that signed");
  assert.deepEqual((await rows(`SELECT decided_by FROM evimed_vcr.decisions WHERE study_id = $1`, [study.id])).map((row) => row.decided_by), [accounts.lead]);
  // A card edited again is the next version, and the study page shows the caller its own abilities.
  assert.equal((await call("datamanager", "POST", `${S}/assumptions`, { key: "event_rate", name: "事件率", pointValue: 0.35 })).body.data.version, 2);
  const page = await call("recruiter", "GET", S);
  assert.deepEqual(page.body.data.roles, ["recruiter"]);
  assert.ok(page.body.data.abilities.includes("contact_patients") && !page.body.data.abilities.includes("run"));
  assert.equal((await call("owner", "GET", S)).body.data.abilities.includes("manage_study"), true);
  // The audit trail names the writer, not the owner.
  const audited = await rows(`SELECT actor FROM evimed_vcr.audit WHERE study_id = $1 AND action = 'vcr.review.add' ORDER BY occurred_at`, [study.id]);
  assert.deepEqual(audited.map((row) => row.actor).sort(), [accounts.clinician, accounts.statistician].sort());
});

test("AC-25 C2-11 a card a person writes as 「外部证据」 cites only what the platform verified — the rule the runtime's write holds — and a person's own value is an expert setting", options, async () => {
  const study = await sharedStudy();
  const S = `/api/vcr/studies/${study.id}`;
  const store = context.app.vcr.evidenceStore;
  const seeded = await store.appendEvidenceItems({ userId: accounts.owner, studyId: study.id, items: [
    { parameter: "median_time", arm: "对照", armRole: "control", endpointKey: "pfs", value: 10.2, unit: "months", quote: "10.2", locator: { verification: "verified" } },
    { parameter: "median_time", arm: "对照 B", armRole: "control", endpointKey: "pfs", value: 9.1, unit: "months", quote: "9.1", locator: { verification: "verified" } },
    { parameter: "dropout_rate", armRole: "control", endpointKey: "drop", value: 0.1, quote: "0.1", locator: { verification: "verified" } },
    { parameter: "median_time", arm: "试验", armRole: "treatment", endpointKey: "pfs", value: 99, quote: "not in the record", locator: { verification: "quote_not_found" } },
  ] });
  const [medianA, medianB, dropout, failed] = seeded.ids;
  const card = (/** @type {Record<string, any>} */ extra) => ({ key: "fake_median", name: "凭空的中位数", pointValue: 42, sourceKind: "external_evidence", valueSource: "extracted", ...extra });
  const count = async () => (await rows(`SELECT key FROM evimed_vcr.assumptions WHERE study_id = $1 AND key = 'fake_median'`, [study.id])).length;

  const invented = await call("datamanager", "POST", `${S}/assumptions`, card({ evidenceIds: ["evd_00000000000000000000zz"] }));
  assert.equal(invented.status, 422, invented.text);
  assert.equal(invented.body.code, "vcr_evidence_unverified");
  for (const evidenceIds of [undefined, [], [failed], [medianA, dropout], [medianA, "not an id!"], Array.from({ length: 21 }, () => medianA)]) {
    const refused = await call("datamanager", "POST", `${S}/assumptions`, card({ ...(evidenceIds === undefined ? {} : { evidenceIds }) }));
    assert.equal(refused.status, 422, `${JSON.stringify(evidenceIds)}: ${refused.text}`);
    assert.equal(refused.body.code, "vcr_evidence_unverified");
  }
  assert.equal(await count(), 0, "no card was written by any refused request");

  const verified = await call("datamanager", "POST", `${S}/assumptions`, card({ evidenceIds: [medianA, medianB] }));
  assert.equal(verified.status, 201, verified.text);
  const saved = (await rows(`SELECT source_kind, evidence_ids, review_state FROM evimed_vcr.assumptions WHERE study_id = $1 AND key = 'fake_median'`, [study.id]))[0];
  assert.deepEqual([saved.source_kind, saved.evidence_ids.sort(), saved.review_state], ["external_evidence", [medianA, medianB].sort(), "reviewed"]);
  // A person's own number is an expert setting and needs no citation: the page's edit form writes exactly this.
  const own = await call("datamanager", "POST", `${S}/assumptions`, { key: "own_median", name: "自设中位数", pointValue: 8, sourceKind: "expert_set", valueSource: "assumed" });
  assert.equal(own.status, 201, own.text);
  // Another study's verified rows are not this study's evidence: a different account's own study cites one.
  const other = await call("stranger", "POST", "/api/vcr/studies", { name: "别人的研究", question: "q", dataTier: "T0", intendedUse: "exploratory" });
  assert.equal(other.status, 201, other.text);
  const foreign = await call("stranger", "POST", `/api/vcr/studies/${other.body.data.id}/assumptions`, card({ evidenceIds: [medianA] }));
  assert.equal(foreign.status, 422, foreign.text);
  assert.equal(foreign.body.code, "vcr_evidence_unverified");
});

test("C2-12 the ledger the browser reads carries the keys its reader takes, all of them for the lead and a site's own only for a site; a model is adopted from the library page", options, async () => {
  const study = await sharedStudy();
  const S = `/api/vcr/studies/${study.id}`;
  const otherSite = await context.app.vcr.matchStore.upsertSite({ site: { studyId: study.id, name: "中心 B" }, userId: accounts.owner });
  for (const [subjectKey, siteId] of [["S-own-1", study.siteId], ["S-own-2", study.siteId], ["S-other-1", otherSite.id]]) {
    await context.app.vcr.matchStore.createReferral({ referral: { studyId: study.id, subjectKey, siteId, actor: "test" }, userId: accounts.owner });
  }
  const lead = await call("lead", "GET", `${S}/referrals`);
  assert.equal(lead.status, 200, lead.text);
  assert.deepEqual(lead.body.data.referrals.map((/** @type {any} */ row) => row.subjectKey).sort(), ["S-other-1", "S-own-1", "S-own-2"]);
  // The keys `readVcrReferrals` in the web client takes: a change on either side is a red test here.
  for (const key of ["id", "subjectKey", "state", "siteId", "assessmentId", "contactApprovedBy", "contactApprovedAt", "screenFailReason", "enrolledOn", "updatedAt"]) {
    assert.ok(key in lead.body.data.referrals[0], `the ledger row has ${key}`);
  }
  const site = await call("site", "GET", `${S}/referrals`);
  assert.deepEqual(site.body.data.referrals.map((/** @type {any} */ row) => row.subjectKey).sort(), ["S-own-1", "S-own-2"], "a site reads its own referrals only");
  assert.equal((await call("lead", "GET", `${S}/referrals?state=contactable`)).body.data.referrals.length, 0);

  // The library page's adoption: the account's own model, written by the server as literature-tier from the trials named.
  const adopted = await call("owner", "POST", "/api/vcr/models", { name: `page-model-${suffix}`, version: "2.1.0", risk: "medium", endpointType: "time_to_event", sources: ["NCT02296125", "CTR20990001"] });
  assert.equal(adopted.status, 201, adopted.text);
  const model = (await rows(`SELECT tier, risk, applicability FROM evimed_vcr.models WHERE name = $1`, [`page-model-${suffix}`]))[0];
  assert.equal(model.tier, "literature");
  assert.equal(model.risk, "medium");
  assert.match(String(model.applicability.population), /NCT02296125/);
  const library = await call("owner", "GET", "/api/vcr/models");
  assert.ok(library.body.data.models.some((/** @type {any} */ row) => row.name === `page-model-${suffix}`));
});

test("PA-11 the first human stop, through HTTP: a coordinator confirms one patient by name; a viewer and a site cannot; the second click writes nothing more", options, async () => {
  const study = await furnishedStudy("联系确认研究");
  const S = `/api/vcr/studies/${study.id}`;
  const referral = await context.app.vcr.matchStore.createReferral({ referral: { studyId: study.id, subjectKey: "S-http-1", siteId: study.siteId, actor: "matching" }, userId: accounts.owner });
  for (const who of ["viewer", "site", "clinician", "statistician", "datamanager", "stranger"]) {
    const refused = await call(who, "POST", `${S}/referrals/${referral.id}/contact`, {});
    assert.equal(refused.status, who === "stranger" ? 404 : 403, `${who}: ${refused.text}`);
  }
  assert.equal((await context.app.vcr.matchStore.getReferral(referral.id)).state, "candidate", "nothing moved");
  // The approver is not a field of the request.
  assert.equal((await call("recruiter", "POST", `${S}/referrals/${referral.id}/contact`, { approvedBy: accounts.lead })).status, 400);

  const confirmed = await call("recruiter", "POST", `${S}/referrals/${referral.id}/contact`, { reason: "符合全部入选标准", note: "已电话前核对病历" });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.body.data.referral.state, "contacted");
  assert.equal(confirmed.body.data.referral.contactApprovedBy, accounts.recruiter, "the approver is the session's account");
  const again = await call("second", "POST", `${S}/referrals/${referral.id}/contact`, {});
  assert.equal(again.status, 200);
  assert.equal(again.body.data.alreadyContacted, true);
  assert.equal(again.body.data.referral.contactApprovedBy, accounts.recruiter, "a second coordinator does not replace the first name");
  assert.deepEqual((await context.app.vcr.matchStore.listReferralEvents(referral.id)).map((event) => event.toState), ["candidate", "contactable", "contacted"]);
  assert.deepEqual((await rows(`SELECT actor FROM evimed_vcr.audit WHERE object = $1 AND action = 'vcr.referral.contact_approved'`, [referral.id])).map((row) => row.actor), [accounts.recruiter]);

  // The move route is no way around the stop: an unconfirmed referral cannot be put into a contact state.
  const other = await context.app.vcr.matchStore.createReferral({ referral: { studyId: study.id, subjectKey: "S-http-2", siteId: study.siteId, actor: "matching" }, userId: accounts.owner });
  assert.equal((await call("recruiter", "POST", `${S}/referrals/${other.id}/transition`, { to: "contactable" })).status, 200);
  const stopped = await call("recruiter", "POST", `${S}/referrals/${other.id}/transition`, { to: "contacted" });
  assert.deepEqual([stopped.status, stopped.body.code], [403, "vcr_contact_not_approved"]);
  // A site moves its own site's referral through its own stage, and the read is scoped the same way.
  await context.app.vcr.store.database.query(`UPDATE evimed_vcr.referrals SET state = 'site_responded', contact_approved_by = 'li' WHERE id = $1`, [referral.id]);
  assert.equal((await call("site", "POST", `${S}/referrals/${referral.id}/transition`, { to: "screening" })).status, 200);
  const foreign = await context.app.vcr.matchStore.createReferral({ referral: { studyId: study.id, subjectKey: "S-http-3", actor: "matching" }, userId: accounts.owner });
  const siteRead = await call("site", "GET", `${S}/referrals`);
  assert.deepEqual(siteRead.body.data.referrals.map((row) => row.id).sort(), [referral.id, other.id].sort(), "a site reads its own site's referrals only");
  assert.ok((await call("viewer", "GET", `${S}/referrals`)).body.data.referrals.some((row) => row.id === foreign.id), "a role that reads the study reads them all");
  assert.equal((await call("site", "POST", `${S}/referrals/${foreign.id}/transition`, { to: "contactable" })).status, 403);

  // What the stop itself refuses is in the module's audit, under the caller's study;
  // what the caller's role could not even ask for is in the platform's security log.
  const withdrawn = await context.app.vcr.matchStore.createReferral({ referral: { studyId: study.id, subjectKey: "S-http-4", actor: "matching" }, userId: accounts.owner });
  await context.app.vcr.store.database.query(`UPDATE evimed_vcr.referrals SET state = 'withdrawn' WHERE id = $1`, [withdrawn.id]);
  const notContactable = await call("recruiter", "POST", `${S}/referrals/${withdrawn.id}/contact`, {});
  assert.deepEqual([notContactable.status, notContactable.body.code], [409, "vcr_referral_transition_invalid"]);
  assert.deepEqual((await rows(`SELECT outcome, reason, actor FROM evimed_vcr.audit WHERE object = $1 AND action = 'vcr.referral.contact'`, [withdrawn.id])).map((row) => [row.outcome, row.reason, row.actor]),
    [["refused", "vcr_referral_transition_invalid", accounts.recruiter]]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const security = (await readFile(path.join(context.dataDir, ".openscience", "security.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.action === "vcr.referral.contact" && String(entry.detail ?? "").includes(study.id));
  const outcomeOf = (/** @type {string} */ who) => security.filter((entry) => entry.userId === accounts[/** @type {keyof typeof accounts} */ (who)]).map((entry) => [entry.status, entry.code]);
  assert.deepEqual(outcomeOf("viewer"), [["refused", "vcr_forbidden"]]);
  assert.deepEqual(outcomeOf("site"), [["refused", "vcr_forbidden"]]);
  assert.deepEqual(outcomeOf("stranger"), [["refused", "vcr_study_not_found"]]);
  assert.deepEqual(outcomeOf("recruiter"), [["completed", referral.id], ["refused", "vcr_referral_transition_invalid"]],
    "the confirmation is 'completed' and the attempt the stop refused is 'refused', each with its own line");
});

test("CW-3 members: added and removed through the routes, the owner cannot be removed, and a removed member loses the study", options, async () => {
  const study = await furnishedStudy("成员研究");
  const S = `/api/vcr/studies/${study.id}`;
  const members = await call("viewer", "GET", `${S}/members`);
  assert.equal(members.status, 200);
  const list = members.body.data.members;
  assert.equal(list.find((/** @type {any} */ member) => member.userId === accounts.owner).owner, true, "the owner is listed, marked, first");
  assert.deepEqual(list.find((/** @type {any} */ member) => member.userId === accounts.statistician).roles, ["statistical_reviewer"]);
  assert.equal((await call("viewer", "POST", `${S}/members`, { userId: accounts.stranger, role: "viewer" })).status, 403);
  assert.equal((await call("owner", "POST", `${S}/members`, { userId: accounts.owner, role: "viewer" })).body.code, "vcr_member_owner_fixed");
  assert.equal((await call("owner", "DELETE", `${S}/members/${accounts.owner}?role=lead`)).status, 409, "the owner stays");
  assert.equal((await call("owner", "DELETE", `${S}/members/${accounts.lead}`)).body.data.removed, 1);
  assert.equal((await call("lead", "GET", S)).status, 404, "a removed member is no longer in the study");
  // A member with two roles loses both when none is named, and one when one is.
  await call("owner", "POST", `${S}/members`, { userId: accounts.stranger, role: "viewer" });
  await call("owner", "POST", `${S}/members`, { userId: accounts.stranger, role: "recruiter" });
  assert.equal((await call("owner", "DELETE", `${S}/members/${accounts.stranger}?role=viewer`)).body.data.removed, 1);
  assert.equal((await call("stranger", "GET", S)).status, 200, "the recruiter role remains");
  assert.equal((await call("owner", "DELETE", `${S}/members/${accounts.stranger}`)).body.data.removed, 1);
  assert.equal((await call("stranger", "GET", S)).status, 404);
});

test("CS-7 the study list does not name a study to an account whose only role is a site; changing what the study is takes the lead", options, async () => {
  const study = await furnishedStudy("列表研究");
  const seen = async (/** @type {string} */ who) => (await call(who, "GET", "/api/vcr/studies")).body.data.studies.map((/** @type {any} */ row) => row.id);
  for (const who of ["owner", "lead", "viewer", "clinician", "statistician", "datamanager", "recruiter"]) assert.ok((await seen(who)).includes(study.id), who);
  assert.equal((await seen("site")).includes(study.id), false, "a site reads referrals, not the study");
  assert.equal((await seen("stranger")).includes(study.id), false);
  const S = `/api/vcr/studies/${study.id}`;
  assert.equal((await call("datamanager", "PATCH", S, { intendedUse: "submission_preparation" })).status, 403);
  assert.equal((await call("datamanager", "PATCH", S, { dataTier: "T3" })).status, 403);
  assert.equal((await call("datamanager", "PATCH", S, { name: "数据管理改名" })).status, 200);
  assert.equal((await call("owner", "PATCH", S, { budget: { cpuSecondsConfirmed: 99_999_999 } })).status, 400, "the budget is not a study field");
  const budget = await call("owner", "POST", `${S}/budget`, { cpuSeconds: 900 });
  assert.equal(budget.status, 200, budget.text);
  assert.equal((await rows(`SELECT budget FROM evimed_vcr.studies WHERE id = $1`, [study.id]))[0].budget.cpuSecondsConfirmed >= 0, true);
  assert.equal((await call("datamanager", "POST", `${S}/budget`, { cpuSeconds: 900 })).status, 403, "spending is confirmed by the lead");
  assert.equal((await call("lead", "PATCH", S, { dataTier: "T1" })).status, 200);
  assert.equal((await rows(`SELECT data_tier FROM evimed_vcr.studies WHERE id = $1`, [study.id]))[0].data_tier, "T1");
});

test("CS-49 creation is atomic, and the data tab never carries a path of the server", options, async () => {
  const before = (await call("owner", "GET", "/api/projects")).body.data.map((/** @type {any} */ project) => project.id).sort();
  const store = context.app.vcr.store;
  const original = store.createStudy;
  store.createStudy = async () => { throw new Error("the study row could not be written"); };
  try {
    const failed = await call("owner", "POST", "/api/vcr/studies", { name: "写不进去的研究" });
    assert.equal(failed.status, 500);
  } finally {
    store.createStudy = original;
  }
  const after = (await call("owner", "GET", "/api/projects")).body.data.map((/** @type {any} */ project) => project.id).sort();
  assert.deepEqual(after, before, "no project is left behind by a study that was not made");

  const study = await furnishedStudy("数据页研究");
  const data = await call("owner", "GET", `/api/vcr/studies/${study.id}/data`);
  assert.equal(data.status, 200);
  assert.equal(data.text.includes(context.plane) || data.text.includes(context.dataDir), false, "no filesystem path of the server is in the page");
  // And at the seam the service reads the plane through: the plane is composed
  // here, so this is the real tab, and it names sources and snapshots, never `root`.
  const seam = await context.app.vcr.dataPlaneSeam.tab({ id: study.id, userId: accounts.owner, dataTier: "T0" }, { id: accounts.owner });
  assert.equal(seam.available, true);
  assert.equal(Object.hasOwn(seam, "root"), false);
  assert.equal(JSON.stringify(seam).includes(context.plane), false);
});

test("CS-3 a model adopted by an account is its own: the platform's rows and other accounts' rows are never rewritten or returned", options, async () => {
  // The seeded catalogue is written once, in the background, when the app composes.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await rows(`SELECT 1 FROM evimed_vcr.models WHERE user_id IS NULL AND name = 'reference-binary'`)).length) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const platform = (await rows(`SELECT id, card, evidence FROM evimed_vcr.models WHERE user_id IS NULL AND name = 'reference-binary' AND version = '1.0.0'`))[0];
  assert.ok(platform, "the platform's reference model is seeded");
  const attack = await call("datamanager", "POST", "/api/vcr/models", { name: "reference-binary", version: "1.0.0", card: { title: "改写" }, evidence: ["external_validation"] });
  assert.deepEqual([attack.status, attack.body.code], [409, "vcr_model_exists"]);
  const kept = (await rows(`SELECT card, evidence FROM evimed_vcr.models WHERE id = $1`, [platform.id]))[0];
  assert.deepEqual(kept, { card: platform.card, evidence: platform.evidence }, "the platform's row is exactly what it was");

  const mine = await call("datamanager", "POST", "/api/vcr/models", { name: `mine-${suffix}`, version: "1.0.0", evidence: ["external_validation", "prospective_validation"] });
  assert.equal(mine.status, 201, mine.text);
  const stored = (await rows(`SELECT user_id, evidence, validation FROM evimed_vcr.models WHERE id = $1`, [mine.body.data.id]))[0];
  assert.equal(stored.user_id, accounts.datamanager);
  assert.deepEqual(stored.evidence, [], "a caller's list of evidence does not certify its own model");
  assert.deepEqual(stored.validation.declaredEvidence, ["external_validation", "prospective_validation"], "it is kept, as declared");
  assert.equal((await call("datamanager", "POST", "/api/vcr/models", { name: `mine-${suffix}`, version: "1.0.0" })).body.code, "vcr_model_exists", "insert-only within an owner");
  // The same name under another account is that account's own model, and neither sees the other's.
  const theirs = await call("viewer", "POST", "/api/vcr/models", { name: `mine-${suffix}`, version: "1.0.0" });
  assert.equal(theirs.status, 201, "another owner's scope is not a conflict");
  assert.notEqual(theirs.body.data.id, mine.body.data.id);
  const library = (await call("viewer", "GET", "/api/vcr/models")).body.data.models.filter((/** @type {any} */ model) => model.name === `mine-${suffix}`);
  assert.deepEqual(library.map((/** @type {any} */ model) => model.id), [theirs.body.data.id], "an account reads its own rows and the platform's");
});

test("CS-42 more than one page of active studies: every one is reached, and a wrap starts again at the beginning", options, async () => {
  const scratch = await createGeoTestDatabase(databaseUrl, "vcrstarve");
  const database = new ControlPlaneDatabase({ databaseUrl: scratch.url, databasePoolMax: 3, databaseConnectionTimeoutMs: 3_000 });
  try {
    const store = new VcrStore({ database });
    await store.ready();
    await store.query(`INSERT INTO evimed_vcr.studies (id, user_id, project_id, name, updated_at)
      SELECT 'std_st_' || lpad(g::text, 4, '0'), 'u_' || g, 'p_' || g, 's', now() - (g || ' hours')::interval FROM generate_series(1, 450) g`);
    const seen = new Set();
    const pages = [];
    for (let tick = 0; tick < 4; tick += 1) {
      const page = await store.activeStudies(200);
      pages.push(page.length);
      for (const row of page) seen.add(row.id);
    }
    assert.deepEqual(pages, [200, 200, 50, 200], "three pages cover 450 studies and the fourth call starts over");
    assert.equal(seen.size, 450, "every active study was in some tick's window");
    const fresh = await store.createStudy({ userId: "u_new", projectId: "p_new", name: "刚建的研究" });
    let reached = false;
    for (let tick = 0; tick < 4 && !reached; tick += 1) reached = (await store.activeStudies(200)).some((row) => row.id === fresh.id);
    assert.equal(reached, true, "a brand-new study is reached within one cycle");
  } finally {
    await database.close().catch(() => {});
    await scratch.drop();
  }
});

test("CS-43 deleting a project or an account takes its patient-level files, its engine job directories, and every membership and grant that names the account", options, async () => {
  const plane = context.plane;
  /** Seed one study's data-plane rows and files, and one engine job. @param {string} studyId @param {string} userId @param {string} label */
  const seed = async (studyId, userId, label) => {
    const db = context.app.vcr.store.database;
    await mkdir(path.join(plane, label), { recursive: true });
    const files = [`${label}/snapshot-a.csv`, `${label}/snapshot-b.csv`, `${label}/subject.csv`];
    for (const file of files) await writeFile(path.join(plane, file), "id,x\n1,2\n");
    await db.query(`INSERT INTO evimed_vcr.sources (id, user_id, study_id, name) VALUES ($1, $2, $3, $4)`, [`src_${label}`, userId, studyId, label]);
    await db.query(`INSERT INTO evimed_vcr.snapshots (id, source_id, study_id, user_id, version, location, sha256) VALUES ($1, $2, $3, $4, 1, $5, $6)`,
      [`snp_${label}`, `src_${label}`, studyId, userId, `${files[0]}\n${files[1]}`, "a".repeat(64)]);
    await db.query(`INSERT INTO evimed_vcr.analysis_tables (id, snapshot_id, study_id, user_id, shape, location, sha256) VALUES ($1, $2, $3, $4, 'subject', $5, $6)`,
      [`atb_${label}`, `snp_${label}`, studyId, userId, files[2], "b".repeat(64)]);
    await db.query(`INSERT INTO evimed_vcr.jobs (id, study_id, user_id, kind, method, checkpoint) VALUES ($1, $2, $3, 'design_simulation', 'design.simulate', $4::jsonb)`,
      [`job_${label}`, studyId, userId, JSON.stringify({ engineJobId: `eng_${label}` })]);
    return files;
  };
  const exists = async (/** @type {string} */ file) => stat(path.join(plane, file)).then(() => true, () => false);

  // 1. A project deleted from the sidebar takes its study's files and its engine job.
  const made = await call("owner", "POST", "/api/vcr/studies", { name: "删项目的研究" });
  const projectFiles = await seed(made.body.data.id, accounts.owner, `proj${suffix}`);
  const beforeCalls = engineCalls.length;
  const deleted = await call("owner", "DELETE", `/api/projects/${made.body.data.projectId}`, { confirm: made.body.data.projectId });
  assert.equal(deleted.status, 200, deleted.text);
  assert.deepEqual(await rows(`SELECT id FROM evimed_vcr.studies WHERE id = $1`, [made.body.data.id]), []);
  for (const file of projectFiles) assert.equal(await exists(file), false, `${file} was removed`);
  assert.equal(await exists(`proj${suffix}`), false, "and so was the directory the study alone made");
  assert.ok(engineCalls.slice(beforeCalls).includes(`DELETE /jobs/eng_proj${suffix}`), `the engine was told to delete the job: ${engineCalls.slice(beforeCalls).join(", ")}`);

  // 2. An account deleted takes its own study's files, and its roles and grants in studies that are not its own.
  const own = await call("leaver", "POST", "/api/vcr/studies", { name: "离开者的研究" });
  const ownFiles = await seed(own.body.data.id, accounts.leaver, `acct${suffix}`);
  const shared = await furnishedStudy("共享研究");
  await call("owner", "POST", `/api/vcr/studies/${shared.id}/members`, { userId: accounts.leaver, role: "clinical_reviewer" });
  await context.app.vcr.store.database.query(`INSERT INTO evimed_vcr.sources (id, user_id, study_id, name) VALUES ($1, $2, $3, 'owner source')`, [`src_own_${suffix}`, accounts.owner, shared.id]);
  await context.app.vcr.store.database.query(`INSERT INTO evimed_vcr.grants (id, source_id, study_id, user_id, grantee) VALUES ($1, $2, $3, $4, $5)`,
    [`grt_${suffix}`, `src_own_${suffix}`, shared.id, accounts.owner, accounts.leaver]);
  assert.equal((await rows(`SELECT 1 FROM evimed_vcr.members WHERE user_id = $1`, [accounts.leaver])).length >= 1, true);
  const gone = await call("leaver", "DELETE", "/api/account", { confirm: accounts.leaver, password: PASSWORD });
  assert.equal(gone.status, 200, gone.text);
  assert.deepEqual(await rows(`SELECT study_id FROM evimed_vcr.members WHERE user_id = $1`, [accounts.leaver]), [], "no membership names the deleted account");
  assert.deepEqual(await rows(`SELECT id FROM evimed_vcr.grants WHERE grantee = $1`, [accounts.leaver]), [], "no grant is made out to it");
  assert.deepEqual(await rows(`SELECT id FROM evimed_vcr.studies WHERE user_id = $1`, [accounts.leaver]), []);
  for (const file of ownFiles) assert.equal(await exists(file), false, `${file} was removed`);
  assert.ok(engineCalls.includes(`DELETE /jobs/eng_acct${suffix}`), "and the engine's job with it");
  assert.equal((await call("owner", "GET", `/api/vcr/studies/${shared.id}`)).status, 200, "the study that was shared with it is untouched");
  assert.ok((await rows(`SELECT 1 FROM evimed_vcr.sources WHERE id = $1`, [`src_own_${suffix}`])).length === 1, "and so is the owner's source");
  // The audit outlives it.
  assert.ok((await rows(`SELECT 1 FROM evimed_vcr.audit WHERE user_id = $1`, [accounts.leaver])).length > 0);
});

/** One upload the way the browser sends it: the file as the raw body, its name and role in the query. @param {string} who @param {string} route @param {string | Buffer} body */
async function uploadFile(who, route, body) {
  const headers = { ...context.sessions[who], "content-type": "application/octet-stream" };
  const response = await fetch(`${context.base}${route}`, { method: "POST", headers, body });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

test("PA-10 PB-10 CS-41 data intake through the real server: source, upload, field map, snapshot, tables, grant — as the roles that may, refused to the ones that may not, and no path in any answer", options, async () => {
  const study = await furnishedStudy("数据接入研究");
  const S = `/api/vcr/studies/${study.id}`;
  const cohort = ["PATIENT_NO,ARM,AGE,OS_MONTHS,OS_DEAD"];
  for (let n = 1; n <= 24; n += 1) cohort.push(`HZ-${9000 + n},${n <= 12 ? "TRT" : "CTL"},${40 + n},${(3.11 + n * 0.71).toFixed(2)},${n % 4 === 0 ? 0 : 1}`);
  const csv = `${cohort.join("\n")}\n`;

  // A data manager registers; a viewer, a statistician and a recruiter cannot.
  for (const who of ["viewer", "statistician", "recruiter", "site", "clinician"]) {
    assert.equal((await call(who, "POST", `${S}/data/sources`, { name: "越权登记" })).status, 403, `${who} may not register a source`);
  }
  assert.equal((await call("stranger", "POST", `${S}/data/sources`, { name: "陌生人" })).status, 404);
  // The write is CSRF-guarded.
  const noToken = await fetch(`${context.base}${S}/data/sources`, { method: "POST", headers: { "content-type": "application/json", cookie: context.sessions.owner.cookie }, body: JSON.stringify({ name: "x" }) });
  assert.equal(noToken.status, 403);
  // A body that names a field the route does not list is refused whole.
  assert.equal((await call("owner", "POST", `${S}/data/sources`, { name: "x", location: "/etc" })).body.code, "vcr_payload_invalid");
  assert.equal((await call("owner", "POST", `${S}/data/sources`, { name: "x", valueSource: "wishful" })).body.code, "vcr_payload_invalid");

  const registered = await call("datamanager", "POST", `${S}/data/sources`, sourceBody({ name: "合作方基线", ownerParty: "合作方医院", allowedUses: ["vcr"], retention: { until: "2030-01-01" }, visibleWindow: { start: "2020-01-01" }, valueSource: "observed" }));
  assert.equal(registered.status, 201, registered.text);
  const sourceId = registered.body.data.source.id;
  assert.equal(registered.body.data.source.fieldMapState, "none");

  // Upload: the raw file, its name in the query. The name is display text only.
  const uploaded = await uploadFile("datamanager", `${S}/data/sources/${sourceId}/files?${uploadQuery({ name: "队列 cohort.csv" })}`, csv);
  assert.equal(uploaded.status, 201, uploaded.text);
  assert.equal(uploaded.body.data.file.rowCount, 24);
  assert.equal(uploaded.body.data.file.name, "队列 cohort.csv");
  assert.deepEqual(uploaded.body.data.file.columns.map((/** @type {any} */ column) => column.name), ["PATIENT_NO", "ARM", "AGE", "OS_MONTHS", "OS_DEAD"]);
  assert.equal(Object.hasOwn(uploaded.body.data.file, "location"), false, "the browser is never told where a file is");
  assert.equal((await uploadFile("datamanager", `${S}/data/sources/${sourceId}/files?${uploadQuery({ name: "队列 cohort.csv" })}`, csv)).status, 200, "the same bytes are the same file");
  const dictionary = await uploadFile("datamanager", `${S}/data/sources/${sourceId}/files?${uploadQuery({ name: "字典.csv", role: "dictionary" })}`, "变量名,说明\nAGE,年龄\n");
  assert.equal(dictionary.status, 201, dictionary.text);
  assert.equal(dictionary.body.data.file.entries, 1);
  assert.equal((await uploadFile("datamanager", `${S}/data/sources/${sourceId}/files?name=x.parquet`, "PAR1")).body.code, "vcr_data_format_unsupported");
  assert.equal((await uploadFile("datamanager", `${S}/data/sources/${sourceId}/files`, csv)).body.code, "vcr_data_file_name_invalid");
  assert.equal((await uploadFile("viewer", `${S}/data/sources/${sourceId}/files?name=a.csv`, csv)).status, 403, "refused before the body is read, and the client still gets the answer");
  assert.equal((await uploadFile("stranger", `${S}/data/sources/${sourceId}/files?name=a.csv`, csv)).status, 404);
  assert.equal((await uploadFile("datamanager", `${S}/data/sources/src_nope/files?name=a.csv`, csv)).body.code, "vcr_source_not_found");

  // Field map: proposed, then confirmed by the hash that was shown.
  const columns = [
    { table: "队列 cohort.csv", column: "PATIENT_NO", role: "subject_key", identifier: true },
    { table: "队列 cohort.csv", column: "ARM", role: "arm", alias: "arm", codes: { treated: ["TRT"], control: ["CTL"] } },
    { table: "队列 cohort.csv", column: "AGE", role: "covariate", alias: "age", unit: "year" },
    { table: "队列 cohort.csv", column: "OS_MONTHS", role: "outcome_time", parameter: "OS" },
    { table: "队列 cohort.csv", column: "OS_DEAD", role: "outcome_event", parameter: "OS" },
  ];
  const badMap = await call("datamanager", "POST", `${S}/data/sources/${sourceId}/fieldmap`, fieldMapBody([...columns, { column: "AGE", role: /** @type {any} */ ("hacker") }], "先试一试"));
  assert.equal(badMap.status, 201);
  assert.equal(badMap.body.data.entryIssues[0].code, "role_unknown", "an entry that fails is named; the rest is kept");
  assert.equal((await call("datamanager", "POST", `${S}/data/sources/${sourceId}/snapshots`, {})).body.code, "vcr_field_map_unconfirmed", "a snapshot is not frozen from an unconfirmed map");
  const proposed = await call("datamanager", "POST", `${S}/data/sources/${sourceId}/fieldmap`, fieldMapBody(columns));
  assert.deepEqual([proposed.body.data.entryIssues, proposed.body.data.mapIssues], [[], []]);
  assert.equal((await call("datamanager", "POST", `${S}/data/sources/${sourceId}/fieldmap/confirm`, { hash: "b".repeat(64) })).body.code, "vcr_field_map_changed");
  assert.equal((await call("datamanager", "POST", `${S}/data/sources/${sourceId}/fieldmap/confirm`, { hash: "not-a-hash" })).body.code, "vcr_payload_invalid");
  const confirmed = await call("datamanager", "POST", `${S}/data/sources/${sourceId}/fieldmap/confirm`, confirmFieldMapBody(proposed.body.data.hash));
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.body.data.source.fieldMapState, "confirmed");

  // Freeze: a snapshot with its tables, sealed only if the study asks for it (this one is exploratory).
  const frozen = await call("datamanager", "POST", `${S}/data/sources/${sourceId}/snapshots`, freezeBody());
  assert.equal(frozen.status, 201, frozen.text);
  const snapshot = frozen.body.data.snapshot;
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.sealedFields, []);
  assert.deepEqual(frozen.body.data.tables.registered.map((/** @type {any} */ table) => table.shape).sort(), ["events", "subject"]);
  assert.equal(frozen.body.data.tables.subjects, 24);
  assert.equal(JSON.stringify(frozen.body).includes(context.plane), false);
  // The tables can be derived again (idempotent: same bytes, same table).
  const again = await call("datamanager", "POST", `${S}/data/snapshots/${snapshot.id}/tables`, {});
  assert.equal(again.status, 201);
  assert.equal(again.body.data.registered.find((/** @type {any} */ table) => table.shape === "subject").sha256, frozen.body.data.tables.registered.find((/** @type {any} */ table) => table.shape === "subject").sha256);

  // The page shows all of it, to a member who may read it, and to nobody's path.
  const page = await call("owner", "GET", `${S}/data`);
  assert.equal(page.status, 200);
  assert.equal(page.text.includes(context.plane), false, "no path of the server in the tab");
  assert.equal(page.text.includes("HZ-9001"), false, "and no subject id from the partner's file");

  // Grants: only the source's own account grants, and only to a member of the study.
  const noOwner = await call("owner", "POST", `${S}/data/sources/${sourceId}/grants`, { grantee: accounts.lead, role: "lead" });
  assert.equal(noOwner.status, 403);
  assert.equal(noOwner.body.code, "vcr_grant_owner_only");
  assert.equal((await call("datamanager", "POST", `${S}/data/sources/${sourceId}/grants`, { grantee: "someone-not-here" })).body.code, "vcr_grant_invalid");
  const grant = await call("datamanager", "POST", `${S}/data/sources/${sourceId}/grants`, grantBody({ grantee: accounts.lead, role: "lead", fields: ["AGE", "ARM"], purposes: ["vcr"], windowStart: "2020-01-01", windowEnd: "2999-12-31", fieldMode: "allow" }));
  assert.equal(grant.status, 201, grant.text);
  const revoked = await call("datamanager", "POST", `${S}/data/grants/${grant.body.data.grant.id}/revoke`, {});
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.data.grant.revokedAt);
  assert.equal((await call("datamanager", "POST", `${S}/data/grants/${grant.body.data.grant.id}/revoke`, {})).status, 200, "revoking twice is not an error");
  assert.equal((await call("datamanager", "POST", `${S}/data/grants/grt_nope/revoke`, {})).body.code, "vcr_grant_not_found");

  // A file no snapshot names can be removed; one a snapshot names cannot.
  assert.equal((await call("datamanager", "DELETE", `${S}/data/files/${uploaded.body.data.file.id}`)).body.code, "vcr_source_file_frozen");
  const spare = await uploadFile("datamanager", `${S}/data/sources/${sourceId}/files?name=spare.csv`, "a,b\n1,2\n");
  assert.equal((await call("datamanager", "DELETE", `${S}/data/files/${spare.body.data.file.id}`)).status, 200);

  // Another study's ids do not exist here, and here's do not exist there.
  const other = await furnishedStudy("另一个研究");
  assert.equal((await call("owner", "POST", `/api/vcr/studies/${other.id}/data/sources/${sourceId}/snapshots`, {})).body.code, "vcr_source_not_found");
  assert.equal((await call("owner", "POST", `/api/vcr/studies/${other.id}/data/snapshots/${snapshot.id}/tables`, {})).body.code, "vcr_snapshot_not_found");
  assert.equal((await call("owner", "POST", `/api/vcr/studies/${other.id}/data/grants/${grant.body.data.grant.id}/revoke`, {})).body.code, "vcr_grant_not_found");

  // Every step is on the platform's audit and the module's own.
  const trail = (await rows(`SELECT DISTINCT action FROM evimed_vcr.audit WHERE study_id = $1`, [study.id])).map((row) => row.action);
  for (const action of ["source.register", "source.file", "fieldmap.propose", "fieldmap.confirm", "snapshot.freeze", "analysis_table.put", "grant.create", "grant.revoke", "source.file.remove"]) {
    assert.ok(trail.includes(action), `${action} is on the module's ledger: ${trail.join(",")}`);
  }
});

test("DL-13 DL-15 readiness names the module and its engine; the metrics carry the queue gauges beside GEO's, in the platform's prefix", options, async () => {
  const ready = await (await fetch(`${context.base}/api/ready`)).json();
  const vcr = ready.data.checks.vcr;
  assert.equal(vcr.ok, true, JSON.stringify(vcr));
  assert.equal(vcr.engine, "wired");
  assert.equal(vcr.warnings?.includes("vcr_engine_unconfigured") ?? false, false);
  const text = await (await fetch(`${context.base}/api/ops/metrics`, { headers: { authorization: "Bearer test-only-metrics-token" } })).text();
  for (const line of [/^open_science_vcr_enabled 1$/m, /^open_science_vcr_tables_readable 1$/m, /^open_science_vcr_engine_configured 1$/m,
    /^open_science_vcr_studies\{state="all"\} \d+$/m, /^open_science_vcr_studies\{state="active"\} \d+$/m,
    /^open_science_vcr_jobs\{state="queued"\} \d+$/m, /^open_science_vcr_jobs\{state="running"\} \d+$/m, /^open_science_vcr_jobs\{state="awaiting_budget"\} \d+$/m]) {
    assert.match(text, line);
  }
  const names = [...new Set([...text.matchAll(/^# TYPE (open_science_vcr_[a-z_]+) /gm)].map((match) => match[1]))];
  assert.ok(names.length >= 8, `${names.length} vcr families: ${names.join(", ")}`);
  assert.equal(text.includes("evimed_vcr_"), false, "the platform's prefix, not the module's own");
  // The release's idle check counts the worker: it is in the activity the maintenance service inspects.
  assert.equal(typeof context.app.vcr.worker.status().running, "boolean");
});

test("a stopped run releases its bounded runtime, and the study's dispatch does not hold the project's slot", options, async () => {
  // The dispatch itself is replaced in this file (a run needs a kernel); what is
  // held here is that the orchestrator's dispatch reached the seam with the
  // shape the server's `dispatchVcrRun` takes, so the release in that function
  // is reachable from a real study.
  assert.ok(dispatches.length > 0, "the matrix ran steps and exports through the orchestrator");
  for (const input of dispatches) {
    assert.match(String(input.dispatchId), /^vcr-/);
    assert.equal(typeof input.projectId, "string");
    assert.equal(typeof input.capabilityId, "string");
  }
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const dispatchBody = source.slice(source.indexOf("async function dispatchVcrRun"), source.indexOf("async function dispatchGeoRun"));
  assert.match(dispatchBody, /endBoundedRuntime\(project, dispatchId\)/, "a dispatch that does not start releases the runtime it reserved");
  assert.match(source, /startsWith\("vcr-"\)\) \{\s+if \(runtimeManager\.boundedRuntimeScope\(project\)\?\.runId === run\.dispatchId\)/,
    "a finished vcr run releases its runtime before the orchestrator folds it in");
  assert.match(source, /vcr\?\.worker\?\.status\?\.\(\)\.running/, "the release idle check counts the vcr worker");
});


test("shared exports serve all VCR kinds to current members without a new research run, and revoke cached downloads", options, async () => {
  const study = await sharedStudy();
  await rows("UPDATE evimed_vcr.jobs SET state='canceled', checkpoint=checkpoint || '{\"engineStopped\":true}'::jsonb WHERE state IN ('queued','running')");
  const current = await context.app.vcr.store.studyById(study.id);
  const beforeRuns = dispatches.length;
  let lastId;
  for (const kind of VCR_EXPORT_KINDS) {
    const written = await vcrRuntimeWrite({ store: context.app.vcr.store, service: context.app.vcr.service, study: current,
      what: "report", items: [ { kind, section: "Methods", template: "方法。" }, { kind, section: "Limitations", template: "尚无结果，保留限制。" } ], data: null });
    assert.equal(written.ok, true);
    const queued = await call("lead", "POST", `/api/vcr/studies/${study.id}/export`, { kind });
    assert.equal(queued.status, 201, queued.text);
    lastId = queued.body.data.conversion.id;
    let status;
    for (let i = 0; i < 100; i++) {
      status = await call("lead", "GET", `/api/document-exports/${lastId}`);
      if (status.body.data?.state === "ready") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status.body.data.state, "ready", status.text);
    const download = await call("lead", "GET", `/api/document-exports/${lastId}/download/docx`);
    assert.equal(download.status, 200, download.text);
    assert.match(download.text, /Methods[\s\S]*Limitations/);
    assert.equal((await call("stranger", "GET", `/api/document-exports/${lastId}/download/pdf`)).status, 404);
  }
  assert.equal(dispatches.length, beforeRuns, "conversion did not start another conversation");
  assert.equal((await call("owner", "DELETE", `/api/vcr/studies/${study.id}/members/${accounts.lead}`)).status, 200);
  assert.equal((await call("lead", "GET", `/api/document-exports/${lastId}`)).status, 404);
  assert.equal((await call("lead", "GET", `/api/document-exports/${lastId}/download/docx`)).status, 404);
});
