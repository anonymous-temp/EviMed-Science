/** Request-scoped supplements for native inputs. Envelopes live outside the runtime workspace. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nativeInputText } from "@evimed/harness-port";
import { HttpError, openScopedDirectoryNoFollow, openScopedFileNoFollow, withProjectStorageMutation, writeFileAtomicNoFollow } from "./security.mjs";
import { MAX_HANDBOOK_PROMPT_BYTES } from "./capabilityHandbooks.mjs";

const DIRECTORY = "native-handbooks";
const MAX_ENVELOPES = 256;
const MAX_FILE_BYTES = 32_768;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const textDigest = (value) => digest(String(value));
const routeDigest = (value) => textDigest(String(value).replace(/\s+/g, " ").trim());
const validRequestId = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const validSession = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const routeFields = ["effectiveAgentId", "effectiveAgentVersion", "effectiveRuntimeAgent", "effectiveRouteReason", "estimatedMinutes"];

export class NativeHandbookContext {
  /** @param {{route:(project:any,sessionId:string,text:string)=>Promise<any>,select:(project:any,session:any,route:any)=>Promise<any>,
   * budget:(project:any)=>number,allowed?:(project:any,sessionId:string)=>Promise<boolean>,attached?:(project:any,sessionId:string,requestIds:string[])=>Promise<any>,now?:()=>number,ttlMs?:number,timeoutMs?:number}} options */
  constructor({ route, select, budget, allowed = async () => true, attached = async () => {}, now = () => Date.now(), ttlMs = 24 * 60 * 60_000, timeoutMs = 5000 }) {
    this.route = route; this.select = select; this.budget = budget; this.allowed = allowed; this.attached = attached;
    this.now = now; this.ttlMs = ttlMs; this.timeoutMs = timeoutMs;
    this.preparing = new Map();
  }

  /** @param {any} project @param {string} sessionId @param {string} requestId @param {boolean} [receipt] */
  file(project, sessionId, requestId, receipt = false) {
    const key = digest(JSON.stringify([project.userId, project.id, sessionId, requestId]));
    return path.join(project.metaDir, DIRECTORY, `${key}${receipt ? ".receipt" : ""}.json`);
  }

  async readFile(project, file) {
    let opened;
    try { opened = await openScopedFileNoFollow(project.rootDir, file); }
    catch (error) { if (["ENOENT", "file_not_found", "directory_not_found"].includes(error?.code)) return null; throw error; }
    try {
      if (opened.stat.size > MAX_FILE_BYTES) throw new HttpError(413, "handbook_context_invalid", "The request context is too large.");
      return JSON.parse(await opened.handle.readFile("utf8"));
    } finally { await opened.handle.close(); }
  }

  async envelope(project, sessionId, requestId) {
    if (!validSession(sessionId) || !validRequestId(requestId)) return null;
    const value = await this.readFile(project, this.file(project, sessionId, requestId));
    return value?.ownerId === project.userId && value?.projectId === project.id && value?.sessionId === sessionId
      && value?.requestId === requestId && value.expiresAt > this.now() ? value : null;
  }

  /** Prune only this server-owned namespace and bound the number of pending inputs. */
  async prune(project) {
    const directory = path.join(project.metaDir, DIRECTORY);
    const opened = await openScopedDirectoryNoFollow(project.rootDir, directory, { create: true });
    let entries;
    try { entries = await fs.readdir(opened.path); } finally { await opened.handle.close(); }
    let count = 0;
    for (const name of entries.filter(entry => /^[a-f0-9]{64}\.json$/.test(entry))) {
      const file = path.join(directory, name);
      const value = await this.readFile(project, file);
      if (value && value.expiresAt <= this.now()) {
        await fs.rm(file, { force: true });
        await fs.rm(file.replace(/\.json$/, ".receipt.json"), { force: true });
      } else count += 1;
    }
    if (count >= MAX_ENVELOPES) throw new HttpError(503, "handbook_context_limit", "The request context limit is reached.");
  }

  /** Freeze before forwarding, never write to a shared session context file. */
  async prepare(project, request) {
    if (!validSession(request?.sessionId) || !validRequestId(request?.requestId)) return null;
    if (!await this.allowed(project, request.sessionId)) return null;
    const fingerprint = digest(JSON.stringify(request));
    const key = this.file(project, request.sessionId, request.requestId);
    const pending = this.preparing.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new HttpError(409, "handbook_request_conflict", "This request identity already names another input.");
      return pending.promise;
    }
    if (this.preparing.size >= MAX_ENVELOPES) throw new HttpError(503, "handbook_context_limit", "Supplement preparation is busy.");
    const promise = this.freeze(project, request, fingerprint);
    this.preparing.set(key, { fingerprint, promise });
    try { return await promise; } finally { this.preparing.delete(key); }
  }

  async freeze(project, request, fingerprint) {
    const existing = await this.envelope(project, request.sessionId, request.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new HttpError(409, "handbook_request_conflict", "This request identity already names another input.");
      return existing;
    }
    let canceled = false;
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      canceled = true; reject(new HttpError(503, "handbook_context_timeout", "Supplement preparation timed out."));
    }, this.timeoutMs); });
    const freeze = async () => {
      const text = nativeInputText(request.content);
      const route = await this.route(project, request.sessionId, text);
      const selected = await this.select(project, { sessionId: request.sessionId }, route);
      if (canceled) return null;
      const context = String(selected?.context ?? "");
      if (Buffer.byteLength(context) > Math.min(MAX_HANDBOOK_PROMPT_BYTES, Math.max(0, this.budget(project)))) {
        throw new HttpError(413, "handbook_context_limit", "The supplement exceeds the current prompt allowance.");
      }
      const envelope = { ownerId: project.userId, projectId: project.id, sessionId: request.sessionId, requestId: request.requestId,
        fingerprint, textDigest: textDigest(text), routeTextDigest: routeDigest(text),
        route: Object.fromEntries(routeFields.filter(key => route?.[key] !== undefined).map(key => [key, route[key]])),
        context, items: selected?.items ?? [], preparedAt: this.now(), expiresAt: this.now() + this.ttlMs };
      const value = { ...envelope, digest: digest(JSON.stringify(envelope)) };
      const bytes = JSON.stringify(value);
      if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw new HttpError(413, "handbook_context_limit", "The request context is too large.");
      return withProjectStorageMutation(project, async () => {
        if (canceled) return null;
        const current = await this.envelope(project, request.sessionId, request.requestId);
        if (current) {
          if (current.fingerprint !== fingerprint) throw new HttpError(409, "handbook_request_conflict", "This request identity already names another input.");
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

  /** Read only actual current-step input identities, within one combined context allowance. */
  async read(project, { sessionId, inputs }) {
    if (!validSession(sessionId) || !Array.isArray(inputs) || inputs.length > 16) throw new HttpError(400, "handbook_request_invalid", "Invalid current inputs.");
    if (!await this.allowed(project, sessionId)) return { contexts: [] };
    const contexts = [];
    let bytes = 0;
    const allowance = Math.min(MAX_HANDBOOK_PROMPT_BYTES, Math.max(0, this.budget(project)));
    for (const input of inputs) {
      const envelope = await this.envelope(project, sessionId, input?.requestId);
      if (!envelope || envelope.textDigest !== input.textDigest || !envelope.context || contexts.some(item => item.requestId === input.requestId)) continue;
      const size = Buffer.byteLength(envelope.context) + 1;
      if (bytes + size > allowance) continue;
      await withProjectStorageMutation(project, async () => {
        const receiptFile = this.file(project, sessionId, input.requestId, true);
        const receipt = await this.readFile(project, receiptFile);
        if (receipt?.digest !== envelope.digest) await writeFileAtomicNoFollow(project.rootDir, receiptFile,
          JSON.stringify({ digest: envelope.digest, offeredAt: this.now() }), { mode: 0o600 });
      });
      contexts.push({ requestId: input.requestId, digest: envelope.digest, context: envelope.context });
      bytes += size;
    }
    return { contexts };
  }

  /** An entering pre-step confirms actual injection. Preparing or reading alone never counts as attachment. */
  async acknowledge(project, { sessionId, receipts }) {
    if (!validSession(sessionId) || !Array.isArray(receipts) || receipts.length > 16) throw new HttpError(400, "handbook_request_invalid", "Invalid context receipts.");
    const attached = [];
    for (const input of receipts) {
      await withProjectStorageMutation(project, async () => {
        const envelope = await this.envelope(project, sessionId, input?.requestId);
        const receiptFile = this.file(project, sessionId, input?.requestId, true);
        const receipt = await this.readFile(project, receiptFile);
        if (!envelope || envelope.digest !== input.digest || receipt?.digest !== envelope.digest) {
          throw new HttpError(409, "handbook_receipt_mismatch", "This receipt does not name offered context.");
        }
        if (!receipt.attachedAt) await writeFileAtomicNoFollow(project.rootDir, receiptFile,
          JSON.stringify({ ...receipt, attachedAt: this.now() }), { mode: 0o600 });
        attached.push(input.requestId);
      });
    }
    if (attached.length) await this.attached(project, sessionId, attached);
    return { attached };
  }

  /** The immutable route can be reused when the committed input becomes a run. */
  async routeFor(project, sessionId, requestIds, text) {
    for (const requestId of (requestIds ?? []).slice(0, 16)) {
      const envelope = await this.envelope(project, sessionId, requestId);
      if (envelope?.routeTextDigest === routeDigest(text)) return envelope.route;
    }
    return null;
  }

  /** Return only confirmed attachments consumed by this owner/capability run. */
  async receipts(project, run) {
    const items = [];
    for (const requestId of (run.kernelRequestIds ?? []).slice(0, 32)) {
      const envelope = await this.envelope(project, run.sessionId, requestId);
      if (!envelope || envelope.route.effectiveAgentId !== run.effectiveAgentId) continue;
      const receipt = await this.readFile(project, this.file(project, run.sessionId, requestId, true));
      if (!receipt?.attachedAt || receipt.digest !== envelope.digest) continue;
      for (const item of envelope.items) if (item.ownerId === project.userId && item.capabilityId === run.effectiveAgentId
        && !items.some(other => other.id === item.id && other.contentDigest === item.contentDigest)) items.push({ ...item, requestId });
    }
    return items;
  }
}
