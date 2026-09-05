import { HttpError } from "./security.mjs";

function failure(code, message, status = 502) { return new HttpError(status, code, message); }

/** @param {unknown} value */
function openListPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 2048 || value.includes("\0")
    || value.split("/").some((part) => part === "." || part === "..")) {
    throw failure("openlist_path_invalid", "OpenList path is invalid.", 400);
  }
  return value.length > 1 ? value.replace(/\/+$/, "") : "/";
}

/** @param {Response} response @param {number} limit */
async function body(response, limit) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw failure("openlist_response_too_large", "OpenList response exceeded its limit.");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let complete = false;
  while (!complete) {
    const item = await reader.read();
    if (item.done) { complete = true; continue; }
    total += item.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw failure("openlist_response_too_large", "OpenList response exceeded its limit.");
    }
    chunks.push(Buffer.from(item.value));
  }
  return Buffer.concat(chunks);
}

function safeName(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw failure("openlist_response_invalid", "OpenList returned an invalid entry name.");
  }
  return value;
}

function providerHash(hashInfo) {
  if (!hashInfo || typeof hashInfo !== "object" || Array.isArray(hashInfo)) return null;
  for (const name of ["sha256", "sha1", "md5", "quickxor", "quick_xor_hash"]) {
    const value = hashInfo[name];
    if (typeof value === "string" && value.trim() && value.length <= 256) return `${name.replaceAll("_", "")}:${value.trim().toLowerCase()}`;
  }
  return null;
}

/** Narrow OpenList v4 client: three configured API calls, no dynamic endpoints. */
export class OpenListClient {
  /** @param {{baseUrl:string,token?:string,fetchImpl?:typeof fetch,timeoutMs?:number,maxResponseBytes?:number}} config */
  constructor({ baseUrl, token = "", fetchImpl = globalThis.fetch, timeoutMs = 30_000, maxResponseBytes = 8 * 1024 * 1024 }) {
    let parsed;
    try { parsed = new URL(String(baseUrl)); } catch { throw new TypeError("OpenList URL is invalid."); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/") {
      throw new TypeError("OpenList URL must be an HTTP origin.");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 64 * 1024 * 1024) {
      throw new TypeError("OpenList limits are invalid.");
    }
    this.baseUrl = parsed.origin;
    this.token = String(token);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  /** @param {string} remotePath @param {{page?:number,perPage?:number,refresh?:boolean}} options */
  async list(remotePath, { page = 1, perPage = 100, refresh = false } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 500) {
      throw failure("openlist_page_invalid", "OpenList page is invalid.", 400);
    }
    const parent = openListPath(remotePath);
    const data = await this.request("/api/fs/list", { path: parent, page, per_page: perPage, refresh: Boolean(refresh) });
    const rows = data?.content;
    if (!Array.isArray(rows) || rows.length > perPage) throw failure("openlist_response_invalid", "OpenList returned an invalid directory listing.");
    const entries = rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw failure("openlist_response_invalid", "OpenList returned an invalid entry.");
      const name = safeName(row.name);
      const size = Number(row.size ?? 0);
      if (!Number.isSafeInteger(size) || size < 0) throw failure("openlist_response_invalid", "OpenList returned an invalid file size.");
      const modified = typeof row.modified === "string" && Number.isFinite(Date.parse(row.modified)) ? new Date(row.modified).toISOString() : null;
      return {
        path: `${parent === "/" ? "" : parent}/${name}`,
        name,
        size,
        mtime: modified,
        entryType: row.is_dir === true ? "dir" : "file",
        providerHash: providerHash(row.hash_info),
      };
    });
    const total = Number(data?.total ?? entries.length);
    return { entries, nextCursor: Number.isFinite(total) && page * perPage < total ? String(page + 1) : null };
  }

  /** @param {string} remotePath */
  async get(remotePath) { return this.request("/api/fs/get", { path: openListPath(remotePath) }); }

  /** @param {string} remotePath */
  async link(remotePath) {
    const data = await this.request("/api/fs/link", { path: openListPath(remotePath) });
    if (!data || typeof data.url !== "string" || !data.url.startsWith("http") || data.url.length > 8192) {
      throw failure("openlist_response_invalid", "OpenList returned an invalid link.");
    }
    return { url: data.url, header: data.header && typeof data.header === "object" && !Array.isArray(data.header) ? data.header : {} };
  }

  /** @param {string} endpoint @param {Record<string,any>} payload */
  async request(endpoint, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: this.token } : {}) },
        body: JSON.stringify(payload), signal: controller.signal,
      });
    } catch (error) {
      throw failure(error?.name === "AbortError" ? "openlist_timeout" : "openlist_unavailable", "OpenList is unavailable.", 503);
    } finally { clearTimeout(timer); }
    if (!response.ok) throw failure("openlist_request_failed", `OpenList returned HTTP ${response.status}.`);
    let parsed;
    try { parsed = JSON.parse((await body(response, this.maxResponseBytes)).toString("utf8")); }
    catch (error) {
      if (error?.code === "openlist_response_too_large") throw error;
      throw failure("openlist_response_invalid", "OpenList returned invalid JSON.");
    }
    if (!parsed || parsed.code !== 200 || !parsed.data || typeof parsed.data !== "object") {
      throw failure("openlist_request_failed", "OpenList rejected the request.");
    }
    return parsed.data;
  }
}
