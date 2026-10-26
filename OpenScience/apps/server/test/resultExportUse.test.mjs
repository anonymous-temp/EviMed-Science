// A result the owner takes as a package is a use of the file it is of (2026-10-25, `LearningEvidence.noteFileUse`): told after the answer, never awaited.
import assert from "node:assert/strict";
import test from "node:test";

import { createResultReuseRoutes } from "../src/resultReuseRoutes.mjs";

const versionId = `rv_${"a".repeat(64)}`;
const file = { mimeType: "application/zip", filename: "package.zip", bytes: Buffer.from("zip") };

/** @param {Record<string, any>} [extra] */
function route(extra = {}) {
  return createResultReuseRoutes({ revisions: null, exporter: { export: async () => file }, store: { ensureSessionUser: async () => ({ user: { id: "owner" } }), assertCsrf: async () => {} }, ...extra });
}
/** @param {string} url */
function request(url) { return { url, method: "GET", headers: {} }; }

test("the owner taking a result package tells the loop, after the package was sent, which result and in which project", async () => {
  const told = [];
  const sent = [];
  const response = { writeHead(status) { sent.push(["head", status]); }, end() { sent.push(["end"]); } };
  const handle = route({ onExported: async (user, projectId, id) => { told.push([user.id, projectId, id, sent.length]); } });
  assert.equal(await handle(request(`/api/results/${versionId}/export?projectId=project_1`), response), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(told, [["owner", "project_1", versionId, 2]], "after the package had been written, not before");
});

test("a failure of the loop's observation is never the owner's: the package is sent and the route answers as it did", async () => {
  const sent = [];
  const handle = route({ onExported: async () => { throw new Error("evidence down"); } });
  assert.equal(await handle(request(`/api/results/${versionId}/export?projectId=project_1`), { writeHead(status) { sent.push(status); }, end() { sent.push("end"); } }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [200, "end"]);
  // And without the observation nothing changes.
  const plain = [];
  assert.equal(await route()(request(`/api/results/${versionId}/export?projectId=p`), { writeHead(status) { plain.push(status); }, end() { plain.push("end"); } }), true);
  assert.deepEqual(plain, [200, "end"]);
});
