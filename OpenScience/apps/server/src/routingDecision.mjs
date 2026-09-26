import { capabilityTitle } from "@evimed/domain";
import { runEstimate } from "./runRoute.mjs";
import { HttpError, assertObject, assertString, readJson, sendJson } from "./security.mjs";
import {
  OPEN_DOMAIN_ANSWER_AGENT_ID,
  routeNamedSpecialist,
  routeOpenDomainSpecialist,
} from "./specialistRouting.mjs";

/**
 * What one question would do, told to the shell before it sends it.
 *
 * The fusion plan gives EviMed and this platform one composer with two speeds
 * (§3.2 「一个输入框，两种速度」): a question is either answered in seconds by
 * EviMed's own AI search, or it commissions a research package that takes
 * minutes to hours and writes files. §9.5 asks this platform to publish the
 * judgement it already makes — 「对外提供一个判断接口：返回「快速回答 / 深度研究
 * + 哪个工具 + 预计时长与灵豆」」 — so the composer can show one line
 * (「会做深度研究 · 约 40 分钟 · 约 120 灵豆 · 改为快速回答」) and send on the
 * first click.
 *
 * Hidden knowledge, and the reason this file is short:
 *
 * - **It is advice, and it is not a gate.** It decides nothing, refuses
 *   nothing, and records nothing. A caller may ignore the answer and dispatch
 *   whatever it likes; `POST /api/agent-runs/dispatch` accepts a `line` that
 *   overrides the router outright, which is exactly what the composer's
 *   「改为快速回答」 sends. Principles 2, 12 and 13: enforcement binds outputs,
 *   a plain question gets a zero-tool answer, and nothing about the shape of a
 *   question may hold it up.
 * - **There is no second classification path.** It calls the same two
 *   functions in the same order the dispatch does — `routeNamedSpecialist`, the
 *   `SpecialistClassifier`, then `routeOpenDomainSpecialist` as the net — so a
 *   prediction that disagreed with the dispatch would be a bug in one of them
 *   rather than a difference of opinion between two routers. Not one regex here
 *   (principles 2 and 5); widening the router's open-vocabulary matching to
 *   make a preview prettier is the failure mode that list already carries scars
 *   from.
 * - **The model is optional and failing means `quick`.** `consultModel` is on
 *   by default because the dispatch consults the classifier first and a
 *   preview that skipped it would under-predict `deep` on every question the
 *   regex net misses. A caller that wants a free, instant answer while the user
 *   is still typing passes `consultModel: false` and gets the deterministic
 *   half. Either way, a classifier that is disabled, unconfigured, slow, broken
 *   or unsure lands on the net, and a net that claims nothing lands on `quick`
 *   — never on an error, and never on a guess.
 * - **`quick` carries no estimate.** A quick answer is EviMed's own line
 *   (§9.5 「沿用 EviMed AI 搜索的流式接口」); its seconds and its price belong
 *   to the engine that runs it, and quoting this platform's answer-line minutes
 *   for it would be a number about the wrong system.
 * - **Credits are a seam, not a table here.** `estimateCredits` is injected —
 *   `EvimedCreditsService.estimate` in a deployment that has 灵豆 switched on
 *   (§9.6 unified metering) — and this module holds no copy of the price list.
 *   Absent, refused or malformed, `credits` is `null` and the composer shows
 *   the duration alone: a preview is not worth failing a question over.
 *
 * @module routingDecision
 */

/** The one path this module answers. */
export const ROUTING_DECISION_PATH = "/api/routing/decision";

/** How the decision was reached, for a caller that logs or measures. */
export const ROUTING_DECIDED_BY = Object.freeze(["named", "model", "rules", "default"]);

/**
 * A duration range in the reader's words — minutes, one unit, like the plan's
 * own example (「约 40 分钟」). The structured `minutes` travels beside this
 * line, so a shell that would rather write hours can.
 * @param {{ min: number, max: number } | null} minutes @returns {string | null}
 */
function durationText(minutes) {
  if (!minutes) return null;
  return minutes.min === minutes.max ? `约 ${minutes.min} 分钟` : `约 ${minutes.min}–${minutes.max} 分钟`;
}

/** @param {{ min: number, max: number } | null} credits @returns {string | null} */
function creditsText(credits) {
  if (!credits) return null;
  return credits.min === credits.max ? `约 ${credits.min} 灵豆` : `约 ${credits.min}–${credits.max} 灵豆`;
}

/**
 * A range as the wire carries one, or null. `{ min, max }` like `minutes`, or
 * the credits service's own `{ low, high }` — read rather than adapted at the
 * call site, so wiring the estimator straight through cannot silently produce
 * a blank price. Anything that is not a range is refused rather than passed on
 * half-filled.
 * @param {unknown} value @returns {{ min: number, max: number } | null}
 */
function range(value) {
  if (!value || typeof value !== "object") return null;
  const pair = /** @type {Record<string, any>} */ (value);
  const min = Number(pair.min ?? pair.low);
  const max = Number(pair.max ?? pair.high);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return null;
  return { min: Math.round(min), max: Math.round(max) };
}

/**
 * What the composer shows under the input box: the speed, the capability, the
 * duration and the price, in that order, whichever of them are known. The
 * 「改为快速回答」 half of the plan's example is a button the shell owns, not
 * text from here.
 * @param {'quick' | 'deep'} mode @param {string | null} title
 * @param {{ min: number, max: number } | null} minutes @param {{ min: number, max: number } | null} credits
 * @returns {string}
 */
function summaryText(mode, title, minutes, credits) {
  if (mode === "quick") return "快速回答 · 几秒内出结果";
  return ["会做深度研究", title, durationText(minutes), creditsText(credits)].filter(Boolean).join(" · ");
}

/**
 * Which line a question would take, and what it would cost.
 *
 * @param {{
 *   question: string,
 *   agents: any[],
 *   classifier?: { available?: boolean, classify: Function } | null,
 *   owner?: { userId: string, projectId: string } | null,
 *   consultModel?: boolean,
 *   estimateCredits?: ((input: { mode: 'deep', capabilityId: string, minutes: { min: number, max: number } | null }) => any) | null,
 * }} input
 * @returns {Promise<{
 *   mode: 'quick' | 'deep',
 *   capability: { id: string, title: string | null } | null,
 *   minutes: { min: number, max: number } | null,
 *   credits: { min: number, max: number } | null,
 *   summary: string,
 *   decidedBy: 'named' | 'model' | 'rules' | 'default',
 *   modelConsulted: boolean,
 * }>}
 */
export async function decideRouting({
  question, agents, classifier = null, owner = null, consultModel = true, estimateCredits = null,
}) {
  const routable = (Array.isArray(agents) ? agents : []).filter((agent) => agent?.id !== OPEN_DOMAIN_ANSWER_AGENT_ID);
  // The dispatch's own order (server.mjs): naming a package is an instruction,
  // the model decides what the question commissions, and the regex rules are
  // the net under an absent decision — never over one.
  let specialist = routeNamedSpecialist(question, routable);
  /** @type {'named' | 'model' | 'rules' | 'default'} */
  let decidedBy = specialist ? "named" : "default";
  /** @type {{ failure?: string, verdict?: string }} */
  const trace = {};
  let modelConsulted = false;
  if (!specialist && consultModel && classifier?.available === true) {
    modelConsulted = true;
    try {
      specialist = await classifier.classify(question, routable, trace, owner);
    } catch (error) {
      // The classifier's own contract is that it resolves to null rather than
      // throwing, and it records why in `trace`. This is the case that contract
      // does not cover, and it is named rather than swallowed (principle 19):
      // the net still gets its turn, and the caller is told the model was not
      // the one that decided.
      trace.failure = `error_${error?.code ?? "unknown"}`;
      process.stderr.write(`routing decision: the classifier threw (${trace.failure})\n`);
    }
    if (specialist) decidedBy = "model";
  }
  if (!specialist) {
    specialist = routeOpenDomainSpecialist(question, routable, { afterCleanNone: trace.verdict === "none" });
    if (specialist) decidedBy = "rules";
  }
  const capability = specialist ? routable.find((agent) => agent.id === specialist?.agentId) ?? null : null;
  if (!capability) {
    // No capability claimed it, so it is a question rather than a commission:
    // the composer sends it to the quick line and nobody waits for a file.
    return {
      mode: "quick", capability: null, minutes: null, credits: null,
      summary: summaryText("quick", null, null, null), decidedBy: "default", modelConsulted,
    };
  }
  // The dispatch's own estimate (`runEstimate`), so the line shown before the
  // send and the one recorded on the run cannot disagree. Note that a
  // capability declares two numbers — its manifest's `estimatedMinutes` and the
  // larger `display.estimatedMinutes` the 科研工具 catalogue shows — and the
  // registry carries only the first; this takes whichever the dispatch takes.
  const minutes = runEstimate(capability);
  const title = capabilityTitle(capability.id);
  let credits = null;
  if (typeof estimateCredits === "function") {
    try {
      credits = range(await estimateCredits({ mode: "deep", capabilityId: capability.id, minutes }));
    } catch (error) {
      // The price is the optional half of the line. A settlement service that
      // is down must cost the reader the 灵豆 figure, never the prediction —
      // and it is named rather than swallowed (principle 19).
      process.stderr.write(`routing decision: no credits estimate (${error?.code ?? error?.message ?? "unknown"})\n`);
    }
  }
  return {
    mode: "deep",
    capability: { id: capability.id, title },
    minutes,
    credits,
    summary: summaryText("deep", title, minutes, credits),
    decidedBy,
    modelConsulted,
  };
}

/**
 * `POST /api/routing/decision` — `{ question, consultModel? }` in, the decision
 * out. Authenticated like every other browser route; the question is charged to
 * the caller's own account and selected project when the model is consulted, so
 * the classification a preview pays for is metered exactly as a dispatch's is.
 *
 * @param {{
 *   config: any,
 *   context: (req: any, res: any) => Promise<any>,
 *   agentRegistry: Promise<any> | any,
 *   classifier: any,
 *   estimateCredits?: ((input: any) => any) | null,
 * }} dependencies
 * @returns {(req: any, res: any) => Promise<boolean>}
 */
export function createRoutingDecisionRoutes({ config, context, agentRegistry, classifier, estimateCredits = null }) {
  return async function routingDecisionRoutes(req, res) {
    const pathname = new URL(req.url ?? "/", "http://evimed.local").pathname;
    if (pathname !== ROUTING_DECISION_PATH) return false;
    if (req.method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "Use POST to ask what a question would do.");
    }
    const ctx = await context(req, res);
    const body = assertObject(await readJson(req, config.maxJsonBytes), "routing decision");
    const unknown = Object.keys(body).filter((field) => !["question", "consultModel"].includes(field));
    if (unknown.length > 0) {
      throw new HttpError(400, "invalid_payload", `Unknown routing decision field(s): ${unknown.sort().join(", ")}.`);
    }
    const question = assertString(body.question, "question", { max: config.maxJsonBytes });
    if (!question.trim()) throw new HttpError(400, "invalid_payload", "question must not be empty.");
    if (body.consultModel != null && typeof body.consultModel !== "boolean") {
      throw new HttpError(400, "invalid_payload", "consultModel must be a boolean.");
    }
    const registry = await agentRegistry;
    const data = await decideRouting({
      question,
      agents: registry.list(),
      classifier,
      owner: { userId: ctx.project.userId ?? ctx.user.id, projectId: ctx.project.id },
      consultModel: body.consultModel !== false,
      estimateCredits,
    });
    sendJson(res, 200, { data });
    return true;
  };
}
