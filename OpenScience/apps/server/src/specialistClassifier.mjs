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

function classifierUrl(baseUrl, production = false) {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Specialist classifier provider URL is invalid.");
  }
  if (production && (url.origin !== "https://api.deepseek.com" || url.pathname !== "/")) {
    throw new Error("Production specialist classification must use the official DeepSeek API origin.");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url;
}

async function boundedJsonResponse(response, maximumBytes = 64 * 1024) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("Specialist classifier response is too large.");
  const text = await response.text();
  if (text.length > maximumBytes) throw new Error("Specialist classifier response is too large.");
  return JSON.parse(text);
}

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
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
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
   * @param {string} reason @param {{ failure?: string }} [trace]
   */
  declined(reason, trace) {
    if (trace) trace.failure = reason;
    this.lastFailure = reason;
    process.stderr.write(`specialist classifier produced no verdict: ${reason}\n`);
    return null;
  }

  /** @param {{ failure?: string }} [trace] */
  async classify(query, agents, trace) {
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
      const response = await this.fetchImpl(classifierUrl(this.config.deepseekBaseUrl, this.config.production), {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.deepseekApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.deepseekModel,
          stream: false,
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
        }),
        signal: controller.signal,
      });
      if (!response.ok) return this.declined(`http_${response.status}`, trace);
      const body = await boundedJsonResponse(response);
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
      if (parsed.agentId.toLowerCase() === "none") return null;
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
      return this.declined(error?.name === "AbortError" ? "timeout" : `error_${error?.code ?? "unknown"}`, trace);
    } finally {
      clearTimeout(timeout);
    }
  }
}
