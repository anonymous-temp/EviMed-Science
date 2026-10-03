import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '@evimed/domain';
import { ProductDocuments } from './productStore.mjs';
import { migrateProductStore } from './productPersistence.mjs';
import { ExtensionResourceResolver } from './extensionResourceResolver.mjs';
import { HttpError, openScopedDirectoryNoFollow, writeFileExclusiveNoFollow, openScopedFileNoFollow, readStableFileHandle, assertProjectCapacity } from './security.mjs';
import { guardDocument } from '../../../scripts/runtime/extensions/cowork/policy.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const purpose = 'evimed-extension-public-document-v1\0';
const denied = () => new HttpError(403, 'extension_access_denied', 'The document resource is unavailable.');

/** Public PDF bytes enter only from the existing checked public-source gateway.
 * Signed, account/project-bound references use the existing product ledger;
 * neither an upload filename nor an imported record can classify patient data.
 */
export class ExtensionDocumentResources {
  /** @param {{config:any,database:any,store:any,access:any,resolveGeneration:any}} dependencies */
  constructor({ config, database, store, access, resolveGeneration }) {
    if (typeof config.modelGatewaySigningSecret !== 'string' || config.modelGatewaySigningSecret.length < 32 || typeof resolveGeneration !== 'function') throw denied();
    this.config = config; this.database = database; this.store = store; this.access = access;
    this.resolveGeneration = resolveGeneration;
    this.documents = new ProductDocuments(database);
    this.resolver = new ExtensionResourceResolver({
      lookupResource: (scope, id) => this.lookup(scope, id),
      verifyProvenance: (scope, record) => this.provenance(scope, record),
      rootFor: (scope, record) => this.projectRoot(scope, record),
      capacityRootFor: async scope => (await this.project(scope)).baseDir,
      lookupTarget: (scope, id) => this.target(scope, id),
      maxProjectBytes: config.maxProjectBytes ?? 128 * 1024 * 1024,
    });
  }
  /** @param {any} body */
  sign(body) { return createHmac('sha256', this.config.modelGatewaySigningSecret).update(purpose).update(canonicalJson(body)).digest('hex'); }
  /** @param {any} scope */
  async project(scope) {
    const user = await this.store.userById(scope.userId);
    if (!user) throw denied();
    const project=await this.access.project(user, scope.projectId);
    if(project.userId!==(scope.ownerId??scope.userId))throw denied();
    return project;
  }
  /** Public sources belong to the project; authored results belong to its active workspace.
   * @param {any} scope @param {any} record */
  async projectRoot(scope, record) {
    const project = await this.project(scope);
    return record?.originType === 'checked-open-access-pdf' ? project.baseDir : project.workspaceDir ?? project.baseDir;
  }
  /** Capture epochs before the public transport starts, never after its bytes arrive.
   * @param {any} principal */
  async prepareCapture(principal) {
    const scope = await this.resolveGeneration(principal);
    if (!scope || scope.userId !== principal.userId || scope.projectId !== principal.projectId || scope.runtimeGeneration !== principal.jti) throw denied();
    const result = await this.database.query(`SELECT u.created_at::text AS "accountCreatedAt",p.created_at::text AS "projectCreatedAt"
      FROM evimed_control.users u JOIN evimed_control.projects p ON p.user_id=u.id
      WHERE u.id=$1 AND p.id=$2`, [principal.userId, principal.projectId]);
    if (!result.rows[0] || result.rows[0].accountCreatedAt !== scope.accountCreatedAt || result.rows[0].projectCreatedAt !== scope.projectCreatedAt) throw denied();
    return { ...result.rows[0], userId: principal.userId, projectId: principal.projectId, runtimeGeneration: principal.jti };
  }
  /** A write names a new ordinary artifact, never a caller-selected path.
   * @param {any} scope @param {string} id */
  async target(scope, id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,89}_(?:xlsx|ipynb)$/.test(id)) throw denied();
    const project = await this.project(scope);
    const format = id.endsWith('_xlsx') ? 'xlsx' : 'ipynb';
    return { ownerId: scope.ownerId ?? scope.userId, projectId: project.id, revision: 1, format,
      relativePath: `outputs/extensions/${id}.${format}` };
  }
  /** @param {any} scope @param {string} id */
  async lookup(scope, id) {
    if (!/^pub_[a-f0-9]{64}$/.test(id)) throw denied();
    const project = await this.project(scope);
    const row = await this.documents.get(project.userId, 'extension-resource', id);
    if (!row || row.projectId !== project.id) throw denied();
    return { ...row.payload.body, revision: row.revision, signature: row.payload.signature };
  }
  /** @param {any} scope @param {any} record */
  async provenance(scope, record) {
    const { revision, signature, ...body } = record;
    if (!/^[a-f0-9]{64}$/.test(signature ?? '') || body.ownerId !== (scope.ownerId ?? scope.userId) || body.projectId !== scope.projectId
      || body.accountCreatedAt !== (scope.ownerAccountCreatedAt ?? scope.accountCreatedAt) || body.projectCreatedAt !== scope.projectCreatedAt
      || body.dataClass !== 'public' || body.format !== 'pdf' || body.originType !== 'checked-open-access-pdf'
      || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.sign(body), 'hex'))) throw denied();
    return { revision, dataClass: 'public' };
  }
  /** Trusted gateway callback; no customer route accepts this classification.
   * @param {any} principal @param {Buffer} bytes @param {any} provenance @param {any} captured @param {any} validateCurrent */
  async capturePdf(principal, bytes, provenance, captured, validateCurrent) {
    if (!captured || typeof validateCurrent !== 'function' || captured.userId !== principal.userId || captured.projectId !== principal.projectId
      || captured.runtimeGeneration !== principal.jti) throw denied();
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 8 * 1024 * 1024) return null;
    try { guardDocument(bytes, 'pdf'); } catch { return null; }
    const user = await this.store.userById(principal.userId);
    if (!user) throw denied();
    await migrateProductStore(this.database);
    return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      const accountCreatedAt = await this.access.account({ ...user, accountCreatedAt: captured.accountCreatedAt }, client);
      const project = await this.access.project(user, principal.projectId, { client });
      const current = await validateCurrent();
      if (project.userId !== user.id || project.projectCreatedAt !== captured.projectCreatedAt || current.userId !== principal.userId
        || current.projectId !== principal.projectId || current.jti !== captured.runtimeGeneration) throw denied();
      const sha256 = hash(bytes), id = `pub_${hash(`${project.id}\0${sha256}`)}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`extension-public-document:${user.id}:${id}`]);
      const body = { ownerId: user.id, projectId: project.id, accountCreatedAt, projectCreatedAt: project.projectCreatedAt,
        relativePath: `sources/public/${sha256}.pdf`, format: 'pdf', sha256, dataClass: 'public',
        originType: 'checked-open-access-pdf', doi: String(provenance.doi), origin: String(provenance.origin) };
      const prior = await this.documents.get(user.id, 'extension-resource', id);
      if (prior && canonicalJson(prior.payload.body) !== canonicalJson(body)) throw denied();
      if (!prior) {
        const count = await client.query("SELECT count(*)::int AS count FROM evimed_product.documents WHERE user_id=$1 AND project_id=$2 AND kind='extension-resource' AND deleted_at IS NULL", [user.id, project.id]);
        if (count.rows[0].count >= 1000) throw denied();
      }
      const target = path.join(project.baseDir, body.relativePath);
      await assertProjectCapacity(project, target, bytes.length, this.config);
      const parent = await openScopedDirectoryNoFollow(project.baseDir, path.dirname(target), { create: true }); await parent.handle.close();
      try { await writeFileExclusiveNoFollow(project.baseDir, target, bytes, { mode: 0o400 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const opened = await openScopedFileNoFollow(project.baseDir, target);
        try { if (!bytes.equals(await readStableFileHandle(opened.handle, opened.stat))) throw denied(); }
        finally { await opened.handle.close(); }
      }
      if (!prior) await this.documents.put(user.id, 'extension-resource', id, { body, signature: this.sign(body) },
        { expectedRevision: 0, projectId: project.id, transactionClient: client });
      return { resourceId: id };
    }));
  }
}
