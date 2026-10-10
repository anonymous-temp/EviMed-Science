// The wish list the knowledge-source plugin pulls (`GET /evolution/source-requests.json`): it asks for what the platform filed and for nothing else.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AI_DISCOVERY_SOURCE_REQUESTS, SOURCE_REQUEST_HOSTS, SOURCE_REQUEST_LIMIT, createEvolutionSourceRequests, evolutionSourceRequestManifest, feedKindOf, normalizeFeedUrl, requestRow,
} from "../src/evolutionSourceRequests.mjs";
import { EvolutionWorker } from "../src/evolutionWorker.mjs";
import { evolutionServiceFixture } from "./helpers/evolutionServiceFixture.mjs";

test("the manifest no longer asks for the single arXiv query: the plugin's registry carries the set it grew into", async () => {
  assert.deepEqual([...AI_DISCOVERY_SOURCE_REQUESTS], [], "a request for a row the registry has dropped would admit the old query again beside the new rows");
  assert.deepEqual(await evolutionSourceRequestManifest(null), { schemaVersion: 1, sources: [] });
  assert.deepEqual(await evolutionSourceRequestManifest({ list: async () => [] }), { schemaVersion: 1, sources: [] });
});

test("what the platform filed is served, in the order it was filed, and nothing that is not public or not waiting", async () => {
  const filed = (/** @type {string} */ id, /** @type {any} */ over = {}) => ({ payload: { public: true, status: "requested", source: { id }, ...over } });
  const service = { list: async (/** @type {string} */ kind) => (kind === "source-request"
    ? [filed("ai-discovery-req-000000000001"), filed("ai-discovery-req-000000000002", { status: "admitted" }), filed("ai-discovery-req-000000000003", { public: false }), filed("ai-discovery-req-000000000004")] : []) };
  assert.deepEqual((await evolutionSourceRequestManifest(service)).sources.map((/** @type {any} */ source) => source.id), ["ai-discovery-req-000000000001", "ai-discovery-req-000000000004"]);
  const many = { list: async () => Array.from({ length: 40 }, (_, index) => filed(`ai-discovery-req-${String(index).padStart(12, "0")}`)) };
  assert.equal((await evolutionSourceRequestManifest(many)).sources.length, 25, "the plugin reads at most twenty-five");
});

// ---- the writer (E12g): what the scout suggests, checked exactly, filed once, kept until the plugin has it -----------------------------------------------------------

const atomFeed = readFileSync(new URL("./fixtures/evolution/arxiv-atom-query.xml", import.meta.url), "utf8");
// Minimal RSS 2.0, written for the test (the Atom answer above is the recorded one).
const rssFeed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Volumes</title><item><title>v306</title><link>https://proceedings.mlr.press/v306</link></item></channel></rss>`;
const ARXIV_FEED = "https://export.arxiv.org/api/query?search_query=abs:%22test-time+training%22+AND+cat:cs.LG&sortOrder=descending&sortBy=submittedDate&max_results=100#frag";
const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../项目代码/knowledge-plugin/knowledge_plugin/source_requests.py");

/** A fetch that answers per address and remembers what it was asked. */
function network(/** @type {Record<string, () => Response>} */ answers) {
  /** @type {string[]} */
  const asked = [];
  const fetchImpl = /** @type {typeof fetch} */ (async (/** @type {any} */ url) => {
    asked.push(String(url));
    const answer = answers[String(url)] ?? answers["*"];
    if (!answer) throw new TypeError("network unreachable");
    return answer();
  });
  return { asked, fetchImpl };
}
const feedResponse = (/** @type {string} */ body, status = 200) => () => new Response(body, { status, headers: { "content-type": "application/atom+xml" } });

function writer(/** @type {Record<string, any>} */ over = {}) {
  const { service, rows, advance } = evolutionServiceFixture();
  const net = network({ "*": feedResponse(atomFeed) });
  const requests = createEvolutionSourceRequests({ service, fetchImpl: net.fetchImpl, lapseDays: 30, ...over });
  return { requests, service, rows, advance, net };
}

test("a feed address is one form: https, no credentials, no fragment, a fixed query order; anything else is none", () => {
  assert.equal(normalizeFeedUrl(ARXIV_FEED)?.href, "https://export.arxiv.org/api/query?max_results=100&search_query=abs%3A%22test-time+training%22+AND+cat%3Acs.LG&sortBy=submittedDate&sortOrder=descending");
  assert.equal(normalizeFeedUrl("https://proceedings.mlr.press:443/feed.xml#top")?.href, "https://proceedings.mlr.press/feed.xml");
  // The address with credentials in it is assembled here so that no credential-shaped literal is in the file.
  const withCredentials = ["https://operator", "placeholder@proceedings.mlr.press/feed.xml"].join(":");
  for (const refused of ["http://proceedings.mlr.press/feed.xml", withCredentials, "https://proceedings.mlr.press:8443/feed.xml", "ftp://x/y", "not a url", "", null, 7, `https://x.org/${"a".repeat(2100)}`]) {
    assert.equal(normalizeFeedUrl(refused), null, String(refused));
  }
});

test("a feed is an RSS or Atom document with entries in it, which is a format", () => {
  assert.equal(feedKindOf(atomFeed), "atom");
  assert.equal(feedKindOf(rssFeed), "rss");
  assert.equal(feedKindOf(`<?xml version="1.0"?><rdf:RDF xmlns:rdf="x"><item><title>x</title></item></rdf:RDF>`), "rss");
  assert.equal(feedKindOf("<html><head><title>A page</title></head><body><item>x</item></body></html>"), null, "a page that merely mentions an item");
  assert.equal(feedKindOf(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>empty</title></feed>`), null, "a feed with nothing in it");
  assert.equal(feedKindOf(""), null);
});

test("the row filed is every field the plugin checks, from closed values: the same literal the plugin's own test admits", () => {
  const row = requestRow({ name: "arXiv · test-time training", url: /** @type {URL} */ (normalizeFeedUrl(ARXIV_FEED)), access: "atom" });
  assert.deepEqual(row, ARXIV_ROW);
  assert.ok(row.id.startsWith("ai-discovery-req-"), "the prefix is what makes the medical feed drop what it brings");
  const mlr = requestRow({ name: "PMLR volumes", url: /** @type {URL} */ (normalizeFeedUrl("https://proceedings.mlr.press/feed.xml")), access: "rss" });
  assert.deepEqual([mlr.source_type, mlr.config.allowed_hosts, "arxiv_comment" in mlr.config], ["journal", ["proceedings.mlr.press"], false]);
  assert.equal(new URL(row.config.url).hostname, row.config.allowed_hosts[0]);
  assert.ok(SOURCE_REQUEST_HOSTS.includes(row.config.allowed_hosts[0]));
});

const ARXIV_ROW = { id: "ai-discovery-req-eb3e36c3b57c", name: "arXiv · test-time training", homepage: "https://export.arxiv.org/", lane: "ai", source_type: "preprint", access: "atom",
  egress: "direct", authority: 2, safety_feed: false, owner_entity: "export.arxiv.org", launch_tier: "P0", language: "en", poll_floor_s: 21600, poll_ceiling_s: 129600, category: "ai-discovery",
  config: { url: "https://export.arxiv.org/api/query?max_results=100&search_query=abs%3A%22test-time+training%22+AND+cat%3Acs.LG&sortBy=submittedDate&sortOrder=descending", max_pages: 1,
    allowed_hosts: ["export.arxiv.org"], discovery_only: true, arxiv_comment: true } };

test("the hosts and readers the plugin admits are the ones asked for", { skip: !existsSync(plugin) && "the plugin is not in this checkout" }, () => {
  const source = readFileSync(plugin, "utf8");
  const hosts = [...(/DISCOVERY_HOSTS\s*=\s*frozenset\(\{([^}]*)\}\)/s.exec(source)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...SOURCE_REQUEST_HOSTS].sort(), hosts.sort(), "a host on one list only is a request that is never admitted, or an admission nobody asks for");
  assert.match(source, /not in \{"rss", "atom", "html-list", "json-api"\} or row\.get\("egress"\) != "direct"/, "rss and atom are readers the plugin admits, on the direct exit");
  assert.match(source, /\[:25\]/, "the plugin reads at most twenty-five");
  assert.equal(SOURCE_REQUEST_LIMIT, 25);
});

test("a feed the scout found is checked, filed once, and served to the plugin", async () => {
  const { requests, net, service } = writer();
  const outcomes = await requests.file([{ name: "arXiv · test-time training", url: ARXIV_FEED, why: "Several of this week's tool papers were found through it." }], { kind: "scout", ref: "job-1" });
  assert.deepEqual(outcomes, [{ outcome: "filed", id: ARXIV_ROW.id }]);
  assert.deepEqual(net.asked, [ARXIV_ROW.config.url], "the feed is read once, at the address that is filed");
  const [record] = await service.list("source-request");
  assert.deepEqual([record.payload.public, record.payload.status, record.payload.origin, record.payload.why], [true, "requested", { kind: "scout", ref: "job-1" }, "Several of this week's tool papers were found through it."]);
  assert.deepEqual(record.payload.source, ARXIV_ROW);
  assert.deepEqual((await evolutionSourceRequestManifest(service)).sources, [ARXIV_ROW]);
  assert.equal(requests.counters.filed, 1);
  assert.equal(requests.counters.waiting, 1);
  // The same feed again, even written differently, is not filed twice and is not read again.
  const again = await requests.file([{ name: "Same feed, other words", url: "https://export.arxiv.org/api/query?sortOrder=descending&search_query=abs:%22test-time+training%22+AND+cat:cs.LG&sortBy=submittedDate&max_results=100" }]);
  assert.deepEqual(again, [{ outcome: "duplicate" }]);
  assert.equal(net.asked.length, 1);
  assert.equal((await service.list("source-request")).length, 1);
});

test("what cannot be filed is counted by its reason and never fails the caller", async () => {
  const net = network({ "https://proceedings.mlr.press/page": feedResponse("<html><body>a page</body></html>"), "https://proceedings.mlr.press/gone": feedResponse("gone", 404),
    "https://proceedings.mlr.press/huge": feedResponse(`<rss><item>${"x".repeat(2 * 1024 * 1024 + 10)}</item></rss>`), "https://proceedings.mlr.press/feed.xml": feedResponse(rssFeed) });
  const { requests, service } = writer({ fetchImpl: net.fetchImpl });
  const outcomes = await requests.file([
    { name: "A page, not a feed", url: "https://proceedings.mlr.press/page" },
    { name: "Gone", url: "https://proceedings.mlr.press/gone" },
    { name: "A volume feed", url: "https://proceedings.mlr.press/feed.xml" },
    { name: "A fourth suggestion is not read", url: "https://proceedings.mlr.press/huge" },
  ]);
  assert.deepEqual(outcomes.map(item => item.outcome), ["notAFeed", "unreachable", "filed"], "three suggestions a card, in the order given");
  const more = await requests.file([
    { name: "Not a host the plugin takes", url: "https://example.org/feed.xml" },
    { name: "x", url: "https://proceedings.mlr.press/feed.xml" },
    { name: "A name without an address", url: "http://proceedings.mlr.press/feed.xml" }]);
  assert.deepEqual(more.map(item => item.outcome), ["unsupportedHost", "invalid", "invalid"]);
  assert.deepEqual((await requests.file([{ name: "Too large", url: "https://proceedings.mlr.press/huge" }])).map(item => item.outcome), ["notAFeed"], "a body past the bound is no feed");
  assert.equal(net.asked.includes("https://example.org/feed.xml"), false, "a host the plugin does not take is not even read");
  assert.deepEqual(await requests.file("not a list"), []);
  assert.deepEqual(await requests.file([null, 7, {}]), [{ outcome: "invalid" }, { outcome: "invalid" }, { outcome: "invalid" }]);
  assert.equal((await service.list("source-request")).length, 1);
  assert.equal(requests.counters.notAFeed, 2);
  assert.equal(requests.counters.unreachable, 1);
  assert.equal(requests.counters.unsupportedHost, 1);
});

test("a feed that moves is followed on its own host and nowhere else, and one that never answers is unreachable", async () => {
  const hop = (/** @type {string} */ to) => () => new Response(null, { status: 301, headers: { location: to } });
  const { requests, service } = writer({ fetchImpl: network({
    "https://proceedings.mlr.press/old.xml": hop("/feed.xml"), "https://proceedings.mlr.press/feed.xml": feedResponse(rssFeed),
    "https://proceedings.mlr.press/away.xml": hop("https://example.org/feed.xml"), "https://proceedings.mlr.press/loop.xml": hop("/loop.xml") }).fetchImpl });
  const outcomes = await requests.file([{ name: "Moved feed", url: "https://proceedings.mlr.press/old.xml" }, { name: "Away feed", url: "https://proceedings.mlr.press/away.xml" },
    { name: "Looping feed", url: "https://proceedings.mlr.press/loop.xml" }]);
  assert.deepEqual(outcomes.map(item => item.outcome), ["filed", "unreachable", "unreachable"]);
  assert.equal((await service.list("source-request"))[0].payload.source.config.url, "https://proceedings.mlr.press/old.xml", "the address filed is the one the scout named");
});

test("there is room for twenty-five, and the twenty-sixth is counted and not filed", async () => {
  const { requests, service } = writer({ fetchImpl: network({ "*": feedResponse(rssFeed) }).fetchImpl });
  for (let index = 0; index < SOURCE_REQUEST_LIMIT; index += 1) {
    assert.equal((await requests.file([{ name: `Volume feed ${index}`, url: `https://proceedings.mlr.press/v${index}/feed.xml` }]))[0].outcome, "filed", String(index));
  }
  assert.deepEqual(await requests.file([{ name: "One too many", url: "https://proceedings.mlr.press/last/feed.xml" }]), [{ outcome: "capReached" }]);
  assert.equal(requests.counters.capReached, 1);
  assert.equal((await evolutionSourceRequestManifest(service)).sources.length, 25);
});

test("a request leaves the list when the plugin has taken it, or has not in thirty days; a plugin that cannot be asked takes nothing", async () => {
  const mirror = { ids: /** @type {string[]} */ ([]), broken: false };
  const { requests, service, advance } = writer({ fetchImpl: network({ "*": feedResponse(rssFeed) }).fetchImpl,
    sources: async () => { if (mirror.broken) throw new Error("mirror unavailable"); return mirror.ids.map(id => ({ id, name: id })); } });
  await requests.file([{ name: "Taken soon", url: "https://proceedings.mlr.press/a/feed.xml" }, { name: "Never taken", url: "https://proceedings.mlr.press/b/feed.xml" }, { name: "Taken later", url: "https://proceedings.mlr.press/c/feed.xml" }]);
  const ids = (await service.list("source-request")).map(row => row.payload.source.id);
  assert.equal(ids.length, 3);
  mirror.broken = true;
  assert.deepEqual(await requests.reconcile(), { admitted: 0, lapsed: 0 });
  mirror.broken = false;
  mirror.ids = [ids[0]];
  assert.deepEqual(await requests.reconcile(), { admitted: 1, lapsed: 0 });
  assert.deepEqual((await evolutionSourceRequestManifest(service)).sources.map(source => source.id), [ids[1], ids[2]], "the one the plugin took is no longer asked for");
  advance(29 * 86_400_000);
  mirror.ids = [ids[0], ids[2]];
  assert.deepEqual(await requests.reconcile(), { admitted: 1, lapsed: 0 }, "on the twenty-ninth day the one the plugin has not taken still waits");
  advance(2 * 86_400_000);
  assert.deepEqual(await requests.reconcile(), { admitted: 0, lapsed: 1 });
  assert.deepEqual((await evolutionSourceRequestManifest(service)).sources, []);
  assert.deepEqual(Object.fromEntries((await service.list("source-request")).map(row => [row.payload.source.id, row.payload.status])), { [ids[0]]: "admitted", [ids[1]]: "lapsed", [ids[2]]: "admitted" });
  assert.deepEqual([requests.counters.admitted, requests.counters.lapsed, requests.counters.waiting], [2, 1, 0]);
  assert.deepEqual(await requests.reconcile(), { admitted: 0, lapsed: 0 });
  // A place freed is a place to ask in again, and what lapsed is not asked for again by the same address either.
  assert.equal((await requests.file([{ name: "Taken soon, again", url: "https://proceedings.mlr.press/a/feed.xml" }]))[0].outcome, "duplicate");
});

test("what the scout is told: the sources already read, by name, and the hosts a request may name", async () => {
  const { requests } = writer({ sources: async () => [{ id: "ai-discovery-hf-blog", name: "Hugging Face · blog" }, { id: "openai-news", name: "OpenAI news" }] });
  assert.deepEqual(await requests.catalogue(), { sources: [{ id: "ai-discovery-hf-blog", name: "Hugging Face · blog" }, { id: "openai-news", name: "OpenAI news" }], hosts: [...SOURCE_REQUEST_HOSTS] });
  const lost = writer({ sources: async () => { throw new Error("mirror unavailable"); } });
  assert.deepEqual((await lost.requests.catalogue()).sources, []);
});

test("the worker comes round to the list every six hours, and not twice inside them", async () => {
  /** @type {string[]} */
  const calls = [];
  let time = new Date("2026-10-06T04:00:00Z");
  const worker = new EvolutionWorker({ service: { config: {}, callbacks: { reconcileSourceRequests: async () => { calls.push("reconcile"); } }, now: () => time, owner: async () => "operator", reconcileQueued: async () => {},
    tools: async () => [], list: async () => [], get: async () => null, save: async () => {}, enqueue: async () => {}, ingestEvent: async () => {}, notifications: { preferences: async () => ({ digestTime: "08:00" }) } }, config: {} });
  await worker.housekeeping();
  assert.deepEqual(calls, ["reconcile"]);
  time = new Date("2026-10-06T09:59:00Z");
  await worker.housekeeping();
  assert.deepEqual(calls, ["reconcile"], "inside six hours it repeats nothing");
  time = new Date("2026-10-06T10:01:00Z");
  await worker.housekeeping();
  assert.deepEqual(calls, ["reconcile", "reconcile"]);
});
