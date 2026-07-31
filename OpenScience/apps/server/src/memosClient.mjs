import { createHash } from "node:crypto";
import { HttpError } from "./security.mjs";

const internalTagPattern = /^#evimed-user-[a-f0-9]{24}$/gm;
const memoIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const memoryRecordIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const memoryNamespacePattern = /^evimed-science-[a-f0-9]{24}$/;

const memoryEnums = {
  scope: {
    user: "MEMORY_SCOPE_USER",
    project: "MEMORY_SCOPE_PROJECT",
    session: "MEMORY_SCOPE_SESSION",
    organization: "MEMORY_SCOPE_ORGANIZATION",
  },
  kind: {
    profile: "MEMORY_KIND_PROFILE",
    preference: "MEMORY_KIND_PREFERENCE",
    behavior: "MEMORY_KIND_BEHAVIOR",
    project_fact: "MEMORY_KIND_PROJECT_FACT",
    analysis: "MEMORY_KIND_ANALYSIS",
    decision: "MEMORY_KIND_DECISION",
    correction: "MEMORY_KIND_CORRECTION",
    follow_up: "MEMORY_KIND_FOLLOW_UP",
    run_summary: "MEMORY_KIND_RUN_SUMMARY",
  },
  origin: {
    explicit: "MEMORY_ORIGIN_EXPLICIT",
    inferred: "MEMORY_ORIGIN_INFERRED",
    system: "MEMORY_ORIGIN_SYSTEM",
    manual: "MEMORY_ORIGIN_MANUAL",
  },
  status: {
    active: "MEMORY_STATUS_ACTIVE",
    pending: "MEMORY_STATUS_PENDING",
    superseded: "MEMORY_STATUS_SUPERSEDED",
    archived: "MEMORY_STATUS_ARCHIVED",
  },
};

// Memories that describe the user rather than a past task. These stay relevant
// whatever the question is; every other kind is episodic and must match the query.
const DURABLE_RECALL_KINDS = new Set(["profile", "preference"]);

const reverseMemoryEnums = Object.fromEntries(
  Object.entries(memoryEnums).map(([group, values]) => [
    group,
    Object.fromEntries(Object.entries(values).map(([key, value]) => [value, key])),
  ]),
);

function namespaceTag(userId) {
  const digest = createHash("sha256").update(`evimed/memos/user/v1:${userId}`).digest("hex").slice(0, 24);
  return `evimed-user-${digest}`;
}

export function memoryNamespace(userId) {
  const digest = createHash("sha256").update(`evimed/memory-record/user/v1:${userId}`).digest("hex").slice(0, 24);
  return `evimed-science-${digest}`;
}

function stripInternalTag(content) {
  return String(content ?? "")
    .replace(internalTagPattern, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function storedContent(content, tag) {
  const clean = stripInternalTag(content);
  return `${clean}\n\n#${tag}`;
}

function memoId(name) {
  const match = String(name ?? "").match(/^memos\/([^/]+)$/);
  if (!match || !memoIdPattern.test(match[1])) {
    throw new HttpError(502, "memory_response_invalid", "The memory service returned an invalid memo id.");
  }
  return match[1];
}

function memoryRecordId(name) {
  const match = String(name ?? "").match(/^memoryRecords\/([^/]+)$/);
  if (!match || !memoryRecordIdPattern.test(match[1])) {
    throw new HttpError(502, "memory_response_invalid", "The memory service returned an invalid structured memory id.");
  }
  return match[1];
}

function enumValue(group, value, field) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const mapped = memoryEnums[group]?.[normalized];
  if (!mapped) throw new HttpError(400, "memory_payload_invalid", `${field} is invalid.`);
  return mapped;
}

function enumName(group, value) {
  return reverseMemoryEnums[group]?.[String(value ?? "")] ?? null;
}

function boundedScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function publicMemoryRecord(record, expectedNamespace = null) {
  if (!record || typeof record !== "object") {
    throw new HttpError(502, "memory_response_invalid", "The memory service returned an invalid structured memory.");
  }
  const namespace = String(record.namespace ?? "");
  if (!memoryNamespacePattern.test(namespace) || (expectedNamespace && namespace !== expectedNamespace)) {
    throw new HttpError(expectedNamespace ? 404 : 502, expectedNamespace ? "memory_not_found" : "memory_response_invalid", expectedNamespace
      ? "Memory not found."
      : "The memory service returned an invalid structured memory namespace.");
  }
  const scope = enumName("scope", record.scope);
  const kind = enumName("kind", record.kind);
  const origin = enumName("origin", record.origin);
  const status = enumName("status", record.status);
  if (!scope || !kind || !origin || !status) {
    throw new HttpError(502, "memory_response_invalid", "The memory service returned invalid structured memory metadata.");
  }
  return {
    id: memoryRecordId(record.name),
    scope,
    scopeId: String(record.scopeId ?? ""),
    kind,
    key: String(record.key ?? ""),
    value: String(record.value ?? ""),
    summary: String(record.summary ?? ""),
    origin,
    status,
    confidence: boundedScore(record.confidence),
    importance: boundedScore(record.importance),
    sensitive: Boolean(record.sensitive),
    evidenceCount: Math.max(0, Number(record.evidenceCount) || 0),
    version: Math.max(1, Number(record.version) || 1),
    createdAt: record.createTime ?? null,
    updatedAt: record.updateTime ?? null,
    lastConfirmedAt: record.lastConfirmedTime ?? null,
    expiresAt: record.expireTime ?? null,
    evidence: Array.isArray(record.evidence) ? record.evidence.map((item) => ({
      sourceType: String(item?.sourceType ?? ""),
      sourceRef: String(item?.sourceRef ?? ""),
      quote: String(item?.quote ?? ""),
      observedAt: item?.observedTime ?? null,
      weight: boundedScore(item?.weight),
      fingerprint: String(item?.fingerprint ?? ""),
    })) : [],
    revisions: Array.isArray(record.revisions) ? record.revisions.map((item) => ({
      version: Number(item?.version) || 0,
      value: String(item?.value ?? ""),
      summary: String(item?.summary ?? ""),
      status: enumName("status", item?.status) ?? "archived",
      changedAt: item?.changedTime ?? null,
      reason: String(item?.reason ?? ""),
    })) : [],
  };
}

function publicMemo(memo, tag) {
  const tags = Array.isArray(memo?.tags) ? memo.tags.filter((item) => item !== tag) : [];
  return {
    id: memoId(memo?.name),
    content: stripInternalTag(memo?.content),
    state: memo?.state === "ARCHIVED" ? "archived" : "normal",
    pinned: Boolean(memo?.pinned),
    tags,
    createdAt: memo?.createTime ?? null,
    updatedAt: memo?.updateTime ?? null,
  };
}

function upstreamMessage(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.message === "string") return body.message;
  if (typeof body.error === "string") return body.error;
  return "";
}

function searchTokens(value) {
  const normalized = String(value ?? "").toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9._-]{1,}|[\u3400-\u9fff]{2,}/g) ?? []);
  for (const run of normalized.match(/[\u3400-\u9fff]{3,}/g) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return [...tokens].filter((token) => token.length >= 2).slice(0, 64);
}

export class MemosClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = String(config.memosUrl ?? "").replace(/\/+$/, "");
    this.accessToken = config.memosAccessToken ?? "";
    this.accessTokenError = config.memosAccessTokenError ?? null;
    this.timeoutMs = Number(config.memosRequestTimeoutMs ?? 8_000);
    this.contextLimit = Math.max(0, Math.min(20, Number(config.memosContextLimit ?? 8)));
    this.contextMaxChars = Math.max(0, Math.min(100_000, Number(config.memosContextMaxChars ?? 20_000)));
    this.fetchImpl = fetchImpl;
    this.urlError = this.#validateUrl();
  }

  #validateUrl() {
    if (!this.baseUrl) return null;
    try {
      const url = new URL(this.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "memory_url_invalid";
      return null;
    } catch {
      return "memory_url_invalid";
    }
  }

  get configured() {
    return Boolean(this.baseUrl && this.accessToken && !this.accessTokenError && !this.urlError);
  }

  async status() {
    if (this.urlError) return { configured: false, connected: false, code: this.urlError };
    if (this.accessTokenError) return { configured: false, connected: false, code: this.accessTokenError };
    if (!this.baseUrl) return { configured: false, connected: false, code: "memory_url_missing" };
    if (!this.accessToken) return { configured: false, connected: false, code: "memory_token_missing" };
    try {
      const body = await this.#request("/api/v1/auth/me");
      await this.#request("/api/v1/memoryRecords?namespace=evimed-science-000000000000000000000000&pageSize=1");
      return {
        configured: true,
        connected: true,
        code: null,
        account: body?.user?.username ?? body?.user?.name ?? null,
        structured: true,
      };
    } catch (error) {
      const code = error instanceof HttpError
        ? (error.code === "memory_not_found" ? "memory_schema_unavailable" : error.code)
        : "memory_unavailable";
      return {
        configured: true,
        connected: false,
        code,
        account: null,
        structured: false,
      };
    }
  }

  async list(userId, { state = "normal", pageSize = 100 } = {}) {
    return (await this.#listMemoPage(userId, { state, pageSize })).memos;
  }

  async #listMemoPage(userId, { state = "normal", pageSize = 100, pageToken = "" } = {}) {
    this.#assertConfigured();
    const tag = namespaceTag(userId);
    const query = new URLSearchParams({
      pageSize: String(Math.max(1, Math.min(200, Number(pageSize) || 100))),
      state: state === "archived" ? "ARCHIVED" : "NORMAL",
      orderBy: "pinned desc, update_time desc",
      filter: `"${tag}" in tags`,
    });
    if (pageToken) query.set("pageToken", pageToken);
    const body = await this.#request(`/api/v1/memos?${query.toString()}`);
    const memos = Array.isArray(body?.memos) ? body.memos : [];
    return {
      memos: memos
      .filter((memo) => Array.isArray(memo?.tags) && memo.tags.includes(tag))
      .map((memo) => publicMemo(memo, tag)),
      nextPageToken: typeof body?.nextPageToken === "string" ? body.nextPageToken : "",
    };
  }

  async listAllMemos(userId, { state = "normal" } = {}) {
    const result = [];
    let pageToken = "";
    const seenTokens = new Set();
    do {
      if (pageToken && seenTokens.has(pageToken)) {
        throw new HttpError(502, "memory_response_invalid", "The memory service repeated a memo page token.");
      }
      if (pageToken) seenTokens.add(pageToken);
      if (seenTokens.size > 1_000) throw new HttpError(502, "memory_response_invalid", "The memo page count exceeded its limit.");
      const page = await this.#listMemoPage(userId, { state, pageSize: 200, pageToken });
      result.push(...page.memos);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return result;
  }

  async relevant(userId, query, { projectId = null, sessionId = null } = {}) {
    if (!this.configured || this.contextLimit === 0 || this.contextMaxChars === 0) return [];
    const terms = searchTokens(query);
    const [memos, records] = await Promise.all([
      this.list(userId, { pageSize: 100 }),
      this.listRecords(userId, { statuses: ["active"], pageSize: 100 }),
    ]);
    const now = Date.now();
    const structured = records
      .filter((record) => !record.sensitive)
      .filter((record) => !record.expiresAt || Date.parse(record.expiresAt) > now)
      .filter((record) => record.scope === "user"
        || (record.scope === "project" && record.scopeId === projectId)
        || (record.scope === "session" && record.scopeId === sessionId))
      .map((record) => {
        const content = [record.summary, record.value].filter(Boolean).join("\n");
        const haystack = `${record.key} ${content}`.toLowerCase();
        const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
        const durable = DURABLE_RECALL_KINDS.has(record.kind);
        const score = matches + (durable ? 0.75 : 0) + record.importance + record.confidence * 0.5;
        return {
          // Only durable identity memories apply to every question. Everything
          // else has to earn recall with a query-term match: importance and
          // confidence alone put the score above zero, so without this a
          // greeting would pull every stored run summary into the prompt.
          recallable: durable || matches > 0,
          memo: {
            id: `record:${record.id}`,
            content,
            updatedAt: record.updatedAt,
            memoryType: "structured",
            kind: record.kind,
            scope: record.scope,
            confidence: record.confidence,
            importance: record.importance,
          },
          score,
        };
      })
      .filter((row) => row.recallable);
    const legacy = memos
      .map((memo) => {
        const haystack = memo.content.toLowerCase();
        const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
        return { memo: { ...memo, memoryType: "manual" }, score: matches + (memo.pinned ? 0.25 : 0) };
      })
      .filter((row) => row.score > 0);
    const ranked = [...structured, ...legacy]
      .sort((left, right) => right.score - left.score || String(right.memo.updatedAt).localeCompare(String(left.memo.updatedAt)));
    const selected = [];
    let total = 0;
    for (const row of ranked) {
      if (selected.length >= this.contextLimit) break;
      const remaining = this.contextMaxChars - total;
      if (remaining <= 0) break;
      const content = row.memo.content.slice(0, remaining);
      if (!content) continue;
      selected.push({ ...row.memo, content });
      total += content.length;
    }
    return selected;
  }

  async listRecords(userId, {
    scopes = [],
    kinds = [],
    statuses = [],
    scopeId = "",
    query = "",
    pageSize = 100,
  } = {}) {
    return (await this.#listRecordPage(userId, { scopes, kinds, statuses, scopeId, query, pageSize })).records;
  }

  async #listRecordPage(userId, {
    scopes = [],
    kinds = [],
    statuses = [],
    scopeId = "",
    query = "",
    pageSize = 100,
    pageToken = "",
  } = {}) {
    this.#assertConfigured();
    const namespace = memoryNamespace(userId);
    const params = new URLSearchParams({
      namespace,
      pageSize: String(Math.max(1, Math.min(100, Number(pageSize) || 100))),
    });
    for (const value of scopes) params.append("scopes", enumValue("scope", value, "scope"));
    for (const value of kinds) params.append("kinds", enumValue("kind", value, "kind"));
    for (const value of statuses) params.append("statuses", enumValue("status", value, "status"));
    if (scopeId) params.set("scopeId", String(scopeId));
    if (query) params.set("query", String(query).slice(0, 500));
    if (pageToken) params.set("pageToken", pageToken);
    const body = await this.#request(`/api/v1/memoryRecords?${params.toString()}`);
    const records = Array.isArray(body?.memoryRecords) ? body.memoryRecords : [];
    return {
      records: records.map((record) => publicMemoryRecord(record, namespace)),
      nextPageToken: typeof body?.nextPageToken === "string" ? body.nextPageToken : "",
    };
  }

  async listAllRecords(userId, filters = {}) {
    const result = [];
    let pageToken = "";
    const seenTokens = new Set();
    do {
      if (pageToken && seenTokens.has(pageToken)) {
        throw new HttpError(502, "memory_response_invalid", "The memory service repeated a structured memory page token.");
      }
      if (pageToken) seenTokens.add(pageToken);
      if (seenTokens.size > 1_000) throw new HttpError(502, "memory_response_invalid", "The structured memory page count exceeded its limit.");
      const page = await this.#listRecordPage(userId, { ...filters, pageSize: 100, pageToken });
      result.push(...page.records);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return result;
  }

  async getRecord(userId, id) {
    this.#assertConfigured();
    this.#assertMemoryRecordId(id);
    const record = await this.#request(`/api/v1/memoryRecords/${encodeURIComponent(id)}`);
    return publicMemoryRecord(record, memoryNamespace(userId));
  }

  async upsertRecord(userId, input, evidence = null, { expectedVersion = 0, reason = "" } = {}) {
    this.#assertConfigured();
    const namespace = memoryNamespace(userId);
    const record = {
      ...(input.id ? { name: `memoryRecords/${this.#assertMemoryRecordId(input.id)}` } : {}),
      namespace,
      scope: enumValue("scope", input.scope, "scope"),
      scopeId: input.scope === "user" ? "" : String(input.scopeId ?? ""),
      kind: enumValue("kind", input.kind, "kind"),
      key: String(input.key ?? ""),
      value: String(input.value ?? ""),
      summary: String(input.summary ?? ""),
      origin: enumValue("origin", input.origin, "origin"),
      status: enumValue("status", input.status, "status"),
      confidence: boundedScore(input.confidence),
      importance: boundedScore(input.importance),
      sensitive: Boolean(input.sensitive),
      ...(input.lastConfirmedAt ? { lastConfirmedTime: input.lastConfirmedAt } : {}),
      ...(input.expiresAt ? { expireTime: input.expiresAt } : {}),
    };
    const body = {
      memoryRecord: record,
      expectedVersion: Math.max(0, Number(expectedVersion) || 0),
      reason: String(reason ?? "").slice(0, 500),
    };
    if (evidence) {
      body.evidence = {
        sourceType: String(evidence.sourceType ?? ""),
        sourceRef: String(evidence.sourceRef ?? ""),
        quote: String(evidence.quote ?? ""),
        observedTime: evidence.observedAt ?? new Date().toISOString(),
        weight: boundedScore(evidence.weight ?? 1),
      };
    }
    const result = await this.#request("/api/v1/memoryRecords:upsert", { method: "POST", body });
    return publicMemoryRecord(result, namespace);
  }

  async deleteRecord(userId, id) {
    this.#assertConfigured();
    this.#assertMemoryRecordId(id);
    await this.getRecord(userId, id);
    await this.#request(`/api/v1/memoryRecords/${encodeURIComponent(id)}`, { method: "DELETE" });
    return true;
  }

  async purgeRecords(userId) {
    this.#assertConfigured();
    const body = await this.#request("/api/v1/memoryRecords:purge", {
      method: "POST",
      body: { namespace: memoryNamespace(userId) },
    });
    return Math.max(0, Number(body?.deletedCount) || 0);
  }

  async deleteProjectMemory(userId, projectId) {
    this.#assertConfigured();
    const scopeId = String(projectId ?? "").trim();
    if (!scopeId) throw new HttpError(400, "memory_payload_invalid", "projectId is required.");
    const records = await this.listAllRecords(userId, { scopes: ["project"], scopeId });
    let structured = 0;
    for (const record of records) {
      await this.deleteRecord(userId, record.id);
      structured += 1;
    }

    let manual = 0;
    const projectLine = `- Project: ${scopeId}`;
    for (const state of ["normal", "archived"]) {
      const memos = await this.listAllMemos(userId, { state });
      for (const memo of memos) {
        if (!memo.tags.includes("evimed-agent-run") || !memo.content.split("\n").includes(projectLine)) continue;
        await this.delete(userId, memo.id);
        manual += 1;
      }
    }
    return { structured, manual };
  }

  async exportUserMemory(userId) {
    this.#assertConfigured();
    const [records, current, archived] = await Promise.all([
      this.listAllRecords(userId),
      this.listAllMemos(userId, { state: "normal" }),
      this.listAllMemos(userId, { state: "archived" }),
    ]);
    return { version: 1, records, manualMemos: [...current, ...archived] };
  }

  async purgeUserMemory(userId) {
    this.#assertConfigured();
    const structured = await this.purgeRecords(userId);
    let manual = 0;
    for (const state of ["normal", "archived"]) {
      for (;;) {
        const batch = await this.list(userId, { state, pageSize: 200 });
        if (batch.length === 0) break;
        for (const memo of batch) {
          await this.delete(userId, memo.id);
          manual += 1;
        }
      }
    }
    return { structured, manual };
  }

  async profile(userId, { projectId = null } = {}) {
    const records = await this.listAllRecords(userId);
    const visible = records.filter((record) => record.scope === "user"
      || (record.scope === "project" && record.scopeId === projectId));
    const groups = Object.fromEntries(Object.keys(memoryEnums.kind).map((kind) => [kind, []]));
    for (const record of visible) groups[record.kind].push(record);
    return {
      records: visible,
      groups,
      activeCount: visible.filter((record) => record.status === "active").length,
      pendingCount: visible.filter((record) => record.status === "pending").length,
    };
  }

  async create(userId, content) {
    this.#assertConfigured();
    const tag = namespaceTag(userId);
    const memo = await this.#request("/api/v1/memos", {
      method: "POST",
      body: {
        state: "NORMAL",
        content: storedContent(content, tag),
        visibility: "PRIVATE",
      },
    });
    return publicMemo(memo, tag);
  }

  async update(userId, id, update) {
    this.#assertConfigured();
    this.#assertMemoId(id);
    const tag = namespaceTag(userId);
    const existing = await this.#ownedMemo(id, tag);
    const memo = { name: existing.name };
    const fields = [];
    if (Object.hasOwn(update, "content")) {
      memo.content = storedContent(update.content, tag);
      fields.push("content");
    }
    if (Object.hasOwn(update, "pinned")) {
      memo.pinned = Boolean(update.pinned);
      fields.push("pinned");
    }
    if (Object.hasOwn(update, "state")) {
      memo.state = update.state === "archived" ? "ARCHIVED" : "NORMAL";
      fields.push("state");
    }
    if (fields.length === 0) return publicMemo(existing, tag);
    const query = new URLSearchParams({ updateMask: fields.join(",") });
    const updated = await this.#request(`/api/v1/memos/${encodeURIComponent(id)}?${query.toString()}`, {
      method: "PATCH",
      body: memo,
    });
    return publicMemo(updated, tag);
  }

  async delete(userId, id) {
    this.#assertConfigured();
    this.#assertMemoId(id);
    const tag = namespaceTag(userId);
    await this.#ownedMemo(id, tag);
    await this.#request(`/api/v1/memos/${encodeURIComponent(id)}`, { method: "DELETE" });
    return true;
  }

  async #ownedMemo(id, tag) {
    const memo = await this.#request(`/api/v1/memos/${encodeURIComponent(id)}`);
    if (!Array.isArray(memo?.tags) || !memo.tags.includes(tag)) {
      throw new HttpError(404, "memory_not_found", "Memory not found.");
    }
    return memo;
  }

  #assertMemoId(id) {
    if (!memoIdPattern.test(String(id ?? ""))) {
      throw new HttpError(400, "memory_id_invalid", "Memory id is invalid.");
    }
  }

  #assertMemoryRecordId(id) {
    const value = String(id ?? "");
    if (!memoryRecordIdPattern.test(value)) {
      throw new HttpError(400, "memory_id_invalid", "Structured memory id is invalid.");
    }
    return value;
  }

  #assertConfigured() {
    const code = this.urlError ?? this.accessTokenError ?? (!this.baseUrl ? "memory_url_missing" : null) ?? (!this.accessToken ? "memory_token_missing" : null);
    if (code) throw new HttpError(503, code, "The research memory service is not configured.");
  }

  async #request(relative, { method = "GET", body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${relative}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.accessToken}`,
          ...(body == null ? {} : { "Content-Type": "application/json" }),
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const code = error?.name === "AbortError" ? "memory_timeout" : "memory_unavailable";
      throw new HttpError(503, code, "The research memory service is unavailable.");
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) throw new HttpError(502, "memory_response_invalid", "The memory service returned invalid JSON.");
      }
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403
        ? "memory_auth_failed"
        : response.status === 404
          ? "memory_not_found"
          : response.status === 409
            ? "memory_conflict"
          : "memory_upstream_error";
      const status = response.status === 404 ? 404 : response.status === 409 ? 409 : 502;
      throw new HttpError(status, code, upstreamMessage(parsed) || "The memory service rejected the request.");
    }
    return parsed;
  }
}
