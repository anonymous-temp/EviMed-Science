import path from "node:path";
import { HttpError, safeId } from "./security.mjs";

function remotePathOf(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 2048 || value.includes("\0")) {
    throw new HttpError(400, "openlist_path_invalid", "OpenList path is invalid.");
  }
  if (value.split("/").some((part) => part === "." || part === "..")) {
    throw new HttpError(400, "openlist_path_invalid", "OpenList path is invalid.");
  }
  const normalized = path.posix.normalize(value);
  if (!normalized.startsWith("/") || normalized === "/.." || normalized.startsWith("/../")) {
    throw new HttpError(400, "openlist_path_invalid", "OpenList path is invalid.");
  }
  return normalized;
}

/** One mapping from an OpenList directory entry to a source manifest. The
 * explicit import route and the leased folder sync both go through it, so a file
 * lands in the same version family whichever path registered it.
 * @param {string} projectId @param {{path:string,size:number,mtime:string|null,providerHash:string|null}} entry
 * @param {{now?:()=>Date}} options */
export function openListSourceInput(projectId, entry, { now = () => new Date() } = {}) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(String(entry?.providerHash ?? ""));
  if (!match) {
    throw new HttpError(409, "openlist_sha256_required", "This OpenList storage must expose a SHA-256 hash; use platform upload for this file.");
  }
  const remotePath = remotePathOf(entry.path);
  return {
    projectId,
    connector: { type: "openlist", id: remotePath },
    path: `openlist/${remotePath.replace(/^\/+/, "")}`,
    size: entry.size,
    mtime: entry.mtime ?? now().toISOString(),
    mimeType: "application/octet-stream",
    sha256: match[1].toLowerCase(),
    providerHash: entry.providerHash,
  };
}

/** Maps every account into one immutable OpenList namespace. A browser can
 * name paths inside its namespace but can never select a storage root. */
export class OpenListSourceConnector {
  /** `probeTimeoutMs` bounds one storage probe: readiness runs it inside a
   * healthcheck with a 5 s budget for every check together. `probeCacheMs` is
   * how long one probe answers every reader — `/api/me` asks on each shell load,
   * and that must not become one OpenList request per page view.
   * @param {any} client @param {{tenantRoot?:string,probeTimeoutMs?:number,probeCacheMs?:number,now?:()=>number}} options */
  constructor(client, { tenantRoot = "/tenants", probeTimeoutMs = 3_000, probeCacheMs = 60_000, now = () => Date.now() } = {}) {
    if (!client) throw new TypeError("OpenList source connector requires a client.");
    const root = remotePathOf(tenantRoot);
    if (root === "/") throw new TypeError("OpenList tenant root cannot be the service root.");
    if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 500 || probeTimeoutMs > 30_000
      || !Number.isSafeInteger(probeCacheMs) || probeCacheMs < 0 || probeCacheMs > 3_600_000) {
      throw new TypeError("OpenList storage probe limits are invalid.");
    }
    this.client = client;
    this.tenantRoot = root.replace(/\/+$/, "");
    this.probeTimeoutMs = probeTimeoutMs;
    this.probeCacheMs = probeCacheMs;
    this.now = now;
    /** @type {{at:number,status?:{storage:"mounted"|"missing",namespaces:number},error?:any}|null} */
    this.probed = null;
    /** @type {Promise<any>|null} */
    this.probing = null;
    /** Probes that reached OpenList, by outcome — the cost the cache bounds. */
    this.probeCounts = new Map();
  }

  /**
   * Whether anything under the tenant root can be imported: the same
   * authenticated `fs/list` the browse route makes, against the configured
   * tenant root, one entry per page. It replaced `/ping`, which OpenList answers
   * without a credential and without a single storage mounted, so a deployment
   * with an empty `x_storages` read `connected` while every browse failed
   * (audit I3-4).
   *
   * `namespaces` is how many entries the tenant root holds — one per account
   * with a drive mounted, or the folders of a storage mounted at the root
   * itself. None, or no storage covering the root at all, is `missing`.
   * Anything else OpenList refuses (unreachable, too slow, the credential) is
   * thrown with its code, and is remembered for the same window.
   *
   * `allowStale` answers the last known state at once, however old, and
   * refreshes it behind the answer: the shell's `/api/me` must not wait on a
   * drive. Only a process that has never probed waits, once.
   * @param {{allowStale?:boolean}} options
   * @returns {Promise<{storage:"mounted"|"missing",namespaces:number}>}
   */
  async storageStatus({ allowStale = false } = {}) {
    const known = this.probed;
    const settled = (/** @type {any} */ record) => { if (record.error) throw record.error; return { ...record.status }; };
    if (known && this.now() - known.at < this.probeCacheMs) return settled(known);
    this.probing ??= this.probeStorage().finally(() => { this.probing = null; });
    if (allowStale && known) return settled(known);
    return settled(await this.probing);
  }

  async probeStorage() {
    /** @type {{at:number,status?:{storage:"mounted"|"missing",namespaces:number},error?:any}} */
    let record;
    try {
      const page = await this.client.list(this.tenantRoot, { page: 1, perPage: 1, timeoutMs: this.probeTimeoutMs });
      const namespaces = Number.isSafeInteger(page.total) ? page.total : page.entries.length;
      record = { at: this.now(), status: { storage: namespaces > 0 ? "mounted" : "missing", namespaces } };
    } catch (error) {
      record = error?.code === "openlist_storage_missing"
        ? { at: this.now(), status: { storage: "missing", namespaces: 0 } }
        : { at: this.now(), error };
    }
    const outcome = record.status?.storage ?? String(record.error?.code ?? "openlist_probe_failed");
    this.probeCounts.set(outcome, (this.probeCounts.get(outcome) ?? 0) + 1);
    this.probed = record;
    return record;
  }

  prefix(userId) { return `${this.tenantRoot}/${encodeURIComponent(safeId(userId, "user"))}`; }

  scoped(userId, value) {
    const selected = remotePathOf(value);
    return `${this.prefix(userId)}${selected === "/" ? "" : selected}`;
  }

  relative(userId, value) {
    const prefix = this.prefix(userId);
    if (value === prefix) return "/";
    if (!value.startsWith(`${prefix}/`)) throw new HttpError(502, "openlist_scope_invalid", "OpenList returned a path outside the account namespace.");
    return value.slice(prefix.length);
  }

  async list(userId, value, options = {}) {
    const page = await this.client.list(this.scoped(userId, value), options);
    return { ...page, entries: page.entries.map((entry) => ({ ...entry, path: this.relative(userId, entry.path) })) };
  }

  async stat(userId, value) {
    const item = await this.client.stat(this.scoped(userId, value));
    return { ...item, path: this.relative(userId, item.path) };
  }

  async read(userId, value) { return this.client.read(this.scoped(userId, value)); }
}
