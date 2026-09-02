import { createHash } from "node:crypto";
import { mcpToolBaseName } from "@evimed/domain";
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

/**
 * Why a record is parked as `pending` instead of activated — or null when it is
 * not parked at all.
 *
 * `pending` is not a refusal: the record is stored with its evidence, it is
 * simply not recalled into a later prompt until a person confirms it. Nothing
 * said so, though. `sensitivePattern` above includes 病历号 and 患者姓名, which
 * are ordinary words in medical research text, so a researcher's own memories
 * were parked routinely — and from the outside that is indistinguishable from
 * an extractor that found nothing: memory "not learning", with no reason
 * anywhere. This function is that reason, and it is the only thing added.
 *
 * Demotion itself stays exactly as it was, deliberately. `sensitive` marks text
 * that may carry an identifier or a credential, and recalling such text into a
 * later prompt without a person having seen it is the one mistake a memory
 * store cannot take back. `inferred` is the model's own guess, which earns
 * activation from three independent observations (see recordRun) rather than
 * from one. Naming a rule is not softening it.
 *
 * The status expression below is derived from this function rather than written
 * beside it, so "which records are demoted" and "what we say about it" cannot
 * drift apart: they are one predicate.
 *
 * @param {boolean} sensitive @param {string} origin @returns {string|null}
 */
function demotionReason(sensitive, origin) {
  if (sensitive && origin === "inferred") return "sensitive_and_inferred";
  if (sensitive) return "sensitive";
  if (origin === "inferred") return "inferred";
  return null;
}

/** What each reason means, for the person reading the run. */
const demotionReasonText = Object.freeze({
  sensitive: "内容命中敏感词表（含病历号、患者姓名等医学研究中的常用词），需本人确认后才会被再次调用",
  inferred: "由模型推断而非你明确要求记住，需累积三次独立观察或本人确认后才会转为生效",
  sensitive_and_inferred: "既由模型推断，又命中敏感词表，需本人确认后才会被再次调用",
});

/** The audit ledger reads English, like every other revision reason here. */
const demotionReasonAudit = Object.freeze({
  sensitive: "parked as pending: the text matched the sensitive-vocabulary screen",
  inferred: "parked as pending: inferred by the model, not stated by the user",
  sensitive_and_inferred: "parked as pending: inferred by the model and matched the sensitive-vocabulary screen",
});

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

// Tools whose result is durable research knowledge rather than a transient
// lookup: a search strategy that worked, a resolved term, a computed estimate.
// Reconstructing these from the assistant's prose loses the numbers; this is
// the one place they exist exactly as produced.
//
// Matched against the base name, never against `part.tool` directly: the same
// tool call reaches this function under any of four spellings depending on the
// kernel and on when the history was recorded (`mcpToolBaseName`'s own doc
// comment names all four), and a pattern anchored to one literal prefix quietly
// stops matching the day that prefix changes — which is exactly what happened
// here when the MCP server's published names were un-prefixed and this pattern
// was not updated with them.
const KNOWLEDGE_TOOL_PATTERN = /^(?:.*search|.*normalize|.*analysis|meta_analysis|mendelian_randomization|adr_signal_analysis|evidence_deduplicate|.*evaluation|open_access_full_text)$/;

function toolMemorySources(message, sessionId, messageId) {
  const sources = [];
  for (const [index, part] of (message?.parts ?? []).entries()) {
    if (part?.type !== "tool" || typeof part.tool !== "string") continue;
    const baseName = mcpToolBaseName(part.tool);
    if (!baseName || !KNOWLEDGE_TOOL_PATTERN.test(baseName)) continue;
    if (part?.state?.status !== "completed") continue;
    let result = null;
    try {
      const output = part?.state?.output;
      result = typeof output === "string" && output.trim().startsWith("{") ? JSON.parse(output) : null;
    } catch {
      continue;
    }
    if (!result || result.status === "error") continue;
    // Carry the call and its outcome, not the whole payload: the record has to
    // stay quotable, and a full result set is neither durable nor legible.
    const text = [
      `tool: ${part.tool}`,
      `arguments: ${JSON.stringify(part?.state?.input ?? {}).slice(0, 1_200)}`,
      `summary: ${String(result.summary ?? "").slice(0, 1_200)}`,
      `data: ${JSON.stringify(result.data ?? {}).slice(0, 4_000)}`,
    ].join("\n");
    sources.push({
      sourceRef: `sessions/${sessionId}/messages/${messageId}/tools/${index}`,
      role: "tool",
      text,
    });
  }
  return sources;
}

export function conversationMemorySources(messages, sessionId) {
  if (!Array.isArray(messages)) return [];
  const sources = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = message?.info?.role ?? message?.role;
    if (!["user", "assistant"].includes(role)) continue;
    const rawId = message?.info?.id ?? message?.id ?? String(index + 1);
    const safeId = String(rawId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || String(index + 1);
    const text = messageText(message);
    if (text) {
      sources.push({
        sourceRef: `sessions/${sessionId}/messages/${safeId}`,
        role,
        text: text.slice(0, 12_000),
      });
    }
    sources.push(...toolMemorySources(message, sessionId, safeId));
  }
  return sources.slice(-20);
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

function validateCandidate(candidate, sourceMap, project, run, rejections = null) {
  const reject = (reason) => {
    if (rejections) rejections.push(reason);
    return null;
  };
  if (!candidate || typeof candidate !== "object") return reject("not an object");
  const kind = boundedText(candidate.kind, 64).toLowerCase();
  const scope = boundedText(candidate.scope, 32).toLowerCase();
  const origin = boundedText(candidate.origin, 32).toLowerCase();
  const key = boundedText(candidate.key, 255).toLowerCase();
  const value = boundedText(candidate.value, 100_000);
  const summary = boundedText(candidate.summary, 2_000);
  const sourceRef = boundedText(candidate.sourceRef, 500);
  const quote = boundedText(candidate.evidenceQuote, 4_000);
  const source = sourceMap.get(sourceRef);
  if (!candidateKinds.has(kind)) return reject(`unknown kind "${kind}"`);
  if (!candidateScopes.has(scope)) return reject(`unknown scope "${scope}"`);
  if (!candidateOrigins.has(origin)) return reject(`unknown origin "${origin}"`);
  if (!memoryKeyPattern.test(key)) return reject(`malformed key "${key}"`);
  if (!value) return reject(`empty value for "${key}"`);
  if (!source) return reject(`sourceRef "${sourceRef}" matches no supplied source`);
  if (!quote) return reject(`no evidence quote for "${key}"`);
  // The most common rejection by far: the model paraphrases instead of copying,
  // so the quote is true but not verbatim.
  if (!source.text.includes(quote)) return reject(`evidence quote for "${key}" is not verbatim in ${sourceRef}`);
  if (["profile", "preference", "behavior"].includes(kind) && (scope !== "user" || source.role !== "user")) {
    return reject(`${kind} must be user-scoped and cite a user message (got scope "${scope}", role "${source.role}")`);
  }
  if (["explicit", "inferred"].includes(origin) && source.role !== "user") {
    return reject(`origin "${origin}" must cite a user message (got role "${source.role}")`);
  }
  // A tool result is machine-grounded, which is exactly what system origin
  // means. It is also the only place a computed estimate or a search strategy
  // exists verbatim, so it must be allowed to ground a memory.
  if (origin === "system" && !["assistant", "tool"].includes(source.role)) {
    return reject(`origin "system" must cite an assistant or tool source (got role "${source.role}")`);
  }
  const sensitive = Boolean(candidate.sensitive) || sensitivePattern.test(`${value}\n${summary}\n${quote}`);
  const pendingReason = demotionReason(sensitive, origin);
  return {
    scope,
    scopeId: candidateScopeId({ scope }, project, run),
    kind,
    key,
    value,
    summary,
    origin,
    status: pendingReason ? "pending" : "active",
    // Carried on the candidate, not sent as a record field: the memory service
    // has a fixed record schema and would drop it. It travels to the audit
    // ledger as the upsert reason, and to the user as a run notice.
    statusReason: pendingReason,
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
    // Extraction is a short structured-output task, not a reasoning one, and it
    // runs after the reply is already delivered. Flash answers it in about half
    // the time the pro model takes.
    this.model = String(config.memoryExtractionModel || config.deepseekModel || "");
    this.runSummaryTtlMs = Math.max(0, Number(config.memoryRunSummaryTtlDays ?? 90)) * 24 * 60 * 60 * 1_000;
  }

  async recordRun(project, run, messages = []) {
    const sources = conversationMemorySources(messages, run.sessionId);
    const runSummary = await this.#recordRunSummary(project, run, sources);
    if (sources.length === 0) {
      return {
        runSummary, extracted: 0, activated: 0, source: "none", proposed: 0, rejected: 0,
        rejectionReasons: [], pending: 0, pendingReasons: [], extractionError: null,
      };
    }

    // Read what is already known before extracting, not after. Left to itself
    // the model invents a fresh key each time — one pass produced
    // user.specialty, profile.specialty, profile.work.area and
    // user.profile.work_domain for the same fact — so the profile accumulates
    // near-duplicates that each stay at one observation instead of one memory
    // that gets reinforced.
    const existing = await this.memosClient.listRecords(project.userId, { pageSize: 100 });
    const known = new Map(existing.map((record) => [canonicalKey(record), record]));

    let candidates = [];
    let source = "deterministic";
    let proposed = 0;
    let rejections = [];
    let extractionError = null;
    if (this.enabled && this.config.deepseekProviderEnabled && this.config.deepseekApiKey) {
      try {
        ({ candidates, proposed, rejections } = await this.#extractWithModel(sources, project, run, existing));
        source = "model";
      } catch (error) {
        extractionError = boundedText(error?.message ?? "memory extraction failed", 200);
        candidates = deterministicCandidates(sources, project, run);
        proposed = candidates.length;
      }
    } else {
      candidates = deterministicCandidates(sources, project, run);
      proposed = candidates.length;
    }
    let extracted = 0;
    let activated = 0;
    /** Reason -> how many records this run parked for it. */
    const pendingReasons = new Map();
    for (const candidate of candidates.slice(0, 12)) {
      const previous = known.get(canonicalKey(candidate));
      if (previous?.status === "active" && candidate.origin === "inferred" && !candidate.sensitive) {
        candidate.status = "active";
        // Re-confirming a memory that is already active is not a demotion, so
        // the reason has to go with the status it explained.
        candidate.statusReason = null;
      }
      let stored;
      try {
        stored = await this.memosClient.upsertRecord(project.userId, {
          ...candidate,
          ...(previous ? { id: previous.id } : {}),
        }, candidate.evidence, {
          expectedVersion: previous?.version ?? 0,
          // The demotion reason rides the revision reason, which is what the
          // memory service keeps as this record's audit trail and what
          // publicMemoryRecord hands back on `revisions[].reason`. Before this,
          // a parked record's history said only that it had been written.
          reason: [
            previous ? "conversation evidence updated the current memory" : "conversation evidence created the memory",
            ...(candidate.statusReason ? [demotionReasonAudit[candidate.statusReason]] : []),
          ].join("; "),
        });
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== "memory_conflict") throw error;
        const refreshed = await this.memosClient.listRecords(project.userId, { query: candidate.key, pageSize: 100 });
        const current = refreshed.find((record) => canonicalKey(record) === canonicalKey(candidate));
        if (!current) throw error;
        stored = await this.memosClient.upsertRecord(project.userId, { ...candidate, id: current.id }, candidate.evidence, {
          expectedVersion: current.version,
          // The retry writes the same record, so it carries the same reason.
          reason: [
            "conversation evidence retried after a concurrent memory update",
            ...(candidate.statusReason ? [demotionReasonAudit[candidate.statusReason]] : []),
          ].join("; "),
        });
      }
      extracted += 1;
      if (candidate.statusReason && stored.status === "pending") {
        pendingReasons.set(candidate.statusReason, (pendingReasons.get(candidate.statusReason) ?? 0) + 1);
      }
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
        // It was counted as parked a moment ago and is not parked any more.
        const parked = pendingReasons.get(candidate.statusReason) ?? 0;
        if (parked > 1) pendingReasons.set(candidate.statusReason, parked - 1);
        else pendingReasons.delete(candidate.statusReason);
      }
      known.set(canonicalKey(stored), stored);
    }
    return {
      runSummary, extracted, activated, source, proposed,
      rejected: proposed - candidates.length,
      rejectionReasons: rejections.slice(0, 12),
      // A record that was stored and parked is neither "extracted and working"
      // nor "rejected". It had no count of its own, which is why the demotion
      // could be silent at all.
      pending: [...pendingReasons.values()].reduce((total, count) => total + count, 0),
      pendingReasons: [...pendingReasons].map(([reason, count]) => ({ reason, count, text: demotionReasonText[reason] })),
      extractionError,
    };
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
      // The run summary can only be parked for the sensitive screen — its
      // origin is always "system" — but it is parked silently for the same
      // reason as everything above, so it says so in the same place.
      status: demotionReason(sensitive, "system") ? "pending" : "active",
      confidence: 1,
      importance: run.status === "succeeded" ? 0.55 : 0.7,
      sensitive,
      lastConfirmedAt: run.finishedAt,
      // Episodic memory ages out; the profile extracted from it does not. One
      // run summary is written per run and nothing ever removed them, so
      // without an expiry they grow without bound and eventually crowd the
      // durable memories out of every query.
      expiresAt: this.runSummaryTtlMs > 0
        ? new Date(Date.parse(run.finishedAt ?? new Date().toISOString()) + this.runSummaryTtlMs).toISOString()
        : null,
    }, {
      sourceType: lastUser ? "conversation_message" : "agent_run",
      sourceRef: lastUser?.sourceRef ?? `runs/${run.id}`,
      quote: question || `Run ${run.id} finished with status ${run.status}.`,
      observedAt: run.finishedAt,
      weight: 1,
    }, {
      reason: [
        "agent run reached a terminal state",
        ...(sensitive ? [demotionReasonAudit.sensitive] : []),
      ].join("; "),
    });
  }

  async #extractWithModel(sources, project, run, existing = []) {
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
          model: this.model,
          stream: false,
          temperature: 0,
          // Twelve candidates carrying a value, a summary and an evidence quote
          // do not fit in 2,400 tokens. The reply then stops mid-object and the
          // whole batch is lost to a parse error rather than a partial result.
          max_tokens: 8_000,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [
                "Extract durable memory candidates from the supplied conversation sources.",
                "Return JSON only: {\"candidates\":[...]}. Maximum 12 candidates.",
                "Each candidate must contain scope, kind, key, value, summary, origin, confidence, importance, sensitive, sourceRef, evidenceQuote.",
                "You are building a long-term picture of this user across many sessions, so prefer what will still be true next month over what only matters in this conversation.",
                // The scope a kind must carry is enforced on the way in. Saying
                // so here is the difference between a candidate being stored and
                // being silently dropped for a mismatch the model could not see.
                "profile, preference and behavior describe the person and MUST use scope \"user\" and cite a user message: profile is who they are and what they work on, preference is how they want work done, behavior is how they habitually work.",
                "project_fact, analysis and decision belong to one project and use scope \"project\". follow_up uses scope \"project\" or \"session\". correction records something the user told you was wrong and uses scope \"user\" for a general rule or \"project\" for a local one.",
                "Allowed origins: explicit, inferred, system. explicit and inferred must cite a user message; system must cite an assistant message and is only for assistant-grounded analysis, decisions, follow-ups, or corrections.",
                "Use explicit when the user stated it outright, inferred when it follows from what they did; an inferred candidate stays provisional until three independent observations agree, so record it rather than withholding it.",
                "Sources with role \"tool\" are results the platform computed or retrieved. They hold what prose loses: the search that worked, the identifier a term resolved to, the effect estimate and its interval. Record those as analysis or project_fact with origin \"system\", quoting the tool source exactly, and keep the numbers rather than describing them.",
                "evidenceQuote must be a short exact substring of the referenced source, copied character for character. Do not infer identity, health, beliefs, demographics, or preferences without direct evidence.",
                "Store durable facts and compact analytical essentials: dataset or artifact reference, population/filter, parameter, unit, method, result, decision, and unresolved follow-up.",
                "Do not store greetings, transient requests, chain-of-thought, secrets, full documents, or unsupported conclusions.",
                "Keys must be stable lowercase dotted paths that a later session would choose again for the same fact, so that repeat observations reinforce one memory instead of creating near-duplicates: prefer preference.output_language over preference.user_wants_chinese.",
                "existingMemories lists what is already stored. When this conversation restates or refines one of them, reuse its exact scope, kind and key so the observation reinforces that memory; only mint a new key for a fact none of them covers.",
              ].join(" "),
            },
            {
              role: "user",
              content: JSON.stringify({
                projectId: project.id,
                sessionId: run.sessionId,
                // Keys already in use, so a recurring fact reinforces the memory
                // that holds it instead of creating a synonym beside it.
                existingMemories: existing
                  .filter((record) => record.kind !== "run_summary")
                  .slice(0, 60)
                  .map((record) => ({
                    scope: record.scope,
                    kind: record.kind,
                    key: record.key,
                    summary: boundedText(record.summary, 160),
                  })),
                sources,
              }),
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Memory extraction provider rejected the request.");
      const body = await boundedJsonResponse(response);
      const parsed = parseModelJson(body?.choices?.[0]?.message?.content);
      const sourceMap = new Map(sources.map((item) => [item.sourceRef, item]));
      const rejections = [];
      const validated = parsed.candidates.map((candidate) => validateCandidate(candidate, sourceMap, project, run, rejections));
      // Report what the model offered as well as what survived. Evidence quotes
      // must reproduce the source byte for byte, so a run where every candidate
      // was rejected is a common failure — and without this count it looks
      // exactly like a run where the model proposed nothing.
      return { candidates: validated.filter(Boolean), proposed: parsed.candidates.length, rejections };
    } finally {
      clearTimeout(timeout);
    }
  }
}
