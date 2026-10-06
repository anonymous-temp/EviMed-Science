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
 * - **Data intake is one ability and one plane.** Every route under
 *   `/api/vcr/studies/:id/data/*` needs `manage_data` (the lead and the data
 *   manager) and goes to the data plane (`vcrDataPlane.mjs`), which judges again
 *   for the same principal: the route says who may ask, the plane says whether
 *   this ask is fine for this source. An upload is the one body that is not JSON
 *   — the file itself, streamed to the plane under a size cap without ever being
 *   held whole here — with its name, role and options in the query. Nothing a
 *   route answers carries a path of the server: a location is the plane's own.
 * - **Writes arrive past the platform's CSRF check and maintenance
 *   admission** (the dispatch in `server.mjs`); the CSRF check is repeated
 *   here like every route factory does.
 * - Answers keep the platform's envelope, `{ data: <shape> }`.
 *
 * @module vcrRoutes
 */

import {
  VCR_ACTIONS, VCR_ASSESSMENT_KEY, VCR_ASSESSMENT_LIMITS, VCR_ASSESSMENT_RATING_FIELDS, VCR_ASSESSMENT_TEXT_FIELDS, VCR_RATINGS,
  VCR_ASSUMPTION_SOURCE_KINDS, VCR_CRITERION_STATES, VCR_DATA_TIERS, VCR_EXPORT_KINDS, VCR_INTENDED_USES, VCR_JOB_KINDS,
  VCR_MEMBER_ROLES, VCR_REVIEW_KINDS, VCR_STEPS, VCR_STUDY_STATUSES, VCR_TABS, VCR_VALUE_SOURCES, roleAllows } from "@evimed/domain";

import { HttpError, readJson, sendJson } from "./security.mjs";
import { fileView, importAttemptAuditDetail, importAuditDetail, snapshotView, sourceView, tableView, uploadAttemptAuditDetail, uploadAuditDetail } from "./vcrDataPlane.mjs";
import { abilitiesOfRoles } from "./vcrMembers.mjs";
import { isSiteScopedRole } from "./vcrRecruit.mjs";
import { VCR_PUBLICATION_LIMITS } from "./vcrPublications.mjs";

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
  "vcr_action_invalid",
  "vcr_criterion_state_invalid",
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
  "vcr_evidence_unverified",
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
  "vcr_data_plane_not_configured",
  "vcr_data_file_name_invalid",
  "vcr_pack_not_found",
  "vcr_pack_invalid",
  "vcr_definition_not_found",
  "vcr_definition_invalid",
  "vcr_model_assessment_not_found",
  // 「模拟研究」 (flywheel 2026-10-06): the column is off, the publication is not the study's, the report is not written yet, the
  // words of the report name a subject of the study.
  "vcr_publications_not_enabled",
  "vcr_publication_not_found",
  "vcr_publication_not_ready",
  "vcr_publication_patient_data",
]);

/**
 * What each route needs of its caller: the caller must hold at least one of the
 * listed abilities in this study. Read by the routes themselves and by the
 * composed-application test, which checks every route against every role.
 */
export const VCR_ROUTE_ABILITIES = Object.freeze({
  "GET /studies/:id": ["read"],
  "GET /studies/:id/:tab": ["read"],
  "PATCH /studies/:id name,question,action": ["write"],
  "PATCH /studies/:id dataTier,intendedUse,status": ["manage_study"],
  "DELETE /studies/:id": ["manage_study"],
  "POST /studies/:id/run": ["run"],
  "GET /studies/:id/jobs": ["read"],
  "GET /studies/:id/jobs/:job": ["read"],
  "POST /studies/:id/jobs": ["run"],
  "POST /studies/:id/jobs/:job/cancel": ["run"],
  "POST /studies/:id/budget": ["manage_study"],
  "POST /studies/:id/assumptions": ["write"],
  "POST /studies/:id/model-assessments": ["manage_study"],
  "POST /studies/:id/correction-cases": ["export"],
  "GET /studies/:id/correction-cases/:dataset": ["export"],
  "POST /studies/:id/correction-cases/:dataset/replay": ["export"],
  "GET /studies/:id/curve-extractions": ["read"],
  "POST /studies/:id/curve-extractions": ["write"],
  "POST /studies/:id/reviews clinical": ["review_clinical", "review_any"],
  "POST /studies/:id/reviews statistical": ["review_statistical", "review_any"],
  "POST /studies/:id/reviews data": ["write", "review_any"],
  "POST /studies/:id/decisions": ["write"],
  "POST /studies/:id/export": ["export"],
  "GET /studies/:id/export/:export": ["read"],
  "GET /studies/:id/publications": ["read"],
  "POST /studies/:id/publications": ["manage_study"],
  "DELETE /studies/:id/publications/:publication": ["manage_study"],
  "GET /studies/:id/members": ["read"],
  "POST /studies/:id/members": ["manage_members"],
  "DELETE /studies/:id/members/:user": ["manage_members"],
  "GET /studies/:id/referrals": ["read", "read_referrals"],
  "POST /studies/:id/referrals/:referral/transition": ["write_referrals", "contact_patients"],
  "POST /studies/:id/referrals/:referral/contact": ["contact_patients"],
  "POST /studies/:id/assessments/:assessment/judgments/:criterion/override": ["write_referrals", "review_clinical", "review_any"],
  "POST /studies/:id/assessments/:assessment/review": ["review_clinical", "review_any"],
  "POST /models (with a study)": ["write"],
  "POST /studies/:id/pack": ["write"],
  "POST /studies/:id/pack/promote": ["manage_study"],
  "POST /studies/:id/definitions": ["write"],
  "POST /studies/:id/definitions/:definition/use": ["write"],
  "POST /studies/:id/definitions/:definition/compare": ["run"],
  "POST /studies/:id/data/sources": ["manage_data"],
  "POST /studies/:id/data/sources/:source/files": ["manage_data"],
  "DELETE /studies/:id/data/files/:file": ["manage_data"],
  "POST /studies/:id/data/sources/:source/fieldmap": ["manage_data"],
  "POST /studies/:id/data/sources/:source/fieldmap/confirm": ["manage_data"],
  "POST /studies/:id/data/sources/:source/snapshots": ["manage_data"],
  "POST /studies/:id/data/snapshots/:snapshot/tables": ["manage_data"],
  "POST /studies/:id/data/sources/:source/grants": ["manage_data"],
  "POST /studies/:id/data/grants/:grant/revoke": ["manage_data"],
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
  if (parts[0] === "packs") return parts.length === 1 ? "/api/vcr/packs" : "/api/vcr/packs/:id";
  if (parts[0] === "definitions") return parts.length === 1 ? "/api/vcr/definitions" : "/api/vcr/definitions/:id";
  if (parts[0] !== "studies") return "/api/vcr/:route";
  if (parts.length === 1) return "/api/vcr/studies";
  if (parts.length === 2) return "/api/vcr/studies/:id";
  const known = [...VCR_TABS, "run", "jobs", "budget", "assumptions", "model-assessments", "reviews", "curve-extractions", "correction-cases", "decisions", "export", "publications", "members", "referrals", "pack", "definitions"];
  const section = known.includes(parts[2]) ? parts[2] : ":route";
  if (parts[2] === "data" && parts.length > 3) {
    // The intake routes: `data/<kind>[/:item[/<action>[/confirm]]]`, every id folded.
    const kind = ["sources", "files", "snapshots", "grants"].includes(parts[3]) ? parts[3] : ":route";
    if (parts.length === 4) return `/api/vcr/studies/:id/data/${kind}`;
    if (parts.length === 5) return `/api/vcr/studies/:id/data/${kind}/:item`;
    const action = ["files", "fieldmap", "snapshots", "grants", "tables", "revoke"].includes(parts[5]) ? parts[5] : ":action";
    return `/api/vcr/studies/:id/data/${kind}/:item/${action}${parts.length > 6 ? "/:step" : ""}`;
  }
  if (parts.length === 3) return `/api/vcr/studies/:id/${section}`;
  if (parts.length === 4) return `/api/vcr/studies/:id/${section}/:item`;
  return `/api/vcr/studies/:id/${section}/:item/${["cancel", "contact", "transition", "use", "compare"].includes(parts[4]) ? parts[4] : ":action"}`;
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

/** The ceiling on a study name, for whoever composes one (the acceptance driver's test holds its own copy equal). */
export const VCR_STUDY_NAME_MAX = NAME_MAX;

/**
 * A study name as the routes that take one read it. Exported so a caller that
 * builds a name — the acceptance driver appends a tag to the owner's — can be
 * held to this rule itself, not to a copy of the number: the driver's own test
 * server took any name, and every live intake was refused `vcr_name_invalid`.
 * @param {unknown} value
 */
export function vcrStudyName(value) {
  return line(value, "name", NAME_MAX);
}

/** @param {unknown} value @param {readonly string[]} vocabulary @param {string} code @param {string} field */
function word(value, vocabulary, code, field) {
  if (typeof value !== "string" || !vocabulary.includes(value)) {
    throw new HttpError(400, code, `${field} must be one of: ${vocabulary.join(", ")}.`);
  }
  return value;
}

/**
 * What a person may say in a model assessment record: the guideline's fields and nothing the platform derives. The risk is not
 * among them — it is worked out from the two ratings (`vcrModelRisk`) — and neither is the model the record is about.
 */
const ASSESSMENT_EDIT_FIELDS = Object.freeze(["key", ...VCR_ASSESSMENT_TEXT_FIELDS, ...VCR_ASSESSMENT_RATING_FIELDS, "technicalCriteria"]);

/**
 * The fields a person's edit named, checked against the limits the run's write holds (`VCR_ASSESSMENT_LIMITS`). A rating is one of
 * the three words, or empty to clear it; a field the edit does not name is the record as it stands.
 * @param {Record<string, any>} body @returns {Record<string, any>}
 */
function assessmentEdit(body) {
  const refuse = (/** @type {string} */ field, /** @type {string} */ why) => new HttpError(400, "vcr_payload_invalid", `${field} ${why}`);
  if (typeof body.key !== "string" || body.key.length > VCR_ASSESSMENT_LIMITS.key || !VCR_ASSESSMENT_KEY.test(body.key)) {
    throw refuse("key", "is the record's name: lowercase letters, digits and underscores, starting with a letter.");
  }
  /** @type {Record<string, any>} */
  const edit = { key: body.key };
  for (const field of VCR_ASSESSMENT_TEXT_FIELDS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string" || body[field].length > VCR_ASSESSMENT_LIMITS.text) throw refuse(field, `is text of at most ${VCR_ASSESSMENT_LIMITS.text} characters.`);
    edit[field] = body[field];
  }
  for (const field of VCR_ASSESSMENT_RATING_FIELDS) {
    if (body[field] === undefined) continue;
    if (body[field] !== "" && !VCR_RATINGS.includes(body[field])) throw refuse(field, `is one of ${VCR_RATINGS.join(", ")}, or empty.`);
    edit[field] = body[field];
  }
  if (body.technicalCriteria !== undefined) {
    const criteria = body.technicalCriteria;
    if (!Array.isArray(criteria) || criteria.length > VCR_ASSESSMENT_LIMITS.criteria) {
      throw refuse("technicalCriteria", `is a list of at most ${VCR_ASSESSMENT_LIMITS.criteria} criteria.`);
    }
    edit.technicalCriteria = criteria.map((/** @type {any} */ entry) => {
      const one = typeof entry === "string" ? { criterion: entry, rationale: "" } : entry;
      if (!one || typeof one !== "object" || typeof one.criterion !== "string" || !one.criterion.trim()
        || (one.rationale != null && typeof one.rationale !== "string")
        || one.criterion.length > VCR_ASSESSMENT_LIMITS.criterion || String(one.rationale ?? "").length > VCR_ASSESSMENT_LIMITS.criterion) {
        throw refuse("technicalCriteria", `holds sentences, or { criterion, rationale }, of at most ${VCR_ASSESSMENT_LIMITS.criterion} characters each.`);
      }
      return { criterion: one.criterion, rationale: String(one.rationale ?? "") };
    });
  }
  return edit;
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
 *   orchestrator?: any, jobs?: any, exporter?: any, members?: any, matching?: any, assessments?: any, dataPlane?: any,
 *   evidence?: any, evidenceStore?: any, corrections?: any, knowledge?: any, publications?: any }} dependencies
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
      get assessments() { return dependencies.assessments ?? service.packages?.matching ?? null; },
      // The data plane, reached through the service's seam (`intake`): the routes
      // are composed before the module is, and the seam is where the plane lives.
      get dataPlane() { return dependencies.dataPlane ?? service.packages?.dataPlane?.intake ?? null; },
      // The evidence side: what a card that cites the literature is checked against.
      get evidence() { return dependencies.evidence ?? service.packages?.evidence ?? null; },
      get evidenceStore() { return dependencies.evidenceStore ?? service.packages?.evidenceStore ?? null; },
      // The disease packs and the definition library.
      get knowledge() { return dependencies.knowledge ?? service.packages?.knowledge ?? null; },
      // The public 「模拟研究」 column's publish and withdraw (`vcrPublications.mjs`); null while the switch is off.
      get publications() { return dependencies.publications ?? null; },
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
     * The citations of an `external_evidence` card are ids of this study's
     * extractions that passed their check against the record they name, all of
     * one parameter (`verifiedEvidenceIds` — the same reader the runtime's write
     * uses). Refused `vcr_evidence_unverified`; a deployment without the
     * evidence side cannot verify, so it does not accept the claim. Answers the
     * cited ids, each once.
     * @param {any} study @param {unknown} ids @returns {Promise<string[]>}
     */
    const requireVerifiedEvidence = async (study, ids) => {
      const cited = Array.isArray(ids) && ids.length <= 20 ? [...new Set(ids.map(String))] : [];
      if (!cited.length || cited.some((cite) => !ID.test(cite))) {
        throw new HttpError(422, "vcr_evidence_unverified", "来源写成「外部证据」的卡要引用本研究通过原文核对的证据（evidenceIds，至少一条）；自己设的值请把来源写成专家设定。");
      }
      if (!hooks.evidence?.verifiedEvidenceIds || !hooks.evidenceStore?.verifiedItemsById) throw UNAVAILABLE();
      const rows = await hooks.evidenceStore.verifiedItemsById({ userId: study.userId, studyId: study.id, ids: cited });
      const parameters = [...new Set(rows.map((/** @type {any} */ row) => String(row.parameter)))];
      const verified = new Set(parameters.length === 1
        ? await hooks.evidence.verifiedEvidenceIds({ userId: study.userId, studyId: study.id, parameter: parameters[0] }) : []);
      const unverified = cited.filter((cite) => !verified.has(cite));
      if (unverified.length || parameters.length !== 1) {
        throw new HttpError(422, "vcr_evidence_unverified",
          `这些证据不是本研究通过原文核对的、同一参数的抽取值：${(unverified.length ? unverified : cited).slice(0, 5).join("、")}。`);
      }
      return cited;
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
    // The packs the account can use, and its library of population definitions: the account's, so no study is named.
    if (parts[0] === "packs" || parts[0] === "definitions") {
      if (method !== "GET" || parts.length > 2) throw new HttpError(404, "not_found", "虚拟临研 route not found.");
      const knowledge = hooks.knowledge;
      if (!knowledge) throw UNAVAILABLE();
      const query = String(url.searchParams.get("q") ?? "").slice(0, 200);
      if (parts[0] === "packs") return reply(parts.length === 1 ? await knowledge.listPacks(String(user.id), query) : await knowledge.getPack(String(user.id), parts[1]));
      return reply(parts.length === 1 ? await knowledge.listLibrary(String(user.id), query) : await knowledge.getLibraryDefinition(String(user.id), parts[1]));
    }
    if (parts[0] !== "studies") throw new HttpError(404, "not_found", "虚拟临研 route not found.");

    // --- the study list --------------------------------------------------------
    if (parts.length === 1) {
      if (method === "GET") return reply(await service.listStudies(user));
      if (method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["name", "question", "dataTier", "intendedUse", "action"]);
        const input = {
          name: body.name == null ? undefined : vcrStudyName(body.name),
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
        const body = await bodyOf(req, maxJsonBytes, ["name", "question", "action", "dataTier", "intendedUse", "status"]);
        const study = await service.requireStudy(user, id);
        const changesStudy = ["dataTier", "intendedUse", "status"].some((key) => body[key] !== undefined);
        if (changesStudy) await requireAbility(study, "manage_study");
        if (body.name !== undefined || body.question !== undefined || body.action !== undefined || !changesStudy) await requireAbility(study, "write");
        /** @type {Record<string, any>} */
        const patch = {};
        if (body.name !== undefined) patch.name = vcrStudyName(body.name);
        if (body.question !== undefined) patch.question = String(body.question).slice(0, QUESTION_MAX);
        // 起点 in the composer: which steps the programme is asked to run —
        // `auto` is all seven, an action is the one step it names (the same
        // mapping creation uses, `vcrRequestedSteps`).
        if (body.action !== undefined) patch.action = body.action === "auto" ? "auto" : word(body.action, VCR_ACTIONS, "vcr_action_invalid", "action");
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

    // --- the study's pack and the definitions of the account's library ------------------------
    if (section === "pack") {
      if (parts.length === 3 && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["use"]);
        if (typeof body.use !== "string" || !ID.test(body.use)) throw new HttpError(400, "vcr_payload_invalid", "use is the id of a pack.");
        const { study } = await authorize(id, "write");
        if (!hooks.knowledge) throw UNAVAILABLE();
        return reply(await audited("vcr.pack.bind", () => ({ code: id, detail: String(body.use) }), { code: id, detail: String(body.use) },
          () => hooks.knowledge.bindPack(study, body.use, String(user.id))));
      }
      if (parts.length === 4 && parts[3] === "promote" && method === "POST") {
        await bodyOf(req, maxJsonBytes, []);
        const study = await service.requireStudy(user, id);
        // The study's lead, or an operator who can see the study.
        if (!service.isOperator(user)) await requireAbility(study, "manage_study");
        else await rolesIn(study);
        if (!hooks.knowledge) throw UNAVAILABLE();
        return reply(await audited("vcr.pack.promote", () => ({ code: id, detail: "curated" }), { code: id },
          () => hooks.knowledge.promotePack(study, String(user.id))));
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }
    if (section === "definitions") {
      if (parts.length === 3 && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["populationId", "name", "text", "definitionId", "packEntries"]);
        if (typeof body.populationId !== "string" || !ID.test(body.populationId)) throw new HttpError(400, "vcr_payload_invalid", "populationId is the id of one of the study's populations.");
        if (body.definitionId != null && (typeof body.definitionId !== "string" || !ID.test(body.definitionId))) throw new HttpError(400, "vcr_payload_invalid", "definitionId is the id of a library definition.");
        if (body.packEntries != null && (!Array.isArray(body.packEntries) || body.packEntries.length > 100)) throw new HttpError(400, "vcr_payload_invalid", "packEntries is a list of { section, id }.");
        const { study } = await authorize(id, "write");
        if (!hooks.knowledge) throw UNAVAILABLE();
        const saved = await audited("vcr.definition.save", (result) => ({ code: String(result.definitionId), detail: `v${result.version}` }), { code: id },
          () => hooks.knowledge.saveFromStudy(study, body, String(user.id)));
        return reply(saved, 201);
      }
      if (parts.length === 5 && parts[4] === "use" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["version", "name", "columnMap", "snapshotId"]);
        if (body.version != null) wholeNumber(body.version, "version", 10_000);
        if (body.columnMap != null && (typeof body.columnMap !== "object" || Array.isArray(body.columnMap))) throw new HttpError(400, "vcr_payload_invalid", "columnMap is { column: replacement }.");
        if (body.snapshotId != null && (typeof body.snapshotId !== "string" || !ID.test(body.snapshotId))) throw new HttpError(400, "vcr_payload_invalid", "snapshotId is the id of a snapshot of this study.");
        const { study } = await authorize(id, "write");
        if (!hooks.knowledge) throw UNAVAILABLE();
        const used = await audited("vcr.definition.use", (result) => ({ code: String(result.definitionId), detail: `v${result.version}` }), { code: parts[3] },
          () => hooks.knowledge.useInStudy(study, { ...body, definitionId: parts[3] }, String(user.id)));
        return reply(used, 201);
      }
      if (parts.length === 5 && parts[4] === "compare" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["versionA", "versionB", "snapshotId", "covariates"]);
        wholeNumber(body.versionA, "versionA", 10_000);
        wholeNumber(body.versionB, "versionB", 10_000);
        if (body.snapshotId != null && (typeof body.snapshotId !== "string" || !ID.test(body.snapshotId))) throw new HttpError(400, "vcr_payload_invalid", "snapshotId is the id of a snapshot of this study.");
        if (body.covariates != null && (!Array.isArray(body.covariates) || body.covariates.length > 100 || body.covariates.some((/** @type {unknown} */ column) => typeof column !== "string"))) {
          throw new HttpError(400, "vcr_payload_invalid", "covariates is a list of column names.");
        }
        const { study } = await authorize(id, "run");
        if (!hooks.knowledge) throw UNAVAILABLE();
        const queued = await audited("vcr.definition.compare", (result) => ({ code: String(result.job?.id ?? ""), detail: parts[3] }), { code: parts[3] },
          () => hooks.knowledge.compareVersions(study, user, { ...body, definitionId: parts[3] }));
        return reply(queued, queued.created ? 201 : 200);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

    // --- data intake: source → files → field map → snapshot → tables → grants -------------
    if (section === "data" && parts.length > 3) {
      /** The plane, or the named refusal a deployment without one gets. */
      const plane = () => {
        const found = hooks.dataPlane;
        if (!found) throw new HttpError(503, "vcr_data_plane_not_configured", "本部署未接入数据平面，不能接入患者级数据。");
        return found;
      };
      const actor = String(user.id);
      const kind = parts[3];
      const S = { studyId: id, actor };

      if (kind === "sources" && parts.length === 4 && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["name", "ownerParty", "allowedUses", "visibleWindow", "retention", "valueSource"]);
        await authorize(id, "manage_data");
        const saved = await audited("vcr.data.source.register", (source) => ({ code: source.id, detail: String(body.name ?? "") }),
          { code: id, detail: String(body.name ?? "") },
          () => plane().registerSource({ userId: actor, studyId: id, name: body.name, ownerParty: body.ownerParty, allowedUses: body.allowedUses,
            visibleWindow: body.visibleWindow, retention: body.retention, valueSource: body.valueSource }));
        return reply({ source: sourceView(saved) }, 201);
      }

      if (kind === "sources" && parts.length === 6 && parts[5] === "files" && method === "POST") {
        try {
          await authorize(id, "manage_data");
          const named = url.searchParams.get("name") ?? "";
          if (!named || named.length > 200) throw new HttpError(400, "vcr_data_file_name_invalid", "name is the file's name, 1 to 200 characters.");
          const role = url.searchParams.get("role") ?? "data";
          const declared = Number(req.headers["content-length"]);
          const single = (/** @type {string} */ key, /** @type {number} */ max) => {
            const value = url.searchParams.get(key);
            if (value != null && value.length > max) throw new HttpError(400, "vcr_payload_invalid", `${key} is at most ${max} characters.`);
            return value;
          };
          // The audit line says what was uploaded — its role, format, size and hash —
          // and never its name: a chart's file name is the patient's, the plane
          // discards it, and audit rows outlive the study (`uploadAuditDetail`).
          const stored = await audited("vcr.data.file.upload", (result) => ({ code: String(result.file?.id ?? ""), detail: uploadAuditDetail(result) }),
            { code: id, detail: uploadAttemptAuditDetail(role, Number.isFinite(declared) ? declared : null) },
            () => plane().storeUpload({ ...S, sourceId: parts[4], name: named, role, stream: req,
              declaredLength: Number.isFinite(declared) ? declared : null, subject: single("subject", 120),
              visibleAt: single("visibleAt", 40), sheet: single("sheet", 120) }));
          return reply({ file: fileView(stored.file), created: stored.created }, stored.created ? 201 : 200);
        } catch (error) {
          // A refusal before the body was read: let the client finish sending, so
          // it reads the answer instead of a reset connection.
          req.resume();
          throw error;
        }
      }

      // A source held in FHIR, OMOP or ADaM: converted inside the deployment into the
      // module's own tables, a dictionary and a proposed field map (`importStandard`).
      if (kind === "sources" && parts.length === 6 && parts[5] === "imports" && method === "POST") {
        try {
          await authorize(id, "manage_data");
          const named = url.searchParams.get("name") ?? "";
          if (!named || named.length > 200) throw new HttpError(400, "vcr_data_file_name_invalid", "name is the file's name, 1 to 200 characters.");
          const format = url.searchParams.get("format") ?? "";
          const declared = Number(req.headers["content-length"]);
          const controller = new AbortController();
          res.once("close", () => { if (!res.writableEnded) controller.abort(); });
          // The audit line says the standard, the count of tables and the upload's hash, never its name.
          const imported = await audited("vcr.data.import", (result) => ({ code: parts[4], detail: importAuditDetail(result) }),
            { code: id, detail: importAttemptAuditDetail(format, Number.isFinite(declared) ? declared : null) },
            () => plane().importStandard({ ...S, sourceId: parts[4], name: named, format, stream: req,
              declaredLength: Number.isFinite(declared) ? declared : null, signal: controller.signal }));
          return reply({ ...imported, files: imported.files.map((file) => fileView(file)) }, 201);
        } catch (error) {
          req.resume();
          throw error;
        }
      }

      if (kind === "files" && parts.length === 5 && method === "DELETE") {
        await bodyOf(req, maxJsonBytes, []);
        await authorize(id, "manage_data");
        return reply(await audited("vcr.data.file.remove", (removed) => ({ code: String(removed.fileId), detail: id }), { code: parts[4], detail: id },
          () => plane().removeUpload({ ...S, fileId: parts[4] })));
      }

      if (kind === "sources" && parts.length === 6 && parts[5] === "fieldmap" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["columns", "reason"]);
        await authorize(id, "manage_data");
        const proposed = await audited("vcr.data.fieldmap.propose", (result) => ({ code: parts[4], detail: String(result.hash).slice(0, 12) }),
          { code: parts[4], detail: id },
          () => plane().proposeFieldMap({ ...S, sourceId: parts[4], columns: body.columns, reason: String(body.reason ?? "").slice(0, 300) }));
        return reply({ source: sourceView(proposed.source), hash: proposed.hash, entryIssues: proposed.entryIssues, mapIssues: proposed.mapIssues }, 201);
      }

      if (kind === "sources" && parts.length === 7 && parts[5] === "fieldmap" && parts[6] === "confirm" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["hash"]);
        if (typeof body.hash !== "string" || !/^[a-f0-9]{64}$/.test(body.hash)) {
          throw new HttpError(400, "vcr_payload_invalid", "hash is the field map's sha256, as it was shown.");
        }
        await authorize(id, "manage_data");
        const confirmed = await audited("vcr.data.fieldmap.confirm", () => ({ code: parts[4], detail: id }), { code: parts[4], detail: id },
          () => plane().confirmFieldMap({ ...S, sourceId: parts[4], hash: body.hash }));
        return reply({ source: sourceView(confirmed.source), checks: confirmed.checks });
      }

      if (kind === "sources" && parts.length === 6 && parts[5] === "snapshots" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["fileIds", "asOf"]);
        if (body.fileIds != null && (!Array.isArray(body.fileIds) || body.fileIds.length > 50 || body.fileIds.some((/** @type {unknown} */ item) => typeof item !== "string" || !ID.test(item)))) {
          throw new HttpError(400, "vcr_payload_invalid", "fileIds is up to 50 file ids.");
        }
        if (body.asOf != null && (typeof body.asOf !== "string" || body.asOf.length > 40)) throw new HttpError(400, "vcr_payload_invalid", "asOf is a date.");
        await authorize(id, "manage_data");
        const frozen = await audited("vcr.data.snapshot.freeze", (result) => ({ code: result.snapshot.id, detail: `v${result.snapshot.version}` }),
          { code: parts[4], detail: id },
          () => plane().freezeSnapshot({ userId: actor, studyId: id, sourceId: parts[4], fileIds: body.fileIds ?? null, asOf: body.asOf ?? null }));
        return reply({
          snapshot: snapshotView(frozen.snapshot),
          tables: frozen.tables ? {
            registered: frozen.tables.registered.map(tableView), refused: frozen.tables.refused, skipped: frozen.tables.skipped ?? [],
            subjects: frozen.tables.subjects ?? null, dropped: frozen.tables.dropped ?? {},
          } : null,
        }, 201);
      }

      if (kind === "snapshots" && parts.length === 6 && parts[5] === "tables" && method === "POST") {
        await bodyOf(req, maxJsonBytes, []);
        await authorize(id, "manage_data");
        const derived = await audited("vcr.data.tables.derive", (result) => ({ code: parts[4], detail: `${result.registered.length} tables` }),
          { code: parts[4], detail: id },
          () => plane().deriveAnalysisTables({ userId: actor, studyId: id, snapshotId: parts[4] }));
        return reply({ registered: derived.registered.map(tableView), refused: derived.refused, skipped: derived.skipped,
          subjects: derived.subjects, dropped: derived.dropped }, 201);
      }

      if (kind === "sources" && parts.length === 6 && parts[5] === "grants" && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["grantee", "role", "fields", "fieldMode", "windowStart", "windowEnd", "purposes"]);
        await authorize(id, "manage_data");
        const granted = await audited("vcr.data.grant.create", (grant) => ({ code: grant.id, detail: String(body.grantee ?? "") }),
          { code: parts[4], detail: id },
          () => plane().createGrant({ ...S, sourceId: parts[4], grantee: body.grantee, role: body.role, fields: body.fields, fieldMode: body.fieldMode,
            windowStart: body.windowStart, windowEnd: body.windowEnd, purposes: body.purposes }));
        return reply({ grant: granted }, 201);
      }

      if (kind === "grants" && parts.length === 6 && parts[5] === "revoke" && method === "POST") {
        await bodyOf(req, maxJsonBytes, []);
        await authorize(id, "manage_data");
        const revoked = await audited("vcr.data.grant.revoke", (grant) => ({ code: grant.id, detail: id }), { code: parts[4], detail: id },
          () => plane().revokeGrant({ ...S, grantId: parts[4] }));
        return reply({ grant: revoked });
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
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
        async () => {
          // A card that says its number is the literature's must cite what the
          // platform verified — the rule the runtime's write holds (a person
          // is no more entitled to an invented citation than a run is).
          const evidenceIds = body.sourceKind === "external_evidence" ? await requireVerifiedEvidence(study, body.evidenceIds) : body.evidenceIds;
          return data().saveAssumption({
            ...body, ...(evidenceIds === undefined ? {} : { evidenceIds }), key, studyId: study.id, userId: String(user.id), name: body.name ?? key,
            // A person editing a card is not the AI setting it: the review state
            // follows who wrote it (plan §10.2, AC-33).
            reviewState: "reviewed",
          });
        });
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

    // --- a model assessment record's next version, written by a person ----------------
    // The study's lead edits what a run wrote. The edit is the next version of the record under its key, by this person; the model
    // risk is derived again from the two ratings and never taken from the request; the frozen model analysis plan keeps the version
    // it was frozen with (the table refuses an update) and the next freeze lists this change. Only a record that exists is edited:
    // a new one is the run's to write.
    if (parts.length === 3 && method === "POST" && section === "model-assessments") {
      const body = await bodyOf(req, maxJsonBytes, ASSESSMENT_EDIT_FIELDS);
      const { study } = await authorize(id, VCR_ROUTE_ABILITIES["POST /studies/:id/model-assessments"]);
      const edit = assessmentEdit(body);
      const saved = await audited("vcr.model_assessment.edit", (version) => ({ code: version.id, detail: edit.key }), { code: id, detail: edit.key },
        async () => {
          const current = (await data().modelAssessments(study.id)).find((/** @type {any} */ record) => record.key === edit.key);
          if (!current) throw new HttpError(404, "vcr_model_assessment_not_found", "No assessment record has this key in this study.");
          return data().saveModelAssessment({ studyId: study.id, userId: study.userId, actor: String(user.id), record: { ...current, ...edit } });
        });
      return reply({ id: saved.id, key: saved.key, version: saved.version, risk: saved.risk, riskRule: saved.riskRule }, 201);
    }

    // --- a review countersignature ------------------------------------------------
    if (section === 'correction-cases') {
      const { study } = await authorize(id, 'export');
      const cases = service.packages?.corrections ?? dependencies.corrections;
      if (!cases) throw new HttpError(503, 'vcr_evaluation_input_unavailable', 'Correction replay is unavailable.');
      const identity = { studyId: study.id, principal: String(user.id) };
      if (parts.length === 3 && method === 'POST') {
        const body = await bodyOf(req, maxJsonBytes, ['after', 'limit']);
        return reply(await cases.exportDataset({ ...identity, after: body.after ?? '0', limit: body.limit ?? 100 }));
      }
      if (parts.length === 4 && method === 'GET') return reply(await cases.readDataset({ ...identity, datasetId: parts[3] }));
      if (parts.length === 5 && parts[4] === 'replay' && method === 'POST') {
        await bodyOf(req, maxJsonBytes, []);
        return reply(await cases.replay({ ...identity, datasetId: parts[3] }));
      }
      throw new HttpError(404, 'not_found', 'Correction-case route not found.');
    }

    if (parts.length === 3 && section === "curve-extractions" && ["GET", "POST"].includes(method)) {
      const { study } = await authorize(id, method === 'POST' ? 'write' : 'read');
      const curves = service.packages?.evidence?.curves ?? dependencies.evidence?.curves;
      if (!curves) throw new HttpError(503, 'vcr_curve_provenance_unavailable', 'Source-bound curve input is unavailable.');
      if (method === 'GET') return reply({ receipts: await curves.receipts({ studyId: study.id, principal: String(user.id) }) });
      const body = await bodyOf(req, maxJsonBytes, ['imageArtifactId', 'points']);
      const saved = await curves.recordSelection({ studyId: study.id, principal: String(user.id), imageArtifactId: body.imageArtifactId, points: body.points });
      return reply({ id: saved.id, origin: saved.origin, createdAt: saved.createdAt }, 201);
    }

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

    // --- 模拟研究: the lead publishes one of the study's reports to the public column --------------------
    if (section === "publications") {
      // Off is invisible: the module's own not-enabled answer, before the study is even looked up.
      if (!config.vcrPublicSimulationsEnabled || !hooks.publications) throw new HttpError(404, "vcr_publications_not_enabled", "模拟研究 is not enabled.");
      if (parts.length === 3 && method === "GET") {
        const { study } = await authorize(id, "read");
        return reply({ publications: await hooks.publications.forStudy(study.id) });
      }
      if (parts.length === 3 && method === "POST") {
        const body = await bodyOf(req, maxJsonBytes, ["exportId", "title", "summary"]);
        if (typeof body.exportId !== "string" || !ID.test(body.exportId)) throw new HttpError(400, "vcr_payload_invalid", "exportId is the id of one of the study's reports.");
        const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
        const summary = typeof body.summary === "string" ? body.summary.replace(/[ \t]+/g, " ").trim() : "";
        if (!title || [...title].length > VCR_PUBLICATION_LIMITS.title) throw new HttpError(400, "vcr_payload_invalid", `title is one line of 1 to ${VCR_PUBLICATION_LIMITS.title} characters.`);
        if ([...summary].length > VCR_PUBLICATION_LIMITS.summary) throw new HttpError(400, "vcr_payload_invalid", `summary is at most ${VCR_PUBLICATION_LIMITS.summary} characters.`);
        // The study's lead alone: publishing is the one act that makes a study's numbers public.
        const { study } = await authorize(id, "manage_study");
        const published = await audited("vcr.simulation.publish", (result) => ({ code: String(result.id), detail: String(result.exportKind) }),
          { code: id, detail: body.exportId }, () => hooks.publications.publish(user, study, { exportId: body.exportId, title, summary }));
        return reply(published, published.existing ? 200 : 201);
      }
      if (parts.length === 4 && method === "DELETE") {
        await bodyOf(req, maxJsonBytes, []);
        const { study } = await authorize(id, "manage_study");
        const withdrawn = await audited("vcr.simulation.withdraw", (result) => ({ code: String(result.id) }), { code: id, detail: parts[3] },
          () => hooks.publications.withdraw(user, study, parts[3]));
        return reply(withdrawn);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
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
    // --- a person's hand on a matching assessment ---------------------------------
    // Both are a person's acts and never a run's: a coordinator or clinician
    // re-judges one criterion (the platform's answer and the person's are both
    // kept), and a reviewer countersigns an assessment (a signature, not a gate).
    if (section === "assessments") {
      if (parts.length === 7 && parts[4] === "judgments" && parts[6] === "override" && method === "POST") {
        if (!ID.test(parts[3]) || !ID.test(parts[5])) throw new HttpError(400, "vcr_path_invalid", "Invalid assessment or criterion id.");
        const { study } = await authorize(id, VCR_ROUTE_ABILITIES["POST /studies/:id/assessments/:assessment/judgments/:criterion/override"]);
        const body = await bodyOf(req, maxJsonBytes, ["state", "note"]);
        const state = word(body.state, VCR_CRITERION_STATES, "vcr_criterion_state_invalid", "state");
        if (!hooks.assessments?.overrideJudgment) throw UNAVAILABLE();
        return reply(await audited("vcr.assessment.override", () => ({ code: parts[3], detail: `${parts[5]}:${state}` }), { code: parts[3] },
          () => hooks.assessments.overrideJudgment(user, study, {
            assessmentId: parts[3], criterionId: parts[5], state, note: body.note === undefined ? "" : String(body.note).slice(0, 1_000),
          })), 201);
      }
      if (parts.length === 5 && parts[4] === "review" && method === "POST") {
        if (!ID.test(parts[3])) throw new HttpError(400, "vcr_path_invalid", "Invalid assessment id.");
        await bodyOf(req, maxJsonBytes, []);
        const { study } = await authorize(id, VCR_ROUTE_ABILITIES["POST /studies/:id/assessments/:assessment/review"]);
        if (!hooks.assessments?.reviewAssessment) throw UNAVAILABLE();
        return reply(await audited("vcr.assessment.review", () => ({ code: parts[3] }), { code: parts[3] },
          () => hooks.assessments.reviewAssessment(user, study, { assessmentId: parts[3] })), 201);
      }
      throw new HttpError(404, "not_found", "虚拟临研 route not found.");
    }

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
