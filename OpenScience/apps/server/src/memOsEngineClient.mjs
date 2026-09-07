import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "./security.mjs";

/** @typedef {{memOsBaseUrl: string, memOsTimeoutMs?: number, memOsMaxRequestBytes?: number, memOsMaxResponseBytes?: number, memOsWriteMode?: "async"|"sync-fast"}} MemOsConfig */
/** @typedef {{accountCreatedAt: string, projectId?: string, capsuleId?: string}} ScopeOptions */
/** @typedef {{entryId: string, content: string, provenanceIds?: string[], revision?: number}} MemOsInputRecord */
/** @typedef {{entryId: string, memoryIds: string[], taskId: string|null}} MemOsReceipt */
/** @typedef {{id: string, content: string, cubeId: string, entryId: string|null, provenanceIds: string[], refId: string|null, memoryType: string|null, status: string|null, revision: number|null, rank: number}} MemOsRecord */

const inputCode = "mem_os_payload_invalid";
const responseCode = "mem_os_response_invalid";
const taskStates = new Set(["waiting", "in_progress", "completed", "failed", "cancelled"]);

function failure(code, message, status = 502) {
  return new HttpError(status, code, message);
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {number} maxBytes @param {string} [code] @returns {string} */
function text(value, maxBytes, code = inputCode) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maxBytes || value.includes("\0")) {
    throw failure(code, "MemOS received an invalid text field.", code === inputCode ? 400 : 502);
  }
  return value;
}

function integer(value, min, max, code = inputCode) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw failure(code, "MemOS received an invalid numeric limit.", code === inputCode ? 400 : 502);
  }
  return value;
}

/** @param {unknown} value @param {string[]} keys */
function fields(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw failure(inputCode, "MemOS payload contains unsupported fields.", 400);
  }
}

/**
 * Scope is built from authenticated account/project IDs, never request-body IDs.
 * JSON tuples distinguish account scope from projects and avoid delimiter collisions.
 * Account creation time is part of the principal so a recreated account with
 * the same public ID cannot recover an earlier account generation's index.
 * @param {string} userId @param {string} accountCreatedAt @param {string} [projectId] @param {string} [capsuleId]
 */
export function memOsNamespace(userId, accountCreatedAt, projectId, capsuleId) {
  text(userId, 512);
  text(accountCreatedAt, 80);
  if (projectId !== undefined) text(projectId, 512);
  if (capsuleId !== undefined) text(capsuleId, 512);
  if (projectId !== undefined && capsuleId !== undefined) throw failure(inputCode, "A memory namespace cannot be both a project and a capsule.", 400);
  const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    userId: `evimed-user-${digest(["evimed-memos-v2", userId, accountCreatedAt])}`,
    cubeId: `evimed-cube-${digest(capsuleId === undefined
      ? ["evimed-memos-v2", userId, accountCreatedAt, "account-or-project", projectId ?? null]
      : ["evimed-memos-v2", userId, accountCreatedAt, "capsule", capsuleId])}`,
  };
}

function taskPrefix(scope) {
  return `evimed-task-${scope.cubeId.slice("evimed-cube-".length)}-`;
}

/**
 * A transport for the verified MemTensor server_api contract, not usememos.
 * The upstream has no authentication: the configured origin MUST be reachable
 * only from the control plane, never from browsers or project runtimes.
 * This client never accepts arbitrary routes, credentials, filters, or cube IDs.
 */
export class MemOsClient {
  #origin;
  #timeoutMs;
  #maxRequestBytes;
  #maxResponseBytes;
  #writeMode;

  /** @param {MemOsConfig} config */
  constructor(config) {
    let url;
    try { url = new URL(config.memOsBaseUrl); } catch {
      throw failure("mem_os_config_invalid", "MemOS requires a valid service origin.", 503);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw failure("mem_os_config_invalid", "MemOS requires an HTTP service origin without credentials, path, query or fragment.", 503);
    }
    this.#origin = url.origin;
    this.#writeMode = config.memOsWriteMode ?? "async";
    if (!["async", "sync-fast"].includes(this.#writeMode)) throw failure("mem_os_config_invalid", "MemOS write mode is invalid.", 503);
    this.#timeoutMs = integer(config.memOsTimeoutMs ?? 15_000, 1, 120_000, "mem_os_config_invalid");
    this.#maxRequestBytes = integer(config.memOsMaxRequestBytes ?? 256 * 1024, 1, 4 * 1024 * 1024, "mem_os_config_invalid");
    this.#maxResponseBytes = integer(config.memOsMaxResponseBytes ?? 2 * 1024 * 1024, 1, 16 * 1024 * 1024, "mem_os_config_invalid");
  }

  #encode(payload) {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > this.#maxRequestBytes) {
      throw failure("mem_os_request_too_large", "MemOS request exceeds the configured byte limit.", 413);
    }
    return body;
  }

  /** @param {string} path @param {Record<string, unknown>|null} [payload] @returns {Promise<Record<string, any>>} */
  async #request(path, payload = null) {
    const body = payload === null ? undefined : this.#encode(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${this.#origin}${path}`, {
        method: body === undefined ? "GET" : "POST", body, redirect: "manual", signal: controller.signal,
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      });
      if (response.status >= 300 && response.status < 400) {
        throw failure("mem_os_redirect_refused", "MemOS redirects are not allowed.");
      }
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? "mem_os_auth_failed"
          : response.status === 429 ? "mem_os_rate_limited"
            : response.status === 404 ? "mem_os_not_found"
              : response.status >= 500 ? "mem_os_unavailable" : "mem_os_operation_failed";
        throw failure(code, "MemOS rejected the request.", response.status >= 500 ? 503 : 502);
      }
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body) {
        throw failure(responseCode, "MemOS returned a non-JSON response.");
      }
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        const value = next.value;
        bytes += value.byteLength;
        if (bytes > this.#maxResponseBytes) {
          await reader.cancel();
          throw failure("mem_os_response_too_large", "MemOS response exceeds the configured byte limit.");
        }
        chunks.push(value);
      }
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        throw failure(responseCode, "MemOS returned invalid JSON.");
      }
      if (!object(parsed)) throw failure(responseCode, "MemOS returned an invalid response object.");
      if (path !== "/health" && (parsed.code !== 200 || typeof parsed.message !== "string")) {
        throw failure(responseCode, "MemOS returned an invalid success envelope.");
      }
      return parsed;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted) throw failure("mem_os_timeout", "MemOS request timed out.", 504);
      throw failure("mem_os_unavailable", "MemOS request failed.", 503);
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }

  async health() {
    const result = await this.#request("/health");
    if (result.status !== "healthy" || result.service !== "memos" || result.version !== "1.0.1") {
      throw failure(responseCode, "MemOS health response does not match the verified API contract.");
    }
    return { status: "healthy", service: "memos", apiVersion: result.version };
  }

  /** @param {string} userId @param {MemOsInputRecord[]} records @param {ScopeOptions} [options] */
  async add(userId, records, options) {
    fields(options, ["accountCreatedAt", "projectId", "capsuleId"]);
    const scope = memOsNamespace(userId, options.accountCreatedAt, options.projectId, options.capsuleId);
    if (!Array.isArray(records) || records.length < 1 || records.length > 20) {
      throw failure(inputCode, "MemOS add requires between 1 and 20 records.", 400);
    }
    const entryIds = new Set();
    // Validate every item and encoded byte size before the first mutation.
    const requests = records.map(record => {
      fields(record, ["entryId", "content", "provenanceIds", "revision"]);
      if (record.revision !== undefined) integer(record.revision, 1, 2_147_483_647);
      const entryId = text(record.entryId, 512);
      if (entryIds.has(entryId)) throw failure(inputCode, "MemOS add contains duplicate entry IDs.", 400);
      entryIds.add(entryId);
      const provenanceIds = record.provenanceIds ?? [];
      if (!Array.isArray(provenanceIds) || provenanceIds.length > 100) {
        throw failure(inputCode, "MemOS provenance IDs are invalid.", 400);
      }
      provenanceIds.forEach(id => text(id, 512));
      const payload = {
        user_id: scope.userId, writable_cube_ids: [scope.cubeId],
        ...(this.#writeMode === "sync-fast" ? { async_mode: "sync", mode: "fast" } : { async_mode: "async", task_id: `${taskPrefix(scope)}${randomUUID()}` }),
        messages: [{ role: "user", content: text(record.content, 128 * 1024) }], chat_history: [],
        info: { evimed_entry_id: entryId, evimed_provenance_ids: provenanceIds, ...(record.revision !== undefined ? { evimed_entry_revision: record.revision } : {}) },
      };
      this.#encode(payload);
      return { entryId, payload };
    });
    /** @type {MemOsReceipt[]} */
    const completed = [];
    for (const { entryId, payload } of requests) {
      try {
        const result = await this.#request("/product/add", payload);
        if (!Array.isArray(result.data) || result.data.length === 0) {
          throw failure(responseCode, "MemOS did not return stored memory identifiers.");
        }
        const memoryIds = result.data.map(record => {
          if (!object(record) || record.cube_id !== scope.cubeId) {
            throw failure("mem_os_scope_mismatch", "MemOS returned a memory outside the requested scope.");
          }
          return text(record.memory_id, 512, responseCode);
        });
        completed.push({ entryId, memoryIds, taskId: "task_id" in payload ? payload.task_id : null });
      } catch (error) {
        if (!completed.length) throw error;
        throw Object.assign(failure("mem_os_partial_write", "MemOS stored only part of the requested batch."), {
          completed, failedEntryId: entryId, causeCode: error instanceof HttpError ? error.code : "mem_os_unavailable",
        });
      }
    }
    // The upstream can swallow scheduler submission errors; stored is not processed.
    return { status: "stored", processingStatus: this.#writeMode === "sync-fast" ? "readback_required" : "unverified", records: completed };
  }

  /** @param {Record<string, any>} result @param {{userId: string, cubeId: string}} scope @returns {MemOsRecord[]} */
  #records(result, scope) {
    if (!object(result.data) || !Array.isArray(result.data.text_mem)) {
      throw failure(responseCode, "MemOS returned an invalid memory collection.");
    }
    return result.data.text_mem.flatMap(bucket => {
      if (!object(bucket) || bucket.cube_id !== scope.cubeId) {
        throw failure("mem_os_scope_mismatch", "MemOS returned a cube outside the requested scope.");
      }
      if (!Array.isArray(bucket.memories)) throw failure(responseCode, "MemOS returned an invalid memory list.");
      return bucket.memories.map((record, rank) => {
        if (!object(record) || !object(record.metadata)) throw failure(responseCode, "MemOS returned invalid memory metadata.");
        if (record.metadata.user_id !== scope.userId) {
          throw failure("mem_os_scope_mismatch", "MemOS returned a memory outside the requested account.");
        }
        // 2.0.30 flattens request `info` into metadata; older fixture builds
        // returned it under metadata.info. Accept only those two known shapes.
        const info = object(record.metadata.info) ? record.metadata.info : record.metadata;
        const provenanceIds = object(info) ? info.evimed_provenance_ids ?? [] : [];
        if (!Array.isArray(provenanceIds)) throw failure(responseCode, "MemOS returned invalid provenance identifiers.");
        return {
          id: text(record.id, 512, responseCode), content: text(record.memory, this.#maxResponseBytes, responseCode),
          cubeId: scope.cubeId, entryId: object(info) && info.evimed_entry_id != null ? text(info.evimed_entry_id, 512, responseCode) : null,
          provenanceIds: provenanceIds.map(id => text(id, 512, responseCode)),
          revision: object(info) && Number.isSafeInteger(info.evimed_entry_revision) ? info.evimed_entry_revision : null,
          refId: typeof record.ref_id === "string" ? record.ref_id : null,
          memoryType: typeof record.metadata.memory_type === "string" ? record.metadata.memory_type : null,
          status: typeof record.metadata.status === "string" ? record.metadata.status : null,
          rank,
        };
      });
    });
  }

  /** @param {string} userId @param {string} query @param {ScopeOptions & {limit?: number}} [options] */
  async search(userId, query, options) {
    fields(options, ["accountCreatedAt", "projectId", "capsuleId", "limit"]);
    const scope = memOsNamespace(userId, options.accountCreatedAt, options.projectId, options.capsuleId);
    const limit = integer(options.limit ?? 10, 1, 100);
    const result = await this.#request("/product/search", {
      user_id: scope.userId, readable_cube_ids: [scope.cubeId], query: text(query, 16 * 1024),
      top_k: limit, mode: "fast", relativity: 0, threshold: 0, filter: { user_id: scope.userId }, internet_search: false,
      include_preference: false, search_tool_memory: false, include_skill_memory: false,
      rerank: false, dedup: "no", chat_history: [],
    });
    return this.#records(result, scope).slice(0, limit);
  }

  /** Export text records in one bounded page. Other engine state is not an account backup.
   * @param {string} userId @param {ScopeOptions & {page?: number, pageSize?: number}} [options] */
  async export(userId, options) {
    fields(options, ["accountCreatedAt", "projectId", "capsuleId", "page", "pageSize"]);
    const scope = memOsNamespace(userId, options.accountCreatedAt, options.projectId, options.capsuleId);
    const page = integer(options.page ?? 1, 1, 1_000_000);
    const pageSize = integer(options.pageSize ?? 100, 1, 100);
    const result = await this.#request("/product/get_memory", {
      mem_cube_id: scope.cubeId, user_id: scope.userId, include_preference: false,
      include_tool_memory: false, include_skill_memory: false, page, page_size: pageSize,
    });
    const records = this.#records(result, scope);
    if (result.data.text_mem.length !== 1) throw failure(responseCode, "MemOS export requires one scoped page.");
    const total = integer(result.data.text_mem[0].total_nodes, 0, Number.MAX_SAFE_INTEGER, responseCode);
    if (records.length > pageSize || (records.length === 0 && (page - 1) * pageSize < total)) {
      throw failure(responseCode, "MemOS returned inconsistent export pagination.");
    }
    const complete = page * pageSize >= total;
    return { records, total, page, pageSize, nextPage: complete ? null : page + 1, complete };
  }

  /** Read one server-derived scope completely before destructive operations.
   * @param {string} userId @param {ScopeOptions} options */
  async #scopeRecords(userId, options) {
    const records = [];
    for (let page = 1; page <= 10_000; page++) {
      const result = await this.export(userId, { ...options, page, pageSize: 100 });
      records.push(...result.records);
      if (result.nextPage === null) return records;
    }
    throw failure(responseCode, "MemOS scoped deletion readback did not terminate.");
  }

  /** @param {string} userId @param {string} recordId @param {ScopeOptions} [options] */
  async deleteRecord(userId, recordId, options) {
    fields(options, ["accountCreatedAt", "projectId", "capsuleId"]);
    const id = text(recordId, 512);
    const records = await this.#scopeRecords(userId, options);
    if (!records.some(record => record.id === id)) return { status: "absent", verified: true };
    this.#deletion(await this.#request("/product/delete_memory", { memory_ids: [id], auto_cleanup_working: true }));
    if ((await this.#scopeRecords(userId, options)).some(record => record.id === id)) {
      throw failure("mem_os_operation_failed", "MemOS deletion readback still contains the record.");
    }
    return { status: "deleted", verified: true };
  }

  /** @param {string} userId @param {ScopeOptions} [options] */
  async deleteScope(userId, options) {
    fields(options, ["accountCreatedAt", "projectId", "capsuleId"]);
    const records = await this.#scopeRecords(userId, options);
    if (!records.length) return { status: "absent", verified: true };
    for (let offset = 0; offset < records.length; offset += 100) {
      const memoryIds = records.slice(offset, offset + 100).map(record => record.id);
      this.#deletion(await this.#request("/product/delete_memory", { memory_ids: memoryIds, auto_cleanup_working: true }));
    }
    if ((await this.#scopeRecords(userId, options)).length) {
      throw failure("mem_os_operation_failed", "MemOS scoped deletion readback still contains records.");
    }
    return { status: "deleted", verified: true };
  }

  #deletion(result) {
    if (!object(result.data) || result.data.status !== "success") {
      throw failure("mem_os_operation_failed", "MemOS did not confirm deletion.");
    }
    // Upstream does not return a count; callers must reconcile retained documents.
    return { status: "deleted", verified: false };
  }

  /**
   * Create the cube this scope writes to, explicitly.
   *
   * `add` has always relied on the engine materializing a cube it has never
   * seen, and today it does. Nothing in the pinned source promises to keep
   * doing so, and the endpoint that does promise it was outside our contract,
   * so a change upstream would have surfaced as writes that succeed into
   * nothing rather than as a refusal.
   *
   * The precondition this pins is the finding: upstream's `CubeHandler`
   * validates `owner_id` against its own `UserManager` and answers 400 for an
   * owner it does not know. Our `memOsNamespace` derives an opaque owner id
   * that is never registered anywhere, so against a real engine this call
   * fails until the substrate migration registers users first. That is worth
   * knowing before the migration rather than during it — see
   * `packages/contracts/memos/fixtures/provenance.json`.
   *
   * `cube_path` is deliberately never sent: a filesystem path chosen by the
   * control plane is a path the engine would write to on our say-so.
   * `cube_name` is the derived id rather than anything about the account,
   * because a human-readable name here would be tenant data in a service that
   * has no authentication.
   *
   * @param {string} userId @param {ScopeOptions} [options]
   */
  async createCube(userId, options) {
    fields(options, ["accountCreatedAt", "projectId", "capsuleId"]);
    const scope = memOsNamespace(userId, options.accountCreatedAt, options.projectId, options.capsuleId);
    const result = await this.#request("/product/create_cube", {
      cube_name: scope.cubeId, owner_id: scope.userId, cube_id: scope.cubeId,
    });
    if (!object(result.data) || result.data.cube_id !== scope.cubeId || result.data.owner_id !== scope.userId) {
      throw failure("mem_os_scope_mismatch", "MemOS created a cube outside the requested scope.");
    }
    return { cubeId: scope.cubeId, status: "created" };
  }

  /**
   * Send one decision about recalled memories back to the ranking.
   *
   * The endpoint MemOS documents for exactly this and our contract did not
   * cover. It is the return path of the recall loop: without it the index only
   * ever learns what was written, never what turned out to be worth reading.
   *
   * `writable_cube_ids` is not optional here even though the model marks it so.
   * Upstream's `FeedbackHandler._resolve_cube_ids` falls back to `[user_id]`
   * when the list is absent — a cube id that is not ours — so an omitted field
   * is a write into a namespace this client exists to make unreachable.
   *
   * `corrected_answer` stays false: this reports what a person decided, and
   * asking the engine to rewrite the answer as well would put a second author
   * on text the gate has already judged.
   *
   * The task id is minted the way `add` mints one, so `getTaskStatus` can
   * verify this call for the same reason and by the same scope check.
   *
   * @param {string} userId
   * @param {{history: {role: string, content: string}[], feedbackContent: string, retrievedMemoryIds?: string[], sessionId?: string}} decision
   * @param {ScopeOptions} [options]
   */
  async feedback(userId, decision, options) {
    fields(options, ["accountCreatedAt", "projectId", "capsuleId"]);
    fields(decision, ["history", "feedbackContent", "retrievedMemoryIds", "sessionId"]);
    const scope = memOsNamespace(userId, options.accountCreatedAt, options.projectId, options.capsuleId);
    const history = Array.isArray(decision.history) ? decision.history : [];
    if (history.length < 1 || history.length > 40) {
      throw failure(inputCode, "MemOS feedback requires between 1 and 40 history messages.", 400);
    }
    const retrievedMemoryIds = decision.retrievedMemoryIds ?? [];
    if (!Array.isArray(retrievedMemoryIds) || retrievedMemoryIds.length > 100) {
      throw failure(inputCode, "MemOS feedback received invalid retrieved memory identifiers.", 400);
    }
    const taskId = `${taskPrefix(scope)}${randomUUID()}`;
    const payload = {
      user_id: scope.userId,
      writable_cube_ids: [scope.cubeId],
      async_mode: "async",
      task_id: taskId,
      corrected_answer: false,
      history: history.map(message => {
        fields(message, ["role", "content"]);
        if (!["user", "assistant"].includes(message.role)) {
          throw failure(inputCode, "MemOS feedback history accepts only user and assistant turns.", 400);
        }
        return { role: message.role, content: text(message.content, 32 * 1024) };
      }),
      feedback_content: text(decision.feedbackContent, 16 * 1024),
      retrieved_memory_ids: retrievedMemoryIds.map(id => text(id, 512)),
      ...(decision.sessionId === undefined ? {} : { session_id: text(decision.sessionId, 512) }),
    };
    this.#encode(payload);
    const result = await this.#request("/product/feedback", payload);
    if (!Array.isArray(result.data)) throw failure(responseCode, "MemOS did not confirm the feedback submission.");
    return { status: "accepted", taskId };
  }

  /** Query only a task issued in this account/project scope; 404 stays an error, never completion.
   * @param {string} userId @param {string} taskId @param {ScopeOptions} [options] */
  async getTaskStatus(userId, taskId, options) {
    fields(options, ["accountCreatedAt", "projectId", "capsuleId"]);
    const scope = memOsNamespace(userId, options.accountCreatedAt, options.projectId, options.capsuleId);
    if (!text(taskId, 256).startsWith(taskPrefix(scope))) {
      throw failure(inputCode, "MemOS task does not belong to the requested scope.", 400);
    }
    const query = new URLSearchParams({ user_id: scope.userId, task_id: taskId });
    const result = await this.#request(`/product/scheduler/status?${query}`);
    if (!Array.isArray(result.data) || result.data.length !== 1 || result.data[0]?.task_id !== taskId || !taskStates.has(result.data[0]?.status)) {
      throw failure(responseCode, "MemOS returned an invalid task status.");
    }
    return { taskId, status: result.data[0].status };
  }
}
