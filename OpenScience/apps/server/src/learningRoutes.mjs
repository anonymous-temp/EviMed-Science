import { createHash } from "node:crypto";
import { cleanMethodDisplay, methodScientific, methodSourceChanges, mountedMethodDigest, parseSkillFrontmatter, promotionVerdict, successfulFamilies } from "@evimed/domain";
import { conversationSources } from "./learningSources.mjs";
import { bodyVersionOf, effectiveStatusReason, methodRecordFrom, methodScopeOf, methodStepsOf } from "./learningService.mjs";
import { HttpError, readJson, sendJson } from "./security.mjs";

/**
 * What a researcher can see and undo about the methods the system learned.
 *
 * Hidden knowledge: there is deliberately no route that approves anything. The
 * first design of this loop had a seven-state lifecycle behind six endpoints
 * with a release review, and that is an approval queue — the one thing the
 * spec's own rule forbids, because a queue turns every learned method into work
 * for the person it was supposed to help. Promotion happens in the nightly job,
 * against evidence that is on the record, and the researcher hears about it
 * afterwards.
 *
 * What is here instead is the other half of that bargain, and it has to exist
 * or the bargain is a bluff:
 *
 *  - **See it.** Every method, its status, and — for one still waiting — the
 *    exact list of what it is missing, in the same words `promotionVerdict`
 *    produces. "The system is not learning" and "it has two of the three run
 *    families it needs" look identical without this.
 *  - **Stop it.** Retire, immediately, no reason required.
 *  - **Undo it.** Restore any earlier revision.
 *  - **Say it.** Write a method themselves, which takes effect at once.
 *
 * That last one is not an approval in disguise; it is the reason the absence of
 * an approval is not a gap. Everything the loop infers has to survive a paired
 * evaluation, and until this route existed the only authors were distillation
 * runs — so the one source of methods the research says actually works, a
 * person writing down how they work, had no way in at all. It is a POST that
 * carries a session, and `createCandidate` decides what it is worth by the same
 * rule the nightly job uses; nothing here asserts a status.
 *
 * @module learningRoutes
 */

/** @param {any} req @param {number} limit @param {string[]} allowed */
async function bodyOf(req, limit, allowed) {
  const value = await readJson(req, limit);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "method_payload_invalid", "Method request contains unsupported fields.");
  }
  return value;
}

/**
 * The view a person reads. The body is included because a method is text a
 * researcher is entitled to read before deciding whether to keep it; the
 * learning counters are included because they are the argument for keeping it.
 * @param {any} document
 * @returns {any}
 */
export function methodView(document) {
  const payload = document.payload ?? {};
  const verdict = promotionVerdict(methodRecordFrom(document));
  const status = payload.status ?? "candidate";
  return {
    id: document.id,
    // Where it was learnt. The record is the account's (`createCandidate`),
    // so this is the provenance's project, never a storage column — which is
    // null for every method since 2026-09-27.
    projectId: payload.provenance?.sourceProjectId ?? document.projectId ?? null,
    // The optimistic-concurrency token. It moves on every write, counters
    // included, so it is never a version number a person reads: that is
    // `version`.
    revision: document.revision,
    // Which body this is, counting from 1: what 「第 N 版」 means.
    version: bodyVersionOf(payload),
    // When the body last changed; `updatedAt` also moves on a status change.
    bodyUpdatedAt: payload.bodyUpdatedAt ?? document.createdAt ?? null,
    name: payload.frontmatter?.name ?? "",
    description: payload.frontmatter?.description ?? "",
    whenToUse: payload.frontmatter?.whenToUse ?? "",
    // What the researcher reads: the method's own name and description are
    // written for the model (`cleanMethodDisplay`). Null until a distillation
    // or a consolidation pass has written one.
    title: cleanMethodDisplay(payload.display)?.title ?? null,
    summary: cleanMethodDisplay(payload.display)?.summary ?? null,
    // The steps in the researcher's language, when they render the body the
    // method holds now; `body` is the SKILL.md written for the model.
    steps: methodStepsOf(payload),
    role: payload.frontmatter?.metadata?.role ?? "functional",
    status,
    // A retired method keeps the reason it was stopped with; any other reads
    // its standing from the record, never from a sentence an older path
    // stored (`effectiveStatusReason`).
    statusReason: status === "retired" ? payload.statusReason ?? null : effectiveStatusReason(payload),
    // When it started being used: what the row reads 「新」 from, and what
    // 「9月18日起生效」 says. Absent on a method written before it was stamped.
    statusChangedAt: payload.statusChangedAt ?? null,
    // How many separate successful deliveries it was distilled from — the
    // checkable half of 「从你的 3 次研究学到」. Counted from the observations
    // themselves, never asserted by whatever wrote the method.
    trajectories: successfulFamilies(payload.learning ?? {}).length,
    contentDigest: payload.contentDigest ?? "",
    mountedDigest: mountedMethodDigest(payload, (text) => createHash("sha256").update(text).digest("hex")),
    origin: payload.provenance?.origin ?? "inferred",
    derivedFrom: payload.frontmatter?.metadata?.derived_from ?? "",
    dependsOn: payload.frontmatter?.metadata?.depends_on ?? "",
    counts: payload.learning?.counts ?? null,
    // What later became of the results produced under the body it holds now (N14): a second axis beside `counts`, which
    // are about deliveries. What it says is association; `causalBenefit` is always `unproven` and `applicability`
    // `unknown` until the engine's own diagnostics say otherwise.
    scientific: methodScientific(payload.scientific, payload.contentDigest),
    // A source a result it was learnt from or used for rests on has changed (N15): a label beside the method, never a verdict on it.
    sourceChanges: methodSourceChanges(payload.sourceChanges),
    // The situation it is for and the ones it must not be loaded into, as declared when it was learnt.
    scope: methodScopeOf(payload),
    // The result versions it was learnt from, and what was left when it was returned to an earlier body or stopped.
    learntFrom: payload.provenance?.results ?? [],
    links: payload.links ?? [],
    level: payload.learning?.level ?? 0,
    relations: payload.learning?.relations ?? [],
    evaluations: payload.learning?.evaluations ?? [],
    // The two lists a person actually needs: why it is effective, or what it is
    // still waiting for. Never a bare "pending".
    promotion: { status: verdict.status, reasons: verdict.reasons, missing: verdict.missing, missingDetails: verdict.missingDetails },
    body: payload.body ?? "",
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

/**
 * `summary` is the loop's own counts for this account (`learningMetrics.mjs`
 * `learningSummary`): read-only, beside the list, and absent rather than an
 * error when it cannot be read — the list is what the page needs.
 * `resolveRun` finds the run a lesson was learnt from, live or preserved (`resolveLessonSourceRun`): what 「从哪里学到的」 lists is
 * read through it and absent when it is not given.
 * @param {{store: any, service: any, maxJsonBytes: number, evaluationUsers?: readonly string[], trialTtlMs?: number,
 *   summary?: ((userId: string) => Promise<any>) | null,
 *   resolveRun?: ((userId: string, projectId: string, runId: string) => Promise<any>) | null}} dependencies */
export function createLearningRoutes({ store, service, maxJsonBytes, evaluationUsers = [], trialTtlMs = 6 * 60 * 60 * 1000, summary = null, resolveRun = null }) {
  const evaluators = new Set((evaluationUsers ?? []).map((value) => String(value)));
  /** @param {any} req @param {any} res */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/methods" && !url.pathname.startsWith("/api/methods/")) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "method_store_unavailable", "Method storage is unavailable.");
    let parts;
    try { parts = url.pathname.slice("/api/methods".length).split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "method_path_invalid", "Invalid method path."); }
    const method = req.method ?? "GET";
    /** @param {any} data */
    const reply = (data) => { sendJson(res, 200, { data }); return true; };

    if (parts.length === 0 && method === "GET") {
      const status = url.searchParams.get("status");
      const page = await service.listMethods(user.id, {
        ...(status ? { status } : {}),
        ...(url.searchParams.has("projectId") ? { projectId: url.searchParams.get("projectId") } : {}),
        limit: Number(url.searchParams.get("limit") ?? 50),
        cursor: url.searchParams.get("cursor"),
      });
      // Whether the loop is turning for this account (build spec §13): one
      // read beside the list, on the first page only.
      const counts = summary && !url.searchParams.get("cursor") ? await summary(user.id).catch(() => null) : null;
      return reply({ items: (page.items ?? []).map(methodView), nextCursor: page.nextCursor ?? null, ...(counts ? { summary: counts } : {}) });
    }
    // Before the by-id branch: a method id is authored text, so `trial` has to
    // be claimed as a literal here or `GET /api/methods/trial` reads as a
    // lookup of a method named "trial" and answers 404 forever.
    if (parts.length === 1 && parts[0] === "trial") {
      const projectId = url.searchParams.get("projectId") ?? (method === "PUT" ? undefined : "");
      if (method === "GET") {
        return reply(await service.methodTrial(user.id, String(projectId ?? "")));
      }
      // Writing a trial mounts text no gate has admitted into a real container.
      // The allowlist is the whole access rule -- no new role, no approval
      // queue -- and it is empty by default, so a deployment that has not
      // opted in answers 403 to everyone including its own operator.
      if (!evaluators.has(String(user.id))) {
        throw new HttpError(403, "method_trial_forbidden", "Only an evaluation identity may put a method on trial.");
      }
      if (method === "PUT") {
        const body = await bodyOf(req, maxJsonBytes, ["projectId", "methodIds", "ttlMs"]);
        if (!Array.isArray(body.methodIds)) {
          throw new HttpError(400, "method_trial_invalid", "methodIds must be an array of method ids.");
        }
        return reply(await service.setMethodTrial(user.id, {
          projectId: String(body.projectId ?? ""),
          methodIds: body.methodIds,
          requestedBy: String(user.id),
          ttlMs: Number.isSafeInteger(body.ttlMs) && Number(body.ttlMs) > 0 ? Number(body.ttlMs) : trialTtlMs,
        }));
      }
      if (method === "DELETE") {
        return reply({ cleared: await service.clearMethodTrial(user.id, String(projectId ?? "")) });
      }
      throw new HttpError(405, "method_not_allowed", "Trial supports GET, PUT and DELETE.");
    }
    if (parts.length === 1 && method === "GET") {
      return reply(methodView(await service.getMethod(user.id, parts[0])));
    }
    // 「历史版本」: the bodies the method has held, newest first — never a
    // counter write or a status change of the same text.
    if (parts.length === 2 && parts[1] === "history" && method === "GET") {
      return reply({ items: await service.history(user.id, parts[0]) });
    }
    // 「从哪里学到的」: the conversations that taught it, as links; empty when none can be found.
    if (parts.length === 2 && parts[1] === "sources" && method === "GET") {
      return reply({ items: await conversationSources({ resolveRun }, user.id, await service.sourceRuns(user.id, parts[0])) });
    }
    if (parts.length === 0 && method === "POST") {
      // The whole SKILL.md, parsed by the parser the distillation path uses.
      // A route with its own idea of the format would be a second grammar to
      // keep in step with the validator, and the one that drifts is always the
      // one with fewer readers.
      const body = await bodyOf(req, maxJsonBytes, ["projectId", "skill"]);
      const parsed = parseSkillFrontmatter(String(body.skill ?? ""));
      if (parsed.issues.length) {
        throw new HttpError(422, "method_payload_invalid", parsed.issues.slice(0, 3).map((issue) => issue.message).join(" "));
      }
      const created = await service.createCandidate(user.id, {
        projectId: body.projectId === undefined ? null : body.projectId,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        provenance: { origin: "explicit" },
      });
      sendJson(res, 201, { data: methodView(created) });
      return true;
    }
    if (parts.length === 2 && parts[1] === "retire" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["expectedRevision", "reason"]);
      return reply(methodView(await service.retire(user.id, parts[0], body)));
    }
    if (parts.length === 2 && parts[1] === "rollback" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["expectedRevision", "targetRevision"]);
      return reply(methodView(await service.rollback(user.id, parts[0], body)));
    }
    throw new HttpError(404, "not_found", "Method route not found.");
  };
}
