/**
 * The review gateway: how a run's submission asks for the independent review
 * (layer 3 — one path prefix, one handler, one allowlist per operation).
 *
 * Hidden knowledge:
 *
 * - **Asynchronous by construction.** An editor pass reads a whole package and
 *   thinks for minutes; Node's `fetch` gives up on a response whose headers
 *   have not arrived in 300 s, and a proxy in between may give up sooner. So a
 *   submission starts a review (202, an id) and asks after it; nothing holds a
 *   request open for the length of the review.
 * - **The workload token names the project; nothing the run says can.** Like
 *   the revision and capsule gateways, the fresh, generation-bound workload
 *   token is the credential — the review writes to a project's ledger and is
 *   charged to it. The run names only its own deliverable and the session it
 *   is working in; the run the spend is charged to is the control plane's
 *   attribution of that session, never an id the run supplies.
 * - **The run never sees the reviewer.** It sends a deliverable id and gets
 *   findings back; the prompt, the checklists and the model live here.
 *
 * Operations (under `/internal/review/v1`):
 *   POST /deliverables          { deliverableId, contractKind, capability?, runId?, sessionId?, attempt?, acceptance?, studyType?, editor? }
 *   GET  /deliverables/<id>     the review's state, and its findings once done
 *   POST /responses             { reviewId, answers: [{ id, response, reason? }] }
 *
 * `studyType` is what the run's plan declared the deliverable to report or
 * design, from the domain's closed vocabulary; it decides which reporting
 * checklist is attached beside the contract kind's, so a value outside the
 * vocabulary is refused rather than read as "none".
 *
 * @module reviewGateway
 */

import { CONTRACT_KINDS, isStudyType } from "@evimed/domain";

export const REVIEW_GATEWAY_PREFIX = "/internal/review/v1/";
const START_PATH = "/internal/review/v1/deliverables";
const RESPONSES_PATH = "/internal/review/v1/responses";
const REVIEW_ID = /^rv_[a-f0-9]{24}$/;
const DELIVERABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CAPABILITY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Requests one project may make a minute: a review polled every three seconds is twenty. */
const WINDOW_LIMIT = 240;
const MAX_BODY_BYTES = 64 * 1024;

class ReviewGatewayError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** @param {any} res @param {number} status @param {unknown} payload */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" });
  res.end(body);
}

/** @param {any} req */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new ReviewGatewayError(413, "review_request_too_large", "The review request was too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new ReviewGatewayError(400, "review_request_invalid", "The review request was not a JSON object.");
  }
}

/** @param {Record<string, unknown>} body @param {readonly string[]} allowed */
function onlyFields(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new ReviewGatewayError(400, "review_request_invalid", "The review request has unsupported fields.");
  }
}

/** @param {unknown} value @param {number} max */
function optionalText(value, max) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > max || [...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new ReviewGatewayError(400, "review_request_invalid", "A text field of the review request is invalid.");
  }
  return value;
}

/** @param {Record<string, any>} body */
function startRequest(body) {
  onlyFields(body, ["deliverableId", "contractKind", "capability", "runId", "sessionId", "attempt", "turn", "acceptance", "studyType", "editor"]);
  const deliverableId = String(body.deliverableId ?? "");
  if (!DELIVERABLE_ID.test(deliverableId)) throw new ReviewGatewayError(400, "review_request_invalid", "deliverableId is invalid.");
  const contractKind = String(body.contractKind ?? "");
  if (!CONTRACT_KINDS.includes(/** @type {any} */ (contractKind))) throw new ReviewGatewayError(400, "review_request_invalid", "contractKind is not a contract kind.");
  const capability = body.capability == null ? "" : String(body.capability);
  if (capability && !CAPABILITY_ID.test(capability)) throw new ReviewGatewayError(400, "review_request_invalid", "capability is invalid.");
  const acceptance = body.acceptance == null ? [] : body.acceptance;
  if (!Array.isArray(acceptance) || acceptance.length > 10 || acceptance.some((item) => typeof item !== "string" || item.length > 400)) {
    throw new ReviewGatewayError(400, "review_request_invalid", "acceptance must be at most ten short strings.");
  }
  const attempt = body.attempt == null ? 1 : Number(body.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100) throw new ReviewGatewayError(400, "review_request_invalid", "attempt is invalid.");
  if (body.editor != null && typeof body.editor !== "boolean") throw new ReviewGatewayError(400, "review_request_invalid", "editor must be a boolean.");
  const studyType = body.studyType ?? "";
  if (studyType !== "" && !isStudyType(studyType)) throw new ReviewGatewayError(400, "review_request_invalid", "studyType is not a study type.");
  return {
    deliverableId, contractKind, capability, attempt, acceptance,
    runId: optionalText(body.runId, 120),
    sessionId: optionalText(body.sessionId, 200),
    turn: Number.isSafeInteger(body.turn) ? body.turn : undefined,
    ...(studyType ? { studyType: String(studyType) } : {}),
    ...(body.editor === false ? { editor: false } : {}),
  };
}

/**
 * @param {{ runtimeManager: any, service: any, config: Record<string, any>, report?: (code: string) => void }} deps
 */
export function createReviewGatewayHandler({ runtimeManager, service, config, report = () => {} }) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const windows = new Map();

  /** @param {string} key */
  function admit(key) {
    const now = Date.now();
    const current = windows.get(key);
    const window = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
    window.count += 1;
    windows.set(key, window);
    if (windows.size > 5_000) for (const [name, entry] of windows) if (entry.resetAt <= now) windows.delete(name);
    if (window.count > WINDOW_LIMIT) throw new ReviewGatewayError(429, "review_rate_limited", "Too many review requests from this project.");
  }

  /** @param {any} req @param {any} res @param {(failure: any) => void} [onFailure] */
  return async (req, res, onFailure) => {
    try {
      const url = new URL(req.url, "http://evimed.local");
      if (!url.pathname.startsWith(REVIEW_GATEWAY_PREFIX) || url.search) throw new ReviewGatewayError(404, "not_found", "Review operation not found.");
      if (!config.reviewEnabled || !service?.enabled) throw new ReviewGatewayError(503, "review_disabled", "The independent review is not enabled in this deployment.");
      const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      let identity;
      try { identity = await runtimeManager.assertActiveEviMedWorkloadToken(token); }
      catch { throw new ReviewGatewayError(401, "evimed_workload_token_invalid", "The workload is unavailable."); }
      admit(`${identity.userId}\u0000${identity.projectId}`);
      const owner = { userId: identity.userId, projectId: identity.projectId };
      if (req.method === "POST" && url.pathname === START_PATH) {
        const request = startRequest(await readJsonBody(req));
        const started = await service.startDeliverableReview(owner, request);
        sendJson(res, started.status === "skipped" ? 200 : 202, started);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith(`${START_PATH}/`)) {
        const reviewId = url.pathname.slice(START_PATH.length + 1);
        if (!REVIEW_ID.test(reviewId)) throw new ReviewGatewayError(404, "review_not_found", "No such review.");
        const state = await service.reviewStatus(owner, reviewId);
        if (!state) throw new ReviewGatewayError(404, "review_not_found", "No such review.");
        sendJson(res, 200, state);
        return;
      }
      if (req.method === "POST" && url.pathname === RESPONSES_PATH) {
        const body = await readJsonBody(req);
        onlyFields(body, ["reviewId", "answers"]);
        const reviewId = String(body.reviewId ?? "");
        if (!REVIEW_ID.test(reviewId)) throw new ReviewGatewayError(404, "review_not_found", "No such review.");
        if (!Array.isArray(body.answers) || body.answers.length > 60) throw new ReviewGatewayError(400, "review_request_invalid", "answers must be a list of at most sixty.");
        const recorded = await service.recordResponses(owner, { reviewId, answers: body.answers });
        if (!recorded) throw new ReviewGatewayError(404, "review_not_found", "No such review.");
        sendJson(res, 200, recorded);
        return;
      }
      throw new ReviewGatewayError(404, "not_found", "Review operation not found.");
    } catch (error) {
      const safe = error instanceof ReviewGatewayError
        ? error
        : Number(error?.status) >= 400 && Number(error?.status) < 500 && typeof error?.code === "string"
          ? new ReviewGatewayError(Number(error.status), error.code, String(error.message ?? "The review request was refused."))
          : new ReviewGatewayError(503, "review_unavailable", "The independent review is unavailable.");
      if (safe.status >= 500) report(safe.code);
      onFailure?.({ code: safe.code, status: safe.status });
      sendJson(res, safe.status, { error: { code: safe.code, message: safe.message } });
    }
  };
}
