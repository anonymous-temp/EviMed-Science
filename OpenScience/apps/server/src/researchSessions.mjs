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
}
