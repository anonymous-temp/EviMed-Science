/**
 * The browser's routes for 「虚拟临研」 (`/api/vcr/*`, build contract
 * 2026-09-28 §3.1).
 *
 * Hidden knowledge:
 *
 * - **Off is invisible.** With the module off — or on for operators only and
 *   the caller neither an operator nor on the preview list — every path
 *   answers 404 `vcr_not_enabled`, the answer a URL that never existed gets.
 *   Another account's study answers 404 `vcr_study_not_found` for the same
 *   reason: the service resolves every id against the caller first.
 * - **A role is checked per operation, never per session** (platform
 *   principle 14). `roleAllows` decides each write against the study roles the
 *   caller actually holds; a reviewer may countersign and export but not
 *   queue compute, and a refusal names the ability rather than the role.
 * - **The write-side actions that belong to other packages are hooks**:
 *   `orchestrator.runStep` (「让 AI 做」) and `requestExport`, `jobs.enqueue`
 *   and `cancel` and `confirmBudget`, `members` (package A) and
 *   `matching.contactReferral` (package E, the first human stop). A hook that
 *   is not composed answers 503 `vcr_unavailable` — the route exists, the
 *   worker does not yet. Hooks are read at request time, so a package composed
 *   after the routes attaches to the same object and is found.
 * - **Writes arrive past the platform's CSRF check and maintenance
 *   admission** (the dispatch in `server.mjs`); the CSRF check is repeated
 *   here like every route factory does.
 * - Answers keep the platform's envelope, `{ data: <shape> }`.
 *
 * @module vcrRoutes
 */

import {
  VCR_ASSUMPTION_SOURCE_KINDS, VCR_DATA_TIERS, VCR_EXPORT_KINDS, VCR_INTENDED_USES, VCR_JOB_KINDS,
  VCR_MEMBER_ROLES, VCR_REVIEW_KINDS, VCR_STEPS, VCR_STUDY_STATUSES, VCR_TABS, VCR_VALUE_SOURCES, roleAllows,
} from "@evimed/domain";

import { HttpError, readJson, sendJson } from "./security.mjs";

/**
 * Every code these routes answer with. Exported so a test can prove the
 * routes emit nothing outside this list, and so the domain's own registry can
 * take it verbatim.
 */
export const VCR_ROUTE_ERROR_CODES = Object.freeze([
  "vcr_not_enabled",
  "vcr_path_invalid",
  "vcr_payload_invalid",
  "vcr_study_not_found",
  "vcr_study_paused",
  "vcr_name_invalid",
  "vcr_tier_invalid",
  "vcr_intended_use_invalid",
  "vcr_status_invalid",
  "vcr_step_invalid",
  "vcr_tab_not_found",
  "vcr_job_kind_invalid",
  "vcr_job_scenario_invalid",
  "vcr_job_not_found",
  "vcr_budget_invalid",
  "vcr_assumption_invalid",
  "vcr_review_kind_invalid",
  "vcr_decision_invalid",
  "vcr_export_kind_invalid",
  "vcr_export_not_found",
  "vcr_model_invalid",
  "vcr_member_role_invalid",
  "vcr_referral_not_found",
  "vcr_forbidden",
  "vcr_unavailable",
]);

const NOT_ENABLED = () => new HttpError(404, "vcr_not_enabled", "虚拟临研 is not enabled.");
const UNAVAILABLE = () => new HttpError(503, "vcr_unavailable", "This 虚拟临研 action is not available on this deployment yet.");
const ID = /^[A-Za-z0-9_-]{1,80}$/;
/** A study name is one line; the same ceiling a project name has. */
const NAME_MAX = 40;
const QUESTION_MAX = 2_000;
const CPU_SECONDS_MAX = 10_000_000;

/**
 * The bounded metric label of a 虚拟临研 path: ids are folded so a dashboard
 * row is a route, not a study.
 * @param {string} pathname
 */
export function vcrRoutePattern(pathname) {
  const parts = pathname.slice("/api/vcr".length).split("/").filter(Boolean);
  if (!parts.length) return "/api/vcr";
  if (parts[0] === "models") return "/api/vcr/models";
  if (parts[0] === "precedents") return "/api/vcr/precedents";
  if (parts[0] !== "studies") return "/api/vcr/:route";
  if (parts.length === 1) return "/api/vcr/studies";
  if (parts.length === 2) return "/api/vcr/studies/:id";
  const known = [...VCR_TABS, "run", "jobs", "budget", "assumptions", "reviews", "decisions", "export", "members", "referrals"];
  const section = known.includes(parts[2]) ? parts[2] : ":route";
  if (parts.length === 3) return `/api/vcr/studies/:id/${section}`;
  if (parts.length === 4) return `/api/vcr/studies/:id/${section}/:item`;
  return `/api/vcr/studies/:id/${section}/:item/${["cancel", "contact"].includes(parts[4]) ? parts[4] : ":action"}`;
}

/** @param {any} req @param {number} limit @param {readonly string[]} allowed */
async function bodyOf(req, limit, allowed) {
  const body = await readJson(req, limit);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "vcr_payload_invalid", `This request takes only: ${allowed.join(", ") || "no fields"}.`);
  }
  return /** @type {Record<string, any>} */ (body);
}

/** @param {unknown} value @param {string} field @param {number} max */
function line(value, field, max) {
  const text = typeof value === "string"
    ? [...value].map((character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character)).join("").replace(/\s+/g, " ").trim()
    : "";
  if (!text || [...text].length > max) {
    throw new HttpError(400, "vcr_name_invalid", `${field} is one line of 1 to ${max} characters.`);
  }
  return text;
}

/** @param {unknown} value @param {readonly string[]} vocabulary @param {string} code @param {string} field */
function word(value, vocabulary, code, field) {
  if (typeof value !== "string" || !vocabulary.includes(value)) {
    throw new HttpError(400, code, `${field} must be one of: ${vocabulary.join(", ")}.`);
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {number} max */
function wholeNumber(value, field, max) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1 || /** @type {number} */ (value) > max) {
    throw new HttpError(400, "vcr_payload_invalid", `${field} must be a whole number from 1 to ${max}.`);
  }
  return /** @type {number} */ (value);
}

/**
 * @param {{ store: any, service: any, config: Record<string, any>, maxJsonBytes: number,
 *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<unknown>,
 *   projects?: { create: (user: any, name: string) => Promise<{ id: string, name: string }>,
 *     bindSession: (user: any, projectId: string, capabilityId: string) => Promise<{ sessionId: string, bound: boolean }>,
 *     latestSessionId?: (user: any, projectId: string) => Promise<string | null> } | null,
 *   orchestrator?: any, jobs?: any, exporter?: any, members?: any, matching?: any }} dependencies
 */
export function createVcrRoutes(dependencies) {
  const { store, service, config, maxJsonBytes, audit = async () => {} } = dependencies;

  /** @param {any} req @param {any} res @returns {Promise<boolean>} */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/vcr" && !url.pathname.startsWith("/api/vcr/")) return false;
    if (!config?.vcrEnabled || !service) throw NOT_ENABLED();
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service.allows(user)) throw NOT_ENABLED();
    let parts;
    try { parts = url.pathname.slice("/api/vcr".length).split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "vcr_path_invalid", "Invalid 虚拟临研 path."); }
    if (parts.some((part) => !ID.test(part))) throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    const method = req.method ?? "GET";
    const reply = (/** @type {any} */ value, status = 200) => { sendJson(res, status, { data: value }); return true; };
    // Read at request time: packages composed after the routes attach to the
    // same `vcr` object and are found here.
    const hooks = {
      get orchestrator() { return dependencies.orchestrator ?? null; },
      get jobs() { return dependencies.jobs ?? null; },
      get exporter() { return dependencies.exporter ?? dependencies.orchestrator ?? null; },
      get members() { return dependencies.members ?? null; },
      get matching() { return dependencies.matching ?? null; },
    };

    /**
     * What this caller may do in this study. The owner is a `lead` even when
     * no membership row says so — a study cannot lock out the person who made
     * it.
     * @param {any} study @param {string} ability
     */
    const requireAbility = async (study, ability) => {
      const roles = await store.rolesOf?.(study.id, String(user.id)) ?? [];
      const held = roles.length ? roles : (study.userId === String(user.id) ? ["lead"] : []);
      if (!held.some((/** @type {string} */ role) => roleAllows(role, ability))) {
        throw new HttpError(403, "vcr_forbidden", `这个操作需要「${ability}」权限，你在本研究中没有。`);
      }
      return held;
    };

    // --- cross-study pages -----------------------------------------------------
    if (parts[0] === "models") {
      if (parts.length === 1 && method === "GET") return reply(await service.modelLibrary(user));
      if (parts.length === 1 && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes,
          ["studyId", "name", "version", "risk", "endpointType", "card", "applicability", "validation", "evidence", "sources"]);
        if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80) {
          throw new HttpError(400, "vcr_model_invalid", "name is one line of at most 80 characters.");
        }
        const saved = await service.adoptModel(user, body);
        await audit("vcr.model.adopt", "completed", { userId: user.id, code: String(saved?.id ?? ""), detail: String(body.name) });
        return reply(saved, 201);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }
    if (parts[0] === "precedents") {
      if (parts.length === 1 && method === "GET") {
        return reply(await service.precedents(user, Object.fromEntries([...url.searchParams].slice(0, 20))));
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }
    if (parts[0] !== "studies") throw new HttpError(404, "not_found", "虚拟临研 route not found.");

    // --- the study list --------------------------------------------------------
    if (parts.length === 1) {
      if (method === "GET") return reply(await service.listStudies(user));
      if (method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["name", "question", "dataTier", "intendedUse", "action"]);
        const input = {
          name: body.name == null ? undefined : line(body.name, "name", NAME_MAX),
          question: body.question == null ? "" : String(body.question).slice(0, QUESTION_MAX),
          dataTier: body.dataTier == null ? undefined : word(body.dataTier, VCR_DATA_TIERS, "vcr_tier_invalid", "dataTier"),
          intendedUse: body.intendedUse == null ? undefined
            : word(body.intendedUse, VCR_INTENDED_USES, "vcr_intended_use_invalid", "intendedUse"),
          action: body.action == null ? undefined : String(body.action).slice(0, 40),
        };
        if (!dependencies.projects) throw UNAVAILABLE();
        const created = await service.createStudy(user, input, {
          createResearcherProject: dependencies.projects.create,
          bindSession: dependencies.projects.bindSession,
        });
        await audit("vcr.study.create", "completed", { userId: user.id, code: created.id, detail: created.projectId });
        return reply(created, 201);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    const id = parts[1];
    if (parts.length === 2) {
      if (method === "GET") {
        const view = await service.studyView(user, id);
        const sessionId = await dependencies.projects?.latestSessionId?.(user, view.projectId).catch(() => null) ?? null;
        return reply({ ...view, sessionId });
      }
      if (method === "PATCH") {
        const body = await bodyOf(req, maxJsonBytes, ["name", "question", "dataTier", "intendedUse", "status", "budget"]);
        const study = await service.requireStudy(user, id);
        await requireAbility(study, "write");
        /** @type {Record<string, any>} */
        const patch = {};
        if (body.name !== undefined) patch.name = line(body.name, "name", NAME_MAX);
        if (body.question !== undefined) patch.question = String(body.question).slice(0, QUESTION_MAX);
        if (body.dataTier !== undefined) patch.dataTier = word(body.dataTier, VCR_DATA_TIERS, "vcr_tier_invalid", "dataTier");
        if (body.intendedUse !== undefined) {
          patch.intendedUse = word(body.intendedUse, VCR_INTENDED_USES, "vcr_intended_use_invalid", "intendedUse");
        }
        if (body.status !== undefined) patch.status = word(body.status, VCR_STUDY_STATUSES, "vcr_status_invalid", "status");
        if (body.budget !== undefined) {
          if (!body.budget || typeof body.budget !== "object" || Array.isArray(body.budget)) {
            throw new HttpError(400, "vcr_budget_invalid", "budget is an object.");
          }
          patch.budget = { ...study.budget, ...body.budget };
        }
        return reply(await service.updateStudy(user, id, patch));
      }
      if (method === "DELETE") {
        await bodyOf(req, maxJsonBytes, []);
        const study = await service.requireStudy(user, id);
        await requireAbility(study, "write");
        const result = await service.deleteStudy(user, id);
        await audit("vcr.study.delete", "completed", { userId: user.id, code: id, detail: result.projectId });
        return reply(result);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    const section = parts[2];

    // --- the seven tabs --------------------------------------------------------
    if (parts.length === 3 && method === "GET" && VCR_TABS.includes(section)) {
      return reply(await service.tab(user, id, section));
    }

    // --- 「让 AI 做」 ------------------------------------------------------------
    if (parts.length === 3 && method === "POST" && section === "run") {
      const body = await bodyOf(req, maxJsonBytes, ["step"]);
      const step = word(body.step, VCR_STEPS, "vcr_step_invalid", "step");
      const study = await service.requireStudy(user, id);
      await requireAbility(study, "run");
      if (!hooks.orchestrator?.runStep) throw UNAVAILABLE();
      return reply(await hooks.orchestrator.runStep(user, study, step));
    }

    // --- jobs ------------------------------------------------------------------
    if (section === "jobs") {
      const study = await service.requireStudy(user, id);
      if (parts.length === 3 && method === "GET") {
        if (!hooks.jobs?.listForStudy) throw UNAVAILABLE();
        return reply({ jobs: await hooks.jobs.listForStudy(study.id), budget: await hooks.jobs.budgetOf?.(study.id) ?? null });
      }
      if (parts.length === 3 && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["kind", "scenario", "inputs", "seed", "replicates", "cpuSecondsLimit"]);
        word(body.kind, VCR_JOB_KINDS, "vcr_job_kind_invalid", "kind");
        if (body.scenario != null && (typeof body.scenario !== "object" || Array.isArray(body.scenario))) {
          throw new HttpError(400, "vcr_job_scenario_invalid", "scenario is an object.");
        }
        if (body.inputs != null && !Array.isArray(body.inputs)) {
          throw new HttpError(400, "vcr_job_scenario_invalid", "inputs is an array.");
        }
        await requireAbility(study, "run");
        if (!hooks.jobs?.enqueue) throw UNAVAILABLE();
        const { job, created } = await hooks.jobs.enqueue({
          studyId: study.id, userId: String(user.id), kind: body.kind, scenario: body.scenario ?? {}, inputs: body.inputs ?? [],
          seed: body.seed ?? null, replicates: body.replicates ?? null,
          cpuSecondsLimit: body.cpuSecondsLimit == null ? null : wholeNumber(body.cpuSecondsLimit, "cpuSecondsLimit", CPU_SECONDS_MAX),
        });
        await audit("vcr.job.enqueue", "completed", { userId: user.id, code: job.id, detail: String(body.kind) });
        return reply(job, created ? 201 : 200);
      }
      if (parts.length === 4 && method === "GET") {
        if (!hooks.jobs?.get) throw UNAVAILABLE();
        const job = await hooks.jobs.get(study.id, parts[3]);
        if (!job) throw new HttpError(404, "vcr_job_not_found", "Job not found.");
        return reply(job);
      }
      if (parts.length === 5 && parts[4] === "cancel" && method === "POST") {
        await bodyOf(req, maxJsonBytes, []);
        await requireAbility(study, "run");
        if (!hooks.jobs?.cancel) throw UNAVAILABLE();
        const result = await hooks.jobs.cancel(study.id, parts[3], { actor: String(user.id) });
        await audit("vcr.job.cancel", "completed", { userId: user.id, code: parts[3], detail: id });
        return reply(result);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    // --- the second human stop: confirm compute budget ---------------------------
    if (parts.length === 3 && method === "POST" && section === "budget") {
      const body = await bodyOf(req, maxJsonBytes, ["cpuSeconds", "jobId"]);
      if (body.cpuSeconds != null) wholeNumber(body.cpuSeconds, "cpuSeconds", CPU_SECONDS_MAX);
      if (body.jobId != null && !ID.test(String(body.jobId))) throw new HttpError(400, "vcr_budget_invalid", "jobId is not an id.");
      const study = await service.requireStudy(user, id);
      await requireAbility(study, "run");
      if (!hooks.jobs?.confirmBudget) throw UNAVAILABLE();
      const result = await hooks.jobs.confirmBudget(study.id, {
        actor: String(user.id), cpuSeconds: body.cpuSeconds ?? 0, jobId: body.jobId ?? null,
      });
      await audit("vcr.budget.confirm", "completed", { userId: user.id, code: id, detail: String(result.released?.length ?? 0) });
      return reply(result);
    }

    // --- an assumption card's next version ---------------------------------------
    if (parts.length === 3 && method === "POST" && section === "assumptions") {
      const body = await bodyOf(req, maxJsonBytes,
        ["key", "name", "endpoint", "unit", "pointValue", "distribution", "sensitivity", "sourceKind", "valueSource",
          "poolingMethod", "pooling", "evidenceIds", "applicability", "note"]);
      const key = line(body.key, "key", 80);
      const study = await service.requireStudy(user, id);
      await requireAbility(study, "write");
      if (body.sourceKind != null) word(body.sourceKind, VCR_ASSUMPTION_SOURCE_KINDS, "vcr_assumption_invalid", "sourceKind");
      if (body.valueSource != null) word(body.valueSource, VCR_VALUE_SOURCES, "vcr_assumption_invalid", "valueSource");
      const saved = await store.saveAssumption({
        ...body, key, studyId: study.id, userId: String(user.id), name: body.name ?? key,
        // A person editing a card is not the AI setting it: the review state
        // follows who wrote it (plan §10.2, AC-33).
        reviewState: "reviewed",
      });
      // Changing an assumption is what §6.3 is about: everything downstream of
      // this version goes stale and the light half recomputes at once.
      if (hooks.orchestrator?.recomputeAfterChange) {
        await hooks.orchestrator.recomputeAfterChange({
          studyId: study.id, changed: [`assumption:${saved.key}@${saved.version}`], reason: "assumption_changed",
          detail: { key, by: String(user.id) },
        }).catch(() => null);
      }
      await audit("vcr.assumption.save", "completed", { userId: user.id, code: saved.id, detail: key });
      return reply(saved, 201);
    }

    // --- a review countersignature ------------------------------------------------
    if (parts.length === 3 && method === "POST" && section === "reviews") {
      const body = await bodyOf(req, maxJsonBytes, ["kind", "nodes", "note", "changes"]);
      const kind = word(body.kind, VCR_REVIEW_KINDS, "vcr_review_kind_invalid", "kind");
      if (!Array.isArray(body.nodes) || !body.nodes.length || body.nodes.length > 200
        || body.nodes.some((node) => typeof node !== "string" || node.length > 200)) {
        throw new HttpError(400, "vcr_payload_invalid", "nodes is a non-empty list of version ids.");
      }
      const study = await service.requireStudy(user, id);
      await requireAbility(study, kind === "clinical" ? "review_clinical" : kind === "statistical" ? "review_statistical" : "write");
      const saved = await store.addReview({
        studyId: study.id, userId: study.userId, kind, nodes: body.nodes, reviewer: String(user.id),
        note: String(body.note ?? "").slice(0, 2_000), changes: Array.isArray(body.changes) ? body.changes.slice(0, 100) : [],
      });
      await audit("vcr.review.add", "completed", { userId: user.id, code: saved.id, detail: kind });
      return reply(saved, 201);
    }

    // --- a decision record ---------------------------------------------------------
    if (parts.length === 3 && method === "POST" && section === "decisions") {
      const body = await bodyOf(req, maxJsonBytes, ["question", "chosen", "alternatives", "rationale"]);
      if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 500) {
        throw new HttpError(400, "vcr_decision_invalid", "question is one line of at most 500 characters.");
      }
      const study = await service.requireStudy(user, id);
      await requireAbility(study, "write");
      const saved = await store.addDecision({
        studyId: study.id, userId: study.userId, question: body.question.trim(),
        chosen: body.chosen ?? {}, alternatives: Array.isArray(body.alternatives) ? body.alternatives.slice(0, 50) : [],
        rationale: String(body.rationale ?? "").slice(0, 4_000), decidedBy: String(user.id),
      });
      return reply(saved, 201);
    }

    // --- export -----------------------------------------------------------------------
    if (section === "export") {
      const study = await service.requireStudy(user, id);
      if (parts.length === 3 && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["kind"]);
        const kind = word(body.kind, VCR_EXPORT_KINDS, "vcr_export_kind_invalid", "kind");
        // Export is never withheld for want of a review (§10.2, AC-21): the
        // cover says what is reviewed and what is not, and the intended-use
        // ceiling is what an unreviewed package cannot claim.
        await requireAbility(study, "export");
        if (!hooks.exporter?.requestExport) throw UNAVAILABLE();
        const result = await hooks.exporter.requestExport(user, study, kind);
        await audit("vcr.export.request", "completed", { userId: user.id, code: String(result?.export?.id ?? ""), detail: kind });
        return reply(result, 201);
      }
      if (parts.length === 4 && method === "GET") {
        const row = await store.exportRow(study.id, parts[3]);
        if (!row) throw new HttpError(404, "vcr_export_not_found", "Export not found.");
        return reply(row);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    // --- members (package A's writes, this module's route) ------------------------------
    if (section === "members") {
      const study = await service.requireStudy(user, id);
      if (parts.length === 3 && method === "GET") return reply({ members: await store.members(study.id) });
      if (parts.length === 3 && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["userId", "role", "detail"]);
        if (typeof body.userId !== "string" || !ID.test(body.userId)) throw new HttpError(400, "vcr_payload_invalid", "userId is an id.");
        word(body.role, VCR_MEMBER_ROLES, "vcr_member_role_invalid", "role");
        await requireAbility(study, "manage_members");
        if (!hooks.members?.add) throw UNAVAILABLE();
        const result = await hooks.members.add(user, study, { userId: body.userId, role: body.role, detail: body.detail ?? {} });
        await audit("vcr.member.add", "completed", { userId: user.id, code: study.id, detail: String(body.role) });
        return reply(result, 201);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    // --- the first human stop: a coordinator confirms one contact ------------------------
    if (section === "referrals" && parts.length === 5 && parts[4] === "contact" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["note", "reason"]);
      const study = await service.requireStudy(user, id);
      await requireAbility(study, "contact_patients");
      if (!hooks.matching?.contactReferral) throw UNAVAILABLE();
      const result = await hooks.matching.contactReferral(user, study, parts[3], {
        note: String(body.note ?? "").slice(0, 1_000), reason: String(body.reason ?? "").slice(0, 500),
      });
      await audit("vcr.referral.contact", "completed", { userId: user.id, code: parts[3], detail: id });
      return reply(result);
    }

    throw new HttpError(404, "not_found", "虚拟临研 route not found.");
  };
}
