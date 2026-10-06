/**
 * The evidence flywheel's own figures (evidence-flywheel plan §11, 2026-10-06): the north star, the five groups of assets and the
 * guardrails, computed from tables that already exist and kept nowhere.
 *
 * Hidden knowledge:
 *
 * - **A figure with no input is `null` with the reason, never 0.** A week in which no reading was recorded and a deployment in which the
 *   table that records readings does not exist are different facts, and a dashboard that shows both as 0 hides the second. Every figure is
 *   `{ value, ... }` or `{ value: null, reason }`; a module another package adds (a question bank, a card reference in a study) is probed
 *   for in `information_schema` first and reads `null` until it exists.
 * - **The north star is cards, de-duplicated, not events.** A verified card is used in a week when at least one of five signals names it
 *   — read, cited by another account's research, cited by a 循证传播 article, cited by a 虚拟临研 study, cited by an AI assistant — and a card
 *   named by three signals counts once. The ways are reported beside it so a change in the star can be traced to the signal that moved.
 *   Card count, page views and words generated are deliberately not outcomes and appear nowhere here.
 * - **"Read" is a page opening, today.** The public pages record one counter per card and day (`evidence_page_reads`); no table records that
 *   a reader reached the end of a card, so the signal says `basis: "page_open"` and no more. The brief's "read to the end" becomes real the
 *   day a table says so.
 * - **An author's own research from their own card is not use** (`evidence_card_runs`, as `EvidenceOrigins` counts it): an author cannot
 *   thank themselves. Product zones are left out of the star: a product card's own project citing it is the company reading its own page.
 * - **A week is Monday to Sunday in Asia/Shanghai**, the platform's own day, as `evidence_page_reads.day` is.
 * - **The guardrails are structural checks, not the in-process counters.** The counters (`evidenceCardMetrics`) reset with the process and
 *   see only what this process refused; the guardrails read the rows, so "must be 0" is a fact about the data that survives a restart.
 *   A write's origin is stored only for the platform's internal writes (`editorial.reviewOrigin`); for every card the actor half of the
 *   allow-list (the zone's owner, or the platform publisher for an official zone) is checked, and the origin half where it was recorded.
 * - **Cost per verified claim is spend over net new ✓ claims.** The model money the programme spent in the window under purpose
 *   `evidence`, over the ✓ claims its revisions added to the platform's own cards in the same window (the ✓ of a card's last published
 *   revision in the window minus the ✓ of its last published revision before it) — so a card revised weekly is not counted anew each week.
 * - **One snapshot is a handful of table scans and some verification.** The route computes it fresh on each request (an operator's call);
 *   the Prometheus families read a snapshot kept for {@link SCRAPE_SNAPSHOT_MS}, because a scraper asks every fifteen seconds and the
 *   verification reads sources' full text. A snapshot that cannot be taken costs the scrape its series and the platform nothing.
 *
 * Which model capability would make it deletable: none. These are rows read and counted.
 *
 * @module evidenceFlywheelMetrics
 */
import { EVIDENCE_SIMULATED_VALUE_SOURCES, evidenceValueSourceIssues, evidenceWriteAllowed, verifyEvidenceCardClaims } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { migrateEvidenceOrigins } from "./evidenceOrigins.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";
import { monthlyEvidenceFigures } from "./evidenceFigures.mjs";
import { verifiedClaimCounts } from "./evidenceVerifiedCards.mjs";

/** The platform's own day. */
const TIME_ZONE_OFFSET = "+08:00";
const DAY_MS = 86_400_000;
/** Weeks one request may ask for. */
export const FLYWHEEL_MAX_WEEKS = 26;
export const FLYWHEEL_DEFAULT_WEEKS = 4;
/** How long the Prometheus families reuse one snapshot. */
export const SCRAPE_SNAPSHOT_MS = 600_000;
/** Cards the whole-library figures verify at most in one snapshot; past it they say so rather than reading on. */
export const FLYWHEEL_VERIFY_CARD_CAP = 2_000;
/** Rows one keyset page of a scan reads. */
const SCAN_PAGE = 100;
/** The five ways a card is used, in the order they are listed. */
export const FLYWHEEL_USE_WAYS = Object.freeze(["read", "research", "communication", "vcr", "assistant"]);

/** The write origins a user zone still takes from an operator import while no platform publisher is configured (`EvidenceZoneService.assertWriteOrigin`). */
const LEGACY_USER_ZONE_IMPORT = Object.freeze({ origin: "import", zoneKind: "user" });

/** @param {string} reason @returns {{ value: null, reason: string }} */
const absent = (reason) => ({ value: null, reason });
/** @param {number} value @param {number} places */
const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * The Monday-to-Monday week, in Asia/Shanghai, that holds an instant.
 * @param {Date} at
 * @returns {{ week: string, from: Date, to: Date, firstDay: string, lastDay: string }}
 */
export function flywheelWeekOf(at) {
  // Shift to the platform's wall clock, then find that day's Monday in UTC arithmetic over the shifted instant.
  const wall = new Date(at.getTime() + 8 * 3_600_000);
  const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  const sinceMonday = (wall.getUTCDay() + 6) % 7;
  const mondayWall = midnight - sinceMonday * DAY_MS;
  const day = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 10);
  const monday = day(mondayWall);
  return {
    week: monday,
    from: new Date(`${monday}T00:00:00${TIME_ZONE_OFFSET}`),
    to: new Date(`${day(mondayWall + 7 * DAY_MS)}T00:00:00${TIME_ZONE_OFFSET}`),
    firstDay: monday,
    lastDay: day(mondayWall + 6 * DAY_MS),
  };
}

/**
 * Whether a table's column exists, asked of the catalogue so a module another package adds is read only once it is there.
 * @param {any} database @param {string} schema @param {string} table @param {string} column
 */
async function columnExists(database, schema, table, column) {
  const { rows } = await database.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3", [schema, table, column]);
  return rows.length > 0;
}

/**
 * @param {{ database: any, platformPublisherUserId?: string | null, now?: () => Date,
 *   citationReaders?: { vcr?: CitationReader | null, assistant?: CitationReader | null } | null,
 *   predictionCalibration?: (() => Promise<any>) | null,
 *   evolutionTools?: (() => Promise<{ id?: string, status?: string, validationLevel?: string }[]>) | null,
 *   assistantCoverage?: (() => Promise<{ rounds: number | null, citedShare: number | null } | null>) | null,
 *   report?: ((code: string) => void) | null }} options
 *   A citation reader answers the card ids cited in `[from, to)` — or null with a reason when its input does not exist.
 * @typedef {(window: { from: Date, to: Date }) => Promise<{ cards: string[] } | { cards: null, reason: string }>} CitationReader
 */
export function createEvidenceFlywheelMetrics({ database, platformPublisherUserId = null, now = () => new Date(), citationReaders = null, predictionCalibration = null, evolutionTools = null, assistantCoverage = null, report = null }) {
  const counters = { snapshots: 0, snapshotFailures: 0, readerFailures: 0 };
  /** @type {{ at: number, value: any } | null} */
  let kept = null;

  /** One way's cards for a window: a set, or why there is none. @param {{ from: Date, to: Date, firstDay: string, lastDay: string }} week */
  async function usedCards(week) {
    /** @type {Record<string, { cards: Set<string> | null, reason?: string, basis?: string }>} */
    const ways = {};

    // Read: one counter per card and day; the table is the public pages' own, so a deployment without them has none.
    if (!(await columnExists(database, "evimed_frontier", "evidence_page_reads", "card_id"))) {
      ways.read = { cards: null, reason: "No page-read table exists in this deployment: the public evidence pages are not installed." };
    } else {
      const rows = (await database.query(
        "SELECT card_id FROM evimed_frontier.evidence_page_reads WHERE card_id<>'' AND day>=$1::date AND day<=$2::date GROUP BY card_id HAVING sum(reads)>0", [week.firstDay, week.lastDay])).rows;
      ways.read = { cards: new Set(rows.map((/** @type {any} */ row) => String(row.card_id))), basis: "page_open" };
    }

    // Research: another account's run that started from the card.
    await migrateEvidenceOrigins(database);
    const runs = (await database.query(
      `SELECT DISTINCT r.card_id FROM evimed_frontier.evidence_card_runs r JOIN evimed_frontier.evidence_cards c ON c.id=r.card_id
       WHERE r.started_at>=$1 AND r.started_at<$2 AND r.user_id<>c.user_id`, [week.from, week.to])).rows;
    ways.research = { cards: new Set(runs.map((/** @type {any} */ row) => String(row.card_id))) };

    // 循证传播: an article made from a card, or one whose text carries a reference to a card claim, once the module records either.
    const communication = await (async () => {
      const direct = await columnExists(database, "evimed_geo", "articles", "card_id");
      const referenced = await columnExists(database, "evimed_geo", "articles", "claim_refs");
      if (!direct && !referenced) return null;
      const found = new Set();
      if (direct) for (const row of (await database.query("SELECT DISTINCT card_id FROM evimed_geo.articles WHERE card_id IS NOT NULL AND created_at>=$1 AND created_at<$2", [week.from, week.to])).rows) found.add(String(row.card_id));
      if (referenced) for (const row of (await database.query(
        "SELECT DISTINCT ref->>'cardId' AS card_id FROM evimed_geo.articles a, jsonb_array_elements(a.claim_refs) ref WHERE a.created_at>=$1 AND a.created_at<$2 AND ref->>'cardId' IS NOT NULL", [week.from, week.to])).rows) found.add(String(row.card_id));
      return found;
    })();
    ways.communication = communication ? { cards: communication } : { cards: null, reason: "The communication module records no card reference in this deployment (no card_id or claim_refs on its articles)." };

    for (const [way, reader, why] of /** @type {[string, CitationReader | null | undefined, string][]} */ ([
      ["vcr", citationReaders?.vcr, "The virtual-clinical-research module records no card reference a count could read."],
      ["assistant", citationReaders?.assistant, "No question bank's citation rows exist in this deployment."],
    ])) {
      if (!reader) { ways[way] = { cards: null, reason: why }; continue; }
      try {
        const answer = await reader({ from: week.from, to: week.to });
        ways[way] = answer.cards ? { cards: new Set(answer.cards) } : { cards: null, reason: /** @type {any} */ (answer).reason ?? why };
      } catch {
        counters.readerFailures += 1;
        ways[way] = { cards: null, reason: "The reader of this signal failed; the figure is left out rather than counted as zero." };
      }
    }
    return ways;
  }

  /** The cards that may be counted: published, in a published official or user zone, not withdrawn, with a ✓. @param {string[]} cardIds */
  async function verifiedPublished(cardIds) {
    if (!cardIds.length) return new Set();
    const eligible = (await database.query(
      `SELECT c.id FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
       WHERE c.id=ANY($1::text[]) AND c.state='published' AND z.state='published' AND c.withdrawn IS NULL AND z.kind<>'product'`, [cardIds])).rows.map((/** @type {any} */ row) => String(row.id));
    const counts = await verifiedClaimCounts(database, eligible);
    return new Set(eligible.filter((id) => (counts.get(id)?.verified ?? 0) >= 1));
  }

  /** @param {ReturnType<typeof flywheelWeekOf>} week */
  async function northStarWeek(week) {
    const ways = await usedCards(week);
    const everyCard = [...new Set(Object.values(ways).flatMap((way) => [...(way.cards ?? [])]))];
    const verified = await verifiedPublished(everyCard);
    const answered = Object.values(ways).filter((way) => way.cards);
    return {
      week: week.week, from: week.from.toISOString(), to: week.to.toISOString(),
      verifiedCardsUsed: answered.length
        ? { value: [...verified].length, deduplicated: true, signalsAnswering: answered.length, signalsAsked: FLYWHEEL_USE_WAYS.length }
        : absent("No signal of use exists in this deployment."),
      ways: Object.fromEntries(FLYWHEEL_USE_WAYS.map((name) => {
        const way = ways[name];
        return [name, way.cards ? { value: [...way.cards].filter((id) => verified.has(id)).length, ...(way.basis ? { basis: way.basis } : {}) } : absent(way.reason ?? "No input.")];
      })),
    };
  }

  /** Every published card the library figures cover, as a keyset scan. @param {(rows: any[]) => Promise<void> | void} visit @param {string} columns @param {string} [extra] */
  async function scanPublished(visit, columns, extra = "") {
    let after = "";
    let seen = 0;
    for (;;) {
      const rows = (await database.query(
        `SELECT ${columns} FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
         WHERE c.id>$1 AND c.state='published' AND z.state='published' ${extra} ORDER BY c.id LIMIT ${SCAN_PAGE}`, [after])).rows;
      if (!rows.length) break;
      await visit(rows);
      seen += rows.length;
      after = String(rows.at(-1).id);
    }
    return seen;
  }

  async function evidenceBase() {
    const rows = (await database.query(
      `SELECT z.kind,count(*)::integer AS published,
         count(*) FILTER (WHERE c.withdrawn IS NULL AND c.retired_at IS NULL AND c.currency='current')::integer AS current
       FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id WHERE c.state='published' AND z.state='published' GROUP BY z.kind`)).rows;
    const published = rows.reduce((sum, row) => sum + row.published, 0);
    const current = rows.reduce((sum, row) => sum + row.current, 0);
    let verifiedClaims = 0;
    let cardsRead = 0;
    /** @type {string[]} */
    const ids = [];
    await scanPublished((page) => { for (const row of page) if (ids.length < FLYWHEEL_VERIFY_CARD_CAP) ids.push(String(row.id)); }, "c.id", "AND c.withdrawn IS NULL");
    for (const count of (await verifiedClaimCounts(database, ids)).values()) { verifiedClaims += count.verified; cardsRead += 1; }
    return {
      currentCards: { value: current, byZoneKind: Object.fromEntries(rows.map((row) => [row.kind, row.current])) },
      currentShare: published ? { value: round(current / published, 4), numerator: current, denominator: published } : absent("No card is published."),
      verifiedClaims: { value: verifiedClaims, cardsRead, ...(ids.length >= FLYWHEEL_VERIFY_CARD_CAP ? { truncatedAt: FLYWHEEL_VERIFY_CARD_CAP } : {}) },
    };
  }

  /** The public record: the month's verification rate, correction time and upheld share, and the predictions' calibration when there are enough. @param {Date} at */
  async function publicRecord(at) {
    const month = new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 7);
    const figures = await monthlyEvidenceFigures(database, { month });
    /** @type {{ value: number | null, reason?: string, scored?: number }} */
    let calibration = absent("The prediction registry is not enabled in this deployment.");
    if (predictionCalibration) {
      try {
        const answer = await predictionCalibration();
        calibration = answer.available && answer.probability?.brierMean != null
          ? { value: round(answer.probability.brierMean, 4), scored: answer.scored }
          : absent(`Only ${answer.scored ?? 0} predictions have been scored: not enough for a calibration yet.`);
      } catch { counters.readerFailures += 1; calibration = absent("The prediction registry could not be read."); }
    }
    return {
      month,
      verificationPassRate: figures.verification.passRate == null ? absent("No quotation-checked claim on a card published this month.") : { value: figures.verification.passRate, claims: figures.verification.claims },
      medianCorrectionHours: figures.corrections.medianLatencyHours == null ? absent("No correction this month started from a signal.") : { value: figures.corrections.medianLatencyHours, entries: figures.corrections.entries },
      challengesUpheldShare: figures.challenges.upheldShare == null ? absent("No challenge has been judged this month.") : { value: figures.challenges.upheldShare, filed: figures.challenges.filed },
      predictionBrier: calibration,
    };
  }

  async function toolLibrary() {
    if (!evolutionTools) return { toolsAtV2OrAbove: absent("The evolution module is not enabled in this deployment.") };
    try {
      const tools = (await evolutionTools()).filter((tool) => tool.status === "active" || tool.status === undefined);
      return { toolsAtV2OrAbove: { value: tools.filter((tool) => Number(String(tool.validationLevel ?? "").slice(1)) >= 2).length, activeTools: tools.length } };
    } catch { counters.readerFailures += 1; return { toolsAtV2OrAbove: absent("The tool ledger could not be read.") }; }
  }

  async function network() {
    const [authors, userCards, follows, cited] = (await Promise.all([
      database.query(
        `SELECT count(DISTINCT c.user_id)::integer AS n FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
         WHERE c.state='published' AND z.state='published' AND z.kind='user' AND z.visibility='internet' AND c.withdrawn IS NULL`),
      database.query(
        `SELECT count(*)::integer AS n FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
         WHERE c.state='published' AND z.state='published' AND z.kind='user' AND c.withdrawn IS NULL`),
      database.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_zone_follows"),
      database.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_card_runs r JOIN evimed_frontier.evidence_cards c ON c.id=r.card_id WHERE r.user_id<>c.user_id"),
    ])).map((result) => result.rows[0].n);
    return { publicAuthors: { value: authors }, userPublishedCards: { value: userCards }, follows: { value: follows }, cardRunsByOthers: { value: cited } };
  }

  async function measurement() {
    if (!assistantCoverage) return { questionBankRounds: absent("No question bank is composed in this deployment."), assistantCitedShare: absent("No question bank is composed in this deployment.") };
    try {
      const answer = await assistantCoverage();
      if (!answer) throw new Error("none");
      return {
        questionBankRounds: answer.rounds == null ? absent("The question bank has no round on record.") : { value: answer.rounds },
        assistantCitedShare: answer.citedShare == null ? absent("No assistant answer has been read for an EviMed page yet.") : { value: answer.citedShare },
      };
    } catch { counters.readerFailures += 1; return { questionBankRounds: absent("The question bank could not be read."), assistantCitedShare: absent("The question bank could not be read.") }; }
  }

  /** @param {ReturnType<typeof flywheelWeekOf>} week */
  async function guardrails(week) {
    const withoutProducer = Number((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_cards WHERE producer IS NULL")).rows[0].n);

    // Writes outside the allow-list. The actor half, for every card; the origin half, where the platform recorded one.
    let outside = 0;
    const actor = (await database.query(
      `SELECT count(*)::integer AS n FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
       WHERE CASE WHEN z.kind='official' THEN $1::text IS NOT NULL AND c.user_id<>$1::text ELSE c.user_id<>z.user_id END`, [platformPublisherUserId])).rows[0].n;
    outside += Number(actor);
    const origins = (await database.query(
      `SELECT z.kind,c.editorial->>'reviewOrigin' AS origin,count(*)::integer AS n FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
       WHERE c.editorial->>'reviewOrigin' IS NOT NULL GROUP BY 1,2`)).rows;
    for (const row of origins) {
      const legacy = row.kind === LEGACY_USER_ZONE_IMPORT.zoneKind && row.origin === LEGACY_USER_ZONE_IMPORT.origin && platformPublisherUserId == null;
      if (!legacy && !evidenceWriteAllowed({ origin: row.origin, zoneKind: row.kind, actorIsZoneOwner: true, actorIsPlatformPublisher: true }).allowed) outside += row.n;
    }

    // Simulated values in published cards: the same check the writer refuses with, read over what was stored.
    let simulated = 0;
    let derivedOnlyOutsideDerived = 0;
    await scanPublished((page) => {
      for (const row of page) {
        const issues = evidenceValueSourceIssues({ claims: row.claims ?? [], content: row.content ?? null });
        if (issues.some((issue) => EVIDENCE_SIMULATED_VALUE_SOURCES.includes(/** @type {any} */ (issue.valueSource)))) simulated += 1;
        else if (issues.length) derivedOnlyOutsideDerived += 1;
      }
    }, "c.id,c.claims,c.content");

    // Platform cards taken back after a reader's challenge, of the platform cards that were challenged.
    const challenged = (await database.query(
      `SELECT count(DISTINCT ch.card_id)::integer AS challenged,
         count(DISTINCT ch.card_id) FILTER (WHERE ch.outcome='withdraw' AND c.withdrawn IS NOT NULL)::integer AS withdrawn
       FROM evimed_frontier.evidence_challenges ch JOIN evimed_frontier.evidence_cards c ON c.id=ch.card_id JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id WHERE z.kind='official'`)).rows[0];

    return {
      cardsWithoutProducer: { value: withoutProducer, mustBe: 0 },
      writesOutsideAllowList: { value: outside, mustBe: 0, basis: "actor for every card; origin where recorded" },
      simulatedValuesInCards: { value: simulated, mustBe: 0, derivedOnlyValuesOutsideDerivedClaims: derivedOnlyOutsideDerived },
      platformCardsWithdrawnAfterChallenge: challenged.challenged
        ? { value: round(challenged.withdrawn / challenged.challenged, 4), numerator: challenged.withdrawn, denominator: challenged.challenged }
        : absent("No platform card has been challenged."),
      costPerVerifiedClaim: await costPerVerifiedClaim(week),
    };
  }

  /** @param {ReturnType<typeof flywheelWeekOf>} week */
  async function costPerVerifiedClaim(week) {
    if (!(await database.query("SELECT to_regclass('evimed_usage.model_requests') AS table_name")).rows[0].table_name) return absent("This deployment keeps no usage ledger.");
    const spend = Number((await database.query(
      "SELECT coalesce(sum(actual_cost),0) AS cost FROM evimed_usage.model_requests WHERE purpose='evidence' AND status='settled' AND created_at>=$1 AND created_at<$2", [week.from, week.to])).rows[0]?.cost ?? 0);
    // The last published revision of each platform card inside the window, and the one before it.
    const inWindow = (await database.query(
      `SELECT DISTINCT ON (r.card_id) r.card_id,r.revision,r.snapshot FROM evimed_frontier.evidence_card_revisions r
       JOIN evimed_frontier.evidence_cards c ON c.id=r.card_id JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
       WHERE z.kind='official' AND r.recorded_at>=$1 AND r.recorded_at<$2 AND r.snapshot->>'state'='published' ORDER BY r.card_id,r.revision DESC`, [week.from, week.to])).rows;
    let added = 0;
    for (const row of inWindow) {
      const verified = (/** @type {any} */ revision) => verifyEvidenceCardClaims({ claims: revision?.claims ?? [], sources: revision?.sources ?? [] }).counts.verified;
      const before = (await database.query(
        `SELECT snapshot FROM evimed_frontier.evidence_card_revisions WHERE card_id=$1 AND recorded_at<$2 AND snapshot->>'state'='published' ORDER BY revision DESC LIMIT 1`,
        [row.card_id, week.from])).rows[0];
      added += Math.max(0, verified(row.snapshot) - (before ? verified(before.snapshot) : 0));
    }
    if (!added) return { ...absent(spend ? "The programme spent money this week and no ✓ claim was added to a platform card." : "No ✓ claim was added to a platform card this week."), spendCny: round(spend, 4), verifiedClaimsAdded: 0 };
    return { value: round(spend / added, 4), unit: "CNY per ✓ claim", spendCny: round(spend, 4), verifiedClaimsAdded: added };
  }

  /**
   * One snapshot: the weeks' north stars (the newest first), the five asset groups and the guardrails.
   * @param {{ weeks?: number }} [query]
   */
  async function snapshot({ weeks = FLYWHEEL_DEFAULT_WEEKS } = {}) {
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > FLYWHEEL_MAX_WEEKS) throw new HttpError(400, "evidence_query_invalid", `weeks is a whole number from 1 to ${FLYWHEEL_MAX_WEEKS}.`);
    await migrateEvidenceZones(database);
    const at = now();
    const current = flywheelWeekOf(at);
    const series = [];
    for (let back = 0; back < weeks; back += 1) series.push(await northStarWeek(flywheelWeekOf(new Date(current.from.getTime() - back * 7 * DAY_MS + 3_600_000))));
    const evidence = await evidenceBase();
    const result = {
      generatedAt: at.toISOString(),
      definition: {
        northStar: "Verified cards used per week, de-duplicated: a published, non-product, non-withdrawn card with at least one ✓ claim that any answering signal names in the week.",
        week: "Monday 00:00 to Monday 00:00, Asia/Shanghai",
        notOutcomes: ["card count", "page views", "words generated"],
      },
      northStar: series,
      assets: {
        evidenceBase: evidence,
        publicRecord: await publicRecord(at),
        toolLibrary: await toolLibrary(),
        network: await network(),
        measurement: await measurement(),
      },
      guardrails: { ...(await guardrails(current)), week: current.week },
    };
    counters.snapshots += 1;
    return result;
  }

  /**
   * The snapshot the Prometheus families read: the current week alone, kept for {@link SCRAPE_SNAPSHOT_MS}. A failure is counted and answers null.
   */
  async function scrapeSnapshot() {
    const clock = now().getTime();
    if (kept && clock - kept.at < SCRAPE_SNAPSHOT_MS) return kept.value;
    try {
      kept = { at: clock, value: await snapshot({ weeks: 1 }) };
      return kept.value;
    } catch {
      counters.snapshotFailures += 1;
      report?.("evidence_flywheel_snapshot_failed");
      return kept?.value ?? null;
    }
  }

  /** The Prometheus families: gauges for what the snapshot could compute, nothing for what it could not. */
  async function metricFamilies() {
    const view = await scrapeSnapshot();
    /** @type {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>} */
    const families = [
      { name: "open_science_evidence_flywheel_snapshots_total", help: "Flywheel metric snapshots taken for the operator route and the scrape, and those that failed.", type: "counter",
        series: [{ value: counters.snapshots, labels: { outcome: "taken" } }, { value: counters.snapshotFailures, labels: { outcome: "failed" } }, { value: counters.readerFailures, labels: { outcome: "reader_failed" } }] },
    ];
    if (!view) return families;
    const star = view.northStar[0];
    /** @type {Array<{ value: number, labels?: Record<string, string> }>} */
    const used = [];
    if (star.verifiedCardsUsed.value != null) used.push({ value: star.verifiedCardsUsed.value, labels: { way: "any" } });
    for (const [way, figure] of Object.entries(star.ways)) if (/** @type {any} */ (figure).value != null) used.push({ value: /** @type {any} */ (figure).value, labels: { way } });
    families.push({ name: "open_science_evidence_flywheel_verified_cards_used", help: "Verified evidence cards used in the current week (Asia/Shanghai Monday to Sunday), de-duplicated across ways; way=any is the north star. A way with no input is absent, not zero.", type: "gauge", series: used });
    const guard = view.guardrails;
    /** @type {Array<{ value: number, labels?: Record<string, string> }>} */
    const guardSeries = [];
    for (const name of ["cardsWithoutProducer", "writesOutsideAllowList", "simulatedValuesInCards"]) guardSeries.push({ value: guard[name].value, labels: { guard: name } });
    for (const name of ["platformCardsWithdrawnAfterChallenge", "costPerVerifiedClaim"]) if (guard[name].value != null) guardSeries.push({ value: guard[name].value, labels: { guard: name } });
    families.push({ name: "open_science_evidence_flywheel_guardrail", help: "The flywheel's guardrails read from the rows: cards without a producer, writes outside the allow-list and simulated values in cards must be 0; the withdrawn-after-challenge share and the cost per ✓ claim (CNY) are watched.", type: "gauge", series: guardSeries });
    const base = view.assets.evidenceBase;
    families.push({ name: "open_science_evidence_flywheel_assets", help: "Evidence-base assets: current cards, ✓ claims standing on published cards, and the public authors and cards users published.", type: "gauge", series: [
      { value: base.currentCards.value, labels: { asset: "current_cards" } }, { value: base.verifiedClaims.value, labels: { asset: "verified_claims" } },
      { value: view.assets.network.publicAuthors.value, labels: { asset: "public_authors" } }, { value: view.assets.network.userPublishedCards.value, labels: { asset: "user_cards" } },
    ] });
    return families;
  }

  return { snapshot, metricFamilies, stats: () => ({ ...counters }) };
}
