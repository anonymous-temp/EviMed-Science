/**
 * The knowledge-source plugin's contract test (`deps-version.json` →
 * `knowledge-plugin`).
 *
 * Hidden knowledge: what has to hold before this pin may move.
 *
 * - What the platform pins is the contract (`knowledge-plugin-openapi.yaml`),
 *   not a plugin build: the plugin is the plugin team's service, released on
 *   its own cadence, and the platform consumes whatever build speaks a
 *   compatible contract. So the pin's derived copies are the vendored YAML, the
 *   recorded fixtures and the platform's minimum contract, and this file holds
 *   each of them to it.
 * - Every fixture was recorded off a live plugin by `fixtures/record.mjs` (see
 *   `fixtures/provenance.json`) and is served here over real HTTP to the real
 *   client (`apps/server/src/knowledgePluginClient.mjs`), so a parse that only
 *   works on a hand-shaped object fails here. Samples must come off the wire,
 *   never be written by hand: a hand-written wire fixture once certified a
 *   shape the wire never produced and defeated the audit that depended on it.
 *   Two tests serve a recorded answer to a request other than the one that
 *   produced it, and say so where they do: the registry pages were recorded for
 *   one lane so the whole walk fits in two pages, and the plugin's refusal of a
 *   negative cursor is served to a request the client can send at all.
 * - The identity ladder (contract rule 3) is what turns cross-source merging
 *   into a table lookup on the platform side. The sample set in
 *   `fixtures/identity-keys.json` is derived from recorded entries; this test
 *   derives it again, checks each key stands on the highest rung its inputs
 *   allow, and checks that the platform's own key derivation
 *   (`entryKeys` in `frontierPipeline.mjs`) produces the same key — two sides
 *   spelling one DOI differently would merge nothing and say nothing.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FRONTIER_ACCESSES, FRONTIER_DATE_PRECISIONS, FRONTIER_EGRESSES, FRONTIER_ENRICHMENT_KEYS, FRONTIER_ENTRY_DEFECTS,
  FRONTIER_FACT_KEYS, FRONTIER_HEALTH_STATES, FRONTIER_LAUNCH_TIERS, FRONTIER_SOURCE_LANES, FRONTIER_SOURCE_TYPES,
  FRONTIER_TEXT_STATUSES, doiOf,
} from "@evimed/domain";
import { loadConfig } from "../../../apps/server/src/config.mjs";
import { entryKeys } from "../../../apps/server/src/frontierPipeline.mjs";
import { KnowledgePluginClient, contractCompatible, parseContractVersion, validateEntry }
  from "../../../apps/server/src/knowledgePluginClient.mjs";
import { ENTRY_PAGE, IDENTITY_LADDER, SOURCE_PAGE, identityInputs } from "./fixtures/record.mjs";

const root = new URL("../../../", import.meta.url);
const workspace = new URL("../../../../", import.meta.url);
const deps = JSON.parse(await readFile(new URL("deps-version.json", root), "utf8"));
const pin = deps["knowledge-plugin"];
const provenance = JSON.parse(await readFile(new URL("./fixtures/provenance.json", import.meta.url), "utf8"));
const identitySamples = JSON.parse(await readFile(new URL("./fixtures/identity-keys.json", import.meta.url), "utf8"));
/** @param {string} name */
const fixtureBytes = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url));
/** @param {string} name */
const fixture = async (name) => JSON.parse((await fixtureBytes(name)).toString("utf8"));
const sha256 = (/** @type {string} */ value) => createHash("sha256").update(value).digest("hex");
const TOKEN = "replay-token-for-the-contract-test";

/** Every fixture the tests below replay; the walk must prove it walked. */
const REPLAYED = ["health.json", "manifest.json", "sources-page-1.json", "sources-page-2.json", "entries-page-1.json",
  "entries-page-2.json", "entries-tail.json", "identity-doi-pmid-registry.json", "identity-doi.json", "identity-pmid.json",
  "identity-reg.json", "identity-fda.json", "identity-url.json", "text-available.json", "text-pending.json", "lookups.json",
  "lookup-unavailable.json", "error-unauthorized.json", "error-not-found.json", "error-invalid-cursor.json"];

/** A recorded answer as the plugin gave it: its status, its content type and the body bytes. @param {string} name */
async function recorded(name) {
  const entry = provenance.fixtures[name];
  assert.ok(entry, `${name} is not listed in provenance.json`);
  return { status: entry.status, headers: { "content-type": entry.headers["content-type"] }, body: await fixtureBytes(name) };
}

/**
 * Serve recorded answers over real HTTP, keyed by `METHOD url` exactly as the
 * client sends it, and record what the client sent. An unexpected request is
 * answered 599 so it can never pass for a recorded one.
 * @param {Record<string, { status: number, headers: Record<string, string>, body: Buffer }>} routes
 * @param {(context: { client: KnowledgePluginClient, seen: { method: string, url: string, headers: http.IncomingHttpHeaders, body: string }[] }) => Promise<void>} run
 * @param {Record<string, any>} [options] client options
 */
async function withPlugin(routes, run, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "knowledge-plugin-contract-"));
  const tokenFile = path.join(directory, "token");
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  /** @type {{ method: string, url: string, headers: http.IncomingHttpHeaders, body: string }[]} */
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: String(request.method), url: String(request.url), headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      const route = routes[`${request.method} ${request.url}`];
      if (!route) { response.writeHead(599); response.end(); return; }
      response.writeHead(route.status, route.headers);
      response.end(route.body);
    });
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", () => resolve(undefined)); });
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  try {
    const client = new KnowledgePluginClient({ baseUrl: `http://127.0.0.1:${address.port}`, tokenFile, timeoutMs: 5_000,
      minContract: pin.version.split(".").slice(0, 2).join("."), sleep: async () => {}, ...options });
    await run({ client, seen });
  } finally {
    await new Promise((resolve) => { server.close(() => resolve(undefined)); });
    await rm(directory, { recursive: true, force: true });
  }
}

/** The path a fixture was recorded at. @param {string} name */
const recordedPath = (name) => provenance.fixtures[name].request.path;

test("the pin is the contract, written once, with its directory and the reason it is what it is", async () => {
  assert.ok(pin, "knowledge-plugin is missing from deps-version.json");
  assert.match(pin.version, /^\d+\.\d+\.\d+$/, "a pin is an exact contract version");
  assert.equal(pin.contractDir, "packages/contracts/knowledge-plugin");
  assert.equal(pin.contractFile, `${pin.contractDir}/knowledge-plugin-openapi.yaml`);
  assert.ok(String(pin.notes ?? "").length > 200, "a pin carries the reason it is what it is");
  assert.match(pin.notes, /contract major/, "the notes say the platform checks the contract major");
  const yaml = await readFile(new URL(pin.contractFile, root), "utf8");
  assert.equal(/^info:\n(?:  .*\n)*?  version: "([^"]+)"$/m.exec(yaml)?.[1], pin.version, "the vendored contract is the pinned version");
});

test("the vendored contract is the canonical one in the plan's assets, byte for byte", async () => {
  const canonical = await readFile(new URL("docs/superpowers/specs/2026-09-21-medical-frontier-feed-assets/contract/knowledge-plugin-openapi.yaml", workspace));
  const vendored = await readFile(new URL(pin.contractFile, root));
  assert.ok(canonical.length > 10_000, "the canonical contract was read, not an empty file");
  assert.ok(vendored.equals(canonical), "re-vendor the contract: copy the canonical file over packages/contracts/knowledge-plugin/");
  // The plugin keeps its own copy while it lives in this repository; once it
  // moves to the team's own repository this comparison has nothing to read.
  const pluginCopy = new URL("项目代码/knowledge-plugin/contract/knowledge-plugin-openapi.yaml", workspace);
  if (await access(pluginCopy).then(() => true, () => false)) {
    assert.ok((await readFile(pluginCopy)).equals(canonical), "the plugin serves a contract other than the one the platform pins");
  }
});

test("the fixtures were recorded off a live plugin speaking the pinned contract", async () => {
  assert.equal(provenance.contractVersion, pin.version);
  assert.equal(provenance.plugin?.name, "evimed-knowledge-plugin");
  assert.match(String(provenance.plugin?.version), /^\d+\.\d+\.\d+/);
  assert.ok(String(provenance.plugin?.build ?? "").length > 0, "the build the fixtures came off is named");
  assert.ok(Number.isFinite(Date.parse(provenance.recordedAt)));
  assert.equal((await fixture("manifest.json")).contract.version, pin.version);
  assert.equal((await fixture("health.json")).contract, pin.version);
  assert.deepEqual(REPLAYED.filter((name) => !provenance.fixtures[name]), [], "every replayed fixture is a listed recording");
  for (const [name, entry] of Object.entries(provenance.fixtures)) {
    assert.ok((await fixtureBytes(name)).length > 0, `${name} is listed but empty`);
    assert.equal(Object.keys(entry.request.headers).some((header) => header.toLowerCase() === "authorization"), false,
      `${name} kept an Authorization header`);
    assert.ok(["none", "the deployment token", "a token the plugin never issued"].includes(entry.request.credential), name);
  }
});

test("the platform's minimum contract accepts the pin, and a plugin of another major is refused", async () => {
  const minimum = loadConfig().knowledgePluginMinContract;
  assert.ok(contractCompatible(pin.version, minimum), `the default minimum ${minimum} refuses the pinned contract ${pin.version}`);
  assert.equal(parseContractVersion(minimum)?.major, parseContractVersion(pin.version)?.major,
    "moving the pin's major moves OPEN_SCIENCE_KNOWLEDGE_PLUGIN_MIN_CONTRACT's default with it");
  // The mutation control: the recorded manifest, its contract bumped a major.
  // Not a fixture — the recorded file is untouched — but the one derived input
  // that shows the client refusing what rule 1 no longer covers.
  const manifest = await fixture("manifest.json");
  const next = `${parseContractVersion(pin.version).major + 1}.0.0`;
  const mutated = Buffer.from(JSON.stringify({ ...manifest, contract: { version: next } }));
  await withPlugin({ "GET /v1/manifest": { status: 200, headers: { "content-type": "application/json" }, body: mutated } }, async ({ client }) => {
    const answered = await client.manifest();
    assert.equal(answered.compatible, false);
    assert.throws(() => client.assertCompatible(answered), { code: "knowledge_plugin_incompatible" });
  }, { minContract: minimum });
});

test("health, as the plugin answers it, reads as ok and is sent no credential", async () => {
  const body = await fixture("health.json");
  await withPlugin({ "GET /v1/health": await recorded("health.json") }, async ({ client, seen }) => {
    const health = await client.health();
    assert.equal(health.status, "ok");
    assert.equal(health.contract, pin.version);
    assert.equal(health.compatible, true);
    assert.equal(health.latest_seq, body.latest_seq);
    assert.deepEqual(health.sources, body.sources);
    assert.equal(seen[0].headers.authorization, undefined, "the health route takes no credential and is sent none");
  });
});

test("the manifest names the contract, and every vocabulary value it uses is one the platform knows", async () => {
  const body = await fixture("manifest.json");
  await withPlugin({ "GET /v1/manifest": await recorded("manifest.json") }, async ({ client, seen }) => {
    const manifest = await client.manifest();
    assert.equal(manifest.plugin.name, "evimed-knowledge-plugin");
    assert.equal(manifest.plugin.version, provenance.plugin.version);
    assert.equal(manifest.contract.version, pin.version);
    assert.equal(manifest.compatible, true);
    assert.equal(manifest.capabilities.stream, true);
    assert.equal(manifest.capabilities.text, true);
    assert.deepEqual(manifest.capabilities.lookups, body.capabilities.lookups);
    assert.equal(manifest.oldest_seq_available, body.oldest_seq_available);
    assert.equal(manifest.sources.total, body.sources.total);
    for (const [name, known] of [["lane", FRONTIER_SOURCE_LANES], ["source_type", FRONTIER_SOURCE_TYPES],
      ["egress", FRONTIER_EGRESSES], ["access", FRONTIER_ACCESSES]]) {
      assert.ok(manifest.vocabularies[name].length > 0, `the manifest lists its ${name} values`);
      assert.deepEqual(manifest.vocabularies[name].filter((value) => !known.includes(value)), [], `${name} values the platform does not know`);
    }
    assert.deepEqual(manifest.fields.facts.filter((key) => !FRONTIER_FACT_KEYS.includes(key)), []);
    assert.deepEqual(manifest.fields.enrichment.filter((key) => !FRONTIER_ENRICHMENT_KEYS.includes(key)), []);
    assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`, "the token file's value, read per call");
  });
});

test("the registry walk follows next_cursor to its end and keeps every recorded row", async () => {
  const pages = Object.keys(provenance.fixtures).filter((name) => /^sources-page-\d+\.json$/.test(name)).sort();
  assert.ok(pages.length >= 2, "the recording exercises paging");
  const routes = {};
  let rows = 0;
  for (const name of pages) {
    // Recorded for one lane so the walk fits in two pages; the client asks
    // for the whole registry, so its unfiltered request gets the lane's page.
    const url = recordedPath(name).replace(/lane=[^&]+&/, "");
    routes[`GET ${url}`] = await recorded(name);
    rows += (await fixture(name)).sources.length;
  }
  await withPlugin(routes, async ({ client, seen }) => {
    const { sources, skipped } = await client.sources({ limit: SOURCE_PAGE });
    assert.deepEqual(skipped, [], "every recorded row passes the client's shape check");
    assert.equal(sources.length, rows);
    assert.equal(seen.length, pages.length, "one request per page, and none after next_cursor ran out");
    assert.equal(new URL(seen[1].url, "http://x").searchParams.get("cursor"), (await fixture(pages[0])).next_cursor);
    for (const source of sources) {
      assert.ok(FRONTIER_SOURCE_LANES.includes(source.lane), `${source.id}: lane ${source.lane}`);
      assert.ok(FRONTIER_SOURCE_TYPES.includes(source.source_type), `${source.id}: source_type ${source.source_type}`);
      assert.ok(FRONTIER_ACCESSES.includes(source.access), `${source.id}: access ${source.access}`);
      assert.ok(FRONTIER_EGRESSES.includes(source.egress), `${source.id}: egress ${source.egress}`);
      assert.ok(FRONTIER_HEALTH_STATES.includes(source.health), `${source.id}: health ${source.health}`);
      assert.ok(FRONTIER_LAUNCH_TIERS.includes(source.launch_tier), `${source.id}: launch_tier ${source.launch_tier}`);
      assert.ok(source.owner_entity && Number.isInteger(source.authority), `${source.id} lost a required field`);
    }
  });
});

test("the stream ascends by seq, says has_more until the tail, and every entry passes the client's shape check", async () => {
  const first = await fixture("entries-page-1.json");
  const second = await fixture("entries-page-2.json");
  const routes = {};
  for (const name of ["entries-page-1.json", "entries-page-2.json", "entries-tail.json"]) routes[`GET ${recordedPath(name)}`] = await recorded(name);
  await withPlugin(routes, async ({ client, seen }) => {
    const pageOne = await client.entries({ after: 0, limit: ENTRY_PAGE });
    assert.deepEqual(pageOne.skipped, []);
    assert.equal(pageOne.entries.length, ENTRY_PAGE);
    assert.equal(pageOne.hasMore, true);
    assert.equal(pageOne.nextAfter, first.next_after);
    const pageTwo = await client.entries({ after: pageOne.nextAfter, limit: ENTRY_PAGE });
    assert.deepEqual(pageTwo.skipped, []);
    assert.equal(pageTwo.hasMore, true);
    assert.equal(pageTwo.nextAfter, second.next_after);
    const tailAfter = Number(new URL(recordedPath("entries-tail.json"), "http://x").searchParams.get("after"));
    const tail = await client.entries({ after: tailAfter, limit: ENTRY_PAGE });
    assert.equal(tail.hasMore, false, "the tail says the stream is caught up");
    const entries = [...pageOne.entries, ...pageTwo.entries, ...tail.entries];
    const seqs = entries.map((entry) => entry.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "ascending by seq");
    assert.equal(new Set(seqs).size, seqs.length, "strictly increasing: nothing delivered twice");
    for (const entry of entries) {
      assert.equal(entry.backfill, false, "the default listing leaves backfill out");
      assert.deepEqual(Object.keys(entry.facts).filter((key) => !FRONTIER_FACT_KEYS.includes(key)), [], `${entry.entry_id}: facts beyond the whitelist`);
      assert.deepEqual(entry.defects.filter((defect) => !FRONTIER_ENTRY_DEFECTS.includes(defect)), [], `${entry.entry_id}: unknown defects`);
      assert.ok(entry.date_precision === null || FRONTIER_DATE_PRECISIONS.includes(entry.date_precision), entry.entry_id);
      assert.match(entry.entry_id, new RegExp(`^${entry.source_id}:[a-f0-9]{32}$`), "entry_id is <source_id>:<sha256(external_key)[0:32]>");
    }
    assert.deepEqual(seen.map((request) => request.url), Object.keys(routes).map((key) => key.slice(4)), "the client asked exactly what was recorded");
  });
});

test("one entry by id, one text the plugin holds and one it has only just scheduled", async () => {
  const entryName = "identity-doi-pmid-registry.json";
  const entryBody = await fixture(entryName);
  const available = await fixture("text-available.json");
  const pending = await fixture("text-pending.json");
  const routes = {
    [`GET ${recordedPath(entryName)}`]: await recorded(entryName),
    [`GET ${recordedPath("text-available.json")}`]: await recorded("text-available.json"),
    [`GET ${recordedPath("text-pending.json")}`]: await recorded("text-pending.json"),
  };
  await withPlugin(routes, async ({ client }) => {
    const entry = await client.entry(entryBody.entry_id);
    assert.equal(entry.identity_key, entryBody.identity_key);
    assert.equal(entry.revision, entryBody.revision);

    const text = await client.text(available.entry_id);
    assert.equal(text.status, "available");
    assert.ok(FRONTIER_TEXT_STATUSES.includes(text.status));
    assert.equal(text.abstract, available.abstract);
    assert.ok(String(text.abstract ?? "").length > 200, "the held text is an abstract, not an empty shell");
    assert.deepEqual(Object.keys(text.enrichment).sort(), Object.keys(available.enrichment).sort(),
      "the client keeps every enrichment field the plugin sent");
    assert.deepEqual(Object.keys(text.enrichment).filter((key) => !FRONTIER_ENRICHMENT_KEYS.includes(key)), []);

    const scheduled = await client.text(pending.entry_id);
    assert.equal(scheduled.status, "pending");
    assert.equal(scheduled.abstract, null);
    assert.ok(Number.isFinite(Date.parse(String(scheduled.next_attempt_at))), "a pending text says when the plugin tries again");
  });
});

test("lookups: this build offers none, and asking for one is a named 501", async () => {
  const routes = {
    "GET /v1/lookups": await recorded("lookups.json"),
    [`POST ${recordedPath("lookup-unavailable.json")}`]: await recorded("lookup-unavailable.json"),
  };
  await withPlugin(routes, async ({ client, seen }) => {
    assert.deepEqual(await client.lookups(), { lookups: [] });
    await assert.rejects(client.lookup("literature-search", {}), { code: "knowledge_plugin_capability_unavailable", status: 501 });
    assert.equal(seen[1].body, "{}");
    assert.equal(seen[1].headers["content-type"], "application/json");
  });
});

test("the recorded error shapes map to the platform's named codes", async () => {
  const codes = ["unauthorized", "not_found", "invalid_cursor", "invalid_params", "capability_unavailable", "upstream_unavailable",
    "rate_limited", "internal"];
  for (const name of ["error-unauthorized.json", "error-not-found.json", "error-invalid-cursor.json", "lookup-unavailable.json"]) {
    const body = await fixture(name);
    assert.ok(codes.includes(body.code), `${name}: code ${body.code} is the contract's Error code`);
    assert.equal(typeof body.message, "string");
    assert.equal(typeof body.retryable, "boolean");
  }

  await withPlugin({ [`GET ${recordedPath("error-unauthorized.json")}`]: await recorded("error-unauthorized.json") }, async ({ client, seen }) => {
    await assert.rejects(client.entries({ after: 0, limit: 1 }), { code: "knowledge_plugin_unauthorized" });
    assert.equal(seen.length, 1, "a refused token is final on the first answer");
    assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
  });

  const missing = "no-such-source:00000000000000000000000000000000";
  assert.equal(recordedPath("error-not-found.json"), `/v1/entries/${encodeURIComponent(missing)}/text`);
  await withPlugin({ [`GET ${recordedPath("error-not-found.json")}`]: await recorded("error-not-found.json") }, async ({ client }) => {
    await assert.rejects(client.text(missing), { code: "knowledge_plugin_not_found", status: 404 });
  });

  // The client refuses a negative cursor itself, so the plugin never sees
  // one from it; the plugin's recorded refusal is served to a request the
  // client can send, which is what is under test: its reading of the body.
  assert.equal(recordedPath("error-invalid-cursor.json"), "/v1/entries?after=-1&limit=1");
  await withPlugin({ "GET /v1/entries?after=0&limit=1": await recorded("error-invalid-cursor.json") }, async ({ client, seen }) => {
    await assert.rejects(client.entries({ after: -1, limit: 1 }), { code: "knowledge_plugin_invalid_cursor" });
    assert.equal(seen.length, 0, "a negative cursor never leaves the platform");
    await assert.rejects(client.entries({ after: 0, limit: 1 }), { code: "knowledge_plugin_invalid_cursor", status: 400 });
  });
});

test("the identity ladder: every recorded sample stands on its highest rung, and the platform derives the same key", async () => {
  // The ladder as the contract states it, read from the vendored document.
  const yaml = (await readFile(new URL(pin.contractFile, root), "utf8")).replace(/\s+/g, " ");
  const stated = /deterministic ladder `([^`]+)`/.exec(yaml)?.[1];
  assert.ok(stated, "the contract states its ladder");
  assert.deepEqual(stated.split(" > ").map((rung) => rung.split(":")[0]), [...IDENTITY_LADDER]);
  assert.deepEqual(identitySamples.ladder, [...IDENTITY_LADDER]);

  /** The rung the inputs allow, highest first. @param {ReturnType<typeof identityInputs>} inputs */
  const expectedRung = (inputs) => (inputs.doi ? "doi" : inputs.pmid ? "pmid" : inputs.wx_biz ? "wx"
    : inputs.trial_event && inputs.registry_ids.length ? "reg" : inputs.fda_application ? "fda" : "url");
  const rungs = new Set();
  for (const sample of identitySamples.samples) {
    const body = await fixture(sample.fixture);
    assert.deepEqual(sample.inputs, identityInputs(body), `${sample.fixture}: the sample set drifted from its recording`);
    assert.equal(sample.identity_key, body.identity_key);
    const rung = sample.identity_key.split(":", 1)[0];
    assert.equal(rung, expectedRung(sample.inputs), `${sample.fixture}: ${sample.identity_key} is not the highest rung`);
    rungs.add(rung);
    const { inputs } = sample;
    const derived = {
      doi: () => `doi:${doiOf(inputs.doi)}`,
      pmid: () => `pmid:${inputs.pmid}`,
      reg: () => `reg:${inputs.registry_ids[0]}:${inputs.trial_event}:${String(inputs.published_at).slice(0, 10)}`,
      fda: () => `fda:${inputs.fda_application}:${inputs.fda_supplement}`,
      url: () => `url:${sha256(inputs.canonical_url)}`,
    }[rung];
    assert.ok(derived, `no derivation for the ${rung} rung`);
    assert.equal(sample.identity_key, derived(), `${sample.fixture}: the platform spells this key differently`);

    // The consumer: the keys the pipeline looks an entry up by. The plugin's
    // key must be among them, and the platform must not add a second spelling
    // of the same DOI or URL beside it.
    const checked = validateEntry(body);
    assert.ok(checked.ok, `${sample.fixture}: ${checked.reason}`);
    const { dedupe } = entryKeys(checked.entry);
    assert.ok(dedupe.includes(sample.identity_key));
    if (rung === "reg" || rung === "fda") assert.deepEqual(dedupe, [sample.identity_key], "an event-level key dedupes alone");
    if (rung === "doi") assert.deepEqual(dedupe.filter((key) => key.startsWith("doi:")), [sample.identity_key]);
    if (rung === "url") assert.deepEqual(dedupe.filter((key) => key.startsWith("url:")), [sample.identity_key]);
  }
  // Every rung the stream can hold is sampled, or its absence is stated.
  const unrecorded = Object.keys(identitySamples.notRecorded).map((name) => /^identity-([a-z]+)\.json$/.exec(name)?.[1]);
  assert.deepEqual(IDENTITY_LADDER.filter((rung) => !rungs.has(rung) && !unrecorded.includes(rung)), []);
  assert.ok(["doi", "pmid", "reg", "fda", "url"].every((rung) => rungs.has(rung)), "the batch-1 rungs are all recorded");
  assert.ok(identitySamples.samples.some(({ inputs }) => inputs.doi && inputs.pmid && inputs.registry_ids.length),
    "one sample holds several rungs at once, where the ladder's order is visible");
});
