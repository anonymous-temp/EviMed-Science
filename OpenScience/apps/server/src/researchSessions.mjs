import path from "node:path";
import {
  HttpError,
  openScopedFileNoFollow,
  safeId,
  withProjectStorageMutation,
  writeJsonFileAtomicNoFollow,
} from "./security.mjs";

const stateFileName = "research-sessions.json";
const modes = new Set(["open-domain", "specialist"]);
const inputFields = new Set(["mode", "agentId", "agentVersion"]);
const maxResearchSessions = 1000;
const maxStateBytes = 1024 * 1024;
/** What a conversation's source scope may hold: knowledge-base documents by id, as many as `kb_search` takes. */
export const MAX_SOURCE_SCOPE = 50;
const sourceIdPattern = /^src_[a-f0-9]{32}$/;

function invalid(message) {
  return new HttpError(400, "invalid_research_session", message);
}

function stateFile(project) {
  return path.join(project.metaDir, stateFileName);
}

function validateTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(500, "research_sessions_corrupt", `${label} is invalid.`);
  }
  return value;
}

/**
 * A conversation's source scope as it is stored: the documents it is limited to, or null for all of them.
 * @param {unknown} value
 * @returns {readonly string[] | null}
 */
export function storedSourceScope(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > MAX_SOURCE_SCOPE || value.some((id) => typeof id !== "string" || !sourceIdPattern.test(id))) {
    throw new HttpError(500, "research_sessions_corrupt", "A research session's source scope is invalid.");
  }
  return value.length ? Object.freeze([...new Set(value)]) : null;
}

/**
 * A source scope as a request states it: a list of document ids, or an empty one to go back to all of them.
 * @param {unknown} value
 * @returns {readonly string[] | null}
 */
export function requestedSourceScope(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > MAX_SOURCE_SCOPE || value.some((id) => typeof id !== "string" || !sourceIdPattern.test(id))) {
    throw invalid(`sourceIds must be at most ${MAX_SOURCE_SCOPE} document ids (src_…).`);
  }
  return value.length ? Object.freeze([...new Set(value)].sort()) : null;
}

function validateStoredRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(500, "research_sessions_corrupt", "A research session record is invalid.");
  }
  const sessionId = safeId(value.sessionId, "research session id");
  if (!modes.has(value.mode)) {
    throw new HttpError(500, "research_sessions_corrupt", "A research session mode is invalid.");
  }
  if (value.mode === "open-domain") {
    if (value.agentId !== null || value.agentVersion !== null || value.runtimeAgent !== null) {
      throw new HttpError(500, "research_sessions_corrupt", "An open-domain session contains an agent pin.");
    }
  } else if (
    typeof value.agentId !== "string" ||
    typeof value.agentVersion !== "string" ||
    typeof value.runtimeAgent !== "string"
  ) {
    throw new HttpError(500, "research_sessions_corrupt", "A specialist session is missing its agent pin.");
  }
  return Object.freeze({
    sessionId,
    mode: value.mode,
    agentId: value.agentId,
    agentVersion: value.agentVersion,
    runtimeAgent: value.runtimeAgent,
    sourceScope: storedSourceScope(value.sourceScope),
    createdAt: validateTimestamp(value.createdAt, "createdAt"),
    updatedAt: validateTimestamp(value.updatedAt, "updatedAt"),
  });
}

async function readState(project) {
  const text = await readStateText(project);
  if (!text) return { version: 1, sessions: [] };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(500, "research_sessions_corrupt", "Research session metadata is not valid JSON.");
  }
  if (!value || typeof value !== "object" || value.version !== 1 || !Array.isArray(value.sessions)) {
    throw new HttpError(500, "research_sessions_corrupt", "Research session metadata has an unsupported shape.");
  }
  const sessions = value.sessions.map(validateStoredRecord);
  if (new Set(sessions.map((record) => record.sessionId)).size !== sessions.length) {
    throw new HttpError(500, "research_sessions_corrupt", "Research session metadata contains duplicate session ids.");
  }
  return { version: 1, sessions };
}

async function readStateText(project) {
  let opened;
  try {
    opened = await openScopedFileNoFollow(project.metaDir, stateFile(project));
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
  try {
    if (!opened.stat.isFile()) throw new HttpError(400, "not_a_file", "Research session state is not a file.");
    if (opened.stat.size > maxStateBytes) {
      throw new HttpError(413, "research_sessions_too_large", "Research session metadata exceeds its size limit.");
    }
    const chunks = [];
    let total = 0;
    while (total <= maxStateBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxStateBytes + 1 - total));
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxStateBytes) {
      throw new HttpError(413, "research_sessions_too_large", "Research session metadata exceeds its size limit.");
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await opened.handle.close();
  }
}

function assertSerializedStateSize(value) {
  const bytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes > maxStateBytes) {
    throw new HttpError(413, "research_sessions_too_large", "Research session metadata exceeds its size limit.");
  }
}

function validateInputContract(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("Research session binding must be an object.");
  }
  const unknown = Object.keys(input).filter((field) => !inputFields.has(field));
  if (unknown.length > 0) throw invalid(`Unknown research session field(s): ${unknown.sort().join(", ")}.`);
  if (!modes.has(input.mode)) throw invalid('mode must be "open-domain" or "specialist".');

  if (input.mode === "open-domain") {
    if (input.agentId != null || input.agentVersion != null) {
      throw invalid("Open-domain sessions must not contain an agent id or version.");
    }
    return { mode: "open-domain", agentId: null, agentVersion: null };
  }

  if (typeof input.agentId !== "string" || typeof input.agentVersion !== "string") {
    throw invalid("Specialist sessions require agentId and agentVersion.");
  }
  return { mode: "specialist", agentId: input.agentId, agentVersion: input.agentVersion };
}

function validateSelection(input, registry) {
  const request = validateInputContract(input);
  if (request.mode === "open-domain") {
    return { ...request, runtimeAgent: null };
  }
  const agent = registry.get(request.agentId);
  if (!agent) throw new HttpError(404, "agent_not_found", "Research agent not found.");
  if (agent.version !== request.agentVersion) {
    throw new HttpError(409, "agent_version_mismatch", "Research agent version is no longer current.");
  }
  return {
    mode: "specialist",
    agentId: agent.id,
    agentVersion: agent.version,
    runtimeAgent: agent.runtimeAgent,
  };
}

function identityConflict() {
  return new HttpError(
    409,
    "research_session_identity_conflict",
    "Research session identity cannot change after it is created.",
  );
}

export class ResearchSessionStore {
  constructor(agentRegistry, { stateStore = null } = {}) {
    this.agentRegistry = Promise.resolve(agentRegistry);
    this.stateStore = stateStore;
    /**
     * Told when a conversation is bound to a specialist, so the binding reaches the runtime as a file
     * (`runtimeManager.writeSessionBinding`). Set by the server once the runtime manager exists; never fails a binding.
     * @type {((project: any, sessionId: string, agentId: string) => Promise<unknown>) | null}
     */
    this.onSpecialistBound = null;
  }

  async list(project) {
    if (typeof this.stateStore?.listResearchSessions === "function") {
      return this.stateStore.listResearchSessions(project);
    }
    const state = await readState(project);
    return [...state.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(project, rawSessionId) {
    const sessionId = safeId(rawSessionId, "research session id");
    if (typeof this.stateStore?.getResearchSession === "function") {
      return this.stateStore.getResearchSession(project, sessionId);
    }
    const state = await readState(project);
    return state.sessions.find((record) => record.sessionId === sessionId) ?? null;
  }

  async put(project, rawSessionId, input) {
    const record = await this.putRecord(project, rawSessionId, input);
    if (record?.mode === "specialist" && record.agentId && this.onSpecialistBound) {
      const bound = this.onSpecialistBound;
      await Promise.resolve().then(() => bound(project, record.sessionId, record.agentId)).catch(() => null);
    }
    return record;
  }

  async putRecord(project, rawSessionId, input) {
    const sessionId = safeId(rawSessionId, "research session id");
    const registry = await this.agentRegistry;
    const request = validateInputContract(input);
    if (typeof this.stateStore?.putResearchSession === "function") {
      const existing = await this.stateStore.getResearchSession(project, sessionId);
      if (
        existing &&
        (
          existing.mode !== request.mode ||
          existing.agentId !== request.agentId ||
          existing.agentVersion !== request.agentVersion
        )
      ) {
        throw identityConflict();
      }
      const selection = validateSelection(request, registry);
      if (existing && existing.runtimeAgent !== selection.runtimeAgent) throw identityConflict();
      const now = new Date().toISOString();
      return this.stateStore.putResearchSession(project, {
        sessionId,
        ...selection,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }, { maximum: maxResearchSessions });
    }
    return withProjectStorageMutation(project, async () => {
      const state = await readState(project);
      const existing = state.sessions.find((record) => record.sessionId === sessionId);
      if (!existing && state.sessions.length >= maxResearchSessions) {
        throw new HttpError(
          409,
          "research_session_limit_reached",
          "This project has reached its research session metadata limit.",
        );
      }
      if (
        existing &&
        (
          existing.mode !== request.mode ||
          existing.agentId !== request.agentId ||
          existing.agentVersion !== request.agentVersion
        )
      ) {
        throw identityConflict();
      }
      const selection = validateSelection(request, registry);
      if (existing && existing.runtimeAgent !== selection.runtimeAgent) throw identityConflict();
      const now = new Date().toISOString();
      const record = Object.freeze({
        sessionId,
        ...selection,
        sourceScope: existing?.sourceScope ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      const sessions = state.sessions.filter((item) => item.sessionId !== sessionId);
      sessions.push(record);
      sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const nextState = { version: 1, sessions };
      assertSerializedStateSize(nextState);
      await writeJsonFileAtomicNoFollow(project.metaDir, stateFile(project), nextState);
      return record;
    });
  }

  /**
   * Limits one conversation to the knowledge-base documents named, or lifts the limit (null / an empty list). The
   * conversation's research session is made first when it has none — a conversation opened from the knowledge base is
   * scoped before it has asked anything — as an open-domain one, which is what an unbound conversation is.
   * Only the scope changes: the session's identity (its mode and agent) is never touched here.
   * @param {any} project @param {string} rawSessionId @param {unknown} sourceIds
   * @returns {Promise<any>} the session as it now stands
   */
  async setSourceScope(project, rawSessionId, sourceIds) {
    const sessionId = safeId(rawSessionId, "research session id");
    const scope = requestedSourceScope(sourceIds);
    if (!(await this.get(project, sessionId))) await this.putRecord(project, sessionId, { mode: "open-domain" });
    if (typeof this.stateStore?.setResearchSessionSourceScope === "function") {
      return this.stateStore.setResearchSessionSourceScope(project, sessionId, scope);
    }
    return withProjectStorageMutation(project, async () => {
      const state = await readState(project);
      const existing = state.sessions.find((record) => record.sessionId === sessionId);
      if (!existing) throw new HttpError(404, "research_session_not_found", "Research session not found.");
      const record = Object.freeze({ ...existing, sourceScope: scope, updatedAt: new Date().toISOString() });
      const sessions = [...state.sessions.filter((item) => item.sessionId !== sessionId), record];
      sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const nextState = { version: 1, sessions };
      assertSerializedStateSize(nextState);
      await writeJsonFileAtomicNoFollow(project.metaDir, stateFile(project), nextState);
      return record;
    });
  }
}
