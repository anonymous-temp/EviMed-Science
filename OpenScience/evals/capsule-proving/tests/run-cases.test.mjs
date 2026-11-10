import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { caseIssues, checkpointsOf, loadCases, normalizeSyntheticUser, registerSet, registeredSets } from "../run/cases.mjs";

/** An invented user in the generator's own field names. @param {string} id @param {Record<string, any>} [extra] */
function invented(id, extra = {}) {
  return {
    schema: "capsule-proving-synthetic-input/1", benchmark: "synthetic-users", userId: id, split: "dev", kind: "general",
    sessions: [
      { sourceSessionId: "s001", at: "2026-01-02T03:04:05.000Z", messages: [{ role: "user", text: "Invented question about a teapot." }, { role: "assistant", text: "Invented reply." }] },
      { sourceSessionId: "s002", at: "2026-01-03T03:04:05.000Z", project: { id: "p-garden", name: "Garden plan" },
        messages: [{ role: "user", text: "Second invented turn.", at: "2026-01-03T03:05:00.000Z" }, { role: "assistant", text: "Fine." }],
        attachments: [{ afterMessage: 0, kind: "document", title: "Invented doc", text: "Doc body." }] },
    ],
    questions: [
      { qid: `${id}-q001`, afterSession: 1, asOf: "2026-01-02T05:00:00.000Z", text: "What was the teapot about?" },
      { qid: `${id}-q002`, afterSession: 2, asOf: "2026-01-04T05:00:00.000Z", text: "And the garden?", project: { id: "p-garden", name: "Garden plan" },
        materials: [{ kind: "web", title: "Invented page", text: "Page body." }], gold: "must not leak" },
    ],
    ...extra,
  };
}

async function dataDir(t, users) {
  const root = await mkdtemp(path.join(tmpdir(), "run-cases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(users)) {
    await mkdir(path.join(root, "dev", name), { recursive: true });
    await writeFile(path.join(root, "dev", name, "input.json"), typeof body === "string" ? body : JSON.stringify(body));
  }
  await mkdir(path.join(root, "dev", "no-input-here"), { recursive: true });
  return root;
}

test("a synthetic user maps to the Case shape and nothing outside it comes along", () => {
  const item = normalizeSyntheticUser(invented("X01"), { set: "synthetic-users", split: "dev", dirName: "X01" });
  assert.equal(item.caseId, "X01");
  assert.equal(item.userKey, "X01");
  assert.equal(item.set, "synthetic-users");
  assert.deepEqual(item.sessions.map((session) => session.sessionId), ["s001", "s002"]);
  assert.equal(item.sessions[0].project, null);
  assert.deepEqual(item.sessions[1].project, { id: "p-garden", name: "Garden plan" });
  assert.equal(item.sessions[1].messages[0].at, "2026-01-03T03:05:00.000Z");
  assert.equal("at" in item.sessions[0].messages[0], false);
  assert.equal(item.sessions[1].attachments?.length, 1);
  assert.deepEqual(item.questions[1].materials, [{ kind: "web", title: "Invented page", text: "Page body." }]);
  assert.equal(JSON.stringify(item).includes("must not leak"), false);
  assert.deepEqual(item.meta, { kind: "general", schema: "capsule-proving-synthetic-input/1" });
  assert.deepEqual(caseIssues(item), []);
  assert.deepEqual(checkpointsOf(item), [1, 2]);
});

test("caseIssues names what breaks the contract", () => {
  const item = normalizeSyntheticUser(invented("X02"), { set: "s", split: "dev", dirName: "X02" });
  item.questions.push({ qid: "X02-q001", afterSession: 9, asOf: "nope", text: "" });
  item.sessions[1].messages.push({ role: /** @type {any} */ ("system"), text: "x" });
  const issues = caseIssues(item).join("\n");
  assert.match(issues, /qid X02-q001 repeats/);
  assert.match(issues, /afterSession is not 0\.\.2/);
  assert.match(issues, /no ISO asOf/);
  assert.match(issues, /no text/);
  assert.match(issues, /role is not user\/assistant/);
});

test("loadCases reads <data>/<split>/<user>/input.json in name order and filters by --only", async (t) => {
  const root = await dataDir(t, { X02: invented("X02"), X01: invented("X01") });
  const all = await loadCases({ set: "synthetic-users", split: "dev", dataDir: root });
  assert.deepEqual(all.map((item) => item.caseId), ["X01", "X02"]);
  assert.deepEqual((await loadCases({ set: "synthetic-users", split: "dev", dataDir: root, only: "X02" })).map((item) => item.caseId), ["X02"]);
  assert.deepEqual((await loadCases({ set: "synthetic-users", split: "dev", dataDir: root, only: ["X01", "X02"] })).length, 2);
  await assert.rejects(loadCases({ set: "synthetic-users", split: "dev", dataDir: root, only: "X09" }), /not in synthetic-users\/dev: X09/);
  await assert.rejects(loadCases({ set: "synthetic-users", split: "sealed", dataDir: root }), /no sealed directory/);
  await assert.rejects(loadCases({ set: "nope", split: "dev", dataDir: root }), /unknown set nope/);
});

test("loadCases refuses a set whose cases break the shape", async (t) => {
  const broken = invented("X03");
  broken.questions[0].afterSession = 7;
  const root = await dataDir(t, { X03: broken });
  await assert.rejects(loadCases({ set: "synthetic-users", split: "dev", dataDir: root }), /shape problem/);
});

test("registerSet adds a loader that loadCases then uses", async () => {
  registerSet("invented-set", async ({ split, set }) => [normalizeSyntheticUser(invented("Y01"), { set, split, dirName: "Y01" })]);
  assert.ok(registeredSets().includes("invented-set"));
  assert.ok(registeredSets().includes("synthetic-users"));
  const cases = await loadCases({ set: "invented-set", split: "dev", dataDir: "/nowhere" });
  assert.deepEqual(cases.map((item) => [item.set, item.caseId]), [["invented-set", "Y01"]]);
  assert.throws(() => registerSet("Bad Name", async () => []), /set name/);
});
