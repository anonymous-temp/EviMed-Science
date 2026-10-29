import assert from "node:assert/strict";
import test from "node:test";
import { getOpenListStatus } from "../src/openListStatus.mjs";

test("OpenList status requires the caller's namespace and never provisions storage", async () => {
  assert.deepEqual(await getOpenListStatus(null, "u1"), { state: "unconfigured" });
  assert.deepEqual(await getOpenListStatus({ storageStatus: async () => ({ storage: "missing" }) }, "u1"), { state: "storage_missing" });
  assert.deepEqual(await getOpenListStatus({ storageStatus: async () => ({ storage: "mounted" }) }, "u1"), { state: "unavailable" });
  const connector = { storageStatus: async () => ({ storage: "mounted" }), list: async (userId, path, options) => {
    assert.equal(userId, "u1"); assert.equal(path, "/"); assert.equal(options.perPage, 1); return { entries: [] };
  } };
  assert.deepEqual(await getOpenListStatus(connector, "u1"), { state: "ready" });
});

for (const [error, state] of [
  [{ code: "openlist_storage_missing" }, "storage_missing"],
  [{ code: "openlist_credential_rejected" }, "permission_denied"],
  [{ status: 403 }, "permission_denied"],
  [{ code: "openlist_request_failed", message: "OpenList returned HTTP 401." }, "permission_denied"],
  [{ code: "openlist_timeout", message: "secret upstream URL" }, "unavailable"],
]) test(`OpenList sanitizes ${error.code ?? error.status}`, async () => {
  for (const phase of ["storageStatus", "list"]) {
    const connector = { storageStatus: async () => ({ storage: "mounted" }), list: async () => ({ entries: [] }),
      [phase]: async () => { throw error; } };
    assert.deepEqual(await getOpenListStatus(connector, "u1"), { state });
  }
});
