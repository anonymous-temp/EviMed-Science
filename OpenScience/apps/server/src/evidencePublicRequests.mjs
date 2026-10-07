// The public topic-request entry of the evidence zones (flywheel F08, plan §8 「任何人都能申请选题」, 2026-10-06): anyone may read the list
// of requested topics, ordered by how many distinct accounts asked for each; a signed-in account may file one or second one.
//
// Hidden knowledge:
//
// - **Order is a count of distinct accounts, and only that.** `evidence_topic_request_votes` has one row per (request, account), so a
//   second vote by the same account is a no-op by the table's key, and the list's order is the number of rows. Nothing about who
//   asked, how often or how recently decides it, and there is no way to pay for a place. Ties go to the request that was filed first.
// - **Filing is seconding.** The filer's own vote is the request's first. A title that folds to the same words as one already on the
//   list (NFKC, whitespace collapsed, case folded — a format fold, not a reading) is that request, and filing it again is a vote for it:
//   one topic is one row however many people typed it. Optional J14 can reuse a semantically identical request; related topics
//   keep separate requests and votes, with a bidirectional public link. An uncertain or unavailable decision keeps the title fold.
// - **One account cannot flood the list.** A signed-in account makes at most `OPEN_SCIENCE_EVIDENCE_TOPIC_REQUESTS_PER_DAY` new votes
//   (filing or seconding) in a day. Voting again for something already voted for costs nothing and changes nothing. The count is taken
//   under a per-account lock so two parallel requests cannot both pass it.
// - **The selector reads counts, never accounts.** `topicRequestCounts` returns the requests with their number of requesters; who they
//   are stays in the votes table.
// - **User-written titles are plain text.** A title is 4 to 200 characters with no control character, and every page that shows it
//   escapes it; the public list page is `noindex` because any account may put a line on it.

import { queryTerms } from "./evidenceZoneSubscription.mjs";
import { randomUUID } from "node:crypto";
import { HttpError, readJson, sendJson } from "./security.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";
import { EVIDENCE_PUBLIC_ZONE_ID, evidencePublicPredicate } from "./evidencePublicQuery.mjs";

const TITLE_MIN = 4;
const TITLE_MAX = 200;
const REQUEST_ID = /^tr_[a-f0-9]{32}$/;
/** The longest list one read returns. */
export const EVIDENCE_TOPIC_REQUEST_LIST_MAX = 100;

const invalid = (/** @type {string} */ message) => new HttpError(400, "evidence_topic_request_invalid", message);

/**
 * A title as it is kept and compared: NFKC, whitespace collapsed, trimmed.
 * @param {unknown} value
 */
export function normalizeTopicTitle(value) {
  if (typeof value !== "string") throw invalid("A topic request needs a title.");
  // Whitespace folds to one space below; any other control character (or a line/paragraph separator) is never part of a title.
  const hasControl = [...value].some((character) => {
    const code = /** @type {number} */ (character.codePointAt(0));
    return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
  });
  if (hasControl) throw invalid("A title has no control characters.");
  const title = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  const length = [...title].length;
  if (length < TITLE_MIN || length > TITLE_MAX) throw invalid(`A title is ${TITLE_MIN} to ${TITLE_MAX} characters.`);
  return title;
}

/** @param {any} row */
const relatedIdsSql = `(SELECT COALESCE(array_agg(CASE WHEN l.left_id=r.id THEN l.right_id ELSE l.left_id END ORDER BY l.left_id,l.right_id), ARRAY[]::text[])
  FROM evimed_frontier.evidence_topic_request_links l WHERE l.left_id=r.id OR l.right_id=r.id)`;

const requestView = (row) => ({
  id: String(row.id), title: String(row.title), zoneId: row.zone_title ? String(row.zone_id) : null, zoneTitle: row.zone_title ?? null,
  relatedRequestIds: Array.isArray(row.related_request_ids) ? row.related_request_ids.map(String) : [],
  requesters: Number(row.requesters), createdAt: new Date(row.created_at).toISOString(),
});

/**
 * The requests with their number of distinct requesters, most first, the earlier first among equals. The topic selector's input.
 * @param {any} database @param {{ limit?: number }} [query]
 * @returns {Promise<{ id: string, title: string, zoneId: string | null, zoneTitle: string | null, requesters: number, createdAt: string }[]>}
 */
export async function topicRequestCounts(database, { limit = 50 } = {}) {
  const size = Number(limit);
  if (!Number.isSafeInteger(size) || size < 1 || size > EVIDENCE_TOPIC_REQUEST_LIST_MAX) throw new TypeError(`limit is a whole number from 1 to ${EVIDENCE_TOPIC_REQUEST_LIST_MAX}.`);
  await migrateEvidenceZones(database);
  const rows = (await database.query(
    `SELECT r.id, r.title, r.zone_id, r.created_at, count(v.user_id)::integer AS requesters, z.title AS zone_title, ${relatedIdsSql} AS related_request_ids
     FROM evimed_frontier.evidence_topic_requests r JOIN evimed_frontier.evidence_topic_request_votes v ON v.request_id = r.id
       LEFT JOIN evimed_frontier.evidence_zones z ON z.id = r.zone_id AND ${evidencePublicPredicate("zones")}
     GROUP BY r.id, z.title ORDER BY requesters DESC, r.created_at ASC, r.id ASC LIMIT $1`, [size])).rows;
  return rows.map(requestView);
}

/**
 * @param {{ database: any, config: { evidenceTopicRequestsPerDay?: number }, judgeService?: any, judgeContext?:(user:{id:string})=>Promise<{userId:string,projectId:string}> }} options
 */
export function createEvidenceTopicRequests({ database, config, judgeService = null, judgeContext = null }) {
  const counters = { filed: 0, seconded: 0, alreadySeconded: 0, refusedLimit: 0, refusedInvalid: 0 };
  const perDay = () => Number(config.evidenceTopicRequestsPerDay ?? 5);

  /** @param {any} client @param {string} userId */
  async function usedToday(client, userId) {
    return Number((await client.query(
      "SELECT count(*)::integer AS n FROM evimed_frontier.evidence_topic_request_votes WHERE user_id = $1 AND created_at > clock_timestamp() - interval '1 day'", [userId])).rows[0].n);
  }

  /** @param {any} client @param {string} requestId */
  async function viewOf(client, requestId) {
    const row = (await client.query(
      `SELECT r.id, r.title, r.zone_id, r.created_at, (SELECT count(*)::integer FROM evimed_frontier.evidence_topic_request_votes v WHERE v.request_id = r.id) AS requesters, z.title AS zone_title, ${relatedIdsSql} AS related_request_ids
       FROM evimed_frontier.evidence_topic_requests r LEFT JOIN evimed_frontier.evidence_zones z ON z.id = r.zone_id AND ${evidencePublicPredicate("zones")} WHERE r.id = $1`, [requestId])).rows[0];
    return requestView(row);
  }

  /**
   * Vote for a request the caller has found or made, under the account's daily ceiling. `alreadyVoted` costs nothing.
   * @param {any} client @param {string} userId @param {string} requestId @param {boolean} created
   */
  async function vote(client, userId, requestId, created) {
    const had = Boolean((await client.query("SELECT 1 FROM evimed_frontier.evidence_topic_request_votes WHERE request_id = $1 AND user_id = $2", [requestId, userId])).rowCount);
    if (had) { counters.alreadySeconded += 1; return { seconded: false, alreadySeconded: true }; }
    if (await usedToday(client, userId) >= perDay()) {
      counters.refusedLimit += 1;
      throw new HttpError(429, "evidence_topic_request_limit", "Too many topic requests today.", { retryAfterSeconds: 3600 });
    }
    await client.query("INSERT INTO evimed_frontier.evidence_topic_request_votes(request_id, user_id) VALUES($1, $2)", [requestId, userId]);
    counters[created ? "filed" : "seconded"] += 1;
    return { seconded: true, alreadySeconded: false };
  }

  return {
    /**
     * File a request (or second the one with the same words).
     * @param {{ id: string }} user @param {any} body
     */
    async file(user, body) {
      /** @type {string} */
      let title;
      try {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["title", "zoneId"].includes(key))) throw invalid("A topic request is { title, zoneId? }.");
        title = normalizeTopicTitle(body.title);
        if (body.zoneId != null && (typeof body.zoneId !== "string" || !EVIDENCE_PUBLIC_ZONE_ID.test(body.zoneId))) throw invalid("zoneId names an evidence zone.");
      } catch (error) {
        counters.refusedInvalid += 1;
        throw error;
      }
      await migrateEvidenceZones(database);
      const key = title.toLowerCase();
      // Reject known invalid targets and quota refusals before optional paid work.
      if (body.zoneId != null && !(await database.query(`SELECT 1 FROM evimed_frontier.evidence_zones z WHERE z.id=$1 AND ${evidencePublicPredicate("zones")}`, [body.zoneId])).rowCount)
        { counters.refusedInvalid++; throw invalid("zoneId names a published zone that is open to the internet."); }
      const deadlineMs = Date.now() + 8000;
      const retry = Symbol("topic-request-snapshot-changed");
      for (let attempt = 0; ; attempt++) {
        const exact = (await database.query("SELECT id FROM evimed_frontier.evidence_topic_requests WHERE title_key=$1", [key])).rows[0];
        if (await usedToday(database, user.id) >= perDay()) {
          const had = exact && (await database.query("SELECT 1 FROM evimed_frontier.evidence_topic_request_votes WHERE request_id=$1 AND user_id=$2", [exact.id, user.id])).rowCount;
          if (!had) { counters.refusedLimit++; throw new HttpError(429, "evidence_topic_request_limit", "Too many topic requests today.", { retryAfterSeconds: 3600 }); }
        }
        let snapshotCount = null, same = null;
        const related = [];
        if (!exact && judgeService && attempt < 3 && Date.now() < deadlineMs) {
          snapshotCount = Number((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_topic_requests")).rows[0].n);
          // A bounded lexical shortlist, with recent requests as the stable tie-breaker.
          // Every title here is already public; no account or zone draft enters the model.
          const candidates = (await database.query(`SELECT id,title FROM evimed_frontier.evidence_topic_requests
            ORDER BY (SELECT count(*) FROM unnest($1::text[]) t WHERE strpos(lower(title),t)>0) DESC,created_at DESC,id ASC LIMIT 15`, [queryTerms(title)])).rows;
          let context = null;
          if (candidates.length && judgeContext) {
            try { context = await judgeContext(user); } catch { /* Keep exact-title filing when attribution is unavailable. */ }
          }
          if (context?.userId !== user.id || !context?.projectId) context = null;
          for (const candidate of context ? candidates : []) {
            if (Date.now() >= deadlineMs) break;
            let decision;
            try { decision = await judgeService.judge("J14", { left: title, right: candidate.title }, { ...context, module: "learning", deadlineMs }); }
            catch { continue; }
            if (["judge_disabled", "judge_unconfigured", "judge_uncalibrated", "judge_calibration_mismatch"].includes(decision?.code)) break;
            if (decision?.outcome !== "settled") continue;
            if (decision.value?.relation === "same") { same = candidate; break; }
            if (decision.value?.relation === "related") related.push(candidate);
          }
        }
        // Only the short mutation holds locks. In particular, paid ledger rows never
        // join the vote transaction and survive a later quota refusal or rollback.
        const result = await database.transaction(async (/** @type {any} */ client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evidence-topic-request:${user.id}`]);
          if (judgeService) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["evidence-topic-request:semantic"]);
          if (body.zoneId != null) {
            const zone = (await client.query(`SELECT 1 FROM evimed_frontier.evidence_zones z WHERE z.id=$1 AND ${evidencePublicPredicate("zones")}`, [body.zoneId])).rowCount;
            if (!zone) { counters.refusedInvalid++; throw invalid("zoneId names a published zone that is open to the internet."); }
          }
          const existing = (await client.query("SELECT id FROM evimed_frontier.evidence_topic_requests WHERE title_key=$1", [key])).rows[0];
          let requestId = existing?.id;
          if (!requestId && snapshotCount !== null) {
            const currentCount = Number((await client.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_topic_requests")).rows[0].n);
            if (currentCount !== snapshotCount) return retry;
          }
          if (!requestId && same && (await client.query("SELECT 1 FROM evimed_frontier.evidence_topic_requests WHERE id=$1 AND title=$2", [same.id, same.title])).rowCount) requestId = same.id;
          let created = !requestId;
          if (!requestId) {
            requestId = `tr_${randomUUID().replaceAll("-", "")}`;
            const inserted = await client.query(
              "INSERT INTO evimed_frontier.evidence_topic_requests(id,title,title_key,zone_id) VALUES($1,$2,$3,$4) ON CONFLICT(title_key) DO NOTHING RETURNING id", [requestId, title, key, body.zoneId ?? null]);
            if (!inserted.rowCount) { requestId = (await client.query("SELECT id FROM evimed_frontier.evidence_topic_requests WHERE title_key=$1", [key])).rows[0].id; created = false; }
          }
          const outcome = await vote(client, user.id, requestId, created);
          for (const candidate of related) {
            if (candidate.id === requestId) continue;
            // Recheck model-visible identity before persisting a link.
            if (!(await client.query("SELECT 1 FROM evimed_frontier.evidence_topic_requests WHERE id=$1 AND title=$2", [candidate.id, candidate.title])).rowCount) continue;
            const [left, right] = [String(requestId), String(candidate.id)].sort();
            await client.query("INSERT INTO evimed_frontier.evidence_topic_request_links(left_id,right_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [left, right]);
          }
          return { request: await viewOf(client, requestId), filed: created, ...outcome };
        });
        if (result !== retry) return result;
        // Re-evaluate changed candidates outside locks, within the same total
        // deadline. Exhaustion keeps the original exact-title fallback.
      }
    },

    /**
     * Second a request that is on the list.
     * @param {{ id: string }} user @param {string} requestId
     */
    async second(user, requestId) {
      if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new HttpError(404, "evidence_topic_request_not_found", "No such topic request.");
      await migrateEvidenceZones(database);
      return database.transaction(async (/** @type {any} */ client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evidence-topic-request:${user.id}`]);
        if (!(await client.query("SELECT 1 FROM evimed_frontier.evidence_topic_requests WHERE id = $1", [requestId])).rowCount) {
          throw new HttpError(404, "evidence_topic_request_not_found", "No such topic request.");
        }
        const outcome = await vote(client, user.id, requestId, false);
        return { request: await viewOf(client, requestId), filed: false, ...outcome };
      });
    },

    /**
     * The list a reader (or the page) sees, and, for a signed-in account, the requests it has already voted for and what is left of today.
     * @param {{ limit?: number, userId?: string | null }} [query]
     */
    async list({ limit = 50, userId = null } = {}) {
      const items = await topicRequestCounts(database, { limit });
      if (!userId) return { items };
      const mine = (await database.query("SELECT request_id FROM evimed_frontier.evidence_topic_request_votes WHERE user_id = $1 AND request_id = ANY($2::text[])", [userId, items.map((item) => item.id)])).rows.map((/** @type {any} */ row) => String(row.request_id));
      const used = await usedToday(database, userId);
      return { items, seconded: mine, remainingToday: Math.max(0, perDay() - used) };
    },

    stats: () => ({ ...counters }),
  };
}

/**
 * The signed-in half of the topic requests, at the door every frontier route uses (frontier on, a session, CSRF checked).
 *
 * - `GET  /api/frontier/evidence/topic-requests` — the list, and which of them the account has voted for;
 * - `POST /api/frontier/evidence/topic-requests` `{ title, zoneId? }` — file a request (or second the one with the same words);
 * - `POST /api/frontier/evidence/topic-requests/:id/second` — second one.
 *
 * With the public pages off (`OPEN_SCIENCE_EVIDENCE_PUBLIC_WEB_ENABLED`) none of it exists and each answers 404 `evidence_public_not_enabled`.
 * @param {{ store: any, requests: ReturnType<typeof createEvidenceTopicRequests> | null, frontier: any, config: Record<string, any>, maxJsonBytes: number }} options
 */
export function createEvidenceTopicRequestRoutes({ store, requests, frontier, config, maxJsonBytes }) {
  const SECOND_PATH = /^\/api\/frontier\/evidence\/topic-requests\/([^/]+)\/second$/;
  const BASE_PATH = "/api/frontier/evidence/topic-requests";
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const second = SECOND_PATH.exec(url.pathname);
    if (url.pathname !== BASE_PATH && !second) return false;
    if (config.evidencePublicWebEnabled !== true || !requests) throw new HttpError(404, "evidence_public_not_enabled", "The public evidence pages are not enabled.");
    if (!config.frontierEnabled || !frontier) throw new HttpError(404, "frontier_not_enabled", "The frontier feed is not enabled.");
    const method = req.method ?? "GET";
    const allowed = second ? method === "POST" : method === "GET" || method === "POST";
    if (!allowed) throw new HttpError(404, "not_found", "No such evidence route.");
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!frontier.allows(user)) throw new HttpError(404, "frontier_not_enabled", "The frontier feed is not enabled.");
    const reply = (/** @type {any} */ value) => { sendJson(res, 200, { data: value }, { "Cache-Control": "private, no-store" }); return true; };
    if (second) {
      let id = "";
      try { id = decodeURIComponent(second[1]); } catch { /* an id that does not decode is not one */ }
      return reply(await requests.second(user, id));
    }
    if (method === "GET") return reply(await requests.list({ userId: user.id }));
    return reply(await requests.file(user, await readJson(req, maxJsonBytes)));
  };
}
