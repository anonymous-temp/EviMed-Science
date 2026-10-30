import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryStore, PostgresStore } from "../src/store.mjs";
import { EvimedAuthService } from "../src/evimedAuthService.mjs";
import { EvimedSearchService, evimedSearchFailureDetail } from "../src/evimedSearchService.mjs";
import { createEvimedSearchRoutes } from "../src/evimedSearchRoutes.mjs";
import { openEvimedSessionCredential, sealEvimedSessionCredential, sealEvimedSearchReference } from "../src/evimedSessionCredentials.mjs";
import { sendJson } from "../src/security.mjs";

const credential = "synthetic-private-search-account-token-7cde92";
const secret = "synthetic-stable-search-encryption-secret-725c14";
const user = { id: "evimed_search_reader", name: "Search Reader", authType: "evimed", tenantId: "evimed_search_reader" };
function configOf(dataDir, extra = {}) {
  return { dataDir, usersFile: path.join(dataDir, "users.json"), sessionsFile: path.join(dataDir, "sessions.json"),
    sessionCookieName: "os_session", sessionTtlMs: 60_000, devAuth: false, production: false,
    modelGatewaySigningSecret: secret, evimedAuthEnabled: true,
    evimedAccountApiBaseUrl: "https://accounts.evimed.test/api-evimed",
    evimedUserIntrospectUrl: "https://accounts.evimed.test/api-evimed/system/profile",
    evimedIntrospectTimeoutMs: 1000, evimedIntrospectCacheTtlMs: 0, ...extra };
}
function responseHeaders() {
  const headers = new Map();
  return { getHeader: name => headers.get(name), setHeader: (name, value) => headers.set(name, value), headers };
}
async function signIn(store, value = credential) {
  const res = responseHeaders();
  const session = await store.createSession(user, { headers: { host: "localhost" }, socket: {} }, res, { evimedCredential: value });
  const cookie = String(res.headers.get("Set-Cookie")).split(";", 1)[0];
  return { cookie, session, req: { method: "POST", headers: { cookie, "x-open-science-csrf": session.csrfToken } } };
}
async function fixture(body, extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "evimed-search-"));
  try {
    const config = configOf(dir, extra);
    const store = new InMemoryStore(config);
    await store.upsertEvimedUser(user.id, user.name, "synthetic-subject");
    const signed = await signIn(store);
    await body({ dir, config, store, signed });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const json = (data, code = 200, status = 200) => new Response(JSON.stringify({ code, data }), { status });
function provider() {
  const calls = [];
  let reply = null;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), init, body: init.body ? JSON.parse(init.body) : null });
    if (reply) return reply(calls.at(-1));
    if (parsed.pathname.endsWith("/screen")) return json({ screenId: "synthetic-search-context" });
    return json({ total: 9, list: [{ id: "paper-1", title: "<b>Study</b>", genericNames: "<b>Study</b>", summary: "Evidence", year: 2026, authorAndStatus: [{ name: "Reader" }],
      journal: "Journal", doi: "10.1234/test", url: "https://journal.example/study", pdfName: "label.pdf", source: "FDA" }] });
  };
  return { calls, fetchImpl, answerWith: next => { reply = next; } };
}

test("session credential ciphertext survives file restart and stays bound to one user, session and expiry", async () => {
  await fixture(async ({ dir, config, store, signed }) => {
    const other = await signIn(store, `${credential}-other`);
    const persisted = await readFile(config.sessionsFile, "utf8");
    assert.equal(persisted.includes(credential), false);
    assert.equal(JSON.stringify(signed.session).includes("evimedCredential"), false);
    const restarted = new InMemoryStore(config);
    assert.equal((await restarted.evimedSearchSession(signed.req, responseHeaders())).credential, credential);
    await restarted.clearEvimedSearchCredential(signed.req);
    assert.equal((await restarted.evimedSearchSession(signed.req, responseHeaders())).credential, null);
    assert.equal((await restarted.evimedSearchSession(other.req, responseHeaders())).credential, `${credential}-other`);
    await restarted.logout(other.req);
    await assert.rejects(restarted.evimedSearchSession(other.req, responseHeaders()), { code: "unauthorized" });
    const expiresAt = Date.now() + 10_000;
    const packed = sealEvimedSessionCredential(config, "session-a", user.id, expiresAt, credential);
    assert.equal(openEvimedSessionCredential(config, "session-a", user.id, expiresAt, packed), credential);
    for (const [binding, owner, expiry] of [["session-b", user.id, expiresAt], ["session-a", "another", expiresAt], ["session-a", user.id, expiresAt + 1]]) {
      assert.equal(openEvimedSessionCredential(config, binding, owner, expiry, packed), null);
    }
    assert.equal(openEvimedSessionCredential({ ...config, modelGatewaySigningSecret: `${secret}-rotated` }, "session-a", user.id, expiresAt, packed), null);
    assert.equal((await readFile(path.join(dir, "users.json"), "utf8")).includes(credential), false);
  });
});

test("Postgres session ciphertext survives a new store instance and is removed with that session", async () => {
  const rows = new Map();
  const database = { query: async (sql, values) => {
    const id = values[0];
    if (sql.includes("INSERT INTO")) {
      rows.set(id, { user_id: values[1], csrf_token: values[2], created_at: new Date(values[3]), expires_at: new Date(values[4]), evimed_search_credential: values[5] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM")) return { rows: [], rowCount: rows.delete(id) ? 1 : 0 };
    if (sql.includes("UPDATE")) { if (rows.has(id)) rows.get(id).evimed_search_credential = null; return { rows: [], rowCount: 1 }; }
    const row = rows.get(id);
    const valid = row && row.expires_at.getTime() > Date.now() && (!sql.includes("user_id = $2") || row.user_id === values[1]);
    return { rows: valid ? [{ ...row, id: user.id, name: user.name, auth_type: "evimed" }] : [], rowCount: valid ? 1 : 0 };
  } };
  const config = configOf("/tmp/synthetic-search-store");
  const makeStore = () => Object.assign(Object.create(PostgresStore.prototype), { config, database });
  const store = makeStore();
  const first = await signIn(store);
  const second = await signIn(store, `${credential}-second`);
  assert.equal(JSON.stringify([...rows.values()]).includes(credential), false);
  const restarted = makeStore();
  assert.equal((await restarted.evimedSearchSession(first.req, responseHeaders())).credential, credential);
  await restarted.clearEvimedSearchCredential(first.req);
  assert.equal((await restarted.evimedSearchSession(first.req, responseHeaders())).credential, null);
  assert.equal((await restarted.evimedSearchSession(second.req, responseHeaders())).credential, `${credential}-second`);
  await restarted.logout(second.req);
  await assert.rejects(restarted.evimedSearchSession(second.req, responseHeaders()), { code: "unauthorized" });
});

test("introspection success preserves only the current session ciphertext and missing encryption does not prevent login", async () => {
  await fixture(async ({ config, store, signed }) => {
    const auth = new EvimedAuthService(config, store, { fetchImpl: async () => json({ userId: "synthetic-subject", nickName: "Reader" }) });
    const res = responseHeaders();
    const result = await auth.createSession({ headers: {}, socket: {} }, res, { token: credential });
    assert.equal(JSON.stringify(result).includes(credential), false);
    const cookie = String(res.headers.get("Set-Cookie")).split(";", 1)[0];
    assert.equal((await store.evimedSearchSession({ headers: { cookie } }, responseHeaders())).credential, credential);
    const unavailable = new EvimedSearchService({ ...config, modelGatewaySigningSecret: "" }, store);
    assert.equal(unavailable.enabled, false);
    const oldSession = await store.createSession(user, { headers: {}, socket: {} }, responseHeaders());
    assert.ok(oldSession.csrfToken);
    assert.ok((await store.ensureSessionUser(signed.req, responseHeaders())).user);
  });
  await fixture(async ({ config, store, signed }) => {
    assert.equal((await store.evimedSearchSession(signed.req, responseHeaders())).credential, null);
    assert.ok(signed.session.csrfToken);
    assert.equal((await readFile(config.sessionsFile, "utf8")).includes(credential), false);
  }, { modelGatewaySigningSecret: "" });
});

test("four searches use the Vue screen and category contracts with bounded normalized output", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider();
    const service = new EvimedSearchService(config, store, upstream);
    const cases = [
      ["literature", { language: "en", startYear: 2020, sort: "newest" }, "/FineScreenController/search", "paper"],
      ["guidelines", { language: "zh", sort: "relevance" }, "/archive-api/guide/search", "guide"],
      ["drugs", { source: "FDA" }, "/drug-api/instructions/pages", "instruction"],
      ["trials", { source: "1", startYear: 2020 }, "/clinical-api/getClinical", ""],
    ];
    for (const [category, filters, suffix, searchType] of cases) {
      const result = await service.search(signed.req, responseHeaders(), category, { query: "  aspirin  ", page: 2, pageSize: 10, filters });
      assert.equal(result.query, "aspirin"); assert.equal(result.total, 9); assert.equal(result.items[0].title, "Study");
      assert.deepEqual(result.items[0].authors, ["Reader"]);
      assert.equal(result.items[0].url, "https://journal.example/study");
      assert.equal(JSON.stringify(result).includes(credential), false);
      assert.equal(category === "trials" ? result.items[0].detailRef : Boolean(result.items[0].detailRef), category === "trials" ? null : true);
      const [screen, search] = upstream.calls.slice(-2);
      assert.equal(screen.body.searchType, searchType); assert.equal(screen.body.queryStr, "aspirin");
      assert.ok(search.path.endsWith(suffix)); assert.equal(search.init.headers.token, credential);
      assert.equal(search.init.headers.cookie, undefined); assert.equal(search.init.redirect, "error");
      if (category === "literature") { assert.equal(search.body.type, 1); assert.deepEqual(search.body.language, [2]); assert.equal(search.body.sortBasis, 2); assert.equal(search.body.startYear, "2020"); }
      if (category === "guidelines") { assert.equal(search.body.sortBy, 0); assert.equal(search.body.sort, 2); }
      if (category === "drugs") { assert.equal(search.init.method, "GET"); assert.equal(search.query.source, "FDA"); assert.equal(search.query.queryStr, "aspirin"); }
      if (category === "trials") { assert.deepEqual(search.body.change, [1]); assert.equal(search.body.startRegistrationTime, "2020"); }
    }
    await service.search(signed.req, responseHeaders(), "guidelines", { query: "aspirin", filters: { sort: "newest" } });
    assert.equal(upstream.calls.at(-1).body.sortBy, 1); assert.equal(upstream.calls.at(-1).body.sort, 0);
    assert.equal(upstream.calls.at(-1).body.language, "all");
    for (const [sort, sortBasis] of [[undefined, 0], ["comprehensive", 0], ["relevance", 5]]) {
      await service.search(signed.req, responseHeaders(), "literature", { query: "aspirin", filters: sort ? { sort } : {} });
      assert.equal(upstream.calls.at(-1).body.sortBasis, sortBasis);
      assert.equal(upstream.calls.at(-1).body.sortDirection, sort === "relevance" ? 2 : null);
    }
    const before = upstream.calls.length;
    for (const [category, body] of [["drugs", { query: "x", filters: { source: "other" } }], ["trials", { query: "x", filters: { source: "3" } }], ["literature", { query: "x", pageSize: 51 }], ["literature", { query: "x", url: "https://evil.invalid" }], ["literature", { query: "x", filters: { startYear: 2026, endYear: 2020 } }]]) {
      await assert.rejects(service.search(signed.req, responseHeaders(), category, body), { code: "evimed_search_invalid_input" });
    }
    assert.equal(upstream.calls.length, before);
  });
});

test("Vue extended filters and sorting retain the provider's exact field types", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    await service.search(signed.req, responseHeaders(), "literature", { query: "aspirin", filters: { language: "en", words: "adults", articleType: ["2"], keyWords: ["diabetes"], p: ["adults"], ic: ["aspirin"], jcrPartition: ["Q1"], journalPartition: ["SCI"], smallJcr: 2.5, bidJcr: 8, startYear: 2020, endYear: 2026, sort: "impact-high" } });
    let sent = upstream.calls.at(-1).body;
    assert.deepEqual(sent.articleType, ["2"]); assert.deepEqual(sent.keyWords, ["diabetes"]);
    assert.deepEqual(sent.jcrPartition, ["Q1"]); assert.deepEqual(sent.journalPartition, ["SCI"]);
    assert.deepEqual(sent.searchDomain, { searchRange: [1, 2, 3, 4], searchWord: "adults" });
    assert.equal(sent.smallJcr, "2.5"); assert.equal(sent.bidJcr, "8"); assert.equal(sent.endYear, "2026");
    assert.equal(sent.sortBasis, 1); assert.equal(sent.sortDirection, 2);
    for (const [sort, basis, direction] of [["oldest", 2, 1], ["impact-low", 1, 1], ["relevance", 5, 2]]) {
      await service.search(signed.req, responseHeaders(), "literature", { query: "aspirin", filters: { language: "en", sort } });
      assert.equal(upstream.calls.at(-1).body.sortBasis, basis); assert.equal(upstream.calls.at(-1).body.sortDirection, direction);
    }
    await service.search(signed.req, responseHeaders(), "guidelines", { query: "aspirin", filters: { words: "adults", zdzs: ["Society"], keywords: ["diabetes"], sType: ["0"], firstLevelDepartment: ["Medicine"], secondLevelDepartment: ["Cardiology"], sort: "oldest" } });
    sent = upstream.calls.at(-1).body;
    assert.deepEqual(sent.sType, [0]); assert.deepEqual(sent.zdzs, ["Society"]); assert.equal(sent.words, "adults");
    assert.equal(sent.firstLevelDepartment, "Medicine"); assert.equal(sent.secondLevelDepartment, "Cardiology");
    assert.equal(sent.sortBy, 1); assert.equal(sent.sort, 1);
    await service.search(signed.req, responseHeaders(), "drugs", { query: "aspirin", filters: { words: "tablets", source: "NMPA" } });
    assert.equal(upstream.calls.at(-1).query.words, "tablets");
    await service.search(signed.req, responseHeaders(), "trials", { query: "aspirin", filters: { source: "1", words: "adult", startYear: 2020, endYear: 2026, minSampleSize: 0, maxSampleSize: 500, testPhase: ["Phase 2/2期临床试验"], associatedArticles: ["0"], recruitmentStatus: ["Recruiting/招募中"] } });
    sent = upstream.calls.at(-1).body;
    assert.deepEqual(sent.associatedArticles, [0]); assert.equal(sent.minSampleSize, "0"); assert.equal(sent.maxSampleSize, "500");
    assert.equal(sent.searchData, "adult"); assert.equal(sent.startRegistrationTime, "2020"); assert.equal(sent.endRegistrationTime, "2026");
    assert.deepEqual(sent.recruitmentStatus, ["Recruiting/招募中"]);
    await service.search(signed.req, responseHeaders(), "trials", { query: "aspirin", filters: { source: "0", studyType: ["干预性研究"] } });
    assert.deepEqual(upstream.calls.at(-1).body.studyType, ["干预性研究"]);
    await service.search(signed.req, responseHeaders(), "trials", { query: "aspirin", filters: { source: "2", clinicalSourceDb: "MEDLINE", startYear: 2020 } });
    assert.equal(upstream.calls.at(-1).body.source, "MEDLINE"); assert.equal(upstream.calls.at(-1).body.startYear, "2020");
    const before = upstream.calls.length;
    for (const [category, filters] of [["literature", { articleType: [1] }], ["literature", { smallJcr: 10, bidJcr: 1 }], ["literature", { sort: "impact-high", language: "zh" }], ["guidelines", { sType: ["not-a-type"] }], ["drugs", { words: "x".repeat(201) }], ["trials", { minSampleSize: 1.5 }], ["trials", { associatedArticles: ["2"] }], ["trials", { studyType: Array(51).fill("type") }]]) {
      await assert.rejects(service.search(signed.req, responseHeaders(), category, { query: "aspirin", filters }), { code: "evimed_search_invalid_input" });
    }
    assert.equal(upstream.calls.length, before);
  });
});

test("literature facets preserve real full-query counts and explicit option identifiers", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    upstream.answerWith(call => {
      if (call.path.endsWith("/screen")) return json({ screenId: "screen" });
      if (call.path.endsWith("/chart")) return json({ name: ["2026", "2020", "bad"], value: [12000, "45", 99] });
      if (call.path.endsWith("/leftSidebarMiddle")) return json({ middle: { "Randomized trial": 2, "Review": 1 } });
      if (call.path.endsWith("/leftSidebarJournal")) return json({ journal: { SCI: 120 } });
      if (call.path.endsWith("/leftSidebarBottom")) return json({ bottom: [{ name: "Diabetes", value: 2000 }] });
      if (call.path.endsWith("/leftSidebarP")) return json({ p: { Adults: 20 } });
      if (call.path.endsWith("/leftSidebarIc")) return json({ ic: { Aspirin: 25 } });
      if (call.path.endsWith("/leftSidebarJcr")) return json({ jcr: { Q1: 40 } });
      throw new Error("Unexpected upstream path");
    });
    const result = await service.facets(signed.req, responseHeaders(), "literature", { query: "aspirin", filters: { language: "en", words: "adults" } });
    assert.deepEqual(result.timeline, [{ year: 2020, count: 45 }, { year: 2026, count: 12000 }]);
    assert.deepEqual(result.unavailable, []);
    assert.deepEqual(result.groups.find(group => group.key === "articleType").options, [{ value: "2", label: "Randomized trial" }, { value: "1", label: "Review" }]);
    assert.deepEqual(result.groups.find(group => group.key === "keyWords").options, [{ value: "Diabetes", label: "Diabetes", count: 2000 }]);
    assert.deepEqual(result.groups.find(group => group.key === "jcrPartition").options, [{ value: "Q1", label: "Q1", count: 40 }]);
    assert.equal(upstream.calls.length, 8);
    assert.equal(upstream.calls.some(call => call.path.endsWith("/search")), false);
    assert.equal(upstream.calls.find(call => call.path.endsWith("/chart")).body.searchDomain.searchWord, "adults");
    assert.equal(JSON.stringify(result).includes(credential), false);
  });
});

test("facet failures keep other groups, never synthesize a year distribution, and enforce session revocation", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    upstream.answerWith(call => {
      if (call.path.endsWith("/screen")) return json({ screenId: "screen" });
      if (call.path.endsWith("/chart")) return json({ name: [2026], value: [] });
      if (call.path.endsWith("/leftSidebarP")) return json(null, 500);
      if (call.path.endsWith("/leftSidebarMiddle")) return json({ middle: [{ name: "Trial", value: "2" }] });
      return json({ journal: { [credential]: 10 }, bottom: {}, ic: {} });
    });
    const result = await service.facets(signed.req, responseHeaders(), "literature", { query: "aspirin" });
    assert.deepEqual(result.timeline, []); assert.deepEqual(result.unavailable, ["timeline", "p"]);
    assert.deepEqual(result.groups.find(group => group.key === "articleType").options, [{ value: "2", label: "Trial" }]);
    assert.equal(JSON.stringify(result).includes(credential), false);
    assert.equal(upstream.calls.some(call => call.path.endsWith("/leftSidebarJcr")), false);
    upstream.answerWith(call => call.path.endsWith("/screen") ? json({ screenId: "screen" }) : json(null, 401));
    await assert.rejects(service.facets(signed.req, responseHeaders(), "literature", { query: "aspirin" }), { code: "evimed_search_credential_expired" });
    assert.equal((await store.evimedSearchSession(signed.req, responseHeaders())).credential, null);
    assert.equal((await store.ensureSessionUser(signed.req, responseHeaders())).user.id, user.id);
  });
});

test("guide facets retain department parents and search derives missing parent selections", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    upstream.answerWith(call => {
      if (call.path.endsWith("/screen")) return json({ screenId: "screen" });
      if (call.path.endsWith("/ysar/get")) return json({ name: ["2025"], value: [100] });
      if (call.path.endsWith("/filter/get")) return json({ sType: { Guideline: 0 }, zdzs: [{ name: "Society", count: 10 }], keywords: ["Heart"] });
      if (call.path.endsWith("/department/")) return json({ department: [{ Medicine: ["Cardiology", "Neurology"] }], administrativeTwo: ["Cardiology", "Neurology"] });
      return json({ list: [], total: 0 });
    });
    const result = await service.facets(signed.req, responseHeaders(), "guidelines", { query: "aspirin" });
    assert.deepEqual(result.groups.find(group => group.key === "sType").options, [{ value: "0", label: "Guideline" }]);
    assert.deepEqual(result.groups.find(group => group.key === "secondLevelDepartment").options[0], { value: "Cardiology", label: "Cardiology", parent: "Medicine" });
    await service.search(signed.req, responseHeaders(), "guidelines", { query: "aspirin", filters: { secondLevelDepartment: ["Cardiology"] } });
    assert.equal(upstream.calls.at(-1).body.firstLevelDepartment, "Medicine");
    assert.equal(upstream.calls.at(-1).body.secondLevelDepartment, "Cardiology");
  });
});

test("drug and registry facets use real source availability and uncounted documented enums", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    upstream.answerWith(call => call.path.endsWith("/screen") ? json({ screenId: "screen" }) : call.path.endsWith("/countrys/list") ? json(["nmpa", "FDA", "unknown", "FDA"]) : json([{ name: "MEDLINE", count: 4 }]));
    const drugs = await service.facets(signed.req, responseHeaders(), "drugs", { query: "aspirin" });
    assert.deepEqual(drugs.groups[0].options.map(option => option.value), ["NMPA", "FDA"]);
    assert.equal(upstream.calls.at(-1).query.queryStr, "aspirin");
    const before = upstream.calls.length;
    const trials = await service.facets(signed.req, responseHeaders(), "trials", { query: "aspirin", filters: { source: "1" } });
    assert.equal(upstream.calls.length, before);
    assert.deepEqual(trials.groups.find(group => group.key === "associatedArticles").options, [{ value: "1", label: "有" }, { value: "0", label: "无" }]);
    assert.equal(trials.groups.some(group => group.key === "studyType"), false);
    const central = await service.facets(signed.req, responseHeaders(), "trials", { query: "aspirin", filters: { source: "2" } });
    assert.deepEqual(central.groups.find(group => group.key === "clinicalSourceDb").options, [{ value: "MEDLINE", label: "MEDLINE", count: 4 }]);
    assert.deepEqual(central.timeline, []);
  });
});

test("Vue alternative identifiers and all NMPA section fields remain readable", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    for (const [category, idKey] of [["literature", "paperId"], ["guidelines", "guideId"]]) {
      upstream.answerWith(call => call.path.endsWith("/screen") ? json({ screenId: "screen" }) : json({ list: [{ [idKey]: "alternate-id", title: "Title" }] }));
      const result = await service.search(signed.req, responseHeaders(), category, { query: "aspirin" });
      assert.equal(result.items[0].id, "alternate-id"); assert.ok(result.items[0].detailRef);
      upstream.answerWith(() => json({ title: "Title", abstract: "Guide abstract" }));
      const detail = await service.detail(signed.req, responseHeaders(), category, { detailRef: result.items[0].detailRef });
      assert.equal(upstream.calls.at(-1).query.id, "alternate-id");
      if (category === "guidelines") assert.ok(detail.sections.some(section => section.text === "Guide abstract"));
    }
    upstream.answerWith(call => call.path.endsWith("/screen") ? json({ screenId: "screen" }) : json({ list: [{ pdfName: "nmpa.pdf", commonName: "Medicine", source: "NMPA" }] }));
    const result = await service.search(signed.req, responseHeaders(), "drugs", { query: "medicine" });
    const fields = ["vaccineRecipients", "pharmacologyAndIndication", "immunizationProgramesAndDose", "introduction", "toxicological", "poison", "pharmacological", "mechanismAction", "radioactivityAndTime", "radiationAbsorbedDose"];
    upstream.answerWith(() => json({ list: { commonName: "Medicine", ...Object.fromEntries(fields.map(field => [field, [{ tag: "text", content: `Content ${field}` }]])) } }));
    const detail = await service.detail(signed.req, responseHeaders(), "drugs", { detailRef: result.items[0].detailRef });
    for (const field of fields) assert.ok(detail.sections.some(section => section.text.includes(`Content ${field}`)), field);
  });
});

test("detail references reject another session/category, tampering and expiry without calling upstream", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    const list = await service.search(signed.req, responseHeaders(), "literature", { query: "aspirin" });
    const detailRef = list.items[0].detailRef;
    const other = await signIn(store);
    const session = await store.evimedSearchSession(signed.req, responseHeaders());
    const expired = sealEvimedSearchReference(config, { ...session, expiresAt: Date.now() - 1 }, "literature", { id: "paper-1" });
    const before = upstream.calls.length;
    for (const [req, category, reference] of [[other.req, "literature", detailRef], [signed.req, "guidelines", detailRef], [signed.req, "literature", `${detailRef.slice(0, -3)}bad`], [signed.req, "literature", expired]]) {
      await assert.rejects(service.detail(req, responseHeaders(), category, { detailRef: reference }), { code: "evimed_search_reference_invalid" });
    }
    assert.equal(upstream.calls.length, before);
    upstream.answerWith(() => json({ title: "Paper", abstract: "<b>Clinical evidence</b>", objective: "Objective", token: credential, url: "https://x.example/?token=private" }));
    const detail = await service.detail(signed.req, responseHeaders(), "literature", { detailRef });
    assert.equal(detail.title, "Paper"); assert.equal(detail.url, null);
    assert.deepEqual(detail.sections[0], { title: "摘要", text: "Clinical evidence" });
    assert.deepEqual(upstream.calls.at(-1).query, { id: "paper-1", screenId: "synthetic-search-context" });
    assert.equal(JSON.stringify(detail).includes(credential), false);
  });
});

test("detail prose preserves paragraphs and list breaks while stripping active HTML", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    const list = await service.search(signed.req, responseHeaders(), "literature", { query: "heart" });
    upstream.answerWith(() => json({ title: "A\n title", abstract: '<p>Methods: n=170.</p><p>Results: P<0.05; 95% CI 1.299–1.467.<br>Second line.</p><ul><li>First item</li><li>Second item</li></ul><script>private()</script><style>body{display:none}</style>' }));
    const detail = await service.detail(signed.req, responseHeaders(), "literature", { detailRef: list.items[0].detailRef });
    assert.equal(detail.title, "A title");
    assert.equal(detail.sections[0].text, "Methods: n=170.\n\nResults: P<0.05; 95% CI 1.299–1.467.\nSecond line.\n\nFirst item\n\nSecond item");
    assert.equal(detail.sections[0].text.includes("private"), false);
  });
});

test("drug details retain multilingual elements, nested text and tables as plain text", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    const list = await service.search(signed.req, responseHeaders(), "drugs", { query: "aspirin", filters: { source: "FDA" } });
    upstream.answerWith(() => json({ info: { genericNames: "Aspirin", companyName: "Manufacturer" }, list: [{ title: "Usage", elements: [
      { type: "text", content_zh: "", content_na: "<p>Give with water.</p>" },
      { type: "text", content_en: "Do not exceed the prescribed dose.", elements: [{ type: "text", content: "Nested note" }] },
      { type: "table", content: { headers: ["Age", "Dose"], rows: [["Adults", "One tablet"], { header: "Children", value: { content: "Consult a clinician" } }] } },
      { type: "image", content: { url: "https://image.example/image.png" } },
    ] }] }));
    const detail = await service.detail(signed.req, responseHeaders(), "drugs", { detailRef: list.items[0].detailRef });
    assert.equal(detail.title, "Aspirin");
    for (const expected of ["Give with water.", "prescribed dose", "Nested note", "Age", "Adults", "One tablet", "Children", "Consult a clinician"]) assert.ok(detail.sections[0].text.includes(expected), expected);
    assert.equal(detail.sections[0].text.includes("<p>"), false);
    assert.deepEqual(upstream.calls.at(-1).query, { source: "fda", pdfName: "label.pdf" });
  });
});

test("an upstream refusal revokes only this session's search credential and keeps the platform session", async () => {
  await fixture(async ({ config, store, signed }) => {
    const other = await signIn(store, `${credential}-other`);
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    upstream.answerWith(() => json(null, 401));
    await assert.rejects(service.search(signed.req, responseHeaders(), "literature", { query: "aspirin" }), { status: 403, code: "evimed_search_credential_expired" });
    assert.equal((await store.evimedSearchSession(signed.req, responseHeaders())).credential, null);
    assert.equal((await store.ensureSessionUser(signed.req, responseHeaders())).user.id, user.id);
    assert.equal((await store.evimedSearchSession(other.req, responseHeaders())).credential, `${credential}-other`);
    await assert.rejects(service.search(signed.req, responseHeaders(), "literature", { query: "aspirin" }), { status: 403, code: "evimed_search_login_required" });
  });
});

test("a search cannot deliver after its session authorization is revoked in flight", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    let release;
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    upstream.answerWith(call => call.path.endsWith("/screen") ? json({ screenId: "screen" }) : new Promise(resolve => {
      release = () => resolve(json({ list: [{ id: "1", title: "Result" }] })); ready();
    }));
    const pending = service.search(signed.req, responseHeaders(), "literature", { query: "aspirin" });
    await started;
    await store.clearEvimedSearchCredential(signed.req);
    release();
    await assert.rejects(pending, { status: 403, code: "evimed_search_credential_expired" });
    assert.equal((await store.ensureSessionUser(signed.req, responseHeaders())).user.id, user.id);
  });
});

test("provider errors, body timeouts, oversized JSON and echoed credentials remain bounded", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    for (const [reply, code] of [
      [() => json(null, 429), "evimed_search_rate_limited"],
      [() => new Response("invalid JSON"), "evimed_search_response_invalid"],
      [() => new Response("x".repeat(2 * 1024 * 1024 + 1)), "evimed_search_response_invalid"],
      [() => { throw new DOMException(credential, "TimeoutError"); }, "evimed_search_timeout"],
      [() => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException(credential, "AbortError")); } })), "evimed_search_timeout"],
      [() => { throw new Error(credential); }, "evimed_search_upstream_unavailable"],
    ]) {
      upstream.answerWith(reply);
      await assert.rejects(service.search(signed.req, responseHeaders(), "literature", { query: "aspirin" }), error => error.code === code && !error.message.includes(credential));
    }
    upstream.answerWith(call => call.path.endsWith("/screen") ? json({ screenId: "screen" }) : json({ list: [{ id: "1", title: credential, summary: credential, url: "javascript:alert(1)" }] }));
    const result = await service.search(signed.req, responseHeaders(), "literature", { query: "aspirin" });
    assert.equal(JSON.stringify(result).includes(credential), false); assert.equal(result.items[0].url, null);
  });
});

test("private refusal diagnostics retain only a stage enum, statuses and a generated reason", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    upstream.answerWith(call => call.path.endsWith("/screen") ? json({ screenId: "screen" })
      : new Response(JSON.stringify({ code: 500, msg: `请求参数无效 ${credential} private-provider-message` })));
    let failure;
    try { await service.search(signed.req, responseHeaders(), "literature", { query: "private-user-query" }); }
    catch (error) { failure = error; }
    const detail = evimedSearchFailureDetail(failure);
    assert.deepEqual(JSON.parse(detail), { stage: "literature-search", httpStatus: 200, businessCode: 500, success: "missing", reason: "invalid_input" });
    for (const privateValue of [credential, "private-provider-message", "private-user-query", "screen"]) assert.equal(detail.includes(privateValue), false);
    assert.equal(evimedSearchFailureDetail(new Error("untrusted")), "");
  });
});

test("plain clinical thresholds retain comparison symbols while markup is removed", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    upstream.answerWith(call => call.path.endsWith("/screen") ? json({ screenId: "screen" }) : json({ list: [
      { id: "threshold", title: '<span title="x > y">Thresholds</span>', summary: "HbA1c < 7%; eGFR > 30 mL/min; p<0.05" },
    ] }));
    const result = await service.search(signed.req, responseHeaders(), "literature", { query: "diabetes" });
    assert.equal(result.items[0].title, "Thresholds");
    assert.equal(result.items[0].summary, "HbA1c < 7%; eGFR > 30 mL/min; p<0.05");
  });
});

test("HTTP routes require an actual session and CSRF, reject arbitrary paths and return no-store", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    const routes = createEvimedSearchRoutes({ store, service, maxJsonBytes: 16_384 });
    const server = createServer(async (req, res) => {
      try { if (!await routes(req, res)) sendJson(res, 404, { code: "not_found" }); }
      catch (error) { sendJson(res, error.status ?? 500, { code: error.code ?? "internal_error" }); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/evimed-search`;
    const post = (route, headers = {}, body = { query: "aspirin" }) => fetch(`${base}/${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    try {
      assert.equal((await post("literature/search")).status, 401);
      assert.equal((await post("literature/search", { Cookie: signed.cookie })).status, 403);
      assert.equal((await post("literature/facets")).status, 401);
      assert.equal((await post("literature/facets", { Cookie: signed.cookie })).status, 403);
      assert.equal((await post("literature/collection")).status, 401);
      assert.equal((await post("literature/fulltext-confirm", { Cookie: signed.cookie })).status, 403);
      assert.equal(upstream.calls.length, 0);
      const headers = { Cookie: signed.cookie, "X-Open-Science-CSRF": signed.session.csrfToken, token: "synthetic-unrelated-browser-token" };
      const response = await post("literature/search", headers);
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.text()).includes(credential), false);
      const facets = await post("trials/facets", headers, { query: "aspirin", filters: { source: "1" } });
      assert.equal(facets.status, 200); assert.equal(facets.headers.get("cache-control"), "no-store");
      assert.equal((await facets.json()).data.groups[0].key, "source");
      assert.equal((await post("arbitrary/search", headers)).status, 404);
      assert.equal((await post("literature/search?url=https://evil.invalid", headers)).status, 404);
      assert.equal((await fetch(`${base}/literature/search`)).status, 405);
      await store.logout(signed.req);
      assert.equal((await post("literature/search", headers)).status, 401);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});

test("search actions use session-bound references and the Vue collection methods without guessing missing state", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    for (const category of ["literature", "guidelines", "drugs"]) {
      upstream.answerWith(call => call.path.endsWith("/screen") ? json({ screenId: "screen" }) : json({ list: [{ id: "record", pdfName: "label.pdf", source: "FDA", title: "Title", name: "Guide title", genericNames: "Medicine", collectionMark: 0 }] }));
      const list = await service.search(signed.req, responseHeaders(), category, { query: "aspirin" });
      const item = list.items[0];
      assert.equal(item.collected, false); assert.ok(item.actionRef);
      upstream.answerWith(() => json(null));
      const result = await service.action(signed.req, responseHeaders(), category, "collection", { actionRef: item.actionRef, collected: true });
      assert.equal(result.collected, true);
      const sent = upstream.calls.at(-1);
      assert.equal(sent.init.method, category === "literature" ? "POST" : "PUT");
      assert.equal(sent.init.headers.token, credential); assert.equal(sent.init.redirect, "error");
      if (category === "literature") assert.deepEqual(sent.body, { ids: ["record"], status: 1 });
      if (category === "guidelines") assert.deepEqual(sent.body, { excIds: ["Guide title"], exclude: 3, screenId: "screen", starMark: 1, type: "" });
      if (category === "drugs") assert.deepEqual(sent.body, { drugName: "", excId: "label.pdf", exclude: 3, instructionName: "Medicine", screenId: "screen", source: "FDA", starMark: 1, type: "" });
      const other = await signIn(store);
      const before = upstream.calls.length;
      await assert.rejects(service.action(other.req, responseHeaders(), category, "collection", { actionRef: item.actionRef, collected: true }), { code: "evimed_search_reference_invalid" });
      await assert.rejects(service.action(signed.req, responseHeaders(), category, "collection", { actionRef: `${item.actionRef}bad`, collected: true }), { code: "evimed_search_reference_invalid" });
      await assert.rejects(service.action(signed.req, responseHeaders(), category, "collection", { actionRef: item.actionRef, collected: true, url: "https://untrusted.example/" }), { code: "evimed_search_invalid_input" });
      assert.equal(upstream.calls.length, before);
      upstream.answerWith(() => json({ title: "Title" }));
      const detail = await service.detail(signed.req, responseHeaders(), category, { detailRef: item.detailRef });
      assert.equal(detail.collected, null); assert.ok(detail.actionRef); assert.ok(detail.id);
    }
  });
});

test("citations preserve available formats and export only verified files from the fixed provider endpoint", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    const list = await service.search(signed.req, responseHeaders(), "literature", { query: "aspirin" });
    const actionRefs = [list.items[0].actionRef, list.items[0].actionRef];
    upstream.answerWith(() => json([{ type: "GB/T 7714", content: `<b>A study.</b><br>Next line. ${credential}` }]));
    const citation = await service.action(signed.req, responseHeaders(), "literature", "citations", { actionRefs, format: 0 });
    assert.equal(citation.quotes[0].label, "GB/T 7714"); assert.ok(citation.quotes[0].text.includes("\nNext line."));
    assert.equal(JSON.stringify(citation).includes(credential), false);
    assert.deepEqual(upstream.calls.at(-1).body, { ids: ["paper-1"], type: 0 });
    for (const [format, bytes, mime, extension] of [[1, "PK\u0003\u0004example", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"], [2, "%PDF-1.7\nexample", "application/pdf", "pdf"], [3, "<?xml version=\"1.0\"?><records/>", "application/xml", "xml"]]) {
      upstream.answerWith(() => new Response(bytes, { headers: { "content-type": mime, "content-disposition": "attachment; filename=../../unsafe.exe" } }));
      const result = await service.action(signed.req, responseHeaders(), "literature", "export", { actionRefs, format });
      assert.equal(result.filename, `literature-export.${extension}`); assert.equal(result.contentType, mime);
      assert.equal(Buffer.from(result.base64, "base64").toString(), bytes);
      assert.ok(upstream.calls.at(-1).path.endsWith("/FineScreenController/batchExport"));
    }
    for (const response of [() => new Response("<html>%PDF-1.7</html>", { headers: { "content-type": "text/html" } }), () => new Response(`%PDF-1.7 ${credential}`, { headers: { "content-type": "application/pdf" } }), () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf", "content-length": String(10 * 1024 * 1024 + 1) } })]) {
      upstream.answerWith(response);
      await assert.rejects(service.action(signed.req, responseHeaders(), "literature", "export", { actionRefs, format: 2 }), { code: "evimed_search_response_invalid" });
    }
    const before = upstream.calls.length;
    await assert.rejects(service.action(signed.req, responseHeaders(), "literature", "export", { actionRefs: Array(21).fill(actionRefs[0]), format: 1 }), { code: "evimed_search_invalid_input" });
    await assert.rejects(service.action(signed.req, responseHeaders(), "guidelines", "citations", { actionRefs, format: 0 }), { code: "evimed_search_invalid_input" });
    assert.equal(upstream.calls.length, before);
  });
});

function fullTextProvider(upstream, state) {
  upstream.answerWith(call => {
    if (call.path.endsWith("/profile/info")) return json({ profileReminderShow: state.profileRequired ?? false });
    if (call.path.endsWith("/fullTextStatus")) return json({ status: state.status ?? 2, url: state.url ?? "https://files.evimed.test/original.pdf" });
    if (call.path.endsWith("/remaining")) return json({ daily: state.daily ?? 1, permanent: 0, unlimited: state.unlimited ?? false });
    if (call.path.endsWith("/getFullText")) { state.status = 1; state.requests = (state.requests ?? 0) + 1; return json(null); }
    if (call.path.endsWith("/addData")) { state.confirmations = (state.confirmations ?? 0) + 1; return state.confirm ? state.confirm() : json(null); }
    throw new Error("Unexpected full text path");
  });
}

test("full text offers are read-only and confirmation alone consumes the disclosed allowance once", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    const list = await service.search(signed.req, responseHeaders(), "literature", { query: "aspirin" });
    const actionRef = list.items[0].actionRef;
    const state = { daily: 1, status: 2, confirmations: 0 };
    fullTextProvider(upstream, state);
    const offer = await service.action(signed.req, responseHeaders(), "literature", "fulltext-offer", { actionRef });
    assert.equal(offer.kind, "free"); assert.equal(offer.amount, 0); assert.equal(offer.filename, "Study.pdf");
    assert.ok(offer.offerRef); assert.equal(state.confirmations, 0);
    const before = upstream.calls.length;
    const other = await signIn(store);
    await assert.rejects(service.action(other.req, responseHeaders(), "literature", "fulltext-confirm", { offerRef: offer.offerRef }), { code: "evimed_search_reference_invalid" });
    await assert.rejects(service.action(signed.req, responseHeaders(), "guidelines", "fulltext-confirm", { offerRef: offer.offerRef }), { code: "evimed_search_reference_invalid" });
    assert.equal(upstream.calls.length, before);
    const results = await Promise.all([service.action(signed.req, responseHeaders(), "literature", "fulltext-confirm", { offerRef: offer.offerRef }), service.action(signed.req, responseHeaders(), "literature", "fulltext-confirm", { offerRef: offer.offerRef })]);
    assert.deepEqual(results, [{ approved: true }, { approved: true }]); assert.equal(state.confirmations, 1);
    assert.deepEqual(upstream.calls.find(call => call.path.endsWith("/addData")).query, { dataId: "paper-1", type: "1", name: "Study" });
    assert.equal(upstream.calls.some(call => /download\/(use|consume)|bean\/consume/.test(call.path)), false);
  });
});

test("download confirmation refuses changed terms, identity requirements, cancellation and expired offers before charging", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    const list = await service.search(signed.req, responseHeaders(), "guidelines", { query: "aspirin" });
    const actionRef = list.items[0].actionRef;
    const state = { daily: 1, status: 2, confirmations: 0, profileRequired: false, url: "https://files.evimed.test/original.pdf" };
    fullTextProvider(upstream, state);
    const offer = await service.action(signed.req, responseHeaders(), "guidelines", "fulltext-offer", { actionRef });
    state.daily = 0;
    await assert.rejects(service.action(signed.req, responseHeaders(), "guidelines", "fulltext-confirm", { offerRef: offer.offerRef }), { code: "evimed_search_download_cost_changed" });
    const paid = await service.action(signed.req, responseHeaders(), "guidelines", "fulltext-offer", { actionRef });
    assert.equal(paid.amount, 4); assert.equal(paid.kind, "beans");
    state.url = "https://files.evimed.test/changed.pdf";
    await assert.rejects(service.action(signed.req, responseHeaders(), "guidelines", "fulltext-confirm", { offerRef: paid.offerRef }), { code: "evimed_search_download_cost_changed" });
    state.url = offer.url; state.daily = 1; state.profileRequired = true;
    await assert.rejects(service.action(signed.req, responseHeaders(), "guidelines", "fulltext-confirm", { offerRef: offer.offerRef }), { code: "evimed_search_profile_required" });
    state.profileRequired = false;
    await assert.rejects(service.action({ ...signed.req, aborted: true }, responseHeaders(), "guidelines", "fulltext-confirm", { offerRef: offer.offerRef }), { code: "evimed_search_action_cancelled" });
    const session = await store.evimedSearchSession(signed.req, responseHeaders());
    const expired = sealEvimedSearchReference(config, session, "guidelines:download", { actionRef, amount: "0", until: String(Date.now() - 1), fileDigest: "irrelevant" });
    await assert.rejects(service.action(signed.req, responseHeaders(), "guidelines", "fulltext-confirm", { offerRef: expired }), { code: "evimed_search_download_cost_changed" });
    assert.equal(state.confirmations, 0);
    state.status = 5; state.daily = 0;
    const owned = await service.action(signed.req, responseHeaders(), "guidelines", "fulltext-offer", { actionRef });
    assert.equal(owned.kind, "owned"); assert.equal(owned.amount, 0);
    await service.action(signed.req, responseHeaders(), "guidelines", "fulltext-confirm", { offerRef: owned.offerRef });
    assert.equal(state.confirmations, 0);
  });
});

test("full text requests are explicit, status refresh is read-only and unsafe file URLs never leave the boundary", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    const list = await service.search(signed.req, responseHeaders(), "drugs", { query: "aspirin", filters: { source: "FDA" } });
    const actionRef = list.items[0].actionRef;
    const state = { status: 0, requests: 0, url: "" };
    fullTextProvider(upstream, state);
    const status = await service.action(signed.req, responseHeaders(), "drugs", "fulltext-status", { actionRef });
    assert.equal(status.canRequest, true); assert.equal(state.requests, 0);
    await service.action(signed.req, responseHeaders(), "drugs", "fulltext-request", { actionRef });
    assert.equal(state.requests, 1);
    assert.deepEqual(upstream.calls.find(call => call.path.endsWith("/getFullText")).query, { dataId: "label.pdf", type: "3", source: "fda" });
    await service.action(signed.req, responseHeaders(), "drugs", "fulltext-request", { actionRef });
    assert.equal(state.requests, 1);
    for (const url of ["http://localhost/private", "http://127.0.0.1/private", "http://10.0.0.1/private", "https://files.evimed.test/file?token=private", "javascript:alert(1)", `https://files.evimed.test/${credential}`]) {
      state.url = url;
      assert.equal((await service.action(signed.req, responseHeaders(), "drugs", "fulltext-status", { actionRef })).url, null);
    }
  });
});

test("an unknown consuming response blocks queued retries until ownership is confirmed", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    const list = await service.search(signed.req, responseHeaders(), "literature", { query: "aspirin" });
    const actionRef = list.items[0].actionRef;
    const state = { status: 2, daily: 1, confirmations: 0, confirm: () => { throw new Error("Synthetic network loss after the provider consumed the allowance"); } };
    fullTextProvider(upstream, state);
    const offer = await service.action(signed.req, responseHeaders(), "literature", "fulltext-offer", { actionRef });
    const results = await Promise.allSettled([service.action(signed.req, responseHeaders(), "literature", "fulltext-confirm", { offerRef: offer.offerRef }), service.action(signed.req, responseHeaders(), "literature", "fulltext-confirm", { offerRef: offer.offerRef })]);
    assert.ok(results.every(result => result.status === "rejected" && result.reason.code === "evimed_search_download_confirmation_pending"));
    assert.equal(state.confirmations, 1);
    await assert.rejects(service.action(signed.req, responseHeaders(), "literature", "fulltext-offer", { actionRef }), { code: "evimed_search_download_confirmation_pending" });
    state.status = 5;
    const owned = await service.action(signed.req, responseHeaders(), "literature", "fulltext-offer", { actionRef });
    assert.equal(owned.kind, "owned");
    assert.deepEqual(await service.action(signed.req, responseHeaders(), "literature", "fulltext-confirm", { offerRef: owned.offerRef }), { approved: true });
    assert.equal(state.confirmations, 1);
  });
});

test("a disconnect during the final session check cannot consume an allowance", async () => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    const list = await service.search(signed.req, responseHeaders(), "literature", { query: "aspirin" });
    const state = { confirmations: 0 };
    fullTextProvider(upstream, state);
    const offer = await service.action(signed.req, responseHeaders(), "literature", "fulltext-offer", { actionRef: list.items[0].actionRef });
    const req = { ...signed.req, aborted: false };
    const confirmSession = service.confirmSession.bind(service);
    service.confirmSession = async (...args) => { await confirmSession(...args); req.aborted = true; };
    await assert.rejects(service.action(req, responseHeaders(), "literature", "fulltext-confirm", { offerRef: offer.offerRef }), { code: "evimed_search_action_cancelled" });
    assert.equal(state.confirmations, 0);
  });
});

test("an offer that expires during the final authorization check cannot consume an allowance", async context => {
  await fixture(async ({ config, store, signed }) => {
    const upstream = provider(); const service = new EvimedSearchService(config, store, upstream);
    const list = await service.search(signed.req, responseHeaders(), "literature", { query: "aspirin" });
    const state = { confirmations: 0 };
    fullTextProvider(upstream, state);
    const offer = await service.action(signed.req, responseHeaders(), "literature", "fulltext-offer", { actionRef: list.items[0].actionRef });
    const afterExpiry = Date.now() + 6 * 60_000;
    const confirmSession = service.confirmSession.bind(service);
    service.confirmSession = async (...args) => { await confirmSession(...args); context.mock.method(Date, "now", () => afterExpiry); };
    try {
      await assert.rejects(service.action(signed.req, responseHeaders(), "literature", "fulltext-confirm", { offerRef: offer.offerRef }), { code: "evimed_search_download_cost_changed" });
      assert.equal(state.confirmations, 0);
    } finally { context.mock.restoreAll(); }
  });
});
