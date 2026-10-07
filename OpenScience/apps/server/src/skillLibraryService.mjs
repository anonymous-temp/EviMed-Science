import { createHash, randomUUID } from "node:crypto";
import {
  buildSkillPackageRecord, canonicalJson, normalizeSkillBaseline, normalizeSkillPackageRecord, personalSkillName, planSkillUpdate,
  skillContentDigests, validateSkillWriteRequest,
} from "@evimed/domain";
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

/** A script's text is read for the libraries it imports; bigger ones, and every one past the sixteenth, are listed by digest only. */
const SCRIPT_TEXT = /\.(?:py|r)$/i, MAX_SCRIPT_TEXT = 256 * 1024, MAX_SCRIPT_READS = 16;
/** A package record that did not fit beside the instructions: the facts that identify it, without the lists. @param {any} record */
const compactPackage = record => ({ ...record, scripts: [], references: [], dependencies: [], operations: [] });
/**
 * The digests an update compares: a skill's content as the library stores it, whichever shape it arrives in (a stored
 * payload, a native parse). One reader, so a stored revision and a fresh parse of the same bytes digest the same.
 * @param {any} value
 */
const contentDigests = value => skillContentDigests({
  description: value.description ?? "", instructions: value.instructions ?? "", whenToUse: value.whenToUse ?? null,
  invocation: { userInvocable: value.invocation?.userInvocable === true, modelInvocable: value.invocation?.modelInvocable === true },
  metadata: value.metadata ?? {}, resources: (value.resources ?? []).map((/** @type {any} */ resource) => ({ path: resource.path, digest: resource.digest })),
}, sha256);
/** The one-line label of a catalogue item's package: state, words, and where it came from. @param {any} view */
const catalogueLabel = view => view && ({ state: view.state, label: view.label, text: view.text, reason: view.reason, notes: view.notes,
  version: view.package?.version ?? null, sourceText: view.package?.sourceText ?? null, licenceText: view.package?.licenceText ?? null });
/** Where a repository preview recorded what it fetched, keyed by the upload it made: an account document, not a path. @param {string} resourceId */
const sourceDocumentId = resourceId => `skill-source:${sha256(resourceId)}`;

/** Personal instructions are account records, never executable authority or a copy of a learned method. */
export class SkillLibraryService {
  /** @param {any} database @param {{documents?:any,artifacts?:any,projectAccess?:any,invoke?:any,learnedMethods?:any,nativeCatalogue?:any,platformCatalogue?:ReturnType<typeof import("./platformSkillCatalogue.mjs").createPlatformSkillCatalogue>|null,repositoryPreview?:any,onRemoved?:any,supply?:import("./skillSupplyService.mjs").SkillSupply|null}} [options] */
  constructor(database, { documents = new ProductDocuments(database), artifacts = null, projectAccess = null, invoke = null, learnedMethods = null, nativeCatalogue = null, platformCatalogue = null, repositoryPreview = null, onRemoved = null, supply = null } = {}) {
    this.database = database;
    this.documents = documents;
    this.artifacts = artifacts;
    this.projectAccess = projectAccess;
    this.dispatchInvocation = invoke;
    this.learnedMethods = learnedMethods;
    this.nativeCatalogue = nativeCatalogue;
    this.platformCatalogue = platformCatalogue;
    this.repositoryPreview = repositoryPreview;
    this.onRemoved = onRemoved;
    this.supply = supply;
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
  /**
   * The package record and the baseline a revision carries: where the content came from, under what licence and at
   * which version, what its scripts import, and the digests it came in with (the base an update is compared to).
   * An edit or a restore keeps the source, licence, version and baseline it had and recomputes the rest from the new
   * content, so an edited copy still knows what it was copied from. Nothing here refuses a save: a failure to read a
   * script leaves its imports unobserved, and unobserved is not "none".
   * @param {any} user @param {{skillId:string,nativeName:string,digest:string,file:string,content:any,resources:any[],native:any,policy:any}} input
   */
  async packageFields(user, { skillId, nativeName, digest, file, content, resources, native, policy }) {
    const previous = normalizeSkillPackageRecord(native?.package);
    const provenance = native?.provenance ?? null;
    const files = native?.files ?? await this.packageFiles(user, { file, content, resources });
    const record = buildSkillPackageRecord({
      id: `personal/${skillId}`, name: nativeName, origin: "personal",
      version: previous?.version ?? null, source: provenance?.source ?? previous?.source ?? { kind: "authored" }, licence: previous?.licence ?? null,
      digest, digestAlgorithm: "personal-skill-v1", files, metadata: policy.metadata,
    });
    const baseline = provenance && Object.hasOwn(provenance, "baseline") ? provenance.baseline : normalizeSkillBaseline(native?.baseline);
    return { package: record, baseline };
  }
  /** The files of a revision as a package reads them: the skill body, and each resource by digest with the text of the scripts. @param {any} user @param {{file:string,content:any,resources:any[]}} input */
  async packageFiles(user, { file, content, resources }) {
    /** @type {{path:string,sha256:string,text?:string}[]} */
    const files = [{ path: "SKILL.md", sha256: sha256(file), text: content.instructions }];
    let reads = 0;
    for (const resource of resources ?? []) {
      const entry = { path: resource.path, sha256: String(resource.digest).slice(7) };
      if (SCRIPT_TEXT.test(resource.path) && resource.size <= MAX_SCRIPT_TEXT && reads < MAX_SCRIPT_READS && this.artifacts?.read) {
        reads += 1;
        try { entry.text = (await this.artifacts.read(user, { resource })).toString("utf8"); } catch { /* unread is unobserved, not absent */ }
      }
      files.push(entry);
    }
    return files;
  }
  /** A record that does not fit beside the instructions loses its lists first and its baseline second, then the save fails as it always did. @param {any} payload */
  fitPayload(payload) {
    try { productPayload(payload); return; }
    catch (error) { if (error?.code !== "product_document_too_large") throw error; }
    if (payload.package) payload.package = compactPackage(payload.package);
    try { productPayload(payload); return; }
    catch (error) { if (error?.code !== "product_document_too_large") throw error; }
    payload.baseline = null;
    productPayload(payload);
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
        ...await this.packageFields(user, { skillId, nativeName, digest, file, content, resources, native, policy }),
    };
    this.fitPayload(payload);
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
      const source = await this.importSource(user, input.resourceId, imported);
      return this.saveContent(user, skillId, content, imported.resources, { ...imported, provenance: { source, baseline: contentDigests(imported) } },
        () => this.artifacts.verifyUpload(user, input.resourceId));
    });
  }
  /**
   * Where an import came from: the repository and commit a preview of exactly these bytes recorded when the control
   * plane fetched them itself, else the upload's own digest. A repository source is believed only when the bytes
   * previewed are the bytes imported; anything else is an upload and says so.
   * @param {any} user @param {string} resourceId @param {any} imported
   */
  async importSource(user, resourceId, imported) {
    try {
      const recorded = await this.documents.get(user.id, "extension-resource", sourceDocumentId(resourceId));
      const claim = recorded?.payload;
      if (claim?.kind === "skill-source" && claim.resourceId === resourceId && claim.packageDigest === imported.packageDigest && claim.source?.kind === "repository") return claim.source;
    } catch { /* a source that cannot be read is an upload, not a failed import */ }
    return { kind: "upload", digest: imported.packageDigest };
  }
  /** What a repository preview fetched, kept by upload so the import of those exact bytes can name it. Best effort: provenance never fails a preview. @param {any} user @param {string} resourceId @param {string} packageDigest @param {any} source */
  async rememberSource(user, resourceId, packageDigest, source) {
    try {
      const id = sourceDocumentId(resourceId), current = await this.documents.get(user.id, "extension-resource", id);
      await this.documents.put(user.id, "extension-resource", id, { schemaVersion: 1, kind: "skill-source", resourceId, packageDigest, source }, { expectedRevision: current?.revision ?? 0 });
    } catch { /* see above */ }
  }
  /** Native parsing previews data only; it creates no library revision,
   * persistent blob, project selection or permission grant.
   * @param {any} user @param {any} body @param {{source?:any}} [hints] */
  async previewImport(user, body, hints = {}) {
    const input = exact(body, ["resourceId"]); productId(input.resourceId);
    if (!this.artifacts) throw new HttpError(503, "product_state_unavailable", "Skill preparation is unavailable.");
    return this.withLibraryAccount(user, async () => {
      const skillId = `skill:${randomUUID()}`;
      const preview = await this.artifacts.import(user, { resourceId: input.resourceId, skillId,
        nativeName: personalSkillName(user.id, skillId, sha256), preview: true });
      // A source a trusted caller fetched itself (the repository import, never the request body) is remembered for the
      // import of these exact bytes, and shown beside the preview.
      const fetched = hints.source?.kind === "repository" ? hints.source : null;
      if (fetched && preview.packageDigest) await this.rememberSource(user, input.resourceId, preview.packageDigest, fetched);
      const source = fetched ?? { kind: "upload", digest: preview.packageDigest };
      return { description: preview.description, instructions: preview.instructions, invocation: preview.invocation,
        whenToUse: preview.whenToUse, metadata: preview.metadata, resources: preview.resources,
        scripts: preview.resources.filter(resource => /^scripts\//.test(resource.path)).map(resource => ({ path: resource.path, size: resource.size })),
        // What the package is and whether this runtime can supply what it needs, before anything is imported.
        packageDigest: preview.packageDigest ?? null, supply: this.previewSupply(user, preview, source),
      };
    });
  }
  /** The label and the facts of a package that has not been imported yet. @param {any} user @param {any} imported @param {any} source */
  previewSupply(user, imported, source) {
    if (!this.supply || !imported?.files) return null;
    const record = buildSkillPackageRecord({ id: "personal/preview", name: imported.nativeName ?? "preview", origin: "personal", source, digest: imported.packageDigest ?? null,
      digestAlgorithm: "package-files-v1", files: imported.files, metadata: imported.metadata });
    return record ? this.supply.view(record, user) : null;
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
      for (const item of catalogue.items) {
        const ref = await this.personalCatalogueRef(user, project, item);
        // A label beside each skill, never a filter: a limited one is still listed and still callable.
        items.push(ref.supply !== undefined ? ref : { ...ref, supply: ref.source === "personal" ? null : this.catalogueSupply(ref, user) });
      }
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
      return { ...item, personalRef: { skillId: pin.skillId, revision: pin.revision, title: row.payload.title },
        supply: catalogueLabel(this.supply?.personal(row.payload, user) ?? null) };
    } catch (error) { if (error?.status !== 404) throw error; return item; }
  }
  /** The label of a built-in or community skill the runtime lists, from the package of that name; none for a name no shipped package carries. @param {any} item @param {any} user */
  catalogueSupply(item, user) {
    const record = this.supply?.catalogued(item.name);
    return record ? catalogueLabel(this.supply?.view(record, user)) : null;
  }
  /** @param {any} user @param {any} project @param {any} body */
  async effectiveDetail(user, project, body) {
    const input = exact(body, ['sessionId', 'key', 'expectedRuntimeGeneration']);
    return this.withLibraryAccount(user, async () => {
      await this.requireProject(user, project);
      if (!this.nativeCatalogue) throw new HttpError(503, 'product_state_unavailable', 'The native skill catalogue is unavailable.');
      const detail = await this.nativeCatalogue.read(user, project, input);
      const ref = await this.personalCatalogueRef(user, project, detail.skill);
      const skill = ref.supply !== undefined ? ref : { ...ref, supply: ref.source === "personal" ? null : this.catalogueSupply(ref, user) };
      // How to run it, written from the package's own operation schemas (never typed beside them).
      if (ref.source !== "personal") skill.operationHelp = this.supply?.help(this.supply.catalogued(ref.name)) || null;
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
      return this.copyBuiltin(user, client, { idempotencyKey: input.idempotencyKey, title: input.title,
        requestDigest: sha256(canonicalJson({ projectId: project.id, ...input })),
        snapshot: async () => (await this.nativeCatalogue.read(user, project, { sessionId: input.sessionId, key: input.key, expectedRuntimeGeneration: input.expectedRuntimeGeneration }, true)).skill,
        verify: () => this.nativeCatalogue.assertCurrent(user, project, input.sessionId, input.expectedRuntimeGeneration) });
    });
  }
  /**
   * One built-in skill's folder becomes the account's own skill. Shared by the copy of a skill a live session lists and the
   * copy of one the platform ships (which needs no session): the bytes pass the same archive importer and native validator,
   * the receipt is one record pointer, and the copy remembers which built-in it was made from and the digests that built-in
   * had, so an edited copy can later tell its own edits from the original's changes.
   * @param {any} user @param {any} client @param {{idempotencyKey:string,title:string,requestDigest:string,snapshot:()=>Promise<{name:string,digest:string,entries:any[]}>,verify?:(()=>Promise<void>)|null}} input
   */
  async copyBuiltin(user, client, { idempotencyKey, title, requestDigest, snapshot, verify = null }) {
    const operationId = `skill-copy:${sha256(idempotencyKey)}`;
    if (client) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`skill-library-account:${user.id}`]);
    const existing = await this.documents.get(user.id, 'extension-resource', operationId);
    if (existing) {
      if (existing.payload.requestDigest !== requestDigest) throw new HttpError(409, 'product_revision_conflict', 'This copy request already names different content.');
      return this.get(user, existing.payload.skillId);
    }
    const source = await snapshot();
    const archive = await nativeSkillSnapshotArchive(source.entries), uploaded = await this.upload(user, 'tar-gzip', archive);
    const skillId = `skill:${randomUUID()}`, nativeName = personalSkillName(user.id, skillId, sha256);
    try {
      const imported = await this.artifacts.import(user, { resourceId: uploaded.resourceId, skillId, nativeName });
      const content = writeRequest({ expectedRevision: 0, title, description: imported.description, instructions: imported.instructions });
      const provenance = { source: { kind: "builtin-copy", package: source.name, digest: source.digest }, baseline: contentDigests(imported) };
      const row = await this.saveContent(user, skillId, content, imported.resources, { ...imported, provenance }, verify);
      await this.documents.put(user.id, 'extension-resource', operationId, { schemaVersion: 1, kind: 'skill-copy', requestDigest, skillId: row.id }, { expectedRevision: 0, transactionClient: client });
      return row;
    } finally { await this.removeUpload(user, uploaded.resourceId); }
  }
  /** The platform's own skills, from the control plane's packages: no runtime, session or project needed. @param {any} user */
  async listPlatform(user) {
    if (!this.platformCatalogue) throw new HttpError(503, 'product_state_unavailable', 'The platform skill list is unavailable.');
    return this.withLibraryAccount(user, () => this.platformCatalogue.list(user));
  }
  /** @param {any} user @param {string} id */
  async readPlatform(user, id) {
    if (!this.platformCatalogue) throw new HttpError(503, 'product_state_unavailable', 'The platform skill list is unavailable.');
    return this.withLibraryAccount(user, () => this.platformCatalogue.read(id, user));
  }
  /**
   * `POST /api/skills/platform/:id/copy`: a platform skill becomes the account's own, to edit. The title is the researcher's
   * (default: the skill's Chinese name).
   * @param {any} user @param {string} id @param {any} body
   */
  async duplicatePlatform(user, id, body) {
    const input = exact(body, ['title', 'idempotencyKey']); productId(input.idempotencyKey);
    if (typeof input.title !== 'string' || !input.title.trim() || Buffer.byteLength(input.title) > 240) throw new HttpError(400, 'extension_contract_invalid', 'Invalid skill title.');
    if (!this.platformCatalogue || !this.artifacts) throw new HttpError(503, 'product_state_unavailable', 'Skill copying is unavailable.');
    const catalogue = this.platformCatalogue;
    return this.withLibraryAccount(user, client => this.copyBuiltin(user, client, { idempotencyKey: input.idempotencyKey, title: input.title,
      requestDigest: sha256(canonicalJson({ platformSkill: id, title: input.title })), snapshot: () => catalogue.snapshot(id, user) }));
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
  /**
   * The skill's own package: what it is, where it came from, what it needs and whether this runtime can supply it,
   * for the current revision or a named one. A revision saved before packages travelled has none, and says so.
   * @param {any} user @param {string} skillId @param {number|null} [revision]
   */
  async supplyOf(user, skillId, revision = null) {
    const row = revision == null ? await this.get(user, skillId) : await this.atRevision(user, skillId, productInteger(revision, 1, 2_147_483_647));
    const view = this.supply?.personal(row.payload, user) ?? null;
    return { revision: row.revision, nativeName: row.payload.nativeName ?? null, baseKnown: normalizeSkillBaseline(row.payload.baseline) !== null,
      package: view?.package ?? null,
      availability: view ? { state: view.state, label: view.label, text: view.text, reason: view.reason, also: view.also, notes: view.notes } : null };
  }
  /**
   * What an update toward a newer version of this skill would change, without changing anything. The newer version is
   * an upload the researcher already holds (a file, or a repository preview at another commit), compared part by part
   * and file by file against the digests this skill came in with: their edits stay, the upstream's changes come, and a
   * difference both sides made is a conflict named for them to settle.
   * @param {any} user @param {string} skillId @param {any} body
   */
  async updatePreview(user, skillId, body) {
    const input = exact(body, ["resourceId"]); productId(input.resourceId);
    if (!this.artifacts) throw new HttpError(503, "product_state_unavailable", "Skill preparation is unavailable.");
    return this.withLibraryAccount(user, async () => {
      const current = await this.get(user, skillId);
      const { imported, source } = await this.upstreamOf(user, input.resourceId, false);
      const plan = planSkillUpdate({ base: normalizeSkillBaseline(current.payload.baseline), local: contentDigests(current.payload), upstream: contentDigests(imported) });
      return { revision: current.revision, source, ...this.publicPlan(plan) };
    });
  }
  /**
   * Make the update a new revision of this skill. Nothing the researcher edited is overwritten unless they said so for
   * that part; the revision every project and every running conversation pinned is untouched (a project moves to the new
   * one by selecting it, as for any edit); the previous revisions stay, and the new revision's baseline is the upstream
   * version it was synchronised with.
   * @param {any} user @param {string} skillId @param {any} body
   */
  async applyUpdate(user, skillId, body) {
    const input = exact(body, ["resourceId", "expectedRevision", "resolutions"]); productId(input.resourceId);
    if (!input.resolutions || typeof input.resolutions !== "object" || Array.isArray(input.resolutions) || Object.keys(input.resolutions).length > 256
      || Object.values(input.resolutions).some(value => !["local", "upstream"].includes(/** @type {string} */ (value)))) {
      throw new HttpError(400, "extension_contract_invalid", "Invalid update resolutions.");
    }
    if (!this.artifacts) throw new HttpError(503, "product_state_unavailable", "Skill preparation is unavailable.");
    return this.withLibraryAccount(user, async () => {
      const current = await this.get(user, skillId);
      if (current.revision !== input.expectedRevision) throw new HttpError(409, "product_revision_conflict", "The skill changed; reload before updating.");
      const { imported, source } = await this.upstreamOf(user, input.resourceId, true);
      const upstream = contentDigests(imported), base = normalizeSkillBaseline(current.payload.baseline);
      const plan = planSkillUpdate({ base, local: contentDigests(current.payload), upstream });
      const sideOf = (/** @type {any} */ entry) => (entry.decision === "conflict" ? (input.resolutions[entry.name] === "upstream" ? "upstream" : "local") : entry.side);
      /** @param {string} name @returns {any} */
      const part = name => (sideOf(plan.entries.find(entry => entry.scope === "part" && entry.name === name)) === "upstream" ? imported : current.payload)[name];
      /** @type {any[]} */ const resources = [];
      for (const entry of plan.entries.filter(item => item.scope === "resource")) {
        const side = sideOf(entry);
        if (side === "removed") continue;
        const found = (side === "upstream" ? imported.resources : current.payload.resources ?? []).find((/** @type {any} */ resource) => resource.path === entry.name);
        if (found) resources.push(found);
      }
      const taken = plan.entries.filter(entry => entry.decision !== "unchanged" && entry.decision !== "same" && sideOf(entry) === "upstream").map(entry => entry.name);
      const kept = plan.entries.filter(entry => entry.decision === "conflict" && sideOf(entry) === "local").map(entry => entry.name);
      // Nothing to take and the baseline already is the upstream's: there is no new fact to record.
      if (!taken.length && base && canonicalJson(base) === canonicalJson(upstream)) return { skill: current, applied: false, taken, kept, ...this.publicPlan(plan) };
      const content = writeRequest({ expectedRevision: current.revision, title: current.payload.title, description: part("description"), instructions: part("instructions") });
      const native = { invocation: part("invocation"), metadata: part("metadata"), whenToUse: part("whenToUse"), package: current.payload.package, baseline: current.payload.baseline,
        provenance: { source, baseline: upstream } };
      const row = await this.saveContent(user, current.id, content, resources, native);
      return { skill: row, applied: true, taken, kept, pinnedRevision: current.revision, ...this.publicPlan(plan) };
    });
  }
  /** The newer content of an update: the upload parsed by the same reader as an import, and where it came from. @param {any} user @param {string} resourceId @param {boolean} publish */
  async upstreamOf(user, resourceId, publish) {
    const skillId = `skill:${randomUUID()}`;
    const imported = await this.artifacts.import(user, { resourceId, skillId, nativeName: personalSkillName(user.id, skillId, sha256), preview: !publish });
    return { imported, source: await this.importSource(user, resourceId, imported) };
  }
  /** A plan as a reader is given it: each part and file with what the update does about it, and the counts. @param {ReturnType<typeof planSkillUpdate>} plan */
  publicPlan(plan) {
    return { baseKnown: plan.baseKnown, changes: plan.changes, conflicts: plan.conflicts, counts: plan.counts,
      entries: plan.entries.map(entry => ({ scope: entry.scope, name: entry.name, decision: entry.decision, side: entry.side })) };
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
