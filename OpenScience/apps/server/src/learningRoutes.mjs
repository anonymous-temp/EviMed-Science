import { parseSkillFrontmatter, promotionVerdict } from "@evimed/domain";
import { methodRecordFrom } from "./learningService.mjs";
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
  return {
    id: document.id,
    projectId: document.projectId,
    revision: document.revision,
    name: payload.frontmatter?.name ?? "",
    description: payload.frontmatter?.description ?? "",
    whenToUse: payload.frontmatter?.whenToUse ?? "",
    role: payload.frontmatter?.metadata?.role ?? "functional",
    status: payload.status ?? "candidate",
    statusReason: payload.statusReason ?? null,
    contentDigest: payload.contentDigest ?? "",
    origin: payload.provenance?.origin ?? "inferred",
    derivedFrom: payload.frontmatter?.metadata?.derived_from ?? "",
    dependsOn: payload.frontmatter?.metadata?.depends_on ?? "",
    counts: payload.learning?.counts ?? null,
    level: payload.learning?.level ?? 0,
    relations: payload.learning?.relations ?? [],
    evaluations: payload.learning?.evaluations ?? [],
    // The two lists a person actually needs: why it is effective, or what it is
    // still waiting for. Never a bare "pending".
    promotion: { status: verdict.status, reasons: verdict.reasons, missing: verdict.missing },
    body: payload.body ?? "",
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

/** @param {{store: any, service: any, maxJsonBytes: number}} dependencies */
export function createLearningRoutes({ store, service, maxJsonBytes }) {
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
      return reply({ items: (page.items ?? []).map(methodView), nextCursor: page.nextCursor ?? null });
    }
    if (parts.length === 1 && method === "GET") {
      return reply(methodView(await service.getMethod(user.id, parts[0])));
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
