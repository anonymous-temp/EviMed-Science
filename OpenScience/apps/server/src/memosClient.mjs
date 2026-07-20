import { createHash } from "node:crypto";
import { HttpError } from "./security.mjs";

const internalTagPattern = /^#evimed-user-[a-f0-9]{24}$/gm;
const memoIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function namespaceTag(userId) {
  const digest = createHash("sha256").update(`evimed/memos/user/v1:${userId}`).digest("hex").slice(0, 24);
  return `evimed-user-${digest}`;
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
      return {
        configured: true,
        connected: true,
        code: null,
        account: body?.user?.username ?? body?.user?.name ?? null,
      };
    } catch (error) {
      return {
        configured: true,
        connected: false,
        code: error instanceof HttpError ? error.code : "memory_unavailable",
        account: null,
      };
    }
  }

  async list(userId, { state = "normal", pageSize = 100 } = {}) {
    this.#assertConfigured();
    const tag = namespaceTag(userId);
    const query = new URLSearchParams({
      pageSize: String(Math.max(1, Math.min(200, Number(pageSize) || 100))),
      state: state === "archived" ? "ARCHIVED" : "NORMAL",
      orderBy: "pinned desc, update_time desc",
      filter: `"${tag}" in tags`,
    });
    const body = await this.#request(`/api/v1/memos?${query.toString()}`);
    const memos = Array.isArray(body?.memos) ? body.memos : [];
    return memos
      .filter((memo) => Array.isArray(memo?.tags) && memo.tags.includes(tag))
      .map((memo) => publicMemo(memo, tag));
  }

  async relevant(userId, query) {
    if (!this.configured || this.contextLimit === 0 || this.contextMaxChars === 0) return [];
    const memos = await this.list(userId, { pageSize: 100 });
    const terms = searchTokens(query);
    const ranked = memos
      .map((memo) => {
        const haystack = memo.content.toLowerCase();
        const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
        return { memo, score: matches + (memo.pinned ? 0.25 : 0) };
      })
      .filter((row) => row.score > 0)
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
          : "memory_upstream_error";
      throw new HttpError(response.status === 404 ? 404 : 502, code, upstreamMessage(parsed) || "The memory service rejected the request.");
    }
    return parsed;
  }
}
