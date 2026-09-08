import { Buffer } from "node:buffer";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { ERROR_DETAIL_FIELDS } from "@evimed/domain";

/** Accept a finite number, or nothing.
 *  `kind` is read by `test/security.test.mjs`, which asserts that every
 *  acceptor in the table below is one of the two vocabularies this module
 *  defines — the property the safety comment there rests on.
 *  @param {unknown} value */
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
finiteNumber.kind = "finite-number";
finiteNumber.allowed = Object.freeze(/** @type {string[]} */ ([]));

/** Accept one of a closed set of strings written here, or nothing.
 *  @param {readonly string[]} allowed */
function oneOf(allowed) {
  const members = Object.freeze([...allowed]);
  /** @param {unknown} value */
  const accept = (value) => (typeof value === "string" && members.includes(value) ? value : undefined);
  accept.kind = "closed-set";
  accept.allowed = members;
  return accept;
}

/**
 * The error codes whose refusal may carry machine-readable specifics to the
 * browser, and the exact shape each one may carry. A code absent from this
 * table carries nothing.
 *
 * Derived from `@evimed/domain`'s `ERROR_DETAIL_FIELDS` rather than written
 * here, because there were three copies of this vocabulary and they disagreed.
 * The browser held one (`parseWebApiErrorDetails`), this module held another,
 * and the domain now holds the declaration both read. While they were separate,
 * the two codes this deployment actually raises — `credits_daily_limit_reached`
 * and `credits_weekly_limit_reached` — were absent from this table, so
 * `assertSpendWithinLimits` computed the window, the ceiling, the amount spent
 * and the reset moment and had all four dropped at the wire; the researcher was
 * told 「请重试」 for a ceiling that retrying cannot clear. Deriving is what
 * makes "declare a code's details" one edit instead of three.
 *
 * The safety argument is unchanged and still structural: the domain declares
 * data — either the literal `'number'` or a frozen closed set of strings — and
 * this maps each to `finiteNumber` or `oneOf`, which are the only two acceptors
 * that exist. There is no way to spell a free-string acceptor in that
 * vocabulary, so no caller-supplied string can be copied out however a future
 * call site fills its bag.
 *
 * The safety of this channel is structural, not a review habit, and it is
 * enforced twice: `HttpError` filters the call site's bag at construction, and
 * `sendError` filters again against this table immediately before writing the
 * body — `details` is an ordinary writable property, so trusting it would make
 * the guarantee a property of the constructor rather than of the wire.
 *
 * A value reaches the wire only if (1) this table declares its key for that
 * code and (2) the acceptor declared for that key returns it — and every
 * acceptor here yields either a finite number or a string it picked out of a
 * closed set written in this file. No caller-supplied string is ever copied
 * out. So a stack trace, a filesystem path, a SQL fragment, a hostname or a
 * credential cannot leave through this channel even if a future call site puts
 * one in the bag: none of them is a finite number, and none of them is a
 * member of a set written above.
 *
 * Frozen, and exported only so that guarantee can be tested rather than
 * believed:
 * `test/security.test.mjs` walks this table and refuses an acceptor that is
 * neither vocabulary, because adding a free-string acceptor here is the one
 * edit that would quietly make the paragraph above false. Nothing outside this
 * module may build a details bag from it.
 *
 * Adding a code here is a new promise to the client. Add one only together
 * with the surface that renders it.
 */
export const errorDetailShapes = Object.freeze(Object.fromEntries(
  Object.entries(ERROR_DETAIL_FIELDS).map(([code, fields]) => [code, Object.freeze(Object.fromEntries(
    Object.entries(fields).map(([key, rule]) => [key, rule === "number" ? finiteNumber : oneOf(rule)]),
  ))]),
));

/** Copy the declared, accepted details out of a call site's options bag.
 *  Only own data properties are read, so no getter runs, nothing is inherited
 *  from a prototype, and the result holds copies rather than references.
 *  @param {string} code @param {Record<string, any>} options
 *  @returns {Record<string, string | number> | undefined} */
function declaredErrorDetails(code, options) {
  const shape = errorDetailShapes[code];
  if (!shape || !options || typeof options !== "object") return undefined;
  /** @type {Record<string, string | number>} */
  const details = {};
  for (const [key, accept] of Object.entries(shape)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !("value" in descriptor)) continue;
    const value = accept(descriptor.value);
    if (value !== undefined) details[key] = value;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

export class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {Record<string, any>} options */
  constructor(status, code, message, options = {}) {
    super(message);
    /** @type {number} */
    this.status = status;
    /** @type {string} */
    this.code = code;
    /** What this refusal can tell the client beyond its code and sentence,
     *  filtered to the shape `errorDetailShapes` declares for this code.
     *  Undefined for every code that declares no shape. Writable like any
     *  property, which is why `sendError` filters again rather than trusting
     *  whatever this holds when the body is written.
     *  @type {Record<string, string | number> | undefined} */
    this.details = declaredErrorDetails(code, options);
    /** Set by the dispatch path when an upstream refusal is final rather than
     *  worth retrying. Declared here so the property has one definition
     *  instead of appearing by assignment at the call sites.
     *  @type {boolean | undefined} */
    this.definitivelyRejected = undefined;
    /** @type {number | undefined} */
    this.retryAfterSeconds = undefined;
    if (Number.isFinite(options.retryAfterSeconds)) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

const projectStorageMutations = new Map();

export function withProjectStorageMutation(project, operation) {
  const key = `${project.userId}:${project.id}`;
  const previous = projectStorageMutations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  projectStorageMutations.set(key, current);
  return current.finally(() => {
    if (projectStorageMutations.get(key) === current) projectStorageMutations.delete(key);
  });
}

export function randomId(prefix = "") {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function safeId(value, label = "id") {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new HttpError(400, "invalid_id", `Invalid ${label}.`);
  }
  return value;
}

export function parseCookies(header = "") {
  const out = new Map();
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rawKey) continue;
    try {
      out.set(rawKey, decodeURIComponent(rest.join("=") ?? ""));
    } catch {
      continue;
    }
  }
  return out;
}

export function appendSetCookie(res, cookie) {
  const current = res.getHeader("Set-Cookie");
  if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, cookie]);
  } else if (typeof current === "string" && current) {
    res.setHeader("Set-Cookie", [current, cookie]);
  } else {
    res.setHeader("Set-Cookie", cookie);
  }
}

export function setSessionCookie(res, name, value, secure = false, maxAgeSeconds = null) {
  const cookie = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0 ? `Max-Age=${Math.floor(maxAgeSeconds)}` : "",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
  appendSetCookie(res, cookie);
}

export function shouldUseSecureCookies(req, config) {
  if (req.socket.encrypted) return true;
  if (typeof config.publicUrl === "string" && config.publicUrl) {
    try {
      return new URL(config.publicUrl).protocol === "https:";
    } catch {
      return false;
    }
  }
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return typeof proto === "string" && proto.split(",")[0]?.trim().toLowerCase() === "https";
}

export function clearSessionCookie(res, name) {
  appendSetCookie(res, `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function sendError(res, err, fields = {}) {
  const status = err instanceof HttpError ? err.status : 500;
  const code = err instanceof HttpError ? err.code : "internal_error";
  const message = err instanceof Error ? err.message : String(err);
  const headers = {};
  if (Number.isFinite(err?.retryAfterSeconds)) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(err.retryAfterSeconds)));
  }
  if (fields.requestId) headers["X-Open-Science-Request-Id"] = fields.requestId;
  /** @type {{ error: string, code: string, requestId: string | null, details?: Record<string, string | number> }} */
  const body = { error: message, code, requestId: fields.requestId ?? null };
  // Only the codes that declared a shape carry details. Every other error
  // keeps the exact three-key envelope clients parse today, byte for byte.
  //
  // Filtered here against the declared shape rather than copied from
  // `err.details`: that property is writable, and readiness and profile checks
  // already build errors carrying a `details` bag of internal reporting (a
  // path, a failing field, a stack) for their own logs. Deriving the wire value
  // at the wire is what makes the guarantee `errorDetailShapes` states true of
  // every response instead of only of errors nobody touched after construction.
  const details = err instanceof HttpError ? declaredErrorDetails(err.code, err.details) : undefined;
  if (details) body.details = details;
  sendJson(res, status, body, headers);
}

export async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, "body_too_large", "Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  return parseJsonBody(raw);
}

export async function readJsonWithSize(req, limit) {
  const raw = await readBody(req, limit);
  return { body: parseJsonBody(raw), bytes: raw.length };
}

function parseJsonBody(raw) {
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected object");
    }
    return parsed;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
}

export function assertObject(value, label = "value") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_payload", `${label} must be an object.`);
  }
  return value;
}

export function assertString(value, label, { optional = false, max = 65536 } = {}) {
  if (value == null && optional) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "invalid_payload", `${label} must be a string.`);
  if (value.length > max) throw new HttpError(400, "invalid_payload", `${label} is too long.`);
  return value;
}

export function normalizeRoot(value) {
  if (value == null || value === "" || value === "workspace") return "workspace";
  if (value === "base") return "base";
  throw new HttpError(400, "invalid_root", "root must be \"workspace\" or \"base\".");
}

export function normalizeWorkspaceRelativePath(value, label = "path", { max = 4096 } = {}) {
  const rel = assertString(value, label, { max }).replace(/\\/g, "/");
  if (!rel || rel.endsWith("/")) throw new HttpError(400, "invalid_path", `${label} is invalid.`);
  if (rel.includes("\0")) throw new HttpError(400, "invalid_path", `${label} contains a null byte.`);
  if (rel.startsWith("/") || /^[a-zA-Z]:\//.test(rel)) {
    throw new HttpError(400, "invalid_path", "absolute paths are not allowed.");
  }
  const parts = rel.split("/");
  if (parts.some((part) => part === "" || part === ".")) {
    throw new HttpError(400, "invalid_path", `${label} contains an invalid path segment.`);
  }
  if (parts.some((part) => part === "..")) {
    throw new HttpError(403, "path_forbidden", "path escapes the workspace.");
  }
  return parts.join("/");
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

function finitePositiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function assertProjectScanCapacity(count, limit) {
  if (limit != null && count > limit) {
    throw new HttpError(413, "project_scan_too_large", `Project scan exceeded ${limit} entries.`);
  }
}

export async function directorySize(rootDir, options = {}) {
  let total = 0;
  let entriesSeen = 0;
  const maxEntries = finitePositiveInteger(options.maxEntries);

  async function walkDir(dir) {
    const opened = await openScopedDirectoryNoFollow(rootDir, dir).catch((err) => {
      if (err?.code === "ENOENT") return null;
      throw err;
    });
    if (!opened) return;
    try {
      const entries = await fs.readdir(opened.path, { withFileTypes: true });
      for (const entry of entries) {
        entriesSeen += 1;
        assertProjectScanCapacity(entriesSeen, maxEntries);
        const full = path.join(dir, entry.name);
        // A file that vanished between readdir and lstat is a live workspace,
        // not a fault. The directory case was already tolerated and the file
        // case was not, so a run deleting its own scratch file while the quota
        // monitor happened to be walking raised a raw ENOENT — which is not an
        // HttpError, so it fell through to "the check itself failed" and the
        // guard stopped the runtime. Seventeen queued analyses never ran.
        const stat = await fs.lstat(path.join(opened.path, entry.name)).catch((err) => {
          if (err?.code === "ENOENT") return null;
          throw err;
        });
        if (!stat) continue;
        if (stat.isDirectory()) {
          await walkDir(full);
        } else if (stat.isFile()) {
          total += stat.size;
        }
      }
    } finally {
      await opened.handle.close();
    }
  }
  await walkDir(rootDir);
  return total;
}

export async function assertProjectCapacity(project, targetPath, incomingBytes, config) {
  const max = Number.isFinite(project.maxBytes) && project.maxBytes > 0
    ? project.maxBytes
    : config.maxProjectBytes;
  if (!Number.isFinite(max) || max <= 0) return;
  const usageRoot = project.baseDir;
  const full = resolveScopedPath(usageRoot, path.relative(usageRoot, targetPath));
  let existing = 0;
  try {
    const stat = await fs.lstat(full);
    if (stat.isFile()) existing = stat.size;
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  const used = await directorySize(usageRoot, { maxEntries: config.maxProjectUsageScanEntries });
  if (used - existing + incomingBytes > max) {
    throw new HttpError(413, "project_quota_exceeded", "Project storage quota exceeded.");
  }
}

export async function assertProjectUsageWithinQuota(project, config) {
  const max = Number.isFinite(project.maxBytes) && project.maxBytes > 0
    ? project.maxBytes
    : config.maxProjectBytes;
  if (!Number.isFinite(max) || max <= 0) return { usedBytes: null, maxBytes: null };
  const usageRoot = project.baseDir;
  await assertNoSymlinkPath(project.rootDir, usageRoot, { allowMissingTail: true });
  const usedBytes = await directorySize(usageRoot, { maxEntries: config.maxProjectUsageScanEntries });
  if (usedBytes > max) {
    throw new HttpError(413, "project_quota_exceeded", "Project storage quota exceeded.");
  }
  return { usedBytes, maxBytes: max };
}

export function resolveScopedPath(rootDir, rel = "") {
  if (typeof rel !== "string") throw new HttpError(400, "invalid_path", "path must be a string.");
  if (rel.includes("\0")) throw new HttpError(400, "invalid_path", "path contains a null byte.");
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
    throw new HttpError(400, "invalid_path", "absolute paths are not allowed.");
  }
  const normalized = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "../");
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.startsWith("../")) {
    throw new HttpError(403, "path_forbidden", "path escapes the workspace.");
  }
  const full = path.resolve(rootDir, normalized === "." ? "" : normalized);
  const root = path.resolve(rootDir);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new HttpError(403, "path_forbidden", "path escapes the workspace.");
  }
  return full;
}

export async function assertNoSymlinkPath(
  rootDir,
  targetPath,
  {
    allowMissingTail = false,
    missingCode = "file_not_found",
    missingMessage = "File not found.",
  } = {},
) {
  const root = path.resolve(rootDir);
  const full = path.resolve(targetPath);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new HttpError(403, "path_forbidden", "path escapes the workspace.");
  }
  try {
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink()) {
      throw new HttpError(403, "path_forbidden", "symbolic links are not allowed in hosted workspaces.");
    }
  } catch (err) {
    if (err?.code === "ENOENT" && allowMissingTail) return full;
    if (err?.code === "ENOENT") throw new HttpError(404, missingCode, missingMessage);
    throw err;
  }
  const rel = path.relative(root, full);
  if (!rel) return full;
  const parts = rel.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      if (err?.code === "ENOENT" && allowMissingTail) return full;
      if (err?.code === "ENOENT") throw new HttpError(404, missingCode, missingMessage);
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new HttpError(403, "path_forbidden", "symbolic links are not allowed in hosted workspaces.");
    }
  }
  return full;
}

async function ensureScopedFileParent(rootDir, file) {
  const dir = path.dirname(file);
  await assertNoSymlinkPath(rootDir, dir, { allowMissingTail: true });
  await ensureDir(dir);
  await assertNoSymlinkPath(rootDir, dir);
}

function noFollowFlags(flags) {
  // O_NONBLOCK so opening a FIFO returns instead of waiting for a writer.
  // Without it the type check below is unreachable: open() itself blocks, and
  // anyone who can run mkfifo in their own workspace can hang a request
  // indefinitely. On Linux the flag has no effect on regular files.
  return flags | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
}

function normalizeNoFollowError(err) {
  if (err?.code === "ELOOP" || err?.code === "ENOTDIR") {
    throw new HttpError(403, "path_forbidden", "symbolic links are not allowed in hosted workspaces.");
  }
  throw err;
}

async function openNoFollow(file, flags, mode) {
  try {
    return await fs.open(file, noFollowFlags(flags), mode);
  } catch (err) {
    normalizeNoFollowError(err);
  }
}

function scopedParts(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new HttpError(403, "path_forbidden", "path escapes the workspace.");
  }
  const rel = path.relative(root, target);
  return { root, target, parts: rel ? rel.split(path.sep).filter(Boolean) : [] };
}

function descriptorPath(handle) {
  return process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : null;
}

const deletedDescriptorSuffix = " (deleted)";

/** Resolve the path a descriptor was opened from.
 *  Atomically replacing a file unlinks the inode that an already-open handle
 *  holds, and realpath cannot resolve a descriptor whose inode has no link.
 *  Linux still records the path it was opened from, suffixed with " (deleted)",
 *  and nlink === 0 proves the inode really is unlinked, so a live file whose
 *  name merely ends in that suffix resolves above and never reaches the
 *  fallback. Without this the reader of any concurrently replaced file sees a
 *  spurious "no such file". */
async function descriptorRealPath(handle) {
  const descriptor = descriptorPath(handle);
  try {
    return await fs.realpath(descriptor);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const [link, stat] = await Promise.all([fs.readlink(descriptor), handle.stat()]);
  if (stat.nlink > 0 || !link.endsWith(deletedDescriptorSuffix)) {
    throw new HttpError(403, "path_forbidden", "opened file has no resolvable path.");
  }
  return link.slice(0, -deletedDescriptorSuffix.length);
}

async function assertHandleWithinRoot(rootDir, handle) {
  const stat = await handle.stat();
  if (process.platform === "linux") {
    const root = await fs.realpath(path.resolve(rootDir));
    const actual = await descriptorRealPath(handle);
    if (actual !== root && !actual.startsWith(root + path.sep)) {
      throw new HttpError(403, "path_forbidden", "opened file escapes the workspace.");
    }
  }
  // A second name for the same inode defeats every path-based check above: the
  // link inside the workspace resolves cleanly while the content belongs to a
  // file outside it. Containment is a property of the inode, not of the path we
  // happened to open it through, and a workspace has no legitimate hardlinks.
  // Directories are exempt — their nlink counts subdirectories.
  if (stat.isFile() && stat.nlink > 1) {
    throw new HttpError(403, "path_forbidden", "hard-linked files are not allowed in hosted workspaces.");
  }
  return stat;
}

async function openDirectoryPathNoFollow(directory) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0);
  const handle = await openNoFollow(directory, flags);
  const stat = await handle.stat();
  if (!stat.isDirectory()) {
    await handle.close();
    throw new HttpError(400, "not_a_directory", "path is not a directory.");
  }
  return handle;
}

export async function openScopedDirectoryNoFollow(rootDir, targetPath, { create = false } = {}) {
  const { root, target, parts } = scopedParts(rootDir, targetPath);
  if (process.platform !== "linux") {
    await assertNoSymlinkPath(root, target, { allowMissingTail: create });
    if (create) await ensureDir(target);
    await assertNoSymlinkPath(root, target);
    const handle = await openDirectoryPathNoFollow(target);
    await assertHandleWithinRoot(root, handle);
    return { handle, path: target, stat: await handle.stat() };
  }

  let handle = await openDirectoryPathNoFollow(root);
  try {
    await assertHandleWithinRoot(root, handle);
    for (const part of parts) {
      const childPath = path.join(descriptorPath(handle), part);
      if (create) {
        await fs.mkdir(childPath, { mode: 0o700 }).catch((err) => {
          if (err?.code !== "EEXIST") throw err;
        });
      }
      const child = await openDirectoryPathNoFollow(childPath);
      await assertHandleWithinRoot(root, child);
      await handle.close();
      handle = child;
    }
    const stat = await handle.stat();
    return { handle, path: descriptorPath(handle), stat };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

export async function openScopedFileNoFollow(
  rootDir,
  file,
  { flags = fsConstants.O_RDONLY, mode = 0o600, createParent = false } = {},
) {
  const { root, target } = scopedParts(rootDir, file);
  if (target === root) throw new HttpError(400, "not_a_file", "path is not a file.");
  const parent = await openScopedDirectoryNoFollow(root, path.dirname(target), { create: createParent });
  let handle;
  try {
    handle = await openNoFollow(path.join(parent.path, path.basename(target)), flags, mode);
    const stat = await assertHandleWithinRoot(root, handle);
    // Every caller here wants a regular file. A device node, socket or FIFO
    // reaching a reader would either block it or feed it something that is not
    // workspace content, so refuse it once here rather than in each caller.
    if (!stat.isFile()) throw new HttpError(400, "not_a_file", "path is not a regular file.");
    return { handle, stat };
  } catch (err) {
    await handle?.close().catch(() => {});
    throw err;
  } finally {
    await parent.handle.close();
  }
}

export async function readFileNoFollow(rootDir, file, options = undefined) {
  let opened;
  try {
    opened = await openScopedFileNoFollow(rootDir, file);
    if (!opened.stat.isFile()) throw new HttpError(400, "not_a_file", "path is not a file.");
    return await opened.handle.readFile(options);
  } finally {
    await opened?.handle.close();
  }
}

export async function writeFileAtomicNoFollow(rootDir, file, data, options = {}) {
  const { root, target } = scopedParts(rootDir, file);
  if (target === root) throw new HttpError(400, "not_a_file", "path is not a file.");
  const parent = await openScopedDirectoryNoFollow(root, path.dirname(target), { create: true });
  const filename = path.basename(target);
  const tmpName = `.${filename}.${process.pid}.${Date.now()}.${randomId("tmp_")}`;
  const tmpPath = path.join(parent.path, tmpName);
  const targetPath = path.join(parent.path, filename);
  let handle;
  try {
    handle = await openNoFollow(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      options.mode ?? 0o600,
    );
    await assertHandleWithinRoot(root, handle);
    await handle.writeFile(data, options.encoding ? { encoding: options.encoding } : undefined);
    await handle.sync();
    await handle.close();
    handle = null;
    const existing = await fs.lstat(targetPath).catch((err) => {
      if (err?.code === "ENOENT") return null;
      throw err;
    });
    if (existing?.isSymbolicLink()) {
      throw new HttpError(403, "path_forbidden", "symbolic links are not allowed in hosted workspaces.");
    }
    if (existing && !existing.isFile()) {
      throw new HttpError(400, "not_a_file", "path is not a file.");
    }
    await fs.rename(tmpPath, targetPath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    await parent.handle.close();
  }
}

/** Atomically create a new scoped file without replacing an existing entry.
 *  A hard-link commit gives us rename-like atomic visibility plus O_EXCL
 *  semantics, which the example installer needs to preserve user edits. */
export async function writeFileExclusiveNoFollow(rootDir, file, data, options = {}) {
  const { root, target } = scopedParts(rootDir, file);
  if (target === root) throw new HttpError(400, "not_a_file", "path is not a file.");
  const parent = await openScopedDirectoryNoFollow(root, path.dirname(target), { create: true });
  const filename = path.basename(target);
  const tmpName = `.${filename}.${process.pid}.${Date.now()}.${randomId("new_")}`;
  const tmpPath = path.join(parent.path, tmpName);
  const targetPath = path.join(parent.path, filename);
  let handle;
  try {
    handle = await openNoFollow(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      options.mode ?? 0o600,
    );
    await assertHandleWithinRoot(root, handle);
    await handle.writeFile(data, options.encoding ? { encoding: options.encoding } : undefined);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(tmpPath, targetPath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    await parent.handle.close();
  }
}

/** Reads the file as text. readFileNoFollow is typed by its options argument,
 *  which TypeScript cannot narrow through a variable, so state the result here
 *  rather than at every call site.
 *  @returns {Promise<string>} */
export async function readTextFileNoFollow(rootDir, file, fallback = "") {
  try {
    return /** @type {string} */ (/** @type {unknown} */ (await readFileNoFollow(rootDir, file, "utf8")));
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "file_not_found") return fallback;
    throw err;
  }
}

/** @param {string} rootDir @param {string} file @param {any} value */
export async function writeJsonFileAtomicNoFollow(rootDir, file, value) {
  await writeFileAtomicNoFollow(rootDir, file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function unlinkRotationTargetNoFollow(rootDir, file) {
  await assertNoSymlinkPath(rootDir, file, { allowMissingTail: true });
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new HttpError(403, "path_forbidden", "symbolic links are not allowed in hosted workspaces.");
  }
  if (!stat.isFile()) {
    throw new HttpError(403, "path_forbidden", "log rotation targets must be regular files.");
  }
  await fs.unlink(file);
}

async function rotateJsonLineFileIfNeeded(rootDir, file, incomingBytes, maxBytes) {
  const limit = Number(maxBytes);
  if (!Number.isFinite(limit) || limit <= 0) return;
  await assertNoSymlinkPath(rootDir, file, { allowMissingTail: true });
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new HttpError(403, "path_forbidden", "symbolic links are not allowed in hosted workspaces.");
  }
  if (!stat.isFile()) {
    throw new HttpError(403, "path_forbidden", "log files must be regular files.");
  }
  if (stat.size === 0 || stat.size + incomingBytes <= limit) return;
  const rotated = `${file}.1`;
  await unlinkRotationTargetNoFollow(rootDir, rotated);
  await fs.rename(file, rotated);
  await assertNoSymlinkPath(rootDir, rotated);
}

export async function appendJsonLineNoFollow(rootDir, file, record, options = {}) {
  await ensureScopedFileParent(rootDir, file);
  await assertNoSymlinkPath(rootDir, file, { allowMissingTail: true });
  const line = `${JSON.stringify(record)}\n`;
  await rotateJsonLineFileIfNeeded(rootDir, file, Buffer.byteLength(line), options.maxBytes);
  // Open through the scoped opener rather than the raw path string. Checking
  // the path and then opening it by name is a check-then-use on every
  // intermediate directory; the scoped opener walks the tree by descriptor and
  // re-asserts containment on the handle it actually got.
  const opened = await openScopedFileNoFollow(rootDir, file, {
    flags: fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY,
  });
  try {
    await opened.handle.writeFile(line);
  } finally {
    await opened.handle.close();
  }
}

const textExtensions = new Set([
  ".txt", ".md", ".json", ".jsonl", ".csv", ".tsv", ".py", ".r", ".js", ".mjs", ".ts",
  ".tsx", ".css", ".html", ".xml", ".yaml", ".yml", ".toml", ".rs", ".sh", ".ipynb",
]);

export function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".ipynb":
      return "application/json; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return textExtensions.has(ext) ? "text/plain; charset=utf-8" : "application/octet-stream";
  }
}

export function isTextFile(filePath) {
  return textExtensions.has(path.extname(filePath).toLowerCase());
}

export function scopedDisplayPath(project, rel = "") {
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  return `/workspace/${project.id}${clean ? `/${clean}` : ""}`;
}

export function apiBaseFromRequest(req, config) {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `${proto}://${host}`;
}

export function encodeBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}
