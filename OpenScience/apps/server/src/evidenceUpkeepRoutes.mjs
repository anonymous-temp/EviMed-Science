import { HttpError, readJson, sendJson } from "./security.mjs";

/**
 * The routes of keeping evidence current (evidence-flywheel plan 2026-10-05 §5.4, §8):
 *
 * - `POST /api/frontier/evidence/:cardId/challenges` `{ claimId, reason }` — a reader challenges one claim of a published card;
 * - `GET  /api/frontier/evidence/:cardId/challenges` — the reader's own challenges on that card and where each stands;
 * - `POST /api/frontier/evidence/:cardId/upkeep` `{ action: "retire" | "reopen" | "reviewed" }` — a producer's word about their card;
 * - `GET  /api/frontier/zones/:id/changes?cardId=&limit=&before=` — the zone's public change log, newest first.
 *
 * Same door as the zone routes: the frontier on, a signed-in account in its audience, CSRF checked. With the upkeep switched off
 * (`OPEN_SCIENCE_EVIDENCE_UPKEEP_ENABLED`) none of them exists and each answers 404 `evidence_upkeep_not_enabled`. Registered before the zone
 * routes, which would otherwise answer `…/zones/:id/changes` with their own 404.
 *
 * @param {{ store: any, service: any, frontier: any, config: any, challenges: any, upkeep: any, changeLog: any, maxJsonBytes: number }} options
 */
export function createEvidenceUpkeepRoutes({ store, service, frontier, config, challenges, upkeep, changeLog, maxJsonBytes }) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const mine = url.pathname.startsWith("/api/frontier/evidence/") || (url.pathname.startsWith("/api/frontier/zones/") && url.pathname.endsWith("/changes"));
    if (!mine) return false;
    let parts;
    try {
      parts = url.pathname.slice("/api/frontier/".length).split("/").map(decodeURIComponent);
    } catch {
      throw new HttpError(400, "evidence_invalid", "Invalid path.");
    }
    const method = req.method ?? "GET";
    const target = (parts[0] === "evidence" && parts.length === 3 && ["challenges", "upkeep"].includes(parts[2]))
      || (parts[0] === "zones" && parts.length === 3 && parts[2] === "changes");
    if (!target) return false;
    if (!config.frontierEnabled || !service || !frontier || !config.evidenceUpkeepEnabled || !changeLog)
      throw new HttpError(404, "evidence_upkeep_not_enabled", "Keeping evidence current is not enabled.");
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!frontier.allows(user)) throw new HttpError(404, "frontier_not_enabled", "The frontier feed is not enabled.");
    if (parts.some((part) => part.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(part))) throw new HttpError(400, "evidence_invalid", "Invalid path.");
    const reply = (/** @type {any} */ value) => {
      sendJson(res, 200, { data: value }, { "Cache-Control": "private, no-store" });
      return true;
    };
    const id = parts[1];
    if (parts[0] === "zones") {
      if (method !== "GET") throw new HttpError(404, "not_found", "No such evidence route.");
      // Who may read a zone may read its history: the zone must be visible to this reader.
      await service.database.transaction((/** @type {any} */ client) => service.zoneRow(client, user, id));
      const cardId = url.searchParams.get("cardId");
      if (cardId !== null && (cardId.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(cardId))) throw new HttpError(400, "evidence_query_invalid", "Invalid change-log query.");
      const limit = url.searchParams.get("limit");
      return reply(await changeLog.list({ zoneId: id, cardId, ...(limit !== null ? { limit: Number(limit) } : {}), before: url.searchParams.get("before") }));
    }
    if (parts[2] === "challenges") {
      if (method === "POST") return reply(await challenges.submit(user, id, await readJson(req, maxJsonBytes)));
      if (method === "GET") return reply(await challenges.listFor(user, id));
    }
    if (parts[2] === "upkeep" && method === "POST") return reply(await upkeep.setUpkeep(user, id, await readJson(req, maxJsonBytes)));
    throw new HttpError(404, "not_found", "No such evidence route.");
  };
}
