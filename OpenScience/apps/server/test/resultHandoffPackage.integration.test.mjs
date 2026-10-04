// The research package against the real ledger: the replays of a result are listed by the documents store's containment
// filter, read through the real job rows, and carried into a package the shipped verifier passes. The unit file
// (`resultHandoffPackage.test.mjs`) holds every tamper and boundary case on in-memory stores; this one holds the part only
// PostgreSQL can answer.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { loadConfig } from "../src/config.mjs";
import { PostgresStore } from "../src/store.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ProductJobs } from "../src/productJobs.mjs";
import { ResultExportService } from "../src/resultExport.mjs";
import { ResultProvenanceService } from "../src/resultProvenanceService.mjs";
import { ResultReplayService } from "../src/resultReplayService.mjs";
import { replayDigest } from "../src/resultReplayClient.mjs";

const run = promisify(execFile);
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured", timeout: 60000 };
const sha = value => createHash("sha256").update(value).digest("hex");
const VERIFIER = new URL("../src/resultPackageVerify.py", import.meta.url).pathname;
const CODE_FILES = [{ path: "new_meta/engines/meta_engine.py", sha256: "1".repeat(64), bytes: 120 }];
const ENVIRONMENT = { python: "3.12.3", implementation: "CPython", platform: "linux", machine: "x86_64", packages: { numpy: "1.26.4" } };
const VALUES = [{ key: "values.pooled_effect", value: 0.7134, unit: "odds_ratio", absoluteTolerance: 1e-10, relativeTolerance: 1e-9 }];

test("a replayed result's package carries the replay read from the real ledger, and the verifier passes it", options, async t => {
  const isolated = await createGeoTestDatabase(databaseUrl, "hnd");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "result-handoff-"));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: "postgres", devAuth: true, maxProjectBytes: 32 * 1024 * 1024 });
  const store = new PostgresStore(config);
  t.after(async () => { await store.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  const user = await store.devUser(); const project = await store.requireProject(user, "default");
  const documents = new ProductDocuments(store.database); const jobs = new ProductJobs(store.database);
  const results = new ResultProvenanceService({ documents, config,
    authorizeProject: async (actor, id) => store.requireProject(await store.userById(actor), id),
    authorizeReference: async (_actor, _project, ref) => ref });
  const capability = { available: true, method: "meta.dl", version: "1", codeDigest: replayDigest(CODE_FILES), environmentDigest: replayDigest(ENVIRONMENT), codeFiles: CODE_FILES, environment: ENVIRONMENT };
  const service = new ResultReplayService({ results, documents, jobs, config, engine: { configured: () => true, capabilities: async () => ({ methods: [capability] }), start: async () => ({ state: "running" }) } });
  const finish = async () => {
    const job = await jobs.claim(["result-replay"], "handoff-fixture", { leaseMs: 60000 });
    const prepared = await service.prepare(job);
    await service.start(job, prepared);
    const resultPath = `result-replays/${job.id}/output/result.json`;
    const body = JSON.stringify({ receipt: { recipeDigest: prepared.execution.recipeDigest, codeFiles: CODE_FILES, environment: ENVIRONMENT }, machineValues: VALUES });
    await mkdir(path.dirname(path.join(project.workspaceDir, resultPath)), { recursive: true });
    await writeFile(path.join(project.workspaceDir, resultPath), body);
    return service.complete(job, prepared, { jobId: job.id, recipeDigest: prepared.execution.recipeDigest, state: "succeeded", cleanup: "confirmed", resultPath,
      artifacts: [{ path: resultPath, sha256: sha(body), bytes: Buffer.byteLength(body) }], machineValues: VALUES });
  };
  await writeFile(path.join(project.workspaceDir, "input.json"), '{"studies":[]}');
  await service.calculate(user.id, project, { method: "meta.dl", inputPath: "input.json", parameters: {} }, { kind: "engine", sessionId: "native-session", callId: "first" });
  const original = await finish();
  const replay = await service.request(user.id, original.versionId, { projectId: project.id, digest: original.digest, requestId: "again" });
  await finish();

  const listed = await service.listFor(user.id, project.id, original.versionId);
  assert.deepEqual(listed.map(item => item.id), [replay.id], "the original's own calculation is not a re-run; the one request is");
  assert.equal(listed[0].state, "succeeded");
  assert.equal(listed[0].comparison.numbers.status, "identical");
  assert.equal(listed[0].outputDigest.length, 64);

  const reply = await new ResultExportService({ results, replays: service }).export(user.id, project.id, original.versionId);
  const files = unzipSync(reply.bytes);
  const [record] = JSON.parse(Buffer.from(files["verification.json"]).toString()).versions;
  assert.equal(record.replays.status, "recorded");
  assert.equal(record.replays.items[0].comparison.numbers.status, "identical");
  assert.equal(JSON.parse(Buffer.from(files["reproduction.json"]).toString()).calculations[0].status, "reconstructable");
  const root = await mkdtemp(path.join(os.tmpdir(), "result-handoff-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); }
  const outcome = JSON.parse((await run("python3", ["-I", VERIFIER, root])).stdout);
  assert.equal(outcome.ok, true, JSON.stringify(outcome.problems));
});
