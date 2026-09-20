// The memory page's search box, over HTTP.
//
// It had none. The box was a `toLowerCase().includes` over the notes already
// loaded into the page, so 「阿司匹林」 found a memory only if its row happened
// to be on screen — and 「做过的研究」, which is what a person searching a drug
// name is usually looking for, was never on screen at all. Keyword comes from
// the store over everything the account holds; the recall index only nominates,
// and every nomination is resolved back to the stored record.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createMemoryRoutes } from "../src/memoryRoutes.mjs";
import { sendError } from "../src/security.mjs";

const user = { id: "usr_1" };
const project = { id: "prj_1" };

const record = (patch = {}) => ({
  id: "rec_1", scope: "user", scopeId: "", kind: "profile", key: "profile.who",
  value: "临床药师，主攻抗凝", summary: "临床药师，主攻抗凝", origin: "explicit", status: "active",
  confidence: 1, importance: 0.8, sensitive: false, evidenceCount: 1, version: 1,
  createdAt: null, updatedAt: null, lastConfirmedAt: null, expiresAt: null,
  provenance: { basis: "stated", observations: 1, runs: 1, conversations: 1 },
  evidence: [], revisions: [], ...patch,
});

/** A memory store with only what the search route reads. */
function storeDouble({ found = [], titles = {}, usage = {}, byId = {} } = {}) {
  const calls = { searchRecords: [], getRecord: [], recordUsage: [] };
  return {
    calls,
    configured: true,
    async searchRecords(_userId, input) { calls.searchRecords.push(input); return { items: found, titles }; },
    async getRecord(_userId, id) {
      calls.getRecord.push(id);
      if (!byId[id]) throw Object.assign(new Error("not found"), { status: 404, code: "memory_not_found" });
      return byId[id];
    },
    async recordUsage(_userId, ids) { calls.recordUsage.push(ids); return usage; },
    async profile() { return { records: found, groups: {}, activeCount: found.length, pendingCount: 0, episodeCount: 0 }; },
  };
}

async function serve(t, { researchMemory, memorySubstrate = null }) {
  const routes = createMemoryRoutes({
    config: { memoryEnabled: true, maxJsonBytes: 64 * 1024 },
    researchMemory, memorySubstrate, feedbackEvents: null,
    store: { async ensureUser() { return { user }; } },
    context: async () => ({ user, project }),
    audit: async () => {},
    recordFeedback: async () => {},
    decodeRouteComponent: (value) => value,
  });
  const server = createServer((req, res) => {
    routes(req, res).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    }, (error) => sendError(res, error));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = /** @type {any} */ (server.address());
  return (path) => fetch(`http://127.0.0.1:${port}${path}`);
}

test("the search is keyword over the whole account, with the index's hits unioned in and resolved", async (t) => {
  const indexed = record({ id: "rec_far", kind: "preference", summary: "报告先给 GRADE" });
  const researchMemory = storeDouble({
    found: [record({ id: "rec_near", summary: "阿司匹林一级预防的适应症" })],
    titles: { ses_9: "阿司匹林一级预防" },
    usage: { rec_near: { count: 7, lastUsedAt: "2026-09-18T00:00:00.000Z" } },
    byId: { rec_far: indexed },
  });
  const memorySubstrate = {
    calls: [],
    async recall(_userId, query, scope) {
      this.calls.push({ query, scope });
      return [{ id: "record:rec_far", content: "报告先给 GRADE" }, { id: "record:rec_near", content: "already found" }];
    },
  };
  const request = await serve(t, { researchMemory, memorySubstrate });
  const answer = await (await request("/api/memory/search?q=%E9%98%BF%E5%8F%B8%E5%8C%B9%E6%9E%97")).json();

  assert.deepEqual(answer.data.items.map((item) => item.id), ["rec_near", "rec_far"], "keyword first, then what only the index found");
  assert.equal(answer.data.semantic, 1, "the one the keyword pass had not already found");
  assert.deepEqual(researchMemory.calls.searchRecords, [{ query: "阿司匹林", projectId: "prj_1" }]);
  assert.deepEqual(researchMemory.calls.getRecord, ["rec_far"], "a nomination is resolved back to the stored record");
  // A researcher looking for a memory is not the platform using one, so the
  // search's own pass through the recall port does not move 「用过 N 次」.
  assert.equal(memorySubstrate.calls[0].scope.countUsage, false);
  assert.equal(answer.data.conversations.ses_9, "阿司匹林一级预防", "so the page can say 「来自 9月12日《…》」");
  assert.deepEqual(answer.data.usage.rec_near, { count: 7, lastUsedAt: "2026-09-18T00:00:00.000Z" });
});

test("an index that is down costs the search its semantic half and nothing else", async (t) => {
  const researchMemory = storeDouble({ found: [record({ summary: "阿司匹林一级预防的适应症" })] });
  const memorySubstrate = { async recall() { throw new Error("index unreachable"); } };
  const request = await serve(t, { researchMemory, memorySubstrate });
  const answer = await (await request("/api/memory/search?q=%E9%98%BF%E5%8F%B8%E5%8C%B9%E6%9E%97")).json();
  assert.deepEqual(answer.data.items.map((item) => item.id), ["rec_1"]);
  assert.equal(answer.data.semantic, 0);
});

test("a nomination the store no longer holds is dropped rather than guessed at", async (t) => {
  const researchMemory = storeDouble({ found: [], byId: {} });
  const memorySubstrate = { async recall() { return [{ id: "record:rec_gone", content: "x" }, { id: "not-a-record", content: "y" }]; } };
  const request = await serve(t, { researchMemory, memorySubstrate });
  const answer = await (await request("/api/memory/search?q=x")).json();
  assert.deepEqual(answer.data.items, []);
  assert.equal(answer.data.semantic, 0);
});

test("an empty query asks the index nothing and answers from the store alone", async (t) => {
  const researchMemory = storeDouble({ found: [record()] });
  const memorySubstrate = { async recall() { throw new Error("an empty query must not reach the index"); } };
  const request = await serve(t, { researchMemory, memorySubstrate });
  const answer = await (await request("/api/memory/search?q=%20%20")).json();
  assert.deepEqual(answer.data.items.map((item) => item.id), ["rec_1"]);
  assert.equal(answer.data.query, "");
});

test("the note routes are gone, and the page's own read carries what its rows need", async (t) => {
  const researchMemory = storeDouble({ found: [record()], titles: { ses_9: "阿司匹林一级预防" }, usage: { rec_1: { count: 2, lastUsedAt: null } } });
  const request = await serve(t, { researchMemory });
  for (const gone of ["/api/memory/memos", "/api/memory/memos/note_1"]) {
    assert.equal((await request(gone)).status, 404, `${gone} is not a route any more`);
  }
  const profile = await (await request("/api/memory/profile")).json();
  assert.deepEqual(profile.data.usage.rec_1, { count: 2, lastUsedAt: null });
  assert.ok("conversations" in profile.data);
});
