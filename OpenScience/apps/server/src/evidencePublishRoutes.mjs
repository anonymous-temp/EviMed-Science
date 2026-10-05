import { HttpError, readJson, sendJson } from "./security.mjs";

const RESULT_CARD_PATH = /^\/api\/results\/(rv_[a-f0-9]{64})\/evidence-card$/;
const CARD_PATH = /^\/api\/frontier\/evidence\/([^/]+)\/(continue|links)$/;
const AUTHOR_PATH = /^\/api\/frontier\/authors\/([^/]+)$/;

/**
 * The browser's routes for the co-creation loop (evidence-flywheel plan §5.2, F05–F07, 2026-10-05):
 *
 * - `POST /api/results/:rv/evidence-card` — publish a result version as a draft card;
 *   `{ projectId, zoneId | newZone: { title }, claimIds? }`.
 * - `POST /api/frontier/evidence/:cardId/continue` — continue research from a card; `{ projectId? }`.
 * - `GET /api/frontier/evidence/:cardId/links` — what a card points to and what points to it.
 * - `GET /api/frontier/authors/:userId` — one author's page.
 *
 * Hidden knowledge: all four are the frontier's, so with the module off — or on for operators only and the caller not
 * among them — each answers 404 `frontier_not_enabled`, the answer a URL that never existed gets. Each needs a session
 * user and the CSRF check (repeated here like every factory does, because a route that relies on its call site is one
 * refactor from none). The result route is scoped by the result's own project through the result service, so another
 * account's version reads as not found; the frontier audience check is the zone routes' own.
 *
 * Mounted before `createFrontierRoutes`, which answers every other `/api/frontier/*` path.
 *
 * @param {{ store: any, frontier: { allows: (user: any) => boolean } | null, config: Record<string, any>, maxJsonBytes: number,
 *   publisher: { publish: (user: any, versionId: string, body: any) => Promise<any> } | null,
 *   continuation: { start: (user: any, cardId: string, body: any) => Promise<any> } | null,
 *   authors: { page: (user: any, authorId: string) => Promise<any>, links: (user: any, cardId: string) => Promise<any> } | null,
 *   audit?: ((event: string, status: string, details: Record<string, any>) => Promise<unknown>) | null }} options
 */
export function createEvidencePublishRoutes({ store, frontier, config, maxJsonBytes, publisher, continuation, authors, audit = null }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    const method = req.method ?? "GET";
    const resultCard = RESULT_CARD_PATH.exec(url.pathname);
    const cardAction = CARD_PATH.exec(url.pathname);
    const author = AUTHOR_PATH.exec(url.pathname);
    if (!resultCard && !cardAction && !author) return false;
    if (!config.frontierEnabled || !frontier || !publisher || !continuation || !authors) {
      throw new HttpError(404, "frontier_not_enabled", "The frontier feed is not enabled.");
    }
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!frontier.allows(user)) throw new HttpError(404, "frontier_not_enabled", "The frontier feed is not enabled.");
    /** @param {string} value */
    const decoded = (value) => {
      try { return decodeURIComponent(value); } catch { throw new HttpError(400, "evidence_invalid", "Invalid path."); }
    };
    /** @param {any} value @param {number} [status] */
    const reply = (value, status = 200) => {
      sendJson(res, status, { data: value }, { "Cache-Control": "private, no-store" });
      return true;
    };
    if (resultCard) {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Publishing a result as an evidence card is a POST.");
      const answer = await publisher.publish(user, resultCard[1], await readJson(req, maxJsonBytes));
      await audit?.("evidence.result_card", "completed", { userId: user.id, code: answer.outcome, detail: answer.evidence?.id });
      return reply(answer, answer.created ? 201 : 200);
    }
    if (cardAction) {
      const cardId = decoded(cardAction[1]);
      if (cardAction[2] === "continue") {
        if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Continuing research from a card is a POST.");
        const answer = await continuation.start(user, cardId, await readJson(req, maxJsonBytes));
        await audit?.("evidence.continue", "completed", { userId: user.id, code: cardId, detail: `${answer.library.saved.length} saved, ${answer.library.failed.length} failed` });
        return reply(answer, 201);
      }
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "A card's links are read with GET.");
      return reply(await authors.links(user, cardId));
    }
    if (method !== "GET") throw new HttpError(405, "method_not_allowed", "An author page is read with GET.");
    return reply(await authors.page(user, decoded(/** @type {RegExpExecArray} */ (author)[1])));
  };
}
