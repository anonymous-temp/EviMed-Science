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
 * - **Two stores, two jobs.** `store` is the platform's — the session and the
 *   CSRF token, and nothing else. Every question about a study's roles,
 *   assumptions, reviews, decisions, exports and members goes to `vcrStore`.
 *   Until 2026-09-29 the composition handed these routes the platform store
 *   for both, and every write, every member read and every role check threw
 *   `is not a function` on the first real request (review CS-1) — hidden for
 *   the whole build by tests whose double had the methods the real one lacked.
 * - **A role is checked per operation, on every route, reads included**
 *   (platform principle 14). A caller's abilities are the union of what the
 *   roles it holds allow (`roleAllows`), the owner being a `lead` without a
 *   membership row; a refusal names the ability rather than the role. A
 *   `site` member holds referral abilities only, so it reads no page of the
 *   study — its own site's referrals are what `GET …/referrals` gives it.
 *   `VCR_ROUTE_ABILITIES` is the table of which route needs what; the
 *   composed-application test drives every route as every role against it.
 * - **Changing what a study is, is the lead's.** `manage_study` (held by
 *   whoever manages the members: the study lead) is what renames nothing but
 *   moves the data tier, the intended use, the status — and deletes. A data
 *   manager who could raise a study to `submission_preparation` would lift the
 *   ceiling every result on the page is labelled under. The compute budget is
 *   not a study field: it changes only through the audited confirmation
 *   (`POST …/budget`), which is the second human stop.
 * - **The write-side actions that belong to other packages are hooks**:
 *   `orchestrator.runStep` (「让 AI 做」) and `requestExport`, `jobs.enqueue`
 *   and `cancel` and `confirmBudget`, `members`, and `matching`
 *   (`contactReferral`, the first human stop, `transitionReferral`,
 *   `listReferrals`). A hook that is not composed answers 503
 *   `vcr_unavailable` — the route exists, the worker does not yet. Hooks are
 *   read at request time, so a package composed after the routes attaches to
 *   the same object and is found.
 * - **The audit line says what happened.** A write that completed, one that was
 *   refused (a 4xx: the caller's ability, a closed vocabulary, a stop that
 *   held) and one that failed are three different lines, never "completed".
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
import { abilitiesOfRoles } from "./vcrMembers.mjs";
import { isSiteScopedRole } from "./vcrRecruit.mjs";

/**
 * Every code these routes answer with — or that a module behind them answers
 * through them. Exported so a test can prove the routes emit nothing outside
 * this list, and so the domain's own registry can take it verbatim.
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
  "vcr_model_exists",
  "vcr_member_role_invalid",
  "vcr_referral_not_found",
  "vcr_forbidden",
  "vcr_unavailable",
]);

/**
 * What each route needs of its caller: the caller must hold at least one of the
 * listed abilities in this study. Read by the routes themselves and by the
 * composed-application test, which checks every route against every role.
 */
export const VCR_ROUTE_ABILITIES = Object.freeze({
  "GET /studies/:id": ["read"],
  "GET /studies/:id/:tab": ["read"],
  "PATCH /studies/:id name,question": ["write"],
  "PATCH /studies/:id dataTier,intendedUse,status": ["manage_study"],
  "DELETE /studies/:id": ["manage_study"],
  "POST /studies/:id/run": ["run"],
  "GET /studies/:id/jobs": ["read"],
  "GET /studies/:id/jobs/:job": ["read"],
  "POST /studies/:id/jobs": ["run"],
  "POST /studies/:id/jobs/:job/cancel": ["run"],
  "POST /studies/:id/budget": ["manage_study"],
  "POST /studies/:id/assumptions": ["write"],
  "POST /studies/:id/reviews clinical": ["review_clinical", "review_any"],
  "POST /studies/:id/reviews statistical": ["review_statistical", "review_any"],
  "POST /studies/:id/reviews data": ["write", "review_any"],
  "POST /studies/:id/decisions": ["write"],
  "POST /studies/:id/export": ["export"],
  "GET /studies/:id/export/:export": ["read"],
  "GET /studies/:id/members": ["read"],
  "POST /studies/:id/members": ["manage_members"],
  "DELETE /studies/:id/members/:user": ["manage_members"],
  "GET /studies/:id/referrals": ["read", "read_referrals"],
  "POST /studies/:id/referrals/:referral/transition": ["write_referrals", "contact_patients"],
  "POST /studies/:id/referrals/:referral/contact": ["contact_patients"],
  "POST /models (with a study)": ["write"],
});

const NOT_ENABLED = () => new HttpError(404, "vcr_not_enabled", "虚拟临研 is not enabled.");
const UNAVAILABLE = () => new HttpError(503, "vcr_unavailable", "This 虚拟临研 action is not available on this deployment yet.");
const ID = /^[A-Za-z0-9_-]{1,80}$/;
/** A study name is one line; the same ceiling a project name has. */
const NAME_MAX = 40;
const QUESTION_MAX = 2_000;
const CPU_SECONDS_MAX = 10_000_000;

/** @param {string} role @param {string} ability */
const roleHolds = (role, ability) => roleAllows(role, ability);

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
  return `/api/vcr/studies/:id/${section}/:item/${["cancel", "contact", "transition"].includes(parts[4]) ? parts[4] : ":action"}`;
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
 * @param {{ store: { ensureSessionUser: (req: any, res: any, options?: any) => Promise<{ user: any }>,
 *     assertCsrf: (req: any, pathname: string) => Promise<unknown> },
 *   vcrStore?: any, service: any, config: Record<string, any>, maxJsonBytes: number,
 *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<unknown>,
 *   projects?: { create: (user: any, name: string) => Promise<{ id: string, name: string }>,
 *     bindSession: (user: any, projectId: string, capabilityId: string) => Promise<{ sessionId: string, bound: boolean }>,
 *     latestSessionId?: (user: any, projectId: string) => Promise<string | null>,
 *     remove?: (user: any, projectId: string) => Promise<unknown> } | null,
 *   orchestrator?: any, jobs?: any, exporter?: any, members?: any, matching?: any }} dependencies
 *   `store` is the platform's, for the session and the CSRF check only;
 *   `vcrStore` is the module's own (defaults to the service's).
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
    /** The module's own store: roles, assumptions, reviews, decisions, exports, members. */
    const data = () => {
      const found = dependencies.vcrStore ?? service.store ?? null;
      if (!found) throw UNAVAILABLE();
      return found;
    };

    /** @type {Map<string, string[]>} */
    const rolesByStudy = new Map();
    /**
     * The roles this caller holds in this study, read once per request. The
     * owner is a `lead` even when no membership row says so — a study cannot
     * lock out the person who made it.
     * @param {any} study
     * @returns {Promise<string[]>}
     */
    const rolesIn = async (study) => {
      const known = rolesByStudy.get(study.id);
      if (known) return known;
      const rows = await data().rolesOf(study.id, String(user.id));
      const held = [...new Set([...(study.userId === String(user.id) ? ["lead"] : []), ...rows])];
      rolesByStudy.set(study.id, held);
      return held;
    };

    /**
     * Refuse unless the caller holds at least one of `abilities` — one of them
     * in one role, or across the roles it holds.
     * @param {any} study @param {string | readonly string[]} abilities
     */
    const requireAbility = async (study, abilities) => {
      const wanted = typeof abilities === "string" ? [abilities] : [...abilities];
      const roles = await rolesIn(study);
      if (!wanted.some((ability) => roles.some((role) => roleHolds(role, ability)))) {
        throw new HttpError(403, "vcr_forbidden", `这个操作需要「${wanted[0]}」权限，你在本研究中没有。`);
      }
      return roles;
    };

    /**
     * The study for this caller, and the ability that is asked of it.
     * @param {string} id @param {string | readonly string[]} abilities
     */
    const authorize = async (id, abilities) => {
      const study = await service.requireStudy(user, id);
      const roles = await requireAbility(study, abilities);
      return { study, roles };
    };

    /**
     * Run a write and audit what happened to it: completed, refused (a 4xx) or
     * failed. The audit line is never the caller's business.
     * @template T
     * @param {string} event @param {(result: T) => Record<string, any>} completed @param {Record<string, any>} attempted
     * @param {() => Promise<T>} work
     * @returns {Promise<T>}
     */
    const audited = async (event, completed, attempted, work) => {
      let result;
      try {
        result = await work();
      } catch (error) {
        const refused = error instanceof HttpError && error.status < 500;
        // The line's `code` is what went wrong; what it was tried on rides in `detail`.
        await audit(event, refused ? "refused" : "failed", {
          userId: user.id, code: String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.name ?? "error"),
          detail: [attempted.code, attempted.detail].filter(Boolean).join(" "),
        }).catch(() => null);
        throw error;
      }
      await audit(event, "completed", { userId: user.id, ...completed(result) }).catch(() => null);
      return result;
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
        // A model taken from a study is written into the study's library by
        // someone who may write there; one with no study is the account's own.
        if (body.studyId != null) {
          if (typeof body.studyId !== "string" || !ID.test(body.studyId)) {
            throw new HttpError(400, "vcr_payload_invalid", "studyId is an id.");
          }
          await authorize(body.studyId, "write");
        }
        const saved = await audited("vcr.model.adopt", (result) => ({ code: String(result?.id ?? ""), detail: String(body.name) }),
          { detail: String(body.name) }, () => service.adoptModel(user, body));
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
        const projects = dependencies.projects;
        if (!projects) throw UNAVAILABLE();
        // A study is a project plus a row. When the row (or anything after it)
        // fails, the project the request made goes with it — a failed 「新建
        // 研究」 leaves no project in the sidebar that is not a study.
        /** @type {string | null} */
        let madeProject = null;
        const created = await audited("vcr.study.create", (result) => ({ code: result.id, detail: result.projectId }), {},
          async () => {
            try {
              return await service.createStudy(user, input, {
                createResearcherProject: async (/** @type {any} */ owner, /** @type {string} */ name) => {
                  const project = await projects.create(owner, name);
                  madeProject = project.id;
                  return project;
                },
                bindSession: projects.bindSession,
              });
            } catch (error) {
              if (madeProject && projects.remove) await projects.remove(user, madeProject).catch(() => null);
              throw error;
            }
          });
        return reply(created, 201);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    const id = parts[1];
    if (parts.length === 2) {
      if (method === "GET") {
        const { study, roles } = await authorize(id, "read");
        const view = await service.studyView(user, study.id);
        const sessionId = await dependencies.projects?.latestSessionId?.(user, view.projectId).catch(() => null) ?? null;
        const abilities = new Set(abilitiesOfRoles(roles));
        if (roles.some((role) => roleHolds(role, "manage_study"))) abilities.add("manage_study");
        // What this caller may do, from the roles it holds now: the page reads
        // it to show only the actions that will not be refused.
        return reply({ ...view, sessionId, roles, abilities: [...abilities].sort() });
      }
      if (method === "PATCH") {
        const body = await bodyOf(req, maxJsonBytes, ["name", "question", "dataTier", "intendedUse", "status"]);
        const study = await service.requireStudy(user, id);
        const changesStudy = ["dataTier", "intendedUse", "status"].some((key) => body[key] !== undefined);
        if (changesStudy) await requireAbility(study, "manage_study");
        if (body.name !== undefined || body.question !== undefined || !changesStudy) await requireAbility(study, "write");
        /** @type {Record<string, any>} */
        const patch = {};
        if (body.name !== undefined) patch.name = line(body.name, "name", NAME_MAX);
        if (body.question !== undefined) patch.question = String(body.question).slice(0, QUESTION_MAX);
        if (body.dataTier !== undefined) patch.dataTier = word(body.dataTier, VCR_DATA_TIERS, "vcr_tier_invalid", "dataTier");
        if (body.intendedUse !== undefined) {
          patch.intendedUse = word(body.intendedUse, VCR_INTENDED_USES, "vcr_intended_use_invalid", "intendedUse");
        }
        if (body.status !== undefined) patch.status = word(body.status, VCR_STUDY_STATUSES, "vcr_status_invalid", "status");
        return reply(await audited("vcr.study.update", () => ({ code: id, detail: Object.keys(patch).join(",") }),
          { detail: Object.keys(patch).join(",") }, () => service.updateStudy(user, id, patch)));
      }
      if (method === "DELETE") {
        await bodyOf(req, maxJsonBytes, []);
        const { study } = await authorize(id, "manage_study");
        const result = await audited("vcr.study.delete", (deleted) => ({ code: id, detail: deleted.projectId }), { code: id },
          () => service.deleteStudy(user, study.id));
        return reply(result);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    const section = parts[2];

    // --- the seven tabs --------------------------------------------------------
    if (parts.length === 3 && method === "GET" && VCR_TABS.includes(section)) {
      await authorize(id, "read");
      return reply(await service.tab(user, id, section, url.searchParams));
    }

    // --- 「让 AI 做」 ------------------------------------------------------------
    if (parts.length === 3 && method === "POST" && section === "run") {
      const body = await bodyOf(req, maxJsonBytes, ["step"]);
      const step = word(body.step, VCR_STEPS, "vcr_step_invalid", "step");
      const { study } = await authorize(id, "run");
      if (!hooks.orchestrator?.runStep) throw UNAVAILABLE();
      return reply(await audited("vcr.step.run", () => ({ code: id, detail: step }), { code: id, detail: step },
        () => hooks.orchestrator.runStep(user, study, step)));
    }

    // --- jobs ------------------------------------------------------------------
    if (section === "jobs") {
      if (parts.length === 3 && method === "GET") {
        const { study } = await authorize(id, "read");
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
        const { study } = await authorize(id, "run");
        if (!hooks.jobs?.enqueue) throw UNAVAILABLE();
        const cpuSecondsLimit = body.cpuSecondsLimit == null ? null : wholeNumber(body.cpuSecondsLimit, "cpuSecondsLimit", CPU_SECONDS_MAX);
        const { job, created } = await audited("vcr.job.enqueue", (result) => ({ code: result.job.id, detail: String(body.kind) }),
          { code: id, detail: String(body.kind) }, () => hooks.jobs.enqueue({
            studyId: study.id, userId: String(user.id), kind: body.kind, scenario: body.scenario ?? {}, inputs: body.inputs ?? [],
            seed: body.seed ?? null, replicates: body.replicates ?? null, cpuSecondsLimit,
          }));
        return reply(job, created ? 201 : 200);
      }
      if (parts.length === 4 && method === "GET") {
        const { study } = await authorize(id, "read");
        if (!hooks.jobs?.get) throw UNAVAILABLE();
        const job = await hooks.jobs.get(study.id, parts[3]);
        if (!job) throw new HttpError(404, "vcr_job_not_found", "Job not found.");
        return reply(job);
      }
      if (parts.length === 5 && parts[4] === "cancel" && method === "POST") {
        await bodyOf(req, maxJsonBytes, []);
        const { study } = await authorize(id, "run");
        if (!hooks.jobs?.cancel) throw UNAVAILABLE();
        const result = await audited("vcr.job.cancel", () => ({ code: parts[3], detail: id }), { code: parts[3], detail: id },
          () => hooks.jobs.cancel(study.id, parts[3], { actor: String(user.id) }));
        return reply(result);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    // --- the second human stop: confirm compute budget ---------------------------
    if (parts.length === 3 && method === "POST" && section === "budget") {
      const body = await bodyOf(req, maxJsonBytes, ["cpuSeconds", "jobId"]);
      if (body.cpuSeconds != null) wholeNumber(body.cpuSeconds, "cpuSeconds", CPU_SECONDS_MAX);
      if (body.jobId != null && !ID.test(String(body.jobId))) throw new HttpError(400, "vcr_budget_invalid", "jobId is not an id.");
      // Spending is the lead's to confirm: the person who queued the compute
      // and the person who signs it off must not be the same click. Audited
      // whichever way it goes, the refusal of a caller who may not included.
      const result = await audited("vcr.budget.confirm", (confirmed) => ({ code: id, detail: String(confirmed.released?.length ?? 0) }),
        { code: id }, async () => {
          const { study } = await authorize(id, "manage_study");
          if (!hooks.jobs?.confirmBudget) throw UNAVAILABLE();
          return hooks.jobs.confirmBudget(study.id, {
            actor: String(user.id), cpuSeconds: body.cpuSeconds ?? 0, jobId: body.jobId ?? null,
          });
        });
      return reply(result);
    }

    // --- an assumption card's next version ---------------------------------------
    if (parts.length === 3 && method === "POST" && section === "assumptions") {
      const body = await bodyOf(req, maxJsonBytes,
        ["key", "name", "endpoint", "unit", "pointValue", "distribution", "sensitivity", "sourceKind", "valueSource",
          "poolingMethod", "pooling", "evidenceIds", "applicability", "note"]);
      const key = line(body.key, "key", 80);
      const { study } = await authorize(id, "write");
      if (body.sourceKind != null) word(body.sourceKind, VCR_ASSUMPTION_SOURCE_KINDS, "vcr_assumption_invalid", "sourceKind");
      if (body.valueSource != null) word(body.valueSource, VCR_VALUE_SOURCES, "vcr_assumption_invalid", "valueSource");
      const saved = await audited("vcr.assumption.save", (card) => ({ code: card.id, detail: key }), { code: id, detail: key },
        () => data().saveAssumption({
          ...body, key, studyId: study.id, userId: String(user.id), name: body.name ?? key,
          // A person editing a card is not the AI setting it: the review state
          // follows who wrote it (plan §10.2, AC-33).
          reviewState: "reviewed",
        }));
      // Changing an assumption is what §6.3 is about: everything downstream of
      // this version goes stale and the light half recomputes at once.
      if (hooks.orchestrator?.recomputeAfterChange) {
        await hooks.orchestrator.recomputeAfterChange({
          studyId: study.id, changed: [`assumption:${saved.key}@${saved.version}`], reason: "assumption_changed",
          detail: { key, by: String(user.id) },
        }).catch(() => null);
      }
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
      // The study lead holds `review_any`; every other reviewer counter-signs
      // the one kind their role carries.
      const { study } = await authorize(id, [
        kind === "clinical" ? "review_clinical" : kind === "statistical" ? "review_statistical" : "write", "review_any"]);
      const saved = await audited("vcr.review.add", (review) => ({ code: review.id, detail: kind }), { code: id, detail: kind },
        () => data().addReview({
          studyId: study.id, userId: study.userId, kind, nodes: body.nodes, reviewer: String(user.id),
          note: String(body.note ?? "").slice(0, 2_000), changes: Array.isArray(body.changes) ? body.changes.slice(0, 100) : [],
        }));
      return reply(saved, 201);
    }

    // --- a decision record ---------------------------------------------------------
    if (parts.length === 3 && method === "POST" && section === "decisions") {
      const body = await bodyOf(req, maxJsonBytes, ["question", "chosen", "alternatives", "rationale"]);
      if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 500) {
        throw new HttpError(400, "vcr_decision_invalid", "question is one line of at most 500 characters.");
      }
      const { study } = await authorize(id, "write");
      const saved = await audited("vcr.decision.add", (decision) => ({ code: decision.id, detail: id }), { code: id },
        () => data().addDecision({
          studyId: study.id, userId: study.userId, question: body.question.trim(),
          chosen: body.chosen ?? {}, alternatives: Array.isArray(body.alternatives) ? body.alternatives.slice(0, 50) : [],
          rationale: String(body.rationale ?? "").slice(0, 4_000), decidedBy: String(user.id),
        }));
      return reply(saved, 201);
    }

    // --- export -----------------------------------------------------------------------
    if (section === "export") {
      if (parts.length === 3 && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["kind"]);
        const kind = word(body.kind, VCR_EXPORT_KINDS, "vcr_export_kind_invalid", "kind");
        // Export is never withheld for want of a review (§10.2, AC-21): the
        // cover says what is reviewed and what is not, and the intended-use
        // ceiling is what an unreviewed package cannot claim.
        const { study } = await authorize(id, "export");
        if (!hooks.exporter?.requestExport) throw UNAVAILABLE();
        const result = await audited("vcr.export.request", (requested) => ({ code: String(requested?.export?.id ?? ""), detail: kind }),
          { code: id, detail: kind }, () => hooks.exporter.requestExport(user, study, kind));
        return reply(result, 201);
      }
      if (parts.length === 4 && method === "GET") {
        await authorize(id, "read");
        // The reader page, not the stored row: the presenter shapes it the way
        // `VcrPackageReader` reads it (title, meta, sections, the run and file).
        return reply(await service.exportView(user, id, parts[3]));
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    // --- members ---------------------------------------------------------------------
    if (section === "members") {
      if (parts.length === 3 && method === "GET") {
        const { study } = await authorize(id, "read");
        return reply({
          members: hooks.members?.list ? await hooks.members.list({ actor: String(user.id), studyId: study.id }) : await data().members(study.id),
        });
      }
      if (parts.length === 3 && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["userId", "role", "detail"]);
        if (typeof body.userId !== "string" || !ID.test(body.userId)) throw new HttpError(400, "vcr_payload_invalid", "userId is an id.");
        const role = word(body.role, VCR_MEMBER_ROLES, "vcr_member_role_invalid", "role");
        const detail = memberDetail(body.detail);
        // A site reads and moves the referrals of its own site and nothing else:
        // without the site named, the account would hold a role that does nothing.
        if (isSiteScopedRole(role) && !detail.siteId) {
          throw new HttpError(400, "vcr_payload_invalid", "A site member needs detail.siteId: the site it belongs to.");
        }
        const { study } = await authorize(id, "manage_members");
        if (!hooks.members?.add) throw UNAVAILABLE();
        const result = await audited("vcr.member.add", () => ({ code: study.id, detail: role }), { code: study.id, detail: role },
          () => hooks.members.add({ actor: String(user.id), studyId: study.id, userId: body.userId, role, detail }));
        return reply(result, 201);
      }
      if (parts.length === 4 && method === "DELETE") {
        await bodyOf(req, maxJsonBytes, []);
        const role = url.searchParams.get("role");
        if (role != null && !VCR_MEMBER_ROLES.includes(role)) {
          throw new HttpError(400, "vcr_member_role_invalid", `role must be one of: ${VCR_MEMBER_ROLES.join(", ")}.`);
        }
        const { study } = await authorize(id, "manage_members");
        if (!hooks.members?.remove) throw UNAVAILABLE();
        const target = parts[3];
        // One role when a role is named; every role the account holds otherwise.
        const roles = role ? [role] : (await data().rolesOf(study.id, target));
        const removed = await audited("vcr.member.remove", (count) => ({ code: study.id, detail: `${count.removed}` }),
          { code: study.id, detail: role ?? "all" }, async () => {
            let count = 0;
            for (const each of roles) {
              const result = await hooks.members.remove({ actor: String(user.id), studyId: study.id, userId: target, role: each });
              if (result?.removed) count += 1;
            }
            return { removed: count };
          });
        return reply(removed);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    // --- the referral ledger; the first human stop is a coordinator confirming one contact --------
    if (section === "referrals") {
      if (parts.length === 3 && method === "GET") {
        const { study } = await authorize(id, VCR_ROUTE_ABILITIES["GET /studies/:id/referrals"]);
        if (!hooks.matching?.listReferrals) throw UNAVAILABLE();
        return reply(await hooks.matching.listReferrals(user, study, { state: url.searchParams.get("state") }));
      }
      if (parts.length === 5 && parts[4] === "transition" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes,
          ["to", "note", "siteId", "screenFailCriterionId", "screenFailReason", "enrolledOn"]);
        const result = await audited("vcr.referral.transition", (moved) => ({ code: parts[3], detail: String(moved?.referral?.state ?? "") }),
          { code: parts[3], detail: String(body.to ?? "") }, async () => {
            const { study } = await authorize(id, VCR_ROUTE_ABILITIES["POST /studies/:id/referrals/:referral/transition"]);
            if (!hooks.matching?.transitionReferral) throw UNAVAILABLE();
            return hooks.matching.transitionReferral(user, study, parts[3], body);
          });
        return reply(result);
      }
      if (parts.length === 5 && parts[4] === "contact" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["note", "reason"]);
        // The audit line is the outcome — and the caller's ability is part of
        // it: a contact that was confirmed, one the caller's role could not
        // even ask for, one the stop refused (which state, which role) and one
        // that failed each read as what they were.
        const result = await audited("vcr.referral.contact", (contacted) => ({
          code: parts[3], detail: contacted?.alreadyContacted ? `${id} (already contacted)` : id,
        }), { code: parts[3], detail: id }, async () => {
          const { study } = await authorize(id, "contact_patients");
          if (!hooks.matching?.contactReferral) throw UNAVAILABLE();
          return hooks.matching.contactReferral(user, study, parts[3], {
            note: String(body.note ?? "").slice(0, 1_000), reason: String(body.reason ?? "").slice(0, 500),
          });
        });
        return reply(result);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    throw new HttpError(404, "not_found", "虚拟临研 route not found.");
  };
}

/**
 * What a membership may carry with it: the site a `site` member belongs to and
 * a short note. Nothing else is stored — the row is read by the referral
 * scoping, and a free-form object would be somewhere for anything to hide.
 * @param {unknown} value
 */
function memberDetail(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "vcr_payload_invalid", "detail is an object.");
  const { siteId, note, ...rest } = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(rest).length) throw new HttpError(400, "vcr_payload_invalid", "detail takes only: siteId, note.");
  /** @type {Record<string, string>} */
  const detail = {};
  if (siteId != null) {
    if (typeof siteId !== "string" || !ID.test(siteId)) throw new HttpError(400, "vcr_payload_invalid", "detail.siteId is an id.");
    detail.siteId = siteId;
  }
  if (note != null) detail.note = String(note).slice(0, 200);
  return detail;
}
