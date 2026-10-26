// Separate operating-system processes prove task admission uses the shared database lock, rather than a process-local mutex.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { AutopilotService } from "../src/autopilotService.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const configuredUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !configuredUrl && "Private test PostgreSQL is not configured", timeout: 30_000 };
let isolated, database, service, documents;
const workers = new Set();
const instruction = { title: "Morning summary", prompt: "Summarize the supplied news", taskTypes: ["routine"],
  schedule: { kind: "daily", timeZone: "UTC", time: "13:00" }, dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8 };
const moduleUrl = (file) => new URL(`../src/${file}`, import.meta.url).href;
const childScript = `
import { ControlPlaneDatabase } from ${JSON.stringify(moduleUrl("controlPlaneDatabase.mjs"))};
import { ProductDocuments, ProductJobs } from ${JSON.stringify(moduleUrl("productStore.mjs"))};
import { AutopilotService } from ${JSON.stringify(moduleUrl("autopilotService.mjs"))};
const database = new ControlPlaneDatabase({ databaseUrl: process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, databasePoolMax: 3, databaseConnectionTimeoutMs: 2000 });
try {
  await database.query("SELECT 1");
  process.stdout.write("READY\\n");
  const request = await new Promise((resolve, reject) => {
    let content = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { content += chunk; });
    process.stdin.on("end", () => { try { resolve(JSON.parse(content)); } catch (error) { reject(error); } });
  });
  const service = new AutopilotService({ documents: new ProductDocuments(database), jobs: new ProductJobs(database), now: () => new Date("2026-10-25T12:00:00Z") });
  try {
    const result = await service.createScheduledTask(request.userId, request.input, { maxTasks: request.maxTasks });
    process.stdout.write(JSON.stringify({ pid: process.pid, id: result.agenda.id, created: result.created, state: result.agenda.payload.status, sourceIds: (result.agenda.payload.materials ?? []).map(item => item.sourceId) }) + "\\n");
  } catch (error) { process.stdout.write(JSON.stringify({ pid: process.pid, code: error.code, status: error.status, message: error.message, detail: error.detail }) + "\\n"); }
} finally { await database.close(); }
`;

before(async () => {
  if (!configuredUrl) return;
  isolated = await createGeoTestDatabase(configuredUrl, "taskadmission");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  for (const userId of ["owner", "other-owner"]) {
    await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Admission test','development')", [userId]);
    for (const id of ["identical", "quota", "scope-a", "scope-b", "response-loss", "materials"]) {
      await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'Admission test',1000000)", [userId, id]);
    }
  }
  documents = new ProductDocuments(database);
  service = new AutopilotService({ documents, jobs: new ProductJobs(database), now: () => new Date("2026-10-25T12:00:00Z") });
});
after(async () => {
  for (const worker of workers) worker.kill();
  await database?.close();
  await isolated?.drop();
});

/** Start all processes and their database connections before releasing any admission request. */
async function admit(requests) {
  const running = requests.map((request) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      env: { ...process.env, OPEN_SCIENCE_TEST_POSTGRES_URL: isolated.url }, stdio: ["pipe", "pipe", "pipe"],
    });
    workers.add(child);
    let stdout = "", stderr = "";
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("READY\n")) readyResolve(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = new Promise((resolve, reject) => {
      child.once("error", (error) => { readyReject(error); reject(error); });
      child.once("close", (code) => {
        workers.delete(child);
        if (code !== 0) { const error = new Error(`Admission child exited ${code}: ${stderr}`); readyReject(error); reject(error); return; }
        try { resolve(JSON.parse(stdout.trim().split("\n").at(-1))); } catch (error) { readyReject(error); reject(error); }
      });
    });
    return { child, ready, result, request };
  });
  const results = Promise.all(running.map((item) => item.result));
  await Promise.all(running.map((item) => item.ready));
  for (const item of running) item.child.stdin.end(JSON.stringify(item.request));
  return results;
}
const request = (projectId, extra = {}, userId = "owner") => ({ userId, input: { ...instruction, projectId, ...extra }, maxTasks: 1 });

test("OS processes concurrently retrying the same identity create exactly one active task", options, async () => {
  const results = await admit([request("identical"), request("identical"), request("identical")]);
  assert.equal(new Set(results.map((item) => item.pid)).size, 3, "these are separate Node processes");
  assert.equal(new Set(results.map((item) => item.id)).size, 1, JSON.stringify(results));
  assert.equal(results.filter((item) => item.created).length, 1, JSON.stringify(results));
  assert.ok(results.every((item) => item.state === "active"));
  assert.equal((await service.list("owner", { projectId: "identical" })).items.length, 1);
});

test("OS processes with different identities cannot over-admit the last retained-task slot", options, async () => {
  const results = await admit([request("quota", { prompt: "First job" }), request("quota", { prompt: "Second job" })]);
  assert.equal(results.filter((item) => item.created).length, 1, JSON.stringify(results));
  assert.deepEqual(results.filter((item) => !item.created).map((item) => [item.status, item.code]), [[409, "task_limit_reached"]]);
  assert.equal((await service.list("owner", { projectId: "quota" })).items.length, 1);
});

test("OS process admission identity and quota remain isolated by both user and project", options, async () => {
  const results = await admit([request("scope-a"), request("scope-b"), request("scope-a", {}, "other-owner"), request("scope-b", {}, "other-owner")]);
  assert.equal(new Set(results.map((item) => item.id)).size, 4);
  assert.ok(results.every((item) => item.created));
  for (const userId of ["owner", "other-owner"]) for (const projectId of ["scope-a", "scope-b"]) {
    assert.equal((await service.list(userId, { projectId })).items.length, 1);
  }
});

test("a replacement OS process safely recovers a lost response, preserves pause, and frees quota only after deletion", options, async () => {
  await admit([request("response-loss")]); // The initiating caller loses this answer.
  const [retry] = await admit([request("response-loss")]);
  assert.equal(retry.created, false);
  const row = await service.get("owner", retry.id);
  await service.stop("owner", row.id, { expectedRevision: row.revision });
  const [paused, full] = await admit([request("response-loss"), request("response-loss", { prompt: "Another retained job" })]);
  assert.equal(paused.created, false);
  assert.equal(paused.state, "stopped");
  assert.equal(full.code, "task_limit_reached");
  const current = await service.get("owner", row.id);
  await service.archive("owner", row.id, { expectedRevision: current.revision });
  const [replacement] = await admit([request("response-loss", { prompt: "Another retained job" })]);
  assert.equal(replacement.created, true);
});

test("OS process source associations retain ownership and reject another project's materials before creation", options, async () => {
  const sourceId = `src_${"e".repeat(32)}`;
  await documents.put("owner", "source", sourceId, { title: "Sheet" }, { expectedRevision: 0, projectId: "materials" });
  const [made, rejected, otherProject] = await admit([request("materials", { sourceIds: [sourceId] }), request("materials", { sourceIds: [sourceId] }, "other-owner"), request("scope-b", { sourceIds: [sourceId] })]);
  assert.deepEqual(made.sourceIds, [sourceId]);
  assert.deepEqual([rejected.status, rejected.code], [404, "autopilot_material_not_found"]);
  assert.deepEqual([otherProject.status, otherProject.code], [404, "autopilot_material_not_found"]);
  assert.equal((await service.list("other-owner", { projectId: "materials" })).items.length, 0);
});
