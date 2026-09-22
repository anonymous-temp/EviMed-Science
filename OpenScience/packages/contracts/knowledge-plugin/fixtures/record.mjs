#!/usr/bin/env node
/**
 * Record the knowledge-source plugin's contract fixtures off a live plugin.
 *
 * Hidden knowledge: why this is a script and not a directory of hand-written
 * JSON. A fixture written from the contract inherits the contract's reading of
 * itself and then certifies it — this platform has been burned exactly so: a
 * hand-authored wire fixture certified a shape the wire never produced, and the
 * audit resting on it passed while the real responses drifted (plan §14.4).
 * So every `*.json` beside this file except `provenance.json` and
 * `identity-keys.json` is a response body exactly as the plugin sent it, byte
 * for byte. `provenance.json` records, per fixture, the request that produced
 * it — method, path and query, every header but `Authorization`, the body of a
 * POST — its status, every response header, and when. Nothing is re-indented,
 * trimmed or reordered.
 *
 * What is recorded, and why each:
 *
 * - `health.json` (no credential: the one route that takes none), `manifest.json`.
 * - `sources-page-<n>.json`: the registry of one small lane (`SOURCE_LANE`), so
 *   the whole `next_cursor` walk fits in a few pages. The client never filters
 *   by lane; the replay serves these pages to its unfiltered walk, because what
 *   is under test is the paging and the rows, not the plugin's filter.
 * - `entries-page-1.json`, `entries-page-2.json` (`has_more: true`) and
 *   `entries-tail.json` (`has_more: false`), the default listing without
 *   backfill, which is what the platform pulls.
 * - `identity-<rung>.json`: one entry per rung of the identity ladder the stream
 *   holds (contract rule 3), chosen by scanning it, and `identity-keys.json`, the
 *   sample set derived from those recordings (the contract test derives it again
 *   and compares, so the set cannot drift from the bodies it came from). The
 *   first sample carries a DOI, a PMID and a registry id at once: the ladder's
 *   order is only visible where several rungs are present.
 * - `text-available.json` and `text-pending.json`: one entry whose text the
 *   plugin holds, and one never asked for before (asking schedules its
 *   enrichment — the only thing this script changes on the plugin).
 * - `lookups.json` (batch 1 offers none) and `lookup-unavailable.json` (501).
 * - `error-unauthorized.json` (401, a token the plugin never issued),
 *   `error-not-found.json` (404) and `error-invalid-cursor.json` (400, a
 *   negative cursor).
 *
 * The token is read from the file the platform reads it from
 * (`OPEN_SCIENCE_KNOWLEDGE_PLUGIN_TOKEN_FILE`, or `--token-file`), through the
 * client's own reader, and never printed; a recording that contains it anywhere
 * is refused before anything is written.
 *
 *   OPEN_SCIENCE_KNOWLEDGE_PLUGIN_TOKEN_FILE=/tmp/frontier-dev/knowledge-plugin.token \
 *   node packages/contracts/knowledge-plugin/fixtures/record.mjs [--url http://127.0.0.1:18080]
 */

import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { readKnowledgePluginToken } from "../../../../apps/server/src/knowledgePluginClient.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The smallest lane of the registry that still takes more than one page at `SOURCE_PAGE`. */
export const SOURCE_LANE = "public-health";
export const SOURCE_PAGE = 10;
export const ENTRY_PAGE = 3;
/** The identity ladder, highest rung first (contract rule 3). */
export const IDENTITY_LADDER = Object.freeze(["doi", "pmid", "wx", "reg", "fda", "url"]);
const SCAN_PAGE = 500;
const MAX_PAGES = 100;
const TEXT_WAIT_MS = 300_000;
/** Files this script writes that are not response bodies. */
const DERIVED = new Set(["provenance.json", "identity-keys.json"]);

/**
 * The inputs of the identity ladder an entry carries, as the stream states them.
 * Shared with the contract test, which derives the sample set again from the
 * recorded bodies and compares.
 * @param {Record<string, any>} entry
 */
export function identityInputs(entry) {
  const facts = entry.facts && typeof entry.facts === "object" ? entry.facts : {};
  return {
    doi: entry.doi ?? null,
    pmid: entry.pmid ?? null,
    registry_ids: Array.isArray(entry.registry_ids) ? entry.registry_ids : [],
    wx_biz: facts.wx_biz ?? null,
    trial_event: facts.trial_event ?? null,
    fda_application: facts.fda_application ?? null,
    fda_supplement: facts.fda_supplement ?? null,
    published_at: entry.published_at ?? null,
    canonical_url: entry.canonical_url,
  };
}

/** @param {string} secret @param {Buffer | string} value */
function assertNoSecret(secret, value) {
  if (secret && Buffer.from(value).includes(Buffer.from(secret))) {
    throw new Error("a recorded exchange contains the token; nothing was written");
  }
}

/**
 * One request, recorded. `credential` says which token was sent without naming it.
 * @param {string} base
 * @param {{ name: string, path: string, method?: "GET" | "POST", token?: string | null, credential?: string, body?: Record<string, unknown> }} spec
 */
async function exchange(base, { name, path: route, method = "GET", token = null, credential = "none", body }) {
  const recordedHeaders = { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) };
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...recordedHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    name,
    request: { method, path: route, headers: recordedHeaders, credential, ...(body ? { body } : {}) },
    status: response.status,
    headers: Object.fromEntries([...response.headers].sort(([left], [right]) => left.localeCompare(right))),
    bytes,
    recordedAt: new Date().toISOString(),
  };
}

/** @param {{ bytes: Buffer }} recorded */
const json = (recorded) => JSON.parse(recorded.bytes.toString("utf8"));

/** @param {{ name: string, status: number }} recorded @param {number} status */
function expectStatus(recorded, status) {
  if (recorded.status !== status) throw new Error(`${recorded.name}: expected HTTP ${status}, the plugin answered ${recorded.status}`);
}

/** The rung an identity key stands on. @param {string} key */
const rungOf = (key) => String(key).split(":", 1)[0];

/**
 * Record everything against `baseUrl` and write it into `outDir`.
 * @param {{ baseUrl: string, token: string, outDir?: string }} options
 * @returns {Promise<{ name: string, status: number }[]>}
 */
export async function recordKnowledgePluginContract({ baseUrl, token, outDir = here }) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const signed = { token, credential: "the deployment token" };
  const recordings = [];
  const keep = (/** @type {any} */ recorded, /** @type {number} */ status) => {
    expectStatus(recorded, status);
    recordings.push(recorded);
    return recorded;
  };

  const health = json(keep(await exchange(base, { name: "health.json", path: "/v1/health" }), 200));
  const manifest = json(keep(await exchange(base, { name: "manifest.json", path: "/v1/manifest", ...signed }), 200));

  let cursor = null;
  for (let page = 1; ; page += 1) {
    if (page > 10) throw new Error(`the ${SOURCE_LANE} lane takes more than ten pages of ${SOURCE_PAGE}; pick a smaller lane`);
    const route = `/v1/sources?lane=${SOURCE_LANE}&limit=${SOURCE_PAGE}&include_retired=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body = json(keep(await exchange(base, { name: `sources-page-${page}.json`, path: route, ...signed }), 200));
    cursor = body.next_cursor ?? null;
    if (!cursor) {
      if (page < 2) throw new Error(`the ${SOURCE_LANE} lane fits one page; the recording would not exercise paging`);
      break;
    }
  }

  const first = json(keep(await exchange(base, { name: "entries-page-1.json", path: `/v1/entries?after=0&limit=${ENTRY_PAGE}`, ...signed }), 200));
  if (!first.has_more || first.entries.length !== ENTRY_PAGE) throw new Error("the stream is too short to record two pages");
  const second = json(keep(await exchange(base, { name: "entries-page-2.json",
    path: `/v1/entries?after=${first.next_after}&limit=${ENTRY_PAGE}`, ...signed }), 200));
  if (!second.has_more) throw new Error("the stream is too short to record a second page with more behind it");
  // The tail: the latest seq the plugin reports, asked again until nothing
  // newer arrived in between (a crawling plugin keeps appending).
  let tail = null;
  for (let attempt = 0; attempt < 5 && !tail; attempt += 1) {
    const latest = (await (await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(30_000) })).json()).latest_seq;
    const recorded = await exchange(base, { name: "entries-tail.json", path: `/v1/entries?after=${latest}&limit=${ENTRY_PAGE}`, ...signed });
    expectStatus(recorded, 200);
    if (json(recorded).has_more === false) tail = recorded;
  }
  if (!tail) throw new Error("the stream kept growing faster than a tail could be recorded");
  recordings.push(tail);

  // Scan the whole stream once (not recorded) to choose the identity samples
  // and the two texts.
  /** @type {Record<string, any>[]} */
  const stream = [];
  let after = 0;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new Error("the stream did not end within the scan bound");
    const response = await fetch(`${base}/v1/entries?after=${after}&limit=${SCAN_PAGE}&include_backfill=true`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`scanning the stream failed with HTTP ${response.status}`);
    const body = await response.json();
    stream.push(...body.entries);
    if (!body.has_more) break;
    after = body.next_after;
  }
  const live = stream.filter((entry) => !entry.backfill);
  /** @type {Array<[string, (entry: Record<string, any>) => boolean, Record<string, any>[]]>} */
  const choices = [
    // Three rungs present at once: the DOI must win over the PMID and the trial id.
    ["identity-doi-pmid-registry.json", (entry) => rungOf(entry.identity_key) === "doi" && entry.pmid && entry.registry_ids?.length > 0, live],
    ["identity-doi.json", (entry) => rungOf(entry.identity_key) === "doi" && !entry.pmid, live],
    ["identity-pmid.json", (entry) => rungOf(entry.identity_key) === "pmid", stream],
    ["identity-wx.json", (entry) => rungOf(entry.identity_key) === "wx", stream],
    ["identity-reg.json", (entry) => rungOf(entry.identity_key) === "reg", stream],
    // openFDA's first contact delivered its history as backfill; a backfill entry answers /v1/entries/{id} alike.
    ["identity-fda.json", (entry) => rungOf(entry.identity_key) === "fda", stream],
    ["identity-url.json", (entry) => rungOf(entry.identity_key) === "url", live],
  ];
  /** @type {Record<string, string>} */
  const notRecorded = {};
  const samples = [];
  for (const [name, wanted, pool] of choices) {
    const entry = pool.find(wanted);
    if (!entry) {
      notRecorded[name] = "the stream held no such entry when this was recorded";
      continue;
    }
    const recorded = keep(await exchange(base, { name, path: `/v1/entries/${encodeURIComponent(entry.entry_id)}`, ...signed }), 200);
    const body = json(recorded);
    samples.push({ rung: rungOf(body.identity_key), fixture: name, entry_id: body.entry_id, source_id: body.source_id,
      inputs: identityInputs(body), identity_key: body.identity_key });
  }

  let available = null;
  // A journal article with an abstract first: its text carries what the
  // platform snapshots (the abstract, publication types, MeSH, journal,
  // authors), not only an excerpt; any held text if none has one.
  const held = live.filter((row) => row.text_status === "available").sort((left, right) => Number(!left.doi) - Number(!right.doi));
  for (const entry of held) {
    const recorded = await exchange(base, { name: "text-available.json", path: `/v1/entries/${encodeURIComponent(entry.entry_id)}/text`, ...signed });
    if (recorded.status !== 200 || json(recorded).status !== "available") continue;
    available ??= recorded;
    if (json(recorded).abstract) { available = recorded; break; }
  }
  const candidates = live.filter((row) => row.text_status === "none" && row.doi).slice(0, 10);
  let pending = null;
  for (const entry of candidates) {
    const recorded = await exchange(base, { name: "text-pending.json", path: `/v1/entries/${encodeURIComponent(entry.entry_id)}/text`, ...signed });
    if (recorded.status === 200 && json(recorded).status === "pending") { pending = { recorded, entry }; break; }
  }
  if (!pending) throw new Error("no entry answered its first text request with pending");
  if (!available) {
    // Nothing held yet: wait for the entry just asked for to be enriched.
    const deadline = Date.now() + TEXT_WAIT_MS;
    while (!available && Date.now() < deadline) {
      await delay(10_000);
      const recorded = await exchange(base, { name: "text-available.json",
        path: `/v1/entries/${encodeURIComponent(pending.entry.entry_id)}/text`, ...signed });
      if (recorded.status === 200 && json(recorded).status === "available") available = recorded;
    }
    if (!available) throw new Error("no entry's text became available within the wait");
  }
  keep(available, 200);
  keep(pending.recorded, 200);

  keep(await exchange(base, { name: "lookups.json", path: "/v1/lookups", ...signed }), 200);
  keep(await exchange(base, { name: "lookup-unavailable.json", path: "/v1/lookups/literature-search", method: "POST", body: {}, ...signed }), 501);
  keep(await exchange(base, { name: "error-unauthorized.json", path: `/v1/entries?after=0&limit=1`,
    token: "not-a-token-this-plugin-issued", credential: "a token the plugin never issued" }), 401);
  keep(await exchange(base, { name: "error-not-found.json", path: `/v1/entries/${encodeURIComponent("no-such-source:00000000000000000000000000000000")}/text`, ...signed }), 404);
  keep(await exchange(base, { name: "error-invalid-cursor.json", path: "/v1/entries?after=-1&limit=1", ...signed }), 400);

  for (const recorded of recordings) {
    assertNoSecret(token, recorded.bytes);
    assertNoSecret(token, JSON.stringify(recorded.headers));
    assertNoSecret(token, JSON.stringify(recorded.request));
  }
  const identityKeys = {
    ladder: IDENTITY_LADDER,
    derivedFrom: "the identity-*.json recordings beside this file, by record.mjs; contract.test.mjs derives it again and compares",
    samples,
    notRecorded,
  };
  const provenance = {
    contractVersion: manifest.contract?.version ?? null,
    plugin: manifest.plugin ?? null,
    server: base,
    serverRole: "the live development instance of 项目代码/knowledge-plugin (crawler on, database evimed_knowledge_dev), not a production plugin",
    recordedAt: new Date().toISOString(),
    healthAtRecording: { latest_seq: health.latest_seq ?? null, sources: health.sources ?? null },
    recorder: "packages/contracts/knowledge-plugin/fixtures/record.mjs",
    fixtureEvidence: "Every other *.json here except identity-keys.json is the response body the plugin sent, byte for byte. Each fixture's request (every header but Authorization; `credential` says which token was sent without naming it), status, response headers and time are recorded below. Nothing was re-indented, trimmed, renamed or invented: a hand-written wire fixture once certified a shape the wire never produced and defeated the audit that depended on it.",
    fixtures: Object.fromEntries(recordings.map((recorded) => [recorded.name,
      { request: recorded.request, status: recorded.status, headers: recorded.headers, recordedAt: recorded.recordedAt }])),
  };
  const written = new Set([...recordings.map((recorded) => recorded.name), ...DERIVED]);
  for (const recorded of recordings) await writeFile(path.join(outDir, recorded.name), recorded.bytes);
  await writeFile(path.join(outDir, "identity-keys.json"), `${JSON.stringify(identityKeys, null, 2)}\n`);
  await writeFile(path.join(outDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  // A body from an older recording that this one did not reproduce would be
  // replayed as if it had been; it goes.
  for (const file of await readdir(outDir)) {
    if (file.endsWith(".json") && !written.has(file)) await rm(path.join(outDir, file));
  }
  return recordings.map(({ name, status }) => ({ name, status }));
}

function argument(/** @type {string} */ name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseUrl = argument("url") ?? "http://127.0.0.1:18080";
  const tokenFile = argument("token-file") ?? process.env.OPEN_SCIENCE_KNOWLEDGE_PLUGIN_TOKEN_FILE ?? "";
  const loaded = await readKnowledgePluginToken(tokenFile);
  if (loaded.error) {
    process.stderr.write(`the token file is unusable (${loaded.error}); set OPEN_SCIENCE_KNOWLEDGE_PLUGIN_TOKEN_FILE or --token-file\n`);
    process.exitCode = 1;
  } else {
    const recorded = await recordKnowledgePluginContract({ baseUrl, token: loaded.value });
    process.stdout.write(`${JSON.stringify(recorded, null, 2)}\n`);
  }
}
