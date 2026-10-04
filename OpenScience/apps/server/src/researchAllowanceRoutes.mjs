/**
 * A researcher's allowance and confirmed task charges. Supplier usage is a
 * separate ledger and never substitutes for a missing financial statement.
 *
 * Where the wallet is simulated (`evimedCreditsSimulator.mjs`) every answer that
 * carries an amount says `simulated: true`, so no consumer can draw one as money.
 */
import { HttpError, sendJson } from "./security.mjs";

const ROOT = "/api/account/allowance";
const HEADERS = Object.freeze({ "Cache-Control": "private, no-store" });
/** A capability id as `capabilities/<id>` spells one. */
const CAPABILITY_ID = /^[a-z][a-z0-9-]{0,63}$/;
/** What one read of `/estimates` may ask about: every listed tool, with room to spare. */
const MAX_ESTIMATES = 40;
const NO_LINKS = Object.freeze({ rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null });

/** @param {string} pathname */
export function researchAllowanceRoutePattern(pathname) {
  return [ROOT, `${ROOT}/statements`, `${ROOT}/estimate`, `${ROOT}/estimates`].includes(pathname)
    ? pathname : `${ROOT}/:route`;
}

/** @param {Date} now */
function monthStart(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** @param {unknown} value */
function balanceStatus(value) {
  if (value === "ok" || value === "ready") return "ready";
  if (value === "disabled") return "disabled";
  if (value === "evimed_credits_account_unlinked" || value === "unlinked") return "unlinked";
  return "unavailable";
}

/** @param {URL} url */
function statementOptions(url) {
  const limit = url.searchParams.get("limit") ?? "20";
  const cursor = url.searchParams.get("cursor");
  if (!/^[1-9]\d?$/.test(limit) || Number(limit) > 50
    || url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("cursor").length > 1
    || (cursor !== null && (cursor.length === 0 || cursor.length > 512))) {
    throw new HttpError(400, "evimed_credits_request_invalid", "Invalid statement pagination.");
  }
  return { limit: Number(limit), cursor };
}

/**
 * One capability's estimate as the page reads it: a range in CNY, never a
 * promise (`binding: false`), and no range at all where there is no basis.
 * @param {string} capabilityId @param {any} estimate
 */
function estimateData(capabilityId, estimate) {
  const rate = Number(estimate?.creditsPerCny);
  const priced = Number.isFinite(rate) && rate > 0 && estimate?.basis !== "none";
  return {
    capabilityId, basis: estimate?.basis ?? "none",
    low: priced ? estimate.low / rate : null, high: priced ? estimate.high / rate : null,
    samples: estimate?.samples ?? 0,
    // A statistical estimate is not a reserved balance or a binding cap.
    binding: false,
  };
}

/** @template T @param {() => Promise<T>} read @returns {Promise<T>} */
async function financialRead(read) {
  try { return await read(); } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "evimed_credits_unreachable", "Research billing records are temporarily unavailable.");
  }
}

/**
 * A missing billing installation has an explicit state, never a fabricated
 * wallet. All identity comes from the authenticated session.
 * @param {{ store: any, service: any, commerce: any, config: Record<string, any>, now?: () => Date }} dependencies
 */
export function createResearchAllowanceRoutes({ store, service, commerce, config, now = () => new Date() }) {
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if ((req.method ?? "GET") !== "GET") {
      throw new HttpError(405, "method_not_allowed", "Research allowance routes are read-only.");
    }
    const enabled = config.evimedCreditsEnabled === true && Boolean(service);
    const simulated = enabled && config.evimedCreditsSimulated === true;
    if (url.pathname === ROOT) {
      const since = monthStart(now());
      const summary = enabled ? await financialRead(() => service.allowanceSummary(user.id, { since })) : null;
      const available = typeof summary?.balanceCny === "number" && Number.isFinite(summary.balanceCny)
        && summary.balanceCny >= 0 ? summary.balanceCny : null;
      const status = summary ? balanceStatus(summary.status) : "disabled";
      // A ledger that could not be read has no month to show: unknown, never zero.
      const readable = summary?.ledgerReadable !== false;
      const lowThreshold = simulated && Number.isFinite(summary?.lowThreshold) ? summary.lowThreshold : null;
      const data = {
        enabled, simulated, currency: "CNY", status: status === "ready" && available === null ? "unavailable" : status,
        available,
        // Neither a wallet hold nor the source of its balance is inferred
        // from model reservations or from an undocumented upstream field.
        held: null, balances: null, membership: null,
        lowThreshold,
        month: readable ? { since: since.toISOString(), paid: summary?.spentCny ?? 0, pending: summary?.pendingCny ?? 0 } : null,
        commerce: readable ? commerce.links() : NO_LINKS,
      };
      sendJson(res, 200, { data }, HEADERS);
      return true;
    }
    if (url.pathname === `${ROOT}/statements`) {
      const options = statementOptions(url);
      const data = enabled ? await financialRead(() => service.statements(user.id, options)) : { items: [], nextCursor: null };
      sendJson(res, 200, { data: { simulated, ...data } }, HEADERS);
      return true;
    }
    if (url.pathname === `${ROOT}/estimate`) {
      const capability = String(url.searchParams.get("capability") ?? "").trim();
      if (capability && !CAPABILITY_ID.test(capability)) {
        throw new HttpError(400, "evimed_credits_request_invalid", "Invalid research capability.");
      }
      const estimate = enabled ? await financialRead(() => service.estimate(capability)) : null;
      sendJson(res, 200, { data: { currency: "CNY", ...estimateData(capability, estimate), simulated } }, HEADERS);
      return true;
    }
    // Every tool's estimate in one read, for the page that lists them.
    if (url.pathname === `${ROOT}/estimates`) {
      const asked = url.searchParams.getAll("capabilities");
      const ids = asked.length === 1 ? asked[0].split(",").map((id) => id.trim()) : [];
      if (ids.length === 0 || ids.length > MAX_ESTIMATES || new Set(ids).size !== ids.length || ids.some((id) => !CAPABILITY_ID.test(id))) {
        throw new HttpError(400, "evimed_credits_request_invalid", "Invalid research capability list.");
      }
      const estimates = enabled ? await financialRead(() => Promise.all(ids.map((id) => service.estimate(id)))) : ids.map(() => null);
      sendJson(res, 200, { data: { currency: "CNY", simulated, items: ids.map((id, at) => estimateData(id, estimates[at])) } }, HEADERS);
      return true;
    }
    throw new HttpError(404, "not_found", "Research allowance route not found.");
  };
}
