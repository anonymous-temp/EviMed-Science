import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, personalSkillName, validateSkillWriteRequest } from "@evimed/domain";
import { ProductDocuments } from "./productStore.mjs";
import { migrateProductStore, productId, productInteger, productPayload } from "./productPersistence.mjs";
import { HttpError } from "./security.mjs";
import { nativeSkillSnapshotArchive } from "./nativeSkillCatalogue.mjs";

/** @param {string} value */
const sha256 = value => createHash("sha256").update(value).digest("hex");
/** @param {unknown} value @param {string[]} keys */
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new HttpError(400, "extension_contract_invalid", "Invalid skill request.");
  }
  return /** @type {any} */ (value);
}
/** @param {any} value */
function writeRequest(value) {
  try { return validateSkillWriteRequest(value); }
  catch { throw new HttpError(400, "extension_contract_invalid", "Invalid skill content."); }
}
/** Rendering is not parsing. Native frontmatter parsing remains in harness-port. @param {string} name @param {{description:string,instructions:string}} content @param {any} [native] */
export function renderPersonalSkill(name, content, native = { invocation: { userInvocable: true, modelInvocable: true }, metadata: {}, whenToUse: null }) {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(content.description)}\nuser-invocable: ${native.invocation.userInvocable}\ndisable-model-invocation: ${!native.invocation.modelInvocable}\nmetadata: ${canonicalJson(native.metadata)}\n${native.whenToUse == null ? "" : `whenToUse: ${JSON.stringify(native.whenToUse)}\n`}---\n\n${content.instructions}\n`;
}
/** @param {any} row */
function summary(row) {
  const { instructions: _instructions, ...payload } = row.payload;
  return { ...row, payload };
}

/** Personal instructions are account records, never executable authority or a copy of a learned method. */
export class SkillLibraryService {
  /** @param {any} database @param {{documents?:any,artifacts?:any,projectAccess?:any,invoke?:any,learnedMethods?:any,nativeCatalogue?:any,repositoryPreview?:any,onRemoved?:any}} [options] */
  constructor(database, { documents = new ProductDocuments(database), artifacts = null, projectAccess = null, invoke = null, learnedMethods = null, nativeCatalogue = null, repositoryPreview = null, onRemoved = null } = {}) {
    this.database = database;
    this.documents = documents;
    this.artifacts = artifacts;
    this.projectAccess = projectAccess;
    this.dispatchInvocation = invoke;
    this.learnedMethods = learnedMethods;
    this.nativeCatalogue = nativeCatalogue;
    this.repositoryPreview = repositoryPreview;
    this.onRemoved = onRemoved;
  }

  /** A delayed request retains its authenticated account generation. The row
   * lock joins account deletion without introducing an inverse project lock.
   * Private writes and their metadata settle before that lock is released.
   * @param {any} user @param {(client:any)=>Promise<any>} work */
  async withLibraryAccount(user, work) {
    if (!this.database) return work(null);
    await migrateProductStore(this.database);
    return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      const account = await client.query(`SELECT id FROM evimed_control.users WHERE id=$1
        AND ($2::timestamptz IS NULL OR created_at=$2::timestamptz) FOR KEY SHARE`, [productId(user.id), user.accountCreatedAt ?? null]);
      if (account.rowCount !== 1) throw new HttpError(401, "unauthorized", "This account generation is unavailable.");
      const operation = () => work(client);
      return this.artifacts?.withTransaction ? this.artifacts.withTransaction(client, operation) : operation();
    }));
  }

  /** @param {any} user @param {{cursor?:string|null,limit?:number}} [options] */
  async list(user, options = {}) {
    return this.withLibraryAccount(user, async () => {
      const page = await this.documents.list(user.id, "skill", { ...options, projectId: null });
      return { ...page, items: page.items.map(summary) };
    });
  }
  /** @param {any} user @param {string} skillId @param {{includeDeleted?:boolean}} [options] */
  async get(user, skillId, options = {}) {
    productId(skillId);
    return this.withLibraryAccount(user, async () => {
      const row = await this.documents.get(user.id, "skill", skillId, options);
      if (!row) throw new HttpError(404, "product_document_not_found", "The skill is unavailable.");
      return row;
    });
  }
  /** @param {any} user @param {any} body */
  async create(user, body) {
    const content = writeRequest(body);
    if (content.expectedRevision !== 0) throw new HttpError(400, "extension_contract_invalid", "A new skill starts at revision zero.");
    return this.saveContent(user, `skill:${randomUUID()}`, content, []);
  }
  /** @param {any} user @param {string} skillId @param {any} body */
  async update(user, skillId, body) {
    const current = await this.get(user, skillId);
    const content = writeRequest(body);
    if (current.revision !== content.expectedRevision) throw new HttpError(409, "product_revision_conflict", "The skill changed; reload before saving.");
    return this.saveContent(user, current.id, content, current.payload.resources ?? [], current.payload);
  }
  /** Native validation and immutable resource publication precede the durable revision. @param {any} user @param {string} skillId @param {any} content @param {any[]} resources @param {any} [native] @param {(()=>Promise<void>)|null} [verifySource] */
  async saveContent(user, skillId, content, resources, native = { invocation: { userInvocable: true, modelInvocable: true }, metadata: {}, whenToUse: null }, verifySource = null) {
    const save = async client => {
      if (client) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`skill-library-account:${user.id}`]);
        const account = await client.query("SELECT id FROM evimed_control.users WHERE id=$1 FOR KEY SHARE", [user.id]);
        if (account.rowCount !== 1) throw new HttpError(404, "product_document_not_found", "The skill is unavailable.");
        const current = await client.query("SELECT revision,deleted_at FROM evimed_product.documents WHERE user_id=$1 AND kind='skill' AND id=$2 FOR UPDATE", [user.id, skillId]);
        if ((current.rows[0]?.revision ?? 0) !== content.expectedRevision || current.rows[0]?.deleted_at) {
          throw new HttpError(409, "product_revision_conflict", "The skill changed; reload before saving.");
        }
      }
      if (verifySource) await verifySource();
      const nativeName = personalSkillName(user.id, skillId, sha256);
      if (typeof native.invocation?.userInvocable !== "boolean" || typeof native.invocation?.modelInvocable !== "boolean") {
        throw new HttpError(400, "extension_contract_invalid", "Invalid native skill policy.");
      }
      const policy = { invocation: { userInvocable: native.invocation.userInvocable, modelInvocable: native.invocation.modelInvocable },
        metadata: native.metadata ?? {}, whenToUse: native.whenToUse ?? null };
      const file = renderPersonalSkill(nativeName, content, policy);
      const digest = `sha256:${sha256(canonicalJson({ file, resources }))}`;
      const payload = {
        schemaVersion: 1, title: content.title, description: content.description,
        instructions: content.instructions, nativeName, digest, resources,
        prepared: true, ...policy,
    };
    productPayload(payload);
    if (!this.artifacts) throw new HttpError(503, "product_state_unavailable", "Skill preparation is unavailable.");
      const prepare = () => this.artifacts.prepare(user, { skillId, nativeName, file, digest, resources });
      const prepared = this.artifacts.withTransaction ? await this.artifacts.withTransaction(client, prepare) : await prepare();
    if (prepared?.nativeName !== nativeName || prepared?.digest !== digest) {
      throw new HttpError(502, "extension_contract_invalid", "Native skill validation did not match the saved content.");
    }
    if (verifySource) await verifySource();
    return this.documents.put(user.id, "skill", skillId, payload, { expectedRevision: content.expectedRevision, transactionClient: client });
    };
    if (!this.database) return save(null);
    return this.withLibraryAccount(user, save);
  }
  /** Explicit owned import resolves bytes through the artifact boundary, never a submitted host path. @param {any} user @param {any} body */
  async import(user, body) {
    const input = exact(body, ["resourceId", "title"]);
    productId(input.resourceId);
    if (typeof input.title !== "string" || !input.title.trim() || Buffer.byteLength(input.title) > 240) {
      throw new HttpError(400, "extension_contract_invalid", "Invalid skill title.");
    }
    if (!this.artifacts) throw new HttpError(503, "product_state_unavailable", "Skill preparation is unavailable.");
    return this.withLibraryAccount(user, async () => {
      const skillId = `skill:${randomUUID()}`;
      const nativeName = personalSkillName(user.id, skillId, sha256);
      const imported = await this.artifacts.import(user, { resourceId: input.resourceId, skillId, nativeName });
      const content = writeRequest({ expectedRevision: 0, title: input.title,
        description: imported.description, instructions: imported.instructions });
      return this.saveContent(user, skillId, content, imported.resources, imported, () => this.artifacts.verifyUpload(user, input.resourceId));
    });
  }
  /** Native parsing previews data only; it creates no library revision,
   * persistent blob, project selection or permission grant.
   * @param {any} user @param {any} body */
  async previewImport(user, body) {
    const input = exact(body, ["resourceId"]); productId(input.resourceId);
    if (!this.artifacts) throw new HttpError(503, "product_state_unavailable", "Skill preparation is unavailable.");
    return this.withLibraryAccount(user, async () => {
      const skillId = `skill:${randomUUID()}`;
      const preview = await this.artifacts.import(user, { resourceId: input.resourceId, skillId,
        nativeName: personalSkillName(user.id, skillId, sha256), preview: true });
      return { description: preview.description, instructions: preview.instructions, invocation: preview.invocation,
        whenToUse: preview.whenToUse, metadata: preview.metadata, resources: preview.resources,
        scripts: preview.resources.filter(resource => /^scripts\//.test(resource.path)).map(resource => ({ path: resource.path, size: resource.size })),
      };
    });
  }
  /** @param {any} user @param {string} kind @param {Buffer} bytes */
  async upload(user, kind, bytes) {
    if (!this.artifacts) throw new HttpError(503, "product_state_unavailable", "Skill preparation is unavailable.");
    return this.withLibraryAccount(user, () => this.artifacts.upload(user, kind, bytes));
  }
  /** Repository acquisition is a separate trusted controlled-egress adapter; no caller host path or token.
   * @param {any} user @param {any} body */
  async previewRepository(user, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['repository', 'commit', 'subdirectory'].includes(key))
      || !Object.hasOwn(body, 'repository') || !Object.hasOwn(body, 'commit')) throw new HttpError(400, 'extension_contract_invalid', 'Invalid repository import.');
    if (!this.repositoryPreview) throw new HttpError(503, 'product_state_unavailable', 'Repository skill import is unavailable.');
    return this.withLibraryAccount(user, () => this.repositoryPreview(user, body));
  }
  /** The catalogue is observed from the actual current native registry. Learned records stay in their original store.
   * @param {any} user @param {any} project @param {string|null} sessionId */
  async effectiveCatalogue(user, project, sessionId) {
    return this.withLibraryAccount(user, async () => {
      await this.requireProject(user, project);
      const catalogue = this.nativeCatalogue ? await this.nativeCatalogue.list(user, project, sessionId)
        : { state: 'unavailable', runtimeGeneration: null, sessionId, items: [], findings: [{ code: 'skill_catalogue_unavailable' }] };
      const items = [];
      for (const item of catalogue.items) items.push(await this.personalCatalogueRef(user, project, item));
      const observed = this.learnedMethods ? await this.learnedMethods(user) : [];
      const rows = Array.isArray(observed) ? observed : observed?.items ?? [];
      const learnedMethods = rows.slice(0, 50).filter(row => typeof row.id === 'string').map(row => ({ id: row.id,
        title: String(row.payload?.title ?? row.title ?? row.id).slice(0, 240), href: '/app/memory?method=' + encodeURIComponent(row.id) }));
      if (catalogue.state === 'available') await this.nativeCatalogue.assertCurrent(user, project, sessionId, catalogue.runtimeGeneration);
      return { ...catalogue, items, learnedMethods };
    });
  }
  /** Labels refer to the mounted historical revision, not a newer library edit. @param {any} user @param {any} project @param {any} item */
  async personalCatalogueRef(user, project, item) {
    if (item.source !== 'personal' || !this.nativeCatalogue) return item;
    const pin = this.nativeCatalogue.runtime.runtimePersonalSkillPins(project).find(entry => entry.nativeName === item.name);
    if (!pin) return item;
    try { const row = await this.atRevision(user, pin.skillId, pin.revision);
      if (row.payload.digest !== pin.digest) return item;
      // The revision row carries no id of its own; the pin names the skill it was read by.
      return { ...item, personalRef: { skillId: pin.skillId, revision: pin.revision, title: row.payload.title } };
    } catch (error) { if (error?.status !== 404) throw error; return item; }
  }
  /** @param {any} user @param {any} project @param {any} body */
  async effectiveDetail(user, project, body) {
    const input = exact(body, ['sessionId', 'key', 'expectedRuntimeGeneration']);
    return this.withLibraryAccount(user, async () => {
      await this.requireProject(user, project);
      if (!this.nativeCatalogue) throw new HttpError(503, 'product_state_unavailable', 'The native skill catalogue is unavailable.');
      const detail = await this.nativeCatalogue.read(user, project, input);
      const skill = await this.personalCatalogueRef(user, project, detail.skill);
      await this.nativeCatalogue.assertCurrent(user, project, input.sessionId, detail.runtimeGeneration);
      return { ...detail, skill };
    });
  }
  /** Real source bytes pass the existing archive importer and native validator, under the captured account lifetime.
   * Idempotency receipts contain only a record pointer, never another method body or executable authority.
   * @param {any} user @param {any} project @param {any} body */
  async duplicateNative(user, project, body) {
    const input = exact(body, ['sessionId', 'key', 'title', 'idempotencyKey', 'expectedRuntimeGeneration']);productId(input.idempotencyKey);
    if (typeof input.title !== 'string' || !input.title.trim() || Buffer.byteLength(input.title) > 240) throw new HttpError(400, 'extension_contract_invalid', 'Invalid skill title.');
    return this.withLibraryAccount(user, async client => {
      await this.requireProject(user, project);
      if (!this.nativeCatalogue || !this.artifacts) throw new HttpError(503, 'product_state_unavailable', 'Native skill duplication is unavailable.');
      const operationId = `skill-copy:${sha256(input.idempotencyKey)}`, requestDigest = sha256(canonicalJson({ projectId: project.id, ...input }));
      if (client) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`skill-library-account:${user.id}`]);
      const existing = await this.documents.get(user.id, 'extension-resource', operationId);
      if (existing) {
        if (existing.payload.requestDigest !== requestDigest) throw new HttpError(409, 'product_revision_conflict', 'This copy request already names different content.');
        return this.get(user, existing.payload.skillId);
      }
      const snapshot = await this.nativeCatalogue.read(user, project, { sessionId: input.sessionId, key: input.key, expectedRuntimeGeneration: input.expectedRuntimeGeneration }, true);
      const archive = await nativeSkillSnapshotArchive(snapshot.skill.entries), uploaded = await this.upload(user, 'tar-gzip', archive);
      const skillId = `skill:${randomUUID()}`, nativeName = personalSkillName(user.id, skillId, sha256);
      try {
        const imported = await this.artifacts.import(user, { resourceId: uploaded.resourceId, skillId, nativeName });
        const content = writeRequest({ expectedRevision: 0, title: input.title, description: imported.description, instructions: imported.instructions });
        const row = await this.saveContent(user, skillId, content, imported.resources, imported,
          () => this.nativeCatalogue.assertCurrent(user, project, input.sessionId, input.expectedRuntimeGeneration));
        await this.documents.put(user.id, 'extension-resource', operationId, { schemaVersion: 1, kind: 'skill-copy', requestDigest, skillId: row.id }, { expectedRevision: 0, transactionClient: client });
        return row;
      } finally { await this.removeUpload(user, uploaded.resourceId); }
    });
  }
  /** Deleting raw input cannot remove any adopted revision. @param {any} user @param {string} resourceId */
  async removeUpload(user, resourceId) {
    if (!this.artifacts) throw new HttpError(503, "product_state_unavailable", "Skill preparation is unavailable.");
    const remove = async client => {
      if (client) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`skill-library-account:${user.id}`]);
      const operation = () => this.artifacts.removeUpload(user, resourceId);
      return this.artifacts.withTransaction ? this.artifacts.withTransaction(client, operation) : operation();
    };
    return this.withLibraryAccount(user, remove);
  }
  /** @param {any} user @param {string} skillId */
  async history(user, skillId) {
    await this.get(user, skillId, { includeDeleted: true });
    return this.documents.history(user.id, "skill", skillId);
  }
  /** Exact historical payload including immutable resource manifest. @param {any} user @param {string} skillId @param {number} revision */
  async atRevision(user, skillId, revision) {
    productInteger(revision, 1, 2_147_483_647);
    await this.get(user, skillId);
    const rows = await this.documents.history(user.id, "skill", skillId, { beforeRevision: revision === 2_147_483_647 ? null : revision + 1, limit: 1 });
    const row = rows[0];
    if (row?.revision !== revision || row.deletedAt) throw new HttpError(404, "product_document_not_found", "The skill revision is unavailable.");
    return row;
  }
  /** @param {any} user @param {string} skillId @param {any} body */
  async restore(user, skillId, body) {
    const input = exact(body, ["expectedRevision", "revision"]);
    const current = await this.get(user, skillId);
    const historical = await this.atRevision(user, skillId, input.revision);
    return this.saveContent(user, current.id, {
      expectedRevision: productInteger(input.expectedRevision, 1, 2_147_483_646),
      title: historical.payload.title, description: historical.payload.description, instructions: historical.payload.instructions,
    }, historical.payload.resources ?? [], historical.payload);
  }
  /** @param {any} user @param {string} skillId @param {any} body */
  async remove(user, skillId, body) {
    const input = exact(body, ["expectedRevision"]);
    await this.get(user, skillId);
    // Resource bytes are retained for existing pinned generations; a deleted library record cannot admit new invocations.
    const remove = async () => {
      const result = await this.documents.remove(user.id, "skill", skillId, productInteger(input.expectedRevision, 1, 2_147_483_646));
      await this.onRemoved?.(user, skillId);
      return result;
    };
    return this.withLibraryAccount(user, remove);
  }
  /** @param {any} user @param {any} value */
  async selections(user, value) {
    if (!Array.isArray(value) || value.length > 64) throw new HttpError(400, "extension_contract_invalid", "Invalid skill selection.");
    const seen = new Set();
    const entries = [];
    for (const item of value) {
      const selection = exact(item, ["skillId", "revision"]);
      productId(selection.skillId);
      if (seen.has(selection.skillId)) throw new HttpError(400, "extension_contract_invalid", "Duplicate skill selection.");
      seen.add(selection.skillId);
      const row = await this.atRevision(user, selection.skillId, selection.revision);
      entries.push({ skillId: selection.skillId, revision: selection.revision, digest: row.payload.digest, nativeName: row.payload.nativeName });
    }
    return entries;
  }
  /** @param {any} user */
  async defaults(user) {
    return this.withLibraryAccount(user, async () => await this.documents.get(user.id, "extension-defaults", "skills:defaults")
      ?? { id: "skills:defaults", revision: 0, payload: { skills: [] } });
  }
  /** @param {any} user @param {any} body */
  async saveDefaults(user, body) {
    const input = exact(body, ["expectedRevision", "skills"]);
    return this.withLibraryAccount(user, async () => {
      const skills = await this.selections(user, input.skills);
      return this.documents.put(user.id, "extension-defaults", "skills:defaults", { skills }, {
        expectedRevision: productInteger(input.expectedRevision, 0, 2_147_483_646),
      });
    });
  }
  /** @param {any} user @param {any} project */
  async projectSelections(user, project) {
    await this.requireProject(user, project);
    return await this.documents.get(user.id, "extension-defaults", `skills:project:${project.id}`)
      ?? { id: `skills:project:${project.id}`, revision: 0, payload: { skills: [] } };
  }
  /** @param {any} user @param {any} project @param {any} body */
  async saveProjectSelections(user, project, body) {
    await this.requireProject(user, project);
    const input = exact(body, ["expectedRevision", "skills"]);
    return this.withLibraryAccount(user, async () => {
      await this.requireProject(user, project);
      const skills = await this.selections(user, input.skills);
      return this.documents.put(user.id, "extension-defaults", `skills:project:${project.id}`, { skills }, {
        expectedRevision: productInteger(input.expectedRevision, 0, 2_147_483_646), projectId: project.id,
      });
    });
  }
  /** Snapshot defaults once; never change an existing project's override. @param {any} user @param {any} project */
  async initializeProject(user, project) {
    return this.withLibraryAccount(user, () => this.initializeOwnedProject(user, project));
  }
  /** @param {any} user @param {any} project */
  async initializeOwnedProject(user, project) {
    await this.requireProject(user, project);
    const id = `skills:project:${project.id}`;
    const current = await this.documents.get(user.id, "extension-defaults", id);
    if (current) return current;
    const defaults = await this.defaults(user);
    const skills = [];
    for (const { skillId, revision } of defaults.payload.skills) {
      try { skills.push(...await this.selections(user, [{ skillId, revision }])); }
      catch (error) { if (error?.status !== 404) throw error; }
    }
    try { return await this.documents.put(user.id, "extension-defaults", id, { skills }, { expectedRevision: 0, projectId: project.id }); }
    catch (error) {
      if (error?.code !== "product_revision_conflict") throw error;
      return this.documents.get(user.id, "extension-defaults", id);
    }
  }
  /** @param {any} user @param {any} project */
  async requireProject(user, project) {
    if (!this.projectAccess) throw new HttpError(503, "product_state_unavailable", "Project skill activation is unavailable.");
    await this.projectAccess(user, project);
  }
  /** Dispatcher must bind and recheck the actual session/generation; no success is synthesized here. @param {any} user @param {any} project @param {string} skillId @param {any} body */
  async invoke(user, project, skillId, body) {
    await this.requireProject(user, project);
    const input = exact(body, ["revision", "sessionId", "idempotencyKey"]);
    productId(input.sessionId); productId(input.idempotencyKey);
    const row = await this.atRevision(user, skillId, input.revision);
    if (row.payload.invocation?.userInvocable !== true) throw new HttpError(403, "extension_access_denied", "This skill does not permit user invocation.");
    const desired = await this.projectSelections(user, project);
    if (!desired.payload.skills.some(item => item.skillId === skillId && item.revision === input.revision && item.digest === row.payload.digest)) {
      throw new HttpError(409, "extension_contract_invalid", "Enable this skill revision in the project before using it.");
    }
    if (!this.dispatchInvocation) throw new HttpError(503, "product_state_unavailable", "Native skill invocation is unavailable.");
    return this.dispatchInvocation({ user, project, skillId, revision: input.revision, payload: row.payload,
      sessionId: input.sessionId, idempotencyKey: input.idempotencyKey });
  }
  /** A resource download rechecks library ownership and revision before reading any file. @param {any} user @param {string} skillId @param {number} revision @param {string} resourceId */
  async resource(user, skillId, revision, resourceId) {
    const row = await this.atRevision(user, skillId, revision);
    const resource = row.payload.resources.find(item => item.id === resourceId);
    if (!resource || !this.artifacts) throw new HttpError(404, "product_document_not_found", "The skill resource is unavailable.");
    return this.artifacts.read(user, { skillId, digest: row.payload.digest, resource });
  }
}
