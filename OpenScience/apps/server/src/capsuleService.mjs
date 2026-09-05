import { randomUUID } from "node:crypto";
import { CAPSULE_ACTIVATION_MODES, CAPSULE_FACT_KINDS, CAPSULE_FACT_ORIGINS, CAPSULE_FACT_STATES, CAPSULE_LAYERS } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { productId, productInteger } from "./productPersistence.mjs";

/** @param {unknown} value @param {string} name @param {number} max @param {boolean} required */
function text(value, name, max, required = true) {
  if ((!required && value == null)) return "";
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new HttpError(400, "capsule_payload_invalid", `Invalid ${name}.`);
  }
  return value.trim();
}

/** @param {unknown} value @param {readonly string[]} allowed @param {string} name */
function member(value, allowed, name) {
  if (!allowed.includes(String(value))) throw new HttpError(400, "capsule_payload_invalid", `Invalid ${name}.`);
  return String(value);
}

/** @param {unknown} value */
function provenance(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, "capsule_payload_invalid", "Invalid provenance.");
  return value.map((item) => ({
    type: member(item?.type, ["user", "run", "source", "import", "correction"], "provenance type"),
    id: text(item.id, "provenance id", 200),
    ...(item.excerpt ? { excerpt: text(item.excerpt, "provenance excerpt", 2000) } : {}),
  }));
}

/** @param {string|null} projectId */
function activationKey(projectId) {
  return projectId == null ? "active-capsules:account" : `active-capsules:project:${productId(projectId, "projectId")}`;
}

/** Capsules supply explicit user context. They never confer tools, permissions or evidence verdicts. */
export class CapsuleService {
  /** @param {import('./productStore.mjs').ProductDocuments} documents */
  constructor(documents) { this.documents = documents; }

  /** @param {string} userId @param {Record<string,any>} input */
  async create(userId, input) {
    return this.documents.put(userId, "capsule", randomUUID(), {
      title: text(input.title, "title", 150), description: text(input.description, "description", 2000, false),
      activationMode: "own", imported: false,
    }, { expectedRevision: 0 });
  }

  /** @param {string} userId @param {Record<string,any>} options */
  async list(userId, options = {}) { return this.documents.list(userId, "capsule", options); }

  /** @param {string} userId @param {string} capsuleId */
  async get(userId, capsuleId) {
    const value = await this.documents.get(userId, "capsule", capsuleId);
    if (!value) throw new HttpError(404, "capsule_not_found", "The capsule is unavailable.");
    return value;
  }

  /** @param {string} userId @param {string} capsuleId @param {Record<string,any>} input */
  async update(userId, capsuleId, input) {
    const current = await this.get(userId, capsuleId);
    const payload = { ...current.payload };
    if (input.title !== undefined) payload.title = text(input.title, "title", 150);
    if (input.description !== undefined) payload.description = text(input.description, "description", 2000, false);
    return this.documents.put(userId, "capsule", capsuleId, payload, { expectedRevision: input.expectedRevision });
  }

  /** @param {string} userId @param {string} capsuleId @param {number} revision */
  async remove(userId, capsuleId, revision) { await this.get(userId, capsuleId); return this.documents.remove(userId, "capsule", capsuleId, revision); }

  /** @param {string} userId @param {string} capsuleId @param {number} revision */
  async restore(userId, capsuleId, revision) { return this.documents.restore(userId, "capsule", capsuleId, revision); }

  /** @param {string} userId @param {string} capsuleId @param {Record<string,any>} options */
  async entries(userId, capsuleId, options = {}) {
    await this.get(userId, capsuleId);
    return this.documents.list(userId, "fact", { limit: options.limit, cursor: options.cursor, filter: { capsuleId } });
  }

  /** Generated/inferred entries are candidates; the user approves them explicitly.
   * @param {string} userId @param {string} capsuleId @param {Record<string,any>} input */
  async addEntry(userId, capsuleId, input) {
    await this.get(userId, capsuleId);
    const origin = member(input.origin ?? "explicit", CAPSULE_FACT_ORIGINS, "origin");
    return this.documents.put(userId, "fact", randomUUID(), {
      capsuleId, factKind: member(input.factKind, CAPSULE_FACT_KINDS, "fact kind"),
      layer: member(input.layer ?? "knowledge", CAPSULE_LAYERS, "layer"),
      content: text(input.content, "content", 20_000), origin,
      status: origin === "explicit" ? "approved" : "candidate",
      provenance: provenance(input.provenance), contextOnly: true,
    }, { expectedRevision: 0 });
  }

  /** @param {string} userId @param {string} capsuleId @param {string} entryId @param {Record<string,any>} input */
  async updateEntry(userId, capsuleId, entryId, input) {
    await this.get(userId, capsuleId);
    const entry = await this.documents.get(userId, "fact", entryId);
    if (!entry || entry.payload.capsuleId !== capsuleId) throw new HttpError(404, "capsule_entry_not_found", "The capsule entry is unavailable.");
    const payload = { ...entry.payload };
    if (input.content !== undefined) {
      payload.content = text(input.content, "content", 20_000);
      payload.correctedAt = new Date().toISOString();
    }
    if (input.status !== undefined) {
      payload.status = member(input.status, CAPSULE_FACT_STATES, "status");
      payload.curatedAt = new Date().toISOString();
    }
    return this.documents.put(userId, "fact", entryId, payload, { expectedRevision: input.expectedRevision });
  }

  /** @param {string} userId @param {string|null} projectId */
  async active(userId, projectId = null) {
    const record = await this.documents.get(userId, "preferences", activationKey(projectId));
    return { record, items: record?.payload.items ?? [] };
  }

  /** @param {string} userId @param {string} capsuleId @param {{ mode?: string, projectId?: string|null }} options */
  async activate(userId, capsuleId, { mode = "own", projectId = null } = {}) {
    await this.get(userId, capsuleId);
    member(mode, CAPSULE_ACTIVATION_MODES, "activation mode");
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.active(userId, projectId);
      const items = mode === "own" ? [{ capsuleId, mode }]
        : [...current.items.filter((x) => x.capsuleId !== capsuleId), { capsuleId, mode }];
      if (items.length > 8) throw new HttpError(400, "capsule_activation_limit", "At most eight capsules may be active together.");
      try {
        return await this.documents.put(userId, "preferences", activationKey(projectId), { items },
          { expectedRevision: current.record?.revision ?? 0, projectId });
      } catch (error) { if (error.code !== "product_revision_conflict" || attempt === 2) throw error; }
    }
  }

  /** @param {string} userId @param {{ query: string, projectId?: string|null, limit?: number }} input */
  async recall(userId, { query, projectId = null, limit = 10 }) {
    const needle = text(query, "query", 2000);
    productInteger(limit, 1, 30);
    const local = await this.active(userId, projectId);
    const global = projectId ? await this.active(userId, null) : { items: [] };
    const active = [...local.items, ...global.items].filter((x, i, all) => all.findIndex((y) => y.capsuleId === x.capsuleId) === i).slice(0, 8);
    const matches = [];
    for (const selection of active) {
      const capsule = await this.documents.get(userId, "capsule", selection.capsuleId);
      if (!capsule) continue;
      const entries = await this.documents.search(userId, "fact", needle, { limit, filter: { capsuleId: capsule.id, status: "approved" } });
      for (const entry of entries) matches.push({
        id: entry.id, capsuleId: capsule.id, capsuleTitle: capsule.payload.title, mode: selection.mode,
        factKind: entry.payload.factKind, layer: entry.payload.layer, content: entry.payload.content,
        origin: entry.payload.origin, provenance: entry.payload.provenance, revision: entry.revision, contextOnly: true,
      });
    }
    return { items: matches.slice(0, limit), mode: "lexical", contextOnly: true };
  }
}
