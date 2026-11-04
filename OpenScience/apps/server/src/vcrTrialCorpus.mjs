/**
 * Operator-pinned ClinicalTrials.gov snapshot. Version 1 uses the documents
 * table (id, nct_id, xml_sha256, payload_sha256, zlib JSON payload, archive) and
 * contentless FTS5 terms table (title, condition, summary, description,
 * eligibility), joined by rowid. The legacy xml_sha256 column carries the
 * digest of the source record in the declared format. Seal it without a WAL dependency
 * and publish it immutably with the manifest. All file and SQL work runs off
 * the control-plane event loop.
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { inflateSync } from "node:zlib";

import { CTGOV_STUDY_URL, ctgovPrecedent } from "./trialRegistryClient.mjs";
import { ctgovCandidate, filterCandidates, fusionScore, presentCandidate, FROZEN_CANDIDATE_LIMIT } from "./vcrCandidateSearch.mjs";

const ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const SHA = /^[a-f0-9]{64}$/;
const NCT = /^NCT[0-9]{8}$/;
const PAGE_SIZE = 50;
const STOP = new Set("a an and are as at be been being but by for from had has have having he her here hers herself him himself his how i if in into is it its itself me more most my myself of on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves".split(" "));

/** @param {string | Buffer} value */
const digest = (value) => createHash("sha256").update(value).digest("hex");
/** @param {string} code */
const failure = (code) => Object.assign(new Error(code), { code });

/** @param {string} path */
function manifestOf(path) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, "utf8")); } catch { throw failure("trial_collection_manifest_unreadable"); }
  const { version, id, sourceVersion, snapshotDate, databasePath, databaseSha256, sourceFormat = "clinicaltrials-xml" } = manifest ?? {};
  const date = new Date(snapshotDate);
  if (version !== 1 || typeof id !== "string" || !ID.test(id) || typeof sourceVersion !== "string" || !ID.test(sourceVersion)
    || typeof snapshotDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate) || !Number.isFinite(date.valueOf())
    || date.toISOString().slice(0, 10) !== snapshotDate || typeof databasePath !== "string" || !databasePath
    || !["clinicaltrials-xml", "trialgpt-json"].includes(sourceFormat) || typeof databaseSha256 !== "string" || !SHA.test(databaseSha256)) {
    throw failure("trial_collection_manifest_invalid");
  }
  const source = { id, sourceVersion, snapshotDate, sourceFormat, databaseSha256 };
  return { ...source, revision: digest(JSON.stringify(source)), path: resolvePath(dirname(path), databasePath) };
}

/** @param {string} path */
function fileStamp(path) {
  const stat = statSync(path, { bigint: true });
  if (statSync(`${path}-wal`, { throwIfNoEntry: false })?.size) throw failure("trial_collection_index_unsealed");
  if (!stat.isFile()) throw failure("trial_collection_index_invalid");
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** @param {string} query */
function tokens(query) {
  return [...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((token) => !STOP.has(token)).sort();
}

/** @param {string[]} words */
const match = (words) => words.map((word) => `"${word}"`).join(" OR ");

/** @param {any} row */
function decode(row) {
  const bytes = inflateSync(row.payload, { maxOutputLength: 2_000_000 });
  if (!NCT.test(row.nct_id) || !SHA.test(row.xml_sha256) || digest(bytes) !== row.payload_sha256) {
    throw failure("trial_collection_record_invalid");
  }
  const payload = JSON.parse(bytes.toString("utf8"));
  if (payload.nct_id !== row.nct_id || (payload.source_sha256 ?? payload.xml_sha256) !== row.xml_sha256) throw failure("trial_collection_record_invalid");
  return payload;
}

/** @param {unknown} value */
const literal = (value) => typeof value === "string" ? value : "";
/** @param {unknown} value */
const lines = (value) => literal(value).split("\n").map((line) => line.trim()).filter(Boolean);

/** @param {any} payload */
function publicFields(payload) {
  const registryId = payload.nct_id;
  return {
    registryId,
    title: literal(payload.title),
    overallStatus: literal(payload.overall_status),
    phases: literal(payload.phase).split("/").map((phase) => phase.trim()).filter(Boolean),
    minimumAge: literal(payload.minimum_age),
    maximumAge: literal(payload.maximum_age),
    sex: literal(payload.gender),
    conditions: lines(payload.condition),
    interventions: lines(payload.interventions),
    eligibility: literal(payload.eligibility),
    url: `${CTGOV_STUDY_URL}${registryId}`,
  };
}

/** @param {ReturnType<typeof manifestOf>} manifest */
async function openIndex(manifest) {
  const { path, ...source } = manifest;
  const stamp = fileStamp(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== source.databaseSha256) throw failure("trial_collection_index_hash_mismatch");
  const uri = pathToFileURL(path);
  uri.searchParams.set("immutable", "1");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(uri, { readOnly: true });
  try {
    if (fileStamp(path) !== stamp) throw failure("trial_collection_index_changed");
    const ranking = db.prepare("SELECT d.id, d.nct_id, bm25(terms) AS distance FROM terms JOIN documents d ON d.id=terms.rowid WHERE terms MATCH ? ORDER BY distance, d.nct_id LIMIT ?");
    const count = db.prepare("SELECT count(*) AS count FROM terms WHERE terms MATCH ?");
    const byRow = db.prepare("SELECT nct_id, xml_sha256, payload_sha256, payload FROM documents WHERE id = ?");
    const byId = db.prepare("SELECT nct_id, xml_sha256, payload_sha256, payload FROM documents WHERE nct_id = ?");
    const cache = new Map();

    /**
     * The list of one request: every phrase searched, the hits fused by TrialGPT's weights (`fusionScore`: an earlier phrase counts for more),
     * the filters applied, the first `request.limit` kept. Computed once per request and kept for the paging that follows.
     * @param {import("./vcrCandidateSearch.mjs").CandidateRequest} request
     */
    const compute = (request) => {
      if (fileStamp(path) !== stamp) throw failure("trial_collection_index_changed");
      // The summary the list may be reordered against is not a term of the search.
      const { summary: _summary, ...searched } = request;
      const key = digest(JSON.stringify([source, searched]));
      let result = cache.get(key);
      if (!result) {
        const queries = [...new Map([request.condition, ...request.terms].map((query) => {
          const words = tokens(query);
          return [match(words), words];
        })).entries()].filter(([query]) => query);
        const all = match([...new Set(queries.flatMap(([, words]) => words))]);
        const totalMatched = all ? Number(count.get(all)?.count) : 0;
        /** @type {Map<string, { id: number, nct: string, score: number }>} */
        const scores = new Map();
        for (const [queryIndex, [query]] of queries.entries()) {
          for (const [rank, row] of ranking.all(query, FROZEN_CANDIDATE_LIMIT).entries()) {
            const nct = String(row.nct_id);
            const hit = scores.get(nct) ?? { id: Number(row.id), nct, score: 0 };
            hit.score += fusionScore(rank, queryIndex);
            scores.set(nct, hit);
          }
        }
        const ordered = [...scores.values()].sort((a, b) => b.score - a.score || a.nct.localeCompare(b.nct));
        const leftOut = { status: 0, age: 0, sex: 0, region: 0 };
        const candidates = [];
        /** @type {Record<string, string>} the head of each kept trial's eligibility text, for a reranker; never presented */
        const cards = {};
        let eligible = 0;
        for (const { id } of ordered) {
          const row = byRow.get(id);
          const fields = publicFields(decode(row));
          const { kept, dropped } = filterCandidates([ctgovCandidate(fields)], request);
          for (const field of /** @type {(keyof typeof leftOut)[]} */ (Object.keys(leftOut))) leftOut[field] += dropped[field];
          if (kept.length) {
            eligible += 1;
            if (candidates.length < request.limit) {
              candidates.push({
                ...presentCandidate(kept[0]), eligibilityText: fields.eligibility ? "in_record" : "not_in_listing",
                collection: source.id, collectionRevision: source.revision, rank: candidates.length + 1,
              });
              cards[fields.registryId] = fields.eligibility.replace(/\s+/g, " ").slice(0, 1_500);
            }
          }
        }
        result = { candidates, cards, totalMatched, fusionPool: ordered.length, eligible, leftOut };
        if (cache.size >= 8) cache.delete(cache.keys().next().value);
        cache.set(key, result);
      }
      return { key, result };
    };

    /** What every answer about a list says of the collection and of the retrieval behind it. */
    const describe = (/** @type {any} */ result, /** @type {any} */ request) => ({
      available: true, status: "ok", collection: source, asOf: source.snapshotDate,
      coverage: `ClinicalTrials.gov frozen collection ${source.id} (${source.snapshotDate}); recruitment status is historical.`,
      order: "BM25 with reciprocal-rank fusion across queries (TrialGPT's weights: earlier queries count for more). Retrieval rank does not judge eligibility.",
      found: result.eligible, leftOut: result.leftOut,
      retrieval: {
        method: "fts5-bm25-rrf", totalMatched: result.totalMatched, fusionPool: result.fusionPool, eligibleInFusionPool: result.eligible,
        limit: request.limit, truncated: result.totalMatched > result.fusionPool || result.eligible > request.limit,
        retrievedIds: result.candidates.map((/** @type {any} */ candidate) => candidate.registryId),
      },
    });

    return {
      /** @param {import("./vcrCandidateSearch.mjs").CandidateRequest} request @param {string | null} cursor */
      search(request, cursor) {
        const { key, result } = compute(request);
        let offset = 0;
        if (cursor) {
          const parsed = /^([a-f0-9]{64})-([1-9][0-9]{0,2})$/.exec(cursor);
          offset = Number(parsed?.[2]);
          if (parsed?.[1] !== key || offset % PAGE_SIZE !== 0 || offset >= request.limit) throw failure("trial_collection_cursor_invalid");
        }
        if (offset && offset >= result.candidates.length) throw failure("trial_collection_cursor_invalid");
        const candidates = result.candidates.slice(offset, offset + PAGE_SIZE);
        const more = offset + candidates.length < result.candidates.length;
        return { ...describe(result, request), more, nextCursor: more ? `${key}-${offset + candidates.length}` : null, candidates };
      },
      /**
       * The whole list of a request and the head of each trial's eligibility text, for a caller that reorders it (the reranker) and keeps it.
       * @param {import("./vcrCandidateSearch.mjs").CandidateRequest} request
       */
      collect(request) {
        const { result } = compute(request);
        return { ...describe(result, request), more: false, nextCursor: null, candidates: result.candidates, cards: result.cards };
      },
      /** @param {string} registryId */
      record(registryId) {
        if (fileStamp(path) !== stamp) throw failure("trial_collection_index_changed");
        const canonical = registryId.trim().toUpperCase();
        const row = NCT.test(canonical) ? byId.get(canonical) : undefined;
        if (!row) return null;
        const payload = decode(row);
        const fields = publicFields(payload);
        const retrievedAt = `${source.snapshotDate}T00:00:00.000Z`;
        const description = { briefSummary: literal(payload.summary), detailedDescription: literal(payload.detailed_description) };
        const built = ctgovPrecedent({
          protocolSection: {
            identificationModule: { nctId: canonical, briefTitle: fields.title },
            descriptionModule: description,
            statusModule: { overallStatus: fields.overallStatus },
            conditionsModule: { conditions: fields.conditions },
            designModule: { phases: fields.phases, studyType: literal(payload.study_type) },
            armsInterventionsModule: { interventions: fields.interventions.map((name) => ({ name })) },
            eligibilityModule: { eligibilityCriteria: fields.eligibility, minimumAge: fields.minimumAge, maximumAge: fields.maximumAge, sex: fields.sex },
          },
        }, { retrievedAt });
        const recordHash = digest(JSON.stringify([source, row.payload_sha256]));
        const collection = { ...source, sourceSha256: row.xml_sha256, payloadSha256: row.payload_sha256,
          ...(source.sourceFormat === "clinicaltrials-xml" ? { xmlSha256: row.xml_sha256 } : {}) };
        built.record.hash = recordHash;
        built.precedent.sources = built.precedent.sources.map((entry) => ({ ...entry, recordHash, collection }));
        return { ...built, description };
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

const MAX_PENDING = 8;

/**
 * @param {string} path operator-configured manifest filename
 * @param {{ timeoutMs?: number }} [options]
 */
export function createVcrTrialCorpus(path, { timeoutMs = 20_000 } = {}) {
  if (!path) return null;
  const manifest = manifestOf(path);
  /** @type {Worker | null} */
  let worker = null;
  /** @type {Promise<unknown> | null} */
  let stopping = null;
  let closed = false;
  let seq = 0;
  let activeId = 0;
  /** @type {Map<number, { id: number, action: "search" | "record" | "collect", args: unknown[], settle: (code: string | null, value?: unknown) => void }>} */
  const pending = new Map();

  /** @param {string} code */
  function stop(code) {
    const active = worker;
    worker = null;
    activeId = 0;
    for (const entry of pending.values()) entry.settle(code);
    if (active) {
      stopping = active.terminate().catch(() => {}).finally(() => { stopping = null; });
    }
    return stopping;
  }

  function dispatch() {
    if (activeId || closed || stopping) return;
    const entry = pending.values().next().value;
    if (!entry) { worker?.unref(); return; }
    try {
      if (!worker) {
        const started = new Worker(new URL(import.meta.url), { workerData: { vcrTrialCorpus: manifest } });
        worker = started;
        started.on("error", () => { if (worker === started) stop("trial_collection_worker_failed"); });
        started.on("exit", () => { if (worker === started) stop("trial_collection_worker_closed"); });
        started.on("message", ({ id, result, code }) => {
          if (worker !== started || id !== activeId) return;
          activeId = 0;
          pending.get(id)?.settle(code ?? null, result);
          dispatch();
        });
      }
      activeId = entry.id;
      worker.ref();
      worker.postMessage({ id: entry.id, action: entry.action, args: entry.args });
    } catch {
      stop("trial_collection_worker_failed");
    }
  }

  /** @param {"search" | "record" | "collect"} action @param {unknown[]} args @param {AbortSignal} [signal] */
  async function call(action, args, signal) {
    if (closed) throw failure("trial_collection_worker_closed");
    if (signal?.aborted) throw failure("trial_collection_read_aborted");
    if (stopping || pending.size >= MAX_PENDING) throw failure("trial_collection_busy");
    const id = ++seq;
    return new Promise((resolve, reject) => {
      /** @param {string} code */
      const cancel = (code) => {
        if (activeId === id) stop(code);
        else pending.get(id)?.settle(code);
      };
      const abort = () => cancel("trial_collection_read_aborted");
      const timer = setTimeout(() => cancel("trial_collection_read_timeout"), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      pending.set(id, { id, action, args, settle: (code, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        pending.delete(id);
        if (code) reject(failure(code)); else resolve(value);
      } });
      dispatch();
    });
  }

  return {
    id: manifest.id,
    revision: manifest.revision,
    /** @param {any} request @param {string | null} cursor @param {AbortSignal} [signal] */
    search: (request, cursor, signal) => call("search", [request, cursor], signal),
    /** The whole list of a request with the head of each trial's eligibility text: what a reranker reads. @param {any} request @param {AbortSignal} [signal] */
    collect: (request, signal) => call("collect", [request], signal),
    /** @param {string} registryId @param {AbortSignal} [signal] */
    record: (registryId, signal) => call("record", [registryId], signal),
    async close() {
      closed = true;
      await stop("trial_collection_worker_closed");
    },
  };
}

if (!isMainThread && workerData?.vcrTrialCorpus && parentPort) {
  const channel = parentPort;
  const index = openIndex(workerData.vcrTrialCorpus).then((value) => ({ value }), (error) => ({
    code: typeof error?.code === "string" && error.code.startsWith("trial_collection_") ? error.code : "trial_collection_index_unavailable",
  }));
  channel.on("message", async ({ id, action, args }) => {
    try {
      const ready = await index;
      if (!("value" in ready)) return void channel.postMessage({ id, code: ready.code });
      const result = action === "search" ? ready.value.search(args[0], args[1]) : action === "collect" ? ready.value.collect(args[0]) : ready.value.record(args[0]);
      channel.postMessage({ id, result });
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      channel.postMessage({ id, code: typeof code === "string" && code.startsWith("trial_collection_") ? code : "trial_collection_read_failed" });
    }
  });
}
