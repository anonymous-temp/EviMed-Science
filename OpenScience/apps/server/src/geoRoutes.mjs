import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  GEO_COVERAGE_DAYS_MAX, GEO_COVERAGE_DAYS_MIN, GEO_ENGINES, GEO_EXPORT_KINDS, GEO_ORDER_CANCELLABLE_STATES, GEO_PROJECT_STATUSES, GEO_STEPS,
  GEO_TIERS, geoProducerSettingsIssues, normalizeGeoProducerSettings,
} from "@evimed/domain";
import { HttpError, readJson, sendJson } from "./security.mjs";

/**
 * The browser's routes for 「循证传播」 (`/api/geo/*`, build spec 2026-09-25 §3).
 *
 * Hidden knowledge:
 *
 * - Off is invisible. With the module off — or on for operators only and the
 *   caller not among them or the preview list — every path answers 404
 *   `geo_not_enabled`, the answer a URL that never existed gets.
 * - Another account's GEO project answers 404 `geo_project_not_found`, the
 *   same as one that never existed: the service resolves every id against
 *   the caller first.
 * - Reads come from the module's tables; the write-side actions that belong
 *   to other workers are hooks: `orchestrator.runStep` (「让 AI 做」),
 *   `exporter.export` (导出), `market.setBudget`, `market.cancelOrder`,
 *   `market.confirmTopup`, and the operators' `market.resolveUnknownOrder`,
 *   `market.markOrderLost` and `market.clearStop`. A hook that is not composed answers 503
 *   `geo_unavailable` — the route exists, the worker does not yet. The hooks
 *   are read at request time, so a package composed after the routes attaches
 *   to the same `geo` object and is found.
 * - Writes arrive here already past the platform's CSRF check and maintenance
 *   admission (the dispatch in `server.mjs`); the CSRF check is repeated like
 *   every route factory does.
 * - Answers keep the platform's envelope, `{ data: <shape> }`; the one
 *   exception is a screenshot, which is the PNG itself.
 *
 * @module geoRoutes
 */

const NOT_ENABLED = () => new HttpError(404, "geo_not_enabled", "循证传播 is not enabled.");
const UNAVAILABLE = () => new HttpError(503, "geo_unavailable", "This GEO action is not available on this deployment yet.");
/** A project name is 1–40 characters (`projectDisplayName`); a brand given at creation becomes it. */
const BRAND_NAME_MAX = 40;
const BUDGET_MAX_CNY = 10_000_000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * The bounded metric label of a GEO path: ids are folded so a dashboard row is
 * a route, not a project.
 * @param {string} pathname
 */
export function geoRoutePattern(pathname) {
  const parts = pathname.slice("/api/geo".length).split("/").filter(Boolean);
  if (!parts.length) return "/api/geo";
  if (parts[0] === "market") {
    if (parts.length === 1) return "/api/geo/market";
    if (parts.length === 2 && ["orders", "topups", "settlement"].includes(parts[1])) return `/api/geo/market/${parts[1]}`;
    if (parts[1] === "clear-stop") return "/api/geo/market/clear-stop";
    if (parts[1] === "orders") return `/api/geo/market/orders/:id/${["resolve", "lost"].includes(parts[3]) ? parts[3] : ":action"}`;
    return "/api/geo/market/topups/:id/confirm";
  }
  if (parts[0] !== "projects") return "/api/geo/:route";
  if (parts.length === 1) return "/api/geo/projects";
  if (parts.length === 2) return "/api/geo/projects/:id";
  const tab = ["evidence", "journey", "questions", "diagnosis", "answers", "screenshots", "sources", "tier", "articles", "distribution", "budget",
    "orders", "monitoring", "run", "export", "cards", "members"].includes(parts[2]) ? parts[2] : ":route";
  if (parts.length === 3) return `/api/geo/projects/:id/${tab}`;
  if (parts.length === 4) return `/api/geo/projects/:id/${tab}/:item`;
  return `/api/geo/projects/:id/${tab}/:item/:action`;
}

/** @param {any} req @param {number} limit @param {readonly string[]} allowed */
async function bodyOf(req, limit, allowed) {
  const body = await readJson(req, limit);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "geo_payload_invalid", `This request takes only: ${allowed.join(", ") || "no fields"}.`);
  }
  return /** @type {Record<string, any>} */ (body);
}

/** @param {unknown} value */
function coverageDays(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < GEO_COVERAGE_DAYS_MIN || /** @type {number} */ (value) > GEO_COVERAGE_DAYS_MAX) {
    throw new HttpError(400, "geo_coverage_invalid", `coverageDays must be a whole number from ${GEO_COVERAGE_DAYS_MIN} to ${GEO_COVERAGE_DAYS_MAX}.`);
  }
  return /** @type {number} */ (value);
}

/** @param {unknown} value */
function engines(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > GEO_ENGINES.length || value.some((engine) => !GEO_ENGINES.includes(engine))
    || new Set(value).size !== value.length) {
    throw new HttpError(400, "geo_engines_invalid", `engines must be distinct values of: ${GEO_ENGINES.join(", ")}.`);
  }
  return /** @type {string[]} */ (value);
}

/** @param {unknown} value */
function tier(value) {
  if (typeof value !== "string" || !GEO_TIERS.includes(value)) throw new HttpError(400, "geo_tier_invalid", `tier must be one of: ${GEO_TIERS.join(", ")}.`);
  return value;
}

/**
 * The producer settings of a project (who speaks for the product): the domain's own check, so the route and a card agree.
 * @param {unknown} value
 */
function producerSettings(value) {
  if (value === null) return null;
  const issues = geoProducerSettingsIssues(value);
  if (issues.length) throw new HttpError(400, "geo_producer_invalid", `The producer settings are not valid: ${issues.join("; ")}.`);
  return normalizeGeoProducerSettings(value);
}

/**
 * The account a hook acts as: the project's owner. The run, its workspace and its money are the owner's whoever asked, and the hooks
 * (the orchestrator, the exporter, the market) check that the account is the project's; the ability the member needed was judged by
 * the route before this.
 * @param {{ id?: string }} user @param {{ userId: string }} project
 */
const asOwner = (user, project) => ({ ...user, id: project.userId });

/** @param {unknown} value */
function brandName(value) {
  if (value == null) return null;
  const name = typeof value === "string"
    ? [...value].map((character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character)).join("").replace(/\s+/g, " ").trim()
    : "";
  if (!name || [...name].length > BRAND_NAME_MAX) {
    throw new HttpError(400, "geo_brand_name_invalid", `brandName is one line of 1 to ${BRAND_NAME_MAX} characters.`);
  }
  return name;
}

/** @param {unknown} value @param {string} field */
function money(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > BUDGET_MAX_CNY) {
    throw new HttpError(400, "geo_budget_invalid", `${field} must be a positive amount of at most ${BUDGET_MAX_CNY} CNY.`);
  }
  return Math.round(value * 100) / 100;
}

/**
 * @param {{ store: any, service: any, config: Record<string, any>, maxJsonBytes: number,
 *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<unknown>,
 *   projects?: { create: (user: any, name: string) => Promise<{ id: string, name: string }>,
 *     bindSession: (user: any, projectId: string) => Promise<{ sessionId: string, bound: boolean }>,
 *     latestSessionId?: (user: any, projectId: string) => Promise<string | null> } | null,
 *   orchestrator?: { runStep?: (user: any, project: any, step: string) => Promise<{ sessionId: string, runId?: string | null }> } | null,
 *   exporter?: { export?: (user: any, project: any, kind: string) => Promise<{ sessionId: string, runId: string | null }> } | null,
 *   cards?: { list?: (project: any) => Promise<any>, refresh?: (user: any, project: any) => Promise<any>,
 *     articleReferences?: (project: any, articleId: string) => Promise<any>, articlePublishable?: (project: any, articleId: string) => Promise<any> } | null,
 *   members?: { list: (project: any) => Promise<any[]>, add: (input: any) => Promise<any>, remove: (input: any) => Promise<any> } | null,
 *   market?: { setBudget?: (user: any, project: any, budget: { totalCny: number, dailyCny: number }) => Promise<any>,
 *     cancelOrder?: (user: any, project: any, orderId: string) => Promise<any>, confirmTopup?: (user: any, topupId: string) => Promise<any>,
 *     resolveUnknownOrder?: (user: any, orderId: string, input: { created: boolean, vendorOrderNid?: string }) => Promise<any>,
 *     markOrderLost?: (user: any, orderId: string, reason: string) => Promise<any>, clearStop?: (user: any, note?: string) => Promise<any>,
 *     balance?: () => Promise<any>, status?: () => Promise<any>, configured?: () => boolean,
 *     orders?: (input: Record<string,string>) => Promise<any>, topups?: (input: Record<string,string>) => Promise<any>,
 *     settlement?: (input: Record<string,string>) => Promise<any> } | null }} dependencies
 */
export function createGeoRoutes(dependencies) {
  const { store, service, config, maxJsonBytes, audit = async () => {} } = dependencies;
  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/geo" && !url.pathname.startsWith("/api/geo/")) return false;
    if (!config?.geoEnabled || !service) throw NOT_ENABLED();
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service.allows(user)) throw NOT_ENABLED();
    let parts;
    try { parts = url.pathname.slice("/api/geo".length).split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "geo_path_invalid", "Invalid GEO path."); }
    if (parts.some((part) => !ID.test(part))) throw new HttpError(404, "not_found", "GEO route not found.");
    const method = req.method ?? "GET";
    const reply = (/** @type {any} */ value, status = 200) => { sendJson(res, status, { data: value }); return true; };
    // Read at request time: the orchestration and market packages attach to
    // the composed `geo` object after the routes are built.
    const hooks = {
      get orchestrator() { return dependencies.orchestrator ?? null; },
      get exporter() { return dependencies.exporter ?? null; },
      get cards() { return dependencies.cards ?? null; },
      get members() { return dependencies.members ?? null; },
      get market() { return dependencies.market ?? null; },
    };

    // --- operators: the platform's marketplace account ---
    if (parts[0] === "market") {
      if (!service.isOperator(user)) throw new HttpError(403, "geo_operator_required", "Only an operator may see the marketplace account.");
      if (parts.length === 1 && method === "GET") return reply(await service.market(hooks.market));
      if (parts.length === 2 && method === "GET" && ["orders", "topups", "settlement"].includes(parts[1])) {
        const name = /** @type {"orders" | "topups" | "settlement"} */ (parts[1]);
        const read = hooks.market?.[name];
        if (!read) throw UNAVAILABLE();
        const allowed = ["limit", "cursor", name === "orders" ? "view" : name === "topups" ? "status" : "month"];
        for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
          throw new HttpError(400, "geo_payload_invalid", "Unsupported marketplace query field.");
        }
        return reply(await read(Object.fromEntries(url.searchParams)));
      }
      if (parts.length === 4 && parts[1] === "topups" && parts[3] === "confirm" && method === "POST") {
        await bodyOf(req, maxJsonBytes, []);
        if (!(await service.topupExists(parts[2]))) throw new HttpError(404, "geo_topup_not_found", "Top-up request not found.");
        if (!hooks.market?.confirmTopup) throw UNAVAILABLE();
        const result = await hooks.market.confirmTopup(user, parts[2]);
        await audit("geo.topup.confirm", "completed", { userId: user.id, code: parts[2] });
        return reply(result);
      }
      // An order the vendor may or may not have (a send that timed out): the
      // operator checked and says which, with the vendor's order number when
      // it exists; the market verifies that number with the vendor.
      if (parts.length === 4 && parts[1] === "orders" && parts[3] === "resolve" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["created", "vendorOrderNid"]);
        if (typeof body.created !== "boolean"
          || (body.created && (typeof body.vendorOrderNid !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(body.vendorOrderNid)))) {
          throw new HttpError(400, "geo_payload_invalid", "created is true or false; a created order names the vendor's order number.");
        }
        if (!hooks.market?.resolveUnknownOrder) throw UNAVAILABLE();
        const result = await hooks.market.resolveUnknownOrder(user, parts[2],
          { created: body.created, ...(body.created ? { vendorOrderNid: body.vendorOrderNid } : {}) });
        await audit("geo.order.resolve", "completed", { userId: user.id, code: parts[2], detail: body.created ? "created" : "not_created" });
        return reply(result);
      }
      // An after-sale the platform will not recover: written off at what the vendor kept.
      if (parts.length === 4 && parts[1] === "orders" && parts[3] === "lost" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["reason"]);
        if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 300) {
          throw new HttpError(400, "geo_payload_invalid", "reason is one line of at most 300 characters.");
        }
        if (!hooks.market?.markOrderLost) throw UNAVAILABLE();
        const result = await hooks.market.markOrderLost(user, parts[2], body.reason.trim());
        await audit("geo.order.lost", "completed", { userId: user.id, code: parts[2] });
        return reply(result);
      }
      // A reconciliation stop an operator looked at: new orders may go out again.
      if (parts.length === 2 && parts[1] === "clear-stop" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["note"]);
        if (body.note != null && (typeof body.note !== "string" || body.note.length > 500)) {
          throw new HttpError(400, "geo_payload_invalid", "note is at most 500 characters.");
        }
        if (!hooks.market?.clearStop) throw UNAVAILABLE();
        const result = await hooks.market.clearStop(user, body.note ?? undefined);
        await audit("geo.market.clear_stop", "completed", { userId: user.id, code: result?.day ? String(result.day) : "none" });
        return reply(result);
      }
      throw new HttpError(404, "not_found", "GEO route not found.");
    }
    if (parts[0] !== "projects") throw new HttpError(404, "not_found", "GEO route not found.");

    if (parts.length === 1) {
      if (method === "GET") return reply(await service.listProjects(user));
      if (method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["brandName", "coverageDays", "engines"]);
        const input = {
          brandName: brandName(body.brandName) ?? undefined,
          coverageDays: body.coverageDays == null ? undefined : coverageDays(body.coverageDays),
          engines: body.engines == null ? undefined : engines(body.engines),
        };
        if (!dependencies.projects) throw UNAVAILABLE();
        const created = await service.createProject(user, input, {
          createControlProject: dependencies.projects.create,
          bindSession: dependencies.projects.bindSession,
        });
        await audit("geo.project.create", "completed", { userId: user.id, code: created.id, detail: created.projectId });
        return reply(created, 201);
      }
    }
    const id = parts[1];
    if (parts.length === 2) {
      if (method === "GET") {
        const view = await service.projectView(user, id);
        const sessionId = await dependencies.projects?.latestSessionId?.(user, view.projectId).catch(() => null) ?? null;
        return reply({ ...view, sessionId });
      }
      if (method === "PATCH") {
        const body = await bodyOf(req, maxJsonBytes, ["coverageDays", "engines", "tier", "status", "producer"]);
        /** @type {Record<string, any>} */
        const patch = {};
        if (body.coverageDays !== undefined) patch.coverageDays = coverageDays(body.coverageDays);
        if (body.engines !== undefined) patch.engines = engines(body.engines);
        if (body.tier !== undefined) patch.tier = tier(body.tier);
        if (body.status !== undefined) {
          if (!GEO_PROJECT_STATUSES.includes(body.status)) throw new HttpError(400, "geo_status_invalid", `status must be one of: ${GEO_PROJECT_STATUSES.join(", ")}.`);
          patch.status = body.status;
        }
        if (body.producer !== undefined) patch.producer = producerSettings(body.producer);
        return reply(await service.updateProject(user, id, patch));
      }
      if (method === "DELETE") {
        await bodyOf(req, maxJsonBytes, []);
        const result = await service.deleteProject(user, id);
        await audit("geo.project.delete", "completed", { userId: user.id, code: id, detail: result.projectId });
        return reply(result);
      }
    }
    const tab = parts[2];
    // --- members: colleagues and outside agencies, by role (the owner alone manages them) ---
    if (tab === "members") {
      if (!hooks.members) throw UNAVAILABLE();
      if (parts.length === 3 && method === "GET") {
        const project = await service.requireProject(user, id);
        return reply({ members: await hooks.members.list(project), you: { roles: project.access.roles, abilities: project.access.abilities } });
      }
      if (parts.length === 3 && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["userId", "role", "detail"]);
        const project = await service.requireProject(user, id, "manage_members");
        const added = await hooks.members.add({ project, actorId: String(user.id), userId: body.userId, role: body.role, detail: body.detail });
        await audit("geo.member.add", "completed", { userId: user.id, code: id, detail: String(body.role) });
        return reply(added, 201);
      }
      if (parts.length === 4 && method === "DELETE") {
        await bodyOf(req, maxJsonBytes, []);
        const role = url.searchParams.get("role");
        // A member may leave on their own; taking someone else off is the owner's.
        const project = await service.requireProject(user, id, parts[3] === String(user.id) ? "read" : "manage_members");
        const removed = await hooks.members.remove({ project, userId: parts[3], role });
        await audit("geo.member.remove", "completed", { userId: user.id, code: id, detail: role ?? "all" });
        return reply(removed);
      }
      throw new HttpError(404, "not_found", "GEO route not found.");
    }
    if (parts.length === 3 && method === "GET") {
      if (tab === "evidence") return reply(await service.evidence(user, id));
      if (tab === "journey") return reply(await service.journey(user, id));
      if (tab === "questions") {
        const raw = url.searchParams.get("version");
        const version = raw == null || raw === "" ? null : Number(raw);
        if (version != null && (!Number.isSafeInteger(version) || version < 1)) throw new HttpError(400, "geo_version_invalid", "version must be a positive whole number.");
        return reply(await service.questions(user, id, version));
      }
      if (tab === "diagnosis") {
        const round = url.searchParams.get("round");
        if (round != null && round !== "" && !ID.test(round)) throw new HttpError(404, "geo_round_not_found", "Round not found.");
        return reply(await service.diagnosis(user, id, round || null));
      }
      if (tab === "sources") return reply(await service.sources(user, id));
      if (tab === "articles") return reply(await service.articles(user, id));
      if (tab === "distribution") {
        const configured = typeof hooks.market?.configured === "function" ? Boolean(hooks.market.configured()) : undefined;
        return reply(await service.distribution(user, id, configured === undefined ? {} : { marketConfigured: configured }));
      }
      if (tab === "monitoring") return reply(await service.monitoring(user, id));
      // The project's product zone and its cards: each claim with its quotation, its ✓/⚠ and the card revision it stands in.
      if (tab === "cards") {
        const project = await service.requireProject(user, id);
        if (!hooks.cards?.list) throw UNAVAILABLE();
        return reply(await hooks.cards.list(project));
      }
    }
    // Write the verified claims of the project into its product zone as cards; the answer says what was written and what was held.
    if (parts.length === 4 && method === "POST" && tab === "cards" && parts[3] === "refresh") {
      await bodyOf(req, maxJsonBytes, []);
      const project = await service.requireProject(user, id, "edit");
      if (!hooks.cards?.refresh) throw UNAVAILABLE();
      const result = await hooks.cards.refresh(asOwner(user, project), project);
      await audit("geo.cards.refresh", "completed", { userId: user.id, code: id, detail: `${result.cards?.length ?? 0}` });
      return reply(result);
    }
    if (parts.length === 4 && method === "GET" && tab === "answers") return reply(await service.answer(user, id, parts[3]));
    if (parts.length === 4 && method === "GET" && tab === "screenshots") {
      const file = await service.screenshotPath(user, id, parts[3]);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new HttpError(404, "geo_screenshot_not_found", "Screenshot not found.");
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(info.size), "Cache-Control": "private, max-age=31536000, immutable" });
      await new Promise((resolve, reject) => {
        const stream = createReadStream(file);
        stream.on("error", reject);
        res.on("finish", resolve);
        res.on("close", resolve);
        stream.pipe(res);
      });
      return true;
    }
    if (parts.length === 5 && method === "POST" && tab === "questions" && parts[4] === "unmeasure") {
      await bodyOf(req, maxJsonBytes, []);
      return reply(await service.unmeasureQuestion(user, id, parts[3]));
    }
    if (parts.length === 3 && method === "POST" && tab === "tier") {
      const body = await bodyOf(req, maxJsonBytes, ["tier"]);
      return reply(await service.setTier(user, id, tier(body.tier)));
    }
    // What the platform reads in an article's claim references: each against the card revision it cites, and the ones a card's change
    // log says have moved since. A card-layer article is read as the card renders it now.
    if (parts.length === 5 && method === "GET" && tab === "articles" && parts[4] === "references") {
      const project = await service.requireProject(user, id);
      if (!hooks.cards?.articleReferences) throw UNAVAILABLE();
      return reply(await hooks.cards.articleReferences(project, parts[3]));
    }
    // The article as it leaves the platform: references off, its author named, the relation to the product said and the AI label.
    if (parts.length === 5 && method === "GET" && tab === "articles" && parts[4] === "text") {
      const project = await service.requireProject(user, id);
      if (!hooks.cards?.articlePublishable) throw UNAVAILABLE();
      return reply(await hooks.cards.articlePublishable(project, parts[3]));
    }
    if (parts.length === 5 && method === "POST" && tab === "articles" && parts[4] === "withdraw") {
      await bodyOf(req, maxJsonBytes, []);
      return reply(await service.withdrawArticle(user, id, parts[3]));
    }
    if (parts.length === 5 && method === "POST" && tab === "articles" && parts[4] === "release") {
      await bodyOf(req, maxJsonBytes, []);
      const result = await service.releaseArticle(user, id, parts[3]);
      await audit("geo.article.release", "completed", { userId: user.id, code: parts[3], detail: id });
      return reply(result);
    }
    if (parts.length === 3 && method === "PUT" && tab === "budget") {
      const body = await bodyOf(req, maxJsonBytes, ["totalCny", "dailyCny"]);
      const budget = { totalCny: money(body.totalCny, "totalCny"), dailyCny: money(body.dailyCny, "dailyCny") };
      if (budget.dailyCny > budget.totalCny) throw new HttpError(400, "geo_budget_invalid", "dailyCny cannot exceed totalCny.");
      const project = await service.requireProject(user, id, "manage_money");
      if (!hooks.market?.setBudget) throw UNAVAILABLE();
      const result = await hooks.market.setBudget(asOwner(user, project), project, budget);
      await audit("geo.budget.set", "completed", { userId: user.id, code: id, detail: `${budget.totalCny}/${budget.dailyCny}` });
      return reply(result);
    }
    if (parts.length === 5 && method === "POST" && tab === "orders" && parts[4] === "cancel") {
      await bodyOf(req, maxJsonBytes, []);
      const { project, order } = await service.order(user, id, parts[3]);
      if (!GEO_ORDER_CANCELLABLE_STATES.includes(order.state)) {
        throw new HttpError(409, "geo_order_not_cancellable", "An order can be cancelled only before the outlet accepts it.");
      }
      if (!hooks.market?.cancelOrder) throw UNAVAILABLE();
      const result = await hooks.market.cancelOrder(asOwner(user, project), project, order.id);
      await audit("geo.order.cancel", "completed", { userId: user.id, code: order.id, detail: id });
      return reply(result);
    }
    if (parts.length === 3 && method === "POST" && tab === "run") {
      const body = await bodyOf(req, maxJsonBytes, ["step"]);
      if (typeof body.step !== "string" || !GEO_STEPS.includes(body.step)) throw new HttpError(400, "geo_step_invalid", `step must be one of: ${GEO_STEPS.join(", ")}.`);
      const project = await service.requireProject(user, id, "run");
      if (!hooks.orchestrator?.runStep) throw UNAVAILABLE();
      return reply(await hooks.orchestrator.runStep(asOwner(user, project), project, body.step));
    }
    if (parts.length === 3 && method === "POST" && tab === "export") {
      const body = await bodyOf(req, maxJsonBytes, ["kind"]);
      if (typeof body.kind !== "string" || !GEO_EXPORT_KINDS.includes(body.kind)) {
        throw new HttpError(400, "geo_export_kind_invalid", `kind must be one of: ${GEO_EXPORT_KINDS.join(", ")}.`);
      }
      const project = await service.requireProject(user, id, "run");
      if (!hooks.exporter?.export) throw UNAVAILABLE();
      return reply(await hooks.exporter.export(asOwner(user, project), project, body.kind));
    }
    throw new HttpError(404, "not_found", "GEO route not found.");
  };
}
