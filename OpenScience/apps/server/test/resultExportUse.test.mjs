// A completed export reports its immutable result receipt after the response finishes.
import assert from "node:assert/strict";
import test from "node:test";

import { createResultReuseRoutes } from "../src/resultReuseRoutes.mjs";

const versionId = `rv_${"a".repeat(64)}`;
const receipt = { versionId, digest: "b".repeat(64), path: "report.md" };
const file = { mimeType: "application/zip", filename: "package.zip", bytes: Buffer.from("zip"), useReceipt: receipt };

/** @param {Record<string, any>} [extra] */
function route(extra = {}) {
  return createResultReuseRoutes({ revisions: null, exporter: { export: async () => file }, store: { ensureSessionUser: async () => ({ user: { id: "owner" } }), assertCsrf: async () => {} }, ...extra });
}
/** @param {string} url */
function request(url) { return { url, method: "GET", headers: {} }; }

test("the owner taking a result package tells the loop, after the package was sent, which result and in which project", async () => {
  const told = [];
  const sent = [];
  const response = { writeHead(status) { sent.push(["head", status]); }, end(_bytes, callback) { sent.push(["end"]); callback(); } };
  const handle = route({ onExported: async (user, projectId, id, held) => { told.push([user.id, projectId, id, sent.length, held]); } });
  assert.equal(await handle(request(`/api/results/${versionId}/export?projectId=project_1`), response), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(told, [["owner", "project_1", versionId, 2, receipt]], "after the package had been written, not before");
});

test("a failure of the loop's observation is never the owner's: the package is sent and the route answers as it did", async () => {
  const sent = [];
  const handle = route({ onExported: async () => { throw new Error("evidence down"); } });
  assert.equal(await handle(request(`/api/results/${versionId}/export?projectId=project_1`), { writeHead(status) { sent.push(status); }, end(_bytes, callback) { sent.push("end"); callback(); } }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [200, "end"]);
  // And without the observation nothing changes.
  const plain = [];
  assert.equal(await route()(request(`/api/results/${versionId}/export?projectId=p`), { writeHead(status) { plain.push(status); }, end() { plain.push("end"); } }), true);
  assert.deepEqual(plain, [200, "end"]);
});

test("omitted result bytes and interrupted sends produce no use receipt", async () => {
  let observed = 0;
  const onExported = async () => { observed += 1; };
  const url = `/api/results/${versionId}/export?projectId=p`;
  await route({ exporter: { export: async () => ({ ...file, useReceipt: null }) }, onExported })(request(url),
    { writeHead() {}, end(_bytes, callback) { callback(); } });
  await route({ onExported })(request(url), { writeHead() {}, end() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed, 0);
});
