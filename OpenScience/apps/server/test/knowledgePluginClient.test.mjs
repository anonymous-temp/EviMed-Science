// The knowledge-plugin client against a stubbed transport: what it sends, what
// it refuses, what it retries, and what it names when the plugin is down.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import YAML from "yaml";
import { FRONTIER_ENRICHMENT_KEYS } from "@evimed/domain";
import {
  KNOWLEDGE_PLUGIN_ERROR_CODES, KnowledgePluginClient, contractCompatible, readKnowledgePluginToken, validateEnrichment, validateEntry,
} from "../src/knowledgePluginClient.mjs";

let dir;
let tokenFile;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "evimed-plugin-client-"));
  tokenFile = path.join(dir, "token");
  await writeFile(tokenFile, "test-only-token-one\n", { mode: 0o600 });
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

const HASH = "a".repeat(64);

/** A contract-shaped entry. @param {Record<string, any>} [overrides] */
function entry(overrides = {}) {
  return {
    entry_id: "nejm:0123456789abcdef0123456789abcdef", seq: 1, revision: 1, source_id: "nejm",
    identity_key: "doi:10.1056/nejmoa2400001", url: "https://www.nejm.org/doi/10.1056/NEJMoa2400001",
    canonical_url: "https://www.nejm.org/doi/10.1056/NEJMoa2400001", title: "A trial", language: "en",
    first_seen_at: "2026-09-22T01:00:00Z", content_sha256: HASH, backfill: false, ...overrides,
  };
}

/** A transport that answers from a queue and records every request. */
function transport(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = answers.shift();
    if (!next) throw new Error("no answer queued");
    if (next instanceof Error) throw next;
    const { status = 200, body = {}, headers = {} } = next;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { fetchImpl, calls };
}

const client = (answers, options = {}) => {
  const stub = transport(answers);
  return { plugin: new KnowledgePluginClient({ baseUrl: "http://plugin.test:8080", tokenFile, fetchImpl: stub.fetchImpl, sleep: async () => {}, ...options }), calls: stub.calls };
};

const manifestBody = (version = "1.0.0") => ({
  plugin: { name: "evimed-knowledge-plugin", version: "0.1.0" }, contract: { version },
  capabilities: { stream: true, text: true, refresh: false, lookups: [] }, vocabularies: { lane: ["evidence"] },
  sources: { total: 3, enabled: 2 }, fields: { entry: ["summary"] }, limits: { entries_page_max: 500, text_max_chars: 20000 },
  oldest_seq_available: 5, extra_future_field: { ignored: true },
});

test("unconfigured, it names itself and sends nothing", async () => {
  const stub = transport([]);
  const plugin = new KnowledgePluginClient({ fetchImpl: stub.fetchImpl });
  assert.equal(plugin.configured, false);
  await assert.rejects(plugin.manifest(), { code: "knowledge_plugin_unconfigured" });
  assert.equal(stub.calls.length, 0);
  assert.ok(KNOWLEDGE_PLUGIN_ERROR_CODES.includes("knowledge_plugin_unconfigured"));
});

test("the token is read on every call, and health is sent none", async () => {
  const { plugin, calls } = client([{ body: manifestBody() }, { body: manifestBody() },
    { body: { status: "ok", contract: "1.0.0", sources: { healthy: 2 }, egress: { direct: "ok" }, latest_seq: 42 } }]);
  await plugin.manifest();
  await writeFile(tokenFile, "test-only-token-two\n", { mode: 0o600 });
  await plugin.manifest();
  const health = await plugin.health();
  assert.equal(calls[0].init.headers.authorization, "Bearer test-only-token-one");
  assert.equal(calls[1].init.headers.authorization, "Bearer test-only-token-two", "a rotated token is used without a restart");
  assert.equal(calls[2].init.headers.authorization, undefined, "health must not carry the credential");
  assert.equal(health.latest_seq, 42);
  assert.equal(health.compatible, true);
  await writeFile(tokenFile, "test-only-token-one\n", { mode: 0o600 });
});

test("D-10: the health answer's host budget is read per host as a use against a cap, and what is not that shape is left out", async () => {
  const sources = { healthy: 2 };
  const { plugin } = client([
    { body: { status: "ok", contract: "1.4.0", sources, egress: {}, host_budget: {
      "api.crossref.org": { used: 2750, cap: 3000 }, "api.fda.gov": { used: 0, cap: 300 },
      "negative.example.org": { used: -1, cap: 10 }, "no-cap.example.org": { used: 5 }, "float.example.org": { used: 1.5, cap: 10 },
      "zero-cap.example.org": { used: 0, cap: 0 }, "text.example.org": { used: "3", cap: 10 }, "Bad Host!": { used: 1, cap: 2 },
      "list.example.org": [1, 2], "string.example.org": "2/3" } } },
    // A key named __proto__ only exists in parsed JSON (in an object literal it would set a prototype).
    { body: '{"status":"ok","contract":"1.4.0","sources":{"healthy":2},"egress":{},"host_budget":{"__proto__":{"used":1,"cap":2},"api.fda.gov":{"used":1,"cap":300}}}' },
    { body: { status: "ok", contract: "1.3.0", sources, egress: {} } },
    { body: { status: "ok", contract: "1.4.0", sources, egress: {}, host_budget: [1, 2] } },
    { body: { status: "ok", contract: "1.4.0", sources, egress: {}, host_budget: {} } },
    { body: { status: "ok", contract: "1.4.0", sources, egress: {}, host_budget: Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`host-${index}.example.org`, { used: index, cap: 1000 }])) } },
  ]);
  const health = await plugin.health();
  assert.deepEqual(health.host_budget, { "api.crossref.org": { used: 2750, cap: 3000 }, "api.fda.gov": { used: 0, cap: 300 } });
  const hostile = (await plugin.health()).host_budget;
  assert.deepEqual(hostile, { "api.fda.gov": { used: 1, cap: 300 } });
  assert.equal(Object.getPrototypeOf(hostile), Object.prototype, "a table that names __proto__ does not change what it is");
  assert.equal(/** @type {any} */ ({}).used, undefined);
  assert.equal((await plugin.health()).host_budget, null, "a plugin of an older minor does not say; absent is not zero");
  assert.equal((await plugin.health()).host_budget, null, "a list is not a table of hosts");
  assert.deepEqual((await plugin.health()).host_budget, {}, "a plugin with no capped host says so");
  assert.equal(Object.keys((await plugin.health()).host_budget).length, 64, "a table is read to a bound, whatever it holds");
});

test("a token file anyone else can read is refused by name, and the token never appears in an error", async () => {
  const loose = path.join(dir, "loose");
  await writeFile(loose, "test-only-loose-token\n");
  await chmod(loose, 0o644);
  assert.deepEqual(await readKnowledgePluginToken(loose), { value: "", error: "token_file_permissions" });
  // Group-readable is the production shape (root:10002 0440: the control plane
  // and the plugin both read it); group-writable is not.
  await chmod(loose, 0o440);
  assert.deepEqual(await readKnowledgePluginToken(loose), { value: "test-only-loose-token", error: null });
  await chmod(loose, 0o460);
  assert.deepEqual(await readKnowledgePluginToken(loose), { value: "", error: "token_file_permissions" });
  await chmod(loose, 0o644);
  assert.deepEqual(await readKnowledgePluginToken(path.join(dir, "missing")), { value: "", error: "token_file_unavailable" });
  const { plugin } = client([], { tokenFile: loose });
  const error = await plugin.manifest().catch((failure) => failure);
  assert.equal(error.code, "knowledge_plugin_unconfigured");
  assert.doesNotMatch(error.message, /loose-token/);
  const withToken = client([{ status: 401, body: { code: "unauthorized", message: "bad token test-only-token-one", retryable: false } }]);
  const refused = await withToken.plugin.manifest().catch((failure) => failure);
  assert.equal(refused.code, "knowledge_plugin_unauthorized");
  assert.doesNotMatch(refused.message, /test-only-token/, "a reflected body must not reach the error");
});

test("one retry on a network failure or a 503, then the outage is named", async () => {
  const recovered = client([new TypeError("fetch failed"), { body: manifestBody() }]);
  assert.equal((await recovered.plugin.manifest()).plugin.version, "0.1.0");
  assert.equal(recovered.plugin.counters.retries, 1);

  const down = client([new TypeError("fetch failed"), new TypeError("fetch failed")]);
  await assert.rejects(down.plugin.manifest(), { code: "knowledge_plugin_unreachable" });
  assert.equal(down.plugin.lastError, "knowledge_plugin_unreachable");

  const busy = client([{ status: 503, body: "" }, { status: 503, body: "" }]);
  await assert.rejects(busy.plugin.manifest(), { code: "knowledge_plugin_unreachable" });
  assert.equal(busy.calls.length, 2);

  // A lookup's upstream being down is the plugin's answer, not an outage: no retry.
  const upstream = client([{ status: 502, body: { code: "upstream_unavailable", message: "x", retryable: true } }]);
  await assert.rejects(upstream.plugin.lookup("literature-search", { q: "x" }), { code: "knowledge_plugin_upstream_unavailable" });
  assert.equal(upstream.calls.length, 1);
});

test("every other refusal maps to its own code", async () => {
  const cases = [
    [{ status: 404, body: { code: "not_found", message: "x", retryable: false } }, "knowledge_plugin_not_found"],
    [{ status: 400, body: { code: "invalid_cursor", message: "x", retryable: false } }, "knowledge_plugin_invalid_cursor"],
    [{ status: 400, body: { code: "invalid_params", message: "x", retryable: false } }, "knowledge_plugin_request_invalid"],
    [{ status: 501, body: { code: "capability_unavailable", message: "x", retryable: false } }, "knowledge_plugin_capability_unavailable"],
    [{ status: 500, body: { code: "internal", message: "x", retryable: true } }, "knowledge_plugin_failed"],
  ];
  for (const [answer, code] of cases) {
    const { plugin } = client([answer]);
    await assert.rejects(plugin.entry("nejm:0123"), { code });
  }
  const limited = client([{ status: 429, body: { code: "rate_limited", message: "x", retryable: true }, headers: { "retry-after": "30" } }]);
  const error = await limited.plugin.lookup("literature-search", {}).catch((failure) => failure);
  assert.equal(error.code, "knowledge_plugin_rate_limited");
  assert.equal(error.retryAfterSeconds, 30);
});

test("the manifest carries its contract verdict; a different major is incompatible", async () => {
  assert.equal(contractCompatible("1.3.0", "1.0"), true);
  assert.equal(contractCompatible("1.0.0", "1.2"), false, "a platform that needs 1.2's fields cannot use 1.0");
  assert.equal(contractCompatible("2.0.0", "1.0"), false);
  assert.equal(contractCompatible("garbage", "1.0"), false);
  const { plugin } = client([{ body: manifestBody("2.0.0") }, { body: manifestBody("1.4.2") }]);
  const incompatible = await plugin.manifest();
  assert.equal(incompatible.compatible, false);
  assert.throws(() => plugin.assertCompatible(incompatible), { code: "knowledge_plugin_incompatible" });
  const compatible = await plugin.manifest();
  assert.equal(compatible.compatible, true);
  assert.equal(compatible.oldest_seq_available, 5);
  assert.equal("extra_future_field" in compatible, false, "unknown members are ignored, not passed on");
  const broken = client([{ body: { plugin: { name: "x" } } }]);
  await assert.rejects(broken.plugin.manifest(), { code: "knowledge_plugin_response_invalid" });
});

test("a page of entries: invalid rows are skipped and counted, the page still advances", async () => {
  const { plugin, calls } = client([{ body: {
    entries: [
      entry({ seq: 11 }),
      entry({ seq: 12, content_sha256: "not-a-hash", entry_id: "nejm:bad" }),
      entry({ seq: 13, title: "x".repeat(1001), entry_id: "nejm:long" }),
      "not an object",
      entry({ seq: 99, entry_id: "nejm:outside" }),
      entry({ seq: 14, entry_id: "nejm:second", facts: { journal: "NEJM" }, summary: "  ", registry_ids: ["NCT01", "NCT01", 7] }),
    ],
    next_after: 14, has_more: true, server_time: "2026-09-22T02:00:00Z",
  } }]);
  const page = await plugin.entries({ after: 10, limit: 500 });
  assert.match(calls[0].url, /\/v1\/entries\?after=10&limit=500$/);
  assert.deepEqual(page.entries.map((item) => item.seq), [11, 14]);
  assert.deepEqual(page.skipped.map((item) => item.reason).sort(),
    ["content_sha256_invalid", "entry_not_object", "seq_out_of_page", "title_invalid"]);
  assert.equal(page.nextAfter, 14);
  assert.equal(page.hasMore, true);
  assert.equal(plugin.counters.skippedEntries, 4);
  const second = page.entries[1];
  assert.equal(second.summary, null, "a blank summary is no summary");
  assert.deepEqual(second.registry_ids, ["NCT01"]);
  assert.deepEqual(second.facts, { journal: "NEJM" }, "facts pass through to the ingest's whitelist");
});

test("a page that goes backwards or claims more without moving is refused, not followed", async () => {
  const backwards = client([{ body: { entries: [], next_after: 3, has_more: false } }]);
  await assert.rejects(backwards.plugin.entries({ after: 10 }), { code: "knowledge_plugin_response_invalid" });
  const stuck = client([{ body: { entries: [], next_after: 10, has_more: true } }]);
  await assert.rejects(stuck.plugin.entries({ after: 10 }), { code: "knowledge_plugin_response_invalid" });
  await assert.rejects(backwards.plugin.entries({ after: -1 }), { code: "knowledge_plugin_invalid_cursor" });
});

test("the registry is followed page by page to its end", async () => {
  const source = (id, extra = {}) => ({ id, name: id.toUpperCase(), lane: "evidence", source_type: "journal", access: "crossref-issn",
    egress: "api", authority: 5, launch_tier: "P0", enabled: true, health: "healthy", owner_entity: "Publisher", ...extra });
  const { plugin, calls } = client([
    { body: { sources: [source("nejm"), source("lancet", { homepage: "javascript:alert(1)" })], next_cursor: "page-2" } },
    { body: { sources: [source("jama", { authority: 9 }), { name: "no id" }, source("nejm")], next_cursor: null } },
  ]);
  const listing = await plugin.sources();
  assert.deepEqual(listing.sources.map((row) => row.id), ["nejm", "lancet", "jama"]);
  assert.equal(listing.sources[1].homepage, null, "a non-http homepage never reaches a link");
  assert.equal(listing.sources[2].authority, null, "an out-of-range authority is left for the ingest's default");
  assert.deepEqual(listing.skipped, [{ reason: "source_id_invalid" }]);
  assert.match(calls[0].url, /include_retired=true/);
  assert.match(calls[1].url, /cursor=page-2/);

  const looping = client([{ body: { sources: [], next_cursor: "same" } }, { body: { sources: [], next_cursor: "same" } }]);
  await assert.rejects(looping.plugin.sources(), { code: "knowledge_plugin_response_invalid" });
});

test("an answer past the size limit is refused whether it declares its length or streams it", async () => {
  const declared = client([{ body: manifestBody(), headers: { "content-length": String(9 * 1024 * 1024) } }]);
  await assert.rejects(declared.plugin.manifest(), { code: "knowledge_plugin_response_too_large" });
  const streamed = client([{ body: JSON.stringify({ padding: "x".repeat(4096) }) }], { maxResponseBytes: 1024 });
  await assert.rejects(streamed.plugin.manifest(), { code: "knowledge_plugin_response_too_large" });
});

test("an entry's text keeps only the enrichment the contract names, and only http links", async () => {
  const { plugin, calls } = client([{ body: {
    entry_id: "nejm:0123", revision: 2, status: "available", text_kind: "abstract", abstract: "Background. 42% of patients.",
    fetched_from: "pubmed", fetched_at: "2026-09-22T03:00:00Z",
    enrichment: { publication_types: ["Randomized Controlled Trial"], open_access: "gold", oa_pdf_url: "javascript:x",
      impact_factor: 96.2, contact_email: "someone@example.org", trial_facts: { phase: "3", enrollment: 1200, secret: "x" } },
  } }]);
  const text = await plugin.text("nejm:0123");
  assert.match(calls[0].url, /\/v1\/entries\/nejm%3A0123\/text$/);
  assert.equal(text.status, "available");
  assert.deepEqual(text.enrichment, { publication_types: ["Randomized Controlled Trial"], open_access: "gold", impact_factor: 96.2,
    trial_facts: { phase: "3", enrollment: 1200 } });
  await assert.rejects(plugin.text("bad\u0000id"), { code: "knowledge_plugin_request_invalid" });
});

test("validateEntry names the first thing wrong with a row", () => {
  assert.equal(validateEntry(entry()).ok, true);
  assert.deepEqual(validateEntry(entry({ revision: 0 })), { ok: false, reason: "revision_invalid", entryId: entry().entry_id });
  assert.equal(validateEntry(entry({ first_seen_at: "yesterday-ish" })).reason, "first_seen_at_invalid");
  assert.equal(validateEntry(entry({ backfill: "no" })).reason, "backfill_invalid");
  assert.equal(validateEntry(entry({ summary: "x".repeat(20_001) })).reason, "summary_invalid");
  assert.equal(validateEntry(entry({ published_at: "not a date" })).entry.published_at, null, "an optional bad date is dropped, not fatal");
});

test("the enrichment whitelist is the contract's, key for key", async () => {
  // The normative contract, not a copy of it: a key the plugin team adds in a
  // minor version and this module forgets would be dropped from every text.
  const contract = YAML.parse(await readFile(new URL("../../../../docs/superpowers/specs/2026-09-21-medical-frontier-feed-assets/contract/knowledge-plugin-openapi.yaml", import.meta.url), "utf8"));
  const contractKeys = Object.keys(contract.components.schemas.EntryText.properties.enrichment.properties).sort();
  const complete = validateEnrichment({
    publication_types: ["Review"], mesh: ["Heart Failure"], journal: "NEJM", authors_short: "Smith J et al.", open_access: "green",
    oa_pdf_url: "https://example.org/x.pdf", impact_factor: 12.5, core_journal_tags: ["SCI"], preprint_of_doi: "10.1/a",
    published_version_doi: "10.1/b", trial_facts: { phase: "3" }, drug_label_excerpt: "Warnings.",
    affiliation_countries: ["cn", "US", "CN", "China", 7],
  });
  assert.deepEqual(Object.keys(complete).sort(), contractKeys);
  assert.deepEqual(complete.affiliation_countries, ["CN", "US"]);
  // The domain's list is the same list (package E holds that against the YAML too).
  assert.deepEqual([...FRONTIER_ENRICHMENT_KEYS].filter((key) => !contractKeys.includes(key)), []);
});

test("a key a later plugin declares passes through within bounds; an undeclared one never does", () => {
  const raw = {
    journal: "NEJM", evidence_grade: "B", guideline_count: 3, listed: true, sources: ["a", "b"], guide_url: "https://example.org/g",
    trial_registry: { id: "ChiCTR2600000001", phase: 3, open: false, deep: { x: 1 } },
    bad_url: "javascript:alert(1)", mixed: ["a", 1], nan: Number.NaN, blank: "  ", nested: [["x"]], contact_email: "someone@example.org",
  };
  const declared = ["journal", "evidence_grade", "guideline_count", "listed", "sources", "guide_url", "trial_registry", "bad_url", "mixed", "nan", "blank", "nested"];
  assert.deepEqual(validateEnrichment(raw, { declared }), {
    journal: "NEJM", evidence_grade: "B", guideline_count: 3, listed: true, sources: ["a", "b"], guide_url: "https://example.org/g",
    trial_registry: { id: "ChiCTR2600000001", phase: 3, open: false },
  });
  assert.deepEqual(validateEnrichment(raw), { journal: "NEJM" }, "before the manifest is read, only the contract's keys");
  const keys = Array.from({ length: 30 }, (_, index) => `new_key_${index}`);
  const many = validateEnrichment(Object.fromEntries(keys.map((key, index) => [key, index])), { declared: keys });
  assert.equal(Object.keys(many).length, 12, "at most twelve keys this build does not know");
  assert.equal(validateEnrichment({ long_text: "x".repeat(900) }, { declared: ["long_text"] }).long_text.length, 500, "cut, not refused");
});

test("the text step keeps what the manifest declared", async () => {
  const answer = { entry_id: "e1", revision: 1, status: "available", text_kind: "abstract", abstract: "An abstract.",
    enrichment: { journal: "NEJM", evidence_grade: "B", contact_email: "someone@example.org" } };
  const manifest = { ...manifestBody("1.1.0"), fields: { entry: ["summary"], enrichment: ["journal", "evidence_grade"] } };
  const { plugin } = client([{ body: answer }, { body: manifest }, { body: answer }]);
  assert.deepEqual((await plugin.text("e1")).enrichment, { journal: "NEJM" }, "before the manifest is read");
  await plugin.manifest();
  assert.deepEqual((await plugin.text("e1")).enrichment, { journal: "NEJM", evidence_grade: "B" });
});

// fr-social 2026-10-22: contract 1.5.0 — social posts, the full text, the providers and the media route.
test("contract 1.5.0: a post's channel, author, media, quote and counts are read; a field that breaks its shape is null alone", () => {
  const photo = { id: "b".repeat(64), kind: "image", width: 1200, height: 800, alt: "chart", original_url: "https://pbs.twimg.com/media/a.jpg" };
  const checked = validateEntry(entry({
    channel: "x", platform: "x",
    author: { name: "U.S. FDA", handle: "US_FDA", url: "https://x.com/US_FDA", role: "organisation", extra: "dropped" },
    media: [photo, { ...photo }, { id: "not-a-hash", kind: "image", original_url: "https://x/y.jpg" },
      { id: "c".repeat(64), kind: "video", original_url: "https://x/z.jpg" }, { id: "d".repeat(64), kind: "image", original_url: "javascript:alert(1)" }],
    quoted: { author: { name: "FDA Drug Info", handle: "FDA_Drug_Info" }, text: "Label update.", url: "https://x.com/FDA_Drug_Info/status/1", media: [photo] },
    metrics: { likes: 12, reposts: -1, replies: 3, views: 1.5, observed_at: "2026-10-22T06:00:00Z" },
  }));
  assert.ok(checked.ok);
  const value = checked.entry;
  assert.equal(value.channel, "x");
  assert.deepEqual(value.author, { name: "U.S. FDA", handle: "US_FDA", url: "https://x.com/US_FDA", role: "organisation" });
  assert.deepEqual(value.media, [photo], "a duplicate, a bad id, an unknown kind and a non-http original are dropped one by one");
  assert.equal(value.quoted.author.handle, "FDA_Drug_Info");
  assert.deepEqual(value.quoted.media, [photo]);
  assert.deepEqual(value.metrics, { likes: 12, reposts: null, replies: 3, views: null, observed_at: "2026-10-22T06:00:00.000Z" },
    "a count that is not a count is unknown, never zero");
  const old = validateEntry(entry()).entry;
  assert.deepEqual([old.channel, old.platform, old.author, old.media, old.quoted, old.metrics], [null, null, null, [], null, null],
    "an entry from before 1.5.0 reads with every new field absent");
  const broken = validateEntry(entry({ author: { handle: "nameless" }, quoted: { text: "no author", url: "https://x.com/a" }, metrics: { likes: 3 } })).entry;
  assert.deepEqual([broken.author, broken.quoted, broken.metrics], [null, null, null]);
});

test("contract 1.5.0: the text carries the full body within its bound; health names providers and discovery", async () => {
  const body = "First paragraph.\n\nSecond.";
  const { plugin } = client([
    { body: { entry_id: "x-us_fda:1", revision: 1, status: "available", text_kind: "full", body_excerpt: body, body_text: body, fetched_from: "x" } },
    { body: { entry_id: "x-us_fda:2", revision: 1, status: "available", text_kind: "full", body_excerpt: "head", body_text: "x".repeat(40_001) } },
    { body: { status: "ok", contract: "1.5.0", sources: {}, egress: {}, latest_seq: 9,
      providers: [{ name: "dajiala", calls_24h: 3, spend_24h: { amount: 0.42, currency: "CNY" }, spend_today: { amount: 0.42, currency: "CNY" },
        daily_cap: { amount: 30, currency: "CNY" }, remaining: { amount: 29.58, currency: "CNY" } },
      { name: "socialdata", calls_24h: 1, spend_24h: { amount: -1, currency: "USD" }, last_error: "http_402" }, { calls_24h: 1 }],
      discovery: { today: { day: "2026-10-22", candidates: 80, validated: 30, trial: 12, admitted: 10, retired: 2, failed: 5 },
        history: [{ day: "2026-10-21", candidates: 70, validated: 20, trial: 9, admitted: 8, retired: 1, failed: 4 }],
        by_line: { "journal-lists": { candidates: 40, validated: 20, trial: 8, admitted: 6, retired: 0, failed: 2 }, "BAD LINE": {} },
        in_trial: 33 } } },
    { body: { status: "ok", contract: "1.4.0", sources: {}, egress: {} } },
  ]);
  const text = await plugin.text("x-us_fda:1");
  assert.equal(text.body_text, body);
  const tooLong = await plugin.text("x-us_fda:2");
  assert.equal(tooLong.body_text, null, "a body past the contract's bound is refused, not cut and passed off as whole");
  assert.equal(tooLong.body_excerpt, "head");
  const health = await plugin.health();
  assert.deepEqual(health.providers.map((row) => row.name), ["dajiala", "socialdata"], "a provider without a name is left out");
  assert.deepEqual(health.providers[0].remaining, { amount: 29.58, currency: "CNY" });
  assert.equal(health.providers[1].spend_24h, null, "a negative amount is no amount");
  assert.equal(health.providers[1].last_error, "http_402");
  assert.equal(health.discovery.today.admitted, 10);
  assert.equal(health.discovery.history.length, 1);
  assert.deepEqual(Object.keys(health.discovery.by_line), ["journal-lists"]);
  assert.equal(health.discovery.in_trial, 33);
  const older = await plugin.health();
  assert.equal(older.providers, null, "a plugin of an older minor says nothing about providers: absent, not empty");
  assert.equal(older.discovery, null);
});

test("contract 1.5.0: media is read as bytes with its type, an unknown id is not found, and a non-image is refused", async () => {
  const id = "e".repeat(64);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const calls = [];
  const answers = [
    () => new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg", etag: `"${id}"` } }),
    () => new Response(JSON.stringify({ code: "not_found", message: "no such media", retryable: false }), { status: 404, headers: { "content-type": "application/json" } }),
    () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
  ];
  const plugin = new KnowledgePluginClient({ baseUrl: "http://plugin.test:8080", tokenFile, sleep: async () => {},
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return answers.shift()(); } });
  const media = await plugin.media(id);
  assert.equal(media.contentType, "image/jpeg");
  assert.ok(media.body.equals(jpeg));
  assert.equal(media.etag, id);
  assert.equal(calls[0].url, `http://plugin.test:8080/v1/media/${id}`);
  assert.equal(calls[0].init.headers.authorization, "Bearer test-only-token-one");
  await assert.rejects(plugin.media("f".repeat(64)), { code: "knowledge_plugin_not_found" });
  await assert.rejects(plugin.media(id), { code: "knowledge_plugin_response_invalid" });
  await assert.rejects(plugin.media("../etc/passwd"), { code: "knowledge_plugin_not_found" });
  assert.equal(calls.length, 3, "an id that is not a sha256 never leaves the platform");
});
