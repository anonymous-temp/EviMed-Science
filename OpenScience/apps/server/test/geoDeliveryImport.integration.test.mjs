// The claim library of a finished geo-insight run is registered from its
// delivered claims.json (geoDeliveryImport.mjs) — the production run of
// 2026-09-25 delivered 80 claims and registered 3.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claimChunks, createGeoDeliveryImport, readWorkspaceFile } from "../src/geoDeliveryImport.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const run = randomBytes(4).toString("hex");
const USER = `importer-${run}`;

/** @type {any} */
let database = null;
/** @type {GeoStore} */
let store;
/** @type {Awaited<ReturnType<typeof createGeoTestDatabase>> | null} */
let isolated = null;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "geoimport");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2_000 });
  store = new GeoStore({ database });
  await store.ready();
});

after(async () => {
  if (database) await database.close();
  await isolated?.drop();
});

/** A method-shaped claim record: the table's fields and many it does not keep. */
const claim = (/** @type {number} */ index) => ({
  claimKey: `MAZ-${index}`, statement: `主张 ${index}`, quote: `原文 ${index}。`, sourceRef: "web-page:e1edc04a1ac28750", sourceKind: "label",
  evidenceLevel: "说明书", inLabel: true, verifiedAt: "2026-09-25", three_screen: { label: true }, expiry_triggers: ["说明书改版"],
  reviewer: "药师", allowed_layers: ["card", "popular"], claim_id: `C${index}`,
});

test("a finished insight run's claims.json is registered in full, once, through the tool's own validation", options, async () => {
  const created = await store.createProject({ userId: USER, projectId: `p-${run}`, engines: ["deepseek"], coverageDays: 90 });
  const files = new Map([["deliverables/geo-insight/claims.json", JSON.stringify({ schema: "x", claims: [...Array.from({ length: 80 }, (_u, i) => claim(i)),
    { claimKey: "bad", statement: "s", sourceRef: "r" }] })]]);
  const reports = /** @type {string[]} */ ([]);
  const importDelivery = createGeoDeliveryImport({ store, report: (code) => reports.push(code),
    readFile: async (_root, file) => { if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files.get(file) ?? ""; },
    listInsightFolders: async () => [] });
  const project = { id: `p-${run}`, userId: USER, workspaceDir: "/nowhere" };

  assert.equal(await importDelivery(project, { id: "run_1", status: "running", deliverables: [{ id: "geo-insight", capability: "geo-insight" }] }), null,
    "a run still going is not imported");
  const result = await importDelivery(project, { id: "run_1", status: "succeeded", deliverables: [{ id: "geo-insight", capability: "geo-insight" },
    { id: "other", capability: "clinical-evidence-synthesis" }] });
  assert.deepEqual(result, { imported: 80, issues: 1 }, "every valid claim, extra fields dropped; the one without a quote refused alone");
  assert.equal((await store.listClaims(created.id)).length, 80);

  // A second finished run that delivered the same file: no new versions.
  const again = await importDelivery(project, { id: "run_2", status: "failed", progress: { deliverables: [{ id: "geo-insight" }] } });
  assert.equal(again?.imported, 80);
  assert.ok((await store.listClaims(created.id)).every((row) => row.version === 1), "an unchanged statement is not a new version");
  assert.equal(await importDelivery(project, { id: "run_2", status: "failed" }), null, "a run is imported once per process");
  assert.equal(await importDelivery({ ...project, id: "not-geo" }, { id: "run_3", status: "succeeded" }), null, "not a GEO project");
});

test("a run that ended before the import existed is picked up when the project's next run ends", options, async () => {
  const created = await store.createProject({ userId: USER, projectId: `q-${run}`, engines: ["deepseek"], coverageDays: 90 });
  const importDelivery = createGeoDeliveryImport({ store,
    readFile: async (_root, file) => { if (file !== "deliverables/geo-insight/claims.json") throw new Error("missing"); return JSON.stringify({ claims: [claim(1), claim(2)] }); },
    listInsightFolders: async () => ["geo-insight"] });
  const result = await importDelivery({ id: `q-${run}`, userId: USER, workspaceDir: "/nowhere" }, { id: "later", status: "succeeded", deliverables: [] });
  assert.deepEqual(result, { imported: 2, issues: 0 });
  assert.equal((await store.listClaims(created.id)).length, 2);
});

test("claims are sent in chunks the write accepts", () => {
  const big = Array.from({ length: 450 }, (_u, i) => ({ claimKey: `k${i}`, statement: "x".repeat(600) }));
  const chunks = claimChunks(big);
  assert.equal(chunks.flat().length, 450);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 200);
    assert.ok(Buffer.byteLength(JSON.stringify({ items: chunk })) < 256 * 1024);
  }
});

test("the default reader finds a deliverable by its path in the workspace, from any working directory", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "geo-import-ws-"));
  try {
    await mkdir(path.join(workspace, "deliverables", "geo-insight"), { recursive: true });
    await writeFile(path.join(workspace, "deliverables", "geo-insight", "claims.json"), JSON.stringify({ claims: [claim(1)] }));
    const text = String(await readWorkspaceFile(workspace, "deliverables/geo-insight/claims.json"));
    assert.equal(JSON.parse(text).claims.length, 1);
    await assert.rejects(readWorkspaceFile(workspace, "../outside.json"), { code: "path_forbidden" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the run's competitors come with its claims when the project has none", options, async () => {
  const created = await store.createProject({ userId: USER, projectId: `r-${run}`, engines: ["deepseek"], coverageDays: 90 });
  const importDelivery = createGeoDeliveryImport({ store,
    readFile: async () => JSON.stringify({ competitors: [{ brandName: "诺和盈", genericName: "司美格鲁肽注射液", reason: "同适应证", tier: "A" }], claims: [claim(1)] }),
    listInsightFolders: async () => ["geo-insight"] });
  await importDelivery({ id: `r-${run}`, userId: USER, workspaceDir: "/nowhere" }, { id: "with-rivals", status: "succeeded", deliverables: [] });
  const saved = await store.getProject(USER, created.id);
  assert.deepEqual(saved?.competitors.map((/** @type {any} */ entry) => entry.brandName), ["诺和盈"]);
});
