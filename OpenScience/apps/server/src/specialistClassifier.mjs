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
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const agentId = typeof parsed.agentId === "string" ? parsed.agentId.trim() : null;
  const confidence = Number(parsed.confidence);
  if (!agentId || agentId.toLowerCase() === "none" || !Number.isFinite(confidence)) return null;
  return { agentId, confidence: Math.max(0, Math.min(1, confidence)) };
}

const classifierInstructions = [
  "You route an open-domain biomedical research request to at most one specialist agent.",
  "Choose only from the supplied specialists by their exact id. If none clearly fits, or the message is generic conversation, small talk, or a non-research request, return agentId \"none\".",
  "Every specialist in the catalog produces a heavy deliverable (a report, analysis package, or evaluation). Route only when the user actually wants that deliverable — a plain clinical or scientific QUESTION (mechanism, efficacy, safety, definition, dosing) stays open-domain even when it mentions a drug, disease, or symptom.",
  "In particular, choose a clinical evidence synthesis agent only when the user explicitly asks for a report, systematic review, or deep evidence analysis.",
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

  async classify(query, agents) {
    if (!this.available) return null;
    if (typeof query !== "string" || !query.trim()) return null;
    if (!Array.isArray(agents) || agents.length === 0) return null;
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const catalog = agents.map((agent) => ({
      id: agent.id,
      title: typeof agent.title === "string" ? agent.title : agent.id,
      description: typeof agent.description === "string" ? agent.description.slice(0, 300) : "",
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
          max_tokens: 200,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: classifierInstructions },
            { role: "user", content: JSON.stringify({ query: query.slice(0, 4_000), specialists: catalog }) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const body = await boundedJsonResponse(response);
      const parsed = parseClassifierJson(body?.choices?.[0]?.message?.content);
      if (!parsed) return null;
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
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
