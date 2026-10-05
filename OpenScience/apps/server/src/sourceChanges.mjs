/**
 * The one durable fact per source identifier that every module reads (plan 2026-10-05 §5.4, B5): whether a published
 * work was retracted, corrected, put under an expression of concern or superseded, who saw it, and when it was last
 * looked at.
 *
 * Until 2026-10-05 three modules detected this and told nobody: the result impact lookup (Crossref, `sourceUpdates.mjs`,
 * remembered in memory only), the evidence zone's editor (Europe PMC's publication status on a card's source), and the
 * frontier feed (relations in `evimed_frontier.item_links`). Each now writes what it saw here, and the result impact
 * path, the memory labels and the cards read it from here — so a retraction the frontier noticed on Monday reaches the
 * result that cites it on Tuesday without anybody asking Crossref.
 *
 * Hidden knowledge:
 *
 * - **Platform-level, in the product ledger, never a tenant's.** A record is a `source-change` document of the product
 *   ledger (no new table), owned by one account the store is given (`ownerUserId`, the platform publisher). It holds
 *   the identifier, the notices and who recorded them: public bibliographic facts. No writer here ever receives a
 *   tenant, a project or a result, so which tenant asked cannot be written to it.
 * - **A feed with a position.** Every change appended takes the next position under one advisory lock, so positions
 *   follow commit order and `changedSince(cursor)` cannot skip a record that committed late — which a timestamp could.
 *   A re-assertion of a change already held takes no position: the feed announces what is new.
 * - **A failed lookup is `unknown`.** `check` asks Crossref only for what was never checked or was checked longer ago
 *   than the caller allows; an answer that could not be had records nothing, so the next read asks again and no read
 *   mistakes it for `clean`.
 * - **Counters are not facts.** A re-assertion by the detector that already saw a change moves only its check time,
 *   written as a counter (no revision row), so polling Crossref twice a day does not fill the ledger's history.
 *
 * @module sourceChanges
 */
import { createHash } from "node:crypto";
import {
  SOURCE_CHANGE_ASSERTERS, canonicalSourceIdentifier, changeFromFrontierLink, changesFromPublicationStatus, doiOfSourceIdentifier,
  foldSourceChanges, sourceChangeFact, sourceIdentifierScheme,
} from "@evimed/domain";
import { migrateProductStore } from "./productPersistence.mjs";
import { HttpError } from "./security.mjs";

const KIND = "source-change";
const SEQ_LOCK = "evimed-source-change-feed";
/** A record is read-modified-written optimistically; two detectors on one work at once settle within a try or two. */
const WRITE_ATTEMPTS = 5;
/** Identifiers one call reads or checks; the lookup behind it takes a few dozen at a time too. */
const MAX_IDENTIFIERS = 500;
/** Records one page of the feed carries. */
const MAX_PAGE = 200;
/** Writes in flight at once when a list of identifiers is noted as checked. */
const NOTE_CONCURRENCY = 6;
/** How long an answered check stays fresh when the caller names no age: a retraction is rare news, half a day is enough. */
export const SOURCE_CHANGE_DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const invalid = () => new HttpError(400, "source_change_invalid", "The source change is invalid.");
const unavailable = () => new HttpError(503, "source_change_unavailable", "Source changes are unavailable.");

/** @param {string} identifier */
const documentId = (identifier) => `sc_${createHash("sha256").update(identifier).digest("hex").slice(0, 40)}`;

/**
 * Every identifier a card source or any `{ url, doi, pmid, identifier }`-shaped reference names, in the forms the code
 * already compares (`doi.org` links, PubMed links, ClinicalTrials.gov study links; a field holding one directly).
 * @param {any} source @returns {string[]}
 */
export function sourceIdentifiersOf(source) {
  const found = [source?.url, source?.doi, source?.pmid, source?.identifier, source?.registryId]
    .map(value => canonicalSourceIdentifier(typeof value === "number" ? String(value) : value))
    .filter(/** @returns {value is string} */ value => value !== null);
  return [...new Set(found)];
}

/**
 * What a card's own reading of Europe PMC says, as entries to record: `recordFromPublicationStatus("10.1000/x", status)`
 * is `{ identifier, entries }` for `store.recordMany(identifier, entries)`. The status is the card source's
 * `publicationStatus` (`evidenceCardContent.mjs`): `{ kind: "retracted" | "corrected" | "concern", notices }`. A clear
 * status (`null`) and a missing one (`undefined`) say different things and are the caller's to tell apart — see
 * `recordPublicationStatus` on the store, which does.
 * @param {unknown} identifier @param {unknown} publicationStatus
 */
export function recordFromPublicationStatus(identifier, publicationStatus) {
  return { identifier: canonicalSourceIdentifier(identifier), entries: changesFromPublicationStatus(publicationStatus) };
}

/**
 * The relations a frontier pipeline just asserted (a retraction, correction, expression of concern or withdrawal notice
 * naming a work), recorded as source changes. Best effort by design: the relation is already stored in the frontier's
 * own tables and the feed goes on, so a store that is absent does nothing and one that fails is counted, never thrown.
 * @param {ReturnType<typeof createSourceChanges> | null | undefined} sourceChanges
 * @param {Array<{ kind: string, noticeDoi: string | null, doi: string, date?: string | null, assertedBy?: string }>} notices
 */
export async function recordFrontierNotices(sourceChanges, notices) {
  if (!sourceChanges) return;
  for (const notice of notices) {
    const change = changeFromFrontierLink({ kind: notice.kind, noticeIdentifier: notice.noticeDoi, date: notice.date ?? null, assertedBy: notice.assertedBy });
    if (!change) continue;
    try { await sourceChanges.recordMany(`doi:${notice.doi}`, [change]); }
    catch (error) { sourceChanges.failed(typeof error?.code === "string" ? error.code : "source_change_write_failed"); }
  }
}

/**
 * @param {{
 *   documents: any, database?: any, ownerUserId: string | (() => string | null | undefined) | null,
 *   lookup?: { lookupStatuses: (dois: readonly string[], options?: { signal?: AbortSignal, maxAgeMs?: number }) => Promise<Map<string, any>> } | null,
 *   now?: () => Date, maxAgeMs?: number, report?: (code: string) => void,
 * }} options
 *   `documents` the product ledger (`ProductDocuments`), `database` its pool (read from `documents` unless given);
 *   `ownerUserId` the account the records belong to — the platform publisher — as an id or a function that answers it
 *   (null answers: the store is unavailable, reads find nothing known and writes refuse); `lookup` the Crossref lookup
 *   `check` asks for what is stale (`sourceUpdates.mjs`, built with this store so what it is answered is recorded; or
 *   `useLookup` after both exist); `maxAgeMs` the default freshness of a check.
 */
export function createSourceChanges({ documents, database = documents?.database ?? null, ownerUserId, lookup = null, now = () => new Date(),
  maxAgeMs = SOURCE_CHANGE_DEFAULT_MAX_AGE_MS, report = () => {} }) {
  /** @type {typeof lookup} */
  let crossref = lookup;
  const counters = {
    recorded: /** @type {Record<string, number>} */ (Object.fromEntries(SOURCE_CHANGE_ASSERTERS.map(asserter => [asserter, 0]))),
    duplicates: 0, checkedNoted: 0, lookups: 0, lookupFailures: 0, writeFailures: 0,
    reads: { get: 0, getMany: 0, changedSince: 0, check: 0 },
  };

  const owner = () => {
    const id = typeof ownerUserId === "function" ? ownerUserId() : ownerUserId;
    return typeof id === "string" && id ? id : null;
  };

  /** @param {unknown[]} identifiers @returns {string[]} */
  const canonicalList = identifiers => {
    if (!Array.isArray(identifiers)) throw invalid();
    const list = [...new Set(identifiers.map(canonicalSourceIdentifier).filter(/** @returns {value is string} */ value => value !== null))];
    if (list.length > MAX_IDENTIFIERS) throw invalid();
    return list;
  };

  /** What the ledger holds for the identifiers, one query: record by identifier, absent ones left out. @param {string[]} canonical */
  async function load(canonical) {
    /** @type {Map<string, any>} */
    const held = new Map();
    const id = owner();
    if (!id || !database || !canonical.length) return held;
    await migrateProductStore(database);
    const result = await database.query(`SELECT payload FROM evimed_product.documents
      WHERE user_id=$1 AND kind=$2 AND id=ANY($3::text[]) AND deleted_at IS NULL`, [id, KIND, canonical.map(documentId)]);
    for (const row of result.rows) if (typeof row.payload?.identifier === "string") held.set(row.payload.identifier, row.payload);
    return held;
  }

  /** @param {string[]} canonical @returns {Promise<Map<string, ReturnType<typeof sourceChangeFact>>>} */
  async function facts(canonical) {
    const held = await load(canonical);
    return new Map(canonical.map(identifier => [identifier, sourceChangeFact(identifier, held.get(identifier))]));
  }

  /**
   * Fold what a detector saw into the record of one identifier and write it. Optimistic and retried: a record is small
   * and written by a few detectors, so two at once settle in a try or two. A change appended takes the next position of
   * the feed under one lock; anything else (a second witness, a date filled in, only a check time) takes none.
   * @param {unknown} identifier
   * @param {Parameters<typeof foldSourceChanges>[1]} entries
   * @param {{ outcome?: "answered" | "not_indexed" }} [options]
   */
  async function write(identifier, entries, { outcome = "answered" } = {}) {
    const canonical = canonicalSourceIdentifier(identifier);
    if (!canonical || !Array.isArray(entries)) throw invalid();
    const id = owner();
    if (!id || !database) throw unavailable();
    await migrateProductStore(database);
    const key = documentId(canonical);
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const row = await documents.get(id, KIND, key);
      const folded = foldSourceChanges(row?.payload ?? null, entries, { identifier: canonical, at: now().toISOString(), outcome });
      try {
        const saved = folded.appended
          ? await database.transaction(async (/** @type {any} */ client) => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SEQ_LOCK]);
            const next = await client.query(`SELECT coalesce(max((payload->>'seq')::bigint),0)+1 AS seq FROM evimed_product.documents
              WHERE user_id=$1 AND kind=$2 AND deleted_at IS NULL`, [id, KIND]);
            return documents.put(id, KIND, key, { ...folded.record, seq: Number(next.rows[0].seq) }, { expectedRevision: row?.revision ?? 0, transactionClient: client });
          })
          // Only the time moved: a counter, with no revision row and no change of `updated_at`.
          : await documents.put(id, KIND, key, folded.record, { expectedRevision: row?.revision ?? 0,
            telemetry: Boolean(row) && folded.confirmed === 0 && folded.filled === 0 });
        for (const asserter of folded.asserters) counters.recorded[asserter] += 1;
        counters.duplicates += folded.duplicates;
        return sourceChangeFact(canonical, saved.payload);
      } catch (error) {
        if (error?.code !== "product_revision_conflict" || attempt + 1 >= WRITE_ATTEMPTS) throw error;
      }
    }
    throw unavailable();
  }

  /**
   * Record changes of one identifier, each by the detector that saw it. An empty list is an answered check that found
   * nothing (or, with `outcome: "not_indexed"`, one whose index does not hold the work).
   * @param {unknown} identifier @param {Parameters<typeof foldSourceChanges>[1]} entries @param {{ outcome?: "answered" | "not_indexed" }} [options]
   */
  const recordMany = (identifier, entries, options) => write(identifier, entries, options);

  /**
   * Record one change: `record("10.1000/x", { kind: "retraction", noticeIdentifier: "10.1000/notice", date: "2026-09-01",
   * evidence: {...} }, { assertedBy: "retraction-watch" })`. The same (kind, notice) seen by another detector is the same
   * change with both detectors kept.
   * @param {unknown} identifier @param {{ kind: string, noticeIdentifier?: string | null, date?: string | null, evidence?: Record<string, any> }} change
   * @param {{ assertedBy: string }} options
   */
  const record = (identifier, change, { assertedBy }) => write(identifier, [{ ...change, assertedBy }]);

  /**
   * Say that identifiers were checked and nothing was found: they become `clean`, and a reader stops asking until the
   * check is old. Never lowers what is held — a work with a retraction on record stays `changed`.
   * @param {unknown[]} identifiers @param {{ outcome?: "answered" | "not_indexed" }} [options]
   */
  async function noteChecked(identifiers, options = {}) {
    const canonical = canonicalList(identifiers);
    /** @type {Array<ReturnType<typeof sourceChangeFact>>} */
    const noted = [];
    for (let start = 0; start < canonical.length; start += NOTE_CONCURRENCY) {
      noted.push(...await Promise.all(canonical.slice(start, start + NOTE_CONCURRENCY).map(identifier => write(identifier, [], options))));
    }
    counters.checkedNoted += noted.length;
    return noted;
  }

  /** @param {unknown} identifier */
  async function get(identifier) {
    const canonical = canonicalSourceIdentifier(identifier);
    if (!canonical) throw invalid();
    counters.reads.get += 1;
    const id = owner();
    if (!id || !database) return sourceChangeFact(canonical, null);
    await migrateProductStore(database);
    return sourceChangeFact(canonical, (await documents.get(id, KIND, documentId(canonical)))?.payload);
  }

  /**
   * The facts of many identifiers in one query, by canonical identifier; one that was never asked about is `unknown`,
   * and an input that is no identifier is left out.
   * @param {unknown[]} identifiers
   */
  async function getMany(identifiers) {
    const canonical = canonicalList(identifiers);
    counters.reads.getMany += 1;
    return facts(canonical);
  }

  /**
   * The changes appended after a position of the feed, oldest first, for a consumer that polls: keep the `cursor` it
   * answers and give it back next time. Positions follow commit order, so nothing is skipped; a work whose changes were
   * appended again later is announced again, at its new position, with everything it holds.
   * @param {number | string | null} [cursor] @param {number} [limit]
   * @returns {Promise<{ items: Array<ReturnType<typeof sourceChangeFact>>, cursor: number, hasMore: boolean }>}
   */
  async function changedSince(cursor = 0, limit = 50) {
    const after = cursor == null || cursor === "" ? 0 : Number(cursor);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw invalid();
    counters.reads.changedSince += 1;
    const id = owner();
    if (!id || !database) return { items: [], cursor: after, hasMore: false };
    await migrateProductStore(database);
    const result = await database.query(`SELECT payload FROM evimed_product.documents
      WHERE user_id=$1 AND kind=$2 AND deleted_at IS NULL AND (payload->>'seq')::bigint > $3
      ORDER BY (payload->>'seq')::bigint LIMIT $4`, [id, KIND, after, limit + 1]);
    const page = result.rows.slice(0, limit).map((/** @type {any} */ row) => sourceChangeFact(row.payload.identifier, row.payload));
    return { items: page, cursor: page.length ? Number(page.at(-1)?.seq) : after, hasMore: result.rows.length > limit };
  }

  /**
   * The facts of identifiers, asking Crossref for the DOIs never checked or checked longer ago than `maxAgeMs`. What the
   * lookup answers it records (it is built with this store), and the facts are read back, so what comes out is what every
   * other module will read. A lookup that failed records nothing and the identifier stays as it was: `unknown` if it
   * never was checked — never `clean`. PMIDs and registry numbers have no Crossref lookup; they are as detectors left them.
   * @param {unknown[]} identifiers @param {{ maxAgeMs?: number, signal?: AbortSignal }} [options]
   */
  async function check(identifiers, { maxAgeMs: age = maxAgeMs, signal } = {}) {
    const canonical = canonicalList(identifiers);
    counters.reads.check += 1;
    const known = await facts(canonical);
    const clock = now().getTime();
    const stale = canonical.filter(identifier => sourceIdentifierScheme(identifier) === "doi" && !(known.get(identifier)?.lastCheckedAt
      && clock - Date.parse(String(known.get(identifier)?.lastCheckedAt)) < age));
    if (!stale.length || !crossref?.lookupStatuses) return known;
    counters.lookups += stale.length;
    /** @type {Map<string, any>} */
    let answered;
    try { answered = await crossref.lookupStatuses(stale.map(identifier => /** @type {string} */ (doiOfSourceIdentifier(identifier))), { signal, maxAgeMs: age }); }
    catch { counters.lookupFailures += stale.length; return known; }
    for (const identifier of stale) {
      const state = answered.get(/** @type {string} */ (doiOfSourceIdentifier(identifier)))?.state;
      if (state !== "changed" && state !== "no_update" && state !== "unknown") counters.lookupFailures += 1;
    }
    const after = await facts(stale);
    for (const [identifier, fact] of after) known.set(identifier, fact);
    return known;
  }

  /**
   * What a card's sources have recorded against them, one entry per source in the order given: the identifiers read from
   * it, what is known (`changed`, `clean` or `unknown`), the changes of all of its identifiers (one list, each change
   * once) and the latest check. Reads the store only; `check` first when freshness matters.
   * @param {ReadonlyArray<any>} sources
   */
  async function changesForCardSources(sources) {
    if (!Array.isArray(sources)) throw invalid();
    const identifiers = sources.map(sourceIdentifiersOf);
    const known = await getMany(identifiers.flat());
    return identifiers.map((ids, index) => {
      const found = /** @type {Array<ReturnType<typeof sourceChangeFact>>} */ (ids.map(identifier => known.get(identifier)).filter(Boolean));
      /** @type {Map<string, any>} */
      const changes = new Map();
      for (const fact of found) for (const change of fact.changes) {
        const key = `${change.kind}\u0000${change.noticeIdentifier ?? ""}`;
        if (!changes.has(key)) changes.set(key, change);
      }
      const checked = found.map(fact => fact.lastCheckedAt).filter(Boolean).sort();
      return { index, identifiers: ids, changes: [...changes.values()], lastCheckedAt: checked.at(-1) ?? null,
        state: changes.size ? "changed" : found.some(fact => fact.state === "clean") ? "clean" : "unknown" };
    });
  }

  /**
   * The Europe PMC reading of a card's source: a retraction, correction or concern is recorded by `europepmc`, a clear
   * status (`null`) is an answered check with nothing found, and a missing one (`undefined`: the record supplied no
   * status) is nothing at all.
   * @param {unknown} identifier @param {unknown} publicationStatus
   */
  async function recordPublicationStatus(identifier, publicationStatus) {
    if (publicationStatus === undefined) return null;
    if (publicationStatus === null) return write(identifier, []);
    const { entries } = recordFromPublicationStatus(identifier, publicationStatus);
    return write(identifier, entries);
  }

  return {
    record, recordMany, recordPublicationStatus, noteChecked, get, getMany, changedSince, check, changesForCardSources,
    /** Late binding of the Crossref lookup, for a composition where the lookup is built with this store. @param {typeof lookup} next */
    useLookup(next) { crossref = next; },
    /** A best-effort writer's failure: counted and reported, never thrown. @param {string} code */
    failed(code) { counters.writeFailures += 1; try { report(code); } catch { /* the report is advice */ } },
    stats: () => ({ ...counters, recorded: { ...counters.recorded }, reads: { ...counters.reads } }),
  };
}

/**
 * The store's counters for the operator's metrics endpoint.
 * @param {ReturnType<ReturnType<typeof createSourceChanges>["stats"]> | null | undefined} stats
 */
export function sourceChangeMetricFamilies(stats) {
  if (!stats) return [];
  return [
    {
      name: "open_science_source_changes_recorded_total",
      help: "Source changes recorded (a new change, or a second detector that saw a change already held), by the detector that saw them.",
      type: /** @type {const} */ ("counter"),
      series: SOURCE_CHANGE_ASSERTERS.map(asserter => ({ value: stats.recorded[asserter] ?? 0, labels: { asserter } })),
    },
    {
      name: "open_science_source_change_duplicates_total",
      help: "Source changes a detector saw again that it had already recorded.",
      type: /** @type {const} */ ("counter"),
      series: [{ value: stats.duplicates }],
    },
    {
      name: "open_science_source_change_checks_total",
      help: "Identifiers asked of the Crossref lookup because they were never checked or the check was older than the reader allowed, by outcome.",
      type: /** @type {const} */ ("counter"),
      series: [
        { value: stats.lookups, labels: { outcome: "requested" } },
        { value: stats.lookupFailures, labels: { outcome: "failed" } },
        { value: stats.checkedNoted, labels: { outcome: "noted_clean" } },
      ],
    },
    {
      name: "open_science_source_change_reads_total",
      help: "Reads of the source-change record by the modules that consume it, by read.",
      type: /** @type {const} */ ("counter"),
      series: Object.entries(stats.reads).map(([reader, value]) => ({ value, labels: { reader } })),
    },
    {
      name: "open_science_source_change_write_failures_total",
      help: "Source changes a best-effort writer could not record (the frontier's relation is kept in its own tables either way).",
      type: /** @type {const} */ ("counter"),
      series: [{ value: stats.writeFailures }],
    },
  ];
}
