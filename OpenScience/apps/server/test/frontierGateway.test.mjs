// The runtime's way into 「前沿动态」 (`frontier_search`), modelled on the
// knowledge-base gateway's tests: the token names the account, the request is
// an allowlist, off says so by name, and the answer is the page's own list cut
// to the tool's contract — with the page's search of 精选 narrowed back to the
// picks.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { FRONTIER_GATEWAY_PATH, createFrontierGatewayHandler, frontierGatewayProviderUrl } from "../src/frontierGateway.mjs";

const runtimeManager = {
  assertActiveModelGatewayToken(token) {
    if (token !== "runtime-token") throw new Error("inactive");
    return { userId: "user-1", projectId: "project-1" };
  },
};

/** A page item as `FrontierService.listItems` serves it, reader state and all. */
function pageItem(overrides = {}) {
  return {
    id: "t0123456789abcdef", title: "司美格鲁肽降低射血分数保留心衰患者的心衰事件", titleRaw: "Semaglutide in HFpEF", titleZh: "司美格鲁肽降低射血分数保留心衰患者的心衰事件",
    summary: "一项随机对照试验……", reason: "改变 HFpEF 的治疗选择", lang: "en", lane: "evidence", laneLabel: "临床证据",
    sourceType: "journal", sourceTypeLabel: "期刊", evidenceType: "rct", evidenceTypeLabel: "RCT", evidenceBasis: "pubmed-types",
    specialties: [{ key: "cardiology", label: "心血管" }], flags: [{ key: "preprint", label: "未经同行评议" }],
    entities: { drugs: ["semaglutide"], trials: [], orgs: [], diseases: [] }, source: { id: "nejm", name: "NEJM", homepage: "https://www.nejm.org/" },
    url: "https://www.nejm.org/doi/full/10.1056/NEJMoa0000001", doi: "10.1056/NEJMoa0000001", pmid: "40000001", registryIds: ["NCT04788511"],
    publishedAt: "2026-09-20T00:00:00.000Z", datePrecision: "day", timelineAt: "2026-09-21T02:13:00.000Z", visibleAt: "2026-09-21T02:13:00.000Z",
    selected: true, selectedRule: "threshold", safetyAlert: false, verification: "passed",
    levels: { authority: "high", impact: "high", novelty: "medium", relevance: null }, openAccess: null,
    alsoReportedBy: [{ sourceId: "lancet", sourceName: "The Lancet", url: "https://www.thelancet.com/x" }], event: { id: "e1", title: "事件" },
    state: { starred: true, hidden: false, read: true },
    ...overrides,
  };
}

/** A service that answers pages from a script and records what it was asked. */
function scriptedService({ pages = [{ items: [pageItem()], nextCursor: null, mode: "list" }], allows = () => true } = {}) {
  const calls = [];
  return {
    calls,
    allows,
    async listItems(user, params) {
      calls.push({ user, params: Object.fromEntries(params) });
      const page = pages[Math.min(calls.length - 1, pages.length - 1)];
      if (page instanceof Error) throw page;
      return { status: 200, etag: "W/\"0.0.x\"", body: { version: "7", ...page } };
    },
  };
}

async function withGateway(t, { config = {}, service = scriptedService(), budgetMs, report } = {}) {
  const failures = [];
  const handler = createFrontierGatewayHandler({ frontierEnabled: true, ...config }, runtimeManager,
    { service, ...(budgetMs ? { budgetMs } : {}), ...(report ? { report } : {}) });
  const server = createServer((req, res) => { void handler(req, res, (failure) => failures.push(failure)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const call = async (body, { token = "runtime-token", method = "POST", path = FRONTIER_GATEWAY_PATH } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { call, failures, service };
}

test("the runtime's own token names the account, and the answer is the page's own list read for it", async (t) => {
  const { call, service } = await withGateway(t);
  const answer = await call({ q: "  GLP-1   心衰 ", lane: "evidence", specialty: "cardiology", window: "7d", mode: "all", limit: 3 });
  assert.equal(answer.status, 200);
  assert.deepEqual(service.calls[0], {
    user: { id: "user-1" },
    params: { view: "all", window: "7d", limit: "3", lane: "evidence", specialty: "cardiology", q: "GLP-1 心衰" },
  });
  assert.deepEqual(answer.body.data.query, { q: "GLP-1 心衰", lane: "evidence", specialty: "cardiology", window: "7d", mode: "all", limit: 3 });
  assert.equal(answer.body.data.searchMode, "list");
  assert.equal(answer.body.data.more, false);
  assert.ok(Number.isFinite(Date.parse(answer.body.data.asOf)));
  assert.equal("unselectedSkipped" in answer.body.data, false, "only a selected search drops anything");

  const defaults = await call({});
  assert.equal(defaults.status, 200);
  assert.deepEqual(service.calls[1].params, { view: "selected", window: "30d", limit: "8" },
    "no query lists the newest picks of the last thirty days, eight of them");
  assert.deepEqual(defaults.body.data.query, { q: null, lane: null, specialty: null, window: "30d", mode: "selected", limit: 8 });
});

test("an item leaves as a lead: titles, digest, source, evidence, times, the original and its ids, flags — never the reader's marks", async (t) => {
  const { call } = await withGateway(t, {
    service: scriptedService({ pages: [{ items: [pageItem(), pageItem({ url: "javascript:alert(1)", titleZh: null, title: "Raw only", titleRaw: "Raw only", summary: null, reason: "  ", flags: [], safetyAlert: true })], nextCursor: "c2", mode: "list" }] }),
  });
  const { body } = await call({ mode: "all", limit: 2 });
  const [lead, bare] = body.data.items;
  assert.deepEqual(lead, {
    title: "司美格鲁肽降低射血分数保留心衰患者的心衰事件", titleRaw: "Semaglutide in HFpEF", summary: "一项随机对照试验……", reason: "改变 HFpEF 的治疗选择",
    source: { name: "NEJM", type: "journal", typeLabel: "期刊" }, evidenceType: "rct", evidenceTypeLabel: "RCT",
    publishedAt: "2026-09-20T00:00:00.000Z", datePrecision: "day", visibleAt: "2026-09-21T02:13:00.000Z",
    url: "https://www.nejm.org/doi/full/10.1056/NEJMoa0000001", doi: "10.1056/NEJMoa0000001", pmid: "40000001", registryIds: ["NCT04788511"],
    flags: [{ key: "preprint", label: "未经同行评议" }], selected: true, safetyAlert: false,
  });
  for (const field of ["state", "levels", "entities", "event", "alsoReportedBy", "openAccess", "id", "specialties"]) {
    assert.equal(field in lead, false, `${field} stays in the control plane`);
  }
  assert.equal(bare.url, null, "an address a reader cannot open is not handed on as the original");
  assert.equal(bare.title, "Raw only");
  assert.equal(bare.reason, null, "blank text reads as absent");
  assert.equal(bare.safetyAlert, true);
  assert.equal(body.data.more, true, "a cursor left over means there is more");
});

test("a selected search drops what was not selected, reads at most three pages of the ranking, and counts what it dropped", async (t) => {
  const picked = (n) => pageItem({ titleRaw: `picked ${n}`, title: `picked ${n}`, selected: true });
  const other = (n) => pageItem({ titleRaw: `other ${n}`, title: `other ${n}`, selected: false });
  const pages = [
    { items: [other(1), picked(1), other(2)], nextCursor: "c2", mode: "keyword" },
    { items: [other(3), picked(2)], nextCursor: "c3", mode: "keyword" },
    { items: [other(4)], nextCursor: "c4", mode: "keyword" },
    { items: [picked(99)], nextCursor: null, mode: "keyword" },
  ];
  const { call, service } = await withGateway(t, { service: scriptedService({ pages }) });
  const { body } = await call({ q: "GLP-1" });
  assert.deepEqual(body.data.items.map((item) => item.titleRaw), ["picked 1", "picked 2"]);
  assert.equal(body.data.unselectedSkipped, 4);
  assert.equal(body.data.more, true, "the ranking was not read to its end");
  assert.equal(body.data.searchMode, "keyword");
  assert.equal(service.calls.length, 3, "three pages of fifty are the whole fused ranking");
  assert.deepEqual(service.calls.map((entry) => [entry.params.view, entry.params.limit, entry.params.cursor ?? null]),
    [["selected", "50", null], ["selected", "50", "c2"], ["selected", "50", "c3"]]);

  const enough = await withGateway(t, { service: scriptedService({ pages: [{ items: [picked(1), other(1), picked(2), picked(3)], nextCursor: "c2", mode: "hybrid" }] }) });
  const full = await enough.call({ q: "GLP-1", limit: 2 });
  assert.deepEqual(full.body.data.items.map((item) => item.titleRaw), ["picked 1", "picked 2"]);
  assert.equal(full.body.data.more, true);
  assert.equal(enough.service.calls.length, 1, "a full answer stops reading");

  const all = await withGateway(t, { service: scriptedService({ pages: [{ items: [other(1), picked(1)], nextCursor: null, mode: "keyword" }] }) });
  const both = await all.call({ q: "GLP-1", mode: "all" });
  assert.deepEqual(both.body.data.items.map((item) => [item.titleRaw, item.selected]), [["other 1", false], ["picked 1", true]]);
  assert.equal("unselectedSkipped" in both.body.data, false);
  assert.equal(all.service.calls[0].params.limit, "8");
});

test("a list that moves between two pages keeps what was already read", async (t) => {
  const moved = Object.assign(new Error("The list changed"), { code: "invalid_cursor" });
  const { call } = await withGateway(t, { service: scriptedService({ pages: [
    { items: [pageItem({ titleRaw: "kept", selected: true })], nextCursor: "c2", mode: "keyword" }, moved,
  ] }) });
  const answer = await call({ q: "GLP-1" });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.data.items.map((item) => item.titleRaw), ["kept"]);
  assert.equal(answer.body.data.more, true);
});

test("no token, a stale token, another route or another method is refused before the service is asked", async (t) => {
  const { call, service } = await withGateway(t);
  assert.equal((await call({}, { token: "" })).body.code, "frontier_search_gateway_token_missing");
  assert.equal((await call({}, { token: "someone-elses" })).body.code, "frontier_search_gateway_token_invalid");
  assert.equal((await call({}, { path: `${FRONTIER_GATEWAY_PATH}/x` })).status, 404);
  assert.equal((await call(null, { method: "GET" })).status, 404);
  assert.equal(service.calls.length, 0);
});

test("switched off, unbuilt, or not open to this account, it says frontier_disabled and nothing else", async (t) => {
  const off = await withGateway(t, { config: { frontierEnabled: false }, service: { allows() { throw new Error("never"); }, listItems() { throw new Error("never"); } } });
  const answer = await off.call({ q: "q" });
  assert.equal(answer.status, 503);
  assert.equal(answer.body.code, "frontier_disabled");
  assert.match(answer.body.error, /switched off/);
  assert.deepEqual(off.failures, [{ code: "frontier_disabled", status: 503 }]);
  const unbuilt = await withGateway(t, { service: null });
  assert.equal((await unbuilt.call({})).body.code, "frontier_disabled");
  const closed = scriptedService({ allows: (user) => user.id !== "user-1" });
  const operatorsOnly = await withGateway(t, { service: closed });
  const refused = await operatorsOnly.call({});
  assert.equal(refused.body.code, "frontier_disabled");
  assert.match(refused.body.error, /not open to this account/);
  assert.equal(closed.calls.length, 0, "an account outside the audience never reads the list");
});

test("a request it cannot parse is named, field by field", async (t) => {
  const { call, service } = await withGateway(t);
  for (const [body, code] of [
    ["not json", "frontier_search_request_invalid"],
    [[], "frontier_search_request_invalid"],
    [{ q: "q", view: "all" }, "frontier_search_request_invalid"],
    [{ q: "" }, "frontier_search_query_invalid"],
    [{ q: "   " }, "frontier_search_query_invalid"],
    [{ q: 42 }, "frontier_search_query_invalid"],
    [{ q: "x".repeat(201) }, "frontier_search_query_invalid"],
    [{ q: "a\u0000b" }, "frontier_search_query_invalid"],
    [{ lane: "mixed" }, "frontier_search_lane_invalid"],
    [{ lane: "gossip" }, "frontier_search_lane_invalid"],
    [{ specialty: "astrology" }, "frontier_search_specialty_invalid"],
    [{ window: "90d" }, "frontier_search_window_invalid"],
    [{ mode: "hot" }, "frontier_search_mode_invalid"],
    [{ limit: 0 }, "frontier_search_limit_invalid"],
    [{ limit: 21 }, "frontier_search_limit_invalid"],
    [{ limit: 1.5 }, "frontier_search_limit_invalid"],
    [{ limit: true }, "frontier_search_limit_invalid"],
  ]) {
    const answer = await call(body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.code, code, JSON.stringify(body));
  }
  assert.equal(service.calls.length, 0);
  const tooLarge = await call(JSON.stringify({ q: "x".repeat(20_000) }));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.code, "frontier_search_request_too_large");
});

test("a slow or failing service is a named answer that says what the run can do instead, and no internal detail", async (t) => {
  const slow = await withGateway(t, { budgetMs: 200, service: { allows: () => true, listItems: () => new Promise(() => {}) } });
  const timedOut = await slow.call({ q: "q" });
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.body.code, "frontier_search_timeout");
  const reported = [];
  const broken = await withGateway(t, {
    report: (code) => reported.push(code),
    service: { allows: () => true, async listItems() { throw Object.assign(new Error("connection to 10.0.0.5 refused: internal detail"), { code: "ECONNREFUSED" }); } },
  });
  const failed = await broken.call({ q: "q" });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "frontier_search_unavailable");
  assert.match(failed.body.error, /literature, guideline and regulatory tools/);
  assert.doesNotMatch(JSON.stringify(failed.body), /10\.0\.0\.5|internal detail|ECONNREFUSED/, "an internal error never reaches the runtime");
  assert.deepEqual(reported, ["ECONNREFUSED"], "the operator hears the underlying code, never its message");
  assert.deepEqual(broken.failures, [{ code: "frontier_search_unavailable", status: 503 }]);
});

test("a runaway loop is bounded per project, not per request", async (t) => {
  const { call } = await withGateway(t);
  let last;
  for (let attempt = 0; attempt < 61; attempt += 1) last = await call({});
  assert.equal(last.status, 429);
  assert.equal(last.body.code, "frontier_search_rate_limited");
});

test("the runtime learns the route only when the module is on, at the model gateway's own address", () => {
  const model = "http://open-science-web:8787/internal/model/v1";
  assert.equal(frontierGatewayProviderUrl({ frontierEnabled: true, modelGatewayInternalUrl: model }), "http://open-science-web:8787/internal/frontier/v1/search");
  assert.equal(frontierGatewayProviderUrl({ frontierEnabled: true, modelGatewayInternalUrl: `${model}?x=1#y` }), "http://open-science-web:8787/internal/frontier/v1/search");
  assert.equal(frontierGatewayProviderUrl({ frontierEnabled: false, modelGatewayInternalUrl: model }), "");
  assert.equal(frontierGatewayProviderUrl({ modelGatewayInternalUrl: model }), "");
  assert.equal(frontierGatewayProviderUrl({ frontierEnabled: true, modelGatewayInternalUrl: "http://user:fake@host/internal/model/v1" }), "");
  assert.equal(frontierGatewayProviderUrl({ frontierEnabled: true, modelGatewayInternalUrl: "not a url" }), "");
  assert.equal(frontierGatewayProviderUrl({ frontierEnabled: true, modelGatewayInternalUrl: "file:///etc/passwd" }), "");
});
