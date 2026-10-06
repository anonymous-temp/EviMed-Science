import { HttpError } from "./security.mjs";
import { retainedSource } from "./evidenceSourceReader.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

/**
 * Having the platform read a card's sources (evidence-flywheel review, 2026-10-06).
 *
 * Hidden knowledge: a card's ✓ means the platform read the source and found the quotation in it
 * (`verifyEvidenceCardClaims`). A card an author writes over HTTP carries only the excerpt they typed, so
 * until the platform has read each address it can show ⚠ 「摘录由作者提供，平台未读取原文」 and no more — an
 * author who typed a quotation and a matching excerpt used to get ✓ by that alone. This is the honest way
 * to ✓: `POST /api/frontier/evidence/:cardId/verify-sources`, for the owner of the card and of its zone, has the
 * platform read each source's address through the same reader the editor's upkeep uses (no model call), keeps what it
 * read exactly as the editor keeps it (`retainedSource`), and answers with the card as it now stands, each claim re-verified.
 *
 * Reading is a bounded act on someone else's server, so it is bounded: at most `OPEN_SCIENCE_EVIDENCE_VERIFY_READS_PER_DAY`
 * reads per account in a rolling day (every attempt counts, the ledger below), and at most `MAX_READS_PER_REQUEST` in one
 * request — the rest are said not to be read yet and a second request takes them. A source that cannot be read — no
 * address, a site that refuses automated reading or asks for a login (restricted), an address that is down or empty
 * (unreachable) — stays as the author wrote it, and is reported by its place in the card with the reader's own code.
 * A source the platform already read is not read again. Nothing here refuses a card or a claim.
 *
 * @module evidenceSourceVerification
 */

/** Sources one request reads at most; the editor's own pass reads eight a tick for the same reason (a request waits on each). */
export const MAX_READS_PER_REQUEST = 8;
/** What the platform did with one source of the card. */
export const SOURCE_READ_OUTCOMES = Object.freeze(["read", "already_read", "no_address", "restricted", "unreachable", "not_read"]);
/** What happened to one request. */
export const SOURCE_VERIFICATION_OUTCOMES = Object.freeze(["completed", "nothing_to_read", "rate_limited", "refused"]);
/** The reader's refusals that say the site does not let the platform in, as opposed to the page being down. */
const RESTRICTED_CODES = new Set(["web_read_robots_disallowed", "web_read_login_required", "web_read_host_forbidden", "web_read_url_forbidden"]);
const READ_TIMEOUT_MS = 90_000;

const LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS evimed_frontier.evidence_source_reads (
 id bigserial PRIMARY KEY,
 user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
 card_id text NOT NULL, source_index integer NOT NULL,
 outcome text NOT NULL, code text,
 read_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS evidence_source_reads_user_idx ON evimed_frontier.evidence_source_reads(user_id,read_at DESC);
`;
const migrations = new WeakMap();
/** @param {any} database */
async function migrateSourceReads(database) {
  if (!migrations.has(database)) {
    migrations.set(database, database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-evidence-source-reads-v1'))");
      await client.query(LEDGER_SQL);
    }).catch((/** @type {unknown} */ error) => { migrations.delete(database); throw error; }));
  }
  await migrations.get(database);
}

/** The platform has read this source: it kept the text, or holds the receipt of the bytes it read. @param {any} source */
export const sourceIsPlatformRead = (source) => (typeof source?.documentText === "string" && source.documentText.length > 0)
  || (typeof source?.fetchedSha256 === "string" && source.fetchedSha256.length > 0);

/**
 * @param {{ database: any, zones: { saveEditorial: (user: any, body: any, zoneId: string | null, cardId: string | null, createCard: boolean, origin: any) => Promise<any> },
 *   readSource: (url: string, options?: any) => Promise<any>, perDay: number, now?: () => Date, report?: (code: string) => void }} dependencies
 */
export function createEvidenceSourceVerification({ database, zones, readSource, perDay, now = () => new Date(), report = () => {} }) {
  const requests = new Map(SOURCE_VERIFICATION_OUTCOMES.map((name) => [name, 0]));
  const sourceReads = new Map(SOURCE_READ_OUTCOMES.map((name) => [name, 0]));
  /** @param {Map<string, number>} map @param {string} key @param {number} [by] */
  const bump = (map, key, by = 1) => { map.set(key, (map.get(key) ?? 0) + by); };

  /**
   * @param {{ id: string }} user the owner of the card and of its zone @param {string} cardId
   */
  async function verify(user, cardId) {
    await migrateEvidenceZones(database);
    await migrateSourceReads(database);
    const card = (await database.query(
      `SELECT c.id,c.zone_id,c.user_id,c.revision,c.sources,c.withdrawn,z.user_id AS zone_owner
         FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id WHERE c.id=$1`, [cardId])).rows[0];
    // Another account's card, an official zone's (its owner cannot sign in) and a card that is not there are one answer.
    if (!card || card.user_id !== user.id || card.zone_owner !== user.id) {
      bump(requests, "refused");
      throw new HttpError(404, "evidence_not_found", "No such evidence content.");
    }
    if (card.withdrawn) {
      bump(requests, "refused");
      throw new HttpError(409, "evidence_card_withdrawn", "The card is withdrawn.");
    }
    const held = Array.isArray(card.sources) ? card.sources : [];
    /** @type {{ sourceIndex: number, status: string, code?: string }[]} */
    const answers = held.map((/** @type {any} */ source, /** @type {number} */ position) => ({
      sourceIndex: position + 1,
      status: sourceIsPlatformRead(source) ? "already_read" : !source?.url ? "no_address" : "not_read",
    }));
    const pending = answers.filter((entry) => entry.status === "not_read").map((entry) => entry.sourceIndex - 1);
    const used = Number((await database.query(
      "SELECT count(*) AS n FROM evimed_frontier.evidence_source_reads WHERE user_id=$1 AND read_at>clock_timestamp()-interval '1 day'", [user.id])).rows[0].n);
    const allowed = Math.max(0, perDay - used);
    if (pending.length && allowed === 0) {
      bump(requests, "rate_limited");
      throw new HttpError(429, "evidence_source_verification_rate_limited", "Too many source reads today.");
    }
    const sources = held.map((/** @type {any} */ source) => source);
    let kept = 0;
    for (const position of pending.slice(0, Math.min(allowed, MAX_READS_PER_REQUEST))) {
      const answer = answers[position];
      /** @type {{ outcome: string, code: string | null }} */
      let attempt;
      try {
        const result = await readSource(held[position].url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
        const text = String(result?.text ?? "").slice(0, 2_000_000);
        if (!text.trim()) throw Object.assign(new Error("No readable source."), { code: "evidence_source_empty" });
        sources[position] = retainedSource(held[position], result, text, now().toISOString());
        kept += 1;
        attempt = { outcome: "read", code: null };
      } catch (error) {
        const code = /^[a-z0-9_]{2,100}$/.test(/** @type {any} */ (error)?.code ?? "") ? /** @type {any} */ (error).code
          : /** @type {any} */ (error)?.name === "TimeoutError" ? "web_read_timeout" : "evidence_source_unavailable";
        attempt = { outcome: RESTRICTED_CODES.has(code) ? "restricted" : "unreachable", code };
      }
      answer.status = attempt.outcome;
      if (attempt.code) answer.code = attempt.code;
      await database.query("INSERT INTO evimed_frontier.evidence_source_reads(user_id,card_id,source_index,outcome,code) VALUES($1,$2,$3,$4,$5)",
        [user.id, card.id, position + 1, attempt.outcome, attempt.code]);
    }
    for (const entry of answers) {
      if (entry.status === "not_read") entry.code = "evidence_source_read_deferred";
      bump(sourceReads, entry.status);
    }
    /** @type {any} */
    let evidence = null;
    if (kept) {
      // The save is the editor's own door for a source's retained text (`origin` owner: the card's own owner, in their own
      // zone), at the revision this request read; a card edited in the meantime is a conflict the owner sees, not a lost edit.
      evidence = (await zones.saveEditorial(user, { expectedRevision: card.revision, sources }, card.zone_id, card.id, false, "owner")).evidence;
      bump(requests, "completed");
    } else bump(requests, pending.length ? "completed" : "nothing_to_read");
    if (pending.length && !kept) report("evidence_sources_not_read");
    return { cardId: card.id, evidence, sources: answers, readsToday: used + Math.min(pending.length, allowed, MAX_READS_PER_REQUEST), perDay };
  }

  return { verify, stats: () => ({ requests: new Map(requests), sources: new Map(sourceReads) }) };
}

/**
 * @param {{ requests: Map<string, number>, sources: Map<string, number> } | null} stats null where the frontier is not composed
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function evidenceSourceVerificationMetricFamilies(stats) {
  if (!stats) return [];
  /** @param {Map<string, number>} map @param {string} label */
  const series = (map, label) => [...map].map(([name, value]) => ({ value, labels: { [label]: name } }));
  return [
    {
      name: "open_science_evidence_source_verifications_total",
      help: "Requests to have the platform read a card's sources, by outcome: completed, nothing to read, over the account's daily limit, or refused (not the owner, or withdrawn).",
      type: "counter",
      series: series(stats.requests, "outcome"),
    },
    {
      name: "open_science_evidence_source_reads_total",
      help: "Sources considered by those requests, by what the platform did: read, already read, no address, restricted (the site refuses), unreachable, or not read yet (the request's own bound).",
      type: "counter",
      series: series(stats.sources, "outcome"),
    },
  ];
}
