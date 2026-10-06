/**
 * The three numbers the platform publishes about its own evidence, month by month (evidence-flywheel plan 2026-10-05 §8, §11): how many
 * of the claims on published cards were found verbatim in their sources, how long a correction takes from the day its cause was first seen,
 * and how many challenges readers made and what became of them.
 *
 * Hidden knowledge:
 *
 * - **Computed from the tables, never kept.** Nothing here is a stored total: the pass rate is the verbatim check
 *   (`verifyEvidenceCardClaims`, the one the reader's ✓ uses) run over each published card's last revision recorded before the month ended;
 *   the latency is a log entry's date minus the earliest `firstSeenAt` of the source changes it names, or the challenge's creation; the
 *   challenges are counted as the table holds them. A figure that cannot be recomputed from the tables is not published.
 * - **A month is a calendar month in Asia/Shanghai**, the platform's own day (`frontierTimeZone`), so a correction made at 00:30 on the 1st
 *   belongs to the new month for the people who made it.
 * - **A latency is only taken where a signal started it:** a source change or a challenge. An update the producer chose to make, or a scheduled
 *   check that found nothing, has no "from" and is not a latency.
 * - **No data is a null, not a zero.** A month with no corrections has no median.
 *
 * @module evidenceFigures
 */
import { verifyEvidenceCardClaims } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

/** Cards whose revisions are verified in one read: each snapshot carries its sources' full text. */
const CARD_BATCH = 20;
/** The reactive triggers whose entries are corrections timed from a cause. */
const LATENCY_TRIGGERS = ["source_change", "challenge"];

/** @param {number[]} values */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return Math.round((sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) * 100) / 100;
}

/**
 * The first and the first-after instants of a month, in Asia/Shanghai.
 * @param {unknown} month `YYYY-MM`
 */
export function evidenceFigureMonth(month) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(typeof month === "string" ? month : "");
  if (!match) throw new HttpError(400, "evidence_query_invalid", "A month is written YYYY-MM.");
  const year = Number(match[1]);
  const index = Number(match[2]);
  const next = index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, "0")}`;
  return { month: `${match[1]}-${match[2]}`, from: new Date(`${match[1]}-${match[2]}-01T00:00:00+08:00`), to: new Date(`${next}-01T00:00:00+08:00`) };
}

/**
 * @param {any} database @param {{ month: string }} query
 * @returns {Promise<{
 *   month: string, from: string, to: string,
 *   verification: { cards: number, claims: number, verified: number, passRate: number | null },
 *   corrections: { entries: number, medianLatencyHours: number | null, bySource: Record<string, { entries: number, medianLatencyHours: number | null }> },
 *   challenges: { filed: number, upheld: number, amended: number, withdrawn: number, producerNotified: number, closed: number, open: number, upheldShare: number | null },
 * }>}
 */
export async function monthlyEvidenceFigures(database, { month }) {
  const range = evidenceFigureMonth(month);
  await migrateEvidenceZones(database);

  // Verification: each published card as it stood at the end of the month.
  let cards = 0;
  let claims = 0;
  let verified = 0;
  let after = "";
  for (;;) {
    const page = (await database.query(
      `SELECT DISTINCT ON (r.card_id) r.card_id,r.snapshot FROM evimed_frontier.evidence_card_revisions r
       JOIN evimed_frontier.evidence_cards c ON c.id=r.card_id JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
       WHERE r.card_id>$1 AND r.recorded_at<$2 AND r.snapshot->>'state'='published' AND z.state='published'
         AND (c.withdrawn IS NULL OR (c.withdrawn->>'at')::timestamptz>=$2)
       ORDER BY r.card_id,r.revision DESC LIMIT $3`, [after, range.to, CARD_BATCH])).rows;
    if (!page.length) break;
    for (const row of page) {
      const counts = verifyEvidenceCardClaims({ claims: row.snapshot.claims ?? [], sources: row.snapshot.sources ?? [] }).counts;
      if (counts.total > 0) cards += 1;
      claims += counts.total;
      verified += counts.verified;
    }
    after = page.at(-1).card_id;
  }

  // Corrections: timed from the signal that started them.
  const entries = (await database.query(
    `SELECT l.trigger,l.occurred_at,l.refs,(SELECT ch.created_at FROM evimed_frontier.evidence_challenges ch WHERE ch.id=l.refs->>'challengeId') AS challenge_at
     FROM evimed_frontier.evidence_change_log l WHERE l.occurred_at>=$1 AND l.occurred_at<$2 AND l.category IN ('correction','withdrawal') AND l.trigger=ANY($3::text[])`,
    [range.from, range.to, LATENCY_TRIGGERS])).rows;
  /** @type {Record<string, number[]>} */
  const hours = Object.fromEntries(LATENCY_TRIGGERS.map((trigger) => [trigger, []]));
  for (const entry of entries) {
    const seen = (Array.isArray(entry.refs?.sourceChanges) ? entry.refs.sourceChanges : []).map((/** @type {any} */ change) => Date.parse(change?.firstSeenAt)).filter(Number.isFinite);
    const started = entry.trigger === "challenge" ? (entry.challenge_at ? new Date(entry.challenge_at).getTime() : NaN) : (seen.length ? Math.min(...seen) : NaN);
    const took = (new Date(entry.occurred_at).getTime() - started) / 3_600_000;
    if (Number.isFinite(took) && took >= 0) hours[entry.trigger].push(took);
  }

  // Challenges filed in the month, as they stand now.
  const filed = (await database.query(
    `SELECT state,outcome,route,count(*)::integer AS n FROM evimed_frontier.evidence_challenges WHERE created_at>=$1 AND created_at<$2 GROUP BY state,outcome,route`,
    [range.from, range.to])).rows;
  /** @param {(row: any) => boolean} test */
  const total = (test) => filed.filter(test).reduce((sum, row) => sum + row.n, 0);
  const upheld = total((row) => row.outcome === "uphold");
  const amended = total((row) => row.outcome === "amend");
  const withdrawn = total((row) => row.outcome === "withdraw");
  const judged = upheld + amended + withdrawn;

  return {
    month: range.month, from: range.from.toISOString(), to: range.to.toISOString(),
    verification: { cards, claims, verified, passRate: claims ? Math.round((verified / claims) * 10_000) / 10_000 : null },
    corrections: {
      entries: entries.length,
      medianLatencyHours: median(LATENCY_TRIGGERS.flatMap((trigger) => hours[trigger])),
      bySource: Object.fromEntries(LATENCY_TRIGGERS.map((trigger) => [trigger, { entries: entries.filter((entry) => entry.trigger === trigger).length, medianLatencyHours: median(hours[trigger]) }])),
    },
    challenges: {
      filed: total(() => true), upheld, amended, withdrawn,
      producerNotified: total((row) => row.route === "producer_notice"),
      closed: total((row) => row.state === "closed"),
      open: total((row) => row.state === "open"),
      upheldShare: judged ? Math.round((upheld / judged) * 10_000) / 10_000 : null,
    },
  };
}

/**
 * The figures as a function of the month alone, over the module's database: what the public pages package holds.
 * @param {{ database: any }} options
 */
export function createEvidenceFigures({ database }) {
  return { monthlyEvidenceFigures: (/** @type {{ month: string }} */ query) => monthlyEvidenceFigures(database, query) };
}
