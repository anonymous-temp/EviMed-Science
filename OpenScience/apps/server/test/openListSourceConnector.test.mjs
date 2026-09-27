import assert from "node:assert/strict";
import test from "node:test";
import { OpenListSourceConnector } from "../src/openListSourceConnector.mjs";

test("OpenList account namespaces cannot overlap or escape their configured root", async () => {
  const calls = [];
  const client = {
    list: async (selected) => { calls.push(selected); return { entries: [{ path: `${selected}/paper.pdf`, name: "paper.pdf" }], nextCursor: null }; },
    stat: async (selected) => ({ path: selected, name: "paper.pdf", entryType: "file" }),
    read: async (selected) => Buffer.from(selected),
  };
  const connector = new OpenListSourceConnector(client, { tenantRoot: "/tenants" });
  const page = await connector.list("user-one", "/folder");
  assert.equal(calls[0], "/tenants/user-one/folder");
  assert.equal(page.entries[0].path, "/folder/paper.pdf");
  assert.equal((await connector.stat("user-two", "/paper.pdf")).path, "/paper.pdf");
  await assert.rejects(() => connector.list("user-one", "/../user-two"), { code: "openlist_path_invalid" });
});

/** A client whose tenant-root listing answers from `answers` in turn, recording each call. */
function probedClient(answers) {
  const calls = [];
  return {
    calls,
    list: async (selected, options) => {
      calls.push({ selected, options });
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}
const refusal = (code) => Object.assign(new Error(code), { code });

test("the storage probe lists the tenant root, authenticated and one entry deep", async () => {
  // Audit I3-4: readiness asked `/ping`, which OpenList answers with no
  // credential and no storage. The probe is the browse route's own call.
  const client = probedClient([{ entries: [{ path: "/tenants/u1", name: "u1", entryType: "dir" }], total: 3, nextCursor: "2" }]);
  const connector = new OpenListSourceConnector(client, { tenantRoot: "/tenants", probeTimeoutMs: 2_000 });
  assert.deepEqual(await connector.storageStatus(), { storage: "mounted", namespaces: 3 });
  assert.deepEqual(client.calls, [{ selected: "/tenants", options: { page: 1, perPage: 1, timeoutMs: 2_000 } }]);
});

test("nothing under the tenant root, or no storage covering it, is missing — not an error", async () => {
  const empty = new OpenListSourceConnector(probedClient([{ entries: [], total: 0, nextCursor: null }]));
  assert.deepEqual(await empty.storageStatus(), { storage: "missing", namespaces: 0 });
  const unmounted = new OpenListSourceConnector(probedClient([refusal("openlist_storage_missing")]));
  assert.deepEqual(await unmounted.storageStatus(), { storage: "missing", namespaces: 0 });
  // What the platform owns is thrown with its code: unreachable, a rejected credential.
  const down = new OpenListSourceConnector(probedClient([refusal("openlist_unavailable")]));
  await assert.rejects(down.storageStatus(), { code: "openlist_unavailable" });
  const rejected = new OpenListSourceConnector(probedClient([refusal("openlist_credential_rejected")]));
  await assert.rejects(rejected.storageStatus(), { code: "openlist_credential_rejected" });
});

test("one probe answers every reader for its window, failures included, and is counted", async () => {
  let clock = 1_000_000;
  const client = probedClient([refusal("openlist_timeout"), { entries: [], total: 0, nextCursor: null },
    { entries: [{ path: "/tenants/u1", name: "u1", entryType: "dir" }], total: 1, nextCursor: null }]);
  const connector = new OpenListSourceConnector(client, { probeCacheMs: 60_000, now: () => clock });
  // Concurrent readers share one request.
  const first = await Promise.allSettled([connector.storageStatus(), connector.storageStatus(), connector.storageStatus()]);
  assert.deepEqual(first.map((item) => item.status), ["rejected", "rejected", "rejected"]);
  assert.equal(client.calls.length, 1);
  clock += 59_999;
  await assert.rejects(connector.storageStatus(), { code: "openlist_timeout" }, "a failure is remembered for the window too");
  assert.equal(client.calls.length, 1);
  clock += 1;
  assert.deepEqual(await connector.storageStatus(), { storage: "missing", namespaces: 0 });
  assert.equal(client.calls.length, 2);
  assert.deepEqual(Object.fromEntries(connector.probeCounts), { openlist_timeout: 1, missing: 1 });
});

test("a stale-tolerant reader never waits once anything is known", async () => {
  // `/api/me` renders the shell: it takes the last answer and the refresh
  // happens behind it. Only a process that has never probed waits, once.
  let clock = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const client = {
    list: async () => {
      calls.push(clock);
      if (calls.length === 1) return { entries: [], total: 0, nextCursor: null };
      await gate;
      return { entries: [{ path: "/tenants/u1", name: "u1", entryType: "dir" }], total: 1, nextCursor: null };
    },
  };
  const connector = new OpenListSourceConnector(client, { probeCacheMs: 1_000, now: () => clock });
  assert.deepEqual(await connector.storageStatus({ allowStale: true }), { storage: "missing", namespaces: 0 }, "the first probe is waited for");
  clock = 5_000;
  assert.deepEqual(await connector.storageStatus({ allowStale: true }), { storage: "missing", namespaces: 0 }, "the stale answer, at once");
  assert.equal(calls.length, 2, "and a refresh started behind it");
  release();
  await connector.probing;
  assert.deepEqual(await connector.storageStatus({ allowStale: true }), { storage: "mounted", namespaces: 1 });
  assert.equal(calls.length, 2);
});

test("probe limits are refused when they cannot bound anything", () => {
  const client = probedClient([]);
  for (const options of [{ probeTimeoutMs: 0 }, { probeTimeoutMs: 60_000 }, { probeCacheMs: -1 }, { probeCacheMs: Number.NaN }]) {
    assert.throws(() => new OpenListSourceConnector(client, options), TypeError, JSON.stringify(options));
  }
});
