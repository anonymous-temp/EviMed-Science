import { randomBytes } from "node:crypto";

import { isInternalProject } from "./internalProjects.mjs";
import { HttpError, assertObject, readJson, sendJson } from "./security.mjs";

/**
 * 「转为深度研究」: a quick answer's question, the sources it already found and
 * the premises it assumed, handed to a new research conversation.
 *
 * The fusion plan's §9.5: 「外壳把问题、已找到的来源、适用前提交给 Science 新建一个研究
 * 对话，在对话 frame 里打开，首条消息带「来自 AI 搜索」卡片」. The shell that calls this
 * is EviMed's Vue application; the answer page it hands off from is EviMed's
 * own AI search.
 *
 * Hidden knowledge, and why this is small: a new conversation already has one
 * path, and this takes it rather than growing a second one. A conversation is
 * a research-session binding made before the kernel exists (the same
 * `research-sessions` binding the capability cards make), opened in the frame
 * by a `create` intent that carries a draft, and started when the person sends
 * it through `POST /api/agent-runs/dispatch` — the one prompt path, with its
 * routing, spend limits and 灵豆 checks. So this route binds a new session in
 * the chosen project and composes the first message; the caller opens the
 * frame on it with the draft, and the person's send is what starts a run that
 * takes tens of minutes. Nothing here dispatches, and nothing here is stored
 * but the binding.
 *
 * The 「来自 AI 搜索」 card is the message itself: the question, then a quoted
 * block naming what it is, the premises, and each source with its identifiers
 * and the sentence that supported the answer. It reads as a card wherever the
 * conversation renders Markdown and as plain text where it does not, and a
 * card the kernel's own renderer had to learn would be a frame change for
 * every host.
 *
 * Off by default (`OPEN_SCIENCE_RESEARCH_HANDOFF_ENABLED`), and named when off.
 *
 * @module researchHandoff
 */

export const RESEARCH_HANDOFF_PATH = "/api/research/handoffs";

/** The bounds of what one hand-off carries. */
export const RESEARCH_HANDOFF_LIMITS = Object.freeze({
  question: 4_000, sources: 20, title: 300, url: 2_000, quote: 500, premises: 10, premise: 100,
});

/** The fields a request may carry, at each level. A contract test holds the
 *  documented contract (docs/WEB_DEPLOYMENT.md) to them. */
export const RESEARCH_HANDOFF_FIELDS = Object.freeze({
  request: Object.freeze(["projectId", "question", "sources", "premises", "capabilityId"]),
  source: Object.freeze(["title", "url", "doi", "pmid", "quote"]),
});

const DOI = /^10\.\d{4,9}\/[^\s]{1,200}$/;
const PMID = /^\d{1,9}$/;

/** @param {unknown} value @param {string} field @param {number} max @param {boolean} [required] */
function text(value, field, max, required = true) {
  if (value == null && !required) return null;
  const clean = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!clean || [...clean].length > max || [...clean].some((character) => character.charCodeAt(0) < 32)) {
    throw new HttpError(400, "research_handoff_invalid", `${field} must be 1–${max} characters.`);
  }
  return clean;
}

/** @param {any} body @param {readonly string[]} allowed @param {string} field */
function only(body, allowed, field) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "research_handoff_invalid", `${field} must be an object.`);
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new HttpError(400, "research_handoff_invalid", `${field} carries unsupported field(s): ${unknown.sort().join(", ")}.`);
  return body;
}

/**
 * The request, checked field by field.
 * @param {any} body
 */
export function readHandoff(body) {
  const input = only(body, RESEARCH_HANDOFF_FIELDS.request, "The request");
  const sources = input.sources ?? [];
  if (!Array.isArray(sources) || sources.length > RESEARCH_HANDOFF_LIMITS.sources) {
    throw new HttpError(400, "research_handoff_invalid", `sources must be a list of at most ${RESEARCH_HANDOFF_LIMITS.sources}.`);
  }
  const premises = input.premises ?? [];
  if (!Array.isArray(premises) || premises.length > RESEARCH_HANDOFF_LIMITS.premises) {
    throw new HttpError(400, "research_handoff_invalid", `premises must be a list of at most ${RESEARCH_HANDOFF_LIMITS.premises}.`);
  }
  return {
    projectId: input.projectId == null ? null : text(input.projectId, "projectId", 64),
    question: text(input.question, "question", RESEARCH_HANDOFF_LIMITS.question),
    capabilityId: input.capabilityId == null ? null : text(input.capabilityId, "capabilityId", 64),
    premises: premises.map((premise, index) => text(premise, `premises[${index}]`, RESEARCH_HANDOFF_LIMITS.premise)),
    sources: sources.map((raw, index) => {
      const source = only(raw, RESEARCH_HANDOFF_FIELDS.source, `sources[${index}]`);
      const url = text(source.url, `sources[${index}].url`, RESEARCH_HANDOFF_LIMITS.url, false);
      if (url !== null) {
        let parsed;
        try { parsed = new URL(url); } catch { parsed = null; }
        if (!parsed || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new HttpError(400, "research_handoff_invalid", `sources[${index}].url must be an http(s) address without credentials.`);
        }
      }
      const doi = text(source.doi, `sources[${index}].doi`, 220, false);
      if (doi !== null && !DOI.test(doi)) throw new HttpError(400, "research_handoff_invalid", `sources[${index}].doi is not a DOI.`);
      const pmid = source.pmid == null ? null : String(source.pmid).trim();
      if (pmid !== null && !PMID.test(pmid)) throw new HttpError(400, "research_handoff_invalid", `sources[${index}].pmid is not a PMID.`);
      return {
        title: text(source.title, `sources[${index}].title`, RESEARCH_HANDOFF_LIMITS.title),
        url, doi, pmid,
        quote: text(source.quote, `sources[${index}].quote`, RESEARCH_HANDOFF_LIMITS.quote, false),
      };
    }),
  };
}

/**
 * The first message: the question, then the 「来自 AI 搜索」 card.
 * @param {ReturnType<typeof readHandoff>} handoff
 */
export function handoffMessage({ question, premises, sources }) {
  if (premises.length === 0 && sources.length === 0) return question;
  const card = ["**来自 AI 搜索**"];
  if (premises.length) card.push("", `适用前提：${premises.join(" · ")}`);
  if (sources.length) {
    card.push("", "已找到的来源：");
    sources.forEach((source, index) => {
      const identifiers = [source.doi && `DOI ${source.doi}`, source.pmid && `PMID ${source.pmid}`, source.url].filter(Boolean);
      card.push(`${index + 1}. ${source.title}${identifiers.length ? `（${identifiers.join(" · ")}）` : ""}`);
      if (source.quote) card.push(`   「${source.quote}」`);
    });
  }
  return `${question}\n\n${card.map((line) => (line ? `> ${line}` : ">")).join("\n")}`;
}

/**
 * @param {{ config: any, store: any, researchSessions: any, agentRegistry: any,
 *   context: (req: any, res: any) => Promise<any>,
 *   audit?: ((ctx: any, action: string, status: string, details?: any) => Promise<void>) | null }} dependencies
 * @returns {(req: any, res: any) => Promise<boolean>}
 */
export function createResearchHandoffRoutes({ config, store, researchSessions, agentRegistry, context, audit = null }) {
  const enabled = config.researchHandoffEnabled === true;
  return async function researchHandoffRoutes(req, res) {
    const pathname = new URL(req.url ?? "/", "http://evimed.local").pathname;
    if (pathname !== RESEARCH_HANDOFF_PATH) return false;
    if (!enabled) throw new HttpError(503, "research_handoff_disabled", "Handing a question to deep research is not enabled in this deployment.");
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "A hand-off is created with POST.");
    const ctx = await context(req, res);
    const handoff = readHandoff(assertObject(await readJson(req, Math.min(config.maxJsonBytes ?? 1_048_576, 256 * 1024)), "research hand-off"));
    // The person's chosen project, or the one the request is in. Theirs, and
    // never one of the platform's own background projects.
    const project = handoff.projectId ? await store.requireProject(ctx.user, handoff.projectId) : ctx.project;
    if (isInternalProject(project.id)) throw new HttpError(404, "project_not_found", "Project not found.");
    /** @type {{ mode: "open-domain" } | { mode: "specialist", agentId: string, agentVersion: string }} */
    let binding = { mode: "open-domain" };
    if (handoff.capabilityId) {
      const agent = (await agentRegistry).get(handoff.capabilityId);
      if (!agent || agent.visibility === "internal") {
        throw new HttpError(400, "research_handoff_capability_invalid", "capabilityId names no capability this deployment offers.");
      }
      binding = { mode: "specialist", agentId: agent.id, agentVersion: agent.version };
    }
    const sessionId = `handoff-${randomBytes(12).toString("hex")}`;
    await researchSessions.put(project, sessionId, binding);
    const draft = handoffMessage(handoff);
    if (audit) await audit(ctx, "research.handoff.create", "completed", { target: sessionId, projectId: project.id, sources: handoff.sources.length });
    sendJson(res, 201, { data: {
      projectId: project.id,
      sessionId,
      draft,
      binding: binding.mode === "specialist" ? { mode: binding.mode, capabilityId: binding.agentId } : { mode: binding.mode },
      card: { title: "来自 AI 搜索", premises: handoff.premises, sources: handoff.sources },
    } });
    return true;
  };
}
