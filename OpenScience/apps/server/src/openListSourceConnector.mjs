import path from "node:path";
import { HttpError, safeId } from "./security.mjs";

function remotePath(value) {
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

/** Maps every account into one immutable OpenList namespace. A browser can
 * name paths inside its namespace but can never select a storage root. */
export class OpenListSourceConnector {
  constructor(client, { tenantRoot = "/tenants" } = {}) {
    if (!client) throw new TypeError("OpenList source connector requires a client.");
    const root = remotePath(tenantRoot);
    if (root === "/") throw new TypeError("OpenList tenant root cannot be the service root.");
    this.client = client;
    this.tenantRoot = root.replace(/\/+$/, "");
  }

  prefix(userId) { return `${this.tenantRoot}/${encodeURIComponent(safeId(userId, "user"))}`; }

  scoped(userId, value) {
    const selected = remotePath(value);
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
  async health() { return this.client.health(); }
}
