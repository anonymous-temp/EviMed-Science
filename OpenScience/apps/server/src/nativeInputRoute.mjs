/**
 * The route of an input typed in the kernel's own window, frozen when the prompt is prepared and read back when the committed input becomes a run.
 *
 * Hidden knowledge: this was `nativeHandbookContext.mjs`, which froze two things in one envelope — the route the input would take (the capability
 * it goes to, its version and reason) and the account's capability handbooks selected for that capability, to be injected into the step that
 * claims the input. The handbooks are gone (nothing files one any more, 2026-10-25); the route is not. Two readers need it and neither can compute
 * it late: the capsule plugin's `evimedNativeRoute` service tells the run policy which capability the current input belongs to, and the adoption of
 * the turn files the run under that same capability (`routeFor`). A route computed again at adoption could read another capability than the one the
 * plan was made under, because routing reads the conversation as it stands and the conversation has moved on.
 *
 * So the envelope is the route and the identity of the input it belongs to — the session, the request, the digest of the text and of the whole
 * thing — and nothing else. It lives outside the runtime workspace, in the project's own meta directory, expires after a day, is bounded in number,
 * and is addressed only by the signed-in project's own session and request ids (the same checks the handbook envelope had).
 *
 * @module nativeInputRoute
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nativeInputText } from "@evimed/harness-port";
import { HttpError, openScopedDirectoryNoFollow, openScopedFileNoFollow, withProjectStorageMutation, writeFileAtomicNoFollow } from "./security.mjs";

const DIRECTORY = "native-routes";
/** Where the envelopes of the handbook arm were kept: one-day files nothing reads any more, taken off with the first prune. */
const RETIRED_DIRECTORY = "native-handbooks";
const MAX_ENVELOPES = 256;
const MAX_FILE_BYTES = 32_768;
const digest = (/** @type {string} */ value) => createHash("sha256").update(value).digest("hex");
const textDigest = (/** @type {unknown} */ value) => digest(String(value));
const routeDigest = (/** @type {unknown} */ value) => textDigest(String(value).replace(/\s+/g, " ").trim());
const validRequestId = (/** @type {unknown} */ value) => typeof value === "string" && value.length > 0 && value.length <= 512 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const validSession = (/** @type {unknown} */ value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const routeFields = ["effectiveAgentId", "effectiveAgentVersion", "effectiveRuntimeAgent", "effectiveRouteReason", "estimatedMinutes"];

export class NativeInputRoute {
  /** @param {{route:(project:any,sessionId:string,text:string)=>Promise<any>,allowed?:(project:any,sessionId:string)=>Promise<boolean>,now?:()=>number,ttlMs?:number,timeoutMs?:number}} options */
  constructor({ route, allowed = async () => true, now = () => Date.now(), ttlMs = 24 * 60 * 60_000, timeoutMs = 5000 }) {
    this.route = route; this.allowed = allowed;
    this.now = now; this.ttlMs = ttlMs; this.timeoutMs = timeoutMs;
    /** @type {Map<string, { fingerprint: string, promise: Promise<any> }>} */
    this.preparing = new Map();
  }

  /** @param {any} project @param {string} sessionId @param {string} requestId */
  file(project, sessionId, requestId) {
    const key = digest(JSON.stringify([project.userId, project.id, sessionId, requestId]));
    return path.join(project.metaDir, DIRECTORY, `${key}.json`);
  }

  /** @param {any} project @param {string} file */
  async readFile(project, file) {
    let opened;
    try { opened = await openScopedFileNoFollow(project.rootDir, file); }
    catch (error) { if (["ENOENT", "file_not_found", "directory_not_found"].includes(/** @type {any} */ (error)?.code)) return null; throw error; }
    try {
      if (opened.stat.size > MAX_FILE_BYTES) throw new HttpError(413, "native_route_invalid", "The request route is too large.");
      return JSON.parse(await opened.handle.readFile("utf8"));
    } finally { await opened.handle.close(); }
  }

  /** @param {any} project @param {string} sessionId @param {string} requestId */
  async envelope(project, sessionId, requestId) {
    if (!validSession(sessionId) || !validRequestId(requestId)) return null;
    const value = await this.readFile(project, this.file(project, sessionId, requestId));
    return value?.ownerId === project.userId && value?.projectId === project.id && value?.sessionId === sessionId
      && value?.requestId === requestId && value.expiresAt > this.now() ? value : null;
  }

  /** Prune only this server-owned namespace and bound the number of pending inputs. @param {any} project */
  async prune(project) {
    // What the handbook arm left here is a directory of one-day files that nothing reads: removed, as a link is, never followed.
    await fs.rm(path.join(project.metaDir, RETIRED_DIRECTORY), { recursive: true, force: true }).catch(() => {});
    const directory = path.join(project.metaDir, DIRECTORY);
    const opened = await openScopedDirectoryNoFollow(project.rootDir, directory, { create: true });
    let entries;
    try { entries = await fs.readdir(opened.path); } finally { await opened.handle.close(); }
    let count = 0;
    for (const name of entries.filter(entry => /^[a-f0-9]{64}\.json$/.test(entry))) {
      const file = path.join(directory, name);
      const value = await this.readFile(project, file);
      if (value && value.expiresAt <= this.now()) await fs.rm(file, { force: true });
      else count += 1;
    }
    if (count >= MAX_ENVELOPES) throw new HttpError(503, "native_route_limit", "The request route limit is reached.");
  }

  /**
   * Freeze before forwarding, never write to a shared session context file. A steer continues the current turn's route: reclassifying a short
   * correction here could send it to another capability, so a steer freezes nothing and the next queued turn gets its own.
   * @param {any} project @param {any} request
   */
  async prepare(project, request) {
    if (request?.mode === "steer") return null;
    if (!validSession(request?.sessionId) || !validRequestId(request?.requestId)) return null;
    if (!await this.allowed(project, request.sessionId)) return null;
    const fingerprint = digest(JSON.stringify(request));
    const key = this.file(project, request.sessionId, request.requestId);
    const pending = this.preparing.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new HttpError(409, "native_route_conflict", "This request identity already names another input.");
      return pending.promise;
    }
    if (this.preparing.size >= MAX_ENVELOPES) throw new HttpError(503, "native_route_limit", "Route preparation is busy.");
    const promise = this.freeze(project, request, fingerprint);
    this.preparing.set(key, { fingerprint, promise });
    try { return await promise; } finally { this.preparing.delete(key); }
  }

  /** @param {any} project @param {any} request @param {string} fingerprint */
  async freeze(project, request, fingerprint) {
    const existing = await this.envelope(project, request.sessionId, request.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new HttpError(409, "native_route_conflict", "This request identity already names another input.");
      return existing;
    }
    let canceled = false;
    /** @type {any} */
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      canceled = true; reject(new HttpError(503, "native_route_timeout", "Route preparation timed out."));
    }, this.timeoutMs); });
    const freeze = async () => {
      const text = nativeInputText(request.content);
      const route = await this.route(project, request.sessionId, text);
      if (canceled) return null;
      const envelope = { ownerId: project.userId, projectId: project.id, sessionId: request.sessionId, requestId: request.requestId,
        fingerprint, textDigest: textDigest(text), routeTextDigest: routeDigest(text),
        route: Object.fromEntries(routeFields.filter(key => route?.[key] !== undefined).map(key => [key, route[key]])),
        preparedAt: this.now(), expiresAt: this.now() + this.ttlMs };
      const value = { ...envelope, digest: digest(JSON.stringify(envelope)) };
      const bytes = JSON.stringify(value);
      if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw new HttpError(413, "native_route_invalid", "The request route is too large.");
      return withProjectStorageMutation(project, async () => {
        if (canceled) return null;
        const current = await this.envelope(project, request.sessionId, request.requestId);
        if (current) {
          if (current.fingerprint !== fingerprint) throw new HttpError(409, "native_route_conflict", "This request identity already names another input.");
          return current;
        }
        await this.prune(project);
        if (canceled) return null;
        await writeFileAtomicNoFollow(project.rootDir, this.file(project, request.sessionId, request.requestId), bytes, { mode: 0o600 });
        return value;
      });
    };
    try { return await Promise.race([freeze(), timeout]); } finally { clearTimeout(timer); }
  }

  /**
   * The routes of the actual current-step inputs, by identity: an input whose text is not the one that was frozen is not answered.
   * @param {any} project @param {{ sessionId: string, inputs: any[] }} request
   * @returns {Promise<{ routes: { requestId: string, textDigest: string, digest: string, route: any }[] }>}
   */
  async read(project, { sessionId, inputs }) {
    if (!validSession(sessionId) || !Array.isArray(inputs) || inputs.length > 16) throw new HttpError(400, "native_route_request_invalid", "Invalid current inputs.");
    if (!await this.allowed(project, sessionId)) return { routes: [] };
    const routes = [];
    for (const input of inputs) {
      const envelope = await this.envelope(project, sessionId, input?.requestId);
      if (!envelope || envelope.textDigest !== input.textDigest || routes.some(item => item.requestId === input.requestId)) continue;
      routes.push({ requestId: input.requestId, textDigest: envelope.textDigest, digest: envelope.digest, route: envelope.route });
    }
    return { routes };
  }

  /**
   * The immutable route can be reused when the committed input becomes a run.
   * @param {any} project @param {string} sessionId @param {string[] | null | undefined} requestIds @param {string} text
   */
  async routeFor(project, sessionId, requestIds, text) {
    for (const requestId of (requestIds ?? []).slice(0, 16)) {
      const envelope = await this.envelope(project, sessionId, requestId);
      if (envelope?.routeTextDigest === routeDigest(text)) return envelope.route;
    }
    return null;
  }
}
