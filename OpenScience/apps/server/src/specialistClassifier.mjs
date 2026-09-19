// LLM-based open-domain routing (item 10b), an OPTIONAL augmentation of the
// deterministic regex router in specialistRouting.mjs.
//
// Safety contract: this classifier never runs before the deterministic router
// and never overrides it. server.mjs consults it ONLY when the regex rules
// return null, so every clinical / high-risk-medicine / named-specialty match
// the regex already makes is preserved. The classifier can therefore only ADD
// routes the regex missed, never remove one — it cannot reduce safety coverage.
// It is also fully fail-safe: any disabled flag, missing key, timeout, bad
// response, low confidence, or unknown agent id resolves to null (open-domain),
// never an exception and never a blocked dispatch.
//
// It reaches the provider through `callModelForControlPlane`, metered as
// `routing`. It used to call api.deepseek.com with its own fetch, so every
// classification — one per unrouted question, on the dispatch path — was spent
// outside the usage ledger and outside the account's caps: the same second way
// out that memory extraction had until it was moved onto the gateway.
import { callModelForControlPlane } from "./modelGateway.mjs";

function parseClassifierJson(content) {
  if (typeof content !== "string") return null;
  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // reasoning_content is prose that happens to contain the verdict. Take the
    // last balanced object in it: the model states its answer at the end, and
    // an earlier brace may belong to something it was reasoning about.
    for (const match of [...raw.matchAll(/\{[^{}]*\}/g)].reverse()) {
      try {
        const candidate = JSON.parse(match[0]);
        if (candidate && typeof candidate === "object" && "agentId" in candidate) {
          parsed = candidate;
          break;
        }
      } catch { /* keep looking */ }
    }
    if (!parsed) return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const agentId = typeof parsed.agentId === "string" ? parsed.agentId.trim() : null;
  const confidence = Number(parsed.confidence);
  if (!agentId || !Number.isFinite(confidence)) return null;
  // "none" is an answer, not a missing one. Returning null for it made a model
  // that correctly declined indistinguishable from a model that never replied.
  return { agentId, confidence: Math.max(0, Math.min(1, confidence)) };
}

const classifierInstructions = [
  "You route an open-domain biomedical research request to at most one specialist agent.",
  "Choose only from the supplied specialists by their exact id. If none clearly fits, or the message is generic conversation, small talk, or a non-research request, return agentId \"none\".",
  "Every specialist in the catalog produces a heavy deliverable (a report, analysis package, or evaluation). Route only when the user actually wants that deliverable — a plain clinical or scientific QUESTION (mechanism, efficacy, safety, definition, dosing) stays open-domain even when it mentions a drug, disease, or symptom.",
  "In particular, choose a clinical evidence synthesis agent only when the user explicitly asks for a report, systematic review, or deep evidence analysis.",
  // Topic words are the wrong signal, and they are the loudest one. Six real
  // requests for a clinical evidence review were routed away from it because
  // they mentioned what the review would have to discuss: briefs that said
  // "existing meta-analyses report..." went to the meta-analysis pipeline,
  // briefs asking whether an adverse reaction is attributable went to
  // pharmacovigilance, and a brief mentioning a dataset went to dataset
  // scoping. Each produced a deliverable nobody asked for.
  "Decide by the DELIVERABLE the request commissions, never by the topics it mentions. A request that asks you to appraise what published meta-analyses show is a literature appraisal, not a request to run a new meta-analysis. A request that asks whether a reported adverse reaction can be attributed to a drug is an evidence question, not a request for a disproportionality signal analysis. Mentioning a data source is not the same as supplying one.",
  "Refuse any specialist whose requiredInputs the request does not actually supply. A specialist that requires a dataset must not be chosen when the user has described data rather than provided it; a specialist that requires a defined PICO must not be chosen when the request is an open appraisal question.",
  "The starterPrompts show what a request that belongs to a specialist looks like. If the request does not resemble any of them in KIND — not in vocabulary — that specialist is the wrong one.",
  "Never invent an id. Prefer \"none\" over a weak guess.",
  "Return JSON only: {\"agentId\": \"<id or none>\", \"confidence\": <0..1>}. Confidence is your calibrated probability that this specialist is the correct handler.",
].join(" ");

export class SpecialistClassifier {
  /**
   * @param {Record<string, any>} config
   * @param {{ fetchImpl?: typeof fetch, usageLedger?: any }} [options]
   */
  constructor(config, { fetchImpl = globalThis.fetch, usageLedger = null } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.usageLedger = usageLedger;
    this.enabled = config?.llmRoutingEnabled === true;
    const threshold = Number(config?.llmRoutingConfidenceThreshold);
    this.threshold = Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : 0.75;
    this.timeoutMs = Math.max(1_000, Math.min(120_000, Number(config?.modelGatewayTimeoutMs ?? 30_000)));
  }

  get available() {
    return this.enabled && this.config?.deepseekProviderEnabled === true && Boolean(this.config?.deepseekApiKey);
  }

  /**
   * A classification that never happened, as opposed to one that concluded
   * "no specialist". Both send the turn to the answer line, but only this one
   * means the fallback is not working — and for six of six live calls it was
   * not, silently, because the token budget cut the verdict off.
   *
   * Which is why the reason now leaves this method. It used to go to stderr and
   * to `lastFailure`, a field nothing reads; the ledger recorded the same route
   * reason either way, so after a batch there was no telling which runs were
   * answered on the open-domain line because they belonged there and which were
   * sent there by a timeout. `trace` is per-call because a batch runs
   * concurrently, and a field on the shared classifier would attribute one
   * request's timeout to another's question.
   * @param {string} reason @param {{ failure?: string, verdict?: string }} [trace]
   */
  declined(reason, trace) {
    if (trace) trace.failure = reason;
    this.lastFailure = reason;
    process.stderr.write(`specialist classifier produced no verdict: ${reason}\n`);
    return null;
  }

  /**
   * @param {{ failure?: string, verdict?: string }} [trace]
   * @param {{ userId: string, projectId: string } | null} [owner] the account and
   *   project the question belongs to, which the classification is charged to
   */
  async classify(query, agents, trace, owner = null) {
    if (!this.available) return null;
    if (typeof query !== "string" || !query.trim()) return null;
    if (!Array.isArray(agents) || agents.length === 0) return null;
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    // The catalog was an id, a title, and a third of a description — enough to
    // match a topic and not enough to tell one deliverable from another. What
    // separates these agents is what they produce, what a request that belongs
    // to them looks like, and what they need supplied before they can run.
    const catalog = agents.map((agent) => ({
      id: agent.id,
      title: typeof agent.title === "string" ? agent.title : agent.id,
      produces: typeof agent.description === "string" ? agent.description : "",
      requiredInputs: Array.isArray(agent.requiredInputs) ? agent.requiredInputs : [],
      requestsThatBelongHere: Array.isArray(agent.starterPrompts) ? agent.starterPrompts.slice(0, 4) : [],
    }));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = await callModelForControlPlane({
        config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl,
      }, {
        userId: owner?.userId ?? "",
        projectId: owner?.projectId ?? "",
        purpose: "routing",
        signal: controller.signal,
        body: {
          model: this.config.deepseekModel,
          temperature: 0,
          // A reasoning model spends its budget thinking before it writes.
          // At 200 it spent all of it: measured against the live API, six of
          // six classifications came back with an empty content and 900–1000
          // characters of reasoning_content — the verdict never got written.
          // The fallback that exists to catch what the regex misses was
          // therefore dead, and every miss fell to the answer line looking
          // exactly like "no specialist fits". At 2000 the same six returned a
          // verdict every time — on the flash model. Certifying the pro model
          // put the deployment back where it started: production logged
          // "produced no verdict: empty_content" and every route fell through
          // to the regex net, which is the arrangement this was moved away
          // from. A budget tuned against one model is not a budget; the ceiling
          // has to leave room for the reasoning the model actually does, and a
          // classification is a few dozen tokens of output whatever precedes it.
          max_tokens: 8_000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: classifierInstructions },
            { role: "user", content: JSON.stringify({ query: query.slice(0, 4_000), specialists: catalog }) },
          ],
        },
      });
      // Read the verdict wherever the model put it. A reasoning model that
      // runs its budget close still often carries the JSON in
      // reasoning_content, and a classification we already paid for should not
      // be discarded over which field it arrived in.
      const message = body?.choices?.[0]?.message;
      const parsed = parseClassifierJson(message?.content) ?? parseClassifierJson(message?.reasoning_content);
      // No verdict at all is a broken classifier; "none" and a low-confidence
      // guess are verdicts. Only the first is worth reporting, and it used to
      // be indistinguishable from the other two.
      if (!parsed) return this.declined(message?.content?.trim() ? "unparseable" : "empty_content", trace);
      // An affirmative "no specialist fits" is a decision, and the caller has to
      // be able to tell it from a classification that never happened: the regex
      // net is a safety net under an ABSENT decision, and it was overriding this
      // one. Only the explicit `none` is recorded — a low-confidence guess or an
      // invented id is a verdict the caller should still let the net back up.
      if (parsed.agentId.toLowerCase() === "none") {
        if (trace) trace.verdict = "none";
        return null;
      }
      const agent = byId.get(parsed.agentId);
      if (!agent) return null;
      if (parsed.confidence < this.threshold) return null;
      return Object.freeze({
        agentId: agent.id,
        agentVersion: agent.version,
        runtimeAgent: agent.runtimeAgent,
        reason: `llm:${parsed.confidence.toFixed(2)}`,
        confidence: parsed.confidence,
      });
    } catch (error) {
      return this.declined(error?.name === "AbortError" ? "timeout"
        : error?.code === "model_gateway_upstream_error" ? `http_${error.upstreamStatus ?? error.status}`
          : `error_${error?.code ?? "unknown"}`, trace);
    } finally {
      clearTimeout(timeout);
    }
  }
}
