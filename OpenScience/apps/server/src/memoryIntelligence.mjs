import { createHash } from "node:crypto";
import { HttpError } from "./security.mjs";

const candidateKinds = new Set([
  "profile",
  "preference",
  "behavior",
  "project_fact",
  "analysis",
  "decision",
  "correction",
  "follow_up",
]);
const candidateScopes = new Set(["user", "project", "session"]);
const candidateOrigins = new Set(["explicit", "inferred", "system"]);
const memoryKeyPattern = /^[a-z0-9][a-z0-9._/-]{0,254}$/;
const sensitivePattern = /(?:password|passcode|api[ _-]?key|access[ _-]?token|secret|\btoken\b|密码|口令|密钥|令牌|身份证|手机号|银行卡|病历号|患者姓名|家庭住址|我(?:患有|诊断为|正在服用))/i;

function boundedText(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function boundedScore(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content.trim();
  if (!Array.isArray(message?.parts)) return "";
  return message.parts
    .filter((part) => part?.type === "text" && part.synthetic !== true && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function conversationMemorySources(messages, sessionId) {
  if (!Array.isArray(messages)) return [];
  const sources = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = message?.info?.role ?? message?.role;
    if (!["user", "assistant"].includes(role)) continue;
    const text = messageText(message);
    if (!text) continue;
    const rawId = message?.info?.id ?? message?.id ?? String(index + 1);
    const safeId = String(rawId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || String(index + 1);
    sources.push({
      sourceRef: `sessions/${sessionId}/messages/${safeId}`,
      role,
      text: text.slice(0, 12_000),
    });
  }
  return sources.slice(-12);
}

function extractionUrl(baseUrl, production = false) {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Memory extraction provider URL is invalid.");
  }
  if (production && (url.origin !== "https://api.deepseek.com" || url.pathname !== "/")) {
    throw new Error("Production memory extraction must use the official DeepSeek API origin.");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url;
}

async function boundedJsonResponse(response, maximumBytes = 512 * 1024) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("Memory extraction response is too large.");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error("Memory extraction response is too large.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

function parseModelJson(content) {
  const raw = boundedText(content, 100_000).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!raw) return { candidates: [] };
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && Array.isArray(parsed.candidates) ? parsed : { candidates: [] };
}

function candidateScopeId(candidate, project, run) {
  if (candidate.scope === "project") return project.id;
  if (candidate.scope === "session") return run.sessionId;
  return "";
}

function validateCandidate(candidate, sourceMap, project, run) {
  if (!candidate || typeof candidate !== "object") return null;
  const kind = boundedText(candidate.kind, 64).toLowerCase();
  const scope = boundedText(candidate.scope, 32).toLowerCase();
  const origin = boundedText(candidate.origin, 32).toLowerCase();
  const key = boundedText(candidate.key, 255).toLowerCase();
  const value = boundedText(candidate.value, 100_000);
  const summary = boundedText(candidate.summary, 2_000);
  const sourceRef = boundedText(candidate.sourceRef, 500);
  const quote = boundedText(candidate.evidenceQuote, 4_000);
  const source = sourceMap.get(sourceRef);
  if (!candidateKinds.has(kind) || !candidateScopes.has(scope) || !candidateOrigins.has(origin)) return null;
  if (!memoryKeyPattern.test(key) || !value || !source || !quote || !source.text.includes(quote)) return null;
  if (["profile", "preference", "behavior"].includes(kind) && (scope !== "user" || source.role !== "user")) return null;
  if (["explicit", "inferred"].includes(origin) && source.role !== "user") return null;
  if (origin === "system" && source.role !== "assistant") return null;
  const sensitive = Boolean(candidate.sensitive) || sensitivePattern.test(`${value}\n${summary}\n${quote}`);
  return {
    scope,
    scopeId: candidateScopeId({ scope }, project, run),
    kind,
    key,
    value,
    summary,
    origin,
    status: sensitive || origin === "inferred" ? "pending" : "active",
    confidence: boundedScore(candidate.confidence, origin === "explicit" ? 1 : 0.65),
    importance: boundedScore(candidate.importance, 0.6),
    sensitive,
    lastConfirmedAt: origin === "explicit" ? new Date().toISOString() : null,
    evidence: {
      sourceType: "conversation_message",
      sourceRef,
      quote,
      observedAt: new Date().toISOString(),
      weight: source.role === "user" ? 1 : 0.8,
    },
  };
}

function deterministicCandidates(sources, project, run) {
  const candidates = [];
  for (const source of sources.filter((item) => item.role === "user")) {
    if (!/(?:请记住|记住|以后请|我的偏好|我偏好|我习惯|长期保持)/.test(source.text)) continue;
    const quote = source.text.slice(0, 4_000);
    const kind = /(?:偏好|希望|以后|回答|输出|格式|习惯)/.test(quote)
      ? "preference"
      : /(?:数据|分析|样本|参数|单位|筛选|口径)/.test(quote)
        ? "analysis"
        : /(?:项目|研究|课题)/.test(quote)
          ? "project_fact"
          : "profile";
    const scope = ["analysis", "project_fact"].includes(kind) ? "project" : "user";
    const digest = createHash("sha256").update(quote.normalize("NFKC").toLowerCase()).digest("hex").slice(0, 16);
    candidates.push(validateCandidate({
      scope,
      kind,
      key: `${kind}.explicit.${digest}`,
      value: quote,
      summary: quote.slice(0, 240),
      origin: "explicit",
      confidence: 1,
      importance: 0.75,
      sensitive: sensitivePattern.test(quote),
      sourceRef: source.sourceRef,
      evidenceQuote: quote,
    }, new Map(sources.map((item) => [item.sourceRef, item])), project, run));
  }
  return candidates.filter(Boolean).slice(0, 4);
}

function canonicalKey(record) {
  return [record.scope, record.scopeId ?? "", record.kind, record.key].join("\u0000");
}

export class MemoryIntelligence {
  constructor(config, memosClient, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.memosClient = memosClient;
    this.fetchImpl = fetchImpl;
    this.enabled = config.memoryExtractionEnabled !== false;
    this.timeoutMs = Math.max(1_000, Math.min(120_000, Number(config.memoryExtractionTimeoutMs ?? 30_000)));
  }

  async recordRun(project, run, messages = []) {
    const sources = conversationMemorySources(messages, run.sessionId);
    const runSummary = await this.#recordRunSummary(project, run, sources);
    if (sources.length === 0) return { runSummary, extracted: 0, activated: 0, source: "none" };

    let candidates = [];
    let source = "deterministic";
    if (this.enabled && this.config.deepseekProviderEnabled && this.config.deepseekApiKey) {
      try {
        candidates = await this.#extractWithModel(sources, project, run);
        source = "model";
      } catch {
        candidates = deterministicCandidates(sources, project, run);
      }
    } else {
      candidates = deterministicCandidates(sources, project, run);
    }

    const existing = await this.memosClient.listRecords(project.userId, { pageSize: 100 });
    const known = new Map(existing.map((record) => [canonicalKey(record), record]));
    let extracted = 0;
    let activated = 0;
    for (const candidate of candidates.slice(0, 12)) {
      const previous = known.get(canonicalKey(candidate));
      if (previous?.status === "active" && candidate.origin === "inferred" && !candidate.sensitive) {
        candidate.status = "active";
      }
      let stored;
      try {
        stored = await this.memosClient.upsertRecord(project.userId, {
          ...candidate,
          ...(previous ? { id: previous.id } : {}),
        }, candidate.evidence, {
          expectedVersion: previous?.version ?? 0,
          reason: previous ? "conversation evidence updated the current memory" : "conversation evidence created the memory",
        });
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== "memory_conflict") throw error;
        const refreshed = await this.memosClient.listRecords(project.userId, { query: candidate.key, pageSize: 100 });
        const current = refreshed.find((record) => canonicalKey(record) === canonicalKey(candidate));
        if (!current) throw error;
        stored = await this.memosClient.upsertRecord(project.userId, { ...candidate, id: current.id }, candidate.evidence, {
          expectedVersion: current.version,
          reason: "conversation evidence retried after a concurrent memory update",
        });
      }
      extracted += 1;
      if (
        stored.origin === "inferred"
        && stored.status === "pending"
        && !stored.sensitive
        && stored.evidenceCount >= 3
        && stored.revisions.length === 0
      ) {
        stored = await this.memosClient.upsertRecord(project.userId, { ...stored, status: "active" }, null, {
          expectedVersion: stored.version,
          reason: "three independent observations activated an inferred memory",
        });
        activated += 1;
      }
      known.set(canonicalKey(stored), stored);
    }
    return { runSummary, extracted, activated, source };
  }

  async #recordRunSummary(project, run, sources) {
    const lastUser = [...sources].reverse().find((source) => source.role === "user") ?? null;
    const lastAssistant = [...sources].reverse().find((source) => source.role === "assistant") ?? null;
    const question = lastUser?.text.slice(0, 4_000) ?? "";
    const answer = lastAssistant?.text.slice(0, 8_000) ?? "";
    const sensitive = sensitivePattern.test(`${question}\n${answer}`);
    const value = JSON.stringify({
      runId: run.id,
      projectId: project.id,
      sessionId: run.sessionId,
      mode: run.mode,
      agentId: run.agentId,
      agentVersion: run.agentVersion,
      effectiveAgentId: run.effectiveAgentId,
      effectiveAgentVersion: run.effectiveAgentVersion,
      effectiveRuntimeAgent: run.effectiveRuntimeAgent,
      model: run.model,
      status: run.status,
      errorCode: run.errorCode,
      artifacts: run.artifacts,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      question,
      answer,
    });
    return this.memosClient.upsertRecord(project.userId, {
      scope: "project",
      scopeId: project.id,
      kind: "run_summary",
      key: `run.${run.id}`.toLowerCase(),
      value,
      summary: question
        ? `Conversation about: ${question.slice(0, 240)}`
        : `Run ${run.id} finished with status ${run.status}; ${run.artifacts.length} artifact(s) recorded.`,
      origin: "system",
      status: sensitive ? "pending" : "active",
      confidence: 1,
      importance: run.status === "succeeded" ? 0.55 : 0.7,
      sensitive,
      lastConfirmedAt: run.finishedAt,
    }, {
      sourceType: lastUser ? "conversation_message" : "agent_run",
      sourceRef: lastUser?.sourceRef ?? `runs/${run.id}`,
      quote: question || `Run ${run.id} finished with status ${run.status}.`,
      observedAt: run.finishedAt,
      weight: 1,
    }, { reason: "agent run reached a terminal state" });
  }

  async #extractWithModel(sources, project, run) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(extractionUrl(this.config.deepseekBaseUrl, this.config.production), {
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
          max_tokens: 2_400,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [
                "Extract durable memory candidates from the supplied conversation sources.",
                "Return JSON only: {\"candidates\":[...]}. Maximum 12 candidates.",
                "Each candidate must contain scope, kind, key, value, summary, origin, confidence, importance, sensitive, sourceRef, evidenceQuote.",
                "Allowed scopes: user, project, session. Allowed kinds: profile, preference, behavior, project_fact, analysis, decision, correction, follow_up.",
                "Allowed origins: explicit, inferred, system. Use system only for assistant-grounded analysis, decisions, follow-ups, or corrections.",
                "evidenceQuote must be a short exact substring of the referenced source. Do not infer identity, health, beliefs, demographics, or preferences without direct evidence.",
                "Store durable facts and compact analytical essentials: dataset or artifact reference, population/filter, parameter, unit, method, result, decision, and unresolved follow-up.",
                "Do not store greetings, transient requests, chain-of-thought, secrets, full documents, or unsupported conclusions. Use stable lowercase dotted keys.",
              ].join(" "),
            },
            {
              role: "user",
              content: JSON.stringify({ projectId: project.id, sessionId: run.sessionId, sources }),
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Memory extraction provider rejected the request.");
      const body = await boundedJsonResponse(response);
      const parsed = parseModelJson(body?.choices?.[0]?.message?.content);
      const sourceMap = new Map(sources.map((item) => [item.sourceRef, item]));
      return parsed.candidates.map((candidate) => validateCandidate(candidate, sourceMap, project, run)).filter(Boolean);
    } finally {
      clearTimeout(timeout);
    }
  }
}
