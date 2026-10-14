// The production case, end to end on a real ledger (2026-10-14): a product-test PDF read before the slots were assigned by type carries a
// clinical study's slots. `scripts/ops/reunderstand-sources.mjs` reports it by id, asks for a new reading only with --apply, through the
// source service's retry (queued, a new generation, an ingest job), and a second run finds nothing more to do for it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebApiApp } from "../src/server.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const SCRIPT = fileURLToPath(new URL("../../../scripts/ops/reunderstand-sources.mjs", import.meta.url));

/** Run the command with the isolated database and read the JSON it prints. */
function runScript(args, url, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, OPEN_SCIENCE_STATE_STORE: "postgres", OPEN_SCIENCE_DATABASE_URL: url, OPEN_SCIENCE_DATA_DIR: dataDir, OPEN_SCIENCE_ENV_FILE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => { try { resolve({ code, report: JSON.parse(out), err }); } catch { reject(new Error(`no report (exit ${code}): ${out.slice(0, 300)} ${err.slice(0, 300)}`)); } });
  });
}

test("a stored reading with a study's slots on a document that is not a paper is reported by id, read again only on --apply, and not found again", {
  skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 180_000,
}, async () => {
  const isolated = await createGeoTestDatabase(databaseUrl, "reunderstand");
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-reunderstand-"));
  const app = createWebApiApp({ dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
    stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url, sourceIngestionEnabled: false, memoryIndexProvider: "builtin", kbSearchEnabled: false });
  const username = `ru${randomUUID().slice(0, 8)}`;
  let user;
  let listening = false;
  try {
    user = await app.store.createUser(username, "test-only-reunderstand-password", "Reunderstand fixture");
    const project = await app.store.defaultProject(await app.store.userById(user.id));
    await app.listen(0, "127.0.0.1");
    listening = true;
    const documents = app.sourceService.documents;
    const slot = (value) => ({ state: "known", value, evidence: [] });
    /** A document the ledger holds as read, with the understanding it was read into. */
    const readDocument = async (id, docType, slots, madeAs = docType) => {
      const understandingId = `understanding:${id}:g1`;
      await documents.put(user.id, "source", id, {
        paths: [`knowledge-base/${id}.pdf`], status: "complete", docType, depth: "structured", version: 1, generation: 1, reasons: [], valueVector: {},
        outputs: { summary: "x" }, fingerprint: { size: 10, sha256: "a".repeat(64) }, currentUnderstandingId: understandingId, connector: { type: "upload" },
      }, { expectedRevision: 0, projectId: project.id });
      await documents.put(user.id, "knowledge", understandingId, { recordType: "source-understanding", sourceId: id, generation: 1, status: "current",
        output: { docType: madeAs, slots }, units: [] }, { expectedRevision: 0, projectId: project.id });
    };
    const productId = `src_${"1".repeat(32)}`;
    const paperId = `src_${"2".repeat(32)}`;
    const noteId = `src_${"3".repeat(32)}`;
    await readDocument(productId, "document", { design: slot("本文档没有研究设计"), population: slot("文档没有定义研究人群"), purpose: slot("记录一次测评") });
    await readDocument(paperId, "published-paper", { design: slot("随机对照试验"), doi: slot("10.1000/xyz"), limitations: slot("单中心") });
    await readDocument(noteId, "note-memo", { topic: slot("组会"), decisions: slot("分开合并") });

    const dry = await runScript(["--user", user.id, "--json"], isolated.url, dataDir);
    assert.equal(dry.code, 0, dry.err);
    assert.deepEqual([dry.report.scanned, dry.report.outdated, dry.report.accounts, dry.report.applied], [3, 1, 1, false]);
    assert.deepEqual(dry.report.byReason, { slots: 1, schema: 0 });
    assert.deepEqual(dry.report.sources.map((item) => [item.sourceId, item.extra, item.queued]), [[productId, ["design", "population"], false]]);
    assert.equal(JSON.stringify(dry.report).includes("本文档没有研究设计"), false, "no text of a document is printed");
    assert.equal((await documents.get(user.id, "source", productId)).payload.status, "complete", "a report changes nothing");

    const applied = await runScript(["--user", user.id, "--apply", "--limit", "5"], isolated.url, dataDir);
    assert.equal(applied.code, 0, applied.err);
    assert.deepEqual([applied.report.outdated, applied.report.queued, applied.report.left, applied.report.failed], [1, 1, 0, []]);
    const queued = await documents.get(user.id, "source", productId);
    assert.deepEqual([queued.payload.status, queued.payload.generation], ["queued", 2], "it is read again the way 「重新读取」 asks: queued, a new generation");
    const jobs = (await app.store.database.query("SELECT kind, status FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'sourceId'=$2", [user.id, productId])).rows;
    assert.ok(jobs.some((job) => job.kind === "ingest" && job.status === "queued"), JSON.stringify(jobs));
    assert.equal((await documents.get(user.id, "source", paperId)).payload.status, "complete", "a paper that carries its clinical slots is left alone");

    // Idempotent: while the new reading is on its way the source is not read again, and nothing else is outdated.
    const again = await runScript(["--user", user.id, "--apply"], isolated.url, dataDir);
    assert.deepEqual([again.report.scanned, again.report.outdated, again.report.queued], [2, 0, 0]);
    assert.equal((await documents.get(user.id, "source", productId)).payload.generation, 2);
  } finally {
    if (user) { try { await app.store.deleteUser(await app.store.userById(user.id)); } catch { /* the next run starts from a fresh account anyway */ } }
    if (listening) await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await isolated.drop();
  }
});
