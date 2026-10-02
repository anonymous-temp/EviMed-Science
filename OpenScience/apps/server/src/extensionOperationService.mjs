import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalJson } from '@evimed/domain';
import { ProductJobs } from './productStore.mjs';
import { migrateProductStore } from './productPersistence.mjs';
import { ExtensionOperationGrants } from './extensionOperationGrants.mjs';
import { extensionRequestObject, extensionIdentifier } from './extensionAccess.mjs';
import { HttpError, directorySize } from './security.mjs';
import { maintenanceAllowsClaims } from './maintenanceService.mjs';
import { heavyWorkAdmission } from './heavyWorkAdmission.mjs';
import { validateRequest } from '../../../scripts/runtime/extensions/cowork/policy.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const denied = () => new HttpError(403, 'extension_access_denied', 'The extension operation is unavailable.');
const pending = () => new HttpError(503, 'product_state_unavailable', 'Extension capacity is waiting for recovery.');
/** Existing ProductJobs is the sole execution ledger. Only trusted adapters can resolve scope/resources. */
export class ExtensionOperationService {
  /** @param {{database:any,dataDir:string,signingSecret:string,generations:any,resolveInvocation:any,resources:any,controller:any,maxPending?:number,maxUserPending?:number,maxStorageBytes?:number,leaseMs?:number}} options */
  constructor({
    database,
    dataDir,
    signingSecret,
    generations,
    resolveInvocation,
    resources,
    controller,
    maxPending = 8,
    maxUserPending = 2,
    maxStorageBytes = 64 * 1024 * 1024,
    leaseMs = 60000
  }) {
    for (const value of [maxPending, maxUserPending, maxStorageBytes, leaseMs]) if (!Number.isSafeInteger(value) || value < 1) throw pending();
    if (leaseMs < 1000 || leaseMs > 3600000 || typeof resolveInvocation !== 'function') throw pending();
    this.database = database;
    this.dataDir = dataDir;
    this.generations = generations;
    this.resolveInvocation = resolveInvocation;
    this.resources = resources;
    this.controller = controller;
    this.maxPending = maxPending;
    this.maxUserPending = maxUserPending;
    this.maxStorageBytes = maxStorageBytes;
    this.leaseMs = leaseMs;
    this.jobs = new ProductJobs(database);
    this.admission = new AsyncLocalStorage();
    this.grants = new ExtensionOperationGrants({
      dataDir,
      secret: signingSecret,
      authorize: (scope, request) => this.authorize(scope, request),
      withAdmission: (scope, work) => this.withAdmission(scope, work)
    });
  }
  /** @param {any} resource */
  resourceIdentity(resource) {
    return {
      resourceId: resource.resourceId,
      format: resource.format,
      dataClass: resource.dataClass,
      sha256: sha(resource.bytes),
      bytes: resource.bytes.length
    };
  }
  /** @param {any} auth @param {string} descriptorId @param {any} request */
  async resolve(auth, descriptorId, request) {
    if (!auth?.runtimeGeneration) throw denied();
    const invocation = await this.resolveInvocation(auth, auth.invocation, request);
    if (!invocation || invocation.userId !== auth.userId || invocation.projectId !== auth.projectId || invocation.runtimeGeneration !== auth.runtimeGeneration || typeof invocation.invocationId !== 'string' || !invocation.allowedOperations?.includes(request.operation)) throw denied();
    const scope = await this.generations.operationIdentity({
      id: auth.userId
    }, auth.projectId, descriptorId, auth.runtimeGeneration, request.operation);
    if (scope.userId !== auth.userId || scope.projectId !== auth.projectId || scope.runtimeGeneration !== auth.runtimeGeneration) throw denied();
    return {
      scope,
      invocation: structuredClone(invocation),
      auth: structuredClone(auth)
    };
  }
  /** Grant authorization uses the current private admission or persisted job, never caller flags. @param {any} scope @param {any} request */
  async authorize(scope, request) {
    const local = this.admission.getStore();
    let auth = local?.auth,
      binding = local?.resourceBinding,
      targetBinding = local?.targetBinding;
    if (!auth) {
      const rows = await this.database.query("SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='extension-execute' AND payload->'scope'=$2::jsonb AND status IN ('queued','running') ORDER BY created_at LIMIT 2", [scope.userId, canonicalJson(scope)]);
      const payload = rows.rows.find(row => canonicalJson(row.payload.request) === canonicalJson(request))?.payload;
      auth = payload?.auth;
      binding = payload?.resourceBinding;
      targetBinding = payload?.targetBinding;
    }
    if (!auth) return false;
    try {
      const current = await this.resolve(auth, scope.descriptorId, request);
      if (canonicalJson(current.scope) !== canonicalJson(scope)) return false;
      if (request.operation === 'doc_read') {
        const fresh = await this.resources.snapshot(scope, request.resourceId);
        return canonicalJson(this.resourceIdentity(fresh)) === canonicalJson(binding);
      }
      return canonicalJson(await this.resources.targetBinding(scope, request.targetId)) === canonicalJson(targetBinding);
    } catch {
      return false;
    }
  }
  /** Account epoch, shared maintenance admission and finite storage/cap fence cover every initial write. @param {any} scope @param {any} work @param {boolean} [settling] */
  async withAdmission(scope, work, settling = false) {
    const previous = this.admission.getStore();
    if (previous?.client) {
      if (canonicalJson(previous.scope) !== canonicalJson(scope)) throw denied();
      return work();
    }
    return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      await this.lock(client, scope, settling);
      return this.admission.run({
        ...previous,
        client
      }, work);
    }));
  }
  /** @param {any} client @param {any} scope @param {boolean} [settling] */
  async lock(client, scope, settling = false) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-extension-operations'))");
    if (!settling && !(await maintenanceAllowsClaims(client))) throw pending();
    const account = await client.query('SELECT id FROM evimed_control.users WHERE id=$1 AND created_at::text=$2 FOR SHARE', [scope.userId, scope.accountCreatedAt]);
    const project = await client.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2 AND created_at::text=$3 FOR SHARE', [scope.userId, scope.projectId, scope.projectCreatedAt]);
    if (account.rowCount !== 1 || project.rowCount !== 1) throw denied();
  }
  /** @param {any} auth @param {any} input */
  async submit(auth, input) {
    extensionRequestObject(input, ['descriptorId', 'request', 'idempotencyKey']);
    extensionIdentifier(input.descriptorId);
    extensionIdentifier(input.idempotencyKey);
    const request = JSON.parse(canonicalJson(input.request));
    try {
      validateRequest(request);
    } catch {
      throw denied();
    }
    if (Buffer.byteLength(canonicalJson(request)) > 65536) throw denied();
    await migrateProductStore(this.database);
    const current = await this.resolve(auth, input.descriptorId, request),
      digest = sha(canonicalJson({
        scope: current.scope,
        request,
        invocation: current.invocation
      })),
      key = 'extension-execute:' + sha(canonicalJson({
        projectId: auth.projectId,
        key: input.idempotencyKey
      }));
    return this.admission.run({
      ...current
    }, () => this.withAdmission(current.scope, async () => {
      const client = this.admission.getStore().client;
      const existing = (await client.query("SELECT id,payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='extension-execute' AND (idempotency_key=$2 OR (project_id=$3 AND payload->'scope'->>'runtimeGeneration'=$4 AND payload->'invocation'->>'invocationId'=$5)) FOR UPDATE", [auth.userId, key, auth.projectId, auth.runtimeGeneration, current.invocation.invocationId])).rows[0];
      if (existing) {
        if (existing.payload.requestDigest !== digest) throw new HttpError(409, 'product_job_idempotency_conflict', 'The request key already names another operation.');
        return {
          jobId: existing.id
        };
      }
      const count = (await client.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE user_id=$1)::int AS owned FROM evimed_product.jobs WHERE kind='extension-execute' AND (status IN ('queued','running') OR payload->>'recoveryRequired'='true')", [auth.userId])).rows[0];
      if (count.total >= this.maxPending || count.owned >= this.maxUserPending) throw pending();
      const resource = request.operation === 'doc_read' ? await this.resources.snapshot(current.scope, request.resourceId) : null;
      const used = await directorySize(this.grants.root, {
        maxEntries: 20000
      }).catch(error => {
        if (['ENOENT', 'file_not_found'].includes(error.code)) return 0;
        throw error;
      });
      if (used + (resource?.bytes.length ?? 0) + 16384 > this.maxStorageBytes) throw pending();
      const resourceBinding = resource ? this.resourceIdentity(resource) : null,
        targetBinding = request.operation === 'doc_write' ? await this.resources.targetBinding(current.scope, request.targetId) : null;
      this.admission.getStore().resourceBinding = resourceBinding;
      this.admission.getStore().targetBinding = targetBinding;
      const issued = await this.grants.issue(current.scope, request, resource);
      try {
        const job = await this.jobs.enqueue(auth.userId, 'extension-execute', {
          schemaVersion: 1,
          ...current,
          request,
          resourceBinding,
          targetBinding,
          requestDigest: digest,
          operationId: issued.operationId,
          dispatch: null,
          cancelRequested: false,
          recoveryRequired: false
        }, {
          idempotencyKey: key,
          projectId: auth.projectId,
          maxAttempts: 1,
          transactionClient: client
        });
        return {
          jobId: job.id
        };
      } catch (error) {
        await this.grants.remove(issued.operationId);
        throw error;
      }
    }));
  }
  /** @param {any} auth @param {string} jobId */
  async owned(auth, jobId) {
    const job = await this.jobs.get(auth.userId, extensionIdentifier(jobId));
    if (!job || job.kind !== 'extension-execute' || job.projectId !== auth.projectId || job.payload.scope.runtimeGeneration !== auth.runtimeGeneration) throw new HttpError(404, 'not_found', 'The operation is unavailable.');
    await this.resolve(auth, job.payload.scope.descriptorId, job.payload.request);
    return job;
  }
  /** @param {any} auth @param {string} jobId */
  async status(auth, jobId) {
    return this.public(await this.owned(auth, jobId));
  }
  /** @param {any} job */
  public(job) {
    return {
      jobId: job.id,
      status: job.status,
      cancelRequested: job.payload.cancelRequested === true,
      recoveryRequired: job.payload.recoveryRequired === true,
      result: job.status === 'succeeded' ? job.result : null,
      error: job.error ? {
        code: job.error.code
      } : null
    };
  }
  /** Scoped claiming deliberately does not auto-fail or redispatch expired physically unknown jobs. @param {string} workerId */
  async claim(workerId) {
    await migrateProductStore(this.database);
    return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-extension-operations'))");
      if (!(await maintenanceAllowsClaims(client)) || !await heavyWorkAdmission(client, 'render') || !(await this.controller.admissionAvailable())) return null;
      const row = (await client.query("SELECT id FROM evimed_product.jobs WHERE kind='extension-execute' AND status='queued' AND run_after<=clock_timestamp() AND payload->>'cancelRequested'='false' ORDER BY run_after,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
      if (!row) return null;
      const token = randomUUID();
      const updated = await client.query("UPDATE evimed_product.jobs SET status='running',worker_id=$2,lease_token=$3,lease_expires_at=clock_timestamp()+($4::int*interval '1 millisecond'),attempts=attempts+1 WHERE id=$1 AND status='queued' RETURNING user_id", [row.id, workerId, token, this.leaseMs]);
      return updated.rows[0] ? this.jobs.get(updated.rows[0].user_id, row.id) : null;
    }));
  }
  /** @param {any} job */
  identity(job) {
    return {
      jobId: job.id,
      leaseToken: job.leaseToken,
      attempts: job.attempts,
      operationId: job.payload.operationId,
      ...job.payload.scope
    };
  }
  /** @param {any} job */
  async markDispatch(job) {
    const current = await this.resolve(job.payload.auth, job.payload.scope.descriptorId, job.payload.request);
    if (canonicalJson(current.scope) !== canonicalJson(job.payload.scope)) throw denied();
    await this.grants.verify(job.payload.operationId, job.payload.request, job.payload.scope);
    const identity = this.identity(job);
    const result = await this.jobs.withLease(job.userId, job.id, job.leaseToken, client => client.query("UPDATE evimed_product.jobs SET payload=jsonb_set(payload,'{dispatch}',$4::jsonb),updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND payload->'dispatch'='null'::jsonb AND payload->>'cancelRequested'='false' RETURNING id", [job.userId, job.id, job.leaseToken, canonicalJson(identity)]));
    if (result?.rowCount !== 1) throw denied();
    job.payload.dispatch = identity;
    return identity;
  }
  /** @param {any} job @param {any} error */
  async retain(job, error) {
    await this.database.query("UPDATE evimed_product.jobs SET payload=jsonb_set(payload,'{recoveryRequired}','true'),error=$3::jsonb,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2 AND status='running'", [job.userId, job.id, canonicalJson({
      code: error?.code ?? 'product_state_unavailable',
      message: 'The operation awaits physical recovery.'
    })]);
  }
  /** @param {any} job @param {any} result */
  async complete(job, result) {
    if (result?.ok !== true || !this.joined(result, job.payload.dispatch)) throw pending();
    if (job.payload.request.operation === 'doc_read' && (Buffer.byteLength(canonicalJson(result.data)) > 65536 || result.data?.resourceId !== job.payload.request.resourceId || result.data?.inputSha256 !== job.payload.resourceBinding.sha256)) throw denied();
    const output = job.payload.request.operation === 'doc_read' ? result.data : {
      targetId: job.payload.request.targetId,
      format: job.payload.request.format,
      bytes: result.data?.bytes,
      sha256: result.data?.sha256,
      artifactPath: job.payload.targetBinding.relativePath
    };
    await this.withAdmission(job.payload.scope, () => this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, output, async client => this.database.withTransactionClient(client, async () => {
      await this.lock(client, job.payload.scope, true);
      const current = await this.resolve(job.payload.auth, job.payload.scope.descriptorId, job.payload.request);
      if (canonicalJson(current.scope) !== canonicalJson(job.payload.scope)) throw denied();
      const row = (await client.query("SELECT payload FROM evimed_product.jobs WHERE id=$1", [job.id])).rows[0];
      if (row.payload.cancelRequested) throw denied();
      await this.grants.verify(job.payload.operationId, job.payload.request, job.payload.scope);
      if (job.payload.request.operation === 'doc_write') {
        const published = await this.resources.publish(job.payload.scope, job.payload.request, result);
        if (published.artifactPath !== job.payload.targetBinding.relativePath) throw denied();
      }
    })), true);
    await this.grants.remove(job.payload.operationId);
  }

  /** @param {any} ack @param {any} identity */
  joined(ack, identity) {
    return Boolean(ack?.identity && identity) && ack.joined === true && ack.physicallyAbsent === true && canonicalJson(ack.identity) === canonicalJson(identity);
  }
  /** Trusted controller callbacks never accept a bare boolean. @param {string} operationId @param {any} request @param {any} expected @param {any} identity */
  async resolveOperation(operationId, request, expected, identity) {
    if (!identity || identity.operationId !== operationId) throw denied();
    const job = await this.jobs.get(identity.userId, identity.jobId);
    if (!job || job.kind !== 'extension-execute' || job.status !== 'running' || job.leaseToken !== identity.leaseToken || job.attempts !== identity.attempts || Date.parse(job.leaseExpiresAt) <= Date.now() || job.payload.cancelRequested || canonicalJson(job.payload.dispatch) !== canonicalJson(identity) || canonicalJson(job.payload.request) !== canonicalJson(request)) throw denied();
    return (await this.grants.verify(operationId, request, expected)).scope;
  }
  /** @param {string} operationId @param {string} resourceId @param {any} identity */
  async resolveInputSnapshot(operationId, resourceId, identity) {
    const job = await this.jobs.get(identity?.userId, identity?.jobId);
    if (!job) throw denied();
    await this.resolveOperation(operationId, job.payload.request, {
      descriptorId: identity.descriptorId,
      artifactDigest: identity.artifactDigest
    }, identity);
    return this.grants.inputSnapshot(operationId, job.payload.request, resourceId, job.payload.scope);
  }
  /** @param {any} auth @param {string} jobId */
  async cancel(auth, jobId) {
    const job = await this.owned(auth, jobId);
    if (!['queued', 'running'].includes(job.status)) return this.public(job);
    await this.database.query("UPDATE evimed_product.jobs SET payload=jsonb_set(payload,'{cancelRequested}','true') WHERE user_id=$1 AND id=$2 AND status IN ('queued','running')", [job.userId, job.id]);
    const current = await this.jobs.get(job.userId, job.id);
    if (!current.payload.dispatch) {
      await this.jobs.cancel(job.userId, job.id);
      await this.grants.remove(job.payload.operationId);
    } else {
      let ack;
      try {
        ack = await this.controller.cancelExecution(current.payload.dispatch);
      } catch {
        ack = null;
      }
      if (this.joined(ack, current.payload.dispatch)) {
        await this.jobs.cancel(job.userId, job.id);
        await this.grants.remove(job.payload.operationId);
      } else await this.retain(current, pending());
    }
    return this.public(await this.jobs.get(job.userId, job.id));
  }
  /** Recovery never re-executes a dispatched operation. Optional extension failure leaves research intact. */
  async recover() {
    await migrateProductStore(this.database);
    const rows = (await this.database.query("SELECT user_id,id FROM evimed_product.jobs WHERE kind='extension-execute' AND (status='running' AND (lease_expires_at<=clock_timestamp() OR payload->>'recoveryRequired'='true')) ORDER BY created_at LIMIT 20")).rows;
    for (const row of rows) {
      const job = await this.jobs.get(row.user_id, row.id);
      if (!job.payload.dispatch) {
        await this.database.query("UPDATE evimed_product.jobs SET status='failed',finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,error='{\"code\":\"product_state_unavailable\",\"message\":\"Undispatched operation lease expired.\"}'::jsonb WHERE id=$1 AND status='running' AND lease_expires_at<=clock_timestamp() AND payload->'dispatch'='null'::jsonb", [job.id]);
        const latest = await this.jobs.get(job.userId, job.id);
        if (latest.status === 'failed') await this.grants.remove(job.payload.operationId);
        continue;
      }
      let ack;
      try {
        ack = await this.controller.executionStatus(job.payload.dispatch);
      } catch {
        continue;
      }
      if (!this.joined(ack, job.payload.dispatch)) continue;
      await this.database.transaction(async client => {
        await client.query('SELECT id FROM evimed_product.jobs WHERE id=$1 FOR UPDATE', [job.id]);
        await client.query("UPDATE evimed_product.jobs SET status=CASE WHEN payload->>'cancelRequested'='true' THEN 'canceled' ELSE 'failed' END,finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,payload=jsonb_set(payload,'{recoveryRequired}','false'),error='{\"code\":\"product_state_unavailable\",\"message\":\"Joined operation did not publish a result.\"}'::jsonb WHERE id=$1 AND status='running' AND payload->'dispatch'=$2::jsonb", [job.id, canonicalJson(job.payload.dispatch)]);
      });
      await this.grants.remove(job.payload.operationId);
    }
  }
  /** @returns {Promise<boolean>} */
  async hasUnjoined() {
    return (await this.database.query("SELECT 1 FROM evimed_product.jobs WHERE kind='extension-execute' AND status='running' AND payload->'dispatch'<>'null'::jsonb LIMIT 1")).rowCount > 0;
  }
  /** Account deletion may purge only after this returns true. @param {string} userId */
  async joinAccount(userId, projectId = null) {
    await this.database.query("UPDATE evimed_product.jobs SET payload=jsonb_set(payload,'{cancelRequested}','true') WHERE user_id=$1 AND ($2::text IS NULL OR project_id=$2) AND kind='extension-execute' AND status IN ('queued','running')", [userId, projectId]);
    const rows = (await this.database.query("SELECT id,payload FROM evimed_product.jobs WHERE user_id=$1 AND ($2::text IS NULL OR project_id=$2) AND kind='extension-execute' AND status IN ('queued','running')", [userId, projectId])).rows;
    for (const row of rows) {
      if (row.payload.dispatch) {
        const ack = await this.controller.cancelExecution(row.payload.dispatch);
        if (!this.joined(ack, row.payload.dispatch)) return false;
      }
      await this.jobs.cancel(userId, row.id);
      await this.grants.remove(row.payload.operationId);
    }
    return true;
  }
}
