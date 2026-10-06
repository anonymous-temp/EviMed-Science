// The monthly figures the public pages and the API publish (flywheel F08, plan §8, 2026-10-06): `monthlyEvidenceFigures` for each of the
// last twelve months that have data.
//
// Hidden knowledge:
//
// - **Recomputed, then remembered for ten minutes.** The pass rate checks every published card's claims against its sources, which is
//   too much to do per page view and too little to be worth storing: the answer for all twelve months is built once, shared by every
//   request that arrives while it is being built (so a crowd costs one computation, not one each) and reused until it is ten minutes old.
//   Nothing is stored in a table — a figure that cannot be recomputed from the tables is not published (`evidenceFigures.mjs`).
// - **A month with no data says so.** The months run from the first month the tables have anything for (a card revision, a log entry or
//   a challenge) to the current one, newest first, at most twelve; a month inside that range with no claims, no corrections and no
//   challenges is `data: false` and the page writes “没有数据”, never 0.
// - **Months are Asia/Shanghai calendar months**, the platform's own day.

import { monthlyEvidenceFigures } from "./evidenceFigures.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

const MONTHS = 12;
const DEFAULT_TTL_MS = 600_000;

/** `YYYY-MM` of an instant in Asia/Shanghai. @param {Date} instant */
export function evidencePublicMonth(instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

/** @param {string} month @param {number} delta */
function shiftMonth(month, delta) {
  const [year, index] = month.split("-").map(Number);
  const total = year * 12 + (index - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/**
 * @param {{ database: any, now?: () => Date, ttlMs?: number, figures?: (query: { month: string }) => Promise<any> }} options
 *   `figures` is the month's computation; the default is the domain's own, over the database.
 */
export function createEvidencePublicMetrics({ database, now = () => new Date(), ttlMs = DEFAULT_TTL_MS, figures = (query) => monthlyEvidenceFigures(database, query) }) {
  const counters = { computed: 0, cacheHits: 0, failures: 0 };
  /** @type {{ at: number, value: any[] } | null} */
  let cached = null;
  /** @type {Promise<any[]> | null} */
  let building = null;

  async function build() {
    await migrateEvidenceZones(database);
    const first = (await database.query(
      `SELECT least(
         (SELECT min(recorded_at) FROM evimed_frontier.evidence_card_revisions),
         (SELECT min(occurred_at) FROM evimed_frontier.evidence_change_log),
         (SELECT min(created_at) FROM evimed_frontier.evidence_challenges)) AS first`)).rows[0]?.first;
    if (!first) return [];
    const current = evidencePublicMonth(now());
    const earliest = evidencePublicMonth(new Date(first));
    /** @type {{ month: string, data: boolean, figures: any }[]} */
    const months = [];
    for (let back = 0; back < MONTHS; back += 1) {
      const month = shiftMonth(current, -back);
      if (month < earliest) break;
      const value = await figures({ month });
      const data = value.verification.claims > 0 || value.corrections.entries > 0 || value.challenges.filed > 0;
      months.push({ month, data, figures: data ? value : null });
    }
    return months;
  }

  return {
    /** The last twelve months, newest first, each with its figures or `data: false`. */
    async months() {
      if (cached && now().getTime() - cached.at < ttlMs) { counters.cacheHits += 1; return cached.value; }
      if (!building) {
        building = build().then((value) => { cached = { at: now().getTime(), value }; counters.computed += 1; return value; })
          .catch((error) => { counters.failures += 1; throw error; })
          .finally(() => { building = null; });
      }
      return building;
    },
    stats: () => ({ ...counters }),
  };
}
